export interface Env {
  DB: D1Database;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET: string;
  ALLOWED_TELEGRAM_USER_ID: string;
  PUBLIC_BASE_URL: string;
  GEMINI_API_KEY: string;
  GEMINI_MODEL: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  TOKEN_ENCRYPTION_KEY: string;
  TIMEZONE: string;
  AI_DAILY_LIMIT: string;
}

export interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    from?: { id: number };
    chat: { id: number; type: string };
    text?: string;
    caption?: string;
    photo?: { file_id: string; file_size?: number }[];
    document?: { file_id: string; file_size?: number; mime_type?: string; file_name?: string };
  };
  callback_query?: {
    id: string;
    from: { id: number };
    data?: string;
    message?: { chat: { id: number; type: string } };
  };
}

export interface Task {
  id: string;
  title: string;
  due_date: string;
  due_time: string | null;
  timezone: string;
  source: string;
  status: string;
  calendar_event_id: string | null;
  calendar_link: string | null;
}

export class UserError extends Error {}
export class RetryLater extends Error {}
export class ContinueWork extends Error {}
