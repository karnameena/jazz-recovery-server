# Jazz Recovery — PostgreSQL-only rollout checklist

**This branch is a reviewable implementation proposal. It does not migrate production data, deploy to Render, or change the live Neon database.**

## Architecture and hard constraints

- Neon PostgreSQL is the only supported application runtime database.
- `JAZZ_DB_ENGINE` must be `postgres`; `DATABASE_URL` must be configured privately. Missing configuration or any request to use SQLite must fail closed.
- `src/entrypoint.mjs` is the only supported API entrypoint; the admin dispatcher applies the same PostgreSQL-only rule.
- SQLite remains only as an explicit one-time legacy import source. No request, session, PIN, passkey, device, photo, location, recovery-command, or audit operation uses SQLite.
- Website and Android clients call the HTTPS API only. They must never receive database credentials.
- No production database migration, owner recreation, password reset, device-token rotation, or deployment is authorized by this branch.

## PostgreSQL data and migrations

- `migrations/postgres/001_schema.sql`: users, sessions, devices, device state, recovery commands, audit data, and indexes.
- `migrations/postgres/002_device_imei.sql`: additive IMEI field.
- `migrations/postgres/20261021_recovery_pin.sql`: additive recovery PIN hash field.
- `migrations/postgres/20261022_passkeys.sql`: passkey credential and one-time challenge tables.
- `src/pg/database.mjs`: PostgreSQL connection pool, TLS verification for remote databases, transactions, advisory-locked migrations, and safe SQL parameter translation.
- Migrations run in sorted filename order and record applied migration names in `pg_schema_migrations`.

## Authentication and recovery routes

- Registration stores a password hash and recovery PIN hash, and creates the account + paired device + initial device state transactionally.
- Login and server-side sessions use PostgreSQL.
- Recovery PIN reset validates the PIN, updates the password hash, and revokes all active sessions.
- Passkey enrollment and password reset use `@simplewebauthn/server`; credential public keys, counters, transports, and expiring challenges are stored in PostgreSQL.
- Passkey challenges are bound to the account, expire, and are consumed once. The password-reset verification checks that the passkey belongs to the same user as the challenge.
- Existing-device repair authenticates with the account password and updates only the existing device's credential/name/IMEI; it does not delete the device row or reset device history/state.
- Configure `JAZZ_WEBAUTHN_ORIGIN` to the exact HTTPS website origin and `JAZZ_WEBAUTHN_RP_ID` to that origin's hostname. Passkeys will fail verification if those values do not match the browser origin.

## Production data protection

1. Identify the authoritative current owner/device dataset and verify which database the deployed Render service actually uses. Do not infer this from deployment status alone.
2. Keep the original username, password hash, device IDs, device credential hashes, and latest recovery state. Do not create a replacement owner or reset credentials to work around a login error.
3. Make a verified, private backup before any approved data movement. Keep all database files and environment secrets outside GitHub and chat.
4. Run migrations and account-recovery integration tests only against an isolated test database or staging branch.
5. Never run `tests/postgres-migration.test.mjs` with a remote `JAZZ_TEST_DATABASE_URL`; its guarded integration setup drops and recreates the local test schema.
6. Do not run the SQLite importer against production until the source snapshot is verified and the destination's contents have been inspected. The importer must refuse a populated destination rather than overwrite it.
7. Keep Render's `DATABASE_URL` private, enable TLS, set `JAZZ_DB_ENGINE=postgres`, set the correct public website origin, and align WebAuthn origin/RP ID.
8. Review Git history for old database artifacts separately; removing files from the latest commit does not erase historic copies.

## Verification required before production

- CI syntax checks and PostgreSQL migration integration tests pass.
- Registration succeeds with valid matching password/PIN confirmations and rejects duplicates and invalid PINs.
- Login works for the original account with its unchanged hash once the authoritative data is present in the chosen database.
- Sessions survive API process restarts and are revoked after password reset.
- PIN recovery rejects incorrect PINs and applies rate limits.
- Passkey enrollment options are persisted in PostgreSQL; successful registration and reset are verified with a real browser authenticator or a controlled WebAuthn test harness.
- Expired/replayed challenges are rejected.
- Device repair preserves the same device ID, state, history, and owner relationship while invalidating the old token.
- Existing device heartbeat, ring, location, photo, voice, command leasing/result, and owner-isolation workflows pass regression tests.
- A load test validates the approximate 10,000-user target against the selected Neon/Render plans. Do not describe this target as proven until the test results exist.

## 10,000-user readiness

Before claiming capacity, test realistic concurrent registration/login/session polling, inspect PostgreSQL indexes and query plans, use a pooled Neon connection string for application traffic where available, verify Render/Neon connection limits, measure photo/location storage growth, and confirm that rate limiting remains appropriate when multiple API instances run. Free-tier availability and compute quotas are not a high-availability guarantee.
