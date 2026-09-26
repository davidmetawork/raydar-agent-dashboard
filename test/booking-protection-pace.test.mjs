// Pacer + single-shot Paraform caller for the lightweight booking-protection
// system (docs/research/booking-protection-minimum-2026-09-26.md item 6:
// "Pace every Paraform request at <= 10/min ... one in flight; when the
// session is refused, wait (Retry-After or 60s, whichever is longer) instead
// of retrying hard; count every request.").
process.env.PARAFORM_COOKIE ||= "Fe26.2**test-cookie";

import test from "node:test";
import assert from "node:assert/strict";

import {
  createPacer,
  singleShotTrpc,
  PACE_MIN_INTERVAL_MS,
  PACE_DEFAULT_BACKOFF_MS,
} from "../api/seq/_lib/booking-protection-pace.mjs";

function fakeClock(start) {
  let now = start;
  return {
    now: () => now,
    advance: (ms) => { now += ms; },
  };
}

test("one in flight: enforces the minimum interval between requests", async () => {
  const clock = fakeClock(1_000_000);
  let state = null;
  const sleeps = [];
  const pace = createPacer({
    loadState: async () => state,
    saveState: async (value) => { state = value; },
    incrementCount: async () => {},
    now: clock.now,
    sleep: async (ms) => { sleeps.push(ms); clock.advance(ms); },
  });

  await pace(async () => "first");
  assert.equal(sleeps.length, 0, "no wait before the very first request");

  clock.advance(1000); // only 1s has passed since the first call
  await pace(async () => "second");
  assert.equal(sleeps.length, 1);
  assert.equal(sleeps[0], PACE_MIN_INTERVAL_MS - 1000);
});

test("counts every request, including ones that fail", async () => {
  const clock = fakeClock(1_000_000);
  let state = null;
  const counted = [];
  const pace = createPacer({
    loadState: async () => state,
    saveState: async (value) => { state = value; },
    incrementCount: async (day) => { counted.push(day); },
    now: clock.now,
    sleep: async () => {},
  });

  await pace(async () => "ok").catch(() => {});
  await pace(async () => { throw new Error("refused"); }).catch(() => {});
  assert.equal(counted.length, 2);
});

test("on refusal, backs off for max(retryAfterMs, 60s) and blocks the next call until then", async () => {
  const clock = fakeClock(1_000_000);
  let state = null;
  const pace = createPacer({
    loadState: async () => state,
    saveState: async (value) => { state = value; },
    incrementCount: async () => {},
    now: clock.now,
    sleep: async (ms) => { clock.advance(ms); },
  });

  const refused = Object.assign(new Error("refused"), { retryAfterMs: 5_000 });
  await assert.rejects(() => pace(async () => { throw refused; }));
  assert.equal(state.backoffUntil, clock.now() + PACE_DEFAULT_BACKOFF_MS, "5s Retry-After is shorter than the 60s floor, so the floor wins");

  await assert.rejects(
    () => pace(async () => "should not run"),
    (error) => error.code === "PARAFORM_PACED_BACKOFF",
  );

  clock.advance(PACE_DEFAULT_BACKOFF_MS + 1);
  const result = await pace(async () => "resumed");
  assert.equal(result, "resumed");
});

test("a longer Retry-After wins over the 60s floor", async () => {
  const clock = fakeClock(1_000_000);
  let state = null;
  const pace = createPacer({
    loadState: async () => state,
    saveState: async (value) => { state = value; },
    incrementCount: async () => {},
    now: clock.now,
    sleep: async () => {},
  });
  const refused = Object.assign(new Error("refused"), { retryAfterMs: 120_000 });
  await assert.rejects(() => pace(async () => { throw refused; }));
  assert.equal(state.backoffUntil, clock.now() + 120_000);
});

test("singleShotTrpc makes exactly one attempt and classifies a refusal with its Retry-After header", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return new Response(null, { status: 401, headers: { "retry-after": "45" } });
  };
  await assert.rejects(
    () => singleShotTrpc("GET", "campaigns.getListOfCampaignsOptimized", {}, { fetchImpl }),
    (error) => error.code === "PARAFORM_REFUSED_AUTH" && error.retryAfterMs === 45_000,
  );
  assert.equal(calls, 1, "no internal retry ladder — the pacer decides what happens next");
});

test("singleShotTrpc surfaces a 500 without a Retry-After as retryAfterMs 0", async () => {
  const fetchImpl = async () => new Response(null, { status: 500 });
  await assert.rejects(
    () => singleShotTrpc("POST", "campaigns.updateCandidatePauseStatus", { a: 1 }, { fetchImpl }),
    (error) => error.code === "PARAFORM_REFUSED" && error.retryAfterMs === 0,
  );
});

test("singleShotTrpc returns result.data.json on success and throws on a trpc-shaped error body", async () => {
  const ok = await singleShotTrpc("GET", "campaigns.getListOfCampaignsOptimized", {}, {
    fetchImpl: async () => Response.json({ result: { data: { json: [{ id: "seq_1" }] } } }),
  });
  assert.deepEqual(ok, [{ id: "seq_1" }]);

  await assert.rejects(
    () => singleShotTrpc("GET", "campaigns.getListOfCampaignsOptimized", {}, {
      fetchImpl: async () => Response.json({ error: { json: { message: "nope" } } }),
    }),
    (error) => error.code === "PARAFORM_TRPC_ERROR",
  );
});
