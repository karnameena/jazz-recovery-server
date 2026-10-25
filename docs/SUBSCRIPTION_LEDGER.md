# Trial and subscription records

## Editable policy files

- `trial.config.json`: `trialDays` controls the default length of a newly claimed trial (default: 7 days). Its optional `users` object supports explicit per-username overrides with `enabled`, `startDate`, `endDate`, and `description`.
- `subscription-config.json`: monthly/yearly price in paise, calendar-month duration, and display labels (`1 month` / `12 months`). Prices and durations are validated when the server starts. Edit these plan rules here; actual per-user paid subscription records are not manually maintained in this file.

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

## Subscription plan configuration

The editable plan policy uses this structure:

```json
{
  "currency": "INR",
  "plans": {
    "monthly": {
      "pricePaise": 4900,
      "durationMonths": 1,
      "label": "Monthly",
      "periodLabel": "1 month"
    },
    "annual": {
      "pricePaise": 39900,
      "durationMonths": 12,
      "label": "Annual",
      "periodLabel": "12 months"
    }
  }
}
```

After a verified payment, PostgreSQL records the username association, plan type, actual start/end timestamps, amount paid, payment reference, and status. The owner-only dashboard ledger displays the username, plan, period, start date, end date, amount, and active/expired state. Do not append paid users to `subscription-config.json`: deployments can replace configuration files, and a file edit must never be able to mark an unverified payment as paid.

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
