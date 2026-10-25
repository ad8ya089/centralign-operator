# CentrAlign Operator

A local AI operator for company workflows. Submit a goal, follow its work, answer questions, and review consequential actions before they run. The server checks persisted records and artifact bytes before reporting completion.

The example prepares onboarding materials for fictional **Acme Logistics**. Email goes to a **simulated outbox**. Acme remains **BLOCKED** for activation while its security questionnaire is missing.

## Run locally

Use **Node.js 24.x** and npm 10+. Run commands from the repository root:

```powershell
node --version
npm --version
npm ci
npx --no-install playwright install chromium
```

For a new checkout, create the local configuration once. Keep an existing `.env` if you already have one:

```powershell
Copy-Item .env.example .env
```

Create a key in Google AI Studio's API Keys page: choose your Google Cloud project (import it first if needed), then choose **Create API key**. Google's [key setup guide](https://ai.google.dev/gemini-api/docs/api-key) describes project access and restrictions. Put the key only in the ignored root file:

```dotenv
MODEL_PROVIDER=gemini
GEMINI_MODEL=gemini-3.8-flash
GEMINI_API_KEY=replace-with-your-key
MODEL_TIMEOUT_MS=30000
```

**Use fictional or explicitly approved test data.** Google's unpaid-tier terms allow inputs and outputs to be used for product improvement and human review. Do not submit confidential company information, credentials, sensitive personal information, or real customer records through an unpaid tier. Quotas and access can change. Paid projects have different terms; this app cannot determine billing status from a key. Check [Google's terms](https://ai.google.dev/gemini-api/terms) and [pricing](https://ai.google.dev/gemini-api/docs/pricing).

```powershell
npm run model:smoke
npm run db:migrate
npm run db:seed
npm run dev
```

Open **[127.0.0.1:5173](http://127.0.0.1:5173)**. [API health](http://127.0.0.1:3001/api/v1/health) listens on port 3001. Ctrl+C stops development processes.

Startup and health work without a key. Live submission requires the selected provider's key and returns a structured configuration error before creating a run when it is absent. There is no provider switch or fake-model fallback.

## Try onboarding

Submit:

> Onboard Acme Logistics: create an onboarding project and checklist tasks, prepare a source-backed onboarding brief, draft a welcome email, and send the welcome email after approval.

Follow **Activity**, **Plan & work**, and **Evidence**. At the approval pause, read the exact recipient, subject, and full body before deciding. Decisions survive reloads and restarts.

A successful materials run has a project, two checklist tasks, a source-backed brief, a draft, and an approved sandbox outbox record. The verifier checks seven required outcomes. Materials completion does not establish activation readiness; the missing questionnaire remains visible.

For an offline demonstration:

```powershell
npm run agent:demo
```

This explicitly injects a deterministic model into the real API, runtime, and tools. It creates `.data/demos/<UUID>/`, saves a database, artifacts, and `report.json`, and supplies an attributed test approval. It does not test live model quality.

## Commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Watch shared contracts, API, and frontend |
| `npm run db:migrate` | Apply additive, checksummed migrations |
| `npm run db:seed` | Seed fictional records and refresh indexes; preserve business edits |
| `npm run typecheck` | Strict source, test, and build-configuration checks |
| `npm test` | Deterministic tests, Chromium journeys, and concurrent-write checks |
| `npm run build` | Build shared contracts, server, and web |
| `npm run verify` | Typecheck, tests, and production builds |
| `npm run tools:smoke` | Isolated workflow through the real tools |
| `npm run agent:demo` | Offline onboarding with saved evidence |
| `npm run agent:evaluate` | Repeated reliability scenarios and JSON results |
| `npm run model:smoke` | One synthetic live request; no business tools or database |
| `npm run start --workspace @centralign/server` | Run the compiled API after building |

The API does not serve `apps/web/dist`. Production web hosting is outside this prototype's scope.

## Reliability evaluation

```powershell
npm run agent:evaluate
npm run agent:evaluate -- --repetitions=3 --scenario=ambiguous-write --scenario=stale-approval
```

The default executes 12 scenarios twice: **24 scenario executions, 40 isolated runs**. Each run uses a unique temporary SQLite database and artifact directory. Temporary workspaces are removed. Reports are saved to `.data/evaluations/<UUID>/report.json`; the development database and `.local` are not used.

Coverage includes onboarding, missing prerequisites, customer ambiguity, transient reads, lost write responses, invalid model output, rejected/stale approval, malicious documents, failed postconditions, restart at human pauses, and resource limits. Negative cases should stop with honest failed or partial results.

Reports measure persisted effects, verified/outstanding deliverables, failed checks, duplicate mutations, approval bypasses, false completion claims, calls, recoveries, and elapsed time. Fake-model token usage is `null`; cost and live success rate are not inferred. Any failed scenario or safety invariant exits nonzero.

Hardening verification passed **281 tests across 27 files**. Repeated evaluation recorded **zero duplicate mutations, approval bypasses, or false completion claims**. The [test record](docs/test-plan.md) contains final gates, live-provider results, and the limits of these observations.

**Acceptance status (2026-10-26):** implementation and deterministic gates passed. Live Gemini smoke failed twice with `MODEL_TEMPORARY_FAILURE` for `gemini-3.8-flash`. Phase 5 remains incomplete until a configured live smoke returns a validated response. No business task was sent to the live model; live task quality remains untested.

## Configuration

Root `.env` values are server-side; explicit process variables take precedence. Restart after changes. Never give a secret a `VITE_` prefix.

| Setting | Default / behavior |
| --- | --- |
| `MODEL_PROVIDER` | `gemini`; select `openai` explicitly for the existing Responses adapter |
| `GEMINI_MODEL` / `GEMINI_API_KEY` | `gemini-3.8-flash` / required for live Gemini |
| `OPENAI_MODEL` / `OPENAI_API_KEY` | `gpt-6-sol` / required only for selected OpenAI |
| `MODEL_TIMEOUT_MS` | Falls back to `OPENAI_TIMEOUT_MS` (30,000 ms); example sets 30,000 |
| `HOST` / `PORT` | `127.0.0.1` / `3001`; explicit loopback addresses or localhost only |
| `DATABASE_PATH` | `.data/centralign.sqlite` |
| `ARTIFACT_WORKSPACE_PATH` | `.data/workspaces` |
| `BROWSER_ALLOWED_ORIGINS` | Empty denies navigation; otherwise exact approved HTTP(S) origins |
| `AGENT_MAX_MODEL_CALLS` / `AGENT_MAX_TOOL_CALLS` | 40 / 60 |
| `AGENT_MAX_RECOVERY_ATTEMPTS` / `AGENT_MAX_REPLANS` | 2 / 4 |
| `AGENT_RUN_TIMEOUT_MS` | 1,800,000 ms absolute run deadline |
| `NODE_ENV` / `LOG_LEVEL` | `development` / `info` |

Relative paths resolve from the repository root in source and compiled execution. Startup migrates but never seeds. Keep the single root lockfile; do not install separately inside workspaces.

## How it works

React → Fastify → one sequential runtime → validated tools → SQLite and scoped artifacts.

The model proposes one structured decision at a time. Server code owns permissions, budgets, leases, approvals, and completion. Required deliverables remain fixed while plans may change. Safe reads can retry within persisted limits; uncertain writes require reconciliation. The verifier reads actual rows and files again before accepting success.

The official `@google/genai` SDK supplies the default Gemini adapter. OpenAI remains explicitly selectable. Both share the provider contract and application validation. The fake is injected only by tests, evaluations, and the labeled demo.

| Location | Contents |
| --- | --- |
| `apps/server/src/agent` | Providers, planning, durable runtime, verifier, evaluation |
| `apps/server/src/tools` | 15 typed tools, policy, ledger, artifacts, restricted browser |
| `apps/server/src/persistence` | SQLite, migrations, fictional seed |
| `apps/web/src` | Workspace, monitoring, human decisions, evidence |
| `packages/shared/src` | Zod contracts and state transitions |
| `fixtures/company` | Fictional SOP, security policy, and company context |
| `docs` | Architecture, decisions, build plan, and test evidence |

## Limits and troubleshooting

This is a **single-user loopback prototype** with a fixed server-controlled local decision identity. Host and browser-origin checks preserve that boundary; they do not provide multi-user authentication. Trusted local processes can access the app. Do not expose it through a tunnel or public proxy.

SQLite business writes and their execution ledger share transactions. Files and SQLite cannot commit atomically; artifact reconciliation accepts only narrowly verified owned bytes. Arbitrary external exactly-once execution, power-loss durability, real CRM/email integrations, and production authorization are not established.

| Problem | Check |
| --- | --- |
| SQLite/native worker fails | Confirm Node 24.x and that npm uses it. This binding requires Node-API 10 |
| Live submission returns configuration error | Check the provider and matching key; restart after editing `.env` |
| Auth, quota, or temporary provider failure | Run `npm run model:smoke`; check its safe error code and provider project access/quota |
| Port already in use | Stop the earlier process or change `PORT`; Vite reads the same setting |
| Browser navigation denied | Configure only exact approved test origins; default is deny |
| Artifact cannot open | Read the verification error; missing or changed bytes must fail fresh checks |

## Engineering notes

- [Architecture and trust boundaries](docs/architecture.md)
- [Five-phase build plan](docs/BUILD_PLAN.md)
- [Test results and reproduction](docs/test-plan.md)
- [Foundation stack](docs/decisions/0001-foundation-stack.md)
- [Tool execution](docs/decisions/0002-local-tool-execution.md)
- [Durable runtime](docs/decisions/0003-durable-single-agent-runtime.md)
- [Gemini provider decision](docs/decisions/0004-gemini-default-provider.md)
