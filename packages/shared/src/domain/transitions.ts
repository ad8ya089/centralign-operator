import type { ApprovalStatus, RunStatus, StepStatus } from './status.js';
import type { RunRecord, RunStepRecord } from '../schemas/records.js';
import { RunRecordSchema, RunStepRecordSchema } from '../schemas/records.js';

function freezeMap<S extends string>(map: Record<S, readonly S[]>): Readonly<Record<S, readonly S[]>> {
  for (const targets of Object.values<readonly S[]>(map)) Object.freeze(targets);
  return Object.freeze(map);
}

export const RUN_TRANSITIONS = freezeMap<RunStatus>({
  CREATED: ['UNDERSTANDING', 'FAILED', 'CANCELLED'],
  UNDERSTANDING: ['PLANNED', 'WAITING_INPUT', 'FAILED', 'CANCELLED'],
  PLANNED: ['RUNNING', 'WAITING_APPROVAL', 'WAITING_INPUT', 'FAILED', 'CANCELLED'],
  RUNNING: ['WAITING_APPROVAL', 'WAITING_INPUT', 'VERIFYING', 'FAILED', 'CANCELLED'],
  WAITING_APPROVAL: ['RUNNING', 'PARTIAL', 'FAILED', 'CANCELLED'],
  WAITING_INPUT: ['UNDERSTANDING', 'PLANNED', 'RUNNING', 'VERIFYING', 'PARTIAL', 'FAILED', 'CANCELLED'],
  VERIFYING: ['RUNNING', 'WAITING_APPROVAL', 'WAITING_INPUT', 'COMPLETED', 'PARTIAL', 'FAILED', 'CANCELLED'],
  COMPLETED: [], PARTIAL: [], FAILED: [], CANCELLED: [],
});

export const STEP_TRANSITIONS = freezeMap<StepStatus>({
  PENDING: ['READY', 'BLOCKED', 'SKIPPED', 'CANCELLED'],
  READY: ['RUNNING', 'WAITING_APPROVAL', 'WAITING_INPUT', 'BLOCKED', 'FAILED', 'SKIPPED', 'CANCELLED'],
  RUNNING: ['WAITING_APPROVAL', 'WAITING_INPUT', 'RETRYING', 'SUCCEEDED', 'BLOCKED', 'FAILED', 'CANCELLED'],
  WAITING_APPROVAL: ['READY', 'BLOCKED', 'FAILED', 'CANCELLED'],
  WAITING_INPUT: ['READY', 'BLOCKED', 'FAILED', 'SKIPPED', 'CANCELLED'],
  RETRYING: ['READY', 'RUNNING', 'BLOCKED', 'FAILED', 'CANCELLED'],
  BLOCKED: ['READY', 'SKIPPED', 'FAILED', 'CANCELLED'],
  SUCCEEDED: [], FAILED: [], SKIPPED: [], CANCELLED: [],
});

export const APPROVAL_TRANSITIONS = freezeMap<ApprovalStatus>({
  PENDING: ['APPROVED', 'REJECTED', 'EXPIRED', 'CANCELLED'],
  APPROVED: [], REJECTED: [], EXPIRED: [], CANCELLED: [],
});

export const canTransitionRun = (from: RunStatus, to: RunStatus): boolean => RUN_TRANSITIONS[from].includes(to);
export const canTransitionStep = (from: StepStatus, to: StepStatus): boolean => STEP_TRANSITIONS[from].includes(to);
export const canTransitionApproval = (from: ApprovalStatus, to: ApprovalStatus): boolean => APPROVAL_TRANSITIONS[from].includes(to);

/** Pure helpers: invalid changes throw before modifying state. Persistence/concurrency enforcement is future work. */
export function transitionRun(run: RunRecord, to: RunStatus, at: string): RunRecord {
  if (!canTransitionRun(run.status, to)) throw new Error(`Invalid run transition: ${run.status} -> ${to}`);
  return RunRecordSchema.parse({ ...run, status: to, updatedAt: at, completedAt: RUN_TRANSITIONS[to].length === 0 ? at : null, version: run.version + 1 });
}

export function transitionStep(step: RunStepRecord, to: StepStatus, at: string): RunStepRecord {
  if (!canTransitionStep(step.status, to)) throw new Error(`Invalid step transition: ${step.status} -> ${to}`);
  return RunStepRecordSchema.parse({ ...step, status: to, updatedAt: at,
    startedAt: to === 'RUNNING' ? step.startedAt ?? at : step.startedAt,
    completedAt: STEP_TRANSITIONS[to].length === 0 ? at : null,
    attemptCount: step.attemptCount + (to === 'RUNNING' ? 1 : 0),
  });
}
