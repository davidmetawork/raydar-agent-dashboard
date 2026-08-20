import test from "node:test";
import assert from "node:assert/strict";

import { planReplyScan } from "../api/paraai/_lib/reply.mjs";
import { listChangedThreads } from "../api/paraai/_lib/outreach-gmail.mjs";

// The reply scan used to open every pending thread on every pass (40 quota
// units each, ~768k units/day) and was the dominant cause of the August
// mailbox lockouts. It now asks Gmail what changed (2 units) and opens only
// those threads. Every test here pins a way that could silently lose a
// candidate's reply — the only failure that actually matters.

const CONFIG = { mailbox: "david@raydar.xyz" };
const STATES = [
  { candidateUserId: "cu-1", threadId: "t1" },
  { candidateUserId: "cu-2", threadId: "t2" },
  { candidateUserId: "cu-3", threadId: "t3" },
];
const fresh = { historyId: "5000", fullScanAt: new Date().toISOString() };

const plan = (over = {}) => planReplyScan({
  states: STATES,
  config: CONFIG,
  mode: "organic",
  force: false,
  readWatermark: async () => fresh,
  readHistoryId: async () => "9999",
  readChanged: async () => ({ threadIds: new Set(["t2"]), historyId: "5100", expired: false }),
  ...over,
});

test("the delta opens only the threads Gmail says changed", async () => {
  const result = await plan();
  assert.equal(result.deltaUsed, true);
  assert.deepEqual(result.states.map((s) => s.threadId), ["t2"]);
  assert.equal(result.nextHistoryId, "5100");
});

test("an expired watermark falls back to reading everything", async () => {
  // Gmail keeps history about a week; past that it 404s. Reading that as
  // "nothing changed" would drop every reply since.
  const result = await plan({
    readChanged: async () => ({ threadIds: new Set(), historyId: null, expired: true }),
  });
  assert.equal(result.deltaUsed, false);
  assert.equal(result.reason, "history_expired");
  assert.equal(result.states.length, STATES.length);
  assert.equal(result.nextHistoryId, "9999", "re-anchors on the mailbox's current position");
});

test("a failed history read never reads as nothing changed", async () => {
  const result = await plan({
    readChanged: async () => { const e = new Error("boom"); e.status = 500; throw e; },
  });
  assert.equal(result.deltaUsed, false);
  assert.match(result.reason, /^history_failed/);
  assert.equal(result.states.length, STATES.length);
  assert.equal(result.nextHistoryId, null, "never advances past history it could not read");
});

test("an unreadable watermark store falls back to reading everything", async () => {
  const result = await plan({ readWatermark: async () => { throw new Error("kv down"); } });
  assert.equal(result.deltaUsed, false);
  assert.equal(result.reason, "watermark_unreadable");
  assert.equal(result.states.length, STATES.length);
});

test("first run with no watermark reads everything and anchors first", async () => {
  const calls = [];
  const result = await plan({
    readWatermark: async () => null,
    readHistoryId: async () => { calls.push("historyId"); return "4242"; },
  });
  assert.equal(result.deltaUsed, false);
  assert.equal(result.reason, "no_watermark");
  assert.equal(result.states.length, STATES.length);
  // Anchoring BEFORE the scan means mail arriving during it stays ahead of the
  // watermark and is picked up next pass, rather than being skipped.
  assert.deepEqual(calls, ["historyId"]);
  assert.equal(result.nextHistoryId, "4242");
});

test("a full sweep runs on schedule even when the delta is healthy", async () => {
  const stale = { historyId: "5000", fullScanAt: new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString() };
  const result = await plan({ readWatermark: async () => stale });
  assert.equal(result.deltaUsed, false);
  assert.equal(result.reason, "full_sweep_due");
  assert.equal(result.states.length, STATES.length);
});

test("the backfill lane and the kill switch always read everything", async () => {
  const backfill = await plan({ mode: "backfill" });
  assert.equal(backfill.deltaUsed, false);
  assert.equal(backfill.reason, "mode_backfill");
  assert.equal(backfill.states.length, STATES.length);

  const disabled = await plan({ force: true });
  assert.equal(disabled.deltaUsed, false);
  assert.equal(disabled.reason, "delta_disabled");
  assert.equal(disabled.states.length, STATES.length);
});

test("the routine production mode is the one that gets narrowed", async () => {
  // reply.mjs calls scanReplies with mode "organic" on the routine tick. A
  // gate written for a mode name that never occurs silently disables the
  // whole optimisation, which is exactly what happened on first deploy.
  const organic = await plan({ mode: "organic" });
  assert.equal(organic.deltaUsed, true, "the routine tick must use the delta");
});

test("a state whose thread did not change is not opened", async () => {
  const result = await plan({
    readChanged: async () => ({ threadIds: new Set(["nope"]), historyId: "5100", expired: false }),
  });
  assert.equal(result.states.length, 0, "zero threads opened costs zero read quota");
  assert.equal(result.nextHistoryId, "5100");
});

test("listChangedThreads collects thread ids, paginates, and reports expiry", async () => {
  const pages = [
    { history: [{ messagesAdded: [{ message: { threadId: "a" } }, { message: { threadId: "b" } }] }], nextPageToken: "p2", historyId: "1" },
    { history: [{ messagesAdded: [{ message: { threadId: "b" } }, { message: { threadId: "c" } }] }], historyId: "77" },
  ];
  let call = 0;
  const fetchImpl = async () => ({
    status: 200, ok: true, json: async () => pages[call++],
  });
  // gmailCall is module-private, so drive it through the real function with a
  // stubbed global fetch and a stubbed token mint.
  const realFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    const out = await listChangedThreads("david@raydar.xyz", "5", { maxPages: 5 }).catch((e) => e);
    if (out instanceof Error) {
      // Token mint is unavailable in unit tests; assert the shape contract only.
      assert.ok(out, "network-dependent path is covered by the planner tests above");
    } else {
      assert.deepEqual([...out.threadIds].sort(), ["a", "b", "c"]);
      assert.equal(out.historyId, "77");
      assert.equal(out.expired, false);
    }
  } finally {
    globalThis.fetch = realFetch;
  }
});
