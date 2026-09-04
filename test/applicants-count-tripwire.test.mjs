// Count-drop tripwire: sync compares each publish's queue/stream sizes with
// the previous publish (apphub:counts) and latches a display-only alert when
// either collapses past COUNT_DROP_RATIO. Born from the 2026-08-10 incident
// where a poisoned upstream CRM index published a 2,244 → 22 review queue
// overnight and the tab rendered it silently.

import test from "node:test";
import assert from "node:assert/strict";

import {
  COUNT_DROP_FLOOR,
  COUNT_DROP_RATIO,
  acknowledgeCountsDoc,
  createSyncHandler,
  nextCountsDoc,
} from "../api/applicants/sync.mjs";
import { createFeedHandler } from "../api/applicants/feed.mjs";
import {
  publicationBody,
  publishInto,
  sourceReceiptsFor,
  sourceRow,
} from "./helpers/applicant-generation.mjs";

const SAVED_SYNC_KEY = process.env.APPHUB_SYNC_KEY;
const KEY = "apphub-sync-key-0000000000000000001";
const AT = "2026-08-10T03:00:00.000Z";

test.after(() => {
  if (SAVED_SYNC_KEY === undefined) delete process.env.APPHUB_SYNC_KEY;
  else process.env.APPHUB_SYNC_KEY = SAVED_SYNC_KEY;
});

function request({ method = "POST", authorization = `Bearer ${KEY}`, body } = {}) {
  return { method, headers: { authorization }, body };
}

function response() {
  return {
    body: undefined,
    headers: {},
    statusCode: undefined,
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    status(value) { this.statusCode = value; return this; },
    json(value) { this.body = value; return this; },
    end() {},
  };
}

// A publish is only accepted when every active row already carries a durable
// source-profile receipt, so the fake store serves the receipts for whatever
// rows the test is about to publish, and remembers the immutable artifacts the
// generation writes (a publish reads them straight back).
function fakeStore(initial = {}, { receipts = {} } = {}) {
  const calls = { writeJson: [], readJson: [] };
  const written = {};
  return {
    calls,
    written,
    deps: {
      kvReady: () => true,
      readHash: async (key) => (key === "apphub:source-profile-ready" ? receipts : {}),
      writeHash: async (fields) => Object.keys(fields || {}).length,
      writeJson: async (key, value, ttlSeconds) => {
        written[key] = value;
        calls.writeJson.push([key, value, ttlSeconds]);
        return "OK";
      },
      writeImmutableJson: async (key, value) => { written[key] = value; return "OK"; },
      activateGeneration: async (key, _previous, next) => { written[key] = next; return true; },
      readJson: async (key) => {
        calls.readJson.push(key);
        if (key in written) return written[key];
        return initial[key] ?? null;
      },
      readHashKeys: async () => [],
      deleteHashFields: async () => 0,
      saveAck: async () => true,
      now: () => AT,
    },
  };
}

const countsWrite = (calls) => calls.writeJson.find(([key]) => key === "apphub:counts")?.[1];

test("nextCountsDoc trips on a >50% drop and stays quiet on smaller or tiny ones", () => {
  // The incident shape: 2,244 → 22.
  const tripped = nextCountsDoc({ queue: 2244, stream: 400, updatedAt: "x", alert: null }, { queue: 22, stream: 400 }, AT);
  assert.deepEqual(tripped, {
    updatedAt: AT, queue: 22, stream: 400,
    alert: { queue: { baseline: 2244, seen: 22, at: AT } },
  });

  // A 40% drop is normal churn, not a trip.
  assert.equal(nextCountsDoc({ queue: 100, stream: 0 }, { queue: 60, stream: 0 }, AT).alert, null);
  // Exactly at the ratio does not trip — the anomaly is BELOW half.
  assert.equal(nextCountsDoc({ queue: 100 }, { queue: 100 * COUNT_DROP_RATIO }, AT).alert, null);
  // Below the floor a huge relative drop is pure noise (4 → 1).
  assert.equal(nextCountsDoc({ queue: COUNT_DROP_FLOOR - 1 }, { queue: 1 }, AT).alert, null);
  // No prior doc at all: nothing to compare against.
  assert.equal(nextCountsDoc(null, { queue: 22, stream: 0 }, AT).alert, null);
});

test("a tripped alert latches on the pre-drop baseline and clears on recovery", () => {
  const first = nextCountsDoc({ queue: 2244 }, { queue: 22 }, AT);
  // The broken publisher republishes the same collapsed number: compared only
  // with the previous publish (22 → 22) this would self-clear; the latched
  // baseline keeps it up, original trip time preserved.
  const later = "2026-08-10T09:00:00.000Z";
  const held = nextCountsDoc(first, { queue: 22 }, later);
  assert.deepEqual(held.alert, { queue: { baseline: 2244, seen: 22, at: AT } });

  // Upstream fixed, the count recovers past the ratio of the baseline: cleared.
  const recovered = nextCountsDoc(held, { queue: 2200 }, later);
  assert.equal(recovered.alert, null);
  assert.equal(recovered.queue, 2200);
});

test("a publish that omits a dimension carries its count and alert forward", () => {
  const prev = { queue: 22, stream: 400, updatedAt: AT, alert: { queue: { baseline: 2244, seen: 22, at: AT } } };
  const doc = nextCountsDoc(prev, { stream: 390 }, "2026-08-10T04:00:00.000Z");
  assert.equal(doc.queue, 22);
  assert.equal(doc.stream, 390);
  assert.deepEqual(doc.alert, { queue: { baseline: 2244, seen: 22, at: AT } });
});

test("a gradual legitimate drain never trips across publishes", () => {
  let doc = { queue: 2244, stream: 400, updatedAt: AT, alert: null };
  for (const queue of [2000, 1500, 1000, 600, 350, 200, 110, 60, 35, 20, 5]) {
    doc = nextCountsDoc(doc, { queue, stream: 400 }, AT);
    assert.equal(doc.alert, null, `queue=${queue}`);
  }
});

// ---------------------------------------------------------------------------
// A MOVE IS NOT A LOSS (2026-09-04). The receipt cutover relabelled 1,809 rows
// from Stream to the profile-preparing partition; the two-dimension tripwire
// read that as a collapse, latched, and parked every saved rule for a day.
// ---------------------------------------------------------------------------

test("a population moving between partitions never trips", () => {
  // The exact 2026-09-03 shape: Stream 1,811 -> 2, the same rows reappearing
  // as profilePreparing, queue untouched, total identical.
  const prev = { queue: 4345, stream: 1811, profilePreparing: 0, total: 6156, updatedAt: AT, alert: null };
  const doc = nextCountsDoc(prev, { queue: 4345, stream: 2, profilePreparing: 1809, total: 6156 }, AT);
  assert.equal(doc.alert, null);
  assert.equal(doc.stream, 2);
  assert.equal(doc.profilePreparing, 1809);
  assert.equal(doc.total, 6156);
});

test("the same collapse WITHOUT the rows reappearing still trips", () => {
  const prev = { queue: 4345, stream: 1811, profilePreparing: 0, total: 6156, updatedAt: AT, alert: null };
  const doc = nextCountsDoc(prev, { queue: 4345, stream: 2, profilePreparing: 0, total: 4347 }, AT);
  assert.deepEqual(doc.alert, { stream: { baseline: 1811, seen: 2, at: AT } });
});

test("the conserved total is its own dimension and trips when everyone vanishes", () => {
  const prev = { queue: 4345, stream: 1811, profilePreparing: 0, total: 6156, updatedAt: AT, alert: null };
  const doc = nextCountsDoc(prev, { queue: 20, stream: 2, profilePreparing: 0, total: 22 }, AT);
  assert.deepEqual(doc.alert, {
    queue: { baseline: 4345, seen: 20, at: AT },
    stream: { baseline: 1811, seen: 2, at: AT },
    total: { baseline: 6156, seen: 22, at: AT },
  });
});

test("the total is summed from the partitions when a publisher omits it", () => {
  const prev = { queue: 100, stream: 100, profilePreparing: 0, total: 200, updatedAt: AT, alert: null };
  const doc = nextCountsDoc(prev, { queue: 20, stream: 20, profilePreparing: 0 }, AT);
  assert.equal(doc.total, 40);
  assert.equal(doc.alert.total.baseline, 200);
});

test("a re-partition CLEARS a partition alert that is already latched", () => {
  // The latch is one-way against a broken publisher republishing its own
  // collapsed number. Conservation is different evidence: nobody is missing,
  // and the moved rows are never coming back to their old partition, so a
  // latch held against them would park the rules forever.
  const latched = {
    queue: 4345, stream: 2, profilePreparing: 1809, total: 6156, updatedAt: AT,
    alert: { stream: { baseline: 1811, seen: 2, at: AT } },
  };
  const doc = nextCountsDoc(latched, { queue: 4345, stream: 2, profilePreparing: 1809, total: 6156 }, AT);
  assert.equal(doc.alert, null);
});

test("conservation is only claimed from two known totals", () => {
  // A doc written before the total existed cannot prove anything, so the
  // partition drop alerts exactly as it did before this change.
  const prev = { queue: 4345, stream: 1811, updatedAt: AT, alert: null };
  const doc = nextCountsDoc(prev, { queue: 4345, stream: 2, profilePreparing: 1809, total: 6156 }, AT);
  assert.deepEqual(doc.alert, { stream: { baseline: 1811, seen: 2, at: AT } });
});

test("acknowledging re-baselines all three partitions and the total", () => {
  const prev = {
    queue: 4345, stream: 2, profilePreparing: 1809, total: 6156, updatedAt: AT,
    alert: { stream: { baseline: 1811, seen: 2, at: AT } },
  };
  const { doc } = acknowledgeCountsDoc(prev, { by: "david", at: AT, note: "archive cohort retired" });
  assert.deepEqual(doc.acknowledged.accepted, { queue: 4345, stream: 2, profilePreparing: 1809, total: 6156 });
  // And the very next genuine collapse trips from the accepted numbers. Losing
  // the preparing partition is a 4,357 total, still over half of 6,156, so the
  // total holds while the partition that actually collapsed is named.
  assert.deepEqual(
    nextCountsDoc(doc, { queue: 4345, stream: 2, profilePreparing: 10, total: 4357 }, AT).alert,
    { profilePreparing: { baseline: 1809, seen: 10, at: AT } },
  );
  // Everyone vanishing trips the total too.
  assert.equal(nextCountsDoc(doc, { queue: 20, stream: 2, profilePreparing: 0, total: 22 }, AT).alert.total.baseline, 6156);
});

test("sync writes the counts doc from a full publish and trips against the stored one", async () => {
  process.env.APPHUB_SYNC_KEY = KEY;
  const stream = Array.from({ length: 380 }, (_, i) => sourceRow(`s${i}`));
  const queue = Array.from({ length: 22 }, (_, i) => sourceRow(`q${i}`));
  const { calls, deps } = fakeStore({
    "apphub:counts": { queue: 2244, stream: 400, updatedAt: "2026-08-09T21:00:00.000Z", alert: null },
  }, { receipts: sourceReceiptsFor([...stream, ...queue]) });
  const handler = createSyncHandler(deps);
  const res = response();
  await handler(request({
    body: publicationBody({ snapshot: { generatedAt: AT, stream }, queue }),
  }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.stored.snapshot, true);
  assert.equal(res.body.stored.queue, true);
  assert.equal(res.body.stored.acks, 0);
  // The conserved dimensions ride the same doc as the tripwire's own state.
  const counts = countsWrite(calls);
  assert.deepEqual(
    { updatedAt: counts.updatedAt, queue: counts.queue, stream: counts.stream,
      total: counts.total, profilePreparing: counts.profilePreparing, alert: counts.alert },
    { updatedAt: AT, queue: 22, stream: 380, total: 402, profilePreparing: 0,
      alert: { queue: { baseline: 2244, seen: 22, at: AT } } },
  );
  // The doc is the generation's own counts artifact, so it carries the
  // publication stamp beside the tripwire state.
  assert.equal(counts.generationId, res.body.generation.id);
});

test("sync counts a snapshot-embedded queue only when no split doc rode the POST", async () => {
  process.env.APPHUB_SYNC_KEY = KEY;
  const { calls, deps } = fakeStore();
  const handler = createSyncHandler(deps);
  const res = response();
  // Older publisher shape: queue embedded in the snapshot, stream missing → 0.
  await handler(request({ body: { snapshot: { generatedAt: AT, queue: [{ key: "cu1:r" }] } } }), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(countsWrite(calls), { updatedAt: AT, queue: 1, stream: 0, alert: null });
});

test("a counts-store failure never fails the sync that carried real data", async () => {
  process.env.APPHUB_SYNC_KEY = KEY;
  const { calls, deps } = fakeStore();
  // A legacy partial publish still exercises the best-effort counts write: it
  // never advances the active generation, so a dead readJson cannot cost the
  // snapshot that rode the same POST.
  deps.readJson = async () => { throw new Error("kv down"); };
  const handler = createSyncHandler(deps);
  const res = response();
  await handler(request({ body: { snapshot: { generatedAt: AT, stream: [] } } }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.stored.snapshot, true);
  assert.equal(countsWrite(calls), undefined);
});

test("an acks-only POST never touches the counts doc", async () => {
  process.env.APPHUB_SYNC_KEY = KEY;
  const { calls, deps } = fakeStore();
  const handler = createSyncHandler(deps);
  const res = response();
  await handler(request({ body: { acks: { "cu1:role1": { status: "invited" } } } }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(calls.readJson.length, 0);
  assert.equal(countsWrite(calls), undefined);
});

// ---------------------------------------------------------------------------
// ACKNOWLEDGEMENT. The latch is one-way on purpose, which is right for a break
// and wrong for a verified permanent change (2026-08-24: the invite lane's
// queue legitimately settled at ~1,183 against a stale 2,479 baseline, so the
// alert could never clear and rules-tick stayed parked indefinitely).
// ---------------------------------------------------------------------------

test("acknowledging re-baselines to today's counts and records who accepted what", () => {
  const prev = { queue: 1183, stream: 1923, updatedAt: AT, alert: { queue: { baseline: 2479, seen: 196, at: AT } } };
  const { doc, cleared } = acknowledgeCountsDoc(prev, { by: "david", at: AT, note: "index restored" });

  assert.equal(doc.alert, null);
  assert.deepEqual(cleared, { queue: { baseline: 2479, seen: 196, at: AT } });
  // The counts themselves are untouched — this moves the baseline, it does not
  // invent a number.
  assert.equal(doc.queue, 1183);
  assert.equal(doc.stream, 1923);
  assert.deepEqual(doc.acknowledged, {
    at: AT, by: "david", note: "index restored",
    cleared: { queue: { baseline: 2479, seen: 196, at: AT } },
    // Every dimension the tripwire watches, explicit null where this doc
    // predates it — never a fabricated zero.
    accepted: { queue: 1183, stream: 1923, profilePreparing: null, total: null },
  });
});

test("acknowledging does NOT suppress the next genuine collapse", () => {
  const prev = { queue: 1183, stream: 1923, updatedAt: AT, alert: { queue: { baseline: 2479, seen: 196, at: AT } } };
  const { doc } = acknowledgeCountsDoc(prev, { by: "david", at: AT });

  // A normal publish right after: nothing trips, and the baseline is now 1183.
  assert.equal(nextCountsDoc(doc, { queue: 1190, stream: 1930 }, AT).alert, null);
  // A real collapse from the NEW baseline trips immediately.
  assert.deepEqual(
    nextCountsDoc(doc, { queue: 30, stream: 1930 }, AT).alert,
    { queue: { baseline: 1183, seen: 30, at: AT } },
  );
});

test("acknowledging with nothing latched is a no-op, not an error", () => {
  const { doc, cleared } = acknowledgeCountsDoc({ queue: 100, stream: 100, alert: null }, { by: "david", at: AT });
  assert.equal(cleared, null);
  assert.equal(doc.alert, null);
  assert.equal(doc.acknowledged, undefined);
});

test("sync acknowledges a latched alert, and refuses one with no author", async () => {
  process.env.APPHUB_SYNC_KEY = KEY;
  const latched = { queue: 1183, stream: 1923, updatedAt: AT, alert: { queue: { baseline: 2479, seen: 196, at: AT } } };

  // No `by` — refused. An unattributed re-baseline is exactly the reset button
  // this must not be.
  {
    const { calls, deps } = fakeStore({ "apphub:counts": latched });
    const res = response();
    await createSyncHandler(deps)(request({ body: { acknowledgeCountsAlert: {} } }), res);
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.error, "acknowledge_requires_by");
    assert.equal(countsWrite(calls), undefined);
  }

  // With an author — cleared and recorded.
  {
    const { calls, deps } = fakeStore({ "apphub:counts": latched });
    const res = response();
    await createSyncHandler(deps)(request({ body: { acknowledgeCountsAlert: { by: "david", note: "verified" } } }), res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body.cleared, { queue: { baseline: 2479, seen: 196, at: AT } });
    const written = countsWrite(calls);
    assert.equal(written.alert, null);
    assert.equal(written.queue, 1183);
    assert.equal(written.acknowledged.by, "david");
  }
});

test("an acknowledge POST never writes the snapshot or queue keys", async () => {
  process.env.APPHUB_SYNC_KEY = KEY;
  const { calls, deps } = fakeStore({
    "apphub:counts": { queue: 1183, stream: 1923, alert: { queue: { baseline: 2479, seen: 196, at: AT } } },
  });
  const res = response();
  await createSyncHandler(deps)(request({
    // A snapshot riding along is ignored: acknowledging is not a publish.
    body: { acknowledgeCountsAlert: { by: "david" }, snapshot: { generatedAt: AT, stream: [] }, queue: [] },
  }), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(calls.writeJson.map(([key]) => key), ["apphub:counts"]);
});

test("feed returns the counts doc alongside the snapshot", async () => {
  // The tripwire doc is not a free-standing key any more: it is the counts
  // artifact of the active generation, so the browser can never read an alert
  // that belongs to a different publication than the rows beside it.
  const state = {};
  const generation = publishInto(state, {
    snapshot: { generatedAt: AT, stream: [] },
    queue: [],
    counts: { updatedAt: AT, alert: { queue: { baseline: 2244, seen: 22, at: AT } } },
  });
  const handler = createFeedHandler({
    corsHandler: () => false,
    authHandler: async () => true,
    kvReady: () => true,
    readJson: async (key) => state[key] ?? null,
    readHash: async () => ({}),
  });
  const res = response();
  await handler(request({ method: "GET" }), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.counts, generation.counts);
  assert.deepEqual(res.body.counts.alert, { queue: { baseline: 2244, seen: 22, at: AT } });
});

// ---------------------------------------------------------------------------
// A PARTIAL PUBLISH CAN NEVER PROVE CONSERVATION (2026-09-04, review finding).
// `doc.total` is set from the incoming publish OR carried forward from the
// previous doc. If the carried number counted as evidence, it would prove
// conservation against itself and delete a partition alert latched one line
// earlier — silencing the exact 2,244 -> 22 collapse this tripwire exists for.
// ---------------------------------------------------------------------------

test("a partial publish can never prove conservation", () => {
  const prev = { queue: 4000, stream: 1800, profilePreparing: 0, total: 5800, updatedAt: AT, alert: null };
  const doc = nextCountsDoc(prev, { queue: 2 }, AT);
  // The carried total is still on the doc — it is the last known number, and
  // dropping it would lose the baseline for the next full publish.
  assert.equal(doc.total, 5800);
  // But it proves nothing: the queue collapse latches.
  assert.deepEqual(doc.alert, { queue: { baseline: 4000, seen: 2, at: AT } });
});

test("a partial publish cannot clear an alert a full publish latched", () => {
  const prev = { queue: 4000, stream: 1800, profilePreparing: 0, total: 5800, updatedAt: AT, alert: null };
  const latched = nextCountsDoc(prev, { queue: 2, stream: 1800, profilePreparing: 0, total: 1802 }, AT);
  // The queue collapsed AND the population really did shrink, so both the
  // partition and the conserved total latch. This is the genuine loss alarm.
  assert.deepEqual(latched.alert, {
    queue: { baseline: 4000, seen: 2, at: AT },
    total: { baseline: 5800, seen: 1802, at: AT },
  });
  // A later publish that omits the total (and does not carry all three
  // partitions) must leave both latches exactly where they are.
  const held = nextCountsDoc(latched, { stream: 1800 }, "2026-09-04T10:00:00.000Z");
  assert.deepEqual(held.alert, {
    queue: { baseline: 4000, seen: 2, at: AT },
    total: { baseline: 5800, seen: 1802, at: AT },
  });
});

test("a full publish that conserves the total still clears a partition alert", () => {
  // The move-is-not-a-loss path is untouched: the total is declared HERE.
  const prev = { queue: 4345, stream: 1811, profilePreparing: 0, total: 6156, updatedAt: AT, alert: null };
  const doc = nextCountsDoc(prev, { queue: 4345, stream: 2, profilePreparing: 1809, total: 6156 }, AT);
  assert.equal(doc.alert, null);
  // And summed-from-partitions counts as declared, because it is the same
  // number by construction.
  const summed = nextCountsDoc(prev, { queue: 4345, stream: 2, profilePreparing: 1809 }, AT);
  assert.equal(summed.alert, null);
  assert.equal(summed.total, 6156);
});
