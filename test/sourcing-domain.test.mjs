import test from "node:test";
import assert from "node:assert/strict";
import {
  actionIdempotencyKey,
  applyFeedback,
  buildRunPlan,
  dedupeResults,
  proposeNextRun,
  transitionCandidate,
  transitionRun,
  validateFeedback,
  validateRoleMapping,
} from "../sourcing-domain.mjs";

test("bad feedback requires a known structured reason", () => {
  assert.throws(() => validateFeedback({ verdict: "bad" }), /structured reason/);
  assert.throws(() => validateFeedback({ verdict: "bad", reason: "vibes" }), /structured reason/);
  assert.deepEqual(validateFeedback({ verdict: "bad", reason: "too_junior", note: "  borderline  " }), {
    verdict: "bad", reason: "too_junior", note: "borderline",
  });
});

test("candidate feedback follows the review state machine and can be relabeled", () => {
  const discovered = { id: "candidate-1", state: "discovered" };
  const good = applyFeedback(discovered, { verdict: "good" });
  assert.equal(good.state, "good");
  const bad = applyFeedback(good, { verdict: "bad", reason: "wrong_title" });
  assert.equal(bad.state, "bad");
  assert.equal(bad.feedback.reason, "wrong_title");
  assert.throws(() => transitionCandidate(discovered, "enrolled"), /invalid candidate transition/);
});

test("a blocked enrollment can return to review and be safely retried", () => {
  const blocked = {
    id: "candidate-1",
    state: "enrollment_blocked",
    projectStatus: "filed",
    enrollmentStatus: "blocked",
    enrollmentReason: "membership_readback_failed",
  };
  const good = applyFeedback(blocked, { verdict: "good" });
  assert.equal(good.state, "good");
  assert.equal(good.projectStatus, "filed");
  assert.equal(good.enrollmentStatus, null);
  assert.equal(good.enrollmentReason, null);
});

test("run states cannot skip the review gate", () => {
  const ready = transitionRun({ id: "run-123", state: "draft" }, "ready");
  const running = transitionRun(ready, "running");
  assert.equal(transitionRun(running, "review").state, "review");
  assert.throws(() => transitionRun(running, "complete"), /invalid run transition/);
});

test("dedup keeps booked, enrolled, prior-run, and in-run duplicates out of review", () => {
  const result = dedupeResults([
    { candidateId: "candidate-a", candidateUserId: "user-a" },
    { candidateId: "candidate-b", candidateUserId: "user-booked" },
    { candidateId: "candidate-c", candidateUserId: "user-enrolled" },
    { candidateId: "candidate-prior", candidateUserId: "user-d" },
    { candidateId: "candidate-a", candidateUserId: "user-a" },
  ], {
    seenCandidateIds: ["candidate-prior"],
    bookedCandidateUserIds: ["user-booked"],
    enrolledCandidateUserIds: ["user-enrolled"],
  });
  assert.deepEqual(result.accepted.map((candidate) => candidate.candidateId), ["candidate-a"]);
  assert.deepEqual(result.blocked.map((candidate) => candidate.dedupReason), [
    "booked_or_later", "already_in_sequence", "seen_for_role", "duplicate_in_run",
  ]);
});

test("role mappings and run plans require stable explicit IDs and bounded lanes", () => {
  const mapping = validateRoleMapping({
    roleId: "role-123", reviewProjectId: "project-123", sequenceId: "sequence-123",
  });
  const run = buildRunPlan({
    runId: "run-123",
    mapping,
    rubricVersionId: "rubric-123",
    candidateCap: 100,
    lanes: [{ id: "lane-core", rationale: "Core match", filters: { skills: ["Go"] } }],
  });
  assert.equal(run.reviewProjectId, "project-123");
  assert.equal(run.writesEnabled, false);
  assert.throws(() => buildRunPlan({ runId: "run-123", mapping, rubricVersionId: "rubric-123", candidateCap: 101, lanes: [{}] }), /candidateCap/);
  assert.throws(() => buildRunPlan({ runId: "run-123", mapping, rubricVersionId: "rubric-123", candidateCap: 1000, lanes: [{}] }), /candidateCap/);
});

test("duplicate feedback proposes dedup work, never a fit-filter change", () => {
  const next = proposeNextRun([
    { verdict: "bad", reason: "duplicate_or_known" },
    { verdict: "bad", reason: "duplicate_or_known" },
  ]);
  assert.equal(next.proposals[0].scope, "dedup");
  assert.equal(next.autoApply, false);
});

test("write actions get deterministic idempotency keys", () => {
  const key = actionIdempotencyKey({ runId: "run-123", candidateId: "candidate-123", action: "project-file" });
  assert.equal(key, "sourcing:run-123:candidate-123:project-file");
});
