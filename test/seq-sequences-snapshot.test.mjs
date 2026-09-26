// api/seq/sequences.mjs (2026-09-26 Paraform read-cut pass): the dropdown
// endpoint used to call listSequences() live on every page load, with no
// cache at all. It now serves a stored snapshot on an ordinary request and
// only ever runs a live read when the caller explicitly asks (`?refresh=1`),
// paced by a shared lock either way.

import assert from "node:assert/strict";
import test from "node:test";

import { createSequencesHandler } from "../api/seq/sequences.mjs";

const noCors = () => false;
const allowAuth = async () => true;

function mockRes() {
  const res = {
    statusCode: null, body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
  return res;
}

const req = (query = {}) => ({ method: "GET", headers: {}, query });

test("an ordinary page load serves the stored snapshot and never calls Paraform", async () => {
  let live = 0;
  const handler = createSequencesHandler({
    corsImpl: noCors, requireAuthImpl: allowAuth, hasCookieImpl: () => true,
    fetchSequences: async () => { live += 1; return [{ id: "s1", name: "Live read" }]; },
    readSnapshot: async () => ({ sequences: [{ id: "s1", name: "Cached Seq" }], fetchedAt: "2026-09-26T00:00:00Z" }),
    writeSnapshot: async () => { throw new Error("must not write on a plain read"); },
    claimRefresh: async () => { throw new Error("must not touch the pacing lock on a plain read"); },
    now: () => Date.parse("2026-09-26T00:30:00Z"),
  });
  const res = mockRes();
  await handler(req(), res);
  assert.equal(live, 0, "an ordinary load must never call listSequences()");
  assert.equal(res.body.ok, true);
  assert.equal(res.body.source, "snapshot");
  assert.deepEqual(res.body.sequences, [{ id: "s1", name: "Cached Seq" }]);
  assert.equal(res.body.snapshotAgeMs, 30 * 60 * 1000);
});

test("a cold start with no snapshot yet bootstraps once and persists the result", async () => {
  let live = 0;
  let written = null;
  const handler = createSequencesHandler({
    corsImpl: noCors, requireAuthImpl: allowAuth, hasCookieImpl: () => true,
    fetchSequences: async () => { live += 1; return [{ id: "s1", name: "Fresh" }]; },
    readSnapshot: async () => null,
    writeSnapshot: async (sequences) => { written = sequences; return { sequences, fetchedAt: "2026-09-26T01:00:00Z" }; },
    claimRefresh: async () => true,
  });
  const res = mockRes();
  await handler(req(), res);
  assert.equal(live, 1, "the very first request, with nothing cached, must do one live read");
  assert.deepEqual(written, [{ id: "s1", name: "Fresh" }]);
  assert.equal(res.body.source, "live");
  assert.deepEqual(res.body.sequences, [{ id: "s1", name: "Fresh" }]);
});

test("a cold start where another request already won the bootstrap lock answers honestly, not with a scan of its own", async () => {
  let live = 0;
  const handler = createSequencesHandler({
    corsImpl: noCors, requireAuthImpl: allowAuth, hasCookieImpl: () => true,
    fetchSequences: async () => { live += 1; return []; },
    readSnapshot: async () => null,
    claimRefresh: async () => false,
  });
  const res = mockRes();
  await handler(req(), res);
  assert.equal(live, 0);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.source, "warming");
  assert.deepEqual(res.body.sequences, []);
});

test("?refresh=1 is the only path that can trigger a live read on a warm snapshot", async () => {
  let live = 0;
  let written = null;
  const handler = createSequencesHandler({
    corsImpl: noCors, requireAuthImpl: allowAuth, hasCookieImpl: () => true,
    fetchSequences: async () => { live += 1; return [{ id: "s2", name: "Refreshed" }]; },
    readSnapshot: async () => ({ sequences: [{ id: "s1", name: "Old" }], fetchedAt: "2026-09-25T00:00:00Z" }),
    writeSnapshot: async (sequences) => { written = sequences; return { sequences, fetchedAt: "2026-09-26T00:00:00Z" }; },
    claimRefresh: async () => true,
  });
  const res = mockRes();
  await handler(req({ refresh: "1" }), res);
  assert.equal(live, 1);
  assert.deepEqual(written, [{ id: "s2", name: "Refreshed" }]);
  assert.equal(res.body.source, "live");
  assert.equal(res.body.refreshed, true);
});

test("?refresh=1 within the pacing window is skipped, serving the last snapshot instead of a second live read", async () => {
  let live = 0;
  const handler = createSequencesHandler({
    corsImpl: noCors, requireAuthImpl: allowAuth, hasCookieImpl: () => true,
    fetchSequences: async () => { live += 1; return []; },
    readSnapshot: async () => ({ sequences: [{ id: "s1", name: "Old" }], fetchedAt: "2026-09-25T00:00:00Z" }),
    claimRefresh: async () => false, // someone just refreshed
    now: () => Date.parse("2026-09-25T00:10:00Z"),
  });
  const res = mockRes();
  await handler(req({ refresh: "1" }), res);
  assert.equal(live, 0, "a paced double-refresh must never reach Paraform twice");
  assert.equal(res.body.refreshSkipped, "too_soon");
  assert.deepEqual(res.body.sequences, [{ id: "s1", name: "Old" }]);
});

test("a failed live refresh falls back to the last good snapshot instead of blanking the page", async () => {
  const handler = createSequencesHandler({
    corsImpl: noCors, requireAuthImpl: allowAuth, hasCookieImpl: () => true,
    fetchSequences: async () => { const e = new Error("AUTH_EXPIRED"); e.code = "AUTH_EXPIRED"; throw e; },
    readSnapshot: async () => ({ sequences: [{ id: "s1", name: "Old" }], fetchedAt: "2026-09-25T00:00:00Z" }),
    claimRefresh: async () => true,
  });
  const res = mockRes();
  await handler(req({ refresh: "1" }), res);
  assert.equal(res.body.ok, true);
  assert.deepEqual(res.body.sequences, [{ id: "s1", name: "Old" }]);
  assert.match(res.body.refreshError, /AUTH_EXPIRED/);
});

test("no Paraform session configured is reported plainly on a cold start", async () => {
  const handler = createSequencesHandler({
    corsImpl: noCors, requireAuthImpl: allowAuth, hasCookieImpl: () => false,
    readSnapshot: async () => null,
  });
  const res = mockRes();
  await handler(req(), res);
  assert.equal(res.body.ok, false);
  assert.equal(res.body.error, "no_cookie");
});
