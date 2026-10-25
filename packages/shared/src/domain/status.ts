import { z } from 'zod';

export const RUN_STATUSES = ['CREATED', 'UNDERSTANDING', 'PLANNED', 'RUNNING', 'WAITING_APPROVAL', 'WAITING_INPUT', 'VERIFYING', 'COMPLETED', 'PARTIAL', 'FAILED', 'CANCELLED'] as const;
export const STEP_STATUSES = ['PENDING', 'READY', 'RUNNING', 'WAITING_APPROVAL', 'WAITING_INPUT', 'RETRYING', 'SUCCEEDED', 'BLOCKED', 'FAILED', 'SKIPPED', 'CANCELLED'] as const;
export const APPROVAL_STATUSES = ['PENDING', 'APPROVED', 'REJECTED', 'EXPIRED', 'CANCELLED'] as const;
export const TOOL_EXECUTION_STATUSES = ['PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'UNKNOWN_OUTCOME', 'CANCELLED'] as const;
export const MEMORY_SCOPES = ['COMPANY', 'CUSTOMER', 'RUN'] as const;
export const MEMORY_TRUST_STATUSES = ['PROVISIONAL', 'APPROVED', 'REJECTED', 'RETIRED'] as const;
export const EVENT_TYPES = [
  'RUN_CREATED', 'RUN_STATUS_CHANGED', 'STEP_CREATED', 'STEP_STATUS_CHANGED',
  'TOOL_EXECUTION_STARTED', 'TOOL_EXECUTION_SUCCEEDED', 'TOOL_EXECUTION_FAILED', 'TOOL_EXECUTION_UNKNOWN_OUTCOME',
  'APPROVAL_REQUESTED', 'APPROVAL_DECIDED', 'VERIFICATION_PASSED', 'VERIFICATION_FAILED', 'ARTIFACT_CREATED',
] as const;

export const RunStatusSchema = z.enum(RUN_STATUSES);
export const StepStatusSchema = z.enum(STEP_STATUSES);
export const ApprovalStatusSchema = z.enum(APPROVAL_STATUSES);
export const ToolExecutionStatusSchema = z.enum(TOOL_EXECUTION_STATUSES);
export const EventTypeSchema = z.enum(EVENT_TYPES);
export type RunStatus = z.infer<typeof RunStatusSchema>;
export type StepStatus = z.infer<typeof StepStatusSchema>;
export type ApprovalStatus = z.infer<typeof ApprovalStatusSchema>;
export type ToolExecutionStatus = z.infer<typeof ToolExecutionStatusSchema>;
export type EventType = z.infer<typeof EventTypeSchema>;
