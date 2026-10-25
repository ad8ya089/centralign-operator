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

## Phase 4 acceptance — 2026-10-26

The checkout was clean at a04a1e6 before implementation. Node 24.19.0 and npm 10.9.2 were selected explicitly. The existing npm run verify baseline exited 0 with **193 tests across 19 files**, strict checking and all production builds before Phase 4 edits. Existing startup scripts were inspected; UI integration uses the same React/Vite workspace and Fastify construction on ephemeral loopback ports.

Phase 4 preserves all Phase 1–3 suites, the three-process idempotency race, six restricted-browser checks, immutable migrations and production OpenAI-only submission. No normal development database or .local files were opened/modified for this phase. No pool/configuration change, skipped test, ignored worker error, frontend fake fallback or external website/model dependency was introduced.

| New suite | Cases | Evidence |
| --- | --- | --- |
| run-read-api | 14 | Stable persisted run-list pages/cursor validation; attributed history and actual activation blocker; real file bytes/MIME/attachment/ETag/CSP/nosniff; missing/cross-run artifacts, path query/traversing metadata, absent/changed/oversized bytes, junctions/hard links, stale source references and unsupported MIME/hostile filename |
| runs-api (web) | 13 | Actual create/decision/input/cancel routes and bodies; complete response schemas; configuration refusal without fallback; network/cancellation/8s timeout; malformed JSON, missing IDs, invalid acknowledgements, 404/409/500/temporary-503 classifications; event/cursor encoding and future event names; artifact digest/attachment validation |
| run-monitor (web) | 6 | Ordered multi-page history, retained monotonic cursor, duplicate suppression, wrong-run/backward-cursor rejection, empty waiting polls, final terminal refresh/stop, transient backoff/reconnection, abort and suppression of late publication, readable future-event fallback |
| ui-browser | 9 | Actual React browser journeys described below, including keyboard tabs and desktop/mobile layout |

Actual commands and results:

- npm run verify before editing: exit 0, 193/19.
- npm run typecheck during implementation: passed after correcting browser-test DOM globals to use typed locator evaluation/globalThis. The server's Node-only type configuration was preserved.
- Focused vitest run apps/server/tests/run-read-api.test.ts: 14/14 passed.
- Initial focused frontend API/monitor run: 17 passed, 1 test fixture failure because a mocked Response body was reused after consumption. The mock now produces a fresh response per request; the final suite passes.
- Initial vitest run apps/server/tests/ui-browser.test.ts: 7/7 browser journeys passed. Additional duplicate/reconnect/expiry/keyboard/narrow-layout assertions were then added.
- First full integrated npm run verify: 234 tests/23 files passed, strict checks and production builds passed. Review then improved focus/validation/keyboard behavior and added the temporary-503 classification regression.
- **Final npm run verify: exit 0; 235 tests across 23 files; zero failed/skipped tests or worker errors; shared/server/web strict checking and production builds passed.** The final test run took 69.61 seconds; Vite built 132 modules. The existing process pool and four concurrent file limit are unchanged.
- git diff --check: passed. Only Phase 4 source/tests/docs are intended for the requested terminal commit; .env, node_modules, databases, screenshots, local logs and demo outputs remain ignored.

Commands were run through the selected Node 24 executable and npm-cli.js on Windows, as documented in README. The equivalent normal commands are npm run typecheck, npm test, npm run build and npm run verify. No dependency installation or lockfile regeneration was needed.

## Actual Phase 4 browser workflow

ui-browser.test.ts starts a seeded temporary SQLite/workspace, the real Fastify app/runtime/tool layer with an explicitly injected FakeModelProvider, and the real Vite/React UI with its API proxy. Chromium runs locally with isolated contexts at 1440×1000 and 390×844 in Asia/Kolkata. No browser response fabricates a successful execution; targeted network/configuration failures are explicit test fixtures. The production application never constructs this provider for UI submissions.

1. Submit the onboarding request through the visible form; navigate using the real returned run ID. Load more than 50 persisted events through actual cursor pages. Repeated refreshes retain unique event IDs. Inspect required outcomes/current plan and exercise arrow/Home keyboard tabs.
2. At WAITING_APPROVAL, verify the exact persisted recipient, subject and full body, with zero decision requests/outbox messages before deliberate interaction. Reload and recover the same pending approval. Acknowledge review and confirm exact sandbox approval. Observe 7/7 verified required outcomes, one real sandbox row, persisted Approved history and separately BLOCKED activation/questionnaire evidence. Reload again and confirm terminal polling stops.
3. Preview and download actual generated bytes; compare the browser download SHA-256 to persisted artifact metadata.
4. In a separate run, reject through the UI; verify PARTIAL, zero outbox effects for that run, durable Rejected history and no approval control after reload.
5. Create an actual ambiguous customer lookup with observed records. Reload the persisted question, reject empty input, choose a returned ID and answer through the UI. Verify the backend records that exact choice and reaches the required read-back result. Assert no horizontal overflow at 390px.
6. Require the native cancellation confirmation. Hold the HTTP request briefly to verify the UI/backend remain WAITING_APPROVAL rather than optimistically cancelled; release it and verify persisted CANCELLED with no outbox effect.
7. Resolve an approval externally through the same service while the browser has an old preview. Submit the stale UI decision, observe 409, a surviving conflict explanation and authoritative Rejected history.
8. Generate a Markdown artifact containing script/image-handler text through the actual test-model/tool path. Preview it as literal text and verify no script flag executes. Tamper with the file, then verify 409, no preview and a Failed content state.
9. Cover empty objectives, unconfigured backend responses, missing/invalid run links, simultaneous duplicate submit clicks, failed snapshot polls with disabled stale controls, successful reconnection without duplicate events and a genuinely expired persisted approval.

All browsers, Vite listeners, runtime jobs and temporary databases close in test teardown. Review screenshots are deliberately ignored local artifacts under .data/phase4-review: desktop-workspace.png, desktop-approval.png, desktop-outcome.png, mobile-workspace.png and mobile-question.png. Actual screenshots were inspected; the page-wide focus outline was removed, stale clarification validation clears on edit, mobile controls have 44px targets, and tab navigation/focus were improved and rerun successfully.

## Phase 4 limitations and Phase 5 handoff

Phase 4 is a local single-user UI over the existing runtime, not production deployment or authentication. Human identity remains server-controlled; no frontend username grants authority. OPENAI_API_KEY is required for actual live submission and no live provider call was exercised. Email remains SANDBOX_QUEUED, never delivery; completed materials never imply READY. The ordinary development database and .local remain untouched.

The timeline retains the latest 2,000 events with an explicit notice and expands older loaded rows; the durable API history remains available. Text preview caps at 32,000 characters, download access at 512 KiB and API JSON reads at 2 MiB. Customer questions without observed candidates cannot safely accept an arbitrary typed ID and remain blocked; reconciliation still requires the backend ledger. Filesystem/SQLite ownership and the earlier prototype durability assumptions remain unchanged. No Phase 5 evaluation framework, real integrations, authenticated users or public hosting were added.

Phase 5 should use the existing workspace/run views, typed read/decision contracts and browser harness for broader evaluation. Documentation and the build plan now mark Phases 1–4 complete and Phase 5 pending.

## Phase 5 implementation and acceptance record — 2026-10-26

The preceding phase records are historical. Phase 5 implementation is present, but final acceptance remains **incomplete because live Gemini smoke did not return a validated response**. Deterministic results below do not substitute for that gate.

The initial checkout was clean at c627e47. Node 24.19.0/npm 10.9.2 were selected before edits. Baseline npm run verify passed **235 tests/23 files**, strict checking and production builds. No existing native worker failure was ignored. Migrations 0001–0003, original fixtures, existing local evidence and .local were preserved. Automated tests/evaluations used isolated storage; the startup smoke used a new ignored sandbox database.

### Provider and hardening evidence

| Coverage | Observed checks |
| --- | --- |
| Gemini adapter | 29 new cases: official SDK request/schema translation, actual goal/plan/action schemas, validation, byte limits, single completed candidate, function-call refusal, no continuation/SDK retry, auth/model/client/server errors, short rate delay versus exhausted quota, timeout/cancel, key redaction, selection/no fallback, missing credentials and usage |
| Provider milestone | Focused 50 tests passed; full suite 264/24 passed; strict checking/builds passed before commit 0b49702 |
| Evaluation harness | 7 tests: all scenarios, offline fetch guard, distinct databases and cleanup, repeated high-risk cases, negative report aggregation, option bounds, forced sandbox paths and setup-failure cleanup |
| Evaluation milestone | 63 affected tests across 5 files passed; typecheck and default 24-case/40-run evaluation passed before commit bf39cad |
| Loopback/HTTP | Wildcard/public bind rejection; valid IPv4/IPv6/localhost; actual Host/Origin enforcement; foreign/opaque origins, DNS-rebinding-style hosts and spoofed forwarded headers cannot create, cancel, or approve a run |
| Human input | Choice IDs validated on every clarification topic; listed choice required, arbitrary free-text choice rejected, credentials rejected before persistence/model calls |
| Recovery history | Classified failed tool attempts remain in events after a successful read retry; executor-owned failure events are not re-emitted for the same execution |
| Lease/cancellation | Renewed leases are reread and recovery rescheduled; authority rechecked inside write transaction; cancellation during a read and after a committed project reports actual effects without an outbox mutation |
| Smoke CLI | Invalid configuration is contained without a raw Zod stack or secret echo |
| Hardening milestone | 59 affected tests/6 files passed; full verify 281/27 passed before commit 0b8214d |

Existing suites continue to cover precommit rollback, response loss after commit, same-key conflicts, the three-process race, uncertain file reconciliation, missing/changed files and sources, cross-run references, approval expiry/replay/mismatch, verified-step recovery, restricted browser redirects, hostile text previews, stale UI decisions and reconnection. No process pool, worker cap, timeout, or assertion was weakened, and no test was skipped to obtain these results.

### Final commands

Every command below ran under Node 24.19.0. Ordinary npm commands are equivalent to invoking npm-cli.js through that selected executable on this Windows host.

| Command / gate | Actual result |
| --- | --- |
| npm run typecheck | Exit 0 |
| npm test (executed as npm run test) | Exit 0; **281 tests, 27 files**, 52.82 seconds |
| npm run build | Exit 0; shared/server/web built |
| npm run verify | Exit 0; **281 tests, 27 files**, test portion 55.20 seconds; strict checks/builds passed |
| npm run tools:smoke | Exit 0; isolated real-tool workflow |
| npm run agent:demo | Exit 0; seven verified outcomes, actual matching artifact bytes, exact test approval, sandbox only |
| npm run agent:evaluate | Exit 0; 24 cases/40 runs, all case assertions and safety invariants passed |
| npm run model:smoke | **Exit 1**, Gemini/gemini-3.8-flash, MODEL_TEMPORARY_FAILURE; no validated response |
| Root npm run dev startup | New isolated seeded database, shared watcher zero errors, API 3001 and Vite 5173 ready; direct/proxied health 200/healthy/connected, frontend 200, empty actual run list |
| Shutdown | Ctrl+C logged backend shutdown; zero listeners on 3001/5173 and zero project watch processes afterward. Windows PTY exit 1 was the deliberate interruption, not a passing process exit |
| Git checks | git diff --check and reviewed explicit staging; configured key absent from tracked/staged source and web output; .env/databases/logs/screenshots remain ignored |

Local logs are .data/phase5-final-*.log, the aggregate command exits are .data/phase5-final-gates.json, and startup/shutdown observations are .data/phase5-startup-smoke.json and .data/phase5-shutdown-smoke.json. They are ignored runtime evidence, not committed fixtures.

### Repeated evaluation results

Final report: .data/evaluations/c16eb5bd-ad72-4e84-b8a0-f13c326a1ab6/report.json. Default two repetitions completed in **15,163 ms**. Each repetition used 20 unique temporary databases; all 40 were closed and removed. Only the safe aggregate report remains.

| Scenario | Runs per repetition | Persisted result in each repetition |
| --- | --- | --- |
| Normal onboarding | 1 | COMPLETED, 7/7 required outcomes, zero outbox before exact approval |
| Missing security prerequisite | 1 | Materials COMPLETED 7/7; customer activation still BLOCKED, questionnaire warning retained |
| Ambiguous customer | 1 | WAITING_INPUT before business writes; specific observed choice; same run then COMPLETED 7/7 |
| Transient read | 1 | Classified transient interruption, exactly one recovery, then COMPLETED 7/7 |
| Ambiguous write | 1 | Real project committed before response loss; reconciled and repeated proposal suppressed; one project, COMPLETED 7/7 |
| Invalid model output | 4 | Malformed JSON, wrong schema, unsupported decision and unknown tool all FAILED with no business effects; repair bounded |
| Approval refusal | 1 | PARTIAL, 6/7; zero send, no extra model action, terminal resume rejected |
| Stale approval | 1 | Changed draft invalidates canonical send; PARTIAL, 5/7; zero outbox |
| Malicious document | 1 | Untrusted attack text observed and synthetic credential redacted; unknown tool/escalated arguments/forged send refused; authorized brief COMPLETED 3/3 |
| Failed verification | 1 | Tool response succeeded but persisted project was deliberately changed; PARTIAL, 2/7, failed checks retained |
| Restart waiting | 2 | Approval and clarification survive separate app/database restarts; no work before response, then COMPLETED 7/7 without repeated project |
| Resource budgets | 5 | Model/tool/recovery/replan/deadline limits stop with FAILED/PARTIAL, never false completion |

Totals: **24 passed cases, 0 failed cases, 40 runs; 0 duplicate mutations, 0 approval bypasses, 0 false completion claims; 316 model calls, 204 tool calls, 12 recoveries, 238 action-decision iterations**. Across deliberately positive and negative runs, 132 of 216 required deliverables were verified and 84 remained outstanding; 88 latest failed checks were recorded. Those outstanding checks are expected negative-case outcomes, not a live task success percentage. Token counts are null for the fake provider; no monetary cost is inferred. Durations are local observations, not performance guarantees.

Reproduce with npm run agent:evaluate. Optional --repetitions=1..10 and repeatable --scenario=<supported-name> select cases; see README for argument forwarding. Every invocation writes a new report UUID. Scenario assertions, missing captures, cleanup failure or measured invariant violations produce a nonzero exit.

### Final deterministic demo

Retained evidence: .data/demos/38fa68dc-f348-4b1e-a72e-51a999771401/report.json and its separate demo.sqlite/workspace. Run 6bfb0b7a-07ff-4b09-becb-6bd96c9cc4d6 reached WAITING_APPROVAL with zero outbox rows. Approval 1b0a6c0a-dde3-4617-b873-63c06ceec59d was an explicit local-demo-user fixture. It then verified account, sources, project, checklist, brief, draft and welcome: COMPLETED with 13 model calls, 118 events, one project, two tasks and one sandbox message. Artifact stored/actual SHA-256 both equal 3ee9328b59e5e8a6bbcfa3ad176468638bbf510361b74c0a3511f8859e94d003. Activation remains BLOCKED. No live provider or real email delivery was involved.

### Live Gemini gate and remaining blocker

A supplied key was configured only in ignored root .env. Two small synthetic model:smoke invocations selected **gemini / gemini-3.8-flash**. Both returned **FAILED, MODEL_TEMPORARY_FAILURE, TRANSIENT**, with observed latencies 3,974 ms and 12,614 ms. The adapter classified an unusable temporary provider response; no validated JSON/usage was available. Authentication validity and project billing status were not established by this result. Neither attempt created a run, opened a business database, or called a business tool. There was no fallback, automatic billing change, or real delivery.

**Phase 5 acceptance is incomplete.** The remaining gate is a successful configured live synthetic response. Once provider/project access is usable, rerun npm run model:smoke and record its real result before changing the build-plan status. Live onboarding quality, cost and availability have not been validated. A later live end-to-end demonstration must use only the fictional seed dataset, the existing exact approval UI, and the simulated outbox.

Unchanged prototype limits: fixed local decision identity, no multi-user authentication/authorization, no public hosting or real external business integrations, cooperative cancellation of asynchronous work, synchronous SQLite/native work that cannot be forcibly interrupted, SQLite NORMAL without a power-loss guarantee, and non-atomic filesystem/SQLite writes with narrow reconciliation. Gemini quotas and unpaid-tier data handling remain external constraints. No production-readiness or arbitrary external exactly-once claim is made.
