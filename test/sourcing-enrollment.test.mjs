import test from "node:test";
import assert from "node:assert/strict";
import {
  applyEnrollmentResults,
  planEnrollment,
  queueEnrollment,
} from "../api/sourcing/_lib/enrollment.mjs";

const candidate = (id, state = "good") => ({
  id,
  candidateUserId: `user-${id}`,
  state,
  projectStatus: "filed",
});

test("enrollment intent is durable and idempotent before a vendor write", () => {
  const queued = queueEnrollment(candidate("one"), { source: "claim" });
  assert.equal(queued.state, "enrollment_queued");
  assert.equal(queueEnrollment(queued, { source: "retry" }), queued);
});

test("retry reconciliation treats target membership as success before global dedup", () => {
  const queued = queueEnrollment(candidate("one"), { source: "claim" });
  const plan = planEnrollment([queued], {
    membership: new Map([[queued.candidateUserId, { ccuId: "lead-1" }]]),
    booked: new Set(),
    already: new Set([queued.candidateUserId]),
  });
  assert.deepEqual([...plan.reconciled], [queued.id]);
  assert.equal(plan.keep.length, 0);

  const [finished] = applyEnrollmentResults([queued], new Set([queued.id]), {
    ...plan,
    vendorBlocked: new Map(),
    membership: new Map(),
    sequenceId: "sequence-123",
    at: "2026-07-15T00:00:00.000Z",
  });
  assert.equal(finished.state, "enrolled");
  assert.equal(finished.enrollmentStatus, "enrolled");
  assert.equal(finished.lastTransition.source, "sourcing-enroll-reconcile");
});

test("booked, cross-sequence, vendor, and failed-readback outcomes all fail closed", () => {
  const items = ["booked", "other", "vendor", "missing"].map((id) => queueEnrollment(candidate(id), { source: "claim" }));
  const plan = planEnrollment(items, {
    membership: new Map(),
    booked: new Set(["user-booked"]),
    already: new Set(["user-other"]),
  });
  assert.deepEqual(plan.keep.map((item) => item.id), ["vendor", "missing"]);

  const finished = applyEnrollmentResults(items, new Set(items.map((item) => item.id)), {
    ...plan,
    vendorBlocked: new Map([["user-vendor", "blocked_company"]]),
    membership: new Map(),
    sequenceId: "sequence-123",
    at: "2026-07-15T00:00:00.000Z",
  });
  assert.deepEqual(finished.map((item) => item.state), Array(4).fill("enrollment_blocked"));
  assert.deepEqual(finished.map((item) => item.enrollmentReason), [
    "booked_or_later",
    "already_in_sequence",
    "blocked_company",
    "membership_readback_failed",
  ]);
});
