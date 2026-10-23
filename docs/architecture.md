# Jazz Recovery data and runtime policy

## Non-negotiable rule

Neon PostgreSQL is the only supported database for any running Jazz Recovery API environment: development, test, staging, and production. Each environment must use its own Neon branch/connection string. There is no automatic SQLite fallback.

## Data ownership

| Data | Authoritative store |
|---|---|
| Usernames and password hashes | Neon `users` |
| Browser/API sessions | Neon `sessions` |
| Device ownership, device ID, credential hash, IMEI | Neon `devices` |
| Current device telemetry and recovery state | Neon `device_state` |
| Commands and command results | Neon `recovery_commands` |
| Security/recovery audit trail | Neon `recovery_audit` |
| Subscription and payment state | Neon PostgreSQL, after reviewed migrations and verified payment webhooks are implemented |

## Request flow

1. Website or Android sends an HTTPS request to the API.
2. The API validates the browser session or device credential.
3. The API checks account ownership on every user-scoped device/action.
4. The API reads or writes Neon using parameterized SQL through the PostgreSQL data module.
5. The API returns only the data the authenticated account/device is authorized to see.

Never trust a client-supplied user ID or device ID as proof of ownership. Device repair must verify the account password and locate the existing device by both authenticated owner and original device ID; it must update that existing row instead of creating a duplicate, preserving device state and history.

## Change and release process

1. Create an isolated feature branch.
2. Take/verify a backup or Neon branch before schema work.
3. Add a numbered migration under `migrations/postgres/`; do not modify an already-applied migration.
4. Run syntax checks and automated tests; add migration/route regression tests.
5. Apply migrations and run end-to-end tests on a non-production Neon branch.
6. Review data preservation, authorization, session/cookie behavior, and rollback/recovery steps.
7. Promote through a reviewed pull request; deploy only after explicit approval.

## Legacy SQLite

SQLite modules and old database files may be retained temporarily for source history and a carefully controlled one-time import. They must not be used by `npm start`, Render, normal development, or automated integration tests. Never auto-import or merge legacy data during server startup.
