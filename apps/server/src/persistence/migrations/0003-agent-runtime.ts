export const agentRuntimeMigration = {
  version: 3, name: 'agent-runtime',
  sql: `
-- Rebuild only the event constraint/index representation, preserving every existing event and its row order.
ALTER TABLE run_events RENAME TO run_events_phase2;
DROP TRIGGER run_events_no_update;
DROP TRIGGER run_events_no_delete;
DROP TRIGGER run_events_no_replace;
CREATE TABLE run_events (
  sequence INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE CHECK(length(trim(id))>0),
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE RESTRICT,
  step_id TEXT,
  event_type TEXT NOT NULL CHECK(event_type IN ('RUN_CREATED','RUN_STATUS_CHANGED','STEP_CREATED','STEP_STATUS_CHANGED','TOOL_EXECUTION_STARTED','TOOL_EXECUTION_SUCCEEDED','TOOL_EXECUTION_FAILED','TOOL_EXECUTION_UNKNOWN_OUTCOME','APPROVAL_REQUESTED','APPROVAL_DECIDED','VERIFICATION_PASSED','VERIFICATION_FAILED','ARTIFACT_CREATED','GOAL_UNDERSTOOD','PLAN_CREATED','PLAN_REVISED','STEP_PROPOSED','RETRY_SCHEDULED','CLARIFICATION_REQUESTED','CLARIFICATION_ANSWERED','RUNTIME_PAUSED','RUNTIME_RESUMED','RECOVERY_ATTEMPTED','RUN_FINISHED','RUN_CANCEL_REQUESTED','MODEL_CALL_STARTED','MODEL_CALL_FAILED','DUPLICATE_ACTION')),
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json) AND json_type(payload_json)='object'),
  created_at TEXT NOT NULL,
  FOREIGN KEY(run_id,step_id) REFERENCES run_steps(run_id,id) ON DELETE RESTRICT
) STRICT;
INSERT INTO run_events(sequence,id,run_id,step_id,event_type,payload_json,created_at)
 SELECT rowid,id,run_id,step_id,event_type,payload_json,created_at FROM run_events_phase2 ORDER BY rowid;
DROP TABLE run_events_phase2;
CREATE INDEX run_events_run_time ON run_events(run_id,created_at,id);
CREATE INDEX run_events_step ON run_events(step_id);
CREATE INDEX run_events_cursor ON run_events(run_id,sequence);
CREATE TRIGGER run_events_no_update BEFORE UPDATE ON run_events BEGIN SELECT RAISE(ABORT,'run_events is append-only'); END;
CREATE TRIGGER run_events_no_delete BEFORE DELETE ON run_events BEGIN SELECT RAISE(ABORT,'run_events is append-only'); END;
CREATE TRIGGER run_events_no_replace BEFORE INSERT ON run_events WHEN EXISTS(SELECT 1 FROM run_events WHERE id=NEW.id) BEGIN SELECT RAISE(ABORT,'run_events is append-only'); END;

CREATE TABLE agent_runs (
  run_id TEXT PRIMARY KEY NOT NULL REFERENCES runs(id) ON DELETE RESTRICT,
  actor_id TEXT NOT NULL,
  granted_scopes_json TEXT NOT NULL CHECK(json_valid(granted_scopes_json) AND json_type(granted_scopes_json)='array'),
  budgets_json TEXT NOT NULL CHECK(json_valid(budgets_json) AND json_type(budgets_json)='object'),
  goal_json TEXT CHECK(goal_json IS NULL OR json_valid(goal_json)),
  resolved_customer_id TEXT REFERENCES customers(id) ON DELETE RESTRICT,
  model_calls INTEGER NOT NULL DEFAULT 0 CHECK(model_calls>=0),
  tool_calls INTEGER NOT NULL DEFAULT 0 CHECK(tool_calls>=0),
  recoveries INTEGER NOT NULL DEFAULT 0 CHECK(recoveries>=0),
  replans INTEGER NOT NULL DEFAULT 0 CHECK(replans>=0),
  deadline_at TEXT NOT NULL,
  cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK(cancel_requested IN (0,1)),
  lease_owner TEXT,
  lease_expires_at TEXT,
  feedback_json TEXT CHECK(feedback_json IS NULL OR json_valid(feedback_json)),
  final_result_json TEXT CHECK(final_result_json IS NULL OR json_valid(final_result_json)),
  CHECK((lease_owner IS NULL)=(lease_expires_at IS NULL))
) STRICT;
CREATE TABLE agent_plan_revisions (
  run_id TEXT NOT NULL REFERENCES agent_runs(run_id) ON DELETE RESTRICT,
  revision INTEGER NOT NULL CHECK(revision>0),
  plan_json TEXT NOT NULL CHECK(json_valid(plan_json)),
  created_at TEXT NOT NULL,
  PRIMARY KEY(run_id,revision)
) STRICT;
CREATE TABLE agent_deliverables (
  run_id TEXT NOT NULL REFERENCES agent_runs(run_id) ON DELETE RESTRICT,
  id TEXT NOT NULL,
  specification_json TEXT NOT NULL CHECK(json_valid(specification_json)),
  PRIMARY KEY(run_id,id)
) STRICT;
CREATE TABLE agent_steps (
  step_id TEXT PRIMARY KEY NOT NULL,
  run_id TEXT NOT NULL REFERENCES agent_runs(run_id) ON DELETE RESTRICT,
  tool_name TEXT NOT NULL,
  arguments_json TEXT NOT NULL CHECK(json_valid(arguments_json) AND json_type(arguments_json)='object'),
  operation_hash TEXT,
  idempotency_key TEXT UNIQUE,
  approval_id TEXT REFERENCES approvals(id) ON DELETE RESTRICT,
  execution_id TEXT REFERENCES tool_executions(id) ON DELETE RESTRICT,
  blocked_reason TEXT,
  expected_outcome TEXT NOT NULL,
  UNIQUE(run_id,operation_hash),
  FOREIGN KEY(run_id,step_id) REFERENCES run_steps(run_id,id) ON DELETE RESTRICT
) STRICT;
CREATE TABLE agent_step_deliverables (
  run_id TEXT NOT NULL,
  step_id TEXT NOT NULL,
  deliverable_id TEXT NOT NULL,
  PRIMARY KEY(step_id,deliverable_id),
  FOREIGN KEY(run_id,step_id) REFERENCES run_steps(run_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(run_id,deliverable_id) REFERENCES agent_deliverables(run_id,id) ON DELETE RESTRICT
) STRICT;
CREATE TABLE agent_questions (
  id TEXT PRIMARY KEY NOT NULL,
  run_id TEXT NOT NULL REFERENCES agent_runs(run_id) ON DELETE RESTRICT,
  fingerprint TEXT NOT NULL,
  proposal_json TEXT NOT NULL CHECK(json_valid(proposal_json)),
  status TEXT NOT NULL CHECK(status IN ('PENDING','ANSWERED','CANCELLED')),
  answer TEXT,
  choice_id TEXT,
  created_at TEXT NOT NULL,
  answered_at TEXT,
  answered_by TEXT,
  UNIQUE(run_id,fingerprint)
) STRICT;
CREATE TABLE agent_verifications (
  id TEXT PRIMARY KEY NOT NULL,
  run_id TEXT NOT NULL REFERENCES agent_runs(run_id) ON DELETE RESTRICT,
  step_id TEXT,
  deliverable_id TEXT,
  kind TEXT NOT NULL CHECK(kind IN ('STEP','GOAL')),
  check_json TEXT NOT NULL CHECK(json_valid(check_json)),
  created_at TEXT NOT NULL,
  FOREIGN KEY(run_id,step_id) REFERENCES run_steps(run_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(run_id,deliverable_id) REFERENCES agent_deliverables(run_id,id) ON DELETE RESTRICT
) STRICT;
CREATE INDEX agent_verifications_run ON agent_verifications(run_id,created_at);
CREATE TABLE agent_model_calls (
  id TEXT PRIMARY KEY NOT NULL,
  run_id TEXT NOT NULL REFERENCES agent_runs(run_id) ON DELETE RESTRICT,
  phase TEXT NOT NULL CHECK(phase IN ('understand','plan','act')),
  status TEXT NOT NULL CHECK(status IN ('STARTED','SUCCEEDED','FAILED','INTERRUPTED')),
  request_hash TEXT NOT NULL,
  response_hash TEXT,
  error_code TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT
) STRICT;
`,
} as const;
