# Jazz Recovery — production engineering standards

## Product target

Build a secure, reliable recovery product that can support an initial target of 10,000 registered users without avoidable hangs, UI stalls, API timeouts, or database contention. A user count alone does not prove capacity: validate expected concurrent active devices, command polling frequency, location update frequency, photo size/rate, dashboard refreshes, and peak bursts with load tests.

## Mandatory architecture

- Neon PostgreSQL is the only supported runtime database for local development, tests, staging, and production. Use separate Neon branches/credentials per environment; never silently fall back to SQLite.
- Website and Android communicate only with the Jazz Recovery HTTPS API. Clients never receive `DATABASE_URL` or connect directly to PostgreSQL.
- Keep account identity, sessions, device ownership/credential hashes, device state, recovery commands, audit events, and subscription state authoritative in PostgreSQL.
- Keep credentials and connection strings in private environment/secret settings. Never log passwords, session tokens, device tokens, IMEI, precise location, photo payloads, or database URLs.
- Preserve existing product behavior and data. Do not reset or truncate production, replace the owner account, silently re-pair a device, or remove existing recovery workflows to make a test pass.

## Performance and scalability rules

1. **Measure before tuning.** Establish representative baselines for API p50/p95/p99 latency, HTTP error rate, PostgreSQL query latency, connection wait time, CPU, memory, and queue depth.
2. **Pool connections deliberately.** Use a bounded PostgreSQL pool; size it against Neon compute limits and all application instances, not per-instance intuition alone. Avoid opening a connection per request. Monitor pool wait/timeout errors.
3. **Use indexes based on real query plans.** Verify indexes for owner-scoped device lists, device credential lookups, pending command polling, command lease expiry, session expiry, and time-ordered audit queries. Use `EXPLAIN (ANALYZE, BUFFERS)` on staging with representative data before adding indexes.
4. **Bound every request.** Enforce JSON/body size limits, query limits, pagination, per-device pending-command caps, timeouts, rate limits, and bounded retries with jitter. Never retry non-idempotent writes blindly.
5. **Avoid polling storms.** Use a measured backoff/jitter strategy for Android heartbeats and pending-command polling. Do not have every device poll at the same fixed interval. Tune intervals only after checking battery impact, recovery-command delivery requirements, and load-test results.
6. **Keep photos out of hot query paths.** Do not return large photo payloads in routine device-list/dashboard responses. For an approved future change, store photo binaries in object storage and retain authorized metadata/reference in PostgreSQL; preserve existing photo retrieval behavior until a migration is tested.
7. **Keep transactions short.** Do not perform network requests, image work, or long CPU work inside a database transaction. Use row locks only for the specific rows needed and define transaction boundaries explicitly.
8. **Use efficient dashboard APIs.** Avoid N+1 queries; fetch device state in bounded batches, paginate audit/history, and select only needed columns. Keep response shapes backward compatible for website and Android.
9. **Cache carefully.** Cache only data whose staleness is safe, with explicit TTL/invalidation. Never let credential caches undermine token rotation or device-repair revocation.
10. **Scale from measurements.** Confirm Neon compute/storage/connection limits for the chosen plan. Test 10,000 registered records and realistic concurrent traffic; registered-user count is not the same as concurrent load. Scale compute only when measured CPU, latency, connection pressure, or I/O demonstrates need.

## Initial service objectives (test targets, not guarantees)

- Normal authenticated API read requests: p95 under 300 ms in a representative staging load test, excluding external network latency and large media transfer.
- Recovery-command enqueue/read path: p95 under 500 ms in staging under the agreed peak workload.
- No unexplained request hangs; explicit request/DB timeouts and bounded retries.
- No data loss or cross-account/device access during concurrency and failure tests.
- For each load test, record workload model, concurrent users/devices, request mix, database branch/compute, results, bottlenecks, and follow-up actions. Revise targets based on real device/network conditions and product requirements.

These are engineering acceptance targets to measure, not a claim that current infrastructure already meets them.

## Security and correctness gates

- Authenticate each request and authorize every resource using the authenticated account/device; a client-provided ID is never proof of ownership.
- Use parameterized SQL, secure password hashing, hashed session/device secrets, TLS, secure cookie configuration, rate limits, and generic login errors.
- Validate ownership on every device command and prevent IDOR/cross-user data access.
- Device repair must verify account credentials and update the existing owner/device row transactionally; preserve its device state, command history, and audit history.
- Location, camera, and other sensitive controls must be visible, consent-based, and constrained by Android permission/platform rules. Do not promise that a web command can bypass Android system permissions.
- Verify Razorpay payments server-side using trusted signatures/webhooks before granting entitlements; never trust client-reported payment success.
- Avoid storing card/payment secrets. Minimize retention and access to location, photos, IMEI, and audit data.

## Required test and release workflow

1. Inspect branch, working tree, and latest commits before changing files. Never discard unknown user changes.
2. Make a small isolated feature branch and record its purpose.
3. Back up/branch the relevant Neon environment before schema work. Never test schema changes on production first.
4. Add a new numbered PostgreSQL migration; never rewrite a migration that may already have run.
5. Add unit, migration, authorization, API contract, and regression tests for affected behavior.
6. Run syntax checks and the full test suite; test against a non-production Neon branch.
7. Test website login/session cookies, registration, device pairing/repair, Android auth, location controls, command lifecycle, photos, audit history, and billing flows that the change touches.
8. Run realistic load tests with representative payloads and concurrent devices; inspect PostgreSQL query plans and pool saturation.
9. Review security, compatibility, data preservation, monitoring, rollback/recovery, and migration idempotency.
10. Keep pull requests draft until validation is actually run and results recorded. Never deploy or merge a risky production change without explicit user approval.

## Observability and incident readiness

- Add structured, privacy-safe logs with request/correlation IDs and route/status/duration; redact secrets and sensitive payloads.
- Monitor API p50/p95/p99, 4xx/5xx/429 rates, DB pool wait, query latency, connection failures, Neon compute/storage, pending-command age, device heartbeat freshness, and background-job failures.
- Provide health/readiness checks that distinguish process health from database readiness without leaking connection details.
- Define backup/restore checks and periodically rehearse recovery on a separate branch. A backup is not proven until restore is tested.
- Use graceful shutdown to stop accepting requests, finish bounded work, and close the PostgreSQL pool.

## Definition of done

A change is not complete merely because it compiles. It must preserve existing workflows, pass tests, be validated against a non-production Neon branch, include evidence for relevant performance/security checks, and have a safe deployment/recovery plan.
