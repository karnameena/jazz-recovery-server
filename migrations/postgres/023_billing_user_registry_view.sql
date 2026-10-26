-- Read-only registry view for auditing each username's trial and latest subscription dates.
-- User entitlement records remain normalized and durable in PostgreSQL.
CREATE OR REPLACE VIEW public.billing_user_registry AS
SELECT
  u.id AS user_id,
  u.username,
  t.starts_at AS trial_started_at,
  t.expires_at AS trial_ends_at,
  s.plan_type AS subscription_plan,
  s.status AS subscription_status,
  s.starts_at AS subscription_started_at,
  s.expires_at AS subscription_ends_at
FROM public.users AS u
LEFT JOIN public.billing_trials AS t ON t.user_id = u.id
LEFT JOIN LATERAL (
  SELECT plan_type, status, starts_at, expires_at
  FROM public.billing_subscriptions
  WHERE user_id = u.id
  ORDER BY created_at DESC, id DESC
  LIMIT 1
) AS s ON TRUE;
