import { z } from 'zod';
import { IdentifierSchema, JsonObjectSchema, JsonValueSchema, UtcTimestampSchema } from './primitives.js';
import { ApprovalRecordSchema, ArtifactRecordSchema, RunEventRecordSchema, RunRecordSchema, RunStepRecordSchema } from './records.js';

const text = z.string().min(1).max(1000);
export const DeliverableCategorySchema = z.enum(['CUSTOMER', 'CONTEXT', 'PROJECT', 'TASKS', 'ARTIFACT', 'EMAIL_DRAFT', 'EMAIL_SEND', 'ACTIVATION_READINESS']);
export const DeliverableSchema = z.strictObject({ id: IdentifierSchema.max(80), description: text, category: DeliverableCategorySchema, minCount: z.number().int().min(1).max(20), sourceRequired: z.boolean() });
export const QuestionProposalSchema = z.strictObject({ text, reason: text, topic: z.enum(['CUSTOMER_IDENTITY', 'MISSING_INFORMATION', 'RECONCILIATION']), choices: z.array(z.strictObject({ id: IdentifierSchema.max(200), label: z.string().min(1).max(200) })).max(20) });
export const GoalSpecificationSchema = z.strictObject({
  summary: text, intent: z.enum(['ONBOARDING', 'PREPARE_BRIEF', 'PROJECT_SETUP', 'COMMUNICATION', 'GENERAL']),
  entities: z.array(z.strictObject({ name: z.string().min(1).max(200), type: z.literal('customer'), unresolved: z.boolean() })).max(10),
  deliverables: z.array(DeliverableSchema).min(1).max(20), constraints: z.array(text).max(20), questions: z.array(QuestionProposalSchema).max(10),
}).refine((goal) => new Set(goal.deliverables.map((item) => item.id)).size === goal.deliverables.length, 'Deliverable IDs must be unique');
export const PlanSchema = z.strictObject({
  summary: text,
  milestones: z.array(z.strictObject({ id: IdentifierSchema.max(80), description: text, deliverableIds: z.array(IdentifierSchema.max(80)).min(1).max(20), prerequisites: z.array(z.string().min(1).max(300)).max(10) })).min(1).max(20),
  blocked: z.array(z.strictObject({ deliverableId: IdentifierSchema.max(80), reason: text })).max(20),
}).refine((plan) => new Set(plan.milestones.map((item) => item.id)).size === plan.milestones.length, 'Milestone IDs must be unique');
export const NextActionSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('tool'), toolName: z.string().regex(/^[a-z][a-z0-9_]{1,63}$/), argumentsJson: z.string().min(2).max(50000), purpose: text, deliverableIds: z.array(IdentifierSchema.max(80)).max(20), expectedOutcome: text, revisedPlan: PlanSchema.nullable() }),
  z.strictObject({ kind: z.literal('question'), question: QuestionProposalSchema, revisedPlan: PlanSchema.nullable() }),
  z.strictObject({ kind: z.literal('complete'), summary: text, revisedPlan: PlanSchema.nullable() }),
]);
// Structured output roots are objects; tool arguments remain JSON text until the actual registry validates them.
export const NextActionEnvelopeSchema = z.strictObject({ decision: NextActionSchema });
export const VerificationCheckSchema = z.strictObject({
  id: IdentifierSchema, targetId: IdentifierSchema, passed: z.boolean(), explanation: text,
  expected: JsonValueSchema, observed: JsonValueSchema, evidence: z.array(z.strictObject({ kind: z.string().min(1), id: IdentifierSchema, reference: z.string().min(1), metadata: JsonObjectSchema })).max(50),
  repairable: z.boolean(), createdAt: UtcTimestampSchema,
});
export const PendingQuestionSchema = QuestionProposalSchema.extend({ id: IdentifierSchema, runId: IdentifierSchema, status: z.enum(['PENDING', 'ANSWERED', 'CANCELLED']), answer: z.string().max(4000).nullable(), choiceId: IdentifierSchema.nullable(), createdAt: UtcTimestampSchema, answeredAt: UtcTimestampSchema.nullable() });
export const FinalResultSchema = z.strictObject({
  summary: text, verified: z.array(z.strictObject({ deliverableId: IdentifierSchema, description: text, evidenceIds: z.array(IdentifierSchema).max(50) })).max(20),
  outstanding: z.array(z.strictObject({ deliverableId: IdentifierSchema, reason: text })).max(20),
  unverifiedStepIds: z.array(IdentifierSchema).max(200), neverExecuted: z.array(IdentifierSchema).max(20), warnings: z.array(text).max(20),
});
export const RunSnapshotSchema = z.strictObject({
  run: RunRecordSchema, goal: GoalSpecificationSchema.nullable(), plan: PlanSchema.nullable(), planRevision: z.number().int().nonnegative(),
  steps: z.array(RunStepRecordSchema).max(200), currentStepId: IdentifierSchema.nullable(),
  pendingQuestions: z.array(PendingQuestionSchema).max(10), pendingApprovals: z.array(ApprovalRecordSchema).max(10),
  verification: z.array(VerificationCheckSchema).max(200), finalResult: FinalResultSchema.nullable(),
  artifacts: z.array(ArtifactRecordSchema).max(100),
  budgets: z.strictObject({ modelCalls: z.number().int().nonnegative(), toolCalls: z.number().int().nonnegative(), recoveries: z.number().int().nonnegative(), replans: z.number().int().nonnegative(), deadlineAt: UtcTimestampSchema }),
});
export const RunEventsPageSchema = z.strictObject({ events: z.array(RunEventRecordSchema).max(100), nextCursor: z.number().int().nonnegative().nullable() });
export const CreateRunRequestSchema = z.strictObject({ objective: z.string().min(1).max(8000).refine((value) => value.trim().length > 0, 'Objective must not be blank') });
export const SubmitInputSchema = z.strictObject({ questionId: IdentifierSchema.max(200), answer: z.string().trim().min(1).max(4000), choiceId: IdentifierSchema.max(200).nullable().default(null) });
export const ApprovalDecisionRequestSchema = z.strictObject({ decision: z.enum(['APPROVED', 'REJECTED']), note: z.string().max(1000).nullable().default(null) });
export type GoalSpecification = z.infer<typeof GoalSpecificationSchema>;
export type Deliverable = z.infer<typeof DeliverableSchema>;
export type Plan = z.infer<typeof PlanSchema>;
export type NextAction = z.infer<typeof NextActionSchema>;
export type QuestionProposal = z.infer<typeof QuestionProposalSchema>;
export type PendingQuestion = z.infer<typeof PendingQuestionSchema>;
export type VerificationCheck = z.infer<typeof VerificationCheckSchema>;
export type FinalResult = z.infer<typeof FinalResultSchema>;
export type RunSnapshot = z.infer<typeof RunSnapshotSchema>;
