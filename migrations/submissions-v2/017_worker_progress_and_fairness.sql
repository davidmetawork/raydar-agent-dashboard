-- Worker observability is durable and privacy-safe: it records cycle outcomes,
-- queue counts, and service turns without candidate or provider payloads.
create table submissions_v2.worker_progress (
  worker_key text primary key,
  worker_id text not null,
  process_started_at timestamptz not null,
  cycle_token uuid,
  cycle_sequence bigint not null default 0 check (cycle_sequence >= 0),
  cycle_running boolean not null default false,
  last_attempted_cycle_at timestamptz,
  last_completed_cycle_at timestamptz,
  last_successful_cycle_at timestamptz,
  last_cycle_ok boolean,
  last_cycle_error_class text check (
    last_cycle_error_class is null or (
      length(last_cycle_error_class) between 1 and 120
      and last_cycle_error_class ~ '^[a-z0-9_-]+$'
    )
  ),
  last_failure_at timestamptz,
  last_failure_error_class text check (
    last_failure_error_class is null or (
      length(last_failure_error_class) between 1 and 120
      and last_failure_error_class ~ '^[a-z0-9_-]+$'
    )
  ),
  last_cycle_job_count integer not null default 0 check (last_cycle_job_count >= 0),
  last_cycle_control_epoch bigint check (last_cycle_control_epoch is null or last_cycle_control_epoch >= 0),
  last_cycle_duration_ms integer check (last_cycle_duration_ms is null or last_cycle_duration_ms >= 0),
  updated_at timestamptz not null default clock_timestamp()
);

create table submissions_v2.worker_service_fairness (
  service_class text primary key check (service_class in (
    'live_intake', 'decision', 'resume', 'proof', 'outbox', 'maintenance'
  )),
  weight integer not null check (weight between 1 and 100),
  max_service_gap_seconds integer not null check (max_service_gap_seconds between 30 and 86400),
  current_weight_score bigint not null default 0,
  last_claimed_at timestamptz,
  claim_count bigint not null default 0 check (claim_count >= 0),
  updated_at timestamptz not null default clock_timestamp()
);

insert into submissions_v2.worker_service_fairness(
  service_class, weight, max_service_gap_seconds
) values
  ('live_intake', 8, 120),
  ('decision', 6, 180),
  ('resume', 3, 300),
  ('proof', 4, 300),
  ('outbox', 4, 300),
  ('maintenance', 1, 900)
on conflict (service_class) do update set
  weight=excluded.weight,
  max_service_gap_seconds=excluded.max_service_gap_seconds;

create or replace function submissions_v2.worker_job_service_class(p_kind text)
returns text
language sql
immutable
strict
set search_path = pg_catalog, submissions_v2
as $$
  select case
    when p_kind in ('reconcile_master_inbox', 'reconcile_sequence_inbox') then 'live_intake'
    when p_kind in ('classify_email_reply', 'recheck_pair') then 'decision'
    when p_kind = 'prepare_resume' then 'resume'
    when p_kind = 'proof_reconcile' then 'proof'
    when p_kind in ('deliver_notification', 'daily_digest') then 'outbox'
    else 'maintenance'
  end
$$;

-- Smooth weighted round-robin provides normal service proportions. A class
-- whose runnable backlog has not received a turn within its service gap wins
-- first, so continuous high-priority intake cannot indefinitely starve proof,
-- outbox, resume, or maintenance work. Jobs still age within their class.
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
declare
  runnable_classes text[];
  chosen_class text;
  runnable_weight integer;
begin
  if length(btrim(coalesce(p_worker_id, ''))) = 0 then
    raise exception using errcode = '22023', message = 'worker id is required';
  end if;
  if p_limit < 1 or p_limit > 50 or p_lease_seconds < 15 or p_lease_seconds > 900 then
    raise exception using errcode = '22023', message = 'invalid claim bounds';
  end if;

  -- Serialize only the small scheduler ledger, never a provider or job handler.
  perform 1
    from submissions_v2.worker_service_fairness
   order by service_class
   for update;

  select array_agg(distinct submissions_v2.worker_job_service_class(job.kind))
    into runnable_classes
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
     );

  if coalesce(cardinality(runnable_classes), 0) = 0 then
    return;
  end if;

  update submissions_v2.worker_service_fairness fairness
     set current_weight_score = fairness.current_weight_score + fairness.weight,
         updated_at = clock_timestamp()
   where fairness.service_class = any(runnable_classes);

  select coalesce(sum(fairness.weight), 1)::integer
    into runnable_weight
    from submissions_v2.worker_service_fairness fairness
   where fairness.service_class = any(runnable_classes);

  with oldest as (
    select submissions_v2.worker_job_service_class(job.kind) as service_class,
           min(job.scheduled_at) as oldest_due_at
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
     group by submissions_v2.worker_job_service_class(job.kind)
  ), ranked as (
    select fairness.service_class,
           extract(epoch from (
             clock_timestamp() - greatest(
               oldest.oldest_due_at,
               coalesce(fairness.last_claimed_at, oldest.oldest_due_at)
             )
           )) / fairness.max_service_gap_seconds::numeric as service_debt,
           fairness.current_weight_score
      from oldest
      join submissions_v2.worker_service_fairness fairness using (service_class)
  )
  select ranked.service_class into chosen_class
    from ranked
   order by
     (ranked.service_debt >= 1) desc,
     case when ranked.service_debt >= 1 then ranked.service_debt else 0 end desc,
     ranked.current_weight_score desc,
     case ranked.service_class
       when 'live_intake' then 0
       when 'decision' then 1
       when 'proof' then 2
       when 'outbox' then 3
       when 'resume' then 4
       else 5
     end,
     ranked.service_class
   limit 1;

  if chosen_class is null then return; end if;

  update submissions_v2.worker_service_fairness fairness
     set current_weight_score = fairness.current_weight_score - runnable_weight,
         last_claimed_at = clock_timestamp(),
         claim_count = fairness.claim_count + 1,
         updated_at = clock_timestamp()
   where fairness.service_class = chosen_class;

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
       and submissions_v2.worker_job_service_class(job.kind) = chosen_class
       and (
         job.state = 'queued'
         or (job.state = 'running' and job.lease_expires_at < clock_timestamp())
       )
     order by
       job.priority - least(
         1000,
         floor(extract(epoch from (clock_timestamp() - job.scheduled_at)) / 60)::integer
       ),
       job.scheduled_at,
       job.created_at,
       job.id
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

revoke all on submissions_v2.worker_progress from public;
revoke all on submissions_v2.worker_service_fairness from public;
revoke execute on function submissions_v2.worker_job_service_class(text) from public;
revoke execute on function submissions_v2.claim_jobs(text, text[], integer, integer, bigint) from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'submissions_v2_worker') then
    grant select, insert, update on submissions_v2.worker_progress to submissions_v2_worker;
    grant select on submissions_v2.worker_service_fairness to submissions_v2_worker;
    grant execute on function submissions_v2.worker_job_service_class(text) to submissions_v2_worker;
    grant execute on function submissions_v2.claim_jobs(text, text[], integer, integer, bigint)
      to submissions_v2_worker;
  end if;
end;
$$;
