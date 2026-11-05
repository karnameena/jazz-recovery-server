-- Jazz Recovery: temporary recovery-result transport only.
-- Photos are fetched by the authenticated browser and then persisted in IndexedDB.
-- This table is short-lived; it is not permanent photo storage.
-- No R2 binding or object storage is required.

-- Jazz Recovery fresh Cloudflare D1 schema.
-- This migration creates an EMPTY database. It intentionally imports no PostgreSQL records.
-- Recovery photos and last-known coordinates are intentionally excluded from D1.

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  recovery_pin_hash TEXT,
  recovery_pin_updated_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username_ci ON users(lower(username));

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_used_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS devices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL UNIQUE,
  device_name TEXT NOT NULL,
  device_type TEXT NOT NULL DEFAULT 'Android',
  credential_hash TEXT NOT NULL,
  imei TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_devices_user_id ON devices(user_id);

-- Status only. Coordinates, location history and photo bytes/data URLs do not belong in D1.
CREATE TABLE IF NOT EXISTS device_state (
  device_id INTEGER PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
  mode TEXT NOT NULL DEFAULT 'NORMAL_MODE',
  battery INTEGER,
  charging INTEGER NOT NULL DEFAULT 0,
  network TEXT,
  online INTEGER NOT NULL DEFAULT 0,
  last_seen TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  location_services_status TEXT NOT NULL DEFAULT 'UNKNOWN',
  location_services_timestamp INTEGER
);

CREATE TABLE IF NOT EXISTS recovery_commands (
  id TEXT PRIMARY KEY,
  device_id INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  args_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  leased_until TEXT,
  completed_at TEXT,
  result_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_commands_device_status ON recovery_commands(device_id,status,created_at);

-- Temporary delivery relay only. Rows expire quickly and are deleted after browser retrieval.
-- Photo bytes live temporarily in R2; no permanent photo/location history is stored in D1.
CREATE TABLE IF NOT EXISTS recovery_result_relays (
  id TEXT PRIMARY KEY,
  owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('location','photo')),
  object_key TEXT,
  payload_json TEXT,
  result_timestamp INTEGER NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_recovery_relay_owner_device_expiry
  ON recovery_result_relays(owner_id,device_id,expires_at,created_at DESC);

CREATE TRIGGER IF NOT EXISTS trg_recovery_commands_pending_limit
BEFORE INSERT ON recovery_commands
WHEN NEW.status='pending' AND
  (SELECT COUNT(*) FROM recovery_commands WHERE device_id=NEW.device_id AND status='pending') >= 20
BEGIN
  SELECT RAISE(ABORT,'too_many_pending_recovery_commands');
END;

CREATE TRIGGER IF NOT EXISTS trg_recovery_commands_dedupe
BEFORE INSERT ON recovery_commands
WHEN NEW.status='pending' AND NEW.type IN
  ('device_status','device_location','recovery_photo','location_status','location_enable','location_disable')
  AND EXISTS (
    SELECT 1 FROM recovery_commands c
    WHERE c.device_id=NEW.device_id AND c.status='pending' AND c.type=NEW.type
      AND (NEW.type<>'recovery_photo' OR
           COALESCE(json_extract(c.args_json,'$.camera'),'front')=COALESCE(json_extract(NEW.args_json,'$.camera'),'front'))
  )
BEGIN
  SELECT RAISE(ABORT,'duplicate_pending_recovery_command');
END;

CREATE TRIGGER IF NOT EXISTS trg_recovery_commands_location_conflict
BEFORE INSERT ON recovery_commands
WHEN NEW.status='pending' AND
  ((NEW.type='location_enable' AND EXISTS(
      SELECT 1 FROM recovery_commands WHERE device_id=NEW.device_id AND status='pending' AND type='location_disable'))
   OR
   (NEW.type='location_disable' AND EXISTS(
      SELECT 1 FROM recovery_commands WHERE device_id=NEW.device_id AND status='pending' AND type='location_enable')))
BEGIN
  SELECT RAISE(ABORT,'opposite_location_command_pending');
END;


CREATE TABLE IF NOT EXISTS recovery_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  device_id INTEGER REFERENCES devices(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_audit_user_created ON recovery_audit(user_id,created_at DESC);

CREATE TABLE IF NOT EXISTS billing_trials (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  starts_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_billing_trials_expires_at ON billing_trials(expires_at);

CREATE TABLE IF NOT EXISTS billing_trial_claims (
  username_hash TEXT PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  claimed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS billing_discount_codes (
  id TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  percent_off INTEGER NOT NULL CHECK(percent_off IN (10,20,50,100)),
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
  starts_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TEXT,
  max_redemptions INTEGER CHECK(max_redemptions IS NULL OR max_redemptions > 0),
  redeemed_count INTEGER NOT NULL DEFAULT 0 CHECK(redeemed_count >= 0),
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  eligible_plan TEXT NOT NULL DEFAULT 'annual' CHECK(eligible_plan IN ('annual','monthly','both')),
  per_user_limit INTEGER NOT NULL DEFAULT 1 CHECK(per_user_limit BETWEEN 1 AND 1000000),
  trial_eligible_from TEXT,
  trial_eligible_until TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_billing_discount_active ON billing_discount_codes(active,expires_at);

CREATE TABLE IF NOT EXISTS billing_subscriptions (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK(status IN ('active','complimentary','expired','refunded')),
  starts_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  amount_paid_paise INTEGER NOT NULL CHECK(amount_paid_paise BETWEEN 0 AND 49900),
  discount_code_id TEXT REFERENCES billing_discount_codes(id) ON DELETE SET NULL,
  payment_id TEXT,
  plan_type TEXT NOT NULL DEFAULT 'annual' CHECK(plan_type IN ('monthly','annual')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_billing_subscriptions_user_expiry ON billing_subscriptions(user_id,expires_at DESC);

CREATE TABLE IF NOT EXISTS billing_payments (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  order_id TEXT NOT NULL UNIQUE,
  payment_id TEXT UNIQUE,
  amount_paise INTEGER NOT NULL CHECK(amount_paise BETWEEN 1 AND 49900),
  currency TEXT NOT NULL DEFAULT 'INR' CHECK(currency='INR'),
  status TEXT NOT NULL CHECK(status IN ('created','paid','failed','refunded')),
  discount_code_id TEXT REFERENCES billing_discount_codes(id) ON DELETE SET NULL,
  plan_type TEXT NOT NULL DEFAULT 'annual' CHECK(plan_type IN ('monthly','annual')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_billing_payments_user_status ON billing_payments(user_id,status);
CREATE INDEX IF NOT EXISTS idx_billing_payments_plan_status ON billing_payments(plan_type,status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_billing_payments_one_pending_per_user ON billing_payments(user_id) WHERE status='created';

CREATE TABLE IF NOT EXISTS billing_discount_redemptions (
  id TEXT PRIMARY KEY,
  discount_code_id TEXT NOT NULL REFERENCES billing_discount_codes(id) ON DELETE RESTRICT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subscription_id TEXT NOT NULL REFERENCES billing_subscriptions(id) ON DELETE CASCADE,
  amount_paid_paise INTEGER NOT NULL CHECK(amount_paid_paise BETWEEN 0 AND 49900),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_billing_redemptions_user ON billing_discount_redemptions(user_id,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_billing_redemptions_code_user ON billing_discount_redemptions(discount_code_id,user_id);

CREATE TABLE IF NOT EXISTS billing_webhook_events (
  event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS billing_admins (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS billing_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  details TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS webauthn_credentials (
  credential_id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  public_key BLOB NOT NULL,
  counter INTEGER NOT NULL DEFAULT 0 CHECK(counter >= 0),
  transports TEXT NOT NULL DEFAULT '[]',
  credential_device_type TEXT,
  backed_up INTEGER NOT NULL DEFAULT 0 CHECK(backed_up IN (0,1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_used_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_webauthn_credentials_user ON webauthn_credentials(user_id);

CREATE TABLE IF NOT EXISTS webauthn_challenges (
  flow_id TEXT PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  username_key TEXT,
  purpose TEXT NOT NULL CHECK(purpose IN ('register','password_reset')),
  challenge TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_webauthn_challenges_expiry ON webauthn_challenges(expires_at);



CREATE TABLE IF NOT EXISTS auth_device_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  ip_key TEXT NOT NULL,
  attempted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_auth_device_attempts_window
  ON auth_device_attempts(device_id,ip_key,attempted_at DESC);

CREATE TABLE IF NOT EXISTS auth_login_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username_key TEXT NOT NULL,
  ip_key TEXT NOT NULL,
  attempted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  succeeded INTEGER NOT NULL DEFAULT 0 CHECK(succeeded IN (0,1))
);
CREATE INDEX IF NOT EXISTS idx_auth_login_attempts_window
  ON auth_login_attempts(username_key,ip_key,attempted_at DESC);

CREATE TABLE IF NOT EXISTS auth_recovery_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username_key TEXT NOT NULL,
  ip_key TEXT NOT NULL,
  attempted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  succeeded INTEGER NOT NULL DEFAULT 0 CHECK(succeeded IN (0,1))
);
CREATE INDEX IF NOT EXISTS idx_auth_recovery_attempts_window ON auth_recovery_attempts(username_key,ip_key,attempted_at DESC);

CREATE TABLE IF NOT EXISTS recovery_beacon_tokens (
  token_hash TEXT PRIMARY KEY,
  device_id INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_recovery_beacon_device_expiry ON recovery_beacon_tokens(device_id,expires_at DESC);

CREATE TABLE IF NOT EXISTS recovery_helper_encounters (
  encounter_id TEXT PRIMARY KEY,
  target_device_id INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  helper_device_id INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  latitude REAL NOT NULL CHECK(latitude BETWEEN -90 AND 90),
  longitude REAL NOT NULL CHECK(longitude BETWEEN -180 AND 180),
  accuracy_meters REAL CHECK(accuracy_meters IS NULL OR accuracy_meters BETWEEN 0 AND 10000),
  location_timestamp INTEGER NOT NULL,
  observed_at INTEGER NOT NULL,
  location_source TEXT NOT NULL DEFAULT 'phone_b_fused',
  location_fresh INTEGER NOT NULL DEFAULT 0 CHECK(location_fresh IN (0,1)),
  received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TEXT NOT NULL,
  CHECK(target_device_id <> helper_device_id)
);
CREATE INDEX IF NOT EXISTS idx_helper_encounters_target_received ON recovery_helper_encounters(target_device_id,received_at DESC);
CREATE INDEX IF NOT EXISTS idx_helper_encounters_helper_received ON recovery_helper_encounters(helper_device_id,received_at DESC);

CREATE TABLE IF NOT EXISTS billing_payment_intents (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan_type TEXT NOT NULL CHECK(plan_type IN ('monthly','annual')),
  amount_paise INTEGER NOT NULL CHECK(amount_paise BETWEEN 1 AND 49900),
  discount_code_id TEXT REFERENCES billing_discount_codes(id) ON DELETE SET NULL,
  payment_url TEXT,
  status TEXT NOT NULL CHECK(status IN ('pending','awaiting_dynamic_checkout','verified','failed','cancelled')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_billing_payment_intents_user_status ON billing_payment_intents(user_id,status,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_billing_payment_intents_status_created ON billing_payment_intents(status,created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_billing_payment_intents_one_pending_per_user ON billing_payment_intents(user_id) WHERE status IN ('pending','awaiting_dynamic_checkout');

CREATE VIEW IF NOT EXISTS billing_user_registry AS
SELECT u.id AS user_id,u.username,
       t.starts_at AS trial_started_at,t.expires_at AS trial_ends_at,
       s.plan_type AS subscription_plan,s.status AS subscription_status,
       s.starts_at AS subscription_started_at,s.expires_at AS subscription_ends_at
FROM users u
LEFT JOIN billing_trials t ON t.user_id=u.id
LEFT JOIN billing_subscriptions s ON s.id=(
  SELECT s2.id FROM billing_subscriptions s2
  WHERE s2.user_id=u.id ORDER BY s2.created_at DESC,s2.id DESC LIMIT 1
);
