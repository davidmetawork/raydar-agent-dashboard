process.env.PARAFORM_COOKIE ||= "Fe26.2**test-cookie";
process.env.CALENDLY_API_TOKEN ||= "test-calendly-token";

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  BOOKING_MEMBERSHIP_KEYS,
  BOOKING_MEMBERSHIP_MAX_SHARDS,
  bookingMembershipCanonicalJson,
  bookingMembershipHash,
  bookingMembershipLeadIndex,
  bookingMembershipSnapshotHealth,
  loadPublishedBookingMembershipSnapshot,
  runBookingMembershipRefresh,
} from "../api/seq/_lib/booking-membership-snapshot.mjs";
import {
  BOOKING_MEMBERSHIP_CURRENT_SCHEMA,
  BOOKING_MEMBERSHIP_BUILD_BUDGET_MS,
  BOOKING_MEMBERSHIP_MAX_AGE_MS,
  BOOKING_MEMBERSHIP_SNAPSHOT_SCHEMA,
  BOOKING_STOP_ATTEMPT_SCHEMA,
  BOOKING_STOP_LEAD_INDEX_SCHEMA,
} from "../api/seq/_lib/booking-stop-contract.mjs";
import {
  K,
  bookingLeadIndexUsable,
  parseKvMgetResult,
  runBookingSweep,
  sweepStaleness,
} from "../api/seq/_lib/booking-stop.mjs";

const BASE_NOW = Date.parse("2026-07-29T14:07:00.000Z");
const GEN_A = "a".repeat(32);
const GEN_B = "b".repeat(32);

function clone(value) {
  return value == null ? value : structuredClone(value);
}

test("paused membership keeps only the fingerprint-selected canary in the webhook index", () => {
  const index = bookingMembershipLeadIndex({
    generation: GEN_A,
    manifestHash: "f".repeat(64),
    scope: {
      schema: "raydar-booking-stop-scope-v1",
      scopeDigest: "d".repeat(64),
      catalogFloor: 1,
    },
    builtAt: new Date(BASE_NOW).toISOString(),
    perSequence: [{
      sequence: { id: "sequence-1", name: "No-send canary" },
      leads: [
        { ccu_id: "active", is_paused: false, is_archived: false, to_use_email: "active@example.invalid" },
        { ccu_id: "canary", is_paused: true, is_archived: false, to_use_email: "canary@example.invalid" },
        { ccu_id: "ordinary", is_paused: true, is_archived: false, to_use_email: "ordinary@example.invalid" },
      ],
    }],
    includePausedLead: (lead) => lead.ccu_id === "canary",
  });
  assert.deepEqual(Object.keys(index.byEmail).sort(), [
    "active@example.invalid",
    "canary@example.invalid",
  ]);
  assert.equal(index.byEmail["ordinary@example.invalid"], undefined);
});

class MemoryStore {
  constructor(now = BASE_NOW) {
    this.now = now;
    this.values = new Map();
    this.expiries = new Map();
    this.operations = [];
  }

  expire(key) {
    const expiry = this.expiries.get(key);
    if (expiry != null && expiry <= this.now) {
      this.values.delete(key);
      this.expiries.delete(key);
    }
  }

  async get(key) {
    this.expire(key);
    this.operations.push(["get", key]);
    return clone(this.values.get(key) ?? null);
  }

  async getMany(keys) {
    this.operations.push(["getMany", ...keys]);
    return keys.map((key) => {
      this.expire(key);
      return clone(this.values.get(key) ?? null);
    });
  }

  async set(key, value, ttlSeconds) {
    this.operations.push(["set", key]);
    this.values.set(key, clone(value));
    if (ttlSeconds) this.expiries.set(key, this.now + ttlSeconds * 1000);
    return "OK";
  }

  async setNx(key, value, ttlSeconds) {
    this.expire(key);
    this.operations.push(["setNx", key]);
    if (this.values.has(key)) return null;
    this.values.set(key, clone(value));
    if (ttlSeconds) this.expiries.set(key, this.now + ttlSeconds * 1000);
    return "OK";
  }

  async atomicPublish({
    expectedCurrent,
    current,
    leadIndex,
    ttlSeconds,
  }) {
    this.expire(BOOKING_MEMBERSHIP_KEYS.current);
    const existing = this.values.get(BOOKING_MEMBERSHIP_KEYS.current) ?? null;
    if (
      bookingMembershipCanonicalJson(existing)
      !== bookingMembershipCanonicalJson(expectedCurrent)
    ) {
      return 0;
    }
    this.operations.push([
      "atomicPublish",
      current.generation,
      leadIndex.generation,
    ]);
    this.values.set(BOOKING_MEMBERSHIP_KEYS.current, clone(current));
    this.values.set("seqguard:leadindex", clone(leadIndex));
    this.expiries.set(
      BOOKING_MEMBERSHIP_KEYS.current,
      this.now + ttlSeconds * 1000,
    );
    this.expiries.set(
      "seqguard:leadindex",
      this.now + ttlSeconds * 1000,
    );
    return 1;
  }

  raw(key) {
    this.expire(key);
    return this.values.get(key);
  }

  delete(key) {
    this.values.delete(key);
    this.expiries.delete(key);
  }
}

function sequence(id, name = `Sequence ${id}`) {
  return { id, name, enabled: true };
}

function scope({
  digest = "d".repeat(64),
  sequences = [sequence("seq-a"), sequence("seq-b")],
  catalog = 2,
} = {}) {
  return {
    schema: "raydar-booking-stop-scope-v2",
    scopeDigest: digest,
    catalogFloor: 1,
    sequences,
    catalogSequences: catalog,
    scannedSequences: catalog,
    linkSequences: sequences.length,
    enabledLinkSequences: sequences.length,
    coveredEnabledLinkSequences: sequences.length,
    complete: true,
  };
}

function lead(id, {
  email = `${id}@example.com`,
  createdAt = "2026-07-29T08:00:00.000Z",
} = {}) {
  return {
    ccu_id: `ccu-${id}`,
    cu_id: `cu-${id}`,
    name: `Candidate ${id}`,
    to_use_email: email,
    user_emails: [],
    created_at: createdAt,
    is_paused: false,
    is_archived: false,
  };
}

function completeRead(leads) {
  return {
    complete: true,
    leads,
    totalCount: leads.length,
    unique: leads.length,
    shortfall: 0,
    apiCalls: 1,
  };
}

async function publish({
  store = new MemoryStore(),
  currentScope = scope(),
  generation = GEN_A,
  leadsBySequence = new Map([
    ["seq-a", [lead("a")]],
    ["seq-b", [lead("b")]],
  ]),
} = {}) {
  const result = await runBookingMembershipRefresh({
    scopeLoader: async () => clone(currentScope),
    membershipLoader: async (id) =>
      completeRead(clone(leadsBySequence.get(id) || [])),
    store,
    clock: () => store.now,
    generationFactory: () => generation,
  });
  return { store, result, currentScope, leadsBySequence };
}

test("happy publication is manifest-last and atomically pairs current with the by-email index", async () => {
  const { store, result, currentScope } = await publish();
  assert.equal(result.ok, true);
  assert.equal(result.complete, true);
  assert.equal(result.generation, GEN_A);
  assert.equal(result.shardCount, 2);
  assert.equal(result.leadCount, 2);

  const current = store.raw(BOOKING_MEMBERSHIP_KEYS.current);
  const manifest = store.raw(current.manifestKey);
  const index = store.raw("seqguard:leadindex");
  assert.equal(current.schema, BOOKING_MEMBERSHIP_CURRENT_SCHEMA);
  assert.equal(manifest.schema, BOOKING_MEMBERSHIP_SNAPSHOT_SCHEMA);
  assert.equal(index.generation, current.generation);
  assert.equal(index.manifestHash, current.manifestHash);
  assert.equal(bookingMembershipHash(index), current.leadIndexHash);
  assert.equal(index.byEmail["a@example.com"][0].ccu, "ccu-a");

  const writes = store.operations.filter(([kind]) =>
    ["setNx", "atomicPublish"].includes(kind));
  const manifestWrite = writes.findIndex(([, key]) =>
    key === current.manifestKey);
  const finalShardWrite = Math.max(...manifest.shards.map(({ key }) =>
    writes.findIndex(([, writtenKey]) => writtenKey === key)));
  const atomicWrite = writes.findIndex(([kind]) => kind === "atomicPublish");
  assert.ok(manifestWrite > finalShardWrite, "manifest must be written last");
  assert.ok(atomicWrite > manifestWrite, "publication follows manifest proof");

  store.operations.length = 0;
  const consumed = await loadPublishedBookingMembershipSnapshot({
    scope: currentScope,
    read: (key) => store.get(key),
    readMany: (keys) => store.getMany(keys),
    now: store.now,
  });
  assert.equal(consumed.ok, true);
  assert.equal(consumed.perSequence.length, 2);
  const batchReads = store.operations.filter(([kind]) =>
    kind === "getMany");
  assert.deepEqual(
    batchReads,
    [["getMany", ...manifest.shards.map(({ key }) => key)]],
    "all immutable shards must use exactly one ordered batch read",
  );
  assert.equal(
    store.operations.some(([kind, key]) =>
      kind === "get"
      && manifest.shards.some((descriptor) => descriptor.key === key)),
    false,
    "no descriptor shard may fall back to a sequential GET",
  );
});

test("consumer rejects missing batch readers, wrong counts, and wrong order", async () => {
  const published = await publish();
  const base = {
    scope: published.currentScope,
    read: (key) => published.store.get(key),
    now: published.store.now,
  };
  const missingReader =
    await loadPublishedBookingMembershipSnapshot(base);
  assert.equal(missingReader.ok, false);
  assert.equal(missingReader.detail, "shard_batch_reader_missing");

  const wrongCount = await loadPublishedBookingMembershipSnapshot({
    ...base,
    readMany: async (keys) =>
      (await published.store.getMany(keys)).slice(1),
  });
  assert.equal(wrongCount.ok, false);
  assert.equal(wrongCount.detail, "shard_batch_invalid");

  const wrongOrder = await loadPublishedBookingMembershipSnapshot({
    ...base,
    readMany: async (keys) =>
      (await published.store.getMany(keys)).reverse(),
  });
  assert.equal(wrongOrder.ok, false);
  assert.equal(wrongOrder.detail, "shard_missing_or_invalid");
});

test("KV MGET parsing is exact, ordered, and bounded", () => {
  assert.deepEqual(
    parseKvMgetResult(
      [JSON.stringify({ sequenceId: "a" }), null],
      2,
    ),
    [{ sequenceId: "a" }, null],
  );
  assert.throws(
    () => parseKvMgetResult([JSON.stringify({})], 2),
    (error) => error?.code === "KV_BATCH_READ_INVALID",
  );
  assert.throws(
    () => parseKvMgetResult(["not-json"], 1),
    (error) => error?.code === "KV_BATCH_READ_INVALID",
  );
  assert.throws(
    () => parseKvMgetResult([{}], 1),
    (error) => error?.code === "KV_BATCH_READ_INVALID",
  );
  assert.throws(
    () => parseKvMgetResult(
      new Array(BOOKING_MEMBERSHIP_MAX_SHARDS + 1).fill(null),
      BOOKING_MEMBERSHIP_MAX_SHARDS + 1,
    ),
    (error) => error?.code === "KV_BATCH_READ_INVALID",
  );
});

test("38-shard consumer and public health each use one bounded batch round trip", async () => {
  const sequences = Array.from(
    { length: 38 },
    (_, index) => sequence(`seq-${String(index).padStart(2, "0")}`),
  );
  const published = await publish({
    currentScope: scope({ sequences, catalog: sequences.length }),
    leadsBySequence: new Map(
      sequences.map(({ id }, index) => [id, [lead(`batch-${index}`)]]),
    ),
  });

  published.store.operations.length = 0;
  const consumed = await loadPublishedBookingMembershipSnapshot({
    scope: published.currentScope,
    read: (key) => published.store.get(key),
    readMany: (keys) => published.store.getMany(keys),
    now: published.store.now,
  });
  assert.equal(consumed.ok, true);
  assert.equal(consumed.perSequence.length, 38);
  assert.equal(
    published.store.operations.filter(([kind]) => kind === "get").length,
    2,
    "consumer reads only current and manifest individually",
  );
  const consumerBatches = published.store.operations.filter(([kind]) =>
    kind === "getMany");
  assert.equal(consumerBatches.length, 1);
  assert.equal(consumerBatches[0].length - 1, 38);

  published.store.operations.length = 0;
  const health = await bookingMembershipSnapshotHealth({
    read: (key) => published.store.get(key),
    readMany: (keys) => published.store.getMany(keys),
    now: published.store.now,
  });
  assert.equal(health.current, true);
  assert.equal(
    published.store.operations.filter(([kind]) => kind === "get").length,
    3,
    "health reads only current, attempt, and manifest individually",
  );
  const healthBatches = published.store.operations.filter(([kind]) =>
    kind === "getMany");
  assert.equal(healthBatches.length, 1);
  assert.equal(healthBatches[0].length - 1, 38);
});

test("membership shards persist only the minimal sweep projection", async () => {
  const privateSentinel = "MUST_NOT_PERSIST_PRIVATE_PROFILE_DATA";
  const sourceLead = {
    ...lead("private"),
    name: privateSentinel,
    linkedin_url: `https://linkedin.example/${privateSentinel}`,
    phone: privateSentinel,
    recent_experience: { company_name: privateSentinel },
    arbitrary_private_upstream_field: privateSentinel,
  };
  const published = await publish({
    currentScope: scope({
      sequences: [sequence("seq-a")],
      catalog: 1,
    }),
    leadsBySequence: new Map([["seq-a", [sourceLead]]]),
  });
  const current =
    published.store.raw(BOOKING_MEMBERSHIP_KEYS.current);
  const manifest = published.store.raw(current.manifestKey);
  const shard = published.store.raw(manifest.shards[0].key);
  assert.deepEqual(Object.keys(shard.leads[0]).sort(), [
    "ccu_id",
    "created_at",
    "cu_id",
    "is_archived",
    "is_paused",
    "to_use_email",
    "user_emails",
  ]);
  assert.equal(JSON.stringify(shard).includes(privateSentinel), false);
  assert.equal(
    JSON.stringify(
      published.store.raw(BOOKING_MEMBERSHIP_KEYS.leadIndex),
    ).includes(privateSentinel),
    false,
  );
});

test("an incomplete membership read never publishes a manifest, current pointer, or index", async () => {
  const store = new MemoryStore();
  await assert.rejects(
    () => runBookingMembershipRefresh({
      scopeLoader: async () => scope(),
      membershipLoader: async (id) => id === "seq-a"
        ? completeRead([lead("a")])
        : {
            complete: false,
            leads: [lead("partial")],
            totalCount: 2,
            unique: 1,
            shortfall: 1,
          },
      store,
      clock: () => store.now,
      generationFactory: () => GEN_A,
    }),
    (error) => error?.code === "BOOKING_MEMBERSHIP_READ_INCOMPLETE",
  );
  assert.equal(store.raw(BOOKING_MEMBERSHIP_KEYS.current), undefined);
  assert.equal(
    store.raw(BOOKING_MEMBERSHIP_KEYS.manifest(GEN_A)),
    undefined,
  );
  assert.equal(store.raw("seqguard:leadindex"), undefined);
});

test("missing, malformed, or future decision-critical lead fields prevent publication", async () => {
  const cases = [
    ["missing cu_id", (value) => { delete value.cu_id; }],
    ["missing to_use_email", (value) => { delete value.to_use_email; }],
    ["malformed user_emails", (value) => {
      value.user_emails = ["ok@example.com", null];
    }],
    ["missing created_at", (value) => { delete value.created_at; }],
    ["malformed created_at", (value) => {
      value.created_at = "not-a-timestamp";
    }],
    ["future created_at", (value) => {
      value.created_at = new Date(BASE_NOW + 1).toISOString();
    }],
    ["malformed is_paused", (value) => { value.is_paused = 0; }],
    ["missing is_archived", (value) => { delete value.is_archived; }],
  ];
  for (const [label, mutate] of cases) {
    const store = new MemoryStore();
    const invalidLead = lead(`invalid-${label}`);
    mutate(invalidLead);
    await assert.rejects(
      () => runBookingMembershipRefresh({
        scopeLoader: async () => scope({
          sequences: [sequence("seq-a")],
          catalog: 1,
        }),
        membershipLoader: async () => completeRead([invalidLead]),
        store,
        clock: () => store.now,
        generationFactory: () => GEN_A,
      }),
      (error) =>
        error?.code === "BOOKING_MEMBERSHIP_READ_INCOMPLETE",
      label,
    );
    assert.equal(
      store.raw(BOOKING_MEMBERSHIP_KEYS.current),
      undefined,
      label,
    );
    assert.equal(
      store.raw(BOOKING_MEMBERSHIP_KEYS.manifest(GEN_A)),
      undefined,
      label,
    );
    assert.equal(store.raw("seqguard:leadindex"), undefined, label);
  }
});

test("consumer rejects a wrong shard hash and a missing shard", async () => {
  const first = await publish();
  const current = first.store.raw(BOOKING_MEMBERSHIP_KEYS.current);
  const manifest = first.store.raw(current.manifestKey);
  const firstShardKey = manifest.shards[0].key;
  first.store.raw(firstShardKey).leads[0].name = "tampered";
  const wrongHash = await loadPublishedBookingMembershipSnapshot({
    scope: first.currentScope,
    read: (key) => first.store.get(key),
    readMany: (keys) => first.store.getMany(keys),
    now: first.store.now,
  });
  assert.equal(wrongHash.ok, false);
  assert.equal(wrongHash.error, "membership_snapshot_unavailable");
  assert.equal(wrongHash.detail, "shard_missing_or_invalid");

  const second = await publish({ generation: GEN_B });
  const secondCurrent =
    second.store.raw(BOOKING_MEMBERSHIP_KEYS.current);
  const secondManifest = second.store.raw(secondCurrent.manifestKey);
  second.store.delete(secondManifest.shards[1].key);
  const missing = await loadPublishedBookingMembershipSnapshot({
    scope: second.currentScope,
    read: (key) => second.store.get(key),
    readMany: (keys) => second.store.getMany(keys),
    now: second.store.now,
  });
  assert.equal(missing.ok, false);
  assert.equal(missing.detail, "shard_missing_or_invalid");
});

test("rehashed current-schema shards with invalid lead bytes fail consumer and public health", async () => {
  const cases = [
    ["missing cu_id", (value) => { delete value.cu_id; }],
    ["null created_at", (value) => { value.created_at = null; }],
    ["future created_at", (value, fetchedAtMs) => {
      value.created_at = new Date(fetchedAtMs + 1).toISOString();
    }],
    ["malformed is_paused", (value) => { value.is_paused = "false"; }],
    ["malformed user_emails", (value) => {
      value.user_emails = [null];
    }],
    ["extra projection field", (value) => {
      value.unexpected = "must-fail";
    }],
  ];
  for (const [label, mutate] of cases) {
    const published = await publish();
    const current =
      published.store.raw(BOOKING_MEMBERSHIP_KEYS.current);
    const manifest = published.store.raw(current.manifestKey);
    const descriptor = manifest.shards[0];
    const shard = published.store.raw(descriptor.key);
    mutate(shard.leads[0], Date.parse(shard.fetchedAt));
    descriptor.hash = bookingMembershipHash(shard);
    current.manifestHash = bookingMembershipHash(manifest);

    published.store.operations.length = 0;
    const consumed = await loadPublishedBookingMembershipSnapshot({
      scope: published.currentScope,
      read: (key) => published.store.get(key),
      readMany: (keys) => published.store.getMany(keys),
      now: published.store.now,
    });
    assert.equal(consumed.ok, false, label);
    assert.equal(
      consumed.detail,
      "shard_missing_or_invalid",
      label,
    );
    assert.equal(
      published.store.operations.filter(([kind]) =>
        kind === "getMany").length,
      1,
      `${label}: consumer MGET count`,
    );

    published.store.operations.length = 0;
    const health = await bookingMembershipSnapshotHealth({
      read: (key) => published.store.get(key),
      readMany: (keys) => published.store.getMany(keys),
      now: published.store.now,
    });
    assert.equal(health.current, false, label);
    assert.equal(health.complete, false, label);
    assert.equal(
      published.store.operations.filter(([kind]) =>
        kind === "getMany").length,
      1,
      `${label}: health MGET count`,
    );
  }
});

test("consumer rejects rehashed selected-sequence omissions and live-scope mismatch", async () => {
  const omitted = await publish();
  const current = omitted.store.raw(BOOKING_MEMBERSHIP_KEYS.current);
  const manifest = omitted.store.raw(current.manifestKey);
  manifest.shards.pop();
  manifest.shardCount = manifest.shards.length;
  manifest.leadCount = manifest.shards[0].count;
  current.manifestHash = bookingMembershipHash(manifest);
  const missingCoverage =
    await loadPublishedBookingMembershipSnapshot({
      scope: omitted.currentScope,
      read: (key) => omitted.store.get(key),
      readMany: (keys) => omitted.store.getMany(keys),
      now: omitted.store.now,
    });
  assert.equal(missingCoverage.ok, false);
  assert.equal(missingCoverage.detail, "manifest_invalid");

  const drifted = await publish({ generation: GEN_B });
  const wrongScope = await loadPublishedBookingMembershipSnapshot({
    scope: scope({ digest: "f".repeat(64) }),
    read: (key) => drifted.store.get(key),
    readMany: (keys) => drifted.store.getMany(keys),
    now: drifted.store.now,
  });
  assert.equal(wrongScope.ok, false);
  assert.equal(wrongScope.detail, "current_invalid_or_scope_mismatch");
});

test("fixed oldestFetchedAt freshness rejects stale and future generations", async () => {
  const stale = await publish();
  const staleRead = await loadPublishedBookingMembershipSnapshot({
    scope: stale.currentScope,
    read: (key) => stale.store.get(key),
    readMany: (keys) => stale.store.getMany(keys),
    now: stale.store.now + BOOKING_MEMBERSHIP_MAX_AGE_MS + 1,
  });
  assert.equal(staleRead.ok, false);
  assert.equal(staleRead.detail, "snapshot_stale_or_future");

  const future = await publish({ generation: GEN_B });
  const futureRead = await loadPublishedBookingMembershipSnapshot({
    scope: future.currentScope,
    read: (key) => future.store.get(key),
    readMany: (keys) => future.store.getMany(keys),
    now: future.store.now - 1,
  });
  assert.equal(futureRead.ok, false);
  assert.equal(futureRead.detail, "snapshot_stale_or_future");
});

test("scope drift between the before and after reads prevents publication", async () => {
  const store = new MemoryStore();
  let reads = 0;
  await assert.rejects(
    () => runBookingMembershipRefresh({
      scopeLoader: async () => {
        reads++;
        return scope({ digest: (reads === 1 ? "a" : "b").repeat(64) });
      },
      membershipLoader: async (id) => completeRead([lead(id)]),
      store,
      clock: () => store.now,
      generationFactory: () => GEN_A,
    }),
    (error) => error?.code === "BOOKING_MEMBERSHIP_SCOPE_DRIFT",
  );
  assert.equal(reads, 2);
  assert.equal(store.raw(BOOKING_MEMBERSHIP_KEYS.current), undefined);
  assert.equal(store.raw("seqguard:leadindex"), undefined);
});

test("a final clock rollback cannot publish future shard timestamps", async () => {
  const validAt = Date.parse("2026-07-29T13:50:00.000Z");
  const firstFetchAt = Date.parse("2026-07-29T14:00:00.000Z");
  const secondFetchAt = Date.parse("2026-07-29T14:03:00.000Z");
  const rolledBackFinalAt = Date.parse("2026-07-29T14:02:00.000Z");
  const store = new MemoryStore(validAt);
  await publish({ store, generation: GEN_A });
  const validCurrent = clone(
    store.raw(BOOKING_MEMBERSHIP_KEYS.current),
  );
  const validIndex = clone(
    store.raw(BOOKING_MEMBERSHIP_KEYS.leadIndex),
  );

  store.now = firstFetchAt;
  let logicalNow = firstFetchAt;
  let scopeReads = 0;
  await assert.rejects(
    () => runBookingMembershipRefresh({
      scopeLoader: async () => {
        scopeReads++;
        if (scopeReads === 2) logicalNow = rolledBackFinalAt;
        return scope();
      },
      membershipLoader: async (id) => {
        logicalNow = id === "seq-a" ? firstFetchAt : secondFetchAt;
        return completeRead([lead(id)]);
      },
      store,
      clock: () => logicalNow,
      generationFactory: () => GEN_B,
      concurrency: 1,
    }),
    (error) =>
      error?.code === "BOOKING_MEMBERSHIP_SNAPSHOT_TIME_INVALID",
  );
  assert.equal(scopeReads, 2);
  assert.deepEqual(
    store.raw(BOOKING_MEMBERSHIP_KEYS.current),
    validCurrent,
    "the prior valid pointer remains authoritative",
  );
  assert.deepEqual(
    store.raw(BOOKING_MEMBERSHIP_KEYS.leadIndex),
    validIndex,
    "the prior valid webhook index remains atomically paired",
  );
  assert.equal(
    store.raw(BOOKING_MEMBERSHIP_KEYS.manifest(GEN_B)),
    undefined,
    "future shard time is rejected before manifest publication",
  );
});

test("a crash resumes the checkpoint without re-reading completed sequence membership", async () => {
  const store = new MemoryStore();
  let crash = true;
  const firstCalls = [];
  await assert.rejects(
    () => runBookingMembershipRefresh({
      scopeLoader: async () => scope(),
      membershipLoader: async (id) => {
        firstCalls.push(id);
        if (id === "seq-b" && crash) throw new Error("simulated crash");
        return completeRead([lead(id)]);
      },
      store,
      clock: () => store.now,
      generationFactory: () => GEN_A,
      concurrency: 1,
    }),
    /simulated crash/u,
  );
  assert.deepEqual(firstCalls, ["seq-a", "seq-b"]);
  const checkpoint = store.raw(BOOKING_MEMBERSHIP_KEYS.checkpoint);
  assert.equal(checkpoint.shards.length, 1);

  store.now += 5 * 60 * 1000 + 1;
  crash = false;
  const resumedCalls = [];
  const resumed = await runBookingMembershipRefresh({
    scopeLoader: async () => scope({
      sequences: [sequence("seq-b"), sequence("seq-a")],
    }),
    membershipLoader: async (id) => {
      resumedCalls.push(id);
      return completeRead([lead(id)]);
    },
    store,
    clock: () => store.now,
    generationFactory: () => GEN_B,
    concurrency: 1,
  });
  assert.equal(resumed.ok, true);
  assert.equal(resumed.generation, GEN_A, "resume retains the generation");
  assert.deepEqual(resumedCalls, ["seq-b"]);
});

test("a rehashed checkpoint shard with invalid critical lead bytes cannot resume", async () => {
  const store = new MemoryStore();
  await assert.rejects(
    () => runBookingMembershipRefresh({
      scopeLoader: async () => scope(),
      membershipLoader: async (id) => {
        if (id === "seq-b") throw new Error("simulated crash");
        return completeRead([lead(id)]);
      },
      store,
      clock: () => store.now,
      generationFactory: () => GEN_A,
      concurrency: 1,
    }),
    /simulated crash/u,
  );
  const checkpoint = store.raw(BOOKING_MEMBERSHIP_KEYS.checkpoint);
  const descriptor = checkpoint.shards[0];
  const shard = store.raw(descriptor.key);
  shard.leads[0].created_at = null;
  descriptor.hash = bookingMembershipHash(shard);

  store.now += 5 * 60 * 1000 + 1;
  await assert.rejects(
    () => runBookingMembershipRefresh({
      scopeLoader: async () => scope(),
      membershipLoader: async () => {
        throw new Error("membership loader must not run");
      },
      store,
      clock: () => store.now,
      generationFactory: () => GEN_B,
      concurrency: 1,
    }),
    (error) =>
      error?.code === "BOOKING_MEMBERSHIP_CHECKPOINT_INVALID",
  );
});

test("a partial immutable batch write resumes with retry-unique shard keys", async () => {
  class PartialShardCrashStore extends MemoryStore {
    shardWrites = 0;
    crash = true;

    async setNx(key, value, ttlSeconds) {
      if (key.includes(":shard:")) {
        this.shardWrites++;
        if (this.crash && this.shardWrites === 2) {
          this.crash = false;
          throw new Error("simulated partial shard transport crash");
        }
      }
      return super.setNx(key, value, ttlSeconds);
    }
  }
  const store = new PartialShardCrashStore();
  await assert.rejects(
    () => publish({ store, generation: GEN_A }),
    /simulated partial shard transport crash/u,
  );
  const orphanKeys = [...store.values.keys()].filter((key) =>
    key.includes(":shard:"));
  assert.equal(orphanKeys.length, 1);
  assert.equal(
    store.raw(BOOKING_MEMBERSHIP_KEYS.checkpoint).shards.length,
    0,
    "the successful SET NX was not yet checkpointed",
  );

  store.now += 5 * 60 * 1000 + 1;
  const resumed = await publish({
    store,
    generation: GEN_B,
    currentScope: scope({
      sequences: [sequence("seq-b"), sequence("seq-a")],
    }),
  });
  assert.equal(resumed.result.ok, true);
  assert.equal(resumed.result.generation, GEN_A);
  const current = store.raw(BOOKING_MEMBERSHIP_KEYS.current);
  const manifest = store.raw(current.manifestKey);
  assert.equal(
    manifest.shards.some(({ key }) => orphanKeys.includes(key)),
    false,
    "the immutable orphan is ignored rather than adopted without a descriptor",
  );
});

test("a crash after manifest write resumes with identical immutable bytes", async () => {
  class AtomicCrashStore extends MemoryStore {
    crash = true;

    async atomicPublish(args) {
      if (this.crash) {
        this.crash = false;
        throw new Error("crash before atomic publication");
      }
      return super.atomicPublish(args);
    }
  }
  const store = new AtomicCrashStore();
  await assert.rejects(
    () => publish({ store, generation: GEN_A }),
    /crash before atomic publication/u,
  );
  const manifestBefore = clone(
    store.raw(BOOKING_MEMBERSHIP_KEYS.manifest(GEN_A)),
  );
  assert.ok(manifestBefore, "manifest was durably written before the crash");
  assert.equal(store.raw(BOOKING_MEMBERSHIP_KEYS.current), undefined);

  store.now += 5 * 60 * 1000 + 1;
  const calls = [];
  const resumed = await runBookingMembershipRefresh({
    scopeLoader: async () => scope({
      sequences: [sequence("seq-b"), sequence("seq-a")],
    }),
    membershipLoader: async (id) => {
      calls.push(id);
      return completeRead([lead(id)]);
    },
    store,
    clock: () => store.now,
    generationFactory: () => GEN_B,
  });
  assert.equal(resumed.ok, true);
  assert.equal(resumed.generation, GEN_A);
  assert.deepEqual(calls, []);
  assert.deepEqual(
    store.raw(BOOKING_MEMBERSHIP_KEYS.manifest(GEN_A)),
    manifestBefore,
  );
});

test("a crash after atomic publication resumes without rolling or rewriting the generation", async () => {
  class FinalCheckpointCrashStore extends MemoryStore {
    crash = true;

    async set(key, value, ttlSeconds) {
      if (
        this.crash
        && key === BOOKING_MEMBERSHIP_KEYS.checkpoint
        && value?.status === "published"
      ) {
        this.crash = false;
        throw new Error("crash after atomic publication");
      }
      return super.set(key, value, ttlSeconds);
    }
  }
  const store = new FinalCheckpointCrashStore();
  await assert.rejects(
    () => publish({ store, generation: GEN_A }),
    /crash after atomic publication/u,
  );
  const currentBefore = clone(
    store.raw(BOOKING_MEMBERSHIP_KEYS.current),
  );
  const indexBefore = clone(store.raw(BOOKING_MEMBERSHIP_KEYS.leadIndex));
  assert.equal(currentBefore.generation, GEN_A);
  assert.equal(indexBefore.generation, GEN_A);

  store.now += 5 * 60 * 1000 + 1;
  const calls = [];
  const resumed = await runBookingMembershipRefresh({
    scopeLoader: async () => scope(),
    membershipLoader: async (id) => {
      calls.push(id);
      return completeRead([lead(id)]);
    },
    store,
    clock: () => store.now,
    generationFactory: () => GEN_B,
  });
  assert.equal(resumed.ok, true);
  assert.equal(resumed.generation, GEN_A);
  assert.deepEqual(calls, []);
  assert.deepEqual(store.raw(BOOKING_MEMBERSHIP_KEYS.current), currentBefore);
  assert.deepEqual(
    store.raw(BOOKING_MEMBERSHIP_KEYS.leadIndex),
    indexBefore,
  );
});

test("the 240-second budget checkpoints even when the final membership read completes at the boundary", async () => {
  const store = new MemoryStore();
  const result = await runBookingMembershipRefresh({
    scopeLoader: async () =>
      scope({ sequences: [sequence("seq-a")], catalog: 1 }),
    membershipLoader: async () => {
      store.now += 240 * 1000;
      return completeRead([lead("a")]);
    },
    store,
    clock: () => store.now,
    generationFactory: () => GEN_A,
  });
  assert.equal(result.ok, false);
  assert.equal(result.resumable, true);
  assert.equal(result.error, "membership_refresh_checkpointed");
  assert.equal(result.completedSequenceCount, 1);
  assert.equal(store.raw(BOOKING_MEMBERSHIP_KEYS.current), undefined);
  assert.equal(
    store.raw(BOOKING_MEMBERSHIP_KEYS.manifest(GEN_A)),
    undefined,
  );
});

test("generation rollover never mutates the prior generation", async () => {
  const first = await publish();
  const oldCurrent = clone(
    first.store.raw(BOOKING_MEMBERSHIP_KEYS.current),
  );
  const oldManifest = clone(first.store.raw(oldCurrent.manifestKey));
  const oldShards = oldManifest.shards.map(({ key }) =>
    [key, clone(first.store.raw(key))]);

  first.store.now += 5 * 60 * 1000 + 1;
  const second = await publish({
    store: first.store,
    currentScope: first.currentScope,
    generation: GEN_B,
  });
  assert.equal(second.result.ok, true);
  assert.equal(
    first.store.raw(BOOKING_MEMBERSHIP_KEYS.current).generation,
    GEN_B,
  );
  assert.deepEqual(first.store.raw(oldCurrent.manifestKey), oldManifest);
  for (const [key, shard] of oldShards) {
    assert.deepEqual(first.store.raw(key), shard);
  }
});

test("a newly enrolled lead appears atomically in the next generation index", async () => {
  const first = await publish({
    leadsBySequence: new Map([
      ["seq-a", [lead("a")]],
      ["seq-b", []],
    ]),
  });
  assert.equal(
    first.store.raw("seqguard:leadindex").byEmail["new@example.com"],
    undefined,
  );

  first.store.now += 5 * 60 * 1000 + 1;
  await publish({
    store: first.store,
    currentScope: first.currentScope,
    generation: GEN_B,
    leadsBySequence: new Map([
      ["seq-a", [lead("a"), lead("new", { email: "new@example.com" })]],
      ["seq-b", []],
    ]),
  });
  const index = first.store.raw("seqguard:leadindex");
  const current = first.store.raw(BOOKING_MEMBERSHIP_KEYS.current);
  assert.equal(index.generation, GEN_B);
  assert.equal(index.generation, current.generation);
  assert.equal(index.byEmail["new@example.com"][0].ccu, "ccu-new");
});

test("webhook lead index is generation/hash-bound and rejects tampered, stale, or future bytes", async () => {
  const published = await publish();
  const current = clone(
    published.store.raw(BOOKING_MEMBERSHIP_KEYS.current),
  );
  const index = clone(
    published.store.raw(BOOKING_MEMBERSHIP_KEYS.leadIndex),
  );
  assert.equal(
    bookingLeadIndexUsable(index, current, published.store.now).usable,
    true,
  );

  for (const oldestFetchedAtMs of [
    published.store.now - BOOKING_MEMBERSHIP_MAX_AGE_MS - 1,
    published.store.now + 1,
  ]) {
    const wrongSnapshotAge = {
      ...clone(current),
      oldestFetchedAt: new Date(oldestFetchedAtMs).toISOString(),
    };
    assert.equal(
      bookingLeadIndexUsable(
        index,
        wrongSnapshotAge,
        published.store.now,
      ).usable,
      false,
      "fresh index bytes cannot bless stale/future membership shards",
    );
  }

  assert.equal(
    bookingLeadIndexUsable(index, {
      ...clone(current),
      publishedAt: new Date(published.store.now - 2000).toISOString(),
    }, published.store.now).usable,
    false,
    "index builtAt must be exactly bound to current.publishedAt",
  );

  const tampered = clone(index);
  tampered.byEmail["a@example.com"][0].ccu = "attacker";
  assert.equal(
    bookingLeadIndexUsable(tampered, current, published.store.now).usable,
    false,
  );

  for (const builtAtMs of [
    published.store.now - BOOKING_MEMBERSHIP_MAX_AGE_MS - 1,
    published.store.now + 1,
  ]) {
    const timed = { ...clone(index), builtAt: new Date(builtAtMs).toISOString() };
    const timedCurrent = {
      ...clone(current),
      leadIndexHash: bookingMembershipHash(timed),
    };
    assert.equal(
      bookingLeadIndexUsable(
        timed,
        timedCurrent,
        published.store.now,
      ).usable,
      false,
    );
  }
});

test("invalid snapshot exits the sweep before booking reads, pauses, rotor writes, or index overwrite", async () => {
  const calls = [];
  const result = await runBookingSweep({
    apply: true,
    now: BASE_NOW,
    sequenceScopeLoader: async () =>
      scope({ sequences: [sequence("seq-a")], catalog: 1 }),
    membershipSnapshotLoader: async () => ({
      ok: false,
      error: "membership_snapshot_unavailable",
      detail: "shard_missing_or_invalid",
    }),
    // These historical injection names are deliberately ignored: the sweep no
    // longer owns either a membership read or index publication.
    membershipLoader: async () => {
      calls.push("membership");
      throw new Error("must never run");
    },
    leadIndexPublisher: async () => {
      calls.push("index");
      throw new Error("must never run");
    },
    calendlyIndexLoader: async () => {
      calls.push("calendly");
      throw new Error("must never run");
    },
    membershipCurrentLoader: async () => {
      calls.push("current");
      throw new Error("must never run");
    },
    decisionApplier: async () => {
      calls.push("pause");
      throw new Error("must never run");
    },
    onDecision: async () => calls.push("decision"),
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, "membership_snapshot_unavailable");
  assert.equal(result.paused, 0);
  assert.equal(result.indexedEmails, 0);
  assert.deepEqual(calls, []);
  assert.equal(
    runBookingSweep.toString().includes("membershipLoader"),
    false,
  );
});

test("missing or incomplete live scope also maps to membership_snapshot_unavailable", async () => {
  for (const sequenceScopeLoader of [
    async () => {
      throw new Error("private upstream detail");
    },
    async () => ({
      ...scope(),
      complete: false,
    }),
  ]) {
    const result = await runBookingSweep({
      apply: true,
      sequenceScopeLoader,
      calendlyIndexLoader: async () => {
        throw new Error("must not run");
      },
      decisionApplier: async () => {
        throw new Error("must not run");
      },
    });
    assert.equal(result.ok, false);
    assert.equal(result.error, "membership_snapshot_unavailable");
    assert.equal(result.paused, 0);
  }
});

test("generation rollover before mutation makes the sweep fail closed with zero pauses", async () => {
  const liveScope =
    scope({ sequences: [sequence("seq-a")], catalog: 1 });
  const consumedCurrent = {
    schema: BOOKING_MEMBERSHIP_CURRENT_SCHEMA,
    snapshotSchema: BOOKING_MEMBERSHIP_SNAPSHOT_SCHEMA,
    complete: true,
    generation: GEN_A,
    manifestHash: "e".repeat(64),
  };
  let pauses = 0;
  const result = await runBookingSweep({
    apply: true,
    now: BASE_NOW,
    profileBudget: 0,
    raydarEnabled: false,
    sequenceScopeLoader: async () => liveScope,
    membershipSnapshotLoader: async () => ({
      ok: true,
      complete: true,
      schema: BOOKING_MEMBERSHIP_SNAPSHOT_SCHEMA,
      generation: GEN_A,
      manifestHash: "e".repeat(64),
      oldestFetchedAt: new Date(BASE_NOW).toISOString(),
      ageMs: 0,
      current: consumedCurrent,
      perSequence: [{
        seq: liveScope.sequences[0],
        leads: [lead("a")],
      }],
    }),
    membershipCurrentLoader: async () => ({
      ...consumedCurrent,
      generation: GEN_B,
    }),
    calendlyIndexLoader: async () => ({
      index: new Map([[
        "a@example.com",
        {
          bookedAt: BASE_NOW,
          startsAt: new Date(BASE_NOW + 3600000).toISOString(),
          eventName: "Human Call",
          status: "active",
        },
      ]]),
      events: 1,
      cacheHits: 0,
      truncated: false,
    }),
    decisionApplier: async () => {
      pauses++;
      return { paused: 1, pausedCcuIds: ["ccu-a"], pauseErrors: [] };
    },
  });
  assert.equal(result.error, "membership_snapshot_unavailable");
  assert.equal(result.membershipSnapshotError, "generation_no_longer_current");
  assert.equal(result.paused, 0);
  assert.equal(pauses, 0);
});

test("a snapshot that expires during booking reads cannot reach mutation", async () => {
  const liveScope =
    scope({ sequences: [sequence("seq-a")], catalog: 1 });
  const oldestFetchedAt = new Date(
    BASE_NOW - BOOKING_MEMBERSHIP_MAX_AGE_MS + 1000,
  ).toISOString();
  const consumedCurrent = {
    schema: BOOKING_MEMBERSHIP_CURRENT_SCHEMA,
    snapshotSchema: BOOKING_MEMBERSHIP_SNAPSHOT_SCHEMA,
    complete: true,
    generation: GEN_A,
    manifestHash: "e".repeat(64),
    oldestFetchedAt,
  };
  let mutationClock = BASE_NOW;
  let pauses = 0;
  const result = await runBookingSweep({
    apply: true,
    now: BASE_NOW,
    clock: () => mutationClock,
    profileBudget: 0,
    raydarEnabled: false,
    sequenceScopeLoader: async () => liveScope,
    membershipSnapshotLoader: async () => ({
      ok: true,
      complete: true,
      schema: BOOKING_MEMBERSHIP_SNAPSHOT_SCHEMA,
      generation: GEN_A,
      manifestHash: "e".repeat(64),
      oldestFetchedAt,
      ageMs: BOOKING_MEMBERSHIP_MAX_AGE_MS - 1000,
      current: consumedCurrent,
      perSequence: [{
        seq: liveScope.sequences[0],
        leads: [lead("a")],
      }],
    }),
    membershipCurrentLoader: async () => consumedCurrent,
    calendlyIndexLoader: async () => {
      mutationClock += 2000;
      return {
        index: new Map([[
          "a@example.com",
          {
            bookedAt: BASE_NOW,
            startsAt: new Date(BASE_NOW + 3600000).toISOString(),
            eventName: "Human Call",
            status: "active",
          },
        ]]),
        events: 1,
        cacheHits: 0,
        truncated: false,
      };
    },
    decisionApplier: async () => {
      pauses++;
      return { paused: 1, pausedCcuIds: ["ccu-a"], pauseErrors: [] };
    },
  });
  assert.equal(result.error, "membership_snapshot_unavailable");
  assert.equal(
    result.membershipSnapshotError,
    "snapshot_stale_before_mutation",
  );
  assert.equal(result.paused, 0);
  assert.equal(result.decisions.length, 0);
  assert.equal(pauses, 0);
});

test("latest running or failed sweep attempt makes prior success stale", async () => {
  const now = BASE_NOW;
  const leadIndex = {
    schema: BOOKING_STOP_LEAD_INDEX_SCHEMA,
    snapshotSchema: BOOKING_MEMBERSHIP_SNAPSHOT_SCHEMA,
    generation: GEN_A,
    manifestHash: "e".repeat(64),
    scopeSchema: "raydar-booking-stop-scope-v2",
    scopeDigest: "d".repeat(64),
    builtAt: new Date(now - 1000).toISOString(),
    byEmail: {},
  };
  const membershipHealth = {
    schema: BOOKING_MEMBERSHIP_SNAPSHOT_SCHEMA,
    generation: GEN_A,
    manifestHash: "e".repeat(64),
    leadIndexHash: bookingMembershipHash(leadIndex),
    current: true,
    complete: true,
    oldestFetchedAt: new Date(now - 1000).toISOString(),
    ageMs: 1000,
    scopeSchema: "raydar-booking-stop-scope-v2",
    scopeDigest: "d".repeat(64),
    catalogSequenceCount: 2,
    selectedSequenceCount: 2,
    latestAttemptAt: new Date(now - 1000).toISOString(),
    latestAttemptStatus: "success",
    latestAttemptError: null,
  };
  const values = new Map([
    [K.lastSweep, {
      at: new Date(now - 2000).toISOString(),
      scopeSchema: "raydar-booking-stop-scope-v2",
      scopeDigest: "d".repeat(64),
      membershipSnapshotSchema: BOOKING_MEMBERSHIP_SNAPSHOT_SCHEMA,
      membershipSnapshotGeneration: GEN_A,
      membershipSnapshotManifestHash: "e".repeat(64),
    }],
    [K.lastAttempt, {
      schema: BOOKING_STOP_ATTEMPT_SCHEMA,
      at: new Date(now - 1000).toISOString(),
      status: "success",
      error: null,
      scopeSchema: "raydar-booking-stop-scope-v2",
      scopeDigest: "d".repeat(64),
      membershipSnapshotGeneration: GEN_A,
    }],
    [K.leadIndex, leadIndex],
  ]);
  const read = async (key) => clone(values.get(key) ?? null);
  const green = await sweepStaleness(now, {
    read,
    snapshotHealthLoader: async () => membershipHealth,
  });
  assert.equal(green.stale, false);
  assert.equal(green.latestAttemptCurrent, true);

  for (const status of ["running", "failure"]) {
    values.set(K.lastAttempt, {
      ...values.get(K.lastAttempt),
      at: new Date(now).toISOString(),
      status,
      error: status === "failure" ? "membership_snapshot_unavailable" : null,
      scopeSchema: null,
      scopeDigest: null,
      membershipSnapshotGeneration: null,
    });
    const statusRead = await sweepStaleness(now + 1, {
      read,
      snapshotHealthLoader: async () => membershipHealth,
    });
    assert.equal(statusRead.stale, true);
    assert.equal(statusRead.latestAttemptStatus, status);
    assert.equal(statusRead.latestAttemptCurrent, false);
  }
});

test("missing or corrupt lead index makes native-off legacy health stale", async () => {
  const now = BASE_NOW;
  const leadIndex = {
    schema: BOOKING_STOP_LEAD_INDEX_SCHEMA,
    snapshotSchema: BOOKING_MEMBERSHIP_SNAPSHOT_SCHEMA,
    generation: GEN_A,
    manifestHash: "e".repeat(64),
    scopeSchema: "raydar-booking-stop-scope-v2",
    scopeDigest: "d".repeat(64),
    builtAt: new Date(now - 1000).toISOString(),
    byEmail: {},
  };
  const membershipHealth = {
    schema: BOOKING_MEMBERSHIP_SNAPSHOT_SCHEMA,
    generation: GEN_A,
    manifestHash: "e".repeat(64),
    leadIndexHash: bookingMembershipHash(leadIndex),
    current: true,
    complete: true,
    oldestFetchedAt: new Date(now - 2000).toISOString(),
    ageMs: 2000,
    scopeSchema: "raydar-booking-stop-scope-v2",
    scopeDigest: "d".repeat(64),
    catalogSequenceCount: 2,
    selectedSequenceCount: 2,
  };
  const baseValues = new Map([
    [K.lastSweep, {
      at: new Date(now - 2000).toISOString(),
      calendlyComplete: true,
      raydarEnabled: false,
      scopeSchema: "raydar-booking-stop-scope-v2",
      scopeDigest: "d".repeat(64),
      membershipSnapshotSchema: BOOKING_MEMBERSHIP_SNAPSHOT_SCHEMA,
      membershipSnapshotGeneration: GEN_A,
      membershipSnapshotManifestHash: "e".repeat(64),
    }],
    [K.lastAttempt, {
      schema: BOOKING_STOP_ATTEMPT_SCHEMA,
      at: new Date(now - 1000).toISOString(),
      status: "success",
      error: null,
      scopeSchema: "raydar-booking-stop-scope-v2",
      scopeDigest: "d".repeat(64),
      membershipSnapshotGeneration: GEN_A,
    }],
  ]);

  for (const damage of ["missing", "corrupt"]) {
    const values = new Map(baseValues);
    if (damage === "corrupt") {
      values.set(K.leadIndex, {
        ...clone(leadIndex),
        byEmail: { "tampered@example.com": [] },
      });
    }
    const status = await sweepStaleness(now, {
      read: async (key) => clone(values.get(key) ?? null),
      snapshotHealthLoader: async () => membershipHealth,
    });
    assert.equal(status.stale, true, damage);
    assert.equal(status.leadIndexCurrent, false, damage);
    assert.equal(status.latestAttemptCurrent, true, damage);
    assert.equal(status.membershipSnapshotCurrent, true, damage);
    assert.equal(status.calendlyComplete, true, damage);
    assert.equal(status.raydarEnabled, false, damage);
  }
});

test("snapshot health exposes generation scope counts and latest refresh attempt", async () => {
  const published = await publish();
  await published.store.set(BOOKING_MEMBERSHIP_KEYS.attempt, {
    schema: "raydar-booking-membership-attempt-v1",
    at: new Date(published.store.now).toISOString(),
    status: "failure",
    error: "membership_refresh_locked",
    generation: null,
  }, 3600);
  const current =
    published.store.raw(BOOKING_MEMBERSHIP_KEYS.current);
  const manifest = published.store.raw(current.manifestKey);
  published.store.operations.length = 0;
  const health = await bookingMembershipSnapshotHealth({
    read: (key) => published.store.get(key),
    readMany: (keys) => published.store.getMany(keys),
    now: published.store.now,
  });
  assert.equal(health.schema, BOOKING_MEMBERSHIP_SNAPSHOT_SCHEMA);
  assert.equal(health.generation, GEN_A);
  assert.equal(health.current, true);
  assert.equal(health.complete, true);
  assert.equal(health.scopeDigest, "d".repeat(64));
  assert.equal(health.catalogSequenceCount, 2);
  assert.equal(health.selectedSequenceCount, 2);
  assert.equal(health.latestAttemptStatus, "failure");
  assert.equal(health.latestAttemptError, "membership_refresh_locked");
  assert.deepEqual(
    published.store.operations.filter(([kind]) => kind === "getMany"),
    [["getMany", ...manifest.shards.map(({ key }) => key)]],
  );
  assert.equal(
    published.store.operations.some(([kind, key]) =>
      kind === "get"
      && manifest.shards.some((descriptor) => descriptor.key === key)),
    false,
  );
});

test("snapshot health fails closed on a missing or corrupt shard", async () => {
  for (const damage of ["missing", "corrupt"]) {
    const published = await publish();
    const current =
      published.store.raw(BOOKING_MEMBERSHIP_KEYS.current);
    const manifest = published.store.raw(current.manifestKey);
    const shardKey = manifest.shards[0].key;
    if (damage === "missing") {
      published.store.delete(shardKey);
    } else {
      published.store.raw(shardKey).leads[0].to_use_email =
        "tampered@example.com";
    }
    const health = await bookingMembershipSnapshotHealth({
      read: (key) => published.store.get(key),
      readMany: (keys) => published.store.getMany(keys),
      now: published.store.now,
    });
    assert.equal(health.current, false, damage);
    assert.equal(health.complete, false, damage);
  }
});

test("snapshot health fails closed when the batch reader is absent or truncated", async () => {
  const published = await publish();
  const options = {
    read: (key) => published.store.get(key),
    now: published.store.now,
  };
  const missingReader = await bookingMembershipSnapshotHealth(options);
  assert.equal(missingReader.current, false);
  assert.equal(missingReader.complete, false);

  const truncated = await bookingMembershipSnapshotHealth({
    ...options,
    readMany: async (keys) =>
      (await published.store.getMany(keys)).slice(0, -1),
  });
  assert.equal(truncated.current, false);
  assert.equal(truncated.complete, false);
});

test("cron refresh is separated before sweep and remains below Vercel's project cap", async () => {
  const config = JSON.parse(
    await readFile(
      new URL("../vercel.json", import.meta.url),
      "utf8",
    ),
  );
  const refresh = config.crons.find(({ path }) =>
    path === "/api/seq/booking-membership-refresh");
  const sweep = config.crons.find(({ path }) =>
    path === "/api/seq/booking-sweep");
  const rearm = config.crons.find(({ path }) =>
    path === "/api/seq/rearm-pause-canary");
  assert.equal(refresh.schedule, "7,37 * * * *");
  assert.equal(rearm.schedule, "12,42 * * * *");
  assert.equal(sweep.schedule, "52 * * * *");
  const refreshMinutes = refresh.schedule
    .split(" ")[0]
    .split(",")
    .map(Number)
    .sort((left, right) => left - right);
  const refreshIntervals = refreshMinutes.map((minute, index) => {
    const next = refreshMinutes[(index + 1) % refreshMinutes.length];
    return (next > minute ? next : next + 60) - minute;
  });
  assert.ok(
    Math.max(...refreshIntervals) * 60 * 1000
      + BOOKING_MEMBERSHIP_BUILD_BUDGET_MS
      < BOOKING_MEMBERSHIP_MAX_AGE_MS,
    "refresh cadence plus the full build budget needs material freshness margin",
  );
  const sweepMinute = Number(sweep.schedule.split(" ")[0]);
  const latestRefreshBeforeSweep = Math.max(
    ...refreshMinutes.filter((minute) => minute < sweepMinute),
  );
  assert.ok(
    (sweepMinute - latestRefreshBeforeSweep) * 60 * 1000
      > BOOKING_MEMBERSHIP_BUILD_BUDGET_MS,
    "sweep starts only after the refresh build budget has elapsed",
  );
  assert.ok(config.crons.length <= 100);
});
