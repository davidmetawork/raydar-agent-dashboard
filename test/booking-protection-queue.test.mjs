import test from "node:test";
import assert from "node:assert/strict";

import {
  enqueuePendingBooking,
  pendingBookingIds,
  readPendingBooking,
  removePendingBooking,
  pendingQueueDepth,
  oldestPendingAgeMs,
} from "../api/seq/_lib/booking-protection-queue.mjs";
import { LITE_KEYS } from "../api/seq/_lib/booking-protection-store.mjs";

function fakeStore() {
  const docs = new Map();
  const set = new Set();
  return {
    docs, set,
    write: async (key, value) => { docs.set(key, value); return "OK"; },
    add: async (key, member) => { void key; set.add(member); return 1; },
    remove: async (key, member) => { void key; set.delete(member); return 1; },
    list: async (key) => { void key; return [...set]; },
    read: async (key) => docs.get(key) ?? null,
  };
}

test("enqueue requires an eventId and writes both the job doc and the pending set", async () => {
  const store = fakeStore();
  await enqueuePendingBooking(
    { eventId: "evt_1", email: "a@example.com" },
    { write: store.write, add: store.add },
  );
  assert.deepEqual(await pendingBookingIds({ list: store.list }), ["evt_1"]);
  assert.deepEqual(
    await readPendingBooking("evt_1", { read: store.read }),
    { eventId: "evt_1", email: "a@example.com" },
  );
  assert.equal(store.docs.has(LITE_KEYS.pending("evt_1")), true);

  await assert.rejects(
    () => enqueuePendingBooking({ email: "no-id@example.com" }, { write: store.write, add: store.add }),
    (error) => error.code === "BOOKING_STOP_LITE_JOB_INVALID",
  );
});

test("remove drops the id from the pending set (the job doc itself just expires by TTL)", async () => {
  const store = fakeStore();
  await enqueuePendingBooking({ eventId: "evt_1" }, { write: store.write, add: store.add });
  await removePendingBooking("evt_1", { remove: store.remove });
  assert.equal(await pendingQueueDepth({ list: store.list }), 0);
});

test("oldestPendingAgeMs finds the OLDEST enqueuedAt across the queue, ignoring bad/missing timestamps", async () => {
  const store = fakeStore();
  const now = Date.parse("2026-09-26T12:00:00.000Z");
  await enqueuePendingBooking(
    { eventId: "evt_new", enqueuedAt: new Date(now - 60_000).toISOString() },
    { write: store.write, add: store.add },
  );
  await enqueuePendingBooking(
    { eventId: "evt_old", enqueuedAt: new Date(now - 3_600_000).toISOString() },
    { write: store.write, add: store.add },
  );
  await enqueuePendingBooking(
    { eventId: "evt_bad_ts", enqueuedAt: "not-a-date" },
    { write: store.write, add: store.add },
  );
  const age = await oldestPendingAgeMs(now, { list: store.list, read: store.read });
  assert.equal(age, 3_600_000);
});

test("an empty queue reports no age at all, not zero", async () => {
  const store = fakeStore();
  assert.equal(await oldestPendingAgeMs(Date.now(), { list: store.list, read: store.read }), null);
  assert.equal(await pendingQueueDepth({ list: store.list }), 0);
});
