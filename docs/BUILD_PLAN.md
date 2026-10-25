# Five-phase build plan

## 1. Foundation and system contracts

- Objective: establish a small, testable application with durable schema and canonical contracts.
- Scope: npm workspaces, strict TypeScript, Zod records/status/transitions, SQLite migrations/constraints, root-aware configuration, health API, connected dashboard, fictional sources, documentation.
- Dependencies: Node 24.x, npm, local filesystem; no credentials or external business services.
- Acceptance: one root lockfile; shared-first builds; successful typecheck, tests, build, verify; repeatable migrations; real healthy/degraded API; frontend connection/retry; full development launch and clean stop; required documents and source fixtures.
- Status: **Complete — acceptance passed on 2026-10-25 using Node 24.19.0 and npm 10.9.2.**
- Observed: installation and dependency tree valid; strict typecheck passed; 71 tests across 5 files passed; production builds and full verify passed; migration CLI applied version 1; direct/proxied health returned 200; dashboard retry, offline request-error state, and recovery observed; compiled backend launched from outside the repository; all launched listeners stopped.
- Outstanding: no required Phase 1 work. Later phase status is recorded separately below. See test-plan.md for the validation record and prototype limits.
- Stage A revalidation: the reported Windows worker crash was reproduced under Node 22.13.1 (Node-API 9) with a Node-API 10 SQLite binding. Runtime guards were added; the same binary passed under Node 24.19.0, including individual native tests, 72 tests in the normal parallel suite, typecheck, build, and verify. The gate passed before Phase 2 work; no dependency rebuild or pool change was needed.

## 2. Company context and reusable tool layer

- Objective: turn source material and business operations into bounded, typed capabilities.
- Scope: document catalog/ingestion and source references, entity resolution, context retrieval, validated tool registry, server-side permissions, action-specific policy and idempotency/reconciliation contracts. Start with the fictional onboarding scenario.
- Dependencies: Phase 1 records, JSON validation, schema/migration runner, trust boundaries; additive migrations for new fields/tables.
- Acceptance: context has traceable sources; malicious source text cannot change permissions; invalid calls fail before side effects; tool arguments/results have schemas and postconditions; stable action identity and explicit UNKNOWN_OUTCOME handling; no unauthorized outbound email.
- Status: **Complete — acceptance passed on 2026-10-25 with Node 24.19.0/npm 10.9.2.**
- Implemented: migration 0002, repeatable seed/index, optional FTS5 and text fallback, source-backed retrieval, 15 typed tools, trusted scopes/context, transactional local idempotency, file reconciliation, exact-action sandbox approval, read-back operations, and restricted Playwright open/snapshot with real loopback tests. No Phase 3 runtime or public execution endpoint.
- Observed: full parallel suite 124 tests/13 files passed, including six real Playwright loopback tests, a three-process idempotency race, and a normalization/ledger consistency regression test; typecheck, build, verify, and isolated tools:smoke exited 0. The real Phase 1 database migrated to version 2; first seed inserted one customer/three documents, second seed changed zero. Direct/proxied health and frontend HTTP launch passed; all development listeners stopped.
- Outstanding: no required Phase 2 work. Prototype limits are recorded in architecture/test-plan. Phase 3 must inspect tools/index.ts, tools/contracts.ts, tools/executor.ts, tools/policy.ts, shared business schemas, and migration 0002 first.

## 3. Autonomous runtime and recovery

- Objective: implement one dynamically acting agent behind deterministic execution controls.
- Scope: Understand → Plan → Execute → Observe → Adapt → Verify, persisted ledger writes and concurrency checks, bounded budgets/retries/deadlines, crash recovery, uncertain-write reconciliation, independent postconditions.
- Dependencies: Phase 2 source/tool contracts; explicit provider/configuration requirements; migrations for runtime data where necessary.
- Acceptance: a restart resumes persisted state; no blind retry of ambiguous writes; invalid transitions preserve state; bounded repair; independent final verification; honest FAILED/PARTIAL outcomes.
- Status: **Complete — Phase 3 backend acceptance passed with Node 24.19.0/npm 10.9.2; full verification passed 193 tests/19 files, strict type checking and production builds.**
- Implemented: real OpenAI Responses provider with optional-key startup/no-row live submission rejection; explicitly injected fake; immutable required goal outcomes and revisioned plans; dynamic single-action loop through the existing 15 tools; durable events, leases/fences, budgets, approvals, questions, cancellation and restart recovery; semantic duplicate suppression and uncertain-write reconciliation; independent row/file step and final verification; lifecycle/decision APIs. Migration 0003 preserves 0001/0002 and existing data.
- Observed: baseline 124-test gate passed after investigating the first Chromium cold-start outer timeout. Expanded positive browser fixtures use the production 5s budget; dedicated negative bounds remain 2s. Full verification with four concurrent test files passes without skips or worker errors; the explicit three-process race remains enabled. Persisted isolated fake-model demo completed seven materials/send outcomes after exact approval, with actual bytes/hash and zero outbox before approval; activation remains BLOCKED. Migration CLI and live direct/proxied HTTP launch/shutdown passed. Actual counts, IDs, intermediate failures and commands are recorded in test-plan.md.
- Outstanding: no required Phase 3 backend implementation remains. Live OpenAI quality/cost/availability was not exercised because no key was configured. Email is simulated; decision identity is fixed/local, not authenticated. Later UI and final acceptance status are recorded below.

## 4. User interface, durable approval, and evidence

- Objective: expose progress, action-specific human control, blockers, and evidence without misrepresenting outcomes.
- Scope: real run views and timeline, durable approvals/rejections/expiry, exact material action preview, evidence links, clarification input, partial outcome reporting.
- Dependencies: runtime and persisted events from Phase 3, tool-policy gates from Phase 2, server-controlled local decision identity. Authenticated multi-user design remains later work.
- Acceptance: no action executes before required approval; changed arguments invalidate authorization; decisions survive restart; rejecting an action cannot be silently reversed; evidence and blockers are visible; UI reflects actual state.
- Status: **Complete — acceptance passed on 2026-10-26 with Node 24.19.0/npm 10.9.2. Final npm run verify passed 235 tests/23 files, strict checks and all production builds.**
- Implemented: real workspace/submission/recent runs, dedicated run views, cursor-based live timeline, plan/deliverable/step views, exact-action approval and rejection, durable decision history, clarification, confirmed cancellation, separate customer activation state, verification/source evidence, safe artifact download and inert text preview. Added only the read-only run-list/content routes and compatible shared snapshot/read DTOs; no new execution path, migration, frontend fake fallback, UI framework or authentication scheme.
- Observed: Phase 3 baseline passed 193/19 before editing. Four new suites add 42 tests: 14 read API/artifact tests, 13 client tests, 6 cursor/monitor tests and 9 actual Chromium UI journeys. Approved/rejected/expired/conflicting actions, reload/reconnect, duplicate submission, observed customer choice, cancellation, downloads and hostile previews passed against isolated real backend/runtime/tools with explicitly injected test models. Desktop and 390px screenshots reviewed and accessibility/layout corrections verified. All existing browser and multi-process tests remain enabled; the four-file worker cap and process pool are unchanged.
- Outstanding: no required Phase 4 implementation remains. The app is loopback-only, uses fixed server-side local attribution and queues simulated email. Customer questions without observed candidates remain safely blocked; large timelines visibly retain the latest 2,000 events. Phase 5 implementation and the remaining live-validation blocker are recorded below.

## 5. Hardening, evaluation, and final demonstration

- Objective: demonstrate reliable onboarding under realistic faults and adversarial inputs.
- Scope: tool/runtime/approval/security/end-to-end evaluations, browser tests if a browser tool is selected, operational shutdown/recovery, deterministic scenarios and evidence-backed demo report.
- Dependencies: Phases 1–4; approved test integrations and isolated accounts/workspaces where needed.
- Acceptance: all critical reliability scenarios in test-plan.md pass; Acme's missing questionnaire prevents activation; approved email has send evidence; partial completion remains explicit; no secret leakage or source-based permission escalation; final verification failures prevent COMPLETED.
- Status: **Implementation finished; Phase 5 acceptance incomplete — live Gemini validation blocked on 2026-10-26.**
- Implemented: official @google/genai 2.31.0 default adapter for gemini-3.8-flash; optional explicit OpenAI; strict structured decisions, safe failure/quota handling, cancellation and usage metadata; additive migration 0004; unpaid-tier data-use disclosure in the UI and README; isolated repeated evaluation and fault injection; loopback/Host/Origin guards; clarification choice/secret validation; durable failure history and renewed-lease recovery; regression tests and delivery documentation.
- Observed: Phase 4 baseline revalidated at 235 tests/23 files. Final deterministic verification passed 281 tests/27 files with Chromium and the three-process race enabled, strict checking and production builds. All 12 evaluation scenarios passed twice across 40 isolated runs: zero duplicate effects, approval bypasses or false completion claims; 316 model calls, 204 tool calls and 12 recoveries. The demo independently verified seven outcomes after exact approval, with activation BLOCKED. Isolated direct/proxied API and frontend launch/shutdown passed; no listeners or watch processes remained.
- Outstanding acceptance blocker: both small live synthetic Gemini smoke requests failed with MODEL_TEMPORARY_FAILURE; no validated live response or live task-quality claim is available. Run npm run model:smoke again once provider/project access is usable, record its real outcome, and only mark this phase complete after it passes. The deterministic suite does not need credentials. Email remains simulated and the app remains an unauthenticated local prototype.
