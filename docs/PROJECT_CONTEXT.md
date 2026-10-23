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
