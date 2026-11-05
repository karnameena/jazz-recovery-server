# Jazz Recovery — D1 migration implementation notes

## Working-copy safety
This directory is a separate working copy extracted from the supplied ZIPs. Original ZIP uploads are unchanged. No Cloudflare account, DNS, domain, production database, or production deployment has been touched.

## Fresh D1 schema
`migrations/cloudflare/0001_initial_d1.sql` creates 24 application tables plus the `billing_user_registry` view. It is SQLite/D1-oriented and creates an empty schema; it does not import PostgreSQL data.

### Table mapping
- Identity/authentication: `users`, `sessions`, `webauthn_credentials`, `webauthn_challenges`, `auth_recovery_attempts`, `auth_login_attempts`, `auth_device_attempts`
- Devices/recovery: `devices`, `device_state`, `recovery_commands`, `recovery_audit`, `recovery_result_relays`
- Bluetooth helper: `recovery_beacon_tokens`, `recovery_helper_encounters` (helper coordinates expire after 15 minutes)
- Billing/admin: `billing_trials`, `billing_trial_claims`, `billing_discount_codes`, `billing_subscriptions`, `billing_payments`, `billing_discount_redemptions`, `billing_webhook_events`, `billing_admins`, `billing_audit`, `billing_payment_intents`
- Read model: `billing_user_registry` view

`device_state` deliberately contains status/telemetry fields only. It does not contain coordinates, location history, photo data URLs, or photo blobs.

## Initial local validation
The migration was executed against Python's in-memory SQLite engine:
- SQL parse/execute: PASS
- 24 application tables created: PASS
- `billing_user_registry` view created: PASS
- This is not a Cloudflare D1 integration test.

## Worker scaffold and route coverage
`cloudflare/src/index.js` exposes `/health`, a subset of migrated auth/device/recovery routes, and deliberately returns HTTP 501 for routes not yet migrated. It is not a production API replacement. `wrangler.toml` contains a placeholder D1 database ID and must not be deployed.

## IndexedDB utility
`website/src/services/recovery-cache.ts` provides owner/device-keyed photo and location storage. It validates incoming values, only replaces records with equal/newer timestamps, and converts a previously-live location to `cached` when read from browser storage. It is not yet connected to the dashboard's API refresh path.

## Critical conversion blockers before any cutover
1. The current `src/pg/server.mjs` is a 59 KB Node HTTP application, not a Workers Fetch handler. It uses Node crypto, request/response objects, process environment, in-memory rate-limit maps and timers. A route-by-route Worker port is still required.
2. `src/pg/database.mjs` uses `pg`, `Pool`, `AsyncLocalStorage`, PostgreSQL advisory locks and `FOR UPDATE`. D1 requires a new asynchronous repository layer and conditional/lease-based concurrency controls; a mechanical SQL placeholder swap is unsafe.
3. `publicDevice()` reads `device_state.latitude`, `longitude`, `photo_data_url`, `photo_camera` and `photo_timestamp`. These fields are intentionally absent from the new D1 schema. The owner-browser relay protocol and UI hydration from IndexedDB must be completed before this endpoint can be migrated.
4. `billing.mjs` has PostgreSQL-specific query patterns and depends on the registry view. Each billing query must be rewritten and tested, not just the schema.
5. WebAuthn credentials use `BYTEA` and `TEXT[]` in PostgreSQL. D1 stores public-key bytes as BLOB and transports as JSON TEXT; serialization/deserialization and SimpleWebAuthn runtime compatibility must be verified.
6. The provided server archive includes `node_modules` and a non-empty `.env`. The working copy intentionally excludes node_modules and environment files. Treat any secrets in the original archive as exposed and rotate them before production.
7. The Android source is a supplied branch. Its server URL, request/response contract and feature parity need comparison against the deployed Android build before making any app changes.

## Cutover gate
Do not change the production API URL, Pages domain, Android API endpoint, DNS, Cloudflare resources, or PostgreSQL deployment until:
- every existing route has a D1 implementation,
- session/admin/device ownership and WebAuthn tests pass,
- the photo/location relay and IndexedDB UI integration pass,
- Android integration passes against a staging Worker,
- backup/restore and rollback are rehearsed.

## Android source qualification
The supplied Android README explicitly labels this archive as an independent "recovery-readiness feature branch" and says it does not modify the existing Android Companion production workflow. It also states that no real-device integration test has been completed. Its README says the Gradle wrapper is absent, while the supplied ZIP actually contains `gradlew`, `gradlew.bat`, and `gradle/wrapper/`; the README is therefore stale on that point. The source's default website/server URL strings are placeholders. No Android endpoint was changed.

## Static checks performed in this working copy
- All 31 original backend `.mjs` files passed `node --check`; the new Worker integration test also passed syntax checking.
- New Worker JavaScript passed `node --check`.
- D1 migration executed successfully in an isolated in-memory SQLite database.
- SQLite smoke checks passed for case-insensitive username uniqueness, foreign-key rejection, and BLE helper coordinate bounds.
- The backend source contains 104 `db.prepare(...)` call sites across the primary server, billing and helper-location modules, 10 transaction blocks, and 3 device row-lock calls. These require deliberate conversion; they are not yet ported.
- The React production build, browser IndexedDB tests, Cloudflare D1 integration tests, Android Gradle build, physical-device tests, and end-to-end regression tests have not been run.


## Implementation progress — 2026-10-31 continuation

### Implemented in the separate working copy
- D1 schema now includes the existing account, device, recovery, billing, passkey, auth-attempt, Bluetooth-helper, and temporary relay data structures.
- Added database-enforced pending-command limit, duplicate command coalescing guard, and opposite Location Services command guard.
- Added Worker Fetch entry point with exact-origin CORS checks, `/health`, and fail-closed handling for routes not yet migrated.
- Added D1-backed registration, login, logout, session lookup, device repair, recovery PIN update, PIN-based password reset, billing status, device list/detail, and explicit IMEI read routes.
- New passwords/PINs use Web Crypto PBKDF2-HMAC-SHA-256 hashes; high-entropy device tokens use SHA-256 digests. No old PostgreSQL hashes are imported.
- Added D1-backed Android device authentication, failed-device-auth throttling, heartbeat, command polling with conditional lease updates, command-result handling, recovery action queue, location-command result readback, device audit readback, and Bluetooth beacon/helper encounter routes.
- Added temporary result relay: location payloads live in a D1 relay row for at most 24 hours; photo bytes live in an R2 temporary object for at most 24 hours. The owner detail request returns the relay, the browser saves to IndexedDB, then explicitly ACKs; only then is the temporary cloud relay deleted. Bluetooth helper coordinates expire after 15 minutes. A scheduled cleanup deletes expired relay data in bounded batches.
- Integrated the existing React dashboard refresh path with IndexedDB hydration for last-known location and recovery photo. Cached location is never relabelled live; it is classified as cached/old.
- Existing UI layout/design has not been redesigned.

### Tests performed
- Worker and route JavaScript syntax checks: PASS.
- Modified React/TypeScript modules transpile syntax: PASS.
- D1 schema executed using isolated SQLite: PASS.
- Foreign-key rejection smoke test: PASS.
- Case-insensitive username uniqueness: PASS.
- Recovery command duplicate guard: PASS.
- Opposite Location Services command guard: PASS.
- Maximum pending command guard: PASS.
- WebCrypto PBKDF2 hash/verify and wrong-password rejection: PASS.
- Existing backend `.mjs` syntax checks: 31/31 PASS.

### Tests not completed
- Cloudflare D1 remote/local binding integration: NOT RUN (no Cloudflare resource created and Wrangler runtime not configured).
- Cloudflare R2 integration: NOT RUN.
- React production build: BLOCKED because the archived dependency tree is missing the platform-specific `@rollup/rollup-linux-x64-gnu` optional package; package installation did not complete in this environment.
- Full TypeScript typecheck: NOT RUN (the supplied archive lacks React type packages).
- Browser IndexedDB runtime tests: NOT RUN.
- Android Gradle build and physical-device tests: NOT RUN.
- Full end-to-end regression tests: NOT RUN.

### Routes still not migrated
- Passkey registration options/verification and passkey password-reset options/verification. The current server uses `@simplewebauthn/server` 13.2.2; its published docs describe Node/Deno environments, and Workers compatibility must be proven before use. Do not replace passkey verification with a mock or weaker verifier.
- Full billing checkout/discount/payment and all billing Admin CRUD/ledger/audit routes.
- Bluetooth helper-location API routes.
- Any backend route not explicitly listed as implemented must continue returning 501 in the new Worker; do not route production traffic to this incomplete Worker.

### Important deployment gates
- `TRIAL_CLAIM_PEPPER` must be set as a Worker secret before registration with trials can work.
- Recovery photo/location delivery uses a short-lived D1 relay only; browser IndexedDB is the durable store. No R2 binding or bucket is configured.
- `database_id` in wrangler.toml remains a placeholder.
- The fresh D1 database has no owner or Admin account. The old PostgreSQL account has not been imported, per the explicit fresh-empty-D1 instruction. A secure owner/Admin bootstrap and device pairing procedure must be designed and approved before staging.
- Workers Free currently has a 10 ms CPU limit per HTTP invocation. PBKDF2 authentication must be measured on the real Worker runtime; do not reduce password/PIN hashing strength just to force Free-tier compatibility. If the secure implementation exceeds the Free CPU limit, the zero-monthly-cost target conflicts with the security requirement and needs an explicit architecture/plan decision.


### Current Worker route coverage
Implemented: `/health`; `/api/auth/register`; `/api/auth/login`; `/api/auth/logout`; `/api/auth/session`; `/api/auth/device-repair`; `/api/auth/recovery-pin`; `/api/auth/forgot-password`; `/api/billing/status`; `/api/devices`; `/api/devices/:id`; `/api/devices/:id/imei`; `/api/devices/:id/actions`; `/api/devices/:id/commands/:commandId`; `/api/devices/:id/audit`; `/api/devices/:id/recovery-relay/ack`; `/api/devices/:id/helper-locations`; `/android/device/heartbeat`; `/android/device/commands/next`; `/android/device/commands/:commandId/result`; `/android/device/beacon`; `/android/helper/encounters`.

Not yet implemented: all passkey/WebAuthn endpoints; full billing checkout, discount, payment and Admin routes; Bluetooth helper-location routes; Admin user management and other PostgreSQL routes not in the implemented list.
