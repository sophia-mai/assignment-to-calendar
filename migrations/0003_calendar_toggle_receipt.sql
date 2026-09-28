-- A failed Telegram menu edit must not invert an already-saved selection on retry.
ALTER TABLE inbox ADD COLUMN effect_applied INTEGER NOT NULL DEFAULT 0;
