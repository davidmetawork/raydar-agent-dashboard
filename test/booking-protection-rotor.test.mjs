// The Book Time rotor (api/seq/_lib/booking-protection-catchup.mjs
// bookTimeRotorCheck) inside the catch-up route's time limit, and what it
// does with refusals, failed pauses and a live set rebuilt every day.
// Kept apart from booking-protection-catchup.test.mjs so parallel changes to
// the reconciliation tests there do not collide with these.
process.env.PARAFORM_COOKIE ||= "Fe26.2**test-cookie";

import test from "node:test";
import assert from "node:assert/strict";

import {
  bookTimeRotorCheck,
  ROTOR_ROW_REFUSAL_LIMIT,
} from "../api/seq/_lib/booking-protection-catchup.mjs";
import { LIVESET_SCHEMA } from "../api/seq/_lib/booking-protection-liveset.mjs";
import {
  createPacer,
  pacedRelationshipStatusLoader,
  PACE_MIN_INTERVAL_MS,
} from "../api/seq/_lib/booking-protection-pace.mjs";

const NOW = Date.parse("2026-09-26T12:00:00.000Z");

function usableLiveSet(entries) {
  return { schema: LIVESET_SCHEMA, builtAt: new Date(NOW - 3600_000).toISOString(), byEmail: entries };
}

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
  assert.deepEqual(rotorState, { cursor: 1, next: "ccu_01", refused: { ccu: "ccu_01", kind: "read", count: 1 } });

  const second = await bookTimeRotorCheck(common);
  assert.equal(second.passedRefused, 1);
  assert.equal(second.readErrors, 0, "a passed refusal is not also a read error");
  assert.equal(second.stoppedBy, "budget");
  assert.deepEqual(read, ["cu_0", "cu_1", "cu_1", "cu_2"], "the second refusal passes the row and the run moves on");
  assert.deepEqual(rotorState, { cursor: 3, next: "ccu_03", refused: null });
});

test("a backoff or a dead session at the cursor does not count against the row", async () => {
  for (const code of ["PARAFORM_PACED_BACKOFF", "PARAFORM_SESSION_DEAD"]) {
    const before = { cursor: 1, next: "ccu_01", refused: { ccu: "ccu_01", kind: "read", count: 1 } };
    let rotorState = before;
    const out = await bookTimeRotorCheck({
      now: NOW,
      loadLive: async () => usableLiveSet(rotorRows(4)),
      loadRotor: async () => rotorState,
      saveRotor: async (cursor, extra = {}) => { rotorState = { cursor, ...extra }; },
      budget: 2,
      relationshipStatusLoader: async () => { throw Object.assign(new Error(code), { code }); },
    });
    assert.equal(out.stoppedBy, "refused", code);
    assert.equal(out.stopReason, code);
    assert.equal(out.passedRefused, 0, code);
    assert.equal(rotorState, before, `${code}: nothing was sent, so nothing is saved`);
  }
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
  assert.deepEqual(rotorState, { cursor: 1, next: "ccu_01", refused: { ccu: "ccu_01", kind: "pause", count: 1 } });

  // The next run retries the same row first; a second failure passes it.
  const second = await bookTimeRotorCheck(common);
  assert.equal(pauseAttempts, 2);
  assert.equal(second.passedPauseFailures, 1);
  assert.equal(second.passedRefused, 0);
  assert.equal(second.stoppedBy, "lap");
  assert.equal(rotorState.refused, null);
});

test("a pause the pacer never sent does not count toward passing the booked lead over", async () => {
  const booked = { status: "SCHEDULED_CALL", at: "2026-08-01T00:00:00.000Z" };
  let rotorState = null;
  const common = {
    now: NOW,
    loadLive: async () => usableLiveSet(rotorRows(3)),
    loadRotor: async () => rotorState,
    saveRotor: async (cursor, extra = {}) => { rotorState = { cursor, ...extra }; },
    relationshipStatusLoader: async (cu) => (cu === "cu_1" ? booked : null),
    applyDecisionsImpl: async () => ({ paused: 0, pauseErrors: [{ sequence: "seq_1", reason: "PARAFORM_PACED_BACKOFF" }] }),
    budget: 3,
  };
  for (let run = 0; run < 3; run++) {
    const out = await bookTimeRotorCheck(common);
    assert.equal(out.stoppedBy, "refused");
    assert.equal(out.passedPauseFailures, 0);
  }
  assert.equal(rotorState.next, "ccu_01", "still on the booked lead after three runs");
  assert.equal(rotorState.refused, null);
});

test("the cursor is the row's own id, so leads added or removed overnight do not move it", async () => {
  // Round-2 review finding: a position in a list rebuilt every day lands on
  // the wrong row when rows before it come or go.
  const row = (id, cu = `cu_${id}`) => ({
    ccu: `ccu_${id}`, cu, n: id, s: "seq_1", sn: "No Show - Agent Call", t: "2026-01-01T00:00:00.000Z",
  });
  const liveSetOf = (ids) => usableLiveSet(Object.fromEntries(ids.map((id) => [`${id}@example.com`, [row(id)]])));
  const booked = { status: "SCHEDULED_CALL", at: "2026-08-01T00:00:00.000Z" };

  // A failed pause on c, then a drops out overnight: the next run still
  // starts on c and retries the pause.
  let rotorState = null;
  const pausesTried = [];
  let ids = ["a", "b", "c", "d"];
  const pauseCommon = {
    now: NOW,
    loadLive: async () => liveSetOf(ids),
    loadRotor: async () => rotorState,
    saveRotor: async (cursor, extra = {}) => { rotorState = { cursor, ...extra }; },
    relationshipStatusLoader: async (cu) => (cu === "cu_c" ? booked : null),
    applyDecisionsImpl: async (decisions) => {
      pausesTried.push(decisions[0].ccuId);
      return { paused: 0, pauseErrors: [{ sequence: "seq_1", reason: "PARAFORM_HTTP_429" }] };
    },
    budget: 4,
  };
  await bookTimeRotorCheck(pauseCommon);
  assert.equal(rotorState.next, "ccu_c");
  ids = ["b", "c", "d"];
  await bookTimeRotorCheck(pauseCommon);
  assert.deepEqual(pausesTried, ["ccu_c", "ccu_c"]);

  // A row refused every day, with a new lead sorting before it each night:
  // the count still reaches the limit and the row is passed.
  rotorState = null;
  ids = ["m", "n", "p"];
  const read = [];
  const refuseCommon = {
    now: NOW,
    loadLive: async () => liveSetOf(ids),
    loadRotor: async () => rotorState,
    saveRotor: async (cursor, extra = {}) => { rotorState = { cursor, ...extra }; },
    relationshipStatusLoader: async (cu) => {
      read.push(cu);
      if (cu === "cu_n") throw Object.assign(new Error("PARAFORM_HTTP_500"), { code: "PARAFORM_REFUSED", status: 500 });
      return null;
    },
    budget: 3,
  };
  const day1 = await bookTimeRotorCheck(refuseCommon);
  assert.equal(day1.stoppedBy, "refused");
  ids = ["a", "m", "n", "p"];
  const day2 = await bookTimeRotorCheck(refuseCommon);
  assert.equal(day2.passedRefused, 1);
  assert.deepEqual(read, ["cu_m", "cu_n", "cu_n", "cu_p", "cu_a"]);
});

test("a cursor saved before this change (a position only) is still honoured once", async () => {
  const read = [];
  const out = await bookTimeRotorCheck({
    now: NOW,
    loadLive: async () => usableLiveSet(rotorRows(4)),
    loadRotor: async () => ({ cursor: 2 }),
    saveRotor: async () => {},
    relationshipStatusLoader: async (cu) => { read.push(cu); return null; },
    budget: 1,
  });
  assert.deepEqual(read, ["cu_2"]);
  assert.equal(out.next, "ccu_03");
});

test("rows with no candidate user id cost no cursor write each", async () => {
  const saves = [];
  const out = await bookTimeRotorCheck({
    now: NOW,
    loadLive: async () => usableLiveSet(rotorRows(8, { cuOf: (i) => (i < 6 ? null : `cu_${i}`) })),
    loadRotor: async () => null,
    saveRotor: async (cursor) => { saves.push(cursor); },
    relationshipStatusLoader: async () => null,
    budget: 5,
  });
  assert.equal(out.reads, 2);
  assert.deepEqual(saves, [6, 7, 0], "before each read, and once at the end");
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
  assert.equal(out.stoppedBy, "budget_invalid");
});

test("a refused read and then one failed pause do not add up to passing a booked lead over", async () => {
  // Focused-check finding: read refusals and pause failures shared one count.
  const booked = { status: "SCHEDULED_CALL", at: "2026-08-01T00:00:00.000Z" };
  let rotorState = { cursor: 1, next: "ccu_01", refused: { ccu: "ccu_01", kind: "read", count: 1 } };
  const common = {
    now: NOW,
    loadLive: async () => usableLiveSet(rotorRows(3)),
    loadRotor: async () => rotorState,
    saveRotor: async (cursor, extra = {}) => { rotorState = { cursor, ...extra }; },
    relationshipStatusLoader: async (cu) => (cu === "cu_1" ? booked : null),
    applyDecisionsImpl: async () => ({ paused: 0, pauseErrors: [{ sequence: "seq_1", reason: "PARAFORM_HTTP_429" }] }),
    budget: 3,
  };
  const out = await bookTimeRotorCheck(common);
  assert.equal(out.passedPauseFailures, 0);
  assert.equal(out.stoppedBy, "refused");
  assert.deepEqual(rotorState.refused, { ccu: "ccu_01", kind: "pause", count: 1 });
  const again = await bookTimeRotorCheck(common);
  assert.equal(again.passedPauseFailures, 1, "the second failed pause in a row passes it");
});

test("a passed-over refusal does not pass another lead of the same candidate unread", async () => {
  // Focused-check finding: the passed row's error was cached for the
  // candidate, so a sibling lead was passed with no refusal of its own.
  const rows = {
    "same@example.com": [
      { ccu: "ccu_0", cu: "cu_same", n: "Cand", s: "seq_1", sn: "No Show - Agent Call", t: "2026-07-01T00:00:00.000Z" },
      { ccu: "ccu_1", cu: "cu_same", n: "Cand", s: "seq_2", sn: "No Show - Agent Call", t: "2026-07-01T00:00:00.000Z" },
    ],
  };
  let rotorState = { cursor: 0, next: "ccu_0", refused: { ccu: "ccu_0", kind: "read", count: 1 } };
  let reads = 0;
  const out = await bookTimeRotorCheck({
    now: NOW,
    loadLive: async () => usableLiveSet(rows),
    loadRotor: async () => rotorState,
    saveRotor: async (cursor, extra = {}) => { rotorState = { cursor, ...extra }; },
    relationshipStatusLoader: async () => {
      reads++;
      throw Object.assign(new Error("PARAFORM_HTTP_403"), { code: "PARAFORM_REFUSED", status: 403 });
    },
    budget: 5,
  });
  assert.equal(reads, 2, "the sibling lead is read again");
  assert.equal(out.passedRefused, 1);
  assert.equal(out.stoppedBy, "refused");
  assert.deepEqual(rotorState, { cursor: 1, next: "ccu_1", refused: { ccu: "ccu_1", kind: "read", count: 1 } });
});

test("a position-only cursor is rewritten with its lead id on the first run, even one that sends nothing", async () => {
  let rotorState = { cursor: 2, refused: { ccu: "ccu_00", count: 1 } };
  const out = await bookTimeRotorCheck({
    now: NOW,
    loadLive: async () => usableLiveSet(rotorRows(4)),
    loadRotor: async () => rotorState,
    saveRotor: async (cursor, extra = {}) => { rotorState = { cursor, ...extra }; },
    relationshipStatusLoader: async () => {
      throw Object.assign(new Error("PARAFORM_PACED_BACKOFF"), { code: "PARAFORM_PACED_BACKOFF" });
    },
    budget: 2,
  });
  assert.equal(out.stoppedBy, "refused");
  assert.deepEqual(rotorState, { cursor: 2, next: "ccu_02", refused: null }, "an old count on another row is not carried over");
});
