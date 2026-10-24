-- Configurable discount eligibility and per-user redemption limits.
ALTER TABLE public.billing_discount_codes
  ADD COLUMN IF NOT EXISTS eligible_plan TEXT NOT NULL DEFAULT 'annual';
ALTER TABLE public.billing_discount_codes
  ADD COLUMN IF NOT EXISTS per_user_limit INTEGER NOT NULL DEFAULT 1;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'billing_discount_codes_eligible_plan_check') THEN
    ALTER TABLE public.billing_discount_codes
      ADD CONSTRAINT billing_discount_codes_eligible_plan_check CHECK (eligible_plan IN ('annual','monthly','both'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'billing_discount_codes_per_user_limit_check') THEN
    ALTER TABLE public.billing_discount_codes
      ADD CONSTRAINT billing_discount_codes_per_user_limit_check CHECK (per_user_limit BETWEEN 1 AND 1000000);
  END IF;
END $$;

-- Replace the former one-redemption-per-user constraint with the configurable
-- per-user limit enforced under a row lock in the billing transaction.
ALTER TABLE public.billing_discount_redemptions
  DROP CONSTRAINT IF EXISTS billing_discount_redemptions_discount_code_id_user_id_key;
CREATE INDEX IF NOT EXISTS idx_billing_redemptions_code_user
  ON public.billing_discount_redemptions(discount_code_id, user_id);
