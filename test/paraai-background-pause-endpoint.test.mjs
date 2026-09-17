import test from "node:test";
import assert from "node:assert/strict";

import { handleBackgroundPause } from "../api/paraai/background-pause.mjs";

const env = {
  PARAAI_AUTOMATION_RUNNER_KEY: "runner-only-secret",
  CRON_SECRET: "cron-is-not-an-operator",
  KV_REST_API_URL: "https://control.example.test",
  KV_REST_API_TOKEN: "test-token",
};

function response() {
  return {
    headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; },
  };
}

function request({ method = "GET", token = "runner-only-secret", body, query = {} } = {}) {
  return {
    method,
    headers: { authorization: `Bearer ${token}` },
    body,
    query,
  };
}

function memoryControl(initial = null) {
  let raw = initial;
  const calls = [];
  return {
    calls,
    get raw() { return raw; },
    async control(command) {
      calls.push(command);
      if (command[0] === "GET") return raw;
      assert.equal(command[0], "EVAL");
      const script = command[1];
      const expected = command[4];
      if (script.includes("redis.call('SET'")) {
        if (raw === null) { raw = expected; return 1; }
        return raw === expected ? 2 : 3;
      }
      if (raw === null) return 1;
      if (raw === expected) { raw = null; return 2; }
      return 3;
    },
  };
}

test("background pause endpoint rejects missing and wrong runner keys before KV", async () => {
  const memory = memoryControl();
  for (const token of ["", "wrong-secret", env.CRON_SECRET]) {
    const res = response();
    await handleBackgroundPause(request({ token }), res, {
      env,
      controlImpl: memory.control,
    });
    assert.equal(res.statusCode, 401);
    assert.equal(res.headers["Cache-Control"], "no-store");
    assert.deepEqual(res.body, { ok: false, error: "unauthorized" });
  }
  assert.equal(memory.calls.length, 0);
});

test("pause is atomic, non-expiring, and idempotent only for its exact record", async () => {
  const memory = memoryControl();
  for (const expected of [false, true]) {
    const res = response();
    await handleBackgroundPause(request({
      method: "POST",
      body: { action: "pause", pauseId: "incident-15394a4" },
    }), res, { env, controlImpl: memory.control });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.alreadyPaused, expected);
    assert.equal(res.body.paused, true);
    assert.equal(res.body.pauseId, "incident-15394a4");
  }
  assert.equal(memory.calls.length, 2);
  for (const command of memory.calls) {
    assert.equal(command[0], "EVAL");
    assert.equal(command[2], 1);
    assert.equal(command.length, 5, "no TTL argument may make the pause expire");
    assert.match(command[1], /SET[\s\S]*'NX'/);
  }
});

test("different or malformed stored records are ownership conflicts, never overwritten or deleted", async () => {
  for (const raw of [
    JSON.stringify({ pauseId: "another-incident", paused: true }),
    "not-json",
    JSON.stringify({ pauseId: "incident-15394a4", paused: false }),
  ]) {
    const memory = memoryControl(raw);
    for (const action of ["pause", "resume"]) {
      const res = response();
      await handleBackgroundPause(request({
        method: "POST",
        body: { action, pauseId: "incident-15394a4" },
      }), res, { env, controlImpl: memory.control });
      assert.equal(res.statusCode, 409);
      assert.deepEqual(res.body, { ok: false, error: "pause_state_conflict" });
    }
    assert.equal(memory.raw, raw);
  }
});

test("resume deletes only the exact owned record and absence is already resumed", async () => {
  const owned = JSON.stringify({ pauseId: "incident-15394a4", paused: true });
  const active = memoryControl(owned);
  const resumed = response();
  await handleBackgroundPause(request({
    method: "POST",
    body: { action: "resume", pauseId: "incident-15394a4" },
  }), resumed, { env, controlImpl: active.control });
  assert.equal(resumed.statusCode, 200);
  assert.equal(resumed.body.alreadyResumed, false);
  assert.equal(active.raw, null);
  assert.equal(active.calls[0][0], "EVAL");
  assert.match(active.calls[0][1], /redis.call\('DEL'/);

  const absent = memoryControl();
  const already = response();
  await handleBackgroundPause(request({
    method: "POST",
    body: { action: "resume", pauseId: "incident-15394a4" },
  }), already, { env, controlImpl: absent.control });
  assert.equal(already.statusCode, 200);
  assert.equal(already.body.alreadyResumed, true);
  assert.equal(already.body.paused, false);
  assert.equal(absent.raw, null);
});

test("status is sanitized and control failures return 503", async () => {
  const active = memoryControl(JSON.stringify({ pauseId: "incident-15394a4", paused: true }));
  const ok = response();
  await handleBackgroundPause(request(), ok, { env, controlImpl: active.control });
  assert.deepEqual(ok.body, {
    ok: true,
    paused: true,
    controlState: "paused",
    pauseId: "incident-15394a4",
  });

  const malformed = memoryControl("private arbitrary raw value");
  const invalid = response();
  await handleBackgroundPause(request(), invalid, { env, controlImpl: malformed.control });
  assert.deepEqual(invalid.body, {
    ok: true,
    paused: true,
    controlState: "invalid",
    pauseId: null,
  });

  const unavailable = response();
  await handleBackgroundPause(request(), unavailable, {
    env,
    controlImpl: async () => { throw new Error("not exposed"); },
  });
  assert.equal(unavailable.statusCode, 503);
  assert.deepEqual(unavailable.body, { ok: false, error: "pause_control_unavailable" });

  const nonOk = response();
  await handleBackgroundPause(request(), nonOk, {
    env,
    fetchImpl: async () => new Response("unavailable", { status: 503 }),
  });
  assert.equal(nonOk.statusCode, 503);
  assert.deepEqual(nonOk.body, { ok: false, error: "pause_control_unavailable" });
});
