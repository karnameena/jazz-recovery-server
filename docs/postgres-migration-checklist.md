# Jazz Recovery — SQLite → Neon PostgreSQL staged migration

**Status: feature branch only. No live database migration, Render deployment or Android Companion modification is authorized by this branch.**

## Source and safety guarantees

- Source branch: `render-backend` (unchanged and still SQLite).
- Implementation branch: `feature/neon-postgres-migration-20261012`.
- Frontend `karnameena/jazz-recovery` / `render-web` stays unchanged.
- Default startup remains SQLite, unless `JAZZ_DB_ENGINE=postgres` is set explicitly.
- The original SQLite file must remain in its private location with a separate, verified backup.
- **Never commit or upload any SQLite database, WAL/SHM, Neon URL, password, device bearer token, location, or private recovery photo to GitHub.**
- This repository is currently public and previously committed SQLite databases on the original `main` branch and in Git history. Privacy changes and historic exposure cleanup must be handled before live recovery usage. Treat potentially exposed device credentials as compromised, and coordinate rotation carefully with Android Companion updates.
- `render.yaml` here is a proposal for a **Free** Render backend; do not deploy it until the user separately approves production cutover. Existing paid-disk `render-backend` configuration is untouched.

## Architecture

React website (Render Static Site) → same-origin /api reverse rewrite → Node API (Render Free) → TLS Neon PostgreSQL.

Android Companion → existing HTTPS Node API routes using its existing individual Device ID + bearer credential. No website or Android changes are required for the database migration.

Neon is the managed PostgreSQL host, while PostgreSQL and the `pg` Node driver are open source. Free-tier limits, sleeping backends and database quotas mean this is **not high availability** for an emergency lost-device service.

## Review of implementation

- `src/entrypoint.mjs`: selects `sqlite` (default) or `postgres` only on explicit opt-in.
- `src/server.mjs` and `src/db/`: ORIGINAL SQLite paths remain untouched.
- `src/pg/server.mjs`: async PostgreSQL API variant retaining identical browser/device routes, JSON shapes, scrypt hashes, CORS and cookies.
- `src/pg/database.mjs`: connection pool, verified TLS for remote databases, transactions and migration runner. Non-TLS is permitted only for an explicitly configured loopback test database outside production.
- `src/pg/sessions.mjs`: server-side sessions in PostgreSQL; active sessions are not imported and owners must sign in again.
- `migrations/postgres/001_schema.sql`: PostgreSQL equivalents of all six SQLite user/device/command/audit tables, including Location Services readback fields.
- `src/scripts/import-sqlite-to-postgres.mjs`: private dry-run first importer; requires `--apply` **and** `JAZZ_CONFIRM_MIGRATION=YES` for actual writes; refuses nonempty PostgreSQL destinations. Reads SQLite using `readOnly: true`, preserves IDs and credential hashes, checks counts and integrity, expires any imported pending commands to avoid replay.
- `src/scripts/dispatch.mjs` and `src/scripts/pg-*.mjs`: existing `npm run create-owner`, `create-device`, `change-owner-password`, `rotate-device` work on the selected backend. Each device gets a distinct, randomly generated bearer token.
- `tests/postgres-migration.test.mjs`: disposable local PostgreSQL / synthetic SQLite import + owner login, device pairing, isolation, command queue/leasing and admin regression coverage. Requires explicit loopback `JAZZ_TEST_DATABASE_URL` and will not reset a remote database.

## Steps to perform later, only after separate go-live approval

1. Secure the GitHub repository and historic leaked credentials. Keep the existing mobile connected to its working backend while planning a credential rotation.
2. Provision a Neon Free PostgreSQL project in a suitable region, select TLS-enabled connection, and store the connection string privately. Never send it in chat or GitHub. Choose a separate staging/test database if testing outside CI.
3. Create a *consistent* offline source SQLite backup (e.g. use SQLite `VACUUM INTO` while source is open); keep it encrypted and outside the repository. Check `PRAGMA quick_check` and `PRAGMA foreign_key_check`.
4. Review whether the Neon destination contains any data. The importer refuses to overwrite nonempty destinations. Decide which SQLite snapshot is authoritative and freeze the current recovery backend during the final copy to prevent state divergence.
5. To inspect source contents **without a Neon connection**, run a dry run in your private local clone:
   ```powershell
   $env:JAZZ_SQLITE_SOURCE = "C:\\private\\backup\\lost-mode.db"
   npm run pg:import
   ```
6. Once separately authorized, and only on the correct private Neon project, configure `DATABASE_URL` *privately* and perform the controlled import. The command below is **for documentation, NOT to run during code review**:
   ```powershell
   $env:JAZZ_DB_ENGINE = "postgres"
   # Configure DATABASE_URL securely in the shell/environment; never commit it.
   $env:JAZZ_CONFIRM_MIGRATION = "YES"
   npm run pg:import -- --apply
   ```
   The importer verifies the source, preserves owner/device IDs and scrypt hashes, validates destination counts, and expires stale pending commands. Browser sessions are intentionally not copied.
7. Run end-to-end tests against staging first. Verify owner login, read-only/device-auth status, real device heartbeat, owner isolation, ring, location, photo, voice, retry, and result confirmation. Location Services ON/OFF still requires the Android device's explicit opt-in and enterprise device-owner authorization.
8. Only when authorized, change the Render Free backend to this reviewed branch, set `JAZZ_DB_ENGINE=postgres`, private `DATABASE_URL`, secure cookie settings and correct `LOST_MODE_PUBLIC_ORIGINS`. Deploy cautiously; the website and Companion API hostnames should not need changes.
9. Confirm real Companion connection and recovery actions, then rotate any exposed owner/device credentials one device at a time. Do not uninstall Companion without another recovery plan. Monitor data size because recovery photos are currently stored as text/base64 in the database.
10. Retain a verified rollback backup and explicit revert instructions. Switching to an empty SQLite database on Render Free is **not** a safe rollback; a rollback requires a previously working backend and authoritative database.

## Local CI verification

GitHub Actions builds with Node 24 and a disposable PostgreSQL 16 service:

```sh
npm install
node --test tests/location-services-readback.test.mjs
# Postgres test requires a disposable LOOPBACK test DB and
# the JAZZ_TEST_DATABASE_URL environment variable.
node --test tests/postgres-migration.test.mjs
```

Expected checks: original SQLite test passes; private SQLite fixture import and PostgreSQL owner/device/API tests pass. CI uses only synthetic identities and never accesses the real owner account.

## Security/availability limitations

- A GitHub `.gitignore` and clean feature branch do **not** remove private historical SQLite objects from previous public commits. Repository privacy and credential rotation need separate remediation.
- Do not expose `DATABASE_URL` in client-side `VITE_*` environment variables.
- Neon Free quotas and Render Free cold starts are not a zero-downtime emergency recovery guarantee.
- Original SQLite code remains available for local fallback. No real owner/device data is included in GitHub.
