import type { Env } from './types.ts';
import { getSetting, openTasks } from './db.ts';
import { addDays, localParts, stableId } from './time.ts';
import { send } from './telegram.ts';

export function inQuietHours(time: string, start?: string, end?: string) {
  if (!start || !end || start === end) return false;
  return start < end ? time >= start && time < end : time >= start || time < end;
}

export async function scheduleBriefing(env: Env, now = Date.now()) {
  const rule = await env.DB.prepare("SELECT * FROM briefings WHERE id='daily' AND enabled=1").first<{ time: string; timezone: string; days_ahead: number }>();
  if (!rule) return;
  const local = localParts(now, rule.timezone);
  if (local.time < rule.time) return;
  const tasks = (await openTasks(env)).filter(t => t.due_date <= addDays(local.date, rule.days_ahead));
  const text = tasks.length ? `Your task briefing — ${local.date}\n\n${tasks.map(t => `• ${t.title}: ${t.due_date}${t.due_time ? ' ' + t.due_time : ''} [${t.timezone}]${t.due_date < local.date ? ' — overdue' : ''}`).join('\n')}\n\nUse /tasks to mark items done.` : `Your task briefing — ${local.date}\nNo unfinished tasks due within ${rule.days_ahead} days.`;
  await env.DB.prepare('INSERT OR IGNORE INTO reminders(id,text,due_at) VALUES (?,?,?)').bind(await stableId('briefing:' + local.date), text, now).run();
}

export async function deliverReminders(env: Env, now = Date.now()) {
  const prefs = JSON.parse(await getSetting(env, 'preferences') ?? '{}');
  if (inQuietHours(localParts(now, prefs.timezone ?? env.TIMEZONE).time, prefs.quiet_start, prefs.quiet_end)) return;
  // A bounded batch stays comfortably below Telegram's ordinary messaging limits.
  const rows = (await env.DB.prepare("SELECT id FROM reminders WHERE due_at<=? AND attempts<3 AND (state='pending' OR (state='sending' AND lease_until<?)) ORDER BY due_at LIMIT 1").bind(now, now).all<{ id: string }>()).results;
  for (const row of rows) {
    const item = await env.DB.prepare("UPDATE reminders SET state='sending',lease_until=?,attempts=attempts+1 WHERE id=? AND (state='pending' OR (state='sending' AND lease_until<?)) RETURNING *").bind(now + 120000, row.id, now).first<{ id: string; text: string; task_id: string | null; attempts: number }>();
    if (!item) continue;
    if (item.task_id) {
      const task = await env.DB.prepare('SELECT status FROM tasks WHERE id=?').bind(item.task_id).first<{ status: string }>();
      if (!task || task.status === 'done') {
        await env.DB.prepare("UPDATE reminders SET state='cancelled' WHERE id=?").bind(item.id).run();
        continue;
      }
    }
    try {
      const buttons = [[...(item.task_id ? [{ text: 'Done', callback_data: `done:${item.task_id}` }] : []), { text: 'Snooze 1 hour', callback_data: `snooze:${item.id}` }]];
      await send(env, item.text, buttons);
      await env.DB.prepare("UPDATE reminders SET state='sent' WHERE id=?").bind(item.id).run();
    } catch {
      await env.DB.prepare("UPDATE reminders SET state=?,due_at=?,lease_until=0 WHERE id=?").bind(item.attempts >= 3 ? 'failed' : 'pending', now + 5 * 60000, item.id).run();
    }
  }
}
