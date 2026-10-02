import type { Action } from './actions.ts';
import type { Env } from './types.ts';
import { UserError, RetryLater } from './types.ts';
import { calendarRequest, accessToken } from './google.ts';
import { getSetting } from './db.ts';
import { localInstant, localParts, addDays, stableId } from './time.ts';
import { listEvents, busyInterval, selectedCalendars, listOwnedCalendars, overlaps, eventLabel, type Match, type Calendar, type CalendarEvent } from './calendar-tools.ts';

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

export async function checkSession(env: Env, token: string, selected: Calendar[], action: Session, destination?: Calendar, scanned?: Match[]) {
  const { start, end } = sessionInterval(action);
  const id = await sessionId(action);
  const target = destination?.id ?? await getSetting(env, 'calendar_id');
  const calendars = [...selected];
  // Also check sessions previously placed in the destination, even if deselected.
  if (target && !calendars.some(c => c.id === target)) calendars.push(destination ?? { id: target, summary: 'Assignment Planner', accessRole: 'owner', timeZone: env.TIMEZONE });
  const matches = scanned ? scanned.filter(m => {
    const interval = busyInterval({ ...m.event, transparency: 'opaque', attendees: [] }, m.calendar.timeZone ?? action.timezone);
    return interval && interval.start < end && interval.end > start;
  }) : await listEvents(token, calendars, start, end);
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


export async function firstAvailableSession(env: Env, action: Extract<Action, { type: 'find_slot' }>): Promise<Session> {
  const from = localInstant(action.date_from, '00:00', action.timezone);
  const until = localInstant(addDays(action.date_to, 1), '00:00', action.timezone);
  if (action.date_to < action.date_from || addDays(action.date_from, 6) < action.date_to) throw new UserError('Please search a range of at most seven calendar days.');
  const earliest = action.time ?? '09:00', latest = action.end_time ?? '21:00';
  if (earliest >= latest) throw new UserError('Please give daytime search hours with the end after the start. Split overnight searches into separate days.');
  const token = await accessToken(env);
  const calendars = await selectedCalendars(env, token, true);
  const destination = await resolveDestination(token, action.calendar_name);
  if (destination && !calendars.some(c => c.id === destination.id)) calendars.push(destination);
  const matches = await listEvents(token, calendars, from, until);
  const busy = matches.map(m => busyInterval(m.event, m.calendar.timeZone ?? action.timezone)).filter((v): v is { start: number; end: number } => v !== null).sort((a, b) => a.start - b.start);
  const duration = action.duration_minutes * 60000;
  for (let day = action.date_from; day <= action.date_to; day = addDays(day, 1)) {
    let start = Math.max(localInstant(day, earliest, action.timezone), Math.ceil((Date.now() + 60000) / 60000) * 60000);
    const end = localInstant(day, latest, action.timezone);
    for (const interval of busy) {
      if (interval.end <= start) continue;
      if (interval.start >= start + duration) break;
      start = Math.ceil(interval.end / 60000) * 60000;
    }
    if (start + duration > end) continue;
    const first = localParts(start, action.timezone), last = localParts(start + duration, action.timezone);
    // Reuse the existing ambiguity checks instead of proposing a repeated DST time.
    if (localInstant(first.date, first.time, action.timezone) !== start || localInstant(last.date, last.time, action.timezone) !== start + duration) throw new UserError('That slot crosses an ambiguous local time. Please choose a different search window.');
    return { type: 'create_event', title: action.title, date: first.date, time: first.time, end_date: last.date, end_time: last.time, timezone: action.timezone, description: action.description, location: action.location, calendar_name: action.calendar_name };
  }
  throw new UserError('No free ' + action.duration_minutes + '-minute slot was found from ' + action.date_from + ' through ' + action.date_to + ' between ' + earliest + ' and ' + latest + ' (' + action.timezone + '). Nothing was scheduled. Try a wider date range or different hours.');
}


export async function resolveDestination(token: string, name?: string | null, reviewed?: Calendar): Promise<Calendar | undefined> {
  if (!name) return undefined;
  const owned = await listOwnedCalendars(token);
  if (reviewed) {
    const current = owned.find(c => c.id === reviewed.id);
    if (!current) throw new UserError('The reviewed destination calendar is no longer owned or accessible. Request a new preview; nothing was redirected.');
    return current;
  }
  const normalized = name.trim().toLocaleLowerCase();
  const matches = owned.filter(c => c.summary.trim().toLocaleLowerCase() === normalized || (normalized === 'primary' && c.primary));
  if (matches.length !== 1) throw new UserError(matches.length ? 'Several owned calendars have that name. Give them distinct names in Google Calendar, then try again.' : 'No owned calendar matches "' + name + '". Available names: ' + owned.map(c => c.summary).join(', ') + '. Nothing was redirected to another calendar.');
  return matches[0];
}


export async function checkSessionBatch(env: Env, token: string, selected: Calendar[], sessions: { action: Session; destination?: Calendar }[]) {
  const calendars = [...selected];
  const planner = await getSetting(env, 'calendar_id');
  if (planner && !calendars.some(c => c.id === planner)) calendars.push({ id: planner, summary: 'Assignment Planner', accessRole: 'owner', timeZone: env.TIMEZONE });
  for (const { destination } of sessions) if (destination && !calendars.some(c => c.id === destination.id)) calendars.push(destination);
  const intervals = sessions.map(s => sessionInterval(s.action));
  const start = Math.min(...intervals.map(i => i.start)), end = Math.max(...intervals.map(i => i.end));
  if (end - start > 367 * 86400000) throw new UserError('Please split event imports into ranges of at most one year.');
  for (let i = 0; i < intervals.length; i++) for (let j = 0; j < i; j++) {
    if (intervals[i].start < intervals[j].end && intervals[i].end > intervals[j].start) throw new UserError('Two requested events overlap: ' + sessions[j].action.title + ' and ' + sessions[i].action.title + '. Please adjust their times or send them separately. Nothing was added.');
  }
  const matches = await listEvents(token, calendars, start, end);
  for (const item of sessions) await checkSession(env, token, calendars, item.action, item.destination, matches);
}
