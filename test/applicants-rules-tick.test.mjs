import test from "node:test";
import assert from "node:assert/strict";

import { createTickHandler, decideRow } from "../api/applicants/rules-tick.mjs";
import { createRulesHandler } from "../api/applicants/rules.mjs";
import { factsFromProfile } from "../api/applicants/_lib/facts.mjs";
import { isRuleActor, ruleIdFromActor } from "../api/applicants/_lib/decision-record.mjs";
import {
  RULE_INTERVIEW_ALREADY_EMAILED,
  currentApplicantAck,
  ruleInterviewSkipReason,
} from "../api/applicants/_lib/rule-interview-eligibility.mjs";
import {
  APPLICANT_REQUEST_ALREADY_EMAILED,
  saveApplicantRequest,
} from "../api/applicants/_lib/request-safety.mjs";
import { generationFence, publishInto } from "./helpers/applicant-generation.mjs";

const NOW = Date.parse("2026-08-20T12:00:00.000Z");
const SOURCE_PAYLOAD_DIGEST = "a".repeat(64);
// The production receipt shape: a durable Hub projection bound to the exact
// source observation the queue row names. A rule may only consider a row whose
// receipt still matches that observation.
const readyReceipt = (cuId) => ({
  cachedAt: "2026-08-20T11:00:00.000Z",
  source: "applicant_hub",
  durable: true,
  historyState: "data",
  sourceObservationId: `obs-${cuId}`,
  payloadDigest: SOURCE_PAYLOAD_DIGEST,
});

const HARVARD_RULE = {
  id: "rule-harvard", name: "Harvard undergrads", action: "interview", state: "live",
  version: 2, scope: { roleIds: [] },
  conditions: [
    { field: "school.id", op: "any_of", value: ["sch_harvard"] },
    { field: "school.level", op: "any_of", value: ["bachelors"] },
  ],
};
const BLOCK_RULE = {
  id: "rule-block", name: "No staffing agencies", action: "pass", state: "live",
  version: 1, scope: { roleIds: [] },
  conditions: [{ field: "job.title", op: "contains", value: "Recruiter" }],
};
const FUNDED_RULE = {
  id: "rule-funded", name: "Funded employer history", action: "interview", state: "live",
  version: 1, scope: { roleIds: [] },
  conditions: [{
    field: "employment.fundedEmployerSnapshot", op: "member_of", value: "funded-2026-09-05",
  }],
};

const profile = ({ school = "sch_harvard", degree = "Bachelor of Arts - AB", title = "Engineer" } = {}) => ({
  education: [{ schoolId: school, school: "Harvard University", degree, end: "2016-01-01" }],
  experiences: [{ companyId: "co1", companyName: "Acme", roleTitle: title, current: true }],
});

// A published queue row. The revision triple is not decoration: pendingRows
// skips any row without inputRevision, and both writers copy all three into
// the decision so a later reader can prove which revision was decided.
const row = (cuId, extra = {}) => ({
  key: `${cuId}:role1`, cuId, roleId: "role1", tier: "C",
  name: "Applicant", roleTitle: "Engineer", company: "Acme Corp",
  appliedAt: "2026-08-15T00:00:00.000Z", interviewAllowed: true,
  inputRevision: "rev-input-1", readinessRevision: "rev-ready-1", decisionRevision: 0,
  sourceObservationId: `obs-${cuId}`,
  ...extra,
});

/** In-memory KV standing in for the apphub namespace.
 *
 *  The queue is not a free-standing key any more: the tick reads the immutable
 *  ACTIVE PUBLICATION and refuses to run against anything else, so every
 *  fixture publishes a real generation and every request carries its fence. */
function store({ rules = [], pausedAll = false, queue = [], decisions = {}, acks = {}, facts = {}, cards = null, receipts = null, counts = null } = {}) {
  const availableCards = cards ?? Object.fromEntries(Object.keys(facts).map((cuId) => [cuId, {}]));
  const state = {
    "apphub:rules": { rev: 3, pausedAll, rules, updatedAt: null },
    "apphub:decisions": { ...decisions },
    "apphub:acks": { ...acks },
    "apphub:facts": facts,
    "apphub:cards": availableCards,
    "apphub:source-profile-ready": receipts
      ?? Object.fromEntries(Object.keys(availableCards).map((cuId) => [cuId, readyReceipt(cuId)])),
    "apphub:rulestats": {},
    "apphub:ruleruns": {},
    "apphub:schools": { sch_harvard: "Harvard University" },
    "apphub:companies": { co1: "Acme" },
  };
  const generation = publishInto(state, {
    snapshot: { generatedAt: "2026-08-20T11:00:00.000Z", stream: [] },
    queue,
    counts,
  });
  const writes = [];
  return {
    state, writes, generation,
    fence: generationFence(generation),
    deps: {
      corsHandler: () => false,
      authHandler: async (req) => { req.authedEmail = "david@raydar.xyz"; return true; },
      kvReady: () => true,
      readJson: async (key) => state[key] ?? null,
      writeJson: async (key, value) => { state[key] = value; writes.push([key, value]); },
      readHash: async (key) => ({ ...(state[key] ?? {}) }),
      readMany: async (key, fields) => {
        const out = {};
        for (const field of fields) if (state[key]?.[field] != null) out[field] = state[key][field];
        return out;
      },
      writeHash: async (key, fields) => {
        state[key] = { ...(state[key] ?? {}), ...fields };
        writes.push([key, fields]);
      },
      saveRequest: async (key, record) => {
        if (state["apphub:decisions"][key]) return false;
        state["apphub:decisions"][key] = record;
        writes.push(["apphub:decisions", { [key]: record }]);
        return true;
      },
      now: () => NOW,
    },
  };
}

function response() {
  return {
    statusCode: undefined, body: undefined, headers: {},
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
}

// Every browser write names the publication the reviewer saw; without the
// fence the tick answers 409 rather than acting on whatever is in KV now.
const request = (s, over = {}) => ({
  method: "POST", headers: {}, query: {}, body: { ...(s ? s.fence : {}) }, ...over,
});

// ── the happy path ─────────────────────────────────────────────────────────

test("an armed rule writes the same decision record a human click writes", async () => {
  const s = store({
    rules: [HARVARD_RULE],
    queue: [row("cu1")],
    facts: { cu1: factsFromProfile(profile(), { now: NOW }) },
  });
  const res = response();
  await createTickHandler(s.deps)(request(s), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.decided, 1);

  const decision = s.state["apphub:decisions"]["cu1:role1"];
  assert.equal(decision.action, "interview");
  assert.equal(decision.at, "2026-08-20T12:00:00.000Z");
  // The identity that makes this an integration rather than a second pipeline:
  // every field the human click writes (api/applicants/decision.mjs) is present
  // and carries the same value, including the revision fence, the generation
  // stamp and the pending delivery state.
  for (const field of [
    "action", "at", "by", "name", "roleTitle", "actorType", "actorId", "authorizedBy",
    "requestId", "inputRevision", "readinessRevision", "decisionRevision", "status",
    "deliveryState", "generationId", "generationDigest",
  ]) assert.ok(field in decision, `human-path field missing: ${field}`);
  assert.equal(decision.status, "pending");
  assert.equal(decision.deliveryState, "requested");
  assert.equal(decision.inputRevision, "rev-input-1");
  assert.equal(decision.decisionRevision, 0);
  assert.equal(decision.generationId, s.fence.generationId);
  // `by` is the only thing that tells the two writers apart.
  assert.equal(decision.actorType, "rule");
  assert.ok(isRuleActor(decision.by));
  assert.equal(ruleIdFromActor(decision.by), "rule-harvard");
});

test("the audit records the rule, its version and the literal fact", async () => {
  const s = store({
    rules: [HARVARD_RULE],
    queue: [row("cu1")],
    facts: { cu1: factsFromProfile(profile(), { now: NOW }) },
  });
  await createTickHandler(s.deps)(request(s), response());

  const audit = s.state["apphub:ruleruns"]["cu1:role1"];
  assert.equal(audit.ruleId, "rule-harvard");
  assert.equal(audit.ruleVersion, 2);
  assert.equal(audit.action, "interview");
  assert.deepEqual(audit.evidence.map((e) => e.field), ["school.id", "school.level"]);
  assert.equal(audit.evidence[0].matched, "Harvard University");
});

test("draft preview and manual tick share funded membership evaluation over full history", async () => {
  const experiences = Array.from({ length: 16 }, (_, index) => ({
    companyId: index === 15 ? "pf-funded" : `pf-other-${index}`,
    companyName: index === 15 ? "Funded Co" : `Other ${index}`,
    roleTitle: "Engineer",
  }));
  const s = store({
    rules: [FUNDED_RULE],
    queue: [row("cu1")],
    facts: { cu1: factsFromProfile({ experiences, education: [] }, {
      now: NOW,
      sourceObservationId: "obs-cu1",
      sourcePayloadDigest: SOURCE_PAYLOAD_DIGEST,
    }) },
  });
  const snapshots = {
    "funded-2026-09-05": {
      snapshotId: "funded-2026-09-05",
      byParaformId: { "pf-funded": { orgId: "org-funded", name: "Funded Co" } },
    },
  };
  s.deps.readMembershipSnapshots = async () => snapshots;

  const preview = response();
  await createRulesHandler({ ...s.deps, mutationAuthHandler: s.deps.authHandler })(
    request(s, { body: { op: "preview", rule: FUNDED_RULE, ...s.fence } }), preview,
  );
  assert.equal(preview.statusCode, 200);
  assert.equal(preview.body.matched, 1);
  assert.equal(s.state["apphub:decisions"]["cu1:role1"], undefined);

  const tick = response();
  await createTickHandler(s.deps)(request(s), tick);
  assert.equal(tick.statusCode, 200);
  assert.equal(tick.body.decided, 1);
  assert.equal(s.state["apphub:decisions"]["cu1:role1"].action, "interview");
  assert.equal(s.state["apphub:ruleruns"]["cu1:role1"].evidence[0].snapshotId, "funded-2026-09-05");
});

test("funded preview and tick reject stale facts until an exact source-bound replay", async () => {
  const experiences = [{ companyId: "pf-funded", companyName: "Funded Co", roleTitle: "Engineer" }];
  const s = store({
    rules: [FUNDED_RULE],
    queue: [row("cu1")],
    facts: { cu1: factsFromProfile({ experiences, education: [] }, {
      now: NOW,
      sourceObservationId: "obs-cu1",
      sourcePayloadDigest: "b".repeat(64),
    }) },
  });
  s.deps.readMembershipSnapshots = async () => ({
    "funded-2026-09-05": {
      snapshotId: "funded-2026-09-05",
      byParaformId: { "pf-funded": { orgId: "org-funded", name: "Funded Co" } },
    },
  });

  const stalePreview = response();
  await createRulesHandler({ ...s.deps, mutationAuthHandler: s.deps.authHandler })(
    request(s, { body: { op: "preview", rule: FUNDED_RULE, ...s.fence } }), stalePreview,
  );
  assert.equal(stalePreview.body.matched, 0);
  assert.equal(stalePreview.body.skipped.employment_facts_source_mismatch, 1);

  const staleTick = response();
  await createTickHandler(s.deps)(request(s), staleTick);
  assert.equal(staleTick.body.decided, 0);
  assert.equal(staleTick.body.skipped.employment_facts_source_mismatch, 1);
  assert.deepEqual(s.state["apphub:decisions"], {});

  s.state["apphub:facts"].cu1 = factsFromProfile({ experiences, education: [] }, {
    now: NOW,
    sourceObservationId: "obs-cu1",
    sourcePayloadDigest: SOURCE_PAYLOAD_DIGEST,
  });
  const replayPreview = response();
  await createRulesHandler({ ...s.deps, mutationAuthHandler: s.deps.authHandler })(
    request(s, { body: { op: "preview", rule: FUNDED_RULE, ...s.fence } }), replayPreview,
  );
  assert.equal(replayPreview.body.matched, 1);

  const replayTick = response();
  await createTickHandler(s.deps)(request(s), replayTick);
  assert.equal(replayTick.body.decided, 1);
  assert.equal(s.state["apphub:decisions"]["cu1:role1"].action, "interview");
  const evidence = s.state["apphub:ruleruns"]["cu1:role1"].evidence[0];
  assert.equal(evidence.sourceObservationId, "obs-cu1");
  assert.equal(evidence.sourcePayloadDigest, SOURCE_PAYLOAD_DIGEST);
});

test("counters accumulate across ticks", async () => {
  const s = store({
    rules: [HARVARD_RULE],
    queue: [row("cu1"), row("cu2")],
    facts: {
      cu1: factsFromProfile(profile(), { now: NOW }),
      cu2: factsFromProfile(profile(), { now: NOW }),
    },
  });
  await createTickHandler(s.deps)(request(s), response());
  assert.equal(s.state["apphub:rulestats"]["rule-harvard"].fired, 2);

  // Second tick: both are decided now, so nothing new fires and the count holds.
  const res = response();
  await createTickHandler(s.deps)(request(s), res);
  assert.equal(res.body.decided, 0);
  assert.equal(s.state["apphub:rulestats"]["rule-harvard"].fired, 2);
});

// ── the refusals ───────────────────────────────────────────────────────────

test("a tick never overwrites an existing decision", async () => {
  const human = { action: "pass", at: "2026-08-19T00:00:00.000Z", by: "david@raydar.xyz", name: "Applicant", roleTitle: "Engineer" };
  const s = store({
    rules: [HARVARD_RULE],
    queue: [row("cu1")],
    decisions: { "cu1:role1": human },
    facts: { cu1: factsFromProfile(profile(), { now: NOW }) },
  });
  const res = response();
  await createTickHandler(s.deps)(request(s), res);
  assert.equal(res.body.decided, 0);
  assert.deepEqual(s.state["apphub:decisions"]["cu1:role1"], human, "the human's call must stand");
});

test("Rules use the same current-ack requestId semantics as the Applicants UI", () => {
  const sentAck = { status: "invited", requestId: "request-old" };
  assert.equal(currentApplicantAck(null, sentAck), sentAck, "without a decision, the durable ack is send evidence");
  assert.equal(
    ruleInterviewSkipReason(row("cu1"), { ack: sentAck }),
    RULE_INTERVIEW_ALREADY_EMAILED,
    "a historical sent ack does not need a current decision",
  );
  assert.equal(
    currentApplicantAck({ requestId: "request-new" }, sentAck),
    null,
    "an older request's ack cannot mask a newer request",
  );
  assert.equal(
    ruleInterviewSkipReason(row("cu1"), {
      decision: { requestId: "request-new" },
      ack: sentAck,
    }),
    null,
    "the stale ack does not block that newer request",
  );
  assert.equal(
    currentApplicantAck({ requestId: "request-old" }, sentAck),
    sentAck,
    "a matching request keeps its ack",
  );
});

test("Interview preview, Watching counters, and live tick all exclude already-emailed rows", async () => {
  const queue = [
    row("cu-ack"),
    row("cu-emailed", { status: "emailed" }),
    row("cu-booked", { status: "booked" }),
    row("cu-replied", { status: "replied" }),
    row("cu-external", { externalPriorSendAt: "2026-08-19T10:00:00.000Z" }),
    row("cu-external-snake", { external_prior_send_at: "2026-08-19T10:00:00.000Z" }),
    row("cu-eligible"),
  ];
  const facts = Object.fromEntries(queue.map(({ cuId }) => [cuId, factsFromProfile(profile(), { now: NOW })]));
  const acks = { "cu-ack:role1": { status: "sendgrid_delivered" } };

  const previewStore = store({ queue, facts, acks });
  const preview = response();
  await createRulesHandler(rulesDeps(previewStore))({
    method: "POST", headers: {}, query: {},
    body: { ...previewStore.fence, op: "preview", rule: { ...HARVARD_RULE, id: undefined } },
  }, preview);
  assert.equal(preview.statusCode, 200);
  assert.equal(preview.body.matched, 1);
  assert.equal(preview.body.skipped.already_emailed, 6);
  assert.deepEqual(preview.body.samples.map(({ key }) => key), ["cu-eligible:role1"]);

  const watchingStore = store({ rules: [{ ...HARVARD_RULE, state: "watching" }], queue, facts, acks });
  const watching = response();
  await createTickHandler(watchingStore.deps)(request(watchingStore), watching);
  assert.equal(watching.body.wouldFire[HARVARD_RULE.id], 1);
  assert.equal(watching.body.skipped.already_emailed, 6);
  assert.deepEqual(watchingStore.state["apphub:decisions"], {});

  const liveStore = store({ rules: [HARVARD_RULE], queue, facts, acks });
  const live = response();
  await createTickHandler(liveStore.deps)(request(liveStore), live);
  assert.equal(live.body.decided, 1);
  assert.equal(live.body.skipped.already_emailed, 6);
  assert.equal(liveStore.state["apphub:decisions"]["cu-eligible:role1"].action, "interview");
  assert.equal(liveStore.state["apphub:decisions"]["cu-ack:role1"], undefined);
});

test("Pass remains allowed when the row has already-email evidence", async () => {
  const s = store({
    rules: [BLOCK_RULE],
    queue: [row("cu1", { status: "emailed" })],
    acks: { "cu1:role1": { status: "invited" } },
    facts: { cu1: factsFromProfile(profile({ title: "Technical Recruiter" }), { now: NOW }) },
  });
  let options;
  const saveRequest = s.deps.saveRequest;
  s.deps.saveRequest = async (key, record, passedOptions) => {
    options = passedOptions;
    return saveRequest(key, record);
  };
  const res = response();
  await createTickHandler(s.deps)(request(s), res);
  assert.equal(res.body.decided, 1);
  assert.equal(s.state["apphub:decisions"]["cu1:role1"].action, "pass");
  assert.equal(options.rejectSentAck, false, "the atomic sent-ack fence is Interview-only");
});

test("a human click landing mid-tick still wins", async () => {
  const s = store({
    rules: [HARVARD_RULE],
    queue: [row("cu1"), row("cu2")],
    facts: {
      cu1: factsFromProfile(profile(), { now: NOW }),
      cu2: factsFromProfile(profile(), { now: NOW }),
    },
  });
  // Simulate the click landing after the tick's opening read: the human's
  // decision appears in the store, so the last-moment re-read sees it.
  let reads = 0;
  const readHash = s.deps.readHash;
  s.deps.readHash = async (key) => {
    if (key === "apphub:decisions") {
      reads += 1;
      if (reads > 1) {
        s.state["apphub:decisions"]["cu1:role1"] = { action: "pass", at: "2026-08-20T12:00:00.000Z", by: "david@raydar.xyz", name: "Applicant", roleTitle: "Engineer" };
      }
    }
    return readHash(key);
  };
  const res = response();
  await createTickHandler(s.deps)(request(s), res);
  assert.equal(res.body.decided, 1, "only the untouched applicant is decided");
  assert.equal(res.body.concededToHuman, 1);
  assert.equal(s.state["apphub:decisions"]["cu1:role1"].by, "david@raydar.xyz", "the click stands");
  assert.equal(s.state["apphub:decisions"]["cu2:role1"].action, "interview");
  assert.ok(!s.state["apphub:ruleruns"]["cu1:role1"], "no audit row for a conceded key");
});

test("an ack landing after the final re-read is rejected by the atomic Rules write", async () => {
  const s = store({
    rules: [HARVARD_RULE],
    queue: [row("cu1")],
    facts: { cu1: factsFromProfile(profile(), { now: NOW }) },
  });
  s.deps.saveRequest = async (key, _record, options) => {
    assert.equal(options.rejectSentAck, true);
    s.state["apphub:acks"][key] = { status: "invited" };
    return APPLICANT_REQUEST_ALREADY_EMAILED;
  };
  const res = response();
  await createTickHandler(s.deps)(request(s), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.decided, 0);
  assert.equal(res.body.skipped.already_emailed, 1);
  assert.equal(res.body.fired[HARVARD_RULE.id], undefined, "a rejected request is not counted as fired");
  assert.equal(res.body.concededToHuman, undefined, "send evidence is not reported as a human decision race");
  assert.deepEqual(s.state["apphub:decisions"], {});
  assert.equal(s.state["apphub:ruleruns"]["cu1:role1"], undefined);
});

test("an ack landing during evaluation is removed by the final re-read", async () => {
  const s = store({
    rules: [HARVARD_RULE],
    queue: [row("cu1")],
    facts: { cu1: factsFromProfile(profile(), { now: NOW }) },
  });
  let ackReads = 0;
  const readHash = s.deps.readHash;
  s.deps.readHash = async (key) => {
    if (key === "apphub:acks" && ++ackReads === 2) {
      s.state["apphub:acks"]["cu1:role1"] = { status: "invited" };
    }
    return readHash(key);
  };
  let saveCalled = false;
  s.deps.saveRequest = async () => { saveCalled = true; return true; };
  const res = response();
  await createTickHandler(s.deps)(request(s), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.decided, 0);
  assert.equal(res.body.skipped.already_emailed, 1);
  assert.equal(res.body.fired[HARVARD_RULE.id], undefined);
  assert.equal(saveCalled, false, "the candidate is removed before request creation");
});

test("a final ack read failure fails closed before Rules create a request", async () => {
  const s = store({
    rules: [HARVARD_RULE],
    queue: [row("cu1")],
    facts: { cu1: factsFromProfile(profile(), { now: NOW }) },
  });
  let ackReads = 0;
  const readHash = s.deps.readHash;
  s.deps.readHash = async (key) => {
    if (key === "apphub:acks" && ++ackReads === 2) throw new Error("acks unavailable");
    return readHash(key);
  };
  const res = response();
  await createTickHandler(s.deps)(request(s), res);
  assert.equal(res.statusCode, 502);
  assert.equal(res.body.error, "tick_failed");
  assert.match(res.body.detail, /acks unavailable/);
  assert.deepEqual(s.state["apphub:decisions"], {});
});

test("the request CAS exposes an opt-in atomic sent-ack result after idempotent replay", async () => {
  const calls = [];
  const result = await saveApplicantRequest("cu1:role1", {
    action: "interview",
    requestId: "request-new",
  }, {
    rejectSentAck: true,
    kvImpl: async (command) => { calls.push(command); return -1; },
  });
  assert.equal(result, APPLICANT_REQUEST_ALREADY_EMAILED);
  assert.equal(calls[0][2], 2);
  assert.deepEqual(calls[0].slice(3, 5), ["apphub:decisions", "apphub:acks"]);
  assert.equal(calls[0].at(-1), "1", "Rules opt into the ack guard through the final Lua argument");
  const script = calls[0][1];
  assert.ok(
    script.indexOf("if old.requestId==ARGV[3] then return 1 end")
      < script.indexOf("if ARGV[5]=='1' then"),
    "same-request replay remains idempotent before the new rejection check",
  );
  assert.match(script, /ack\.status=='invited' or ack\.status=='sendgrid_delivered'/);

  const manual = await saveApplicantRequest("cu1:role1", {
    action: "interview",
    requestId: "request-manual",
  }, {
    kvImpl: async (command) => {
      assert.equal(command.at(-1), "0", "existing manual callers keep the guard disabled by default");
      return 1;
    },
  });
  assert.equal(manual, true);

  const pass = await saveApplicantRequest("cu1:role1", {
    action: "pass",
    requestId: "request-pass",
  }, {
    rejectSentAck: true,
    kvImpl: async (command) => {
      assert.equal(command.at(-1), "0", "even an opted-in caller cannot apply the ack fence to Pass");
      return 1;
    },
  });
  assert.equal(pass, true);
});

test("the global pause parks the tick", async () => {
  const s = store({
    rules: [HARVARD_RULE], pausedAll: true,
    queue: [row("cu1")],
    facts: { cu1: factsFromProfile(profile(), { now: NOW }) },
  });
  const res = response();
  await createTickHandler(s.deps)(request(s), res);
  assert.equal(res.body.parked, "all_rules_paused");
  assert.equal(res.body.decided, 0);
  assert.deepEqual(s.state["apphub:decisions"], {});
});

test("a latched count-drop tripwire parks the tick", async () => {
  const s = store({
    rules: [HARVARD_RULE],
    queue: [row("cu1")],
    facts: { cu1: factsFromProfile(profile(), { now: NOW }) },
    counts: { updatedAt: "2026-08-20T11:00:00.000Z", alert: { queue: { baseline: 2244, seen: 22 } } },
  });
  const res = response();
  await createTickHandler(s.deps)(request(s), res);
  assert.equal(res.body.parked, "snapshot_counts_alert");
  assert.equal(res.body.decided, 0);
  assert.deepEqual(s.state["apphub:decisions"], {});
});

test("an off rule never fires and a watching rule only counts", async () => {
  const s = store({
    rules: [
      { ...HARVARD_RULE, id: "rule-off", state: "off" },
      { ...HARVARD_RULE, id: "rule-watch", state: "watching" },
    ],
    queue: [row("cu1")],
    facts: { cu1: factsFromProfile(profile(), { now: NOW }) },
  });
  const res = response();
  await createTickHandler(s.deps)(request(s), res);
  assert.equal(res.body.decided, 0);
  assert.deepEqual(s.state["apphub:decisions"], {});
  assert.equal(res.body.wouldFire["rule-watch"], 1);
  assert.equal(res.body.wouldFire["rule-off"], undefined);
});

test("an applicant with no facts is skipped and counted, never decided", async () => {
  const s = store({ rules: [HARVARD_RULE], queue: [row("cu1")], facts: {}, cards: { cu1: {} } });
  const res = response();
  await createTickHandler(s.deps)(request(s), res);
  assert.equal(res.body.decided, 0);
  assert.equal(res.body.skipped.no_facts_yet, 1);
});

test("a rule cannot consider an applicant before its profile card is cached", async () => {
  const s = store({
    rules: [HARVARD_RULE],
    queue: [row("cu1")],
    facts: { cu1: factsFromProfile(profile(), { now: NOW }) },
    cards: {},
  });
  const res = response();
  await createTickHandler(s.deps)(request(s), res);
  // Fail closed on the whole run, not per row: silently skipping the
  // uncacheable applicants would hand the reviewer a smaller queue that looks
  // healthy, which is the failure this fence exists to prevent.
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.error, "generation_unavailable");
  assert.equal(res.body.reason, "profile_receipt_mismatch");
  assert.deepEqual(s.state["apphub:decisions"], {});
});

test("a rule cannot consider an applicant after the full profile receipt expires", async () => {
  const s = store({
    rules: [HARVARD_RULE],
    queue: [row("cu1")],
    facts: { cu1: factsFromProfile(profile(), { now: NOW }) },
    receipts: { cu1: { cachedAt: "2026-08-18T00:00:00.000Z", expiresAt: "2026-08-19T00:00:00.000Z" } },
  });
  const res = response();
  await createTickHandler(s.deps)(request(s), res);
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.reason, "profile_receipt_mismatch");
  assert.deepEqual(s.state["apphub:decisions"], {});
});

test("a rule cannot consider an applicant whose receipt names an older observation", async () => {
  const s = store({
    rules: [HARVARD_RULE],
    queue: [row("cu1")],
    facts: { cu1: factsFromProfile(profile(), { now: NOW }) },
    receipts: {
      cu1: {
        cachedAt: "2026-08-20T11:00:00.000Z",
        source: "applicant_hub",
        durable: true,
        historyState: "data",
        sourceObservationId: "obs-stale",
      },
    },
  });
  const res = response();
  await createTickHandler(s.deps)(request(s), res);
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.reason, "profile_receipt_mismatch");
  assert.deepEqual(s.state["apphub:decisions"], {});
});

test("an Interview rule reports a hard-held applicant without writing a decision", async () => {
  // `interviewAllowed` is a delivery hint, not a gate. The gate is the shared
  // hard-hold code list, and the skip is counted under the hold's own code so
  // the reason is legible in the response.
  const s = store({
    rules: [HARVARD_RULE],
    queue: [row("cu1", { readinessState: "identity_review" })],
    facts: { cu1: factsFromProfile(profile(), { now: NOW }) },
  });
  const res = response();
  await createTickHandler(s.deps)(request(s), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.decided, 0);
  assert.equal(res.body.skipped.identity_review, 1);
  assert.deepEqual(s.state["apphub:decisions"], {});
});

test("an unauthorized caller gets 401 and changes nothing", async () => {
  const s = store({ rules: [HARVARD_RULE], queue: [row("cu1")] });
  s.deps.authHandler = async (_req, res) => { res.status(401).json({ ok: false, error: "auth_required" }); return false; };
  const res = response();
  await createTickHandler(s.deps)(request(s), res);
  assert.equal(res.statusCode, 401);
  assert.equal(s.writes.length, 0);
});

test("GET and machine-style bearer calls cannot execute rules", async () => {
  const s = store({
    rules: [HARVARD_RULE],
    queue: [row("cu1")],
    facts: { cu1: factsFromProfile(profile(), { now: NOW }) },
  });
  const res = response();
  await createTickHandler(s.deps)(request(s, {
    method: "GET",
    headers: { authorization: "Bearer former-machine-key", "x-vercel-cron": "1" },
  }), res);
  assert.equal(res.statusCode, 405);
  assert.equal(s.writes.length, 0);
});

// ── precedence ─────────────────────────────────────────────────────────────

test("a Pass rule beats an Interview rule and the loser is still recorded", async () => {
  const s = store({
    rules: [HARVARD_RULE, BLOCK_RULE],
    queue: [row("cu1")],
    facts: { cu1: factsFromProfile(profile({ title: "Technical Recruiter" }), { now: NOW }) },
  });
  await createTickHandler(s.deps)(request(s), response());

  assert.equal(s.state["apphub:decisions"]["cu1:role1"].action, "pass");
  const audit = s.state["apphub:ruleruns"]["cu1:role1"];
  assert.equal(audit.ruleId, "rule-block");
  assert.deepEqual(audit.alsoMatched, [{ id: "rule-harvard", name: "Harvard undergrads", action: "interview" }]);
});

test("decideRow picks Pass regardless of rule order", () => {
  const subject = { row: row("cu1"), facts: factsFromProfile(profile({ title: "Recruiter" }), { now: NOW }) };
  for (const rules of [[HARVARD_RULE, BLOCK_RULE], [BLOCK_RULE, HARVARD_RULE]]) {
    assert.equal(decideRow(rules, subject, { now: NOW }).action, "pass");
  }
});

test("a rule scoped to another role does not fire", async () => {
  const s = store({
    rules: [{ ...HARVARD_RULE, scope: { roleIds: ["role9"] } }],
    queue: [row("cu1")],
    facts: { cu1: factsFromProfile(profile(), { now: NOW }) },
  });
  const res = response();
  await createTickHandler(s.deps)(request(s), res);
  assert.equal(res.body.decided, 0);
});

// ── the rules endpoint ─────────────────────────────────────────────────────

function rulesDeps(s, email = "david@raydar.xyz") {
  const signedIn = async (req) => {
    req.authedEmail = email;
    req.applicantActor = { type: "human", id: email, email };
    return true;
  };
  return {
    corsHandler: () => false,
    authHandler: signedIn,
    // Writes go through requireApplicantMutation in production — same session,
    // plus a same-origin check no machine caller can satisfy.
    mutationAuthHandler: signedIn,
    kvReady: () => true,
    readJson: s.deps.readJson,
    writeJson: s.deps.writeJson,
    readHash: s.deps.readHash,
    readMany: s.deps.readMany,
    now: () => "2026-08-20T12:00:00.000Z",
    newId: () => "rule-new",
  };
}

test("saving a rule stamps the author, versions it, and bumps the revision", async () => {
  const s = store({ rules: [] });
  const res = response();
  await createRulesHandler(rulesDeps(s))({
    method: "POST", headers: {}, query: {},
    body: { op: "save", rev: 3, rule: { name: "Harvard undergrads", action: "interview", state: "off", conditions: HARVARD_RULE.conditions } },
  }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.rule.id, "rule-new");
  assert.equal(res.body.rule.version, 1);
  assert.equal(res.body.rule.createdBy, "david@raydar.xyz");
  assert.equal(res.body.rev, 4);
});

test("a save against a stale revision is refused rather than clobbering", async () => {
  const s = store({ rules: [] });
  const res = response();
  await createRulesHandler(rulesDeps(s))({
    method: "POST", headers: {}, query: {},
    body: { op: "save", rev: 1, rule: { name: "x", action: "pass", conditions: HARVARD_RULE.conditions } },
  }, res);
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.error, "rules_changed");
});

test("editing an existing rule keeps the previous wording in its history", async () => {
  const s = store({ rules: [{ ...HARVARD_RULE, version: 1, createdAt: "2026-08-01T00:00:00.000Z", createdBy: "sam@raydar.xyz", updatedAt: "2026-08-01T00:00:00.000Z", updatedBy: "sam@raydar.xyz", versions: [] }] });
  const res = response();
  await createRulesHandler(rulesDeps(s))({
    method: "POST", headers: {}, query: {},
    body: {
      op: "save", rev: 3,
      rule: { ...HARVARD_RULE, name: "Ivy undergrads", conditions: [{ field: "school.level", op: "any_of", value: ["bachelors"] }] },
    },
  }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.rule.name, "Ivy undergrads");
  assert.equal(res.body.rule.version, 2);
  assert.equal(res.body.rule.createdBy, "sam@raydar.xyz", "authorship of the original is preserved");
  assert.equal(res.body.rule.versions.length, 1);
  assert.equal(res.body.rule.versions[0].name, "Harvard undergrads");
});

test("preview reports matches and skips without writing anything", async () => {
  const s = store({
    queue: [row("cu1"), row("cu2"), row("cu3")],
    facts: {
      cu1: factsFromProfile(profile(), { now: NOW }),
      cu2: factsFromProfile(profile({ degree: "Master of Business Administration - MBA" }), { now: NOW }),
      // cu3 is the 44%: a real applicant with an empty Paraform record.
      cu3: factsFromProfile({ education: [], experiences: [] }, { now: NOW }),
    },
  });
  const res = response();
  await createRulesHandler(rulesDeps(s))({
    method: "POST", headers: {}, query: {},
    body: { ...s.fence, op: "preview", rule: { name: "Harvard undergrads", action: "interview", conditions: HARVARD_RULE.conditions } },
  }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.pending, 3);
  assert.equal(res.body.matched, 1, "only the Harvard bachelor's");
  assert.equal(res.body.skipped.no_profile_history, 1, "the empty record is reported, not hidden");
  assert.equal(res.body.samples[0].key, "cu1:role1");
  assert.equal(s.writes.length, 0, "preview must never write");
});

test("preview fails closed when acknowledgements cannot be read", async () => {
  const s = store({
    queue: [row("cu1")],
    facts: { cu1: factsFromProfile(profile(), { now: NOW }) },
  });
  const deps = rulesDeps(s);
  const readHash = deps.readHash;
  deps.readHash = async (key) => {
    if (key === "apphub:acks") throw new Error("acks unavailable");
    return readHash(key);
  };
  const res = response();
  await createRulesHandler(deps)({
    method: "POST", headers: {}, query: {},
    body: { ...s.fence, op: "preview", rule: { ...HARVARD_RULE, id: undefined } },
  }, res);
  assert.equal(res.statusCode, 502);
  assert.equal(res.body.error, "rules_unavailable");
  assert.match(res.body.detail, /acks unavailable/);
  assert.equal(s.writes.length, 0);
});

test("preview refuses an invalid draft instead of previewing nonsense", async () => {
  const s = store({ queue: [] });
  const res = response();
  await createRulesHandler(rulesDeps(s))({
    method: "POST", headers: {}, query: {},
    body: { ...s.fence, op: "preview", rule: { name: "x", action: "interview", conditions: [{ field: "school.mascot", op: "contains", value: "crimson" }] } },
  }, res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, "rule_invalid");
});

test("pausing everything is one flag, and it survives a stale revision", async () => {
  const s = store({ rules: [HARVARD_RULE] });
  const res = response();
  await createRulesHandler(rulesDeps(s))({
    method: "POST", headers: {}, query: {},
    body: { op: "pauseAll", rev: 1, paused: true },
  }, res);
  assert.equal(res.statusCode, 200, "the kill switch must never be blocked by a stale rev");
  assert.equal(res.body.pausedAll, true);
});

test("the list omits directories unless asked, and includes them when asked", async () => {
  const s = store({ rules: [HARVARD_RULE] });
  const plain = response();
  await createRulesHandler(rulesDeps(s))(request(s, { method: "GET" }), plain);
  assert.equal(plain.body.directories, undefined);

  const full = response();
  await createRulesHandler(rulesDeps(s))(request(s, { method: "GET", query: { with: "directories" } }), full);
  assert.deepEqual(full.body.directories.schools, { sch_harvard: "Harvard University" });
});

test("deleting a rule that does not exist is a 404, not a silent success", async () => {
  const s = store({ rules: [HARVARD_RULE] });
  const res = response();
  await createRulesHandler(rulesDeps(s))({
    method: "POST", headers: {}, query: {}, body: { op: "delete", rev: 3, id: "rule-nope" },
  }, res);
  assert.equal(res.statusCode, 404);
});
