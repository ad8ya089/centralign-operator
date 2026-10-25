import { randomUUID } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { isAbsolute, parse, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { ArtifactRecordSchema, DocumentCitationSchema, FinalResultSchema, JsonObjectSchema, RelativePathSchema, VerificationCheckSchema, parseStoredJson } from '@centralign/shared';
import type { FinalResult, JsonObject, VerificationCheck } from '@centralign/shared';
import { BusinessStore } from '../tools/business-store.js';
import { ToolOutcomeSchema } from '../tools/contracts.js';
import type { ToolOutcome } from '../tools/contracts.js';
import { canonicalJson, sha256 } from '../persistence/json.js';
import { canonicalSendAction } from '../tools/policy.js';
import { categoryTool } from './security.js';
import { MAX_ARTIFACT_BYTES } from './contracts.js';
import { RunStore } from './run-store.js';
import type { StoredAction } from './run-store.js';

export class IndependentVerifier {
  constructor(private readonly store: RunStore, private readonly workspaceRoot: string) {}
  private result(targetId: string, passed: boolean, explanation: string, expected: unknown, observed: unknown, evidence: VerificationCheck['evidence'] = [], repairable = true): VerificationCheck {
    return VerificationCheckSchema.parse({ id: randomUUID(), targetId, passed, explanation, expected, observed, evidence, repairable, createdAt: this.store.now() });
  }
  step(action: StoredAction, rawOutcome: ToolOutcome): VerificationCheck {
    const args = parseStoredJson(action.arguments_json, JsonObjectSchema); const db = this.store.db; const business = new BusinessStore(db);
    const outcome = ToolOutcomeSchema.parse(rawOutcome);
    if (!outcome.ok) return this.result(action.step_id, false, 'The tool did not report a committed result.', { tool: action.tool_name }, { code: outcome.error.code }, [], false);
    const data = outcome.data; let passed = false;
    try {
      const record = !Array.isArray(data) && data !== null && typeof data === 'object' ? data : {};
      const id = z.string().parse(record['id'] ?? '');
      switch (action.tool_name) {
        case 'create_project': { const row = business.project(id); passed = row.id === `project-${outcome.executionId}` && row.customerId === args['customerId'] && row.name === args['name']; break; }
        case 'create_task': { const row = business.task(id); passed = row.id === `task-${outcome.executionId}` && row.projectId === args['projectId'] && row.title === args['title'] && row.description === args['description']; break; }
        case 'create_email_draft': { const row = business.draft(id); passed = row.id === `draft-${outcome.executionId}` && row.customerId === args['customerId'] && row.projectId === args['projectId'] && row.recipient === args['recipient'] && row.subject === args['subject'] && row.body === args['body']; break; }
        case 'send_email': {
          const row = business.outbox(id); const draft = business.draft(row.draftId);
          const count = z.object({ count: z.number() }).parse(db.prepare('SELECT count(*) AS count FROM sandbox_outbox WHERE draft_id=?').get(args['draftId'])).count;
          const approval = this.store.approvals(action.run_id).find((item) => item.id === row.approvalId);
          passed = row.id === `outbox-${outcome.executionId}` && row.executionId === outcome.executionId && row.draftId === args['draftId'] && row.approvalId === args['approvalId'] && row.recipient === draft.recipient && row.subject === draft.subject && row.body === draft.body && row.status === 'SANDBOX_QUEUED' && draft.status === 'QUEUED' && count === 1 && approval?.status === 'APPROVED' && approval.stepId === action.step_id && approval.runId === action.run_id && canonicalJson(approval.action) === canonicalJson(canonicalSendAction(draft));
          break;
        }
        case 'write_artifact': {
          const raw = z.record(z.string(), z.unknown()).parse(db.prepare('SELECT id,run_id AS runId,step_id AS stepId,name,path,mime_type AS mimeType,content_hash AS contentHash,metadata_json,created_at AS createdAt FROM artifacts WHERE id=?').get(id));
          const { metadata_json, ...fields } = raw;
          const artifact = ArtifactRecordSchema.parse({ ...fields, metadata: parseStoredJson(z.string().parse(metadata_json), JsonObjectSchema) });
          const destination = resolve(this.workspaceRoot, RelativePathSchema.parse(artifact.path)); const inside = relative(resolve(this.workspaceRoot), destination);
          if (inside.startsWith('..') || isAbsolute(inside)) throw new Error('Outside workspace');
          let current = parse(destination).root;
          for (const segment of destination.slice(current.length).split(sep).filter(Boolean)) { current = resolve(current, segment); if (lstatSync(current).isSymbolicLink()) throw new Error('Linked artifact'); }
          const stat = lstatSync(destination); if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_ARTIFACT_BYTES) throw new Error('Unsafe artifact');
          const bytes = readFileSync(destination); const hash = sha256(bytes); const content = bytes.toString('utf8');
          const sources = z.array(DocumentCitationSchema).parse(artifact.metadata['sources']);
          let sourcesValid = true;
          for (const source of sources) {
            const sourceRow = db.prepare('SELECT source_path,content_hash FROM company_documents WHERE id=? AND indexed_at IS NOT NULL').get(source.documentId) as { source_path: string; content_hash: string } | undefined;
            if (!sourceRow || sourceRow.content_hash !== source.contentHash || !content.includes(source.documentId) && !content.includes(sourceRow.source_path) || source.chunkId !== null && !db.prepare('SELECT 1 FROM document_chunks WHERE id=? AND document_id=?').get(source.chunkId, source.documentId)) sourcesValid = false;
          }
          const state = this.store.state(action.run_id); const customer = state.resolved_customer_id ? business.customer(state.resolved_customer_id) : null;
          const missingSecurity = customer?.metadata['securityQuestionnaire'] === 'missing';
          const sourceRequired = state.goal?.deliverables.some((item) => item.category === 'ARTIFACT' && item.sourceRequired) ?? false;
          passed = artifact.id === `artifact-${outcome.executionId}` && artifact.runId === action.run_id && artifact.stepId === action.step_id && hash === artifact.contentHash && hash === sha256(z.string().parse(args['content'])) && artifact.mimeType === args['mimeType'] && artifact.metadata['sizeBytes'] === stat.size && sourcesValid && (!sourceRequired || sources.length > 0) && (!missingSecurity || /questionnaire/i.test(content) && /pending|missing|not received|blocked|not ready/i.test(content));
          break;
        }
        case 'search_company_knowledge': {
          const hits = z.array(z.object({ documentId: z.string(), contentHash: z.string(), chunkId: z.string() })).parse(record['hits']);
          passed = hits.every((hit) => Boolean(db.prepare('SELECT 1 FROM company_documents d JOIN document_chunks c ON c.document_id=d.id WHERE d.id=? AND d.content_hash=? AND c.id=?').get(hit.documentId, hit.contentHash, hit.chunkId))); break;
        }
        case 'read_company_document': passed = Boolean(db.prepare('SELECT 1 FROM company_documents WHERE id=? AND content_hash=? AND indexed_content=?').get(id, record['contentHash'], record['content'])); break;
        case 'get_customer_record': passed = business.customer(id).id === id; break;
        case 'search_customers': {
          const candidates = z.array(z.object({ id: z.string() })).parse(record['candidates']);
          passed = candidates.every((candidate) => business.customer(candidate.id).id === candidate.id); break;
        }
        case 'get_project': passed = business.project(id).id === id; break;
        case 'list_project_tasks': passed = Array.isArray(data) && data.every((item) => { const task = z.object({ id: z.string() }).parse(item); return business.task(task.id).projectId === args['projectId']; }); break;
        case 'get_email_draft': passed = business.draft(id).id === id; break;
        case 'get_outbox_message': passed = business.outbox(id).id === id; break;
        case 'browser_open': case 'browser_snapshot': passed = typeof record['url'] === 'string' && typeof record['sessionId'] === 'string' && outcome.evidence.some((item) => item.kind === 'browser' && item.id === record['sessionId']); break;
        default: return this.result(action.step_id, false, 'No independent verification strategy is registered for this tool.', { tool: action.tool_name }, {}, [], false);
      }
    } catch { passed = false; }
    return this.result(action.step_id, passed, passed ? 'Fresh read-back matched the expected operation and evidence.' : 'Independent read-back did not establish the expected postcondition.', { tool: action.tool_name, argumentsHash: sha256(canonicalJson(args)) }, { verified: passed }, passed ? outcome.evidence : [], action.tool_name !== 'send_email');
  }
  goal(runId: string): { checks: VerificationCheck[]; result: FinalResult; complete: boolean } {
    const state = this.store.state(runId); const actions = this.store.actions(runId); const goal = state.goal;
    const verified: FinalResult['verified'] = []; const outstanding: FinalResult['outstanding'] = []; const checks: VerificationCheck[] = [];
    const pending = this.store.questions(runId, true).length > 0 || this.store.approvals(runId, true).length > 0;
    const allSteps = this.store.steps(runId); const warnings: string[] = [];
    const customer = state.resolved_customer_id ? new BusinessStore(this.store.db).customer(state.resolved_customer_id) : null;
    if (customer?.metadata['securityQuestionnaire'] === 'missing') warnings.push('Activation remains blocked: the security questionnaire has not been received. Completed onboarding materials do not establish activation readiness.');
    for (const deliverable of goal?.deliverables ?? []) {
      const ids = new Set<string>(); let anyAttempt = false;
      const linked = new Set((this.store.db.prepare('SELECT step_id FROM agent_step_deliverables WHERE run_id=? AND deliverable_id=?').all(runId, deliverable.id) as { step_id: string }[]).map((row) => row.step_id));
      for (const action of actions.filter((item) => linked.has(item.step_id) && categoryTool[deliverable.category].includes(item.tool_name))) {
        anyAttempt = true; const step = this.store.step(action.step_id);
        if (step.status !== 'SUCCEEDED' || !step.output) continue;
        const outcome = ToolOutcomeSchema.safeParse(step.output); if (!outcome.success || !outcome.data.ok) continue;
        const check = this.step(action, outcome.data); this.store.check(runId, check, action.step_id);
        if (check.passed) for (const evidence of check.evidence) ids.add(evidence.id);
      }
      let passed = ids.size >= deliverable.minCount;
      if (deliverable.category === 'ACTIVATION_READINESS') passed = Boolean(customer && ['READY', 'ACTIVE'].includes(customer.status) && customer.metadata['securityQuestionnaire'] === 'received' && customer.metadata['securityReviewApproved'] === true);
      const explanation = passed ? 'Required persisted evidence passed independent verification.' : pending ? 'A required human decision or answer is outstanding.' : anyAttempt ? 'Required evidence is insufficient or failed read-back verification.' : 'Required work has not been executed.';
      const check = this.result(deliverable.id, passed, explanation, { minCount: deliverable.minCount, category: deliverable.category }, { evidenceCount: ids.size }, [], true);
      this.store.check(runId, check, null, deliverable.id); checks.push(check);
      if (passed) verified.push({ deliverableId: deliverable.id, description: deliverable.description, evidenceIds: [...ids] });
      else outstanding.push({ deliverableId: deliverable.id, reason: explanation });
    }
    const complete = Boolean(goal && checks.length > 0 && checks.every((check) => check.passed) && !pending);
    const result = FinalResultSchema.parse({ summary: complete ? 'All requested deliverables passed independent verification. Email, if requested, was queued only in the local sandbox.' : 'Requested work remains incomplete; only the verified deliverables listed here are established.', verified, outstanding, unverifiedStepIds: allSteps.filter((step) => step.status !== 'SUCCEEDED' || !this.store.db.prepare("SELECT 1 FROM agent_verifications WHERE step_id=? AND json_extract(check_json,'$.passed')=1").get(step.id)).map((step) => step.id), neverExecuted: (goal?.deliverables ?? []).filter((item) => !actions.some((action) => this.store.db.prepare('SELECT 1 FROM agent_step_deliverables WHERE step_id=? AND deliverable_id=?').get(action.step_id, item.id))).map((item) => item.id), warnings });
    return { checks, result, complete };
  }
}
