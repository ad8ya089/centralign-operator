/** Immutable schema snapshot. Add 0002 rather than changing an applied migration. */
export const foundationMigration = {
  version: 1,
  name: 'foundation',
  sql: `
CREATE TABLE runs (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(trim(id)) > 0),
  objective TEXT NOT NULL CHECK (length(trim(objective)) > 0),
  status TEXT NOT NULL CHECK (status IN ('CREATED','UNDERSTANDING','PLANNED','RUNNING','WAITING_APPROVAL','WAITING_INPUT','VERIFYING','COMPLETED','PARTIAL','FAILED','CANCELLED')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  metadata_json TEXT NOT NULL CHECK (json_valid(metadata_json) AND json_type(metadata_json) = 'object'),
  version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
  CHECK ((status IN ('COMPLETED','PARTIAL','FAILED','CANCELLED') AND completed_at IS NOT NULL) OR (status NOT IN ('COMPLETED','PARTIAL','FAILED','CANCELLED') AND completed_at IS NULL))
) STRICT;
CREATE INDEX runs_status_updated ON runs(status, updated_at);

CREATE TABLE run_steps (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(trim(id)) > 0),
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE RESTRICT,
  step_index INTEGER NOT NULL CHECK (step_index >= 0),
  description TEXT NOT NULL CHECK (length(trim(description)) > 0),
  status TEXT NOT NULL CHECK (status IN ('PENDING','READY','RUNNING','WAITING_APPROVAL','WAITING_INPUT','RETRYING','SUCCEEDED','BLOCKED','FAILED','SKIPPED','CANCELLED')),
  input_json TEXT NOT NULL CHECK (json_valid(input_json) AND json_type(input_json) = 'object'),
  output_json TEXT CHECK (output_json IS NULL OR json_valid(output_json)),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  error_json TEXT CHECK (error_json IS NULL OR (json_valid(error_json) AND json_type(error_json) = 'object')),
  UNIQUE (run_id, step_index),
  UNIQUE (run_id, id)
) STRICT;
CREATE INDEX run_steps_run_status ON run_steps(run_id, status);

CREATE TABLE run_events (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(trim(id)) > 0),
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE RESTRICT,
  step_id TEXT,
  event_type TEXT NOT NULL CHECK (event_type IN ('RUN_CREATED','RUN_STATUS_CHANGED','STEP_CREATED','STEP_STATUS_CHANGED','TOOL_EXECUTION_STARTED','TOOL_EXECUTION_SUCCEEDED','TOOL_EXECUTION_FAILED','TOOL_EXECUTION_UNKNOWN_OUTCOME','APPROVAL_REQUESTED','APPROVAL_DECIDED','VERIFICATION_PASSED','VERIFICATION_FAILED','ARTIFACT_CREATED')),
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json) AND json_type(payload_json) = 'object'),
  created_at TEXT NOT NULL,
  FOREIGN KEY (run_id, step_id) REFERENCES run_steps(run_id, id) ON DELETE RESTRICT
) STRICT;
CREATE INDEX run_events_run_time ON run_events(run_id, created_at, id);
CREATE INDEX run_events_step ON run_events(step_id);
CREATE TRIGGER run_events_no_update BEFORE UPDATE ON run_events
BEGIN SELECT RAISE(ABORT, 'run_events is append-only'); END;
CREATE TRIGGER run_events_no_delete BEFORE DELETE ON run_events
BEGIN SELECT RAISE(ABORT, 'run_events is append-only'); END;
CREATE TRIGGER run_events_no_replace BEFORE INSERT ON run_events
WHEN EXISTS (SELECT 1 FROM run_events WHERE id = NEW.id)
BEGIN SELECT RAISE(ABORT, 'run_events is append-only'); END;

CREATE TABLE approvals (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(trim(id)) > 0),
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE RESTRICT,
  step_id TEXT,
  action_json TEXT NOT NULL CHECK (json_valid(action_json) AND json_type(action_json) = 'object'),
  policy_reason TEXT NOT NULL CHECK (length(trim(policy_reason)) > 0),
  status TEXT NOT NULL CHECK (status IN ('PENDING','APPROVED','REJECTED','EXPIRED','CANCELLED')),
  requested_at TEXT NOT NULL,
  expires_at TEXT,
  decided_at TEXT,
  decision_maker TEXT,
  decision_note TEXT,
  FOREIGN KEY (run_id, step_id) REFERENCES run_steps(run_id, id) ON DELETE RESTRICT,
  CHECK ((status = 'PENDING' AND decided_at IS NULL AND decision_maker IS NULL AND decision_note IS NULL) OR (status <> 'PENDING' AND decided_at IS NOT NULL)),
  CHECK (status NOT IN ('APPROVED','REJECTED') OR decision_maker IS NOT NULL)
) STRICT;
CREATE INDEX approvals_run_status ON approvals(run_id, status);
CREATE INDEX approvals_step ON approvals(step_id);

CREATE TABLE tool_executions (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(trim(id)) > 0),
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE RESTRICT,
  step_id TEXT NOT NULL,
  tool_name TEXT NOT NULL CHECK (length(trim(tool_name)) > 0),
  idempotency_key TEXT NOT NULL UNIQUE CHECK (length(trim(idempotency_key)) > 0),
  arguments_json TEXT NOT NULL CHECK (json_valid(arguments_json) AND json_type(arguments_json) = 'object'),
  result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
  error_json TEXT CHECK (error_json IS NULL OR (json_valid(error_json) AND json_type(error_json) = 'object')),
  status TEXT NOT NULL CHECK (status IN ('PENDING','RUNNING','SUCCEEDED','FAILED','UNKNOWN_OUTCOME','CANCELLED')),
  attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  FOREIGN KEY (run_id, step_id) REFERENCES run_steps(run_id, id) ON DELETE RESTRICT
) STRICT;
CREATE INDEX tool_executions_run_status ON tool_executions(run_id, status);
CREATE INDEX tool_executions_step ON tool_executions(step_id);

CREATE TABLE company_documents (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(trim(id)) > 0),
  title TEXT NOT NULL CHECK (length(trim(title)) > 0),
  source_path TEXT NOT NULL UNIQUE CHECK (length(source_path) > 0),
  content_hash TEXT NOT NULL CHECK (length(content_hash) = 64 AND content_hash NOT GLOB '*[^0-9a-f]*'),
  metadata_json TEXT NOT NULL CHECK (json_valid(metadata_json) AND json_type(metadata_json) = 'object'),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE artifacts (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(trim(id)) > 0),
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE RESTRICT,
  step_id TEXT,
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  path TEXT NOT NULL CHECK (length(path) > 0),
  mime_type TEXT NOT NULL CHECK (length(mime_type) > 0),
  content_hash TEXT NOT NULL CHECK (length(content_hash) = 64 AND content_hash NOT GLOB '*[^0-9a-f]*'),
  metadata_json TEXT NOT NULL CHECK (json_valid(metadata_json) AND json_type(metadata_json) = 'object'),
  created_at TEXT NOT NULL,
  FOREIGN KEY (run_id, step_id) REFERENCES run_steps(run_id, id) ON DELETE RESTRICT
) STRICT;
CREATE INDEX artifacts_run_time ON artifacts(run_id, created_at);
CREATE INDEX artifacts_step ON artifacts(step_id);

CREATE TABLE memory_entries (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(trim(id)) > 0),
  scope TEXT NOT NULL CHECK (scope IN ('COMPANY','CUSTOMER','RUN')),
  scope_id TEXT,
  content TEXT NOT NULL CHECK (length(trim(content)) > 0),
  source_references_json TEXT NOT NULL CHECK (json_valid(source_references_json) AND json_type(source_references_json) = 'array'),
  trust_status TEXT NOT NULL CHECK (trust_status IN ('PROVISIONAL','APPROVED','REJECTED','RETIRED')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  reviewed_at TEXT,
  reviewed_by TEXT,
  CHECK ((scope = 'COMPANY' AND scope_id IS NULL) OR (scope <> 'COMPANY' AND scope_id IS NOT NULL)),
  CHECK ((trust_status = 'PROVISIONAL' AND reviewed_at IS NULL AND reviewed_by IS NULL) OR (trust_status <> 'PROVISIONAL' AND reviewed_at IS NOT NULL AND reviewed_by IS NOT NULL))
) STRICT;
CREATE INDEX memory_entries_scope_trust ON memory_entries(scope, scope_id, trust_status);
`,
} as const;
