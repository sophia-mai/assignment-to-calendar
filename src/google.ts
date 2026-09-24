import type { Env, Task } from './types.ts';
import { UserError, RetryLater } from './types.ts';
import { getSetting, setSetting } from './db.ts';
import { addDays, localInstant } from './time.ts';

function base64(bytes: Uint8Array): string { return btoa(String.fromCharCode(...bytes)); }
function unbase64(value: string): Uint8Array { return Uint8Array.from(atob(value), c => c.charCodeAt(0)); }

async function encryptionKey(env: Env) {
  try {
    const raw = unbase64(env.TOKEN_ENCRYPTION_KEY);
    if (raw.length !== 32) throw new Error();
    return await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
  } catch { throw new UserError('The token encryption key must be configured as 32 random bytes in base64.'); }
}

export async function seal(env: Env, text: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await encryptionKey(env), new TextEncoder().encode(text));
  return base64(iv) + '.' + base64(new Uint8Array(encrypted));
}

async function unseal(env: Env, text: string) {
  const [iv, ciphertext] = text.split('.');
  const bytes = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unbase64(iv) }, await encryptionKey(env), unbase64(ciphertext));
  return new TextDecoder().decode(bytes);
}

export async function connectLink(env: Env) {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET || !env.PUBLIC_BASE_URL) throw new UserError('Google OAuth is not configured yet. See the setup guide.');
  await encryptionKey(env);
  const state = crypto.randomUUID();
  await env.DB.prepare('INSERT INTO oauth_states(state,expires_at) VALUES (?,?)').bind(state, Date.now() + 10 * 60000).run();
  return `${env.PUBLIC_BASE_URL}/oauth/start?state=${state}`;
}

export async function oauthStart(env: Env, state: string) {
  const row = await env.DB.prepare('UPDATE oauth_states SET started=1 WHERE state=? AND expires_at>? AND started=0 RETURNING state').bind(state, Date.now()).first();
  if (!row) return new Response('Link expired or already used. Send /connect to the bot for a new link.', { status: 400 });
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.search = new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID, redirect_uri: `${env.PUBLIC_BASE_URL}/oauth/callback`, response_type: 'code', scope: 'https://www.googleapis.com/auth/calendar.app.created', access_type: 'offline', prompt: 'consent', state }).toString();
  return Response.redirect(url.toString(), 302);
}

async function tokenRequest(env: Env, params: Record<string, string>) {
  const response = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, ...params }), signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new UserError('Google authorization failed or expired. Send /connect to reconnect.');
  return await response.json() as { access_token: string; refresh_token?: string };
}

export async function oauthCallback(env: Env, url: URL) {
  const state = url.searchParams.get('state') ?? '';
  const row = await env.DB.prepare('DELETE FROM oauth_states WHERE state=? AND expires_at>? AND started=1 RETURNING state').bind(state, Date.now()).first();
  if (!row) return new Response('Invalid or expired authorization. Send /connect to try again.', { status: 400 });
  const code = url.searchParams.get('code');
  if (!code || url.searchParams.has('error')) return new Response('Connection cancelled. Return to Telegram.', { status: 400 });
  const tokens = await tokenRequest(env, { code, grant_type: 'authorization_code', redirect_uri: `${env.PUBLIC_BASE_URL}/oauth/callback` });
  if (!tokens.refresh_token) throw new UserError('Google did not provide offline access. Revoke the app in Google settings and reconnect.');
  await setSetting(env, 'google_refresh_token', await seal(env, tokens.refresh_token));
  return new Response('Google connected. Return to Telegram and approve your first import. The app creates its own Assignment Planner calendar.', { headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } });
}

export async function accessToken(env: Env) {
  const encrypted = await getSetting(env, 'google_refresh_token');
  if (!encrypted) throw new UserError('Connect Google Calendar first with /connect, then approve this proposal again.');
  const tokens = await tokenRequest(env, { refresh_token: await unseal(env, encrypted), grant_type: 'refresh_token' });
  return tokens.access_token;
}

async function calendarRequest(token: string, path: string, method = 'GET', body?: unknown) {
  return fetch(`https://www.googleapis.com/calendar/v3/${path}`, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(10000) });
}

export async function ensureCalendar(env: Env, token: string) {
  const id = await getSetting(env, 'calendar_id');
  if (id) {
    const response = await calendarRequest(token, `calendars/${encodeURIComponent(id)}`);
    if (response.ok) return id;
    if ([403, 404].includes(response.status)) throw new UserError('The saved planner calendar is inaccessible. Reconnect the original Google account; switching accounts is not supported yet.');
    throw new RetryLater('Could not verify the calendar.');
  }
  // A crash after creating a calendar cannot be retried safely: require manual recovery.
  if (await getSetting(env, 'calendar_creation_pending')) throw new UserError('Calendar creation needs recovery. Check Google Calendar for Assignment Planner and follow README recovery instructions.');
  await setSetting(env, 'calendar_creation_pending', '1');
  const response = await calendarRequest(token, 'calendars', 'POST', { summary: 'Assignment Planner', timeZone: env.TIMEZONE });
  if (!response.ok) {
    if (response.status < 500 && response.status !== 429) await env.DB.prepare("DELETE FROM settings WHERE key='calendar_creation_pending'").run();
    throw new UserError('Could not create the planner calendar. Check your Google connection and calendar recovery instructions.');
  }
  const calendar = await response.json() as { id: string };
  await setSetting(env, 'calendar_id', calendar.id);
  await env.DB.prepare("DELETE FROM settings WHERE key='calendar_creation_pending'").run();
  return calendar.id;
}

export function eventBody(task: Task) {
  const dates = task.due_time ? (() => {
    const instant = localInstant(task.due_date, task.due_time, task.timezone);
    return { start: { dateTime: new Date(instant).toISOString(), timeZone: task.timezone }, end: { dateTime: new Date(instant + 60000).toISOString(), timeZone: task.timezone } };
  })() : { start: { date: task.due_date }, end: { date: addDays(task.due_date, 1) } };
  return { summary: task.title, description: `Assignment deadline\nSource: ${task.source}\nManaged by Assignment Planner. Completion is tracked in Telegram.`, ...dates, transparency: 'transparent', reminders: { useDefault: false }, extendedProperties: { private: { plannerTaskId: task.id } } };
}

export async function syncTask(env: Env, task: Task, token: string, calendar: string, update = false) {
  const eventId = task.id; // Hex is a valid subset of Google event ID alphabet.
  const path = `calendars/${encodeURIComponent(calendar)}/events`;
  let response = await calendarRequest(token, update ? `${path}/${eventId}` : path, update ? 'PATCH' : 'POST', { ...eventBody(task), ...(!update ? { id: eventId } : {}) });
  if (!update && response.status === 409) response = await calendarRequest(token, `${path}/${eventId}`);
  if (!response.ok) {
    if ([401, 403, 404].includes(response.status)) throw new UserError('Calendar access or the event is unavailable. Reconnect with /connect and check the planner calendar.');
    throw new RetryLater('Google Calendar is temporarily unavailable.');
  }
  const event = await response.json() as { id: string; htmlLink: string; status?: string; extendedProperties?: { private?: { plannerTaskId?: string } } };
  if (event.status === 'cancelled' || event.extendedProperties?.private?.plannerTaskId !== task.id) throw new UserError('This calendar event was deleted or no longer matches the task. Manual recovery is required; nothing was overwritten.');
  await env.DB.prepare('UPDATE tasks SET calendar_event_id=?,calendar_link=? WHERE id=?').bind(event.id, event.htmlLink, task.id).run();
  return event.htmlLink;
}
