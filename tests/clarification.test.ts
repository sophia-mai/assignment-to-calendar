import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseModelPlan } from '../src/ai.ts';
import { fixture } from './helpers.ts';
import { handleUpdate } from '../src/bot.ts';

test('invalid or incomplete model output becomes a question without executable actions', () => {
  for (const text of ['not JSON', JSON.stringify({ reply: 'Add it', needs_clarification: false, actions: [{ type: 'create_event', title: 'Show' }] })]) {
    const result = parseModelPlan(text, true);
    assert.equal(result.needs_clarification, true);
    assert.deepEqual(result.actions, []);
    assert.match(result.reply, /Which event or deadline/);
    assert.match(result.reply, /without uploading/);
  }
});

test('a specific clarification question discards even otherwise valid proposed mutations', () => {
  const result = parseModelPlan(JSON.stringify({ reply: 'The October 4 deadline or the October 17 show? What year?', needs_clarification: true, actions: [{ type: 'preference', key: 'timezone', value: 'UTC' }] }), true);
  assert.match(result.reply, /October 4/);
  assert.deepEqual(result.actions, []);
});

test('invalid image extraction retains original upload and question through follow-up, with no writes', async t => {
  const { env, sql } = fixture();
  env.AI_DAILY_LIMIT = '5';
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; sql.close(); });
  let calls = 0;
  const replies: string[] = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.includes('/getFile')) return Response.json({ ok: true, result: { file_path: 'poster.jpg' } });
    if (url.includes('/file/bot')) return new Response(new Uint8Array([1, 2, 3]));
    if (url.includes('generativelanguage')) {
      calls++;
      const body = JSON.parse(init!.body as string);
      assert.equal(body.contents[0].parts[1].inlineData.mimeType, 'image/jpeg');
      assert.match(body.systemInstruction.parts[0].text, /Add this poster/);
      if (calls === 2) {
        assert.match(body.contents[0].parts[0].text, /2026/);
        assert.match(body.systemInstruction.parts[0].text, /Which event or deadline/);
      }
      return Response.json({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: calls === 1 ? '{"actions":[{"type":"create_event"}]}' : JSON.stringify({ reply: 'Thanks, I have the year. What time does the show start and end?', actions: [], needs_clarification: true }) }] } }] });
    }
    assert.ok(url.includes('api.telegram.org'), 'No Calendar write is allowed while clarifying');
    replies.push(JSON.parse(init!.body as string).text);
    return Response.json({ ok: true, result: {} });
  };
  const base = { message_id: 1, date: 1790532000, chat: { id: 123, type: 'private' } };
  await handleUpdate(env, { update_id: 10, message: { ...base, caption: 'Add this poster', photo: [{ file_id: 'poster' }] } });
  assert.match(replies[0], /Which event or deadline/);
  await handleUpdate(env, { update_id: 11, message: { ...base, text: 'The show in 2026' } });
  const saved = JSON.parse(sql.prepare("SELECT value FROM settings WHERE key='pending_attachment'").get()!.value as string);
  assert.equal(saved.request, 'Add this poster');
  assert.equal(saved.photo[0].file_id, 'poster');
  assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM proposals').get()!.n, 0);
  await handleUpdate(env, { update_id: 12, message: { ...base, text: '/reset' } });
  assert.equal(sql.prepare("SELECT value FROM settings WHERE key='pending_attachment'").get(), undefined);
});

test('quota failure preserves file metadata and is not misreported as an ambiguous image', async t => {
  const { env, sql } = fixture();
  env.AI_DAILY_LIMIT = '0';
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; sql.close(); });
  globalThis.fetch = async () => { throw new Error('No provider call expected'); };
  await assert.rejects(handleUpdate(env, { update_id: 1, message: { message_id: 1, chat: { id: 123, type: 'private' }, caption: 'Add the deadline', photo: [{ file_id: 'saved' }] } }), /AI requests are disabled/);
  const saved = JSON.parse(sql.prepare("SELECT value FROM settings WHERE key='pending_attachment'").get()!.value as string);
  assert.equal(saved.photo[0].file_id, 'saved');
  assert.equal(saved.request, 'Add the deadline');
});


test('clarifications cannot forward the model success statement from the reported conversation', () => {
  for (const needs_clarification of [true, false]) {
    const plan = parseModelPlan(JSON.stringify({ reply: 'I have scheduled your lab meeting for tomorrow. Since September only has 30 days, did you mean October 1st instead?', needs_clarification, actions: [] }), false);
    assert.doesNotMatch(plan.reply, /I have scheduled/);
    assert.equal(plan.needs_clarification, true);
    assert.equal(plan.actions.length, 0);
  }
});

test('text clarification survives a provider failure and bounded-history eviction', async t => {
  const { env, sql } = fixture(); env.AI_DAILY_LIMIT = '5';
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; sql.close(); });
  let calls = 0;
  globalThis.fetch = async (input, init) => {
    if (String(input).includes('generativelanguage')) {
      calls++;
      const prompt = JSON.parse(init!.body as string).systemInstruction.parts[0].text;
      if (calls > 1) assert.match(prompt, /lab meeting.*7pm.*8pm/);
      if (calls === 2) return Response.json({}, { status: 503 });
      if (calls === 3) assert.match(prompt, /October 1st/);
      return Response.json({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify({ reply: 'Did you mean October 1st?', needs_clarification: true, actions: [] }) }] } }] });
    }
    assert.ok(String(input).includes('api.telegram.org'));
    return Response.json({ ok: true, result: {} });
  };
  const base = { chat: { id: 123, type: 'private' }, date: 1790784000 };
  await handleUpdate(env, { update_id: 1, message: { ...base, message_id: 1, text: 'Add lab meeting on September 31st from 7pm to 8pm' } });
  sql.prepare('DELETE FROM history').run();
  const answer = { update_id: 2, message: { ...base, message_id: 2, text: 'Yes October 1st' } };
  await assert.rejects(handleUpdate(env, answer), /temporarily unavailable/);
  await handleUpdate(env, answer);
  const saved = JSON.parse(sql.prepare("SELECT value FROM settings WHERE key='pending_attachment'").get()!.value as string);
  assert.equal(saved.answers.length, 1);
  const attempts = sql.prepare('SELECT outcome,duration_ms,request_id FROM ai_attempts ORDER BY id').all();
  assert.deepEqual(attempts.map(a => a.outcome), ['CLARIFICATION', 'HTTP_503', 'CLARIFICATION']);
  assert.ok(attempts.every(a => Number(a.duration_ms) >= 0));
  assert.equal(attempts[2].request_id, 2);
});
