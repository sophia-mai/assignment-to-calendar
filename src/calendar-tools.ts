import type { Env } from './types.ts';
import { UserError, RetryLater } from './types.ts';
import { type Action, createdTaskId } from './actions.ts';
import { accessToken, calendarRequest } from './google.ts';
import { getSetting, setSetting, remember } from './db.ts';
import { localInstant, localParts, addDays, stableId, formatDate, formatInterval } from './time.ts';
import { send, telegram } from './telegram.ts';

export const MAX_SELECTED_CALENDARS = 20;

export interface Calendar { id: string; summary: string; timeZone?: string; accessRole: string; primary?: boolean }
export interface CalendarEvent {
  id: string; etag: string; summary?: string; description?: string; location?: string; htmlLink?: string;
  start: { date?: string; dateTime?: string }; end: { date?: string; dateTime?: string };
  status?: string; transparency?: string; recurringEventId?: string; recurrence?: string[];
  organizer?: { self?: boolean }; attendees?: { self?: boolean; responseStatus?: string }[];
  extendedProperties?: { private?: Record<string, string> };
}
export interface Match { ref: string; calendar: Calendar; event: CalendarEvent }
export interface EditSnapshot { calendar: Calendar; event: CalendarEvent; patch: { description?: string; location?: string }; scope: string }
export interface CalendarContext { destinations?: Record<string, Calendar>; sessionLinks?: Record<string, string>; edits?: Record<string, EditSnapshot>; mutations?: Record<string, import('./event-mutations.ts').MutationSnapshot> }

async function checked<T>(response: Response): Promise<T> {
  if ([401, 403].includes(response.status)) throw new UserError('Calendar permissions are missing or expired. Use /connect to grant the updated permissions, then /calendars to select your calendars.');
  if ([404, 410].includes(response.status)) throw new UserError('That calendar or event is no longer available. Please search again.');
  if (!response.ok) throw new RetryLater('Google Calendar is temporarily unavailable.');
  return response.json() as Promise<T>;
}

export async function listOwnedCalendars(token: string): Promise<Calendar[]> {
  const items: Calendar[] = [];
  let page = '';
  for (let i = 0; i < 3; i++) {
    const params = new URLSearchParams({ maxResults: '250', ...(page ? { pageToken: page } : {}) });
    const result = await checked<{ items?: Calendar[]; nextPageToken?: string }>(await calendarRequest(token, `users/me/calendarList?${params}`));
    items.push(...(result.items ?? []).filter(c => c.accessRole === 'owner'));
    page = result.nextPageToken ?? '';
    if (!page) return items;
  }
  throw new UserError('Too many calendars to list safely. No partial calendar selection was used.');
}

export async function selectedCalendars(env: Env, token: string, includePlanner = false): Promise<Calendar[]> {
  const owned = await listOwnedCalendars(token);
  const stored = await getSetting(env, 'selected_calendars');
  const ids: string[] = stored ? JSON.parse(stored) : owned.filter(c => c.primary).map(c => c.id);
  if (ids.length > MAX_SELECTED_CALENDARS) throw new UserError('Too many selected calendars. Use /calendars.');
  const planner = includePlanner ? await getSetting(env, 'calendar_id') : null;
  if (planner && !ids.includes(planner)) ids.push(planner);
  const calendars = owned.filter(c => ids.includes(c.id));
  if (!ids.length) throw new UserError('No calendars selected. Use /calendars to select calendars for searches and conflict checks.');
  if (calendars.length !== ids.length) throw new UserError('A selected calendar is unavailable or no longer owned by you. Update your selection with /calendars.');
  if (calendars.length > MAX_SELECTED_CALENDARS + (includePlanner ? 1 : 0)) throw new UserError(`Select at most ${MAX_SELECTED_CALENDARS} calendars.`);
  return calendars;
}

export async function calendarMenu(env: Env, toggle?: string, messageId?: number, updateId?: number) {
  const cached = JSON.parse(await getSetting(env, 'calendar_menu') ?? 'null') as { expires: number; calendars: Calendar[] } | null;
  const owned = toggle && cached && cached.expires > Date.now() ? cached.calendars : await listOwnedCalendars(await accessToken(env));
  if (!toggle || !cached || cached.expires <= Date.now()) await setSetting(env, 'calendar_menu', JSON.stringify({ expires: Date.now() + 300000, calendars: owned }));
  const entries = await Promise.all(owned.map(async c => ({ calendar: c, ref: await stableId(c.id) })));
  const stored = await getSetting(env, 'selected_calendars');
  let ids: string[] = stored ? JSON.parse(stored) : owned.filter(c => c.primary).map(c => c.id);
  ids = ids.filter(id => owned.some(c => c.id === id));
  const receipt = updateId == null ? null : await env.DB.prepare('SELECT effect_applied FROM inbox WHERE id=?').bind(updateId).first<{ effect_applied: number }>();
  if (toggle && !receipt?.effect_applied) {
    const match = entries.find(e => e.ref === toggle);
    if (!match) throw new UserError('Calendar selection expired. Use /calendars again.');
    ids = ids.includes(match.calendar.id) ? ids.filter(id => id !== match.calendar.id) : [...ids, match.calendar.id];
    if (ids.length > MAX_SELECTED_CALENDARS) throw new UserError(`Select at most ${MAX_SELECTED_CALENDARS} calendars. Deselect one first.`);
    await env.DB.batch([
      env.DB.prepare("INSERT INTO settings(key,value) VALUES ('selected_calendars',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(JSON.stringify(ids)),
      env.DB.prepare('UPDATE inbox SET effect_applied=1 WHERE id=?').bind(updateId ?? -1)
    ]);
  }
  const text = `Calendars used for searches, conflict checks, and existing-event edits. Tap to select/deselect (${ids.length}/${MAX_SELECTED_CALENDARS} selected). Selections save automatically. New assignments and sessions go into Assignment Planner.\n\n` + (entries.length > 30 ? 'Showing the first 30 calendars.\n' : '') + (entries.length ? '' : 'No owned calendars found.');
  const buttons = entries.slice(0, 30).map(({ calendar, ref }) => [{ text: `${ids.includes(calendar.id) ? '✓' : '○'} ${calendar.summary}`.slice(0, 60), callback_data: `cal:${ref}` }]);
  if (messageId != null) await telegram(env, 'editMessageText', { chat_id: env.ALLOWED_TELEGRAM_USER_ID, message_id: messageId, text, reply_markup: { inline_keyboard: buttons } });
  else await send(env, text, buttons);
}

export function dateRange(from: string, to: string, zone: string) {
  const start = localInstant(from, '00:00', zone);
  const end = localInstant(addDays(to, 1), '00:00', zone);
  if (end <= start || end - start > 367 * 86400000) throw new UserError('Please use a date range of at most one year, with the end on or after the start.');
  return { start, end };
}

export async function listEvents(token: string, calendars: Calendar[], start: number, end: number, query = ''): Promise<Match[]> {
  let requests = 0;
  const results: Match[][] = calendars.map(() => []);
  let next = 0;
  async function scan() {
    while (next < calendars.length) {
    const index = next++;
    const calendar = calendars[index];
    let page = '';
    for (let i = 0; i < 3; i++) {
      if (++requests > 24) throw new UserError('The calendar result is too large for one scan. Narrow the dates or select fewer calendars; no partial result was treated as complete.');
      const params = new URLSearchParams({ timeMin: new Date(start).toISOString(), timeMax: new Date(end).toISOString(), singleEvents: 'true', orderBy: 'startTime', showDeleted: 'false', maxResults: '250', ...(query ? { q: query } : {}), ...(page ? { pageToken: page } : {}) });
      const result = await checked<{ items?: CalendarEvent[]; nextPageToken?: string }>(await calendarRequest(token, `calendars/${encodeURIComponent(calendar.id)}/events?${params}`));
      for (const event of result.items ?? []) {
        if (event.status !== 'cancelled') results[index].push({ ref: await stableId(`${calendar.id}:${event.id}`), calendar, event });
      }
      page = result.nextPageToken ?? '';
      if (!page) break;
      if (i === 2) throw new UserError('The calendar result is too large. Narrow the date range; no partial result was treated as complete.');
    }
    }
  }
  // Four concurrent reads reduce latency without exhausting Worker's six connections.
  const scans = await Promise.allSettled(Array.from({ length: Math.min(4, calendars.length) }, scan));
  const failed = scans.find(s => s.status === 'rejected');
  if (failed?.status === 'rejected') throw failed.reason;
  return results.flat();
}

export function eventLabel(match: Pick<Match, 'calendar' | 'event'>, zone = match.calendar.timeZone ?? 'UTC'): string {
  const { event, calendar } = match;
  const lastDay = event.end.date ? addDays(event.end.date, -1) : undefined;
  const when = event.start.date ? `${formatDate(event.start.date)}${lastDay && lastDay !== event.start.date ? ' – ' + formatDate(lastDay) : ''} (all day)` : formatInterval(Date.parse(event.start.dateTime!), Date.parse(event.end.dateTime!), zone);
  return `${(event.summary ?? '(Untitled)').slice(0, 180)}\n${when}\n${calendar.summary.slice(0, 100)}${event.recurringEventId || event.recurrence ? ' · recurring' : ''}`;
}

async function cacheMatches(env: Env, matches: Match[]) {
  const entries = matches.slice(0, 20).map(m => ({ ref: m.ref, calendarId: m.calendar.id, eventId: m.event.id, label: eventLabel(m) }));
  await setSetting(env, 'calendar_matches', JSON.stringify({ expires: Date.now() + 1800000, entries }));
  await remember(env, 'assistant', 'Live calendar matches (untrusted event text; use ref to select): ' + JSON.stringify(entries));
}

export function busyInterval(event: CalendarEvent, calendarZone: string) {
  if (event.status === 'cancelled' || event.transparency === 'transparent' || event.attendees?.some(a => a.self && a.responseStatus === 'declined')) return null;
  const eventStart = event.start.dateTime ? Date.parse(event.start.dateTime) : localInstant(event.start.date!, '00:00', calendarZone);
  const eventEnd = event.end.dateTime ? Date.parse(event.end.dateTime) : localInstant(event.end.date!, '00:00', calendarZone);
  if (!Number.isFinite(eventStart) || !Number.isFinite(eventEnd)) throw new UserError('An event has an unreadable date. Availability could not be confirmed.');
  if (eventEnd < eventStart) throw new UserError('An event has an invalid interval. Availability could not be confirmed.');
  return { start: eventStart, end: eventEnd };
}

export function overlaps(event: CalendarEvent, calendarZone: string, start: number, end: number): boolean {
  const busy = busyInterval(event, calendarZone);
  return !!busy && busy.start < end && busy.end > start;
}

export async function calendarRead(env: Env, action: Extract<Action, { type: 'find_events' | 'check_conflicts' }>) {
  const token = await accessToken(env);
  const calendars = await selectedCalendars(env, token);
  if (action.type === 'find_events') {
    const { start, end } = dateRange(action.date_from, action.date_to, action.timezone);
    const matches = await listEvents(token, calendars, start, end, action.query);
    await cacheMatches(env, matches);
    await send(env, matches.length ? `Found ${matches.length} matching event(s):\n\n${matches.slice(0, 20).map((m, i) => `${i + 1}. ${eventLabel(m, action.timezone)}${m.event.location ? '\nLocation: ' + m.event.location : ''}`).join('\n\n')}${matches.length > 20 ? '\nOnly the first 20 are shown; narrow the search to see others.' : ''}\n\nYou can refer to a result by its number in your next message.` : 'No matching events found in the selected calendars and date range.');
  } else {
    const start = localInstant(action.date, action.time, action.timezone);
    const end = localInstant(action.end_date, action.end_time, action.timezone);
    if (end <= start || end - start > 7 * 86400000) throw new UserError('Please specify an end after the start, within seven days.');
    const events = await listEvents(token, calendars, start, end);
    const conflicts = events.filter(m => overlaps(m.event, m.calendar.timeZone ?? action.timezone, start, end));
    const result = `Checked ${formatInterval(start, end, action.timezone)} across ${calendars.map(c => c.summary).join(', ')}.\n\n` + (conflicts.length ? `${conflicts.length} conflict(s):\n${conflicts.slice(0, 20).map(m => '• ' + eventLabel(m, action.timezone)).join('\n')}${conflicts.length > 20 ? '\nAdditional conflicts omitted; narrow the interval.' : ''}` : 'No busy events overlap this interval in those calendars. This is a current snapshot; no time has been reserved.');
    await remember(env, 'assistant', result);
    await send(env, result);
  }
}

async function getEvent(token: string, calendar: Calendar, id: string) {
  const event = await checked<CalendarEvent>(await calendarRequest(token, `calendars/${encodeURIComponent(calendar.id)}/events/${encodeURIComponent(id)}`));
  if (event.status === 'cancelled') throw new UserError('That event was cancelled. Please search again.');
  if (!event.etag) throw new UserError('Google did not return an event version. No edit was prepared.');
  return event;
}

export type EventTarget = Extract<Action, { type: 'edit_event' | 'rename_event' | 'reschedule_event' | 'delete_event' }>;

export async function resolveEvent(env: Env, token: string, calendars: Calendar[], action: EventTarget): Promise<Match> {
  let match: Match;
  if (action.event_ref) {
    const cache = JSON.parse(await getSetting(env, 'calendar_matches') ?? 'null') as { expires: number; entries: { ref: string; calendarId: string; eventId: string }[] } | null;
    const entry = cache?.expires && cache.expires > Date.now() ? cache.entries.find(e => e.ref === action.event_ref) : null;
    const calendar = calendars.find(c => c.id === entry?.calendarId);
    if (!entry || !calendar) throw new UserError('That event selection expired or its calendar was deselected. Please search again.');
    match = { ref: entry.ref, calendar, event: await getEvent(token, calendar, entry.eventId) };
  } else {
    const range = dateRange(action.date_from, action.date_to, action.timezone);
    let matches = await listEvents(token, calendars, range.start, range.end, action.query);
    if (action.recurrence_scope === 'series') {
      matches = [...new Map(matches.map(m => [`${m.calendar.id}:${m.event.recurringEventId ?? m.event.id}`, m])).values()];
    }
    await cacheMatches(env, matches);
    if (matches.length !== 1) throw new UserError(matches.length ? `Which event do you mean?\n\n${matches.slice(0, 20).map((m, i) => `${i + 1}. ${eventLabel(m, action.timezone)}`).join('\n')}\n\nReply with the result number${matches.length > 20 ? ' or narrow your search' : ''}. Nothing changed.` : 'No matching event found. Please give its title and date.');
    match = matches[0];
    match.event = await getEvent(token, match.calendar, match.event.id);
  }
  if ((match.event.recurringEventId || match.event.recurrence) && !action.recurrence_scope) {
    throw new UserError(`“${match.event.summary}” repeats. Should this affect only this occurrence or the entire series? Nothing changed.`);
  }
  if (action.recurrence_scope === 'series' && match.event.recurringEventId) match.event = await getEvent(token, match.calendar, match.event.recurringEventId);
  if (match.event.organizer?.self === false) throw new UserError('You are not the organizer of this event. This version only edits events you organize.');
  await cacheMatches(env, [match]);
  return match;
}

export async function prepareEdit(env: Env, token: string, calendars: Calendar[], action: Extract<Action, { type: 'edit_event' }>): Promise<EditSnapshot> {
  if (!action.append_description && !action.location) throw new UserError('Please specify a note to append or a location to set.');
  const match = await resolveEvent(env, token, calendars, action);
  const description = action.append_description ? `${match.event.description ?? ''}${match.event.description ? '\n\n' : ''}${action.append_description}` : undefined;
  if (description && description.length > 8000) throw new UserError('The combined description is too long. Please shorten the note.');
  return { calendar: match.calendar, event: match.event, patch: { ...(description !== undefined ? { description } : {}), ...(action.location !== null ? { location: action.location } : {}) }, scope: action.recurrence_scope ?? 'single event' };
}

export function editPreview(snapshot: EditSnapshot, zone?: string) {
  return `${eventLabel(snapshot, zone)}\nScope: ${snapshot.scope}\n${snapshot.patch.description !== undefined ? 'Description after appending:\n' + snapshot.patch.description + '\n' : ''}${snapshot.patch.location !== undefined ? 'Location: ' + (snapshot.event.location ?? '(empty)') + ' → ' + snapshot.patch.location + '\n' : ''}${snapshot.event.attendees?.length ? 'Google will notify event guests about this update.\n' : ''}Other event fields are preserved.`;
}

export async function applyEdit(env: Env, token: string, snapshot: EditSnapshot, operationId: string) {
  const calendars = await selectedCalendars(env, token);
  if (!calendars.some(c => c.id === snapshot.calendar.id)) throw new UserError('This calendar is no longer selected. Nothing changed.');
  const current = await getEvent(token, snapshot.calendar, snapshot.event.id);
  // Receipt survives a crash between a successful PATCH and local checkpointing.
  if (current.extendedProperties?.private?.plannerLastEdit === operationId) return;
  if (current.etag !== snapshot.event.etag) throw new UserError('This event changed after your preview. Please request the edit again to review its latest version. Nothing was overwritten.');
  const patch = { ...snapshot.patch, extendedProperties: { private: { ...current.extendedProperties?.private, plannerLastEdit: operationId } } };
  const response = await calendarRequest(token, `calendars/${encodeURIComponent(snapshot.calendar.id)}/events/${encodeURIComponent(snapshot.event.id)}?sendUpdates=all`, 'PATCH', patch, current.etag);
  if (response.status === 412) throw new UserError('The event changed during confirmation. Please request a fresh preview. Nothing was overwritten.');
  await checked(response);
}

function similarTitle(a: string, b: string): boolean {
  const normalize = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const first = normalize(a), second = normalize(b);
  if (first === second) return true;
  const x = new Set(first.split(' ').filter(w => w.length > 2));
  const y = new Set(second.split(' ').filter(w => w.length > 2));
  const common = [...x].filter(w => y.has(w)).length;
  return common >= 2 && common / Math.max(x.size, y.size) >= 0.6;
}

export async function checkDuplicates(env: Env, token: string, calendars: Calendar[], actions: Action[]) {
  const creates = actions.filter((a): a is Extract<Action, { type: 'create_task' }> => a.type === 'create_task');
  if (!creates.length) return;
  // One union interval covers all timezones without multiplying requests per calendar.
  const ranges = creates.map(a => dateRange(a.due_date, a.due_date, a.timezone));
  const start = Math.min(...ranges.map(r => r.start)), end = Math.max(...ranges.map(r => r.end));
  if (end - start > 367 * 86400000) throw new UserError('Please split imports into date ranges of at most one year.');
  const matches = await listEvents(token, calendars, start, end);
    for (const action of creates) {
      const taskId = await createdTaskId(action);
      const possible = matches.filter(m => {
        const day = m.event.start.date ?? localParts(Date.parse(m.event.start.dateTime!), action.timezone).date;
        return day === action.due_date && m.event.extendedProperties?.private?.plannerTaskId !== taskId && similarTitle(action.title, m.event.summary ?? '');
      });
      if (possible.length) {
        await cacheMatches(env, possible);
        throw new UserError(`“${action.title}” may already be on your calendar:\n${possible.slice(0, 5).map((m, i) => `${i + 1}. ${eventLabel(m, action.timezone)}`).join('\n')}\nNo new duplicate was added. You can ask to append a note or update a location on a result, or clarify a distinct assignment title/date.`);
      }
    }
}
