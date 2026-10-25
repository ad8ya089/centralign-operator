# CentrAlign Operator

Phase 3 of a five-phase proof of concept: a single AI operator that plans from a natural-language goal, selects one action from current observations, executes through deterministic controls and independently verifies required outcomes.

Implemented: the Phase 1/2 foundation and 15 tools, real OpenAI integration, structured goals/plans, durable sequential runtime, approvals/clarification APIs, bounded recovery, leases, duplicate suppression and fresh business/file verification. The web app remains a live health dashboard. Phase 4 run/approval/artifact UI and real email delivery are not implemented; email remains a local sandbox.

## Setup

Use **Node.js 24.x LTS** and npm 10 or newer. Check `node --version` and `npm --version` first. `.nvmrc` selects 24 for compatible version managers, and `.npmrc` rejects incompatible installations. A system Node 22 installation must be switched to Node 24; this project does not target Node 22.

Run all commands from the repository root:

```text
npm install
npm run db:migrate
npm run db:seed
npm run dev
```

Open [the dashboard](http://127.0.0.1:5173). The API listens at [the health endpoint](http://127.0.0.1:3001/api/v1/health). Keep the terminal open; Ctrl+C stops the shared compiler, backend, and frontend together. `concurrently --kill-others` also stops sibling processes if any development process exits.

The root has one `package-lock.json`. Use `npm ci` for a clean reproducible installation after checkout. Do not install dependencies separately inside workspaces or create nested lockfiles.

Before running tests, install the pinned Playwright Chromium browser once:

```text
npx --no-install playwright install chromium
npm run verify
```

Browser tests use isolated local HTTP servers, not an external website. Production navigation defaults to deny. Browser binaries live in Playwright's OS cache, not this repository.

Windows runtime note: Node 22.13.1 provides Node-API 9, while this installed better-sqlite3 binding requires Node-API 10. Root scripts and direct Vitest configuration now reject Node 22 before native loading. If a system npm.ps1 still invokes its adjacent old Node after selecting Node 24, invoke npm's `node_modules/npm/bin/npm-cli.js` through the selected Node 24 executable. No native rebuild or dependency downgrade is needed. The detailed reproduced failure and baseline results are in docs/test-plan.md.

## Environment

Defaults work without `.env`. Optionally copy `.env.example` to `.env` (PowerShell: `Copy-Item .env.example .env`) and edit it. Existing process environment variables take precedence. Restart development after changing configuration.

| Variable | Default | Meaning |
| --- | --- | --- |
| `NODE_ENV` | `development` | `development`, `test`, or `production` |
| `HOST` | `127.0.0.1` | Backend bind address; keep loopback for this unauthenticated foundation |
| `PORT` | `3001` | Backend port, integer 1–65535 |
| `LOG_LEVEL` | `info` | Pino level: fatal/error/warn/info/debug/trace/silent |
| `DATABASE_PATH` | `.data/centralign.sqlite` | Absolute path or path relative to the repository root |
| `ARTIFACT_WORKSPACE_PATH` | `.data/workspaces` | Trusted artifact workspace; absolute or repository-relative |
| `BROWSER_ALLOWED_ORIGINS` | empty | Comma-separated exact HTTP(S) origins; empty denies browser navigation |
| `OPENAI_API_KEY` | unset | Optional at startup; required for live task submission |
| `OPENAI_MODEL` | `gpt-6-sol` | Configurable model used by official Responses structured outputs |
| `OPENAI_TIMEOUT_MS` | `30000` | Per-call timeout, 100–120000 ms |
| `AGENT_MAX_MODEL_CALLS` | `40` | Persisted limit, 1–200 |
| `AGENT_MAX_TOOL_CALLS` | `60` | Persisted limit, 1–200 |
| `AGENT_MAX_RECOVERY_ATTEMPTS` | `2` | Shared repair/retry/reconciliation limit, 0–5 |
| `AGENT_MAX_REPLANS` | `4` | Adaptation limit, 0–20 |
| `AGENT_RUN_TIMEOUT_MS` | `1800000` | Durable absolute deadline, 1000–86400000 ms |

Both `.env` and relative database paths resolve from the repository root in `src` and `dist`. Runtime databases, sidecars, credentials and builds are ignored. Startup works without an API key; live POST /api/v1/runs returns 503 CONFIGURATION_ERROR without creating a run until OPENAI_API_KEY is configured. Restart after changing configuration. Production never substitutes the fake model. No live OpenAI call was exercised during acceptance because no key was configured; SDK transport and error handling use injected responses in tests.

The Vite proxy reads backend `HOST` and `PORT` from root configuration. Browser requests use `/api/v1/health`; no permissive CORS is configured. Only `VITE_` variables are exposed by Vite: never put secrets in variables with that prefix.

## Commands

| Command | Behavior |
| --- | --- |
| `npm run dev` | Build shared, then watch shared, Fastify (`tsx`), and Vite together |
| `npm run db:migrate` | Build shared, open SQLite, apply the same migrations as startup, report schema versions, close |
| `npm run db:seed` | Insert missing fictional customers and atomically refresh changed source indexes; preserve business edits |
| `npm run tools:smoke` | Run an isolated deterministic tool workflow, including trusted test approval and sandbox outbox read-back |
| `npm run agent:demo` | Explicit fake model with real API/runtime/tools in a new ignored .data/demos/UUID database/workspace; saves persisted IDs and verified evidence in report.json |
| `npm run typecheck` | Build shared, strictly check shared/server/web sources, tests, and build configuration |
| `npm test` | Build shared and run deterministic Vitest suites against temporary databases |
| `npm run build` | Build shared first, then server and web |
| `npm run verify` | Typecheck → tests → production builds; stop on any failure |

After `npm run build`, `npm run start --workspace @centralign/server` runs the compiled backend and resolves the same repository-relative configuration. The web output is `apps/web/dist`. Production web hosting and a production reverse proxy are outside Phase 1; the backend does not serve the web build. Workspaces are private and are not published.

Phase 1 acceptance passed on 2026-10-25 with Node 24.19.0 and npm 10.9.2: strict typecheck, 71 tests, production builds, full verify, migration CLI, live dashboard/retry/offline recovery, and compiled backend startup from another directory. All smoke-test processes were stopped. See docs/test-plan.md for the actual validation record, resolved failures, and limits.

Stage A reproduced the unsupported-Node worker crash and added runtime guards. Phase 2 passed 124 tests/13 files. Phase 3 adds the autonomous backend; current commands/counts, baseline/browser findings and persisted demo evidence are in docs/test-plan.md. Phases 4 and 5 remain pending.

## Layout and handoff

- `packages/shared/src`: canonical states, records, JSON/runtime validation, health/error schemas, and pure transition rules.
- `apps/server/src`: root-aware environment configuration, SQLite lifecycle, migration runner/CLI, testable Fastify construction, and socket entry point.
- `apps/web/src`: dashboard, reusable health client, and explicit loading/healthy/degraded/request-error states with manual retry.
- `fixtures/company`: three fictional sources indexed by the explicit seed command; never permission grants.
- [Architecture](docs/architecture.md), [five-phase build plan](docs/BUILD_PLAN.md), [test plan](docs/test-plan.md), and [stack decision](docs/decisions/0001-foundation-stack.md).

Phase 4 should use the shared agent schemas and apps/server/src/api/runs.ts with the existing RunService. RunSnapshot exposes goal, plan/revision, steps/actions/milestones, pending questions/approvals, verification, final result, counters and artifact metadata. Event pages expose a stable cursor. Use exact persisted approval previews and specific question IDs; never infer success from a model summary. Artifact byte/download UI and authenticated decision identity remain pending. There is no public generic tool endpoint or automatic seed.

Preserve the shared-first build, single lockfile, Node 24 guard, persisted-state authority, exact-action approval, idempotency identity, and additive migrations. Do not edit applied migration SQL; checksums reject drift. A tool success or SANDBOX_QUEUED message is not final verified business completion or real email delivery.

## Run API and human decisions

Migration 0003 upgrades existing databases on startup or via npm run db:migrate; migrations 0001/0002 are unchanged. Keep this unauthenticated prototype on loopback.

| Method and path under /api/v1 | Body / result |
| --- | --- |
| POST /runs | { objective }; HTTP 202 with id/status, background execution |
| GET /runs/:runId | Validated RunSnapshotSchema |
| GET /runs/:runId/events?after=0&limit=50 | RunEventsPageSchema; max 100, cursor for later polling, nextCursor for another page |
| POST /runs/:runId/input | { questionId, answer, choiceId? }; HTTP 202 |
| POST /runs/:runId/approvals/:approvalId/decision | { decision: APPROVED or REJECTED, note? }; new 202, identical repeat 200 |
| POST /runs/:runId/cancel | Empty object; HTTP 202, durable cancellation |

PowerShell example against a configured live server:

```powershell
$base = 'http://127.0.0.1:3001/api/v1'
$body = @{ objective = 'Onboard Acme Logistics using our CRM and onboarding SOP. Create the onboarding project and checklist, prepare an onboarding brief with sources, draft and send the welcome email.' } | ConvertTo-Json
$accepted = Invoke-RestMethod "$base/runs" -Method Post -ContentType 'application/json' -Body $body
$runId = $accepted.id
$snapshot = Invoke-RestMethod "$base/runs/$runId"
$events = Invoke-RestMethod "$base/runs/$runId/events?after=0&limit=50"
```

When WAITING_APPROVAL, inspect pendingApprovals[0].action before deciding:

```powershell
$approval = $snapshot.pendingApprovals[0]
$approval.action | ConvertTo-Json -Depth 8
$decision = @{ decision = 'APPROVED'; note = 'Reviewed this exact sandbox message' } | ConvertTo-Json
Invoke-RestMethod "$base/runs/$runId/approvals/$($approval.id)/decision" -Method Post -ContentType 'application/json' -Body $decision
```

Use REJECTED to deny the action. Identity/time are server-owned. Conflicting/stale/expired decisions return 409. Changed draft content invalidates approval; rejection cannot be bypassed by the model. Approval pauses survive restart.

For WAITING_INPUT, inspect pendingQuestions and target its specific ID. Customer questions require choiceId from observed choices, or an explicitly identified existing account when no match exists:

```powershell
$question = $snapshot.pendingQuestions[0]
$answer = @{ questionId = $question.id; answer = 'Use this account'; choiceId = 'observed-customer-id' } | ConvertTo-Json
Invoke-RestMethod "$base/runs/$runId/input" -Method Post -ContentType 'application/json' -Body $answer
Invoke-RestMethod "$base/runs/$runId/cancel" -Method Post -ContentType 'application/json' -Body '{}'
```

Questions/answers persist across restart. Free text cannot establish an uncertain write's outcome; authoritative ledger reconciliation is required. Cancellation preserves committed effects and can wait for reconciliation. Shared structured errors cover 400 validation, 404 missing, 409 conflict, 413 body limits and 503 configuration.

The real provider uses official Responses structured output and server validation with storage disabled. Dynamic decisions use bounded observations and actual discovered IDs; only independent required-outcome checks permit COMPLETED. Acme's questionnaire remains missing: completed materials and a queued sandbox welcome message do not establish READY.

Run npm run verify for typecheck, all tests and production builds. npm run agent:demo explicitly uses FakeModelProvider, actual HTTP/runtime/tools and an attributed human-decision fixture in its own new ignored database. It saves seven verified deliverables, persisted IDs and artifact byte hashes; it is not live-model validation or a production fallback. See docs/architecture.md and docs/decisions/0003-durable-single-agent-runtime.md for runtime/recovery details.
