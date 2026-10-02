import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatDate, formatInstant, formatInterval, resolveZone } from '../src/time.ts';
import { eventLabel } from '../src/calendar-tools.ts';
import { fixture } from './helpers.ts';
import { handleUpdate } from '../src/bot.ts';
import { approve, showProposal } from '../src/planner.ts';
import type { Action } from '../src/actions.ts';
import { preferredTimezone, setSetting } from '../src/db.ts';
import { interpret } from '../src/ai.ts';

test('friendly dates handle ordinals, noon/midnight, and date-specific daylight saving names', () => {
  assert.equal(formatInstant(Date.parse('2026-01-01T20:00:00Z'), 'America/New_York'), 'Thursday, January 1st, 2026 at 3:00pm EST');
  assert.equal(formatInstant(Date.parse('2026-09-28T16:00:00Z'), 'America/New_York'), 'Monday, September 28th, 2026 at 12:00pm EDT');
  assert.match(formatInstant(Date.parse('2026-09-28T04:00:00Z'), 'America/New_York'), /12:00am EDT$/);
  for (const day of [11, 12, 13]) assert.match(formatDate(`2026-01-${day}`), new RegExp(`${day}th`));
  assert.match(formatDate('2026-01-22'), /22nd/);
  assert.match(formatDate('2026-01-23'), /23rd/);
  assert.equal(resolveZone('Eastern'), 'America/New_York');
  assert.equal(resolveZone('Europe/London'), 'Europe/London');
  assert.equal(resolveZone('EST'), null);
  assert.equal(resolveZone('Invalid/Place'), null);
});

test('changing to London converts stored task and proposal displays without moving schedules', async t => {
  const { env, sql } = fixture();
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; sql.close(); });
  const messages: string[] = [];
  globalThis.fetch = async (input, init) => {
    assert.ok(String(input).includes('api.telegram.org'), 'timezone changes must not write to Google Calendar');
    messages.push(JSON.parse(init!.body as string).text);
    return Response.json({ ok: true, result: {} });
  };
  const id = 'a'.repeat(32);
  const due = Date.parse('2099-09-28T16:00:00Z');
  sql.prepare('INSERT INTO tasks(id,title,due_date,due_time,timezone,source,created_at) VALUES (?,?,?,?,?,?,?)').run(id, 'Essay', '2099-09-28', '12:00', 'America/New_York', 'test', 0);
  sql.prepare('INSERT INTO reminders(id,text,due_at) VALUES (?,?,?)').run(id, 'Reminder', due);
  const action: Action = { type: 'create_event', title: 'Study', date: '2099-09-28', time: '12:00', end_date: '2099-09-28', end_time: '13:00', timezone: 'America/New_York', description: '', location: null };
  const serialized = JSON.stringify([action]);
  sql.prepare('INSERT INTO proposals(id,actions,expires_at,created_at) VALUES (?,?,?,?)').run(id, serialized, Date.now() + 86400000, 0);
  const beforeTask = sql.prepare('SELECT * FROM tasks').get();
  const base = { message_id: 1, chat: { id: 123, type: 'private' } };
  await handleUpdate(env, { update_id: 100, message: { ...base, text: '/timezone Europe/London' } });
  const change = sql.prepare('SELECT id FROM proposals WHERE id<>?').get(id)!;
  await approve(env, change.id as string);
  await handleUpdate(env, { update_id: 101, message: { ...base, text: '/tasks' } });
  assert.match(messages.at(-1)!, /5:00pm/);
  await showProposal(env, id, [action]);
  assert.match(messages.at(-1)!, /5:00pm.*6:00pm/);
  assert.deepEqual(sql.prepare('SELECT * FROM tasks').get(), beforeTask);
  assert.equal(sql.prepare('SELECT due_at FROM reminders').get()!.due_at, due);
  assert.equal(sql.prepare('SELECT actions FROM proposals WHERE id=?').get(id)!.actions, serialized);
});

test('intervals show both dates across midnight and both offsets across a DST transition', () => {
  assert.equal(formatInterval(Date.parse('2026-09-28T16:00:00Z'), Date.parse('2026-09-28T17:15:00Z'), 'America/New_York'), 'Monday, September 28th, 2026 at 12:00pm EDT – 1:15pm EDT');
  assert.match(formatInterval(Date.parse('2026-09-28T03:00:00Z'), Date.parse('2026-09-28T05:00:00Z'), 'America/New_York'), /Sunday.*Monday/);
  assert.match(formatInterval(Date.parse('2026-11-01T05:30:00Z'), Date.parse('2026-11-01T06:30:00Z'), 'America/New_York'), /1:30am EDT – 1:30am EST/);
});

test('calendar labels convert timed events and preserve inclusive all-day dates', () => {
  const calendar = { id: 'test', summary: 'Classes', accessRole: 'owner', timeZone: 'America/New_York' };
  const event = { id: 'test', etag: '1', summary: 'Lecture', start: { dateTime: '2026-09-28T12:00:00-04:00' }, end: { dateTime: '2026-09-28T13:15:00-04:00' } };
  assert.match(eventLabel({ calendar, event }, 'America/Los_Angeles'), /9:00am PDT – 10:15am PDT/);
  const allDay = { ...event, start: { date: '2026-09-28' }, end: { date: '2026-09-30' } };
  const label = eventLabel({ calendar, event: allDay }, 'America/Los_Angeles');
  assert.match(label, /September 28th.*September 29th.*all day/);
  assert.ok(!label.includes('30th'));
});

test('timezone command works without AI, persists after confirmation and leaves briefing schedule intact', async t => {
  const { env, sql } = fixture();
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; sql.close(); });
  const messages: string[] = [];
  globalThis.fetch = async (input, init) => {
    assert.ok(String(input).includes('api.telegram.org'));
    messages.push(JSON.parse(init!.body as string).text);
    return Response.json({ ok: true, result: {} });
  };
  sql.prepare("INSERT INTO briefings(id,time,timezone,days_ahead,enabled) VALUES ('daily','09:00','America/New_York',2,1)").run();
  const base = { message_id: 1, chat: { id: 123, type: 'private' } };
  await handleUpdate(env, { update_id: 1, message: { ...base, text: '/timezone Pacific' } });
  assert.equal(await preferredTimezone(env), 'America/New_York');
  await approve(env, sql.prepare('SELECT id FROM proposals').get()!.id as string);
  assert.equal(await preferredTimezone(env), 'America/Los_Angeles');
  await handleUpdate(env, { update_id: 2, message: { ...base, text: '/timezone' } });
  assert.match(messages.at(-1)!, /Your default timezone: America\/Los_Angeles/);
  assert.equal(sql.prepare('SELECT timezone FROM briefings').get()!.timezone, 'America/New_York');
  await assert.rejects(handleUpdate(env, { update_id: 3, message: { ...base, text: '/timezone CST' } }), /Please use a region/);
});

test('saved timezone is the actual default passed to the model', async t => {
  const { env, sql } = fixture();
  await setSetting(env, 'preferences', JSON.stringify({ timezone: 'Asia/Tokyo' }));
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; sql.close(); });
  globalThis.fetch = async (_input, init) => {
    const prompt = JSON.parse(init!.body as string).systemInstruction.parts[0].text;
    assert.match(prompt, /Default timezone: Asia\/Tokyo/);
    return Response.json({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify({ reply: 'Ready.', needs_clarification: false, actions: [] }) }] } }] });
  };
  await interpret(env, { message_id: 1, chat: { id: 123, type: 'private' }, text: 'What timezone am I using?' });
});


test('reminders list uses saved timezone, excludes inactive reminders, and explains Telegram delivery', async t => {
  const { env, sql } = fixture();
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; sql.close(); });
  const messages: string[] = [];
  globalThis.fetch = async (input, init) => {
    assert.ok(String(input).includes('api.telegram.org'));
    messages.push(JSON.parse(init!.body as string).text);
    return Response.json({ ok: true, result: {} });
  };
  await setSetting(env, 'preferences', JSON.stringify({ timezone: 'Europe/London' }));
  const update = { update_id: 1, message: { message_id: 1, chat: { id: 123, type: 'private' }, text: '/reminders' } };
  await handleUpdate(env, update);
  assert.match(messages.at(-1)!, /No upcoming Telegram reminders/);
  for (const [id, state] of [['active', 'pending'], ['old', 'sent'], ['cancelled', 'cancelled']]) {
    sql.prepare('INSERT INTO reminders(id,text,due_at,state) VALUES (?,?,?,?)').run(id, id + ' reminder', Date.parse('2099-01-01T20:00:00Z'), state);
  }
  await handleUpdate(env, update);
  assert.match(messages.at(-1)!, /active reminder/);
  assert.match(messages.at(-1)!, /8:00pm GMT/);
  assert.match(messages.at(-1)!, /here in this chat/);
  assert.doesNotMatch(messages.at(-1)!, /old reminder|cancelled reminder/);
});
