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
