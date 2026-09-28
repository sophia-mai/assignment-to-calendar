import type { Action } from './actions.ts';
import type { Env } from './types.ts';
import { UserError, RetryLater } from './types.ts';
import { calendarRequest } from './google.ts';
import { getSetting } from './db.ts';
import { localInstant, stableId } from './time.ts';
import { listEvents, overlaps, eventLabel, type Calendar, type CalendarEvent } from './calendar-tools.ts';

type Session = Extract<Action, { type: 'create_event' }>;

export function sessionInterval(action: Session) {
  const start = localInstant(action.date, action.time, action.timezone);
  const end = localInstant(action.end_date, action.end_time, action.timezone);
  if (end <= start || end - start > 7 * 86400000) throw new UserError('Please give the session an end after its start, within seven days.');
  return { start, end };
}

export async function sessionId(action: Session) {
  const { start, end } = sessionInterval(action);
  return stableId(JSON.stringify(['session', action.title.trim().toLowerCase().replace(/\s+/g, ' '), start, end]));
}

export async function checkSession(env: Env, token: string, selected: Calendar[], action: Session) {
  const { start, end } = sessionInterval(action);
  const id = await sessionId(action);
  const target = await getSetting(env, 'calendar_id');
  const calendars = [...selected];
  // Also check sessions previously placed in the destination, even if deselected.
  if (target && !calendars.some(c => c.id === target)) calendars.push({ id: target, summary: 'Assignment Planner', accessRole: 'owner', timeZone: env.TIMEZONE });
  const matches = await listEvents(token, calendars, start, end);
  const other = matches.filter(m => !(m.calendar.id === target && m.event.id === id && m.event.extendedProperties?.private?.plannerSessionId === id));
  const duplicates = other.filter(m => (m.event.summary ?? '').trim().toLowerCase() === action.title.trim().toLowerCase());
  if (duplicates.length) throw new UserError(`That session may already be on your calendar:\n${duplicates.slice(0, 5).map(m => eventLabel(m, action.timezone)).join('\n')}\nNo duplicate was added. Ask to update that event or choose a different time.`);
  const conflicts = other.filter(m => overlaps(m.event, m.calendar.timeZone ?? action.timezone, start, end));
  if (conflicts.length) throw new UserError(`That session overlaps ${conflicts.length} busy event(s):\n${conflicts.slice(0, 5).map(m => eventLabel(m, action.timezone)).join('\n')}\nPlease choose another time. No new session was added.`);
}

export async function createSession(token: string, calendar: string, action: Session) {
  const id = await sessionId(action);
  const { start, end } = sessionInterval(action);
  const path = `calendars/${encodeURIComponent(calendar)}/events`;
  let response = await calendarRequest(token, path, 'POST', {
    id, summary: action.title, description: action.description,
    ...(action.location ? { location: action.location } : {}),
    start: { dateTime: new Date(start).toISOString(), timeZone: action.timezone },
    end: { dateTime: new Date(end).toISOString(), timeZone: action.timezone },
    transparency: 'opaque', reminders: { useDefault: false },
    extendedProperties: { private: { plannerSessionId: id } }
  });
  if (response.status === 409) response = await calendarRequest(token, `${path}/${id}`);
  if (!response.ok) {
    if ([401, 403, 404, 410].includes(response.status)) throw new UserError('Calendar access or this session is unavailable. Use /connect and check Assignment Planner.');
    throw new RetryLater('Google Calendar is temporarily unavailable.');
  }
  const event = await response.json() as CalendarEvent;
  if (event.status === 'cancelled' || event.extendedProperties?.private?.plannerSessionId !== id) throw new UserError('The existing event no longer matches this session. Nothing was overwritten; please review it in Google Calendar.');
  return event.htmlLink;
}
