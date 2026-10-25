import { existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { EVALUATION_SCENARIOS, EvaluationReportSchema } from '@centralign/shared';
import type { EvaluationReport } from '@centralign/shared';
import { runEvaluation, summarize } from '../src/agent/evaluation/runner.js';
import { evaluationSession } from '../src/agent/evaluation/session.js';
import { onboardingResponse } from '../src/agent/testing/onboarding-model.js';

describe('isolated deterministic reliability evaluation', () => {
  let report: EvaluationReport; const workspaces: string[] = [];
  beforeAll(async () => {
    vi.stubGlobal('fetch', vi.fn(() => { throw new Error('External requests are forbidden during evaluation'); }));
    report = await runEvaluation({ repetitions: 1, onWorkspace: (path) => workspaces.push(path) });
  }, 120000);
  afterAll(() => vi.unstubAllGlobals());

  it('checks all scenarios against real persisted outcomes and fails no safety invariant', () => {
    expect(EvaluationReportSchema.parse(report).summary).toMatchObject({ scenarioExecutions: 12, totalRuns: 20, passed: 12, failed: 0, duplicateMutations: 0, approvalBypasses: 0, falseCompletionClaims: 0, allSafetyInvariantsHeld: true, usage: { inputTokens: null, outputTokens: null, totalTokens: null } });
    expect(report.results.map((item) => item.scenario)).toEqual(EVALUATION_SCENARIOS);
    const normal = report.results.find((item) => item.scenario === 'normal-onboarding')!.runs[0]!;
    expect(normal).toMatchObject({ status: 'COMPLETED', requiredDeliverables: 7, verifiedDeliverables: 7, incompleteDeliverables: 0, mutations: { projects: 1, tasks: 2, artifacts: 1, drafts: 1, outbox: 1 } });
    for (const name of ['invalid-model-output', 'approval-refusal', 'stale-approval', 'failed-verification', 'resource-budgets']) {
      expect(report.results.find((item) => item.scenario === name)!.runs.every((run) => ['FAILED', 'PARTIAL'].includes(run.status))).toBe(true);
    }
    expect(report.results.find((item) => item.scenario === 'failed-verification')!.runs[0]!.failedChecks).toBeGreaterThan(0);
    expect(report.results.find((item) => item.scenario === 'transient-read')!.runs[0]!.recoveries).toBe(1);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('uses a distinct temporary database for each run and removes its files', () => {
    const runs = report.results.flatMap((item) => item.runs);
    expect(workspaces).toHaveLength(20); expect(new Set(workspaces).size).toBe(20);
    expect(new Set(runs.map((run) => run.databaseId)).size).toBe(20);
    for (const path of workspaces) { expect(relative(tmpdir(), path)).toMatch(/^centralign-evaluation-/); expect(existsSync(path)).toBe(false); expect(JSON.stringify(report)).not.toContain(path); }
    expect(JSON.stringify(report)).not.toContain(`AQ.${'S'.repeat(44)}`);
  });

  it('repeats high-risk cases independently with stable business effects', async () => {
    const repeated = await runEvaluation({ repetitions: 2, scenarios: ['ambiguous-write', 'stale-approval'] });
    expect(repeated.summary).toMatchObject({ scenarioExecutions: 4, totalRuns: 4, passed: 4, allSafetyInvariantsHeld: true });
    expect(new Set(repeated.results.flatMap((item) => item.runs.map((run) => run.databaseId))).size).toBe(4);
    for (const name of ['ambiguous-write', 'stale-approval']) {
      const runs = repeated.results.filter((item) => item.scenario === name).map((item) => item.runs[0]!);
      expect(runs[0]!.mutations).toEqual(runs[1]!.mutations);
      expect(runs[0]!.modelCalls).toBe(runs[1]!.modelCalls);
      expect(runs[0]!.mutations.projects).toBe(1);
    }
  }, 30000);

  it('does not hide a failed case or invent token/cost measurements', () => {
    const broken = structuredClone(report.results[0]!); broken.passed = false; broken.issues = ['Synthetic failed invariant'];
    Object.assign(broken.runs[0]!, { falseCompletionClaims: 1, allSafetyInvariantsHeld: false });
    expect(summarize([broken])).toMatchObject({ passed: 0, failed: 1, falseCompletionClaims: 1, allSafetyInvariantsHeld: false, usage: { totalTokens: null } });
    expect(summarize([]).allSafetyInvariantsHeld).toBe(false);
  });

  it('rejects invalid repetition counts, unknown or duplicate scenarios before execution', async () => {
    for (const options of [{ repetitions: 0 }, { repetitions: 11 }, { scenarios: ['unknown'] }, { scenarios: [] }, { scenarios: ['transient-read', 'transient-read'] }]) await expect(runEvaluation(options)).rejects.toThrow();
  });

  it('forces sandbox paths even when environment options try to override them', async () => {
    const session = await evaluationSession({ model: onboardingResponse, environment: { DATABASE_PATH: join(tmpdir(), 'forbidden-evaluation.sqlite'), ARTIFACT_WORKSPACE_PATH: join(tmpdir(), 'forbidden-evaluation-workspace') } });
    try { expect(session.config.DATABASE_PATH).toBe(join(session.root, 'state.sqlite')); expect(session.config.ARTIFACT_WORKSPACE_PATH).toBe(join(session.root, 'workspace')); }
    finally { await session.close(); }
    expect(existsSync(session.root)).toBe(false);
  });

  it('cleans failed setup and reports initialization failure without leaking its exception', async () => {
    let root = '';
    await expect(evaluationSession({ model: onboardingResponse, onWorkspace: (path) => { root = path; }, setup: () => { throw new Error('Synthetic setup failure'); } })).rejects.toThrow('Synthetic setup failure');
    expect(existsSync(root)).toBe(false);
    const failed = await runEvaluation({ repetitions: 1, scenarios: ['transient-read'], onWorkspace: (path) => { root = path; throw new Error('PRIVATE_SETUP_CONTENT'); } });
    expect(failed.summary).toMatchObject({ failed: 1, totalRuns: 0, allSafetyInvariantsHeld: false });
    expect(JSON.stringify(failed)).not.toContain('PRIVATE_SETUP_CONTENT'); expect(existsSync(root)).toBe(false);
  });
});
