# Jazz Recovery authentication implementation

## PostgreSQL

The server applies `migrations/postgres/030_recovery_auth.sql` through the existing ordered migration runner. It is additive: it adds nullable recovery PIN metadata to `users` and creates WebAuthn credential, one-time challenge, and recovery-attempt tables. It does not drop or rewrite existing user/device/recovery/billing tables.

For a fresh database, run the normal server migration/startup flow. Do not run destructive reset scripts against production.

## Recovery PIN

- New registrations must submit matching four-digit `recoveryPin` and `confirmRecoveryPin` values.
- Only a per-user salted scrypt hash is stored; the PIN is never stored in plaintext.
- `POST /api/auth/recovery-pin` requires a valid session and the current password, then replaces the salted PIN hash.
- `POST /api/auth/forgot-password` validates username, PIN, and password policy, applies a 5-attempt/15-minute rate limit, updates the password and deletes every active session in one transaction.

## Passkeys

The server uses `@simplewebauthn/server` (v13 API) for WebAuthn parsing and cryptographic verification. Install dependencies from `server/package.json` before deployment (`npm install`; this environment could not reach npm to refresh the lockfile).

No separate WebAuthn environment variables are required. The server derives:

- RP ID from the hostname in the existing `LOST_MODE_PUBLIC_ORIGINS` / `LOST_MODE_PUBLIC_ORIGIN` setting.
- RP name as `Jazz Recovery`.
- Allowed browser origins from that same existing public-origin setting.

Before hosting, the default local origin is `http://localhost:5190`, so local development uses RP ID `localhost`. WebAuthn works on localhost as a browser-secure development context. Once hosted, set the existing public-origin setting to the final HTTPS website origin; the RP ID and allowed origin will be derived automatically. Production passkeys are intentionally unavailable over plain HTTP.

The four endpoints are:

- `POST /api/auth/passkey/register/options` (authenticated)
- `POST /api/auth/passkey/register/verify` (authenticated)
- `POST /api/auth/password-reset/passkey/options`
- `POST /api/auth/password-reset/passkey/verify`

Challenges are random, stored in PostgreSQL for five minutes, and consumed once. Verification checks expected challenge, exact configured origin, RP ID, user verification, and authenticator counter. Password reset invalidates all user sessions.

## Trial access

Admin extension remains based on `billing_trials.starts_at` and `billing_trials.expires_at`. The billing-access function reads this same row; no duplicate client-side expiry state is introduced. Registration now fails atomically with HTTP 409 if a username's trial claim already exists, rather than creating a user/device that silently has no trial. Admin deletion removes only the matching username-hash/user trial claim in the same transaction as deletion, allowing a deliberately deleted username to register again.

## Important verification limitation

This package was edited in an offline environment. JavaScript syntax validation passed. The existing billing unit tests passed (11 tests), but the PostgreSQL migration test could not start because `pg` is not installed in this runtime; npm registry DNS was unavailable, so neither `pg` nor `@simplewebauthn/server` could be installed here. A live PostgreSQL migration test, browser passkey ceremony, and full production build have NOT been completed. Do not deploy until your hosting build installs dependencies and the verification checklist is completed on a separate fresh/test database.
