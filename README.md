# Jazz Recovery API — PostgreSQL only

Jazz Recovery's hosted API uses **Neon PostgreSQL as its only runtime database**. The website and Android companion call the Node.js API over HTTPS; neither client receives database credentials or connects directly to PostgreSQL.

## Non-negotiable runtime rules

- `JAZZ_DB_ENGINE=postgres` is the only accepted runtime engine.
- `DATABASE_URL` is required and must be configured privately on the host.
- Missing or invalid PostgreSQL configuration must stop startup. The API and administration dispatcher must never fall back to SQLite.
- `npm start` starts `src/entrypoint.mjs`; `npm run migrate` applies PostgreSQL migrations.
- No SQLite runtime, adapter, migration path, or importer is included. All persistent application data uses PostgreSQL.
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

No data importer is included. Keep the existing Neon database and its records in place during code deployment. Any future data movement must be separately designed, explicitly authorized, and tested without resetting the existing database.

## Local validation

Requires Node.js 22.5+ and npm. Use a dedicated, isolated local PostgreSQL test database; never use the live Neon production connection for tests.

```powershell
$env:JAZZ_DB_ENGINE = "postgres"
# Set DATABASE_URL privately in your terminal environment.
npm install
node --check src/entrypoint.mjs
node --check src/pg/server.mjs
node --test tests/postgres-only-runtime.test.mjs
node --test tests/postgres-only-runtime.test.mjs
# PostgreSQL integration test requires JAZZ_TEST_DATABASE_URL to point to loopback only.
node --test tests/postgres-migration.test.mjs
```

The PostgreSQL integration test deliberately resets the `public` schema only after verifying that `JAZZ_TEST_DATABASE_URL` is a loopback address. **Never point it at Neon or another remote database.**

## Scale target

The design target is approximately 10,000 registered website users. This is a target, not a performance guarantee: validate Neon plan limits, connection pooling, indexes, API rate limits, storage growth, and concurrent registration/login behavior with load tests before announcing capacity.

## Security note

This repository's older history may contain database artifacts. Removing a file from the current tree does not remove it from Git history. Review repository visibility and history exposure separately, and do not commit database backups, session cookies, tokens, credentials, locations, or recovery photos.


## Permanent billing administrator and account recovery

Billing-admin access is a PostgreSQL role in `billing_admins`; it is not a hard-coded username/password and is not stored in the website. The account password remains a salted password hash in `users`. Public first-time admin claiming is disabled. Ordinary visitors and subscribers never see the owner bootstrap form.

Run these commands only from a trusted private terminal in the server checkout, with `DATABASE_URL` and `JAZZ_DB_ENGINE=postgres` configured for the intended database. In Render, use the deployed server's private Shell/one-off job after the relevant code has been deployed. Do not share the Neon connection string or any password.

1. **Find the owner username and role**
   ```powershell
   npm run list-users
   ```
   This prints usernames and whether each account has billing-admin access. It never prints passwords or password hashes.

2. **Recover or assign billing-admin access to an existing account**
   ```powershell
   npm run recover-billing-admin
   ```
   Enter the existing registered username. If a different billing admin already exists, the command requires the exact confirmation `REASSIGN BILLING ADMIN` before transferring the role. It changes only the rows in `billing_admins`; it does not delete users, paired devices, subscriptions, trials, locations, or photos. If the target already has the role, it makes no change.

3. **If the password was forgotten**
   ```powershell
   npm run change-owner-password
   ```
   Enter the username and a new password when prompted. Password entry is hidden in an interactive terminal; password hashes are stored in PostgreSQL and existing sessions for that account are revoked. Do not pass the password as a command-line argument.

4. **If there is no owner account yet**
   First run `npm run list-users`. Only if you have confirmed that no suitable existing account exists, create one with `npm run create-owner`, then run `npm run recover-billing-admin` and assign the role to that account. Do not create a replacement account just because the password was forgotten; reset the existing account's password instead.

The account and role persist across deployments because they are in PostgreSQL. Do not add an automatic owner-creation step to server startup, do not reset the database, and do not expose these recovery commands as public HTTP endpoints. Keep a securely stored copy of the owner username in a password manager. A password manager may also store the password; the application itself must never be able to reveal it later.

Before production use, verify that the hosted API and website branches containing these changes have been reviewed, merged, and deployed. Do not run database recovery commands against Neon until you have verified which database the private terminal is configured to use.
