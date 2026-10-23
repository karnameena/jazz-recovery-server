# Jazz Recovery — project continuity record

This file is a handoff index for future sessions. It is not a replacement for Git history, pull-request reviews, Neon branch inspection, or local working-tree checks. Refresh it after meaningful milestones; always verify live state before acting.

## Durable project decisions

- Product goal: secure, reliable Jazz Recovery with a Phase 1 target of 10,000 registered users and low-latency, non-hanging workflows.
- Database standard: Neon PostgreSQL is the only supported runtime database in every environment. No automatic SQLite fallback.
- Architecture: website + Android -> HTTPS Jazz Recovery API on Render -> Neon PostgreSQL. Clients must never connect directly to Neon.
- Preserve the existing owner account, paired device, device state, recovery commands, audit history, and all established recovery workflows.
- Do not reset/truncate production, overwrite production data, import legacy data into production, or deploy/merge untested changes without explicit approval.
- Development workflow preference: VS Code and PowerShell; do not require Android Studio.
- Prefer small isolated branches, additive PostgreSQL migrations, backup-first changes, automated tests, non-production Neon validation, and explicit evidence before promotion.
- Proactively assess performance, security, authorization, reliability, accessibility, compatibility, observability, and failure handling—not only the narrow requested feature.
- See `docs/engineering-standards.md` for required scalability, security, testing, and release gates.

## Server repository

- Repository: https://github.com/karnameena/jazz-recovery-server
- Feature branch created for PostgreSQL-only runtime organization: `feature/neon-only-runtime-20261023`
- Base branch: `fix/recovery-device-repair-neon-20261023`
- Base commit at branch/PR creation: `55e78ad06001516bff0e40ebf9c8ae2600012040` (device repair IMEI validation fix)
- Draft PR: https://github.com/karnameena/jazz-recovery-server/pull/11
- PR #11 title: `[DRAFT] Standardize Jazz Recovery on Neon PostgreSQL`
- PR head at PR creation (before continuity docs were added): `10a4456308dd7a8f643c03d94bd910a5767fe16e`
- The branch has additional commits after that recorded head because this continuity record and engineering standards are being added. Check the PR page or run `git log -5 --oneline` to identify the latest commit before any next change.
- PR is draft/unmerged as of the last recorded check. Do not assume its state has not changed.

## Changes included in the PostgreSQL-only organization work

- API entrypoint requires PostgreSQL and private `DATABASE_URL`; SQLite mode fails closed.
- `npm run migrate` points to PostgreSQL migrations.
- Legacy SQLite import has an explicit `import:legacy-sqlite` script name; it must never run automatically or against production without a separately approved migration plan.
- Administrative command dispatch defaults to PostgreSQL and rejects SQLite mode.
- README documents architecture, environment configuration, and release/data-safety policy.
- Regression tests were added for preventing SQLite fallback; they still require execution.
- No production Neon data was modified and no Render deployment was triggered during these changes.

## Known verification status

- The GitHub edits above were committed to the isolated feature branch.
- Do not describe checks as passing until `npm run check` and `npm test` have actually run and their results are recorded.
- Still required: validate API startup and migrations against a non-production Neon branch; website session/cookie behavior; Android device authentication; registration and device repair; location/recovery commands; photos and audit history; and representative concurrency/load tests.
- The production Neon database has been inspected previously and contains real owner/device/recovery records. Treat it as protected production data.
- Prior local Windows server repo: `C:\Users\gunak\Downloads\jazz-recovery-server`.
- Prior Android repo: `C:\Users\gunak\Downloads\jazz-recovery\android`.
- The local server worktree previously contained user changes and untracked debug/backup/migration files. Inspect `git status --short` before operating; do not clean/reset/rebase away unknown changes.
- Local `src/server.mjs` is the legacy SQLite server and is not the PostgreSQL runtime. The local command `node src/server.mjs` bypasses the new entrypoint. Use the documented Neon-only `npm start` after configuring a non-production Neon URL.

## How to resume in a new chat

1. Read this file and `docs/engineering-standards.md`.
2. Check the live PR #11 status and current head SHA.
3. Inspect local `git status --short`, current branch, and recent commits before editing anything.
4. Confirm the intended Neon branch/environment without printing or sharing connection strings.
5. Ask for approval before production data changes, production schema operations, merge, or deployment.
6. Update this continuity file after a meaningful branch/commit/PR milestone with the new verified commit and validation results.

## 2026-10-23 Android re-pair investigation checkpoint

- Android draft PR: https://github.com/karnameena/jazz-recovery/pull/16
- Android feature branch: `feature/neon-device-repair-ui-20261023`
- Android initial commit: `e1509d1681e3f1d3d12ebfc38dca8ae9369df996`
- Android latest checkpoint commit: `9ecee0ce5536f98aead0cbea380dc1a5d91e228a`
- Server draft PR #11 remains required: https://github.com/karnameena/jazz-recovery-server/pull/11
- Confirmed mismatch: the Android app's current `MainActivity.kt` has server URL, health check, manually entered device credential, and heartbeat, but it does not call `POST /api/auth/device-repair` or collect the website account credentials and existing website device ID.
- The server feature branch contains `POST /api/auth/device-repair`. It verifies the website username/password, finds the existing device by both account ID and device ID, replaces only the device credential hash and optional device metadata in a transaction, and leaves the device ID/history/state/commands/audit records intact.
- Server branch has PostgreSQL migration `migrations/postgres/002_device_imei.sql` because the existing production schema did not have an `imei` column. The migration must be applied through the reviewed Neon migration flow, never by ad hoc production SQL.
- Android PR adds a re-pair form, generates a 256-bit URL-safe device token, posts the same API payload, and only after a confirmed successful response saves the token encrypted via Android Keystore and updates the app's local device ID.
- Server CI checks for commit `2e55ee019ba086eee22ed267c904e227a4e7aae8` reported success (server checks and PostgreSQL migration verification). Android PR has no workflow runs, so Kotlin compilation and physical-device end-to-end testing remain outstanding.
- Both PRs are drafts/unmerged. Do not deploy the Android change until the matching server endpoint and migration are deployed to a non-production Neon branch and end-to-end tested. Verify Render's start command is `npm start` (Neon-only `src/entrypoint.mjs`) and its private `JAZZ_DB_ENGINE=postgres` and `DATABASE_URL` point at the intended Neon branch.
- Test plan: (1) confirm server health and Neon runtime identity; (2) authenticate existing website account; (3) re-pair using exact `devices.device_id` from the website and verify HTTP 200; (4) confirm database device ID, owner, state, commands, and audit history counts are preserved; (5) send Android heartbeat using the newly saved credential; (6) confirm website shows the device online; (7) verify wrong password, wrong owner/device ID, and invalid input fail without credential rotation.
- Never ask the user to paste passwords, DATABASE_URL, or device tokens into chat/logs. Do not print these secrets in diagnostics.


## 2026-10-23 follow-up: re-pair says username/password/device ID not found

- User reports the test re-pair APK's `/health` check succeeds but re-pair says the username/password/device ID is not found.
- Important: `/health` proves only that some server responds. It does NOT prove that the Neon-only entrypoint is running, that the repair route exists, or that the server uses the same Neon branch/database as the website.
- Historical context: local `node src/server.mjs` on port 8890 is the legacy SQLite server; previous tests confirmed `POST /api/auth/device-repair` was 404 on that process. Use `npm start` (the Neon-only `src/entrypoint.mjs`) only with a non-production Neon URL while testing.
- Website dashboard source `src/main.tsx` renders the registered device identifier from `device.deviceId` (the API's `devices.device_id` text value), not the numeric database primary key `device.id`. Re-pair must use that exact displayed string.
- Android UX bug found and corrected on Android PR #16: the re-pair field was prefilled with the fresh install's temporary ID. It is now blank by default and explicitly warns that the temporary installation ID may differ from the registered website device ID. Latest Android PR commit: `9ecee0ce5536f98aead0cbea380dc1a5d91e228a`.
- This UX correction alone does not establish that the currently installed APK includes it; a new APK build/install is needed. It also does not solve a server that lacks the route or is pointed at a different database.
- Safe triage order: (1) inspect Render start command and environment names without printing secrets; (2) POST an empty JSON object to `/api/auth/device-repair` to check route existence without changing credentials (expected route validation 400; missing route commonly 404); (3) use the website API base URL and verify `POST /api/auth/login` plus authenticated `GET /api/devices` see the existing device; (4) compare the exact `device.deviceId` string; (5) only then attempt re-pair on a non-production Neon branch. Never log or share password, `DATABASE_URL`, or device token.
- If the API returns 401, investigate username/password mismatch or wrong database. If it returns 404 with the server's explicit "That existing device ID is not registered to this account" message, the endpoint authenticated the user but cannot find the exact device ID under that user in the database that API is connected to. If route-level 404/not-found occurs, verify deployed route and Render service/version.
