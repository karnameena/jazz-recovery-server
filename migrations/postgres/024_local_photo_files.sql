-- Photo bytes remain in device_state.photo_data_url in Neon PostgreSQL.
-- These metadata columns are additive and retain one current photo per device.
ALTER TABLE device_state ADD COLUMN IF NOT EXISTS photo_mime_type TEXT;
ALTER TABLE device_state ADD COLUMN IF NOT EXISTS photo_size_bytes INTEGER;
