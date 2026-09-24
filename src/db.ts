import type { Env, Task } from './types.ts';

export async function getSetting(env: Env, key: string): Promise<string | null> {
  const row = await env.DB.prepare('SELECT value FROM settings WHERE key = ?').bind(key).first<{ value: string }>();
  return row?.value ?? null;
}

export async function setSetting(env: Env, key: string, value: string) {
  await env.DB.prepare('INSERT INTO settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').bind(key, value).run();
}

export async function openTasks(env: Env): Promise<Task[]> {
  return (await env.DB.prepare("SELECT * FROM tasks WHERE status='open' ORDER BY due_date, due_time LIMIT 100").all<Task>()).results;
}

export async function remember(env: Env, role: string, content: string) {
  await env.DB.prepare('INSERT INTO history(role,content,created_at) VALUES (?,?,?)').bind(role, content.slice(0, 12000), Date.now()).run();
  await env.DB.prepare('DELETE FROM history WHERE id NOT IN (SELECT id FROM history ORDER BY id DESC LIMIT 12)').run();
}

export async function claimLock(env: Env, name: string, duration: number): Promise<boolean> {
  const now = Date.now();
  const row = await env.DB.prepare('INSERT INTO locks(name,expires_at) VALUES (?,?) ON CONFLICT(name) DO UPDATE SET expires_at=excluded.expires_at WHERE locks.expires_at < ? RETURNING name').bind(name, now + duration, now).first();
  return !!row;
}
