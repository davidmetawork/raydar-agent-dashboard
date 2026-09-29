// Para AI reply auto-pass (David, 2026-09-29): pending interview requests whose
// candidate said no, is off the market, or asked not to be contacted are
// passed on Paraform, proven by read-back, one Slack line each.
import test from "node:test";
import assert from "node:assert/strict";

const {
  candidatesToAssess,
  contactedAfter,
  passCauseFor,
  planReplyPasses,
  replyPassConfig,
  replyPassReason,
  replyPassSlackLine,
  runReplyPassStep,
  REPLY_PASS_LANE,
} = await import("../api/paraai/_lib/outreach-reply-pass.mjs");
const { REQUEST_LANE_RATE_LIMITED_CODE } = await import("../api/paraai/_lib/request-lane-throttle.mjs");

const NOW = Date.parse("2026-09-29T18:00:00.000Z");
const iso = (ms) => new Date(ms).toISOString();
const HOUR = 60 * 60 * 1000;

function request(id, candidateUserId, { status = "pending", roleId = `role-${id}`, company = "Garage", role = "Software Engineer", createdAtMs = NOW - 24 * HOUR, name = "Meesh Z." } = {}) {
  return { id, status, candidateUserId, roleId, roleName: role, companyName: company, candidateName: name, createdAtMs };
}

function offMarketState(candidateUserId, { detectedAt = "2026-09-14T15:54:12.000Z", expiresAt = "2027-03-16T15:54:12.000Z", verdict = "OFF_MARKET", ...extra } = {}) {
  return {
    candidateUserId,
    revision: 1,
    threadId: `thread-${candidateUserId}`,
    offMarket: {
      verdict,
      detectedAt,
      expiresAt: verdict === "OFF_MARKET" ? expiresAt : null,
      reason: 'Candidate explicitly stated "I recently started a new role, so I\'ll pass."',
      source: "model",
    },
    ...extra,
  };
}

// In-memory doubles for every side effect the step has.
function harness({ states = [], history = [], dismissError = null, readBack = "dismissed", claims = new Map() } = {}) {
  const store = new Map(states.map((state) => [state.candidateUserId, structuredClone(state)]));
  const calls = { dismissed: [], released: [], resolved: [], slack: [], alertSlots: new Set(), assessed: [] };
  const deps = {
    getStateImpl: async (id) => structuredClone(store.get(id) || null),
    saveStateImpl: async (state, revision) => {
      const current = store.get(state.candidateUserId);
      if (current && Number(current.revision) !== Number(revision)) throw new Error("revision conflict");
      const next = { ...state, revision: Number(revision || 0) + 1 };
      store.set(state.candidateUserId, next);
      return structuredClone(next);
    },
    lockImpl: async () => "lock",
    unlockImpl: async () => true,
    claimImpl: async (requestId, action, lane) => {
      if (claims.has(requestId)) return { status: "existing", claim: claims.get(requestId) };
      const claim = { action, lane, claimId: `claim-${requestId}`, namespace: "request-claim" };
      claims.set(requestId, claim);
      return { status: "claimed", claim };
    },
    readClaimImpl: async (requestId) => claims.get(requestId) || null,
    releaseClaimImpl: async (requestId, claimId, { lane }) => {
      const claim = claims.get(requestId);
      assert.equal(claim.claimId, claimId);
      assert.equal(lane, REPLY_PASS_LANE);
      claims.delete(requestId);
      calls.released.push(requestId);
      return true;
    },
    dismissImpl: async (id, reason) => {
      calls.dismissed.push({ id, reason });
      if (dismissError) throw dismissError;
      return { ok: true };
    },
    historyImpl: async () => history.map((row) => (
      calls.dismissed.some((call) => call.id === row.id) ? { ...row, status: readBack } : row
    )),
    resolveExceptionImpl: async (requestId, { resolution }) => {
      calls.resolved.push({ requestId, resolution });
      return { status: "resolved" };
    },
    notifyImpl: async (text) => { calls.slack.push(text); return true; },
    alertSlotImpl: async (key) => {
      if (calls.alertSlots.has(key)) return false;
      calls.alertSlots.add(key);
      return true;
    },
    assessImpl: async ({ state }) => { calls.assessed.push(state.candidateUserId); return { checked: false }; },
    assessmentPatchImpl: () => ({ patch: {}, event: null }),
  };
  return { store, calls, claims, deps };
}

const config = { mailbox: "david@raydar.xyz" };
const passConfig = (overrides = {}) => ({ ...replyPassConfig({}), ...overrides });

test("a held off-market request is passed with the neutral reason, proven, recorded, and announced once", async () => {
  const held = request("req-garage", "cu-meesh");
  const other = request("req-other", "cu-open", { name: "Open Candidate" });
  const history = [held, other, request("req-done", "cu-meesh", { status: "dismissed" })];
  const { store, calls, deps } = harness({
    states: [offMarketState("cu-meesh"), { candidateUserId: "cu-open", revision: 1, threadId: "t-open" }],
    history,
  });
  const result = await runReplyPassStep({ history, states: [...store.values()], config, now: NOW, passConfig: passConfig(), ...deps });
  assert.deepEqual(calls.dismissed, [{ id: "req-garage", reason: "Candidate is no longer looking for a new role." }]);
  assert.deepEqual(result.passed, [{ requestId: "req-garage", cause: "off_market", status: "dismissed" }]);
  assert.deepEqual(calls.resolved, [{ requestId: "req-garage", resolution: "passed_on_paraform:off_market" }]);
  const state = store.get("cu-meesh");
  assert.equal(state.passedRequests["req-garage"].cause, "off_market");
  assert.equal(state.journal.at(-1).event, "request_passed_on_paraform");
  assert.equal(calls.slack.length, 1);
  assert.equal(
    calls.slack[0],
    "✋ Para AI: passed Software Engineer @ Garage for Meesh Z. on Paraform, because they said they are off the market (our hold runs to 2027-03-16).",
  );
  assert.doesNotMatch(calls.slack[0], /new role, so I'll pass/, "Slack never carries the candidate's words");
  // Passed once: the next run finds it recorded (and Paraform no longer pending).
  const again = await runReplyPassStep({ history, states: [...store.values()], config, now: NOW, passConfig: passConfig(), ...deps });
  assert.equal(calls.dismissed.length, 1);
  assert.deepEqual(again.passed, []);
});

test("a role the candidate declined is passed; their other pending role is left alone", async () => {
  const declined = request("req-toku", "cu-d", { company: "Toku", roleId: "role-toku" });
  const wanted = request("req-roger", "cu-d", { company: "Roger Healthcare", roleId: "role-roger" });
  const state = {
    candidateUserId: "cu-d",
    revision: 1,
    threadId: "t-d",
    declinedRoles: { "role-toku": { roleId: "role-toku", declinedAt: iso(NOW - 2 * HOUR), source: "model" } },
    matches: { "req-toku": { sentAt: iso(NOW - 20 * HOUR) }, "req-roger": { sentAt: iso(NOW - 20 * HOUR) } },
  };
  const history = [declined, wanted];
  const { calls, deps } = harness({ states: [state], history });
  const result = await runReplyPassStep({ history, states: [state], config, now: NOW, passConfig: passConfig(), ...deps });
  assert.deepEqual(calls.dismissed, [{ id: "req-toku", reason: "Candidate is not interested in this role." }]);
  assert.deepEqual(result.passed.map((row) => row.requestId), ["req-toku"]);
  assert.match(calls.slack[0], /passed Software Engineer @ Toku .* because they said no to this role\.$/);
});

test("the conversation is re-read with the live assessor, and what it latches is what gets passed", async () => {
  const pending = request("req-new", "cu-r", { company: "Beta" });
  const state = { candidateUserId: "cu-r", revision: 1, mailroomConversation: { startedAt: iso(NOW - 30 * HOUR) }, matches: { "req-new": { sentAt: iso(NOW - 30 * HOUR) } } };
  const history = [pending];
  const { store, calls, deps } = harness({ states: [state], history });
  const seen = [];
  deps.assessImpl = async ({ state: read, config: cfg, history: hist }) => {
    seen.push({ id: read.candidateUserId, mailbox: cfg.mailbox, rows: hist.length });
    return { checked: true, replied: true, verdict: "OFF_MARKET", intent: { source: "model" } };
  };
  deps.assessmentPatchImpl = (assessment, options) => {
    assert.equal(options.requestId, null);
    return {
      patch: { repliedAt: iso(NOW - HOUR), offMarket: { verdict: "OFF_MARKET", detectedAt: iso(NOW - HOUR), expiresAt: iso(NOW + 180 * 24 * HOUR) } },
      event: "match_blocked_off_market",
    };
  };
  const result = await runReplyPassStep({ history, states: [state], config, now: NOW, passConfig: passConfig(), ...deps });
  assert.deepEqual(seen, [{ id: "cu-r", mailbox: "david@raydar.xyz", rows: 1 }]);
  assert.equal(result.assessed, 1);
  assert.deepEqual(calls.dismissed.map((call) => call.id), ["req-new"]);
  const saved = store.get("cu-r");
  assert.equal(saved.replyPassCheckedAt, iso(NOW));
  assert.ok(saved.journal.some((entry) => entry.event === "match_blocked_off_market" && entry.source === REPLY_PASS_LANE));
});

test("conversations are re-read at most once per recheck interval, least recently read first", () => {
  const history = [request("a1", "cu-a"), request("b1", "cu-b"), request("c1", "cu-c"), request("d1", "cu-d", { status: "submitted" })];
  const states = [
    { candidateUserId: "cu-a", threadId: "t-a", replyPassCheckedAt: iso(NOW - 10 * 60_000) },
    { candidateUserId: "cu-b", threadId: "t-b", replyPassCheckedAt: iso(NOW - 45 * 60_000) },
    { candidateUserId: "cu-c", mailroomConversation: { startedAt: iso(NOW - HOUR) } },
    { candidateUserId: "cu-d", threadId: "t-d" },
    { candidateUserId: "cu-e" },
  ];
  const picked = candidatesToAssess({ history, states, now: NOW, recheckMs: 30 * 60_000, limit: 5 });
  assert.deepEqual(picked.map((state) => state.candidateUserId), ["cu-c", "cu-b"]);
  assert.deepEqual(
    candidatesToAssess({ history, states, now: NOW, recheckMs: 30 * 60_000, limit: 1 }).map((state) => state.candidateUserId),
    ["cu-c"],
  );
});

test("never passes over David: a send-anyway after the statement, a send in flight, a lapsed or cleared hold", () => {
  const req = request("req-x", "cu-x");
  const base = offMarketState("cu-x");
  assert.equal(passCauseFor(base, req, NOW).cause, "off_market");
  // Sent anyway after the candidate's statement.
  const overridden = { ...base, outbox: { "match:req-x": { status: "delivered", claimedAt: "2026-09-20T10:00:00.000Z" } } };
  assert.equal(passCauseFor(overridden, req, NOW), null);
  assert.equal(contactedAfter({ matches: { "req-x": { sentAt: "2026-09-20T10:00:00.000Z" } } }, "req-x", base.offMarket.detectedAt), true);
  // An email sent BEFORE the statement does not protect the request.
  assert.equal(passCauseFor({ ...base, matches: { "req-x": { sentAt: "2026-09-13T10:00:00.000Z" } } }, req, NOW).cause, "off_market");
  // A released claim never went out.
  assert.equal(passCauseFor({ ...base, outbox: { "match:req-x": { status: "released", claimedAt: "2026-09-20T10:00:00.000Z" } } }, req, NOW).cause, "off_market");
  // A send still settling waits.
  assert.equal(passCauseFor({ ...base, outbox: { "match:req-x": { status: "queued", claimedAt: "2026-09-01T10:00:00.000Z" } } }, req, NOW), null);
  // Six months later the hold has lapsed; a cleared hold never counts.
  assert.equal(passCauseFor(offMarketState("cu-x", { expiresAt: "2026-09-01T00:00:00.000Z" }), req, NOW), null);
  assert.equal(passCauseFor({ ...base, offMarket: { ...base.offMarket, clearedAt: iso(NOW) } }, req, NOW), null);
  // Do-not-contact never lapses.
  assert.equal(passCauseFor(offMarketState("cu-x", { verdict: "DO_NOT_CONTACT" }), req, NOW).cause, "do_not_contact");
  // Already passed by us.
  assert.equal(passCauseFor({ ...base, passedRequests: { "req-x": { cause: "off_market" } } }, req, NOW), null);
  // An open candidate has nothing to pass.
  assert.equal(passCauseFor({ candidateUserId: "cu-x", intentVerdict: "OPEN" }, req, NOW), null);
});

test("only pending requests are planned, oldest first", () => {
  const history = [
    request("late", "cu-p", { createdAtMs: NOW - HOUR }),
    request("early", "cu-p", { createdAtMs: NOW - 5 * HOUR }),
    request("closed", "cu-p", { status: "expired", createdAtMs: NOW - 9 * HOUR }),
    request("elsewhere", "cu-q"),
  ];
  const plans = planReplyPasses({ history, states: [offMarketState("cu-p")], now: NOW });
  assert.deepEqual(plans.map((plan) => plan.request.id), ["early", "late"]);
});

test("a throttle refusal gives the claim back and stops the batch without a word", async () => {
  const history = [request("r1", "cu-t"), request("r2", "cu-t", { createdAtMs: NOW })];
  const error = new Error("pace");
  error.code = REQUEST_LANE_RATE_LIMITED_CODE;
  const { calls, claims, deps } = harness({ states: [offMarketState("cu-t")], history, dismissError: error });
  const result = await runReplyPassStep({ history, states: [offMarketState("cu-t")], config, now: NOW, passConfig: passConfig(), ...deps });
  assert.equal(result.stopped, REQUEST_LANE_RATE_LIMITED_CODE);
  assert.deepEqual(calls.dismissed.map((call) => call.id), ["r1"]);
  assert.deepEqual(calls.released, ["r1"]);
  assert.equal(claims.size, 0);
  assert.deepEqual(result.passed, []);
  assert.equal(calls.slack.length, 0);
});

test("an unconfirmed pass keeps its claim, is flagged once, and is never retried or allowed to block the next one", async () => {
  const stuck = request("r-stuck", "cu-s", { createdAtMs: NOW - 9 * HOUR });
  const history = [stuck];
  const surprise = new Error("socket hang up");
  const first = harness({ states: [offMarketState("cu-s")], history, dismissError: surprise, readBack: "pending" });
  const run1 = await runReplyPassStep({ history, states: [offMarketState("cu-s")], config, now: NOW, passConfig: passConfig(), ...first.deps });
  assert.deepEqual(run1.passed, []);
  assert.equal(run1.unverified[0].requestId, "r-stuck");
  assert.equal(first.claims.get("r-stuck").lane, REPLY_PASS_LANE);
  assert.equal(first.calls.slack.length, 1);
  assert.match(first.calls.slack[0], /could not confirm it went through\. It will not be retried/);
  // Next tick: still pending on Paraform, our claim is there. No second
  // dismiss, no second alert, and a newer request behind it still gets passed.
  const next = request("r-next", "cu-n", { createdAtMs: NOW - HOUR, company: "Beta" });
  const history2 = [stuck, next];
  const states2 = [offMarketState("cu-s"), offMarketState("cu-n")];
  first.deps.dismissImpl = async (id, reason) => { first.calls.dismissed.push({ id, reason }); return { ok: true }; };
  first.deps.historyImpl = async () => history2.map((row) => (row.id === "r-next" ? { ...row, status: "dismissed" } : row));
  const run2 = await runReplyPassStep({ history: history2, states: states2, config, now: NOW + 5 * 60_000, passConfig: passConfig({ passLimit: 1 }), ...first.deps });
  assert.deepEqual(first.calls.dismissed.map((call) => call.id), ["r-stuck", "r-next"]);
  assert.deepEqual(run2.passed.map((row) => row.requestId), ["r-next"]);
  assert.deepEqual(run2.unverified, [{ requestId: "r-stuck", earlier: true }]);
  assert.equal(first.calls.slack.filter((line) => /could not confirm/.test(line)).length, 1);
});

test("a request another lane already claimed (expired actioning, the Submissions tab) is left to it", async () => {
  const history = [request("r-c", "cu-c")];
  const claims = new Map([["r-c", { lane: "submissions", action: "submit", claimId: "x" }]]);
  const { calls, deps } = harness({ states: [offMarketState("cu-c")], history, claims });
  const result = await runReplyPassStep({ history, states: [offMarketState("cu-c")], config, now: NOW, passConfig: passConfig(), ...deps });
  assert.equal(calls.dismissed.length, 0);
  assert.deepEqual(result.skipped, [{ requestId: "r-c", reason: "claimed_by_submissions" }]);
});

test("the per-tick cap counts Paraform attempts", async () => {
  const history = ["a", "b", "c", "d"].map((id, i) => request(id, "cu-cap", { createdAtMs: NOW - (10 - i) * HOUR }));
  const { calls, deps } = harness({ states: [offMarketState("cu-cap")], history });
  const result = await runReplyPassStep({ history, states: [offMarketState("cu-cap")], config, now: NOW, passConfig: passConfig({ passLimit: 3 }), ...deps });
  assert.deepEqual(calls.dismissed.map((call) => call.id), ["a", "b", "c"]);
  assert.equal(result.passed.length, 3);
});

test("PARAAI_REPLY_PASS=off stops the lane; the defaults are on", async () => {
  assert.equal(replyPassConfig({}).enabled, true);
  assert.equal(replyPassConfig({ PARAAI_REPLY_PASS: "OFF" }).enabled, false);
  assert.equal(replyPassConfig({ PARAAI_REPLY_PASS_RECHECK_MINUTES: "2" }).recheckMs, 5 * 60_000, "never faster than 5 minutes");
  const history = [request("r-off", "cu-off")];
  const { calls, deps } = harness({ states: [offMarketState("cu-off")], history });
  const result = await runReplyPassStep({ history, states: [offMarketState("cu-off")], config, now: NOW, passConfig: replyPassConfig({ PARAAI_REPLY_PASS: "off" }), ...deps });
  assert.equal(result.enabled, false);
  assert.equal(calls.dismissed.length + calls.assessed.length, 0);
});

test("copy: the hiring manager sees a neutral reason, David sees why", () => {
  assert.equal(replyPassReason("off_market"), "Candidate is no longer looking for a new role.");
  assert.equal(replyPassReason("declined"), "Candidate is not interested in this role.");
  assert.equal(replyPassReason("do_not_contact"), "Candidate is not interested in this role.");
  assert.match(
    replyPassSlackLine({ request: request("r", "c", { name: "" }), cause: "do_not_contact" }),
    /for a candidate on Paraform, because they asked us not to contact them\.$/,
  );
});
