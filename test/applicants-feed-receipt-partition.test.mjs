// One stale source-profile receipt must not blank the Applicants tab.
//
// 2026-09-04: feed answered 503 generation_unavailable when ANY active row's
// durable Hub receipt no longer matched the observation the row names. The tab
// treats a failed feed as "discard everything" (markFeedUnavailable in
// applicants.html), so a single row whose observation id had moved wiped a
// 4,345-row queue, the decision overlay, the cards, and the reviewer's local
// checkbox state. The publish-time fence is the one that must fail closed; a
// read has a published, already-proved generation in hand.

import test from "node:test";
import assert from "node:assert/strict";

import { createFeedHandler } from "../api/applicants/feed.mjs";
import { createSyncHandler } from "../api/applicants/sync.mjs";
import * as profileReadiness from "../api/applicants/_lib/profile-readiness.mjs";
import {
  publicationBody,
  publishInto,
  sourceReceiptsFor,
  sourceRow,
} from "./helpers/applicant-generation.mjs";

const AT = "2026-09-04T12:00:00.000Z";
const KEY = "apphub-sync-key-0000000000000000001";

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

const feedRequest = () => ({ method: "GET", headers: {}, query: {} });

function feed(state, receipts) {
  return createFeedHandler({
    corsHandler: () => false,
    authHandler: async () => true,
    kvReady: () => true,
    readJson: async (key) => state[key] ?? null,
    readHash: async (key) => (key === "apphub:source-profile-ready" ? receipts : {}),
    now: () => Date.parse(AT),
  });
}

test("a row whose receipt went stale moves to preparing, it does not blank the feed", async () => {
  const queue = [sourceRow("cu1"), sourceRow("cu2"), sourceRow("cu3")];
  const stream = [sourceRow("cs1")];
  const state = {};
  publishInto(state, { snapshot: { generatedAt: AT, stream }, queue });
  // cu2's Hub observation moved after the generation was published — exactly
  // the shape that used to 503.
  const receipts = sourceReceiptsFor([...queue, ...stream]);
  receipts.cu2 = { ...receipts.cu2, sourceObservationId: "obs-moved-on" };

  const res = response();
  await feed(state, receipts)(feedRequest(), res);

  assert.equal(res.statusCode, 200, "the other rows still render");
  assert.deepEqual(res.body.snapshot.queue.map((row) => row.cuId), ["cu1", "cu3"]);
  assert.deepEqual(res.body.snapshot.stream.map((row) => row.cuId), ["cs1"]);
  assert.equal(res.body.profileReceiptWithheld, 1);
  assert.equal(res.body.profilePreparing, 1);
  assert.equal(res.body.profileCache.withheldCandidates, 1);
  // The withheld row is not renderable anywhere, so it cannot be actioned.
  const rendered = JSON.stringify([res.body.snapshot.queue, res.body.snapshot.stream]);
  assert.doesNotMatch(rendered, /cu2/);
});

test("the withheld count is added to Core's own preparing partition, not substituted for it", async () => {
  const queue = [sourceRow("cu1"), sourceRow("cu2")];
  const state = {};
  publishInto(state, {
    snapshot: { generatedAt: AT, stream: [], profilePreparing: 7 },
    queue,
  });
  const receipts = sourceReceiptsFor(queue);
  delete receipts.cu2;

  const res = response();
  await feed(state, receipts)(feedRequest(), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.profileReceiptWithheld, 1);
  assert.equal(res.body.profilePreparing, 8);
});

test("a fully backed generation is untouched and withholds nothing", async () => {
  const queue = [sourceRow("cu1"), sourceRow("cu2")];
  const state = {};
  publishInto(state, { snapshot: { generatedAt: AT, stream: [] }, queue });

  const res = response();
  await feed(state, sourceReceiptsFor(queue))(feedRequest(), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.profileReceiptWithheld, 0);
  assert.equal(res.body.snapshot.queue.length, 2);
});

test("feed still fails closed when there is no verified generation at all", async () => {
  const res = response();
  await feed({}, {})(feedRequest(), res);
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.error, "generation_unavailable");
});

test("the PUBLISH-time fence still refuses an unbacked generation", async () => {
  // Read-time leniency is only safe because the write side is strict: an
  // unbacked generation must never become the active one.
  const saved = process.env.APPHUB_SYNC_KEY;
  process.env.APPHUB_SYNC_KEY = KEY;
  try {
    const queue = [sourceRow("cu1"), sourceRow("cu2")];
    const receipts = sourceReceiptsFor([queue[0]]);
    const res = response();
    await createSyncHandler({
      kvReady: () => true,
      readHash: async (key) => (key === "apphub:source-profile-ready" ? receipts : {}),
      writeHash: async () => 1,
      writeJson: async () => "OK",
      readJson: async () => null,
      readHashKeys: async () => [],
      deleteHashFields: async () => 0,
      now: () => AT,
    })({
      method: "POST",
      headers: { authorization: `Bearer ${KEY}` },
      body: publicationBody({ snapshot: { generatedAt: AT, stream: [] }, queue }),
    }, res);
    assert.equal(res.statusCode, 409);
    assert.equal(res.body.error, "source_profile_prepublication_incomplete");
    assert.equal(res.body.missing, 1);
  } finally {
    if (saved === undefined) delete process.env.APPHUB_SYNC_KEY;
    else process.env.APPHUB_SYNC_KEY = saved;
  }
});

test("the dead profileCacheGate is gone", () => {
  // It had no caller anywhere in the repo and described a row-filtering policy
  // that the receipt fence replaced; leaving it invited a future reader to
  // wire the old behaviour back in.
  assert.equal(profileReadiness.profileCacheGate, undefined);
  assert.equal(typeof profileReadiness.partitionByProfileReceipt, "function");
});
