import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  listPendingPostCallInterestEvents,
  postCallInterestEventKey,
  recordPostCallInterestEvent,
  settlePostCallInterestEvent,
} from "../api/paraai/_lib/interest-store.mjs";
import {
  drainPostCallInterestOutbox,
  postCallInterestProducerEnabled,
  postCallInterestRequest,
} from "../api/paraai/_lib/post-call-interest-outbox.mjs";

function inMemoryKv() {
  const values = new Map();
  const sets = new Map();
  const kvImpl = async ([command, key, ...rest]) => {
    if (command === "GET") return values.get(key) ?? null;
    if (command === "SET") {
      if (rest.includes("NX") && values.has(key)) return null;
      if (rest.includes("XX") && !values.has(key)) return null;
      values.set(key, rest[0]);
      return "OK";
    }
    if (command === "SADD") {
      const set = sets.get(key) || new Set();
      const before = set.size;
      set.add(rest[0]);
      sets.set(key, set);
      return set.size === before ? 0 : 1;
    }
    if (command === "SREM") {
      return sets.get(key)?.delete(rest[0]) ? 1 : 0;
    }
    if (command === "SMEMBERS") return [...(sets.get(key) || [])];
    throw new Error(`unexpected command ${command}`);
  };
  return kvImpl;
}

const EVENT = Object.freeze({
  candidateUserId: "candidate_1",
  batchId: "batch-1",
  roleId: "role_1",
  occurredAt: "2026-08-28T17:00:00.000Z",
});

test("the post-call interest producer is hard-dark by default", async () => {
  assert.equal(postCallInterestProducerEnabled({}), false);
  let reads = 0;
  let sends = 0;
  const result = await drainPostCallInterestOutbox({
    env: {
      POST_CALL_BASE: "https://post-call.raydar.xyz",
      POST_CALL_ENGAGEMENT_API_KEY: "x".repeat(32),
    },
    listImpl: async () => { reads += 1; return []; },
    fetchImpl: async () => { sends += 1; throw new Error("must stay dark"); },
  });
  assert.deepEqual(result, {
    enabled: false,
    attempted: 0,
    delivered: 0,
    pending: 0,
  });
  assert.equal(reads, 0);
  assert.equal(sends, 0);
});

test("an interest transition is a durable idempotent outbox record", async () => {
  const kvImpl = inMemoryKv();
  const first = await recordPostCallInterestEvent(EVENT, { kvImpl });
  const replay = await recordPostCallInterestEvent({
    ...EVENT,
    occurredAt: "2026-08-28T17:01:00.000Z",
  }, { kvImpl });
  assert.equal(first.created, true);
  assert.equal(replay.created, false);
  assert.equal(replay.record.occurredAt, EVENT.occurredAt);
  assert.equal(
    first.record.eventKey,
    "curated-interest:candidate_1:batch-1:role_1",
  );
  assert.deepEqual(
    (await listPendingPostCallInterestEvents(10, { kvImpl }))
      .map((record) => record.eventKey),
    [first.record.eventKey],
  );

  const failed = await settlePostCallInterestEvent(first.record.eventKey, {
    delivered: false,
    statusCode: 503,
    errorCode: "POST_CALL_INTEREST_HTTP_503",
  }, { kvImpl });
  assert.equal(failed.state, "pending");
  assert.equal(failed.attempts, 1);
  assert.equal(failed.lastErrorCode, "POST_CALL_INTEREST_HTTP_503");

  const delivered = await settlePostCallInterestEvent(first.record.eventKey, {
    delivered: true,
    responseEventKey: first.record.eventKey,
    statusCode: 202,
  }, { kvImpl });
  assert.equal(delivered.state, "delivered");
  assert.equal(delivered.attempts, 2);
  assert.deepEqual(await listPendingPostCallInterestEvents(10, { kvImpl }), []);
});

test("the event key and wire body are deterministic and contain no contact PII", () => {
  assert.equal(
    postCallInterestEventKey(EVENT.candidateUserId, EVENT.batchId, EVENT.roleId),
    "curated-interest:candidate_1:batch-1:role_1",
  );
  const request = postCallInterestRequest({
    version: 1,
    state: "pending",
    eventKey: "curated-interest:candidate_1:batch-1:role_1",
    ...EVENT,
  });
  assert.deepEqual(request.body, {
    schemaVersion: 1,
    event: {
      kind: "curated_role_interest",
      candidateId: "candidate_1",
      roleId: "role_1",
      batchId: "batch-1",
      occurredAt: EVENT.occurredAt,
      evidence: {
        source: "paraai_curated_interest_v1",
        sourceEventId: request.eventKey,
      },
    },
  });
  assert.doesNotMatch(JSON.stringify(request.body), /email|linkedin|phone|resume|name/iu);
  assert.throws(
    () => postCallInterestEventKey("candidate:1", "batch-1", "role_1"),
    (error) => error.code === "POST_CALL_INTEREST_ID_INVALID",
  );
});

test("delivery uses only the fixed HTTPS path and bearer contract", async () => {
  const eventKey = "curated-interest:candidate_1:batch-1:role_1";
  const captured = [];
  const settled = [];
  const result = await drainPostCallInterestOutbox({
    enabled: true,
    env: {
      POST_CALL_BASE: "https://post-call.raydar.xyz",
      POST_CALL_ALLOWED_ORIGINS: "https://post-call.raydar.xyz",
      POST_CALL_ENGAGEMENT_API_KEY: "secret".repeat(6),
    },
    listImpl: async () => [{ eventKey, ...EVENT }],
    settleImpl: async (...args) => { settled.push(args); },
    signalFactory: () => undefined,
    fetchImpl: async (url, init) => {
      captured.push({ url, init, body: JSON.parse(init.body) });
      return new Response(JSON.stringify({
        ok: true,
        eventType: "curated_role_interest",
        eventKey,
        replayed: false,
      }), {
        status: 202,
        headers: { "content-type": "application/json" },
      });
    },
  });
  assert.equal(result.delivered, 1);
  assert.equal(result.pending, 0);
  assert.equal(captured[0].url, "https://post-call.raydar.xyz/api/v1/engagement-events");
  assert.equal(captured[0].init.redirect, "error");
  assert.equal(captured[0].init.headers.authorization, `Bearer ${"secret".repeat(6)}`);
  assert.equal(captured[0].body.event.candidateId, EVENT.candidateUserId);
  assert.deepEqual(settled[0], [eventKey, {
    delivered: true,
    responseEventKey: eventKey,
    statusCode: 202,
  }]);
});

test("a rejected delivery remains pending with a typed retry reason", async () => {
  const eventKey = "curated-interest:candidate_1:batch-1:role_1";
  const settled = [];
  const result = await drainPostCallInterestOutbox({
    enabled: true,
    env: {
      POST_CALL_BASE: "https://post-call.raydar.xyz",
      POST_CALL_ALLOWED_ORIGINS: "https://post-call.raydar.xyz",
      POST_CALL_ENGAGEMENT_API_KEY: "secret".repeat(6),
    },
    listImpl: async () => [{ eventKey, ...EVENT }],
    settleImpl: async (...args) => { settled.push(args); },
    signalFactory: () => undefined,
    fetchImpl: async () => new Response(JSON.stringify({ ok: false }), {
      status: 503,
      headers: { "content-type": "application/json" },
    }),
  });
  assert.equal(result.delivered, 0);
  assert.equal(result.pending, 1);
  assert.equal(result.results[0].errorCode, "POST_CALL_INTEREST_HTTP_503");
  assert.deepEqual(settled[0], [eventKey, {
    delivered: false,
    statusCode: 503,
    errorCode: "POST_CALL_INTEREST_HTTP_503",
  }]);
});

test("a core acceptance followed by a local settlement failure stays retryable", async () => {
  const eventKey = "curated-interest:candidate_1:batch-1:role_1";
  const settlements = [];
  const result = await drainPostCallInterestOutbox({
    enabled: true,
    env: {
      POST_CALL_BASE: "https://post-call.raydar.xyz",
      POST_CALL_ALLOWED_ORIGINS: "https://post-call.raydar.xyz",
      POST_CALL_ENGAGEMENT_API_KEY: "secret".repeat(6),
    },
    listImpl: async () => [{ eventKey, ...EVENT }],
    settleImpl: async (_key, outcome) => {
      settlements.push(outcome);
      if (outcome.delivered) {
        const error = new Error("store unavailable");
        error.code = "POST_CALL_INTEREST_OUTBOX_SETTLEMENT_FAILED";
        throw error;
      }
    },
    signalFactory: () => undefined,
    fetchImpl: async () => new Response(JSON.stringify({
      ok: true,
      eventType: "curated_role_interest",
      eventKey,
      replayed: false,
    }), {
      status: 202,
      headers: { "content-type": "application/json" },
    }),
  });
  assert.equal(result.delivered, 0);
  assert.equal(result.pending, 1);
  assert.equal(
    result.results[0].errorCode,
    "POST_CALL_INTEREST_OUTBOX_SETTLEMENT_FAILED",
  );
  assert.deepEqual(
    settlements.map((outcome) => outcome.delivered),
    [true, false],
  );
});

test("enabled delivery fails closed before reads when its destination is unsafe", async () => {
  let reads = 0;
  await assert.rejects(
    drainPostCallInterestOutbox({
      enabled: true,
      env: {
        POST_CALL_BASE: "http://127.0.0.1:3000",
        POST_CALL_ENGAGEMENT_API_KEY: "secret".repeat(6),
      },
      listImpl: async () => { reads += 1; return []; },
    }),
    /post_call_interest_base_unsafe/u,
  );
  assert.equal(reads, 0);
});

test("the source snapshot advances only after the outbox persistence block", async () => {
  const source = await readFile(
    new URL("../api/paraai/_lib/interest.mjs", import.meta.url),
    "utf8",
  );
  const persistence = source.indexOf("await recordPostCallInterestEvent({");
  const advancement = source.indexOf(
    "await putSnapshot(candidate.candidateUserId, statuses);",
    persistence,
  );
  assert.ok(persistence > 0);
  assert.ok(advancement > persistence);
  assert.match(source.slice(persistence, advancement), /snapshotDeferred = true/u);
});
