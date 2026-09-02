alter table submissions_v2.case_deletions
  drop constraint case_deletions_state_check;
alter table submissions_v2.case_deletions
  add constraint case_deletions_state_check
  check (state in ('soft_deleted', 'purging', 'restored', 'purged', 'purge_failed'));
alter table submissions_v2.case_deletions
  add column purge_lease_owner text,
  add column purge_lease_expires_at timestamptz,
  add column purge_fencing_token bigint not null default 0 check (purge_fencing_token >= 0),
  add column tombstone_candidate_hmac text check (tombstone_candidate_hmac is null or tombstone_candidate_hmac ~ '^[0-9a-f]{64}$'),
  add constraint case_deletions_purge_lease_check check (
    (state = 'purging' and purge_lease_owner is not null and purge_lease_expires_at is not null)
    or (state <> 'purging' and purge_lease_owner is null and purge_lease_expires_at is null)
  );

create table submissions_v2.candidate_index_suppressions (
  candidate_hmac text primary key check (candidate_hmac ~ '^[0-9a-f]{64}$'),
  deletion_id uuid references submissions_v2.case_deletions(id) on delete set null,
  created_at timestamptz not null default clock_timestamp()
);

revoke insert, update, delete, truncate on submissions_v2.candidate_index_suppressions from public;

create or replace function submissions_v2.reject_append_only_mutation()
returns trigger
language plpgsql
set search_path = pg_catalog, submissions_v2
as $$
begin
  if session_user = 'submissions_v2_purge'
     and current_setting('submissions_v2.approved_purge', true) = 'on' then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;
  raise exception using
    errcode = '55000',
    message = format('%I.%I is append-only', tg_table_schema, tg_table_name);
end;
$$;

create table submissions_v2.pair_signal_links (
  pair_id uuid not null references submissions_v2.candidate_role_pairs(id) on delete restrict,
  signal_id uuid not null references submissions_v2.source_events(id) on delete restrict,
  role_id text not null,
  link_kind text not null check (link_kind in ('classified_reply', 'classification_failure', 'manual', 'curated')),
  linked_at timestamptz not null default clock_timestamp(),
  primary key (pair_id, signal_id, role_id)
);

create index pair_signal_links_signal_idx
  on submissions_v2.pair_signal_links (signal_id, pair_id);

create trigger pair_signal_links_append_only
before update or delete on submissions_v2.pair_signal_links
for each row execute function submissions_v2.reject_append_only_mutation();

revoke update, delete, truncate on submissions_v2.pair_signal_links from public;

create table submissions_v2.archive_lookup_audit (
  id uuid primary key default gen_random_uuid(),
  actor_email text not null,
  filter_digest text not null check (filter_digest ~ '^[0-9a-f]{64}$'),
  result text not null check (result in ('matched', 'not_found')),
  artifact_id uuid references submissions_v2.resume_artifacts(id) on delete restrict,
  pair_id uuid references submissions_v2.candidate_role_pairs(id) on delete restrict,
  requested_at timestamptz not null default clock_timestamp(),
  check ((result='matched' and artifact_id is not null and pair_id is not null)
      or (result='not_found' and artifact_id is null and pair_id is null))
);

create index archive_lookup_audit_actor_time_idx
  on submissions_v2.archive_lookup_audit (actor_email, requested_at desc);

create trigger archive_lookup_audit_append_only
before update or delete on submissions_v2.archive_lookup_audit
for each row execute function submissions_v2.reject_append_only_mutation();

revoke update, delete, truncate on submissions_v2.archive_lookup_audit from public;

create or replace function submissions_v2.assert_isolated_purge_session()
returns void
language plpgsql
security definer
set search_path = pg_catalog, submissions_v2
as $$
begin
  if session_user <> 'submissions_v2_purge' then
    raise exception using errcode = '42501', message = 'isolated purge identity required';
  end if;
end;
$$;

create or replace function submissions_v2.claim_case_purges(
  p_worker_id text,
  p_limit integer,
  p_lease_seconds integer
)
returns setof submissions_v2.case_deletions
language plpgsql
security definer
set search_path = pg_catalog, submissions_v2
as $$
begin
  perform submissions_v2.assert_isolated_purge_session();
  if length(btrim(coalesce(p_worker_id, ''))) = 0
     or p_limit < 1 or p_limit > 20
     or p_lease_seconds < 60 or p_lease_seconds > 3600 then
    raise exception using errcode = '22023', message = 'invalid purge claim bounds';
  end if;
  return query
  with due as materialized (
    select deletion.id
      from submissions_v2.case_deletions deletion
     where deletion.recovery_deadline <= clock_timestamp()
       and (
         deletion.state = 'soft_deleted'
         or (deletion.state = 'purging' and deletion.purge_lease_expires_at < clock_timestamp())
       )
     order by deletion.recovery_deadline, deletion.id
     for update skip locked
     limit p_limit
  )
  update submissions_v2.case_deletions deletion
     set state = 'purging', purge_lease_owner = p_worker_id,
         purge_lease_expires_at = clock_timestamp() + make_interval(secs => p_lease_seconds),
         purge_fencing_token = deletion.purge_fencing_token + 1
   where deletion.id in (select id from due)
  returning deletion.*;
end;
$$;

create or replace function submissions_v2.case_purge_plan(
  p_deletion_id uuid,
  p_worker_id text,
  p_fencing_token bigint
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, submissions_v2
as $$
declare
  deletion submissions_v2.case_deletions%rowtype;
  result jsonb;
begin
  perform submissions_v2.assert_isolated_purge_session();
  select * into deletion
    from submissions_v2.case_deletions
   where id = p_deletion_id and state = 'purging'
     and purge_lease_owner = p_worker_id and purge_fencing_token = p_fencing_token
     and purge_lease_expires_at >= clock_timestamp()
     and recovery_deadline <= clock_timestamp()
   for update;
  if deletion.id is null or deletion.pair_id is null then
    raise exception using errcode = '40001', message = 'purge claim fence lost';
  end if;

  with source_ids as (
    select first_signal_id as id from submissions_v2.candidate_role_pairs where id = deletion.pair_id
    union select source_event_id from submissions_v2.not_interested_entries where pair_id = deletion.pair_id
    union select first_signal_id from submissions_v2.resume_generations where pair_id = deletion.pair_id
    union select signal_id from submissions_v2.pair_signal_links where pair_id = deletion.pair_id
  ), deletable_sources as (
    select source.id
      from source_ids source
     where not exists (
       select 1 from submissions_v2.candidate_role_pairs pair
        where pair.first_signal_id = source.id and pair.id <> deletion.pair_id
     )
       and not exists (
         select 1 from submissions_v2.not_interested_entries history
          where history.source_event_id = source.id and history.pair_id <> deletion.pair_id
       )
       and not exists (
         select 1 from submissions_v2.resume_generations generation
          where generation.first_signal_id = source.id and generation.pair_id <> deletion.pair_id
       )
       and not exists (
         select 1 from submissions_v2.pair_signal_links link
          where link.signal_id = source.id and link.pair_id <> deletion.pair_id
       )
       and not exists (
         select 1 from submissions_v2.signal_role_decisions decision
          join submissions_v2.candidate_role_pairs pair on pair.id = deletion.pair_id
          where decision.signal_id = source.id
            and (decision.candidate_user_id is distinct from pair.candidate_user_id
                 or decision.role_id is distinct from pair.role_id)
       )
  ), object_keys as (
    select private_object_key as object_key
      from submissions_v2.resume_artifacts where pair_id = deletion.pair_id
    union select object_key from submissions_v2.resume_supplements
      where pair_id = deletion.pair_id and object_key is not null
    union select extracted_text_object_key from submissions_v2.resume_supplements
      where pair_id = deletion.pair_id and extracted_text_object_key is not null
    union select stage.output_object_key
      from submissions_v2.resume_stage_runs stage
      join submissions_v2.resume_generations generation on generation.id = stage.generation_id
     where generation.pair_id = deletion.pair_id and stage.output_object_key is not null
    union select event.encrypted_body_object_key
      from submissions_v2.source_events event join deletable_sources source on source.id = event.id
     where event.encrypted_body_object_key is not null
    union select event.encrypted_sender_object_key
      from submissions_v2.source_events event join deletable_sources source on source.id = event.id
     where event.encrypted_sender_object_key is not null
    union select history.encrypted_manifest_object_key
      from submissions_v2.case_deletions history
     where history.pair_id=deletion.pair_id
       and history.encrypted_manifest_object_key <> '[purged]'
  )
  select jsonb_build_object(
    'deletion_id', deletion.id,
    'fencing_token', deletion.purge_fencing_token,
    'object_keys', coalesce(jsonb_agg(object_key order by object_key) filter (where object_key is not null), '[]'::jsonb)
  ) into result from object_keys;
  return result;
end;
$$;

create or replace function submissions_v2.finalize_case_purge(
  p_deletion_id uuid,
  p_worker_id text,
  p_fencing_token bigint,
  p_result text
)
returns submissions_v2.case_deletions
language plpgsql
security definer
set search_path = pg_catalog, submissions_v2
as $$
declare
  deletion submissions_v2.case_deletions%rowtype;
  pair_row submissions_v2.candidate_role_pairs%rowtype;
  source_ids uuid[];
  deletable_source_ids uuid[];
  generation_ids uuid[];
  claim_ids uuid[];
  artifact_ids uuid[];
  job_ids uuid[];
  command_ids uuid[];
begin
  perform submissions_v2.assert_isolated_purge_session();
  select * into deletion
    from submissions_v2.case_deletions
   where id = p_deletion_id and state = 'purging'
     and purge_lease_owner = p_worker_id and purge_fencing_token = p_fencing_token
     and purge_lease_expires_at >= clock_timestamp()
     and recovery_deadline <= clock_timestamp()
   for update;
  if deletion.id is null or deletion.pair_id is null then
    raise exception using errcode = '40001', message = 'purge claim fence lost';
  end if;
  select * into pair_row from submissions_v2.candidate_role_pairs where id = deletion.pair_id for update;
  if pair_row.id is null or pair_row.case_hidden_at is null then
    raise exception using errcode = '23514', message = 'purge requires a hidden case';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(pair_row.candidate_user_id, 0));
  perform set_config('submissions_v2.approved_purge', 'on', true);

  select coalesce(array_agg(distinct id), '{}'::uuid[]) into source_ids from (
    select pair_row.first_signal_id as id
    union select source_event_id from submissions_v2.not_interested_entries where pair_id = pair_row.id
    union select first_signal_id from submissions_v2.resume_generations where pair_id = pair_row.id
    union select signal_id from submissions_v2.pair_signal_links where pair_id = pair_row.id
  ) sources;
  select coalesce(array_agg(source.id), '{}'::uuid[]) into deletable_source_ids
    from unnest(source_ids) source(id)
   where not exists (
     select 1 from submissions_v2.candidate_role_pairs pair
      where pair.first_signal_id = source.id and pair.id <> pair_row.id
   )
     and not exists (
       select 1 from submissions_v2.not_interested_entries history
        where history.source_event_id = source.id and history.pair_id <> pair_row.id
     )
     and not exists (
       select 1 from submissions_v2.resume_generations generation
        where generation.first_signal_id = source.id and generation.pair_id <> pair_row.id
     )
     and not exists (
       select 1 from submissions_v2.pair_signal_links link
        where link.signal_id = source.id and link.pair_id <> pair_row.id
     )
     and not exists (
       select 1 from submissions_v2.signal_role_decisions decision
        where decision.signal_id = source.id
          and (decision.candidate_user_id is distinct from pair_row.candidate_user_id
               or decision.role_id is distinct from pair_row.role_id)
     );
  select coalesce(array_agg(id), '{}'::uuid[]) into generation_ids
    from submissions_v2.resume_generations where pair_id = pair_row.id;
  select coalesce(array_agg(id), '{}'::uuid[]) into claim_ids
    from submissions_v2.resume_claims where generation_id = any(generation_ids);
  select coalesce(array_agg(id), '{}'::uuid[]) into artifact_ids
    from submissions_v2.resume_artifacts where pair_id = pair_row.id;
  select coalesce(array_agg(id), '{}'::uuid[]) into job_ids
    from submissions_v2.jobs
   where (subject_type = 'pair' and subject_id = pair_row.id::text)
      or (subject_type = 'signal' and exists (
        select 1 from unnest(deletable_source_ids) source_id where subject_id = source_id::text
      ));
  select coalesce(array_agg(id), '{}'::uuid[]) into command_ids
    from submissions_v2.api_commands
   where pair_id = pair_row.id
      or id in (select command_id from submissions_v2.jobs where id = any(job_ids) and command_id is not null);
  select coalesce(array_agg(id), '{}'::uuid[]) into job_ids
    from submissions_v2.jobs
   where id = any(job_ids) or command_id = any(command_ids);

  delete from submissions_v2.notification_outbox notification
   where notification.pair_id = pair_row.id;
  delete from submissions_v2.job_attempts where job_id = any(job_ids);
  delete from submissions_v2.jobs where id = any(job_ids);
  delete from submissions_v2.download_audit where pair_id = pair_row.id;
  delete from submissions_v2.archive_lookup_audit where pair_id = pair_row.id;
  delete from submissions_v2.download_tickets where pair_id = pair_row.id;
  delete from submissions_v2.artifact_deletions where artifact_id = any(artifact_ids);
  delete from submissions_v2.submission_proofs where pair_id = pair_row.id;
  delete from submissions_v2.claim_validations where claim_id = any(claim_ids);
  delete from submissions_v2.claim_evidence_links where claim_id = any(claim_ids);
  delete from submissions_v2.resume_claims where id = any(claim_ids);
  delete from submissions_v2.resume_sources where generation_id = any(generation_ids);
  delete from submissions_v2.resume_stage_runs where generation_id = any(generation_ids);
  delete from submissions_v2.upload_reservations where pair_id = pair_row.id;
  -- Reservations are text-polymorphic, so never select them by owner_ref: a
  -- pair UUID can equal another pair's generation UUID.  Delete only the
  -- exact paths owned by records in this case; ownerless writes are delegated
  -- to the isolated routine-expiry lane.
  delete from submissions_v2.private_object_reservations reservation
   where reservation.object_key in (
        select artifact.private_object_key from submissions_v2.resume_artifacts artifact where artifact.pair_id = pair_row.id
        union select supplement.object_key from submissions_v2.resume_supplements supplement
          where supplement.pair_id = pair_row.id and supplement.object_key is not null
        union select supplement.extracted_text_object_key from submissions_v2.resume_supplements supplement
          where supplement.pair_id = pair_row.id and supplement.extracted_text_object_key is not null
        union select stage.output_object_key
          from submissions_v2.resume_stage_runs stage
          join submissions_v2.resume_generations generation on generation.id = stage.generation_id
         where generation.pair_id = pair_row.id and stage.output_object_key is not null
        union select event.encrypted_body_object_key from submissions_v2.source_events event
          where event.id = any(deletable_source_ids) and event.encrypted_body_object_key is not null
        union select event.encrypted_sender_object_key from submissions_v2.source_events event
          where event.id = any(deletable_source_ids) and event.encrypted_sender_object_key is not null
        union select deletion.encrypted_manifest_object_key
      );
  delete from submissions_v2.resume_supplements where pair_id = pair_row.id;
  delete from submissions_v2.resume_artifacts where pair_id = pair_row.id;
  delete from submissions_v2.resume_generations where id = any(generation_ids);
  delete from submissions_v2.review_items where pair_id = pair_row.id;
  delete from submissions_v2.not_interested_entries where pair_id = pair_row.id;
  delete from submissions_v2.pair_events where pair_id = pair_row.id;
  delete from submissions_v2.pair_signal_links where pair_id = pair_row.id;
  delete from submissions_v2.api_commands where id = any(command_ids);
  delete from submissions_v2.curated_snapshots
   where candidate_user_id = pair_row.candidate_user_id and role_id = pair_row.role_id;
  update submissions_v2.case_deletions historical
     set state='purged', reason='[purged]', encrypted_manifest_object_key='[purged]',
         manifest_digest=encode(public.digest('purged'::text, 'sha256'::text), 'hex'),
         restored_by=null, purged_at=coalesce(historical.purged_at, clock_timestamp()),
         purge_result=coalesce(historical.purge_result, 'superseded deletion history redacted'),
         purge_lease_owner=null, purge_lease_expires_at=null
   where historical.pair_id=pair_row.id and historical.id <> deletion.id;
  delete from submissions_v2.candidate_role_pairs where id = pair_row.id;

  delete from submissions_v2.review_items review
   where review.unresolved_signal_id = any(deletable_source_ids);
  delete from submissions_v2.signal_role_decisions decision
   where decision.signal_id = any(source_ids)
     and decision.candidate_user_id is not distinct from pair_row.candidate_user_id
     and decision.role_id = pair_row.role_id;
  delete from submissions_v2.classification_attempts attempt
   where attempt.signal_id = any(deletable_source_ids);
  delete from submissions_v2.signal_role_decisions decision
   where decision.signal_id = any(deletable_source_ids);
  delete from submissions_v2.source_offered_roles offered
   where offered.signal_id = any(deletable_source_ids);
  delete from submissions_v2.source_events event
   where event.id = any(deletable_source_ids);

  with deleted_candidate as (
    delete from submissions_v2.candidate_index candidate
     where candidate.candidate_user_id = pair_row.candidate_user_id
       and not exists (
         select 1 from submissions_v2.candidate_role_pairs remaining
          where remaining.candidate_user_id = pair_row.candidate_user_id
       )
       and not exists (
         select 1 from submissions_v2.curated_snapshots snapshot
          where snapshot.candidate_user_id = pair_row.candidate_user_id
       )
       and not exists (
         select 1 from submissions_v2.signal_role_decisions decision
          where decision.candidate_user_id = pair_row.candidate_user_id
       )
       and not exists (
         select 1 from submissions_v2.source_events source
          where source.envelope #>> '{candidate_resolution,candidate_user_id}' = pair_row.candidate_user_id
             or source.envelope #>> '{candidate_resolution,candidate,candidate_user_id}' = pair_row.candidate_user_id
       )
    returning candidate.candidate_user_id
  )
  insert into submissions_v2.candidate_index_suppressions(candidate_hmac, deletion_id)
  select deletion.tombstone_candidate_hmac, deletion.id from deleted_candidate
   where deletion.tombstone_candidate_hmac is not null
  on conflict (candidate_hmac) do nothing;

  update submissions_v2.case_deletions
     set state = 'purged', reason = '[purged]', encrypted_manifest_object_key = '[purged]',
         manifest_digest = encode(public.digest('purged'::text, 'sha256'::text), 'hex'),
         purged_at = clock_timestamp(), purge_result = left(coalesce(p_result, 'purged'), 500),
         purge_lease_owner = null, purge_lease_expires_at = null
   where id = p_deletion_id
  returning * into deletion;
  insert into submissions_v2.case_deletion_audit(
    deletion_id, tombstone_case_hmac, event_type, actor_email,
    pair_state_version, reason_digest, idempotency_key, metadata
  ) values (
    deletion.id, deletion.tombstone_case_hmac, 'purged', deletion.admin_actor,
    null, encode(public.digest(coalesce(p_result, 'purged')::text, 'sha256'::text), 'hex'),
    'case-purge:' || deletion.id::text,
    jsonb_build_object('result', left(coalesce(p_result, 'purged'), 120))
  ) on conflict (idempotency_key) do nothing;
  return deletion;
end;
$$;

create or replace function submissions_v2.release_case_purge(
  p_deletion_id uuid,
  p_worker_id text,
  p_fencing_token bigint,
  p_error_code text
)
returns submissions_v2.case_deletions
language plpgsql
security definer
set search_path = pg_catalog, submissions_v2
as $$
declare
  deletion submissions_v2.case_deletions%rowtype;
begin
  perform submissions_v2.assert_isolated_purge_session();
  update submissions_v2.case_deletions
     set state = 'soft_deleted', purge_lease_owner = null, purge_lease_expires_at = null,
         purge_result = left(coalesce(p_error_code, 'purge_failed'), 500)
   where id = p_deletion_id and state = 'purging'
     and purge_lease_owner = p_worker_id and purge_fencing_token = p_fencing_token
  returning * into deletion;
  if deletion.id is null then
    raise exception using errcode = '40001', message = 'purge claim fence lost';
  end if;
  insert into submissions_v2.case_deletion_audit(
    deletion_id, tombstone_case_hmac, event_type, actor_email,
    pair_state_version, reason_digest, idempotency_key, metadata
  ) values (
    deletion.id, deletion.tombstone_case_hmac, 'purge_failed', deletion.admin_actor,
    null, encode(public.digest(coalesce(p_error_code, 'purge_failed')::text, 'sha256'::text), 'hex'),
    'case-purge-failed:' || deletion.id::text || ':' || p_fencing_token::text,
    jsonb_build_object('error_code', left(coalesce(p_error_code, 'purge_failed'), 120))
  ) on conflict (idempotency_key) do nothing;
  return deletion;
end;
$$;

revoke all on function submissions_v2.assert_isolated_purge_session() from public;
revoke all on function submissions_v2.claim_case_purges(text, integer, integer) from public;
revoke all on function submissions_v2.case_purge_plan(uuid, text, bigint) from public;
revoke all on function submissions_v2.finalize_case_purge(uuid, text, bigint, text) from public;
revoke all on function submissions_v2.release_case_purge(uuid, text, bigint, text) from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'submissions_v2_purge') then
    grant usage on schema submissions_v2 to submissions_v2_purge;
    grant execute on function submissions_v2.claim_case_purges(text, integer, integer) to submissions_v2_purge;
    grant execute on function submissions_v2.case_purge_plan(uuid, text, bigint) to submissions_v2_purge;
    grant execute on function submissions_v2.finalize_case_purge(uuid, text, bigint, text) to submissions_v2_purge;
    grant execute on function submissions_v2.release_case_purge(uuid, text, bigint, text) to submissions_v2_purge;
  end if;
end;
$$;
