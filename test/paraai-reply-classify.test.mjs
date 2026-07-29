import test from "node:test";
import assert from "node:assert/strict";

import {
  classifyReply,
  enforceQuoteFidelity,
  isMachineReply,
  normalizeSignals,
  stripQuotedReply,
} from "../api/paraai/_lib/reply-classify.mjs";

// The literal extraction layer always runs before the policy layer in
// production, so the fixtures go through it here too: a signal that cannot be
// quoted from the body must never reach classifyReply().
const signalsFor = (raw, body) => enforceQuoteFidelity(normalizeSignals(raw), body);

const pendingRequest = (over = {}) => ({
  id: "req-1",
  state: "PENDING",
  candidateUserId: "cu-1",
  candidateName: "Amy Chen",
  roleName: "Backend Engineer",
  companyName: "Pallet",
  ...over,
});

const message = (headers, over = {}) => ({
  id: "msg-1",
  payload: { headers: headers.map(([name, value]) => ({ name, value })) },
  ...over,
});

const rules = (decision) => decision.provenance.map((row) => row.rule);

test("a conditional yes is a yes and carries the condition to the submission", () => {
  const body = "I'd be interested if it's fully remote.";
  const signals = signalsFor({
    interestStated: { value: "positive", conditional: true, quote: "I'd be interested if it's fully remote" },
    conditions: ["fully remote"],
  }, body);

  const decision = classifyReply(signals, { pendingRequests: [pendingRequest()] });

  assert.equal(decision.intent, "yes");
  assert.equal(decision.confidence, "definitive");
  assert.deepEqual(decision.targetRequestIds, ["req-1"]);
  assert.deepEqual(decision.conditions, ["fully remote"]);
  assert.deepEqual(rules(decision), ["conditional_yes_is_yes", "conditions_ride_along", "sole_pending"]);
  assert.deepEqual(decision.provenance[0], {
    field: "intent",
    stated: "conditional interest",
    routed: "yes",
    rule: "conditional_yes_is_yes",
  });
});

test("a plain enthusiastic yes classifies as yes on the sole pending request", () => {
  const body = "Yes absolutely, I would love to speak with the team.";
  const signals = signalsFor({
    interestStated: { value: "positive", conditional: false, quote: "Yes absolutely, I would love to speak with the team" },
  }, body);

  const decision = classifyReply(signals, { pendingRequests: [pendingRequest()] });

  assert.equal(decision.intent, "yes");
  assert.equal(decision.evidence, "Yes absolutely, I would love to speak with the team");
  assert.deepEqual(decision.targetRequestIds, ["req-1"]);
  assert.deepEqual(rules(decision), ["explicit_yes", "sole_pending"]);
});

test("an explicit decline classifies as no", () => {
  const body = "No thank you, please do not submit me for this one.";
  const signals = signalsFor({
    interestStated: { value: "negative", conditional: false, quote: "No thank you" },
    refusalStated: { value: true, quote: "please do not submit me for this one" },
  }, body);

  const decision = classifyReply(signals, { pendingRequests: [pendingRequest()] });

  assert.equal(decision.intent, "no");
  assert.equal(decision.confidence, "definitive");
  assert.equal(decision.evidence, "please do not submit me for this one");
  assert.deepEqual(decision.targetRequestIds, ["req-1"]);
  assert.deepEqual(rules(decision), ["explicit_refusal", "sole_pending"]);
});

test("an accepted offer with an explicit stop searching classifies as off market", () => {
  const body = "I just accepted an offer, I'm no longer looking. Thanks for thinking of me.";
  const signals = signalsFor({
    interestStated: { value: "negative", conditional: false, quote: "I just accepted an offer" },
    noLongerSearchingStated: { value: true, quote: "I'm no longer looking" },
  }, body);

  const decision = classifyReply(signals, {
    pendingRequests: [pendingRequest(), pendingRequest({ id: "req-2", roleName: "Platform Engineer", companyName: "Reform" })],
  });

  assert.equal(decision.intent, "off_market");
  assert.equal(decision.confidence, "definitive");
  assert.equal(decision.evidence, "I'm no longer looking");
  assert.deepEqual(decision.targetRequestIds, ["req-1", "req-2"]);
  assert.deepEqual(rules(decision), ["explicit_off_market"]);
});

// THE BOUNDARY. Off-market is candidate-level and network-wide, so passing on
// one role must never be read as leaving the market.
test("not interested in this one is a pass and never off market", () => {
  const body = "Thanks but I'm not interested in this one.";
  const signals = signalsFor({
    interestStated: { value: "negative", conditional: false, quote: "I'm not interested in this one" },
    refusalStated: { value: true, quote: "I'm not interested in this one" },
  }, body);

  const decision = classifyReply(signals, { pendingRequests: [pendingRequest()] });

  assert.equal(decision.intent, "no");
  assert.notEqual(decision.intent, "off_market");
  assert.equal(signals.noLongerSearchingStated.value, null);
  assert.deepEqual(rules(decision), ["explicit_refusal", "sole_pending"]);
});

test("a reply with no decision goes to review with the reason recorded", () => {
  const schedulingBody = "Can we move it to Thursday at 3pm instead?";
  const scheduling = classifyReply(
    signalsFor({ schedulingOnly: true }, schedulingBody),
    { pendingRequests: [pendingRequest()] },
  );
  assert.equal(scheduling.intent, "uncertain");
  assert.equal(scheduling.confidence, "none");
  assert.equal(scheduling.reviewReason, "scheduling_only");

  const questionBody = "What is the salary range for this role?";
  const question = classifyReply(
    signalsFor({ questionAsked: { value: true, quote: "What is the salary range for this role?" } }, questionBody),
    { pendingRequests: [pendingRequest()] },
  );
  assert.equal(question.intent, "uncertain");
  assert.equal(question.reviewReason, "candidate_asked_a_question");
  assert.equal(question.evidence, "What is the salary range for this role?");
});

// Submitting to the wrong hiring manager wastes a third party's time, so
// ambiguity across several open requests is the one place the classifier
// refuses to be generous.
test("a yes with several pending requests and no role named goes to review", () => {
  const body = "Yes please, that sounds great.";
  const signals = signalsFor({
    interestStated: { value: "positive", conditional: false, quote: "Yes please, that sounds great" },
  }, body);

  const decision = classifyReply(signals, {
    pendingRequests: [pendingRequest(), pendingRequest({ id: "req-2", roleName: "Platform Engineer", companyName: "Reform" })],
  });

  assert.equal(decision.intent, "uncertain");
  assert.equal(decision.confidence, "ambiguous_target");
  assert.equal(decision.reviewReason, "yes_but_multiple_pending_requests");
  assert.deepEqual(decision.targetRequestIds, ["req-1", "req-2"]);
  assert.deepEqual(rules(decision), ["explicit_yes", "ambiguous_target"]);
});

test("a no with several pending requests and no role named goes to review", () => {
  const body = "I am going to pass, thanks.";
  const signals = signalsFor({
    refusalStated: { value: true, quote: "I am going to pass" },
  }, body);

  const decision = classifyReply(signals, {
    pendingRequests: [pendingRequest(), pendingRequest({ id: "req-2", roleName: "Platform Engineer", companyName: "Reform" })],
  });

  assert.equal(decision.intent, "uncertain");
  assert.equal(decision.reviewReason, "no_but_multiple_pending_requests");
  assert.deepEqual(decision.targetRequestIds, ["req-1", "req-2"]);
  assert.deepEqual(rules(decision), ["explicit_refusal", "ambiguous_target"]);
});

test("a named company among several pending requests targets exactly that request", () => {
  const body = "The Reform role sounds great, happy to meet them.";
  const signals = signalsFor({
    interestStated: { value: "positive", conditional: false, quote: "happy to meet them" },
    rolesReferenced: [{ mention: "Reform", sentiment: "positive", quote: "The Reform role sounds great" }],
  }, body);

  const decision = classifyReply(signals, {
    pendingRequests: [pendingRequest(), pendingRequest({ id: "req-2", roleName: "Platform Engineer", companyName: "Reform" })],
  });

  assert.equal(decision.intent, "yes");
  assert.deepEqual(decision.targetRequestIds, ["req-2"]);
  assert.deepEqual(rules(decision), ["explicit_yes", "named_role"]);
});

test("a signal whose quote is absent from the body is dropped, not trusted", () => {
  const body = "Sounds good, happy to chat.";
  const signals = enforceQuoteFidelity(normalizeSignals({
    interestStated: { value: "positive", conditional: false, quote: "happy to chat" },
    refusalStated: { value: true, quote: "I will pass on this one" },
    rolesReferenced: [
      { mention: "Pallet", sentiment: "positive", quote: "happy to chat" },
      { mention: "Reform", sentiment: "negative", quote: "Reform is not for me" },
    ],
  }), body);

  assert.equal(signals.interestStated.value, "positive");
  assert.equal(signals.refusalStated.value, null);
  assert.equal(signals.refusalStated.quote, null);
  assert.deepEqual(signals.rolesReferenced.map((row) => row.mention), ["Pallet"]);

  const decision = classifyReply(signals, { pendingRequests: [pendingRequest()] });
  assert.equal(decision.intent, "yes");
});

test("stripQuotedReply keeps only what the candidate newly wrote", () => {
  const quoted = [
    "Thanks for reaching out, I am interested.",
    "",
    "On Mon, Jul 27, 2026 at 9:02 AM David Phillips <david@raydar.xyz> wrote:",
    "> We have an interview request for you at Pallet.",
    "> Let me know if you would like an intro.",
  ].join("\n");
  assert.equal(stripQuotedReply(quoted), "Thanks for reaching out, I am interested.");
  assert.doesNotMatch(stripQuotedReply(quoted), /Pallet/);

  const signed = [
    "Yes, keen to chat.",
    "",
    "--",
    "Amy Chen",
    "Senior Engineer, Example Co",
  ].join("\n");
  assert.equal(stripQuotedReply(signed), "Yes, keen to chat.");
});

test("machine mail is recognised by subject, sender and auto-submitted header", () => {
  const outOfOffice = message([
    ["From", "Amy Chen <amy@example.com>"],
    ["Subject", "Out of Office: Re: 1st Round - Interview Request @ Pallet"],
  ]);
  assert.equal(isMachineReply(outOfOffice, "I am away until August 4th."), true);

  const bounce = message([
    ["From", "Mail Delivery Subsystem <mailer-daemon@googlemail.com>"],
    ["Subject", "Delivery Status Notification (Failure)"],
  ]);
  assert.equal(isMachineReply(bounce, "Your message could not be delivered."), true);

  const autoSubmitted = message([
    ["From", "Amy Chen <amy@example.com>"],
    ["Subject", "Re: 1st Round - Interview Request @ Pallet"],
    ["Auto-Submitted", "auto-replied"],
  ]);
  assert.equal(isMachineReply(autoSubmitted, "Thanks for your note, I will reply soon."), true);
});

test("a short human reply is not treated as machine mail", () => {
  const human = message([
    ["From", "Amy Chen <amy@example.com>"],
    ["Subject", "Re: 1st Round - Interview Request @ Pallet"],
  ]);
  assert.equal(isMachineReply(human, "Yes, keen to chat."), false);
});
