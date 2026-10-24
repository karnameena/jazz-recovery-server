# Jazz Recovery subscription and Razorpay setup

This guide applies to the isolated subscription feature branch. It does not authorize a production reset, merge, or deployment.

## Plans and rules

- Monthly: ₹49 (4900 paise), one calendar month.
- Annual: ₹399 (39900 paise), twelve calendar months.
- A new eligible username receives one seven-day trial. Trial claims are retained as a username HMAC in PostgreSQL so deleting/recreating an account does not automatically grant another trial.
- Discount codes apply to the annual plan only. The server computes every amount in integer paise.
- `jazzry10` is seeded as an active 10% annual discount when `JAZZ_DISCOUNT_CODE_PEPPER` is configured.
- `jazzfamly` is seeded as a disabled 100% complimentary annual code. In the owner controls, set a maximum redemption count and save it before enabling the code. This prevents an accidental unlimited free-access code.
- A 100% code grants a complimentary entitlement without pretending a Razorpay payment occurred.
- Active subscriptions cannot be checked out again until current access expires. Each account can have one pending checkout; retrying the same plan/code resumes its existing Razorpay order.
- Only a captured payment confirmed by a valid Razorpay webhook can activate paid access. Browser callbacks, screenshots, and payment-success pages are not payment proof.
- Recovery data and billing data use PostgreSQL. The hosted entry point fails closed unless `JAZZ_DB_ENGINE=postgres` and `DATABASE_URL` are configured.

## Required private Render environment variables

- `JAZZ_DB_ENGINE=postgres`
- `DATABASE_URL` — Neon PostgreSQL connection string for the intended environment.
- `JAZZ_DISCOUNT_CODE_PEPPER` — long random secret used to HMAC discount codes.
- `JAZZ_TRIAL_CLAIM_PEPPER` — a different long random secret used to HMAC trial claims.
- `JAZZ_BILLING_ADMIN_BOOTSTRAP_SECRET` — one-time high-entropy secret used by the first authenticated owner account to claim billing-admin controls.
- `RAZORPAY_KEY_ID` — use the Test Mode key while KYC is pending.
- `RAZORPAY_KEY_SECRET` — private server-side Test Mode secret.
- `RAZORPAY_WEBHOOK_SECRET` — a separate secret configured for the Razorpay webhook endpoint.
- Existing server origin/cookie settings required by the current deployment, including `LOST_MODE_PUBLIC_ORIGINS`.

Generate high-entropy secrets locally with a trusted password manager or PowerShell cryptographic randomness. Never commit them, place them in Vite variables, paste them into screenshots, or share them in chat. The Razorpay key secret and webhook secret must never be exposed to the browser.

## Razorpay configuration

1. Complete the merchant KYC/business verification requested by Razorpay. Until approved, keep the site in Test Mode.
2. Configure the server with Test Mode credentials only.
3. In Razorpay, add a webhook pointing to `https://YOUR-API-HOST/api/billing/razorpay/webhook`.
4. Set the webhook secret in `RAZORPAY_WEBHOOK_SECRET`.
5. Enable `payment.captured` and `order.paid` events. The backend verifies the HMAC signature over the raw request body and checks the payment order, INR currency, exact amount, and pending billing record. Webhook event IDs are stored to make retries idempotent.
6. Use Razorpay's test payment methods to verify successful, failed, dismissed, duplicate, and delayed webhook scenarios before requesting live credentials.
7. Once KYC is approved, configure the live Key ID, Key Secret, and webhook secret privately on the server and verify the live webhook. Never mix Test Mode and Live Mode credentials.

## First owner setup and discounts

1. Register/sign in using the intended owner account; do not delete or reset existing accounts as part of billing setup.
2. Configure the one-time `JAZZ_BILLING_ADMIN_BOOTSTRAP_SECRET`, sign in as the owner, and use the existing billing admin claim flow once. Remove the bootstrap secret from Render after successful claim.
3. The server seeds `jazzry10` and `jazzfamly` on PostgreSQL when `JAZZ_DISCOUNT_CODE_PEPPER` is configured. The seed is insert-only; it does not overwrite owner changes.
4. In Owner Controls, set a maximum redemption limit for `jazzfamly`, save it, then enable it. Keep it disabled until its limit is set.
5. Confirm `jazzry10` previews 10% off ₹399 (₹359.10) and `jazzfamly` previews ₹0 only after it is enabled.

## Test checklist

- Registration creates one seven-day trial and paired device in the same PostgreSQL-backed flow.
- Login, logout, and re-login do not reset trial timestamps.
- Trial expiry is calculated from server timestamps.
- Monthly checkout creates a ₹49 order and grants one calendar month after verified capture.
- Annual checkout creates a ₹399 order and grants twelve calendar months after verified capture.
- Annual discounts calculate correctly: 10% → ₹359.10; 20% → ₹319.20; 50% → ₹199.50; 100% → ₹0 complimentary entitlement.
- Monthly checkout rejects annual-only discount codes.
- Invalid webhook signatures, mismatched amounts/currency/orders, and unverified browser callbacks never activate access.
- Duplicate webhook delivery never grants a second subscription.
- Concurrent checkout attempts cannot create multiple pending orders for the same account.
- Existing owner login, device pairing, device heartbeat, location, recovery photo, commands, and audit records remain intact.
- Verify the website production build and server tests before any deployment.

## Deployment safety

- This branch is not a production release.
- Do not run any user/device reset SQL, drop schemas, change the production Neon branch, merge these branches, or deploy without explicit owner approval.
- Apply the additive `021_billing_plan_types.sql` migration only through the reviewed PostgreSQL migration runner on the intended environment.
- Take and verify a fresh database backup before any production migration.
- KYC pending means live payment acceptance is not ready. The website can be built and tested in Test Mode, but do not advertise live checkout until Razorpay enables it.
