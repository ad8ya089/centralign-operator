import { z } from 'zod';
import { ContentHashSchema, IdentifierSchema, JsonObjectSchema, RelativePathSchema, UtcTimestampSchema } from './primitives.js';

const timestamps = { createdAt: UtcTimestampSchema, updatedAt: UtcTimestampSchema };
export const CustomerRecordSchema = z.strictObject({
  id: IdentifierSchema, companyName: z.string().min(1), normalizedName: z.string().min(1),
  contactName: z.string().nullable(), contactEmail: z.email().nullable(),
  status: z.enum(['NEW', 'ONBOARDING', 'BLOCKED', 'READY', 'ACTIVE']), metadata: JsonObjectSchema, ...timestamps,
});
export const ProjectRecordSchema = z.strictObject({
  id: IdentifierSchema, customerId: IdentifierSchema, name: z.string().min(1),
  status: z.enum(['PLANNED', 'ACTIVE', 'COMPLETED', 'CANCELLED']), metadata: JsonObjectSchema, ...timestamps,
});
export const TaskRecordSchema = z.strictObject({
  id: IdentifierSchema, projectId: IdentifierSchema, title: z.string().min(1), description: z.string(),
  status: z.enum(['PENDING', 'IN_PROGRESS', 'BLOCKED', 'COMPLETED', 'CANCELLED']), metadata: JsonObjectSchema, ...timestamps,
});
export const EmailDraftRecordSchema = z.strictObject({
  id: IdentifierSchema, customerId: IdentifierSchema, projectId: IdentifierSchema.nullable(),
  recipient: z.email(), subject: z.string().min(1), body: z.string().min(1),
  status: z.enum(['DRAFT', 'QUEUED']), ...timestamps,
});
export const OutboxRecordSchema = z.strictObject({
  id: IdentifierSchema, draftId: IdentifierSchema, approvalId: IdentifierSchema, executionId: IdentifierSchema,
  recipient: z.email(), subject: z.string().min(1), body: z.string().min(1),
  status: z.literal('SANDBOX_QUEUED'), createdAt: UtcTimestampSchema,
});
export const DocumentCitationSchema = z.strictObject({
  documentId: IdentifierSchema, contentHash: ContentHashSchema, chunkId: IdentifierSchema.nullable(),
});
export const KnowledgeHitSchema = z.strictObject({
  documentId: IdentifierSchema, title: z.string().min(1), sourcePath: RelativePathSchema,
  contentHash: ContentHashSchema, chunkId: IdentifierSchema, chunkIndex: z.number().int().nonnegative(),
  heading: z.string().nullable(), excerpt: z.string().max(1200), trust: z.literal('untrusted_source'),
});
export const IndexedDocumentSchema = z.strictObject({
  id: IdentifierSchema, title: z.string().min(1), sourcePath: RelativePathSchema, contentHash: ContentHashSchema,
  content: z.string().max(131072), indexedAt: UtcTimestampSchema, trust: z.literal('untrusted_source'),
});
export const SendEmailActionSchema = z.strictObject({
  type: z.literal('send_email'), draftId: IdentifierSchema, customerId: IdentifierSchema,
  projectId: IdentifierSchema.nullable(), recipient: z.email(), subject: z.string().min(1), body: z.string().min(1),
});
export type CustomerRecord = z.infer<typeof CustomerRecordSchema>;
export type ProjectRecord = z.infer<typeof ProjectRecordSchema>;
export type TaskRecord = z.infer<typeof TaskRecordSchema>;
export type EmailDraftRecord = z.infer<typeof EmailDraftRecordSchema>;
export type OutboxRecord = z.infer<typeof OutboxRecordSchema>;
export type KnowledgeHit = z.infer<typeof KnowledgeHitSchema>;
export type IndexedDocument = z.infer<typeof IndexedDocumentSchema>;
export type SendEmailAction = z.infer<typeof SendEmailActionSchema>;
