# Jazz Lost Mode — dedicated Render backend

**Source:** copied from the `services/lost-mode-server` module of `karnameena/Jazz-AI-Assistant` at the Jazz icon/location feature branch. This repository contains **only the backend**. The React website lives separately in the main Jazz project (or in a separate website repository).

## Urgent security warning

This GitHub repository originally committed database files (`data/*.db`, `*.db-wal`, `*.db-shm`), including a large restored owner/device recovery database. They have been removed **from the tip of `render-backend`**, but **they remain in previous Git history and the original `main` branch**. `.gitignore` does NOT erase that history. Before deploying real recovery accounts:
1. Make the GitHub repository **private** under Settings → General → Danger Zone.
2. Remove the files from *all Git history* using a carefully reviewed history cleanup in a local clone (after creating an offline backup); note that old clones and public copies may still exist.
3. Rotate exposed device credentials and owner passwords and preserve the existing Android Companion pairing as part of a coordinated re-enrollment plan.
4. Never place SQLite files, credentials, photos, or location/history payloads in GitHub, a public URL, or Render environment variable values.

## Render hosting — `render-backend`

**Recommended: paid Render Web Service with a persistent disk.** This code stores users, device pairing hashes, sessions, command results, photos, and location state in SQLite. Free Render Web Services do not offer permanent local disk persistence and are not suitable for this persistent recovery database.

You can use the included `render.yaml` Render Blueprint (explicitly provisions a **paid Starter** service plus 1 GB disk; review costs before applying), or create a Web Service manually with:

| Render setting | Value |
|---|---|
| Repository | `karnameena/jazz-recovery-server` |
| Branch | `render-backend` |
| Service type | Web Service |
| Root directory | repository root, leave blank |
| Runtime | Node.js 24 |
| Build | `npm install --omit=dev` |
| Start | `npm start` (runs `node src/server.mjs`) |
| Health check | `/health` |
| Persistent disk mount | `/var/data` |
| SQLite file | `/var/data/lost-mode.db` |

Set the following environment variables on Render, replacing the website URL with your actual **website origin**, not the backend:

```env
NODE_ENV=production
LOST_MODE_DB_PATH=/var/data/lost-mode.db
LOST_MODE_PUBLIC_ORIGINS=https://YOUR-LOST-MODE-WEBSITE.onrender.com
LOST_MODE_COOKIE_SECURE=true
LOST_MODE_COOKIE_SAMESITE=None
LOST_MODE_TRUST_PROXY=true
```

Render provides `PORT`; don't hardcode it in the hosted backend. Do not set `NODE_ENV=production` on your local Windows testing environment unless configured accordingly.

## Owner and paired-device database

**Deploying source code does not migrate accounts.** The backend automatically applies SQL migrations on startup, but a new empty disk contains no user or paired device. Login will return `Invalid username or password` even when your credentials match the owner entry in your *local* database.

Local source known to contain one owner and one paired Android device:
`<your-original-project>/services/lost-mode-server/data/lost-mode.db`

Do not add this file to the repository. Do not invent a new device credential or reset the phone pairing. For hosted continuity, securely transfer a **consistent SQLite backup** (Node `VACUUM INTO`, with the source database active) from your trusted PC to the Render persistent disk using a private administrator-managed channel, verifying the file and `PRAGMA quick_check` before starting the hosted backend. This step depends on how you administer the Render disk and should be done only after GitHub exposure is remediated and replacement credentials are planned.

If an old Render instance already holds owner accounts or pairing records, back it up and decide which dataset is authoritative before any import; **do not overwrite an existing `/var/data/lost-mode.db`**.

## Website integration

This is the `/api` server, not the website build. Host `apps/lost-mode-web` as a Render Static Site separately. Use its `VITE_API_BASE_URL` at build time to point at the HTTPS backend, or configure a same-origin `/api/*` proxy/rewrite on the website. Make sure hosted session cookies work in your chosen deployment; cross-site browser cookie restrictions can break login even when the backend accepts credentials.

The Companion's Lost Mode Server URL must point at the backend HTTPS base URL (not the website URL); the existing device ID and token must match the server database. The dashboard's Location ON/OFF commands additionally require explicit local opt-in and device-owner provisioned Android permissions, not merely installing a new APK.

## Checks

```sh
npm install --omit=dev
node --check src/server.mjs
node --test tests/location-services-readback.test.mjs
npm start
# GET http://localhost:8890/health (unless PORT is set)
```

When developing locally, use a separate test database and `LOST_MODE_PUBLIC_ORIGINS=http://localhost:5190`. Never commit that database. See Render environment configuration and logs if the website gets 401, 404 or 429 responses.

The branch is intentionally separate from the source monorepo. The original repository and `main` branch have not been modified by these deployment-branch changes.
