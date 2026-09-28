import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.ts';
import { fixture } from './helpers.ts';
import { setSetting, getSetting } from '../src/db.ts';
import { seal } from '../src/google.ts';
import { calendarMenu, selectedCalendars, listEvents, checkDuplicates, type Calendar } from '../src/calendar-tools.ts';
import { stableId } from '../src/time.ts';
import { makeProposal, approve } from '../src/planner.ts';
import { sessionInterval } from '../src/sessions.ts';
import { interpret } from '../src/ai.ts';
import { planJsonSchema, type Action } from '../src/actions.ts';

const session: Extract<Action, { type: 'create_event' }> = { type: 'create_event', title: 'Study group', date: '2099-10-08', time: '13:00', end_date: '2099-10-08', end_time: '14:00', timezone: 'America/New_York', description: 'Review chapter 2.', location: 'Library' };
const calendars: Calendar[] = Array.from({ length: 20 }, (_, i) => ({ id: `cal${i}`, summary: `Calendar ${i}`, accessRole: 'owner', primary: i === 0, timeZone: 'America/New_York' }));
const message = { message_id: 12, from: { id: 123 }, chat: { id: 123, type: 'private' }, text: '/tasks' };
test('model schema requires complete intervals and excludes unrelated action fields', () => {
  const shape = planJsonSchema.properties.actions.items.anyOf.find(s => s.properties.type.enum[0] === 'create_event')!;
  assert.ok(shape.required.includes('end_date'));
  assert.ok(shape.required.includes('end_time'));
  assert.ok(!('enabled' in shape.properties));
  assert.equal(shape.additionalProperties, false);
});
function request(body: unknown) { return new Request('https://planner.example/telegram/webhook', { method: 'POST', headers: { 'X-Telegram-Bot-Api-Secret-Token': 'test-secret' }, body: JSON.stringify(body) }); }

test('webhook wakes a durable consumer immediately; consumer responds without a cron tick', async t => {
  const { env, sql } = fixture();
  t.after(() => sql.close());
  const wakes: unknown[] = [];
  env.INBOX_QUEUE = { async send(body: unknown) { wakes.push(body); } } as unknown as typeof env.INBOX_QUEUE;
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  let sent = 0;
  globalThis.fetch = async () => { sent++; return Response.json({ ok: true, result: {} }); };
  assert.equal((await worker.fetch(request({ update_id: 1, message }), env)).status, 200);
  assert.deepEqual(wakes, [{ wake: true }]);
  assert.equal(sent, 0);
  let ack = false;
  await worker.queue({ messages: [{ ack() { ack = true; } }] } as unknown as MessageBatch<{ wake: true }>, env);
  assert.equal(sent, 1);
  assert.equal(ack, true);
  assert.equal(sql.prepare('SELECT state FROM inbox').get()!.state, 'done');
});

test('natural messages receive an immediate receipt, callbacks a spinner acknowledgement, duplicates no receipt', async t => {
  const { env, sql } = fixture();
  t.after(() => sql.close());
  env.INBOX_QUEUE = { async send() {} } as unknown as typeof env.INBOX_QUEUE;
  const update = { update_id: 1, message: { ...message, text: 'Schedule a study group tomorrow 1–2pm' } };
  assert.equal((await (await worker.fetch(request(update), env)).json() as any).method, 'sendMessage');
  assert.equal(await (await worker.fetch(request(update), env)).text(), 'OK');
  const callback = { update_id: 2, callback_query: { id: 'callback', from: { id: 123 }, message, data: 'cal:' + 'a'.repeat(32) } };
  assert.deepEqual(await (await worker.fetch(request(callback), env)).json(), { method: 'answerCallbackQuery', callback_query_id: 'callback' });
});

test('failed queue handoff keeps durable input and a redelivery wakes it without duplication', async t => {
  const { env, sql } = fixture();
  t.after(() => sql.close());
  env.INBOX_QUEUE = { async send() { throw new Error('unavailable'); } } as unknown as typeof env.INBOX_QUEUE;
  const update = { update_id: 1, message };
  assert.equal((await worker.fetch(request(update), env)).status, 503);
  env.INBOX_QUEUE = { async send() {} } as unknown as typeof env.INBOX_QUEUE;
  assert.equal((await worker.fetch(request(update), env)).status, 200);
  assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM inbox').get()!.n, 1);
});

test('calendar taps edit one menu, use cached calendar list, and never invert a selection on delivery retry', async t => {
  const { env, sql } = fixture();
  t.after(() => sql.close());
  await setSetting(env, 'google_refresh_token', await seal(env, 'refresh'));
  await setSetting(env, 'selected_calendars', JSON.stringify(calendars.slice(0, 7).map(c => c.id)));
  sql.prepare('INSERT INTO inbox(id,payload,available_at,created_at) VALUES (10,?,0,0)').run('{}');
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  let googleReads = 0, sends = 0, edits = 0;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.includes('oauth2')) return Response.json({ access_token: 'access' });
    if (url.includes('/calendarList')) { googleReads++; return Response.json({ items: calendars }); }
    if (url.endsWith('/sendMessage')) sends++;
    if (url.endsWith('/editMessageText')) {
      edits++;
      const body = JSON.parse(init!.body as string);
      assert.equal(body.message_id, 55);
      assert.match(body.text, /8\/20 selected/);
      if (edits === 1) return Response.json({ ok: false }, { status: 503 });
      return Response.json({ ok: false, description: 'Bad Request: message is not modified' }, { status: 400 });
    }
    return Response.json({ ok: true, result: {} });
  };
  await calendarMenu(env);
  const ref = await stableId(calendars[7].id);
  await assert.rejects(calendarMenu(env, ref, 55, 10));
  await calendarMenu(env, ref, 55, 10);
  assert.equal(JSON.parse((await getSetting(env, 'selected_calendars'))!).length, 8);
  assert.equal(googleReads, 1);
  assert.equal(sends, 1);
  assert.equal(edits, 2);
});

test('20 calendars are supported, reads run concurrently, and exhausted scan budgets fail explicitly', async t => {
  const { env, sql } = fixture();
  t.after(() => sql.close());
  await setSetting(env, 'selected_calendars', JSON.stringify(calendars.map(c => c.id)));
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  let active = 0, peak = 0, reads = 0, paginate = false;
  globalThis.fetch = async input => {
    if (String(input).includes('/calendarList')) return Response.json({ items: calendars });
    reads++; active++; peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 1)); active--;
    return Response.json({ items: [], ...(paginate ? { nextPageToken: 'more' } : {}) });
  };
  assert.equal((await selectedCalendars(env, 'token')).length, 20);
  assert.deepEqual(await listEvents('token', calendars, 0, 3600000), []);
  assert.equal(reads, 20);
  assert.equal(peak, 4);
  reads = 0; paginate = true;
  await assert.rejects(listEvents('token', calendars, 0, 3600000), /no partial/);
  assert.ok(reads <= 24);
  paginate = false; reads = 0;
  await checkDuplicates(env, 'token', calendars, ['America/New_York', 'Europe/London'].map(timezone => ({ type: 'create_task', title: 'Essay', due_date: '2099-10-08', due_time: null, timezone, source: 'test' })));
  assert.equal(reads, 20, 'multiple timezones share one scan');
});

test('study sessions reserve the full interval only after confirmation and recover lost checkpoints without duplicates', async t => {
  const { env, sql } = fixture();
  t.after(() => sql.close());
  await setSetting(env, 'google_refresh_token', await seal(env, 'refresh'));
  await setSetting(env, 'calendar_id', 'planner');
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  let saved: any, inserts = 0;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.includes('oauth2')) return Response.json({ access_token: 'access' });
    if (url.includes('/calendarList')) return Response.json({ items: [calendars[0]] });
    if (url.includes('/events?')) return Response.json({ items: url.includes('/planner/') && saved ? [saved] : [] });
    if (url.endsWith('/events') && init?.method === 'POST') {
      if (saved) return new Response('', { status: 409 });
      inserts++; saved = { ...JSON.parse(init.body as string), etag: 'v1', htmlLink: 'https://calendar.google.com/test' };
      return Response.json(saved);
    }
    if (url.includes('/events/')) return Response.json(saved);
    if (url.includes('googleapis')) return Response.json({ id: 'planner' });
    return Response.json({ ok: true, result: {} });
  };
  await makeProposal(env, [session], 20);
  assert.equal(inserts, 0);
  const id = sql.prepare('SELECT id FROM proposals').get()!.id as string;
  await approve(env, id);
  assert.equal(inserts, 1);
  assert.equal(Date.parse(saved.end.dateTime) - Date.parse(saved.start.dateTime), 3600000);
  assert.equal(saved.start.dateTime, '2099-10-08T17:00:00.000Z');
  assert.equal(saved.transparency, 'opaque');
  assert.equal(saved.location, 'Library');
  assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM tasks').get()!.n, 0);
  sql.prepare("UPDATE proposals SET next_action=0,state='applying'").run();
  await approve(env, id);
  assert.equal(inserts, 1);
});

test('session conflicts added after preview stop confirmation before writes; invalid durations are rejected', async t => {
  const { env, sql } = fixture();
  t.after(() => sql.close());
  await setSetting(env, 'google_refresh_token', await seal(env, 'refresh'));
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  let busy = false, writes = 0;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.includes('oauth2')) return Response.json({ access_token: 'access' });
    if (url.includes('/calendarList')) return Response.json({ items: [calendars[0]] });
    if (url.includes('/events?')) return Response.json({ items: busy ? [{ id: 'other', summary: 'Class', start: { dateTime: '2099-10-08T17:30:00Z' }, end: { dateTime: '2099-10-08T18:30:00Z' } }] : [] });
    if (url.includes('googleapis') && init?.method === 'POST') writes++;
    return Response.json({ ok: true, result: {} });
  };
  await makeProposal(env, [session], 1);
  busy = true;
  await assert.rejects(approve(env, sql.prepare('SELECT id FROM proposals').get()!.id as string), /overlaps 1 busy/);
  assert.equal(writes, 0);
  assert.throws(() => sessionInterval({ ...session, end_time: '12:00' }), /end after/);
});

test('AI timeout gets an actionable reply and relative-date prompt uses original Telegram timestamp', async t => {
  const { env, sql } = fixture();
  t.after(() => sql.close());
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async (_input, init) => {
    const prompt = JSON.parse(init!.body as string).systemInstruction.parts[0].text;
    assert.match(prompt, /User message sent at UTC: 2026-09-27T18:00:00.000Z/);
    assert.match(prompt, /create_event/);
    throw new DOMException('Timed out', 'TimeoutError');
  };
  await assert.rejects(interpret(env, { ...message, date: Date.parse('2026-09-27T18:00:00Z') / 1000, text: 'Study group tomorrow 1-2pm' }), /did not respond in time/);
});
