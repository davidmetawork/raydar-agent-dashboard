import assert from "node:assert/strict";
import test from "node:test";

import {
  createPreparationCommand,
  preparationResult,
  projectSubmissionCounts,
  projectSubmissionPair,
} from "../api/submissions-v2/_lib/domain/index.mjs";

const base = Object.freeze({
  pair_id: "pair-1", candidate_user_id: "candidate-1", role_id: "role-1", state_version: 8,
  intent_state: "interested", workflow_state: "preparing_resume", submission_status: "none", role_active: true,
});

test("positive intent stays visible while preparation is active", () => {
  const projected = projectSubmissionPair({ ...base, generation_status: "strategizing" });
  assert.equal(projected.view, "interested");
  assert.equal(projected.preparation.state, "preparing");
  assert.equal(projected.capabilities.download_artifact, false);
  assert.equal(projected.capabilities.open_submission_destination, false);
});

test("an initial preparation failure is an actionable Review state", () => {
  const projected = projectSubmissionPair({ ...base, workflow_state: "needs_review", generation_status: "failed", preparation_error_code: "candidate_original_resume_missing" });
  assert.equal(projected.view, "needs_review");
  assert.equal(projected.preparation.state, "blocked");
  assert.equal(projected.preparation.initial_failure, true);
  assert.equal(projected.capabilities.retry_preparation, false);
});

test("failed regeneration retains the last validated artifact", () => {
  const projected = projectSubmissionPair({ ...base, workflow_state: "interested", generation_status: "failed", preparation_error_code: "resume_preparation_failed", artifact_ready: true, current_artifact_id: "artifact-1", artifact_version: 3 });
  assert.equal(projected.view, "interested");
  assert.equal(projected.preparation.regeneration_failure, true);
  assert.equal(projected.capabilities.download_artifact, true);
  assert.equal(projected.capabilities.retry_preparation, true);
});

test("proof-only concurrency retains intent and preparation facts", () => {
  const projected = projectSubmissionPair({ ...base, workflow_state: "preparing_resume", generation_status: "validating", submission_status: "proven", submission_proof_id: "proof-1" });
  assert.equal(projected.intent.state, "interested");
  assert.equal(projected.preparation.state, "preparing");
  assert.equal(projected.submission.state, "proven");
  assert.equal(projected.capabilities.open_submission_destination, false);
});

test("Submit is navigation-only and history is an immutable projection", () => {
  const event = { id: "event-1", event_type: "submit_opened", created_at: "2026-09-05T12:00:00Z", from_submission_status: "none", to_submission_status: "opened" };
  const projected = projectSubmissionPair({ ...base, workflow_state: "interested", artifact_ready: true, current_artifact_id: "artifact-1", current_artifact_validation_status: "passed", history: [event] });
  assert.equal(projected.capabilities.open_submission_destination, true);
  assert.equal(projected.capabilities.mark_submitted, false);
  assert.equal(Object.isFrozen(projected.history), true);
  assert.equal(Object.isFrozen(projected.history[0]), true);
  event.event_type = "rewritten";
  assert.equal(projected.history[0].event_type, "submit_opened");
});

test("counts derive from the same versioned projection as detail rows", () => {
  assert.deepEqual(projectSubmissionCounts([
    { ...base, generation_status: "queued" },
    { ...base, pair_id: "pair-2", workflow_state: "needs_review", generation_status: "failed" },
    { ...base, pair_id: "pair-3", intent_state: "not_interested", workflow_state: "not_interested" },
  ]), { schema_version: "raydar.submissions-v2.pair-projection.v1", interested: 1, needs_review: 1, not_interested: 1, total: 3 });
});

test("preparation command carries only exact pair work and result holds conservative spend", () => {
  const command = createPreparationCommand({ pair: { id: "pair-1", candidate_user_id: "candidate-1", role_id: "role-1", state_version: 8, intent_state: "interested", workflow_state: "preparing_resume" }, job: { id: "job-1", attempt_count: 1 }, checkpoint: { expected_pair_version: 8, trigger_kind: "initial" } });
  assert.deepEqual(command.reuse_policy, {
    candidate_original_extraction: "exact-candidate-source-digest-only", pair_supplements: "never", role_context: "never", strategy: "never", validator: "never", artifact: "never",
  });
  const result = preparationResult({ command, outcome: "uncertain", reservedCents: 61, actualCents: null });
  assert.equal(result.cost.reserved_cents, 61);
  assert.equal(result.cost.actual_cents, null);
  assert.equal(result.cost.outcome_uncertain, true);
});
