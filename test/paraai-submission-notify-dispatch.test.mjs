import test from "node:test";
import assert from "node:assert/strict";

import {
  dispatchEvents,
  isSeeded,
  markSeeded,
} from "../api/paraai/_lib/submission-notify-dispatch.mjs";
import {
  SIGNAL_INTERESTED,
  STREAM_INTEREST,
  STREAM_REQUEST,
  notificationDedupeKey,
} from "../api/paraai/_lib/submission-notify.mjs";

function harness({ store = new Map(), post = async () => true } = {}) {
  const posted = [];
  return {
    store,
    posted,
    kvGet: async (k) => store.get(k) ?? null,
    kvSet: async (k, v) => { store.set(k, v); },
    postMessage: async (text) => { const ok = await post(text); if (ok) posted.push(text); return ok; },
  };
}

const evt = (over = {}) => ({
  stream: STREAM_INTEREST,
  candidateUserId: "c1",
  candidateName: "Ada Lovelace",
  eventId: "e1",
  signal: SIGNAL_INTERESTED,
  ...over,
});

test("a new event is posted once and remembered", async () => {
  const h = harness();
  const out = await dispatchEvents({ events: [evt()], ...h });
  assert.equal(out.posted, 1);
  assert.equal(h.posted.length, 1);
  assert.match(h.posted[0], /Ada Lovelace/);
  assert.ok(h.store.get(notificationDedupeKey({ stream: STREAM_INTEREST, candidateUserId: "c1", eventId: "e1" })));
});

test("the same event is never posted twice", async () => {
  const h = harness();
  await dispatchEvents({ events: [evt()], ...h });
  const out = await dispatchEvents({ events: [evt()], ...h });
  assert.equal(out.posted, 0);
  assert.equal(out.duplicate, 1);
  assert.equal(h.posted.length, 1, "still only one message overall");
});

test("re-scanning the whole source is safe: only genuinely new events post", async () => {
  // The collectors are deliberately dumb and re-scan everything each run.
  const h = harness();
  await dispatchEvents({ events: [evt({ eventId: "e1" })], ...h });
  const out = await dispatchEvents({
    events: [evt({ eventId: "e1" }), evt({ eventId: "e2" })], ...h,
  });
  assert.equal(out.posted, 1);
  assert.equal(out.duplicate, 1);
  assert.equal(h.posted.length, 2);
});

test("the same event id in two streams is not treated as a duplicate", async () => {
  const h = harness();
  const out = await dispatchEvents({
    events: [evt({ stream: STREAM_INTEREST }), evt({ stream: STREAM_REQUEST })], ...h,
  });
  assert.equal(out.posted, 2);
});

/* ─────────────────────────────────────────────────────────── the seeding rule */

test("seeding marks everything as seen and posts nothing", async () => {
  const h = harness();
  const out = await dispatchEvents({
    events: [evt({ eventId: "old1" }), evt({ eventId: "old2" })], seeding: true, ...h,
  });
  assert.equal(out.posted, 0);
  assert.equal(out.seeded, 2);
  assert.equal(h.posted.length, 0, "day one must not replay history into the channel");
});

test("events seeded on the first run never post afterwards", async () => {
  const h = harness();
  await dispatchEvents({ events: [evt({ eventId: "old1" })], seeding: true, ...h });
  const out = await dispatchEvents({ events: [evt({ eventId: "old1" })], ...h });
  assert.equal(out.posted, 0);
  assert.equal(out.duplicate, 1);
});

test("an event arriving after seeding does post", async () => {
  const h = harness();
  await dispatchEvents({ events: [evt({ eventId: "old1" })], seeding: true, ...h });
  const out = await dispatchEvents({
    events: [evt({ eventId: "old1" }), evt({ eventId: "new1" })], ...h,
  });
  assert.equal(out.posted, 1);
  assert.match(h.posted[0], /Ada Lovelace/);
});

test("the seeded flag round-trips", async () => {
  const store = new Map();
  const kvGet = async (k) => store.get(k) ?? null;
  const kvSet = async (k, v) => { store.set(k, v); };
  assert.equal(await isSeeded({ kvGet }), false);
  await markSeeded({ kvSet });
  assert.equal(await isSeeded({ kvGet }), true);
});

/* ──────────────────────────────────────────────────── failure must not lose */

test("a failed post is left unmarked so the next run retries it", async () => {
  let allow = false;
  const h = harness({ post: async () => allow });
  const first = await dispatchEvents({ events: [evt()], ...h });
  assert.equal(first.posted, 0);
  assert.equal(first.failed, 1);

  allow = true;
  const second = await dispatchEvents({ events: [evt()], ...h });
  assert.equal(second.posted, 1, "the event must survive a failed send");
});

test("a throwing post is also retried, not swallowed", async () => {
  let boom = true;
  const h = harness({ post: async () => { if (boom) throw new Error("slack down"); return true; } });
  const first = await dispatchEvents({ events: [evt()], ...h });
  assert.equal(first.failed, 1);
  assert.match(first.errors.join(" "), /slack down/);

  boom = false;
  const second = await dispatchEvents({ events: [evt()], ...h });
  assert.equal(second.posted, 1);
});

test("an unreadable dedupe key skips rather than duplicating or dropping silently", async () => {
  const h = harness();
  const out = await dispatchEvents({
    events: [evt()], ...h,
    kvGet: async () => { throw new Error("kv unavailable"); },
  });
  assert.equal(out.posted, 0);
  assert.equal(out.failed, 1);
  assert.match(out.errors.join(" "), /kv unavailable/);
  assert.equal(h.posted.length, 0);
});

test("a mark failure after a successful post is recorded, not hidden", async () => {
  const h = harness();
  const out = await dispatchEvents({
    events: [evt()], ...h,
    kvSet: async () => { throw new Error("kv write refused"); },
  });
  assert.equal(out.posted, 1, "the message did go out");
  assert.match(out.errors.join(" "), /mark failed after posting/);
});

test("malformed events are skipped without derailing the batch", async () => {
  const h = harness();
  const out = await dispatchEvents({ events: [null, {}, evt()], ...h });
  assert.equal(out.posted, 1);
  assert.equal(h.posted.length, 1);
});
