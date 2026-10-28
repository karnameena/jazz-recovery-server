CREATE TABLE IF NOT EXISTS location_helper_consents (
  helper_device_id INTEGER PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS location_helper_authorizations (
  target_device_id INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  helper_device_id INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  owner_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (target_device_id, helper_device_id),
  CHECK (target_device_id <> helper_device_id)
);

CREATE TABLE IF NOT EXISTS location_helper_reports (
  target_device_id INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  helper_device_id INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  report_id UUID NOT NULL UNIQUE,
  observed_at_ms BIGINT NOT NULL,
  latitude DOUBLE PRECISION NOT NULL CHECK (latitude BETWEEN -90 AND 90),
  longitude DOUBLE PRECISION NOT NULL CHECK (longitude BETWEEN -180 AND 180),
  accuracy_meters DOUBLE PRECISION NOT NULL CHECK (accuracy_meters BETWEEN 0 AND 100000),
  rssi INTEGER NOT NULL CHECK (rssi BETWEEN -127 AND 0),
  received_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (target_device_id, helper_device_id)
);

CREATE INDEX IF NOT EXISTS location_helper_reports_target_received_idx
  ON location_helper_reports(target_device_id, received_at DESC);

CREATE TABLE IF NOT EXISTS location_helper_beacon_tokens (
  target_device_id INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  token_hash CHAR(64) NOT NULL,
  expires_at_ms BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (target_device_id, token_hash)
);

CREATE INDEX IF NOT EXISTS location_helper_beacon_tokens_expiry_idx
  ON location_helper_beacon_tokens(target_device_id, expires_at_ms);
