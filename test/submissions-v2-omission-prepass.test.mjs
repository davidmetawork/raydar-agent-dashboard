import assert from "node:assert/strict";
import test from "node:test";

import {
  OMISSION_EVIDENCE_KIND,
  exactProducerRoleSource,
  omissionDecisions,
  omissionPrepassMode,
} from "../api/submissions-v2/_lib/omission-prepass.mjs";

const ON = { SUBMISSIONS_V2_OMISSION_PREPASS: "apply" };

const offered = (...ids) => ids.map((role_id) => ({ role_id, company: "Example Inc", title: role_id }));
const yes = (role_id) => ({ role_id, label: "interested", quote: "Please put me forward.", review_reason: null, negative_reason: null });
const no = (role_id) => ({ role_id, label: "not_interested", quote: "Not this one.", review_reason: null, negative_reason: null });
const review = (role_id) => ({ role_id, label: "needs_review", quote: "Maybe.", review_reason: "role_unclear", negative_reason: null });

function gmailEvent(overrides = {}) {
  return {
    schema_version: "submissions.email_reply.v1",
    adapter_version: "gmail-role-interest-v2",
    provider: "gmail",
    provider_message_id: "message-1",
    outbound_message_id: "outbound-1",
    source_evidence: null,
    candidate_authored_text: "Please put me forward.",
    offered_roles: offered("role-a", "role-b", "role-c"),
    ...overrides,
  };
}

test("the pre-pass is off unless the flag is exactly apply", () => {
  assert.equal(omissionPrepassMode({}), "off");
  assert.equal(omissionPrepassMode({ SUBMISSIONS_V2_OMISSION_PREPASS: "" }), "off");
  assert.equal(omissionPrepassMode({ SUBMISSIONS_V2_OMISSION_PREPASS: "off" }), "off");
  assert.equal(omissionPrepassMode({ SUBMISSIONS_V2_OMISSION_PREPASS: "1" }), "off");
  assert.equal(omissionPrepassMode({ SUBMISSIONS_V2_OMISSION_PREPASS: "true" }), "off");
  assert.equal(omissionPrepassMode({ SUBMISSIONS_V2_OMISSION_PREPASS: "Apply" }), "apply");

  const off = omissionDecisions({ event: gmailEvent(), decisions: [yes("role-a")], env: {} });
  assert.deepEqual(off, { mode: "off", skipped: "prepass_off", decisions: [] });
});

test("a fully gated omission closes every offered role the reply left unnamed, without a quote", () => {
  const result = omissionDecisions({ event: gmailEvent(), decisions: [yes("role-a")], env: ON });
  assert.equal(result.skipped, null);
  assert.deepEqual(result.decisions.map((decision) => decision.role_id), ["role-b", "role-c"]);
  for (const decision of result.decisions) {
    assert.equal(decision.label, "not_interested");
    assert.equal(decision.quote, null);
    assert.equal(decision.negative_reason, null);
    assert.equal(decision.review_reason, null);
    assert.equal(decision.evidence_kind, OMISSION_EVIDENCE_KIND);
    assert.equal(decision.evidence.kind, OMISSION_EVIDENCE_KIND);
    assert.equal(decision.evidence.role_source, "outbound_parent_links");
    assert.equal(decision.evidence.offered_role_count, 3);
    assert.match(decision.evidence.offered_role_set_digest, /^[a-f0-9]{64}$/u);
    assert.deepEqual(decision.evidence.named_role_ids, ["role-a"]);
    assert.equal(decision.evidence.provider_message_id, "message-1");
    assert.ok(!("quote" in decision) || decision.quote === null);
  }
});

test("an explicit negative beside the positive still leaves the silent roles to the pre-pass", () => {
  const result = omissionDecisions({ event: gmailEvent(), decisions: [yes("role-a"), no("role-b")], env: ON });
  assert.equal(result.skipped, null);
  assert.deepEqual(result.decisions.map((decision) => decision.role_id), ["role-c"]);
  assert.deepEqual(result.decisions[0].evidence.named_role_ids, ["role-a", "role-b"]);
});

test("every ungated shape is skipped with its exact reason", () => {
  const cases = [
    ["no_interested_decision", gmailEvent(), [no("role-a")]],
    ["reply_has_review_decision", gmailEvent(), [yes("role-a"), review("role-b")]],
    ["every_offered_role_decided", gmailEvent(), [yes("role-a"), no("role-b"), no("role-c")]],
    ["single_offered_role", gmailEvent({ offered_roles: offered("role-a") }), [yes("role-a")]],
    ["decision_outside_offer", gmailEvent(), [yes("role-z")]],
    ["decision_duplicate_role", gmailEvent(), [yes("role-a"), yes("role-a")]],
    ["no_decisions", gmailEvent(), []],
    ["not_email_reply", gmailEvent({ schema_version: "curated.v1" }), [yes("role-a")]],
    ["offered_roles_invalid", gmailEvent({ offered_roles: [{ role_id: "role-a" }, { role_id: "role-a" }] }), [yes("role-a")]],
  ];
  for (const [reason, event, decisions] of cases) {
    assert.deepEqual(omissionDecisions({ event, decisions, env: ON }), { mode: "apply", skipped: reason, decisions: [] }, reason);
  }
});

test("only an exact producer offered list qualifies", () => {
  assert.equal(exactProducerRoleSource(gmailEvent()), "outbound_parent_links");
  assert.equal(exactProducerRoleSource(gmailEvent({ adapter_version: "master-inbox-contract-1", provider: "master_inbox" })), "outbound_contract");
  assert.equal(exactProducerRoleSource(gmailEvent({ source_evidence: { cache_version: 3, exact_role_source: "campaign.role_id" } })), "campaign.role_id");

  // The candidate's own named roles, a saved sourcing mapping, and a send whose
  // offered list was never retained are all rejected.
  assert.equal(exactProducerRoleSource(gmailEvent({
    source_evidence: { resolution_version: "candidate-explicit-role-v1", exact_role_source: "candidate_authored_explicit" },
  })), null);
  assert.equal(exactProducerRoleSource(gmailEvent({ source_evidence: { cache_version: 3, exact_role_source: "sourcing.role_state.mapping" } })), null);
  assert.equal(exactProducerRoleSource(gmailEvent({ outbound_message_id: null })), null);
  assert.equal(exactProducerRoleSource(gmailEvent({ adapter_version: "some-other-adapter" })), null);

  for (const event of [
    gmailEvent({ source_evidence: { resolution_version: "candidate-explicit-role-v1", exact_role_source: "candidate_authored_explicit" } }),
    gmailEvent({ outbound_message_id: null }),
  ]) {
    assert.deepEqual(omissionDecisions({ event, decisions: [yes("role-a")], env: ON }).skipped, "role_source_not_exact_producer");
  }
});

test("quoted or forwarded history means the reply is not the single send we bound the offer from", () => {
  const quoted = [
    "Please put me forward.\n\nOn Tuesday, someone wrote:\n> the other roles",
    "Please put me forward.\n> quoted offer line",
    "Please put me forward.\n\n--- Original Message ---",
    "Please put me forward.\n\nBegin forwarded message:",
    "Please put me forward.\n\nFrom: someone",
  ];
  for (const candidate_authored_text of quoted) {
    assert.equal(
      omissionDecisions({ event: gmailEvent({ candidate_authored_text }), decisions: [yes("role-a")], env: ON }).skipped,
      "reply_contains_quoted_history",
      candidate_authored_text,
    );
  }
});

test("an operator-scoped role selection never triggers the pre-pass", () => {
  assert.deepEqual(
    omissionDecisions({ event: gmailEvent(), decisions: [yes("role-a")], env: ON, operatorScopedRoles: true }),
    { mode: "apply", skipped: "operator_scoped_roles", decisions: [] },
  );
});
