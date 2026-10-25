# ADR 0001 — Small monolithic operator foundation

Date: 2026-10-25. Status: Accepted for the prototype.

## Context and decision

Build a local, single-process backend with a separate development frontend, organized as three npm workspaces. The prototype favors a **small monolithic application, a relational database, one dynamically acting agent in a later phase, and deterministic controls around tool execution**. Phase 1 does not introduce an agent or external integrations.

Choose Node 24.x LTS, strict TypeScript, React/Vite, Fastify, SQLite via better-sqlite3, Zod, Vitest, tsx, concurrently, and dotenv. Use current stable versions verified against the npm registry, pinned in the root lockfile. Node engines are restricted to 24.x; the available system Node 22 was incompatible, so validation uses an already available Node 24 runtime.

## Reasons and trade-offs

- npm workspaces and compiled shared ESM exports keep runtime schemas and frontend/backend types aligned without adding a task orchestrator. Root scripts enforce build order; shared changes are watched during development.
- Fastify provides a small HTTP surface, structured logs, and injection tests without real listening sockets. React/Vite provides a minimal dashboard and same-origin development proxy; production web hosting remains a future deployment choice.
- SQLite gives transactions, constraints, foreign keys, and a local audit ledger without a service dependency. better-sqlite3 is synchronous and requires a native binary; this suits small local workloads but needs reassessment for heavy concurrency. WAL and a bounded busy timeout reduce local contention; synchronous NORMAL is a local performance/durability trade-off, not a production guarantee.
- Parameterized SQL and immutable numbered migration modules keep persistence explicit. A transactional migration ledger with checksums catches drift. Repository text uses LF through .gitattributes for consistent cross-platform checkouts. No ORM or generic repository framework is needed for a health API and foundational schema.
- Zod owns runtime validation as well as inferred types; strict record objects reject unknown fields. JSON stored locally remains untrusted. SQL independently constrains enum values, relationships, and basic JSON shape, while future application services must enforce policy and legal transitions on writes.
- The model will suggest actions; deterministic server-side validation, durable exact-action approval, idempotency/reconciliation, and independent verification must control execution. A single dynamically acting agent is simpler to audit than multiple coordinating agents.

## Alternatives considered

Express would need more manual validation/logging/test wiring. A full-stack framework adds routing/deployment conventions beyond current needs. PostgreSQL adds a service dependency for a local proof of concept; a JSON-file store lacks relational integrity and transactional migrations. An ORM hides little complexity at this scale while adding another schema layer. Source-only shared exports simplify development but complicate compiled server startup. Separate services, agent frameworks, multiple agents, Docker, queues, vector databases, and cloud infrastructure lack a concrete Phase 1 requirement.

## Consequences

No authentication, production hosting, retrieval, LLM SDK, browser automation, email, full idempotent execution, or approval service ships in Phase 1. Future schema changes are additive migrations. Later phases must preserve the invariants in architecture.md, use the shared contracts, validate data at boundaries, and add testable capabilities only when required.

Compatibility references checked during implementation: [Vite getting started](https://vite.dev/guide/), [Fastify LTS policy](https://fastify.dev/docs/latest/Reference/LTS/), and [Zod API](https://zod.dev/api). The installed dependency versions and integrity hashes are recorded in package-lock.json; these upstream references do not replace local verification.
