create or replace function submissions_v2.touch_updated_at()
returns trigger
language plpgsql
set search_path = pg_catalog, submissions_v2
as $$
begin
  new.updated_at := clock_timestamp();
  return new;
end;
$$;

create or replace function submissions_v2.reject_append_only_mutation()
returns trigger
language plpgsql
set search_path = pg_catalog, submissions_v2
as $$
begin
  if current_user = 'submissions_v2_purge'
     and current_setting('submissions_v2.approved_purge', true) = 'on' then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;
  raise exception using
    errcode = '55000',
    message = format('%I.%I is append-only', tg_table_schema, tg_table_name);
end;
$$;

create trigger runtime_control_events_append_only
before update or delete on submissions_v2.runtime_control_events
for each row execute function submissions_v2.reject_append_only_mutation();
create trigger source_offered_roles_append_only
before update or delete on submissions_v2.source_offered_roles
for each row execute function submissions_v2.reject_append_only_mutation();
create trigger signal_role_decisions_append_only
before update or delete on submissions_v2.signal_role_decisions
for each row execute function submissions_v2.reject_append_only_mutation();
create trigger pair_events_append_only
before update or delete on submissions_v2.pair_events
for each row execute function submissions_v2.reject_append_only_mutation();
create trigger classification_attempts_append_only
before update or delete on submissions_v2.classification_attempts
for each row execute function submissions_v2.reject_append_only_mutation();
create trigger claim_evidence_links_append_only
before update or delete on submissions_v2.claim_evidence_links
for each row execute function submissions_v2.reject_append_only_mutation();
create trigger claim_validations_append_only
before update or delete on submissions_v2.claim_validations
for each row execute function submissions_v2.reject_append_only_mutation();
create trigger submission_proofs_append_only
before update or delete on submissions_v2.submission_proofs
for each row execute function submissions_v2.reject_append_only_mutation();
create trigger download_audit_append_only
before update or delete on submissions_v2.download_audit
for each row execute function submissions_v2.reject_append_only_mutation();

revoke update, delete, truncate on submissions_v2.runtime_control_events from public;
revoke update, delete, truncate on submissions_v2.source_offered_roles from public;
revoke update, delete, truncate on submissions_v2.signal_role_decisions from public;
revoke update, delete, truncate on submissions_v2.pair_events from public;
revoke update, delete, truncate on submissions_v2.classification_attempts from public;
revoke update, delete, truncate on submissions_v2.claim_evidence_links from public;
revoke update, delete, truncate on submissions_v2.claim_validations from public;
revoke update, delete, truncate on submissions_v2.submission_proofs from public;
revoke update, delete, truncate on submissions_v2.download_audit from public;

create or replace function submissions_v2.guard_source_event_evidence()
returns trigger
language plpgsql
set search_path = pg_catalog, submissions_v2
as $$
declare
  mutable_columns constant text[] := array[
    'processing_state', 'processed_at', 'safe_error_code', 'safe_error_detail'
  ];
begin
  if (to_jsonb(new) - mutable_columns) is distinct from (to_jsonb(old) - mutable_columns) then
    raise exception using errcode = '55000', message = 'source event evidence is immutable';
  end if;
  return new;
end;
$$;

create trigger source_events_evidence_immutable
before update on submissions_v2.source_events
for each row execute function submissions_v2.guard_source_event_evidence();

create or replace function submissions_v2.guard_pair_identity()
returns trigger
language plpgsql
set search_path = pg_catalog, submissions_v2
as $$
begin
  if new.candidate_user_id is distinct from old.candidate_user_id
     or new.role_id is distinct from old.role_id
     or new.first_signal_id is distinct from old.first_signal_id
     or new.original_signal_at is distinct from old.original_signal_at
     or new.created_at is distinct from old.created_at then
    raise exception using errcode = '55000', message = 'candidate-role identity and first signal are immutable';
  end if;
  if new.state_version <> old.state_version + 1 then
    raise exception using errcode = '40001', message = 'pair state_version must advance by exactly one';
  end if;
  return new;
end;
$$;

create trigger candidate_role_pairs_identity_immutable
before update on submissions_v2.candidate_role_pairs
for each row execute function submissions_v2.guard_pair_identity();
create trigger candidate_role_pairs_touch
before update on submissions_v2.candidate_role_pairs
for each row execute function submissions_v2.touch_updated_at();

create or replace function submissions_v2.guard_not_interested_history()
returns trigger
language plpgsql
set search_path = pg_catalog, submissions_v2
as $$
declare
  mutable_columns constant text[] := array[
    'corrected_destination', 'corrected_at', 'corrected_by', 'correction_note',
    'active_projection', 'updated_at'
  ];
begin
  if (to_jsonb(new) - mutable_columns) is distinct from (to_jsonb(old) - mutable_columns) then
    raise exception using errcode = '55000', message = 'negative evidence history is immutable';
  end if;
  if old.corrected_destination is not null then
    raise exception using errcode = '55000', message = 'a corrected negative history entry is permanent';
  end if;
  return new;
end;
$$;

create trigger not_interested_entries_evidence_immutable
before update on submissions_v2.not_interested_entries
for each row execute function submissions_v2.guard_not_interested_history();
create trigger not_interested_entries_touch
before update on submissions_v2.not_interested_entries
for each row execute function submissions_v2.touch_updated_at();

create or replace function submissions_v2.guard_artifact_identity()
returns trigger
language plpgsql
set search_path = pg_catalog, submissions_v2
as $$
begin
  if new.pair_id is distinct from old.pair_id
     or new.generation_id is distinct from old.generation_id
     or new.artifact_version is distinct from old.artifact_version
     or new.kind is distinct from old.kind
     or new.private_object_key is distinct from old.private_object_key
     or new.digest is distinct from old.digest
     or new.created_at is distinct from old.created_at then
    raise exception using errcode = '55000', message = 'artifact identity and archived content are immutable';
  end if;
  return new;
end;
$$;

create trigger resume_artifacts_identity_immutable
before update on submissions_v2.resume_artifacts
for each row execute function submissions_v2.guard_artifact_identity();

create trigger review_items_touch
before update on submissions_v2.review_items
for each row execute function submissions_v2.touch_updated_at();
create trigger source_cursors_touch
before update on submissions_v2.source_cursors
for each row execute function submissions_v2.touch_updated_at();
create trigger source_health_touch
before update on submissions_v2.source_health
for each row execute function submissions_v2.touch_updated_at();
create trigger jobs_touch
before update on submissions_v2.jobs
for each row execute function submissions_v2.touch_updated_at();
create trigger resume_generations_touch
before update on submissions_v2.resume_generations
for each row execute function submissions_v2.touch_updated_at();
create trigger resume_claims_touch
before update on submissions_v2.resume_claims
for each row execute function submissions_v2.touch_updated_at();
create trigger notification_outbox_touch
before update on submissions_v2.notification_outbox
for each row execute function submissions_v2.touch_updated_at();

create or replace function submissions_v2.guard_api_command_identity()
returns trigger
language plpgsql
set search_path = pg_catalog, submissions_v2
as $$
begin
  if new.id is distinct from old.id or new.actor_email is distinct from old.actor_email
     or new.action is distinct from old.action or new.idempotency_key is distinct from old.idempotency_key
     or new.request_digest is distinct from old.request_digest
     or new.expected_version is distinct from old.expected_version
     or (old.pair_id is not null and new.pair_id is distinct from old.pair_id)
     or new.created_at is distinct from old.created_at then
    raise exception using errcode = '55000', message = 'API command identity and request digest are immutable';
  end if;
  return new;
end;
$$;
create trigger api_commands_identity_immutable
before update on submissions_v2.api_commands
for each row execute function submissions_v2.guard_api_command_identity();

create or replace function submissions_v2.guard_job_identity()
returns trigger
language plpgsql
set search_path = pg_catalog, submissions_v2
as $$
begin
  if new.id is distinct from old.id or new.kind is distinct from old.kind
     or new.subject_type is distinct from old.subject_type or new.subject_id is distinct from old.subject_id
     or new.command_id is distinct from old.command_id or new.idempotency_key is distinct from old.idempotency_key
     or new.required_control is distinct from old.required_control or new.created_at is distinct from old.created_at then
    raise exception using errcode = '55000', message = 'job identity and idempotency are immutable';
  end if;
  return new;
end;
$$;
create trigger jobs_identity_immutable
before update on submissions_v2.jobs
for each row execute function submissions_v2.guard_job_identity();

create or replace function submissions_v2.guard_generation_identity()
returns trigger
language plpgsql
set search_path = pg_catalog, submissions_v2
as $$
begin
  if new.id is distinct from old.id or new.pair_id is distinct from old.pair_id
     or new.generation_version is distinct from old.generation_version
     or new.trigger_kind is distinct from old.trigger_kind or new.command_id is distinct from old.command_id
     or new.idempotency_key is distinct from old.idempotency_key
     or new.expected_pair_version is distinct from old.expected_pair_version
     or new.first_signal_id is distinct from old.first_signal_id
     or new.primary_model_pin is distinct from old.primary_model_pin
     or new.fallback_model_pin is distinct from old.fallback_model_pin
     or new.validator_model_pin is distinct from old.validator_model_pin
     or new.prompt_pin is distinct from old.prompt_pin or new.template_pin is distinct from old.template_pin
     or new.budget_cents is distinct from old.budget_cents
     or new.deadline_at is distinct from old.deadline_at
     or new.prior_artifact_id is distinct from old.prior_artifact_id
     or new.created_at is distinct from old.created_at then
    raise exception using errcode = '55000', message = 'resume generation identity and pins are immutable';
  end if;
  return new;
end;
$$;
create trigger resume_generations_identity_immutable
before update on submissions_v2.resume_generations
for each row execute function submissions_v2.guard_generation_identity();

alter table submissions_v2.curated_snapshots
  add constraint curated_snapshots_source_run_fk
  foreign key (source_run_id) references submissions_v2.source_runs(id)
  deferrable initially deferred;

create or replace function submissions_v2.assert_pair_artifact_set()
returns trigger
language plpgsql
set search_path = pg_catalog, submissions_v2
as $$
declare
  pair_row submissions_v2.candidate_role_pairs%rowtype;
  pdf_row submissions_v2.resume_artifacts%rowtype;
  valid_kinds integer;
begin
  if tg_table_name = 'candidate_role_pairs' then
    pair_row := new;
  else
    select * into pair_row
      from submissions_v2.candidate_role_pairs
     where id = coalesce(new.pair_id, old.pair_id);
  end if;
  if pair_row.id is null or pair_row.workflow_state <> 'interested' then
    return null;
  end if;
  select * into pdf_row
    from submissions_v2.resume_artifacts
   where id = pair_row.current_artifact_id;
  if pdf_row.id is null or pdf_row.pair_id <> pair_row.id or pdf_row.kind <> 'pdf'
     or pdf_row.validation_status <> 'passed' or pdf_row.current_state <> 'current'
     or pdf_row.archived_at is null or pdf_row.archive_readback_at is null then
    raise exception using errcode = '23514', message = 'Interested requires a validated current PDF artifact';
  end if;
  select count(distinct kind) into valid_kinds
    from submissions_v2.resume_artifacts
   where pair_id = pair_row.id
     and generation_id = pdf_row.generation_id
     and kind in ('pdf', 'ats', 'manifest')
     and validation_status = 'passed'
     and current_state = 'current'
     and archived_at is not null
     and archive_readback_at is not null;
  if valid_kinds <> 3 then
    raise exception using errcode = '23514', message = 'Interested requires current PDF, ATS, and manifest readback';
  end if;
  if exists (
    select 1 from submissions_v2.resume_claims
     where generation_id = pdf_row.generation_id
       and retained and final_status <> 'passed'
  ) then
    raise exception using errcode = '23514', message = 'Interested artifact contains an unvalidated retained claim';
  end if;
  return null;
end;
$$;

create constraint trigger candidate_role_pairs_artifact_set
after insert or update on submissions_v2.candidate_role_pairs
deferrable initially deferred
for each row execute function submissions_v2.assert_pair_artifact_set();
create constraint trigger resume_artifacts_pair_set
after insert or update or delete on submissions_v2.resume_artifacts
deferrable initially deferred
for each row execute function submissions_v2.assert_pair_artifact_set();

create or replace function submissions_v2.assert_pair_review_consistency()
returns trigger
language plpgsql
set search_path = pg_catalog, submissions_v2
as $$
declare
  target_pair uuid;
  workflow text;
  open_count integer;
begin
  if tg_table_name = 'candidate_role_pairs' then
    target_pair := coalesce(new.id, old.id);
  else
    target_pair := coalesce(new.pair_id, old.pair_id);
  end if;
  if target_pair is null then return null; end if;
  select workflow_state into workflow from submissions_v2.candidate_role_pairs where id = target_pair;
  if workflow is null then return null; end if;
  select count(*) into open_count
    from submissions_v2.review_items
   where pair_id = target_pair and action_state = 'open';
  if workflow = 'needs_review' and open_count = 0 then
    raise exception using errcode = '23514', message = 'Needs Review pair requires an open blocking reason';
  end if;
  if workflow <> 'needs_review' and open_count > 0 then
    raise exception using errcode = '23514', message = 'Open blocking reasons require Needs Review workflow';
  end if;
  return null;
end;
$$;

create constraint trigger candidate_role_pairs_review_consistency
after insert or update on submissions_v2.candidate_role_pairs
deferrable initially deferred
for each row execute function submissions_v2.assert_pair_review_consistency();
create constraint trigger review_items_pair_consistency
after insert or update or delete on submissions_v2.review_items
deferrable initially deferred
for each row execute function submissions_v2.assert_pair_review_consistency();

create or replace function submissions_v2.assert_pair_proof_consistency()
returns trigger
language plpgsql
set search_path = pg_catalog, submissions_v2
as $$
declare
  target_pair uuid;
  pair_row submissions_v2.candidate_role_pairs%rowtype;
begin
  if tg_table_name = 'candidate_role_pairs' then
    target_pair := coalesce(new.id, old.id);
  else
    target_pair := coalesce(new.pair_id, old.pair_id);
  end if;
  if target_pair is null then return null; end if;
  select * into pair_row from submissions_v2.candidate_role_pairs where id = target_pair;
  if pair_row.submission_status = 'proven' and not exists (
    select 1 from submissions_v2.submission_proofs
     where pair_id = target_pair
       and application_id = pair_row.submission_application_id
       and authoritative_path = pair_row.submission_authoritative_path
       and evidence_digest = pair_row.submission_evidence_digest
  ) then
    raise exception using errcode = '23514', message = 'Proven submission requires matching authoritative proof';
  end if;
  return null;
end;
$$;

create constraint trigger candidate_role_pairs_proof_consistency
after insert or update on submissions_v2.candidate_role_pairs
deferrable initially deferred
for each row execute function submissions_v2.assert_pair_proof_consistency();
create constraint trigger submission_proofs_pair_consistency
after insert or delete on submissions_v2.submission_proofs
deferrable initially deferred
for each row execute function submissions_v2.assert_pair_proof_consistency();

create or replace function submissions_v2.job_control_enabled(
  required text,
  controls submissions_v2.runtime_controls
)
returns boolean
language sql
immutable
set search_path = pg_catalog, submissions_v2
as $$
  select case required
    when 'ui' then controls.ui_enabled
    when 'ingestion' then controls.ingestion_enabled
    when 'generation' then controls.generation_enabled
    when 'master_inbox' then controls.ingestion_enabled and controls.master_inbox_enabled
    when 'curated' then controls.ingestion_enabled and controls.curated_enabled
    when 'always' then true
    else false
  end
$$;

create or replace function submissions_v2.source_control_enabled(
  source_key text,
  controls submissions_v2.runtime_controls
)
returns boolean
language sql
immutable
set search_path = pg_catalog, submissions_v2
as $$
  select controls.ingestion_enabled and case source_key
    when 'master_inbox' then controls.master_inbox_enabled
    when 'curated' then controls.curated_enabled
    else true
  end
$$;

create or replace function submissions_v2.guard_runtime_controls()
returns trigger
language plpgsql
set search_path = pg_catalog, submissions_v2
as $$
begin
  if tg_op = 'DELETE' then
    raise exception using errcode = '55000', message = 'runtime controls cannot be deleted';
  end if;
  if new.singleton is distinct from old.singleton then
    raise exception using errcode = '55000', message = 'runtime control singleton is immutable';
  end if;
  if new.control_epoch <> old.control_epoch + 1 then
    raise exception using errcode = '40001', message = 'runtime control epoch must increase by exactly one';
  end if;
  if length(btrim(new.actor_email)) = 0 or length(btrim(new.reason)) = 0 then
    raise exception using errcode = '23514', message = 'runtime control actor and reason are required';
  end if;
  new.changed_at := clock_timestamp();
  return new;
end;
$$;

create or replace function submissions_v2.audit_runtime_controls()
returns trigger
language plpgsql
set search_path = pg_catalog, submissions_v2
as $$
begin
  insert into submissions_v2.runtime_control_events (
    control_epoch, ui_enabled, ingestion_enabled, generation_enabled,
    master_inbox_enabled, curated_enabled, actor_email, reason, changed_at
  ) values (
    new.control_epoch, new.ui_enabled, new.ingestion_enabled, new.generation_enabled,
    new.master_inbox_enabled, new.curated_enabled, new.actor_email, new.reason, new.changed_at
  );

  update submissions_v2.jobs job
     set state = 'held', hold_reason = 'control_disabled', control_epoch = new.control_epoch,
         lease_owner = null, lease_expires_at = null
   where job.state = 'queued'
     and not submissions_v2.job_control_enabled(job.required_control, new);

  update submissions_v2.jobs job
     set state = 'queued', hold_reason = null, control_epoch = new.control_epoch,
         scheduled_at = least(job.scheduled_at, clock_timestamp())
   where job.state = 'held'
     and job.hold_reason in ('control_disabled', 'control_epoch_changed')
     and submissions_v2.job_control_enabled(job.required_control, new);

  update submissions_v2.jobs job
     set control_epoch = new.control_epoch
   where job.state = 'queued'
     and submissions_v2.job_control_enabled(job.required_control, new);
  return null;
end;
$$;

create trigger runtime_controls_guard
before update or delete on submissions_v2.runtime_controls
for each row execute function submissions_v2.guard_runtime_controls();
create trigger runtime_controls_audit
after update on submissions_v2.runtime_controls
for each row execute function submissions_v2.audit_runtime_controls();

create or replace function submissions_v2.set_runtime_controls(
  p_actor_email text,
  p_reason text,
  p_ui_enabled boolean,
  p_ingestion_enabled boolean,
  p_generation_enabled boolean,
  p_master_inbox_enabled boolean,
  p_curated_enabled boolean
)
returns submissions_v2.runtime_controls
language plpgsql
security definer
set search_path = pg_catalog, submissions_v2
as $$
declare
  result submissions_v2.runtime_controls%rowtype;
begin
  update submissions_v2.runtime_controls
     set control_epoch = control_epoch + 1,
         ui_enabled = p_ui_enabled,
         ingestion_enabled = p_ingestion_enabled,
         generation_enabled = p_generation_enabled,
         master_inbox_enabled = p_master_inbox_enabled,
         curated_enabled = p_curated_enabled,
         actor_email = p_actor_email,
         reason = p_reason
   where singleton = true
   returning * into result;
  if result.singleton is null then
    raise exception using errcode = '55000', message = 'runtime controls unavailable';
  end if;
  return result;
end;
$$;

create or replace function submissions_v2.claim_source_cursor(
  p_source_key text,
  p_worker_id text,
  p_lease_seconds integer,
  p_control_epoch bigint
)
returns setof submissions_v2.source_cursors
language plpgsql
security definer
set search_path = pg_catalog, submissions_v2
as $$
begin
  if length(btrim(coalesce(p_worker_id, ''))) = 0
     or p_lease_seconds < 15 or p_lease_seconds > 900 then
    raise exception using errcode = '22023', message = 'invalid source lease request';
  end if;
  return query
  update submissions_v2.source_cursors cursor
     set lease_owner = p_worker_id,
         lease_expires_at = clock_timestamp() + make_interval(secs => p_lease_seconds),
         fencing_token = cursor.fencing_token + 1,
         control_epoch = p_control_epoch
    from submissions_v2.runtime_controls controls
   where cursor.source_key = p_source_key
     and (cursor.lease_owner is null or cursor.lease_expires_at < clock_timestamp())
     and controls.singleton = true
     and controls.control_epoch = p_control_epoch
     and submissions_v2.source_control_enabled(cursor.source_key, controls)
  returning cursor.*;
end;
$$;

create or replace function submissions_v2.heartbeat_source_cursor(
  p_source_key text,
  p_worker_id text,
  p_fencing_token bigint,
  p_control_epoch bigint,
  p_lease_seconds integer
)
returns setof submissions_v2.source_cursors
language plpgsql
security definer
set search_path = pg_catalog, submissions_v2
as $$
begin
  if p_lease_seconds < 15 or p_lease_seconds > 900 then
    raise exception using errcode = '22023', message = 'invalid source lease bounds';
  end if;
  return query
  update submissions_v2.source_cursors cursor
     set lease_expires_at = clock_timestamp() + make_interval(secs => p_lease_seconds)
    from submissions_v2.runtime_controls controls
   where cursor.source_key = p_source_key
     and cursor.lease_owner = p_worker_id and cursor.fencing_token = p_fencing_token
     and cursor.control_epoch = p_control_epoch and cursor.lease_expires_at >= clock_timestamp()
     and controls.singleton = true and controls.control_epoch = p_control_epoch
     and submissions_v2.source_control_enabled(cursor.source_key, controls)
  returning cursor.*;
end;
$$;

create or replace function submissions_v2.commit_source_cursor(
  p_source_key text,
  p_worker_id text,
  p_fencing_token bigint,
  p_control_epoch bigint,
  p_checkpoint jsonb,
  p_full_success boolean
)
returns setof submissions_v2.source_cursors
language plpgsql
security definer
set search_path = pg_catalog, submissions_v2
as $$
begin
  return query
  update submissions_v2.source_cursors cursor
     set checkpoint = coalesce(p_checkpoint, '{}'::jsonb),
         last_full_success_at = case when p_full_success then clock_timestamp() else cursor.last_full_success_at end,
         lease_owner = null, lease_expires_at = null
    from submissions_v2.runtime_controls controls
   where cursor.source_key = p_source_key
     and cursor.lease_owner = p_worker_id and cursor.fencing_token = p_fencing_token
     and cursor.control_epoch = p_control_epoch and cursor.lease_expires_at >= clock_timestamp()
     and controls.singleton = true and controls.control_epoch = p_control_epoch
     and submissions_v2.source_control_enabled(cursor.source_key, controls)
  returning cursor.*;
end;
$$;

create or replace function submissions_v2.release_source_cursor(
  p_source_key text,
  p_worker_id text,
  p_fencing_token bigint,
  p_control_epoch bigint
)
returns setof submissions_v2.source_cursors
language sql
security definer
set search_path = pg_catalog, submissions_v2
as $$
  update submissions_v2.source_cursors cursor
     set lease_owner = null, lease_expires_at = null
   where cursor.source_key = p_source_key
     and cursor.lease_owner = p_worker_id and cursor.fencing_token = p_fencing_token
     and cursor.control_epoch = p_control_epoch and cursor.lease_expires_at >= clock_timestamp()
  returning cursor.*
$$;

create or replace function submissions_v2.claim_jobs(
  p_worker_id text,
  p_kinds text[],
  p_limit integer,
  p_lease_seconds integer,
  p_control_epoch bigint
)
returns setof submissions_v2.jobs
language plpgsql
security definer
set search_path = pg_catalog, submissions_v2
as $$
begin
  if length(btrim(coalesce(p_worker_id, ''))) = 0 then
    raise exception using errcode = '22023', message = 'worker id is required';
  end if;
  if p_limit < 1 or p_limit > 50 or p_lease_seconds < 15 or p_lease_seconds > 900 then
    raise exception using errcode = '22023', message = 'invalid claim bounds';
  end if;

  return query
  with eligible as materialized (
    select job.id
      from submissions_v2.jobs job
      join submissions_v2.runtime_controls controls on controls.singleton = true
     where controls.control_epoch = p_control_epoch
       and job.scheduled_at <= clock_timestamp()
       and job.attempt_count < job.max_attempts
       and (cardinality(p_kinds) = 0 or job.kind = any(p_kinds))
       and submissions_v2.job_control_enabled(job.required_control, controls)
       and (
         job.state = 'queued'
         or (job.state = 'running' and job.lease_expires_at < clock_timestamp())
       )
     order by job.priority, job.scheduled_at, job.created_at, job.id
     for update of job skip locked
     limit p_limit
  ), expired_attempts as (
    update submissions_v2.job_attempts attempt
       set finished_at = coalesce(attempt.finished_at, clock_timestamp()),
           outcome = coalesce(attempt.outcome, 'lease_expired')
     where attempt.job_id in (select id from eligible)
       and attempt.finished_at is null
    returning attempt.id
  ), claimed as (
    update submissions_v2.jobs job
       set state = 'running',
           lease_owner = p_worker_id,
           lease_expires_at = clock_timestamp() + make_interval(secs => p_lease_seconds),
           fencing_token = job.fencing_token + 1,
           attempt_count = job.attempt_count + 1,
           control_epoch = p_control_epoch,
           hold_reason = null,
           safe_error_code = null,
           safe_error_detail = null,
           started_at = coalesce(job.started_at, clock_timestamp())
     where job.id in (select id from eligible)
     returning job.*
  ), attempts as (
    insert into submissions_v2.job_attempts (
      job_id, attempt_no, fencing_token, worker_id, control_epoch, started_at
    )
    select claimed.id, claimed.attempt_count, claimed.fencing_token,
           p_worker_id, p_control_epoch, clock_timestamp()
      from claimed
    returning id
  )
  select claimed.* from claimed;
end;
$$;

create or replace function submissions_v2.heartbeat_job(
  p_job_id uuid,
  p_worker_id text,
  p_fencing_token bigint,
  p_control_epoch bigint,
  p_lease_seconds integer
)
returns setof submissions_v2.jobs
language plpgsql
security definer
set search_path = pg_catalog, submissions_v2
as $$
begin
  if p_lease_seconds < 15 or p_lease_seconds > 900 then
    raise exception using errcode = '22023', message = 'invalid lease bounds';
  end if;
  return query
  update submissions_v2.jobs job
     set lease_expires_at = clock_timestamp() + make_interval(secs => p_lease_seconds)
    from submissions_v2.runtime_controls controls
   where job.id = p_job_id
     and job.state = 'running'
     and job.lease_owner = p_worker_id
     and job.fencing_token = p_fencing_token
     and job.control_epoch = p_control_epoch
     and job.lease_expires_at >= clock_timestamp()
     and controls.singleton = true
     and controls.control_epoch = p_control_epoch
     and submissions_v2.job_control_enabled(job.required_control, controls)
  returning job.*;
end;
$$;

create or replace function submissions_v2.checkpoint_job(
  p_job_id uuid,
  p_worker_id text,
  p_fencing_token bigint,
  p_control_epoch bigint,
  p_checkpoint jsonb
)
returns setof submissions_v2.jobs
language plpgsql
security definer
set search_path = pg_catalog, submissions_v2
as $$
declare
  current_job submissions_v2.jobs%rowtype;
  controls submissions_v2.runtime_controls%rowtype;
begin
  select * into current_job from submissions_v2.jobs
   where id = p_job_id and state = 'running' and lease_owner = p_worker_id
     and fencing_token = p_fencing_token and control_epoch = p_control_epoch
     and lease_expires_at >= clock_timestamp()
   for update;
  if current_job.id is null then return; end if;
  select * into controls from submissions_v2.runtime_controls where singleton = true;
  if controls.singleton is null then
    update submissions_v2.jobs
       set checkpoint = coalesce(p_checkpoint, '{}'::jsonb), state = 'held',
           hold_reason = 'control_epoch_changed', lease_owner = null, lease_expires_at = null
     where id = p_job_id;
    update submissions_v2.job_attempts
       set finished_at = clock_timestamp(), outcome = 'held',
           checkpoint = coalesce(p_checkpoint, '{}'::jsonb)
     where job_id = p_job_id and fencing_token = p_fencing_token and finished_at is null;
  elsif controls.control_epoch <> p_control_epoch
     or not submissions_v2.job_control_enabled(current_job.required_control, controls) then
    if submissions_v2.job_control_enabled(current_job.required_control, controls) then
      update submissions_v2.jobs
         set checkpoint = coalesce(p_checkpoint, '{}'::jsonb), state = 'queued',
             hold_reason = null, control_epoch = controls.control_epoch,
             scheduled_at = clock_timestamp(), lease_owner = null, lease_expires_at = null
       where id = p_job_id;
      update submissions_v2.job_attempts
         set finished_at = clock_timestamp(), outcome = 'retry',
             checkpoint = coalesce(p_checkpoint, '{}'::jsonb)
       where job_id = p_job_id and fencing_token = p_fencing_token and finished_at is null;
    else
      update submissions_v2.jobs
         set checkpoint = coalesce(p_checkpoint, '{}'::jsonb), state = 'held',
             hold_reason = 'control_disabled', control_epoch = controls.control_epoch,
             lease_owner = null, lease_expires_at = null
       where id = p_job_id;
      update submissions_v2.job_attempts
         set finished_at = clock_timestamp(), outcome = 'held',
             checkpoint = coalesce(p_checkpoint, '{}'::jsonb)
       where job_id = p_job_id and fencing_token = p_fencing_token and finished_at is null;
    end if;
  else
    update submissions_v2.jobs
       set checkpoint = coalesce(p_checkpoint, '{}'::jsonb)
     where id = p_job_id;
    update submissions_v2.job_attempts
       set checkpoint = coalesce(p_checkpoint, '{}'::jsonb)
     where job_id = p_job_id and fencing_token = p_fencing_token;
  end if;
  return query select * from submissions_v2.jobs where id = p_job_id;
end;
$$;

create or replace function submissions_v2.complete_job(
  p_job_id uuid,
  p_worker_id text,
  p_fencing_token bigint,
  p_control_epoch bigint,
  p_checkpoint jsonb
)
returns setof submissions_v2.jobs
language plpgsql
security definer
set search_path = pg_catalog, submissions_v2
as $$
begin
  return query
  with completed as (
    update submissions_v2.jobs job
       set state = 'succeeded', checkpoint = coalesce(p_checkpoint, '{}'::jsonb),
           lease_owner = null, lease_expires_at = null, completed_at = clock_timestamp()
      from submissions_v2.runtime_controls controls
     where job.id = p_job_id and job.state = 'running'
       and job.lease_owner = p_worker_id and job.fencing_token = p_fencing_token
       and job.control_epoch = p_control_epoch and job.lease_expires_at >= clock_timestamp()
       and controls.singleton = true and controls.control_epoch = p_control_epoch
       and submissions_v2.job_control_enabled(job.required_control, controls)
    returning job.*
  ), finished_attempt as (
    update submissions_v2.job_attempts attempt
       set finished_at = clock_timestamp(), outcome = 'succeeded',
           checkpoint = coalesce(p_checkpoint, '{}'::jsonb)
     where attempt.job_id in (select id from completed)
       and attempt.fencing_token = p_fencing_token and attempt.finished_at is null
    returning attempt.id
  )
  select completed.* from completed;
end;
$$;

create or replace function submissions_v2.fail_job(
  p_job_id uuid,
  p_worker_id text,
  p_fencing_token bigint,
  p_control_epoch bigint,
  p_error_code text,
  p_safe_error text,
  p_retry boolean,
  p_retry_delay_seconds integer,
  p_checkpoint jsonb
)
returns setof submissions_v2.jobs
language plpgsql
security definer
set search_path = pg_catalog, submissions_v2
as $$
declare
  current_job submissions_v2.jobs%rowtype;
  controls submissions_v2.runtime_controls%rowtype;
  next_state text;
  attempt_outcome text;
  next_hold_reason text;
begin
  select * into current_job from submissions_v2.jobs
   where id = p_job_id and state = 'running' and lease_owner = p_worker_id
     and fencing_token = p_fencing_token and control_epoch = p_control_epoch
     and lease_expires_at >= clock_timestamp()
   for update;
  if current_job.id is null then return; end if;
  select * into controls from submissions_v2.runtime_controls where singleton = true;
  if controls.singleton is null then
    next_state := 'held';
    attempt_outcome := 'held';
    next_hold_reason := 'control_epoch_changed';
  elsif controls.control_epoch <> p_control_epoch then
    if submissions_v2.job_control_enabled(current_job.required_control, controls) then
      next_state := 'queued';
      attempt_outcome := 'retry';
      next_hold_reason := null;
    else
      next_state := 'held';
      attempt_outcome := 'held';
      next_hold_reason := 'control_disabled';
    end if;
  elsif not submissions_v2.job_control_enabled(current_job.required_control, controls) then
    next_state := 'held';
    attempt_outcome := 'held';
    next_hold_reason := 'control_disabled';
  elsif p_retry and current_job.attempt_count < current_job.max_attempts then
    next_state := 'queued';
    attempt_outcome := 'retry';
    next_hold_reason := null;
  else
    next_state := 'failed';
    attempt_outcome := 'failed';
    next_hold_reason := null;
  end if;

  update submissions_v2.jobs
     set state = next_state,
         checkpoint = coalesce(p_checkpoint, '{}'::jsonb),
         safe_error_code = left(coalesce(p_error_code, 'job_failed'), 120),
         safe_error_detail = left(coalesce(p_safe_error, 'Job failed'), 500),
         scheduled_at = case when next_state = 'queued'
           then clock_timestamp() + make_interval(secs => greatest(0, least(86400, p_retry_delay_seconds)))
           else scheduled_at end,
         hold_reason = next_hold_reason,
         control_epoch = case when controls.singleton is null then current_job.control_epoch else controls.control_epoch end,
         lease_owner = null,
         lease_expires_at = null,
         completed_at = case when next_state = 'failed' then clock_timestamp() else null end
   where id = p_job_id;
  update submissions_v2.job_attempts
     set finished_at = clock_timestamp(), outcome = attempt_outcome,
         checkpoint = coalesce(p_checkpoint, '{}'::jsonb),
         safe_error_code = left(coalesce(p_error_code, 'job_failed'), 120),
         safe_error_detail = left(coalesce(p_safe_error, 'Job failed'), 500)
   where job_id = p_job_id and fencing_token = p_fencing_token and finished_at is null;
  return query select * from submissions_v2.jobs where id = p_job_id;
end;
$$;
