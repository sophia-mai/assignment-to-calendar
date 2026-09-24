import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker, { processInbox } from '../src/index.ts';
import { fixture } from './helpers.ts';
import { validDate, localInstant, localParts, stableId } from '../src/time.ts';
import { PlanSchema, type Action } from '../src/actions.ts';
import { authorized } from '../src/telegram.ts';
import { approve, complete, validateActions } from '../src/planner.ts';
import { seal, eventBody, connectLink, oauthStart, oauthCallback } from '../src/google.ts';
import { setSetting } from '../src/db.ts';
import { deliverReminders, inQuietHours, scheduleBriefing } from '../src/scheduler.ts';
import { interpret } from '../src/ai.ts';
import type { Task } from '../src/types.ts';
import { ContinueWork } from '../src/types.ts';
import { handleUpdate } from '../src/bot.ts';

test('date validation rejects impossible dates and handles leap years', () => {
  assert.equal(validDate('2026-02-29'), false);
  assert.equal(validDate('2028-02-29'), true);
  assert.equal(validDate('2026-13-01'), false);
  assert.equal(validDate('yesterday'), false);
});

test('wall-clock conversion respects DST and rejects skipped/repeated times', () => {
  assert.equal(new Date(localInstant('2026-07-01', '09:00', 'America/New_York')).toISOString(), '2026-07-01T13:00:00.000Z');
  assert.equal(new Date(localInstant('2026-12-01', '09:00', 'America/New_York')).toISOString(), '2026-12-01T14:00:00.000Z');
  assert.throws(() => localInstant('2026-03-08', '02:30', 'America/New_York'));
  assert.throws(() => localInstant('2026-11-01', '01:30', 'America/New_York'));
  assert.deepEqual(localParts(Date.parse('2026-12-01T14:00:00Z'), 'America/New_York'), { date: '2026-12-01', time: '09:00' });
});

test('untrusted AI output cannot execute unsupported actions or unresolved plans', () => {
  assert.equal(PlanSchema.safeParse({ reply: 'ok', needs_clarification: false, actions: [{ type: 'delete_calendar' }] }).success, false);
  assert.equal(PlanSchema.safeParse({ reply: 'Which day?', needs_clarification: true, actions: [{ type: 'briefing', time: '09:00', timezone: 'UTC', days_ahead: 2, enabled: true }] }).success, false);
});

test('webhook rejects wrong secrets, other users and group chats; duplicate deliveries enqueue once', async () => {
  const { env, sql } = fixture();
  const update = { update_id: 1, message: { message_id: 1, from: { id: 123 }, chat: { id: 123, type: 'private' }, text: '/tasks' } };
  const request = (body: unknown, secret = 'test-secret') => new Request('https://planner.example/telegram/webhook', { method: 'POST', headers: { 'X-Telegram-Bot-Api-Secret-Token': secret }, body: JSON.stringify(body) });
  assert.equal((await worker.fetch(request(update, 'wrong'), env)).status, 401);
  await worker.fetch(request({ ...update, message: { ...update.message, from: { id: 456 } } }), env);
  assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM inbox').get()!.n, 0);
  assert.equal(authorized({ ...update, message: { ...update.message, chat: { id: 123, type: 'group' } } }, '123'), false);
  assert.equal((await worker.fetch(request(update), env)).status, 200);
  await worker.fetch(request(update), env);
  assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM inbox').get()!.n, 1);
  sql.close();
});

test('OAuth links expire and state is single-use', async () => {
  const { env, sql } = fixture();
  const link = new URL(await connectLink(env));
  const state = link.searchParams.get('state')!;
  assert.equal((await oauthStart(env, state)).status, 302);
  assert.equal((await oauthStart(env, state)).status, 400);
  assert.equal((await oauthCallback(env, new URL(`https://planner.example/oauth/callback?state=${state}&error=access_denied`))).status, 400);
  assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM oauth_states').get()!.n, 0);
  sql.close();
});

test('deadline event preserves date-only and timed deadlines without blocking time', () => {
  const task = { id: 'a'.repeat(32), title: 'Essay', due_date: '2026-10-08', due_time: null, timezone: 'America/New_York', source: 'Page 2' } as Task;
  assert.deepEqual(eventBody(task).end, { date: '2026-10-09' });
  assert.equal(eventBody(task).transparency, 'transparent');
  const start = eventBody({ ...task, due_time: '23:59' }).start;
  assert.ok('dateTime' in start);
  assert.equal(start.dateTime, '2026-10-09T03:59:00.000Z');
});

test('confirmed task creation is idempotent and new-task reminders cancel on completion', async t => {
  const { env, sql } = fixture();
  await setSetting(env, 'google_refresh_token', await seal(env, 'refresh-secret'));
  await setSetting(env, 'calendar_id', 'calendar');
  let eventWrites = 0;
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; sql.close(); });
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.includes('oauth2.googleapis.com')) return Response.json({ access_token: 'access' });
    if (url.includes('/events')) {
      eventWrites++;
      const body = JSON.parse(init!.body as string);
      return Response.json({ id: body.id, htmlLink: 'https://calendar.google.com/event', extendedProperties: body.extendedProperties });
    }
    if (url.includes('googleapis.com')) return Response.json({ id: 'calendar' });
    return Response.json({ ok: true, result: {} });
  };
  const actions: Action[] = [
    { type: 'create_task', title: 'Essay', due_date: '2099-10-08', due_time: null, timezone: 'America/New_York', source: 'Page 1: Essay due October 8, 2099' },
    { type: 'reminder', task_id: 'new:0', text: 'Start Essay', date: '2099-10-07', time: '09:00', timezone: 'America/New_York' }
  ];
  const id = 'b'.repeat(32);
  sql.prepare('INSERT INTO proposals(id,actions,expires_at,created_at) VALUES (?,?,?,?)').run(id, JSON.stringify(actions), Date.now() + 86400000, Date.now());
  await approve(env, id);
  await approve(env, id);
  assert.equal(eventWrites, 1);
  const task = sql.prepare('SELECT * FROM tasks').get()!;
  assert.equal(sql.prepare('SELECT task_id FROM reminders').get()!.task_id, task.id);
  await complete(env, task.id as string);
  assert.equal(sql.prepare('SELECT state FROM reminders').get()!.state, 'cancelled');
});

test('invalid new-task references are rejected before changes', async () => {
  const { env, sql } = fixture();
  await assert.rejects(validateActions(env, [{ type: 'reminder', task_id: 'new:1', text: 'test', date: '2099-01-01', time: '09:00', timezone: 'UTC' }]));
  assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM reminders').get()!.n, 0);
  sql.close();
});

test('daily briefing is deduplicated across ticks and reminders are independent of AI', async t => {
  const { env, sql } = fixture();
  env.GEMINI_API_KEY = '';
  sql.prepare("INSERT INTO briefings VALUES ('daily','09:00','America/New_York',2,1)").run();
  const now = Date.parse('2026-09-20T13:00:00Z');
  await scheduleBriefing(env, now);
  await scheduleBriefing(env, now + 60000);
  assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM reminders').get()!.n, 1);
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; sql.close(); });
  let sends = 0;
  globalThis.fetch = async () => { sends++; return Response.json({ ok: true, result: {} }); };
  await deliverReminders(env, now);
  await deliverReminders(env, now + 60000);
  assert.equal(sends, 1);
});

test('quiet hours cover midnight and defer sending without dropping the reminder', async t => {
  assert.equal(inQuietHours('23:30', '22:00', '08:00'), true);
  assert.equal(inQuietHours('07:59', '22:00', '08:00'), true);
  assert.equal(inQuietHours('08:00', '22:00', '08:00'), false);
  const { env, sql } = fixture();
  await setSetting(env, 'preferences', JSON.stringify({ quiet_start: '22:00', quiet_end: '08:00', timezone: 'UTC' }));
  sql.prepare('INSERT INTO reminders(id,text,due_at) VALUES (?,?,?)').run('c'.repeat(32), 'test', 0);
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; sql.close(); });
  globalThis.fetch = async () => { throw new Error('Should not call Telegram'); };
  await deliverReminders(env, Date.parse('2026-09-20T23:00:00Z'));
  assert.equal(sql.prepare('SELECT state FROM reminders').get()!.state, 'pending');
});

test('AI daily cap rejects calls locally without contacting provider', async t => {
  const { env, sql } = fixture();
  sql.prepare('INSERT INTO usage(day,ai_calls) VALUES (?,1)').run(new Date().toISOString().slice(0, 10));
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; sql.close(); });
  globalThis.fetch = async () => { throw new Error('Should not contact AI'); };
  await assert.rejects(interpret(env, { message_id: 1, chat: { id: 123, type: 'private' }, text: 'hello' }), /daily AI limit/);
});

test('failed inbox delivery retries with a lease and does not disappear', async t => {
  const { env, sql } = fixture();
  const payload = { update_id: 1, message: { message_id: 1, chat: { id: 123, type: 'private' }, text: '/tasks' } };
  sql.prepare('INSERT INTO inbox(id,payload,available_at,created_at) VALUES (1,?,0,0)').run(JSON.stringify(payload));
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; sql.close(); });
  globalThis.fetch = async () => Response.json({ ok: false }, { status: 503 });
  await processInbox(env);
  const job = sql.prepare('SELECT state,attempts,available_at FROM inbox').get()!;
  assert.equal(job.state, 'queued');
  assert.equal(job.attempts, 1);
  assert.ok(Number(job.available_at) > Date.now());
});

test('stable task IDs use a Google-compatible alphabet', async () => {
  assert.match(await stableId('essay'), /^[a-f0-9]{32}$/);
  assert.equal(await stableId('essay'), await stableId('essay'));
});

test('large approvals checkpoint and resume without restarting earlier actions', async t => {
  const { env, sql } = fixture();
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; sql.close(); });
  globalThis.fetch = async () => Response.json({ ok: true, result: {} });
  const actions: Action[] = [0, 1, 2, 3].map(i => ({ type: 'reminder', task_id: null, text: `Reminder ${i}`, date: '2099-01-01', time: '09:00', timezone: 'UTC' }));
  const id = 'd'.repeat(32);
  sql.prepare('INSERT INTO proposals(id,actions,expires_at,created_at) VALUES (?,?,?,?)').run(id, JSON.stringify(actions), Date.now() + 86400000, Date.now());
  await assert.rejects(approve(env, id), ContinueWork);
  assert.equal(sql.prepare('SELECT next_action FROM proposals').get()!.next_action, 3);
  assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM reminders').get()!.n, 3);
  await approve(env, id);
  assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM reminders').get()!.n, 4);
  assert.equal(sql.prepare('SELECT state FROM proposals').get()!.state, 'done');
});

test('missing-year clarification reuses the uploaded image on the next message', async t => {
  const { env, sql } = fixture();
  env.AI_DAILY_LIMIT = '5';
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; sql.close(); });
  let aiCalls = 0;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.includes('/getFile')) return Response.json({ ok: true, result: { file_path: 'photo.jpg', file_size: 3 } });
    if (url.includes('/file/bot')) return new Response(new Uint8Array([1, 2, 3]));
    if (url.includes('generativelanguage')) {
      aiCalls++;
      const body = JSON.parse(init!.body as string);
      assert.equal(body.contents[0].parts[1].inlineData.mimeType, 'image/jpeg');
      return Response.json({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify({ reply: aiCalls === 1 ? 'Which year?' : 'No deadlines in this image.', needs_clarification: aiCalls === 1, actions: [] }) }] } }] });
    }
    return Response.json({ ok: true, result: {} });
  };
  const base = { message_id: 1, from: { id: 123 }, chat: { id: 123, type: 'private' } };
  await handleUpdate(env, { update_id: 20, message: { ...base, caption: 'Add this.', photo: [{ file_id: 'image', file_size: 3 }] } });
  assert.ok(sql.prepare("SELECT value FROM settings WHERE key='pending_attachment'").get());
  await handleUpdate(env, { update_id: 21, message: { ...base, text: '2026' } });
  assert.equal(aiCalls, 2);
  assert.equal(sql.prepare("SELECT value FROM settings WHERE key='pending_attachment'").get(), undefined);
});

test('cancelled proposals cannot write calendar events or task records', async () => {
  const { env, sql } = fixture();
  const id = 'e'.repeat(32);
  sql.prepare("INSERT INTO proposals(id,actions,state,expires_at,created_at) VALUES (?,?,'cancelled',?,?)").run(id, '[]', Date.now() + 86400000, Date.now());
  await assert.rejects(approve(env, id), /cancelled or expired/);
  assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM tasks').get()!.n, 0);
  sql.close();
});
