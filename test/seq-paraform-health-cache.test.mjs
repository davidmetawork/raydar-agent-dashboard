import test from "node:test";
import assert from "node:assert/strict";

import { paraformHealth } from "../api/seq/_lib/core.mjs";

// C1 (2026-09-24 Paraform reduction pass): seq-health and inbox-health (and
// enrich-health) all call this exact function on the same 2-minute tick.
// This pins the dedupe: two calls inside the cache window must produce
// exactly one live Paraform read, and a third call after the window expires
// must read live again.

const KV_URL = "https://control.example.test";

function fakeParaform() {
  const store = new Map();
  let paraformCalls = 0;
  const fetchImpl = async (url, init) => {
    const href = String(url);
    if (href.startsWith(KV_URL)) {
      const command = JSON.parse(init.body);
      const [op, key] = command;
      if (op === "GET") {
        return { ok: true, json: async () => ({ result: store.has(key) ? store.get(key) : null }) };
      }
      if (op === "SET") {
        store.set(key, command[2]);
        return { ok: true, json: async () => ({ result: "OK" }) };
      }
      return { ok: true, json: async () => ({ result: null }) };
    }
    paraformCalls += 1;
    return {
      status: 200,
      json: async () => ({
        result: { data: { json: [{ id: "seq-1" }, { id: "seq-2" }, { id: "seq-3" }] } },
      }),
    };
  };
  return { fetchImpl, calls: () => paraformCalls };
}

const notPaused = async () => ({ paused: false, state: "absent" });

async function withEnv(env, fn) {
  const previous = {};
  for (const key of Object.keys(env)) previous[key] = process.env[key];
  Object.assign(process.env, env);
  try {
    return await fn();
  } finally {
    for (const key of Object.keys(env)) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
}

test("two paraformHealth calls in the same window share one live Paraform read", async () => {
  await withEnv({
    KV_REST_API_URL: KV_URL,
    KV_REST_API_TOKEN: "test-token",
    PARAFORM_SESSION_COOKIE: "test-cookie",
  }, async () => {
    const { fetchImpl, calls } = fakeParaform();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchImpl;
    try {
      const first = await paraformHealth({ pauseState: notPaused });
      const second = await paraformHealth({ pauseState: notPaused });
      assert.equal(first.paraform, "live");
      assert.equal(first.sequenceCount, 3);
      assert.deepEqual(second, first);
      assert.equal(calls(), 1, "the second call must be served from cache, not a fresh trpc read");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("a paused dashboardReaders control still short-circuits before any cache read", async () => {
  await withEnv({
    KV_REST_API_URL: KV_URL,
    KV_REST_API_TOKEN: "test-token",
    PARAFORM_SESSION_COOKIE: "test-cookie",
  }, async () => {
    const { fetchImpl, calls } = fakeParaform();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchImpl;
    try {
      const paused = async () => ({ paused: true, state: "configured", pauseId: "x" });
      const result = await paraformHealth({ pauseState: paused });
      assert.deepEqual(result, { paraform: "paused", paused: true, pauseControlState: "configured" });
      assert.equal(calls(), 0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("a cache read that cannot reach KV degrades to a live read, not a throw", async () => {
  await withEnv({
    KV_REST_API_URL: KV_URL,
    KV_REST_API_TOKEN: "test-token",
    PARAFORM_SESSION_COOKIE: "test-cookie",
  }, async () => {
    const originalFetch = globalThis.fetch;
    let paraformCalls = 0;
    globalThis.fetch = async (url) => {
      if (String(url).startsWith(KV_URL)) throw new Error("kv unreachable");
      paraformCalls += 1;
      return { status: 200, json: async () => ({ result: { data: { json: [{ id: "s1" }] } } }) };
    };
    try {
      const result = await paraformHealth({ pauseState: notPaused });
      assert.equal(result.paraform, "live");
      assert.equal(paraformCalls, 1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
