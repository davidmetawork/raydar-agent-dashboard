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
  createSyncHandler,
  nextCountsDoc,
} from "../api/applicants/sync.mjs";
import { createFeedHandler } from "../api/applicants/feed.mjs";

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

function fakeStore(initial = {}) {
  const calls = { writeJson: [], readJson: [] };
  return {
    calls,
    deps: {
      kvReady: () => true,
      readHash: async () => ({}),
      writeHash: async (fields) => Object.keys(fields || {}).length,
      writeJson: async (key, value, ttlSeconds) => { calls.writeJson.push([key, value, ttlSeconds]); return "OK"; },
      readJson: async (key) => { calls.readJson.push(key); return initial[key] ?? null; },
      readHashKeys: async () => [],
      deleteHashFields: async () => 0,
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

test("sync writes the counts doc from a full publish and trips against the stored one", async () => {
  process.env.APPHUB_SYNC_KEY = KEY;
  const { calls, deps } = fakeStore({
    "apphub:counts": { queue: 2244, stream: 400, updatedAt: "2026-08-09T21:00:00.000Z", alert: null },
  });
  const handler = createSyncHandler(deps);
  const res = response();
  await handler(request({
    body: {
      snapshot: { generatedAt: AT, stream: Array.from({ length: 380 }, (_, i) => ({ key: `cu${i}:r` })) },
      queue: Array.from({ length: 22 }, (_, i) => ({ key: `cu${i}:r` })),
    },
  }), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.stored, { snapshot: true, queue: true, acks: 0 });
  assert.deepEqual(countsWrite(calls), {
    updatedAt: AT, queue: 22, stream: 380,
    alert: { queue: { baseline: 2244, seen: 22, at: AT } },
  });
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
  deps.readJson = async () => { throw new Error("kv down"); };
  const handler = createSyncHandler(deps);
  const res = response();
  await handler(request({ body: { snapshot: { generatedAt: AT, stream: [] }, queue: [] } }), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.stored, { snapshot: true, queue: true, acks: 0 });
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

test("feed returns the counts doc alongside the snapshot", async () => {
  const counts = { queue: 22, stream: 380, updatedAt: AT, alert: { queue: { baseline: 2244, seen: 22, at: AT } } };
  const handler = createFeedHandler({
    corsHandler: () => false,
    authHandler: async () => true,
    kvReady: () => true,
    readJson: async (key) => ({ "apphub:counts": counts, "apphub:snapshot": { generatedAt: AT } }[key] ?? null),
    readHash: async () => ({}),
  });
  const res = response();
  await handler(request({ method: "GET" }), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.counts, counts);
});
