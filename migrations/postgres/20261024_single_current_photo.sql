-- One current photo reference per device. No photo history/archive table.
ALTER TABLE device_state ADD COLUMN IF NOT EXISTS photo_object_key TEXT;
ALTER TABLE device_state ADD COLUMN IF NOT EXISTS photo_mime_type TEXT;
ALTER TABLE device_state ADD COLUMN IF NOT EXISTS photo_size_bytes INTEGER;

-- Temporary durable cleanup outbox; rows disappear after old objects are deleted.
CREATE TABLE IF NOT EXISTS photo_cleanup_jobs (
  object_key TEXT PRIMARY KEY,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_photo_cleanup_due
  ON photo_cleanup_jobs(next_attempt_at, created_at);
