# ADR 0004 — Gemini default with bounded application decisions

Date: 2026-10-26. Status: Accepted for implementation; observed live validation is recorded in test-plan.md.

Use the official @google/genai SDK, pinned to 2.31.0, behind the existing ModelProvider contract. MODEL_PROVIDER defaults to gemini with gemini-3.8-flash; openai explicitly selects the preserved Responses adapter. Official [model documentation](https://ai.google.dev/gemini-api/docs/models) confirms the configured model. Missing credentials or provider failures must never substitute a fake or another provider.

Use models.generateContent with responseMimeType application/json and responseJsonSchema. Translate supported JSON Schema grammar, then validate parsed output with the original Zod and semantic checks. The server retains authority over tool execution, scopes, budgets, human decisions, and independent verification. Structured generation cannot establish that a proposed action is authorized or a deliverable exists.

Disable automatic function calling, continuation, SDK retries, storage, and thought output. Bound response bytes, output tokens, cancellation, and timeouts. Persist safe hashes, provider/model, latency, status, and supplied token counts through additive migration 0004. No raw provider errors or private reasoning are recorded. Preserve migrations 0001–0003.

Map failures to the existing runtime categories. Retry short explicit rate limits and temporary service failures only within the shared recovery budget and deadline; fail conservatively on daily, zero, or unclear quota. Never enable billing, change tiers, or switch providers automatically. A separate model:smoke command exercises only a synthetic structured response without business tools or persistence.

The free tier supports prototype experimentation, with quotas and access subject to change. Google's [pricing](https://ai.google.dev/gemini-api/docs/pricing) and [terms](https://ai.google.dev/gemini-api/terms) distinguish unpaid and paid services. Unpaid content may support product improvement and human review. The README and submission UI require fictional or explicitly approved test data and explain that the key does not establish billing status. This prototype cannot promise confidentiality for unpaid-tier content.

Tradeoffs: schema conversion needs adapter tests, provider availability is external, and deterministic evaluations do not establish live model quality or cost. OpenAI remains an optional compatibility path. No orchestration rewrite, second agent, external database, or real email integration is introduced.

Implementation references: [structured output](https://ai.google.dev/gemini-api/docs/structured-output), [official SDK](https://github.com/googleapis/js-genai), [GenerateContentConfig](https://googleapis.github.io/js-genai/release_docs/interfaces/types.GenerateContentConfig.html), and [HttpOptions](https://googleapis.github.io/js-genai/release_docs/interfaces/types.HttpOptions.html).
