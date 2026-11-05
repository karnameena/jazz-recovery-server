# Jazz Recovery Cloudflare Worker

This is the Cloudflare Worker API source in the integrated working copy. It retains the existing authentication, device, recovery, and helper route dispatch, plus the approved root service landing page.

## Data and recovery transport
- D1 is the configured application database binding.
- Recovery photos and locations use short-lived D1 `recovery_result_relays` rows only as transport from Android to the authenticated browser.
- The browser stores verified photo bytes and full last-known location records in IndexedDB.
- Local Storage contains small location/photo display metadata and UI preferences only.
- No R2 bucket, binding, object API, or photo object storage is used.

The Worker limits an individual relayed photo to 1,200 KiB raw bytes. Larger photos are rejected. Confirm actual Android camera payload sizes before production; Android source was not changed.

## Safety and deployment
- `wrangler.toml` keeps the current D1 binding and placeholder database ID from the supplied source archive. Replace the placeholder only after the intended fresh D1 resource is verified and approved.
- No database migration or deployment was run as part of this patch.
- Configure secrets using Wrangler secret commands. Never commit secret values.
- Do not point production traffic at this Worker until live D1, authentication, recovery, and device end-to-end checks are complete.

## Local regression test
From `server/server`, run `npm run test:cloudflare`. It uses Node's built-in SQLite as a local D1-compatible test double. It is not a live Cloudflare D1 or production integration test.


## Phase 1 local review
- `wrangler.toml` is set to `remote = false`; local development uses a local D1 database.
- From `server/server`, apply migrations locally only:
  `npx wrangler d1 migrations apply jazz-recovery-main --local --config cloudflare/wrangler.toml`
- Start the Worker locally:
  `npm run dev`
- The local Worker is normally available at `http://127.0.0.1:8787`.
- In the website terminal, set `LOST_MODE_API_URL=http://127.0.0.1:8787` before `npm run dev` so Vite proxies API calls to the local Worker.
- Never remove `--local` from the migration command during local review. Do not run `wrangler deploy` until the owner explicitly approves deployment.
- `APP_TIME_ZONE_OFFSET_MINUTES=330` treats timezone-free `datetime-local` admin inputs as India Standard Time and stores UTC in D1. Explicit ISO timestamps containing `Z` or an offset are preserved as absolute instants.
