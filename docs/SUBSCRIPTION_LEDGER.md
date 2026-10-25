# Trial and subscription records

## Editable policy files

- `trial.config.json`: `trialDays` controls the length of a newly claimed trial (default: 7 days).
- `subscription-config.json`: monthly/yearly price in paise and calendar-month duration. Prices and durations are validated when the server starts.

These files define policy only. Do not add usernames or per-user activation records to them: the deployed filesystem may be ephemeral, and JSON files are not safe as the authoritative record when multiple server instances are running.

## Durable per-user records

PostgreSQL stores trial start/end timestamps in `billing_trials`, one-time eligibility in `billing_trial_claims`, and activated monthly/yearly access in `billing_subscriptions`. Registration creates the trial and claim in the same transaction as the user/device registration. A verified Razorpay webhook or an authorized complimentary subscription creates the subscription record.

To inspect each username with its trial dates and latest subscription dates using a database console:

```sql
SELECT username, trial_started_at, trial_ends_at,
       subscription_plan, subscription_status,
       subscription_started_at, subscription_ends_at
FROM public.billing_user_registry
ORDER BY username;
```

Do not expose this view to unauthenticated website users. The billing configuration does not contain secrets; keep `.env` values private.
