-- Submission is an independently verified provider fact. A Review item can
-- have an unclear reply while its exact candidate-role application is proven.
-- Recording that fact must not invent candidate interest or start preparation.
alter table submissions_v2.candidate_role_pairs
  drop constraint candidate_role_pairs_submission_proof_state_check,
  add constraint candidate_role_pairs_submission_proof_state_check check (
    (submission_status = 'proven' and submission_proven_at is not null
      and submission_application_id is not null and submission_authoritative_path is not null
      and submission_evidence_digest is not null
      and ((intent_state = 'interested' and workflow_state in ('preparing_resume', 'interested', 'needs_review'))
        or (intent_state = 'unclear' and workflow_state = 'needs_review')))
    or
    (submission_status <> 'proven' and submission_proven_at is null
      and submission_application_id is null and submission_authoritative_path is null
      and submission_evidence_digest is null)
  );

create or replace function submissions_v2.assert_pair_review_consistency()
returns trigger
language plpgsql
set search_path = pg_catalog, submissions_v2
as $$
declare
  target_pair uuid;
  workflow text;
  submission text;
  open_count integer;
begin
  if tg_table_name = 'candidate_role_pairs' then
    target_pair := coalesce(new.id, old.id);
  else
    target_pair := coalesce(new.pair_id, old.pair_id);
  end if;
  if target_pair is null then return null; end if;
  select workflow_state, submission_status into workflow, submission
    from submissions_v2.candidate_role_pairs where id = target_pair;
  if workflow is null then return null; end if;
  select count(*) into open_count from submissions_v2.review_items
   where pair_id = target_pair and action_state = 'open';
  if workflow = 'needs_review' and submission <> 'proven' and open_count = 0 then
    raise exception using errcode = '23514', message = 'Needs Review pair requires an open blocking reason';
  end if;
  if workflow <> 'needs_review' and open_count > 0 then
    raise exception using errcode = '23514', message = 'Open blocking reasons require Needs Review workflow';
  end if;
  return null;
end;
$$;
