import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
const env = { ...parseEnv(readFileSync('.dev.vars', 'utf8')), ...process.env };
if (!env.TELEGRAM_BOT_TOKEN) throw new Error('Set TELEGRAM_BOT_TOKEN in .dev.vars first.');
try {
  const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getUpdates`);
  const body = await response.json();
  if (!response.ok || !body.ok) {
    const code = body.error_code ?? response.status;
    const explanation = code === 401 || code === 404 ? 'Telegram rejected the bot token. Copy the current token from BotFather into TELEGRAM_BOT_TOKEN.' : code === 409 ? 'Telegram reports a conflict: a webhook or another getUpdates reader is active.' : 'Telegram could not complete the request.';
    console.error(`Telegram error ${code}: ${explanation}`);
    process.exitCode = 1;
  } else {
  const ids = [...new Set(body.result.filter(u => u.message?.chat?.type === 'private').map(u => u.message.from.id))];
  console.log(ids.length ? `Private-chat sender IDs: ${ids.join(', ')}` : 'No messages found. Open your bot and send /start, then try again.');
  }
} catch { console.error('Could not reach Telegram or read its response. Check network access.'); process.exitCode = 1; }
