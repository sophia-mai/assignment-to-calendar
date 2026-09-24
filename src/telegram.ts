import type { Env, TelegramUpdate } from './types.ts';
import { UserError, RetryLater } from './types.ts';

type Button = { text: string; callback_data?: string; url?: string };
let lastMessageAt = 0;

export async function telegram<T>(env: Env, method: string, body: unknown): Promise<T> {
  if (method === 'sendMessage') {
    const delay = Math.max(0, lastMessageAt + 1100 - Date.now());
    if (delay) await new Promise(resolve => setTimeout(resolve, delay));
    lastMessageAt = Date.now();
  }
  const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(10000)
  });
  const result = await response.json() as { ok: boolean; result: T };
  if (!response.ok || !result.ok) throw new RetryLater(`Telegram request failed (${response.status}).`);
  return result.result;
}

export async function send(env: Env, text: string, buttons?: Button[][]) {
  // Plain text avoids Markdown injection from uploaded documents.
  const chunks = text.match(/[\s\S]{1,3500}/g) ?? [''];
  for (let i = 0; i < chunks.length; i++) {
    await telegram(env, 'sendMessage', { chat_id: env.ALLOWED_TELEGRAM_USER_ID, text: chunks[i],
      ...(i === chunks.length - 1 && buttons ? { reply_markup: { inline_keyboard: buttons } } : {}) });
  }
}

export function authorized(update: TelegramUpdate, allowed: string): boolean {
  const item = update.callback_query ?? update.message;
  const chat = update.callback_query?.message?.chat ?? update.message?.chat;
  return !!allowed && !!item?.from && String(item.from.id) === allowed && chat?.type === 'private' && String(chat.id) === allowed;
}

export async function attachment(env: Env, message: NonNullable<TelegramUpdate['message']>) {
  const file = message.document ?? message.photo?.at(-1);
  if (!file) return null;
  const mime = message.document?.mime_type ?? 'image/jpeg';
  if (!['application/pdf', 'image/jpeg', 'image/png', 'image/webp'].includes(mime)) throw new UserError('Please send a PDF, JPG, PNG, or WebP file.');
  const max = 4 * 1024 * 1024;
  if ((file.file_size ?? 0) > max) throw new UserError('Please send a file smaller than 4 MB, or split the syllabus into smaller PDFs.');
  const info = await telegram<{ file_path: string; file_size?: number }>(env, 'getFile', { file_id: file.file_id });
  if ((info.file_size ?? 0) > max) throw new UserError('That file exceeds the 4 MB limit.');
  const response = await fetch(`https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${info.file_path}`, { signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new RetryLater('Attachment download failed.');
  if (Number(response.headers.get('Content-Length') ?? 0) > max) throw new UserError('That file exceeds the 4 MB limit.');
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length > max) throw new UserError('That file exceeds the 4 MB limit.');
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return { inlineData: { mimeType: mime, data: btoa(binary) } };
}
