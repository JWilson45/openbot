export const PROTOCOL_IDENTITIES_SCHEMA = `
CREATE TABLE IF NOT EXISTS protocol_identities (
  id text PRIMARY KEY,
  account_id text NOT NULL REFERENCES accounts(id),
  subject_id text NOT NULL,
  protocol text NOT NULL,
  namespace text NOT NULL,
  entity_kind text NOT NULL CHECK(entity_kind IN (
    'thread', 'task', 'run', 'message', 'artifact', 'attachment', 'interrupt'
  )),
  external_id text NOT NULL,
  internal_id text NOT NULL,
  created_at integer NOT NULL,
  UNIQUE(account_id, subject_id, protocol, namespace, entity_kind, external_id),
  UNIQUE(account_id, subject_id, protocol, namespace, entity_kind, internal_id)
);
`;

export const TASK_SCHEMA = `
CREATE TABLE IF NOT EXISTS agent_conversations (
  id text PRIMARY KEY,
  account_id text NOT NULL REFERENCES accounts(id),
  title text,
  metadata_json text NOT NULL DEFAULT '{}',
  created_at integer NOT NULL,
  updated_at integer NOT NULL
);
CREATE INDEX IF NOT EXISTS agent_conversations_account_updated
  ON agent_conversations(account_id, updated_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS agent_tasks (
  id text PRIMARY KEY,
  account_id text NOT NULL REFERENCES accounts(id),
  thread_id text NOT NULL REFERENCES agent_conversations(id),
  agent_id text NOT NULL REFERENCES bots(id),
  status text NOT NULL CHECK(status IN (
    'submitted', 'working', 'input_required', 'auth_required',
    'completed', 'failed', 'canceled', 'rejected'
  )),
  metadata_json text NOT NULL DEFAULT '{}',
  created_at integer NOT NULL,
  updated_at integer NOT NULL
);
CREATE INDEX IF NOT EXISTS agent_tasks_account_updated
  ON agent_tasks(account_id, updated_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS agent_tasks_thread_updated
  ON agent_tasks(thread_id, updated_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS agent_runs (
  id text PRIMARY KEY,
  account_id text NOT NULL REFERENCES accounts(id),
  task_id text NOT NULL REFERENCES agent_tasks(id),
  thread_id text NOT NULL REFERENCES agent_conversations(id),
  agent_id text NOT NULL REFERENCES bots(id),
  attempt integer NOT NULL CHECK(attempt > 0),
  status text NOT NULL CHECK(status IN (
    'queued', 'running', 'interrupted', 'completed', 'failed', 'canceled'
  )),
  provider_session_ref text,
  metadata_json text NOT NULL DEFAULT '{}',
  created_at integer NOT NULL,
  started_at integer,
  finished_at integer,
  UNIQUE(task_id, attempt)
);
CREATE INDEX IF NOT EXISTS agent_runs_task_attempt ON agent_runs(task_id, attempt);

CREATE TABLE IF NOT EXISTS agent_messages (
  id text PRIMARY KEY,
  account_id text NOT NULL REFERENCES accounts(id),
  thread_id text NOT NULL REFERENCES agent_conversations(id),
  task_id text REFERENCES agent_tasks(id),
  run_id text REFERENCES agent_runs(id),
  role text NOT NULL CHECK(role IN ('user', 'agent', 'system', 'tool')),
  parts_json text NOT NULL,
  metadata_json text NOT NULL DEFAULT '{}',
  created_at integer NOT NULL
);
CREATE INDEX IF NOT EXISTS agent_messages_thread_created
  ON agent_messages(account_id, thread_id, created_at, id);
CREATE INDEX IF NOT EXISTS agent_messages_task_created
  ON agent_messages(account_id, task_id, created_at, id);

CREATE TABLE IF NOT EXISTS agent_artifacts (
  id text PRIMARY KEY,
  account_id text NOT NULL REFERENCES accounts(id),
  task_id text NOT NULL REFERENCES agent_tasks(id),
  name text,
  description text,
  parts_json text NOT NULL,
  metadata_json text NOT NULL DEFAULT '{}',
  created_at integer NOT NULL,
  updated_at integer NOT NULL
);
CREATE INDEX IF NOT EXISTS agent_artifacts_task ON agent_artifacts(account_id, task_id, created_at, id);

CREATE TABLE IF NOT EXISTS agent_interrupts (
  id text PRIMARY KEY,
  account_id text NOT NULL REFERENCES accounts(id),
  task_id text NOT NULL REFERENCES agent_tasks(id),
  run_id text NOT NULL REFERENCES agent_runs(id),
  kind text NOT NULL CHECK(kind IN ('permission', 'input', 'auth')),
  prompt text NOT NULL,
  response_schema_json text NOT NULL,
  status text NOT NULL CHECK(status IN ('open', 'resolved', 'expired', 'canceled')),
  response_json text,
  metadata_json text NOT NULL DEFAULT '{}',
  created_at integer NOT NULL,
  expires_at integer,
  resolved_at integer
);
CREATE INDEX IF NOT EXISTS agent_interrupts_task ON agent_interrupts(account_id, task_id, created_at, id);
CREATE UNIQUE INDEX IF NOT EXISTS agent_interrupts_one_open
  ON agent_interrupts(id) WHERE status = 'open';

CREATE TABLE IF NOT EXISTS runtime_interrupt_correlations (
  interrupt_id text PRIMARY KEY REFERENCES agent_interrupts(id),
  account_id text NOT NULL REFERENCES accounts(id),
  task_id text NOT NULL REFERENCES agent_tasks(id),
  run_id text NOT NULL REFERENCES agent_runs(id),
  provider_request_ref text NOT NULL,
  created_at integer NOT NULL,
  UNIQUE(account_id, run_id, provider_request_ref)
);
CREATE INDEX IF NOT EXISTS runtime_interrupt_correlations_task
  ON runtime_interrupt_correlations(account_id, task_id, run_id);

${PROTOCOL_IDENTITIES_SCHEMA}

CREATE TABLE IF NOT EXISTS idempotency_records (
  id text PRIMARY KEY,
  account_id text NOT NULL REFERENCES accounts(id),
  subject_id text NOT NULL,
  operation text NOT NULL,
  idempotency_key text NOT NULL,
  result_json text NOT NULL,
  created_at integer NOT NULL,
  UNIQUE(account_id, subject_id, operation, idempotency_key)
);

CREATE TABLE IF NOT EXISTS task_event_sequences (
  task_id text PRIMARY KEY REFERENCES agent_tasks(id),
  last_seq integer NOT NULL DEFAULT 0 CHECK(last_seq >= 0)
);

CREATE TABLE IF NOT EXISTS task_events (
  event_id text PRIMARY KEY,
  account_id text NOT NULL REFERENCES accounts(id),
  task_id text NOT NULL REFERENCES agent_tasks(id),
  run_id text REFERENCES agent_runs(id),
  seq integer NOT NULL CHECK(seq > 0),
  event_json text NOT NULL,
  created_at integer NOT NULL,
  UNIQUE(task_id, seq)
);
CREATE INDEX IF NOT EXISTS task_events_account_task_seq
  ON task_events(account_id, task_id, seq);

CREATE TABLE IF NOT EXISTS application_outbox (
  id text PRIMARY KEY,
  account_id text NOT NULL REFERENCES accounts(id),
  topic text NOT NULL,
  payload_json text NOT NULL,
  created_at integer NOT NULL,
  available_at integer NOT NULL,
  lease_owner text,
  lease_expires_at integer,
  delivered_at integer,
  attempts integer NOT NULL DEFAULT 0,
  last_error text
);
CREATE INDEX IF NOT EXISTS application_outbox_pending
  ON application_outbox(delivered_at, available_at, lease_expires_at);

CREATE TABLE IF NOT EXISTS attachments (
  id text PRIMARY KEY,
  account_id text NOT NULL REFERENCES accounts(id),
  name text,
  media_type text NOT NULL,
  size integer NOT NULL CHECK(size >= 0 AND size <= 52428800),
  sha256 text NOT NULL,
  storage_ref text NOT NULL,
  created_at integer NOT NULL,
  UNIQUE(account_id, sha256, size)
);

CREATE TABLE IF NOT EXISTS attachment_import_idempotency (
  id text PRIMARY KEY,
  account_id text NOT NULL REFERENCES accounts(id),
  subject_id text NOT NULL,
  idempotency_key text NOT NULL,
  fingerprint text NOT NULL,
  attachment_id text NOT NULL REFERENCES attachments(id),
  created_at integer NOT NULL,
  UNIQUE(account_id, subject_id, idempotency_key)
);
`;
