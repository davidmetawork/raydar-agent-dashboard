create extension if not exists pgcrypto;
create extension if not exists pg_trgm;

create schema if not exists submissions_v2;

create table if not exists submissions_v2.schema_migrations (
  version text primary key,
  digest_sha256 text not null check (digest_sha256 ~ '^[0-9a-f]{64}$'),
  applied_at timestamptz not null default clock_timestamp()
);

create table submissions_v2.runtime_controls (
  singleton boolean primary key default true check (singleton),
  control_epoch bigint not null default 0 check (control_epoch >= 0),
  ui_enabled boolean not null default false,
  ingestion_enabled boolean not null default false,
  generation_enabled boolean not null default false,
  master_inbox_enabled boolean not null default false,
  curated_enabled boolean not null default false,
  actor_email text not null,
  reason text not null check (length(btrim(reason)) between 1 and 500),
  changed_at timestamptz not null default clock_timestamp()
);

create table submissions_v2.runtime_control_events (
  id bigint generated always as identity primary key,
  control_epoch bigint not null unique,
  ui_enabled boolean not null,
  ingestion_enabled boolean not null,
  generation_enabled boolean not null,
  master_inbox_enabled boolean not null,
  curated_enabled boolean not null,
  actor_email text not null,
  reason text not null,
  changed_at timestamptz not null
);

insert into submissions_v2.runtime_controls (
  singleton, control_epoch, ui_enabled, ingestion_enabled, generation_enabled,
  master_inbox_enabled, curated_enabled, actor_email, reason
) values (
  true, 0, false, false, false, false, false,
  'migration@raydar.xyz', 'Safe default: all Submissions V2 controls disabled'
) on conflict (singleton) do nothing;

insert into submissions_v2.runtime_control_events (
  control_epoch, ui_enabled, ingestion_enabled, generation_enabled,
  master_inbox_enabled, curated_enabled, actor_email, reason, changed_at
)
select control_epoch, ui_enabled, ingestion_enabled, generation_enabled,
       master_inbox_enabled, curated_enabled, actor_email, reason, changed_at
  from submissions_v2.runtime_controls
on conflict (control_epoch) do nothing;

create table submissions_v2.source_events (
  id uuid primary key default gen_random_uuid(),
  source_family text not null check (source_family in ('email', 'curated', 'manual')),
  source_version text not null,
  event_id text,
  provider text,
  mailbox_id text,
  provider_message_id text,
  provider_thread_id text,
  outbound_message_id text,
  direction text check (direction is null or direction in ('inbound', 'manual', 'observed')),
  sent_at timestamptz,
  received_at timestamptz not null,
  ingested_at timestamptz not null default clock_timestamp(),
  encrypted_body_object_key text,
  encrypted_sender_object_key text,
  content_digest text not null check (content_digest ~ '^[0-9a-f]{64}$'),
  sender_match_hmac_current text,
  sender_match_hmac_current_version text,
  sender_match_hmac_previous text,
  sender_match_hmac_previous_version text,
  sender_display_name text,
  machine_flag boolean not null default false,
  machine_reason text,
  processing_state text not null default 'received' check (processing_state in (
    'received', 'ignored_machine', 'unsupported_version', 'needs_candidate',
    'needs_role', 'ready', 'resolved', 'quarantined', 'ignored_later'
  )),
  processed_at timestamptz,
  safe_error_code text,
  safe_error_detail text check (safe_error_detail is null or length(safe_error_detail) <= 500),
  idempotency_key text not null unique,
  envelope jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default clock_timestamp(),
  check (source_family <> 'email' or (
    mailbox_id is not null and provider_message_id is not null and direction = 'inbound'
  )),
  check ((sender_match_hmac_previous is null) = (sender_match_hmac_previous_version is null)),
  check ((sender_match_hmac_current is null) = (sender_match_hmac_current_version is null))
);

create unique index source_events_email_provider_message_uq
  on submissions_v2.source_events (mailbox_id, provider_message_id)
  where source_family = 'email';
create unique index source_events_event_id_uq
  on submissions_v2.source_events (event_id)
  where event_id is not null;
create index source_events_processing_idx
  on submissions_v2.source_events (processing_state, received_at, id);
create index source_events_sender_hmac_current_idx
  on submissions_v2.source_events (sender_match_hmac_current)
  where sender_match_hmac_current is not null;

create table submissions_v2.source_offered_roles (
  signal_id uuid not null references submissions_v2.source_events(id) on delete restrict,
  role_id text not null,
  company_snapshot text,
  role_label_snapshot text not null,
  role_url_snapshot text,
  offered_order integer not null default 0 check (offered_order >= 0),
  content_digest text check (content_digest is null or content_digest ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default clock_timestamp(),
  primary key (signal_id, role_id)
);

create table submissions_v2.signal_role_decisions (
  id uuid primary key default gen_random_uuid(),
  signal_id uuid not null references submissions_v2.source_events(id) on delete restrict,
  role_id text not null,
  candidate_user_id text,
  decision_label text not null check (decision_label in ('interested', 'needs_review', 'not_interested')),
  exact_quote text,
  binding_result text not null,
  primary_model_pin text,
  fallback_model_pin text,
  selected_model_pin text,
  prompt_pin text,
  schema_version text not null,
  validation jsonb not null default '{}'::jsonb,
  decided_at timestamptz not null default clock_timestamp(),
  unique (signal_id, role_id),
  foreign key (signal_id, role_id)
    references submissions_v2.source_offered_roles(signal_id, role_id) on delete restrict,
  check (decision_label = 'needs_review' or length(btrim(coalesce(exact_quote, ''))) > 0)
);

create table submissions_v2.candidate_role_pairs (
  id uuid primary key default gen_random_uuid(),
  candidate_user_id text not null,
  role_id text not null,
  first_signal_id uuid not null references submissions_v2.source_events(id) on delete restrict,
  intent_state text not null check (intent_state in ('unknown', 'unclear', 'interested', 'not_interested')),
  workflow_state text not null check (workflow_state in (
    'classifying', 'preparing_resume', 'interested', 'needs_review', 'not_interested'
  )),
  state_version bigint not null default 1 check (state_version >= 1),
  owner_email text,
  original_signal_at timestamptz not null,
  current_artifact_id uuid,
  resume_ready_at timestamptz,
  role_state text not null default 'unknown' check (role_state in ('unknown', 'active', 'unavailable', 'delayed')),
  role_checked_at timestamptz,
  submission_status text not null default 'none' check (submission_status in ('none', 'opened', 'proven')),
  submission_opened_at timestamptz,
  submission_proven_at timestamptz,
  submission_application_id text,
  submission_authoritative_path text,
  submission_evidence_digest text check (
    submission_evidence_digest is null or submission_evidence_digest ~ '^[0-9a-f]{64}$'
  ),
  case_hidden_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique (candidate_user_id, role_id),
  check (workflow_state <> 'classifying' or intent_state = 'unknown'),
  check (workflow_state <> 'preparing_resume' or intent_state = 'interested'),
  check (workflow_state <> 'interested' or (
    intent_state = 'interested' and current_artifact_id is not null and resume_ready_at is not null
  )),
  check (workflow_state <> 'not_interested' or intent_state = 'not_interested'),
  check (workflow_state <> 'needs_review' or intent_state <> 'not_interested'),
  check (submission_status <> 'opened' or submission_opened_at is not null),
  check (
    (submission_status = 'proven' and submission_proven_at is not null
      and submission_application_id is not null and submission_authoritative_path is not null
      and submission_evidence_digest is not null and workflow_state = 'interested')
    or
    (submission_status <> 'proven' and submission_proven_at is null
      and submission_application_id is null and submission_authoritative_path is null
      and submission_evidence_digest is null)
  )
);

create index candidate_role_pairs_list_idx
  on submissions_v2.candidate_role_pairs (workflow_state, submission_status, original_signal_at desc, id);
create index candidate_role_pairs_owner_idx
  on submissions_v2.candidate_role_pairs (owner_email, workflow_state, original_signal_at desc);

create table submissions_v2.pair_events (
  id bigint generated always as identity primary key,
  pair_id uuid not null references submissions_v2.candidate_role_pairs(id) on delete restrict,
  actor_type text not null check (actor_type in ('human', 'worker', 'source', 'system', 'administrator')),
  actor_id text not null,
  source text not null,
  event_type text not null,
  from_intent_state text,
  to_intent_state text,
  from_workflow_state text,
  to_workflow_state text,
  from_submission_status text,
  to_submission_status text,
  expected_version bigint,
  new_version bigint,
  note text,
  reason_code text,
  causation_id text,
  correlation_id text,
  idempotency_key text not null unique,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default clock_timestamp(),
  check (
    (expected_version is null and new_version is null)
    or (expected_version is not null and new_version = expected_version + 1)
  )
);
create index pair_events_pair_time_idx on submissions_v2.pair_events (pair_id, created_at, id);

create table submissions_v2.review_items (
  id uuid primary key default gen_random_uuid(),
  pair_id uuid references submissions_v2.candidate_role_pairs(id) on delete restrict,
  unresolved_signal_id uuid references submissions_v2.source_events(id) on delete restrict,
  reason_code text not null check (reason_code in (
    'candidate_not_found', 'candidate_ambiguous', 'reply_unclear_or_conditional',
    'candidate_question', 'role_unclear', 'role_unavailable',
    'candidate_original_resume_missing', 'classification_failed', 'resume_preparation_failed'
  )),
  owner_email text,
  safe_detail text check (safe_detail is null or length(safe_detail) <= 500),
  evidence jsonb not null default '{}'::jsonb,
  action_state text not null default 'open' check (action_state in ('open', 'resolved', 'dismissed')),
  opened_at timestamptz not null default clock_timestamp(),
  resolved_at timestamptz,
  resolved_by text,
  resolution_note text,
  updated_at timestamptz not null default clock_timestamp(),
  check ((pair_id is not null)::integer + (unresolved_signal_id is not null)::integer = 1),
  check (
    (action_state = 'open' and resolved_at is null and resolved_by is null)
    or (action_state <> 'open' and resolved_at is not null and resolved_by is not null)
  )
);
create unique index review_items_open_pair_reason_uq
  on submissions_v2.review_items (pair_id, reason_code)
  where pair_id is not null and action_state = 'open';
create unique index review_items_open_signal_reason_uq
  on submissions_v2.review_items (unresolved_signal_id, reason_code)
  where unresolved_signal_id is not null and action_state = 'open';
create index review_items_owner_opened_idx
  on submissions_v2.review_items (owner_email, opened_at, id)
  where action_state = 'open';

create table submissions_v2.not_interested_entries (
  id uuid primary key default gen_random_uuid(),
  pair_id uuid not null references submissions_v2.candidate_role_pairs(id) on delete restrict,
  source_event_id uuid not null references submissions_v2.source_events(id) on delete restrict,
  original_negative_at timestamptz not null,
  grounded_reason text not null,
  exact_quote text,
  evidence_digest text not null check (evidence_digest ~ '^[0-9a-f]{64}$'),
  notification_dedupe_key text,
  corrected_destination text check (corrected_destination is null or corrected_destination in ('interested', 'needs_review')),
  corrected_at timestamptz,
  corrected_by text,
  correction_note text,
  active_projection boolean not null default true,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique (pair_id, source_event_id),
  check (
    (corrected_destination is null and corrected_at is null and corrected_by is null and correction_note is null and active_projection)
    or (corrected_destination is not null and corrected_at is not null and corrected_by is not null
      and length(btrim(coalesce(correction_note, ''))) > 0 and not active_projection)
  )
);
create index not_interested_history_idx
  on submissions_v2.not_interested_entries (original_negative_at desc, id);

create table submissions_v2.classification_attempts (
  id uuid primary key default gen_random_uuid(),
  signal_id uuid not null references submissions_v2.source_events(id) on delete restrict,
  attempt integer not null check (attempt between 1 and 3),
  model_pin text not null,
  prompt_pin text not null,
  fallback_reason text,
  structured_result jsonb,
  exact_quote text,
  input_tokens integer check (input_tokens is null or input_tokens >= 0),
  output_tokens integer check (output_tokens is null or output_tokens >= 0),
  cost_micros integer not null default 0 check (cost_micros between 0 and 20000),
  duration_ms integer check (duration_ms is null or duration_ms between 0 and 30000),
  outcome text not null check (outcome in ('passed', 'invalid_schema', 'invalid_quote', 'technical_failure', 'budget_exhausted', 'timeout')),
  safe_error_code text,
  safe_error_detail text check (safe_error_detail is null or length(safe_error_detail) <= 500),
  created_at timestamptz not null default clock_timestamp(),
  unique (signal_id, attempt)
);

create table submissions_v2.curated_snapshots (
  candidate_user_id text not null,
  role_id text not null,
  last_confirmed_status text not null,
  digest text not null check (digest ~ '^[0-9a-f]{64}$'),
  first_seen_at timestamptz not null,
  last_success_at timestamptz not null,
  resolved boolean not null default false,
  source_run_id uuid,
  updated_at timestamptz not null default clock_timestamp(),
  primary key (candidate_user_id, role_id)
);

create table submissions_v2.source_cursors (
  source_key text primary key,
  activation_cursor jsonb not null default '{}'::jsonb,
  checkpoint jsonb not null default '{}'::jsonb,
  last_full_success_at timestamptz,
  lease_owner text,
  lease_expires_at timestamptz,
  fencing_token bigint not null default 0 check (fencing_token >= 0),
  control_epoch bigint not null default 0 check (control_epoch >= 0),
  updated_at timestamptz not null default clock_timestamp(),
  check ((lease_owner is null) = (lease_expires_at is null))
);

create table submissions_v2.source_runs (
  id uuid primary key default gen_random_uuid(),
  source_key text not null references submissions_v2.source_cursors(source_key) on delete restrict,
  range_start jsonb not null default '{}'::jsonb,
  range_end jsonb not null default '{}'::jsonb,
  complete boolean not null default false,
  read_count integer not null default 0 check (read_count >= 0),
  changed_count integer not null default 0 check (changed_count >= 0),
  error_class text,
  safe_error_detail text check (safe_error_detail is null or length(safe_error_detail) <= 500),
  commit_state text not null default 'started' check (commit_state in ('started', 'committed', 'partial', 'failed')),
  started_at timestamptz not null default clock_timestamp(),
  completed_at timestamptz,
  created_at timestamptz not null default clock_timestamp()
);
create index source_runs_source_time_idx on submissions_v2.source_runs (source_key, started_at desc);

create table submissions_v2.source_health (
  source_key text primary key,
  enabled boolean not null default false,
  last_success_at timestamptz,
  delayed_since timestamptz,
  last_alert_at timestamptz,
  last_recovery_at timestamptz,
  quota_state text not null default 'clear' check (quota_state in ('clear', 'slowed', 'paused')),
  quota_retry_at timestamptz,
  current_run_id uuid references submissions_v2.source_runs(id) on delete set null,
  error_class text,
  safe_error_detail text check (safe_error_detail is null or length(safe_error_detail) <= 500),
  updated_at timestamptz not null default clock_timestamp()
);

create table submissions_v2.candidate_index (
  candidate_user_id text primary key,
  display_name text not null,
  normalized_name text not null,
  search_key text not null,
  email_match_hmac_current text,
  email_match_hmac_current_version text,
  email_match_hmac_previous text,
  email_match_hmac_previous_version text,
  paraform_profile_url text not null,
  linkedin_url text,
  raydar_url text,
  owner_email text,
  has_recorded_call boolean not null default false,
  last_call_at timestamptz,
  provider_updated_at timestamptz,
  last_confirmed_at timestamptz not null,
  source_digest text not null check (source_digest ~ '^[0-9a-f]{64}$'),
  indexed_at timestamptz not null default clock_timestamp(),
  active boolean not null default true,
  check ((email_match_hmac_current is null) = (email_match_hmac_current_version is null)),
  check ((email_match_hmac_previous is null) = (email_match_hmac_previous_version is null))
);
create index candidate_index_search_trgm_idx
  on submissions_v2.candidate_index using gin (search_key gin_trgm_ops);
create index candidate_index_hmac_current_idx
  on submissions_v2.candidate_index (email_match_hmac_current)
  where email_match_hmac_current is not null;
create index candidate_index_hmac_previous_idx
  on submissions_v2.candidate_index (email_match_hmac_previous)
  where email_match_hmac_previous is not null;

create table submissions_v2.role_index (
  role_id text primary key,
  company_name text not null,
  role_title text not null,
  search_key text not null,
  active boolean not null,
  destination_url text not null,
  owner_email text,
  provider_updated_at timestamptz,
  last_confirmed_at timestamptz not null,
  source_digest text not null check (source_digest ~ '^[0-9a-f]{64}$'),
  indexed_at timestamptz not null default clock_timestamp()
);
create index role_index_active_search_trgm_idx
  on submissions_v2.role_index using gin (search_key gin_trgm_ops)
  where active;

create table submissions_v2.api_commands (
  id uuid primary key default gen_random_uuid(),
  actor_email text not null,
  action text not null,
  idempotency_key text not null,
  request_digest text not null check (request_digest ~ '^[0-9a-f]{64}$'),
  expected_version bigint,
  pair_id uuid references submissions_v2.candidate_role_pairs(id) on delete restrict,
  status text not null default 'started' check (status in ('started', 'succeeded', 'failed')),
  result jsonb,
  safe_error_code text,
  created_at timestamptz not null default clock_timestamp(),
  completed_at timestamptz,
  unique (actor_email, idempotency_key)
);

create table submissions_v2.jobs (
  id uuid primary key default gen_random_uuid(),
  kind text not null,
  subject_type text not null,
  subject_id text not null,
  command_id uuid references submissions_v2.api_commands(id) on delete restrict,
  idempotency_key text not null,
  required_control text not null check (required_control in ('ui', 'ingestion', 'generation', 'master_inbox', 'curated', 'always')),
  scheduled_at timestamptz not null default clock_timestamp(),
  state text not null default 'queued' check (state in ('queued', 'running', 'held', 'succeeded', 'failed', 'cancelled')),
  priority integer not null default 100 check (priority between 0 and 1000),
  lease_owner text,
  lease_expires_at timestamptz,
  fencing_token bigint not null default 0 check (fencing_token >= 0),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  max_attempts integer not null default 3 check (max_attempts between 1 and 20),
  checkpoint jsonb not null default '{}'::jsonb,
  safe_error_code text,
  safe_error_detail text check (safe_error_detail is null or length(safe_error_detail) <= 500),
  hold_reason text,
  control_epoch bigint not null check (control_epoch >= 0),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  started_at timestamptz,
  completed_at timestamptz,
  unique (kind, idempotency_key),
  check ((lease_owner is null) = (lease_expires_at is null)),
  check (state = 'running' or lease_owner is null),
  check (state not in ('succeeded', 'failed', 'cancelled') or completed_at is not null)
);
create index jobs_claim_idx
  on submissions_v2.jobs (priority, scheduled_at, created_at)
  where state in ('queued', 'running');
create index jobs_subject_idx on submissions_v2.jobs (subject_type, subject_id, created_at desc);

create table submissions_v2.job_attempts (
  id bigint generated always as identity primary key,
  job_id uuid not null references submissions_v2.jobs(id) on delete restrict,
  attempt_no integer not null check (attempt_no >= 1),
  fencing_token bigint not null check (fencing_token >= 1),
  worker_id text not null,
  control_epoch bigint not null check (control_epoch >= 0),
  started_at timestamptz not null default clock_timestamp(),
  finished_at timestamptz,
  outcome text check (outcome is null or outcome in ('succeeded', 'retry', 'failed', 'held', 'lease_expired')),
  checkpoint jsonb not null default '{}'::jsonb,
  safe_error_code text,
  safe_error_detail text check (safe_error_detail is null or length(safe_error_detail) <= 500),
  unique (job_id, fencing_token)
);

create table submissions_v2.resume_generations (
  id uuid primary key default gen_random_uuid(),
  pair_id uuid not null references submissions_v2.candidate_role_pairs(id) on delete restrict,
  generation_version integer not null check (generation_version >= 1),
  trigger_kind text not null check (trigger_kind in ('initial', 'regenerate', 'retry')),
  command_id uuid references submissions_v2.api_commands(id) on delete restrict,
  idempotency_key text not null unique,
  status text not null default 'queued' check (status in (
    'queued', 'collecting', 'extracting', 'strategizing', 'validating', 'rendering',
    'archiving', 'succeeded', 'failed', 'cancelled', 'held'
  )),
  stage text not null default 'queued',
  expected_pair_version bigint not null check (expected_pair_version >= 1),
  first_signal_id uuid not null references submissions_v2.source_events(id) on delete restrict,
  primary_model_pin text not null,
  fallback_model_pin text not null,
  validator_model_pin text not null,
  prompt_pin text not null,
  template_pin text not null,
  source_digest text,
  instruction_digest text,
  budget_cents integer not null default 200 check (budget_cents between 1 and 200),
  spent_cents integer not null default 0 check (spent_cents between 0 and 200),
  deadline_at timestamptz not null,
  prior_artifact_id uuid,
  safe_failure_code text,
  safe_failure_detail text check (safe_failure_detail is null or length(safe_failure_detail) <= 500),
  created_at timestamptz not null default clock_timestamp(),
  started_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz not null default clock_timestamp(),
  unique (pair_id, generation_version)
);
create unique index resume_generations_one_active_per_pair_uq
  on submissions_v2.resume_generations (pair_id)
  where status in ('queued', 'collecting', 'extracting', 'strategizing', 'validating', 'rendering', 'archiving');

create table submissions_v2.resume_stage_runs (
  id uuid primary key default gen_random_uuid(),
  generation_id uuid not null references submissions_v2.resume_generations(id) on delete restrict,
  stage text not null,
  attempt integer not null check (attempt between 1 and 3),
  input_digest text not null check (input_digest ~ '^[0-9a-f]{64}$'),
  output_object_key text,
  output_digest text check (output_digest is null or output_digest ~ '^[0-9a-f]{64}$'),
  status text not null check (status in ('running', 'succeeded', 'failed', 'held')),
  cost_cents integer not null default 0 check (cost_cents between 0 and 200),
  started_at timestamptz not null default clock_timestamp(),
  completed_at timestamptz,
  safe_error_code text,
  safe_error_detail text check (safe_error_detail is null or length(safe_error_detail) <= 500),
  unique (generation_id, stage, attempt)
);

create table submissions_v2.resume_sources (
  id uuid primary key default gen_random_uuid(),
  generation_id uuid not null references submissions_v2.resume_generations(id) on delete restrict,
  source_key text not null,
  status text not null check (status in ('present', 'partial', 'missing', 'unreadable', 'denied', 'stale')),
  requiredness text not null check (requiredness in ('critical', 'expected', 'optional')),
  origin text not null check (origin in ('candidate_original', 'raydar_generated', 'origin_unverified', 'not_applicable')),
  source_id text,
  source_locator text,
  captured_at timestamptz,
  source_updated_at timestamptz,
  content_digest text check (content_digest is null or content_digest ~ '^[0-9a-f]{64}$'),
  normalized_text_digest text check (normalized_text_digest is null or normalized_text_digest ~ '^[0-9a-f]{64}$'),
  item_count integer check (item_count is null or item_count >= 0),
  accuracy_impact text,
  remediation text,
  created_at timestamptz not null default clock_timestamp(),
  unique (generation_id, source_key)
);

create table submissions_v2.resume_supplements (
  id uuid primary key default gen_random_uuid(),
  pair_id uuid not null references submissions_v2.candidate_role_pairs(id) on delete restrict,
  generation_id uuid references submissions_v2.resume_generations(id) on delete restrict,
  supplement_kind text not null check (supplement_kind in ('evidence', 'generation_instruction')),
  text_value_encrypted bytea,
  object_key text,
  extracted_text_object_key text,
  creator_email text not null,
  created_at timestamptz not null default clock_timestamp(),
  mime_type text,
  original_name text,
  size_bytes bigint check (size_bytes is null or size_bytes between 0 and 20971520),
  digest text not null check (digest ~ '^[0-9a-f]{64}$'),
  scan_state text not null default 'pending' check (scan_state in ('pending', 'clean', 'rejected', 'failed', 'not_applicable')),
  parse_state text not null default 'pending' check (parse_state in ('pending', 'parsed', 'failed', 'not_applicable')),
  active boolean not null default true,
  deleted_at timestamptz,
  deletion_actor text,
  evidence_basis text,
  source_or_correction_note text,
  check ((text_value_encrypted is not null)::integer + (object_key is not null)::integer = 1),
  check ((supplement_kind = 'evidence' and generation_id is null) or
         (supplement_kind = 'generation_instruction' and generation_id is not null)),
  check ((active and deleted_at is null and deletion_actor is null) or
         (not active and deleted_at is not null and deletion_actor is not null))
);
create index resume_supplements_pair_active_idx
  on submissions_v2.resume_supplements (pair_id, created_at)
  where active;

create table submissions_v2.resume_claims (
  id uuid primary key default gen_random_uuid(),
  generation_id uuid not null references submissions_v2.resume_generations(id) on delete restrict,
  claim_key text not null,
  original_wording text not null,
  final_wording text,
  claim_kind text not null,
  retained boolean not null default true,
  final_status text not null default 'pending' check (final_status in ('pending', 'passed', 'removed', 'failed')),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique (generation_id, claim_key),
  check ((retained and final_status <> 'removed') or (not retained and final_status = 'removed'))
);

create table submissions_v2.claim_evidence_links (
  id uuid primary key default gen_random_uuid(),
  claim_id uuid not null references submissions_v2.resume_claims(id) on delete restrict,
  resume_source_id uuid not null references submissions_v2.resume_sources(id) on delete restrict,
  candidate_side boolean not null,
  exact_locator text not null,
  exact_excerpt text,
  evidence_digest text not null check (evidence_digest ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default clock_timestamp(),
  unique (claim_id, resume_source_id, exact_locator)
);

create table submissions_v2.claim_validations (
  id uuid primary key default gen_random_uuid(),
  claim_id uuid not null references submissions_v2.resume_claims(id) on delete restrict,
  attempt integer not null check (attempt between 1 and 3),
  validator_model_pin text not null,
  result text not null check (result in ('passed', 'narrowed', 'removed', 'failed')),
  rewrite_text text,
  reason text,
  input_digest text not null check (input_digest ~ '^[0-9a-f]{64}$'),
  output_digest text check (output_digest is null or output_digest ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default clock_timestamp(),
  unique (claim_id, attempt)
);

create table submissions_v2.resume_artifacts (
  id uuid primary key default gen_random_uuid(),
  pair_id uuid not null references submissions_v2.candidate_role_pairs(id) on delete restrict,
  generation_id uuid not null references submissions_v2.resume_generations(id) on delete restrict,
  artifact_version integer not null check (artifact_version >= 1),
  kind text not null check (kind in ('pdf', 'ats', 'manifest')),
  private_object_key text not null,
  digest text not null check (digest ~ '^[0-9a-f]{64}$'),
  size_bytes bigint not null check (size_bytes > 0),
  page_count integer check (page_count is null or page_count between 1 and 2),
  text_digest text check (text_digest is null or text_digest ~ '^[0-9a-f]{64}$'),
  validation_status text not null check (validation_status in ('pending', 'passed', 'failed')),
  archive_readback_at timestamptz,
  archived_at timestamptz,
  deleted_at timestamptz,
  current_state text not null default 'staged' check (current_state in ('staged', 'current', 'superseded', 'deleted', 'purged')),
  created_at timestamptz not null default clock_timestamp(),
  unique (pair_id, artifact_version, kind),
  unique (generation_id, kind),
  check (kind = 'pdf' or page_count is null),
  check (validation_status <> 'passed' or archive_readback_at is not null),
  check (current_state not in ('current', 'superseded') or (validation_status = 'passed' and archived_at is not null)),
  check (current_state <> 'deleted' or deleted_at is not null)
);
create unique index resume_artifacts_one_current_kind_uq
  on submissions_v2.resume_artifacts (pair_id, kind)
  where current_state = 'current';
create index resume_artifacts_archive_lookup_idx
  on submissions_v2.resume_artifacts (pair_id, artifact_version desc, kind);

create table submissions_v2.artifact_deletions (
  id uuid primary key default gen_random_uuid(),
  artifact_id uuid not null references submissions_v2.resume_artifacts(id) on delete restrict,
  admin_actor text not null,
  reason text not null,
  soft_deleted_at timestamptz not null default clock_timestamp(),
  purge_after timestamptz not null,
  restored_at timestamptz,
  restored_by text,
  purged_at timestamptz,
  purge_result text,
  created_at timestamptz not null default clock_timestamp(),
  check (purge_after >= soft_deleted_at + interval '30 days'),
  check (restored_at is null or purged_at is null)
);
create unique index artifact_deletions_one_open_uq
  on submissions_v2.artifact_deletions (artifact_id)
  where restored_at is null and purged_at is null;

alter table submissions_v2.candidate_role_pairs
  add constraint candidate_role_pairs_current_artifact_fk
  foreign key (current_artifact_id) references submissions_v2.resume_artifacts(id)
  deferrable initially deferred;

alter table submissions_v2.resume_generations
  add constraint resume_generations_prior_artifact_fk
  foreign key (prior_artifact_id) references submissions_v2.resume_artifacts(id)
  deferrable initially deferred;

create table submissions_v2.submission_proofs (
  id uuid primary key default gen_random_uuid(),
  pair_id uuid not null references submissions_v2.candidate_role_pairs(id) on delete restrict,
  application_id text not null,
  authoritative_path text not null,
  evidence_digest text not null check (evidence_digest ~ '^[0-9a-f]{64}$'),
  observed_at timestamptz not null,
  source_checked_at timestamptz not null,
  created_at timestamptz not null default clock_timestamp(),
  unique (pair_id, application_id)
);

create table submissions_v2.notification_outbox (
  id uuid primary key default gen_random_uuid(),
  kind text not null,
  destination_id text not null,
  safe_payload jsonb not null,
  dedupe_key text not null unique,
  state text not null default 'pending' check (state in ('pending', 'sending', 'sent', 'failed', 'held')),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  next_attempt_at timestamptz not null default clock_timestamp(),
  provider_receipt text,
  recovery_link text,
  safe_error_code text,
  safe_error_detail text check (safe_error_detail is null or length(safe_error_detail) <= 500),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  sent_at timestamptz
);
create index notification_outbox_due_idx
  on submissions_v2.notification_outbox (next_attempt_at, created_at)
  where state in ('pending', 'failed');

create table submissions_v2.download_audit (
  id uuid primary key default gen_random_uuid(),
  user_email text not null,
  artifact_id uuid not null references submissions_v2.resume_artifacts(id) on delete restrict,
  pair_id uuid not null references submissions_v2.candidate_role_pairs(id) on delete restrict,
  disposition text not null check (disposition in ('attachment', 'archive_retrieval')),
  signed_url_expires_at timestamptz,
  requested_at timestamptz not null default clock_timestamp(),
  result text not null check (result in ('issued', 'denied', 'failed')),
  safe_error_code text,
  request_digest text not null check (request_digest ~ '^[0-9a-f]{64}$')
);
create index download_audit_pair_time_idx
  on submissions_v2.download_audit (pair_id, requested_at desc);

create table submissions_v2.case_deletions (
  id uuid primary key default gen_random_uuid(),
  pair_id uuid not null references submissions_v2.candidate_role_pairs(id) on delete restrict,
  admin_actor text not null,
  reason text not null,
  requested_at timestamptz not null default clock_timestamp(),
  recovery_deadline timestamptz not null,
  state text not null default 'soft_deleted' check (state in ('soft_deleted', 'restored', 'purged', 'purge_failed')),
  encrypted_manifest_object_key text not null,
  manifest_digest text not null check (manifest_digest ~ '^[0-9a-f]{64}$'),
  restored_at timestamptz,
  restored_by text,
  purged_at timestamptz,
  purge_result text,
  tombstone_case_hmac text,
  created_at timestamptz not null default clock_timestamp(),
  check (recovery_deadline >= requested_at + interval '30 days')
);
create unique index case_deletions_one_open_uq
  on submissions_v2.case_deletions (pair_id)
  where state = 'soft_deleted';
