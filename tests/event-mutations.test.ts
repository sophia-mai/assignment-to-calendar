import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers.ts';
import { setSetting } from '../src/db.ts';
import { seal } from '../src/google.ts';
import { makeProposal, approve } from '../src/planner.ts';
import { applyMutation, prepareMutation, type EventMutation, type MutationSnapshot } from '../src/event-mutations.ts';
import type { CalendarEvent } from '../src/calendar-tools.ts';

const calendar = { id: 'planner', summary: 'Assignment Planner', accessRole: 'owner', timeZone: 'America/New_York' };
const originalEvent: CalendarEvent = { id: 'session', etag: 'v1', summary: 'Study group session', description: 'Original notes', location: 'Library', organizer: { self: true }, start: { dateTime: '2099-09-28T19:00:00Z' }, end: { dateTime: '2099-09-28T20:00:00Z' }, extendedProperties: { private: { other: 'keep' } } };
const target = { query: 'Study group', date_from: '2099-09-28', date_to: '2099-09-28', timezone: 'America/New_York', event_ref: null, recurrence_scope: null } as const;
const rename: EventMutation = { type: 'rename_event', ...target, title: 'Study chemistry' };
const deletion: EventMutation = { type: 'delete_event', ...target };
const move: EventMutation = { type: 'reschedule_event', ...target, date: '2099-09-28', time: '16:00', end_date: '2099-09-28', end_time: '17:00' };

async function setup(t: TestContext) {
  const { env, sql } = fixture();
  await setSetting(env, 'google_refresh_token', await seal(env, 'refresh'));
  await setSetting(env, 'calendar_id', calendar.id);
  // Planner is deliberately absent from the selected calendars.
  await setSetting(env, 'selected_calendars', JSON.stringify(['personal']));
  const state = { event: structuredClone(originalEvent), deleted: false, conflict: false, extra: false, rejectWrite: false, writes: [] as { method: string; body: any; headers: any; url: string }[], messages: [] as any[] };
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; sql.close(); });
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.includes('oauth2')) return Response.json({ access_token: 'access' });
    if (url.includes('/calendarList')) return Response.json({ items: [calendar, { ...calendar, id: 'personal', primary: true }] });
    if (url.includes('api.telegram.org')) { state.messages.push(JSON.parse(init!.body as string)); return Response.json({ ok: true, result: {} }); }
    if (['PATCH', 'DELETE'].includes(init?.method ?? '')) {
      state.writes.push({ method: init!.method!, body: init?.body ? JSON.parse(init.body as string) : undefined, headers: init?.headers, url });
      if (state.rejectWrite) return new Response('', { status: 412 });
      if (init!.method === 'DELETE') { state.deleted = true; return new Response(null, { status: 204 }); }
      state.event = { ...state.event, ...JSON.parse(init!.body as string), etag: 'v2' };
      return Response.json(state.event);
    }
    if (url.includes('/events?')) {
      const items = url.includes('/planner/') && !state.deleted ? [state.event, ...(state.extra ? [{ ...state.event, id: 'other' }] : [])] : [];
      if (state.conflict && url.includes('/personal/') && !new URL(url).searchParams.has('q')) items.push({ ...originalEvent, id: 'class', summary: 'Class', start: { dateTime: '2099-09-28T20:30:00Z' }, end: { dateTime: '2099-09-28T21:30:00Z' } });
      return Response.json({ items });
    }
    if (url.includes('/events/')) return state.deleted ? new Response('', { status: 410 }) : Response.json(state.event);
    throw new Error('Unexpected request');
  };
  return { env, sql, state };
}

test('rename finds planner events even when not selected, requires confirmation and preserves details', async t => {
  const { env, sql, state } = await setup(t);
  await makeProposal(env, [rename], 1);
  assert.equal(state.writes.length, 0);
  assert.match(state.messages.at(-1).text, /Study group session → Study chemistry/);
  const id = sql.prepare('SELECT id FROM proposals').get()!.id as string;
  await approve(env, id);
  assert.deepEqual(Object.keys(state.writes[0].body).sort(), ['extendedProperties', 'summary']);
  assert.equal(state.writes[0].headers['If-Match'], 'v1');
  assert.equal(state.event.description, originalEvent.description);
  assert.deepEqual(state.event.start, originalEvent.start);
  sql.prepare("UPDATE proposals SET state='applying',next_action=0").run();
  await approve(env, id);
  assert.equal(state.writes.length, 1, 'lost local checkpoint must not repeat PATCH');
});

test('deletion preview is explicit, uses conditional DELETE, and retries safely after removal', async t => {
  const { env, sql, state } = await setup(t);
  state.event.attendees = [{ self: true }];
  await makeProposal(env, [deletion], 2);
  assert.equal(state.writes.length, 0);
  assert.match(state.messages.at(-1).text, /DELETE.*event/);
  assert.match(state.messages.at(-1).text, /notify the event guests/);
  assert.equal(state.messages.at(-1).reply_markup.inline_keyboard[0][0].text, 'Confirm deletion');
  const id = sql.prepare('SELECT id FROM proposals').get()!.id as string;
  await approve(env, id);
  assert.equal(state.writes[0].method, 'DELETE');
  assert.equal(state.writes[0].headers['If-Match'], 'v1');
  assert.match(state.writes[0].url, /sendUpdates=all/);
  sql.prepare("UPDATE proposals SET state='applying',next_action=0").run();
  await approve(env, id);
  assert.equal(state.writes.length, 1);
});

test('stale previews and conditional-write races cannot delete changed events', async t => {
  const { env, state } = await setup(t);
  const snapshot: MutationSnapshot = { calendar, event: structuredClone(state.event), action: deletion };
  state.event.etag = 'changed';
  await assert.rejects(applyMutation(env, 'token', snapshot, 'op'), /changed after your preview/);
  assert.equal(state.writes.length, 0);
  state.event.etag = 'v1'; state.rejectWrite = true;
  await assert.rejects(applyMutation(env, 'token', snapshot, 'op'), /changed during confirmation/);
  assert.equal(state.deleted, false);
});

test('moving checks new conflicts and excludes itself, then updates only the interval', async t => {
  const { env, sql, state } = await setup(t);
  await makeProposal(env, [move], 3);
  assert.match(state.messages.at(-1).text, /4:00pm EDT – 5:00pm EDT/);
  const id = sql.prepare('SELECT id FROM proposals').get()!.id as string;
  state.conflict = true;
  await assert.rejects(approve(env, id), /overlaps 1 busy/);
  assert.equal(state.writes.length, 0);
  state.conflict = false;
  await approve(env, id);
  assert.deepEqual(Object.keys(state.writes[0].body).sort(), ['end', 'extendedProperties', 'start']);
  assert.equal(state.event.start.dateTime, '2099-09-28T20:00:00.000Z');
  assert.equal(state.event.end.dateTime, '2099-09-28T21:00:00.000Z');
  assert.equal(state.event.summary, originalEvent.summary);
});

test('ambiguous matches and recurring scope must be resolved before a proposal', async t => {
  const { env, sql, state } = await setup(t);
  state.extra = true;
  await assert.rejects(makeProposal(env, [deletion], 1), /Which event/);
  state.extra = false; state.event.recurringEventId = 'parent';
  await assert.rejects(makeProposal(env, [deletion], 1), /only this occurrence or the entire series/);
  assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM proposals').get()!.n, 0);
  await makeProposal(env, [{ ...deletion, recurrence_scope: 'occurrence' }], 2);
  assert.match(state.messages.at(-1).text, /Only this occurrence/);
  assert.equal(state.writes.length, 0);
});

test('series deletion resolves the parent and whole-series moves are refused', async t => {
  const { env, state } = await setup(t);
  state.event.recurringEventId = 'parent';
  // Return a real series parent for the resolver's final fetch.
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init) => String(input).endsWith('/events/parent') ? Response.json({ ...state.event, id: 'parent', recurringEventId: undefined, recurrence: ['RRULE:FREQ=WEEKLY'] }) : original(input, init);
  const snapshot = await prepareMutation(env, 'token', [calendar], { ...deletion, recurrence_scope: 'series' });
  assert.equal(snapshot.event.id, 'parent');
  await assert.rejects(prepareMutation(env, 'token', [calendar], { ...move, recurrence_scope: 'series' }), /entire recurring series/);
});

test('deleting a managed assignment cancels its local task and linked reminders only', async t => {
  const { env, sql, state } = await setup(t);
  const id = 'b'.repeat(32);
  state.event.extendedProperties = { private: { plannerTaskId: id } };
  sql.prepare('INSERT INTO tasks(id,title,due_date,timezone,source,calendar_event_id,created_at) VALUES (?,?,?,?,?,?,?)').run(id, 'Essay', '2099-09-28', 'UTC', 'test', 'session', 0);
  sql.prepare('INSERT INTO reminders(id,task_id,text,due_at) VALUES (?,?,?,?)').run('linked', id, 'Essay', 9999999999999);
  sql.prepare('INSERT INTO reminders(id,text,due_at) VALUES (?,?,?)').run('standalone', 'Other', 9999999999999);
  await makeProposal(env, [deletion], 4);
  await approve(env, sql.prepare('SELECT id FROM proposals').get()!.id as string);
  assert.equal(sql.prepare('SELECT status FROM tasks').get()!.status, 'cancelled');
  assert.equal(sql.prepare("SELECT state FROM reminders WHERE id='linked'").get()!.state, 'cancelled');
  assert.equal(sql.prepare("SELECT state FROM reminders WHERE id='standalone'").get()!.state, 'pending');
});

test('cancelled deletion proposals and mixed mutation plans cannot write', async t => {
  const { env, sql, state } = await setup(t);
  await assert.rejects(makeProposal(env, [deletion, rename], 1), /one event per message/);
  await makeProposal(env, [deletion], 2);
  sql.prepare("UPDATE proposals SET state='cancelled'").run();
  await assert.rejects(approve(env, sql.prepare('SELECT id FROM proposals').get()!.id as string), /cancelled/);
  assert.equal(state.writes.length, 0);
});
