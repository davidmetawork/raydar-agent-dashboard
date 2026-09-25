process.env.PARAFORM_COOKIE ||= "Fe26.2**test-cookie";
process.env.CALENDLY_API_TOKEN ||= "test-calendly-token";

import test from "node:test";
import assert from "node:assert/strict";

import {
  discoverBookingStopSequences,
  recordSuccessfulSweep,
  runBookingSweep,
} from "../api/seq/_lib/booking-stop.mjs";
import {
  bookingMembershipCurrentProvablyStale,
} from "../api/seq/_lib/booking-membership-snapshot.mjs";
import {
  BOOKING_MEMBERSHIP_BUILD_BUDGET_MS,
  BOOKING_MEMBERSHIP_CURRENT_SCHEMA,
  BOOKING_MEMBERSHIP_MAX_AGE_MS,
  BOOKING_MEMBERSHIP_SNAPSHOT_SCHEMA,
  BOOKING_STOP_PRECHECK_MAX_WAIT_MS,
  BOOKING_STOP_PRECHECK_POLL_MS,
} from "../api/seq/_lib/booking-stop-contract.mjs";
import {
  bookingStopCatalogNameSha256,
  parseBookingStopColdExclusions,
} from "../api/seq/_lib/booking-stop-policy.mjs";

const NOW = Date.parse("2026-09-25T06:08:00.000Z");
const MIN = 60 * 1000;
const LINK = { steps: [{ subject: "", body: "https://book.raydar.xyz/agent" }] };
const NO_LINK = { steps: [{ subject: "", body: "Plain copy" }] };

const pointer = (ageMs, overrides = {}) => ({
  schema: BOOKING_MEMBERSHIP_CURRENT_SCHEMA,
  snapshotSchema: BOOKING_MEMBERSHIP_SNAPSHOT_SCHEMA,
  complete: true,
  generation: "a".repeat(32),
  oldestFetchedAt: new Date(NOW - ageMs).toISOString(),
  ...overrides,
});

// Every downstream leg throws if reached; `calls` records which ones were.
function sweepHarness(precheckValues) {
  const calls = [];
  const queue = [...precheckValues];
  return {
    calls,
    run: () => runBookingSweep({
      apply: true,
      now: NOW,
      membershipCurrentPrecheckLoader: async () => {
        calls.push("precheck");
        const next = queue.length > 1 ? queue.shift() : queue[0];
        if (next instanceof Error) throw next;
        return structuredClone(next);
      },
      // No refresh lock (an unreadable lock waits; see the review tests).
      membershipLockPrecheckLoader: async () => null,
      sequenceScopeLoader: async () => {
        calls.push("scope");
        throw new Error("scope unavailable in this test");
      },
      membershipSnapshotLoader: async () => {
        calls.push("snapshot");
        throw new Error("must not run");
      },
      membershipCurrentLoader: async () => {
        calls.push("current");
        throw new Error("must not run");
      },
      calendlyIndexLoader: async () => {
        calls.push("calendly");
        throw new Error("must not run");
      },
      decisionApplier: async () => {
        calls.push("pause");
        throw new Error("must not run");
      },
    }),
  };
}

test("provably-stale pointer: strictly past the same 60-minute limit, well-formed only", () => {
  assert.equal(bookingMembershipCurrentProvablyStale(pointer(BOOKING_MEMBERSHIP_MAX_AGE_MS + 1), NOW), true);
  assert.equal(bookingMembershipCurrentProvablyStale(pointer(BOOKING_MEMBERSHIP_MAX_AGE_MS), NOW), false);
  assert.equal(bookingMembershipCurrentProvablyStale(pointer(MIN), NOW), false);
  assert.equal(bookingMembershipCurrentProvablyStale(pointer(-MIN), NOW), false, "future-dated");
  for (const malformed of [
    null,
    "string",
    [],
    pointer(2 * BOOKING_MEMBERSHIP_MAX_AGE_MS, { schema: "other" }),
    pointer(2 * BOOKING_MEMBERSHIP_MAX_AGE_MS, { snapshotSchema: "other" }),
    pointer(2 * BOOKING_MEMBERSHIP_MAX_AGE_MS, { complete: false }),
    pointer(2 * BOOKING_MEMBERSHIP_MAX_AGE_MS, { generation: "short" }),
    pointer(2 * BOOKING_MEMBERSHIP_MAX_AGE_MS, { oldestFetchedAt: "not a date" }),
  ]) {
    assert.equal(bookingMembershipCurrentProvablyStale(malformed, NOW), false, JSON.stringify(malformed));
  }
  assert.equal(bookingMembershipCurrentProvablyStale(pointer(2 * BOOKING_MEMBERSHIP_MAX_AGE_MS), Number.NaN), false);
});

test("a stale pointer, still stale on re-read, exits before any Paraform read or mutation", async () => {
  const h = sweepHarness([pointer(BOOKING_MEMBERSHIP_MAX_AGE_MS + 1)]);
  const result = await h.run();
  assert.deepEqual(h.calls, ["precheck", "precheck"]);
  assert.equal(result.ok, false);
  assert.equal(result.error, "membership_snapshot_unavailable");
  assert.equal(result.membershipSnapshotError, "snapshot_stale_before_scope");
  assert.equal(result.membershipSnapshotPrecheck, true);
  assert.equal(result.paused, 0);
  assert.deepEqual(result.decisions, []);
});

test("precheck race: a fresh generation on the re-read takes the normal path", async () => {
  const h = sweepHarness([pointer(BOOKING_MEMBERSHIP_MAX_AGE_MS + MIN), pointer(MIN)]);
  const result = await h.run();
  assert.deepEqual(h.calls, ["precheck", "precheck", "scope"]);
  assert.equal(result.membershipSnapshotError, "live_scope_unavailable");
  assert.equal(result.membershipSnapshotPrecheck, false);
});

test("missing, malformed, exactly-60-minute, fresh pointers and KV errors keep today's path", async () => {
  for (const [value, calls] of [
    // Absent or unreadable: retried ONCE (strict read), then the normal path.
    [null, ["precheck", "precheck", "scope"]],
    [{ schema: "x", oldestFetchedAt: "2000-01-01T00:00:00Z" }, ["precheck", "scope"]],
    [pointer(BOOKING_MEMBERSHIP_MAX_AGE_MS), ["precheck", "scope"]],
    [pointer(MIN), ["precheck", "scope"]],
    [new Error("kv down"), ["precheck", "precheck", "scope"]],
  ]) {
    const h = sweepHarness([value]);
    const result = await h.run();
    assert.deepEqual(h.calls, calls, String(value?.message || JSON.stringify(value)));
    assert.equal(result.membershipSnapshotError, "live_scope_unavailable");
    assert.equal(result.membershipSnapshotPrecheck, false);
    assert.equal(result.paused, 0);
  }
});

test("dangerClassSequences counts enabled, unnamed, not-excluded no-link rows and is recorded unbound", async () => {
  const rows = [
    { id: "link0001", name: "Sourcing - Counsel", enabled: true },
    { id: "plain001", name: "Plain outreach", enabled: true },
    { id: "plain002", name: "Plain outreach two", enabled: true },
    { id: "offplain", name: "Disabled plain", enabled: false },
    { id: "named001", name: "No Show - Agent Call - Role", enabled: true },
    { id: "cold0001", name: "Cold one", enabled: true },
  ];
  const definitions = {
    link0001: LINK, plain001: NO_LINK, plain002: NO_LINK, offplain: NO_LINK, named001: NO_LINK,
  };
  const load = (policy) => discoverBookingStopSequences({
    listSequences: async () => structuredClone(rows),
    readCampaign: async (id) => structuredClone(definitions[id] ?? LINK),
    minimumCatalogCount: 1,
    sequenceKeys: ["No Show - Agent Call"],
    coldExclusionPolicy: policy,
    classificationRecorder: async () => {},
  });
  const v2 = await load(parseBookingStopColdExclusions(""));
  // cold0001 is read as link-bearing without a policy, so it is not counted.
  assert.equal(v2.dangerClassSequences, 2);
  const policy = parseBookingStopColdExclusions(JSON.stringify({
    schema: "raydar-booking-stop-cold-exclusions-v1",
    campaigns: [{
      id: "cold0001",
      catalogNameSha256: bookingStopCatalogNameSha256("Cold one"),
      definitionSha256: "d".repeat(64),
    }],
  }));
  const v3 = await load(policy);
  assert.equal(v3.dangerClassSequences, 2);


  const sweep = {
    ok: true,
    calendlyTruncated: false,
    pauseErrors: [],
    scopeSchema: v2.schema,
    scopeDigest: v2.scopeDigest,
    scopeCatalogFloor: 1,
    sequenceCatalogCount: v2.catalogSequences,
    sequenceScopeScanned: v2.scannedSequences,
    linkScopeComplete: true,
    enabledLinkSequences: v2.enabledLinkSequences,
    coveredEnabledLinkSequences: v2.coveredEnabledLinkSequences,
    bookingStopPolicy: null,
    membershipSnapshotSchema: BOOKING_MEMBERSHIP_SNAPSHOT_SCHEMA,
    membershipSnapshotGeneration: "a".repeat(32),
    membershipSnapshotManifestHash: "e".repeat(64),
    membershipSnapshotAgeMs: MIN,
    membershipSnapshotOldestFetchedAt: new Date(NOW - MIN).toISOString(),
    membershipSnapshotCurrent: true,
    dangerClassSequences: v2.dangerClassSequences,
  };
  // recordSuccessfulSweep writes through KV; without KV configured the durable
  // write fails, so only prove the validation accepts the extra field.
  await assert.rejects(() => recordSuccessfulSweep(sweep, NOW), {
    code: "KV_CORRECTNESS_WRITE_FAILED",
  });
});

// ─── Review regression: a refresh in flight can publish a generation this
// pass would accept (its builtAt is its membership-fetch time, BEFORE the
// pointer write), so a provably stale pointer waits for it instead of exiting.

function waitingHarness({ pointers, lock, clockStart = NOW }) {
  const calls = [];
  const queue = [...pointers];
  let clockMs = clockStart;
  const scopeArgs = [];
  return {
    calls,
    scopeArgs,
    run: () => runBookingSweep({
      apply: true,
      now: NOW,
      clock: () => clockMs,
      membershipCurrentPrecheckLoader: async () => {
        calls.push("precheck");
        const next = queue.length > 1 ? queue.shift() : queue[0];
        return structuredClone(next);
      },
      membershipLockPrecheckLoader: async () => {
        calls.push("lock");
        return structuredClone(lock);
      },
      precheckSleep: async (ms) => {
        calls.push("sleep");
        clockMs += ms;
      },
      sequenceScopeLoader: async (args) => {
        calls.push("scope");
        scopeArgs.push(args);
        throw new Error("scope unavailable in this test");
      },
      membershipSnapshotLoader: async () => { throw new Error("must not run"); },
      membershipCurrentLoader: async () => { throw new Error("must not run"); },
      calendlyIndexLoader: async () => { throw new Error("must not run"); },
      decisionApplier: async () => { throw new Error("must not run"); },
    }),
  };
}

const lockAt = (ms) => ({
  schema: "raydar-booking-membership-lock-v1",
  token: "t".repeat(32),
  at: new Date(ms).toISOString(),
});

test("review: a stale pointer with a refresh in flight waits for its publish and takes the normal path", async () => {
  const stale = pointer(2 * BOOKING_MEMBERSHIP_MAX_AGE_MS);
  const fresh = pointer(30 * 1000, { scope: { digest: "c".repeat(64) } });
  const h = waitingHarness({
    pointers: [stale, stale, stale, stale, fresh],
    lock: lockAt(NOW - 60 * 1000),
  });
  const result = await h.run();
  assert.deepEqual(h.calls, [
    "precheck", "lock", "precheck", "sleep", "precheck", "sleep", "precheck", "sleep", "precheck", "scope",
  ]);
  assert.equal(result.membershipSnapshotPrecheck, false);
  assert.equal(result.membershipSnapshotError, "live_scope_unavailable");
  // The sweep serves only the answers of the digest it is about to bind.
  assert.equal(h.scopeArgs[0].definitionSource, "published");
  assert.equal(h.scopeArgs[0].definitionAnswersDigest, "c".repeat(64));
});

test("review: the in-flight wait is bounded by the pre-cache scope-leg time, then the pass skips", async () => {
  const stale = pointer(2 * BOOKING_MEMBERSHIP_MAX_AGE_MS);
  const h = waitingHarness({ pointers: [stale], lock: lockAt(NOW - 10 * 1000) });
  const result = await h.run();
  const sleeps = h.calls.filter((call) => call === "sleep").length;
  assert.equal(sleeps, Math.floor(BOOKING_STOP_PRECHECK_MAX_WAIT_MS / BOOKING_STOP_PRECHECK_POLL_MS));
  assert.equal(h.calls.includes("scope"), false);
  assert.equal(result.membershipSnapshotError, "snapshot_stale_before_scope");
  assert.equal(result.membershipSnapshotPrecheck, true);
});

test("review: no wait for a refresh that started after this pass, or one long past its build budget", async () => {
  const stale = pointer(2 * BOOKING_MEMBERSHIP_MAX_AGE_MS);
  for (const lock of [
    lockAt(NOW + 1000), // its builtAt will be after `now`: the loader rejects it
    lockAt(NOW - BOOKING_MEMBERSHIP_BUILD_BUDGET_MS - 10 * 60 * 1000),
    { schema: "other", at: new Date(NOW).toISOString() },
    null,
  ]) {
    const h = waitingHarness({ pointers: [stale], lock });
    const result = await h.run();
    assert.deepEqual(h.calls, ["precheck", "lock", "precheck"], JSON.stringify(lock));
    assert.equal(result.membershipSnapshotError, "snapshot_stale_before_scope");
  }
});

test("review: a fresh pointer passes its digest to the scope load; no pointer passes none", async () => {
  const withDigest = waitingHarness({
    pointers: [pointer(MIN, { scope: { digest: "b".repeat(64) } })],
    lock: null,
  });
  await withDigest.run();
  assert.deepEqual(withDigest.calls, ["precheck", "scope"]);
  assert.equal(withDigest.scopeArgs[0].definitionAnswersDigest, "b".repeat(64));
  const none = waitingHarness({ pointers: [null], lock: null });
  await none.run();
  assert.equal(none.scopeArgs[0].definitionAnswersDigest, null);
  assert.equal(none.scopeArgs[0].definitionSource, "published");
});
