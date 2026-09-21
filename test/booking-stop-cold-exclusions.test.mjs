process.env.PARAFORM_COOKIE ||= "test-booking-policy-cookie";

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  K,
  applyDecisions,
  discoverBookingStopSequences,
  pauseForBooking,
  bookingLeadIndexUsable,
  sweepStaleness,
} from "../api/seq/_lib/booking-stop.mjs";
import {
  bookingStopCatalogNameSha256,
  bookingStopPolicyHealth,
  parseBookingStopColdExclusions,
} from "../api/seq/_lib/booking-stop-policy.mjs";
import {
  BOOKING_MEMBERSHIP_CURRENT_SCHEMA,
  BOOKING_MEMBERSHIP_SNAPSHOT_SCHEMA,
  BOOKING_STOP_ATTEMPT_SCHEMA,
  BOOKING_STOP_LEAD_INDEX_SCHEMA,
  BOOKING_STOP_SCOPE_SCHEMA,
  BOOKING_STOP_SCOPE_SCHEMA_V3,
} from "../api/seq/_lib/booking-stop-contract.mjs";
import {
  BOOKING_MEMBERSHIP_KEYS,
  bookingMembershipHash,
  bookingMembershipStoredScopeBindingValid,
  runBookingMembershipRefresh,
} from "../api/seq/_lib/booking-membership-snapshot.mjs";
import {
  loadCurrentMembershipSnapshot,
} from "../api/seq/_lib/pause-canary-rearm.mjs";

const policyJson = (campaigns) => JSON.stringify({
  schema: "raydar-booking-stop-cold-exclusions-v1",
  campaigns: [...campaigns].sort((left, right) => left.id.localeCompare(right.id)),
});
const entry = (id, name, definitionSha256 = "d".repeat(64)) => ({
  id,
  catalogNameSha256: bookingStopCatalogNameSha256(name),
  definitionSha256,
});
const linkCampaign = { steps: [{ subject: "", body: "https://book.raydar.xyz/agent" }] };

test("absent policy preserves v2 behavior and strict malformed policy fails before provider reads", async () => {
  const inactive = parseBookingStopColdExclusions("");
  assert.equal(inactive.active, false);
  assert.equal(inactive.scopeSchema, BOOKING_STOP_SCOPE_SCHEMA);
  const definitionA = parseBookingStopColdExclusions(policyJson([
    entry("cold0001", "A", "a".repeat(64)),
  ]));
  const definitionB = parseBookingStopColdExclusions(policyJson([
    entry("cold0001", "A", "b".repeat(64)),
  ]));
  assert.notEqual(definitionA.policyDigest, definitionB.policyDigest);

  for (const raw of [
    "{",
    JSON.stringify({ schema: "wrong", campaigns: [] }),
    JSON.stringify({ schema: "raydar-booking-stop-cold-exclusions-v1", campaigns: [], extra: true }),
    JSON.stringify({
      schema: "raydar-booking-stop-cold-exclusions-v1",
      campaigns: [{
        id: "cold0001",
        catalogNameSha256: bookingStopCatalogNameSha256("A"),
      }],
    }),
    policyJson([entry("cold0001", "A", "A".repeat(64))]),
    JSON.stringify({
      schema: "raydar-booking-stop-cold-exclusions-v1",
      campaigns: [entry("cold0002", "B"), entry("cold0001", "A")],
    }),
    policyJson([entry("cold0001", "A"), entry("cold0001", "A")]),
  ]) {
    let providerReads = 0;
    await assert.rejects(async () => discoverBookingStopSequences({
      coldExclusionPolicy: parseBookingStopColdExclusions(raw),
      listSequences: async () => { providerReads++; return []; },
      readCampaign: async () => { providerReads++; return linkCampaign; },
      minimumCatalogCount: 1,
    }), { code: "BOOKING_STOP_COLD_EXCLUSIONS_INVALID" });
    assert.equal(providerReads, 0);
  }
});

test("81 reviewed cold campaigns skip definition reads while mixed and named cohorts remain protected", async () => {
  const cold = Array.from({ length: 81 }, (_, index) => {
    const id = `cold${String(index + 1).padStart(4, "0")}`;
    const name = `Reviewed cold campaign ${index + 1}`;
    return { id, name, enabled: true };
  });
  const extra = [
    { id: "auto0001", name: "Automated followup", enabled: true },
    { id: "unknown1", name: "Unlisted link outreach", enabled: true },
    { id: "canary01", name: "No Show - Agent Call - Canary", enabled: false },
  ];
  const policy = parseBookingStopColdExclusions(policyJson(
    cold.map(({ id, name }) => entry(id, name)),
  ));
  const definitionReads = [];
  const receipts = [];
  const scope = await discoverBookingStopSequences({
    coldExclusionPolicy: policy,
    sequenceKeys: ["No Show - Agent Call"],
    listSequences: async () => [...cold, ...extra],
    readCampaign: async (id) => {
      definitionReads.push(id);
      return id === "canary01" ? { steps: [] } : linkCampaign;
    },
    minimumCatalogCount: 1,
    concurrency: 2,
    clock: () => Date.parse("2026-09-21T18:00:00.000Z"),
    classificationRecorder: async (receipt) => {
      assert.equal(definitionReads.length, 0);
      receipts.push(receipt);
    },
  });
  assert.equal(scope.schema, BOOKING_STOP_SCOPE_SCHEMA_V3);
  assert.equal(scope.bookingStopPolicy.policyDigest, policy.policyDigest);
  assert.equal(scope.catalogSequences, 84);
  assert.equal(scope.scannedSequences, 84);
  assert.equal(scope.definitionSequencesRead, 3);
  assert.equal(scope.excludedColdSequences, 81);
  assert.equal(scope.enabledLinkSequences, 83);
  assert.equal(scope.coveredEnabledLinkSequences, 2);
  assert.equal(scope.excludedColdEnabledLinkSequences, 81);
  assert.equal(scope.bookingStopPolicy.nameDriftProtectedSequences, 0);
  assert.equal(scope.bookingStopPolicy.missingCatalogEntries, 0);
  assert.deepEqual(receipts, [{
    schema: "raydar-booking-stop-classification-receipt-v1",
    state: "classification_only",
    at: "2026-09-21T18:00:00.000Z",
    policyDigest: policy.policyDigest,
    catalogSequences: 84,
    excludedColdSequences: 81,
    plannedDefinitionReads: 3,
    plannedProtectedNamedSequences: 1,
    nameDriftProtectedSequences: 0,
    missingCatalogEntries: 0,
  }]);
  assert.deepEqual(definitionReads.sort(), ["auto0001", "canary01", "unknown1"]);
  assert.deepEqual(scope.sequences.map(({ id }) => id).sort(), [
    "auto0001", "canary01", "unknown1",
  ]);
});

test("classification receipt failure cannot change scope protection", async () => {
  const cold = { id: "cold0001", name: "Reviewed cold campaign", enabled: true };
  const protectedSequence = { id: "protect01", name: "Automated followup", enabled: true };
  const policy = parseBookingStopColdExclusions(policyJson([entry(cold.id, cold.name)]));
  const reads = [];
  const scope = await discoverBookingStopSequences({
    coldExclusionPolicy: policy,
    sequenceKeys: [],
    listSequences: async () => [cold, protectedSequence],
    readCampaign: async (id) => { reads.push(id); return linkCampaign; },
    classificationRecorder: async () => { throw new Error("KV unavailable"); },
    minimumCatalogCount: 1,
  });
  assert.deepEqual(reads, [protectedSequence.id]);
  assert.deepEqual(scope.sequences.map(({ id }) => id), [protectedSequence.id]);
});

test("name drift, custom family matches, and unlisted campaigns stay protected", async () => {
  const rows = [
    { id: "drift001", name: "Renamed cold campaign", enabled: true },
    { id: "custom01", name: "Custom protected family - Role", enabled: false },
    { id: "default1", name: "No Show - Agent Call - Canary", enabled: false },
    { id: "unknown1", name: "New unreviewed campaign", enabled: true },
  ];
  const policy = parseBookingStopColdExclusions(policyJson([
    entry("custom01", rows[1].name),
    entry("default1", rows[2].name),
    entry("drift001", "Old cold campaign name"),
    entry("missing1", "Deleted campaign"),
  ]));
  const reads = [];
  const scope = await discoverBookingStopSequences({
    coldExclusionPolicy: policy,
    sequenceKeys: ["Custom protected family"],
    listSequences: async () => rows,
    readCampaign: async (id) => {
      reads.push(id);
      return ["custom01", "default1"].includes(id)
        ? { steps: [] }
        : linkCampaign;
    },
    minimumCatalogCount: 1,
  });
  assert.equal(scope.excludedColdSequences, 0);
  assert.equal(scope.bookingStopPolicy.nameDriftProtectedSequences, 1);
  assert.equal(scope.bookingStopPolicy.missingCatalogEntries, 1);
  assert.deepEqual(reads.sort(), rows.map(({ id }) => id).sort());
  assert.deepEqual(scope.sequences.map(({ id }) => id).sort(), rows.map(({ id }) => id).sort());
});

test("inactive v2 keeps the historical custom-key override semantics", async () => {
  const rows = [
    { id: "custom01", name: "Custom protected family - Role", enabled: false },
    { id: "default1", name: "No Show - Agent Call - Canary", enabled: false },
  ];
  const scope = await discoverBookingStopSequences({
    coldExclusionPolicy: parseBookingStopColdExclusions(""),
    sequenceKeys: ["Custom protected family"],
    listSequences: async () => rows,
    readCampaign: async () => ({ steps: [] }),
    minimumCatalogCount: 1,
  });
  assert.equal(scope.schema, BOOKING_STOP_SCOPE_SCHEMA);
  assert.deepEqual(scope.sequences.map(({ id }) => id), ["custom01"]);
});

test("v3 membership publication reads only the protected cohort and seals the policy binding", async () => {
  const cold = { id: "cold0001", name: "Reviewed cold campaign", enabled: true };
  const protectedSequence = {
    id: "protect01",
    name: "No Show - Agent Call - Canary",
    enabled: true,
  };
  const policy = parseBookingStopColdExclusions(policyJson([entry(cold.id, cold.name)]));
  const scope = await discoverBookingStopSequences({
    coldExclusionPolicy: policy,
    sequenceKeys: [],
    listSequences: async () => [cold, protectedSequence],
    readCampaign: async () => linkCampaign,
    minimumCatalogCount: 1,
  });
  const values = new Map();
  const membershipReads = [];
  const store = {
    get: async (key) => structuredClone(values.get(key) ?? null),
    getMany: async (keys) => keys.map((key) =>
      structuredClone(values.get(key) ?? null)),
    set: async (key, value) => { values.set(key, structuredClone(value)); return "OK"; },
    setNx: async (key, value) => {
      if (values.has(key)) return null;
      values.set(key, structuredClone(value));
      return "OK";
    },
    atomicPublish: async ({ current, leadIndex }) => {
      values.set(BOOKING_MEMBERSHIP_KEYS.current, structuredClone(current));
      values.set(BOOKING_MEMBERSHIP_KEYS.leadIndex, structuredClone(leadIndex));
      return 1;
    },
  };
  const now = Date.parse("2026-09-21T18:00:00.000Z");
  const result = await runBookingMembershipRefresh({
    scopeLoader: async () => structuredClone(scope),
    membershipLoader: async (id) => {
      membershipReads.push(id);
      const leads = [{
        ccu_id: "ccu-canary",
        cu_id: "cu-canary",
        to_use_email: "canary@example.invalid",
        user_emails: [],
        created_at: "2026-09-20T18:00:00.000Z",
        is_paused: true,
        is_archived: false,
      }];
      return {
        complete: true,
        leads,
        totalCount: 1,
        unique: 1,
        shortfall: 0,
      };
    },
    store,
    clock: () => now,
    generationFactory: () => "a".repeat(32),
    shardTokenFactory: () => "b".repeat(24),
  });
  assert.equal(result.ok, true);
  assert.deepEqual(membershipReads, [protectedSequence.id]);
  const current = values.get(BOOKING_MEMBERSHIP_KEYS.current);
  const index = values.get(BOOKING_MEMBERSHIP_KEYS.leadIndex);
  assert.equal(bookingMembershipStoredScopeBindingValid(current.scope), true);
  assert.equal(current.scope.bookingStopPolicy.policyDigest, policy.policyDigest);
  assert.equal(index.scopePolicyDigest, policy.policyDigest);
  const canarySnapshot = await loadCurrentMembershipSnapshot({
    read: (key) => store.get(key),
    readMany: (keys) => store.getMany(keys),
    now,
  });
  assert.equal(canarySnapshot.ok, true);
  assert.equal(canarySnapshot.complete, true);
  assert.equal(canarySnapshot.perSequence[0].seq.id, protectedSequence.id);
  assert.equal(canarySnapshot.perSequence[0].leads[0].ccu_id, "ccu-canary");
});

test("latest attempt health carries only the redacted policy counters when available", async () => {
  const policy = parseBookingStopColdExclusions(policyJson([
    entry("cold0001", "Reviewed cold campaign"),
  ]));
  const health = bookingStopPolicyHealth(policy, {
    excludedSequences: 1,
    excludedEnabledLinkSequences: 1,
  });
  const now = Date.parse("2026-09-21T18:00:00.000Z");
  const status = await sweepStaleness(now, {
    coldExclusionPolicy: policy,
    read: async (key) => {
      if (key === K.lastAttempt) return {
        schema: BOOKING_STOP_ATTEMPT_SCHEMA,
        at: new Date(now - 1000).toISOString(),
        status: "failure",
        error: "membership_snapshot_unavailable",
        bookingStopPolicy: health,
      };
      if (key === K.scopeClassification) return {
        schema: "raydar-booking-stop-classification-receipt-v1",
        state: "classification_only",
        at: new Date(now - 2000).toISOString(),
        policyDigest: policy.policyDigest,
        catalogSequences: 2,
        excludedColdSequences: 1,
        plannedDefinitionReads: 1,
        plannedProtectedNamedSequences: 0,
        nameDriftProtectedSequences: 0,
        missingCatalogEntries: 0,
      };
      return null;
    },
    snapshotHealthLoader: async () => ({}),
  });
  assert.deepEqual(status.latestAttemptBookingStopPolicy, health);
  assert.equal(status.latestScopeClassification.state, "classification_only");
  assert.equal(status.latestScopeClassification.current, true);
  assert.equal(status.latestScopeClassification.excludedColdSequences, 1);
  assert.equal(JSON.stringify(status).includes("cold0001"), false);
});

test("last successful v3 link scope is false when current policy digest changes", async () => {
  const policyA = parseBookingStopColdExclusions(policyJson([
    entry("cold0001", "Reviewed cold campaign", "a".repeat(64)),
  ]));
  const policyB = parseBookingStopColdExclusions(policyJson([
    entry("cold0001", "Reviewed cold campaign", "b".repeat(64)),
  ]));
  const now = Date.parse("2026-09-21T18:00:00.000Z");
  const generation = "a".repeat(32);
  const manifestHash = "b".repeat(64);
  const scopeDigest = "c".repeat(64);
  const leadIndex = {
    schema: BOOKING_STOP_LEAD_INDEX_SCHEMA,
    snapshotSchema: BOOKING_MEMBERSHIP_SNAPSHOT_SCHEMA,
    generation,
    manifestHash,
    scopeSchema: BOOKING_STOP_SCOPE_SCHEMA_V3,
    scopeDigest,
    scopePolicyDigest: policyB.policyDigest,
    builtAt: new Date(now - 1000).toISOString(),
    byEmail: {},
  };
  const values = new Map([
    [K.lastSweep, {
      at: new Date(now - 2000).toISOString(),
      scopeSchema: BOOKING_STOP_SCOPE_SCHEMA_V3,
      scopeDigest,
      bookingStopPolicy: bookingStopPolicyHealth(policyA, {
        excludedSequences: 1,
        excludedEnabledLinkSequences: 1,
      }),
      linkScopeComplete: true,
      membershipSnapshotSchema: BOOKING_MEMBERSHIP_SNAPSHOT_SCHEMA,
      membershipSnapshotGeneration: generation,
      membershipSnapshotManifestHash: manifestHash,
    }],
    [K.lastAttempt, {
      schema: BOOKING_STOP_ATTEMPT_SCHEMA,
      at: new Date(now - 1000).toISOString(),
      status: "success",
      error: null,
      scopeSchema: BOOKING_STOP_SCOPE_SCHEMA_V3,
      scopeDigest,
      membershipSnapshotGeneration: generation,
    }],
    [K.leadIndex, leadIndex],
  ]);
  const status = await sweepStaleness(now, {
    coldExclusionPolicy: policyB,
    read: async (key) => structuredClone(values.get(key) ?? null),
    snapshotHealthLoader: async () => ({
      schema: BOOKING_MEMBERSHIP_SNAPSHOT_SCHEMA,
      generation,
      manifestHash,
      leadIndexHash: bookingMembershipHash(leadIndex),
      current: true,
      complete: true,
      oldestFetchedAt: new Date(now - 1000).toISOString(),
      ageMs: 1000,
      scopeSchema: BOOKING_STOP_SCOPE_SCHEMA_V3,
      scopeDigest,
      catalogSequenceCount: 2,
      selectedSequenceCount: 1,
    }),
  });
  assert.equal(status.bookingStopPolicyCurrent, false);
  assert.equal(status.linkScopeComplete, false);
  assert.equal(status.stale, true);
});

function v3Cache(policy, sequence) {
  const now = Date.parse("2026-09-21T18:00:00.000Z");
  const health = bookingStopPolicyHealth(policy, {
    excludedSequences: 1,
    excludedEnabledLinkSequences: 1,
  });
  const index = {
    schema: BOOKING_STOP_LEAD_INDEX_SCHEMA,
    snapshotSchema: BOOKING_MEMBERSHIP_SNAPSHOT_SCHEMA,
    generation: "a".repeat(32),
    manifestHash: "b".repeat(64),
    scopeSchema: BOOKING_STOP_SCOPE_SCHEMA_V3,
    scopeDigest: "c".repeat(64),
    scopePolicyDigest: policy.policyDigest,
    builtAt: new Date(now - 1000).toISOString(),
    byEmail: {
      "candidate@example.com": [{
        s: sequence.id, sn: sequence.name, ccu: "ccu-cold", cu: "cu-cold",
        n: "Candidate", t: "2026-09-20T18:00:00.000Z",
      }],
    },
  };
  const current = {
    schema: BOOKING_MEMBERSHIP_CURRENT_SCHEMA,
    snapshotSchema: BOOKING_MEMBERSHIP_SNAPSHOT_SCHEMA,
    complete: true,
    generation: index.generation,
    manifestHash: index.manifestHash,
    leadIndexHash: bookingMembershipHash(index),
    publishedAt: index.builtAt,
    oldestFetchedAt: index.builtAt,
    scope: {
      schema: BOOKING_STOP_SCOPE_SCHEMA_V3,
      digest: index.scopeDigest,
      catalogFloor: 1,
      catalogSequenceCount: 2,
      selectedSequenceIds: ["protected01"],
      selectedSequenceCount: 1,
      linkSequenceCount: 2,
      enabledLinkSequenceCount: 2,
      coveredEnabledLinkSequenceCount: 1,
      definitionSequenceReadCount: 1,
      excludedColdSequenceCount: 1,
      excludedColdEnabledLinkSequenceCount: 1,
      bookingStopPolicy: health,
    },
  };
  return { now, health, index, current };
}

test("activated v3 rejects old caches and webhook defense never pauses an excluded cold row", async () => {
  const sequence = { id: "cold0001", name: "Reviewed cold campaign", enabled: true };
  const policy = parseBookingStopColdExclusions(policyJson([entry(sequence.id, sequence.name)]));
  const { now, index, current } = v3Cache(policy, sequence);
  const oldIndex = {
    ...index,
    scopeSchema: BOOKING_STOP_SCOPE_SCHEMA,
  };
  delete oldIndex.scopePolicyDigest;
  const oldCurrent = {
    ...current,
    leadIndexHash: bookingMembershipHash(oldIndex),
    scope: {
      schema: BOOKING_STOP_SCOPE_SCHEMA,
      digest: oldIndex.scopeDigest,
    },
  };
  assert.equal(bookingLeadIndexUsable(oldIndex, oldCurrent, now, policy).usable, false);
  const partialPolicyCurrent = structuredClone(current);
  delete partialPolicyCurrent.scope.bookingStopPolicy.missingCatalogEntries;
  assert.equal(bookingLeadIndexUsable(index, partialPolicyCurrent, now, policy).usable, false);

  let applied = 0;
  const result = await pauseForBooking({
    email: "candidate@example.com",
    bookedAt: "2026-09-21T17:00:00.000Z",
    apply: true,
    now,
    coldExclusionPolicy: policy,
    leadIndexLoader: async () => index,
    membershipCurrentLoader: async () => current,
    deferredWriter: async () => { throw new Error("fresh v3 cache must not defer"); },
    decisionApplier: async () => { applied++; return { paused: 1, pauseErrors: [] }; },
  });
  assert.equal(result.deferred, false);
  assert.equal(result.decisions.length, 0);
  assert.equal(result.paused, 0);
  assert.equal(applied, 0);

  const originalFetch = globalThis.fetch;
  let providerCalls = 0;
  globalThis.fetch = async () => { providerCalls++; throw new Error("must not call provider"); };
  try {
    assert.deepEqual(await applyDecisions([{
      sequenceId: sequence.id,
      sequence: sequence.name,
      ccuId: "ccu-cold",
    }], { coldExclusionPolicy: policy, keys: [] }), {
      paused: 0, pausedCcuIds: [], pauseErrors: [], throttled: 0,
    });
  } finally { globalThis.fetch = originalFetch; }
  assert.equal(providerCalls, 0);
});

test("pre-enrollment booking gates remain source-identical and outside the exclusion policy", async () => {
  for (const [file, call] of [
    ["api/seq/preview.mjs", "bookedSet(matchedIds)"],
    ["api/seq/enroll.mjs", "bookedSet(preexisting)"],
    ["api/seq/release.mjs", "bookedSet(members.map((m) => m.id))"],
  ]) {
    const source = await readFile(new URL(`../${file}`, import.meta.url), "utf8");
    assert.ok(source.includes(call), `${file} must retain ${call}`);
    assert.doesNotMatch(source, /BOOKING_STOP_COLD_EXCLUSIONS|booking-stop-policy/u);
  }
});
