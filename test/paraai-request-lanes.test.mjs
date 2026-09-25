import test from "node:test";
import assert from "node:assert/strict";

// 2026-09-25: David turned the two Para AI interview-request lanes (candidate
// outreach email and expired-match actioning) back on while the rest of the
// worker stays under the 2026-09-16 background pause. These tests pin that
// scope, the lanes' own brake, and the follow-up guard that keeps a resumed
// outreach lane from nudging candidates about requests that already closed.
//
// The state stores snapshot their KV configuration at import time, so the
// in-memory KV is installed before the modules are imported. Any request that
// is not the fake KV fails the test: no Paraform, Gmail or Slack IO may occur.
const KV_URL = "https://kv.request-lanes.test";
process.env.KV_REST_API_URL = KV_URL;
process.env.KV_REST_API_TOKEN = "kv-test-token";
process.env.PARAAI_AUTOMATION_RUNNER_KEY = "runner-test-secret";

const kv = new Map();
const zsets = new Map();
const providerCalls = [];
const zadd = (key, member) => {
  if (!zsets.has(key)) zsets.set(key, []);
  const list = zsets.get(key).filter((item) => item !== member);
  list.push(member);
  zsets.set(key, list);
};

function evalScript([script, keyCount, ...rest]) {
  const keys = rest.slice(0, Number(keyCount));
  const args = rest.slice(Number(keyCount));
  if (script.includes("return {1, ARGV[1]}")) {
    // createOutreachState: insert once.
    const existing = kv.get(keys[0]);
    zadd(keys[1], args[3]);
    if (existing) return [0, existing];
    kv.set(keys[0], args[0]);
    return [1, args[0]];
  }
  if (script.includes("cjson.decode")) {
    // saveOutreachState: compare-and-set on revision.
    const raw = kv.get(keys[0]);
    if (!raw) return -1;
    if (Number(JSON.parse(raw).revision || 0) !== Number(args[0])) return 0;
    kv.set(keys[0], args[1]);
    zadd(keys[1], args[4]);
    return 1;
  }
  if (script.includes("redis.call('GET', KEYS[1]) == ARGV[1]")) {
    // Lock release.
    if (kv.get(keys[0]) === args[0]) { kv.delete(keys[0]); return 1; }
    return 0;
  }
  throw new Error(`unexpected EVAL in test: ${script.slice(0, 60)}`);
}

function command([name, ...args]) {
  switch (String(name).toUpperCase()) {
    case "GET": return kv.get(args[0]) ?? null;
    case "SET": {
      const [key, value, ...options] = args;
      if (options.includes("NX") && kv.has(key)) return null;
      kv.set(key, value);
      return "OK";
    }
    case "DEL": return kv.delete(args[0]) ? 1 : 0;
    case "ZREVRANGE": return [...(zsets.get(args[0]) || [])].reverse();
    case "EVAL": return evalScript(args);
    default: throw new Error(`unexpected KV command in test: ${name}`);
  }
}

globalThis.fetch = async (url, init = {}) => {
  const href = String(url);
  if (!href.startsWith(KV_URL)) {
    providerCalls.push(href);
    throw new Error(`provider IO must not occur: ${href}`);
  }
  const body = JSON.parse(init.body || "null");
  const result = href.endsWith("/pipeline")
    ? body.map((item) => ({ result: command(item) }))
    : { result: command(body) };
  return new Response(JSON.stringify(result), { status: 200 });
};

const {
  closedRequestStatuses,
  outreachConfig,
  processDueFollowup,
  runOutreachTick,
} = await import("../api/paraai/_lib/outreach.mjs");
const {
  expiredConfig,
  gatherContactEvidence,
  planExpiredRow,
} = await import("../api/paraai/_lib/expired.mjs");
const { normalizeExpiredRow } = await import("../api/paraai/_lib/expired-actions.mjs");
const { handleParaaiHealth } = await import("../api/paraai/health.mjs");
const { createOutreachState, getOutreachState } = await import("../api/paraai/_lib/outreach-store.mjs");
const { runExpiredTick } = await import("../api/paraai/_lib/expired.mjs");
const { handleParaaiWorker, runRequestLanes } = await import("../api/paraai/worker.mjs");
const { PARAFORM_BACKGROUND_PAUSE_KEYS } = await import("../api/_lib/paraform-background-pause.mjs");
const { handleBackgroundPause } = await import("../api/paraai/background-pause.mjs");

function nodeResponse() {
  return {
    headers: {},
    body: null,
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; },
  };
}

const auth = { authorization: "Bearer runner-test-secret" };
const openOutreachConfig = () => ({
  ...outreachConfig({}),
  approved: true,
  sendApproved: true,
  dryRun: false,
  notBeforeMs: Date.parse("2026-07-18T17:00:00.000Z"),
  gmailConfigured: true,
  storeConfigured: true,
  mailbox: "david@raydar.xyz",
});

test.beforeEach(() => {
  kv.clear();
  zsets.clear();
  providerCalls.length = 0;
});

test("the interview-request lanes have their own brake scope on the existing control", async () => {
  assert.equal(
    PARAFORM_BACKGROUND_PAUSE_KEYS.paraaiRequestLanes,
    "ops:paraform-background-pause:v1:paraai-request-lanes",
  );
  assert.notEqual(
    PARAFORM_BACKGROUND_PAUSE_KEYS.paraaiRequestLanes,
    PARAFORM_BACKGROUND_PAUSE_KEYS.paraaiWorker,
  );
  const calls = [];
  const response = nodeResponse();
  await handleBackgroundPause({
    method: "POST",
    headers: auth,
    body: { action: "pause", scope: "paraaiRequestLanes", pauseId: "request-lanes-test" },
    query: {},
  }, response, {
    env: { PARAAI_AUTOMATION_RUNNER_KEY: "runner-test-secret" },
    controlImpl: async (commandArgs) => { calls.push(commandArgs); return 1; },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.paused, true);
  assert.equal(calls[0][3], PARAFORM_BACKGROUND_PAUSE_KEYS.paraaiRequestLanes);
});

test("only positive evidence closes a request", () => {
  const closed = closedRequestStatuses([
    { id: "open", status: "pending" },
    { id: "expired", status: "expired" },
    { id: "dismissed", status: "DISMISSED" },
    { id: "submitted", status: "submitted" },
    { id: "unknown", status: "" },
    { id: "", status: "expired" },
  ]);
  assert.deepEqual([...closed.entries()], [
    ["expired", "expired"],
    ["dismissed", "dismissed"],
    ["submitted", "submitted"],
  ]);
});

async function seedDueFollowup(candidateUserId, ownerMatchId) {
  await createOutreachState(candidateUserId, {
    candidateName: "Test Candidate",
    candidateEmail: "candidate@example.test",
    threadId: "thread-1",
    latestMatchId: ownerMatchId,
    firstOutboundAt: "2026-09-15T00:00:00.000Z",
    lastOutboundAt: "2026-09-15T00:00:00.000Z",
    followup: {
      ownerMatchId,
      number: 1,
      remaining: 2,
      dueAt: "2026-09-17T00:00:00.000Z",
      roleName: "Engineer",
      companyName: "Example Co",
    },
  });
}

test("a due follow-up for a request Paraform has closed is cancelled, never sent", async () => {
  await seedDueFollowup("candidate-closed", "request-expired");
  const result = await processDueFollowup("candidate-closed", {
    config: openOutreachConfig(),
    now: Date.parse("2026-09-25T20:00:00.000Z"),
    closedRequests: new Map([["request-expired", "expired"]]),
  });
  assert.equal(result.action, "canceled_request_closed");
  const state = await getOutreachState("candidate-closed");
  assert.equal(state.followup, null);
  const last = state.journal.at(-1);
  assert.equal(last.event, "followup_canceled_request_closed");
  assert.equal(last.ownerMatchId, "request-expired");
  assert.equal(last.requestStatus, "expired");
  assert.deepEqual(providerCalls, [], "cancelling must not read Gmail or Paraform");
});

test("a due follow-up for a still-open request is not cancelled by the guard", async () => {
  await seedDueFollowup("candidate-open", "request-open");
  // The open path goes on to read the Gmail thread, which this test process
  // cannot reach; it must fail there rather than cancel.
  await assert.rejects(processDueFollowup("candidate-open", {
    config: openOutreachConfig(),
    now: Date.parse("2026-09-25T20:00:00.000Z"),
    closedRequests: new Map([["some-other-request", "expired"]]),
  }));
  const state = await getOutreachState("candidate-open");
  assert.equal(state.followup?.ownerMatchId, "request-open");
  assert.ok(!JSON.stringify(state.journal).includes("followup_canceled_request_closed"));
});

test("the outreach tick stops at the request-lanes brake before any store or provider call", async () => {
  let fetches = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async (...args) => { fetches += 1; return original(...args); };
  try {
    for (const pauseState of [
      async () => ({ paused: true }),
      async () => { throw new Error("control unreadable"); },
    ]) {
      const result = await runOutreachTick({ config: openOutreachConfig(), pauseState });
      assert.deepEqual(result, { enabled: true, processed: 0, reason: "request_lanes_paused" });
    }
  } finally {
    globalThis.fetch = original;
  }
  assert.equal(fetches, 0);
});

test("the expired tick stops at the request-lanes brake, including backfill", async () => {
  let fetches = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async (...args) => { fetches += 1; return original(...args); };
  try {
    for (const mode of ["organic", "manual", "backfill"]) {
      const result = await runExpiredTick({
        mode,
        env: { PARAAI_EXPIRED_APPROVED: "true" },
        pauseState: async () => ({ paused: true }),
      });
      assert.deepEqual(result, { ok: true, ran: false, reason: "request_lanes_paused" });
    }
  } finally {
    globalThis.fetch = original;
  }
  assert.equal(fetches, 0);
});

test("request lanes run outreach then expired, each isolated from the other", async () => {
  const order = [];
  const alerts = [];
  const lanes = await runRequestLanes({
    outreachImpl: async () => { order.push("outreach"); throw Object.assign(new Error("boom"), { code: "GMAIL_REQUEST_FAILED" }); },
    expiredImpl: async () => { order.push("expired"); return { ok: true, ran: true, dismissed: 1 }; },
    alertImpl: async (_error, { slot }) => { alerts.push(slot); return true; },
  });
  assert.deepEqual(order, ["outreach", "expired"]);
  assert.equal(lanes.outreachError.error, "GMAIL_REQUEST_FAILED");
  assert.deepEqual(lanes.expired, { ok: true, ran: true, dismissed: 1 });
  assert.equal(lanes.expiredError, null);

  const second = await runRequestLanes({
    outreachImpl: async () => ({ enabled: true, processed: 0 }),
    expiredImpl: async () => { throw Object.assign(new Error("boom"), { code: "PARAFORM_FAILED" }); },
    alertImpl: async (_error, { slot }) => { alerts.push(slot); return true; },
  });
  assert.equal(second.outreachError, null);
  assert.equal(second.expiredError.error, "PARAFORM_FAILED");
  assert.deepEqual(alerts, ["outreach-worker-failed", "expired-worker-failed"]);
});

test("a paused worker runs only the request lanes, and only on its automatic entrypoints", async () => {
  const cases = [
    { request: { method: "POST", headers: auth, body: { mode: "tick" }, query: {} }, runs: true },
    // GET without a mode is the Vercel cron's recovery entrypoint.
    { request: { method: "GET", headers: auth, query: {} }, runs: true },
    { request: { method: "GET", headers: auth, query: { mode: "status" } }, runs: false },
    { request: { method: "POST", headers: auth, body: { mode: "enqueue" }, query: {} }, runs: false },
    { request: { method: "POST", headers: auth, body: { mode: "phase3-shadow-arm" }, query: {} }, runs: false },
  ];
  for (const { request, runs } of cases) {
    let calls = 0;
    const response = nodeResponse();
    await handleParaaiWorker(request, response, {
      pauseState: async () => ({ paused: true }),
      requestLanes: async () => {
        calls += 1;
        return { outreach: { processed: 0 }, outreachError: null, expired: { ran: false }, expiredError: null };
      },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.body.ok, true, "the Fly poller needs ok:true to treat the tick as a success");
    assert.equal(response.body.paused, true);
    assert.equal(response.body.reason, "paraai_worker_paused");
    assert.equal(calls, runs ? 1 : 0, JSON.stringify(request));
    if (runs) {
      assert.equal(response.body.requestLanes, "running");
      assert.equal(response.body.degraded, false);
      assert.deepEqual(response.body.outreach, { processed: 0 });
      assert.deepEqual(response.body.expired, { ran: false });
      assert.equal(response.body.tick, undefined, "no Phase 1 queue work runs under the pause");
    } else {
      assert.deepEqual(response.body, { ok: true, paused: true, reason: "paraai_worker_paused" });
    }
  }
  assert.deepEqual(providerCalls, []);
});

test("a lane failure under the pause marks the paused response degraded", async () => {
  const response = nodeResponse();
  await handleParaaiWorker({ method: "POST", headers: auth, body: { mode: "tick" }, query: {} }, response, {
    pauseState: async () => ({ paused: true }),
    requestLanes: async () => ({
      outreach: null,
      outreachError: { error: "outreach_failed" },
      expired: { ran: true },
      expiredError: null,
    }),
  });
  assert.equal(response.body.ok, true);
  assert.equal(response.body.degraded, true);
});

test("the tick cancels every closed-request nudge without spending the batch on them", async () => {
  // batchSize 1: two closed-request nudges are cancelled AND the one open
  // nudge is still attempted, proving cancellations use no send slot.
  await seedDueFollowup("candidate-a", "request-closed-a");
  await seedDueFollowup("candidate-b", "request-open");
  await seedDueFollowup("candidate-c", "request-closed-c");
  const created = Date.parse("2026-09-15T00:00:00.000Z");
  const history = [
    { id: "request-closed-a", status: "expired", candidateUserId: "candidate-a", roleId: "role-a", reachedOut: true, createdAtMs: created, reachedOutAtMs: created + 3_600_000, recipientTypes: [] },
    { id: "request-open", status: "pending", candidateUserId: "candidate-b", roleId: "role-b", reachedOut: true, createdAtMs: created, reachedOutAtMs: created + 3_600_000, recipientTypes: [] },
    { id: "request-closed-c", status: "dismissed", candidateUserId: "candidate-c", roleId: "role-c", reachedOut: true, createdAtMs: created, reachedOutAtMs: created + 3_600_000, recipientTypes: [] },
  ];
  const result = await runOutreachTick({
    config: { ...openOutreachConfig(), batchSize: 1 },
    now: Date.parse("2026-09-25T20:00:00.000Z"),
    pauseState: async () => ({ paused: false }),
    historyImpl: async () => history,
  });
  const followups = result.results.filter((item) => item.followup);
  assert.equal(followups.filter((item) => item.action === "canceled_request_closed").length, 2);
  // The open one reaches Gmail, which this process cannot, so it errors
  // rather than being cancelled or skipped.
  assert.equal(followups.filter((item) => item.action === "error").length, 1);
  assert.equal(result.processed, 0);
  assert.equal((await getOutreachState("candidate-a")).followup, null);
  assert.equal((await getOutreachState("candidate-c")).followup, null);
  assert.equal((await getOutreachState("candidate-b")).followup?.ownerMatchId, "request-open");
});

test("a paused worker never coerces a non-string mode into a lane run", async () => {
  for (const body of [{ mode: ["tick"] }, { mode: { toString: () => "tick" } }, { mode: 1 }]) {
    let calls = 0;
    const response = nodeResponse();
    await handleParaaiWorker({ method: "POST", headers: auth, body, query: {} }, response, {
      pauseState: async () => ({ paused: true }),
      requestLanes: async () => { calls += 1; return {}; },
    });
    assert.equal(calls, 0);
    assert.deepEqual(response.body, { ok: true, paused: true, reason: "paraai_worker_paused" });
  }
});

test("the paused response says when both lanes are braked, and counts expired row errors", async () => {
  const braked = nodeResponse();
  await handleParaaiWorker({ method: "POST", headers: auth, body: { mode: "tick" }, query: {} }, braked, {
    pauseState: async () => ({ paused: true }),
    requestLanes: async () => ({
      outreach: { enabled: true, processed: 0, reason: "request_lanes_paused" },
      outreachError: null,
      expired: { ok: true, ran: false, reason: "request_lanes_paused" },
      expiredError: null,
    }),
  });
  assert.equal(braked.body.requestLanes, "paused");
  assert.equal(braked.body.degraded, false);

  const rowErrors = nodeResponse();
  await handleParaaiWorker({ method: "POST", headers: auth, body: { mode: "tick" }, query: {} }, rowErrors, {
    pauseState: async () => ({ paused: true }),
    requestLanes: async () => ({
      outreach: { enabled: true, processed: 0 },
      outreachError: null,
      expired: { ok: true, ran: true, errors: 1 },
      expiredError: null,
    }),
  });
  assert.equal(rowErrors.body.requestLanes, "running");
  assert.equal(rowErrors.body.degraded, true);
});

// ---------------------------------------------------------------- expired truth

const armed = () => ({
  ...expiredConfig({
    PARAAI_EXPIRED_APPROVED: "true",
    PARAAI_EXPIRED_DRY_RUN: "false",
    PARAAI_EXPIRED_NOT_BEFORE: "2026-09-16T00:00:00Z",
    PARAAI_EXPIRED_DISMISS_APPROVED: "true",
  }),
  gmailConfigured: true,
  mailbox: "david@raydar.xyz",
});
const createdIso = "2026-09-18T19:31:32.707Z";
const rawRow = (overrides = {}) => ({
  id: "request-x",
  status: "expired",
  created_at: createdIso,
  reached_out_to_candidate: true,
  reached_out_to_candidate_at: "2026-09-19T16:00:00.000Z",
  recipient_types: ["RECRUITER"],
  candidate: { candidate_user_id: "candidate-x" },
  role: { id: "role-x" },
  ...overrides,
});
const noReplies = new Map();
const now = Date.parse("2026-09-25T21:00:00.000Z");

async function evidenceFor(row, {
  state,
  search = async () => [],
  thread = async () => ({ messages: [] }),
  email = async () => "",
} = {}) {
  return gatherContactEvidence(normalizeExpiredRow(row), {
    config: armed(),
    replyRecordsByCandidate: noReplies,
    now,
    stateImpl: async () => state,
    searchImpl: search,
    threadImpl: thread,
    emailImpl: email,
  });
}

test("Paraform's own candidate-recipient premark is not contact by us", async () => {
  const premarked = rawRow({
    recipient_types: ["RECRUITER", "CANDIDATE"],
    reached_out_to_candidate_at: "2026-09-18T19:31:40.000Z",
  });
  const evidence = await evidenceFor(premarked, { state: null });
  assert.equal(evidence.vendorPremark, true);
  assert.equal(evidence.raydarDelivery, null);
  const plan = planExpiredRow(normalizeExpiredRow(premarked), evidence, { config: armed(), now, claim: null });
  assert.equal(plan.action, "review");
  assert.equal(plan.resolution, "never_contacted");

  // The same premark with our own Gmail delivery of this request is contact.
  const delivered = await evidenceFor(premarked, {
    state: { candidateEmail: "x@example.test", threadId: "t", matches: { "request-x": { sentAt: "2026-09-18T19:40:00.000Z", transport: "gmail" } } },
  });
  assert.equal(delivered.raydarDelivery, "gmail");
  assert.equal(planExpiredRow(normalizeExpiredRow(premarked), delivered, { config: armed(), now, claim: null }).action, "dismiss");
});

test("any message from the candidate anywhere in the mailbox since creation blocks the reason", async () => {
  const queries = [];
  const state = {
    candidateEmail: "x@example.test",
    threadId: "t",
    matches: { "request-x": { sentAt: "2026-09-20T00:00:00.000Z", transport: "mailroom-sendgrid" } },
  };
  const evidence = await evidenceFor(rawRow(), {
    state,
    search: async (mailbox, query) => { queries.push([mailbox, query]); return [{ id: "reply-thread" }]; },
  });
  assert.deepEqual(queries, [["david@raydar.xyz", `from:"x@example.test" in:anywhere after:${Math.floor(Date.parse(createdIso) / 1000)}`]]);
  assert.equal(evidence.mailboxReplies, 1);
  const plan = planExpiredRow(normalizeExpiredRow(rawRow()), evidence, { config: armed(), now, claim: null });
  assert.equal(plan.action, "review");
  assert.equal(plan.resolution, "candidate_replied");

  // A SendGrid delivery with a clean mailbox search is provably unanswered.
  const quiet = await evidenceFor(rawRow(), { state });
  assert.equal(planExpiredRow(normalizeExpiredRow(rawRow()), quiet, { config: armed(), now, claim: null }).action, "dismiss");
});

test("a SendGrid delivery whose mailbox cannot be searched goes to review", () => {
  const row = normalizeExpiredRow(rawRow());
  const plan = planExpiredRow(row, {
    reachedOut: true,
    vendorPremark: false,
    raydarDelivery: "mailroom-sendgrid",
    replyRecords: [],
    gmailReplies: 0,
    mailboxReplies: null,
    gmailError: null,
  }, { config: armed(), now, claim: null });
  assert.equal(plan.action, "review");
  assert.equal(plan.resolution, "reply_not_observable");
});

test("a mailbox search failure holds the row for the next pass instead of deciding", async () => {
  const evidence = await evidenceFor(rawRow(), {
    state: { candidateEmail: "x@example.test", threadId: "t", matches: {} },
    search: async () => { throw Object.assign(new Error("429"), { code: "GMAIL_REQUEST_FAILED" }); },
  });
  assert.equal(evidence.gmailError, "GMAIL_REQUEST_FAILED");
  assert.equal(planExpiredRow(normalizeExpiredRow(rawRow()), evidence, { config: armed(), now, claim: null }).action, "hold");
});

test("health reports outreach readiness from the request-lanes brake while the worker is paused", async () => {
  const gateEnv = {
    PARAAI_OUTREACH_APPROVED: "true",
    PARAAI_OUTREACH_SEND_APPROVED: "true",
    PARAAI_OUTREACH_DRY_RUN: "false",
    PARAAI_OUTREACH_NOT_BEFORE: "2026-07-18T17:00:00.000Z",
    GOOGLE_SA_KEY_FILE: "/private/key.json",
  };
  const prior = Object.fromEntries(Object.keys(gateEnv).map((key) => [key, process.env[key]]));
  Object.assign(process.env, gateEnv);
  try {
    for (const [lanesPaused, ready] of [[false, true], [true, false]]) {
      const response = nodeResponse();
      await handleParaaiHealth({ method: "GET", headers: {}, query: {} }, response, {
        pauseState: async () => ({ paused: true }),
        requestLanesPauseState: async () => ({ paused: lanesPaused }),
      });
      assert.equal(response.body.paused, true);
      assert.equal(response.body.paraform, "paused");
      assert.equal(response.body.automation.ready, false);
      assert.equal(response.body.outreach.requestLanesPaused, lanesPaused);
      assert.equal(response.body.outreach.executionReady, ready);
    }
  } finally {
    for (const [key, value] of Object.entries(prior)) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  }
  assert.deepEqual(providerCalls, [], "health under the pause makes no provider call");
});

test("a hand-sent reach-out is judged by a mailbox search on the Paraform address, or goes to review", async () => {
  // Paraform says reached out (not its premark) and Raydar never emailed this
  // candidate: the address comes from Paraform and the whole mailbox is searched.
  const lookups = [];
  const queries = [];
  const searched = await evidenceFor(rawRow(), {
    state: null,
    email: async (candidateUserId) => { lookups.push(candidateUserId); return "hand@example.test"; },
    search: async (_mailbox, query) => { queries.push(query); return []; },
  });
  assert.deepEqual(lookups, ["candidate-x"]);
  assert.match(queries[0], /^from:"hand@example\.test" in:anywhere after:\d+$/);
  assert.equal(searched.mailboxReplies, 0);
  assert.equal(planExpiredRow(normalizeExpiredRow(rawRow()), searched, { config: armed(), now, claim: null }).action, "dismiss");

  // No address anywhere: the search cannot run, so the reason is unproven.
  const blind = await evidenceFor(rawRow(), { state: null, email: async () => "" });
  assert.equal(blind.mailboxReplies, null);
  const plan = planExpiredRow(normalizeExpiredRow(rawRow()), blind, { config: armed(), now, claim: null });
  assert.equal(plan.action, "review");
  assert.equal(plan.resolution, "reply_not_observable");

  // A failed Paraform address read holds rather than deciding.
  const failed = await evidenceFor(rawRow(), {
    state: null,
    email: async () => { throw Object.assign(new Error("401"), { code: "AUTH_EXPIRED" }); },
  });
  assert.equal(planExpiredRow(normalizeExpiredRow(rawRow()), failed, { config: armed(), now, claim: null }).action, "hold");
});

test("a paused Para AI matching status raises the matching-paused alert; an active one does not", async () => {
  for (const [matchingPaused, expected] of [[true, 1], [false, 0], [null, 0]]) {
    const alerts = [];
    await runRequestLanes({
      outreachImpl: async () => ({ enabled: true, processed: 0 }),
      expiredImpl: async () => ({ ok: true, ran: true, matchingPaused, expiredCount: 3 }),
      alertImpl: async () => true,
      pausedAlertImpl: async (expired) => { alerts.push(expired.expiredCount); return true; },
    });
    assert.equal(alerts.length, expected, String(matchingPaused));
  }
});
