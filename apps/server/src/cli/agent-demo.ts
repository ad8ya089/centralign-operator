import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createApp } from '../app.js';
import { parseEnvironment } from '../config/env.js';
import { REPOSITORY_ROOT } from '../config/paths.js';
import { openDatabase } from '../persistence/database.js';
import { seedDemoData } from '../persistence/seed.js';
import { sha256 } from '../persistence/json.js';
import { RunService } from '../agent/run-service.js';
import { createOnboardingTestModel, ONBOARDING_OBJECTIVE } from '../agent/testing/onboarding-model.js';

// Explicit deterministic demo only. The normal application always constructs the real provider.
const directory = join(REPOSITORY_ROOT, '.data', 'demos', randomUUID()); mkdirSync(directory, { recursive: true });
const config = parseEnvironment({ NODE_ENV: 'test', DATABASE_PATH: join(directory, 'demo.sqlite'), ARTIFACT_WORKSPACE_PATH: join(directory, 'workspace') });
const db = openDatabase(config.DATABASE_PATH); seedDemoData(db);
const model = createOnboardingTestModel();
const app = createApp({ database: db, config, logging: false, agent: { provider: model, decisionMaker: 'local-demo-user' } });
try {
  const accepted = await app.inject({ method: 'POST', url: '/api/v1/runs', payload: { objective: ONBOARDING_OBJECTIVE } });
  if (accepted.statusCode !== 202) throw new Error('Demo creation failed');
  const id = (accepted.json() as { id: string }).id; const service = app.getDecorator<RunService>('runService'); await service.waitForIdle(id);
  const paused = service.snapshot(id); if (paused.run.status !== 'WAITING_APPROVAL' || paused.pendingApprovals.length !== 1) throw new Error('Demo did not pause for exact approval');
  const beforeApproval = db.prepare('SELECT count(*) AS count FROM sandbox_outbox').get();
  const approvalId = paused.pendingApprovals[0]!.id;
  const approved = await app.inject({ method: 'POST', url: `/api/v1/runs/${id}/approvals/${approvalId}/decision`, payload: { decision: 'APPROVED', note: 'Explicit human-decision fixture for this isolated deterministic demo.' } });
  if (approved.statusCode !== 202) throw new Error('Demo approval failed'); await service.waitForIdle(id);
  const snapshot = service.snapshot(id); if (snapshot.run.status !== 'COMPLETED') throw new Error('Demo did not independently complete');
  const artifacts = snapshot.artifacts.map((artifact) => ({ id: artifact.id, path: join(config.ARTIFACT_WORKSPACE_PATH, artifact.path), hash: artifact.contentHash, actualHash: sha256(readFileSync(join(config.ARTIFACT_WORKSPACE_PATH, artifact.path))) }));
  const report = { provider: 'Explicit FakeModelProvider; no live OpenAI call', runId: id, approvalId, statusBeforeApproval: paused.run.status, outboxBeforeApproval: beforeApproval, snapshot, artifacts, projects: db.prepare('SELECT id,customer_id,name FROM projects').all(), tasks: db.prepare('SELECT id,project_id,title FROM tasks').all(), drafts: db.prepare('SELECT id,customer_id,project_id,status FROM email_drafts').all(), outbox: db.prepare('SELECT id,draft_id,approval_id,execution_id,status FROM sandbox_outbox').all(), customer: db.prepare('SELECT id,status,metadata_json FROM customers').get(), modelCalls: model.requests.length, eventCount: db.prepare('SELECT count(*) AS count FROM run_events WHERE run_id=?').get(id), databasePath: config.DATABASE_PATH };
  const reportPath = join(directory, 'report.json'); writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ runId: id, approvalId, status: snapshot.run.status, verified: snapshot.finalResult?.verified.map((item) => item.deliverableId), warnings: snapshot.finalResult?.warnings, reportPath, databasePath: config.DATABASE_PATH }, null, 2));
} finally { await app.close(); }
