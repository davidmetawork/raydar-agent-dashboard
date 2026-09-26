// The background matcher (item 3 of docs/research/booking-protection-minimum-
// 2026-09-26.md): drains what the always-answer-OK webhooks only ever
// enqueue. These are the direct descendants of five tests that used to live
// in test/raydar-booking-stop.test.mjs against the hook directly, back when
// the hook paused inline (see that file's comment at the same spot).
process.env.PARAFORM_COOKIE ||= "Fe26.2**test-cookie";

import test from "node:test";
import assert from "node:assert/strict";

import { drainPendingBookings } from "../api/seq/_lib/booking-protection-worker.mjs";
import {
  K,
  applyDecisions,
  raydarPauseCanaryIdentityFingerprint,
  raydarWebhookProofStatus,
} from "../api/seq/_lib/booking-stop.mjs";
import { LIVESET_SCHEMA } from "../api/seq/_lib/booking-protection-liveset.mjs";
import {
  createPacer,
  pacedApplyDecisionsOverrides,
  PACE_MIN_INTERVAL_MS,
} from "../api/seq/_lib/booking-protection-pace.mjs";

const SECRET = "raydar-booking-test-secret-that-is-long-enough";
const NOW_MS = Date.parse("2026-07-29T18:00:00.000Z");
const CANARY_FINGERPRINT = raydarPauseCanaryIdentityFingerprint({
  secret: SECRET,
  email: "candidate@example.com",
});

function job(overrides = {}) {
  return {
    eventId: "bevt_test_001",
    email: "candidate@example.com",
    bookedAtMs: Date.parse("2026-07-29T17:59:00.000Z"),
    effectiveBookedAtMs: Date.parse("2026-07-29T17:59:00.000Z"),
    startsAt: "2026-07-30T18:00:00.000Z",
    eventName: "Agent Call",
    source: "raydar_scheduler",
    bookingId: "bk_test_001",
    enqueuedAt: "2026-07-29T17:59:05.000Z",
    ...overrides,
  };
}

function usableLiveSet(entries = {
  "candidate@example.com": [{
    ccu: "ccu_1", cu: "cu_1", n: "Test Candidate", s: "seq_1",
    sn: "No Show - Agent Call", t: "2026-07-01T00:00:00.000Z",
  }],
}) {
  return {
    schema: LIVESET_SCHEMA,
    builtAt: new Date(NOW_MS - 3600_000).toISOString(),
    byEmail: entries,
  };
}

function baseDeps(overrides = {}) {
  const removed = [];
  const writes = [];
  return {
    now: NOW_MS,
    listPending: async () => ["bevt_test_001"],
    readJob: async () => job(),
    removeJob: async (eventId) => { removed.push(eventId); },
    loadLive: async () => usableLiveSet(),
    applyDecisionsImpl: async () => ({ paused: 1, pauseErrors: [] }),
    writeProof: async (key, value) => { writes.push({ key, value }); return "OK"; },
    pauseCanaryFingerprint: CANARY_FINGERPRINT,
    webhookSecret: SECRET,
    apply: true,
    _removed: removed,
    _writes: writes,
    ...overrides,
  };
}

test("matches a pending booking against the live-set index (0 Paraform) and pauses via applyDecisions (2 Paraform)", async () => {
  let sawDecisions = null;
  const deps = baseDeps({
    applyDecisionsImpl: async (decisions) => { sawDecisions = decisions; return { paused: 1, pauseErrors: [] }; },
  });
  const result = await drainPendingBookings(deps);
  assert.equal(result.pending, 1);
  assert.equal(result.processed, 1);
  assert.equal(result.matched, 1);
  assert.equal(result.paused, 1);
  assert.equal(result.liveSetReady, true);
  assert.equal(sawDecisions.length, 1);
  assert.equal(sawDecisions[0].ccuId, "ccu_1");
  assert.deepEqual(deps._removed, ["bevt_test_001"], "resolved jobs are dequeued");
});

test("leaves a job queued when the pause fails read-back verification, instead of dropping it", async () => {
  const deps = baseDeps({
    applyDecisionsImpl: async () => ({ paused: 0, pauseErrors: [{ sequence: "No Show - Agent Call", reason: "still_active_after_pause" }] }),
  });
  const result = await drainPendingBookings(deps);
  assert.equal(result.pauseErrors.length, 1);
  assert.equal(result.paused, 0);
  assert.deepEqual(deps._removed, [], "an unverified pause must not be dequeued — the next tick retries it");
});

test("defers every pending job when the live-set index is stale or missing, without ever calling Paraform", async () => {
  let applyCalls = 0;
  const deps = baseDeps({
    loadLive: async () => null,
    applyDecisionsImpl: async () => { applyCalls++; return { paused: 0, pauseErrors: [] }; },
  });
  const result = await drainPendingBookings(deps);
  assert.equal(result.liveSetReady, false);
  assert.equal(result.deferred, 1);
  assert.equal(result.processed, 0);
  assert.equal(applyCalls, 0);
  assert.deepEqual(deps._removed, []);
});

test("silently drops a dangling queue entry whose job payload is missing", async () => {
  const deps = baseDeps({ readJob: async () => null });
  const result = await drainPendingBookings(deps);
  assert.equal(result.processed, 0);
  assert.deepEqual(deps._removed, ["bevt_test_001"]);
});

test("respects maxJobsPerRun, leaving the rest queued for the next tick", async () => {
  const deps = baseDeps({
    listPending: async () => ["a", "b", "c"],
    readJob: async (id) => job({ eventId: id }),
    maxJobsPerRun: 2,
  });
  const result = await drainPendingBookings(deps);
  assert.equal(result.pending, 3);
  assert.equal(result.processed, 2);
  assert.equal(deps._removed.length, 2);
});

test("an unmatched booking (no live-set hit) is dequeued with zero Paraform cost", async () => {
  let applyCalls = 0;
  const deps = baseDeps({
    readJob: async () => job({ email: "nobody@example.com" }),
    applyDecisionsImpl: async () => { applyCalls++; return { paused: 0, pauseErrors: [] }; },
  });
  const result = await drainPendingBookings(deps);
  assert.equal(result.matched, 0);
  assert.equal(applyCalls, 0, "no decisions -> applyDecisions is never even called");
  assert.deepEqual(deps._removed, ["bevt_test_001"]);
});

// ─────────────────────────────────────────────────────────────────────────────
// Proof-writing — moved here from the hook's tests now that the WORKER is what
// resolves a booking and therefore what proves it.
// ─────────────────────────────────────────────────────────────────────────────

test("a resolved match persists a secret-bound, PII-free success proof, through the SAME K.* keys health.mjs already reads", async () => {
  const deps = baseDeps({
    applyDecisionsImpl: async () => ({ paused: 1, pauseErrors: [] }),
  });
  await drainPendingBookings(deps);
  const proof = deps._writes.find((entry) => entry.key === K.raydarWebhookProof)?.value;
  assert.equal(proof?.schema, "raydar-booking-webhook-proof-v1");
  assert.equal(proof?.apply, true);
  assert.equal(proof?.deferred, false);
  assert.equal(proof?.matched, 1);
  assert.equal(proof?.paused, 1);
  assert.equal(JSON.stringify(proof).includes("candidate@example.com"), false);

  const canaryProof = deps._writes.find((entry) => entry.key === K.raydarPauseCanaryProof)?.value;
  assert.deepEqual(canaryProof, { ...proof, canaryFingerprint: CANARY_FINGERPRINT });

  const status = await raydarWebhookProofStatus({
    read: async (key) => key === K.raydarPauseCanaryProof ? canaryProof : proof,
    secret: SECRET,
    canaryFingerprint: CANARY_FINGERPRINT,
    now: NOW_MS,
  });
  assert.equal(status.verified, true);
  assert.equal(status.pauseCanaryVerified, true);
});

test("a real non-canary candidate pause cannot mint the controlled canary proof", async () => {
  const deps = baseDeps({
    readJob: async () => job({ email: "someone-else@example.com" }),
    loadLive: async () => usableLiveSet({
      "someone-else@example.com": [{
        ccu: "ccu_2", cu: "cu_2", n: "Someone Else", s: "seq_1",
        sn: "No Show - Agent Call", t: "2026-07-01T00:00:00.000Z",
      }],
    }),
    applyDecisionsImpl: async () => ({ paused: 1, pauseErrors: [] }),
  });
  await drainPendingBookings(deps);
  assert.equal(deps._writes.some((entry) => entry.key === K.raydarPauseCanaryProof), false);
});

test("an unresolved (no-match) booking still updates the transport proof, without erasing pause-canary readiness", async () => {
  const store = new Map();
  const writeProof = async (key, value) => { store.set(key, structuredClone(value)); return "OK"; };

  await drainPendingBookings(baseDeps({
    writeProof,
    applyDecisionsImpl: async () => ({ paused: 1, pauseErrors: [] }),
  }));

  await drainPendingBookings(baseDeps({
    writeProof,
    readJob: async () => job({ eventId: "bevt_unmatched", email: "nobody@example.com" }),
    listPending: async () => ["bevt_unmatched"],
    applyDecisionsImpl: async () => { throw new Error("must not be called"); },
  }));

  const status = await raydarWebhookProofStatus({
    read: async (key) => store.get(key) || null,
    secret: SECRET,
    canaryFingerprint: CANARY_FINGERPRINT,
    now: NOW_MS,
  });
  assert.equal(status.verified, true);
  assert.equal(status.latestMatched, 0, "the second, unmatched run is the LATEST transport proof");
  assert.equal(status.latestPaused, 0);
  assert.equal(status.pauseCanaryVerified, true, "the canary proof from the first run is untouched");
  assert.equal(status.matched, 1);
  assert.equal(status.paused, 1);
});

test("proof-writing failures never re-queue an already-verified pause", async () => {
  const deps = baseDeps({
    applyDecisionsImpl: async () => ({ paused: 1, pauseErrors: [] }),
    writeProof: async () => { throw new Error("kv down"); },
  });
  const result = await drainPendingBookings(deps);
  assert.equal(result.paused, 1);
  assert.deepEqual(deps._removed, ["bevt_test_001"], "the pause itself already passed read-back verification");
});

// ─────────────────────────────────────────────────────────────────────────────
// Cancel-record check (review finding: K.raydarCancel was write-only — the
// hook recorded a booking.cancelled/rescheduled event but nothing ever read
// it back before matching/pausing the original booking.confirmed job).
// ─────────────────────────────────────────────────────────────────────────────

test("a job whose booking was cancelled before the worker runs is dropped without matching or pausing", async () => {
  let applyCalls = 0;
  const cancelRecords = new Map([[K.raydarCancel("bk_test_001"), { at: "2026-07-29T17:59:30.000Z" }]]);
  const deps = baseDeps({
    readCancelRecord: async (key) => cancelRecords.get(key) || null,
    applyDecisionsImpl: async () => { applyCalls++; return { paused: 1, pauseErrors: [] }; },
  });
  const result = await drainPendingBookings(deps);
  assert.equal(result.cancelled, 1);
  assert.equal(result.processed, 0);
  assert.equal(result.matched, 0);
  assert.equal(applyCalls, 0, "a cancelled booking must never reach applyDecisions");
  assert.deepEqual(deps._removed, ["bevt_test_001"], "the cancelled job is dequeued, not left to retry forever");
});

test("a job with no recorded cancellation still matches and pauses normally", async () => {
  const deps = baseDeps({
    readCancelRecord: async () => null,
  });
  const result = await drainPendingBookings(deps);
  assert.equal(result.cancelled, 0);
  assert.equal(result.paused, 1);
});

// ─────────────────────────────────────────────────────────────────────────────
// Pacer wiring (review finding: drainPendingBookings' real applyDecisions
// default path was never exercised with the actual pacer — every test above
// injects its own applyDecisionsImpl stub instead). This drives the REAL
// applyDecisions (booking-stop.mjs) through the REAL pacedApplyDecisionsOverrides
// (booking-protection-pace.mjs), the exact composition booking-worker.mjs
// wires in production, against a fake `fetch`.
// ─────────────────────────────────────────────────────────────────────────────

test("the real applyDecisions default path, driven through pacedApplyDecisionsOverrides, makes exactly 2 paced Paraform requests for one match", async () => {
  const originalFetch = global.fetch;
  const calls = [];
  let now = 2_000_000;
  let state = null;
  const pace = createPacer({
    loadState: async () => state,
    saveState: async (value) => { state = value; },
    incrementCount: async () => {},
    now: () => now,
    sleep: async (ms) => { calls.push({ sleptMs: ms }); now += ms; },
  });
  global.fetch = async (url) => {
    calls.push({ url: String(url), at: now });
    if (String(url).includes("updateCandidatePauseStatus")) {
      return Response.json({ result: { data: { json: { ok: true } } } });
    }
    return Response.json({
      result: { data: { json: { leads: [{ ccu_id: "ccu_1", is_paused: true }] } } },
    });
  };
  try {
    const deps = baseDeps({
      applyDecisionsImpl: applyDecisions,
      applyDecisionsOverrides: pacedApplyDecisionsOverrides(pace),
    });
    const result = await drainPendingBookings(deps);
    assert.equal(result.paused, 1);
    const requests = calls.filter((c) => c.url);
    assert.equal(requests.length, 2, "one pause + one read-back search — no retry ladder firing extra requests");
    assert.ok(
      requests[1].at - requests[0].at >= PACE_MIN_INTERVAL_MS,
      "the two Paraform requests are spaced by the pacer, not fired back-to-back",
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test("the real applyDecisions default path never retries hard on a refusal — it costs one request and leaves the job queued", async () => {
  const originalFetch = global.fetch;
  let fetchCalls = 0;
  const pace = createPacer({
    loadState: async () => null,
    saveState: async () => {},
    incrementCount: async () => {},
    now: () => 3_000_000,
    sleep: async () => {},
  });
  global.fetch = async () => {
    fetchCalls++;
    return new Response(null, { status: 401, headers: { "retry-after": "30" } });
  };
  try {
    const deps = baseDeps({
      applyDecisionsImpl: applyDecisions,
      applyDecisionsOverrides: pacedApplyDecisionsOverrides(pace),
    });
    const result = await drainPendingBookings(deps);
    assert.equal(result.paused, 0);
    assert.equal(result.pauseErrors.length, 1);
    assert.equal(fetchCalls, 1, "single-shot: a refusal is not retried in-process");
    assert.deepEqual(deps._removed, [], "an unresolved pause stays queued for the next, paced tick");
  } finally {
    global.fetch = originalFetch;
  }
});
