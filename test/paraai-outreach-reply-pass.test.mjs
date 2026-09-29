// Para AI reply auto-pass (David, 2026-09-29): pending interview requests whose
// candidate said no, is off the market, or asked not to be contacted are
// passed on Paraform. A pass is attempted on one tick and confirmed from the
// next tick's history read; one Slack line each.
import test from "node:test";
import assert from "node:assert/strict";

const {
  candidatesToAssess,
  changedFields,
  contactedAfter,
  passCauseFor,
  planReplyPasses,
  replyPassConfig,
  replyPassReason,
  replyPassSlackLine,
  runReplyPassStep,
  sendInFlight,
  REPLY_PASS_LANE,
} = await import("../api/paraai/_lib/outreach-reply-pass.mjs");
const { REQUEST_LANE_RATE_LIMITED_CODE } = await import("../api/paraai/_lib/request-lane-throttle.mjs");

const NOW = Date.parse("2026-09-29T18:00:00.000Z");
const iso = (ms) => new Date(ms).toISOString();
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function request(id, candidateUserId, { status = "pending", roleId = `role-${id}`, company = "Garage", role = "Software Engineer", createdAtMs = NOW - DAY, name = "Meesh Z." } = {}) {
  return { id, status, candidateUserId, roleId, roleName: role, companyName: company, candidateName: name, createdAtMs };
}

function heldState(candidateUserId, { detectedAt = "2026-09-14T15:54:12.000Z", expiresAt = "2027-03-16T15:54:12.000Z", verdict = "OFF_MARKET", source = "model", ...extra } = {}) {
  return {
    candidateUserId,
    revision: 1,
    threadId: `thread-${candidateUserId}`,
    // Read recently, so a step does not re-assess unless a test says so.
    replyPassCheckedAt: iso(NOW - 60_000),
    offMarket: {
      verdict,
      detectedAt,
      expiresAt: verdict === "OFF_MARKET" ? expiresAt : null,
      reason: 'Candidate explicitly stated "I recently started a new role, so I\'ll pass."',
      source,
    },
    ...extra,
  };
}

// In-memory doubles for every side effect the step has.
function harness({ states = [], dismissError = null, claims = new Map(), saveFailsFor = null } = {}) {
  const store = new Map(states.map((state) => [state.candidateUserId, structuredClone(state)]));
  const calls = { dismissed: [], released: [], resolved: [], slack: [], alertSlots: new Set(), assessed: [], locks: [] };
  let clockMs = 0;
  const deps = {
    clock: () => clockMs,
    getStateImpl: async (id) => structuredClone(store.get(id) || null),
    saveStateImpl: async (state, revision) => {
      if (saveFailsFor && saveFailsFor(state)) throw new Error("kv down");
      const current = store.get(state.candidateUserId);
      if (current && Number(current.revision) !== Number(revision)) throw new Error("revision conflict");
      const next = { ...structuredClone(state), revision: Number(revision || 0) + 1 };
      store.set(state.candidateUserId, next);
      return structuredClone(next);
    },
    lockImpl: async (id) => { calls.locks.push(id); return "lock"; },
    unlockImpl: async () => true,
    claimImpl: async (requestId, action, lane) => {
      if (claims.has(requestId)) return { status: "existing", claim: claims.get(requestId) };
      const claim = { action, lane, claimId: `claim-${requestId}`, namespace: "request-claim" };
      claims.set(requestId, claim);
      return { status: "claimed", claim };
    },
    readClaimImpl: async (requestId) => claims.get(requestId) || null,
    releaseClaimImpl: async (requestId, claimId, { lane }) => {
      assert.equal(claims.get(requestId)?.claimId, claimId);
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
    resolveExceptionImpl: async (requestId, { resolution }) => {
      calls.resolved.push({ requestId, resolution });
      return { status: "resolved" };
    },
    gmailBackoffImpl: async () => null,
    notifyImpl: async (text) => { calls.slack.push(text); return true; },
    alertSlotImpl: async (key) => {
      if (calls.alertSlots.has(key)) return false;
      calls.alertSlots.add(key);
      return true;
    },
    assessImpl: async ({ state }) => { calls.assessed.push(state.candidateUserId); return { checked: false }; },
    assessmentPatchImpl: () => ({ patch: {}, event: null }),
  };
  const run = (history, extra = {}) => runReplyPassStep({
    history,
    states: [...store.values()].map((state) => structuredClone(state)),
    config: { mailbox: "david@raydar.xyz" },
    now: NOW,
    passConfig: replyPassConfig({}),
    ...deps,
    ...extra,
  });
  return { store, calls, claims, deps, run, advanceClock: (ms) => { clockMs += ms; } };
}

const dismissedIn = (history, ids) => history.map((row) => (ids.includes(row.id) ? { ...row, status: "dismissed" } : row));

test("a held off-market request is passed with the neutral reason, confirmed on the next tick, and announced once", async () => {
  const held = request("req-garage", "cu-meesh");
  const other = request("req-other", "cu-open", { name: "Open Candidate" });
  const history = [held, other];
  const h = harness({ states: [heldState("cu-meesh"), { candidateUserId: "cu-open", revision: 1, threadId: "t-open" }] });
  const first = await h.run(history);
  assert.deepEqual(h.calls.dismissed, [{ id: "req-garage", reason: "Candidate is no longer looking for a new role." }]);
  assert.deepEqual(first.attempted, [{ requestId: "req-garage", cause: "off_market" }]);
  assert.equal(h.store.get("cu-meesh").pendingPasses["req-garage"].claimId, "claim-req-garage");
  assert.equal(h.calls.slack.length, 0, "nothing is announced until Paraform shows it");

  const second = await h.run(dismissedIn(history, ["req-garage"]));
  assert.deepEqual(second.confirmed, [{ requestId: "req-garage", cause: "off_market" }]);
  assert.equal(h.calls.dismissed.length, 1, "confirmation costs no Paraform call");
  const state = h.store.get("cu-meesh");
  assert.equal(state.pendingPasses["req-garage"], undefined);
  assert.equal(state.passedRequests["req-garage"].cause, "off_market");
  assert.equal(state.journal.at(-1).event, "request_passed_on_paraform");
  assert.deepEqual(h.calls.resolved, [{ requestId: "req-garage", resolution: "passed_on_paraform:off_market" }]);
  assert.deepEqual(h.calls.slack, [
    "✋ Para AI: passed Software Engineer @ Garage for Meesh Z. on Paraform, because they said they are off the market (our hold runs to 2027-03-16).",
  ]);
  assert.doesNotMatch(h.calls.slack[0], /new role, so I'll pass/, "Slack never carries the candidate's words");

  const third = await h.run(dismissedIn(history, ["req-garage"]));
  assert.deepEqual(third.confirmed, []);
  assert.equal(h.calls.slack.length, 1);
});

test("a verdict the model did not give never passes anything (phrase shortcut, model-down fallback)", async () => {
  const history = [request("r-p", "cu-p")];
  for (const source of ["phrase", "phrase_fallback", "empty"]) {
    const h = harness({ states: [heldState("cu-p", { verdict: "DO_NOT_CONTACT", source })] });
    const result = await h.run(history);
    assert.deepEqual(result.attempted, [], source);
    assert.equal(h.calls.dismissed.length, 0, source);
  }
  assert.equal(passCauseFor(heldState("cu-p", { verdict: "DO_NOT_CONTACT" }), history[0], NOW).cause, "do_not_contact");
});

test("a role the candidate recently declined is passed; their other pending role is left alone", async () => {
  const declined = request("req-toku", "cu-d", { company: "Toku", roleId: "role-toku" });
  const wanted = request("req-roger", "cu-d", { company: "Roger Healthcare", roleId: "role-roger" });
  const state = {
    candidateUserId: "cu-d",
    revision: 1,
    threadId: "t-d",
    replyPassCheckedAt: iso(NOW - 60_000),
    declinedRoles: { "role-toku": { roleId: "role-toku", declinedAt: iso(NOW - 2 * HOUR), source: "model" } },
    matches: { "req-toku": { sentAt: iso(NOW - 20 * HOUR) }, "req-roger": { sentAt: iso(NOW - 20 * HOUR) } },
  };
  const history = [declined, wanted];
  const h = harness({ states: [state] });
  await h.run(history);
  assert.deepEqual(h.calls.dismissed, [{ id: "req-toku", reason: "Candidate is not interested in this role." }]);
  await h.run(dismissedIn(history, ["req-toku"]));
  assert.match(h.calls.slack[0], /passed Software Engineer @ Toku .* because they said no to this role\.$/);
});

test("an old decline is not the answer to a request that came much later", () => {
  const state = { declinedRoles: { "role-x": { roleId: "role-x", declinedAt: iso(NOW - 45 * DAY), source: "model" } } };
  assert.equal(passCauseFor(state, request("late", "c", { roleId: "role-x", createdAtMs: NOW - DAY }), NOW), null);
  assert.equal(passCauseFor(state, request("near", "c", { roleId: "role-x", createdAtMs: NOW - 20 * DAY }), NOW).cause, "declined");
  const notModel = { declinedRoles: { "role-x": { roleId: "role-x", declinedAt: iso(NOW - HOUR), source: "manual" } } };
  assert.equal(passCauseFor(notModel, request("any", "c", { roleId: "role-x" }), NOW), null);
});

test("the conversation is re-read with the live assessor, and what it latches is what gets passed", async () => {
  const pending = request("req-new", "cu-r", { company: "Beta" });
  const state = { candidateUserId: "cu-r", revision: 1, mailroomConversation: { startedAt: iso(NOW - 30 * HOUR) }, matches: { "req-new": { sentAt: iso(NOW - 30 * HOUR) } } };
  const h = harness({ states: [state] });
  const seen = [];
  h.deps.assessImpl = async ({ state: read, config: cfg, history: hist }) => {
    seen.push({ id: read.candidateUserId, mailbox: cfg.mailbox, rows: hist.length });
    return { checked: true, replied: true, verdict: "OFF_MARKET", intent: { source: "model" } };
  };
  h.deps.assessmentPatchImpl = (assessment, options) => {
    assert.equal(options.requestId, null);
    return {
      patch: { repliedAt: iso(NOW - HOUR), offMarket: { verdict: "OFF_MARKET", detectedAt: iso(NOW - HOUR), expiresAt: iso(NOW + 180 * DAY), source: "model" } },
      event: "match_blocked_off_market",
    };
  };
  const result = await h.run([pending]);
  assert.deepEqual(seen, [{ id: "cu-r", mailbox: "david@raydar.xyz", rows: 1 }]);
  assert.equal(result.assessed, 1);
  assert.deepEqual(h.calls.dismissed.map((call) => call.id), ["req-new"]);
  const saved = h.store.get("cu-r");
  assert.equal(saved.replyPassCheckedAt, iso(NOW));
  assert.ok(saved.journal.some((entry) => entry.event === "match_blocked_off_market" && entry.source === REPLY_PASS_LANE));
});

test("re-reading an unchanged conversation writes only the check time, never a journal entry", async () => {
  const state = heldState("cu-j", { replyPassCheckedAt: iso(NOW - 2 * HOUR), repliedAt: iso(NOW - 10 * DAY), stoppedReason: "candidate_replied", followup: null, intentCheckedThrough: 5, intentVerdict: "OFF_MARKET", journal: [] });
  const h = harness({ states: [state] });
  h.deps.assessImpl = async () => ({ checked: true, replied: true, verdict: "OFF_MARKET", cached: true });
  // assessmentPatch re-states everything, including a hold with requestId null.
  h.deps.assessmentPatchImpl = (assessment, { repliedAt, stoppedReason }) => ({
    patch: {
      repliedAt,
      stoppedReason,
      followup: null,
      intentCheckedThrough: 5,
      intentVerdict: "OFF_MARKET",
      offMarket: { ...state.offMarket, requestId: null },
    },
    event: "match_blocked_off_market",
  });
  // Nothing pending to pass here, only a request that was already claimed.
  const claims = h.claims;
  claims.set("r-j", { lane: "submissions", claimId: "x" });
  await h.run([request("r-j", "cu-j")]);
  const saved = h.store.get("cu-j");
  assert.equal(saved.replyPassCheckedAt, iso(NOW));
  assert.deepEqual(saved.journal, [], "no churn in the 200-entry journal");
  assert.equal(saved.offMarket.requestId, undefined, "the original hold is kept as it was");
  assert.deepEqual(changedFields({ bounce: { at: "a", detectedAt: "1" } }, { bounce: { at: "a", detectedAt: "2" } }), {});
  assert.deepEqual(changedFields({ repliedAt: null }, { repliedAt: "x" }), { repliedAt: "x" });
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
  assert.deepEqual(
    candidatesToAssess({ history, states, now: NOW, recheckMs: 30 * 60_000, limit: 5 }).map((state) => state.candidateUserId),
    ["cu-c", "cu-b"],
  );
});

test("never passes over David: send anyway after the statement (single or bundle), a send in flight, a lapsed or cleared hold", () => {
  const req = request("req-x", "cu-x");
  const base = heldState("cu-x");
  assert.equal(passCauseFor(base, req, NOW).cause, "off_market");
  const after = "2026-09-20T10:00:00.000Z";
  assert.equal(passCauseFor({ ...base, outbox: { "match:req-x": { status: "delivered", claimedAt: after } } }, req, NOW), null);
  assert.equal(passCauseFor({ ...base, outbox: { "match-bundle:req-w,req-x": { status: "delivered", requestIds: ["req-w", "req-x"], claimedAt: after } } }, req, NOW), null);
  assert.equal(contactedAfter({ matches: { "req-x": { sentAt: after } } }, "req-x", base.offMarket.detectedAt), true);
  // An email sent BEFORE the statement does not protect the request.
  assert.equal(passCauseFor({ ...base, matches: { "req-x": { sentAt: "2026-09-13T10:00:00.000Z" } } }, req, NOW).cause, "off_market");
  // A released claim never went out.
  assert.equal(passCauseFor({ ...base, outbox: { "match:req-x": { status: "released", claimedAt: after } } }, req, NOW).cause, "off_market");
  // A send still settling waits, including an uncertain bundle.
  assert.equal(passCauseFor({ ...base, outbox: { "match:req-x": { status: "queued", claimedAt: "2026-09-01T10:00:00.000Z" } } }, req, NOW), null);
  assert.equal(sendInFlight({ outbox: { "match-bundle:req-x,req-y": { status: "uncertain", requestIds: ["req-x", "req-y"] } } }, "req-x"), true);
  assert.equal(sendInFlight({ outbox: { "match-bundle:req-y,req-z": { status: "uncertain", requestIds: ["req-y", "req-z"] } } }, "req-x"), false);
  // Six months later the hold has lapsed; a cleared hold never counts.
  assert.equal(passCauseFor(heldState("cu-x", { expiresAt: "2026-09-01T00:00:00.000Z" }), req, NOW), null);
  assert.equal(passCauseFor({ ...base, offMarket: { ...base.offMarket, clearedAt: iso(NOW) } }, req, NOW), null);
  // Already passed, or a pass already attempted.
  assert.equal(passCauseFor({ ...base, passedRequests: { "req-x": {} } }, req, NOW), null);
  assert.equal(passCauseFor({ ...base, pendingPasses: { "req-x": {} } }, req, NOW), null);
  assert.equal(passCauseFor({ candidateUserId: "cu-x", intentVerdict: "OPEN" }, req, NOW), null);
});

test("each pass is re-planned under the candidate's lock, so a send-anyway made meanwhile wins", async () => {
  const history = [request("r-race", "cu-race")];
  const h = harness({ states: [heldState("cu-race")] });
  // The listing the tick handed us is stale: David sent anyway since.
  h.store.set("cu-race", {
    ...h.store.get("cu-race"),
    revision: 2,
    outbox: { "match:r-race": { status: "claimed", claimedAt: iso(NOW - 5_000) } },
  });
  const stale = [heldState("cu-race")];
  const result = await runReplyPassStep({ history, states: stale, config: {}, now: NOW, passConfig: replyPassConfig({}), ...h.deps });
  assert.equal(h.calls.dismissed.length, 0);
  assert.deepEqual(result.skipped, [{ requestId: "r-race", reason: "state_changed" }]);
  assert.ok(h.calls.locks.includes("cu-race"));
});

test("only pending requests are planned, oldest first", () => {
  const history = [
    request("late", "cu-p", { createdAtMs: NOW - HOUR }),
    request("early", "cu-p", { createdAtMs: NOW - 5 * HOUR }),
    request("closed", "cu-p", { status: "expired", createdAtMs: NOW - 9 * HOUR }),
    request("elsewhere", "cu-q"),
  ];
  assert.deepEqual(planReplyPasses({ history, states: [heldState("cu-p")], now: NOW }).map((plan) => plan.request.id), ["early", "late"]);
});

test("a throttle refusal gives the request back and stops the batch without a word", async () => {
  const history = [request("r1", "cu-t"), request("r2", "cu-t", { createdAtMs: NOW })];
  const error = new Error("pace");
  error.code = REQUEST_LANE_RATE_LIMITED_CODE;
  const h = harness({ states: [heldState("cu-t")], dismissError: error });
  const result = await h.run(history);
  assert.equal(result.stopped, REQUEST_LANE_RATE_LIMITED_CODE);
  assert.deepEqual(h.calls.dismissed.map((call) => call.id), ["r1"]);
  assert.deepEqual(h.calls.released, ["r1"]);
  assert.equal(h.claims.size, 0);
  assert.deepEqual(h.store.get("cu-t").pendingPasses, {});
  assert.equal(h.calls.slack.length, 0);
});

test("a pass that did not take is flagged once, never retried, and does not block the next one", async () => {
  const stuck = request("r-stuck", "cu-s", { createdAtMs: NOW - 9 * HOUR });
  const next = request("r-next", "cu-n", { createdAtMs: NOW - HOUR, company: "Beta" });
  const h = harness({ states: [heldState("cu-s")] });
  h.deps.dismissImpl = async (id, reason) => { h.calls.dismissed.push({ id, reason }); throw new Error("socket hang up"); };
  await h.run([stuck]);
  assert.equal(h.store.get("cu-s").pendingPasses["r-stuck"].cause, "off_market");
  // Next tick: Paraform still shows it pending. Flagged once, not retried.
  h.store.set("cu-n", heldState("cu-n"));
  h.deps.dismissImpl = async (id, reason) => { h.calls.dismissed.push({ id, reason }); return { ok: true }; };
  const second = await h.run([stuck, next], { passConfig: replyPassConfig({ PARAAI_REPLY_PASS_LIMIT: "1" }) });
  assert.deepEqual(second.unverified, [{ requestId: "r-stuck" }]);
  assert.deepEqual(h.calls.dismissed.map((call) => call.id), ["r-stuck", "r-next"]);
  assert.equal(h.calls.slack.length, 1);
  assert.match(h.calls.slack[0], /Software Engineer @ Garage for Meesh Z\. on Paraform, but the request is still pending\. It will not be retried/);
  await h.run([stuck, dismissedIn([next], ["r-next"])[0]]);
  assert.equal(h.calls.slack.filter((line) => /still pending/.test(line)).length, 1, "flagged once");
  assert.equal(h.calls.dismissed.filter((call) => call.id === "r-stuck").length, 1, "never retried");
});

test("a request that expired or was submitted meanwhile is given back, not announced as a pass", async () => {
  const row = request("r-exp", "cu-e");
  const h = harness({ states: [heldState("cu-e")] });
  await h.run([row]);
  const result = await h.run([{ ...row, status: "expired" }]);
  assert.deepEqual(result.returned, [{ requestId: "r-exp", status: "expired" }]);
  assert.deepEqual(result.confirmed, []);
  assert.deepEqual(h.calls.released, ["r-exp"], "the expired lane may act on it now");
  assert.equal(h.calls.slack.length, 0);
  assert.equal(h.calls.resolved.length, 0);
  assert.equal(h.store.get("cu-e").passedRequests, undefined);
});

test("a request another lane already claimed (expired actioning, the Submissions tab) is left to it", async () => {
  const history = [request("r-c", "cu-c")];
  const h = harness({ states: [heldState("cu-c")], claims: new Map([["r-c", { lane: "submissions", action: "submit", claimId: "x" }]]) });
  const result = await h.run(history);
  assert.equal(h.calls.dismissed.length, 0);
  assert.deepEqual(result.skipped, [{ requestId: "r-c", reason: "claimed_by_submissions" }]);
});

test("if the attempt cannot be recorded, nothing is sent and the claim is given back", async () => {
  const h = harness({ states: [heldState("cu-f")], saveFailsFor: (state) => Boolean(state.pendingPasses) });
  const result = await h.run([request("r-f", "cu-f")]);
  assert.equal(h.calls.dismissed.length, 0);
  assert.deepEqual(h.calls.released, ["r-f"]);
  assert.deepEqual(result.skipped, [{ requestId: "r-f", reason: "state_save_failed" }]);
});

test("the per-tick cap counts Paraform attempts; the time budget and the Gmail breaker stop the step", async () => {
  const history = ["a", "b", "c", "d"].map((id, i) => request(id, "cu-cap", { createdAtMs: NOW - (10 - i) * HOUR }));
  const capped = harness({ states: [heldState("cu-cap")] });
  const result = await capped.run(history);
  assert.deepEqual(capped.calls.dismissed.map((call) => call.id), ["a", "b", "c"]);
  assert.equal(result.attempted.length, 3);

  const slow = harness({ states: [heldState("cu-slow")] });
  slow.deps.clock = (() => { let t = 0; return () => (t += 50_000); })();
  const late = await slow.run([request("s1", "cu-slow")]);
  assert.equal(late.stopped, "budget");
  assert.equal(slow.calls.dismissed.length, 0);

  const busy = harness({ states: [heldState("cu-g", { replyPassCheckedAt: null })] });
  busy.deps.gmailBackoffImpl = async () => "2026-09-29T18:20:00.000Z";
  const braked = await busy.run([request("g1", "cu-g")]);
  assert.equal(braked.stopped, "gmail_rate_limited");
  assert.equal(busy.calls.assessed.length, 0);
});

test("PARAAI_REPLY_PASS=off stops the lane; the defaults are on", async () => {
  assert.equal(replyPassConfig({}).enabled, true);
  assert.equal(replyPassConfig({ PARAAI_REPLY_PASS: "OFF" }).enabled, false);
  assert.equal(replyPassConfig({ PARAAI_REPLY_PASS_RECHECK_MINUTES: "2" }).recheckMs, 5 * 60_000, "never faster than 5 minutes");
  const h = harness({ states: [heldState("cu-off")] });
  const result = await h.run([request("r-off", "cu-off")], { passConfig: replyPassConfig({ PARAAI_REPLY_PASS: "off" }) });
  assert.equal(result.enabled, false);
  assert.equal(h.calls.dismissed.length + h.calls.assessed.length, 0);
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
