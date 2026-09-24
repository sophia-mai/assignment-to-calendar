// Load local settings without exposing tokens in command arguments or output.
import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
const env = { ...parseEnv(readFileSync('.dev.vars', 'utf8')), ...process.env };
for (const key of ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_WEBHOOK_SECRET', 'PUBLIC_BASE_URL']) {
  if (!env[key]) throw new Error(`Missing ${key} in .dev.vars`);
}
if (!/^[A-Za-z0-9_-]{32,256}$/.test(env.TELEGRAM_WEBHOOK_SECRET)) throw new Error('Use a 32–256 character URL-safe webhook secret.');
const url = new URL('/telegram/webhook', env.PUBLIC_BASE_URL);
if (url.protocol !== 'https:') throw new Error('The webhook requires HTTPS.');
try {
  const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/setWebhook`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: url.toString(), secret_token: env.TELEGRAM_WEBHOOK_SECRET, allowed_updates: ['message', 'callback_query'], max_connections: 1, drop_pending_updates: false })
  });
  const body = await response.json();
  if (!response.ok || !body.ok) throw new Error();
  console.log('Telegram webhook registered. Open your bot and send /start.');
} catch { console.error('Webhook registration failed. Check credentials and connectivity.'); process.exitCode = 1; }
