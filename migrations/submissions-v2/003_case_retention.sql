create table submissions_v2.case_deletion_audit (
  id bigint generated always as identity primary key,
  deletion_id uuid not null references submissions_v2.case_deletions(id) on delete restrict,
  tombstone_case_hmac text not null check (tombstone_case_hmac ~ '^[0-9a-f]{64}$'),
  event_type text not null check (event_type in ('soft_deleted', 'restored', 'purged', 'purge_failed')),
  actor_email text not null,
  pair_state_version bigint check (pair_state_version is null or pair_state_version >= 1),
  reason_digest text not null check (reason_digest ~ '^[0-9a-f]{64}$'),
  idempotency_key text not null unique,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default clock_timestamp()
);
create index case_deletion_audit_deletion_time_idx
  on submissions_v2.case_deletion_audit (deletion_id, created_at, id);

create or replace function submissions_v2.reject_permanent_audit_mutation()
returns trigger
language plpgsql
set search_path = pg_catalog, submissions_v2
as $$
begin
  raise exception using
    errcode = '55000',
    message = format('%I.%I is a permanent append-only audit', tg_table_schema, tg_table_name);
end;
$$;

create trigger case_deletion_audit_append_only
before update or delete on submissions_v2.case_deletion_audit
for each row execute function submissions_v2.reject_permanent_audit_mutation();

revoke update, delete, truncate on submissions_v2.case_deletion_audit from public;

create index case_deletions_recovery_due_idx
  on submissions_v2.case_deletions (recovery_deadline, id)
  where state = 'soft_deleted';

-- The sensitive pair may be physically removed by the separately isolated
-- purge role after recovery expires while its non-PII tombstone remains.
alter table submissions_v2.case_deletions
  drop constraint case_deletions_pair_id_fkey;
alter table submissions_v2.case_deletions
  alter column pair_id drop not null;
alter table submissions_v2.case_deletions
  add constraint case_deletions_pair_id_fkey
  foreign key (pair_id) references submissions_v2.candidate_role_pairs(id) on delete set null;

-- A hidden case deliberately makes all of its artifacts unavailable during the
-- recovery window.  The ordinary Interested invariant resumes as soon as an
-- administrator restores the case and its exact artifact states.
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
  if pair_row.id is null or pair_row.workflow_state <> 'interested'
     or pair_row.case_hidden_at is not null then
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
