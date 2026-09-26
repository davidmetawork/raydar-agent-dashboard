// api/roster/paraai-status.mjs (2026-09-26 Paraform read-cut pass): the
// Candidates tab's Para AI status read used to be guarded only by an
// in-memory, per-process 5-minute TTL — no defense against a serverless
// cold start or a front-end poll every 60 seconds. It now serves a durable
// KV snapshot on an ordinary request and only ever runs the expensive CRM
// walk / sequence reads on a lock-guarded bootstrap or an explicit
// `?refresh=1`. test/candidate-match-queue.test.mjs pins the *shape* of a
// live compute; this file pins the caching/pacing wrapper around it.

import assert from "node:assert/strict";
import test from "node:test";

import { createParaAIStatusHandler } from "../api/roster/paraai-status.mjs";

function mockRes() {
  return {
    statusCode: null, headers: {}, body: null,
    setHeader(key, value) { this.headers[key.toLowerCase()] = value; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}
const req = (query = {}) => ({ method: "GET", query, headers: {} });
const noCors = () => false;
const allowAuth = async () => true;

const FULL_SNAPSHOT = { ok: true, statuses: [{ candidateUserId: "c1", status: "added" }], fetchedAt: "2026-09-26T00:00:00Z" };
const OUTCOMES_SNAPSHOT = { ok: true, outcomes: [{ candidateUserId: "c1" }], fetchedAt: "2026-09-26T00:00:00Z" };

test("an ordinary full-status request serves the KV snapshot and never scans the CRM", async () => {
  let scans = 0;
  const handler = createParaAIStatusHandler({
    corsImpl: noCors, requireAuthImpl: allowAuth,
    loadSnapshot: async () => { scans++; return { rows: [], complete: true }; },
    readCache: async (mode) => (mode === "full" ? FULL_SNAPSHOT : null),
    writeCache: async () => { throw new Error("must not write on a plain read"); },
    claimWindow: async () => { throw new Error("must not touch the pacing lock on a plain read"); },
    now: () => Date.parse("2026-09-26T00:10:00Z"),
  });
  const res = mockRes();
  await handler(req(), res);
  assert.equal(scans, 0);
  assert.equal(res.body.source, "snapshot");
  assert.deepEqual(res.body.statuses, FULL_SNAPSHOT.statuses);
  assert.equal(res.body.snapshotAgeMs, 10 * 60 * 1000);
});

test("an ordinary outcomes-only request also serves its own KV snapshot", async () => {
  let scans = 0;
  const handler = createParaAIStatusHandler({
    corsImpl: noCors, requireAuthImpl: allowAuth,
    loadOutcomeSnapshot: async () => { scans++; return { complete: true, entries: [] }; },
    readCache: async (mode) => (mode === "outcomes" ? OUTCOMES_SNAPSHOT : null),
    claimWindow: async () => { throw new Error("must not touch the pacing lock on a plain read"); },
  });
  const res = mockRes();
  await handler(req({ outcomes: "1" }), res);
  assert.equal(scans, 0);
  assert.deepEqual(res.body.outcomes, OUTCOMES_SNAPSHOT.outcomes);
});

test("a cold start with no snapshot bootstraps exactly once and persists the scan", async () => {
  let scans = 0;
  let written = null;
  const handler = createParaAIStatusHandler({
    corsImpl: noCors, requireAuthImpl: allowAuth,
    loadSnapshot: async () => { scans++; return { rows: [{ id: "c1", name: "Cand", talent_network_submitted_at: "2026-07-01" }], complete: true, generatedAt: "x" }; },
    loadJobs: async () => [],
    loadOutcomeSnapshot: async () => ({ complete: true, entries: [] }),
    readCache: async () => null,
    writeCache: async (mode, payload) => { written = { mode, payload }; return { ...payload, fetchedAt: "2026-09-26T01:00:00Z" }; },
    claimWindow: async () => true,
  });
  const res = mockRes();
  await handler(req(), res);
  assert.equal(scans, 1);
  assert.equal(written.mode, "full");
  assert.equal(res.body.source, "live");
  assert.equal(res.body.statuses[0].candidateUserId, "c1");
});

test("a cold start where another instance already won the bootstrap lock answers warming, not with a second scan", async () => {
  let scans = 0;
  const handler = createParaAIStatusHandler({
    corsImpl: noCors, requireAuthImpl: allowAuth,
    loadSnapshot: async () => { scans++; return { rows: [], complete: true }; },
    readCache: async () => null,
    claimWindow: async () => false,
  });
  const res = mockRes();
  await handler(req(), res);
  assert.equal(scans, 0);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.warming, true);
  assert.deepEqual(res.body.statuses, []);
  // A warming placeholder must still be shaped like a real answer so the
  // Candidates tab's outcome-verification check does not treat it as a
  // Paraform failure and spin its retry ladder.
  assert.equal(res.body.outcomeVerification.complete, false);
});

test("?refresh=1 is the only path that can re-scan a warm snapshot, and it is paced", async () => {
  let scans = 0;
  let written = null;
  const handler = createParaAIStatusHandler({
    corsImpl: noCors, requireAuthImpl: allowAuth,
    loadSnapshot: async () => { scans++; return { rows: [{ id: "c2", name: "New", talent_network_submitted_at: "2026-09-01" }], complete: true, generatedAt: "x" }; },
    loadJobs: async () => [],
    loadOutcomeSnapshot: async () => ({ complete: true, entries: [] }),
    readCache: async () => FULL_SNAPSHOT,
    writeCache: async (mode, payload) => { written = payload; return { ...payload, fetchedAt: "2026-09-26T02:00:00Z" }; },
    claimWindow: async () => true,
  });
  const res = mockRes();
  await handler(req({ refresh: "1" }), res);
  assert.equal(scans, 1);
  assert.equal(res.body.refreshed, true);
  assert.equal(res.body.statuses[0].candidateUserId, "c2");
  assert.ok(written);
});

test("a double-click refresh within the pacing window is skipped and serves the last snapshot", async () => {
  let scans = 0;
  const handler = createParaAIStatusHandler({
    corsImpl: noCors, requireAuthImpl: allowAuth,
    loadSnapshot: async () => { scans++; return { rows: [], complete: true }; },
    readCache: async () => FULL_SNAPSHOT,
    claimWindow: async () => false,
    now: () => Date.parse("2026-09-26T00:00:30Z"),
  });
  const res = mockRes();
  await handler(req({ refresh: "1" }), res);
  assert.equal(scans, 0, "a paced double-refresh must never reach Paraform twice");
  assert.equal(res.body.refreshSkipped, "too_soon");
  assert.deepEqual(res.body.statuses, FULL_SNAPSHOT.statuses);
});

test("a failed refresh falls back to the last good snapshot instead of erroring out a working tab", async () => {
  const handler = createParaAIStatusHandler({
    corsImpl: noCors, requireAuthImpl: allowAuth,
    loadSnapshot: async () => { const e = new Error("AUTH_EXPIRED"); e.code = "AUTH_EXPIRED"; throw e; },
    loadJobs: async () => [],
    loadOutcomeSnapshot: async () => ({ complete: true, entries: [] }),
    readCache: async () => FULL_SNAPSHOT,
    claimWindow: async () => true,
  });
  const res = mockRes();
  await handler(req({ refresh: "1" }), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.statuses, FULL_SNAPSHOT.statuses);
  assert.match(res.body.refreshError, /AUTH_EXPIRED/);
});

test("a genuine failure with nothing ever cached still reports the real error", async () => {
  const handler = createParaAIStatusHandler({
    corsImpl: noCors, requireAuthImpl: allowAuth,
    loadSnapshot: async () => { const e = new Error("AUTH_EXPIRED"); e.code = "AUTH_EXPIRED"; throw e; },
    loadJobs: async () => [],
    loadOutcomeSnapshot: async () => ({ complete: true, entries: [] }),
    readCache: async () => null,
    claimWindow: async () => true,
  });
  const res = mockRes();
  await handler(req({ refresh: "1" }), res);
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.error, "AUTH_EXPIRED");
});
