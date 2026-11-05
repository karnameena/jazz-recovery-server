# Jazz Recovery Server — FCM / Cloudflare Workers / D1 branch

- Branch created: `feature/fcm-lost-mode-cloudflare-workers-d1-20261105-0000`
- Created: 2026-11-05 00:00 Asia/Kolkata (timestamp encoded in branch name; rounded branch label)
- Source package: `JazzRecovery-FCM-LostMode-Final-Source-04-1-26-19-26-PM.zip`
- Baseline: existing `main`; this branch adds supplied server project files under `server/`.

## What is added

- Cloudflare Worker implementation, split modules for FCM, D1, Android routes, auth, helpers and admin routes.
- D1 migrations, including initial schema and device push-token storage.
- Cloudflare Wrangler configuration, Worker tests, security tests, FCM tests and integration tests.
- Existing Node/PostgreSQL server materials and migration/test assets from the ZIP, retained as source history/reference rather than silently converted or executed.

## Current target architecture

- Cloudflare Workers for API endpoints.
- Cloudflare D1 binding `DB` for the D1-backed auth/device metadata and push-token table as defined by the supplied schema.
- FCM HTTP v1 sender reads the Worker secret `FCM_SERVICE_ACCOUNT_JSON`; no service-account JSON is included in this branch.
- Android command is queued first; FCM data-only `command_wakeup` is a wake-up hint. Android retrieves and acknowledges the authenticated command.

## Lost Mode / background behavior

The source handoff says background-safe polling is restricted to `set_recovery_mode`; other camera/location/ring operations remain on their existing foreground recovery workflow. This is intentional protection against a background worker consuming foreground-only commands.

## Deployment status and safeguards

The supplied remote D1 report records a successful read-only catalog query against `jazz-recovery-main`, but warns that this Worker package is a partial migration with missing route coverage / owner bootstrap prerequisites. It explicitly says not to deploy as a production replacement until route coverage, bootstrap, secrets and end-to-end Android checks are reviewed. It also says staging migration history must be inspected before applying migrations because the push-token table may already exist.

This branch upload did not deploy a Worker, change a Cloudflare secret, execute a D1 migration, alter Pages routing, or write to remote D1. Treat `wrangler.toml` values as source configuration to verify before any deploy.

## Previous vs current

The server repository's main branch was a smaller PostgreSQL-oriented server subset. This branch adds the supplied Cloudflare Worker / D1 / FCM package alongside that baseline; it does not delete or replace the existing PostgreSQL code. D1 is the active target for the new Worker package, while the prior PostgreSQL assets remain for traceability until an explicit migration/removal decision.
