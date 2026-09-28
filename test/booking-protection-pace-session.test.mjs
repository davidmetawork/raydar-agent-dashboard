// The booking-protection pacer and a dead Paraform session. Measured
// 2026-09-27/28: the daily live-set refresh failed twice with
// PARAFORM_HTTP_401 while the shared n8n slot was dead and the 'david' slot
// was live, because the pacer's single-shot client never reported a 401 and
// so never moved off the dead slot. These tests run the production shape: a
// store with a shared and an account session, and a dead env seal underneath.
// The pacer must leave a session only after serial probes of that exact
// cookie confirm it dead (core.mjs unauthorizedRead), keep every probe paced
// and counted, and never park anything on a throttle 401.
import test from "node:test";
import assert from "node:assert/strict";

import {
  createPacer,
  pacedApplyDecisionsOverrides,
  pacedTrpcClient,
  PACE_DEFAULT_BACKOFF_MS,
  PACE_MIN_INTERVAL_MS,
  sessionFingerprint,
  __resetPacerSessionMemoryForTests,
} from "../api/seq/_lib/booking-protection-pace.mjs";
import {
  ensureParaformSession,
  __resetSessionExpiryChecksForTests,
} from "../api/seq/_lib/core.mjs";
import { __resetParaformSessionStateForTests } from "../api/_lib/paraform-session-store.mjs";

const SHARED = `Fe26.2${"s".repeat(70)}`;
const ACCOUNT = `Fe26.2${"a".repeat(70)}`;
const ENV_SEAL = `Fe26.2${"e".repeat(70)}`;
const N8N = "https://n8n.example.test";
const SHARED_ROWS = [
  { key: "PARAFORM_SESSION_COOKIE_G1_1", value: SHARED },
  { key: "PARAFORM_SESSION_COOKIE_G1_PARTS", value: "1" },
];
const ACCOUNT_ROWS = [
  { key: "PARAFORM_DAVID_SESSION_G1_1", value: ACCOUNT },
  { key: "PARAFORM_DAVID_SESSION_G1_PARTS", value: "1" },
];
const CATALOG = "campaigns.getListOfCampaignsOptimized";

const sentCookie = (init) => String(init?.headers?.cookie || "").replace(/^[^=]+=/u, "");
const ok = (json) => Response.json({ result: { data: { json } } });
const unauthorized = (retryAfterSeconds) => new Response(null, {
  status: 401,
  headers: retryAfterSeconds ? { "retry-after": String(retryAfterSeconds) } : {},
});

// A process whose resolver settled on the shared store session, with a stub
// Paraform behind `answer(cookie, row, harness)`. Every Paraform request is
// recorded with the pacer's clock time. n8n reads answer from `rows`.
// `freshProcess()` drops everything a new serverless instance would not
// have (the store cache and parks, the pacer's in-process memory) while the
// KV state survives, and re-resolves the store.
async function withStoreSession(options, run) {
  const { answer, saveState = null } = options;
  const env = {
    N8N_BASE_URL: N8N,
    N8N_API_KEY: "test-n8n-key",
    PARAFORM_SESSION_COOKIE: ENV_SEAL,
    PARAFORM_THROTTLE_DELAYS_MS: "0,0,0",
    PARAFORM_PROBE_DELAY_MS: "0",
  };
  const saved = {};
  for (const key of Object.keys(env)) {
    saved[key] = process.env[key];
    process.env[key] = env[key];
  }
  let clockMs = 5_000_000;
  let state = null;
  const counted = [];
  const sent = [];
  const makePacer = () => createPacer({
    loadState: async () => state,
    saveState: saveState
      ? async (value) => { state = await saveState(value, state); }
      : async (value) => { state = value; },
    incrementCount: async (day) => { counted.push(day); },
    now: () => clockMs,
    sleep: async (ms) => { clockMs += ms; },
    log: () => {},
  });
  const harness = {
    pace: makePacer(),
    makePacer,
    sent,
    counted,
    now: () => clockMs,
    advance: (ms) => { clockMs += ms; },
    state: () => state,
    freshProcess: async () => {
      __resetParaformSessionStateForTests();
      __resetSessionExpiryChecksForTests();
      __resetPacerSessionMemoryForTests();
      return ensureParaformSession();
    },
  };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith(N8N)) {
      return Response.json({ data: options.rows }); // read per call: a test may reseed
    }
    const cookie = sentCookie(init);
    const row = { url: String(url), cookie, at: clockMs, body: init?.body ? JSON.parse(init.body) : null };
    sent.push(row);
    return answer(cookie, row, harness);
  };
  __resetParaformSessionStateForTests();
  __resetSessionExpiryChecksForTests();
  __resetPacerSessionMemoryForTests();
  try {
    assert.equal((await ensureParaformSession()).slot, "shared");
    return await run(harness);
  } finally {
    globalThis.fetch = realFetch;
    for (const key of Object.keys(env)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    __resetParaformSessionStateForTests();
    __resetSessionExpiryChecksForTests();
    __resetPacerSessionMemoryForTests();
  }
}

function assertPaced(sent) {
  for (let i = 1; i < sent.length; i += 1) {
    assert.ok(
      sent[i].at - sent[i - 1].at >= PACE_MIN_INTERVAL_MS,
      `request ${i} came ${sent[i].at - sent[i - 1].at}ms after the one before`,
    );
  }
}

test("a confirmed-dead store session moves the paced read to the next store session, every probe paced and counted", async () => {
  let heldDuringProbes = null;
  let otherInvocation = null;
  await withStoreSession({
    rows: [...SHARED_ROWS, ...ACCOUNT_ROWS],
    answer: async (cookie, row, harness) => {
      if (harness.sent.length === 2) {
        // The first probe: other invocations must be held off while it runs.
        heldDuringProbes = harness.state().backoffUntil > harness.now();
        otherInvocation = await harness.makePacer()(async () => "sent")
          .catch((error) => error.code);
      }
      return cookie === ACCOUNT ? ok([{ id: "seq_1" }]) : unauthorized();
    },
  }, async (harness) => {
    const catalog = await pacedTrpcClient(harness.pace).get(CATALOG, {});
    assert.deepEqual(catalog, [{ id: "seq_1" }]);

    const cookies = harness.sent.map((row) => row.cookie);
    assert.equal(cookies[0], SHARED, "the request went out on the held session");
    assert.equal(cookies.at(-1), ACCOUNT, "then exactly one attempt on the next store session");
    const probes = cookies.slice(1, -1);
    assert.equal(probes.length, 6, "three ladder probes plus three serial probes");
    assert.ok(probes.every((cookie) => cookie === SHARED), "every probe tested the cookie that got the 401");
    assert.ok(!cookies.includes(ENV_SEAL), "the env seal was never sent");

    assertPaced(harness.sent);
    assert.equal(harness.counted.length, harness.sent.length, "every request, probes included, is counted");
    assert.equal(heldDuringProbes, true);
    assert.equal(otherInvocation, "PARAFORM_PACED_BACKOFF", "another invocation waits while the probes run");
    assert.equal(harness.state().backoffUntil, null, "a moved success clears the hold");
    assert.deepEqual(
      harness.state().deadSessions.map((entry) => entry.fp),
      [sessionFingerprint(SHARED)],
      "only a fingerprint of the dead session is kept",
    );
    assert.ok(!JSON.stringify(harness.state()).includes(SHARED), "never the session value");

    const next = await ensureParaformSession();
    assert.equal(next.slot, "account", "the process now holds the account session");
    const fresh = await ensureParaformSession({ force: true });
    assert.equal(fresh.slot, "account", "and the dead shared slot is parked");
  });
});

test("a throttle 401 on a live session parks nothing, sends nothing elsewhere, and backs off as before", async () => {
  await withStoreSession({
    rows: [...SHARED_ROWS, ...ACCOUNT_ROWS],
    answer: async (cookie, row, harness) =>
      (harness.sent.length === 1 ? unauthorized() : ok([{ id: "seq_1" }])),
  }, async (harness) => {
    await assert.rejects(
      () => pacedTrpcClient(harness.pace).get(CATALOG, {}),
      (error) => error.code === "PARAFORM_REFUSED_AUTH" && error.message === "PARAFORM_HTTP_401",
    );
    assert.deepEqual(
      harness.sent.map((row) => row.cookie),
      [SHARED, SHARED],
      "one request and one clean probe of the same cookie",
    );
    assertPaced(harness.sent);
    assert.equal(harness.state().backoffUntil, harness.now() + PACE_DEFAULT_BACKOFF_MS);
    const next = await ensureParaformSession();
    assert.equal(next.cached, true, "a throttle must not invalidate the cache");
    assert.equal(next.slot, "shared", "a throttle must not park the slot");
  });
});

test("a dead session with no other store session fails as PARAFORM_SESSION_DEAD and never sends the env seal", async () => {
  await withStoreSession({
    rows: SHARED_ROWS,
    answer: async () => unauthorized(),
  }, async (harness) => {
    await assert.rejects(
      () => pacedTrpcClient(harness.pace).get(CATALOG, {}),
      (error) => error.code === "PARAFORM_SESSION_DEAD",
    );
    assert.equal(harness.sent.length, 7, "one request plus six probes, no second attempt");
    assert.ok(harness.sent.every((row) => row.cookie === SHARED), "never the env seal");
    assert.ok(harness.state().backoffUntil > harness.now());
  });
});

test("a 401 on the next session too is not confirmed again in the same call", async () => {
  await withStoreSession({
    rows: [...SHARED_ROWS, ...ACCOUNT_ROWS],
    answer: async () => unauthorized(),
  }, async (harness) => {
    await assert.rejects(
      () => pacedTrpcClient(harness.pace).get(CATALOG, {}),
      (error) => error.code === "PARAFORM_REFUSED_AUTH",
    );
    const cookies = harness.sent.map((row) => row.cookie);
    assert.equal(cookies.length, 8, "request, six probes, one attempt on the next session");
    assert.deepEqual(cookies.filter((cookie) => cookie === ACCOUNT), [ACCOUNT]);
    assertPaced(harness.sent);
    assert.ok(harness.state().backoffUntil >= harness.now() + PACE_DEFAULT_BACKOFF_MS);
  });
});

test("a pause refused on a dead session is sent once more, unchanged, on the next session", async () => {
  await withStoreSession({
    rows: [...SHARED_ROWS, ...ACCOUNT_ROWS],
    answer: async (cookie) => (cookie === ACCOUNT ? ok({ ok: true }) : unauthorized()),
  }, async (harness) => {
    await pacedApplyDecisionsOverrides(harness.pace).mutatePause("ccu_42");
    const pauses = harness.sent.filter((row) => row.url.includes("updateCandidatePauseStatus"));
    assert.deepEqual(pauses.map((row) => row.cookie), [SHARED, ACCOUNT]);
    assert.deepEqual(pauses[0].body, pauses[1].body, "the same pause, not a different write");
    assert.deepEqual(pauses[1].body.json, { campaign_to_candidate_user_id: "ccu_42", is_paused: true });
  });
});

test("a refusal that is not a 401 gets no probes", async () => {
  await withStoreSession({
    rows: [...SHARED_ROWS, ...ACCOUNT_ROWS],
    answer: async () => new Response(null, { status: 500 }),
  }, async (harness) => {
    await assert.rejects(
      () => pacedTrpcClient(harness.pace).get(CATALOG, {}),
      (error) => error.code === "PARAFORM_REFUSED",
    );
    assert.equal(harness.sent.length, 1);
    assert.equal((await ensureParaformSession()).slot, "shared");
  });
});

test("a 401 that carries Retry-After is a throttle: no probes, nothing parked", async () => {
  await withStoreSession({
    rows: [...SHARED_ROWS, ...ACCOUNT_ROWS],
    answer: async () => unauthorized(120),
  }, async (harness) => {
    await assert.rejects(
      () => pacedTrpcClient(harness.pace).get(CATALOG, {}),
      (error) => error.code === "PARAFORM_REFUSED_AUTH" && error.retryAfterMs === 120_000,
    );
    assert.equal(harness.sent.length, 1);
    assert.equal(harness.state().backoffUntil, harness.now() + 120_000);
    assert.equal((await ensureParaformSession()).slot, "shared");
  });
});

test("a fresh invocation skips a session another invocation confirmed dead, without sending on it", async () => {
  await withStoreSession({
    rows: [...SHARED_ROWS, ...ACCOUNT_ROWS],
    answer: async (cookie) => (cookie === ACCOUNT ? ok([{ id: "seq_1" }]) : unauthorized()),
  }, async (harness) => {
    await pacedTrpcClient(harness.pace).get(CATALOG, {});
    const before = harness.sent.length;

    // A new serverless instance: it resolves the shared slot again, and only
    // the KV state remembers that this exact session is dead.
    harness.advance(10 * 60 * 1000);
    assert.equal((await harness.freshProcess()).slot, "shared");
    const catalog = await pacedTrpcClient(harness.makePacer()).get(CATALOG, {});
    assert.deepEqual(catalog, [{ id: "seq_1" }]);
    assert.deepEqual(
      harness.sent.slice(before).map((row) => row.cookie),
      [ACCOUNT],
      "no request and no probes on the remembered-dead session",
    );
  });
});

test("the memory expires with the store's 30-minute window, and a reseeded value is never skipped", async () => {
  let rows = [...SHARED_ROWS, ...ACCOUNT_ROWS];
  const RESEEDED = `Fe26.2${"r".repeat(70)}`;
  await withStoreSession({
    get rows() { return rows; },
    answer: async (cookie) => (cookie === SHARED ? unauthorized() : ok([{ id: "seq_1" }])),
  }, async (harness) => {
    await pacedTrpcClient(harness.pace).get(CATALOG, {});

    // Reseeded ten minutes later: a new value in the shared slot.
    rows = [
      { key: "PARAFORM_SESSION_COOKIE_G2_1", value: RESEEDED },
      { key: "PARAFORM_SESSION_COOKIE_G2_PARTS", value: "1" },
      ...ACCOUNT_ROWS,
    ];
    harness.advance(10 * 60 * 1000);
    await harness.freshProcess();
    let before = harness.sent.length;
    await pacedTrpcClient(harness.makePacer()).get(CATALOG, {});
    assert.deepEqual(harness.sent.slice(before).map((row) => row.cookie), [RESEEDED]);

    // The old value again after 31 minutes: tested afresh, not skipped.
    rows = [...SHARED_ROWS, ...ACCOUNT_ROWS];
    harness.advance(31 * 60 * 1000);
    await harness.freshProcess();
    before = harness.sent.length;
    await pacedTrpcClient(harness.makePacer()).get(CATALOG, {});
    assert.equal(harness.sent[before].cookie, SHARED, "the expired memory no longer skips it");
  });
});

test("a call never moves onto a session already confirmed dead, even when the resolver falls back to it", async () => {
  // Only the shared slot is in the store and the env seal is dead too. After
  // the shared session is confirmed dead the process falls back to the env
  // seal; when that is confirmed dead as well, the resolver's all-parked
  // fallback hands back the shared session. The pacer must not send it.
  await withStoreSession({
    rows: SHARED_ROWS,
    answer: async () => unauthorized(),
  }, async (harness) => {
    await assert.rejects(
      () => pacedTrpcClient(harness.pace).get(CATALOG, {}),
      (error) => error.code === "PARAFORM_SESSION_DEAD",
    );
    harness.advance(PACE_DEFAULT_BACKOFF_MS + 1);
    const before = harness.sent.length;
    await assert.rejects(
      () => pacedTrpcClient(harness.pace).get(CATALOG, {}),
      (error) => error.code === "PARAFORM_SESSION_DEAD",
    );
    const second = harness.sent.slice(before).map((row) => row.cookie);
    assert.ok(second.length > 0 && second.every((cookie) => cookie === ENV_SEAL),
      "the process's own env fallback is tested, and the dead shared session is not re-sent");

    harness.advance(PACE_DEFAULT_BACKOFF_MS + 1);
    const third = harness.sent.length;
    await assert.rejects(
      () => pacedTrpcClient(harness.pace).get(CATALOG, {}),
      (error) => error.code === "PARAFORM_SESSION_DEAD",
    );
    assert.equal(harness.sent.length, third, "with every session known dead, nothing is sent");
    assert.equal(
      harness.state().backoffUntil,
      harness.now() + PACE_DEFAULT_BACKOFF_MS,
      "and the pacer backs off, so the next calls wait instead of re-reading the store",
    );
    await assert.rejects(
      () => pacedTrpcClient(harness.pace).get(CATALOG, {}),
      (error) => error.code === "PARAFORM_PACED_BACKOFF",
    );
  });
});

test("if the hold cannot be written, no probes run and the call backs off as before", async () => {
  let writes = 0;
  await withStoreSession({
    rows: [...SHARED_ROWS, ...ACCOUNT_ROWS],
    answer: async () => unauthorized(),
    saveState: async (value) => {
      writes += 1;
      if (writes === 1) throw new Error("kv down");
      return value;
    },
  }, async (harness) => {
    await assert.rejects(
      () => pacedTrpcClient(harness.pace).get(CATALOG, {}),
      (error) => error.code === "PARAFORM_REFUSED_AUTH",
    );
    assert.equal(harness.sent.length, 1, "no probes without the hold");
    assert.equal(harness.state().backoffUntil, harness.now() + PACE_DEFAULT_BACKOFF_MS);
    assert.equal((await ensureParaformSession()).slot, "shared");
  });
});
