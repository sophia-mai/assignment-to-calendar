import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers.ts';
import { setSetting, getSetting } from '../src/db.ts';
import { seal, GOOGLE_SCOPES, syncTask } from '../src/google.ts';
import { selectedCalendars, prepareEdit, applyEdit, overlaps, listEvents, checkDuplicates, calendarRead, type Calendar, type CalendarEvent, type EditSnapshot } from '../src/calendar-tools.ts';
import { makeProposal, approve } from '../src/planner.ts';
import type { Action } from '../src/actions.ts';
import type { Task } from '../src/types.ts';

const calendar: Calendar = { id: 'personal', summary: 'Personal', accessRole: 'owner', primary: true, timeZone: 'America/New_York' };
const event: CalendarEvent = { id: 'exam', etag: 'v1', summary: 'Biology exam', description: 'Bring ID.', location: 'Room 101', start: { dateTime: '2099-10-08T15:00:00-04:00' }, end: { dateTime: '2099-10-08T16:00:00-04:00' }, organizer: { self: true }, extendedProperties: { private: { unrelated: 'preserve' } } };
const edit: Extract<Action, { type: 'edit_event' }> = { type: 'edit_event', query: 'Biology exam', date_from: '2099-10-08', date_to: '2099-10-08', timezone: 'America/New_York', event_ref: null, recurrence_scope: null, append_description: 'Bring a calculator.', location: 'Room 204' };

test('OAuth requests owned-event access without full calendar administration', () => {
  assert.ok(GOOGLE_SCOPES.includes('https://www.googleapis.com/auth/calendar.events.owned'));
  assert.ok(GOOGLE_SCOPES.includes('https://www.googleapis.com/auth/calendar.calendarlist.readonly'));
  assert.ok(!GOOGLE_SCOPES.includes('https://www.googleapis.com/auth/calendar'));
});

test('conflicts respect exclusive end, transparent/declined events, and all-day calendar timezone', () => {
  const start = Date.parse('2099-10-08T19:00:00Z'), end = Date.parse('2099-10-08T20:00:00Z');
  assert.equal(overlaps(event, 'America/New_York', start, end), true);
  assert.equal(overlaps(event, 'America/New_York', end, end + 3600000), false);
  assert.equal(overlaps({ ...event, transparency: 'transparent' }, 'America/New_York', start, end), false);
  assert.equal(overlaps({ ...event, attendees: [{ self: true, responseStatus: 'declined' }] }, 'America/New_York', start, end), false);
  const allDay = { ...event, start: { date: '2099-10-08' }, end: { date: '2099-10-09' } };
  assert.equal(overlaps(allDay, 'America/New_York', start, end), true);
  assert.equal(overlaps(allDay, 'America/New_York', Date.parse('2099-10-09T04:00:00Z'), Date.parse('2099-10-09T05:00:00Z')), false);
});

test('event note/location update requires review and sends only requested fields with If-Match', async t => {
  const { env, sql } = fixture();
  await setSetting(env, 'google_refresh_token', await seal(env, 'refresh'));
  let current = structuredClone(event);
  const patches: { body: any; headers: any }[] = [];
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; sql.close(); });
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.includes('oauth2')) return Response.json({ access_token: 'access' });
    if (url.includes('/calendarList')) return Response.json({ items: [calendar] });
    if (init?.method === 'PATCH') {
      const body = JSON.parse(init.body as string);
      patches.push({ body, headers: init.headers });
      current = { ...current, ...body, etag: 'v2' };
      return Response.json(current);
    }
    if (url.includes('/events/exam')) return Response.json(current);
    if (url.includes('/events?')) return Response.json({ items: [current] });
    return Response.json({ ok: true, result: {} });
  };
  await makeProposal(env, [edit], 101);
  assert.equal(patches.length, 0);
  const proposal = sql.prepare('SELECT id,calendar_context FROM proposals').get()!;
  const context = JSON.parse(proposal.calendar_context as string);
  assert.equal(context.edits[0].patch.description, 'Bring ID.\n\nBring a calculator.');
  await approve(env, proposal.id as string);
  assert.equal(patches.length, 1);
  assert.equal(patches[0].headers['If-Match'], 'v1');
  assert.deepEqual(Object.keys(patches[0].body).sort(), ['description', 'extendedProperties', 'location']);
  assert.equal(patches[0].body.extendedProperties.private.unrelated, 'preserve');
  // Simulate successful remote write followed by loss of the local checkpoint.
  sql.prepare("UPDATE proposals SET state='applying',next_action=0").run();
  await approve(env, proposal.id as string);
  assert.equal(patches.length, 1);
});

test('stale event preview cannot overwrite later calendar edits', async t => {
  const { env, sql } = fixture();
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; sql.close(); });
  let writes = 0;
  globalThis.fetch = async (input, init) => {
    if (init?.method === 'PATCH') writes++;
    return String(input).includes('/calendarList') ? Response.json({ items: [calendar] }) : Response.json({ ...event, etag: 'changed' });
  };
  const snapshot: EditSnapshot = { calendar, event, patch: { location: 'New room' }, scope: 'single event' };
  await assert.rejects(applyEdit(env, 'token', snapshot, 'operation'), /changed after your preview/);
  assert.equal(writes, 0);
});

test('Google 412 race is reported without retrying with a new version', async t => {
  const { env, sql } = fixture();
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; sql.close(); });
  let writes = 0;
  globalThis.fetch = async (input, init) => {
    if (init?.method === 'PATCH') { writes++; return new Response('', { status: 412 }); }
    return String(input).includes('/calendarList') ? Response.json({ items: [calendar] }) : Response.json(event);
  };
  await assert.rejects(applyEdit(env, 'token', { calendar, event, patch: { location: 'New' }, scope: 'single' }, 'op'), /changed during confirmation/);
  assert.equal(writes, 1);
});

test('multiple matches ask for selection and cache numbered refs; forged refs are refused', async t => {
  const { env, sql } = fixture();
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; sql.close(); });
  globalThis.fetch = async () => Response.json({ items: [event, { ...event, id: 'other' }] });
  await assert.rejects(prepareEdit(env, 'token', [calendar], edit), /Which event/);
  const cache = JSON.parse((await getSetting(env, 'calendar_matches'))!);
  assert.equal(cache.entries.length, 2);
  await assert.rejects(prepareEdit(env, 'token', [calendar], { ...edit, event_ref: 'f'.repeat(32) }), /selection expired/);
  globalThis.fetch = async () => Response.json(event);
  const selected = await prepareEdit(env, 'token', [calendar], { ...edit, event_ref: cache.entries[0].ref });
  assert.equal(selected.event.id, event.id);
});

test('recurring edits require explicit scope and whole-series edit targets the parent', async t => {
  const { env, sql } = fixture();
  const instance = { ...event, id: 'exam_instance', recurringEventId: 'series' };
  const parent = { ...event, id: 'series', recurrence: ['RRULE:FREQ=WEEKLY'] };
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; sql.close(); });
  globalThis.fetch = async input => {
    const url = String(input);
    if (url.includes('/events?')) return Response.json({ items: [instance] });
    return Response.json(url.endsWith('/series') ? parent : instance);
  };
  await assert.rejects(prepareEdit(env, 'token', [calendar], edit), /only this occurrence or the entire series/);
  assert.equal((await prepareEdit(env, 'token', [calendar], { ...edit, recurrence_scope: 'occurrence' })).event.id, 'exam_instance');
  assert.equal((await prepareEdit(env, 'token', [calendar], { ...edit, recurrence_scope: 'series' })).event.id, 'series');
  globalThis.fetch = async input => String(input).includes('/events?') ? Response.json({ items: [instance, { ...instance, id: 'exam_next_instance' }] }) : Response.json(String(input).endsWith('/series') ? parent : instance);
  assert.equal((await prepareEdit(env, 'token', [calendar], { ...edit, recurrence_scope: 'series' })).event.id, 'series');
});

test('manually created matching event blocks a new duplicate before any task is inserted', async t => {
  const { env, sql } = fixture();
  await setSetting(env, 'google_refresh_token', await seal(env, 'refresh'));
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; sql.close(); });
  globalThis.fetch = async input => {
    const url = String(input);
    if (url.includes('oauth2')) return Response.json({ access_token: 'access' });
    if (url.includes('/calendarList')) return Response.json({ items: [calendar] });
    return Response.json({ items: [event] });
  };
  const create: Action = { type: 'create_task', title: 'Biology exam', due_date: '2099-10-08', due_time: null, timezone: 'America/New_York', source: 'Syllabus' };
  await assert.rejects(makeProposal(env, [create], 1), /may already be on your calendar/);
  assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM tasks').get()!.n, 0);
  assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM proposals').get()!.n, 0);
});

test('incomplete pagination never produces a false no-conflict result', async t => {
  const { sql } = fixture();
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; sql.close(); });
  globalThis.fetch = async () => Response.json({ items: [], nextPageToken: 'more' });
  await assert.rejects(listEvents('token', [calendar], Date.now(), Date.now() + 3600000), /No partial|no partial/);
});

test('calendar selection limits access and permission errors request reconnection', async t => {
  const { env, sql } = fixture();
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; sql.close(); });
  await setSetting(env, 'selected_calendars', JSON.stringify(['second']));
  globalThis.fetch = async () => Response.json({ items: [calendar, { ...calendar, id: 'second', primary: false }] });
  assert.deepEqual((await selectedCalendars(env, 'token')).map(c => c.id), ['second']);
  globalThis.fetch = async () => new Response('', { status: 403 });
  await assert.rejects(selectedCalendars(env, 'token'), /updated permissions/);
});

test('existing task deadline update preserves appended notes, location, guests and reminders', async t => {
  const { env, sql } = fixture();
  const task = { id: 'a'.repeat(32), title: 'Essay', due_date: '2099-10-08', due_time: null, timezone: 'UTC', source: 'Page 1', status: 'open', calendar_event_id: 'a'.repeat(32), calendar_link: null } as Task;
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; sql.close(); });
  let patch: any;
  globalThis.fetch = async (_input, init) => {
    if (init?.method === 'PATCH') patch = JSON.parse(init.body as string);
    return Response.json({ ...event, id: task.id, extendedProperties: { private: { plannerTaskId: task.id } }, htmlLink: 'https://calendar.google.com' });
  };
  await syncTask(env, task, 'token', 'calendar', true);
  assert.deepEqual(Object.keys(patch).sort(), ['end', 'start', 'summary']);
});

test('availability result is produced from live events without a second AI call', async t => {
  const { env, sql } = fixture();
  await setSetting(env, 'google_refresh_token', await seal(env, 'refresh'));
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; sql.close(); });
  let message = '';
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    assert.ok(!url.includes('generativelanguage'));
    if (url.includes('oauth2')) return Response.json({ access_token: 'access' });
    if (url.includes('/calendarList')) return Response.json({ items: [calendar] });
    if (url.includes('/events?')) return Response.json({ items: [event] });
    message = JSON.parse(init!.body as string).text;
    return Response.json({ ok: true, result: {} });
  };
  await calendarRead(env, { type: 'check_conflicts', date: '2099-10-08', time: '15:30', end_date: '2099-10-08', end_time: '16:30', timezone: 'America/New_York' });
  assert.match(message, /1 conflict/);
  assert.match(message, /Biology exam/);
});

test('duplicate checks repeat at confirmation if someone added the event after the preview', async t => {
  const { env, sql } = fixture();
  await setSetting(env, 'google_refresh_token', await seal(env, 'refresh'));
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; sql.close(); });
  let exists = false, calendarWrites = 0;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.includes('oauth2')) return Response.json({ access_token: 'access' });
    if (url.includes('/calendarList')) return Response.json({ items: [calendar] });
    if (url.includes('/events?')) return Response.json({ items: exists ? [event] : [] });
    if (url.includes('googleapis') && init?.method === 'POST') calendarWrites++;
    return Response.json({ ok: true, result: {} });
  };
  await makeProposal(env, [{ type: 'create_task', title: 'Biology exam', due_date: '2099-10-08', due_time: null, timezone: 'America/New_York', source: 'Syllabus' }], 102);
  exists = true;
  const id = sql.prepare('SELECT id FROM proposals').get()!.id as string;
  await assert.rejects(approve(env, id), /may already/);
  assert.equal(calendarWrites, 0);
  assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM tasks').get()!.n, 0);
});

test('deselecting a calendar invalidates a previously prepared edit', async t => {
  const { env, sql } = fixture();
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; sql.close(); });
  await setSetting(env, 'selected_calendars', JSON.stringify(['other']));
  let writes = 0;
  globalThis.fetch = async (_input, init) => {
    if (init?.method === 'PATCH') writes++;
    return Response.json({ items: [calendar, { ...calendar, id: 'other', primary: false }] });
  };
  await assert.rejects(applyEdit(env, 'token', { calendar, event, patch: { location: 'Room 204' }, scope: 'single' }, 'op'), /no longer selected/);
  assert.equal(writes, 0);
});
