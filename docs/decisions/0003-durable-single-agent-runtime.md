# ADR 0003 — Durable sequential decisions with independent completion

Date: 2026-10-25. Status: Accepted for Phase 3.

Use official OpenAI Responses behind an injectable ModelProvider, strict structured output and independent server Zod/semantic validation. Production always uses the real provider; tests/demo explicitly inject a fake. Missing credentials reject submission before creating a run. References: [structured outputs](https://developers.openai.com/api/docs/guides/structured-outputs), [configured model](https://developers.openai.com/api/docs/models/gpt-6-sol).

Persist immutable required deliverables and advisory plan revisions. Ask for one next action from real observations rather than executing a fixed tool array. The model cannot discard failed requirements, grant authority or establish completion.

Extend SQLite with migration 0003 and preserve the Phase 2 executor. Durable lease fencing complements process single-flight. Semantic operation identity across steps plus the existing unique key and atomic local ledger prevent duplicates. Unknown writes require authoritative reconciliation; files only adopt existing matching owned bytes.

Persist exact approval previews and attributed answers. The loopback prototype uses a server-side local decision identity; authenticated multiuser authorization and the UI remain pending. Rejected sends cannot be silently proposed again.

Fresh business/file read-back decides step and goal success. Completion requests trigger verification; materials and activation readiness remain separate outcomes. Costs include extra reads, conservative scopes and bounded model context. Distributed external exactly-once execution and production durability are not claimed.
