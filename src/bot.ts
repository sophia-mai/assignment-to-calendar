import type { Env, TelegramUpdate } from './types.ts';
import { UserError } from './types.ts';
import { getSetting, setSetting, openTasks, remember, preferredTimezone } from './db.ts';
import { connectLink } from './google.ts';
import { interpret } from './ai.ts';
import { approve, complete, makeProposal, showProposal } from './planner.ts';
import { send } from './telegram.ts';
import type { Action } from './actions.ts';
import { stableId, resolveZone, formatInstant, formatDeadline } from './time.ts';
import { calendarMenu, calendarRead } from './calendar-tools.ts';

const HELP = `Assignment Planner\n\nSend a syllabus PDF, assignment screenshot, or a message such as “Add my essay deadline on October 8, 2026.”\n\n/connect — connect Google Calendar\n/tasks — unfinished tasks and Done buttons\n/pending — review pending changes\n/timezone — view or change your timezone\n/settings — preferences and briefing\n/status — connection, quotas, failed reminders\n/stop — disable briefing and cancel pending reminders\n/reset — clear conversation and pending attachment\n/help — this message\n\nRequests start processing as soon as they arrive. AI responses can take several seconds. Large imports continue in small batches. Calendar changes require confirmation. Supported attachments: PDF/JPG/PNG/WebP, up to 4 MB. You can also rename, move, or delete a calendar event by asking in chat.\n\nTry “Send my unfinished tasks every day at 9 a.m.” or “Remind me tomorrow at 4 p.m. to start the essay.”`;

export async function handleUpdate(env: Env, update: TelegramUpdate) {
  const callback = update.callback_query;
  if (callback) {
    // The webhook acknowledges the button immediately, before queue processing.
    const [action, id] = (callback.data ?? '').split(':');
    if (!/^[a-f0-9]{32}$/.test(id ?? '')) throw new UserError('That button is invalid.');
    if (action === 'cal') await calendarMenu(env, id, callback.message?.message_id, update.update_id);
    else if (action === 'approve') await approve(env, id);
    else if (action === 'cancel') {
      const result = await env.DB.prepare("UPDATE proposals SET state='cancelled' WHERE id=? AND state='pending' RETURNING id").bind(id).first();
      await send(env, result ? 'Proposal cancelled.' : 'This proposal has already started or finished. Use /pending to inspect it.');
    } else if (action === 'done') { await complete(env, id); await send(env, 'Marked complete. Linked reminders are cancelled; the calendar event stays.'); }
    else if (action === 'snooze') {
      const result = await env.DB.prepare("UPDATE reminders SET state='pending',due_at=?,attempts=0,lease_until=0 WHERE id=? AND state='sent' AND (task_id IS NULL OR task_id IN (SELECT id FROM tasks WHERE status='open')) RETURNING id").bind(Date.now() + 3600000, id).first();
      await send(env, result ? 'Reminder snoozed for one hour.' : 'This reminder was already snoozed, cancelled, or completed.');
    }
    return;
  }
  const message = update.message!;
  const text = message.text ?? message.caption ?? '';
  const command = text.trim().split(/\s/)[0].split('@')[0].toLowerCase();
  if (command === '/start' || command === '/help') { await send(env, HELP + '\n\n/calendars — choose calendars for searches and conflicts\nYou can also ask “Am I free tomorrow from 3–4 p.m.?” or “Add bring a calculator to the biology exam notes.”'); return; }
  if (command === '/calendars') { await calendarMenu(env); return; }
  if (command === '/timezone') {
    const input = text.trim().split(/\s+/).slice(1).join(' ');
    if (!input) {
      const zone = await preferredTimezone(env);
      await send(env, `Your default timezone: ${zone}\nCurrent time: ${formatInstant(Date.now(), zone)}\n\nChange it with:\n/timezone Eastern\n/timezone Pacific\n/timezone Europe/London\n/timezone Asia/Tokyo\n\nYou can also say “Change my timezone to Eastern Time.” Use a city/region rather than ambiguous abbreviations like EST or CST.`);
      return;
    }
    const zone = resolveZone(input);
    if (!zone) throw new UserError('Please use a region such as America/New_York or Europe/London, or Eastern, Central, Mountain, Pacific, or UTC. For EST/EDT, use Eastern so daylight saving time adjusts automatically.');
    await makeProposal(env, [{ type: 'preference', key: 'timezone', value: zone }], update.update_id);
    return;
  }
  if (command === '/connect') { await send(env, 'Connect the Google account you want to use. This link expires in 10 minutes.', [[{ text: 'Connect Google Calendar', url: await connectLink(env) }]]); return; }
  if (command === '/tasks') {
    const tasks = await openTasks(env);
    const zone = await preferredTimezone(env);
    if (!tasks.length) { await send(env, 'No unfinished tasks. Send a syllabus or assignment to get started.'); return; }
    // One message + buttons, rather than one API call per task.
    await send(env, tasks.map((t, i) => `${i + 1}. ${t.title}\n${formatDeadline(t.due_date, t.due_time, t.timezone, zone)}${t.calendar_link ? '\n' + t.calendar_link : '\nCalendar sync pending'}`).join('\n\n'), tasks.slice(0, 20).map((t, i) => [{ text: `Done: ${i + 1}. ${t.title}`.slice(0, 60), callback_data: `done:${t.id}` }]));
    return;
  }
  if (command === '/pending') {
    const proposals = (await env.DB.prepare("SELECT id,actions,next_action FROM proposals WHERE state IN ('pending','applying') AND expires_at>? ORDER BY created_at DESC LIMIT 3").bind(Date.now()).all<{ id: string; actions: string; next_action: number }>()).results;
    if (!proposals.length) await send(env, 'No pending changes.');
    for (const p of proposals) {
      if (p.next_action) await send(env, `${p.next_action} changes in this proposal are already applied. Confirm to resume the remaining changes.`);
      await showProposal(env, p.id, JSON.parse(p.actions) as Action[]);
    }
    return;
  }
  if (command === '/settings') {
    const briefing = await env.DB.prepare("SELECT time,timezone,days_ahead,enabled FROM briefings WHERE id='daily'").first();
    await send(env, `Preferences:\n${await getSetting(env, 'preferences') ?? 'None set'}\n\nDaily briefing:\n${briefing ? JSON.stringify(briefing) : 'Not enabled'}\n\nDefault timezone: ${await preferredTimezone(env)}\nTell me what you would like to change.`);
    return;
  }
  if (command === '/status') {
    const day = new Date().toISOString().slice(0, 10);
    const usage = await env.DB.prepare('SELECT ai_calls FROM usage WHERE day=?').bind(day).first<{ ai_calls: number }>();
    const failed = await env.DB.prepare("SELECT COUNT(*) AS count FROM reminders WHERE state='failed' OR (state='sending' AND attempts>=3 AND lease_until<?)").bind(Date.now()).first<{ count: number }>();
    const failedRequests = await env.DB.prepare("SELECT COUNT(*) AS count FROM inbox WHERE state='failed'").first<{ count: number }>();
    await send(env, `Google connection stored: ${await getSetting(env, 'google_refresh_token') ? 'yes (access checked when used)' : 'no; use /connect'}\nAI attempts today (UTC): ${usage?.ai_calls ?? 0}/${env.AI_DAILY_LIMIT}\nFailed reminders: ${failed?.count ?? 0}\nFailed requests (last 7 days): ${failedRequests?.count ?? 0}\nUse /pending to resume confirmed changes.\nNo paid fallback is configured.`);
    return;
  }
  if (command === '/stop') {
    await env.DB.batch([env.DB.prepare('UPDATE briefings SET enabled=0'), env.DB.prepare("UPDATE reminders SET state='cancelled' WHERE state IN ('pending','sending')")]);
    await send(env, 'Daily briefings disabled and pending reminders cancelled. Your tasks and calendar events remain.'); return;
  }
  if (command === '/reset') {
    await env.DB.batch([env.DB.prepare('DELETE FROM history'), env.DB.prepare("DELETE FROM settings WHERE key IN ('pending_attachment','calendar_matches')")]);
    await send(env, 'Conversation context cleared. Tasks, proposals, and reminders remain.'); return;
  }
  if (command.startsWith('/')) { await send(env, 'Unknown command. Use /help or send a normal message.'); return; }
  if (!text && !message.photo && !message.document) throw new UserError('Please send text, an image, or a PDF. Voice and other attachments are not supported yet.');
  if (text.length > 12000) throw new UserError('Please split that message into smaller parts.');
  const existing = await env.DB.prepare('SELECT id,actions FROM proposals WHERE id=?').bind(await stableId('proposal:' + update.update_id)).first<{ id: string; actions: string }>();
  if (existing) { await showProposal(env, existing.id, JSON.parse(existing.actions)); return; }
  let effectiveMessage = message;
  let uploadContext: { request: string; date?: number } | undefined;
  if (!message.photo && !message.document) {
    const saved = JSON.parse(await getSetting(env, 'pending_attachment') ?? 'null') as { expires: number; request?: string; date?: number; photo?: NonNullable<TelegramUpdate['message']>['photo']; document?: NonNullable<TelegramUpdate['message']>['document'] } | null;
    if (saved && saved.expires > Date.now()) {
      effectiveMessage = { ...message, photo: saved.photo, document: saved.document };
      uploadContext = { request: saved.request ?? '', date: saved.date };
    }
  }
  // Save metadata before the provider call so quota/timeouts don't discard the
  // upload. Store only Telegram references, never the original file bytes.
  if (effectiveMessage.photo || effectiveMessage.document) {
    uploadContext ??= { request: text, date: message.date };
    await setSetting(env, 'pending_attachment', JSON.stringify({ expires: Date.now() + 86400000, ...uploadContext, photo: effectiveMessage.photo, document: effectiveMessage.document }));
  }
  const plan = await interpret(env, effectiveMessage, uploadContext);
  if (!plan.needs_clarification) {
    await env.DB.prepare("DELETE FROM settings WHERE key='pending_attachment'").run();
  }
  await remember(env, 'user', text || '[Uploaded document/image]');
  await remember(env, 'assistant', JSON.stringify(plan));
  const reads = plan.actions.filter((a): a is Extract<Action, { type: 'find_events' | 'check_conflicts' }> => a.type === 'find_events' || a.type === 'check_conflicts');
  if (reads.length) {
    if (reads.length !== plan.actions.length || reads.length > 1) throw new UserError('Please check or search one calendar interval first, then request further checks or changes in a separate message.');
    for (const action of reads) await calendarRead(env, action);
    return;
  }
  if (plan.actions.length) await makeProposal(env, plan.actions, update.update_id);
  else await send(env, plan.reply);
}
