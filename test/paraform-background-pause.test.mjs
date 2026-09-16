import test from "node:test";
import assert from "node:assert/strict";

import {
  PARAFORM_BACKGROUND_PAUSE_KEYS,
  paraformBackgroundPauseState,
} from "../api/_lib/paraform-background-pause.mjs";
import { handleParaaiWorker } from "../api/paraai/worker.mjs";
import { handleParaaiHealth } from "../api/paraai/health.mjs";

const controlEnv = {
  KV_REST_API_URL: "https://control.example.test",
  KV_REST_API_TOKEN: "test-token",
};

function nodeResponse() {
  return {
    headers: {},
    body: null,
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; },
    end() { this.ended = true; return this; },
  };
}

test("background pause accepts only the two-field operator record and preserves absence", async () => {
  const calls = [];
  const absent = await paraformBackgroundPauseState("paraaiWorker", {
    env: controlEnv,
    fetchImpl: async (_url, init) => {
      calls.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ result: null }));
    },
  });
  assert.deepEqual(absent, { paused: false, state: "absent" });
  assert.deepEqual(calls, [["GET", PARAFORM_BACKGROUND_PAUSE_KEYS.paraaiWorker]]);

  const paused = await paraformBackgroundPauseState("paraaiWorker", {
    env: controlEnv,
    fetchImpl: async () => new Response(JSON.stringify({
      result: JSON.stringify({ pauseId: "incident-2026-09-16", paused: true }),
    })),
  });
  assert.deepEqual(paused, { paused: true, state: "configured" });
});

test("background pause fails closed for missing control configuration and malformed records", async () => {
  assert.deepEqual(
    await paraformBackgroundPauseState("paraaiWorker", { env: {}, fetchImpl: async () => null }),
    { paused: true, state: "unreadable" },
  );
  assert.deepEqual(
    await paraformBackgroundPauseState("paraaiWorker", {
      env: controlEnv,
      fetchImpl: async () => new Response(JSON.stringify({
        result: JSON.stringify({ pauseId: "wrong-shape", paused: true, extra: "not-allowed" }),
      })),
    }),
    { paused: true, state: "unreadable" },
  );
});

test("ParaAI worker pause covers recovery, tick, and status before dispatch", async () => {
  const previous = process.env.PARAAI_AUTOMATION_RUNNER_KEY;
  process.env.PARAAI_AUTOMATION_RUNNER_KEY = "test-worker-secret";
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => { fetchCalls++; throw new Error("provider IO must not occur"); };
  try {
    for (const request of [
      // GET without mode is the Vercel cron's recovery entrypoint.
      { method: "GET", headers: { authorization: "Bearer test-worker-secret" }, query: {} },
      { method: "POST", headers: { authorization: "Bearer test-worker-secret" }, body: { mode: "tick" }, query: {} },
      { method: "GET", headers: { authorization: "Bearer test-worker-secret" }, query: { mode: "status" } },
    ]) {
      const response = nodeResponse();
      await handleParaaiWorker(request, response, {
        pauseState: async () => ({ paused: true }),
      });
      assert.equal(response.statusCode, 200);
      assert.deepEqual(response.body, {
        ok: true,
        paused: true,
        reason: "paraai_worker_paused",
      });
    }
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
    if (previous == null) delete process.env.PARAAI_AUTOMATION_RUNNER_KEY;
    else process.env.PARAAI_AUTOMATION_RUNNER_KEY = previous;
  }
});

test("ParaAI health pause returns no provider/readiness claim before Paraform probes", async () => {
  const response = nodeResponse();
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => { fetchCalls++; throw new Error("provider IO must not occur"); };
  try {
    await handleParaaiHealth({ method: "GET", headers: {}, query: {} }, response, {
      pauseState: async () => ({ paused: true }),
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.ok, false);
  assert.equal(response.body.paused, true);
  assert.equal(response.body.paraform, "paused");
  assert.equal(response.body.submitReady, false);
  assert.equal(response.body.enrollmentReady, false);
  assert.equal(response.body.matchShadowReady, false);
  assert.equal(response.body.automation.ready, false);
  assert.equal(response.body.outreach.executionReady, false);
  assert.equal(fetchCalls, 0);
  assert.equal(response.body.talentNetwork, null);
  assert.equal(response.body.quota, null);
});

test("an unpaused ParaAI worker retains GET recovery and POST tick routing", async () => {
  const priorRunner = process.env.PARAAI_AUTOMATION_RUNNER_KEY;
  const priorUrl = process.env.KV_REST_API_URL;
  const priorToken = process.env.KV_REST_API_TOKEN;
  process.env.PARAAI_AUTOMATION_RUNNER_KEY = "test-worker-secret";
  delete process.env.KV_REST_API_URL;
  delete process.env.KV_REST_API_TOKEN;
  try {
    for (const request of [
      { method: "GET", headers: { authorization: "Bearer test-worker-secret" }, query: {} },
      { method: "POST", headers: { authorization: "Bearer test-worker-secret" }, body: { mode: "tick" }, query: {} },
    ]) {
      const response = nodeResponse();
      await handleParaaiWorker(request, response, {
        pauseState: async () => ({ paused: false }),
      });
      // This is the worker's existing pre-dispatch failure, proving the pause
      // guard did not turn either automatic entrypoint into a paused no-op.
      assert.equal(response.statusCode, 503);
      assert.deepEqual(response.body, {
        ok: false,
        error: "state_store_not_configured",
      });
    }
  } finally {
    if (priorRunner == null) delete process.env.PARAAI_AUTOMATION_RUNNER_KEY;
    else process.env.PARAAI_AUTOMATION_RUNNER_KEY = priorRunner;
    if (priorUrl == null) delete process.env.KV_REST_API_URL;
    else process.env.KV_REST_API_URL = priorUrl;
    if (priorToken == null) delete process.env.KV_REST_API_TOKEN;
    else process.env.KV_REST_API_TOKEN = priorToken;
  }
});
