import type { Env, TelegramUpdate } from './types.ts';
import { UserError } from './types.ts';
import { getSetting, setSetting, openTasks, remember } from './db.ts';
import { connectLink } from './google.ts';
import { interpret } from './ai.ts';
import { approve, complete, makeProposal, showProposal } from './planner.ts';
import { send, telegram } from './telegram.ts';
import type { Action } from './actions.ts';
import { stableId } from './time.ts';

const HELP = `Assignment Planner\n\nSend a syllabus PDF, assignment screenshot, or a message such as “Add my essay deadline on October 8, 2026.”\n\n/connect — connect Google Calendar\n/tasks — unfinished tasks and Done buttons\n/pending — review pending changes\n/settings — preferences and briefing\n/status — connection, quotas, failed reminders\n/stop — disable briefing and cancel pending reminders\n/reset — clear conversation and pending attachment\n/help — this message\n\nRequests are processed within about a minute. Large imports continue in small batches. Calendar changes require confirmation. Supported attachments: PDF/JPG/PNG/WebP, up to 4 MB.\n\nTry “Send my unfinished tasks every day at 9 a.m.” or “Remind me tomorrow at 4 p.m. to start the essay.”`;

export async function handleUpdate(env: Env, update: TelegramUpdate) {
  const callback = update.callback_query;
  if (callback) {
    // Telegram callback queries may expire while queued; acknowledgement is best-effort.
    try { await telegram(env, 'answerCallbackQuery', { callback_query_id: callback.id }); } catch { /* no state mutation */ }
    const [action, id] = (callback.data ?? '').split(':');
    if (!/^[a-f0-9]{32}$/.test(id ?? '')) throw new UserError('That button is invalid.');
    if (action === 'approve') await approve(env, id);
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
  if (command === '/start' || command === '/help') { await send(env, HELP); return; }
  if (command === '/connect') { await send(env, 'Connect the Google account you want to use. This link expires in 10 minutes.', [[{ text: 'Connect Google Calendar', url: await connectLink(env) }]]); return; }
  if (command === '/tasks') {
    const tasks = await openTasks(env);
    if (!tasks.length) { await send(env, 'No unfinished tasks. Send a syllabus or assignment to get started.'); return; }
    // One message + buttons, rather than one API call per task.
    await send(env, tasks.map((t, i) => `${i + 1}. ${t.title}\n${t.due_date}${t.due_time ? ' ' + t.due_time : ' (all day)'} [${t.timezone}]${t.calendar_link ? '\n' + t.calendar_link : '\nCalendar sync pending'}`).join('\n\n'), tasks.slice(0, 20).map((t, i) => [{ text: `Done: ${i + 1}. ${t.title}`.slice(0, 60), callback_data: `done:${t.id}` }]));
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
    await send(env, `Preferences:\n${await getSetting(env, 'preferences') ?? 'None set'}\n\nDaily briefing:\n${briefing ? JSON.stringify(briefing) : 'Not enabled'}\n\nDefault timezone: ${env.TIMEZONE}\nTell me what you would like to change.`);
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
    await env.DB.batch([env.DB.prepare('DELETE FROM history'), env.DB.prepare("DELETE FROM settings WHERE key='pending_attachment'")]);
    await send(env, 'Conversation context cleared. Tasks, proposals, and reminders remain.'); return;
  }
  if (command.startsWith('/')) { await send(env, 'Unknown command. Use /help or send a normal message.'); return; }
  if (!text && !message.photo && !message.document) throw new UserError('Please send text, an image, or a PDF. Voice and other attachments are not supported yet.');
  if (text.length > 12000) throw new UserError('Please split that message into smaller parts.');
  const existing = await env.DB.prepare('SELECT id,actions FROM proposals WHERE id=?').bind(await stableId('proposal:' + update.update_id)).first<{ id: string; actions: string }>();
  if (existing) { await showProposal(env, existing.id, JSON.parse(existing.actions)); return; }
  let effectiveMessage = message;
  if (!message.photo && !message.document) {
    const saved = JSON.parse(await getSetting(env, 'pending_attachment') ?? 'null') as { expires: number; photo?: NonNullable<TelegramUpdate['message']>['photo']; document?: NonNullable<TelegramUpdate['message']>['document'] } | null;
    if (saved && saved.expires > Date.now()) effectiveMessage = { ...message, photo: saved.photo, document: saved.document };
  }
  const plan = await interpret(env, effectiveMessage);
  if (plan.needs_clarification && (effectiveMessage.photo || effectiveMessage.document)) {
    await setSetting(env, 'pending_attachment', JSON.stringify({ expires: Date.now() + 86400000, photo: effectiveMessage.photo, document: effectiveMessage.document }));
  } else {
    await env.DB.prepare("DELETE FROM settings WHERE key='pending_attachment'").run();
  }
  await remember(env, 'user', text || '[Uploaded document/image]');
  await remember(env, 'assistant', JSON.stringify(plan));
  if (plan.actions.length) await makeProposal(env, plan.actions, update.update_id);
  else await send(env, plan.reply);
}
