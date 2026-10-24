-- Add explicit plan identity for billing records without altering existing recovery data.
-- Existing billing records are treated as annual because the previous release only sold annual access.
ALTER TABLE public.billing_subscriptions
  ADD COLUMN IF NOT EXISTS plan_type TEXT NOT NULL DEFAULT 'annual';
ALTER TABLE public.billing_payments
  ADD COLUMN IF NOT EXISTS plan_type TEXT NOT NULL DEFAULT 'annual';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'billing_subscriptions_plan_type_check') THEN
    ALTER TABLE public.billing_subscriptions
      ADD CONSTRAINT billing_subscriptions_plan_type_check CHECK (plan_type IN ('monthly','annual'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'billing_payments_plan_type_check') THEN
    ALTER TABLE public.billing_payments
      ADD CONSTRAINT billing_payments_plan_type_check CHECK (plan_type IN ('monthly','annual'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_billing_payments_plan_status
  ON public.billing_payments(plan_type, status);
