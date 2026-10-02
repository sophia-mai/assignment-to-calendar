import type { Env, Task } from './types.ts';
import { UserError, ContinueWork } from './types.ts';
import { ActionSchema, type Action, describeAction, createdTaskId } from './actions.ts';
import { getSetting, setSetting, preferredTimezone } from './db.ts';
import { localInstant, stableId, validZone } from './time.ts';
import { accessToken, ensureCalendar, syncTask } from './google.ts';
import { send } from './telegram.ts';
import { selectedCalendars, prepareEdit, editPreview, applyEdit, checkDuplicates, type CalendarContext } from './calendar-tools.ts';
import { prepareMutation, mutationPreview, applyMutation } from './event-mutations.ts';
import { sessionInterval, checkSession, createSession, resolveDestination, checkSessionBatch } from './sessions.ts';

export async function validateActions(env: Env, actions: Action[], start = 0) {
  for (let index = start; index < actions.length; index++) {
    const action = actions[index];
    if (action.type === 'find_slot') throw new UserError('Find an available slot before confirming a concrete event.');
    if (action.type === 'create_event') sessionInterval(action);
    if (action.type === 'create_task' || action.type === 'update_task') {
      if (action.due_time) localInstant(action.due_date, action.due_time, action.timezone);
    }
    if ('task_id' in action && action.task_id) {
      if (action.task_id.startsWith('new:')) {
        const ref = Number(action.task_id.slice(4));
        if (ref >= index || actions[ref]?.type !== 'create_task') throw new UserError('The reminder has an invalid task reference. Please resend the request.');
      } else {
        const task = await env.DB.prepare('SELECT id FROM tasks WHERE id=?').bind(action.task_id).first();
        if (!task) throw new UserError('A referenced task no longer exists. Please resend the request.');
      }
    }
    if (action.type === 'reminder' && localInstant(action.date, action.time, action.timezone) <= Date.now()) throw new UserError('That reminder would be in the past. Please choose a future date and time.');
    if (action.type === 'preference') {
      const valid = action.key === 'timezone' ? validZone(action.value) : action.key === 'finish_days_early' ? /^(?:[0-9]|[12][0-9]|30)$/.test(action.value) : /^([01]\d|2[0-3]):[0-5]\d$/.test(action.value);
      if (!valid) throw new UserError('That preference value is invalid. Please specify a timezone, a 24-hour time, or 0–30 days as appropriate.');
    }
  }
}

export async function makeProposal(env: Env, actions: Action[], sourceUpdate: number) {
  await validateActions(env, actions);
  const mutations = actions.filter(a => ['rename_event', 'reschedule_event', 'delete_event'].includes(a.type));
  if (mutations.length && actions.length !== 1) throw new UserError('Please rename, move, or delete one event per message.');
  const edits = actions.filter(a => a.type === 'edit_event');
  const sessions = actions.filter(a => a.type === 'create_event');
  if (sessions.length && (sessions.length > 10 || actions.some(a => ['create_task', 'update_task', 'edit_event'].includes(a.type)))) throw new UserError('Please schedule up to ten events per message, separately from assignment imports or calendar edits.');
  for (const session of sessions) if (sessionInterval(session).start <= Date.now()) throw new UserError('That session would start in the past. Please choose a future date and time.');
  if (edits.length > 1 || (edits.length && actions.some(a => a.type === 'create_task'))) throw new UserError('Please update one existing event per message, separately from new assignment imports. This keeps each preview clear and within the free hosting limits.');
  const context: CalendarContext = { edits: {}, mutations: {}, destinations: {} };
  if (mutations.length || actions.some(a => a.type === 'create_task' || a.type === 'edit_event' || a.type === 'create_event')) {
    const token = await accessToken(env);
    const calendars = await selectedCalendars(env, token, mutations.length > 0);
    await checkDuplicates(env, token, calendars, actions);
    for (let i = 0; i < actions.length; i++) {
      const action = actions[i];
      if (action.type === 'rename_event' || action.type === 'reschedule_event' || action.type === 'delete_event') context.mutations![i] = await prepareMutation(env, token, calendars, action);
      if (action.type === 'edit_event') context.edits![i] = await prepareEdit(env, token, calendars, action);
      if (action.type === 'create_event') {
        const destination = await resolveDestination(token, action.calendar_name);
        if (destination) { context.destinations![i] = destination; action.calendar_name = destination.summary; }

      }
    }
    if (sessions.length) await checkSessionBatch(env, token, calendars, actions.flatMap((action, i) => action.type === 'create_event' ? [{ action, destination: context.destinations?.[i] }] : []));
  }
  const id = await stableId('proposal:' + sourceUpdate);
  await env.DB.prepare('INSERT OR IGNORE INTO proposals(id,actions,calendar_context,expires_at,created_at) VALUES (?,?,?,?,?)').bind(id, JSON.stringify(actions), JSON.stringify(context), Date.now() + 86400000, Date.now()).run();
  await showProposal(env, id, actions);
}

export async function showProposal(env: Env, id: string, actions: Action[]) {
  const row = await env.DB.prepare('SELECT calendar_context,next_action,state FROM proposals WHERE id=?').bind(id).first<{ calendar_context: string; next_action: number; state: string }>();
  const context: CalendarContext = JSON.parse(row?.calendar_context ?? '{}');
  if (row?.state === 'done' || row?.state === 'cancelled') { await send(env, `This proposal is ${row.state}.`); return; }
  const displayZone = await preferredTimezone(env);
  await send(env, `Please review these changes.${row?.next_action ? ` The first ${row.next_action} changes are already applied.` : ' Nothing has been applied yet.'}\n\n${actions.map((action, i) => `${i + 1}. ${context.mutations?.[i] ? mutationPreview(context.mutations[i], displayZone) : context.edits?.[i] ? editPreview(context.edits[i], displayZone) : describeAction(action, displayZone)}`).join('\n\n')}\n\nProposal expires after 24 hours.`, [[{ text: actions.some(a => a.type === 'delete_event') ? 'Confirm deletion' : 'Confirm changes', callback_data: `approve:${id}` }, { text: 'Cancel', callback_data: `cancel:${id}` }]]);
}

export async function approve(env: Env, id: string) {
  const proposal = await env.DB.prepare('SELECT * FROM proposals WHERE id=?').bind(id).first<{ actions: string; calendar_context: string; state: string; expires_at: number; next_action: number }>();
  if (!proposal) throw new UserError('Proposal not found.');
  if (proposal.state === 'done') { await send(env, 'These changes were already applied. Use /reminders for Telegram reminders, /tasks for assignments, or Google Calendar for events.'); return; }
  if (proposal.state === 'cancelled' || proposal.expires_at < Date.now()) throw new UserError('This proposal was cancelled or expired. Please send the request again.');
  const actions = JSON.parse(proposal.actions).map((a: unknown) => ActionSchema.parse(a)) as Action[];
  await validateActions(env, actions, proposal.next_action);
  const context: CalendarContext = JSON.parse(proposal.calendar_context ?? '{}');
  const batchSize = actions.some(a => a.type === 'create_event') ? 1 : 3;
  const batch = actions.slice(proposal.next_action, proposal.next_action + batchSize);
  const needsCalendar = batch.some(a => ['create_task', 'update_task', 'edit_event', 'create_event', 'rename_event', 'reschedule_event', 'delete_event'].includes(a.type));
  const token = needsCalendar ? await accessToken(env) : '';
  if (batch.some(a => a.type === 'create_task')) await checkDuplicates(env, token, await selectedCalendars(env, token), batch);
  for (const [offset, action] of batch.entries()) if (action.type === 'create_event') {
    if (sessionInterval(action).start <= Date.now()) throw new UserError('This session’s start time has passed. Check Calendar for any earlier successful attempt, then request a new time.');
    const reviewed = context.destinations?.[proposal.next_action + offset];
    if (action.calendar_name && !reviewed) throw new UserError('This destination has no reviewed calendar. Request a new preview.');
    const destination = await resolveDestination(token, action.calendar_name, reviewed);
    await checkSession(env, token, await selectedCalendars(env, token), action, destination);
  }
  const calendar = batch.some(a => a.type === 'create_task' || a.type === 'update_task' || (a.type === 'create_event' && !a.calendar_name)) ? await ensureCalendar(env, token) : '';
  await env.DB.prepare("UPDATE proposals SET state='applying' WHERE id=?").bind(id).run();
  for (let i = proposal.next_action; i < Math.min(actions.length, proposal.next_action + batchSize); i++) {
    const action = actions[i];
    const actionId = await stableId(`${id}:${i}`);
    if (action.type === 'rename_event' || action.type === 'reschedule_event' || action.type === 'delete_event') {
      if (!context.mutations?.[i]) throw new UserError('This change has no reviewed event snapshot. Request a new preview.');
      await applyMutation(env, token, context.mutations[i], actionId);
    } else if (action.type === 'create_event') {
      const link = await createSession(token, context.destinations?.[i]?.id ?? calendar, action);
      if (link) {
        (context.sessionLinks ??= {})[i] = link;
        await env.DB.prepare('UPDATE proposals SET calendar_context=? WHERE id=?').bind(JSON.stringify(context), id).run();
      }
    } else if (action.type === 'edit_event') {
      if (!context.edits?.[i]) throw new UserError('This edit has no reviewed event snapshot. Please request a new preview.');
      await applyEdit(env, token, context.edits[i], actionId);
    } else if (action.type === 'create_task') {
      const taskId = await createdTaskId(action);
      await env.DB.prepare('INSERT OR IGNORE INTO tasks(id,title,due_date,due_time,timezone,source,created_at) VALUES (?,?,?,?,?,?,?)').bind(taskId, action.title, action.due_date, action.due_time, action.timezone, action.source, Date.now()).run();
      const task = (await env.DB.prepare('SELECT * FROM tasks WHERE id=?').bind(taskId).first<Task>())!;
      if (task.status === 'cancelled') throw new UserError('This assignment was previously deleted. Please use a distinct title or date for a new assignment; the deleted event was not recreated.');
      if (!task.calendar_event_id) await syncTask(env, task, token, calendar);
    } else if (action.type === 'update_task') {
      const old = (await env.DB.prepare('SELECT * FROM tasks WHERE id=?').bind(action.task_id).first<Task>())!;
      const task = { ...old, title: action.title, due_date: action.due_date, due_time: action.due_time, timezone: action.timezone };
      await syncTask(env, task, token, calendar, !!old.calendar_event_id);
      await env.DB.prepare('UPDATE tasks SET title=?,due_date=?,due_time=?,timezone=? WHERE id=?').bind(task.title, task.due_date, task.due_time, task.timezone, task.id).run();
    } else if (action.type === 'complete_task') {
      await complete(env, action.task_id);
    } else if (action.type === 'reminder') {
      const taskId = action.task_id?.startsWith('new:') ? await createdTaskId(actions[Number(action.task_id.slice(4))] as Extract<Action, { type: 'create_task' }>) : action.task_id;
      await env.DB.prepare('INSERT OR IGNORE INTO reminders(id,task_id,text,due_at) VALUES (?,?,?,?)').bind(actionId, taskId, action.text, localInstant(action.date, action.time, action.timezone)).run();
    } else if (action.type === 'briefing') {
      await env.DB.prepare("INSERT INTO briefings(id,time,timezone,days_ahead,enabled) VALUES ('daily',?,?,?,?) ON CONFLICT(id) DO UPDATE SET time=excluded.time,timezone=excluded.timezone,days_ahead=excluded.days_ahead,enabled=excluded.enabled").bind(action.time, action.timezone, action.days_ahead, Number(action.enabled)).run();
    } else if (action.type === 'preference') {
      const prefs = JSON.parse(await getSetting(env, 'preferences') ?? '{}');
      prefs[action.key] = action.value;
      await setSetting(env, 'preferences', JSON.stringify(prefs));
    }
    await env.DB.prepare('UPDATE proposals SET next_action=? WHERE id=?').bind(i + 1, id).run();
    if (action.type === 'create_event' && actions.filter(a => a.type === 'create_event').length > 1) await send(env, `Saved event: ${action.title}\nCalendar: ${action.calendar_name ?? 'Assignment Planner'}${context.sessionLinks?.[i] ? '\n' + context.sessionLinks[i] : ''}\n${i + 1} of ${actions.length} changes recorded. Remaining changes continue automatically; use /pending if processing stops.`);
  }
  if (proposal.next_action + batchSize < actions.length) throw new ContinueWork();
  await env.DB.prepare("UPDATE proposals SET state='done' WHERE id=?").bind(id).run();
  if (actions.some(a => a.type === 'reminder')) await send(env, 'Reminder saved — I will send you a Telegram message here at the scheduled time. Quiet hours may delay delivery. View upcoming reminders with /reminders. Reminders themselves do not create Google Calendar events.');
  if (actions.every(a => a.type === 'reminder')) return;
  const mutation = actions.find(a => ['rename_event', 'reschedule_event', 'delete_event'].includes(a.type));
  if (mutation) { await send(env, mutation.type === 'delete_event' ? 'Confirmed — the event is removed from Google Calendar. Linked assignment reminders are cancelled; standalone reminders are unchanged.' : 'Confirmed — your event was updated in Google Calendar.'); return; }
  const timezoneChange = actions.some(a => a.type === 'preference' && a.key === 'timezone');
  if (timezoneChange) { await send(env, `Changes applied. Default timezone: ${await preferredTimezone(env)}. Future requests, displayed times, and quiet hours use this timezone. Existing events, reminders, daily briefings, and pending proposals keep their scheduled times.`); return; }
  const links = Object.values(context.sessionLinks ?? {});
  for (const action of actions) {
    if (action.type !== 'create_task' && action.type !== 'update_task') continue;
    const taskId = action.type === 'create_task' ? await createdTaskId(action) : action.task_id;
    const task = await env.DB.prepare('SELECT calendar_link FROM tasks WHERE id=?').bind(taskId).first<{ calendar_link: string | null }>();
    if (task?.calendar_link) links.push(task.calendar_link);
  }
  if (links.length) await send(env, 'Saved calendar items — open in Google Calendar:\n' + links.join('\n'));
  await send(env, actions.some(a => a.type === 'create_event') ? actions.filter(a => a.type === 'create_event').length === 1 ? `Confirmed — your session is scheduled in ${actions.find(a => a.type === 'create_event')?.calendar_name ?? 'Assignment Planner'}. Open Google Calendar to view it. Sessions reserve time; they are not unfinished assignments in /tasks.` : `Confirmed — ${actions.filter(a => a.type === 'create_event').length} events scheduled in the calendars shown in your preview. Open the calendar links above to view them.` : actions.some(a => a.type === 'create_task' || a.type === 'update_task' || a.type === 'complete_task') ? 'Confirmed — assignment changes saved. Use /tasks to see your assignments and calendar links.' : actions.some(a => a.type === 'briefing') ? 'Confirmed — daily Telegram briefing settings saved. Use /settings to review them.' : 'Confirmed — preferences saved. Use /settings to review them.');
}

export async function complete(env: Env, id: string) {
  const task = await env.DB.prepare("UPDATE tasks SET status='done' WHERE id=? RETURNING id").bind(id).first();
  if (!task) throw new UserError('Task not found.');
  await env.DB.prepare("UPDATE reminders SET state='cancelled' WHERE task_id=? AND state IN ('pending','sending')").bind(id).run();
}
