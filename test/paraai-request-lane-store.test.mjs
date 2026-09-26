import test from "node:test";
import assert from "node:assert/strict";

// request-lane-store.mjs (2026-09-26 review finding): the throttle state it
// holds (cooldown, cadence, rate bucket, counters) must be shared BETWEEN the
// outreach and expired lanes, so its env fallback order has to match the
// established convention for cross-lane-shared state — PARAAI_REPLY_* first,
// same as request-claim.mjs (the cross-lane arbitration store) and
// expired-store.mjs — not default straight to the outreach-only prefix.
// PARAAI_REPLY_*, PARAAI_OUTREACH_*, PARAAI_INTEREST_* and PARAAI_SOURCE_*
// are independently-set env vars in this repo and are not guaranteed to
// point at the same physical Upstash instance.
//
// The module reads its KV_URL/KV_TOKEN once, at import time, from
// process.env — so exercising each fallback branch needs a fresh module
// instance per case. A cache-busting query string on the specifier gives
// each case its own module graph without needing a subprocess.
const MODULE_URL = new URL("../api/paraai/_lib/request-lane-store.mjs", import.meta.url).href;

const ENV_KEYS = [
  "PARAAI_REPLY_KV_REST_API_URL",
  "PARAAI_REPLY_KV_REST_API_TOKEN",
  "PARAAI_OUTREACH_KV_REST_API_URL",
  "PARAAI_OUTREACH_KV_REST_API_TOKEN",
  "KV_REST_API_URL",
  "KV_REST_API_TOKEN",
];

async function withEnv(env, fn) {
  const saved = {};
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  Object.assign(process.env, env);
  const originalFetch = globalThis.fetch;
  try {
    return await fn();
  } finally {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    globalThis.fetch = originalFetch;
  }
}

function mockFetchRecordingUrls(seenUrls) {
  globalThis.fetch = async (url) => {
    seenUrls.push(String(url));
    return new Response(JSON.stringify({ result: "OK" }), { status: 200 });
  };
}

test("request-lane-store: PARAAI_REPLY_* wins over PARAAI_OUTREACH_*, matching request-claim.mjs/expired-store.mjs's cross-lane convention", async () => {
  await withEnv({
    PARAAI_REPLY_KV_REST_API_URL: "https://reply-kv.request-lane-store.test",
    PARAAI_REPLY_KV_REST_API_TOKEN: "reply-token",
    PARAAI_OUTREACH_KV_REST_API_URL: "https://outreach-kv.request-lane-store.test",
    PARAAI_OUTREACH_KV_REST_API_TOKEN: "outreach-token",
  }, async () => {
    const seenUrls = [];
    mockFetchRecordingUrls(seenUrls);
    const { requestLaneKv, requestLaneStoreConfigured } = await import(`${MODULE_URL}?case=reply-wins`);
    assert.equal(requestLaneStoreConfigured(), true);
    await requestLaneKv(["GET", "x"]);
    assert.ok(
      seenUrls[0]?.startsWith("https://reply-kv.request-lane-store.test"),
      `expected the shared PARAAI_REPLY_* store, got ${seenUrls[0]}`,
    );
  });
});

test("request-lane-store: falls back to PARAAI_OUTREACH_* when PARAAI_REPLY_* is unset", async () => {
  await withEnv({
    PARAAI_OUTREACH_KV_REST_API_URL: "https://outreach-kv.request-lane-store.test",
    PARAAI_OUTREACH_KV_REST_API_TOKEN: "outreach-token",
  }, async () => {
    const seenUrls = [];
    mockFetchRecordingUrls(seenUrls);
    const { requestLaneKv, requestLaneStoreConfigured } = await import(`${MODULE_URL}?case=outreach-fallback`);
    assert.equal(requestLaneStoreConfigured(), true);
    await requestLaneKv(["GET", "x"]);
    assert.ok(seenUrls[0]?.startsWith("https://outreach-kv.request-lane-store.test"));
  });
});

test("request-lane-store: falls back to the generic KV_REST_API_URL when neither PARAAI prefix is set", async () => {
  await withEnv({
    KV_REST_API_URL: "https://generic-kv.request-lane-store.test",
    KV_REST_API_TOKEN: "generic-token",
  }, async () => {
    const seenUrls = [];
    mockFetchRecordingUrls(seenUrls);
    const { requestLaneKv, requestLaneStoreConfigured } = await import(`${MODULE_URL}?case=generic-fallback`);
    assert.equal(requestLaneStoreConfigured(), true);
    await requestLaneKv(["GET", "x"]);
    assert.ok(seenUrls[0]?.startsWith("https://generic-kv.request-lane-store.test"));
  });
});

test("request-lane-store: reports unconfigured, not a crash, when nothing is set", async () => {
  await withEnv({}, async () => {
    const { requestLaneStoreConfigured } = await import(`${MODULE_URL}?case=unconfigured`);
    assert.equal(requestLaneStoreConfigured(), false);
  });
});
