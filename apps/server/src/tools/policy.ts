import { z } from 'zod';
import { ApprovalRecordSchema, EmailDraftRecordSchema, SendEmailActionSchema, parseStoredJson, JsonObjectSchema } from '@centralign/shared';
import type { JsonValue, SendEmailAction } from '@centralign/shared';
import { canonicalJson } from '../persistence/json.js';
import { BusinessStore } from './business-store.js';
import { ToolFault } from './errors.js';
import type { HandlerContext, ToolMetadata } from './contracts.js';

export function canonicalSendAction(draft: z.infer<typeof EmailDraftRecordSchema>): SendEmailAction {
  return SendEmailActionSchema.parse({ type: 'send_email', draftId: draft.id, customerId: draft.customerId, projectId: draft.projectId, recipient: draft.recipient, subject: draft.subject, body: draft.body });
}
export function validateApproval(context: HandlerContext, approvalId: string, action: SendEmailAction): void {
  const raw = context.db.prepare('SELECT id,run_id AS runId,step_id AS stepId,action_json,policy_reason AS policyReason,status,requested_at AS requestedAt,expires_at AS expiresAt,decided_at AS decidedAt,decision_maker AS decisionMaker,decision_note AS decisionNote FROM approvals WHERE id=?').get(approvalId);
  if (!raw) throw new ToolFault('APPROVAL_REQUIRED', 'An exact persisted approval is required.', 'PERMISSION');
  try {
    const fields = z.record(z.string(), z.unknown()).parse(raw);
    const { action_json, ...record } = fields;
    const approval = ApprovalRecordSchema.parse({ ...record, action: parseStoredJson(z.string().parse(action_json), JsonObjectSchema) });
    const now = Date.parse(context.now());
    if (approval.status !== 'APPROVED' || approval.runId !== context.runId || (approval.stepId !== null && approval.stepId !== context.stepId) || !approval.decisionMaker || !approval.decidedAt || Date.parse(approval.decidedAt) > now || Date.parse(approval.decidedAt) < Date.parse(approval.requestedAt) || (approval.expiresAt !== null && (Date.parse(approval.expiresAt) <= now || Date.parse(approval.expiresAt) <= Date.parse(approval.decidedAt))) || canonicalJson(SendEmailActionSchema.parse(approval.action)) !== canonicalJson(action)) throw new Error('Approval mismatch');
  } catch { throw new ToolFault('APPROVAL_INVALID', 'Approval is unresolved, expired, invalid, or does not match the exact send action.', 'PERMISSION'); }
}
/** Called under the write transaction, before any handler or its side effects. */
export function enforceRiskPolicy(metadata: ToolMetadata, input: JsonValue, context: HandlerContext): void {
  if (metadata.risk !== 'external_side_effect' && metadata.name !== 'send_email') return;
  if (metadata.name !== 'send_email') throw new ToolFault('RISK_POLICY_DENIED', 'No server policy exists for this consequential action.', 'PERMISSION');
  const args = z.strictObject({ draftId: z.string().min(1), approvalId: z.string().min(1) }).parse(input);
  const draft = new BusinessStore(context.db).draft(args.draftId);
  if (draft.status !== 'DRAFT') throw new ToolFault('DRAFT_ALREADY_QUEUED', 'The draft has already been queued in the sandbox.');
  validateApproval(context, args.approvalId, canonicalSendAction(draft));
}
