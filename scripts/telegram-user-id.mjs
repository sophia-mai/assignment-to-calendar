import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
const env = { ...parseEnv(readFileSync('.dev.vars', 'utf8')), ...process.env };
if (!env.TELEGRAM_BOT_TOKEN) throw new Error('Set TELEGRAM_BOT_TOKEN in .dev.vars first.');
try {
  const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getUpdates`);
  const body = await response.json();
  if (!response.ok || !body.ok) throw new Error();
  const ids = [...new Set(body.result.filter(u => u.message?.chat?.type === 'private').map(u => u.message.from.id))];
  console.log(ids.length ? `Private-chat sender IDs: ${ids.join(', ')}` : 'No messages found. Open your bot and send /start, then try again.');
} catch { console.error('Could not read updates. Check the token and make sure no webhook is registered yet.'); process.exitCode = 1; }
