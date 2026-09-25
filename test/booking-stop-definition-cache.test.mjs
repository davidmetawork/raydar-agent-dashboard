process.env.PARAFORM_COOKIE ||= "Fe26.2**test-cookie";
process.env.CALENDLY_API_TOKEN ||= "test-calendly-token";

// Every Paraform and KV call in this file is an injected in-memory fake.
// Run under a no-network preload to prove it.
import test from "node:test";
import assert from "node:assert/strict";

import {
  createRefreshScopeLoader,
  discoverBookingStopSequences,
  isNudgeSequence,
} from "../api/seq/_lib/booking-stop.mjs";
import {
  BOOKING_MEMBERSHIP_KEYS,
  bookingMembershipAttempt,
  bookingMembershipCanonicalJson,
  loadPublishedBookingMembershipSnapshot,
  runBookingMembershipRefresh,
} from "../api/seq/_lib/booking-membership-snapshot.mjs";
import {
  BOOKING_MEMBERSHIP_MAX_AGE_MS,
  BOOKING_STOP_DEFINITION_CACHE_MAX_BYTES,
  BOOKING_STOP_DEFINITION_CACHE_MAX_ENTRIES,
  BOOKING_STOP_DEFINITION_CACHE_SCHEMA,
  BOOKING_STOP_DEFINITION_MAX_AGE_MS,
  BOOKING_STOP_DEFINITION_NO_LINK_MAX_AGE_MS,
  BOOKING_STOP_DEFINITION_ROTOR_HORIZON_MS,
  BOOKING_STOP_DEFINITION_ROTOR_MAX_READS,
  BOOKING_STOP_DEFINITION_SETTLE_MS,
} from "../api/seq/_lib/booking-stop-contract.mjs";
import {
  bookingStopDefinitionCacheRevision,
  definitionCacheAlert,
  definitionCacheTelemetry,
  definitionRotorQuota,
  readDefinitionCacheDocument,
  selectDefinitionRotorReads,
} from "../api/seq/_lib/booking-stop-definition-cache.mjs";
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
  revision = "dpl_test_a",
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
    store,
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
      state.writes += 1;
      state.store.doc = clone(doc);
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
  const fullRead = () => discoverBookingStopSequences(options({
    definitionCacheRevision: null,
    readCampaign: async (id) => clone(state.definitions[id]),
    listSequences: async () => clone(state.rows),
  }));
  // Cold load at T0, then a settle confirmation past SETTLE_MS: afterwards
  // every entry is a usable cache hit.
  const warm = async () => {
    await load();
    state.now += 6 * MIN;
    await load();
  };
  return { state, load, measure, fullRead, warm, options };
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

// ─── Revision and switch ─────────────────────────────────────────────────────

test("revision is the deployment identity; absent, oversized or switched off disables the cache", () => {
  assert.equal(bookingStopDefinitionCacheRevision({}), null);
  assert.equal(bookingStopDefinitionCacheRevision({
    VERCEL_GIT_COMMIT_SHA: "abc", BOOKING_STOP_DEFINITION_CACHE: "off",
  }), null);
  assert.equal(bookingStopDefinitionCacheRevision({
    VERCEL_DEPLOYMENT_ID: "dpl_x", BOOKING_STOP_DEFINITION_CACHE: " OFF ",
  }), null);
  assert.equal(bookingStopDefinitionCacheRevision({ VERCEL_GIT_COMMIT_SHA: "abc" }), "abc");
  assert.equal(bookingStopDefinitionCacheRevision({
    VERCEL_DEPLOYMENT_ID: "dpl_x", VERCEL_GIT_COMMIT_SHA: "abc",
  }), "dpl_x");
  assert.equal(bookingStopDefinitionCacheRevision({ VERCEL_DEPLOYMENT_ID: "x".repeat(129) }), null);
});

test("disabled cache never touches KV and reads every definition on every load", async () => {
  const h = harness({ revision: null });
  const first = await h.measure(() => h.load());
  h.state.now += 20 * MIN;
  const second = await h.measure(() => h.load());
  assert.equal(h.state.readerCalls, 0);
  assert.equal(h.state.writes, 0);
  assert.deepEqual(first.reads, ["linked01", "named001", "offlink1", "offplain", "plain001"]);
  assert.deepEqual(second.reads, first.reads);
  assert.equal(second.out.definitionCache.state, "disabled");
  assert.equal(second.out.definitionCache.write, "disabled");
});

// ─── Cold start, hit, miss ──────────────────────────────────────────────────

test("cold start reads everything once and stores only {n,e,l,r,f} per id", async () => {
  const h = harness();
  const cold = await h.measure(() => h.load());
  assert.equal(cold.catalogReads, 1);
  assert.equal(cold.reads.length, 5);
  assert.equal(cold.out.definitionFreshReads, 5);
  assert.equal(cold.out.definitionCacheHits, 0);
  assert.equal(cold.out.definitionCache.state, "missing");
  assert.equal(cold.out.definitionCache.write, "written");
  const doc = h.state.store.doc;
  assert.equal(doc.schema, BOOKING_STOP_DEFINITION_CACHE_SCHEMA);
  assert.equal(doc.revision, "dpl_test_a");
  assert.deepEqual(Object.keys(doc.entries).sort(), cold.reads);
  for (const [id, entry] of Object.entries(doc.entries)) {
    assert.deepEqual(Object.keys(entry).sort(), ["e", "f", "l", "n", "r"]);
    assert.equal(entry.n, bookingStopCatalogNameSha256(h.state.rows.find((row) => row.id === id).name));
    assert.equal(entry.r, T0);
    assert.equal(entry.f, T0);
  }
  assert.equal(JSON.stringify(doc).includes("book.raydar.xyz"), false, "no step text is stored");
  assert.deepEqual(bindingOf(cold.out), bindingOf(await h.fullRead()));
});

test("warm cache: 1 catalog read, 0 definition reads, binding identical to a full read", async () => {
  const h = harness();
  await h.load();
  h.state.now = T0 + 6 * MIN;
  const confirm = await h.measure(() => h.load());
  // plain001 is the only selection-deciding "no link": its first read is
  // provisional until a read at least SETTLE_MS later confirms it.
  assert.deepEqual(confirm.reads, ["plain001"]);
  h.state.now = T0 + 12 * MIN;
  const warm = await h.measure(() => h.load());
  assert.equal(warm.catalogReads, 1);
  assert.deepEqual(warm.reads, []);
  assert.equal(warm.out.definitionFreshReads, 0);
  assert.equal(warm.out.definitionCacheHits, 5);
  assert.equal(warm.out.definitionCache.state, "warm");
  assert.equal(warm.out.definitionCache.write, "not_needed");
  assert.deepEqual(bindingOf(warm.out), bindingOf(await h.fullRead()));
  assert.equal(warm.out.scannedSequences, 5);
});

test("read count: a healthy run on a 200-row catalog costs 1 catalog read plus only the changed definitions", async () => {
  const rows = [];
  const definitions = {};
  for (let index = 0; index < 200; index += 1) {
    const id = `seq${String(index).padStart(5, "0")}`;
    rows.push({
      id,
      name: index % 7 === 0 ? `${NUDGE} - Role ${index}` : `Outreach ${index}`,
      enabled: index % 3 !== 0,
    });
    definitions[id] = index % 4 === 0 ? LINK : NO_LINK;
  }
  const h = harness({ rows, definitions });
  const cold = await h.measure(() => h.load());
  assert.equal(cold.reads.length, 200);
  await h.warm();
  h.state.now += 6 * MIN;
  const steady = await h.measure(() => h.load());
  assert.equal(steady.catalogReads, 1);
  assert.deepEqual(steady.reads, []);

  // Five catalog-visible changes: two new ids, a rename, and an enable flip
  // in each direction. Exactly those five definitions are read.
  h.state.now += 6 * MIN;
  rows.push({ id: "new00001", name: "New outreach", enabled: true });
  rows.push({ id: "new00002", name: "New disabled", enabled: false });
  definitions.new00001 = LINK;
  definitions.new00002 = NO_LINK;
  rows[1].name = "Outreach 1 renamed";
  rows[3].enabled = true; // index 3 started disabled
  rows[4].enabled = false; // index 4 started enabled
  const changed = await h.measure(() => h.load());
  assert.equal(changed.catalogReads, 1);
  assert.deepEqual(changed.reads, ["new00001", "new00002", "seq00001", "seq00003", "seq00004"]);
  assert.equal(changed.out.definitionFreshReads, 5);
  assert.equal(changed.out.definitionCacheHits, 197);
  assert.deepEqual(bindingOf(changed.out), bindingOf(await h.fullRead()));
});

// ─── Invalidation on every change signal ────────────────────────────────────

test("every catalog-visible change signal forces a read of exactly that row", async () => {
  const cases = [
    ["new id", (h) => {
      h.state.rows.push({ id: "brandnew", name: "Brand new", enabled: true });
      h.state.definitions.brandnew = LINK;
    }, ["brandnew"]],
    ["rename", (h) => { h.state.rows[0].name = "Sourcing - Counsel v2"; }, ["linked01"]],
    ["enable flip off to on", (h) => { h.state.rows[2].enabled = true; }, ["offplain"]],
    ["enable flip on to off", (h) => { h.state.rows[0].enabled = false; }, ["linked01"]],
  ];
  for (const [label, mutate, expected] of cases) {
    const h = harness();
    await h.warm();
    h.state.now += 6 * MIN;
    mutate(h);
    const run = await h.measure(() => h.load());
    assert.deepEqual(run.reads, expected, label);
    assert.deepEqual(bindingOf(run.out), bindingOf(await h.fullRead()), label);
  }
});

test("disabled-to-enabled with a fresh link selects the row on the same load", async () => {
  const h = harness();
  await h.warm();
  h.state.now += 6 * MIN;
  h.state.definitions.offplain = LINK; // steps edited while disabled
  h.state.rows[2].enabled = true;
  const run = await h.measure(() => h.load());
  assert.deepEqual(run.reads, ["offplain"]);
  assert.equal(selectedIds(run.out).includes("offplain"), true);
});

test("a returning id is read again: rows that leave the catalog are dropped from the cache", async () => {
  const h = harness();
  await h.warm();
  const removed = h.state.rows.splice(0, 1)[0];
  h.state.rows.push({ id: "other001", name: "Other", enabled: false });
  h.state.definitions.other001 = NO_LINK;
  h.state.now += MIN;
  await h.load(); // reads other001, rewrites without linked01
  assert.equal(Object.hasOwn(h.state.store.doc.entries, "linked01"), false);
  h.state.rows.unshift(removed);
  h.state.now += MIN;
  const back = await h.measure(() => h.load());
  assert.deepEqual(back.reads, ["linked01"]);
});

test("a deploy (new revision) ignores the whole document and reads everything", async () => {
  const store = { doc: null };
  const a = harness({ revision: "dpl_a", store });
  await a.warm();
  const b = harness({ revision: "dpl_b", store });
  b.state.now = a.state.now + MIN;
  const run = await b.measure(() => b.load());
  assert.equal(run.reads.length, 5);
  assert.equal(run.out.definitionCache.state, "foreign_revision");
  assert.equal(store.doc.revision, "dpl_b");
});

test("a key change that moves a row into the danger class applies the 30-minute bound on that same load", async () => {
  const h = harness();
  await h.warm(); // named001 read at T0 only (6h class while its name matches)
  h.state.now = T0 + BOOKING_STOP_DEFINITION_NO_LINK_MAX_AGE_MS + MIN;
  const sameKeys = await h.measure(() => h.load());
  assert.equal(sameKeys.reads.includes("named001"), false);
  const newKeys = await h.measure(() => h.load({ sequenceKeys: ["Something else"] }));
  assert.equal(newKeys.reads.includes("named001"), true);
  const fullWithNewKeys = await discoverBookingStopSequences(h.options({
    definitionCacheRevision: null,
    sequenceKeys: ["Something else"],
  }));
  assert.deepEqual(bindingOf(newKeys.out), bindingOf(fullWithNewKeys));
});

test("a cold-policy change: excluded rows are never read or cached, un-excluded rows are read", async () => {
  const rows = [...defaultRows(), { id: "cold0001", name: "Cold one", enabled: true }];
  const definitions = { ...defaultDefinitions(), cold0001: LINK };
  const policy = coldPolicy([{ id: "cold0001", name: "Cold one" }]);
  const h = harness({ rows, definitions, policy });
  const cold = await h.measure(() => h.load());
  assert.equal(cold.reads.includes("cold0001"), false);
  assert.equal(Object.hasOwn(h.state.store.doc.entries, "cold0001"), false);
  h.state.now += 6 * MIN;
  await h.load();
  h.state.now += 6 * MIN;
  const warm = await h.measure(() => h.load());
  assert.deepEqual(warm.reads, []);
  assert.equal(warm.out.definitionSequencesRead, warm.out.catalogSequences - warm.out.excludedColdSequences);
  assert.deepEqual(bindingOf(warm.out), bindingOf(await h.fullRead()));

  h.state.policy = NO_POLICY; // policy withdrawn
  const unexcluded = await h.measure(() => h.load({ coldExclusionPolicy: NO_POLICY }));
  assert.deepEqual(unexcluded.reads, ["cold0001"]);
});

// ─── Maximum-age bounds, settle, sticky true ────────────────────────────────

test("danger class: used at 29m59.999s after its read, re-read at exactly 30m", async () => {
  const h = harness();
  await h.warm(); // plain001 confirmed at T0+6
  const readAt = T0 + 6 * MIN;
  h.state.now = readAt + BOOKING_STOP_DEFINITION_NO_LINK_MAX_AGE_MS - 1;
  const inside = await h.measure(() => h.load());
  assert.deepEqual(inside.reads, []);
  h.state.now = readAt + BOOKING_STOP_DEFINITION_NO_LINK_MAX_AGE_MS;
  const edge = await h.measure(() => h.load());
  assert.deepEqual(edge.reads, ["plain001"]);
});

test("other class: used at 6h minus 1 ms, re-read at exactly 6h", async () => {
  const h = harness();
  await h.warm(); // linked01, named001, offplain, offlink1 read at T0 only
  h.state.now = T0 + BOOKING_STOP_DEFINITION_MAX_AGE_MS - 1;
  const inside = await h.measure(() => h.load());
  assert.deepEqual(inside.reads, ["plain001"]); // its own 30-minute bound
  h.state.now = T0 + BOOKING_STOP_DEFINITION_MAX_AGE_MS;
  const edge = await h.measure(() => h.load());
  assert.deepEqual(edge.reads, ["linked01", "named001", "offlink1", "offplain"]);
});

test("settle: a new selection-deciding 'no link' is not trusted until a read >= 5 min after first seen", async () => {
  const h = harness();
  await h.load(); // f = r = T0
  h.state.now = T0 + BOOKING_STOP_DEFINITION_SETTLE_MS - 1;
  const early = await h.measure(() => h.load());
  assert.deepEqual(early.reads, ["plain001"]); // r - f = 0: unsettled
  h.state.now = T0 + BOOKING_STOP_DEFINITION_SETTLE_MS + 30 * 1000;
  const again = await h.measure(() => h.load());
  // Previous read was < SETTLE after first seen, so still unsettled.
  assert.deepEqual(again.reads, ["plain001"]);
  h.state.now += MIN;
  const settled = await h.measure(() => h.load());
  assert.deepEqual(settled.reads, []);
});

test("sticky true: a cached 'has link' stays selected until 6h, then a fresh read shrinks it", async () => {
  const h = harness();
  await h.warm();
  h.state.definitions.linked01 = NO_LINK; // link removed: cached true only widens
  h.state.now = T0 + BOOKING_STOP_DEFINITION_MAX_AGE_MS - MIN;
  const before = await h.measure(() => h.load());
  assert.equal(selectedIds(before.out).includes("linked01"), true);
  h.state.now = T0 + BOOKING_STOP_DEFINITION_MAX_AGE_MS + MIN;
  const after = await h.measure(() => h.load());
  assert.equal(after.reads.includes("linked01"), true);
  assert.equal(selectedIds(after.out).includes("linked01"), false);
  // Its new "no link" is selection-deciding and fresh: the next load confirms.
  h.state.now += MIN;
  const confirm = await h.measure(() => h.load());
  assert.deepEqual(confirm.reads, ["linked01"]);
});

test("a link added in the UI to an enabled unnamed sequence is seen within the bound and raises the correction alert", async () => {
  const h = harness();
  await h.warm();
  const before = await h.load();
  assert.equal(selectedIds(before).includes("plain001"), false);
  h.state.definitions.plain001 = LINK; // no catalog field moves
  h.state.now = T0 + 6 * MIN + BOOKING_STOP_DEFINITION_NO_LINK_MAX_AGE_MS - 1;
  const hidden = await h.measure(() => h.load());
  assert.deepEqual(hidden.reads, []); // the accepted, bounded gap
  h.state.now += 1;
  const seen = await h.measure(() => h.load());
  assert.deepEqual(seen.reads, ["plain001"]);
  assert.equal(selectedIds(seen.out).includes("plain001"), true);
  assert.notEqual(seen.out.scopeDigest, before.scopeDigest);
  assert.equal(seen.out.definitionCache.staleFalseCorrections, 1);
  assert.equal(seen.out.definitionCache.staleFalseCorrectionMaxAgeMs, BOOKING_STOP_DEFINITION_NO_LINK_MAX_AGE_MS);
  const alert = definitionCacheAlert(seen.out.definitionCache);
  assert.equal(alert.key, "definition-cache-stale-false");
  assert.match(alert.message, /30 min/u);
  assert.equal(definitionCacheAlert(before.definitionCache), null);
  // A disabled or name-matched row gaining a link is not the gap: no count.
  const other = harness();
  await other.warm();
  other.state.definitions.offplain = LINK;
  other.state.now = T0 + BOOKING_STOP_DEFINITION_MAX_AGE_MS;
  const quiet = await other.load();
  assert.equal(quiet.definitionCache.staleFalseCorrections, 0);
});

// ─── Failures fail toward protection ────────────────────────────────────────

test("a throttled REQUIRED read fails the whole load: an expired entry is never reused and r never moves forward", async () => {
  const h = harness();
  await h.warm();
  const plainBefore = clone(h.state.store.doc.entries.plain001);
  h.state.now = T0 + 6 * MIN + BOOKING_STOP_DEFINITION_NO_LINK_MAX_AGE_MS; // plain001 expired
  h.state.failRead = (id) => (id === "plain001" ? throttled() : null);
  await assert.rejects(() => h.load(), { code: "PARAFORM_THROTTLED" });
  assert.deepEqual(h.state.store.doc.entries.plain001, plainBefore);
  // Still throttled a minute later: still a failure, never a stale answer.
  h.state.now += MIN;
  await assert.rejects(() => h.load(), { code: "PARAFORM_THROTTLED" });
  h.state.failRead = null;
  h.state.now += MIN;
  const recovered = await h.measure(() => h.load());
  assert.deepEqual(recovered.reads, ["plain001"]);
});

test("valid reads completed before a failure ARE persisted; the next run reads only the remainder", async () => {
  const h = harness();
  await h.warm();
  h.state.now += 10 * MIN;
  for (const id of ["new00001", "new00002", "new00003"]) {
    h.state.rows.push({ id, name: `Link ${id}`, enabled: true });
    h.state.definitions[id] = LINK;
  }
  h.state.failRead = (id) => (id === "new00003" ? throttled() : null);
  await assert.rejects(() => h.load(), { code: "PARAFORM_THROTTLED" });
  assert.equal(Object.hasOwn(h.state.store.doc.entries, "new00001"), true);
  assert.equal(Object.hasOwn(h.state.store.doc.entries, "new00002"), true);
  assert.equal(Object.hasOwn(h.state.store.doc.entries, "new00003"), false);
  h.state.failRead = null;
  h.state.now += MIN;
  const next = await h.measure(() => h.load());
  assert.deepEqual(next.reads, ["new00003"]);
  assert.deepEqual(bindingOf(next.out), bindingOf(await h.fullRead()));
});

test("a badly shaped definition throws CAMPAIGN_INVALID and is never written", async () => {
  const h = harness();
  h.state.definitions.offplain = { steps: "not-an-array" };
  await assert.rejects(() => h.load(), { code: "BOOKING_STOP_SEQUENCE_CAMPAIGN_INVALID" });
  const entries = h.state.store.doc?.entries || {};
  assert.equal(Object.hasOwn(entries, "offplain"), false);
  // Reads that completed before it (catalog order, concurrency 1) were valid.
  assert.deepEqual(Object.keys(entries).sort(), ["linked01", "plain001"]);
});

test("a ROTOR read that is throttled keeps the valid cached entry, stops the rotor, and the load succeeds unchanged", async () => {
  const h = harness();
  await h.warm();
  h.state.now = T0 + 20 * MIN; // plain001 14 min old, others 20 min: all eligible
  const docBefore = clone(h.state.store.doc);
  h.state.failRead = () => throttled();
  const run = await h.measure(() => h.load({ definitionRotor: true }));
  assert.equal(run.out.complete, true);
  assert.equal(run.out.definitionCache.rotorPlanned, 2); // 1 danger + 1 other
  assert.equal(run.out.definitionCache.rotorFailures, 1);
  assert.equal(run.out.definitionCache.rotorReads, 0);
  assert.deepEqual(h.state.attempts, ["plain001"]); // stopped after the first failure
  assert.deepEqual(h.state.store.doc, docBefore); // nothing written, nothing lost
  assert.deepEqual(bindingOf(run.out), bindingOf(await h.fullRead()));
});

test("a rotor read that returns a bad shape is also only a rotor failure", async () => {
  const h = harness();
  await h.warm();
  h.state.now = T0 + 20 * MIN;
  h.state.definitions.plain001 = { steps: null };
  const run = await h.load({ definitionRotor: true });
  assert.equal(run.complete, true);
  assert.equal(run.definitionCache.rotorFailures, 1);
});

test("the rotor respects its phase deadline: an exhausted deadline plans reads but makes none", async () => {
  const h = harness();
  await h.warm();
  h.state.now = T0 + 20 * MIN;
  const run = await h.measure(() => h.load({ definitionRotor: true, deadline: h.state.now }));
  assert.equal(run.out.definitionCache.rotorPlanned, 2);
  assert.equal(run.out.definitionCache.rotorReads, 0);
  assert.deepEqual(run.reads, []);
});

test("malformed, foreign, future-dated or oversized documents are misses and never select fewer ids", async () => {
  const h = harness();
  await h.warm();
  const good = clone(h.state.store.doc);
  h.state.now += 6 * MIN;
  const reference = selectedIds(await h.fullRead());
  const withEntry = (patch) => ({
    ...good,
    entries: { ...good.entries, linked01: { ...good.entries.linked01, ...patch } },
  });
  const oversized = {
    ...good,
    entries: Object.fromEntries(Array.from(
      { length: BOOKING_STOP_DEFINITION_CACHE_MAX_ENTRIES + 1 },
      (_, index) => [`pad${index}`, good.entries.offplain],
    )),
  };
  for (const [label, doc, expectAllRead] of [
    ["wrong schema", { ...good, schema: "other" }, true],
    ["foreign revision", { ...good, revision: "dpl_other" }, true],
    ["entries array", { ...good, entries: [] }, true],
    ["not an object", "garbage", true],
    ["oversized", oversized, true],
    ["future r", withEntry({ r: h.state.now + MIN }), false],
    ["f after r", withEntry({ f: good.entries.linked01.r + 1 }), false],
    ["non-boolean l", withEntry({ l: "yes" }), false],
    ["bad name hash", withEntry({ n: "x" }), false],
    ["cached false where the truth is a link", withEntry({ l: false, f: T0 - HOUR }), false],
  ]) {
    h.state.store.doc = clone(doc);
    const run = await h.measure(() => h.load({ definitionCacheWriter: async () => {} }));
    if (expectAllRead) assert.equal(run.reads.length, 5, label);
    else if (label !== "cached false where the truth is a link") {
      assert.ok(run.reads.includes("linked01"), label);
    }
    for (const id of reference) {
      if (label === "cached false where the truth is a link" && id === "linked01") continue;
      assert.ok(selectedIds(run.out).includes(id), `${label}: ${id}`);
    }
  }
  assert.equal(readDefinitionCacheDocument(oversized, { revision: "dpl_test_a", nowMs: h.state.now }).state, "oversize");
});

test("reader and writer failures change nothing but the read count", async () => {
  const h = harness();
  const run = await h.measure(() => h.load({
    definitionCacheReader: async () => { throw new Error("kv down"); },
    definitionCacheWriter: async () => { throw new Error("kv down"); },
  }));
  assert.equal(run.reads.length, 5);
  assert.equal(run.out.complete, true);
  assert.equal(run.out.definitionCache.state, "read_error");
  assert.equal(run.out.definitionCache.write, "failed");
  assert.deepEqual(bindingOf(run.out), bindingOf(await h.fullRead()));
});

test("oversized write is skipped, reported, and alerts", async () => {
  const rows = Array.from({ length: BOOKING_STOP_DEFINITION_CACHE_MAX_ENTRIES + 1 }, (_, index) => ({
    id: `row${String(index).padStart(5, "0")}`,
    name: `Row ${index}`,
    enabled: false,
  }));
  const definitions = Object.fromEntries(rows.map(({ id }) => [id, NO_LINK]));
  const h = harness({ rows, definitions });
  const run = await h.load();
  assert.equal(run.definitionCache.write, "oversize");
  assert.equal(h.state.writes, 0);
  assert.equal(definitionCacheAlert(run.definitionCache).key, "definition-cache-oversize");
  assert.ok(BOOKING_STOP_DEFINITION_CACHE_MAX_BYTES >= 64 * 1024);
});

// ─── Racing writers, overlay, refresh counts ────────────────────────────────

test("an older writer landing last can never extend an entry's trust window", async () => {
  const h = harness();
  await h.load();
  const early = clone(h.state.store.doc);
  h.state.now = T0 + 6 * MIN;
  await h.load(); // confirms plain001 at T0+6
  h.state.store.doc = early; // a slower concurrent writer lands last
  h.state.now = T0 + 7 * MIN;
  const run = await h.measure(() => h.load());
  assert.deepEqual(run.reads, ["plain001"]); // provisional again: re-read, not trusted
});

test("merge-on-write keeps a racing writer's newer real read and drops nothing newer", async () => {
  const h = harness();
  await h.warm();
  h.state.now += 10 * MIN;
  h.state.rows.push({ id: "brandnew", name: "Brand new", enabled: false });
  h.state.definitions.brandnew = NO_LINK;
  const racer = clone(h.state.store.doc);
  racer.entries.linked01 = { ...racer.entries.linked01, r: h.state.now, f: racer.entries.linked01.f };
  let calls = 0;
  await h.load({
    definitionCacheReader: async () => {
      calls += 1;
      // First call: the load's own read. Second: the merge-on-write re-read,
      // where a racing writer has just refreshed linked01.
      return clone(calls === 1 ? h.state.store.doc : racer);
    },
  });
  assert.equal(calls, 2);
  assert.equal(h.state.store.doc.entries.linked01.r, h.state.now);
  assert.equal(Object.hasOwn(h.state.store.doc.entries, "brandnew"), true);
});

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

async function refreshOnce(h, store, { loaderOverrides = {}, onMembership = null } = {}) {
  store.values.delete(BOOKING_MEMBERSHIP_KEYS.lock);
  h.state.reads = [];
  const catalogBefore = h.state.catalogReads;
  const refresh = createRefreshScopeLoader({ loaderOptions: h.options(loaderOverrides) });
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

test("refresh read counts: a cold publishing run pays each definition about once, warm runs pay ~0", async () => {
  const h = harness();
  const store = memoryStore();
  const cold = await refreshOnce(h, store);
  assert.equal(cold.result.ok, true, JSON.stringify(cold.result));
  assert.equal(cold.catalogReads, 2); // scopeBefore + scopeAfter
  // Today this run pays 10 definition reads. scopeAfter re-reads only the
  // provisional selection-deciding "no link" (settle rule).
  assert.deepEqual(cold.reads, ["linked01", "named001", "offlink1", "offplain", "plain001", "plain001"]);
  assert.equal(cold.telemetry.loads, 2);
  assert.equal(cold.telemetry.freshReads, 6);

  h.state.now = T0 + 10 * MIN; // next cron
  const second = await refreshOnce(h, store);
  assert.equal(second.result.ok, true);
  // plain001 confirmed after settle, plus the rotor's one "other" slice.
  assert.equal(second.reads.includes("plain001"), true);
  assert.equal(second.reads.length, 2);
  assert.equal(second.telemetry.rotorReads, 1);

  h.state.now = T0 + 20 * MIN;
  const third = await refreshOnce(h, store);
  assert.equal(third.result.ok, true);
  assert.equal(third.catalogReads, 2);
  assert.ok(third.reads.length <= 2, JSON.stringify(third.reads)); // rotor slice only

  // The sweep's own scope load, served by the same cache, binds the same
  // scope, so it accepts the refresh's generation with zero definition reads.
  h.state.now = T0 + 27 * MIN;
  const sweep = await h.measure(() => h.load());
  assert.deepEqual(sweep.reads, []);
  const accepted = await loadPublishedBookingMembershipSnapshot({
    scope: sweep.out,
    now: h.state.now,
    read: store.get,
    readMany: async (keys) => keys.map((key) => clone(store.values.get(key) ?? null)),
  });
  assert.equal(accepted.ok, true, JSON.stringify(accepted).slice(0, 200));

  // Telemetry never enters the binding, and the attempt record keeps counts only.
  const attempt = bookingMembershipAttempt({ status: "success", result: third.result, definitionCache: third.telemetry });
  assert.equal(attempt.definitionCache.loads, 2);
  assert.equal(JSON.stringify(store.values.get(BOOKING_MEMBERSHIP_KEYS.current)).includes("definitionFreshReads"), false);
});

test("overlay: with every KV cache write failing, scopeAfter still reuses scopeBefore's reads and publishes without drift", async () => {
  const h = harness();
  const store = memoryStore();
  await h.warm(); // KV doc now settled
  h.state.now += 6 * MIN;
  const run = await refreshOnce(h, store, {
    loaderOverrides: {
      definitionCacheReader: async () => null, // KV empty/unreachable
      definitionCacheWriter: async () => { throw new Error("kv write failed"); },
    },
  });
  assert.equal(run.result.ok, true, JSON.stringify(run.result));
  // scopeBefore reads all 5 (no KV doc); scopeAfter re-reads only the
  // unsettled selection-deciding "no link", everything else from the overlay.
  assert.deepEqual(run.reads, ["linked01", "named001", "offlink1", "offplain", "plain001", "plain001"]);
});

test("a real change between the two refresh loads still throws BOOKING_MEMBERSHIP_SCOPE_DRIFT", async () => {
  const h = harness();
  const store = memoryStore();
  await h.warm();
  h.state.now += 6 * MIN;
  await assert.rejects(() => refreshOnce(h, store, {
    onMembership: () => {
      if (!h.state.rows.some(({ id }) => id === "latelink")) {
        h.state.rows.push({ id: "latelink", name: "Late link", enabled: true });
        h.state.definitions.latelink = LINK;
      }
    },
  }), { code: "BOOKING_MEMBERSHIP_SCOPE_DRIFT" });
});

test("a change the sweep sees after its bound makes it fail closed until the next refresh republishes", async () => {
  const h = harness();
  const store = memoryStore();
  await refreshOnce(h, store);
  h.state.now = T0 + 10 * MIN;
  await refreshOnce(h, store);
  h.state.definitions.plain001 = LINK;
  h.state.now = T0 + 10 * MIN + BOOKING_STOP_DEFINITION_NO_LINK_MAX_AGE_MS;
  const changed = await h.load();
  assert.equal(selectedIds(changed).includes("plain001"), true);
  const rejected = await loadPublishedBookingMembershipSnapshot({
    scope: changed,
    now: T0 + 27 * MIN,
    read: store.get,
    readMany: async (keys) => keys.map((key) => clone(store.values.get(key) ?? null)),
  });
  assert.equal(rejected.ok, false);
});

// ─── Rotor spreading ─────────────────────────────────────────────────────────

test("rotor selection: per-class quota, horizon filter, oldest first, stable tie-break, total cap", () => {
  assert.equal(definitionRotorQuota(20, BOOKING_STOP_DEFINITION_NO_LINK_MAX_AGE_MS), 10);
  assert.equal(definitionRotorQuota(251, BOOKING_STOP_DEFINITION_MAX_AGE_MS), 8);
  assert.equal(definitionRotorQuota(0, BOOKING_STOP_DEFINITION_MAX_AGE_MS), 0);
  const nowMs = T0 + HOUR;
  const candidates = [
    { id: "d-young", r: nowMs - 5 * MIN, dangerClass: true },
    { id: "d-old", r: nowMs - 25 * MIN, dangerClass: true },
    { id: "d-mid", r: nowMs - 15 * MIN, dangerClass: true },
    { id: "o-a", r: nowMs - 50 * MIN, dangerClass: false },
    { id: "o-b", r: nowMs - 50 * MIN, dangerClass: false },
  ];
  const picked = selectDefinitionRotorReads(candidates, { nowMs, dangerClassCount: 3, otherCount: 2 });
  // danger quota ceil(3/2)=2 (oldest first, horizon excludes d-young);
  // other quota ceil(2*10/350)=1 with a stable hash tie-break.
  assert.deepEqual(picked.slice(0, 2), ["d-old", "d-mid"]);
  assert.equal(picked.length, 3);
  assert.deepEqual(
    selectDefinitionRotorReads([...candidates].reverse(), { nowMs, dangerClassCount: 3, otherCount: 2 }),
    picked,
  );
  const many = Array.from({ length: 300 }, (_, index) => ({
    id: `x${index}`, r: nowMs - HOUR, dangerClass: true,
  }));
  assert.equal(
    selectDefinitionRotorReads(many, { nowMs, dangerClassCount: 300, otherCount: 0 }).length,
    BOOKING_STOP_DEFINITION_ROTOR_MAX_READS,
  );
});

test("48-hour simulation: refresh :01 with rotor, sweep :08, cold cache; bounds hold, no bursts, sweep ~0 reads", async () => {
  // 271 non-cold rows shaped like the measured catalog: 20 danger-class,
  // 60 enabled link-bearing, 150 disabled, 41 name-matched.
  const rows = [];
  const definitions = {};
  const add = (count, prefix, name, enabled, definition) => {
    for (let index = 0; index < count; index += 1) {
      const id = `${prefix}${String(index).padStart(4, "0")}`;
      rows.push({ id, name: `${name} ${index}`, enabled });
      definitions[id] = definition;
    }
  };
  add(20, "dang", "Plain outreach", true, NO_LINK);
  add(60, "link", "Sourcing", true, LINK);
  add(150, "dsbl", "Old outreach", false, NO_LINK);
  add(41, "name", NUDGE, true, NO_LINK);
  assert.equal(rows.length, 271);
  const h = harness({ rows, definitions });
  h.state.concurrency = 2;
  const truthLink = (id) => definitions[id] === LINK;
  const boundFor = (row) => (
    row.enabled && !isNudgeSequence(row, [NUDGE]) && !truthLink(row.id)
      ? BOOKING_STOP_DEFINITION_NO_LINK_MAX_AGE_MS
      : BOOKING_STOP_DEFINITION_MAX_AGE_MS
  );
  const runs = [];
  const start = T0; // :01
  for (let step = 0; step < 48 * 6; step += 1) {
    for (const [kind, offset, rotor] of [["refresh", 0, true], ["sweep", 7 * MIN, false]]) {
      h.state.now = start + step * 10 * MIN + offset;
      const run = await h.measure(() => h.load({ definitionRotor: rotor, concurrency: 2 }));
      for (const row of rows) {
        const age = h.state.now - h.state.lastRead.get(row.id);
        assert.ok(age < boundFor(row), `${kind} step ${step}: ${row.id} answer ${age} ms old`);
      }
      const t = run.out.definitionCache;
      assert.ok((t.oldestDangerClassAgeMs ?? 0) < BOOKING_STOP_DEFINITION_NO_LINK_MAX_AGE_MS);
      assert.ok((t.oldestOtherAgeMs ?? 0) < BOOKING_STOP_DEFINITION_MAX_AGE_MS);
      runs.push({ kind, step, reads: run.reads.length, rotor: t.rotorReads, required: t.requiredReads });
    }
  }
  const after = runs.filter(({ step }) => step >= 6); // past the first hour
  const refreshMax = Math.max(...after.filter(({ kind }) => kind === "refresh").map(({ reads }) => reads));
  const sweepReads = after.filter(({ kind }) => kind === "sweep").map(({ reads }) => reads);
  assert.ok(refreshMax <= BOOKING_STOP_DEFINITION_ROTOR_MAX_READS, `refresh burst ${refreshMax}`);
  assert.ok(Math.max(...sweepReads) === 0, `sweep reads ${Math.max(...sweepReads)}`);
  const lastDay = runs.filter(({ step }) => step >= 24 * 6);
  const perDay = lastDay.reduce((sum, { reads }) => sum + reads, 0);
  // Today: 2 loads x 144 runs x 271 definitions = 78,048 a day.
  assert.ok(perDay < 4000, `steady-state definition reads per day ${perDay}`);
});

// ─── Equivalence property ───────────────────────────────────────────────────

function prng(seed) {
  let value = seed >>> 0;
  return () => {
    value = (value * 1664525 + 1013904223) >>> 0;
    return value / 2 ** 32;
  };
}

test("equivalence property: a settled, valid cache yields the same digest, binding, selection and counters as a full read", async () => {
  for (let seed = 1; seed <= 40; seed += 1) {
    const random = prng(seed);
    const size = 3 + Math.floor(random() * 40);
    const rows = [];
    const definitions = {};
    for (let index = 0; index < size; index += 1) {
      const id = `seed${String(seed).padStart(3, "0")}row${String(index).padStart(3, "0")}`;
      const named = random() < 0.2;
      rows.push({
        id,
        name: named ? `${NUDGE} - ${index}` : `Outreach ${seed}-${index}`,
        enabled: random() < 0.6,
      });
      definitions[id] = random() < 0.4 ? LINK : NO_LINK;
    }
    const excluded = rows.filter((row) => !row.name.includes(NUDGE) && random() < 0.2);
    const policy = excluded.length && seed % 2 === 0 ? coldPolicy(excluded) : NO_POLICY;
    const h = harness({ rows, definitions, policy });
    await h.warm();
    h.state.now += 6 * MIN;
    const cached = await h.measure(() => h.load());
    assert.deepEqual(cached.reads, [], `seed ${seed}`);
    const full = await h.fullRead();
    assert.deepEqual(bindingOf(cached.out), bindingOf(full), `seed ${seed}`);
    assert.equal(cached.out.dangerClassSequences, full.dangerClassSequences, `seed ${seed}`);
    assert.equal(cached.out.scannedSequences, full.scannedSequences, `seed ${seed}`);
  }
});

// ─── Contract and telemetry hygiene ──────────────────────────────────────────

test("contract constants keep every bound inside the membership freshness contract", () => {
  assert.ok(BOOKING_STOP_DEFINITION_NO_LINK_MAX_AGE_MS <= BOOKING_MEMBERSHIP_MAX_AGE_MS);
  assert.ok(BOOKING_STOP_DEFINITION_SETTLE_MS < BOOKING_STOP_DEFINITION_NO_LINK_MAX_AGE_MS);
  assert.ok(BOOKING_STOP_DEFINITION_NO_LINK_MAX_AGE_MS < BOOKING_STOP_DEFINITION_MAX_AGE_MS);
  assert.ok(BOOKING_STOP_DEFINITION_ROTOR_HORIZON_MS < BOOKING_STOP_DEFINITION_NO_LINK_MAX_AGE_MS);
  assert.equal(BOOKING_STOP_DEFINITION_NO_LINK_MAX_AGE_MS, 30 * MIN);
  assert.equal(BOOKING_STOP_DEFINITION_MAX_AGE_MS, 6 * HOUR);
});

test("telemetry projection is counts-only and drops anything else", () => {
  const projected = definitionCacheTelemetry({
    state: "warm",
    write: "written",
    freshReads: 3,
    requiredReads: 2,
    rotorReads: 1,
    cacheHits: 7,
    staleFalseCorrections: -1,
    oldestDangerClassAgeMs: 1234.4,
    secret: "Fe26.2**cookie",
    ids: ["a"],
  });
  assert.deepEqual(projected, {
    state: "warm",
    write: "written",
    freshReads: 3,
    requiredReads: 2,
    rotorReads: 1,
    rotorPlanned: 0,
    rotorFailures: 0,
    cacheHits: 7,
    staleFalseCorrections: 0,
    oldestDangerClassAgeMs: 1234,
    oldestOtherAgeMs: null,
    staleFalseCorrectionMaxAgeMs: null,
  });
  assert.equal(definitionCacheTelemetry(null), null);
  assert.equal(definitionCacheTelemetry({ state: "made-up" }).state, null);
});

test("default KV reader/writer: an unconfigured or failing store reads everything and reports the write as failed", async () => {
  const h = harness();
  const { definitionCacheReader, definitionCacheWriter, ...rest } = h.options();
  assert.equal(typeof definitionCacheReader, "function");
  assert.equal(typeof definitionCacheWriter, "function");
  const scope = await discoverBookingStopSequences(rest); // defaults, no KV env in tests
  assert.equal(scope.definitionFreshReads, 5);
  assert.equal(scope.definitionCache.state, "missing");
  assert.equal(scope.definitionCache.write, "failed");
});
