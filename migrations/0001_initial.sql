PRAGMA foreign_keys = ON;

CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE oauth_states (
  state TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL,
  started INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE inbox (
  id INTEGER PRIMARY KEY,
  payload TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'queued',
  attempts INTEGER NOT NULL DEFAULT 0,
  available_at INTEGER NOT NULL,
  lease_until INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX inbox_due ON inbox(state, available_at);
CREATE TABLE history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE proposals (
  id TEXT PRIMARY KEY,
  actions TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending',
  next_action INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  due_date TEXT NOT NULL,
  due_time TEXT,
  timezone TEXT NOT NULL,
  source TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  calendar_event_id TEXT,
  calendar_link TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX tasks_due ON tasks(status, due_date);
CREATE TABLE reminders (
  id TEXT PRIMARY KEY,
  task_id TEXT REFERENCES tasks(id),
  text TEXT NOT NULL,
  due_at INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  lease_until INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX reminders_due ON reminders(state, due_at);
CREATE TABLE briefings (
  id TEXT PRIMARY KEY,
  time TEXT NOT NULL,
  timezone TEXT NOT NULL,
  days_ahead INTEGER NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE usage (day TEXT PRIMARY KEY, ai_calls INTEGER NOT NULL DEFAULT 0);
CREATE TABLE locks (name TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
