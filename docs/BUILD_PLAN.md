# Five-phase build plan

## 1. Foundation and system contracts

- Objective: establish a small, testable application with durable schema and canonical contracts.
- Scope: npm workspaces, strict TypeScript, Zod records/status/transitions, SQLite migrations/constraints, root-aware configuration, health API, connected dashboard, fictional sources, documentation.
- Dependencies: Node 24.x, npm, local filesystem; no credentials or external business services.
- Acceptance: one root lockfile; shared-first builds; successful typecheck, tests, build, verify; repeatable migrations; real healthy/degraded API; frontend connection/retry; full development launch and clean stop; required documents and source fixtures.
- Status: **Complete — acceptance passed on 2026-10-25 using Node 24.19.0 and npm 10.9.2.**
- Observed: installation and dependency tree valid; strict typecheck passed; 71 tests across 5 files passed; production builds and full verify passed; migration CLI applied version 1; direct/proxied health returned 200; dashboard retry, offline request-error state, and recovery observed; compiled backend launched from outside the repository; all launched listeners stopped.
- Outstanding: no required Phase 1 work. Business features remain pending under Phases 2–5. See test-plan.md for the validation record and prototype limits.

## 2. Company context and reusable tool layer

- Objective: turn source material and business operations into bounded, typed capabilities.
- Scope: document catalog/ingestion and source references, entity resolution, context retrieval, validated tool registry, server-side permissions, action-specific policy and idempotency/reconciliation contracts. Start with the fictional onboarding scenario.
- Dependencies: Phase 1 records, JSON validation, schema/migration runner, trust boundaries; additive migrations for new fields/tables.
- Acceptance: context has traceable sources; malicious source text cannot change permissions; invalid calls fail before side effects; tool arguments/results have schemas and postconditions; stable action identity and explicit UNKNOWN_OUTCOME handling; no unauthorized outbound email.
- Status: **Pending.**
- Outstanding: all context/tool functionality; select minimal integrations and write deterministic fixtures/tests. Inspect architecture, shared schemas/transitions, database migration 0001, test helpers, and app construction first.

## 3. Autonomous runtime and recovery

- Objective: implement one dynamically acting agent behind deterministic execution controls.
- Scope: Understand → Plan → Execute → Observe → Adapt → Verify, persisted ledger writes and concurrency checks, bounded budgets/retries/deadlines, crash recovery, uncertain-write reconciliation, independent postconditions.
- Dependencies: Phase 2 source/tool contracts; explicit provider/configuration requirements; migrations for runtime data where necessary.
- Acceptance: a restart resumes persisted state; no blind retry of ambiguous writes; invalid transitions preserve state; bounded repair; independent final verification; honest FAILED/PARTIAL outcomes.
- Status: **Pending.**
- Outstanding: entire runtime, provider integration, recovery scheduler, verifier, and failure-injection tests. Do not replace persisted authority with model memory.

## 4. User interface, durable approval, and evidence

- Objective: expose progress, action-specific human control, blockers, and evidence without misrepresenting outcomes.
- Scope: real run views and timeline, durable approvals/rejections/expiry, exact material action preview, evidence links, clarification input, partial outcome reporting.
- Dependencies: runtime and persisted events from Phase 3, tool-policy gates from Phase 2; authenticated decision identity design.
- Acceptance: no action executes before required approval; changed arguments invalidate authorization; decisions survive restart; rejecting an action cannot be silently reversed; evidence and blockers are visible; UI reflects actual state.
- Status: **Pending.**
- Outstanding: all execution and approval UI/APIs, authorization enforcement, and UI/integration tests. Phase 1 only has a health dashboard.

## 5. Hardening, evaluation, and final demonstration

- Objective: demonstrate reliable onboarding under realistic faults and adversarial inputs.
- Scope: tool/runtime/approval/security/end-to-end evaluations, browser tests if a browser tool is selected, operational shutdown/recovery, deterministic scenarios and evidence-backed demo report.
- Dependencies: Phases 1–4; approved test integrations and isolated accounts/workspaces where needed.
- Acceptance: all critical reliability scenarios in test-plan.md pass; Acme's missing questionnaire prevents activation; approved email has send evidence; partial completion remains explicit; no secret leakage or source-based permission escalation; final verification failures prevent COMPLETED.
- Status: **Pending.**
- Outstanding: evaluation harness, scenario results, hardening, and final demonstration. Do not claim production readiness from the local prototype.
