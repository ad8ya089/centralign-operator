import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runEvaluation } from '../agent/evaluation/runner.js';
import { REPOSITORY_ROOT } from '../config/paths.js';

try {
  let repetitions = 2; let scenarios: string[] | undefined;
  for (const argument of process.argv.slice(2)) {
    if (/^--repetitions=\d+$/.test(argument)) repetitions = Number(argument.split('=')[1]);
    else if (argument.startsWith('--scenario=')) (scenarios ??= []).push(argument.slice('--scenario='.length));
    else throw new Error('Invalid evaluation option');
  }
  const report = await runEvaluation({ repetitions, ...(scenarios ? { scenarios } : {}), onCase: (result) => console.log(`${result.passed ? 'PASS' : 'FAIL'} ${result.scenario} #${result.repetition} | ${result.runs.length} isolated run(s) | ${result.durationMs} ms${result.issues.length ? ` | ${result.issues.join('; ')}` : ''}`) });
  const folder = join(REPOSITORY_ROOT, '.data', 'evaluations', report.id); mkdirSync(folder, { recursive: true }); const reportPath = join(folder, 'report.json'); writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ provider: report.provider, sandboxOnly: true, ...report.summary, reportPath }));
  if (!report.summary.allSafetyInvariantsHeld || report.summary.failed > 0) process.exitCode = 1;
} catch { console.error('Evaluation failed. Use --repetitions=1..10 and optional --scenario=<supported-name>. No success is claimed.'); process.exitCode = 1; }
