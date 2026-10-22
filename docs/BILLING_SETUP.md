# Jazz Recovery billing integration (feature branch)

## Required private environment variables
- `JAZZ_DB_ENGINE=postgres` and `DATABASE_URL` for the intended Neon branch.
- `JAZZ_DISCOUNT_CODE_PEPPER`: long random secret used to HMAC discount codes.
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
