import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import { chromium } from 'playwright';
import type { Browser, BrowserContext, Page } from 'playwright';
import { createServer } from 'vite';
import type { ViteDevServer } from 'vite';
import { z } from 'zod';
import { GoalSpecificationSchema, SendEmailActionSchema } from '@centralign/shared';
import { FakeModelProvider } from '../src/agent/fake-model-provider.js';
import { completionDecision, ONBOARDING_OBJECTIVE, onboardingResponse, toolDecision } from '../src/agent/testing/onboarding-model.js';
import { REPOSITORY_ROOT } from '../src/config/paths.js';
import { sha256 } from '../src/persistence/json.js';
import { agentFixture } from './agent-helpers.js';

let fixture: ReturnType<typeof agentFixture>; let web: ViteDevServer; let browser: Browser; let context: BrowserContext; let page: Page; let origin: string;
const screenshots = join(REPOSITORY_ROOT, '.data', 'phase4-review');
const readGoal = GoalSpecificationSchema.parse({ summary: 'Resolve the requested customer', intent: 'GENERAL', entities: [{ type: 'customer', name: 'Acme', unresolved: true }], deliverables: [{ id: 'customer', category: 'CUSTOMER', description: 'Resolve customer identity', minCount: 1, sourceRequired: false }], constraints: [], questions: [] });
beforeAll(async () => {
  mkdirSync(screenshots, { recursive: true });
  const model = new FakeModelProvider(Array.from({ length: 500 }, () => (request: Parameters<typeof onboardingResponse>[0]) => {
    if (String(request.context['originalRequest']).includes('Clarify account')) {
      if (request.phase === 'understand') return readGoal;
      if (request.phase === 'plan') return { summary: 'Resolve account from observed candidates', milestones: [{ id: 'resolve', description: 'Resolve account', deliverableIds: ['customer'], prerequisites: [] }], blocked: [] };
      const facts = z.array(z.object({ toolName: z.string() })).parse(request.context['successfulActions']);
      return { decision: facts.some((item) => item.toolName === 'get_customer_record') ? completionDecision : request.context['resolvedCustomerId'] ? toolDecision('get_customer_record', { id: request.context['resolvedCustomerId'] }, ['customer']) : toolDecision('search_customers', { query: 'Acme' }, ['customer']) };
    }
    const result = onboardingResponse(request);
    if (request.phase === 'act' && String(request.context['originalRequest']).includes('Preview fixture')) {
      const parsed = z.object({ decision: z.object({ kind: z.string(), toolName: z.string().optional(), argumentsJson: z.string().optional() }) }).parse(result);
      if (parsed.decision.toolName === 'write_artifact') {
        const args = z.record(z.string(), z.unknown()).parse(JSON.parse(parsed.decision.argumentsJson!)); args['content'] = `${String(args['content'])}\n<script>window.__artifactExecuted = true</script><img src=x onerror="window.__artifactExecuted = true">`;
        return { decision: toolDecision('write_artifact', args, ['brief']) };
      }
    }
    return result;
  }));
  fixture = agentFixture({ provider: model }); const apiOrigin = await fixture.app.listen({ host: '127.0.0.1', port: 0 });
  web = await createServer({ root: join(REPOSITORY_ROOT, 'apps', 'web'), configFile: join(REPOSITORY_ROOT, 'apps', 'web', 'vite.config.ts'), server: { host: '127.0.0.1', port: 0, strictPort: false, proxy: { '/api': { target: apiOrigin } } }, logLevel: 'error' }); await web.listen();
  origin = `http://127.0.0.1:${(web.httpServer!.address() as AddressInfo).port}`;
  browser = await chromium.launch({ headless: true, timeout: 15000 });
}, 30000);
beforeEach(async () => { context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true, timezoneId: 'Asia/Kolkata' }); page = await context.newPage(); page.setDefaultTimeout(15000); });
afterEach(async () => { await context?.close(); });
afterAll(async () => { await browser?.close(); await web?.close(); await fixture?.close(); });
async function submit(objective = ONBOARDING_OBJECTIVE) {
  await page.goto(origin); await page.getByLabel('Your request', { exact: true }).fill(objective); await page.getByRole('button', { name: 'Start run', exact: true }).click(); await page.waitForURL(/\/runs\//); const id = decodeURIComponent(new URL(page.url()).pathname.split('/').at(-1)!); return id;
}
async function awaitingApproval(objective = ONBOARDING_OBJECTIVE) { const id = await submit(objective); await page.getByRole('heading', { name: 'Review the welcome message' }).waitFor(); await fixture.service.waitForIdle(id); return id; }
function outboxCount(id: string) { return (fixture.db.prepare('SELECT count(*) AS count FROM sandbox_outbox o JOIN tool_executions e ON e.id=o.execution_id WHERE e.run_id=?').get(id) as { count: number }).count; }
async function confirmApproval() { await page.getByRole('button', { name: 'Approve this exact action', exact: true }).click(); await page.getByLabel('I reviewed the recipient, subject and complete message body.').check(); await page.getByRole('button', { name: 'Confirm sandbox approval', exact: true }).click(); }

it('creates a real run, drains event pages, reviews exact approval, reloads durable state and displays verified outcomes separately from activation', async () => {
  const requests: string[] = []; page.on('request', (request) => { if (request.method() === 'POST') requests.push(request.url()); });
  await page.goto(origin); await page.getByRole('heading', { name: 'What needs to get done?' }).waitFor(); await page.screenshot({ path: join(screenshots, 'desktop-workspace.png') });
  expect(await page.getByRole('complementary', { name: 'Model data use' }).innerText()).toContain('reviewed by humans');
  const id = await awaitingApproval(); const approval = fixture.service.snapshot(id).pendingApprovals[0]!; const action = SendEmailActionSchema.parse(approval.action);
  expect(await page.locator('.message-envelope').innerText()).toContain(action.recipient); expect(await page.locator('.message-envelope').innerText()).toContain(action.subject); expect(await page.locator('.message-body').innerText()).toBe(action.body); expect(outboxCount(id)).toBe(0); expect(requests.filter((url) => url.endsWith('/decision'))).toHaveLength(0);
  await page.locator('[data-event-id]').first().waitFor(); const loaded = await page.locator('[data-event-id]').count(); expect(loaded).toBeGreaterThan(50);
  await page.getByRole('button', { name: 'Refresh now' }).click(); await page.getByRole('button', { name: 'Refresh now' }).click(); const ids = await page.locator('[data-event-id]').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-event-id'))); expect(new Set(ids).size).toBe(ids.length);
  await page.getByRole('tab', { name: 'Plan & work' }).click(); await page.getByRole('heading', { name: 'Required deliverables' }).waitFor(); expect(await page.getByRole('heading', { name: /Plan Revision/ }).count()).toBe(1);
  await page.getByRole('tab', { name: 'Plan & work' }).press('ArrowRight'); expect(await page.getByRole('tab', { name: /^Evidence/ }).getAttribute('aria-selected')).toBe('true'); await page.getByRole('tab', { name: /^Evidence/ }).press('Home'); expect(await page.getByRole('tab', { name: 'Activity', exact: true }).getAttribute('aria-selected')).toBe('true');
  await page.reload(); await page.getByRole('heading', { name: 'Review the welcome message' }).waitFor(); expect(fixture.service.snapshot(id).pendingApprovals[0]?.id).toBe(approval.id);
  await page.screenshot({ path: join(screenshots, 'desktop-approval.png') });
  await confirmApproval(); await page.getByRole('heading', { name: '7 of 7 required outcomes verified' }).waitFor(); expect(fixture.service.snapshot(id).run.status).toBe('COMPLETED'); expect(outboxCount(id)).toBe(1);
  expect(await page.locator('.business-status').innerText()).toContain('Blocked'); expect(await page.locator('.business-status').innerText()).toContain('questionnaire'); expect(await page.getByRole('button', { name: 'Cancel run', exact: true }).count()).toBe(0);
  await page.reload(); await page.getByRole('heading', { name: '7 of 7 required outcomes verified' }).waitFor(); expect(await page.locator('.history-card').innerText()).toContain('Approved');
  let polls = 0; page.on('request', (request) => { if (request.url().includes(`/runs/${id}`) && request.method() === 'GET') polls++; }); await page.waitForTimeout(2300); expect(polls).toBe(0);
  await page.getByRole('tab', { name: /^Evidence/ }).click(); await page.getByRole('button', { name: 'Preview as text' }).click(); await page.getByTestId('artifact-preview').waitFor(); expect(await page.getByTestId('artifact-preview').innerText()).toContain('Security questionnaire pending');
  const downloadEvent = page.waitForEvent('download'); await page.getByRole('button', { name: 'Download artifact' }).click(); const download = await downloadEvent; expect(download.suggestedFilename()).toBe('onboarding-brief.md'); const path = await download.path(); expect(sha256(readFileSync(path!))).toBe(fixture.service.snapshot(id).artifacts[0]?.contentHash);
  await page.screenshot({ path: join(screenshots, 'desktop-outcome.png') });
  await page.setViewportSize({ width: 390, height: 844 }); await page.goto(origin); await page.getByRole('heading', { name: 'What needs to get done?' }).waitFor(); await page.screenshot({ path: join(screenshots, 'mobile-workspace.png') }); expect(await page.locator('html').evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
}, 60000);
it('persists rejection, never queues the rejected action, and reconstructs it after reload', async () => {
  const id = await awaitingApproval(); await page.getByRole('button', { name: 'Reject this action', exact: true }).click(); await page.getByRole('heading', { name: '6 of 7 required outcomes verified' }).waitFor(); expect(fixture.service.snapshot(id).run.status).toBe('PARTIAL'); expect(outboxCount(id)).toBe(0);
  await page.reload(); await page.getByRole('heading', { name: 'Decision history' }).waitFor(); expect(await page.locator('.history-card').innerText()).toContain('Rejected'); expect(await page.locator('.history-card').innerText()).toContain('cannot bypass'); expect(await page.getByRole('button', { name: 'Approve this exact action', exact: true }).count()).toBe(0);
}, 40000);
it('submits an observed customer choice and nonempty answer, supports narrow screens and restores the question after reload', async () => {
  const customer = fixture.db.prepare('SELECT id,created_at FROM customers LIMIT 1').get() as { id: string; created_at: string };
  fixture.db.prepare("INSERT INTO customers(id,company_name,normalized_name,contact_name,contact_email,status,metadata_json,created_at,updated_at) VALUES(?,?,?,'Other contact','other@example.test','NEW','{}',?,?)").run(randomUUID(), 'Acme Western', 'acme western', customer.created_at, customer.created_at);
  const id = await submit('Find Acme customer. Clarify account.'); await page.getByRole('heading', { name: 'Help resolve a blocker' }).waitFor(); await page.reload(); await page.getByRole('heading', { name: 'Help resolve a blocker' }).waitFor();
  await page.setViewportSize({ width: 390, height: 844 }); await page.getByRole('button', { name: 'Submit this answer' }).click(); await page.getByRole('alert').filter({ hasText: 'nonempty answer' }).waitFor();
  await page.locator(`input[type=radio][value="${customer.id}"]`).check(); await page.getByLabel('Your answer', { exact: true }).fill('Use the observed Acme Logistics account.'); await page.screenshot({ path: join(screenshots, 'mobile-question.png') });
  expect(await page.locator('html').evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.getByRole('button', { name: 'Submit this answer' }).click(); await page.getByRole('heading', { name: '1 of 1 required outcomes verified' }).waitFor(); expect(fixture.service.snapshot(id).resolvedCustomerId).toBe(customer.id); expect(fixture.service.snapshot(id).questionHistory.some((question) => question.choiceId === customer.id && question.status === 'ANSWERED')).toBe(true);
}, 40000);
it('requests cancellation only after confirmation and never optimistically reports cancellation', async () => {
  const id = await awaitingApproval(); let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route(`**/api/v1/runs/${id}/cancel`, async (route) => { await gate; await route.continue(); });
  await page.getByRole('button', { name: 'Cancel run', exact: true }).click(); await page.getByRole('dialog').waitFor(); expect(fixture.service.snapshot(id).run.status).toBe('WAITING_APPROVAL'); await page.getByRole('button', { name: 'Confirm cancellation' }).click(); expect(await page.getByRole('heading', { name: 'Stop this run safely?' }).isVisible()).toBe(true); expect(fixture.service.snapshot(id).run.status).toBe('WAITING_APPROVAL'); release();
  await page.getByRole('heading', { name: '6 of 7 required outcomes verified' }).waitFor(); expect(fixture.service.snapshot(id).run.status).toBe('CANCELLED'); expect(outboxCount(id)).toBe(0); expect(await page.getByRole('button', { name: 'Cancel run', exact: true }).count()).toBe(0);
}, 40000);
it('reloads authoritative rejected state on a stale approval conflict', async () => {
  const id = await awaitingApproval(); const approval = fixture.service.snapshot(id).pendingApprovals[0]!;
  await page.route(`**/api/v1/runs/${id}/approvals/${approval.id}/decision`, async (route) => { fixture.service.decision(id, approval.id, { decision: 'REJECTED', note: 'Another local review resolved this action' }); await fixture.service.waitForIdle(id); await route.continue(); });
  await confirmApproval(); await page.getByRole('heading', { name: 'Decision history' }).waitFor(); await page.getByRole('alert').filter({ hasText: 'persisted state changed' }).waitFor(); expect(await page.locator('.history-card').innerText()).toContain('Rejected'); expect(outboxCount(id)).toBe(0);
}, 40000);
it('renders hostile artifact text inertly and refuses a subsequently tampered file', async () => {
  const id = await awaitingApproval(`${ONBOARDING_OBJECTIVE} Preview fixture.`); await page.getByRole('tab', { name: /^Evidence/ }).click(); await page.getByRole('button', { name: 'Preview as text' }).click(); await page.getByTestId('artifact-preview').waitFor(); expect(await page.getByTestId('artifact-preview').innerText()).toContain('<script>'); expect(await page.evaluate(() => '__artifactExecuted' in globalThis)).toBe(false);
  const artifact = fixture.service.snapshot(id).artifacts[0]!; writeFileSync(join(fixture.workspace, artifact.path), 'changed bytes'); await page.getByRole('button', { name: 'Preview as text' }).click(); await page.getByRole('alert').filter({ hasText: 'failed verification' }).waitFor(); expect(await page.getByTestId('artifact-preview').count()).toBe(0); expect(await page.locator('.artifact-card').innerText()).toContain('Failed');
}, 40000);
it('handles real validation, configuration errors and missing run links without a frontend fallback', async () => {
  await page.goto(origin); await page.getByRole('button', { name: 'Start run', exact: true }).click(); await page.getByRole('alert').filter({ hasText: 'Enter a request' }).waitFor();
  let submissions = 0; await page.route('**/api/v1/runs', async (route) => { if (route.request().method() !== 'POST') return route.continue(); submissions++; await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'CONFIGURATION_ERROR', message: 'Configure backend', requestId: 'ui-config-test', details: null }, timestamp: new Date().toISOString() }) }); });
  await page.getByLabel('Your request', { exact: true }).fill('Read company context'); await page.getByRole('button', { name: 'Start run', exact: true }).click(); await page.getByRole('alert').filter({ hasText: 'GEMINI_API_KEY' }).waitFor(); expect(submissions).toBe(1); expect(new URL(page.url()).pathname).toBe('/');
  await page.goto(`${origin}/runs/does-not-exist`); await page.getByRole('heading', { name: 'Run not found' }).waitFor(); await page.goto(`${origin}/runs/`); await page.getByRole('heading', { name: 'Run link missing or invalid' }).waitFor();
}, 40000);
it('prevents duplicate task submission while the accepted request is pending', async () => {
  await page.goto(origin); let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; }); let posts = 0;
  await page.route('**/api/v1/runs', async (route) => { if (route.request().method() === 'POST') { posts++; await gate; } await route.continue(); });
  await page.getByLabel('Your request', { exact: true }).fill(ONBOARDING_OBJECTIVE); await page.getByRole('button', { name: 'Start run', exact: true }).evaluate((element) => { if ('click' in element && typeof element.click === 'function') { element.click(); element.click(); } });
  await page.getByRole('button', { name: 'Starting run…' }).waitFor(); expect(await page.getByRole('button', { name: 'Starting run…' }).isDisabled()).toBe(true); expect(posts).toBe(1); release(); await page.waitForURL(/\/runs\//); await page.getByRole('heading', { name: 'Review the welcome message' }).waitFor(); expect(posts).toBe(1);
}, 40000);
it('reconnects after a failed snapshot poll, preserves event identity and shows expired approvals accurately', async () => {
  const id = await awaitingApproval(); let failures = 0; await page.route(`**/api/v1/runs/${id}`, async (route) => { if (failures++ === 0) await route.abort('connectionfailed'); else await route.continue(); });
  await page.getByRole('button', { name: 'Refresh now' }).click(); await page.getByRole('alert').filter({ hasText: 'Connection interrupted' }).waitFor(); expect(await page.getByRole('button', { name: 'Approve this exact action', exact: true }).isDisabled()).toBe(true);
  await page.getByRole('alert').filter({ hasText: 'Connection interrupted' }).waitFor({ state: 'hidden' }); const ids = await page.locator('[data-event-id]').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-event-id'))); expect(new Set(ids).size).toBe(ids.length);
  fixture.db.prepare('UPDATE approvals SET expires_at=? WHERE id=?').run(new Date(Date.now() - 1000).toISOString(), fixture.service.snapshot(id).pendingApprovals[0]!.id); await page.getByRole('button', { name: 'Refresh now' }).click(); await page.getByText('Approval has expired. The server will not accept a decision.').waitFor(); expect(await page.getByRole('button', { name: 'Approve this exact action', exact: true }).isDisabled()).toBe(true); expect(outboxCount(id)).toBe(0);
}, 40000);
