import test from "node:test";
import assert from "node:assert/strict";

import handler, { runLifecycleWatchdogRelay } from "../api/ops/lifecycle-watchdog-relay.mjs";

const NOW = Date.parse("2026-08-09T04:00:00Z");

function response(status, body = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    async json() { return body; },
  };
}

test("recent workflow run suppresses a redundant dispatch", async () => {
  const calls = [];
  const result = await runLifecycleWatchdogRelay({
    token: "test-token",
    nowMs: NOW,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return response(200, {
        workflow_runs: [{ id: 12, created_at: "2026-08-09T03:45:00Z" }],
      });
    },
  });

  assert.equal(result.action, "skipped_recent_run");
  assert.equal(result.ageMin, 15);
  assert.equal(calls.length, 1);
});

test("stale workflow run dispatches main exactly once", async () => {
  const calls = [];
  const result = await runLifecycleWatchdogRelay({
    token: "test-token",
    nowMs: NOW,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (url.endsWith("/dispatches")) return response(204);
      return response(200, {
        workflow_runs: [{ id: 11, created_at: "2026-08-09T03:20:00Z" }],
      });
    },
  });

  assert.equal(result.action, "dispatched");
  assert.equal(result.previousAgeMin, 40);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].options.method, "POST");
  assert.deepEqual(JSON.parse(calls[1].options.body), { ref: "main" });
});

test("an empty workflow history dispatches the bootstrap run", async () => {
  let count = 0;
  const result = await runLifecycleWatchdogRelay({
    token: "test-token",
    nowMs: NOW,
    fetchImpl: async (_url, options) => {
      count++;
      return options.method === "POST" ? response(204) : response(200, { workflow_runs: [] });
    },
  });
  assert.equal(result.action, "dispatched");
  assert.equal(count, 2);
});

test("missing or rejected credentials fail closed", async () => {
  assert.deepEqual(
    await runLifecycleWatchdogRelay({ token: "" }),
    { ok: false, status: 503, error: "dispatch_token_missing" },
  );
  const result = await runLifecycleWatchdogRelay({
    token: "bad-token",
    fetchImpl: async () => response(401),
  });
  assert.deepEqual(result, { ok: false, status: 502, error: "github_read_rejected" });
});

test("a rejected dispatch never reports success", async () => {
  const result = await runLifecycleWatchdogRelay({
    token: "test-token",
    nowMs: NOW,
    fetchImpl: async (_url, options) => options.method === "POST"
      ? response(403)
      : response(200, { workflow_runs: [{ created_at: "2026-08-09T03:00:00Z" }] }),
  });
  assert.deepEqual(result, { ok: false, status: 502, error: "github_dispatch_rejected" });
});

test("a transient GitHub error is retried before the relay gives up", async () => {
  let attempts = 0;
  const result = await runLifecycleWatchdogRelay({
    token: "test-token",
    nowMs: NOW,
    fetchImpl: async () => {
      attempts++;
      if (attempts === 1) return response(503);
      return response(200, {
        workflow_runs: [{ id: 12, created_at: "2026-08-09T03:45:00Z" }],
      });
    },
  });
  assert.equal(attempts, 2);
  assert.equal(result.action, "skipped_recent_run");
});

test("the handler rejects forged cron headers without calling GitHub", async () => {
  const previous = process.env.CRON_SECRET;
  process.env.CRON_SECRET = "s3cret";
  let status = null;
  let body = null;
  const res = {
    setHeader() {},
    status(value) { status = value; return this; },
    json(value) { body = value; return this; },
  };
  try {
    await handler({ headers: { "x-vercel-cron": "1" } }, res);
    assert.equal(status, 401);
    assert.equal(body.ok, false);
  } finally {
    if (previous === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = previous;
  }
});
