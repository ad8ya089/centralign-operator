import { z } from 'zod';
import { GoalSpecificationSchema, JsonValueSchema, PlanSchema } from '@centralign/shared';
import type { GoalSpecification, NextAction, Plan } from '@centralign/shared';
import type { StructuredModelRequest } from '../contracts.js';
import { FakeModelProvider } from '../fake-model-provider.js';

export const ONBOARDING_OBJECTIVE = 'Onboard Acme Logistics using our CRM and onboarding SOP. Create the onboarding project and checklist, prepare an onboarding brief with sources, draft and send the welcome email.';
export const demoGoal: GoalSpecification = GoalSpecificationSchema.parse({ summary: 'Prepare verified Acme onboarding materials and an approved sandbox welcome message.', intent: 'ONBOARDING', entities: [{ name: 'Acme Logistics', type: 'customer', unresolved: true }], constraints: ['Activation requires a security questionnaire; do not mark readiness from materials alone.', 'Email transport is a local sandbox and exact approval is required.'], questions: [], deliverables: [
  { id: 'account', description: 'Resolve the customer account', category: 'CUSTOMER', minCount: 1, sourceRequired: false },
  { id: 'sources', description: 'Retrieve the onboarding SOP and security policy', category: 'CONTEXT', minCount: 2, sourceRequired: true },
  { id: 'project', description: 'Create the onboarding project', category: 'PROJECT', minCount: 1, sourceRequired: false },
  { id: 'checklist', description: 'Create the onboarding checklist', category: 'TASKS', minCount: 2, sourceRequired: false },
  { id: 'brief', description: 'Prepare a source-backed brief recording the missing questionnaire', category: 'ARTIFACT', minCount: 1, sourceRequired: true },
  { id: 'draft', description: 'Prepare the welcome email draft', category: 'EMAIL_DRAFT', minCount: 1, sourceRequired: false },
  { id: 'welcome', description: 'Queue the exactly approved welcome email in the sandbox', category: 'EMAIL_SEND', minCount: 1, sourceRequired: false },
] });
export const demoPlan: Plan = PlanSchema.parse({ summary: 'Resolve context, prepare materials, then request exact approval for a sandbox welcome message.', milestones: demoGoal.deliverables.map((item) => ({ id: `milestone-${item.id}`, description: item.description, deliverableIds: [item.id], prerequisites: [] })), blocked: [] });
export function toolDecision(toolName: string, args: unknown, deliverableIds: string[] = [], purpose = 'Perform the next required operation'): NextAction {
  return { kind: 'tool', toolName, argumentsJson: JSON.stringify(args), deliverableIds, purpose, expectedOutcome: 'The persisted result and evidence can be read back independently.', revisedPlan: null };
}
export const completionDecision: NextAction = { kind: 'complete', summary: 'Propose verification of the requested materials; activation readiness remains separate.', revisedPlan: null };

/** Explicit test/demo model. It uses real observations, not manufactured business IDs, and is never a production fallback. */
export function onboardingResponse(request: StructuredModelRequest): unknown {
  if (request.phase === 'understand') return demoGoal;
  if (request.phase === 'plan') return demoPlan;
  const facts = z.array(z.object({ toolName: z.string(), result: JsonValueSchema })).parse(request.context['successfulActions']);
  const fact = (name: string) => facts.filter((item) => item.toolName === name).at(-1)?.result;
  const sources = z.array(z.object({ id: z.string(), reference: z.string(), metadata: z.record(z.string(), JsonValueSchema) })).parse(request.context['sources']);
  let decision: NextAction;
  if (!sources.some((source) => source.reference.includes('onboarding-sop.md'))) decision = toolDecision('search_company_knowledge', { query: 'required deliverables onboarding procedure', limit: 5 }, ['sources']);
  else if (!sources.some((source) => source.reference.includes('security-policy.md'))) decision = toolDecision('search_company_knowledge', { query: 'security questionnaire policy', limit: 5 }, ['sources']);
  else if (request.context['resolvedCustomerId'] === null) decision = toolDecision('search_customers', { query: 'Acme Logistics' }, ['account']);
  else if (!fact('get_customer_record')) decision = toolDecision('get_customer_record', { id: request.context['resolvedCustomerId'] }, ['account']);
  else {
    const customer = z.object({ id: z.string(), companyName: z.string(), contactEmail: z.string() }).parse(fact('get_customer_record'));
    if (!fact('create_project')) decision = toolDecision('create_project', { customerId: customer.id, name: `${customer.companyName} onboarding` }, ['project']);
    else {
      const project = z.object({ id: z.string() }).parse(fact('create_project'));
      const tasks = facts.filter((item) => item.toolName === 'create_task').map((item) => z.object({ title: z.string() }).parse(item.result));
      if (!tasks.some((task) => task.title === 'Collect security questionnaire')) decision = toolDecision('create_task', { projectId: project.id, title: 'Collect security questionnaire', description: 'Activation is blocked pending questionnaire and security review.' }, ['checklist']);
      else if (!tasks.some((task) => task.title === 'Confirm billing contact')) decision = toolDecision('create_task', { projectId: project.id, title: 'Confirm billing contact', description: 'Account notes identify the billing contact as missing.' }, ['checklist']);
      else if (!fact('write_artifact')) {
        decision = toolDecision('write_artifact', { filename: 'onboarding-brief.md', content: `# ${customer.companyName} onboarding\n\nSecurity questionnaire pending; activation is blocked. Billing contact remains unconfirmed.\n\nSources:\n${sources.map((source) => `- ${source.reference}`).join('\n')}`, mimeType: 'text/markdown', sources: sources.map((source) => ({ documentId: source.id, contentHash: source.metadata['contentHash'], chunkId: source.metadata['chunkId'] ?? null })) }, ['brief']);
      } else if (!fact('create_email_draft')) decision = toolDecision('create_email_draft', { customerId: customer.id, projectId: project.id, recipient: customer.contactEmail, subject: 'Welcome to Harborline', body: 'Your onboarding materials are prepared. Please complete the security questionnaire before activation.' }, ['draft']);
      else if (!fact('send_email')) decision = toolDecision('send_email', { draftId: z.object({ id: z.string() }).parse(fact('create_email_draft')).id }, ['welcome']);
      else decision = completionDecision;
    }
  }
  return { decision };
}
export function createOnboardingTestModel(): FakeModelProvider { return new FakeModelProvider(Array.from({ length: 60 }, () => onboardingResponse)); }
