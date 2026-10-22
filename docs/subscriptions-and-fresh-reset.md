# Jazz Recovery registration, trials, subscriptions and production reset

## Current implementation branch

- Server: `feature/fresh-registration-subscriptions-20261022`
- Website: `feature/fresh-registration-subscriptions-20261022`
- The feature branch is isolated; do not merge or deploy until the checklist below passes.
- Production Neon snapshot created before any reset: `before-jazz-recovery-fresh-reset-20261022`.
- A separate Neon test branch was created from production: `jazz-recovery-fresh-reset-test-20261022`.

## What this feature adds

- Website registration form: username, password + confirmation, device name, IMEI, generated device-token ID, and generated device secret.
- Server-side password policy and hashing; device secret is hashed server-side. The plaintext device token is shown to the user only at registration time.
- One seven-day trial record per account. New account registration creates the subscription record in the same database transaction as user/device registration.
- Annual plan priced at INR 49900 paise (₹499.00); no automatic renewal.
- Server-side 10%, 20%, 50%, and 100% discounts; code hashes are stored, not plaintext codes.
- Owner-only discount creation, enable/disable controls, optional expiry, optional redemption limit, and audit events.
- Razorpay order creation, HMAC webhook signature verification, amount/currency matching, event idempotency, and annual entitlement activation only after a captured payment webhook.
- Existing device recovery routes and command allowlist are left in place.

## Required private Render environment variables

Set these in the server service's private environment settings, not in Git or the website bundle:

- `JAZZ_DB_ENGINE=postgres`
- `DATABASE_URL`: connection string for the intended Neon branch (use the pooled URL for normal runtime traffic where suitable).
- `JAZZ_OWNER_USERNAME`: exact username of the preserved owner account. Confirm this value before enabling admin controls.
- `JAZZ_DISCOUNT_PEPPER`: a long, random, stable secret used to hash discount codes. Keep it private and do not rotate it casually, or existing codes will no longer validate.
- `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, and `RAZORPAY_WEBHOOK_SECRET`: use Razorpay **Test Mode** credentials first.
- `LOST_MODE_PUBLIC_ORIGINS`: exact website origin(s), as already required by the recovery API.

Configure a Razorpay webhook pointing to `/api/billing/webhook` and subscribe to `payment.captured`. Keep the webhook secret separate from the API key secret. The customer total remains ₹499 before discount; gateway charges are deducted from merchant settlement, not added to the displayed customer price.

## Before production deployment

1. Build the website and server from these feature branches in staging.
2. Confirm migration `002_device_imei.sql` runs before registration. Production was inspected and the IMEI column was missing from the live schema at inspection time; the migration runner should add it.
3. Confirm the migration `003_subscriptions_discounts_payments.sql` completes and existing accounts receive a subscription row without deleting any users/devices.
4. Test registration, duplicate usernames/device IDs, password mismatch, invalid IMEI, login/logout, and app heartbeat/polling/command result.
5. Test trial status and expiry; 10%, 20%, 50%, and 100% codes; expired/disabled/duplicate codes; admin denial for non-owner sessions; and code rotation.
6. In Razorpay Test Mode, test failed/cancelled payment, correct captured payment, wrong amount/currency, invalid webhook signature, repeated webhook delivery, and delayed webhook delivery.
7. Test concurrent code redemptions and duplicate orders. Do not enable limited-use promotions until redemption reservation/concurrency tests pass.
8. Run a realistic load test before making any 10K/50K capacity claim.
9. Verify essential recovery workflows still work for an expired subscription. Do not lock out critical recovery functions merely because a trial ended.
10. Review the actual Render branch/auto-deploy setting. This branch must not be deployed to production by accident.

## Production data reset — NOT EXECUTED

A snapshot exists. Do not run destructive SQL until staging registration and login are verified and the exact owner username is confirmed. The reset must preserve the owner row and schema, remove all old device registrations and sessions, and remove non-owner accounts only. Do not use `DROP SCHEMA`, `DROP TABLE`, or truncate the recovery schema.

Suggested transaction after successful staging validation, after replacing the owner username with the confirmed exact value:

```sql
BEGIN;

-- Clear device registrations and dependent state/queued commands.
DELETE FROM public.devices;

-- Invalidate active browser sessions, including the preserved owner's session.
DELETE FROM public.sessions;

-- Clear old audit history only if the owner explicitly wants it erased.
-- DELETE FROM public.recovery_audit;

-- Remove ordinary accounts while retaining the owner/admin account.
DELETE FROM public.users
WHERE LOWER(username) <> LOWER('REPLACE_WITH_CONFIRMED_OWNER_USERNAME');

COMMIT;
```

The existing `users`, `devices`, `device_state`, `recovery_commands`, and audit schemas remain intact. Take a second snapshot immediately before executing this transaction. After the reset, log in as the preserved owner and register a new device through the website. This SQL is documentation only and has not been run against production.
