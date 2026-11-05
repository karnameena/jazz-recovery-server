we are using d1 db coloudflared


## Local setup

1. Copy `.env.example` to `.env` and configure a dedicated local PostgreSQL database.
2. Run `npm ci`.
3. Run `npm start`. The npm script loads the private `.env` file (without overriding platform-injected variables), then the entry point refuses to start unless PostgreSQL is explicitly configured. PostgreSQL migrations run during startup.
4. Verify `http://localhost:8891/health`.
5. After creating/registering the intended administrator account, run `npm run bootstrap-billing-admin` once from the server folder and enter that account username plus the private bootstrap secret.

The website Vite proxy targets `http://127.0.0.1:8891` by default.

## Billing safety

- Trials, subscription records, discount codes, payment intents and audit events are stored in PostgreSQL.
- The first billing administrator is designated from the server with `npm run bootstrap-billing-admin`; the script verifies the private `JAZZ_BILLING_ADMIN_BOOTSTRAP_SECRET`, refuses to replace an existing administrator, and records an audit event.
- Discount codes are annual-only and limited to 10%, 20% and 50%.
- Fixed-price Razorpay links are configured for ₹49 monthly and ₹399 annual. Payment intents remain pending; a browser redirect does not activate a subscription.
- Discounted annual intents remain pending until dynamic checkout can collect the exact amount.
- No payment verification/webhook is enabled in this release. Implement verified activation only after merchant KYC and webhook configuration are complete.

## Database safety

Migrations are additive. Do not reset production or run integration tests against production/Neon. Use a dedicated local test database or isolated Neon test branch. PostgreSQL is the only supported runtime database; the legacy SQLite implementation is not an application startup option.
