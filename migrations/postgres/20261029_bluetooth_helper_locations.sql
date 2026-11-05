-- Short-lived BLE beacon tokens and helper encounter reports. PostgreSQL only.
CREATE TABLE IF NOT EXISTS recovery_beacon_tokens (
  token_hash TEXT PRIMARY KEY,
  device_id INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_recovery_beacon_device_expiry ON recovery_beacon_tokens(device_id, expires_at DESC);
CREATE TABLE IF NOT EXISTS recovery_helper_encounters (
  encounter_id UUID PRIMARY KEY,
  target_device_id INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  helper_device_id INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  latitude DOUBLE PRECISION NOT NULL,
  longitude DOUBLE PRECISION NOT NULL,
  accuracy_meters DOUBLE PRECISION,
  location_timestamp BIGINT NOT NULL,
  observed_at BIGINT NOT NULL,
  location_source TEXT NOT NULL DEFAULT 'phone_b_fused',
  location_fresh BOOLEAN NOT NULL DEFAULT FALSE,
  received_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (latitude BETWEEN -90 AND 90),
  CHECK (longitude BETWEEN -180 AND 180),
  CHECK (accuracy_meters IS NULL OR accuracy_meters BETWEEN 0 AND 10000),
  CHECK (target_device_id <> helper_device_id)
);
CREATE INDEX IF NOT EXISTS idx_helper_encounters_target_received ON recovery_helper_encounters(target_device_id, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_helper_encounters_helper_received ON recovery_helper_encounters(helper_device_id, received_at DESC);
