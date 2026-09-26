// Daily safety net (item 5): reconcile Scheduler/Calendly bookings against
// what the webhook/worker path already resolved, plus a small bounded daily
// Book Time rotor check.
process.env.PARAFORM_COOKIE ||= "Fe26.2**test-cookie";
process.env.CALENDLY_API_TOKEN ||= "test-calendly-token";
process.env.RAYDAR_SCHEDULER_BOOKING_STOP_ENABLED = "1";
process.env.RAYDAR_SCHEDULER_INTEGRATION_READ_KEY ||= "test-scheduler-read-key";

import test from "node:test";
import assert from "node:assert/strict";

import {
  catchUpBookingIndexes,
  bookTimeRotorCheck,
} from "../api/seq/_lib/booking-protection-catchup.mjs";
import { LIVESET_SCHEMA } from "../api/seq/_lib/booking-protection-liveset.mjs";
import { applyDecisions } from "../api/seq/_lib/booking-stop.mjs";
import {
  createPacer,
  pacedApplyDecisionsOverrides,
  pacedRelationshipStatusLoader,
  PACE_MIN_INTERVAL_MS,
} from "../api/seq/_lib/booking-protection-pace.mjs";

const NOW = Date.parse("2026-09-26T12:00:00.000Z");

function usableLiveSet(entries) {
  return { schema: LIVESET_SCHEMA, builtAt: new Date(NOW - 3600_000).toISOString(), byEmail: entries };
}

function processedStore() {
  const processed = new Set();
  return {
    processed,
    read: async (key) => (processed.has(key) ? { at: "x" } : null),
    claim: async (key) => { processed.add(key); },
  };
}

test("catch-up defers entirely (0 Paraform) when the live-set index is stale", async () => {
  const out = await catchUpBookingIndexes({
    now: NOW,
    loadLive: async () => null,
    fetchRaydarIndex: async () => { throw new Error("must not be called"); },
    fetchCalendlyIndex: async () => { throw new Error("must not be called"); },
  });
  assert.equal(out.liveSetReady, false);
  assert.equal(out.raydar, null);
  assert.equal(out.calendly, null);
});

test("reconciles a previously-unresolved Scheduler booking: matches, pauses, and marks it processed", async () => {
  const store = processedStore();
  let sawDecisions = null;
  const out = await catchUpBookingIndexes({
    now: NOW,
    loadLive: async () => usableLiveSet({
      "candidate@example.com": [{ ccu: "ccu_1", cu: "cu_1", n: "Cand", s: "seq_1", sn: "No Show - Agent Call", t: "2026-07-01T00:00:00.000Z" }],
    }),
    fetchRaydarIndex: async () => ({
      complete: true,
      index: new Map([["candidate@example.com", { bookedAt: Date.parse("2026-08-01T00:00:00.000Z"), startsAt: null, eventName: "Agent Call", status: "active", bookingId: "bk_1" }]]),
    }),
    fetchCalendlyIndex: async () => ({ index: new Map() }),
    applyDecisionsImpl: async (decisions) => { sawDecisions = decisions; return { paused: 1, pauseErrors: [] }; },
    processedRead: store.read,
    processedClaim: store.claim,
  });
  assert.equal(out.raydar.checked, 1);
  assert.equal(out.raydar.matched, 1);
  assert.equal(out.raydar.paused, 1);
  assert.equal(sawDecisions.length, 1);
  assert.equal(store.processed.size, 1, "the booking id is marked processed so tomorrow's run skips it");
});

test("skips a booking id already marked processed (idempotent day over day)", async () => {
  const store = processedStore();
  // Pre-mark it processed with the SAME key shape reconcileIndex uses.
  await catchUpBookingIndexes({
    now: NOW,
    loadLive: async () => usableLiveSet({}),
    fetchRaydarIndex: async () => ({
      complete: true,
      index: new Map([["candidate@example.com", { bookedAt: NOW, status: "active", bookingId: "bk_seen" }]]),
    }),
    fetchCalendlyIndex: async () => ({ index: new Map() }),
    processedRead: store.read,
    processedClaim: store.claim,
  });
  let applyCalls = 0;
  const out = await catchUpBookingIndexes({
    now: NOW,
    loadLive: async () => usableLiveSet({
      "candidate@example.com": [{ ccu: "ccu_1", cu: "cu_1", n: "Cand", s: "seq_1", sn: "No Show - Agent Call", t: "2026-01-01T00:00:00.000Z" }],
    }),
    fetchRaydarIndex: async () => ({
      complete: true,
      index: new Map([["candidate@example.com", { bookedAt: NOW, status: "active", bookingId: "bk_seen" }]]),
    }),
    fetchCalendlyIndex: async () => ({ index: new Map() }),
    applyDecisionsImpl: async () => { applyCalls++; return { paused: 1, pauseErrors: [] }; },
    processedRead: store.read,
    processedClaim: store.claim,
  });
  assert.equal(out.raydar.checked, 0);
  assert.equal(applyCalls, 0);
});

test("an incomplete Scheduler index is reported without throwing or touching Calendly's own result", async () => {
  const out = await catchUpBookingIndexes({
    now: NOW,
    loadLive: async () => usableLiveSet({}),
    fetchRaydarIndex: async () => ({ complete: false }),
    fetchCalendlyIndex: async () => ({ index: new Map() }),
  });
  assert.equal(out.raydarError, "incomplete_index");
  assert.ok(out.calendly);
});

test("bookTimeRotorCheck stays within its daily budget and advances the rotor across ticks", async () => {
  const rows = Array.from({ length: 5 }, (_, i) => ({
    ccu: `ccu_${i}`, cu: `cu_${i}`, n: `Cand ${i}`, s: "seq_1", sn: "No Show - Agent Call", t: "2026-01-01T00:00:00.000Z",
  }));
  const byEmail = Object.fromEntries(rows.map((r) => [`${r.cu}@example.com`, [r]]));
  let rotorState = null;
  const checkedCus = [];
  const common = {
    now: NOW,
    loadLive: async () => usableLiveSet(byEmail),
    loadRotor: async () => rotorState,
    saveRotor: async (cursor) => { rotorState = { cursor }; },
    relationshipStatusLoader: async (cu) => { checkedCus.push(cu); return null; },
    budget: 2,
  };
  const first = await bookTimeRotorCheck(common);
  assert.equal(first.checked, 2);
  const second = await bookTimeRotorCheck(common);
  assert.equal(second.checked, 2);
  assert.deepEqual(
    checkedCus,
    ["cu_0", "cu_1", "cu_2", "cu_3"],
    "the rotor moves forward instead of re-checking the same two names",
  );
});

test("bookTimeRotorCheck pauses a lead whose Paraform status shows a Book Time booking", async () => {
  const out = await bookTimeRotorCheck({
    now: NOW,
    loadLive: async () => usableLiveSet({
      "candidate@example.com": [{ ccu: "ccu_1", cu: "cu_1", n: "Cand", s: "seq_1", sn: "No Show - Agent Call", t: "2026-07-01T00:00:00.000Z" }],
    }),
    loadRotor: async () => null,
    saveRotor: async () => {},
    relationshipStatusLoader: async () => ({ status: "SCHEDULED_CALL", at: "2026-08-01T00:00:00.000Z" }),
    applyDecisionsImpl: async () => ({ paused: 1, pauseErrors: [] }),
  });
  assert.equal(out.checked, 1);
  assert.equal(out.matched, 1);
  assert.equal(out.paused, 1);
});

test("bookTimeRotorCheck does nothing (0 checks) when the live-set index is stale", async () => {
  const out = await bookTimeRotorCheck({ now: NOW, loadLive: async () => null });
  assert.equal(out.checked, 0);
  assert.equal(out.rows, 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// Pacer wiring (review finding: neither catchUpBookingIndexes' applyDecisions
// calls nor bookTimeRotorCheck's relationshipStatusLoader calls ever ran
// through the pacer — every test above injects its own mocks instead of
// exercising the real defaults). These drive the REAL applyDecisions and the
// REAL cachedRelationshipStatus (via booking-protection-pace.mjs's exported
// helpers — the exact composition booking-catchup.mjs wires in production)
// against a fake `fetch`.
// ─────────────────────────────────────────────────────────────────────────────

test("bookTimeRotorCheck, driven through pacedRelationshipStatusLoader, paces its Paraform profile reads", async () => {
  const originalFetch = global.fetch;
  const calls = [];
  let now = NOW;
  let state = null;
  const pace = createPacer({
    loadState: async () => state,
    saveState: async (value) => { state = value; },
    incrementCount: async () => {},
    now: () => now,
    sleep: async (ms) => { now += ms; },
  });
  global.fetch = async (url) => {
    calls.push({ url: String(url), at: now });
    return Response.json({ result: { data: { json: { candidate_user_relationship_status: null } } } });
  };
  try {
    const out = await bookTimeRotorCheck({
      now: NOW,
      loadLive: async () => usableLiveSet({
        "a@example.com": [{ ccu: "ccu_1", cu: "cu_1", n: "A", s: "seq_1", sn: "No Show - Agent Call", t: "2026-01-01T00:00:00.000Z" }],
        "b@example.com": [{ ccu: "ccu_2", cu: "cu_2", n: "B", s: "seq_1", sn: "No Show - Agent Call", t: "2026-01-01T00:00:00.000Z" }],
      }),
      loadRotor: async () => null,
      saveRotor: async () => {},
      relationshipStatusLoader: pacedRelationshipStatusLoader(pace),
      budget: 2,
    });
    assert.equal(out.checked, 2);
    assert.equal(calls.length, 2, "one profile read per row — no burst-tuned retry ladder firing extra requests");
    assert.ok(
      calls[1].at - calls[0].at >= PACE_MIN_INTERVAL_MS,
      "the rotor's Paraform reads are spaced by the pacer, not fired back-to-back",
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test("catchUpBookingIndexes, driven through the real applyDecisions + pacedApplyDecisionsOverrides, makes exactly 2 paced Paraform requests for a real match", async () => {
  const originalFetch = global.fetch;
  const calls = [];
  let now = NOW;
  let state = null;
  const pace = createPacer({
    loadState: async () => state,
    saveState: async (value) => { state = value; },
    incrementCount: async () => {},
    now: () => now,
    sleep: async (ms) => { now += ms; },
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
  const store = processedStore();
  try {
    const out = await catchUpBookingIndexes({
      now: NOW,
      loadLive: async () => usableLiveSet({
        "candidate@example.com": [{ ccu: "ccu_1", cu: "cu_1", n: "Cand", s: "seq_1", sn: "No Show - Agent Call", t: "2026-07-01T00:00:00.000Z" }],
      }),
      fetchRaydarIndex: async () => ({
        complete: true,
        index: new Map([["candidate@example.com", { bookedAt: Date.parse("2026-08-01T00:00:00.000Z"), startsAt: null, eventName: "Agent Call", status: "active", bookingId: "bk_1" }]]),
      }),
      fetchCalendlyIndex: async () => ({ index: new Map() }),
      applyDecisionsImpl: (decisions) => applyDecisions(decisions, pacedApplyDecisionsOverrides(pace)),
      processedRead: store.read,
      processedClaim: store.claim,
    });
    assert.equal(out.raydar.paused, 1);
    assert.equal(calls.length, 2, "one pause + one read-back search");
    assert.ok(calls[1].at - calls[0].at >= PACE_MIN_INTERVAL_MS);
  } finally {
    global.fetch = originalFetch;
  }
});
