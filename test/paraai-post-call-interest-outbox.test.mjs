import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  claimPendingPostCallInterestEvents,
  diffInterest,
  getPostCallInterestSnapshot,
  getPostCallInterestSweepState,
  listPendingPostCallInterestEvents,
  postCallInterestEventKey,
  postCallProjectionBatchId,
  putPostCallInterestSnapshot,
  recordPostCallInterestEvent,
  recordPostCallInterestSweep,
  settlePostCallInterestEvent,
} from "../api/paraai/_lib/interest-store.mjs";
import {
  drainPostCallInterestOutbox,
  postCallInterestProducerEnabled,
  postCallInterestRequest,
} from "../api/paraai/_lib/post-call-interest-outbox.mjs";
import {
  runPostCallInterestProjectionTick,
  runScheduledInterestSweep,
  sweepPostCallInterestProjection,
} from "../api/paraai/_lib/interest.mjs";
import {
  postCallInterestWorkerAuthorized,
} from "../api/paraai/post-call-interest.mjs";

const CONTRACT_FIXTURE = JSON.parse(await readFile(
  new URL("./fixtures/post-call-interest-contract-v1.json", import.meta.url),
  "utf8",
));

function inMemoryKv() {
  const values = new Map();
  const expiries = new Map();
  const sortedSets = new Map();
  let nowMs = Date.parse("2026-08-28T17:00:00.000Z");
  const read = (key) => {
    if (Number(expiries.get(key)) <= nowMs) {
      values.delete(key);
      expiries.delete(key);
    }
    return values.get(key) ?? null;
  };
  const zset = (key) => {
    const selected = sortedSets.get(key) || new Map();
    sortedSets.set(key, selected);
    return selected;
  };
  const kvImpl = async ([command, key, ...rest]) => {
    if (command === "GET") return read(key);
    if (command === "SET") {
      if (rest.includes("NX") && read(key) != null) return null;
      if (rest.includes("XX") && read(key) == null) return null;
      values.set(key, rest[0]);
      const px = rest.indexOf("PX");
      if (px >= 0) expiries.set(key, nowMs + Number(rest[px + 1]));
      return "OK";
    }
    if (command === "ZADD") {
      zset(key).set(String(rest[1]), Number(rest[0]));
      return 1;
    }
    if (command === "ZREM") return zset(key).delete(String(rest[0])) ? 1 : 0;
    if (command === "ZRANGE") {
      const start = Number(rest[0]);
      const end = Number(rest[1]);
      const rows = [...zset(key)].sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]));
      return rows.slice(start, end < 0 ? undefined : end + 1).map(([member]) => member);
    }
    if (command === "EVAL") {
      const script = key;
      const keyCount = Number(rest[0]);
      const keys = rest.slice(1, 1 + keyCount);
      const args = rest.slice(1 + keyCount);
      if (script.includes("post-call-outbox-record-v2")) {
        const [recordKey, indexKey] = keys;
        const [payload, , hash] = args;
        const prior = read(recordKey);
        if (prior == null) {
          values.set(recordKey, payload);
          zset(indexKey).set(hash, nowMs);
          return [1, payload];
        }
        if (JSON.parse(prior).state === "pending" && !zset(indexKey).has(hash)) {
          zset(indexKey).set(hash, nowMs);
        }
        return [0, prior];
      }
      if (script.includes("post-call-outbox-claim-v2")) {
        const [indexKey] = keys;
        const [limitRaw, leaseMsRaw, token, recordPrefix, leasePrefix] = args;
        const limit = Number(limitRaw);
        const leaseMs = Number(leaseMsRaw);
        const due = [...zset(indexKey)]
          .filter(([, score]) => score <= nowMs)
          .sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))
          .slice(0, Math.max(limit * 4, 20));
        const out = [];
        for (const [hash] of due) {
          const raw = read(`${recordPrefix}${hash}`);
          if (!raw || JSON.parse(raw).state !== "pending") {
            zset(indexKey).delete(hash);
            continue;
          }
          const leaseKey = `${leasePrefix}${hash}`;
          if (read(leaseKey) != null) continue;
          const leaseToken = `${token}.${hash}`;
          values.set(leaseKey, leaseToken);
          expiries.set(leaseKey, nowMs + leaseMs);
          zset(indexKey).set(hash, nowMs + leaseMs);
          out.push(hash, raw, leaseToken, String(nowMs), String(nowMs + leaseMs));
          if (out.length / 5 >= limit) break;
        }
        return out;
      }
      if (script.includes("post-call-outbox-discard-invalid-v2")) {
        const [indexKey, leaseKey] = keys;
        const [token, hash] = args;
        if (read(leaseKey) !== token) return 0;
        values.delete(leaseKey);
        expiries.delete(leaseKey);
        zset(indexKey).delete(hash);
        return 1;
      }
      if (script.includes("post-call-outbox-settle-v2")) {
        const [recordKey, indexKey, leaseKey] = keys;
        const [eventKey, token, hash, delivered, nowIso, status, errorCode] = args;
        const raw = read(recordKey);
        if (!raw) return [0, "missing"];
        const current = JSON.parse(raw);
        if (current.eventKey !== eventKey) return [0, "conflict"];
        if (current.state === "delivered") {
          zset(indexKey).delete(hash);
          if (read(leaseKey) === token) values.delete(leaseKey);
          return [2, raw];
        }
        if (current.state !== "pending" || read(leaseKey) !== token) return [0, "claim_lost"];
        current.attempts = Math.max(0, Number(current.attempts) || 0) + 1;
        current.lastAttemptAt = nowIso;
        current.updatedAt = nowIso;
        current.statusCode = status === "" ? null : Number(status);
        if (delivered === "1") {
          current.state = "delivered";
          current.lastErrorCode = null;
          current.deliveredAt = nowIso;
          current.nextAttemptAtMs = null;
          zset(indexKey).delete(hash);
        } else {
          current.state = "pending";
          current.lastErrorCode = errorCode;
          current.deliveredAt = null;
          const delay = Math.min(300_000, 5_000 * (2 ** Math.min(6, current.attempts - 1)));
          current.nextAttemptAtMs = nowMs + delay;
          zset(indexKey).set(hash, current.nextAttemptAtMs);
        }
        const encoded = JSON.stringify(current);
        values.set(recordKey, encoded);
        values.delete(leaseKey);
        expiries.delete(leaseKey);
        return [1, encoded];
      }
    }
    throw new Error(`unexpected command ${command}`);
  };
  return {
    kvImpl,
    advance(milliseconds) { nowMs += Number(milliseconds); },
    keys() { return [...values.keys()]; },
    now() { return nowMs; },
  };
}

const EVENT = Object.freeze({
  ...CONTRACT_FIXTURE.tuple,
  occurredAt: CONTRACT_FIXTURE.occurredAt,
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
    claimImpl: async () => { reads += 1; return []; },
    fetchImpl: async () => { sends += 1; throw new Error("must stay dark"); },
  });
  assert.deepEqual(result, {
    enabled: false,
    attempted: 0,
    delivered: 0,
    pending: 0,
    leased: 0,
    deferred: 0,
  });
  assert.equal(reads, 0);
  assert.equal(sends, 0);
});

test("an interest transition is a durable idempotent outbox record", async () => {
  const memory = inMemoryKv();
  const { kvImpl } = memory;
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
    CONTRACT_FIXTURE.eventKey,
  );
  assert.deepEqual(
    (await listPendingPostCallInterestEvents(10, { kvImpl }))
      .map((record) => record.eventKey),
    [first.record.eventKey],
  );

  const [firstClaim] = await claimPendingPostCallInterestEvents(1, {
    kvImpl, token: "lease-token-first", leaseMs: 1_000,
  });
  const failed = await settlePostCallInterestEvent(first.record.eventKey, {
    delivered: false,
    leaseToken: firstClaim.leaseToken,
    statusCode: 503,
    errorCode: "POST_CALL_INTEREST_HTTP_503",
  }, { kvImpl });
  assert.equal(failed.state, "pending");
  assert.equal(failed.attempts, 1);
  assert.equal(failed.lastErrorCode, "POST_CALL_INTEREST_HTTP_503");

  memory.advance(5_001);
  const [secondClaim] = await claimPendingPostCallInterestEvents(1, {
    kvImpl, token: "lease-token-second", leaseMs: 1_000,
  });
  const delivered = await settlePostCallInterestEvent(first.record.eventKey, {
    delivered: true,
    leaseToken: secondClaim.leaseToken,
    responseEventKey: first.record.eventKey,
    statusCode: 202,
  }, { kvImpl });
  assert.equal(delivered.state, "delivered");
  assert.equal(delivered.attempts, 2);
  assert.deepEqual(await listPendingPostCallInterestEvents(10, { kvImpl }), []);
});

test("a role clicked before its first PENDING observation becomes durable", async () => {
  const memory = inMemoryKv();
  const diff = diffInterest(
    { statuses: { existing_role: "PENDING" } },
    { existing_role: "PENDING", role_1: "APPLIED_TO_ROLE" },
  );
  assert.deepEqual(diff.newlyInterested, ["role_1"]);
  for (const roleId of diff.newlyInterested) {
    await recordPostCallInterestEvent({ ...EVENT, roleId }, { kvImpl: memory.kvImpl });
  }
  assert.deepEqual(
    (await listPendingPostCallInterestEvents(10, { kvImpl: memory.kvImpl }))
      .map((record) => record.eventKey),
    [CONTRACT_FIXTURE.eventKey],
  );
});

test("the independent projection records a first-observed click without consuming legacy jobs", async () => {
  const memory = inMemoryKv();
  let statuses = { existing_role: "PENDING" };
  const dependencies = {
    config: {
      postCallInterestEnabled: true,
      sweepBatchSize: 10,
      sweepConcurrency: 1,
    },
    listCandidatesImpl: async () => [{
      candidateUserId: EVENT.candidateUserId,
      candidateId: "candidate-domain-1",
    }],
    readStatusesImpl: async () => statuses,
    getSnapshotImpl: (candidateUserId) => getPostCallInterestSnapshot(
      candidateUserId,
      { kvImpl: memory.kvImpl },
    ),
    putSnapshotImpl: (candidateUserId, nextStatuses, options) =>
      putPostCallInterestSnapshot(candidateUserId, nextStatuses, {
        ...options,
        kvImpl: memory.kvImpl,
      }),
    getSweepStateImpl: () => getPostCallInterestSweepState({ kvImpl: memory.kvImpl }),
    recordSweepImpl: (result) => recordPostCallInterestSweep(
      result,
      { kvImpl: memory.kvImpl },
    ),
    acquireLockImpl: async () => "projection-candidate-lease",
    releaseLockImpl: async () => true,
    recordEventImpl: (event) => recordPostCallInterestEvent(
      event,
      { kvImpl: memory.kvImpl },
    ),
  };
  const seeded = await sweepPostCallInterestProjection({
    ...dependencies,
    now: Date.parse("2026-08-28T17:00:00.000Z"),
  });
  assert.equal(seeded.seeded, 1);
  assert.equal(seeded.postCallOutboxQueued, 0);
  const prior = await getPostCallInterestSnapshot(
    EVENT.candidateUserId,
    { kvImpl: memory.kvImpl },
  );

  statuses = { existing_role: "PENDING", role_1: "APPLIED_TO_ROLE" };
  const clicked = await sweepPostCallInterestProjection({
    ...dependencies,
    now: Date.parse("2026-08-28T17:01:00.000Z"),
  });
  assert.equal(clicked.detected.length, 1);
  assert.equal(clicked.postCallOutboxQueued, 1);
  const [record] = await listPendingPostCallInterestEvents(10, {
    kvImpl: memory.kvImpl,
  });
  assert.equal(record.batchId, postCallProjectionBatchId(
    EVENT.candidateUserId,
    prior.generationId,
    prior.revision,
    ["role_1"],
  ));
  assert.equal(record.roleId, "role_1");
  assert.equal(
    memory.keys().some((key) => key.startsWith("paraai:interest:job:")),
    false,
  );
});

test("the event key and wire body are deterministic and contain no contact PII", () => {
  assert.equal(JSON.stringify({
    batchId: EVENT.batchId,
    candidateUserId: EVENT.candidateUserId,
    roleId: EVENT.roleId,
  }), CONTRACT_FIXTURE.canonicalJson);
  assert.equal(
    postCallInterestEventKey(EVENT.candidateUserId, EVENT.batchId, EVENT.roleId),
    CONTRACT_FIXTURE.eventKey,
  );
  const request = postCallInterestRequest({
    version: 1,
    state: "pending",
    eventKey: CONTRACT_FIXTURE.eventKey,
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
  assert.doesNotMatch(request.eventKey, /candidate_1|batch-1|role_1/u);
  assert.throws(
    () => postCallInterestEventKey("candidate:1", "batch-1", "role_1"),
    (error) => error.code === "POST_CALL_INTEREST_ID_INVALID",
  );
});

test("delivery uses only the fixed HTTPS path and bearer contract", async () => {
  const eventKey = CONTRACT_FIXTURE.eventKey;
  const captured = [];
  const settled = [];
  const result = await drainPostCallInterestOutbox({
    enabled: true,
    env: {
      POST_CALL_BASE: "https://post-call.raydar.xyz",
      POST_CALL_ALLOWED_ORIGINS: "https://post-call.raydar.xyz",
      POST_CALL_ENGAGEMENT_API_KEY: "secret".repeat(6),
    },
    claimImpl: async () => [{ eventKey, ...EVENT, leaseToken: "lease-token-delivery" }],
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
    leaseToken: "lease-token-delivery",
    responseEventKey: eventKey,
    statusCode: 202,
  }]);
});

test("a rejected delivery remains pending with a typed retry reason", async () => {
  const eventKey = CONTRACT_FIXTURE.eventKey;
  const settled = [];
  const result = await drainPostCallInterestOutbox({
    enabled: true,
    env: {
      POST_CALL_BASE: "https://post-call.raydar.xyz",
      POST_CALL_ALLOWED_ORIGINS: "https://post-call.raydar.xyz",
      POST_CALL_ENGAGEMENT_API_KEY: "secret".repeat(6),
    },
    claimImpl: async () => [{ eventKey, ...EVENT, leaseToken: "lease-token-rejection" }],
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
    leaseToken: "lease-token-rejection",
    statusCode: 503,
    errorCode: "POST_CALL_INTEREST_HTTP_503",
  }]);
});

test("a core acceptance followed by a local settlement failure stays retryable", async () => {
  const eventKey = CONTRACT_FIXTURE.eventKey;
  const settlements = [];
  const result = await drainPostCallInterestOutbox({
    enabled: true,
    env: {
      POST_CALL_BASE: "https://post-call.raydar.xyz",
      POST_CALL_ALLOWED_ORIGINS: "https://post-call.raydar.xyz",
      POST_CALL_ENGAGEMENT_API_KEY: "secret".repeat(6),
    },
    claimImpl: async () => [{ eventKey, ...EVENT, leaseToken: "lease-token-settlement" }],
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

test("an event lease excludes overlap, expires, and rejects the stale claimant", async () => {
  const memory = inMemoryKv();
  const { kvImpl } = memory;
  const recorded = await recordPostCallInterestEvent(EVENT, { kvImpl });
  const [first] = await claimPendingPostCallInterestEvents(1, {
    kvImpl, token: "lease-owner-first", leaseMs: 1_000,
  });
  assert.equal(first.eventKey, recorded.record.eventKey);
  assert.deepEqual(await claimPendingPostCallInterestEvents(1, {
    kvImpl, token: "lease-owner-overlap", leaseMs: 1_000,
  }), []);

  memory.advance(1_001);
  const [recovered] = await claimPendingPostCallInterestEvents(1, {
    kvImpl, token: "lease-owner-recovery", leaseMs: 1_000,
  });
  assert.equal(recovered.eventKey, first.eventKey);
  assert.notEqual(recovered.leaseToken, first.leaseToken);
  await assert.rejects(
    settlePostCallInterestEvent(first.eventKey, {
      delivered: true,
      leaseToken: first.leaseToken,
      responseEventKey: first.eventKey,
      statusCode: 202,
    }, { kvImpl }),
    (error) => error.code === "POST_CALL_INTEREST_CLAIM_LOST",
  );
  const delivered = await settlePostCallInterestEvent(recovered.eventKey, {
    delivered: true,
    leaseToken: recovered.leaseToken,
    responseEventKey: recovered.eventKey,
    statusCode: 202,
  }, { kvImpl });
  assert.equal(delivered.state, "delivered");
});

test("failed records move behind untouched due work instead of starving it", async () => {
  const memory = inMemoryKv();
  const { kvImpl } = memory;
  for (let index = 0; index < 6; index += 1) {
    await recordPostCallInterestEvent({
      candidateUserId: `candidate_${index}`,
      batchId: "batch-fairness",
      roleId: `role_${index}`,
      occurredAt: EVENT.occurredAt,
    }, { kvImpl });
  }
  const first = await claimPendingPostCallInterestEvents(2, {
    kvImpl, token: "lease-fairness-first", leaseMs: 1_000,
  });
  assert.equal(first.length, 2);
  for (const record of first) {
    await settlePostCallInterestEvent(record.eventKey, {
      delivered: false,
      leaseToken: record.leaseToken,
      statusCode: 503,
      errorCode: "POST_CALL_INTEREST_HTTP_503",
    }, { kvImpl });
  }
  const second = await claimPendingPostCallInterestEvents(2, {
    kvImpl, token: "lease-fairness-second", leaseMs: 1_000,
  });
  assert.equal(second.length, 2);
  assert.deepEqual(
    second.map((record) => record.eventKey).filter(
      (eventKey) => first.some((record) => record.eventKey === eventKey),
    ),
    [],
  );
});

test("the drain caps its batch and yields leased work before its host budget", async () => {
  let nowMs = 0;
  let selectedLimit = null;
  const records = Array.from({ length: 5 }, (_, index) => {
    const tuple = {
      candidateUserId: `candidate_budget_${index}`,
      batchId: "batch-budget",
      roleId: `role_budget_${index}`,
    };
    return {
      ...tuple,
      occurredAt: EVENT.occurredAt,
      eventKey: postCallInterestEventKey(tuple.candidateUserId, tuple.batchId, tuple.roleId),
      leaseToken: `lease-budget-${index}`,
    };
  });
  const result = await drainPostCallInterestOutbox({
    enabled: true,
    env: {
      POST_CALL_BASE: "https://post-call.raydar.xyz",
      POST_CALL_ALLOWED_ORIGINS: "https://post-call.raydar.xyz",
      POST_CALL_ENGAGEMENT_API_KEY: "secret".repeat(6),
    },
    limit: 50,
    runBudgetMs: 16_100,
    nowImpl: () => nowMs,
    signalFactory: () => undefined,
    claimImpl: async (limit) => { selectedLimit = limit; return records; },
    settleImpl: async () => {},
    fetchImpl: async () => {
      nowMs += 8_000;
      return new Response(JSON.stringify({ ok: false }), {
        status: 503,
        headers: { "content-type": "application/json" },
      });
    },
  });
  assert.equal(selectedLimit, 5);
  assert.equal(result.leased, 5);
  assert.equal(result.attempted, 2);
  assert.equal(result.deferred, 3);
});

test("the independent drain owner requires an exact automation bearer", () => {
  const env = { CRON_SECRET: "cron-secret", PARAAI_AUTOMATION_RUNNER_KEY: "runner-secret" };
  assert.equal(postCallInterestWorkerAuthorized({
    headers: { authorization: "Bearer cron-secret" },
  }, env), true);
  assert.equal(postCallInterestWorkerAuthorized({
    headers: { authorization: "Bearer wrong" },
  }, env), false);
  assert.equal(postCallInterestWorkerAuthorized({ headers: {} }, env), false);
});

test("the dedicated projection is hard-dark unless its own gate is explicit", async () => {
  let storeChecks = 0;
  let sweeps = 0;
  let drains = 0;
  const result = await runPostCallInterestProjectionTick({
    config: {
      enabled: true,
      notBeforeConfigured: true,
      postCallInterestEnabled: false,
    },
    storeConfiguredImpl: () => { storeChecks += 1; return true; },
    sweepRunner: async () => { sweeps += 1; throw new Error("must stay dark"); },
    drainImpl: async () => { drains += 1; throw new Error("must stay dark"); },
  });
  assert.deepEqual(result, {
    ok: false,
    ran: false,
    reason: "disabled",
    sweep: null,
    postCallInterest: null,
  });
  assert.equal(storeChecks, 0);
  assert.equal(sweeps, 0);
  assert.equal(drains, 0);
});

test("the dedicated projection fails closed when its required KV is absent", async () => {
  let sweeps = 0;
  let drains = 0;
  const result = await runPostCallInterestProjectionTick({
    config: { enabled: false, postCallInterestEnabled: true },
    storeConfiguredImpl: () => false,
    sweepRunner: async () => { sweeps += 1; },
    drainImpl: async () => { drains += 1; },
  });
  assert.equal(result.ran, false);
  assert.equal(result.reason, "store_not_configured");
  assert.equal(sweeps, 0);
  assert.equal(drains, 0);
});

test("the dedicated projection ignores legacy lane gates but strips all action authority", async () => {
  let selectedConfig = null;
  let drainOptions = null;
  const result = await runPostCallInterestProjectionTick({
    config: {
      enabled: false,
      dryRun: false,
      notBefore: Date.parse("2099-01-01T00:00:00.000Z"),
      notBeforeConfigured: false,
      releaseReady: true,
      stopArmed: true,
      emailArmed: true,
      submitArmed: true,
      writesEnabled: true,
      gateOrderViolations: ["legacy gate violation"],
      sweepIntervalMs: 60_000,
      postCallInterestEnabled: true,
    },
    now: Date.parse(EVENT.occurredAt),
    storeConfiguredImpl: () => true,
    sweepRunner: async (options) => {
      selectedConfig = options.config;
      return { sweep: null, summary: { skipped: "not_due" } };
    },
    drainImpl: async (options) => {
      drainOptions = options;
      return {
        enabled: true, attempted: 0, delivered: 0, pending: 0, leased: 0, deferred: 0,
      };
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.ran, true);
  assert.deepEqual(result.sweep, { skipped: "not_due" });
  assert.equal(selectedConfig.postCallInterestEnabled, true);
  assert.equal(selectedConfig.notBefore, null);
  assert.equal(selectedConfig.enabled, false);
  assert.equal(selectedConfig.dryRun, true);
  assert.equal(selectedConfig.releaseReady, false);
  assert.equal(selectedConfig.writesEnabled, false);
  assert.equal(selectedConfig.stopArmed, false);
  assert.equal(selectedConfig.emailArmed, false);
  assert.equal(selectedConfig.submitArmed, false);
  assert.deepEqual(selectedConfig.gateOrderViolations, []);
  assert.deepEqual(drainOptions, { enabled: true });
});

test("legacy and dedicated sweep overlaps share one lease owner", async () => {
  let locked = false;
  let sweepCalls = 0;
  let releaseSweep;
  let markStarted;
  const started = new Promise((resolve) => { markStarted = resolve; });
  const barrier = new Promise((resolve) => { releaseSweep = resolve; });
  const dependencies = {
    config: { sweepIntervalMs: 60_000 },
    now: Date.parse(EVENT.occurredAt),
    getSweepStateImpl: async () => null,
    acquireLockImpl: async () => {
      if (locked) return null;
      locked = true;
      return "shared-sweep-owner";
    },
    releaseLockImpl: async (_candidate, token) => {
      assert.equal(token, "shared-sweep-owner");
      locked = false;
    },
    sweepImpl: async () => {
      sweepCalls += 1;
      markStarted();
      await barrier;
      return {
        ok: true,
        populationSize: 1,
        cursorStart: 0,
        cursorEnd: 1,
        nextCursor: 0,
        cycleComplete: true,
        cycleCandidatesRead: 1,
        candidatesRead: 1,
        seeded: 0,
        detected: [],
        readErrors: 0,
        stateDeferrals: 0,
        postCallOutboxQueued: 0,
        postCallOutboxErrors: 0,
      };
    },
  };
  const legacy = runScheduledInterestSweep(dependencies);
  await started;
  const dedicated = await runScheduledInterestSweep(dependencies);
  assert.deepEqual(dedicated, { sweep: null, summary: { skipped: "locked" } });
  releaseSweep();
  const completed = await legacy;
  assert.equal(completed.summary.ok, true);
  assert.equal(sweepCalls, 1);
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
      claimImpl: async () => { reads += 1; return []; },
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
  const persistence = source.indexOf("await recordEventImpl({");
  const advancement = source.indexOf(
    "await putSnapshotImpl(candidate.candidateUserId, statuses);",
    persistence,
  );
  const leaseRelease = source.indexOf(
    "await releaseLockImpl(candidate.candidateUserId, token);",
    persistence,
  );
  assert.ok(persistence > 0);
  assert.ok(advancement > persistence);
  assert.ok(leaseRelease > advancement);
});
