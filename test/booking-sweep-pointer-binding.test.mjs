process.env.PARAFORM_COOKIE ||= "Fe26.2**test-cookie";
process.env.CALENDLY_API_TOKEN ||= "test-calendly-token";

// PR 231 third review: the sweep's scope leg (which serves the published
// answers of a pointer's digest) and its snapshot leg (which binds to a
// pointer) must bind to ONE pointer read, and no single KV blip may change
// which answers the pass serves or discard positive stale evidence. Adapted
// from the round-two refuters (pointer race, KV throttle) plus the
// persistDefinitions merge-read case.
//
// Every Paraform and KV call in this file is an injected in-memory fake.
// Run under a no-network preload to prove it.
import test from "node:test";
import assert from "node:assert/strict";

import {
  bookingStopDefinitionCacheRevision,
  bookingStopScopeCatalog,
  createRefreshScopeLoader,
  discoverBookingStopSequences,
  runBookingSweep,
} from "../api/seq/_lib/booking-stop.mjs";
import {
  BOOKING_MEMBERSHIP_KEYS,
  bookingMembershipCanonicalJson,
  loadPublishedBookingMembershipSnapshot,
  runBookingMembershipRefresh,
} from "../api/seq/_lib/booking-membership-snapshot.mjs";
import {
  BOOKING_MEMBERSHIP_MAX_AGE_MS,
  BOOKING_STOP_DEFINITION_MAX_AGE_MS,
  BOOKING_STOP_DEFINITION_SWEEP_MAX_AGE_MS,
  BOOKING_STOP_PRECHECK_MAX_WAIT_MS,
  BOOKING_STOP_PRECHECK_POLL_MS,
} from "../api/seq/_lib/booking-stop-contract.mjs";
import {
  bookingStopCatalogNameSha256,
  parseBookingStopColdExclusions,
} from "../api/seq/_lib/booking-stop-policy.mjs";

const T0 = Date.parse("2026-09-25T06:01:00.000Z");
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const LINK = { steps: [{ subject: "", body: "https://book.raydar.xyz/agent" }] };
const NO_LINK = { steps: [{ subject: "", body: "Plain copy" }] };
const NUDGE = "No Show - Agent Call";
const NO_POLICY = parseBookingStopColdExclusions("");
const throttled = () =>
  Object.assign(new Error("PARAFORM_THROTTLED"), { code: "PARAFORM_THROTTLED" });

function clone(value) {
  return value == null ? value : structuredClone(value);
}

// plain001 is the one selection-deciding row: enabled, name-unmatched, no
// link. It is read live on every load; the other four may be served.
function defaultRows() {
  return [
    { id: "linked01", name: "Sourcing - Counsel", enabled: true },
    { id: "plain001", name: "Plain outreach", enabled: true },
    { id: "offplain", name: "Disabled plain", enabled: false },
    { id: "named001", name: `${NUDGE} - Role`, enabled: true },
    { id: "offlink1", name: "Disabled link", enabled: false },
  ];
}

function defaultDefinitions() {
  return {
    linked01: LINK,
    plain001: NO_LINK,
    offplain: NO_LINK,
    named001: NO_LINK,
    offlink1: LINK,
  };
}

function coldPolicy(rows) {
  return parseBookingStopColdExclusions(JSON.stringify({
    schema: "raydar-booking-stop-cold-exclusions-v1",
    campaigns: rows.map(({ id, name }) => ({
      id,
      catalogNameSha256: bookingStopCatalogNameSha256(name),
      definitionSha256: "d".repeat(64),
    })).sort((left, right) => (left.id < right.id ? -1 : 1)),
  }));
}

function harness({
  revision = "matcher-test-a",
  rows = defaultRows(),
  definitions = defaultDefinitions(),
  store = { doc: null },
  keys = [NUDGE],
  policy = NO_POLICY,
} = {}) {
  const state = {
    now: T0,
    rows,
    definitions,
    keys,
    policy,
    reads: [],
    attempts: [],
    lastRead: new Map(),
    catalogReads: 0,
    writes: 0,
    readerCalls: 0,
    failRead: null,
    failWrite: false,
    store,
    // Published answers documents, by scope digest (write-once per digest).
    answers: new Map(),
    answersReads: 0,
    answersWrites: 0,
    failAnswersWrite: false,
    failAnswersRead: null,
  };
  const options = (overrides = {}) => ({
    listSequences: async () => {
      state.catalogReads += 1;
      return clone(state.rows);
    },
    readCampaign: async (id) => {
      state.attempts.push(id);
      const failure = state.failRead?.(id);
      if (failure) throw failure;
      state.reads.push(id);
      state.lastRead.set(id, state.now);
      return clone(state.definitions[id]);
    },
    minimumCatalogCount: 1,
    concurrency: 1,
    sequenceKeys: state.keys,
    coldExclusionPolicy: state.policy,
    classificationRecorder: async () => {},
    clock: () => state.now,
    definitionCacheRevision: revision,
    definitionCacheReader: async () => {
      state.readerCalls += 1;
      return clone(state.store.doc);
    },
    definitionCacheWriter: async (doc) => {
      if (state.failWrite) throw new Error("kv write failed");
      state.writes += 1;
      state.store.doc = clone(doc);
    },
    definitionAnswersReader: async (digest) => {
      state.answersReads += 1;
      const failure = state.failAnswersRead?.(digest);
      if (failure) throw failure;
      return clone(state.answers.get(digest) ?? null);
    },
    definitionAnswersWriter: async (digest, doc) => {
      if (state.failAnswersWrite) throw new Error("kv write failed");
      state.answersWrites += 1;
      state.answers.set(digest, clone(doc));
    },
    ...overrides,
  });
  const load = (overrides = {}) =>
    discoverBookingStopSequences(options(overrides));
  const measure = async (fn) => {
    state.reads = [];
    state.attempts = [];
    const catalogBefore = state.catalogReads;
    const out = await fn();
    return {
      out,
      reads: [...state.reads].sort(),
      catalogReads: state.catalogReads - catalogBefore,
    };
  };
  // Reference: the same catalog and definitions read in full, no cache.
  const fullRead = (overrides = {}) => discoverBookingStopSequences(options({
    definitionCacheRevision: null,
    readCampaign: async (id) => clone(state.definitions[id]),
    listSequences: async () => clone(state.rows),
    ...overrides,
  }));
  // The sweep's scope load: serves only the published answers of `digest`.
  const sweep = (digest, overrides = {}) => load({
    definitionSource: "published",
    definitionAnswersDigest: digest,
    definitionMaxAgeMs: BOOKING_STOP_DEFINITION_SWEEP_MAX_AGE_MS,
    ...overrides,
  });
  return { state, load, measure, fullRead, options, sweep };
}

// Mirrors scopeBinding() in booking-membership-snapshot.mjs field for field.
const bindingOf = (scope) => ({
  schema: scope.schema,
  digest: scope.scopeDigest,
  catalogFloor: scope.catalogFloor,
  catalogSequenceCount: scope.catalogSequences,
  selectedSequenceIds: scope.sequences.map(({ id }) => id).sort(),
  linkSequenceCount: scope.linkSequences,
  enabledLinkSequenceCount: scope.enabledLinkSequences,
  coveredEnabledLinkSequenceCount: scope.coveredEnabledLinkSequences,
  definitionSequenceReadCount: scope.definitionSequencesRead ?? null,
  excludedColdSequenceCount: scope.excludedColdSequences ?? null,
  excludedColdEnabledLinkSequenceCount:
    scope.excludedColdEnabledLinkSequences ?? null,
  bookingStopPolicy: scope.bookingStopPolicy ?? null,
});

const selectedIds = (scope) => scope.sequences.map(({ id }) => id).sort();

function memoryStore() {
  const values = new Map();
  return {
    values,
    get: async (key) => clone(values.get(key) ?? null),
    set: async (key, value) => { values.set(key, clone(value)); return "OK"; },
    setNx: async (key, value) => {
      if (values.has(key)) return null;
      values.set(key, clone(value));
      return "OK";
    },
    atomicPublish: async ({ expectedCurrent, current, leadIndex }) => {
      const existing = values.get(BOOKING_MEMBERSHIP_KEYS.current) ?? null;
      if (bookingMembershipCanonicalJson(existing) !== bookingMembershipCanonicalJson(expectedCurrent)) return 0;
      values.set(BOOKING_MEMBERSHIP_KEYS.current, clone(current));
      values.set(BOOKING_MEMBERSHIP_KEYS.leadIndex, clone(leadIndex));
      return 1;
    },
  };
}

async function refreshOnce(h, store, {
  loaderOverrides = {},
  onMembership = null,
  rotor = true,
} = {}) {
  store.values.delete(BOOKING_MEMBERSHIP_KEYS.lock);
  h.state.reads = [];
  const catalogBefore = h.state.catalogReads;
  const refresh = createRefreshScopeLoader({
    loaderOptions: h.options(loaderOverrides),
    loader: rotor
      ? discoverBookingStopSequences
      : (options) => discoverBookingStopSequences({ ...options, definitionRotor: false }),
  });
  const result = await runBookingMembershipRefresh({
    scopeLoader: refresh.scopeLoader,
    membershipLoader: async () => {
      onMembership?.();
      return { complete: true, leads: [], totalCount: 0, unique: 0, shortfall: 0, apiCalls: 1 };
    },
    store,
    clock: () => h.state.now,
  });
  return {
    result,
    reads: [...h.state.reads].sort(),
    catalogReads: h.state.catalogReads - catalogBefore,
    telemetry: refresh.definitionCache(),
  };
}

const sweepAccepts = async (h, store, scope) => loadPublishedBookingMembershipSnapshot({
  scope,
  now: h.state.now,
  read: store.get,
  readMany: async (keys) => keys.map((key) => clone(store.values.get(key) ?? null)),
});

const publishedDigestOf = (store) =>
  store.values.get(BOOKING_MEMBERSHIP_KEYS.current).scope.digest;

const currentOf = (store) =>
  clone(store.values.get(BOOKING_MEMBERSHIP_KEYS.current) ?? null);
const STOP = Object.assign(new Error("STOP_AFTER_SNAPSHOT"), { code: "STOP_AFTER_SNAPSHOT" });

// Runs the real runBookingSweep up to and including its snapshot leg. The
// snapshot loader is the production one (loadPublishedBookingMembershipSnapshot)
// over the in-memory store, honouring the `pointer` the sweep hands it.
async function runSweep(h, store, {
  precheck = async () => currentOf(store),
  lock = async () => null,
  scopeHook = null,
  // false models the pre-cache sweep: no published answers are served, every
  // definition is read live.
  cacheOn = true,
  loaderOverrides = {},
} = {}) {
  const seen = { scopeCalls: [], snapshot: null, pointerArg: "not-called", sleeps: 0 };
  let result = null;
  const realNow = Date.now;
  Date.now = () => h.state.now; // the sweep's budget deadline uses Date.now
  try {
    result = await runBookingSweep({
      apply: false,
      now: h.state.now,
      clock: () => h.state.now,
      coldExclusionPolicy: NO_POLICY,
      membershipCurrentPrecheckLoader: precheck,
      membershipLockPrecheckLoader: lock,
      precheckSleep: async (ms) => { seen.sleeps += 1; h.state.now += ms; },
      sequenceScopeLoader: async (args) => {
        const call = { args, catalogReadsBefore: h.state.catalogReads };
        seen.scopeCalls.push(call);
        await scopeHook?.(seen.scopeCalls.length);
        const readsBefore = h.state.reads.length;
        const catalogBefore = h.state.catalogReads;
        const scope = await h.load({
          ...args,
          ...(cacheOn ? {} : { definitionAnswersDigest: null }),
          ...loaderOverrides,
        });
        call.reads = h.state.reads.slice(readsBefore).sort();
        call.catalogReads = h.state.catalogReads - catalogBefore;
        return scope;
      },
      membershipSnapshotLoader: async ({ scope, now, pointer }) => {
        seen.pointerArg = pointer;
        seen.snapshot = await loadPublishedBookingMembershipSnapshot({
          scope,
          now,
          pointer,
          read: store.get,
          readMany: async (keys) => keys.map((key) => clone(store.values.get(key) ?? null)),
        });
        throw STOP; // the rest of the pass is out of scope here
      },
    });
  } finally {
    Date.now = realNow;
  }
  return { result, seen };
}

// linked01's link is removed after it was cached; refresh A (inside the 6h
// trust window) still serves the cached "has link" and publishes it.
async function publishedWithServedStaleAnswer({ refreshAt = T0 + 3 * HOUR } = {}) {
  const h = harness();
  const store = memoryStore();
  await h.load(); // T0: every answer read and cached
  h.state.definitions.linked01 = NO_LINK;
  h.state.now = refreshAt;
  const a = await refreshOnce(h, store, { rotor: false });
  assert.equal(a.result.ok, true, JSON.stringify(a.result));
  assert.equal(
    store.values.get(BOOKING_MEMBERSHIP_KEYS.current).scope.selectedSequenceIds.includes("linked01"),
    true,
    "the published binding carries the served (stale) answer",
  );
  h.state.now += 7 * MIN;
  return { h, store };
}

// ─── 1. Pointer race (round-two refuter, two reviewers) ─────────────────────

async function pointerRace({ cacheOn }) {
  // Refresh A just inside the 6h bound; refresh B (past it, so it re-reads
  // linked01 live) publishes while the sweep's FIRST scope load runs.
  const { h, store } = await publishedWithServedStaleAnswer({
    refreshAt: T0 + BOOKING_STOP_DEFINITION_MAX_AGE_MS - 5 * MIN,
  });
  const precheckDigest = publishedDigestOf(store);
  let refreshB = null;
  const run = await runSweep(h, store, {
    cacheOn,
    scopeHook: async (call) => {
      if (call === 1) refreshB = await refreshOnce(h, store, { rotor: false });
    },
  });
  assert.equal(refreshB?.result.ok, true);
  return { h, store, run, precheckDigest };
}

test("pointer race: a refresh publishing during the scope leg; the pre-cache (all-live) sweep binds", async () => {
  const { run } = await pointerRace({ cacheOn: false });
  assert.equal(run.seen.snapshot?.ok, true, JSON.stringify(run.seen.snapshot));
  // It served nothing, so it needs no re-run.
  assert.equal(run.seen.scopeCalls.length, 1);
  assert.equal(run.result.scopeReloadedForPointer, false);
});

test("pointer race: the cached sweep re-runs its scope ONCE against the new digest and binds to that same pointer", async () => {
  const { store, run, precheckDigest } = await pointerRace({ cacheOn: true });
  const bindDigest = publishedDigestOf(store);
  assert.notEqual(precheckDigest, bindDigest, "the pointer moved during the scope leg");
  assert.equal(run.seen.snapshot?.ok, true, JSON.stringify(run.seen.snapshot));
  assert.equal(run.result.scopeReloadedForPointer, true);
  assert.equal(run.seen.scopeCalls.length, 2);
  assert.equal(run.seen.scopeCalls[0].args.definitionAnswersDigest, precheckDigest);
  assert.equal(run.seen.scopeCalls[1].args.definitionAnswersDigest, bindDigest);
  // Both legs bind to ONE read: the snapshot got the pointer whose digest
  // the re-run served.
  assert.equal(run.seen.pointerArg.scope.digest, bindDigest);
  // The re-run reuses this pass's catalog and every row the first load
  // already read live (plain001): it reads only linked01, now
  // selection-deciding in the new digest's answers. No row is read twice.
  assert.equal(run.seen.scopeCalls[1].catalogReads, 0);
  assert.deepEqual(run.seen.scopeCalls[1].reads, ["linked01"]);
  assert.equal(run.result.definitionCache.liveReuses, 1);
});

test("pointer race on a SERVABLE row: a disabled sequence gains a link, the next refresh publishes mid-scope; the re-run serves the new digest's answer and binds", async () => {
  const h = harness();
  const store = memoryStore();
  assert.equal((await refreshOnce(h, store)).result.ok, true);
  const d1 = publishedDigestOf(store);
  h.state.now += 5 * MIN;
  h.state.definitions.offplain = LINK;
  h.state.now += 2 * MIN;
  const run = await runSweep(h, store, {
    scopeHook: async (call) => {
      if (call !== 1) return;
      // Expire offplain in the refresh's memory so the refresh re-reads it.
      h.state.store.doc.entries.offplain.r = h.state.now - BOOKING_STOP_DEFINITION_MAX_AGE_MS;
      assert.equal((await refreshOnce(h, store)).result.ok, true);
    },
  });
  const d2 = publishedDigestOf(store);
  assert.notEqual(d2, d1, "the new pointer carries the new link answer");
  assert.equal(run.seen.snapshot?.ok, true, JSON.stringify(run.seen.snapshot));
  assert.equal(run.seen.scopeCalls.length, 2);
  assert.equal(run.seen.scopeCalls[1].args.definitionAnswersDigest, d2);
  // offplain came from d2's answers and plain001 from the first load's live
  // read: the re-run makes no Paraform read at all.
  assert.deepEqual(run.seen.scopeCalls[1].reads, []);
  assert.equal(run.seen.pointerArg.scope.digest, d2);
});

test("no pointer movement: one scope load, and the snapshot leg is handed the same pointer object", async () => {
  const { h, store } = await publishedWithServedStaleAnswer();
  const run = await runSweep(h, store);
  assert.equal(run.seen.snapshot?.ok, true, JSON.stringify(run.seen.snapshot));
  assert.equal(run.seen.scopeCalls.length, 1);
  assert.deepEqual(run.seen.scopeCalls[0].reads, ["plain001"]);
  assert.deepEqual(run.seen.pointerArg, currentOf(store));
  assert.equal(run.result.scopeReloadedForPointer, false);
});

// ─── 2. KV blip on the precheck pointer read (round-two KV refuter) ─────────

for (const [label, blip] of [
  ["returns null (kvGet-style)", () => null],
  ["throws (strict KV_UNAVAILABLE)", () => { throw Object.assign(new Error("KV_UNAVAILABLE"), { code: "KV_UNAVAILABLE" }); }],
]) {
  test(`one KV blip on the pointer read ${label}: retried, the digest is kept, only the deciding row is read, and the pass binds`, async () => {
    const { h, store } = await publishedWithServedStaleAnswer();
    let blips = 1;
    const run = await runSweep(h, store, {
      precheck: async () => (blips-- > 0 ? blip() : currentOf(store)),
    });
    assert.equal(run.seen.scopeCalls[0].args.definitionAnswersDigest, publishedDigestOf(store));
    assert.deepEqual(run.seen.scopeCalls[0].reads, ["plain001"]);
    assert.equal(run.seen.snapshot?.ok, true, JSON.stringify(run.seen.snapshot));
  });
}

test("the snapshot leg's pointer read failing twice keeps the precheck's pointer (positive evidence) and binds", async () => {
  const { h, store } = await publishedWithServedStaleAnswer();
  let calls = 0;
  const run = await runSweep(h, store, {
    precheck: async () => {
      calls += 1;
      if (calls === 1) return currentOf(store);
      throw new Error("KV_UNAVAILABLE");
    },
  });
  assert.equal(calls, 3, "precheck read, then one strict read retried once");
  assert.deepEqual(run.seen.pointerArg, currentOf(store));
  assert.equal(run.seen.snapshot?.ok, true, JSON.stringify(run.seen.snapshot));
});

test("no readable pointer at all: every definition is read live and the snapshot loader reads the pointer itself, as before the cache", async () => {
  const { h, store } = await publishedWithServedStaleAnswer();
  const run = await runSweep(h, store, {
    precheck: async () => { throw new Error("KV_UNAVAILABLE"); },
  });
  assert.equal(run.seen.scopeCalls.length, 1);
  assert.equal(run.seen.scopeCalls[0].args.definitionAnswersDigest, null);
  assert.equal(run.seen.scopeCalls[0].reads.length, 5);
  assert.equal(run.seen.pointerArg, undefined);
});

// ─── 3. The precheck wait never lets a failed re-read discard stale evidence ─

async function stalePointerWithRefreshInFlight() {
  const { h, store } = await publishedWithServedStaleAnswer();
  h.state.now = Date.parse(store.values.get(BOOKING_MEMBERSHIP_KEYS.current).oldestFetchedAt)
    + BOOKING_MEMBERSHIP_MAX_AGE_MS + 5 * MIN;
  const lockAt = new Date(h.state.now - 60 * 1000).toISOString();
  const lock = async () => ({ schema: "raydar-booking-membership-lock-v1", token: "t", at: lockAt });
  return { h, store, lock };
}

for (const [label, fail] of [
  ["null", () => null],
  ["a thrown KV error", () => { throw new Error("KV_UNAVAILABLE"); }],
]) {
  test(`stale pointer + refresh in flight: ${label} on a wait re-read keeps the stale evidence, and the pass skips with zero definition reads`, async () => {
    const { h, store, lock } = await stalePointerWithRefreshInFlight();
    let call = 0;
    const run = await runSweep(h, store, {
      lock,
      precheck: async () => {
        call += 1;
        // Both attempts of the second poll fail.
        if (call === 3 || call === 4) return fail();
        return currentOf(store);
      },
    });
    assert.equal(run.seen.scopeCalls.length, 0);
    assert.equal(run.result.membershipSnapshotError, "snapshot_stale_before_scope");
    assert.equal(run.result.membershipSnapshotPrecheck, true);
    assert.ok(run.seen.sleeps >= 10);
  });
}

test("stale pointer + an unreadable refresh lock: the pass waits (KV reads only) instead of skipping, and binds a publish that lands", async () => {
  const { h, store } = await stalePointerWithRefreshInFlight();
  const stale = currentOf(store);
  let polls = 0;
  let fresh = null;
  const run = await runSweep(h, store, {
    lock: async () => { throw new Error("KV_UNAVAILABLE"); },
    precheck: async () => {
      polls += 1;
      if (polls === 5) {
        // A refresh publishes while the pass waits.
        const b = await refreshOnce(h, store, { rotor: false });
        assert.equal(b.result.ok, true);
        fresh = currentOf(store);
      }
      return polls >= 5 ? currentOf(store) : clone(stale);
    },
  });
  assert.ok(fresh, "the refresh published");
  assert.ok(run.seen.sleeps >= 1);
  assert.equal(run.seen.scopeCalls.length, 1);
  assert.equal(run.seen.scopeCalls[0].args.definitionAnswersDigest, fresh.scope.digest);
});

test("stale pointer + an unreadable refresh lock, no publish: the wait is bounded by the pre-cache scope-leg time, then the pass skips", async () => {
  const { h, store } = await stalePointerWithRefreshInFlight();
  const run = await runSweep(h, store, {
    lock: async () => { throw new Error("KV_UNAVAILABLE"); },
  });
  assert.equal(run.seen.scopeCalls.length, 0);
  assert.equal(run.seen.sleeps, Math.floor(BOOKING_STOP_PRECHECK_MAX_WAIT_MS / BOOKING_STOP_PRECHECK_POLL_MS));
  assert.equal(run.result.membershipSnapshotError, "snapshot_stale_before_scope");
});

// ─── 4. The mutable cache document: strict reader, no blind overwrite ────────

test("persistDefinitions: when the merge-on-write read throws, nothing is written (a racing writer's entries survive)", async () => {
  const h = harness();
  await h.load();
  const before = clone(h.state.store.doc);
  const writesBefore = h.state.writes;
  h.state.now += 10 * MIN;
  h.state.rows.push({ id: "brandnew", name: "Brand new", enabled: false });
  h.state.definitions.brandnew = NO_LINK;
  let calls = 0;
  const scope = await h.load({
    definitionCacheReader: async () => {
      calls += 1;
      if (calls === 1) return clone(h.state.store.doc); // the load's own read
      throw Object.assign(new Error("KV_UNAVAILABLE"), { code: "KV_UNAVAILABLE" });
    },
  });
  assert.equal(calls, 2);
  assert.equal(scope.complete, true);
  assert.equal(scope.definitionCache.write, "failed");
  assert.equal(h.state.writes, writesBefore, "the writer was never called");
  assert.deepEqual(h.state.store.doc, before);
});

test("persistDefinitions: a merge read that returns genuinely absent (null) still writes", async () => {
  const h = harness();
  await h.load();
  h.state.now += 10 * MIN;
  h.state.rows.push({ id: "brandnew", name: "Brand new", enabled: false });
  h.state.definitions.brandnew = NO_LINK;
  const writesBefore = h.state.writes;
  let calls = 0;
  const scope = await h.load({
    definitionCacheReader: async () => {
      calls += 1;
      return calls === 1 ? clone(h.state.store.doc) : null;
    },
  });
  assert.equal(scope.definitionCache.write, "written");
  assert.equal(h.state.writes, writesBefore + 1);
  assert.equal(Object.hasOwn(h.state.store.doc.entries, "brandnew"), true);
});

// ─── 5. Plumbing ────────────────────────────────────────────────────────────

test("loadPublishedBookingMembershipSnapshot: a handed pointer is used as-is; an omitted one is read", async () => {
  const { h, store } = await publishedWithServedStaleAnswer();
  const scope = await h.sweep(publishedDigestOf(store));
  const reads = [];
  const read = async (key) => { reads.push(key); return clone(store.values.get(key) ?? null); };
  const readMany = async (keys) => keys.map((key) => clone(store.values.get(key) ?? null));
  const handed = await loadPublishedBookingMembershipSnapshot({
    scope, now: h.state.now, read, readMany, pointer: currentOf(store),
  });
  assert.equal(handed.ok, true);
  assert.equal(reads.includes(BOOKING_MEMBERSHIP_KEYS.current), false);
  const omitted = await loadPublishedBookingMembershipSnapshot({
    scope, now: h.state.now, read, readMany,
  });
  assert.equal(omitted.ok, true);
  assert.equal(reads.includes(BOOKING_MEMBERSHIP_KEYS.current), true);
  // A handed pointer that is not a valid binding is rejected like a read one.
  const wrong = await loadPublishedBookingMembershipSnapshot({
    scope, now: h.state.now, read, readMany, pointer: null,
  });
  assert.equal(wrong.ok, false);
});

test("bookingStopScopeCatalog returns a copy of the rows the load listed, and a listedCatalog load does not list again", async () => {
  const h = harness();
  const scope = await h.load();
  const rows = bookingStopScopeCatalog(scope);
  assert.deepEqual(rows, defaultRows());
  rows[0].name = "mutated";
  assert.deepEqual(bookingStopScopeCatalog(scope), defaultRows());
  assert.equal(bookingStopScopeCatalog({}), null);
  assert.equal(JSON.stringify(scope).includes("mutated"), false);
  const before = h.state.catalogReads;
  const again = await h.load({ listedCatalog: bookingStopScopeCatalog(scope) });
  assert.equal(h.state.catalogReads, before);
  assert.equal(again.scopeDigest, scope.scopeDigest);
});

// ─── 6. Round four: the sweep reproduces the published binding exactly ──────
// PR 231 third review found five passes that fail closed (pause no one) where
// main binds. Each scenario runs twice: once on the cached system, once on a
// model of main (refresh with the cache off, sweep reading every definition
// live), and the cached pass must bind wherever main's does.

const KV_DOWN = () =>
  Object.assign(new Error("KV_UNAVAILABLE"), { code: "KV_UNAVAILABLE" });

// Main: every refresh and sweep read reads Paraform live. Same world as
// publishedWithServedStaleAnswer: linked01's link is removed after T0.
async function mainWorld({ duringWalk = null, beforeSweep = null, precheck = null } = {}) {
  const h = harness({ revision: null });
  const store = memoryStore();
  await h.load();
  h.state.definitions.linked01 = NO_LINK;
  h.state.now = T0 + 3 * HOUR;
  const refresh = await refreshOnce(h, store, { rotor: false, onMembership: duringWalk });
  if (!refresh.result.ok) return { refresh, run: null };
  h.state.now += 7 * MIN;
  beforeSweep?.(h);
  const run = await runSweep(h, store, {
    cacheOn: false,
    ...(precheck ? { precheck: precheck(store) } : {}),
  });
  return { refresh, run };
}

test("round four: a rename of a non-selection-deciding row between refresh and sweep serves the bound answer, and the pass binds where main binds", async () => {
  const rename = (h) => { h.state.rows[0].name = "Sourcing - Counsel (renamed)"; };
  const main = await mainWorld({ beforeSweep: rename });
  assert.equal(main.run.seen.snapshot?.ok, true, "main binds");

  const { h, store } = await publishedWithServedStaleAnswer();
  rename(h); // linked01: still enabled and name-unmatched, served "has link"
  const run = await runSweep(h, store);
  assert.equal(run.seen.snapshot?.ok, true, JSON.stringify(run.seen.snapshot));
  assert.equal(run.seen.scopeCalls.length, 1);
  // The name hash moved, but the bound answer is served: only the
  // selection-deciding row is read live.
  assert.deepEqual(run.seen.scopeCalls[0].reads, ["plain001"]);
  assert.equal(run.result.scopeReloadedForPointer, false);
});

test("round four: a rename that makes a row selection-deciding still reads it live (and fails closed exactly where main does)", async () => {
  const rename = (h) => { h.state.rows[3].name = "Plain role"; }; // named001 loses its nudge name
  const main = await mainWorld({ beforeSweep: rename });
  assert.equal(main.run.seen.snapshot?.ok, false, "main fails closed: the selection moved");

  const { h, store } = await publishedWithServedStaleAnswer();
  rename(h);
  const run = await runSweep(h, store);
  assert.ok(run.seen.scopeCalls[0].reads.includes("named001"), "read live, never served");
  assert.equal(run.seen.snapshot?.ok, false);
  // It served the bound digest's own answers, so a re-run cannot help.
  assert.equal(run.seen.scopeCalls.length, 1);
});

test("round four: a rename during the refresh's membership walk publishes where main publishes (no BOOKING_MEMBERSHIP_SCOPE_DRIFT)", async () => {
  const renameDuringWalk = (h) => () => { h.state.rows[0].name = "Sourcing - Counsel v2"; };
  const main = await (async () => {
    const h = harness({ revision: null });
    const store = memoryStore();
    await h.load();
    h.state.definitions.linked01 = NO_LINK;
    h.state.now = T0 + 3 * HOUR;
    return refreshOnce(h, store, { rotor: false, onMembership: renameDuringWalk(h) });
  })();
  assert.equal(main.result.ok, true, "main publishes");

  const h = harness();
  const store = memoryStore();
  await h.load(); // T0: every answer read and cached
  h.state.definitions.linked01 = NO_LINK;
  h.state.now = T0 + 3 * HOUR; // the refresh serves linked01's cached "has link"
  const run = await refreshOnce(h, store, {
    rotor: false,
    onMembership: renameDuringWalk(h),
  });
  assert.equal(run.result.ok, true, JSON.stringify(run.result));
  // The drift-check load served the first load's answer for the renamed row
  // and read only the selection-deciding row live.
  assert.deepEqual(run.reads, ["plain001", "plain001"]);
  h.state.now += 7 * MIN;
  const sweep = await runSweep(h, store);
  assert.equal(sweep.seen.snapshot?.ok, true, JSON.stringify(sweep.seen.snapshot));
});

test("round four: a link added to a selection-deciding row during the walk is still drift (pinned answers never cover a live-read row)", async () => {
  const h = harness();
  const store = memoryStore();
  await h.load();
  h.state.now = T0 + 3 * HOUR;
  await assert.rejects(() => refreshOnce(h, store, {
    rotor: false,
    onMembership: () => { h.state.definitions.plain001 = LINK; },
  }), { code: "BOOKING_MEMBERSHIP_SCOPE_DRIFT" });
});

test("round four: the precheck pointer read failing twice with a stale served answer re-runs against the bound digest and binds, reading no row twice", async () => {
  const failTwice = () => {
    let calls = 0;
    return (store) => async () => {
      calls += 1;
      if (calls <= 2) throw KV_DOWN();
      return currentOf(store);
    };
  };
  const main = await mainWorld({ precheck: failTwice() });
  assert.equal(main.run.seen.snapshot?.ok, true, "main binds");

  const { h, store } = await publishedWithServedStaleAnswer();
  const run = await runSweep(h, store, { precheck: failTwice()(store) });
  assert.equal(run.seen.scopeCalls.length, 2);
  // The first load had no digest: it read everything live, and its live
  // "no link" on linked01 contradicts the binding's served "has link".
  assert.equal(run.seen.scopeCalls[0].args.definitionAnswersDigest, null);
  assert.equal(run.seen.scopeCalls[0].reads.length, 5);
  // The re-run (whatever the first load's hit count, here 0) serves the bound
  // answers and reuses every live read: zero further Paraform reads.
  assert.equal(run.seen.scopeCalls[1].args.definitionAnswersDigest, publishedDigestOf(store));
  assert.deepEqual(run.seen.scopeCalls[1].reads, []);
  assert.equal(run.seen.scopeCalls[1].catalogReads, 0);
  assert.equal(run.result.scopeReloadedForPointer, true);
  assert.equal(run.seen.snapshot?.ok, true, JSON.stringify(run.seen.snapshot));
});

test("round four: the rollback lever pulled while the current pointer carries cached answers; the first sweep still binds, then the lever's refresh publishes the live truth", async () => {
  // The lever really does switch the revision off on Vercel.
  assert.equal(
    bookingStopDefinitionCacheRevision({ VERCEL: "1", BOOKING_STOP_DEFINITION_CACHE: "off" }),
    null,
  );
  const lever = { definitionCacheRevision: null };
  const { h, store } = await publishedWithServedStaleAnswer();
  const first = await runSweep(h, store, { loaderOverrides: lever });
  assert.equal(first.seen.snapshot?.ok, true, JSON.stringify(first.seen.snapshot));
  assert.deepEqual(first.seen.scopeCalls[0].reads, ["plain001"]);
  assert.equal(first.result.definitionCache.state, "warm");

  // The next refresh under the lever serves nothing and writes no answers.
  h.state.now += 3 * MIN;
  const answersWritesBefore = h.state.answersWrites;
  const refresh = await refreshOnce(h, store, { rotor: false, loaderOverrides: lever });
  assert.equal(refresh.result.ok, true);
  assert.equal(refresh.reads.length, 10, "both loads read every definition, as main");
  assert.equal(h.state.answersWrites, answersWritesBefore);
  assert.equal(currentOf(store).scope.selectedSequenceIds.includes("linked01"), false);
  h.state.now += 7 * MIN;
  const next = await runSweep(h, store, { loaderOverrides: lever });
  assert.equal(next.seen.snapshot?.ok, true, JSON.stringify(next.seen.snapshot));
  assert.equal(next.seen.scopeCalls[0].reads.length, 5, "no answers for that digest: all live");
});

test("round four: the answers document failing durability twice no longer fails the refresh; it publishes a scope that served nothing and the sweep reads live and binds", async () => {
  const h = harness();
  const store = memoryStore();
  await h.load();
  h.state.definitions.linked01 = NO_LINK;
  h.state.now = T0 + 3 * HOUR;
  h.state.failAnswersWrite = true;
  const refresh = await refreshOnce(h, store, {
    rotor: false,
    loaderOverrides: { definitionAnswersReader: async () => null },
  });
  assert.equal(refresh.result.ok, true, JSON.stringify(refresh.result));
  assert.equal(refresh.telemetry.durable, false);
  assert.equal(refresh.telemetry.cacheHits, 0);
  // Each load re-read the rows it served; never more than main's full read.
  assert.ok(refresh.telemetry.recoveryReads >= 4);
  assert.ok(refresh.reads.length <= 10, refresh.reads.join(","));
  assert.equal(currentOf(store).scope.selectedSequenceIds.includes("linked01"), false);
  h.state.now += 7 * MIN;
  const run = await runSweep(h, store);
  assert.equal(run.seen.snapshot?.ok, true, JSON.stringify(run.seen.snapshot));
  assert.equal(run.seen.scopeCalls[0].reads.length, 5);
  assert.equal(run.seen.scopeCalls.length, 1);
});

test("round four: a drift-check load whose own write cannot be verified is covered by the first load's durable document under the same digest (no recovery reads)", async () => {
  const h = harness();
  const store = memoryStore();
  await h.load();
  h.state.now = T0 + 3 * HOUR;
  let failing = false;
  const refresh = await refreshOnce(h, store, {
    rotor: false,
    onMembership: () => { failing = true; },
    loaderOverrides: {
      definitionAnswersWriter: async (digest, doc) => {
        if (failing) throw KV_DOWN();
        h.state.answers.set(digest, clone(doc));
      },
      definitionAnswersReader: async (digest) =>
        (failing ? null : clone(h.state.answers.get(digest) ?? null)),
    },
  });
  assert.equal(refresh.result.ok, true, JSON.stringify(refresh.result));
  assert.equal(refresh.telemetry.durable, true);
  assert.equal(refresh.telemetry.recoveryReads, 0);
  assert.deepEqual(refresh.reads, ["plain001", "plain001"]);
  h.state.now += 7 * MIN;
  const run = await runSweep(h, store);
  assert.equal(run.seen.snapshot?.ok, true, JSON.stringify(run.seen.snapshot));
  assert.deepEqual(run.seen.scopeCalls[0].reads, ["plain001"]);
});

test("round four: when the pointer moved and the re-run's answers read fails, the re-run reads only the rows the first load served, never a full live read twice", async () => {
  const { h, store } = await publishedWithServedStaleAnswer({
    refreshAt: T0 + BOOKING_STOP_DEFINITION_MAX_AGE_MS - 5 * MIN,
  });
  let bound = null;
  const run = await runSweep(h, store, {
    scopeHook: async (call) => {
      if (call !== 1) return;
      assert.equal((await refreshOnce(h, store, { rotor: false })).result.ok, true);
      bound = publishedDigestOf(store);
      h.state.failAnswersRead = (digest) => (digest === bound ? KV_DOWN() : null);
    },
  });
  assert.equal(run.seen.scopeCalls.length, 2);
  assert.equal(run.seen.scopeCalls[1].args.definitionAnswersDigest, bound);
  assert.equal(run.result.definitionCache.state, "read_error");
  // plain001 was read live by the first load and is reused; the four rows
  // the first load served from the old digest's answers are read live.
  assert.deepEqual(run.seen.scopeCalls[0].reads, ["plain001"]);
  assert.deepEqual(run.seen.scopeCalls[1].reads, ["linked01", "named001", "offlink1", "offplain"]);
  const all = [...run.seen.scopeCalls[0].reads, ...run.seen.scopeCalls[1].reads];
  assert.equal(new Set(all).size, all.length, "no row read twice in one pass");
  // All-live answers equal what refresh B published (it read linked01 live).
  assert.equal(run.seen.snapshot?.ok, true, JSON.stringify(run.seen.snapshot));
});

test("round four parity control: a real change on a live-read row after the refresh fails closed with no re-run, as main does", async () => {
  const addLink = (h) => { h.state.definitions.plain001 = LINK; };
  const main = await mainWorld({ beforeSweep: addLink });
  assert.equal(main.run.seen.snapshot?.ok, false, "main fails closed");

  const { h, store } = await publishedWithServedStaleAnswer();
  addLink(h);
  const run = await runSweep(h, store);
  assert.equal(run.seen.scopeCalls.length, 1);
  assert.equal(run.result.scopeReloadedForPointer, false);
  assert.equal(run.seen.snapshot?.ok, false);
});
