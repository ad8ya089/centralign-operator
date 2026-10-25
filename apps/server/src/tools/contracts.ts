import { z } from 'zod';
import type Database from 'better-sqlite3';
import type { JsonValue } from '@centralign/shared';
import { IdentifierSchema, JsonObjectSchema, JsonValueSchema } from '@centralign/shared';
import type { ArtifactStore } from './artifacts.js';
import type { RestrictedBrowser } from '../browser/adapter.js';
import type { FailureCategory, Retryability } from './errors.js';

export const PERMISSION_SCOPES = ['knowledge:read', 'customers:read', 'projects:read', 'projects:write', 'tasks:read', 'tasks:write', 'artifacts:write', 'email:read', 'email:draft', 'email:send', 'browser:read'] as const;
export const PermissionScopeSchema = z.enum(PERMISSION_SCOPES);
export type PermissionScope = z.infer<typeof PermissionScopeSchema>;
export const ToolMetadataSchema = z.strictObject({
  name: z.string().regex(/^[a-z][a-z0-9_]{1,63}$/), description: z.string().min(10),
  risk: z.enum(['read', 'reversible_write', 'external_side_effect']),
  requiredScopes: z.array(PermissionScopeSchema).min(1), timeoutMs: z.number().int().min(1).max(30000),
  retry: z.enum(['safe_read', 'idempotent_local', 'reconcile_before_retry']),
  changesPersistentState: z.boolean(), persistence: z.enum(['none', 'sqlite', 'filesystem']),
});
export type ToolMetadata = Readonly<Omit<z.infer<typeof ToolMetadataSchema>, 'requiredScopes'> & { requiredScopes: readonly PermissionScope[] }>;
export const EvidenceSchema = z.strictObject({ kind: z.enum(['document', 'customer', 'project', 'task', 'artifact', 'draft', 'outbox', 'browser']), id: IdentifierSchema, reference: z.string().min(1), metadata: JsonObjectSchema });
export type Evidence = z.infer<typeof EvidenceSchema>;
export interface ToolValue<T> { data: T; evidence: Evidence[] }
/** Constructed exclusively by trusted server code; never derive scopes, clock, or workspace from model arguments. */
export interface ExecutionContext {
  readonly runId: string; readonly stepId: string; readonly actorId: string;
  readonly grantedScopes: readonly PermissionScope[]; readonly idempotencyKey: string | null;
  readonly deadline: number; readonly signal?: AbortSignal; readonly clock?: () => Date;
  /** Optional trusted runtime lease/cancellation fence, rechecked inside each write transaction. */
  readonly assertAuthority?: () => void;
}
export interface HandlerContext {
  readonly db: Database.Database; readonly runId: string; readonly stepId: string; readonly actorId: string;
  readonly executionId: string; readonly signal: AbortSignal; readonly deadline: number; readonly now: () => string;
  readonly artifacts: ArtifactStore; readonly browser: RestrictedBrowser | undefined;
}
export interface ToolDefinition<I, O> {
  readonly metadata: ToolMetadata; readonly inputSchema: z.ZodType<I>; readonly resultSchema: z.ZodType<O>;
  readonly handler: (input: I, context: HandlerContext) => ToolValue<O> | Promise<ToolValue<O>>;
  /** Filesystem tools can reconcile an existing owned file, but must never write a new file here. */
  readonly reconcile?: (input: I, context: HandlerContext) => ToolValue<O>;
}
export type ToolOutcome =
  | { ok: true; executionId: string; data: JsonValue; evidence: Evidence[]; replayed: boolean }
  | { ok: false; executionId: string | null; error: { category: FailureCategory; code: string; message: string; retryability: Retryability } };
export const ToolOutcomeSchema = z.discriminatedUnion('ok', [
  z.strictObject({ ok: z.literal(true), executionId: IdentifierSchema, data: JsonValueSchema, evidence: z.array(EvidenceSchema), replayed: z.boolean() }),
  z.strictObject({ ok: z.literal(false), executionId: IdentifierSchema.nullable(), error: z.strictObject({ category: z.enum(['VALIDATION', 'BUSINESS_RULE', 'PERMISSION', 'TRANSIENT', 'PERMANENT', 'UNKNOWN_OUTCOME']), code: z.string().min(1), message: z.string().min(1), retryability: z.enum(['NEVER', 'SAFE_READ', 'RECONCILE']) }) }),
]);
