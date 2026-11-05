-- Additive recovery authentication schema for new and existing PostgreSQL deployments.
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS recovery_pin_hash TEXT;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS recovery_pin_updated_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS public.webauthn_credentials (
  credential_id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  public_key BYTEA NOT NULL,
  counter BIGINT NOT NULL DEFAULT 0 CHECK (counter >= 0),
  transports TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  credential_device_type TEXT,
  backed_up BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_used_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_webauthn_credentials_user ON public.webauthn_credentials(user_id);

CREATE TABLE IF NOT EXISTS public.webauthn_challenges (
  flow_id UUID PRIMARY KEY,
  user_id INTEGER REFERENCES public.users(id) ON DELETE CASCADE,
  username_key TEXT,
  purpose TEXT NOT NULL CHECK (purpose IN ('register','password_reset')),
  challenge TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_webauthn_challenges_expiry ON public.webauthn_challenges(expires_at);

CREATE TABLE IF NOT EXISTS public.auth_recovery_attempts (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  username_key TEXT NOT NULL,
  ip_key TEXT NOT NULL,
  attempted_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  succeeded BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE INDEX IF NOT EXISTS idx_auth_recovery_attempts_window ON public.auth_recovery_attempts(username_key, ip_key, attempted_at DESC);
