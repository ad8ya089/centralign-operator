# Test and acceptance plan

## Stage A investigation — 2026-10-25

The reported failure was reproduced exactly with the default Node 22.13.1: 58 passing tests and two native worker crashes with exit 3221225477 (0xC0000005). Each affected database/health file also crashed alone with maxWorkers=1 and fileParallelism disabled. This excludes file concurrency as the cause of this reproduction.

The standalone `node scripts/sqlite-smoke.mjs` imported better-sqlite3 but crashed at opening an in-memory database, before any migrations, Fastify lifecycle, or teardown. It exited -1073741819, the signed form of the same access violation. No application database was used.

Confirmed incompatibility: installed better-sqlite3 13.0.3 declares `NAPI_VERSION=10` in its binding.gyp. Node 22.13.1 reports Node-API 9 (module ABI 127); the existing Node 24.19.0 reports Node-API 10 (module ABI 137). The same installed binary and same path with spaces succeeded under Node 24: SQLite 3.53.4, a temporary-table roundtrip, FTS5 enabled, and clean close. This package uses Node-API, so the Node-API version is the relevant compatibility evidence, not merely the differing module ABI. No reinstall, native rebuild, dependency upgrade, project move, or pool change was justified.

The fix keeps Node 24 as the target, guards root commands and direct Vitest config loading, and rejects unsupported server runtimes before opening native SQLite. Tests remain on normal parallel forks; no errors are ignored. Under Node 24, the former crashing files passed individually (9 database tests and 4 HTTP tests), the post-fix normal full suite passed (72 tests including a new runtime guard test), and typecheck, build, and full verify each exited 0. Under Node 22 the guarded verify command now exits 1 with an explicit runtime error before any tests/native load. **Stage A exit gate passed before Phase 2 implementation.**

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

## Phase 2 suites and reproduction

Use Node 24.x for all commands. The tested dependencies remain Vitest 5.0.5 and better-sqlite3 13.0.3; Playwright 1.64.1 is the only new application dependency. Install its matching Chromium once with `npx --no-install playwright install chromium`. The browser integration tests are required, not silently skipped, and never use an external website. Browser installation was performed successfully in the OS cache using the package's official CLI.

```text
node scripts/sqlite-smoke.mjs
npx --no-install vitest run apps/server/tests/database.test.ts --maxWorkers=1 --no-file-parallelism
npx --no-install vitest run apps/server/tests/health.test.ts --maxWorkers=1 --no-file-parallelism
npm run tools:smoke
npm run typecheck
npm test
npm run build
npm run verify
npm run db:migrate
npm run db:seed
npm run db:seed
npm run dev
```

The standalone diagnostic intentionally can compare runtimes without a guard; run it under the selected Node 24 except when deliberately diagnosing the incompatible Node 22 crash. Direct Vitest also loads the runtime guard. Existing shell launchers that pin Node 22 must be bypassed by invoking the npm CLI through Node 24, as documented in README.

| Suite | Actual state/invariant tested |
| --- | --- |
| business-schema | Fresh/current schema, a real Phase 1 file upgraded with old data/checksum preserved, repeat migrations, customer/project/task/document/draft/outbox FKs, states, duplicate identifiers |
| context | Repeat seed, preservation of edited customer data, hashes/chunks/FTS refresh, malformed/missing source rollback, traversal/linked-source rejection, relevant and absent queries, limits/literal FTS terms, provenance, fallback search |
| tools | Metadata and duplicate/unknown tools, argument validation before handler, trusted scopes, active same-run context, result validation/rollback, read deadlines/cancellation, stable keys with canonical defaulted input, mismatched arguments/actors, stored result replay, no blind unknown-write retry, customer ambiguity, malicious text staying untrusted |
| concurrency | Three independent Node processes/connections simultaneously request the same write; exactly one commits and two replay the same result |
| artifacts | Actual bytes/hash/size/citations, exclusive scoped path, traversal/absolute/reserved path rejection, linked ancestor protection, stale source rejection, post-file/pre-database failure followed by existing-byte reconciliation |
| email | Real draft/read-back, pending/rejected/expired/cancelled/missing approvals denied, exact recipient/subject/body/draft/type match, body changes invalidating approval, attribution/time validation, common policy before handler, duplicate prevention, sandbox read-back, outbox transaction fault leaves draft intact, no network delivery |
| browser | Real pinned Chromium: allowed navigation, text/headings/links, denied scheme/origin/credentials, default deny, redirect target blocked before network access, same-origin redirect allowed, scripts/subresources blocked, size/deadline bounds, owner isolation, registry/executor integration, clean repeated close |
| tool-workflow | Deterministic source lookup → project → task → source-backed artifact → draft → explicit trusted test approval → local outbox, independent read-back, activation status remains BLOCKED; no LLM or HTTP executor |

Initial Phase 2 checking found an unused import and an incorrectly typed timeout test promise; both were fixed. The first full new suite ran 118 tests: 117 passed and one workflow assertion incorrectly expected 10 success records rather than 9. That assertion was replaced with validation of the actual persisted send execution. No worker error was suppressed.

Final acceptance on 2026-10-25: npm run typecheck exited 0; the final npm run verify passed **124 tests across 13 files**, including all **six real Playwright/Chromium integration tests** and the three-process idempotency race, and completed all type checks/production builds with exit 0 and no worker errors. The earlier standalone npm test/build and verify runs passed 123 tests before a final review added a regression test and fixed repeated input normalization. The registry now prepares validated arguments once so the handler consumes exactly the input fingerprinted in the ledger; replay/reconciliation also checks deadlines. All 35 affected tool/artifact/email/workflow tests passed before the complete 124-test verification rerun. npm run tools:smoke passed its isolated end-to-end tool-layer test. This is a deterministic tool workflow, not an autonomous agent demonstration.

The explicit migration CLI applied version 2 to the existing development database and preserved version 1's original applied timestamp. First db:seed reported insertedCustomers=1/indexedDocuments=3; second reported 0/0. npm ls --depth=0 showed a valid dependency tree, and installation audited 131 packages with zero reported vulnerabilities. Migration 0001 and the original fictional fixture contents are unchanged. No .local content was read or modified in this task.

Root npm run dev launched the shared watcher (zero errors), Fastify on 3001, and Vite on 5173. Direct and proxied health both returned HTTP 200/healthy/connected; the web page returned 200 and the served component contained Phase 2 / 5. Ctrl+C stopped the launched processes; subsequent checks found zero listeners on both ports and no remaining project watch processes. The Windows PTY returned exit 1 for that deliberate interruption and printed batch termination prompts; no listener/process remained. Current frontend validation was typecheck/build/HTTP smoke, not an added React component or interactive UI test suite.

No normal database is opened by these suites or tools:smoke. The explicit db:migrate/db:seed and launch smoke commands exercise the configured development database. Seeding does not auto-run during app startup and does not overwrite existing customer edits.

Known limits: these are local business simulations, not external CRM/email integrations; SANDBOX_QUEUED does not mean delivery. No LLM/runtime, approval UI/identity service, independent business verifier, crash-recovery scheduler, browser clicks, arbitrary evaluation, or hostile OS filesystem race protection exists. Browser reads disable JavaScript and subresources deliberately. Files and SQLite cannot commit atomically; the covered file fault uses narrow existing-byte reconciliation. Success replay is not fresh independent artifact verification. Async reads cancel cooperatively; synchronous native calls finish/return before deadline rollback can be applied. No unconditional retry or ignored worker error is configured.

## Later-phase suites — remaining work

| Suite | Required scenarios |
| --- | --- |
| Context/tool extensions | Additional integrations, conflicting business sources, activation prerequisite policy and source/version lifecycle beyond the three local fixtures |
| Runtime/recovery | Crash after intent persistence, crash after external write, restart from ledger, action/deadline bounds, retry exhaustion, concurrent workers/version conflicts |
| Approval | Bypass attempts, replayed/rejected/expired decisions, changed material arguments, durable action binding, decision identity, restart while waiting |
| Browser interaction | If introduced later: explicit observed-target clicks, write outcomes, postconditions, and isolated integration accounts |
| Fault injection | Ambiguous write outcomes must not cause duplicate actions; network/SQLite contention; partial tool effects; failed verification followed by bounded repair |
| Security | Malicious source content cannot override permissions; path traversal/symlinks; secret leakage; authorization boundaries; provisional memory cannot become approved policy silently |
| End-to-end | Acme onboarding artifacts cite sources; missing security questionnaire blocks activation; outbound email requires exact-action approval; incomplete work ends PARTIAL/FAILED with evidence; failed final verification prevents COMPLETED |

Passing health tests is not evidence that any business workflow, recovery mechanism, approval gate, or independent verifier works. Each later feature must add tests and update this document.
