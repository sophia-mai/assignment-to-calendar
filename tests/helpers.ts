import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { URL } from 'node:url';
import type { Env } from '../src/types.ts';

export function fixture() {
  const sql = new DatabaseSync(':memory:');
  sql.exec(readFileSync(new URL('../migrations/0001_initial.sql', import.meta.url), 'utf8'));
  sql.exec(readFileSync(new URL('../migrations/0002_calendar_context.sql', import.meta.url), 'utf8'));
  sql.exec(readFileSync(new URL('../migrations/0003_calendar_toggle_receipt.sql', import.meta.url), 'utf8'));
  function prepare(query: string) {
    let values: unknown[] = [];
    const execute = () => sql.prepare(query);
    return {
      bind(...args: unknown[]) { values = args; return this; },
      async first() { return execute().get(...values as never[]) ?? null; },
      async all() { return { results: execute().all(...values as never[]), success: true }; },
      async run() { const result = execute().run(...values as never[]); return { success: true, meta: { changes: Number(result.changes) } }; }
    };
  }
  const db = { prepare, async batch(statements: { run(): Promise<unknown> }[]) { return Promise.all(statements.map(s => s.run())); } } as unknown as D1Database;
  const env: Env = { DB: db, TELEGRAM_BOT_TOKEN: 'test-token', TELEGRAM_WEBHOOK_SECRET: 'test-secret', ALLOWED_TELEGRAM_USER_ID: '123', PUBLIC_BASE_URL: 'https://planner.example', GEMINI_API_KEY: 'test', GEMINI_MODEL: 'test', GOOGLE_CLIENT_ID: 'test', GOOGLE_CLIENT_SECRET: 'test', TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'), TIMEZONE: 'America/New_York', AI_DAILY_LIMIT: '1' };
  return { env, sql };
}
