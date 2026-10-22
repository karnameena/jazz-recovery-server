-- Jazz Recovery subscriptions and billing. Safe, additive migration; preserves recovery tables.
ALTER TABLE public.devices ADD COLUMN IF NOT EXISTS imei TEXT;

CREATE TABLE IF NOT EXISTS public.billing_trials (
  user_id INTEGER PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
  starts_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_billing_trials_expires_at ON public.billing_trials(expires_at);

CREATE TABLE IF NOT EXISTS public.billing_discount_codes (
  id TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  percent_off INTEGER NOT NULL CHECK (percent_off IN (10,20,50,100)),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  starts_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMPTZ,
  max_redemptions INTEGER CHECK (max_redemptions IS NULL OR max_redemptions > 0),
  redeemed_count INTEGER NOT NULL DEFAULT 0 CHECK (redeemed_count >= 0),
  created_by INTEGER REFERENCES public.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_billing_discount_active ON public.billing_discount_codes(active, expires_at);

CREATE TABLE IF NOT EXISTS public.billing_subscriptions (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('active','complimentary','expired','refunded')),
  starts_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  amount_paid_paise INTEGER NOT NULL CHECK (amount_paid_paise BETWEEN 0 AND 49900),
  discount_code_id TEXT REFERENCES public.billing_discount_codes(id) ON DELETE SET NULL,
  payment_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_billing_subscriptions_user_expiry ON public.billing_subscriptions(user_id, expires_at DESC);

CREATE TABLE IF NOT EXISTS public.billing_payments (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  order_id TEXT NOT NULL UNIQUE,
  payment_id TEXT UNIQUE,
  amount_paise INTEGER NOT NULL CHECK (amount_paise BETWEEN 1 AND 49900),
  currency TEXT NOT NULL DEFAULT 'INR' CHECK (currency = 'INR'),
  status TEXT NOT NULL CHECK (status IN ('created','paid','failed','refunded')),
  discount_code_id TEXT REFERENCES public.billing_discount_codes(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_billing_payments_user_status ON public.billing_payments(user_id, status);

CREATE TABLE IF NOT EXISTS public.billing_discount_redemptions (
  id TEXT PRIMARY KEY,
  discount_code_id TEXT NOT NULL REFERENCES public.billing_discount_codes(id) ON DELETE RESTRICT,
  user_id INTEGER NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  subscription_id TEXT NOT NULL REFERENCES public.billing_subscriptions(id) ON DELETE CASCADE,
  amount_paid_paise INTEGER NOT NULL CHECK (amount_paid_paise BETWEEN 0 AND 49900),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(discount_code_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_billing_redemptions_user ON public.billing_discount_redemptions(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.billing_webhook_events (
  event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS public.billing_admins (
  user_id INTEGER PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS public.billing_audit (
  id BIGSERIAL PRIMARY KEY,
  actor_user_id INTEGER REFERENCES public.users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
