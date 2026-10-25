import { z } from 'zod';
import { RunStatusSchema } from '../domain/status.js';
import { IdentifierSchema, UtcTimestampSchema } from './primitives.js';
export const EVALUATION_SCENARIOS = ['normal-onboarding', 'missing-security-prerequisite', 'ambiguous-customer', 'transient-read', 'ambiguous-write', 'invalid-model-output', 'approval-refusal', 'stale-approval', 'malicious-document', 'failed-verification', 'restart-waiting', 'resource-budgets'] as const;
export const EvaluationScenarioSchema = z.enum(EVALUATION_SCENARIOS);
export type EvaluationScenario = z.infer<typeof EvaluationScenarioSchema>;
const count = z.number().int().nonnegative();
const usage = z.strictObject({ inputTokens: count.nullable(), outputTokens: count.nullable(), totalTokens: count.nullable() });
export const EvaluationRunSchema = z.strictObject({ runId: IdentifierSchema, databaseId: z.string().regex(/^[a-f0-9]{64}$/), status: RunStatusSchema,
  iterations: count, requiredDeliverables: count, verifiedDeliverables: count, incompleteDeliverables: count, failedChecks: count,
  duplicateMutations: count, approvalBypasses: count, falseCompletionClaims: count, modelCalls: count, toolCalls: count, recoveries: count, durationMs: count,
  mutations: z.strictObject({ projects: count, tasks: count, artifacts: count, drafts: count, outbox: count }), usage, allSafetyInvariantsHeld: z.boolean(),
});
export type EvaluationRun = z.infer<typeof EvaluationRunSchema>;
export const EvaluationCaseSchema = z.strictObject({ scenario: EvaluationScenarioSchema, repetition: count.min(1).max(10), passed: z.boolean(), issues: z.array(z.string().min(1).max(500)).max(30), runs: z.array(EvaluationRunSchema).max(10), durationMs: count });
export const EvaluationReportSchema = z.strictObject({ version: z.literal(1), id: IdentifierSchema, provider: z.literal('explicit-fake-model'), sandboxOnly: z.literal(true), startedAt: UtcTimestampSchema, finishedAt: UtcTimestampSchema, durationMs: count, repetitions: count.min(1).max(10), results: z.array(EvaluationCaseSchema).max(120),
  summary: z.strictObject({ scenarioExecutions: count, totalRuns: count, passed: count, failed: count, duplicateMutations: count, approvalBypasses: count, falseCompletionClaims: count, modelCalls: count, toolCalls: count, recoveries: count, usage, allSafetyInvariantsHeld: z.boolean() }),
});
export type EvaluationReport = z.infer<typeof EvaluationReportSchema>;
