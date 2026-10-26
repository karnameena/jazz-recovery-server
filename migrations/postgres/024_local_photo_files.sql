-- Store only the current recovery photo path in PostgreSQL; file bytes live on persistent API-host disk.
-- Existing accounts, devices, locations, commands, audit records, and legacy photo fields are preserved.
ALTER TABLE device_state ADD COLUMN IF NOT EXISTS photo_local_path TEXT;
ALTER TABLE device_state ADD COLUMN IF NOT EXISTS photo_mime_type TEXT;
ALTER TABLE device_state ADD COLUMN IF NOT EXISTS photo_size_bytes INTEGER;

CREATE TABLE IF NOT EXISTS photo_file_cleanup_jobs (
  photo_path TEXT PRIMARY KEY,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_photo_file_cleanup_due
  ON photo_file_cleanup_jobs(next_attempt_at, created_at);
