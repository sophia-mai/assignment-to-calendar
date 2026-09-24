import type { Env, TelegramUpdate } from './types.ts';
import { UserError, ContinueWork } from './types.ts';
import { authorized, send } from './telegram.ts';
import { claimLock } from './db.ts';
import { handleUpdate } from './bot.ts';
import { oauthStart, oauthCallback } from './google.ts';
import { scheduleBriefing, deliverReminders } from './scheduler.ts';

export async function processInbox(env: Env) {
  const now = Date.now();
  const job = await env.DB.prepare("UPDATE inbox SET state='processing',lease_until=?,attempts=attempts+1 WHERE id=(SELECT id FROM inbox WHERE attempts<3 AND available_at<=? AND (state='queued' OR (state='processing' AND lease_until<?)) ORDER BY id LIMIT 1) RETURNING *").bind(now + 180000, now, now).first<{ id: number; payload: string; attempts: number }>();
  if (!job) return;
  try {
    await handleUpdate(env, JSON.parse(job.payload) as TelegramUpdate);
    await env.DB.prepare("UPDATE inbox SET state='done',payload='{}' WHERE id=?").bind(job.id).run();
  } catch (error) {
    if (error instanceof ContinueWork) {
      await env.DB.prepare("UPDATE inbox SET state='queued',attempts=0,available_at=?,lease_until=0 WHERE id=?").bind(Date.now() + 1000, job.id).run();
    } else if (error instanceof UserError || job.attempts >= 3) {
      try { await send(env, error instanceof UserError ? error.message : 'That request could not finish after retries. Some confirmed changes may have applied. Use /pending to review and resume.'); } catch { /* /pending retains proposals if Telegram is unavailable */ }
      await env.DB.prepare("UPDATE inbox SET state='failed',payload='{}' WHERE id=?").bind(job.id).run();
    } else {
      await env.DB.prepare("UPDATE inbox SET state='queued',available_at=?,lease_until=0 WHERE id=?").bind(now + 60000 * job.attempts, job.id).run();
    }
  }
}

export async function tick(env: Env) {
  if (!env.ALLOWED_TELEGRAM_USER_ID || !env.TELEGRAM_BOT_TOKEN) return;
  if (!await claimLock(env, 'tick', 180000)) return;
  try {
    await env.DB.batch([
      env.DB.prepare("UPDATE inbox SET state='failed',payload='{}' WHERE state='processing' AND attempts>=3 AND lease_until<?").bind(Date.now()),
      env.DB.prepare("UPDATE reminders SET state='failed' WHERE state='sending' AND attempts>=3 AND lease_until<?").bind(Date.now())
    ]);
    try { await processInbox(env); } catch { /* Continue to scheduled reminders even if an inbox request fails. */ }
    await scheduleBriefing(env);
    await deliverReminders(env);
    await env.DB.batch([
      env.DB.prepare('DELETE FROM oauth_states WHERE expires_at<?').bind(Date.now()),
      env.DB.prepare("DELETE FROM inbox WHERE state IN ('done','failed') AND created_at<?").bind(Date.now() - 7 * 86400000),
      env.DB.prepare('DELETE FROM usage WHERE day<?').bind(new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10)),
      env.DB.prepare('DELETE FROM proposals WHERE expires_at<?').bind(Date.now() - 7 * 86400000)
    ]);
  } finally { await env.DB.prepare("DELETE FROM locks WHERE name='tick'").run(); }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (request.method === 'GET' && url.pathname === '/health') return Response.json({ ok: true });
      if (request.method === 'GET' && url.pathname === '/oauth/start') return oauthStart(env, url.searchParams.get('state') ?? '');
      if (request.method === 'GET' && url.pathname === '/oauth/callback') return await oauthCallback(env, url);
      if (request.method !== 'POST' || url.pathname !== '/telegram/webhook') return new Response('Not found', { status: 404 });
      if (!env.TELEGRAM_WEBHOOK_SECRET || request.headers.get('X-Telegram-Bot-Api-Secret-Token') !== env.TELEGRAM_WEBHOOK_SECRET) return new Response('Unauthorized', { status: 401 });
      if (Number(request.headers.get('Content-Length') ?? 0) > 65536) return new Response('Too large', { status: 413 });
      const raw = await request.text();
      if (raw.length > 65536) return new Response('Too large', { status: 413 });
      let update: TelegramUpdate;
      try { update = JSON.parse(raw); } catch { return new Response('Invalid JSON', { status: 400 }); }
      if (!update || !Number.isSafeInteger(update.update_id)) return new Response('Invalid update', { status: 400 });
      if (!authorized(update, env.ALLOWED_TELEGRAM_USER_ID)) return new Response('OK');
      await env.DB.prepare('INSERT OR IGNORE INTO inbox(id,payload,available_at,created_at) VALUES (?,?,?,?)').bind(update.update_id, raw, Date.now(), Date.now()).run();
      return new Response('OK');
    } catch (error) {
      // Never log provider responses, request URLs, files, or tokens.
      return new Response(error instanceof UserError ? error.message : 'Request failed. Please try again.', { status: error instanceof UserError ? 400 : 503, headers: { 'Cache-Control': 'no-store' } });
    }
  },
  async scheduled(_event: ScheduledController, env: Env): Promise<void> { await tick(env); }
};
