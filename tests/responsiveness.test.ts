import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker, { processInbox } from '../src/index.ts';
import { handleUpdate } from '../src/bot.ts';
import { fixture } from './helpers.ts';
import { setSetting, getSetting } from '../src/db.ts';
import { seal } from '../src/google.ts';
import { calendarMenu, selectedCalendars, listEvents, checkDuplicates, type Calendar } from '../src/calendar-tools.ts';
import { stableId } from '../src/time.ts';
import { makeProposal, approve } from '../src/planner.ts';
import { sessionInterval, firstAvailableSession } from '../src/sessions.ts';
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
  const confirmations: string[] = [];
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
    if (url.includes('sendMessage')) confirmations.push(JSON.parse(init!.body as string).text);
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
  assert.ok(confirmations.some(text => text.includes('https://calendar.google.com/test')));
  assert.equal(JSON.parse(sql.prepare('SELECT calendar_context FROM proposals WHERE id=?').get(id)!.calendar_context as string).sessionLinks['0'], saved.htmlLink);
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


test('temporary AI failures retry three times, retain safe diagnostics, and respect daily budget', async t => {
  const { env, sql } = fixture();
  env.AI_DAILY_LIMIT = '3';
  env.GEMINI_FALLBACK_MODEL = 'fallback-test';
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; sql.close(); });
  const messages: string[] = [];
  let calls = 0;
  globalThis.fetch = async (input, init) => {
    if (String(input).includes('generativelanguage')) { calls++; assert.ok(String(input).includes(calls === 1 ? '/test:' : '/fallback-test:')); return Response.json({ error: { message: 'private-provider-detail' } }, { status: 503 }); }
    assert.ok(String(input).includes('api.telegram.org'));
    messages.push(JSON.parse(init!.body as string).text);
    return Response.json({ ok: true, result: {} });
  };
  const update = { update_id: 900, message: { ...message, text: 'Add lab meeting tomorrow 7pm to 8pm' } };
  sql.prepare('INSERT INTO inbox(id,payload,available_at,created_at) VALUES (900,?,0,?)').run(JSON.stringify(update), Date.now());
  for (let i = 1; i <= 3; i++) {
    sql.prepare('UPDATE inbox SET available_at=0 WHERE id=900').run();
    await processInbox(env);
    const row = sql.prepare('SELECT state,attempts,diagnostic FROM inbox WHERE id=900').get()!;
    assert.equal(row.state, i < 3 ? 'queued' : 'failed');
    assert.equal(row.attempts, i);
    assert.match(row.diagnostic as string, /HTTP_503/);
    assert.doesNotMatch(row.diagnostic as string, /private-provider-detail/);
  }
  await handleUpdate(env, { update_id: 901, message: { ...message, text: '/diagnostics' } });
  assert.match(messages.at(-1)!, /Understanding request/);
  assert.match(messages.at(-1)!, /Changes at failure: None/);
  assert.equal(calls, 3);
  await assert.rejects(interpret(env, update.message), /daily AI limit/);
  assert.equal(calls, 3);
  assert.equal(sql.prepare('SELECT COUNT(*) AS count FROM proposals').get()!.count, 0);
});

test('AI access and quota failures stop without retrying', async t => {
  const { env, sql } = fixture(); env.AI_DAILY_LIMIT = '3';
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; sql.close(); });
  for (const status of [403, 429]) {
    globalThis.fetch = async input => String(input).includes('generativelanguage') ? Response.json({}, { status }) : Response.json({ ok: true, result: {} });
    sql.prepare('INSERT INTO inbox(id,payload,available_at,created_at) VALUES (?, ?,0,?)').run(status, JSON.stringify({ update_id: status, message: { ...message, text: 'Schedule lab tomorrow 7pm to 8pm' } }), Date.now());
    await processInbox(env);
    assert.equal(sql.prepare('SELECT state FROM inbox WHERE id=?').get(status)!.state, 'failed');
  }
});


test('first available slot merges busy intervals, ignores free events, checks planner and fails when full', async t => {
  const { env, sql } = fixture();
  await setSetting(env, 'google_refresh_token', await seal(env, 'refresh'));
  await setSetting(env, 'calendar_id', 'planner');
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; sql.close(); });
  let full = false;
  const scanned: string[] = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    assert.ok(!init?.method || init.method === 'GET' || url.includes('oauth2') || url.includes('telegram.org') || url.includes('generativelanguage'), 'slot search must not create events');
    if (url.includes('oauth2')) return Response.json({ access_token: 'access' });
    if (url.includes('/calendarList')) return Response.json({ items: [calendars[0], { id: 'planner', summary: 'Planner', accessRole: 'owner' }] });
    if (url.includes('/events?')) {
      scanned.push(url);
      const interval = (id: string, start: string, end: string, extra = {}) => ({ id, start: { dateTime: '2099-10-08T' + start + ':00-04:00' }, end: { dateTime: '2099-10-08T' + end + ':00-04:00' }, ...extra });
      return Response.json({ items: full ? [{ id: 'all', start: { date: '2099-10-08' }, end: { date: '2099-10-09' } }] : [interval('one', '09:00', '10:00'), interval('two', '09:30', '10:30'), interval('free', '10:30', '11:00', { transparency: 'transparent' }), interval('next', '11:00', '12:00')] });
    }
    if (url.includes('generativelanguage')) return Response.json({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify({ reply: 'Finding a slot', needs_clarification: false, actions: [request] }) }] } }] });
    if (url.includes('telegram.org')) return Response.json({ ok: true, result: {} });
    throw Error('Unexpected call');
  };
  const request: Extract<Action, { type: 'find_slot' }> = { type: 'find_slot', title: 'Homework review', date_from: '2099-10-08', date_to: '2099-10-08', time: null, end_time: null, duration_minutes: 30, timezone: 'America/New_York', description: '', location: null };
  const result = await firstAvailableSession(env, request);
  assert.equal(result.time, '10:30'); assert.equal(result.end_time, '11:00');
  assert.ok(scanned.some(url => url.includes('/planner/')));
  assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM proposals').get()!.n, 0);
  await handleUpdate(env, { update_id: 987, message: { ...message, text: 'Find the first free 30 minutes to review homework' } });
  const proposed = JSON.parse(sql.prepare('SELECT actions FROM proposals').get()!.actions as string);
  assert.equal(proposed[0].type, 'create_event');
  assert.equal(proposed[0].time, '10:30');
  full = true;
  await assert.rejects(firstAvailableSession(env, request), /No free 30-minute slot/);
  await assert.rejects(firstAvailableSession(env, { ...request, date_to: '2099-10-15' }), /at most seven/);
});


test('named destination is reviewed, used for writes, and loss of access never redirects', async t => {
  const { env, sql } = fixture();
  await setSetting(env, 'google_refresh_token', await seal(env, 'refresh'));
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; sql.close(); });
  let accessible = true, writes = 0;
  const texts: string[] = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.includes('oauth2')) return Response.json({ access_token: 'access' });
    if (url.includes('/calendarList')) return Response.json({ items: [calendars[0], ...(accessible ? [{ id: 'jhu', summary: 'JHU Events', accessRole: 'owner' }] : [])] });
    if (url.includes('/events?')) return Response.json({ items: [] });
    if (url.includes('googleapis') && init?.method === 'POST') {
      assert.ok(url.includes('/calendars/jhu/events'));
      writes++;
      return Response.json({ ...JSON.parse(init.body as string), htmlLink: 'https://calendar.google.com/named' });
    }
    if (url.includes('telegram.org')) { texts.push(JSON.parse(init!.body as string).text); return Response.json({ ok: true, result: {} }); }
    throw Error('Unexpected call');
  };
  await makeProposal(env, [{ ...session, calendar_name: 'jhu events' }], 920);
  const row = sql.prepare('SELECT id,calendar_context FROM proposals').get()!;
  assert.equal(JSON.parse(row.calendar_context as string).destinations['0'].id, 'jhu');
  assert.ok(texts.some(s => s.includes('Calendar: JHU Events')));
  accessible = false;
  await assert.rejects(approve(env, row.id as string), /no longer owned or accessible/);
  assert.equal(writes, 0);
  accessible = true;
  await approve(env, row.id as string);
  assert.equal(writes, 1);
  assert.ok(texts.some(s => s.includes('scheduled in JHU Events')));
  assert.equal(await getSetting(env, 'calendar_id'), null);
  await assert.rejects(makeProposal(env, [{ ...session, calendar_name: 'Unknown calendar' }], 921), /No owned calendar matches/);
});


test('two events from one model plan share a preview and resume a failed second write without duplicates', async t => {
  const { env, sql } = fixture();
  await setSetting(env, 'google_refresh_token', await seal(env, 'refresh'));
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; sql.close(); });
  const events = [{ ...session, title: 'Workshop', calendar_name: 'JHU Events' }, { ...session, title: 'Dinner', date: '2099-10-09', end_date: '2099-10-09', calendar_name: 'JHU Events' }];
  const stored = new Map<string, any>(); let fail = true, inserts = 0;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.includes('generativelanguage')) return Response.json({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify({ reply: 'Review both events', needs_clarification: false, actions: events }) }] } }] });
    if (url.includes('oauth2')) return Response.json({ access_token: 'access' });
    if (url.includes('/calendarList')) return Response.json({ items: [{ ...calendars[0], id: 'jhu', summary: 'JHU Events' }] });
    if (url.includes('/events?')) return Response.json({ items: [...stored.values()] });
    if (url.endsWith('/events') && init?.method === 'POST') {
      assert.ok(url.includes('/calendars/jhu/events'));
      const body = JSON.parse(init.body as string);
      if (body.summary === 'Dinner' && fail) return new Response('', { status: 503 });
      if (stored.has(body.id)) return new Response('', { status: 409 });
      inserts++; stored.set(body.id, { ...body, htmlLink: 'https://calendar.google.com/' + body.id });
      return Response.json(stored.get(body.id));
    }
    if (url.includes('/events/')) return Response.json(stored.get(url.split('/').at(-1)!));
    if (url.includes('telegram.org')) return Response.json({ ok: true, result: {} });
    throw Error('Unexpected request');
  };
  await handleUpdate(env, { update_id: 995, message: { ...message, text: 'Add these two events in JHU Events' } });
  const proposal = sql.prepare('SELECT id,actions FROM proposals').get()!;
  assert.equal(JSON.parse(proposal.actions as string).length, 2);
  assert.equal(inserts, 0);
  await assert.rejects(approve(env, proposal.id as string), e => e instanceof Error && e.constructor.name === 'ContinueWork');
  assert.equal(inserts, 1);
  await assert.rejects(approve(env, proposal.id as string), /temporarily unavailable/);
  assert.equal(sql.prepare('SELECT next_action FROM proposals').get()!.next_action, 1);
  fail = false;
  await approve(env, proposal.id as string);
  await approve(env, proposal.id as string);
  assert.equal(inserts, 2);
  assert.equal(sql.prepare('SELECT state FROM proposals').get()!.state, 'done');
});
