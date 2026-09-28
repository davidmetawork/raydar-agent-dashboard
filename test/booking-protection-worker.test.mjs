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
  __resetPacerSessionMemoryForTests,
} from "../api/seq/_lib/booking-protection-pace.mjs";
import { __resetSessionExpiryChecksForTests } from "../api/seq/_lib/core.mjs";
import { __resetParaformSessionStateForTests } from "../api/_lib/paraform-session-store.mjs";

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
    // Never the real KV readers: a dev shell with KV_REST_API_* exported
    // would otherwise read production.
    readCancelRecord: async () => null,
    readPausedRecord: async () => null,
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

test("drops a dangling queue entry whose job payload is missing, and counts it", async () => {
  const deps = baseDeps({ readJob: async () => null });
  const result = await drainPendingBookings(deps);
  assert.equal(result.processed, 0);
  assert.equal(result.missing, 1);
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
  // Retry-After says "throttled", so the pacer runs no session probes.
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

test("a pause on a confirmed-dead session with nowhere to move is one pause error, not an aborted drain", async () => {
  // applyDecisions answers AUTH_EXPIRED with its own unpaced probes and
  // throws out of the whole batch. The pacer must report a dead session with
  // no other store session as PARAFORM_SESSION_DEAD instead.
  const originalFetch = global.fetch;
  const delays = {
    PARAFORM_THROTTLE_DELAYS_MS: process.env.PARAFORM_THROTTLE_DELAYS_MS,
    PARAFORM_PROBE_DELAY_MS: process.env.PARAFORM_PROBE_DELAY_MS,
  };
  process.env.PARAFORM_THROTTLE_DELAYS_MS = "0,0,0";
  process.env.PARAFORM_PROBE_DELAY_MS = "0";
  __resetParaformSessionStateForTests();
  __resetSessionExpiryChecksForTests();
  __resetPacerSessionMemoryForTests();
  const requests = [];
  const pace = createPacer({
    loadState: async () => null,
    saveState: async () => {},
    incrementCount: async () => {},
    now: () => 3_000_000,
    sleep: async () => {},
    log: () => {},
  });
  global.fetch = async (url) => {
    requests.push(String(url));
    return new Response(null, { status: 401 });
  };
  try {
    const deps = baseDeps({
      applyDecisionsImpl: applyDecisions,
      applyDecisionsOverrides: pacedApplyDecisionsOverrides(pace),
    });
    const result = await drainPendingBookings(deps);
    assert.equal(result.paused, 0);
    assert.deepEqual(
      result.pauseErrors.map((error) => error.reason),
      ["PARAFORM_SESSION_DEAD"],
    );
    assert.equal(
      requests.filter((url) => url.includes("updateCandidatePauseStatus")).length,
      1,
      "the pause itself is sent once",
    );
    assert.ok(
      requests.filter((url) => !url.includes("updateCandidatePauseStatus"))
        .every((url) => url.includes("getListOfCampaignsOptimized")),
      "everything else is the pacer's serial probes, none from applyDecisions",
    );
    assert.deepEqual(deps._removed, [], "the job stays queued");
  } finally {
    global.fetch = originalFetch;
    for (const [key, value] of Object.entries(delays)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    __resetParaformSessionStateForTests();
    __resetSessionExpiryChecksForTests();
    __resetPacerSessionMemoryForTests();
  }
});

// ── Incomplete live sets: hold, never drop (found in the PR 244 review) ──────
// A refresh that could not read one sequence still publishes. A booking for a
// lead in that sequence finds no match, and used to be removed for good.

const L1_BUILT = new Date(NOW_MS - 3600_000).toISOString();
const L2_BUILT = new Date(NOW_MS - 60_000).toISOString();

function entry(overrides = {}) {
  return {
    ccu: "ccu_1", cu: "cu_1", n: "Test Candidate", s: "seq_1",
    sn: "No Show - Agent Call", t: "2026-07-01T00:00:00.000Z",
    ...overrides,
  };
}

function incompleteLiveSet(entries, unverified, builtAt = L1_BUILT) {
  return {
    schema: LIVESET_SCHEMA,
    builtAt,
    byEmail: entries,
    incomplete: true,
    unverifiedSequences: unverified.map((id) => ({ id, name: `Seq ${id}`, reason: "PARAFORM_HTTP_401" })),
  };
}

function holdingDeps(overrides = {}) {
  const holds = [];
  const applied = [];
  return baseDeps({
    holdJob: async (eventId, jobDoc, hold) => { holds.push({ eventId, jobDoc, hold }); },
    applyDecisionsImpl: async (decisions) => {
      applied.push(decisions.map((d) => d.sequenceId));
      return { paused: decisions.length, pauseErrors: [] };
    },
    _holds: holds,
    _applied: applied,
    ...overrides,
  });
}

test("a no-match booking checked against an incomplete index is held, not dropped", async () => {
  const deps = holdingDeps({
    loadLive: async () => incompleteLiveSet({}, ["seq_2"]),
  });
  const result = await drainPendingBookings(deps);
  assert.equal(result.processed, 1);
  assert.equal(result.matched, 0);
  assert.equal(result.held, 1);
  assert.deepEqual(deps._removed, [], "the booking stays queued");
  assert.equal(deps._holds.length, 1);
  assert.deepEqual(deps._holds[0].hold, {
    checkedAgainst: L1_BUILT,
    unverifiedSequenceIds: ["seq_2"],
    heldSince: new Date(NOW_MS).toISOString(),
    appliedCcuIds: [],
  });
  assert.deepEqual(result.unverifiedSequences.map((s) => s.id), ["seq_2"]);
});

test("a held booking is skipped against the same index, then paused and resolved by the next complete one", async () => {
  const hold = { checkedAgainst: L1_BUILT, unverifiedSequenceIds: ["seq_2"], heldSince: L1_BUILT };
  const same = holdingDeps({
    readJob: async () => job({ hold }),
    loadLive: async () => incompleteLiveSet({}, ["seq_2"]),
  });
  const skipped = await drainPendingBookings(same);
  assert.equal(skipped.held, 1);
  assert.equal(skipped.processed, 0, "nothing new can be learnt from the same index");
  assert.deepEqual(same._applied, []);
  assert.deepEqual(same._removed, []);
  assert.deepEqual(same._holds, [], "no rewrite either");

  const next = holdingDeps({
    readJob: async () => job({ hold }),
    loadLive: async () => ({
      schema: LIVESET_SCHEMA,
      builtAt: L2_BUILT,
      byEmail: { "candidate@example.com": [entry({ ccu: "ccu_2", s: "seq_2", sn: "Audio Failed" })] },
      incomplete: false,
      unverifiedSequences: [],
    }),
  });
  const resolved = await drainPendingBookings(next);
  assert.deepEqual(next._applied, [["seq_2"]], "the lead in the once-unread sequence is paused");
  assert.equal(resolved.paused, 1);
  assert.deepEqual(next._removed, ["bevt_test_001"], "resolved once every sequence has been read");
});

test("a match against an incomplete index pauses now, and the next index applies only the once-unread sequence", async () => {
  const first = holdingDeps({
    loadLive: async () => incompleteLiveSet({ "candidate@example.com": [entry()] }, ["seq_2"]),
  });
  const r1 = await drainPendingBookings(first);
  assert.deepEqual(first._applied, [["seq_1"]], "the readable sequence is protected immediately");
  assert.equal(r1.paused, 1);
  assert.deepEqual(first._removed, []);
  const hold = first._holds[0].hold;

  // A person has since un-paused the seq_1 lead, so it is active again in
  // the next index. Only seq_2's decision may be applied.
  const second = holdingDeps({
    readJob: async () => job({ hold }),
    loadLive: async () => ({
      schema: LIVESET_SCHEMA,
      builtAt: L2_BUILT,
      byEmail: { "candidate@example.com": [entry(), entry({ ccu: "ccu_2", s: "seq_2", sn: "Audio Failed" })] },
      unverifiedSequences: [],
    }),
  });
  await drainPendingBookings(second);
  assert.deepEqual(second._applied, [["seq_2"]], "the seq_1 pause is not re-sent");
  assert.deepEqual(second._removed, ["bevt_test_001"]);
});

test("a hold narrows to sequences no index has read, and keeps its first heldSince", async () => {
  const hold = { checkedAgainst: L1_BUILT, unverifiedSequenceIds: ["seq_2", "seq_3"], heldSince: L1_BUILT };
  const deps = holdingDeps({
    readJob: async () => job({ hold }),
    loadLive: async () => incompleteLiveSet({}, ["seq_3", "seq_4"], L2_BUILT),
  });
  await drainPendingBookings(deps);
  assert.deepEqual(deps._removed, []);
  assert.deepEqual(deps._holds[0].hold, {
    checkedAgainst: L2_BUILT,
    unverifiedSequenceIds: ["seq_3"],
    heldSince: L1_BUILT,
    appliedCcuIds: [],
  }, "seq_2 was read now and seq_4 was read before, so only seq_3 is still unknown");

  const cleared = holdingDeps({
    readJob: async () => job({ hold: { ...hold, unverifiedSequenceIds: ["seq_2"] } }),
    loadLive: async () => incompleteLiveSet({}, ["seq_4"], L2_BUILT),
  });
  await drainPendingBookings(cleared);
  assert.deepEqual(cleared._removed, ["bevt_test_001"], "every sequence was read by one index or the other");
});

test("an index published before unverifiedSequences existed is judged by its errors list", async () => {
  const deps = holdingDeps({
    loadLive: async () => ({
      ...usableLiveSet({}),
      incomplete: true,
      errors: [{ sequenceId: "seq_2", name: "Audio Failed", reason: "PARAFORM_HTTP_401" }],
    }),
  });
  await drainPendingBookings(deps);
  assert.deepEqual(deps._removed, []);
  assert.deepEqual(deps._holds[0].hold.unverifiedSequenceIds, ["seq_2"]);
});

test("held jobs do not spend maxJobsPerRun, so a held backlog cannot starve a new booking", async () => {
  const hold = { checkedAgainst: L1_BUILT, unverifiedSequenceIds: ["seq_2"], heldSince: L1_BUILT };
  const deps = holdingDeps({
    listPending: async () => ["h1", "h2", "h3", "new"],
    readJob: async (id) => (id === "new" ? job({ eventId: id }) : job({ eventId: id, hold })),
    loadLive: async () => incompleteLiveSet({ "candidate@example.com": [entry()] }, ["seq_2"]),
    maxJobsPerRun: 1,
  });
  const result = await drainPendingBookings(deps);
  assert.equal(result.processed, 1);
  assert.deepEqual(deps._applied, [["seq_1"]], "the new booking behind three held ones was matched");
  assert.equal(result.held, 4, "three already held plus the new one");
});

test("a job record KV could not return is left queued, not removed as missing", async () => {
  const deps = baseDeps({
    readJob: async () => { throw Object.assign(new Error("KV_UNAVAILABLE"), { code: "KV_UNAVAILABLE" }); },
  });
  const result = await drainPendingBookings(deps);
  assert.equal(result.unreadable, 1);
  assert.equal(result.missing, 0);
  assert.deepEqual(deps._removed, []);
});

test("a re-check against a newer index still catches a lead the earlier index could not see", async () => {
  // Enrolled in seq_1 after index 1 was built but before booking: index 2
  // is the first to show it. seq_1 was already read, but the lead is new.
  const hold = { checkedAgainst: L1_BUILT, unverifiedSequenceIds: ["seq_2"], heldSince: L1_BUILT, appliedCcuIds: ["ccu_1"] };
  const deps = holdingDeps({
    readJob: async () => job({ hold }),
    loadLive: async () => ({
      schema: LIVESET_SCHEMA,
      builtAt: L2_BUILT,
      byEmail: { "candidate@example.com": [entry(), entry({ ccu: "ccu_late", t: "2026-07-29T12:00:00.000Z" })] },
      unverifiedSequences: [],
    }),
    readPausedRecord: async () => null,
  });
  await drainPendingBookings(deps);
  assert.deepEqual(deps._applied, [["seq_1"]]);
  assert.deepEqual(deps._removed, ["bevt_test_001"]);
});

test("re-checking a held backlog after a refresh costs no budget unless it sends a pause", async () => {
  const hold = { checkedAgainst: L1_BUILT, unverifiedSequenceIds: ["seq_2"], heldSince: L1_BUILT, appliedCcuIds: [] };
  const deps = holdingDeps({
    listPending: async () => ["h1", "h2", "h3", "new"],
    readJob: async (id) => (id === "new" ? job({ eventId: id }) : job({ eventId: id, email: `${id}@example.com`, hold })),
    // A newer index, still missing seq_2: the held jobs are re-checked (they
    // match nothing), and the new booking behind them matches seq_1.
    loadLive: async () => incompleteLiveSet({ "candidate@example.com": [entry()] }, ["seq_2"], L2_BUILT),
    maxJobsPerRun: 1,
  });
  const result = await drainPendingBookings(deps);
  assert.equal(result.processed, 4, "all four were checked");
  assert.deepEqual(deps._applied, [["seq_1"]], "the new booking was not starved");
  assert.equal(deps._holds.length, 4);
});

test("after a failed hold write, the next tick does not re-send a pause the last tick already verified", async () => {
  // Tick 1 (after the 17:59 booking) paused ccu_1 at 17:59:30 and then failed
  // to write the hold, so tick 2 sees the job unheld against the same index.
  const deps = holdingDeps({
    loadLive: async () => incompleteLiveSet({ "candidate@example.com": [entry()] }, ["seq_2"]),
    readPausedRecord: async (key) => (key === K.paused("ccu_1") ? { at: new Date(NOW_MS - 30_000).toISOString() } : null),
  });
  const result = await drainPendingBookings(deps);
  assert.deepEqual(deps._applied, [], "no Paraform request");
  assert.equal(result.held, 1, "still held for seq_2");
  assert.deepEqual(deps._holds[0].hold.appliedCcuIds, ["ccu_1"]);
});

test("alert texts name sequences, never candidates, and the held threshold defaults to 26 hours", async () => {
  const { heldAlertText, heldAlertAgeMs } = await import("../api/seq/booking-worker.mjs");
  const { incompleteRefreshText } = await import("../api/seq/booking-liveset-refresh.mjs");
  assert.equal(heldAlertAgeMs({}), 26 * 3600 * 1000);
  assert.equal(heldAlertAgeMs({ BOOKING_STOP_LITE_HOLD_ALERT_HOURS: "30" }), 30 * 3600 * 1000);
  assert.equal(heldAlertAgeMs({ BOOKING_STOP_LITE_HOLD_ALERT_HOURS: "nonsense" }), 26 * 3600 * 1000);
  const held = heldAlertText({
    held: 3,
    oldestHeldAgeMs: 27 * 3600 * 1000,
    heldSequenceIds: ["seq_2", "seq_9"],
    unverifiedSequences: [{ id: "seq_2", name: "Audio Failed" }],
  });
  assert.match(held, /holding 3 booking\(s\), the oldest for 27h/);
  assert.match(held, /Audio Failed, seq_9/);
  const refresh = incompleteRefreshText([
    { id: "a", name: "No Show - Agent Call", reason: "PARAFORM_HTTP_401" },
    { id: "b", name: null, reason: "short_read:3/5" },
  ]);
  assert.match(refresh, /could not fully read 2 sequence\(s\): No Show - Agent Call \(PARAFORM_HTTP_401\), b \(short_read:3\/5\)/);
  assert.match(refresh, /held in the queue, not dropped/);
});

test("the scan cap bounds work per tick, but held skips against the same index do not use it up", async () => {
  const hold = { checkedAgainst: L1_BUILT, unverifiedSequenceIds: ["seq_2"], heldSince: L1_BUILT, appliedCcuIds: [] };
  const ids = ["h1", "h2", "h3", "n1", "n2", "n3"];
  const deps = holdingDeps({
    listPending: async () => ids,
    readJob: async (id) => (id.startsWith("h") ? job({ eventId: id, hold }) : job({ eventId: id, email: `${id}@example.com` })),
    loadLive: async () => incompleteLiveSet({}, ["seq_2"]),
    maxScanPerRun: 2,
  });
  const result = await drainPendingBookings(deps);
  assert.equal(result.processed, 2, "two new bookings checked, the cap reached");
  assert.deepEqual(deps._holds.map((h) => h.eventId), ["n1", "n2"], "the three held skips did not spend it");
});

test("the drain stops starting jobs once its time budget is spent", async () => {
  let clockMs = 0;
  const deps = baseDeps({
    listPending: async () => ["a", "b", "c"],
    readJob: async (id) => { clockMs += 50_000; return job({ eventId: id }); },
    stopAfterMs: 80_000,
    clock: () => clockMs,
  });
  const result = await drainPendingBookings(deps);
  assert.equal(result.processed, 2, "the third job is left for the next tick");
  assert.deepEqual(deps._removed, ["a", "b"]);
});

test("a garbage cap never lifts the limit", async () => {
  const noJobs = baseDeps({ maxJobsPerRun: Number("nonsense") });
  const none = await drainPendingBookings(noJobs);
  assert.equal(none.processed, 0, "a non-number job cap processes nothing, as before");

  const scanFallback = baseDeps({
    listPending: async () => ["a", "b"],
    readJob: async (id) => job({ eventId: id }),
    maxScanPerRun: Number("nonsense"),
  });
  const both = await drainPendingBookings(scanFallback);
  assert.equal(both.processed, 2, "a non-number scan cap falls back to the default");
});

test("a dry run holds the booking but records nothing as handled", async () => {
  const deps = holdingDeps({
    apply: false,
    loadLive: async () => incompleteLiveSet({ "candidate@example.com": [entry()] }, ["seq_2"]),
  });
  const result = await drainPendingBookings(deps);
  assert.deepEqual(deps._applied, [], "nothing sent");
  assert.equal(result.matched, 1);
  assert.deepEqual(deps._holds[0].hold.appliedCcuIds, [], "switching apply on later still pauses ccu_1");
});

test("worker alerts: held jobs never trip the stuck alert, and each alert has its own gate", async () => {
  const { workerAlerts } = await import("../api/seq/booking-worker.mjs");
  const quiet = { pending: 0, processed: 0, matched: 0, paused: 0, missing: 0, unreadable: 0, pauseErrors: [], liveSetReady: true, unverifiedSequences: [] };
  const H = 3600 * 1000;
  const keys = (result, queue, env = {}) => workerAlerts({ result: { ...quiet, ...result }, queue, env }).map((a) => a.key);

  assert.deepEqual(keys({}, { oldestUnheldAgeMs: null, oldestHeldAgeMs: 25 * H, held: 4, heldSequenceIds: ["seq_2"] }), [],
    "a day-old hold is waiting for the next refresh, not stuck");
  assert.deepEqual(keys({}, { oldestUnheldAgeMs: 7 * H, oldestHeldAgeMs: 27 * H, held: 4, heldSequenceIds: ["seq_2"] }),
    ["booking-worker-stuck-pending", "booking-worker-held"]);
  assert.deepEqual(keys({}, { oldestHeldAgeMs: 27 * H, held: 1 }, { BOOKING_STOP_LITE_HOLD_ALERT_HOURS: "30" }), []);
  assert.deepEqual(keys({ missing: 2 }, null), ["booking-worker-missing"]);
  assert.deepEqual(keys({ unreadable: 3 }, { unreadable: 3 }), ["booking-worker-unreadable"], "a store that will not return records is not silent");
  assert.deepEqual(keys({ unreadable: 1 }, { unreadable: 0 }), [], "a one-off blip in one pass stays quiet");
  assert.deepEqual(keys({ pending: 5, liveSetReady: false }, null), ["booking-worker-liveset-stale"]);
  const paused = workerAlerts({ result: { ...quiet, paused: 1, matched: 1, processed: 1 }, queue: null, env: {} });
  assert.deepEqual(paused.map((a) => [a.key, a.dedupeSeconds]), [["booking-worker-paused", null]], "a pause is always reported");
});
