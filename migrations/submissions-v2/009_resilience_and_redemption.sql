alter table submissions_v2.candidate_index
  add column reconciliation_cycle text;

create index candidate_index_reconciliation_cycle_idx
  on submissions_v2.candidate_index (reconciliation_cycle, candidate_user_id);

alter table submissions_v2.resume_supplements
  add column private_object_purged_at timestamptz,
  add column private_object_purge_actor text,
  add column quarantine_cleanup_state text not null default 'pending'
    check (quarantine_cleanup_state in ('pending', 'cleanup', 'purged')),
  add column quarantine_cleanup_owner text,
  add column quarantine_cleanup_started_at timestamptz,
  add column quarantine_cleanup_fencing_token bigint not null default 0
    check (quarantine_cleanup_fencing_token >= 0);

alter table submissions_v2.resume_supplements
  drop constraint if exists resume_supplements_quarantine_shape;

alter table submissions_v2.resume_supplements
  add constraint resume_supplements_quarantine_shape check (
    (
      not quarantined
      and quarantine_cleanup_state='pending'
      and quarantine_cleanup_owner is null
      and quarantine_cleanup_started_at is null
    ) or (
      supplement_kind = 'evidence'
      and object_key is not null
      and scan_state = 'pending'
      and parse_state = 'pending'
      and (
        (
          active
          and deleted_at is null
          and deletion_actor is null
          and private_object_purged_at is null
          and private_object_purge_actor is null
          and quarantine_cleanup_state in ('pending', 'cleanup')
          and ((quarantine_cleanup_state='pending' and quarantine_cleanup_owner is null and quarantine_cleanup_started_at is null)
            or (quarantine_cleanup_state='cleanup' and quarantine_cleanup_owner is not null and quarantine_cleanup_started_at is not null))
        )
        or (
          not active
          and deleted_at is not null
          and deletion_actor is not null
          and private_object_purged_at is not null
          and private_object_purge_actor is not null
          and quarantine_cleanup_state='purged'
          and quarantine_cleanup_owner is null
          and quarantine_cleanup_started_at is not null
        )
      )
    )
  );

alter table submissions_v2.upload_reservations
  drop constraint upload_reservations_state_check,
  drop constraint upload_reservations_check1,
  add column cleanup_owner text,
  add column cleanup_started_at timestamptz,
  add column cleanup_fencing_token bigint not null default 0 check (cleanup_fencing_token >= 0),
  add constraint upload_reservations_state_check check (state in ('pending', 'cleanup', 'completed', 'purged')),
  add constraint upload_reservations_state_shape check (
    (state='pending' and supplement_id is null and completed_at is null and purged_at is null and purge_actor is null
      and cleanup_owner is null and cleanup_started_at is null)
    or (state='cleanup' and supplement_id is null and completed_at is null and purged_at is null and purge_actor is null
      and cleanup_owner is not null and cleanup_started_at is not null)
    or (state='completed' and supplement_id is not null and completed_at is not null and purged_at is null and purge_actor is null
      and cleanup_owner is null and cleanup_started_at is null)
    or (state='purged' and supplement_id is null and completed_at is null and purged_at is not null and purge_actor is not null
      and cleanup_owner is null and cleanup_started_at is not null)
  );

create table submissions_v2.download_tickets (
  ticket_id uuid primary key,
  actor_email text not null,
  artifact_id uuid not null references submissions_v2.resume_artifacts(id) on delete restrict,
  pair_id uuid not null references submissions_v2.candidate_role_pairs(id) on delete restrict,
  disposition text not null check (disposition in ('attachment', 'archive_retrieval')),
  pathname text not null,
  expires_at timestamptz not null,
  state text not null default 'issued' check (state in ('issued', 'redeemed')),
  issued_at timestamptz not null default clock_timestamp(),
  redeemed_at timestamptz,
  redemption_digest text check (redemption_digest is null or redemption_digest ~ '^[0-9a-f]{64}$'),
  check ((state = 'issued' and redeemed_at is null and redemption_digest is null)
      or (state = 'redeemed' and redeemed_at is not null and redemption_digest is not null))
);

create index download_tickets_pair_time_idx
  on submissions_v2.download_tickets (pair_id, issued_at desc);

alter table submissions_v2.download_audit
  add column ticket_id uuid references submissions_v2.download_tickets(ticket_id) on delete restrict;

create index download_audit_ticket_idx
  on submissions_v2.download_audit (ticket_id, requested_at);

create table submissions_v2.private_object_reservations (
  id uuid primary key,
  object_key text not null unique,
  purpose text not null check (purpose in ('source_event', 'case_manifest', 'resume_checkpoint', 'resume_artifact', 'supplement_text')),
  owner_ref text not null,
  expected_digest text not null check (expected_digest ~ '^[0-9a-f]{64}$'),
  state text not null default 'pending' check (state in ('pending', 'cleanup', 'committed', 'purged')),
  expires_at timestamptz not null,
  created_at timestamptz not null default clock_timestamp(),
  cleanup_owner text,
  cleanup_started_at timestamptz,
  cleanup_fencing_token bigint not null default 0 check (cleanup_fencing_token >= 0),
  write_owner text,
  write_lease_expires_at timestamptz,
  write_fencing_token bigint not null default 0 check (write_fencing_token >= 0),
  committed_at timestamptz,
  purged_at timestamptz,
  purge_actor text,
  check (expires_at > created_at),
  check ((state = 'pending' and committed_at is null and purged_at is null and purge_actor is null
            and cleanup_owner is null and cleanup_started_at is null
            and ((write_owner is null and write_lease_expires_at is null)
              or (write_owner is not null and write_lease_expires_at is not null)))
      or (state = 'cleanup' and committed_at is null and purged_at is null and purge_actor is null
            and cleanup_owner is not null and cleanup_started_at is not null
            and write_owner is null and write_lease_expires_at is null)
      or (state = 'committed' and committed_at is not null and purged_at is null and purge_actor is null
            and cleanup_owner is null and cleanup_started_at is null
            and write_owner is null and write_lease_expires_at is null)
      or (state = 'purged' and committed_at is null and purged_at is not null and purge_actor is not null
            and cleanup_owner is null and cleanup_started_at is not null
            and write_owner is null and write_lease_expires_at is null))
);

create index private_object_reservations_cleanup_idx
  on submissions_v2.private_object_reservations (expires_at, id)
  where state in ('pending', 'cleanup');

alter table submissions_v2.notification_outbox
  add column pair_id uuid references submissions_v2.candidate_role_pairs(id) on delete restrict;

create index notification_outbox_pair_state_idx
  on submissions_v2.notification_outbox (pair_id, state, next_attempt_at)
  where pair_id is not null;

alter table submissions_v2.case_deletions
  drop constraint case_deletions_state_check,
  drop constraint case_deletions_purge_lease_check,
  add constraint case_deletions_state_check
    check (state in ('soft_deleted', 'purging', 'restored', 'manifest_purging', 'manifest_purged', 'purged', 'purge_failed')),
  add constraint case_deletions_purge_lease_check check (
    (state in ('purging', 'manifest_purging') and purge_lease_owner is not null and purge_lease_expires_at is not null)
    or (state not in ('purging', 'manifest_purging') and purge_lease_owner is null and purge_lease_expires_at is null)
  );

create or replace function submissions_v2.claim_restored_manifest_purges(
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
    raise exception using errcode = '22023', message = 'invalid manifest purge claim bounds';
  end if;
  return query
  with due as materialized (
    select deletion.id
      from submissions_v2.case_deletions deletion
     where deletion.recovery_deadline <= clock_timestamp()
       and deletion.encrypted_manifest_object_key <> '[purged]'
       and (
         deletion.state = 'restored'
         or (deletion.state = 'manifest_purging' and deletion.purge_lease_expires_at < clock_timestamp())
       )
     order by deletion.recovery_deadline, deletion.id
     for update skip locked
     limit p_limit
  )
  update submissions_v2.case_deletions deletion
     set state='manifest_purging', purge_lease_owner=p_worker_id,
         purge_lease_expires_at=clock_timestamp() + make_interval(secs => p_lease_seconds),
         purge_fencing_token=deletion.purge_fencing_token+1
   where deletion.id in (select id from due)
  returning deletion.*;
end;
$$;

create or replace function submissions_v2.restored_manifest_purge_plan(
  p_deletion_id uuid,
  p_worker_id text,
  p_fencing_token bigint
)
returns text
language plpgsql
security definer
set search_path = pg_catalog, submissions_v2
as $$
declare
  manifest_object_key text;
begin
  perform submissions_v2.assert_isolated_purge_session();
  select deletion.encrypted_manifest_object_key into manifest_object_key
    from submissions_v2.case_deletions deletion
   where deletion.id=p_deletion_id and deletion.state='manifest_purging'
     and deletion.purge_lease_owner=p_worker_id and deletion.purge_fencing_token=p_fencing_token
     and deletion.purge_lease_expires_at >= clock_timestamp()
   for update;
  if manifest_object_key is null or manifest_object_key='[purged]' then
    raise exception using errcode = '40001', message = 'manifest purge claim fence lost';
  end if;
  return manifest_object_key;
end;
$$;

create or replace function submissions_v2.finalize_restored_manifest_purge(
  p_deletion_id uuid,
  p_worker_id text,
  p_fencing_token bigint
)
returns submissions_v2.case_deletions
language plpgsql
security definer
set search_path = pg_catalog, submissions_v2
as $$
declare
  deletion submissions_v2.case_deletions%rowtype;
  manifest_object_key text;
begin
  perform submissions_v2.assert_isolated_purge_session();
  perform set_config('submissions_v2.approved_purge', 'on', true);
  select item.encrypted_manifest_object_key into manifest_object_key
    from submissions_v2.case_deletions item
   where item.id=p_deletion_id and item.state='manifest_purging'
     and item.purge_lease_owner=p_worker_id and item.purge_fencing_token=p_fencing_token
     and item.purge_lease_expires_at >= clock_timestamp()
   for update;
  if manifest_object_key is null or manifest_object_key='[purged]' then
    raise exception using errcode = '40001', message = 'manifest purge claim fence lost';
  end if;
  update submissions_v2.case_deletions item
     set state='manifest_purged', reason='[purged]', encrypted_manifest_object_key='[purged]',
         manifest_digest=encode(public.digest('purged'::text, 'sha256'::text), 'hex'),
         purged_at=clock_timestamp(), purge_result='restored recovery manifest deleted',
         purge_lease_owner=null, purge_lease_expires_at=null
   where item.id=p_deletion_id and item.state='manifest_purging'
     and item.purge_lease_owner=p_worker_id and item.purge_fencing_token=p_fencing_token
     and item.purge_lease_expires_at >= clock_timestamp()
  returning item.* into deletion;
  if deletion.id is null then
    raise exception using errcode = '40001', message = 'manifest purge claim fence lost';
  end if;
  delete from submissions_v2.private_object_reservations reservation
   where reservation.object_key=manifest_object_key;
  return deletion;
end;
$$;

create or replace function submissions_v2.release_restored_manifest_purge(
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
  perform set_config('submissions_v2.approved_purge', 'on', true);
  update submissions_v2.case_deletions item
     set state='restored', purge_lease_owner=null, purge_lease_expires_at=null,
         purge_result=left(coalesce(p_error_code, 'manifest_purge_failed'), 500)
   where item.id=p_deletion_id and item.state='manifest_purging'
     and item.purge_lease_owner=p_worker_id and item.purge_fencing_token=p_fencing_token
  returning item.* into deletion;
  if deletion.id is null then
    raise exception using errcode = '40001', message = 'manifest purge release fence lost';
  end if;
  return deletion;
end;
$$;

create or replace function submissions_v2.cancel_pair_job(
  p_job_id uuid,
  p_pair_id uuid,
  p_requested_at timestamptz
)
returns submissions_v2.jobs
language plpgsql
security definer
set search_path = pg_catalog, submissions_v2
as $$
declare
  result submissions_v2.jobs%rowtype;
begin
  if p_job_id is null or p_pair_id is null or p_requested_at is null then
    raise exception using errcode = '22023', message = 'pair job cancellation requires exact identifiers';
  end if;
  update submissions_v2.jobs
     set state='cancelled', lease_owner=null, lease_expires_at=null,
         fencing_token=fencing_token+1, completed_at=p_requested_at,
         safe_error_code='case_soft_deleted', hold_reason='case_soft_deleted'
   where id=p_job_id and subject_type='pair' and subject_id=p_pair_id::text
     and state in ('queued','running','held')
  returning * into result;
  if result.id is null then
    raise exception using errcode = '40001', message = 'pair job cancellation fence lost';
  end if;
  return result;
end;
$$;

-- PostgreSQL grants EXECUTE to PUBLIC on new functions by default; the final
-- migration removes that implicit capability from every V2 function before
-- assigning only the explicit API, worker, and isolated-purge grants below.
revoke execute on all functions in schema submissions_v2 from public;

revoke all on function submissions_v2.claim_restored_manifest_purges(text, integer, integer) from public;
revoke all on function submissions_v2.restored_manifest_purge_plan(uuid, text, bigint) from public;
revoke all on function submissions_v2.finalize_restored_manifest_purge(uuid, text, bigint) from public;
revoke all on function submissions_v2.release_restored_manifest_purge(uuid, text, bigint, text) from public;
revoke all on function submissions_v2.cancel_pair_job(uuid, uuid, timestamptz) from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname='submissions_v2_purge') then
    grant execute on function submissions_v2.claim_restored_manifest_purges(text, integer, integer) to submissions_v2_purge;
    grant execute on function submissions_v2.restored_manifest_purge_plan(uuid, text, bigint) to submissions_v2_purge;
    grant execute on function submissions_v2.finalize_restored_manifest_purge(uuid, text, bigint) to submissions_v2_purge;
    grant execute on function submissions_v2.release_restored_manifest_purge(uuid, text, bigint, text) to submissions_v2_purge;
  end if;
  if exists (select 1 from pg_roles where rolname='submissions_v2_api') then
    grant execute on function submissions_v2.cancel_pair_job(uuid, uuid, timestamptz) to submissions_v2_api;
  end if;
end;
$$;
