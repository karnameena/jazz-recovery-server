# Jazz Recovery API — Neon PostgreSQL only

This repository contains the Jazz Recovery backend API. The website and Android app call this API over HTTPS. **Neon PostgreSQL is the only supported runtime database.** The website and Android app must never connect directly to Neon or contain database credentials.

## Architecture

```text
Jazz Recovery website ─┐
                       ├── HTTPS ──> Render API ── TLS ──> Neon PostgreSQL
Jazz Recovery Android ─┘
```

- **Website and Android:** UI only; send authenticated API requests.
- **Render API:** validates credentials, enforces account/device ownership, issues sessions, manages recovery commands, and writes audit records.
- **Neon PostgreSQL:** source of truth for users, sessions, paired devices, device state, recovery commands/audit history, and future subscription records.
- **Migrations:** versioned PostgreSQL SQL files in `migrations/postgres/`; run with `npm run migrate`. The API also applies pending migrations during startup.
- **Local development:** use a dedicated Neon development/test branch and a private `DATABASE_URL`. Do not use production for development or tests.

## Required server configuration

Set these variables in Render's private environment settings (never commit values):

| Variable | Required value |
|---|---|
| `JAZZ_DB_ENGINE` | `postgres` |
| `DATABASE_URL` | Neon PostgreSQL connection string for the intended branch |
| `NODE_ENV` | `production` |
| `LOST_MODE_PUBLIC_ORIGINS` | Exact HTTPS website origin(s), comma-separated if needed |
| `LOST_MODE_COOKIE_SECURE` | `true` |
| `LOST_MODE_COOKIE_SAMESITE` | `None` when website/API are cross-site and cookie configuration requires it |
| `LOST_MODE_TRUST_PROXY` | `true` on Render |

Render provides `PORT`. Use `npm start`; it launches `src/entrypoint.mjs`, which fails closed unless PostgreSQL is explicitly configured and `DATABASE_URL` is present. It does not fall back to a local database.

## Standard commands

```sh
npm install
npm run check
npm test
npm run migrate
npm start
```

Use Node.js 22.5+ (Node 24 is recommended for the hosted service).

## Data safety and releases

- Never reset, truncate, or replace the production database as part of an application deployment.
- Never create a new owner or re-pair a device as a workaround for a schema or login error.
- Back up the intended Neon branch before production schema changes; validate migrations on a separate Neon test branch first.
- Keep production and test `DATABASE_URL` values separate. Do not print them in logs or paste them into chat.
- Preserve user IDs, device IDs, credential hashes, device state, recovery commands, and audit history during migrations and repairs.
- Keep migration SQL additive and backward-compatible where possible; destructive migrations require explicit review and a verified recovery plan.
- SQLite source files remain only as legacy migration/forensic material. They are not a supported server runtime. The one-time import command is named `npm run import:legacy-sqlite`; do not run it against production without a reviewed mapping, backup, and duplicate-handling plan.

## Security note about historical Git data

Earlier versions of this repository included database files in Git history. Removing them from the latest commit does not remove old Git objects, forks, or clones. Keep the repository private, review historical exposure, and rotate any credentials that may have been exposed through an approved continuity plan. Never commit database files, secrets, photos, location payloads, or exported recovery records.

## Health check

The API health endpoint is `/health`. Confirm health, database connectivity, authentication, website login/session cookies, Android device authentication, recovery commands, and audit writes in the test environment before promoting a release.
