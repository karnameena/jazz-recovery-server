# Jazz Recovery billing integration (feature branch)

## Required private environment variables
- `JAZZ_DB_ENGINE=postgres` and `DATABASE_URL` for the intended Neon branch.
- `JAZZ_DISCOUNT_CODE_PEPPER`: long random secret used to HMAC discount codes.
- `JAZZ_TRIAL_CLAIM_PEPPER`: separate long random secret used to prevent the same normalized username claiming repeated trials without storing usernames in trial history.
- `JAZZ_BILLING_ADMIN_BOOTSTRAP_SECRET`: one-time high-entropy secret used by the first authenticated account to claim billing-admin status.
- `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`: Razorpay Test Mode credentials first; configure the webhook to send `payment.captured` and `order.paid` events to `/api/billing/razorpay/webhook`.

Never put these values in the website bundle, Git, screenshots, or chat.

## Safety notes
- The registration endpoint creates a one-time seven-day trial.
- Annual list price is ₹499 (49900 paise). Discounts are 10%, 20%, 50%, and 100%; the server calculates amounts.
- Only a verified Razorpay webhook grants paid subscriptions. Browser callbacks are not payment proof.
- 100% discounts grant a complimentary annual subscription without creating a Razorpay order.
- Code rotation changes future code validation only; already granted subscriptions remain intact.
- The first admin must authenticate normally and submit the one-time bootstrap secret. After claiming, remove the bootstrap secret from the environment.
- Do not reset production until the migration and registration path have been tested on a separate Neon branch and a new owner account/bootstrap process has been confirmed.


## Production fresh reset (owner/admin will also be deleted)

**Status: NOT EXECUTED.** Do not run this until the matching website/server feature branches are approved, staging registration and recovery checks pass, Razorpay Test Mode webhook verification succeeds, and the production cutover is scheduled.

A separate Neon branch copy was created from the production branch and verified:
- Backup branch: `pre-reset-production-verified-20261022`
- Branch ID: `br-long-cell-b4cie19y`
- At backup time: 1 user, 1 device, 1 session, 177 recovery commands, and 465 recovery audit rows.
- The native snapshot request was rejected because the project's snapshot quota was full. The branch copy is the available recoverable backup; keep it and do not delete it.
- Migration verification branch: `billing-feature-test-20261022` (`br-broad-paper-b4mv3x1t`). The billing migration was applied there; all billing tables were created and the original user/device/recovery row counts remained unchanged.

### Approved reset scope
The requested reset removes the existing owner/admin account as well as every registered user, paired device, browser session, queued recovery command, recovery state, recovery audit record, billing admin, discount code/redemption, trial claim, subscription, payment record, and webhook event. It must **not** drop schemas or tables. The Neon Auth schema is not part of this reset.

### Cutover sequence
1. Create and verify a second Neon branch backup immediately before the reset; preserve both backup branches.
2. Pause the deployed API to prevent concurrent writes. Confirm the deployed server's `DATABASE_URL` points to the intended production branch.
3. Apply the new migration from this feature branch and verify the new schema exists.
4. In one transaction, delete rows in this order (only after the backup is verified):
   ```sql
   BEGIN;
   DELETE FROM public.billing_webhook_events;
   DELETE FROM public.billing_discount_redemptions;
   DELETE FROM public.billing_payments;
   DELETE FROM public.billing_subscriptions;
   DELETE FROM public.billing_trials;
   DELETE FROM public.billing_trial_claims;
   DELETE FROM public.billing_discount_codes;
   DELETE FROM public.billing_admins;
   DELETE FROM public.billing_audit;
   DELETE FROM public.recovery_commands;
   DELETE FROM public.device_state;
   DELETE FROM public.devices;
   DELETE FROM public.sessions;
   DELETE FROM public.recovery_audit;
   DELETE FROM public.users;
   COMMIT;
   ```
5. Deploy the tested website and server pair, then register the new owner account through the website. Generate/copy the device ID and secret into the installed Android app.
6. Claim billing-admin access once using `JAZZ_BILLING_ADMIN_BOOTSTRAP_SECRET`; remove that secret from Render after the claim succeeds.
7. Confirm a new 7-day trial, login/logout, Android heartbeat, command polling/results, recovery actions, discount management, and Razorpay Test Mode webhook activation before accepting real payments.

Do not perform the reset before step 1–3 are complete. If any verification fails, stop and restore the app/database connection to the verified backup rather than continuing.
