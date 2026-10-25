import { AgentFault } from './contracts.js';
import type { PermissionScope } from '../tools/contracts.js';
import type { DeliverableCategorySchema } from '@centralign/shared';
import type { z } from 'zod';

const credentials = /sk-[a-zA-Z0-9_-]{12,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|Bearer\s+[a-zA-Z0-9._-]{20,}/g;
export function redactSecrets(text: string, secret?: string): string {
  const redacted = text.replace(credentials, '[REDACTED]');
  return secret ? redacted.replaceAll(secret, '[REDACTED]') : redacted;
}
export function rejectSecrets(text: string, secret?: string): void {
  if (redactSecrets(text, secret) !== text) throw new AgentFault('SENSITIVE_CONTENT', 'Credentials must remain in environment configuration, outside objectives and tool arguments.', 'VALIDATION');
}
export function permissionsForObjective(objective: string): PermissionScope[] {
  const scopes: PermissionScope[] = ['knowledge:read', 'customers:read', 'projects:read', 'tasks:read', 'email:read', 'browser:read'];
  if (/\b(onboard(?:ing)?|project)\b/i.test(objective)) scopes.push('projects:write');
  if (/\b(onboard(?:ing)?|checklist|tasks?)\b/i.test(objective)) scopes.push('tasks:write');
  if (/\b(onboard(?:ing)?|brief|report|artifact|document|summary)\b/i.test(objective)) scopes.push('artifacts:write');
  if (/\b(onboard(?:ing)?|email|welcome|draft|message)\b/i.test(objective)) scopes.push('email:draft');
  if (/\b(send|dispatch)\b/i.test(objective) && /\b(email|welcome|message)\b/i.test(objective) && !/\b(do not|don't|never|without|not to)\s+(?:actually\s+)?send(?:ing)?\b/i.test(objective)) scopes.push('email:send');
  return scopes;
}
export const categoryTool: Record<z.infer<typeof DeliverableCategorySchema>, readonly string[]> = {
  CUSTOMER: ['search_customers', 'get_customer_record'], CONTEXT: ['search_company_knowledge', 'read_company_document'],
  PROJECT: ['create_project'], TASKS: ['create_task'], ARTIFACT: ['write_artifact'], EMAIL_DRAFT: ['create_email_draft'], EMAIL_SEND: ['send_email'], ACTIVATION_READINESS: ['get_customer_record'],
};
