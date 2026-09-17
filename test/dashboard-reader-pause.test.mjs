import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  PARAFORM_BACKGROUND_PAUSE_KEYS,
} from "../api/_lib/paraform-background-pause.mjs";
import { handleActivityDigest } from "../api/activity/digest.mjs";
import { handleActivityFeed } from "../api/activity/feed.mjs";
import { createInboxSyncHandler } from "../api/inbox/sync.mjs";
import { handleBackgroundPause } from "../api/paraai/background-pause.mjs";
import { paraformHealth } from "../api/seq/_lib/core.mjs";
import { handleSubmissionCredits } from "../api/submissions/credits.mjs";
import { handleSubmissionsRefresh } from "../api/submissions/refresh.mjs";

const PAUSE_ID = "incident-2026-09-17-dashboard-readers";
const OPERATOR_ENV = {
  PARAAI_AUTOMATION_RUNNER_KEY: "runner-only-secret",
  CRON_SECRET: "cron-cannot-operate-pause",
  KV_REST_API_URL: "https://control.example.test",
  KV_REST_API_TOKEN: "test-token",
};

function response() {
  return {
    headers: {},
    statusCode: 200,
    body: null,
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; },
  };
}

function memoryControl() {
  const values = new Map();
  const calls = [];
  return {
    calls,
    values,
    async control(command) {
      calls.push(command);
      const key = command[command[0] === "GET" ? 1 : 3];
      if (command[0] === "GET") return values.get(key) ?? null;
      assert.equal(command[0], "EVAL");
      const script = command[1];
      const expected = command[4];
      const current = values.get(key) ?? null;
      if (script.includes("redis.call('SET'")) {
        if (current === null) { values.set(key, expected); return 1; }
        return current === expected ? 2 : 3;
      }
      if (current === null) return 1;
      if (current === expected) { values.delete(key); return 2; }
      return 3;
    },
  };
}

const operatorRequest = ({ method = "GET", body, query = {} } = {}) => ({
  method,
  headers: { authorization: `Bearer ${OPERATOR_ENV.PARAAI_AUTOMATION_RUNNER_KEY}` },
  body,
  query,
});

const paused = async () => ({
  paused: true,
  state: "configured",
  pauseId: PAUSE_ID,
});

test("dashboard reader pause is a separate atomic owner record with exact resume", async () => {
  const memory = memoryControl();
  const key = PARAFORM_BACKGROUND_PAUSE_KEYS.dashboardReaders;
  const paraaiKey = PARAFORM_BACKGROUND_PAUSE_KEYS.paraaiWorker;

  const pauseResponse = response();
  await handleBackgroundPause(operatorRequest({
    method: "POST",
    body: { action: "pause", pauseId: PAUSE_ID, scope: "dashboardReaders" },
  }), pauseResponse, { env: OPERATOR_ENV, controlImpl: memory.control });
  assert.equal(pauseResponse.statusCode, 200);
  assert.equal(pauseResponse.body.paused, true);
  assert.ok(memory.values.has(key));
  assert.equal(memory.values.has(paraaiKey), false, "the existing ParaAI pause is independent");
  assert.equal(memory.calls[0][3], key);
  assert.equal(memory.calls[0].length, 5, "the owner pause must not expire");
  assert.match(memory.calls[0][1], /SET[\s\S]*'NX'/u);

  const statusResponse = response();
  await handleBackgroundPause(operatorRequest({
    query: { scope: "dashboardReaders" },
  }), statusResponse, { env: OPERATOR_ENV, controlImpl: memory.control });
  assert.equal(statusResponse.body.pauseId, PAUSE_ID);

  const wrongResume = response();
  await handleBackgroundPause(operatorRequest({
    method: "POST",
    body: { action: "resume", pauseId: "another-owner", scope: "dashboardReaders" },
  }), wrongResume, { env: OPERATOR_ENV, controlImpl: memory.control });
  assert.equal(wrongResume.statusCode, 409);
  assert.ok(memory.values.has(key), "a different owner cannot delete the pause");

  const resumeResponse = response();
  await handleBackgroundPause(operatorRequest({
    method: "POST",
    body: { action: "resume", pauseId: PAUSE_ID, scope: "dashboardReaders" },
  }), resumeResponse, { env: OPERATOR_ENV, controlImpl: memory.control });
  assert.equal(resumeResponse.statusCode, 200);
  assert.equal(resumeResponse.body.paused, false);
  assert.equal(memory.values.has(key), false);
  assert.match(memory.calls.at(-1)[1], /redis.call\('DEL'/u);
});

test("unknown pause scopes are rejected before any KV operation", async () => {
  const memory = memoryControl();
  const res = response();
  await handleBackgroundPause(operatorRequest({
    method: "POST",
    body: { action: "pause", pauseId: PAUSE_ID, scope: "arbitrary-kv-key" },
  }), res, { env: OPERATOR_ENV, controlImpl: memory.control });
  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, { ok: false, error: "invalid_scope" });
  assert.equal(memory.calls.length, 0);
});

test("non-booking health returns paused before a provider fetch", async () => {
  const previousCookie = process.env.PARAFORM_SESSION_COOKIE;
  process.env.PARAFORM_SESSION_COOKIE = "test-cookie";
  const originalFetch = globalThis.fetch;
  let providerCalls = 0;
  globalThis.fetch = async () => { providerCalls += 1; throw new Error("provider IO forbidden"); };
  try {
    assert.deepEqual(await paraformHealth({ pauseState: paused }), {
      paraform: "paused",
      paused: true,
      pauseControlState: "configured",
    });
    assert.equal(providerCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
    if (previousCookie === undefined) delete process.env.PARAFORM_SESSION_COOKIE;
    else process.env.PARAFORM_SESSION_COOKIE = previousCookie;
  }
});

test("Activity feed serves the retained cache while paused and does not rebuild", async () => {
  const previousCron = process.env.CRON_SECRET;
  process.env.CRON_SECRET = "cron-test-secret";
  const cached = {
    generatedAt: "2026-09-17T12:00:00.000Z",
    queues: { needs_reply: [{ key: "application-1" }], gone_quiet: [] },
    counts: { needs_reply: 1, gone_quiet: 0 },
    pairsScanned: 1,
    paused: false,
    controlState: "stale-cache-must-not-override-control",
  };
  const originalFetch = globalThis.fetch;
  let providerCalls = 0;
  globalThis.fetch = async () => { providerCalls += 1; throw new Error("provider IO forbidden"); };
  try {
    const res = response();
    await handleActivityFeed({
      method: "GET",
      headers: { authorization: "Bearer cron-test-secret" },
      query: { refresh: "1" },
    }, res, {
      pauseState: paused,
      getJsonImpl: async () => cached,
      hgetallJsonImpl: async () => ({}),
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.cached, true);
    assert.equal(res.body.stale, true);
    assert.equal(res.body.paused, true);
    assert.equal(res.body.controlState, "configured");
    assert.equal(res.body.counts.open_needs_reply, 1);
    assert.equal(providerCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
    if (previousCron === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = previousCron;
  }
});

test("Activity UI labels a retained paused snapshot instead of claiming live", async () => {
  const html = await readFile(new URL("../activity.html", import.meta.url), "utf8");
  assert.match(html, /if\(data\.paused\)/u);
  assert.match(html, /paused · cached/u);
  assert.match(html, /Showing the retained Activity snapshot/u);
});

test("Activity digest pause is an explicit failure before cookie or provider work", async () => {
  let cookieChecks = 0;
  const res = response();
  await handleActivityDigest({ method: "GET", headers: {} }, res, {
    cronAuthorize: () => ({ ok: true }),
    pauseState: paused,
    cookiePresent: () => { cookieChecks += 1; return true; },
  });
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.error, "paraform_background_paused");
  assert.equal(cookieChecks, 0);
});

test("Inbox sync pause preserves the stored snapshot by stopping before lock/build/write", async () => {
  const calls = [];
  const handler = createInboxSyncHandler({
    corsHandler: () => false,
    authHandler: async () => true,
    pauseState: paused,
    acquireLock: async () => { calls.push("lock"); return { status: "acquired", token: "x" }; },
    readState: async () => { calls.push("read"); return { status: "ready", value: {} }; },
    buildRefresh: async () => { calls.push("build"); return {}; },
    writeState: async () => { calls.push("write"); return {}; },
  });
  const res = response();
  await handler({
    method: "POST",
    headers: { "content-type": "application/json" },
    body: {},
  }, res);
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.error, "paraform_background_paused");
  assert.deepEqual(calls, []);
});

test("Inbox UI distinguishes a paused reader from provider failure", async () => {
  const html = await readFile(new URL("../inbox.html", import.meta.url), "utf8");
  assert.match(html, /health\.paraform==="paused"/u);
  assert.match(html, /error\.code==="paraform_background_paused"/u);
  assert.match(html, /retained Inbox snapshot/u);
});

test("V1 automatic and manual refresh stop before state or provider work", async () => {
  for (const method of ["GET", "POST"]) {
    const calls = [];
    const res = response();
    await handleSubmissionsRefresh({ method, headers: {} }, res, {
      cronAuthHandler: () => true,
      humanAuthHandler: async () => true,
      pauseState: paused,
      configured: () => { calls.push("configured"); return true; },
      sync: async () => { calls.push("sync"); return { ok: true }; },
    });
    assert.equal(res.statusCode, 503);
    assert.equal(res.body.error, "paraform_background_paused");
    assert.deepEqual(calls, []);
  }
});

test("V1 credits pause stops before the provider read", async () => {
  let reads = 0;
  const res = response();
  await handleSubmissionCredits({ method: "GET", headers: {} }, res, {
    auth: async () => true,
    pauseState: paused,
    readCredits: async () => { reads += 1; return {}; },
  });
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.error, "paraform_background_paused");
  assert.equal(reads, 0);
});

test("absent dashboard pause preserves refresh and credits behavior", async () => {
  const refresh = response();
  await handleSubmissionsRefresh({ method: "GET", headers: {} }, refresh, {
    cronAuthHandler: () => true,
    pauseState: async () => ({ paused: false, state: "absent" }),
    configured: () => true,
    sync: async (options) => ({ ok: true, options }),
  });
  assert.equal(refresh.statusCode, 200);
  assert.deepEqual(refresh.body, { ok: true, options: { force: false } });

  const credits = response();
  await handleSubmissionCredits({ method: "GET", headers: {} }, credits, {
    auth: async () => true,
    pauseState: async () => ({ paused: false, state: "absent" }),
    readCredits: async () => ({ available: 3 }),
  });
  assert.equal(credits.statusCode, 200);
  assert.deepEqual(credits.body, { ok: true, credits: { available: 3 } });
});
