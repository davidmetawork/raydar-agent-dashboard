// Applicant Pipeline Core's funnel snapshot: an optional `pipeline` object
// on sync's POST body (Status v2 build plan step 3,
// docs/PRD-STATUS-V2-2026-09-03.md §5.2/§7 in the main repo). Stored
// verbatim under KV "apphub:pipeline" and read back by feed.mjs as
// `pipeline` (null when Core has never published one). Backward compatible
// by construction: Core does not send this field today.

import test from "node:test";
import assert from "node:assert/strict";

import { PIPELINE_COUNT_FIELDS, createSyncHandler, normalizePipeline } from "../api/applicants/sync.mjs";
import { createFeedHandler } from "../api/applicants/feed.mjs";
import { publishInto } from "./helpers/applicant-generation.mjs";

const SAVED_SYNC_KEY = process.env.APPHUB_SYNC_KEY;
const KEY = "apphub-sync-key-0000000000000000001";
const AT = "2026-09-03T12:00:00.000Z";

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
  const calls = { writeJson: [] };
  return {
    calls,
    deps: {
      kvReady: () => true,
      readHash: async () => ({}),
      writeHash: async (fields) => Object.keys(fields || {}).length,
      writeJson: async (key, value, ttlSeconds) => { calls.writeJson.push([key, value, ttlSeconds]); return "OK"; },
      readJson: async (key) => initial[key] ?? null,
      readHashKeys: async () => [],
      deleteHashFields: async () => 0,
      now: () => AT,
    },
  };
}

const validPipeline = () => ({
  generatedAt: AT,
  window: { days: 7, since: "2026-08-27T00:00:00.000Z" },
  captured: 120,
  identified: 90,
  readyToDecide: 40,
  holdsTotal: 30,
  holdsByReason: [
    { code: "missing_resume", label: "Missing resume", count: 12 },
    { code: "duplicate_review", label: "Duplicate review", count: 18 },
  ],
  passed: 20,
  invited: 0,
  postDecisionHolds: 10,
  unaccounted: 0,
  laneEnabled: false,
  stopReason: "invite lane disabled",
});

test("normalizePipeline accepts the shared-contract shape and passes through null counts", () => {
  const result = normalizePipeline(validPipeline());
  assert.equal(result.ok, true);
  assert.equal(result.pipeline.captured, 120);
  assert.deepEqual(result.pipeline.holdsByReason, [
    { code: "missing_resume", label: "Missing resume", count: 12 },
    { code: "duplicate_review", label: "Duplicate review", count: 18 },
  ]);
  assert.equal(result.pipeline.laneEnabled, false);
  assert.equal(result.pipeline.stopReason, "invite lane disabled");

  // "not computed" is null, never a fake 0 — every declared count field
  // accepts it.
  const sparse = { ...validPipeline() };
  for (const field of PIPELINE_COUNT_FIELDS) sparse[field] = null;
  const sparseResult = normalizePipeline(sparse);
  assert.equal(sparseResult.ok, true);
  for (const field of PIPELINE_COUNT_FIELDS) assert.equal(sparseResult.pipeline[field], null);
});

test("normalizePipeline rejects malformed shapes: bad generatedAt, non-integer counts, vague holds", () => {
  assert.equal(normalizePipeline(null).ok, false);
  assert.equal(normalizePipeline([]).ok, false);
  assert.equal(normalizePipeline({ ...validPipeline(), generatedAt: "not a date" }).ok, false);
  assert.equal(normalizePipeline({ ...validPipeline(), window: { days: "7" } }).ok, false);
  assert.equal(normalizePipeline({ ...validPipeline(), captured: 1.5 }).ok, false);
  assert.equal(normalizePipeline({ ...validPipeline(), captured: "120" }).ok, false);
  assert.equal(normalizePipeline({ ...validPipeline(), holdsByReason: "none" }).ok, false);
  assert.equal(normalizePipeline({ ...validPipeline(), holdsByReason: [{ code: "x" }] }).ok, false, "a hold row needs a label");
  assert.equal(normalizePipeline({ ...validPipeline(), laneEnabled: "false" }).ok, false, "laneEnabled must be a real boolean");
  assert.equal(normalizePipeline({ ...validPipeline(), stopReason: 42 }).ok, false);
});

test("sync stores a valid pipeline verbatim under apphub:pipeline", async () => {
  process.env.APPHUB_SYNC_KEY = KEY;
  const { calls, deps } = fakeStore();
  const handler = createSyncHandler(deps);
  const res = response();
  await handler(request({ body: { pipeline: validPipeline() } }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.stored.pipeline, true);
  const [key, stored] = calls.writeJson.find(([k]) => k === "apphub:pipeline");
  assert.equal(key, "apphub:pipeline");
  assert.equal(stored.captured, 120);
  assert.equal(stored.holdsByReason.length, 2);
});

test("sync rejects an invalid pipeline before writing anything, and stays silent when absent", async () => {
  process.env.APPHUB_SYNC_KEY = KEY;
  const { calls, deps } = fakeStore();
  const handler = createSyncHandler(deps);

  const bad = response();
  await handler(request({ body: { pipeline: { generatedAt: "nope" } } }), bad);
  assert.equal(bad.statusCode, 400);
  assert.equal(bad.body.error, "invalid_pipeline");
  assert.ok(!calls.writeJson.some(([k]) => k === "apphub:pipeline"));

  // Legacy publishers (no `pipeline` field at all) are untouched — fully
  // backward compatible.
  const legacy = response();
  await handler(request({ body: { snapshot: { generatedAt: AT, stream: [] } } }), legacy);
  assert.equal(legacy.statusCode, 200);
  assert.equal(legacy.body.stored.pipeline, undefined);
});

test("feed returns pipeline null when Core has never published, and the stored doc when it has", async () => {
  // The funnel doc is a free-standing key, not a generation artifact — but the
  // feed still refuses to answer at all without an active publication, so both
  // halves of this test run against one.
  const state = {};
  publishInto(state, { snapshot: { generatedAt: AT, stream: [] }, queue: [] });
  const emptyDeps = {
    corsHandler: () => false,
    authHandler: async () => true,
    kvReady: () => true,
    readJson: async (key) => state[key] ?? null,
    readHash: async () => ({}),
    now: () => Date.parse(AT),
  };
  const emptyRes = response();
  await createFeedHandler(emptyDeps)(request({ method: "GET" }), emptyRes);
  assert.equal(emptyRes.statusCode, 200);
  assert.equal(emptyRes.body.pipeline, null);

  const stored = normalizePipeline(validPipeline()).pipeline;
  const filledDeps = {
    ...emptyDeps,
    readJson: async (key) => (key === "apphub:pipeline" ? stored : state[key] ?? null),
  };
  const filledRes = response();
  await createFeedHandler(filledDeps)(request({ method: "GET" }), filledRes);
  assert.equal(filledRes.statusCode, 200);
  assert.deepEqual(filledRes.body.pipeline, stored);
});

test("feed refuses to answer when there is no active publication at all", () => {
  const res = response();
  return createFeedHandler({
    corsHandler: () => false,
    authHandler: async () => true,
    kvReady: () => true,
    readJson: async () => null,
    readHash: async () => ({}),
    now: () => Date.parse(AT),
  })(request({ method: "GET" }), res).then(() => {
    assert.equal(res.statusCode, 503);
    assert.equal(res.body.error, "generation_unavailable");
  });
});
