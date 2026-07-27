// Regression cover for the 2026-07-27 false-Added investigation. Three
// independent paths were turning the Candidates-tab pill green for candidates
// Paraform has no Talent Network submission for.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  buildParaAIStatusIndex,
  confirmedLocalMemberships,
  localConfirmedMembership,
  talentNetworkSubmitted,
} from "../api/roster/_lib/paraai-status.mjs";
import {
  applyOutcomeMemberships,
  buildOutcomeMembershipIndex,
} from "../api/roster/_lib/outcome-sequences.mjs";

const dashboard = await readFile(new URL("../index.html", import.meta.url), "utf8");

const job = (overrides = {}) => ({
  identity: { candidateUserId: "candidate-a" },
  submission: { name: "Candidate A" },
  ...overrides,
});

test("a pre-submission review job is not submission evidence", () => {
  // `needs_review` is also the human-review lane a prepared job parks in
  // before any write; on 2026-07-27 that alone turned 21 candidates green.
  assert.equal(localConfirmedMembership(job({ state: "needs_review" })), null);
  assert.equal(localConfirmedMembership(job({ state: "no_email" })), null);
  assert.equal(localConfirmedMembership(job({ state: "ready_to_submit" })), null);
  assert.equal(localConfirmedMembership(job({ state: "needs_identity_review" })), null);
  // An uncertain write is "may have landed", never a green badge.
  assert.equal(
    localConfirmedMembership(job({ state: "submission_unknown", submitClaimedAt: "2026-07-27T00:00:00.000Z" })),
    null,
  );
});

test("only accepted, read-back or post-submit jobs confirm membership", () => {
  for (const confirmed of [
    job({ state: "needs_review", submitReadbackVerified: true }),
    job({ state: "needs_review", error: { code: "ALREADY_SUBMITTED" } }),
    // A genuinely submitted job that later parks in review still qualifies:
    // submitAcceptedAt is written when Paraform accepted the mutation and
    // survives every later transition.
    job({ state: "needs_review", submitAcceptedAt: "2026-07-27T00:00:00.000Z" }),
    job({ state: "no_email", submitAcceptedAt: "2026-07-27T00:00:00.000Z" }),
    job({ state: "awaiting_matches" }),
    job({ state: "awaiting_approval" }),
    job({ state: "enrolled" }),
  ]) {
    assert.equal(localConfirmedMembership(confirmed)?.candidateUserId, "candidate-a");
  }
  assert.equal(confirmedLocalMemberships([job({ state: "needs_review" }), job({ state: "enrolled" })]).length, 1);
});

test("Talent Network membership is the submission timestamp, not the matching pool", () => {
  assert.equal(talentNetworkSubmitted({ talent_network_submitted_at: "2026-07-27T00:00:00.000Z" }), true);
  assert.equal(talentNetworkSubmitted({ talentNetworkSubmittedAt: "2026-07-27T00:00:00.000Z" }), true);
  // Paraform's real enum values are AUTO_/RECRUITER_ prefixed, so the old
  // bare "OFF_MARKET" exclusion never matched and off-market people read as
  // submitted. Being in (or out of) the matching pool is not membership.
  for (const pool of [
    "AUTO_OFF_MARKET",
    "RECRUITER_OFF_MARKET",
    "RECRUITER_PRE_EXCLUDED",
    "AUTO_ON_MARKET",
    "RECRUITER_ON_MARKET",
    "INELIGIBLE",
  ]) {
    assert.equal(talentNetworkSubmitted({ matching_pool_status: pool }), false, pool);
  }
  // Having ever applied to some role says nothing about the Talent Network.
  assert.equal(talentNetworkSubmitted({ has_application_submission_ever: true }), false);
});

test("the CRM index defaults to the strict submission predicate", () => {
  const index = buildParaAIStatusIndex([
    { id: "submitted", name: "Submitted Person", talent_network_submitted_at: "2026-07-27T00:00:00.000Z" },
    { id: "off-market", name: "Off Market Person", matching_pool_status: "AUTO_OFF_MARKET", has_application_submission_ever: true },
    { id: "applicant", name: "Applicant Person", has_application_submission_ever: true },
  ]);
  const byName = new Map(index.statuses.map((status) => [status.name, status]));
  assert.equal(byName.get("Submitted Person").status, "added");
  assert.equal(byName.get("Off Market Person").status, "not_added");
  assert.equal(byName.get("Applicant Person").status, "not_added");
  assert.equal(index.addedCount, 1);
});

test("outcome-sequence membership completes review without claiming membership", () => {
  const { memberships } = buildOutcomeMembershipIndex([
    { id: "seq", outcome: "Sent List", leads: [{ cu_id: "hand-enrolled" }] },
  ]);
  const [status] = applyOutcomeMemberships([
    { candidateUserId: "hand-enrolled", status: "not_added", added: false, ambiguous: false, source: "paraform_crm" },
  ], memberships);
  assert.equal(status.status, "not_added");
  assert.equal(status.added, false);
  assert.equal(status.source, "paraform_crm");
  assert.equal(status.outcomeComplete, true);
  assert.equal(status.verifiedOutcome, "Sent List");
});

test("the Candidates pill separates unresolved identities from a confirmed no", () => {
  assert.match(dashboard, /no_match:\s*\{ cls:"muted",\s*label:"No match" \}/);
  assert.match(dashboard, /ambiguous:\s*\{ cls:"muted",\s*label:"Ambiguous" \}/);
  assert.match(dashboard, /row\.paraAIStatus=!hit\s*\n\s*\? "no_match"/);
  // The outcome pass must not write paraAIStatus at all.
  assert.doesNotMatch(dashboard, /row\.paraAIStatus="added"/);
  assert.doesNotMatch(dashboard, /paraAISource="outcome_sequence"/);
});
