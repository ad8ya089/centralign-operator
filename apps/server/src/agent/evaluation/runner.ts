import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { EVALUATION_SCENARIOS, EvaluationReportSchema, EvaluationScenarioSchema } from '@centralign/shared';
import type { EvaluationReport } from '@centralign/shared';
import { executeScenario, ScenarioFailure } from './scenarios.js';

export interface EvaluationOptions { repetitions?: number; scenarios?: readonly string[]; onWorkspace?: (path: string) => void; onCase?: (result: EvaluationReport['results'][number]) => void }
export function summarize(results: EvaluationReport['results']) {
  const runs = results.flatMap((result) => result.runs); const sum = (field: 'duplicateMutations' | 'approvalBypasses' | 'falseCompletionClaims' | 'modelCalls' | 'toolCalls' | 'recoveries') => runs.reduce((total, run) => total + run[field], 0);
  const tokens = (field: 'inputTokens' | 'outputTokens' | 'totalTokens') => { const values = runs.flatMap((run) => run.usage[field] === null ? [] : [run.usage[field]!]); return values.length ? values.reduce((a, b) => a + b, 0) : null; };
  return { scenarioExecutions: results.length, totalRuns: runs.length, passed: results.filter((result) => result.passed).length, failed: results.filter((result) => !result.passed).length, duplicateMutations: sum('duplicateMutations'), approvalBypasses: sum('approvalBypasses'), falseCompletionClaims: sum('falseCompletionClaims'), modelCalls: sum('modelCalls'), toolCalls: sum('toolCalls'), recoveries: sum('recoveries'), usage: { inputTokens: tokens('inputTokens'), outputTokens: tokens('outputTokens'), totalTokens: tokens('totalTokens') }, allSafetyInvariantsHeld: results.length > 0 && results.every((result) => result.passed) && runs.length > 0 && runs.every((run) => run.allSafetyInvariantsHeld) };
}
export async function runEvaluation(options: EvaluationOptions = {}): Promise<EvaluationReport> {
  const repetitions = z.number().int().min(1).max(10).parse(options.repetitions ?? 2);
  const scenarios = z.array(EvaluationScenarioSchema).min(1).max(12).parse(options.scenarios ?? [...EVALUATION_SCENARIOS]);
  if (new Set(scenarios).size !== scenarios.length) throw new Error('Evaluation scenario names must be unique.');
  const startedAt = new Date().toISOString(); const started = performance.now(); const results: EvaluationReport['results'] = [];
  for (const scenario of scenarios) for (let repetition = 1; repetition <= repetitions; repetition++) {
    const before = performance.now(); let runs: EvaluationReport['results'][number]['runs'] = []; const issues: string[] = [];
    try { runs = await executeScenario(scenario, options.onWorkspace); if (!runs.every((run) => run.allSafetyInvariantsHeld)) issues.push('Duplicate mutations, approval bypasses or false completion claims were observed.'); }
    catch (error) { if (error instanceof ScenarioFailure) { runs = error.runs; issues.push(error.message); } else issues.push('Scenario initialization or cleanup failed; no success is claimed.'); }
    const value = { scenario, repetition, passed: issues.length === 0 && runs.length > 0, issues, runs, durationMs: Math.round(performance.now() - before) }; results.push(value); options.onCase?.(value);
  }
  return EvaluationReportSchema.parse({ version: 1, id: randomUUID(), provider: 'explicit-fake-model', sandboxOnly: true, startedAt, finishedAt: new Date().toISOString(), durationMs: Math.round(performance.now() - started), repetitions, results, summary: summarize(results) });
}
