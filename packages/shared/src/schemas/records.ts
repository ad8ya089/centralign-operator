import { z } from 'zod';
import { ApprovalStatusSchema, EventTypeSchema, MEMORY_SCOPES, MEMORY_TRUST_STATUSES, RunStatusSchema, StepStatusSchema, ToolExecutionStatusSchema } from '../domain/status.js';
import { ContentHashSchema, ExecutionErrorSchema, IdentifierSchema, JsonObjectSchema, JsonValueSchema, RelativePathSchema, UtcTimestampSchema } from './primitives.js';

const terminalRuns = new Set(['COMPLETED', 'PARTIAL', 'FAILED', 'CANCELLED']);

export const RunRecordSchema = z.strictObject({
  id: IdentifierSchema,
  objective: z.string().trim().min(1),
  status: RunStatusSchema,
  createdAt: UtcTimestampSchema,
  updatedAt: UtcTimestampSchema,
  completedAt: UtcTimestampSchema.nullable(),
  metadata: JsonObjectSchema,
  version: z.number().int().nonnegative(),
}).refine((run) => terminalRuns.has(run.status) === (run.completedAt !== null), 'Terminal runs require completedAt; active runs must have null completedAt');

export const RunStepRecordSchema = z.strictObject({
  id: IdentifierSchema,
  runId: IdentifierSchema,
  stepIndex: z.number().int().nonnegative(),
  description: z.string().trim().min(1),
  status: StepStatusSchema,
  input: JsonObjectSchema,
  output: JsonValueSchema.nullable(),
  attemptCount: z.number().int().nonnegative(),
  createdAt: UtcTimestampSchema,
  updatedAt: UtcTimestampSchema,
  startedAt: UtcTimestampSchema.nullable(),
  completedAt: UtcTimestampSchema.nullable(),
  error: ExecutionErrorSchema.nullable(),
});

export const RunEventRecordSchema = z.strictObject({
  id: IdentifierSchema,
  runId: IdentifierSchema,
  stepId: IdentifierSchema.nullable(),
  type: EventTypeSchema,
  payload: JsonObjectSchema,
  createdAt: UtcTimestampSchema,
});

export const ApprovalRecordSchema = z.strictObject({
  id: IdentifierSchema,
  runId: IdentifierSchema,
  stepId: IdentifierSchema.nullable(),
  action: JsonObjectSchema,
  policyReason: z.string().trim().min(1),
  status: ApprovalStatusSchema,
  requestedAt: UtcTimestampSchema,
  expiresAt: UtcTimestampSchema.nullable(),
  decidedAt: UtcTimestampSchema.nullable(),
  decisionMaker: IdentifierSchema.nullable(),
  decisionNote: z.string().nullable(),
}).refine((approval) =>
  approval.status === 'PENDING'
    ? approval.decidedAt === null && approval.decisionMaker === null && approval.decisionNote === null
    : approval.decidedAt !== null && (approval.status !== 'APPROVED' && approval.status !== 'REJECTED' || approval.decisionMaker !== null),
'Pending approvals have no decision; resolved approvals require a timestamp and human decisions require a decision maker');

export const ToolExecutionRecordSchema = z.strictObject({
  id: IdentifierSchema,
  runId: IdentifierSchema,
  stepId: IdentifierSchema,
  toolName: z.string().trim().min(1),
  idempotencyKey: IdentifierSchema,
  arguments: JsonObjectSchema,
  result: JsonValueSchema.nullable(),
  error: ExecutionErrorSchema.nullable(),
  status: ToolExecutionStatusSchema,
  attemptNumber: z.number().int().positive(),
  createdAt: UtcTimestampSchema,
  updatedAt: UtcTimestampSchema,
  startedAt: UtcTimestampSchema.nullable(),
  completedAt: UtcTimestampSchema.nullable(),
});

export const CompanyDocumentRecordSchema = z.strictObject({
  id: IdentifierSchema,
  title: z.string().trim().min(1),
  sourcePath: RelativePathSchema,
  contentHash: ContentHashSchema,
  metadata: JsonObjectSchema,
  createdAt: UtcTimestampSchema,
  updatedAt: UtcTimestampSchema,
});

export const ArtifactRecordSchema = z.strictObject({
  id: IdentifierSchema,
  runId: IdentifierSchema,
  stepId: IdentifierSchema.nullable(),
  name: z.string().trim().min(1),
  path: RelativePathSchema,
  mimeType: z.string().regex(/^[\w.+-]+\/[\w.+-]+$/),
  contentHash: ContentHashSchema,
  metadata: JsonObjectSchema,
  createdAt: UtcTimestampSchema,
});

export const SourceReferenceSchema = z.strictObject({
  kind: z.enum(['COMPANY_DOCUMENT', 'RUN_EVENT', 'ARTIFACT', 'HUMAN_NOTE']),
  sourceId: IdentifierSchema,
  locator: z.string().nullable(),
});
export const MemoryEntryRecordSchema = z.strictObject({
  id: IdentifierSchema,
  scope: z.enum(MEMORY_SCOPES),
  scopeId: IdentifierSchema.nullable(),
  content: z.string().trim().min(1),
  sourceReferences: z.array(SourceReferenceSchema),
  trustStatus: z.enum(MEMORY_TRUST_STATUSES),
  createdAt: UtcTimestampSchema,
  updatedAt: UtcTimestampSchema,
  reviewedAt: UtcTimestampSchema.nullable(),
  reviewedBy: IdentifierSchema.nullable(),
}).refine((entry) => (entry.scope === 'COMPANY') === (entry.scopeId === null), 'Company scope has null scopeId; customer and run scopes require an ID')
  .refine((entry) => entry.trustStatus === 'PROVISIONAL'
    ? entry.reviewedAt === null && entry.reviewedBy === null
    : entry.reviewedAt !== null && entry.reviewedBy !== null,
  'Reviewed trust states require explicit review attribution');

export type RunRecord = z.infer<typeof RunRecordSchema>;
export type RunStepRecord = z.infer<typeof RunStepRecordSchema>;
export type RunEventRecord = z.infer<typeof RunEventRecordSchema>;
export type ApprovalRecord = z.infer<typeof ApprovalRecordSchema>;
export type ToolExecutionRecord = z.infer<typeof ToolExecutionRecordSchema>;
export type CompanyDocumentRecord = z.infer<typeof CompanyDocumentRecordSchema>;
export type ArtifactRecord = z.infer<typeof ArtifactRecordSchema>;
export type MemoryEntryRecord = z.infer<typeof MemoryEntryRecordSchema>;
