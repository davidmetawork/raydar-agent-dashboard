import { transitionCandidate } from "../../../sourcing-domain.mjs";

export function queueEnrollment(candidate, evidence) {
  let next = candidate;
  if (next.state === "good") next = transitionCandidate(next, "project_queued", evidence);
  if (next.state === "project_queued") next = transitionCandidate(next, "project_filed", evidence);
  if (next.state === "project_filed") next = transitionCandidate(next, "enrollment_queued", evidence);
  return next;
}

export function finishEnrollment(candidate, finalState, evidence) {
  return transitionCandidate(queueEnrollment(candidate, evidence), finalState, evidence);
}

export function planEnrollment(candidates, { already, booked, membership }) {
  const preblocked = new Map();
  const reconciled = new Set();
  for (const candidate of candidates) {
    // Target membership is authoritative evidence that an interrupted earlier
    // write succeeded. It must be reconciled, not misclassified as a duplicate.
    if (membership.has(candidate.candidateUserId)) reconciled.add(candidate.id);
    else if (booked.has(candidate.candidateUserId)) preblocked.set(candidate.id, "booked_or_later");
    else if (already.has(candidate.candidateUserId)) preblocked.set(candidate.id, "already_in_sequence");
  }
  const keep = candidates.filter((candidate) => !preblocked.has(candidate.id) && !reconciled.has(candidate.id));
  return { preblocked, reconciled, keep };
}

export function applyEnrollmentResults(candidates, selected, {
  preblocked,
  reconciled,
  vendorBlocked,
  membership,
  sequenceId,
  at,
}) {
  return candidates.map((candidate) => {
    if (!selected.has(candidate.id)) return candidate;
    const reason = preblocked.get(candidate.id) || vendorBlocked.get(candidate.candidateUserId);
    if (reconciled.has(candidate.id) || membership.has(candidate.candidateUserId)) {
      return {
        ...finishEnrollment(candidate, "enrolled", {
          source: reconciled.has(candidate.id) ? "sourcing-enroll-reconcile" : "sourcing-enroll",
          at,
        }),
        enrollmentStatus: "enrolled",
        enrolledAt: at,
        sequenceId,
      };
    }
    const blockedReason = reason || "membership_readback_failed";
    return {
      ...finishEnrollment(candidate, "enrollment_blocked", { source: "sourcing-enroll", at, reason: blockedReason }),
      enrollmentStatus: "blocked",
      enrollmentReason: blockedReason,
    };
  });
}
