# CentrAlign Operator

Phase 4 of a five-phase proof of concept: a single AI operator with a real workspace for submitting goals, following execution, reviewing exact actions and inspecting independently verified results.

Implemented: the runtime and 15 tools plus the run workspace, persisted recent runs, live event timeline, plans/steps, exact-action approval/rejection, clarification, cancellation, decision history, verification/source evidence and safe artifact download/text preview. Gemini is the default live provider; OpenAI remains an explicitly selected alternative. Email remains a local sandbox. This is a loopback-only prototype with a fixed server-controlled local decision identity, not authenticated multi-user access. Phase 5 evaluation and final review are in progress.

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

Default provider: `MODEL_PROVIDER=gemini`, `GEMINI_MODEL=gemini-3.8-flash`. Set `GEMINI_API_KEY` in the ignored root `.env`. Use `MODEL_PROVIDER=openai` plus `OPENAI_API_KEY` to select OpenAI instead. Missing credentials never trigger a provider or fake-model fallback. `MODEL_TIMEOUT_MS` applies to the selected provider; the existing OPENAI_TIMEOUT_MS remains a fallback when it is unset. `npm run model:smoke` sends one small synthetic structured request with no business tools or private context.

**Gemini unpaid-tier data use:** Google may use inputs/outputs to improve products, and human reviewers may process them. Use fictional or explicitly approved test data. Do not submit confidential company data, credentials, sensitive personal information or real customer records on an unpaid tier. Quotas and access can change. Paid projects have different terms; the app cannot infer billing status from the key. Check [Google's terms](https://ai.google.dev/gemini-api/terms), [pricing](https://ai.google.dev/gemini-api/docs/pricing) and [models](https://ai.google.dev/gemini-api/docs/models).

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
| `MODEL_PROVIDER` | `gemini` | Explicit live provider: gemini or openai |
| `GEMINI_API_KEY` | unset | Required for live Gemini submission |
| `GEMINI_MODEL` | `gemini-3.8-flash` | Gemini structured-output model |
| `MODEL_TIMEOUT_MS` | unset | Selected-provider timeout; falls back to OPENAI_TIMEOUT_MS |
| `OPENAI_API_KEY` | unset | Required only when MODEL_PROVIDER=openai |
| `OPENAI_MODEL` | `gpt-6-sol` | Configurable model used by official Responses structured outputs |
| `OPENAI_TIMEOUT_MS` | `30000` | Per-call timeout, 100–120000 ms |
| `AGENT_MAX_MODEL_CALLS` | `40` | Persisted limit, 1–200 |
| `AGENT_MAX_TOOL_CALLS` | `60` | Persisted limit, 1–200 |
| `AGENT_MAX_RECOVERY_ATTEMPTS` | `2` | Shared repair/retry/reconciliation limit, 0–5 |
| `AGENT_MAX_REPLANS` | `4` | Adaptation limit, 0–20 |
| `AGENT_RUN_TIMEOUT_MS` | `1800000` | Durable absolute deadline, 1000–86400000 ms |

Both `.env` and relative database paths resolve from the repository root in `src` and `dist`. Runtime databases, sidecars, credentials and builds are ignored. Startup works without an API key; live POST /api/v1/runs returns 503 CONFIGURATION_ERROR without creating a run until the selected provider's key is configured. Restart after changing configuration. Production never substitutes another provider or fake model. SDK transport and error handling use injected responses in normal tests.

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

Stage A reproduced the unsupported-Node worker crash and added runtime guards. Phase 2 passed 124 tests/13 files; Phase 3 passed 193 tests/19 files. Phase 4 adds the real user interface and scoped read APIs. Current commands/counts, browser workflow, limitations and validation evidence are in docs/test-plan.md. Phase 5 remains pending.

## Layout and handoff

- `packages/shared/src`: canonical states, records, JSON/runtime validation, health/error schemas, and pure transition rules.
- `apps/server/src`: root-aware environment configuration, SQLite lifecycle, migration runner/CLI, testable Fastify construction, and socket entry point.
- `apps/web/src`: workspace and run views, typed API client, cursor monitor, decision forms, artifact access and reusable service health.
- `fixtures/company`: three fictional sources indexed by the explicit seed command; never permission grants.
- [Architecture](docs/architecture.md), [five-phase build plan](docs/BUILD_PLAN.md), [test plan](docs/test-plan.md), and [stack decision](docs/decisions/0001-foundation-stack.md).

The UI uses the shared agent schemas and existing RunService. RunSnapshot exposes goal, plan/revision, steps/actions/milestones, pending/history questions and approvals, actual customer activation blockers, verification, final result, counters and artifact metadata. Event pages expose stable cursors. No public generic tool endpoint, frontend fake-model fallback, ad hoc authentication or automatic seed exists. Phase 5 should preserve these contracts and evaluate broader reliability without replacing persisted authority with model assertions.

Preserve the shared-first build, single lockfile, Node 24 guard, persisted-state authority, exact-action approval, idempotency identity, and additive migrations. Do not edit applied migration SQL; checksums reject drift. A tool success or SANDBOX_QUEUED message is not final verified business completion or real email delivery.

## Run API and human decisions

Migration 0003 upgrades existing databases on startup or via npm run db:migrate; migrations 0001/0002 are unchanged. Keep this unauthenticated prototype on loopback.

| Method and path under /api/v1 | Body / result |
| --- | --- |
| POST /runs | { objective }; HTTP 202 with id/status, background execution |
| GET /runs?limit=20&cursor=... | Persisted executable runs, creation order with stable ID tie-breaker; max 50 per page |
| GET /runs/:runId | Validated RunSnapshotSchema |
| GET /runs/:runId/events?after=0&limit=50 | RunEventsPageSchema; max 100, cursor for later polling, nextCursor for another page |
| POST /runs/:runId/input | { questionId, answer, choiceId? }; HTTP 202 |
| POST /runs/:runId/approvals/:approvalId/decision | { decision: APPROVED or REJECTED, note? }; new 202, identical repeat 200 |
| POST /runs/:runId/cancel | Empty object; HTTP 202, durable cancellation |
| GET /runs/:runId/artifacts/:artifactId/content | Owning-run validated bytes, attachment only, bounded file and fresh hash/provenance checks |

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

## Using the run workspace

Open http://127.0.0.1:5173 after npm run dev. Enter a goal or use the onboarding example, then select **Start run**. Live submission requires OPENAI_API_KEY on the backend. Without it, the workspace displays the real configuration error and creates no simulated success. Recent runs come from SQLite; selecting one or reopening /runs/ID reconstructs its persisted state.

The **Activity** tab follows durable events; **Plan & work** distinguishes requested deliverables, current milestones and executed steps; **Evidence** shows recorded checks, sources and artifacts. Active/waiting runs refresh every two seconds, with capped reconnect backoff. Terminal runs receive a final refresh and stop polling. Refresh now can reread authoritative state manually. Large histories retain the latest 2,000 events with an explicit notice, and earlier loaded events are expandable.

When approval is required, review the full recipient, subject and body. **Approve this exact action** opens a deliberate confirmation requiring review acknowledgment; **Reject this action** persists denial. Neither edits the canonical action. Decision history survives reload. Expired or conflicting decisions reload the current state; no frontend identity field grants authority. Approved messages are queued locally, never delivered as real email.

For clarification, select a returned candidate where required and provide a nonempty answer. The form submits the exact question ID. No arbitrary customer-ID field is offered; questions without observed customer candidates remain blocked rather than guessing an account. Reconciliation questions require the backend's authoritative outcome, not just text. **Cancel run** requires confirmation, preserves committed work and may remain pending for reconciliation.

Artifacts download only through their owning run's content route. Each access checks confinement, links, size, actual bytes/hash and recorded sources. Supported text/Markdown/JSON previews display inert text, never rendered HTML. Other content downloads as an attachment with an inert MIME type. A missing/tampered file shows a verification error. The final materials result and **Customer activation** are distinct; a missing questionnaire remains a visible blocker even when all requested materials are verified.

Browser UI tests run automatically in npm run verify using installed Playwright Chromium, an isolated real backend with an explicitly injected test model, and Vite on loopback ephemeral ports. They never use the normal development database, .local, external sites or a live API key. Captured local review screenshots are ignored under .data/phase4-review. See docs/test-plan.md for exact coverage and results.
