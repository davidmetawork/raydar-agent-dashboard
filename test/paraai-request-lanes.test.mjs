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
const providerCalls = [];

function evalScript([script, keyCount, ...rest]) {
  const keys = rest.slice(0, Number(keyCount));
  const args = rest.slice(Number(keyCount));
  if (script.includes("return {1, ARGV[1]}")) {
    // createOutreachState: insert once.
    const existing = kv.get(keys[0]);
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
