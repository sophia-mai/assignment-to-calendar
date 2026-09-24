import type { Env, Task } from './types.ts';
import { UserError, ContinueWork } from './types.ts';
import { ActionSchema, type Action, describeAction } from './actions.ts';
import { getSetting, setSetting } from './db.ts';
import { localInstant, stableId, validZone } from './time.ts';
import { accessToken, ensureCalendar, syncTask } from './google.ts';
import { send } from './telegram.ts';

async function createdTaskId(action: Extract<Action, { type: 'create_task' }>) {
  return stableId(JSON.stringify([action.title.trim().toLowerCase().replace(/\s+/g, ' '), action.due_date, action.due_time, action.timezone]));
}

export async function validateActions(env: Env, actions: Action[], start = 0) {
  for (let index = start; index < actions.length; index++) {
    const action = actions[index];
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
  const id = await stableId('proposal:' + sourceUpdate);
  await env.DB.prepare('INSERT OR IGNORE INTO proposals(id,actions,expires_at,created_at) VALUES (?,?,?,?)').bind(id, JSON.stringify(actions), Date.now() + 86400000, Date.now()).run();
  await showProposal(env, id, actions);
}

export async function showProposal(env: Env, id: string, actions: Action[]) {
  await send(env, `Please review these changes. Nothing has been applied yet.\n\n${actions.map((action, i) => `${i + 1}. ${describeAction(action)}`).join('\n\n')}\n\nProposal expires after 24 hours.`, [[{ text: 'Confirm changes', callback_data: `approve:${id}` }, { text: 'Cancel', callback_data: `cancel:${id}` }]]);
}

export async function approve(env: Env, id: string) {
  const proposal = await env.DB.prepare('SELECT * FROM proposals WHERE id=?').bind(id).first<{ actions: string; state: string; expires_at: number; next_action: number }>();
  if (!proposal) throw new UserError('Proposal not found.');
  if (proposal.state === 'done') { await send(env, 'These changes were already applied. /tasks shows the current list.'); return; }
  if (proposal.state === 'cancelled' || proposal.expires_at < Date.now()) throw new UserError('This proposal was cancelled or expired. Please send the request again.');
  const actions = JSON.parse(proposal.actions).map((a: unknown) => ActionSchema.parse(a)) as Action[];
  await validateActions(env, actions, proposal.next_action);
  const needsCalendar = actions.slice(proposal.next_action).some(a => ['create_task', 'update_task'].includes(a.type));
  const token = needsCalendar ? await accessToken(env) : '';
  const calendar = needsCalendar ? await ensureCalendar(env, token) : '';
  await env.DB.prepare("UPDATE proposals SET state='applying' WHERE id=?").bind(id).run();
  for (let i = proposal.next_action; i < Math.min(actions.length, proposal.next_action + 3); i++) {
    const action = actions[i];
    const actionId = await stableId(`${id}:${i}`);
    if (action.type === 'create_task') {
      const taskId = await createdTaskId(action);
      await env.DB.prepare('INSERT OR IGNORE INTO tasks(id,title,due_date,due_time,timezone,source,created_at) VALUES (?,?,?,?,?,?,?)').bind(taskId, action.title, action.due_date, action.due_time, action.timezone, action.source, Date.now()).run();
      const task = (await env.DB.prepare('SELECT * FROM tasks WHERE id=?').bind(taskId).first<Task>())!;
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
  }
  if (proposal.next_action + 3 < actions.length) throw new ContinueWork();
  await env.DB.prepare("UPDATE proposals SET state='done' WHERE id=?").bind(id).run();
  await send(env, 'Confirmed changes applied. Use /tasks to see your assignments and calendar links.');
}

export async function complete(env: Env, id: string) {
  const task = await env.DB.prepare("UPDATE tasks SET status='done' WHERE id=? RETURNING id").bind(id).first();
  if (!task) throw new UserError('Task not found.');
  await env.DB.prepare("UPDATE reminders SET state='cancelled' WHERE task_id=? AND state IN ('pending','sending')").bind(id).run();
}
