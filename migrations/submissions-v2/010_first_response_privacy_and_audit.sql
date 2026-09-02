create table submissions_v2.first_response_claims (
  candidate_user_id text not null,
  role_id text not null,
  event_id text not null,
  source_family text not null check (source_family in ('email', 'curated', 'manual')),
  signal_id uuid references submissions_v2.source_events(id) on delete set null,
  claimed_at timestamptz not null default clock_timestamp(),
  committed_at timestamptz,
  primary key (candidate_user_id, role_id),
  unique (event_id, role_id),
  check (signal_id is null or committed_at is not null)
);

create index first_response_claims_signal_idx
  on submissions_v2.first_response_claims (signal_id)
  where signal_id is not null;

create table submissions_v2.privacy_safe_events (
  event_digest text not null check (event_digest ~ '^[0-9a-f]{64}$'),
  metric_key text not null check (metric_key in ('later_signal_dropped', 'later_role_dropped')),
  dropped_role_count integer not null check (dropped_role_count > 0),
  recorded_at timestamptz not null default clock_timestamp(),
  primary key (event_digest, metric_key)
);

create table submissions_v2.privacy_safe_metrics (
  metric_key text primary key check (metric_key in ('later_signal_dropped', 'later_role_dropped')),
  event_count bigint not null default 0 check (event_count >= 0),
  dropped_role_count bigint not null default 0 check (dropped_role_count >= 0),
  updated_at timestamptz not null default clock_timestamp()
);

alter table submissions_v2.curated_snapshots
  add column pending_status text,
  add column pending_digest text check (pending_digest is null or pending_digest ~ '^[0-9a-f]{64}$'),
  add column pending_observed_at timestamptz;

-- Pre-release rows have no durable pending payload; treat them as resolved
-- before enabling the stronger forward-only pending-transition shape.
update submissions_v2.curated_snapshots set resolved=true;

alter table submissions_v2.curated_snapshots
  add constraint curated_snapshots_pending_shape check (
    (resolved and pending_status is null and pending_digest is null and pending_observed_at is null)
    or (not resolved and pending_status is not null and pending_digest is not null and pending_observed_at is not null)
  );

create or replace function submissions_v2.remove_first_response_claim_for_purged_pair()
returns trigger
language plpgsql
set search_path = pg_catalog, submissions_v2
as $$
begin
  delete from submissions_v2.first_response_claims
   where candidate_user_id=old.candidate_user_id and role_id=old.role_id;
  return old;
end;
$$;

create trigger candidate_role_pair_claim_cleanup
after delete on submissions_v2.candidate_role_pairs
for each row execute function submissions_v2.remove_first_response_claim_for_purged_pair();

alter table submissions_v2.classification_attempts
  drop constraint classification_attempts_attempt_check,
  add column execution_id uuid,
  add column attempt_in_execution integer;

update submissions_v2.classification_attempts
   set execution_id=signal_id, attempt_in_execution=attempt;

alter table submissions_v2.classification_attempts
  alter column execution_id set not null,
  alter column attempt_in_execution set not null,
  add constraint classification_attempts_attempt_check check (attempt > 0),
  add constraint classification_attempts_execution_attempt_check check (attempt_in_execution between 1 and 3),
  add constraint classification_attempts_execution_attempt_uq unique (signal_id, execution_id, attempt_in_execution);

revoke all on submissions_v2.first_response_claims from public;
revoke all on submissions_v2.privacy_safe_events from public;
revoke all on submissions_v2.privacy_safe_metrics from public;
revoke execute on function submissions_v2.remove_first_response_claim_for_purged_pair() from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname='submissions_v2_api') then
    grant select, insert, update on submissions_v2.first_response_claims to submissions_v2_api;
    grant select, insert on submissions_v2.privacy_safe_events to submissions_v2_api;
    grant select, insert, update on submissions_v2.privacy_safe_metrics to submissions_v2_api;
  end if;
  if exists (select 1 from pg_roles where rolname='submissions_v2_worker') then
    grant select, insert, update on submissions_v2.first_response_claims to submissions_v2_worker;
    grant select, insert on submissions_v2.privacy_safe_events to submissions_v2_worker;
    grant select, insert, update on submissions_v2.privacy_safe_metrics to submissions_v2_worker;
  end if;
end;
$$;

-- PostgreSQL grants EXECUTE to PUBLIC on new functions by default.
revoke execute on all functions in schema submissions_v2 from public;
