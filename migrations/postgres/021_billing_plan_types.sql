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

-- A user can have at most one pending checkout. Resolve legacy duplicate pending rows
-- before creating the index; newest pending order is retained for checkout resumption.
WITH ranked_pending AS (
  SELECT id, ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY created_at DESC, id DESC) AS row_num
  FROM public.billing_payments
  WHERE status = 'created'
)
UPDATE public.billing_payments AS payment
SET status = 'failed', updated_at = CURRENT_TIMESTAMP
FROM ranked_pending
WHERE payment.id = ranked_pending.id AND ranked_pending.row_num > 1;

CREATE UNIQUE INDEX IF NOT EXISTS idx_billing_payments_one_pending_per_user
  ON public.billing_payments(user_id)
  WHERE status = 'created';
