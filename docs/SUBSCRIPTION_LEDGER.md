# Trial and subscription records

## Editable policy files

- `trial.config.json`: `trialDays` controls the default length of a newly claimed trial (default: 7 days). Its optional `users` object supports explicit per-username overrides with `enabled`, `startDate`, `endDate`, and `description`.
- `subscription-config.json`: monthly/yearly price in paise and calendar-month duration. Prices and durations are validated when the server starts.

Example per-user override (add inside `trial.config.json` under `users`):
```json
{
  "karnameena1": {
    "enabled": true,
    "startDate": "2026-10-25T00:00:00+05:30",
    "endDate": "2026-11-01T23:59:59+05:30",
    "description": "Manually managed trial period"
  }
}
```

The username entry is an override, not the user registry. For a new registration, the configured timestamps are used instead of the default duration. For an existing account, an enabled override is applied to its PostgreSQL trial record when the authenticated owner refreshes the per-user ledger. Removing an override does not delete or reset the PostgreSQL record; an entry with `enabled: false` prevents a configured trial from being granted to a newly registered account and does not revoke an already-issued trial. Dates must be ISO timestamps with an explicit timezone and `endDate` must be after `startDate`.

PostgreSQL remains the authoritative persistent store for all actual per-user trial and subscription records. Do not treat JSON as a dynamically written user database; this avoids data loss on redeploy and inconsistencies across server instances.

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
