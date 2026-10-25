import type { GoalSpecification, Plan } from '@centralign/shared';
import type { PermissionScope } from '../tools/contracts.js';
import { AgentFault } from './contracts.js';
import { categoryTool } from './security.js';
import type { ToolRegistry } from '../tools/registry.js';

export function validateGoal(goal: GoalSpecification, objective: string, scopes: readonly PermissionScope[], registry: ToolRegistry): void {
  for (const deliverable of goal.deliverables) {
    if (deliverable.category === 'ACTIVATION_READINESS') continue;
    if (!categoryTool[deliverable.category].some((name) => registry.resolve(name).metadata.requiredScopes.every((scope) => scopes.includes(scope)))) throw new AgentFault('UNAUTHORIZED_GOAL', 'A proposed deliverable exceeds the original request permissions.', 'VALIDATION');
  }
  const required: [RegExp, string][] = [];
  if (scopes.includes('projects:write')) required.push([/\bproject\b/i, 'PROJECT']);
  if (scopes.includes('tasks:write')) required.push([/\b(checklist|tasks?)\b/i, 'TASKS']);
  if (scopes.includes('artifacts:write')) required.push([/\b(brief|report|artifact)\b/i, 'ARTIFACT']);
  if (scopes.includes('email:send')) required.push([/\b(send|dispatch)\b/i, 'EMAIL_SEND']);
  for (const [pattern, category] of required) if (pattern.test(objective) && !goal.deliverables.some((item) => item.category === category)) throw new AgentFault('GOAL_OMITS_REQUEST', 'The interpreted goal omitted an explicitly requested outcome.', 'VALIDATION');
  if (goal.deliverables.some((item) => item.category === 'EMAIL_SEND') && !scopes.includes('email:send')) throw new AgentFault('SEND_NOT_REQUESTED', 'The original request does not authorize sending an email.', 'VALIDATION');
  if (goal.deliverables.some((item) => item.category === 'ACTIVATION_READINESS') && !/\b(activate|activation|ready)\b/i.test(objective)) throw new AgentFault('ACTIVATION_NOT_REQUESTED', 'Activation readiness is a separate outcome from preparing onboarding materials.', 'VALIDATION');
  if (/with sources|source-backed|sourced|citations?/i.test(objective) && goal.deliverables.some((item) => item.category === 'ARTIFACT' && !item.sourceRequired)) throw new AgentFault('SOURCES_REQUIRED', 'The source-backed deliverable must require source evidence.', 'VALIDATION');
}
export function validatePlan(plan: Plan, goal: GoalSpecification): void {
  const required = new Set(goal.deliverables.map((item) => item.id));
  const covered = new Set([...plan.milestones.flatMap((item) => item.deliverableIds), ...plan.blocked.map((item) => item.deliverableId)]);
  if ([...covered].some((id) => !required.has(id)) || [...required].some((id) => !covered.has(id))) throw new AgentFault('PLAN_COVERAGE', 'Every required deliverable must be covered or explicitly blocked; unknown deliverables are invalid.', 'VALIDATION');
}
