-- FCM registration tokens are private delivery metadata, never exposed to the website.
-- Safe to apply when the table was already created manually in a staging database.
CREATE TABLE IF NOT EXISTS device_push_tokens (
  device_id INTEGER PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
  fcm_token TEXT NOT NULL,
  platform TEXT NOT NULL DEFAULT 'android',
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
