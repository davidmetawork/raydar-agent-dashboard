-- Run once as the schema owner after every Submissions V2 migration.
-- Attach deployment login roles to submissions_v2_api or submissions_v2_worker
-- outside this file; never reuse either login for the isolated purge service.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'submissions_v2_api') then
    create role submissions_v2_api nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'submissions_v2_worker') then
    create role submissions_v2_worker nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'submissions_v2_purge') then
    create role submissions_v2_purge login noinherit;
  end if;
end;
$$;

revoke all on schema submissions_v2 from public;
revoke all on all tables in schema submissions_v2 from public;
revoke all on all sequences in schema submissions_v2 from public;
revoke execute on all functions in schema submissions_v2 from public;

grant usage on schema submissions_v2 to submissions_v2_api, submissions_v2_worker, submissions_v2_purge;
grant select on
  submissions_v2.archive_lookup_audit,
  submissions_v2.api_commands,
  submissions_v2.artifact_deletions,
  submissions_v2.candidate_index,
  submissions_v2.candidate_role_pairs,
  submissions_v2.case_deletion_audit,
  submissions_v2.case_deletions,
  submissions_v2.claim_evidence_links,
  submissions_v2.claim_validations,
  submissions_v2.classification_attempts,
  submissions_v2.curated_snapshots,
  submissions_v2.download_audit,
  submissions_v2.download_tickets,
  submissions_v2.first_response_claims,
  submissions_v2.job_attempts,
  submissions_v2.jobs,
  submissions_v2.not_interested_entries,
  submissions_v2.notification_outbox,
  submissions_v2.pair_events,
  submissions_v2.pair_signal_links,
  submissions_v2.private_object_reservations,
  submissions_v2.privacy_safe_events,
  submissions_v2.privacy_safe_metrics,
  submissions_v2.resume_artifacts,
  submissions_v2.resume_claims,
  submissions_v2.resume_generations,
  submissions_v2.resume_sources,
  submissions_v2.resume_stage_runs,
  submissions_v2.resume_supplements,
  submissions_v2.review_items,
  submissions_v2.role_index,
  submissions_v2.runtime_control_events,
  submissions_v2.runtime_controls,
  submissions_v2.signal_role_decisions,
  submissions_v2.source_cursors,
  submissions_v2.source_events,
  submissions_v2.source_health,
  submissions_v2.source_offered_roles,
  submissions_v2.source_runs,
  submissions_v2.submission_proofs,
  submissions_v2.upload_reservations
to submissions_v2_api;

grant insert, update on
  submissions_v2.api_commands,
  submissions_v2.artifact_deletions,
  submissions_v2.candidate_role_pairs,
  submissions_v2.case_deletions,
  submissions_v2.download_audit,
  submissions_v2.download_tickets,
  submissions_v2.first_response_claims,
  submissions_v2.not_interested_entries,
  submissions_v2.private_object_reservations,
  submissions_v2.privacy_safe_metrics,
  submissions_v2.resume_artifacts,
  submissions_v2.resume_generations,
  submissions_v2.resume_supplements,
  submissions_v2.review_items,
  submissions_v2.source_events,
  submissions_v2.upload_reservations
to submissions_v2_api;
grant insert on
  submissions_v2.archive_lookup_audit,
  submissions_v2.case_deletion_audit,
  submissions_v2.jobs,
  submissions_v2.notification_outbox,
  submissions_v2.pair_events,
  submissions_v2.pair_signal_links,
  submissions_v2.privacy_safe_events,
  submissions_v2.source_offered_roles
to submissions_v2_api;

grant select on
  submissions_v2.artifact_deletions,
  submissions_v2.candidate_index,
  submissions_v2.candidate_index_suppressions,
  submissions_v2.candidate_role_pairs,
  submissions_v2.claim_evidence_links,
  submissions_v2.claim_validations,
  submissions_v2.classification_attempts,
  submissions_v2.curated_snapshots,
  submissions_v2.first_response_claims,
  submissions_v2.job_attempts,
  submissions_v2.jobs,
  submissions_v2.not_interested_entries,
  submissions_v2.notification_outbox,
  submissions_v2.pair_events,
  submissions_v2.pair_signal_links,
  submissions_v2.private_object_reservations,
  submissions_v2.privacy_safe_events,
  submissions_v2.privacy_safe_metrics,
  submissions_v2.resume_artifacts,
  submissions_v2.resume_claims,
  submissions_v2.resume_generations,
  submissions_v2.resume_sources,
  submissions_v2.resume_stage_runs,
  submissions_v2.resume_supplements,
  submissions_v2.review_items,
  submissions_v2.role_index,
  submissions_v2.runtime_controls,
  submissions_v2.signal_role_decisions,
  submissions_v2.source_cursors,
  submissions_v2.source_events,
  submissions_v2.source_health,
  submissions_v2.source_offered_roles,
  submissions_v2.submission_proofs,
  submissions_v2.upload_reservations
to submissions_v2_worker;

grant insert, update on
  submissions_v2.artifact_deletions,
  submissions_v2.candidate_index,
  submissions_v2.candidate_role_pairs,
  submissions_v2.curated_snapshots,
  submissions_v2.first_response_claims,
  submissions_v2.job_attempts,
  submissions_v2.jobs,
  submissions_v2.not_interested_entries,
  submissions_v2.notification_outbox,
  submissions_v2.private_object_reservations,
  submissions_v2.privacy_safe_metrics,
  submissions_v2.resume_artifacts,
  submissions_v2.resume_claims,
  submissions_v2.resume_generations,
  submissions_v2.resume_stage_runs,
  submissions_v2.resume_supplements,
  submissions_v2.review_items,
  submissions_v2.role_index,
  submissions_v2.source_cursors,
  submissions_v2.source_events,
  submissions_v2.source_health,
  submissions_v2.upload_reservations
to submissions_v2_worker;
grant insert on
  submissions_v2.claim_evidence_links,
  submissions_v2.claim_validations,
  submissions_v2.classification_attempts,
  submissions_v2.privacy_safe_events,
  submissions_v2.pair_events,
  submissions_v2.pair_signal_links,
  submissions_v2.resume_sources,
  submissions_v2.signal_role_decisions,
  submissions_v2.source_offered_roles,
  submissions_v2.submission_proofs
to submissions_v2_worker;
grant usage, select on all sequences in schema submissions_v2 to submissions_v2_api, submissions_v2_worker;

grant execute on function submissions_v2.set_runtime_controls(text, text, boolean, boolean, boolean, boolean, boolean)
  to submissions_v2_api;
grant execute on function submissions_v2.lock_runtime_controls()
  to submissions_v2_api, submissions_v2_worker;
grant execute on function submissions_v2.cancel_pair_job(uuid, uuid, timestamptz)
  to submissions_v2_api;

grant execute on function submissions_v2.claim_jobs(text, text[], integer, integer, bigint)
  to submissions_v2_worker;
grant execute on function submissions_v2.heartbeat_job(uuid, text, bigint, bigint, integer)
  to submissions_v2_worker;
grant execute on function submissions_v2.checkpoint_job(uuid, text, bigint, bigint, jsonb)
  to submissions_v2_worker;
grant execute on function submissions_v2.complete_job(uuid, text, bigint, bigint, jsonb)
  to submissions_v2_worker;
grant execute on function submissions_v2.fail_job(uuid, text, bigint, bigint, text, text, boolean, integer, jsonb)
  to submissions_v2_worker;
grant execute on function submissions_v2.claim_source_cursor(text, text, integer, bigint)
  to submissions_v2_worker;
grant execute on function submissions_v2.heartbeat_source_cursor(text, text, bigint, bigint, integer)
  to submissions_v2_worker;
grant execute on function submissions_v2.commit_source_cursor(text, text, bigint, bigint, jsonb, boolean)
  to submissions_v2_worker;
grant execute on function submissions_v2.release_source_cursor(text, text, bigint, bigint)
  to submissions_v2_worker;
grant execute on function submissions_v2.job_control_enabled(text, submissions_v2.runtime_controls)
  to submissions_v2_worker;

grant execute on function submissions_v2.claim_case_purges(text, integer, integer) to submissions_v2_purge;
grant execute on function submissions_v2.case_purge_plan(uuid, text, bigint) to submissions_v2_purge;
grant execute on function submissions_v2.finalize_case_purge(uuid, text, bigint, text) to submissions_v2_purge;
grant execute on function submissions_v2.release_case_purge(uuid, text, bigint, text) to submissions_v2_purge;
grant execute on function submissions_v2.claim_restored_manifest_purges(text, integer, integer) to submissions_v2_purge;
grant execute on function submissions_v2.restored_manifest_purge_plan(uuid, text, bigint) to submissions_v2_purge;
grant execute on function submissions_v2.finalize_restored_manifest_purge(uuid, text, bigint) to submissions_v2_purge;
grant execute on function submissions_v2.release_restored_manifest_purge(uuid, text, bigint, text) to submissions_v2_purge;
grant execute on function submissions_v2.claim_routine_object_purges(text, integer, integer) to submissions_v2_purge;
grant execute on function submissions_v2.finalize_routine_object_purge(text, uuid, text, bigint) to submissions_v2_purge;
grant execute on function submissions_v2.release_routine_object_purge(text, uuid, text, bigint) to submissions_v2_purge;

alter default privileges in schema submissions_v2 revoke all on tables from public;
alter default privileges in schema submissions_v2 revoke execute on functions from public;
