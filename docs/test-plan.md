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


## Phase 3 acceptance and reproduction

Phase 3 was implemented on the verified Phase 2 repository using Node 24.19.0 / npm 10.9.2. The initial baseline ran all 124 tests/13 files: 123 passed and the first Chromium cold-start test exceeded Vitest's outer five-second timeout. All six browser tests passed in isolation. Giving that multi-operation cold-start test a 15-second outer allowance produced a full baseline pass, with typecheck and all builds passing before runtime work proceeded. No worker crash or native binding failure occurred under Node 24.

The expanded parallel suite subsequently exposed the same first-browser-test timeout at 15 seconds (189/190 and later 192/193 other tests passed). Both isolated browser diagnostics and a Playwright-debug full parallel run passed. The positive fixture had a two-second total budget covering launch/context/navigation; it now uses the production five-second budget, while a dedicated negative fixture still enforces two-second navigation/content bounds. Review also fixed an already-fired abort signal being missed after Chromium startup/context creation. A further full regression passed 192/193 but timed out during the negative fixture's separate cold launch. This host reports 16 logical processors, about 16 GB RAM and only about 2 GB free at inspection. Concurrent file workers are now capped at four to bound native/SDK/Chromium resource pressure; file parallelism, the process pool, isolation and the explicit three-process race remain enabled. No test was skipped, pool switched, worker error ignored, or failing command treated as success. Temporary tracing was removed. The exact host scheduling delay was not independently measured.

| New suite | Actual checks |
| --- | --- |
| agent-model | Official SDK request format/store:false, unconfigured provider, 429/500/503 transient classification, 400/401 permanent errors, malformed/incomplete/oversized output, transport limit, cancellation, context/provenance/ID retention, redaction, conservative scopes and configuration bounds |
| agent-runtime | One schema repair, invalid repair exhaustion, plan coverage repair, unsupported tools/trust fields, scope/association rejection, completion without evidence, model/tool/deadline/replan limits, transient retries, noncooperative provider timeout, cancellation, single-flight and stale lease fencing, actual committed response loss, semantic duplicate suppression, classified read retries, safe error reporting, unknown-write cancellation/reconciliation |
| agent-api-recovery | Optional-key health/startup and no-row 503, strict/secret-bearing bodies, original request preservation, bounded cursor pagination, 404/400/no executor route, attributed approval/rejection/idempotency/conflicts, expiry and forged identity, approval restart with no new model activity, specific clarification after restart, committed effect reconstruction, cancellation while approval waits |
| agent-verifier | Missing/changed bytes, stored hash/MIME/owner/citation/source errors, changed project/task/draft, missing/changed outbox and mismatched approval, successful tool output without persisted effect, explicit activation prerequisite failure |
| agent-migration | Real version-2 schema upgraded with all old events/run/step/checksums preserved; event order, append-only triggers, explicit event types, foreign keys and repeat migration |
| agent-e2e | Actual HTTP API/runtime/tools with observation-driven fake: source discovery, resolved customer, project, two tasks, source-backed file bytes/hash, draft, zero outbox before exact approval, approved send, fresh verification and seven required outcomes; customer remains BLOCKED |

The test provider is explicitly injected and uses actual observed business IDs. Production selects OpenAIModelProvider and never silently falls back. These tests use temporary databases and loopback Chromium fixtures without a live model/network dependency. The provider tests exercise the real SDK through an injected fetch, not a mock SDK method. The three-process Phase 2 idempotency test and all six real Chromium tests remain included.

During test authoring, typecheck caught a JsonValue needing explicit JsonObject validation, and several new test calls used the service's string objective instead of its strict request object; the tests were corrected and rerun. The final gate below includes those corrections.

Actual commands and results:

- npm run typecheck: passed (shared/server/web, including tests).
- Focused agent-runtime + agent-api-recovery run: initially 30 tests passed; later additions are included in the final gate.
- Focused agent-model + agent-verifier run: 33 tests passed before later scope coverage.
- Isolated browser diagnostic: 6/6 passed.
- Instrumented full parallel diagnostic: 190/190 passed; a later diagnostic passed 193/193.
- **Final npm run verify: exit 0; 193 tests across 19 files, zero failures/skips/worker errors; strict checks and shared/server/web production builds passed.** The final configured parallel limit is four concurrent test files. Earlier uncapped diagnostics also passed, but exposed the resource-sensitive cold-start failures recorded above.
- npm run db:migrate: version 3 applied to the existing development database; original version-1 applied_at 2026-10-25T14:16:28.764Z and version-2 applied_at 2026-10-25T16:24:38.684Z preserved. Versions 0001/0002 have no source diff.
- npm run agent:demo: exit 0, isolated persisted deterministic demo described below.
- Root npm run dev: shared watcher reported zero errors; Fastify and Vite started on 3001/5173 using the isolated demo database. Direct/proxied health and web returned 200; proxied GET of the persisted run returned COMPLETED; real HTTP POST without a key returned 503 CONFIGURATION_ERROR. Ctrl+C logged server shutdown; ports 3001/5173 had no remaining listeners. The Windows PTY's deliberate interruption returned 1, not a test failure. The final production build includes the corrected Phase 3 status text; no Phase 4 UI was added.

## Persisted Phase 3 demo evidence

This is an explicitly labeled FakeModelProvider demonstration with real runtime, HTTP API and business tools. No live OpenAI request or external email occurred. Its human decision is an attributed test/demo fixture, not a claim that a person approved an actual delivery.

- Run: b02837da-4ed5-4d20-8b7c-3c26fcf7ce44.
- Approval: 83962fc9-25fa-483b-8172-0a6172aca962.
- State: WAITING_APPROVAL with zero outbox messages, then COMPLETED after exact approval and independent verification.
- Verified required IDs: account, sources, project, checklist, brief, draft, welcome.
- Project: project-exec-0810a8ac06d081d651df98c7294931a994f5f916b81a40ae470c5b1bfaf8dbb6.
- Tasks: task-exec-dec902aee59bc260e77a27b077f42d25942f885586cf4c75031aebe128059456 and task-exec-d574cb443752791a975f8ccacbfa17e883cadd618df38245f094215655186a8f.
- Draft: draft-exec-d384cf2fe7b8a820b13ce73ae1d82fd939f6d935b2debea12773a9ccb7b800b4.
- Sandbox outbox: outbox-exec-38317943cd602752ede7af73a1612c867e35a99170d726c078b798fb6affb386.
- Artifact: artifact-exec-d1b00bd5a518835baa3b7425472018eb7994e212939f5f0ee18beec16d2f4236; actual/stored SHA-256 both 3ee9328b59e5e8a6bbcfa3ad176468638bbf510361b74c0a3511f8859e94d003.
- 13 model calls, 118 persisted events, one project, two tasks and one sandbox message.
- Actual retained report: .data/demos/73a3026a-672e-4201-bb6c-139bd8c0e3f5/report.json; database: demo.sqlite in that directory; artifact bytes under its workspace/artifacts/runs subtree. All are ignored local evidence, deliberately separate from the normal database and .local.
- Warnings: questionnaire missing and activation BLOCKED; materials completion does not imply readiness. SANDBOX_QUEUED does not imply delivery.

## Phase 3 limits and Phase 4 handoff

No live OpenAI call was exercised: OPENAI_API_KEY was absent. Provider request/schema/error behavior is tested; actual model quality, cost and service availability remain unvalidated. Email stays local, decision attribution is a trusted fixed local identity rather than authentication, and files/SQLite are not an atomic distributed transaction. SQLite NORMAL and cooperative async cancellation retain the documented prototype limits. No .local content or original source fixtures were modified.

Phase 4 should consume shared RunSnapshotSchema (run, goal, plan/revision, steps/actions/milestones, pending decisions, verification/final result, artifacts/budgets) and RunEventsPageSchema. Preserve cursor after the final page for polling; use exact approval action previews and pending question IDs. Use the three POST decision/input/cancel endpoints, never a public tool executor. Artifact metadata is available; a byte-serving/exploration interface and authenticated user identity remain later work.

The earlier later-phase matrix above is historical: runtime/recovery, backend approval and deterministic backend E2E scenarios listed here are now implemented. Phase 4 UI and Phase 5 broader evaluation/hardening remain pending.
