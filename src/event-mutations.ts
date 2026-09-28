import type { Env } from './types.ts';
import { UserError, RetryLater } from './types.ts';
import type { Action } from './actions.ts';
import { calendarRequest } from './google.ts';
import { getSetting } from './db.ts';
import { localInstant, formatInterval } from './time.ts';
import { resolveEvent, selectedCalendars, listEvents, overlaps, eventLabel, type Calendar, type CalendarEvent } from './calendar-tools.ts';

export type EventMutation = Extract<Action, { type: 'rename_event' | 'reschedule_event' | 'delete_event' }>;
export interface MutationSnapshot {
  calendar: Calendar;
  event: CalendarEvent;
  action: EventMutation;
}

function interval(action: Extract<EventMutation, { type: 'reschedule_event' }>) {
  const start = localInstant(action.date, action.time, action.timezone);
  const end = localInstant(action.end_date, action.end_time, action.timezone);
  if (end <= start || end - start > 7 * 86400000) throw new UserError('Please give a new end after the start, within seven days.');
  if (start <= Date.now()) throw new UserError('Please choose a future start time.');
  return { start, end };
}

async function checkMove(token: string, calendars: Calendar[], snapshot: MutationSnapshot) {
  if (snapshot.action.type !== 'reschedule_event') return;
  const { start, end } = interval(snapshot.action);
  const matches = await listEvents(token, calendars, start, end);
  const conflicts = matches.filter(m => !(m.calendar.id === snapshot.calendar.id && m.event.id === snapshot.event.id) && overlaps(m.event, m.calendar.timeZone ?? snapshot.action.timezone, start, end));
  if (conflicts.length) throw new UserError(`The new time overlaps ${conflicts.length} busy event(s):\n${conflicts.slice(0, 5).map(m => eventLabel(m, snapshot.action.timezone)).join('\n\n')}\nChoose another time. Nothing was moved.`);
}

export async function prepareMutation(env: Env, token: string, calendars: Calendar[], action: EventMutation): Promise<MutationSnapshot> {
  const match = await resolveEvent(env, token, calendars, action);
  if (action.type === 'reschedule_event') {
    if (match.event.recurrence) throw new UserError('Moving an entire recurring series is not supported yet. Request one occurrence, or change the series in Google Calendar.');
    if (!match.event.start.dateTime) throw new UserError('This is an all-day event. Moving all-day events is not supported yet.');
    if (match.event.extendedProperties?.private?.plannerTaskId) throw new UserError('This is an assignment deadline. Ask to change the assignment due date/time instead of moving it as a session.');
    interval(action);
  }
  // Confirmation rechecks availability. Avoid two full scans in a single Worker
  // invocation (one to find the event and another to check its proposed interval).
  return { calendar: match.calendar, event: match.event, action };
}

export function mutationPreview(snapshot: MutationSnapshot, zone: string) {
  const { action, event } = snapshot;
  const scope = event.recurrence ? 'ENTIRE recurring series (all occurrences)' : event.recurringEventId ? 'Only this occurrence' : 'This single event';
  let change: string;
  if (action.type === 'delete_event') change = 'DELETE this event from Google Calendar. Any linked assignment will be cancelled and its pending task reminders stopped. Standalone session reminders are separate; cancel those separately.';
  else if (action.type === 'rename_event') change = `Title: ${event.summary ?? '(Untitled)'} → ${action.title}\nTimes and other details stay unchanged.`;
  else {
    const { start, end } = interval(action);
    change = `New time: ${formatInterval(start, end, zone)}\nConflicts will be checked when you confirm. Existing reminders keep their times.`;
  }
  return `${eventLabel(snapshot, zone)}\nScope: ${scope}\n\n${change}${event.attendees?.length ? '\nGoogle will notify the event guests about this change.' : ''}`;
}

async function syncManagedTask(env: Env, snapshot: MutationSnapshot, title?: string) {
  const taskId = snapshot.event.extendedProperties?.private?.plannerTaskId;
  if (!taskId || snapshot.calendar.id !== await getSetting(env, 'calendar_id')) return;
  if (snapshot.action.type === 'delete_event') {
    await env.DB.batch([
      env.DB.prepare("UPDATE tasks SET status='cancelled' WHERE id=? AND calendar_event_id=?").bind(taskId, snapshot.event.id),
      env.DB.prepare("UPDATE reminders SET state='cancelled' WHERE task_id=? AND state IN ('pending','sending') AND EXISTS (SELECT 1 FROM tasks WHERE id=? AND calendar_event_id=?)").bind(taskId, taskId, snapshot.event.id)
    ]);
  } else if (snapshot.action.type === 'rename_event') {
    await env.DB.prepare('UPDATE tasks SET title=? WHERE id=? AND calendar_event_id=?').bind(title ?? snapshot.action.title, taskId, snapshot.event.id).run();
  }
}

export async function applyMutation(env: Env, token: string, snapshot: MutationSnapshot, operationId: string) {
  const calendars = await selectedCalendars(env, token, true);
  if (!calendars.some(c => c.id === snapshot.calendar.id)) throw new UserError('This calendar is no longer selected. Please request a new preview.');
  const path = `calendars/${encodeURIComponent(snapshot.calendar.id)}/events/${encodeURIComponent(snapshot.event.id)}`;
  const read = await calendarRequest(token, path);
  const deleting = snapshot.action.type === 'delete_event';
  if (deleting && [404, 410].includes(read.status)) { await syncManagedTask(env, snapshot); return; }
  if (!read.ok) throw new UserError('Could not read the current event. Please check access and request a new preview.');
  const current = await read.json() as CalendarEvent;
  if (deleting && current.status === 'cancelled') { await syncManagedTask(env, snapshot); return; }
  if (current.status === 'cancelled') throw new UserError('This event was cancelled. Nothing changed.');
  if (!deleting && current.extendedProperties?.private?.plannerLastEdit === operationId) { await syncManagedTask(env, snapshot, current.summary); return; }
  if (!current.etag || current.etag !== snapshot.event.etag) throw new UserError('This event changed after your preview. Request a fresh preview; nothing was changed.');
  await checkMove(token, calendars, snapshot);
  let patch: Record<string, unknown> | undefined;
  if (!deleting) {
    patch = { extendedProperties: { private: { ...current.extendedProperties?.private, plannerLastEdit: operationId } } };
    if (snapshot.action.type === 'rename_event') patch.summary = snapshot.action.title;
    else if (snapshot.action.type === 'reschedule_event') {
      const { start, end } = interval(snapshot.action);
      patch.start = { dateTime: new Date(start).toISOString(), timeZone: snapshot.action.timezone };
      patch.end = { dateTime: new Date(end).toISOString(), timeZone: snapshot.action.timezone };
    }
  }
  const response = await calendarRequest(token, path + '?sendUpdates=all', deleting ? 'DELETE' : 'PATCH', patch, current.etag);
  if (response.status === 412) throw new UserError('The event changed during confirmation. Request a fresh preview. Nothing was overwritten.');
  if (!response.ok && !(deleting && [404, 410].includes(response.status))) {
    if ([400, 401, 403, 404, 410].includes(response.status)) throw new UserError('Google could not apply this change. Check calendar access and request a new preview.');
    throw new RetryLater('Google Calendar is temporarily unavailable.');
  }
  await syncManagedTask(env, snapshot);
}
