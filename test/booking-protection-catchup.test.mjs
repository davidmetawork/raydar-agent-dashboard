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
  ROTOR_ROW_REFUSAL_LIMIT,
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

// ─────────────────────────────────────────────────────────────────────────────
// The rotor inside the catch-up route's 120 s (2026-09-28 gap): its default
// budget of 60 reads at the pacer's 6.5 s spacing cannot fit, and it saved
// its cursor only at the end, so a run the platform killed never advanced
// it and the same first rows were re-read every day.
// ─────────────────────────────────────────────────────────────────────────────

function rotorRows(count, { cuOf = (i) => `cu_${i}` } = {}) {
  const rows = Array.from({ length: count }, (_, i) => ({
    ccu: `ccu_${String(i).padStart(2, "0")}`,
    cu: cuOf(i),
    n: `Cand ${i}`,
    s: "seq_1",
    sn: "No Show - Agent Call",
    t: "2026-01-01T00:00:00.000Z",
  }));
  return Object.fromEntries(rows.map((row, i) => [`row${i}@example.com`, [row]]));
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test("bookTimeRotorCheck saves its cursor after every read, so a run killed mid-read keeps the rows it finished", async () => {
  const saves = [];
  let release;
  const hang = new Promise((resolve) => { release = resolve; });
  const run = bookTimeRotorCheck({
    now: NOW,
    loadLive: async () => usableLiveSet(rotorRows(5)),
    loadRotor: async () => null,
    saveRotor: async (cursor) => { saves.push(cursor); },
    // The third read never answers: the platform kills the run here.
    relationshipStatusLoader: async (cu) => (cu === "cu_2" ? hang : null),
    budget: 5,
  });
  for (let i = 0; i < 10; i++) await settle();
  assert.deepEqual(saves, [1, 2], "rows 0 and 1 are saved before the hung read");
  release(null);
  const out = await run;
  assert.deepEqual(saves, [1, 2, 3, 4, 0]);
  assert.equal(out.stoppedBy, "lap");
  assert.equal(out.cursor, 0);
});

test("bookTimeRotorCheck starts no read past its deadline and records where it stopped", async () => {
  let clockMs = 0;
  const saves = [];
  const out = await bookTimeRotorCheck({
    now: NOW,
    loadLive: async () => usableLiveSet(rotorRows(10)),
    loadRotor: async () => null,
    saveRotor: async (cursor) => { saves.push(cursor); },
    relationshipStatusLoader: async () => { clockMs += PACE_MIN_INTERVAL_MS; return null; },
    budget: 60,
    deadlineAt: 20_000,
    clock: () => clockMs,
  });
  // Reads start at 0, 6.5, 13 and 19.5 s; at 26 s the deadline has passed.
  assert.equal(out.checked, 4);
  assert.equal(out.stoppedBy, "deadline");
  assert.equal(out.cursor, 4);
  assert.deepEqual(saves, [1, 2, 3, 4]);
});

test("bookTimeRotorCheck stops on a refusal and leaves the cursor on the refused row", async () => {
  let rotorState = null;
  const read = [];
  const common = {
    now: NOW,
    loadLive: async () => usableLiveSet(rotorRows(5)),
    loadRotor: async () => rotorState,
    saveRotor: async (cursor) => { rotorState = { cursor }; },
    budget: 5,
  };
  const first = await bookTimeRotorCheck({
    ...common,
    relationshipStatusLoader: async (cu) => {
      if (cu === "cu_1") throw Object.assign(new Error("PARAFORM_PACED_BACKOFF"), { code: "PARAFORM_PACED_BACKOFF" });
      read.push(cu);
      return null;
    },
  });
  assert.equal(first.checked, 1);
  assert.equal(first.stoppedBy, "refused");
  assert.equal(first.stopReason, "PARAFORM_PACED_BACKOFF");
  assert.equal(first.cursor, 1);
  assert.deepEqual(rotorState, { cursor: 1 });

  const second = await bookTimeRotorCheck({
    ...common,
    budget: 2,
    relationshipStatusLoader: async (cu) => { read.push(cu); return null; },
  });
  assert.equal(second.checked, 2);
  assert.deepEqual(read, ["cu_0", "cu_1", "cu_2"], "the next run starts at the row that was refused");
});

test("bookTimeRotorCheck passes over a row whose own read fails, so one bad row cannot hold the rotor", async () => {
  const out = await bookTimeRotorCheck({
    now: NOW,
    loadLive: async () => usableLiveSet(rotorRows(3)),
    loadRotor: async () => null,
    saveRotor: async () => {},
    relationshipStatusLoader: async (cu) => {
      if (cu === "cu_1") throw Object.assign(new Error("not found"), { code: "PARAFORM_REFUSED", status: 404 });
      return null;
    },
    budget: 3,
  });
  assert.equal(out.reads, 3);
  assert.equal(out.checked, 2, "the row whose read failed is not counted as checked");
  assert.equal(out.readErrors, 1);
  assert.equal(out.stoppedBy, "lap");
});

test("bookTimeRotorCheck treats 401, 403, 429, 5xx, transport and dead-session failures as refusals", async () => {
  const refusals = [
    { code: "PARAFORM_REFUSED_AUTH", status: 401 },
    { code: "PARAFORM_REFUSED", status: 403 },
    { code: "PARAFORM_REFUSED", status: 429 },
    { code: "PARAFORM_REFUSED", status: 502 },
    { code: "PARAFORM_TRANSPORT_ERROR" },
    { code: "PARAFORM_SESSION_DEAD", status: 401 },
    { code: "KV_UNAVAILABLE" },
  ];
  for (const refusal of refusals) {
    const out = await bookTimeRotorCheck({
      now: NOW,
      loadLive: async () => usableLiveSet(rotorRows(3)),
      loadRotor: async () => null,
      saveRotor: async () => {},
      relationshipStatusLoader: async () => { throw Object.assign(new Error(refusal.code), refusal); },
      budget: 3,
    });
    assert.equal(out.stoppedBy, "refused", `${refusal.code} ${refusal.status ?? ""}`);
    assert.equal(out.checked, 0);
    assert.equal(out.cursor, 0);
  }
});

test("bookTimeRotorCheck moves past rows with no candidate user id instead of sticking on them", async () => {
  // The old cursor advanced by the number of rows READ, so a stretch of at
  // least `budget` rows without a cu id held it in place for good.
  let rotorState = null;
  const read = [];
  const common = {
    now: NOW,
    loadLive: async () => usableLiveSet(rotorRows(6, { cuOf: (i) => (i < 3 ? null : `cu_${i}`) })),
    loadRotor: async () => rotorState,
    saveRotor: async (cursor) => { rotorState = { cursor }; },
    relationshipStatusLoader: async (cu) => { read.push(cu); return null; },
    budget: 2,
  };
  const first = await bookTimeRotorCheck(common);
  assert.equal(first.checked, 2);
  assert.equal(first.cursor, 5);
  const second = await bookTimeRotorCheck(common);
  assert.deepEqual(read, ["cu_3", "cu_4", "cu_5", "cu_3"], "the second run reads row 5, passes over rows 0-2 and wraps to row 3");
  assert.equal(second.cursor, 4);
});

test("bookTimeRotorCheck through the real pacer: a 429 stops the rotor after one request, with the cursor on that row", async () => {
  const originalFetch = global.fetch;
  const calls = [];
  let now = NOW;
  let state = null;
  let rotorState = null;
  const pace = createPacer({
    loadState: async () => state,
    saveState: async (value) => { state = value; },
    incrementCount: async () => {},
    now: () => now,
    sleep: async (ms) => { now += ms; },
    heldSession: () => ({ value: "Fe26.2**test-cookie", slot: "env" }),
    nextSession: async () => null,
    log: () => {},
  });
  global.fetch = async (url) => {
    calls.push(String(url));
    if (calls.length === 2) return new Response(null, { status: 429 });
    return Response.json({ result: { data: { json: { candidate_user_relationship_status: null } } } });
  };
  try {
    const out = await bookTimeRotorCheck({
      now: NOW,
      loadLive: async () => usableLiveSet(rotorRows(5, { cuOf: (i) => `cu_rotor_429_${i}` })),
      loadRotor: async () => rotorState,
      saveRotor: async (cursor) => { rotorState = { cursor }; },
      relationshipStatusLoader: pacedRelationshipStatusLoader(pace),
      budget: 5,
    });
    assert.equal(calls.length, 2, "one read, then the refused one; nothing after it");
    assert.equal(out.checked, 1);
    assert.equal(out.stoppedBy, "refused");
    assert.equal(out.stopReason, "PARAFORM_REFUSED");
    assert.deepEqual(rotorState, { cursor: 1 });
  } finally {
    global.fetch = originalFetch;
  }
});

test("a row refused on two runs in a row is passed over, so one row Paraform always refuses cannot hold the rotor", async () => {
  assert.equal(ROTOR_ROW_REFUSAL_LIMIT, 2);
  let rotorState = null;
  const read = [];
  const common = {
    now: NOW,
    loadLive: async () => usableLiveSet(rotorRows(4)),
    loadRotor: async () => rotorState,
    saveRotor: async (cursor, extra = {}) => { rotorState = { cursor, ...extra }; },
    budget: 2,
    relationshipStatusLoader: async (cu) => {
      read.push(cu);
      if (cu === "cu_1") throw Object.assign(new Error("PARAFORM_HTTP_403"), { code: "PARAFORM_REFUSED", status: 403 });
      return null;
    },
  };
  const first = await bookTimeRotorCheck(common);
  assert.equal(first.stoppedBy, "refused");
  assert.deepEqual(rotorState, { cursor: 1, refused: { ccu: "ccu_01", count: 1 } });

  const second = await bookTimeRotorCheck(common);
  assert.equal(second.passedRefused, 1);
  assert.equal(second.readErrors, 1);
  assert.equal(second.stoppedBy, "budget");
  assert.deepEqual(read, ["cu_0", "cu_1", "cu_1", "cu_2"], "the second refusal passes the row and the run moves on");
  assert.deepEqual(rotorState, { cursor: 3, refused: null });
});

test("a backoff or a dead session at the cursor does not count against the row", async () => {
  let rotorState = { cursor: 1, refused: { ccu: "ccu_01", count: 1 } };
  const out = await bookTimeRotorCheck({
    now: NOW,
    loadLive: async () => usableLiveSet(rotorRows(4)),
    loadRotor: async () => rotorState,
    saveRotor: async (cursor, extra = {}) => { rotorState = { cursor, ...extra }; },
    budget: 2,
    relationshipStatusLoader: async () => {
      throw Object.assign(new Error("PARAFORM_PACED_BACKOFF"), { code: "PARAFORM_PACED_BACKOFF" });
    },
  });
  assert.equal(out.stoppedBy, "refused");
  assert.equal(out.passedRefused, 0);
  assert.deepEqual(rotorState, { cursor: 1, refused: { ccu: "ccu_01", count: 1 } }, "nothing was sent, so nothing changes");
});

test("one profile read serves every lead of the same candidate, so a second sequence's lead is paused in the same run", async () => {
  // Review finding: with the cursor counting rows, a second row for a
  // candidate already read this run was passed over for a whole lap.
  const booked = { status: "SCHEDULED_CALL", at: "2026-08-01T00:00:00.000Z" };
  const reads = [];
  const paused = [];
  const out = await bookTimeRotorCheck({
    now: NOW,
    loadLive: async () => usableLiveSet({
      "same@example.com": [
        { ccu: "ccu_0", cu: "cu_same", n: "Cand", s: "seq_1", sn: "No Show - Agent Call", t: "2026-07-01T00:00:00.000Z" },
        { ccu: "ccu_1", cu: "cu_same", n: "Cand", s: "seq_2", sn: "No Show - Agent Call", t: "2026-07-01T00:00:00.000Z" },
      ],
    }),
    loadRotor: async () => null,
    saveRotor: async () => {},
    relationshipStatusLoader: async (cu) => { reads.push(cu); return booked; },
    applyDecisionsImpl: async (decisions) => {
      paused.push(...decisions.map((d) => d.ccuId));
      return { paused: decisions.length, pauseErrors: [] };
    },
    budget: 1,
  });
  assert.deepEqual(reads, ["cu_same"], "one read");
  assert.equal(out.reads, 1);
  assert.equal(out.checked, 2);
  assert.equal(out.matched, 2);
  assert.equal(out.paused, 2);
  assert.deepEqual(paused, ["ccu_0", "ccu_1"]);
  assert.equal(out.stoppedBy, "lap");
});

test("a failed pause stops the run on that row, so the next run retries it instead of a lap later", async () => {
  const booked = { status: "SCHEDULED_CALL", at: "2026-08-01T00:00:00.000Z" };
  let rotorState = null;
  let pauseAttempts = 0;
  const common = {
    now: NOW,
    loadLive: async () => usableLiveSet(rotorRows(3)),
    loadRotor: async () => rotorState,
    saveRotor: async (cursor, extra = {}) => { rotorState = { cursor, ...extra }; },
    relationshipStatusLoader: async (cu) => (cu === "cu_1" ? booked : null),
    applyDecisionsImpl: async () => {
      pauseAttempts++;
      return { paused: 0, pauseErrors: [{ sequence: "seq_1", reason: "throttled_after_retries" }] };
    },
    budget: 3,
  };
  const first = await bookTimeRotorCheck(common);
  assert.equal(first.stoppedBy, "refused");
  assert.equal(first.stopReason, "PAUSE_FAILED");
  assert.equal(first.pauseErrors.length, 1);
  assert.deepEqual(rotorState, { cursor: 1, refused: { ccu: "ccu_01", count: 1 } });

  // The next run retries the same row first; a second failure passes it.
  const second = await bookTimeRotorCheck(common);
  assert.equal(pauseAttempts, 2);
  assert.equal(second.passedRefused, 1);
  assert.equal(second.stoppedBy, "lap");
  assert.equal(rotorState.refused, null);
});

test("a budget setting that is not a number reads nothing, as before", async () => {
  let reads = 0;
  const out = await bookTimeRotorCheck({
    now: NOW,
    loadLive: async () => usableLiveSet(rotorRows(3)),
    loadRotor: async () => null,
    saveRotor: async () => {},
    relationshipStatusLoader: async () => { reads++; return null; },
    budget: Number("sixty"),
  });
  assert.equal(reads, 0);
  assert.equal(out.stoppedBy, "budget");
});
