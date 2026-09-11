import test from "node:test";
import assert from "node:assert/strict";
import { REVIEW_REASONS, publicHealth, rowDto, safeHttps } from "../api/submissions-v2/_lib/presentation.mjs";

test("all nine normalized review reasons have simple recruiter actions", () => assert.equal(Object.keys(REVIEW_REASONS).length, 9));

test("row DTO rejects unsafe Signal destinations", () => {
  const row = rowDto({ signal_id: "s", provisional_name: "Unknown", signal_url: "javascript:alert(1)", workflow_state: "needs_review", review_reasons: ["candidate_not_found"] });
  assert.equal(row.signal_url, null);
  assert.equal(row.review_reasons[0].label, "Candidate is missing in Paraform");
  assert.equal(row.primary_action_label, "Add in Paraform, then Recheck");
  assert.equal(row.current_artifact_id, null);
  assert.deepEqual(row.capabilities, {
    can_correct: false,
    can_duplicate: false,
    can_download: false,
    can_regenerate: false,
    can_prepare_resume: false,
    can_submit: false,
    can_mark_submitted: false,
    can_unmark_submitted: false,
    can_mark_bad_fit: false,
    can_clear_bad_fit: false,
  });
});

test("pair-scoped role uncertainty asks for an interest decision without changing unresolved-source selection", () => {
  const pair = rowDto({
    pair_id: "pair-1", candidate_user_id: "candidate-1", role_id: "role-1",
    workflow_state: "needs_review", review_reasons: ["role_unclear"],
  });
  assert.deepEqual(pair.review_reasons, [{
    code: "role_unclear", label: "Confirm interest for this role", detail: null, action: "Review Signal",
  }]);
  assert.equal(pair.primary_action_label, "Review Signal");

  const unresolved = rowDto({
    signal_id: "signal-1", workflow_state: "needs_review", review_reasons: ["role_unclear"],
  });
  assert.deepEqual(unresolved.review_reasons, [{
    code: "role_unclear", label: "Exact offered role is unclear", detail: null, action: "Select role(s)",
  }]);
  assert.equal(unresolved.primary_action_label, "Select role(s)");
});

test("a role-unclear email with no offered role points at the producer gap, not a role picker", () => {
  const gap = rowDto({
    signal_id: "signal-2", source_family: "email", email_source_family: "new_match",
    workflow_state: "needs_review", review_reasons: ["role_unclear"], offered_role_count: 0,
  });
  assert.equal(gap.review_reasons[0].code, "role_unclear");
  assert.equal(gap.review_reasons[0].label, "No offered role was recorded for this reply");
  assert.equal(gap.primary_action_label, "Open the reply");
  assert.match(gap.review_reasons[0].detail, /no offered role/iu);
  // A stored safe detail still wins, and every other role-unclear row is untouched.
  assert.equal(rowDto({ ...{ signal_id: "signal-2", source_family: "email", offered_role_count: 0, workflow_state: "needs_review" }, review_reasons: [{ reason_code: "role_unclear", safe_detail: "Stored detail" }] }).review_reasons[0].detail, "Stored detail");
  const offered = rowDto({ signal_id: "signal-3", source_family: "email", workflow_state: "needs_review", review_reasons: ["role_unclear"], offered_role_count: 2 });
  assert.equal(offered.review_reasons[0].label, "Exact offered role is unclear");
  assert.equal(offered.primary_action_label, "Select role(s)");
  const curated = rowDto({ signal_id: "signal-4", source_family: "curated", workflow_state: "needs_review", review_reasons: ["role_unclear"], offered_role_count: 0 });
  assert.equal(curated.review_reasons[0].label, "Exact offered role is unclear");
});

test("rows without source evidence hide Signal instead of resolving Monitor root", () => {
  assert.equal(safeHttps(null, ["monitor.raydar.xyz"]), null);
  assert.equal(safeHttps("/master-inbox", ["monitor.raydar.xyz"]), null);
  assert.equal(rowDto({ signal_id: "s", signal_url: null }).signal_url, null);
});

test("safe URL allowlist includes exact trusted subdomains only", () => {
  assert.ok(safeHttps("https://www.paraform.com/browse?role=x", ["paraform.com"]));
  assert.equal(safeHttps("https://paraform.com.attacker.example/", ["paraform.com"]), null);
});

test("profile links immediately repair cached routes using resolved candidate user identity", () => {
  const row = rowDto({ candidate_user_id: "candidate-user-1", candidate_id: "domain-candidate-2", candidate_url: "https://www.paraform.com/candidates?candidate=old" });
  assert.equal(row.candidate_url, "https://www.paraform.com/candidates?candidate_profile_id=candidate-user-1");
  assert.equal(rowDto({ provisional_name: "Same name", candidate_id: "domain-candidate-2" }).candidate_url, null);
  assert.equal(rowDto({ candidate_user_id: "candidate&another=value" }).candidate_url, null);
});

test("admission sources identify the stored event and link only retained safe evidence", () => {
  const signal_url = "https://www.paraform.com/lists/list-1";
  assert.deepEqual(rowDto({ source_family: "curated", decisive_status: "APPLIED_TO_ROLE", signal_url }).admission_source,
    { label: "Curated List interest", url: signal_url });
  assert.deepEqual(rowDto({ source_family: "curated", decisive_status: "NOT_INTERESTED" }).admission_source,
    { label: "Curated List decline", url: null });
  assert.deepEqual(rowDto({ source_family: "email", email_source_family: "new_match", signal_url: "javascript:alert(1)" }).admission_source,
    { label: "New Match reply", url: null });
  assert.equal(rowDto({ source_family: "email", email_source_family: "para_ai_interview_request" }).admission_source.label, "Interview Request reply");
  assert.equal(rowDto({ source_family: "email", email_source_family: "fit_follow_up_with_matches" }).admission_source.label, "Fit Follow Up reply");
  assert.equal(rowDto({ source_family: "email", email_source_family: "paraform_sequence_reply" }).admission_source.label, "Sequence reply");
  assert.deepEqual(rowDto({ source_family: "manual" }).admission_source, { label: "Added by recruiter", url: null });
});

test("Interested preparation rows expose safe progress without artifact actions", () => {
  const row = rowDto({
    pair_id: "pair-1", candidate_user_id: "candidate-1", role_id: "role-1",
    workflow_state: "preparing_resume", submission_status: "none",
    generation_status: "QUEUED", generation_stage: "starting",
    preparation_error_code: "auth_expired", preparation_error_detail: "Safe retry detail",
    current_artifact_id: "unvalidated-artifact", artifact_ready: false, role_active: true,
  });
  assert.equal(row.generation_status, "queued");
  assert.equal(row.current_artifact_id, null);
  assert.equal(row.preparation_error_code, "auth_expired");
  assert.deepEqual(row.capabilities, {
    can_correct: true,
    can_duplicate: true,
    can_download: false,
    can_regenerate: false,
    can_prepare_resume: false,
    can_submit: false,
    can_mark_submitted: false,
    can_unmark_submitted: false,
    can_mark_bad_fit: true,
    can_clear_bad_fit: false,
  });
});

test("Needs Review shows the latest technical preparation failure without rewriting other blockers", () => {
  const row = rowDto({
    pair_id: "pair-1", candidate_user_id: "candidate-1", role_id: "role-1",
    workflow_state: "needs_review", submission_status: "none",
    review_reasons: [
      { reason_code: "role_unavailable", safe_detail: "The role is still unavailable." },
      { reason_code: "resume_preparation_failed", safe_detail: "Resume preparation exceeded its recovery deadline." },
    ],
    generation_status: "failed", generation_stage: "failed",
    preparation_error_code: "generation_budget_exhausted",
    preparation_error_detail: "Resume preparation reached its two-dollar model-cost ceiling.",
  });
  assert.equal(row.review_reasons[0].detail, "The role is still unavailable.");
  assert.equal(row.review_reasons[1].detail, "Resume preparation reached its two-dollar model-cost ceiling.");
  assert.equal(row.preparation_error_code, "generation_budget_exhausted");
});

test("only a validated ready artifact enables download, regeneration, and submission", () => {
  const ready = rowDto({
    pair_id: "pair-1", candidate_user_id: "candidate-1", role_id: "role-1",
    workflow_state: "interested", submission_status: "none", generation_status: "succeeded",
    current_artifact_id: "artifact-1", artifact_ready: true, artifact_version: 2, role_active: true,
  });
  assert.equal(ready.current_artifact_id, "artifact-1");
  assert.equal(ready.capabilities.can_download, true);
  assert.equal(ready.capabilities.can_regenerate, true);
  assert.equal(ready.capabilities.can_submit, true);

  const submitted = rowDto({ ...ready, submission_status: "proven" });
  assert.equal(submitted.capabilities.can_download, true);
  assert.equal(submitted.capabilities.can_correct, false);
  assert.equal(submitted.capabilities.can_regenerate, true);
  assert.equal(submitted.capabilities.can_submit, false);
});

test("Submitted history preserves downloads while regeneration still requires positive intent", () => {
  const row = {
    pair_id: "pair-1", candidate_user_id: "candidate-1", role_id: "role-1",
    workflow_state: "needs_review", submission_status: "proven", generation_status: "failed",
    current_artifact_id: "artifact-1", artifact_ready: true,
  };
  const positive = rowDto({ ...row, intent_state: "interested" });
  assert.equal(positive.capabilities.can_download, true);
  assert.equal(positive.capabilities.can_regenerate, true);
  const unclear = rowDto({ ...row, intent_state: "unclear" });
  assert.equal(unclear.capabilities.can_download, true);
  assert.equal(unclear.capabilities.can_regenerate, false);
  assert.equal(unclear.capabilities.can_submit, false);
  assert.equal(rowDto({ ...row, intent_state: "interested", generation_status: "strategizing" }).capabilities.can_regenerate, false);
});

test("a proven submission with no resume offers preparation instead of an unreachable regeneration", () => {
  const stranded = {
    pair_id: "pair-1", candidate_user_id: "candidate-1", role_id: "role-1",
    workflow_state: "needs_review", submission_status: "proven", generation_status: "failed",
    preparation_error_code: "resume_preparation_failed", artifact_ready: false, review_reasons: [],
  };
  const interested = rowDto({ ...stranded, intent_state: "interested" });
  assert.equal(interested.capabilities.can_prepare_resume, true);
  assert.equal(interested.capabilities.can_regenerate, false, "there is no artifact to regenerate from");
  assert.equal(interested.capabilities.can_download, false);

  assert.equal(rowDto({ ...stranded, intent_state: "unclear" }).capabilities.can_prepare_resume, true);
  assert.equal(rowDto({ ...stranded, intent_state: "unknown" }).capabilities.can_prepare_resume, false);
  assert.equal(rowDto({
    ...stranded, intent_state: "interested", artifact_ready: true, current_artifact_id: "artifact-1",
  }).capabilities.can_prepare_resume, false, "a ready resume needs no preparation");
  assert.equal(rowDto({
    ...stranded, intent_state: "interested", generation_status: "strategizing",
  }).capabilities.can_prepare_resume, false, "a live generation is already preparing it");
  assert.equal(rowDto({
    ...stranded, intent_state: "not_interested", workflow_state: "not_interested",
  }).capabilities.can_prepare_resume, false);
  assert.equal(rowDto({
    ...stranded, intent_state: "interested", submission_status: "none",
  }).capabilities.can_prepare_resume, false, "an unproven preparing item keeps Retry preparation");
});

test("a manual submission mark replaces the ready actions until Paraform confirms or the mark is undone", () => {
  const ready = {
    pair_id: "pair-1", candidate_user_id: "candidate-1", role_id: "role-1",
    workflow_state: "interested", submission_status: "none", generation_status: "succeeded",
    current_artifact_id: "artifact-1", artifact_ready: true, role_active: true,
  };
  const unmarked = rowDto(ready);
  assert.equal(unmarked.submission_marked_at, null);
  assert.equal(unmarked.submission_marked_by, null);
  assert.equal(unmarked.submitted_manually, false);
  assert.equal(unmarked.capabilities.can_mark_submitted, true);
  assert.equal(unmarked.capabilities.can_unmark_submitted, false);

  const marked = rowDto({
    ...ready, submission_status: "opened",
    submission_marked_at: "2026-09-08T10:00:00Z", submission_marked_by: "david@raydar.xyz",
  });
  assert.equal(marked.submission_marked_at, "2026-09-08T10:00:00.000Z");
  assert.equal(marked.submission_marked_by, "david@raydar.xyz");
  assert.equal(marked.submitted_manually, true);
  assert.equal(marked.capabilities.can_mark_submitted, false);
  assert.equal(marked.capabilities.can_unmark_submitted, true);
  assert.equal(marked.capabilities.can_submit, false);
  assert.equal(marked.capabilities.can_correct, false);
  assert.equal(marked.capabilities.can_download, true);
  assert.equal(marked.capabilities.can_regenerate, true);
  assert.equal(marked.capabilities.can_duplicate, true);

  const proven = rowDto({ ...marked, submission_status: "proven" });
  assert.equal(proven.submitted_manually, false, "Paraform proof supersedes the human mark");
  assert.equal(proven.capabilities.can_mark_submitted, false);
  assert.equal(proven.capabilities.can_unmark_submitted, false);
  assert.equal(proven.capabilities.can_submit, false);

  const preparing = rowDto({ ...ready, workflow_state: "preparing_resume", artifact_ready: false });
  assert.equal(preparing.capabilities.can_mark_submitted, false, "only an Interested candidate can be marked");

  const withoutArtifact = rowDto({ ...ready, artifact_ready: false, current_artifact_id: null });
  assert.equal(withoutArtifact.capabilities.can_submit, false);
  assert.equal(withoutArtifact.capabilities.can_mark_submitted, true, "David may have submitted a different resume");
  assert.equal(rowDto({ ...ready, role_active: false }).capabilities.can_mark_submitted, true, "the role may go inactive after a real submission");
});

test("public health preserves safe per-source status for dependency-specific gating", () => {
  const health = publicHealth({
    delayed: true,
    database: "current",
    sources: {
      candidate_index: { enabled: true, last_success_at: "2026-09-04T21:00:00.000Z", delayed_since: "2026-09-04T22:00:00.000Z", error_class: "AUTH_EXPIRED", safe_error_detail: "Candidate cache is delayed.", quota_state: "available" },
      role_index: { enabled: true, last_success_at: "2026-09-04T23:00:00.000Z", delayed_since: null, error_class: null, quota_state: "available" },
    },
  });
  assert.equal(health.delayed, true);
  assert.equal(health.sources.candidate_index.delayed, true);
  assert.equal(health.sources.candidate_index.error_class, "AUTH_EXPIRED");
  assert.equal(health.sources.candidate_index.safe_error_detail, "Candidate cache is delayed.");
  assert.equal(health.sources.role_index.delayed, false);
});

test("health separates live and history coverage from successful checks without exposing cursors", () => {
  const health = publicHealth({ sources: { master_inbox: {
    enabled: true, last_success_at: "2026-09-01T00:00:00Z", quota_retry_at: "invalid",
    last_complete_at: null, coverage: {
      live_through: Date.parse("2026-09-04T21:00:00Z"), history_through: Date.parse("2026-09-02T05:00:00Z"),
      live_caught_up: true, history_caught_up: false, cursor: "opaque-private-cursor", provider_id: "private-id",
    },
  }, sequence_inbox: { coverage: { cache_confirmed_through: "2026-09-04T20:00:00Z", caught_up: false } } } });
  assert.deepEqual(health.sources.master_inbox.coverage, {
    live_through: "2026-09-04T21:00:00.000Z", history_through: "2026-09-02T05:00:00.000Z",
    live_caught_up: true, history_caught_up: false, cache_confirmed_through: null, caught_up: null,
  });
  assert.equal(health.sources.master_inbox.last_complete_at, null);
  assert.equal(health.sources.master_inbox.retry_at, null);
  assert.equal(health.sources.sequence_inbox.coverage.cache_confirmed_through, "2026-09-04T20:00:00.000Z");
  assert.equal(health.sources.sequence_inbox.coverage.caught_up, false);
  assert.equal(JSON.stringify(health).includes("private"), false);
});
