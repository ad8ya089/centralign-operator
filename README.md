# CentrAlign Operator

Phase 1 of a five-phase proof of concept: an autonomous enterprise operator designed to complete verified business work. This increment provides real shared contracts, versioned local persistence, a database-backed health API, and a connected dashboard.

Autonomous planning, LLM calls, company retrieval, business tools, email sending, approval workflows, and independent business verification are **not implemented**.

## Setup

Use **Node.js 24.x LTS** and npm 10 or newer. Check `node --version` and `npm --version` first. `.nvmrc` selects 24 for compatible version managers, and `.npmrc` rejects incompatible installations. A system Node 22 installation must be switched to Node 24; this project does not target Node 22.

Run all commands from the repository root:

```text
npm install
npm run db:migrate
npm run dev
```

Open [the dashboard](http://127.0.0.1:5173). The API listens at [the health endpoint](http://127.0.0.1:3001/api/v1/health). Keep the terminal open; Ctrl+C stops the shared compiler, backend, and frontend together. `concurrently --kill-others` also stops sibling processes if any development process exits.

The root has one `package-lock.json`. Use `npm ci` for a clean reproducible installation after checkout. Do not install dependencies separately inside workspaces or create nested lockfiles.

## Environment

Defaults work without `.env`. Optionally copy `.env.example` to `.env` (PowerShell: `Copy-Item .env.example .env`) and edit it. Existing process environment variables take precedence. Restart development after changing configuration.

| Variable | Default | Meaning |
| --- | --- | --- |
| `NODE_ENV` | `development` | `development`, `test`, or `production` |
| `HOST` | `127.0.0.1` | Backend bind address; keep loopback for this unauthenticated foundation |
| `PORT` | `3001` | Backend port, integer 1–65535 |
| `LOG_LEVEL` | `info` | Pino level: fatal/error/warn/info/debug/trace/silent |
| `DATABASE_PATH` | `.data/centralign.sqlite` | Absolute path or path relative to the repository root |

Both `.env` and relative database paths resolve from the repository root, discovered from the server module location in either `src` or `dist`. The database parent directory is created automatically. Runtime databases, WAL sidecars, credentials, and build outputs are ignored. No API key is needed.

The Vite proxy reads backend `HOST` and `PORT` from root configuration. Browser requests use `/api/v1/health`; no permissive CORS is configured. Only `VITE_` variables are exposed by Vite: never put secrets in variables with that prefix.

## Commands

| Command | Behavior |
| --- | --- |
| `npm run dev` | Build shared, then watch shared, Fastify (`tsx`), and Vite together |
| `npm run db:migrate` | Build shared, open SQLite, apply the same migrations as startup, report schema versions, close |
| `npm run typecheck` | Build shared, strictly check shared/server/web sources, tests, and build configuration |
| `npm test` | Build shared and run deterministic Vitest suites against temporary databases |
| `npm run build` | Build shared first, then server and web |
| `npm run verify` | Typecheck → tests → production builds; stop on any failure |

After `npm run build`, `npm run start --workspace @centralign/server` runs the compiled backend and resolves the same repository-relative configuration. The web output is `apps/web/dist`. Production web hosting and a production reverse proxy are outside Phase 1; the backend does not serve the web build. Workspaces are private and are not published.

Phase 1 acceptance passed on 2026-10-25 with Node 24.19.0 and npm 10.9.2: strict typecheck, 71 tests, production builds, full verify, migration CLI, live dashboard/retry/offline recovery, and compiled backend startup from another directory. All smoke-test processes were stopped. See docs/test-plan.md for the actual validation record, resolved failures, and limits.

## Layout and handoff

- `packages/shared/src`: canonical states, records, JSON/runtime validation, health/error schemas, and pure transition rules.
- `apps/server/src`: root-aware environment configuration, SQLite lifecycle, migration runner/CLI, testable Fastify construction, and socket entry point.
- `apps/web/src`: dashboard, reusable health client, and explicit loading/healthy/degraded/request-error states with manual retry.
- `fixtures/company`: three fictional sources for the future Acme onboarding scenario; no ingestion happens yet.
- [Architecture](docs/architecture.md), [five-phase build plan](docs/BUILD_PLAN.md), [test plan](docs/test-plan.md), and [stack decision](docs/decisions/0001-foundation-stack.md).

Prompt 2 should read these documents, shared exports, migration 0001, and `createApp` before making changes. Preserve the shared-first build, single root lockfile, persisted-state authority, trust boundaries, and additive migrations. Do not edit an already-applied migration; checksums deliberately reject drift.
