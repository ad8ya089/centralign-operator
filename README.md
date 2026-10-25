# CentrAlign Operator

Phase 2 of a five-phase proof of concept: an autonomous enterprise operator designed to complete verified business work. This increment provides source-backed company context and deterministic server tools on the tested Phase 1 foundation.

Implemented: shared contracts, versioned SQLite persistence, company indexing/search, customer/project/task tools, restricted artifacts, draft/outbox operations with exact persisted approval checks, and read-only restricted browser sessions. The web app remains a live health dashboard. Autonomous planning, LLM calls, real email delivery, approval decision interfaces, and independent business verification are **not implemented**.

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

Both `.env` and relative database paths resolve from the repository root, discovered from the server module location in either `src` or `dist`. The database parent directory is created automatically. Runtime databases, WAL sidecars, credentials, and build outputs are ignored. No API key is needed.

The Vite proxy reads backend `HOST` and `PORT` from root configuration. Browser requests use `/api/v1/health`; no permissive CORS is configured. Only `VITE_` variables are exposed by Vite: never put secrets in variables with that prefix.

## Commands

| Command | Behavior |
| --- | --- |
| `npm run dev` | Build shared, then watch shared, Fastify (`tsx`), and Vite together |
| `npm run db:migrate` | Build shared, open SQLite, apply the same migrations as startup, report schema versions, close |
| `npm run db:seed` | Insert missing fictional customers and atomically refresh changed source indexes; preserve business edits |
| `npm run tools:smoke` | Run an isolated deterministic tool workflow, including trusted test approval and sandbox outbox read-back |
| `npm run typecheck` | Build shared, strictly check shared/server/web sources, tests, and build configuration |
| `npm test` | Build shared and run deterministic Vitest suites against temporary databases |
| `npm run build` | Build shared first, then server and web |
| `npm run verify` | Typecheck → tests → production builds; stop on any failure |

After `npm run build`, `npm run start --workspace @centralign/server` runs the compiled backend and resolves the same repository-relative configuration. The web output is `apps/web/dist`. Production web hosting and a production reverse proxy are outside Phase 1; the backend does not serve the web build. Workspaces are private and are not published.

Phase 1 acceptance passed on 2026-10-25 with Node 24.19.0 and npm 10.9.2: strict typecheck, 71 tests, production builds, full verify, migration CLI, live dashboard/retry/offline recovery, and compiled backend startup from another directory. All smoke-test processes were stopped. See docs/test-plan.md for the actual validation record, resolved failures, and limits.

Stage A subsequently reproduced the unsupported-Node worker crash and added runtime guards; the supported baseline passed 72 tests and verify. Phase 2 acceptance then passed with 124 tests/13 files (including six real browser tests and an independent-process race), strict checks, production builds, full verify, isolated tools:smoke, repeatable migration/seed CLI, and development launch/shutdown. Phases 3–5 remain pending.

## Layout and handoff

- `packages/shared/src`: canonical states, records, JSON/runtime validation, health/error schemas, and pure transition rules.
- `apps/server/src`: root-aware environment configuration, SQLite lifecycle, migration runner/CLI, testable Fastify construction, and socket entry point.
- `apps/web/src`: dashboard, reusable health client, and explicit loading/healthy/degraded/request-error states with manual retry.
- `fixtures/company`: three fictional sources indexed by the explicit seed command; never permission grants.
- [Architecture](docs/architecture.md), [five-phase build plan](docs/BUILD_PLAN.md), [test plan](docs/test-plan.md), and [stack decision](docs/decisions/0001-foundation-stack.md).

Phase 3 should read these documents, shared exports/business schemas, tools/index.ts, tools/contracts.ts, tools/executor.ts, tools/policy.ts, and migrations 0001/0002 before making changes. Use createToolLayer(db, config), call executor.execute with trusted run/step/actor/scopes/key/deadline context, and close the layer's browser resources. The caller owns the database. There is deliberately no public generic tool endpoint and no automatic seed/startup workflow.

Preserve the shared-first build, single lockfile, Node 24 guard, persisted-state authority, exact-action approval, idempotency identity, and additive migrations. Do not edit applied migration SQL; checksums reject drift. A tool success or SANDBOX_QUEUED message is not final verified business completion or real email delivery.
