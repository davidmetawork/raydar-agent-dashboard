import test from "node:test";
import assert from "node:assert/strict";

import {
  findJobForCandidate,
  planReplyAction,
  replyActionEnabled,
  replyConfig,
  replyDetectionEnabled,
  replyHealth,
  replyShadowMode,
  runReplyTick,
} from "../api/paraai/_lib/reply.mjs";

// A fully armed config, so every test names the ONE gate it is closing.
const armed = (over = {}) => ({
  approved: true,
  dryRun: false,
  notBeforeMs: Date.parse("2026-07-28T00:00:00.000Z"),
  submitApproved: true,
  passApproved: true,
  offMarketApproved: true,
  batchSize: 3,
  pollLockSeconds: 45,
  mailbox: "david@raydar.xyz",
  gmailConfigured: true,
  storeConfigured: true,
  ...over,
});

const authority = (config) => ["yes", "no", "off_market"].filter((action) => replyActionEnabled(action, config));

const pendingRequest = (over = {}) => ({
  id: "req-1",
  state: "PENDING",
  candidateUserId: "cu-1",
  candidateName: "Amy Chen",
  roleName: "Backend Engineer",
  companyName: "Pallet",
  ...over,
});

const record = (decision) => ({
  replyId: "cu-1:msg-1",
  candidateUserId: "cu-1",
  decision: { conditions: [], targetRequestIds: ["req-1"], ...decision },
});

const job = { id: "bot-1", candidateUserId: "cu-1" };

// FAIL CLOSED BY ABSENCE. An unset dry-run flag is a dry run, so a machine that
// simply never received the variable cannot start writing.
test("an absent dry run flag means dry run", () => {
  assert.equal(replyConfig({}).dryRun, true);
  assert.equal(replyConfig({ PARAAI_REPLY_DRY_RUN: "" }).dryRun, true);
  assert.equal(replyConfig({ PARAAI_REPLY_DRY_RUN: "true" }).dryRun, true);
  assert.equal(replyConfig({ PARAAI_REPLY_DRY_RUN: "false" }).dryRun, false);
});

test("every gate is closed by default", () => {
  const config = replyConfig({});
  assert.equal(config.approved, false);
  assert.equal(config.submitApproved, false);
  assert.equal(config.passApproved, false);
  assert.equal(config.offMarketApproved, false);
  assert.equal(config.notBeforeMs, null);
  assert.equal(replyDetectionEnabled(config), false);
  assert.deepEqual(authority(config), []);
});

test("the arming pin is read from PARAAI_REPLY_NOT_BEFORE", () => {
  assert.equal(replyConfig({ PARAAI_REPLY_NOT_BEFORE: "2026-07-28T00:00:00.000Z" }).notBeforeMs, 1785196800000);
  assert.equal(replyConfig({ PARAAI_REPLY_NOT_BEFORE: "not a date" }).notBeforeMs, null);
});

test("a fully armed config grants all three write authorities", () => {
  assert.deepEqual(authority(armed()), ["yes", "no", "off_market"]);
});

test("a dry run grants no write authority at all", () => {
  assert.deepEqual(authority(armed({ dryRun: true })), []);
});

test("an unpinned arming date grants no write authority at all", () => {
  assert.deepEqual(authority(armed({ notBeforeMs: null })), []);
});

test("each per action approval gates only its own action", () => {
  assert.deepEqual(authority(armed({ submitApproved: false })), ["no", "off_market"]);
  assert.deepEqual(authority(armed({ passApproved: false, offMarketApproved: false })), ["yes"]);
  assert.deepEqual(authority(armed({ offMarketApproved: false })), ["yes", "no"]);
});

// Off-market is candidate-level and network-wide, and it always passes the
// individual requests first, so it can never outrank the pass gate.
test("off market additionally requires the pass approval", () => {
  assert.deepEqual(authority(armed({ passApproved: false })), ["yes"]);
  assert.equal(replyActionEnabled("off_market", armed({ passApproved: false })), false);
  assert.equal(replyActionEnabled("off_market", armed({ offMarketApproved: false })), false);
});

test("detection needs the master switch, Gmail and the state store together", () => {
  assert.equal(replyDetectionEnabled(armed()), true);
  assert.equal(replyDetectionEnabled(armed({ approved: false })), false);
  assert.equal(replyDetectionEnabled(armed({ gmailConfigured: false })), false);
  assert.equal(replyDetectionEnabled(armed({ storeConfigured: false })), false);
});

test("shadow mode is detection on with the write gates shut", () => {
  assert.equal(replyShadowMode(armed({ dryRun: true })), true);
  assert.equal(replyShadowMode(armed({ submitApproved: false })), true);
  assert.equal(replyShadowMode(armed()), false);
  assert.equal(replyShadowMode(armed({ approved: false })), false);
});

test("a tick with the gates closed does no reading at all", async () => {
  const result = await runReplyTick({ config: armed({ approved: false }) });
  assert.deepEqual(result, { enabled: false, processed: 0, reason: "reply_gates_closed" });
});

test("health reports the write authority alongside the gate state", async () => {
  // An unreachable store must degrade to empty counts, never to a thrown health
  // check: the Para AI tab reads this to show whether the subsystem is armed.
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("no network in tests"); };
  try {
    const health = await replyHealth({ config: armed({ submitApproved: false }) });
    assert.equal(health.detectionEnabled, true);
    assert.equal(health.shadowMode, true);
    assert.deepEqual(health.writeAuthority, { yes: false, no: true, off_market: true });
    assert.deepEqual(health.counts, {});
    assert.equal(health.total, 0);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("a yes with no screening call record goes to review rather than submitting", async () => {
  const plan = await planReplyAction(
    record({ intent: "yes", confidence: "definitive" }),
    { requests: [pendingRequest()], jobs: [], config: armed() },
  );
  assert.deepEqual(plan, {
    action: "review",
    reason: "no_screening_call_record",
    requestIds: ["req-1"],
  });
});

test("a yes with a screening call plans a submit for the targeted request", async () => {
  const plan = await planReplyAction(
    record({ intent: "yes", confidence: "definitive" }),
    {
      requests: [pendingRequest(), pendingRequest({ id: "req-2", candidateUserId: "cu-2" })],
      jobs: [{ id: "bot-9", candidateUserId: "cu-2" }, job],
      config: armed(),
    },
  );
  assert.deepEqual(plan, {
    action: "submit",
    reason: "definitive_yes",
    requestIds: ["req-1"],
    jobId: "bot-1",
  });
});

test("a plan is none when no pending requests remain", async () => {
  const plan = await planReplyAction(
    record({ intent: "yes", confidence: "definitive" }),
    { requests: [pendingRequest({ state: "DISMISSED" })], jobs: [job], config: armed() },
  );
  assert.deepEqual(plan, { action: "none", reason: "no_pending_requests" });
});

test("a yes whose target is no longer pending goes to review", async () => {
  const plan = await planReplyAction(
    record({ intent: "yes", targetRequestIds: ["req-1"] }),
    { requests: [pendingRequest({ id: "req-2" })], jobs: [job], config: armed() },
  );
  assert.deepEqual(plan, {
    action: "review",
    reason: "target_not_pending",
    requestIds: ["req-2"],
  });
});

test("an uncertain decision carries its review reason into the plan", async () => {
  const plan = await planReplyAction(
    record({ intent: "uncertain", reviewReason: "yes_but_multiple_pending_requests", targetRequestIds: ["req-1", "req-2"] }),
    {
      requests: [pendingRequest(), pendingRequest({ id: "req-2" })],
      jobs: [job],
      config: armed(),
    },
  );
  assert.deepEqual(plan, {
    action: "review",
    reason: "yes_but_multiple_pending_requests",
    requestIds: ["req-1", "req-2"],
  });
});

test("a no plans a pass on the named request only", async () => {
  const plan = await planReplyAction(
    record({ intent: "no", targetRequestIds: ["req-2"] }),
    {
      requests: [pendingRequest(), pendingRequest({ id: "req-2" })],
      jobs: [job],
      config: armed(),
    },
  );
  assert.deepEqual(plan, { action: "pass", reason: "not_interested", requestIds: ["req-2"] });
});

test("off market plans against every pending request for the candidate", async () => {
  const plan = await planReplyAction(
    record({ intent: "off_market", targetRequestIds: ["req-1", "req-2"] }),
    {
      requests: [
        pendingRequest(),
        pendingRequest({ id: "req-2" }),
        pendingRequest({ id: "req-3", candidateUserId: "cu-2" }),
      ],
      jobs: [job],
      config: armed(),
    },
  );
  assert.deepEqual(plan, { action: "off_market", reason: "off_market", requestIds: ["req-1", "req-2"] });
});

// REGRESSION (2026-07-28): findJobForCandidate read only the top-level
// job.candidateUserId, but the pipeline stores the resolved id at
// job.identity.candidateUserId. The lookup therefore matched nothing, and every
// definitive yes was filed as no_screening_call_record instead of submitting.
// The first backfill made it visible: 0 of 241 identified jobs matched.
test("the screening job is found by its resolved identity id", () => {
  const jobs = [{ id: "bot_a", identity: { candidateUserId: "cand_1" } }];
  assert.equal(findJobForCandidate(jobs, "cand_1")?.id, "bot_a");
});

test("older job record shapes still resolve through the fallback paths", () => {
  const shapes = [
    { id: "legacy_top", candidateUserId: "cand_2" },
    { id: "legacy_candidate", candidate: { candidateUserId: "cand_2" } },
    { id: "legacy_snake", candidate: { candidate_user_id: "cand_2" } },
    { id: "legacy_submission", submission: { candidateUserId: "cand_2" } },
  ];
  for (const job of shapes) {
    assert.equal(findJobForCandidate([job], "cand_2")?.id, job.id, `failed for ${job.id}`);
  }
});

test("a candidate with no screening job resolves to null rather than a wrong job", () => {
  const jobs = [{ id: "bot_a", identity: { candidateUserId: "cand_1" } }];
  assert.equal(findJobForCandidate(jobs, "cand_other"), null);
});

test("an empty candidate id never matches a job that is missing the field", () => {
  const jobs = [{ id: "bot_blank" }, { id: "bot_a", identity: { candidateUserId: "cand_1" } }];
  assert.equal(findJobForCandidate(jobs, ""), null);
  assert.equal(findJobForCandidate(jobs, null), null);
});

test("a yes whose candidate has an identity-keyed job plans a submit, not a review", async () => {
  const record = {
    candidateUserId: "cand_1",
    decision: { intent: "yes", targetRequestIds: ["req_1"], conditions: [] },
  };
  const requests = [{ id: "req_1", candidateUserId: "cand_1", state: "PENDING", roleName: "FDE", companyName: "Openlayer" }];
  const jobs = [{ id: "bot_a", identity: { candidateUserId: "cand_1" } }];
  const plan = await planReplyAction(record, { requests, jobs, config: {} });
  assert.equal(plan.action, "submit");
  assert.equal(plan.reason, "definitive_yes");
  assert.deepEqual(plan.requestIds, ["req_1"]);
});
