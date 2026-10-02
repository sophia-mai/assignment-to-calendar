CREATE TABLE ai_attempts (id INTEGER PRIMARY KEY AUTOINCREMENT, request_id INTEGER NOT NULL, model TEXT NOT NULL, duration_ms INTEGER NOT NULL, outcome TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE INDEX ai_attempts_created ON ai_attempts(created_at);
