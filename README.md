# Jazz Recovery API — PostgreSQL only

Jazz Recovery's hosted API uses **Neon PostgreSQL as its only runtime database**. The website and Android companion call the Node.js API over HTTPS; neither client receives database credentials or connects directly to PostgreSQL.

## Non-negotiable runtime rules

- `JAZZ_DB_ENGINE=postgres` is the only accepted runtime engine.
- `DATABASE_URL` is required and must be configured privately on the host.
- Missing or invalid PostgreSQL configuration must stop startup. The API and administration dispatcher must never fall back to SQLite.
- `npm start` starts `src/entrypoint.mjs`; `npm run migrate` applies PostgreSQL migrations.
- SQLite is retained only as a **legacy source format for the explicit one-time import utility**. It is not an application runtime database.
- Runtime migrations are additive. Do not drop schemas, recreate the owner, reset credentials, or import over a populated database.

## Persistent data

PostgreSQL stores user accounts and password hashes, recovery PIN hashes, sessions, passkey credentials and one-time WebAuthn challenges, paired devices and credential hashes, IMEI, device state, location and photo data/references, recovery commands, and audit records.

Passkey verification requires the public website origin to match `JAZZ_WEBAUTHN_ORIGIN`; `JAZZ_WEBAUTHN_RP_ID` must be that website's hostname. Keep these values aligned with the HTTPS website users actually open.

## Hosted configuration

Set these values in the private Render environment (do not commit secrets):

| Variable | Purpose |
| --- | --- |
| `JAZZ_DB_ENGINE` | Must be `postgres` |
| `DATABASE_URL` | Neon PostgreSQL connection string with TLS |
| `LOST_MODE_PUBLIC_ORIGINS` | Exact HTTPS website origin allowed to call the API |
| `LOST_MODE_COOKIE_SECURE` | `true` in production |
| `LOST_MODE_COOKIE_SAMESITE` | `None` when the frontend and API are cross-site |
| `LOST_MODE_TRUST_PROXY` | `true` when behind the trusted Render proxy |
| `JAZZ_WEBAUTHN_ORIGIN` | Exact HTTPS website origin for passkeys |
| `JAZZ_WEBAUTHN_RP_ID` | Hostname of that website, without scheme or path |

Render provides `PORT`. The checked-in `render.yaml` is a staging/proposal configuration; do not deploy it to production without reviewing the service settings and explicitly approving the cutover.

## Account recovery endpoints

- `POST /api/auth/register` — creates a user, stores password/PIN hashes, pairs the submitted Android device, and creates a session in one PostgreSQL transaction.
- `POST /api/auth/recovery-pin` — authenticated PIN setup/change, requiring the current password.
- `POST /api/auth/forgot-password` — verifies username + recovery PIN, changes the password, and revokes the user's existing sessions.
- `POST /api/auth/passkey/register/options` and `/verify` — authenticated passkey enrollment.
- `POST /api/auth/password-reset/passkey/options` and `/verify` — passkey-based password reset. Compatibility aliases `/api/auth/passkey/options` and `/api/auth/passkey/verify` are also supported.
- `POST /api/auth/device-repair` — verifies the account password and updates the token on an existing device record without replacing its device state/history.

Recovery PINs are stored as password-style hashes, never plaintext. A 4-digit PIN has limited entropy, so keep rate limits enabled and consider a longer recovery secret in a future UI-compatible change. Passkey challenges expire and are consumed once; passkey credentials and challenge state are stored in PostgreSQL.

## Preserving the existing owner and devices

Deploying source code does **not** move data. Before any production cutover, identify which database currently contains the authoritative owner, paired-device credential hashes, and newest recovery state. Keep the original owner identity, password hash, device IDs, and device credential hashes unchanged. Never paste passwords or `DATABASE_URL` into chat, logs, GitHub, or source files.

The legacy import tool is intentionally separate and must be reviewed against a private, consistent backup first. It refuses to overwrite a populated PostgreSQL destination and requires explicit apply confirmation. Never run its destructive test setup against Neon or any remote database.

## Local validation

Requires Node.js 22.5+ and npm. Use a dedicated, isolated local PostgreSQL test database; never use the live Neon production connection for tests.

```powershell
$env:JAZZ_DB_ENGINE = "postgres"
# Set DATABASE_URL privately in your terminal environment.
npm install
node --check src/entrypoint.mjs
node --check src/pg/server.mjs
node --test tests/postgres-only-runtime.test.mjs
node --test tests/location-services-readback.test.mjs
# PostgreSQL integration test requires JAZZ_TEST_DATABASE_URL to point to loopback only.
node --test tests/postgres-migration.test.mjs
```

The PostgreSQL integration test deliberately resets the `public` schema only after verifying that `JAZZ_TEST_DATABASE_URL` is a loopback address. **Never point it at Neon or another remote database.**

## Scale target

The design target is approximately 10,000 registered website users. This is a target, not a performance guarantee: validate Neon plan limits, connection pooling, indexes, API rate limits, storage growth, and concurrent registration/login behavior with load tests before announcing capacity.

## Security note

This repository's older history may contain database artifacts. Removing a file from the current tree does not remove it from Git history. Review repository visibility and history exposure separately, and do not commit database backups, session cookies, tokens, credentials, locations, or recovery photos.
