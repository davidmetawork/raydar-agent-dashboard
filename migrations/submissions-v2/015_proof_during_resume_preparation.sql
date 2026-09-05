do $$
declare
  prior_constraint text;
begin
  select constraint_row.conname into prior_constraint
    from pg_constraint constraint_row
   where constraint_row.conrelid = 'submissions_v2.candidate_role_pairs'::regclass
     and constraint_row.contype = 'c'
     and pg_get_constraintdef(constraint_row.oid) like '%submission_status%proven%submission_proven_at%'
   order by constraint_row.conname
   limit 1;
  if prior_constraint is null then
    raise exception 'candidate-role submission proof state constraint was not found';
  end if;
  execute format('alter table submissions_v2.candidate_role_pairs drop constraint %I', prior_constraint);
end
$$;

alter table submissions_v2.candidate_role_pairs
  add constraint candidate_role_pairs_submission_proof_state_check check (
    (submission_status = 'proven' and submission_proven_at is not null
      and submission_application_id is not null and submission_authoritative_path is not null
      and submission_evidence_digest is not null
      and intent_state = 'interested'
      and workflow_state in ('preparing_resume', 'interested', 'needs_review'))
    or
    (submission_status <> 'proven' and submission_proven_at is null
      and submission_application_id is null and submission_authoritative_path is null
      and submission_evidence_digest is null)
  );

create or replace function submissions_v2.guard_pair_identity()
returns trigger
language plpgsql
set search_path = pg_catalog, submissions_v2
as $$
declare
  proof_only_fence_preserving boolean;
  active_generation_exists boolean;
begin
  if new.candidate_user_id is distinct from old.candidate_user_id
     or new.role_id is distinct from old.role_id
     or new.first_signal_id is distinct from old.first_signal_id
     or new.original_signal_at is distinct from old.original_signal_at
     or new.created_at is distinct from old.created_at then
    raise exception using errcode = '55000', message = 'candidate-role identity and first signal are immutable';
  end if;
  select exists (
    select 1 from submissions_v2.resume_generations generation
     where generation.pair_id = old.id
       and generation.status in ('queued','collecting','extracting','strategizing','validating','rendering','archiving')
  ) into active_generation_exists;
  proof_only_fence_preserving :=
    new.state_version = old.state_version
    and (old.workflow_state = 'preparing_resume' or active_generation_exists)
    and new.workflow_state = old.workflow_state
    and new.intent_state = old.intent_state
    and new.owner_email is not distinct from old.owner_email
    and new.current_artifact_id is not distinct from old.current_artifact_id
    and new.resume_ready_at is not distinct from old.resume_ready_at
    and new.role_state is not distinct from old.role_state
    and new.role_checked_at is not distinct from old.role_checked_at
    and new.submission_opened_at is not distinct from old.submission_opened_at
    and new.case_hidden_at is not distinct from old.case_hidden_at
    and old.submission_status in ('none', 'opened')
    and new.submission_status = 'proven'
    and new.submission_proven_at is not null
    and new.submission_application_id is not null
    and new.submission_authoritative_path is not null
    and new.submission_evidence_digest is not null;
  if new.state_version <> old.state_version + 1 and not proof_only_fence_preserving then
    raise exception using errcode = '40001', message = 'pair state_version must advance by exactly one';
  end if;
  return new;
end;
$$;
