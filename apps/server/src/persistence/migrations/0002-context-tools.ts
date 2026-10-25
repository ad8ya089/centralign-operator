export const contextToolsMigration = {
  version: 2,
  name: 'context-tools',
  sql: `
CREATE TABLE customers (
  id TEXT PRIMARY KEY NOT NULL,
  company_name TEXT NOT NULL CHECK (length(trim(company_name)) > 0),
  normalized_name TEXT NOT NULL CHECK (length(trim(normalized_name)) > 0),
  contact_name TEXT,
  contact_email TEXT,
  status TEXT NOT NULL CHECK (status IN ('NEW','ONBOARDING','BLOCKED','READY','ACTIVE')),
  metadata_json TEXT NOT NULL CHECK (json_valid(metadata_json) AND json_type(metadata_json) = 'object'),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
CREATE INDEX customers_name ON customers(normalized_name, id);
CREATE INDEX customers_email ON customers(contact_email);

CREATE TABLE projects (
  id TEXT PRIMARY KEY NOT NULL,
  customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  status TEXT NOT NULL CHECK (status IN ('PLANNED','ACTIVE','COMPLETED','CANCELLED')),
  metadata_json TEXT NOT NULL CHECK (json_valid(metadata_json) AND json_type(metadata_json) = 'object'),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (customer_id, id)
) STRICT;
CREATE INDEX projects_customer ON projects(customer_id);

CREATE TABLE tasks (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  title TEXT NOT NULL CHECK (length(trim(title)) > 0),
  description TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('PENDING','IN_PROGRESS','BLOCKED','COMPLETED','CANCELLED')),
  metadata_json TEXT NOT NULL CHECK (json_valid(metadata_json) AND json_type(metadata_json) = 'object'),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
CREATE INDEX tasks_project_status ON tasks(project_id, status, id);

CREATE TABLE email_drafts (
  id TEXT PRIMARY KEY NOT NULL,
  customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  project_id TEXT,
  recipient TEXT NOT NULL CHECK (length(recipient) > 0),
  subject TEXT NOT NULL CHECK (length(trim(subject)) > 0),
  body TEXT NOT NULL CHECK (length(trim(body)) > 0),
  status TEXT NOT NULL CHECK (status IN ('DRAFT','QUEUED')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (customer_id, project_id) REFERENCES projects(customer_id, id) ON DELETE RESTRICT
) STRICT;
CREATE INDEX email_drafts_customer ON email_drafts(customer_id);
CREATE INDEX email_drafts_project ON email_drafts(project_id);

CREATE TABLE sandbox_outbox (
  id TEXT PRIMARY KEY NOT NULL,
  draft_id TEXT NOT NULL UNIQUE REFERENCES email_drafts(id) ON DELETE RESTRICT,
  approval_id TEXT NOT NULL UNIQUE REFERENCES approvals(id) ON DELETE RESTRICT,
  execution_id TEXT NOT NULL UNIQUE REFERENCES tool_executions(id) ON DELETE RESTRICT,
  recipient TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status = 'SANDBOX_QUEUED'),
  created_at TEXT NOT NULL
) STRICT;

ALTER TABLE company_documents ADD COLUMN indexed_content TEXT;
ALTER TABLE company_documents ADD COLUMN indexed_at TEXT;
CREATE TABLE document_chunks (
  id TEXT PRIMARY KEY NOT NULL,
  document_id TEXT NOT NULL REFERENCES company_documents(id) ON DELETE RESTRICT,
  chunk_index INTEGER NOT NULL CHECK (chunk_index >= 0),
  heading TEXT,
  content TEXT NOT NULL CHECK (length(content) > 0),
  content_hash TEXT NOT NULL CHECK (length(content_hash) = 64 AND content_hash NOT GLOB '*[^0-9a-f]*'),
  UNIQUE (document_id, chunk_index)
) STRICT;
CREATE INDEX document_chunks_document ON document_chunks(document_id);
ALTER TABLE tool_executions ADD COLUMN actor_id TEXT;
ALTER TABLE tool_executions ADD COLUMN arguments_hash TEXT CHECK (arguments_hash IS NULL OR length(arguments_hash) = 64);
`,
  optionalFts5Sql: `
CREATE VIRTUAL TABLE document_chunks_fts USING fts5(content, content='document_chunks', content_rowid='rowid');
CREATE TRIGGER document_chunks_fts_insert AFTER INSERT ON document_chunks BEGIN
  INSERT INTO document_chunks_fts(rowid, content) VALUES (new.rowid, new.content);
END;
CREATE TRIGGER document_chunks_fts_delete AFTER DELETE ON document_chunks BEGIN
  INSERT INTO document_chunks_fts(document_chunks_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
END;
CREATE TRIGGER document_chunks_fts_update AFTER UPDATE ON document_chunks BEGIN
  INSERT INTO document_chunks_fts(document_chunks_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
  INSERT INTO document_chunks_fts(rowid, content) VALUES (new.rowid, new.content);
END;
INSERT INTO document_chunks_fts(document_chunks_fts) VALUES ('rebuild');
`,
} as const;
