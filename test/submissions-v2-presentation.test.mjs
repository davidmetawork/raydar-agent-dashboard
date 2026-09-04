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
    can_submit: false,
  });
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
    can_submit: false,
  });
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
