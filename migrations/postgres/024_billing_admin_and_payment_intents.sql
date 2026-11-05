-- Additive billing controls. Existing recovery tables and account data are untouched.
ALTER TABLE public.billing_discount_codes
  ADD COLUMN IF NOT EXISTS trial_eligible_from TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS trial_eligible_until TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS public.billing_payment_intents (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  plan_type TEXT NOT NULL CHECK (plan_type IN ('monthly','annual')),
  amount_paise INTEGER NOT NULL CHECK (amount_paise BETWEEN 1 AND 49900),
  discount_code_id TEXT REFERENCES public.billing_discount_codes(id) ON DELETE SET NULL,
  payment_url TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending','awaiting_dynamic_checkout','verified','failed','cancelled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_billing_payment_intents_user_status
  ON public.billing_payment_intents(user_id,status,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_billing_payment_intents_status_created
  ON public.billing_payment_intents(status,created_at DESC);

-- Disable historical 100% complimentary codes; never auto-grant access from them.
UPDATE public.billing_discount_codes SET active=FALSE, updated_at=CURRENT_TIMESTAMP WHERE percent_off=100;

-- At most one unresolved payment intent per account; a new checkout cancels the previous intent.
CREATE UNIQUE INDEX IF NOT EXISTS idx_billing_payment_intents_one_pending_per_user
  ON public.billing_payment_intents(user_id)
  WHERE status IN ('pending','awaiting_dynamic_checkout');
