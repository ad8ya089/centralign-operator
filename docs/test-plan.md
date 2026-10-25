# Test and acceptance plan

## Phase 1 commands

Use Node 24.x and the single root npm workspace. From the repository root run these in order:

```text
npm install
npm run typecheck
npm test
npm run build
npm run verify
npm run db:migrate
npm run dev
```

`verify` repeats typecheck, tests, and production builds with fail-fast chaining. Record real failures, fixes, and final results; do not mark Phase 1 complete from file existence alone.

Automated tests use unique OS temporary SQLite files and close connections before cleanup. They never open the normal `.data` database. The migration CLI and manual application smoke test intentionally exercise the configured development database.

| Suite | Acceptance coverage |
| --- | --- |
| Shared contracts | Accepted/rejected run/step transitions, terminal protection, no mutation after rejection, version/attempt updates, irreversible approval rules, JSON validation, UTC health/error schema consistency, portable paths, explicit memory review attribution |
| SQLite integration | Expected tables/ledger, repeat migrations, FK/same-run references, step-index/idempotency uniqueness, valid states and JSON shapes, append-only update/delete/replace protections, migration checksum drift, transactional rollback, isolation/closure |
| Configuration | Safe defaults, invalid variables, repository discovery from src/dist, relative/absolute database resolution, root .env without process mutation |
| Fastify injection | Real healthy query, closed database → 503 degraded, canonical schema, structured 404, no execution endpoint, connection closes with app |
| Frontend API client | Healthy/degraded validation, inconsistent/malformed response rejection, HTTP/network errors, a fresh request on retry |
| Type/build | Strict checking of all workspaces and tests/configuration; shared built first; Vite web output and compiled backend |

## Development smoke acceptance

1. Launch root `npm run dev`; observe all three development processes.
2. Request `/api/v1/health` directly on port 3001 and through Vite on 5173; both must report an actual SQLite check.
3. Open the dashboard: check the product name, Phase 1 boundary, healthy state, and Retry check. Exercise a disconnected backend and retry when feasible; API-client tests cover network and malformed responses and HTTP tests cover degraded behavior.
4. Stop the root development command; verify the children and listening ports stop. Check compiled backend startup from a different working directory to validate root-aware paths.

## Observed Phase 1 results — 2026-10-25

Validation used an existing bundled **Node 24.19.0** runtime and **npm 10.9.2**, without a global installation or changing the project target. The host's default Node was 22.13.1. On this host the system npm PowerShell launcher selects its adjacent Node 22 even after a PATH change; invoking the npm CLI explicitly through Node 24 resolved the engine mismatch. Ordinary setup commands assume Node 24 is selected for both node and npm.

| Actual command/check | Observed result |
| --- | --- |
| `npm install` | Passed under Node 24; 129 audited packages, zero reported vulnerabilities. An initial invocation through the system launcher failed with EBADENGINE under Node 22; corrected as above. |
| `npm ls --depth=0` | Valid three-workspace dependency tree; only one repository package-lock.json outside node_modules |
| `npm run typecheck` | Passed. First pass found shared test snapshots using structuredClone without that global's type declaration; snapshots were corrected and the complete command rerun successfully. |
| `npm test` | 5 test files, 71 tests passed |
| HTTP tests after logging fix | 4 tests passed without warnings. Initial full tests passed but emitted FSTDEP023; replaced deprecated top-level disableRequestLogging with Fastify LogController before final verify. |
| `npm run build` | Shared, server, and Vite production web build passed |
| `npm run verify` | Passed typecheck, all 71 tests, and all production builds with no deprecation warnings |
| `npm run db:migrate` | Applied and reported migration 1 (foundation) in the configured development database |
| Root `npm run dev` | Shared watcher reported zero errors; server listened at 127.0.0.1:3001; Vite at 127.0.0.1:5173 |
| Direct and Vite-proxied health | Both HTTP 200, status healthy, database connected, UTC timestamps |
| Browser interaction | Healthy state observed; Retry check updated the timestamp. With only Vite running, real connection refusal produced Request error and Unconfirmed dependencies. Starting the compiled backend and retrying restored healthy/connected. |
| Compiled server from `C:\\` | Started successfully, queried the existing repository database, and recovered the dashboard; no dependency on shell cwd |
| Shutdown | Ctrl+C stopped root development and both follow-up smoke processes; compiled server logged Shutting down. Both ports had zero remaining listeners. Interactive PTY interruption returned exit code 1, expected for manual cancellation. |

Screenshots of the real healthy and offline states were saved under ignored `.local/smoke/` during validation. Generated builds and runtime databases remain ignored. No automated test used the development database.

Limits: degraded HTTP 503 is exercised by closing a real test SQLite connection, and the frontend client validates that response in tests; no production failure hook was added. The browser smoke exercised healthy, request-error, and retry recovery states. There is no dedicated React component or browser test dependency/suite, and no business workflow, external integration, authentication, production hosting, or production durability validation.

## Later-phase suites — pending, not implemented

| Suite | Required scenarios |
| --- | --- |
| Context/tool | Source references, conflicting entities, missing prerequisites, invalid tool arguments/results, permission denial, idempotency collisions, reconciliation |
| Runtime/recovery | Crash after intent persistence, crash after external write, restart from ledger, action/deadline bounds, retry exhaustion, concurrent workers/version conflicts |
| Approval | Bypass attempts, replayed/rejected/expired decisions, changed material arguments, durable action binding, decision identity, restart while waiting |
| Browser | Only if introduced: constrained navigation, selectors, ambiguous click/write outcome, observed postconditions, isolated test accounts |
| Fault injection | Ambiguous write outcomes must not cause duplicate actions; network/SQLite contention; partial tool effects; failed verification followed by bounded repair |
| Security | Malicious source content cannot override permissions; path traversal/symlinks; secret leakage; authorization boundaries; provisional memory cannot become approved policy silently |
| End-to-end | Acme onboarding artifacts cite sources; missing security questionnaire blocks activation; outbound email requires exact-action approval; incomplete work ends PARTIAL/FAILED with evidence; failed final verification prevents COMPLETED |

Passing health tests is not evidence that any business workflow, recovery mechanism, approval gate, or independent verifier works. Each later feature must add tests and update this document.
