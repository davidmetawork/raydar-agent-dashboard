process.env.PARAFORM_COOKIE ||= "Fe26.2**test-cookie";
process.env.CALENDLY_API_TOKEN ||= "test-calendly-token";

// Every Paraform and KV call in this file is an injected in-memory fake.
// Run under a no-network preload to prove it.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import {
  bookingStopDefinitionCacheRevision,
  bookingStopDefinitionMatcherFingerprint,
  campaignHasCandidateSchedulingLink,
  createRefreshScopeLoader,
  discoverBookingStopSequences,
  isNudgeSequence,
  kvGetStrict,
} from "../api/seq/_lib/booking-stop.mjs";
import {
  BOOKING_MEMBERSHIP_KEYS,
  bookingMembershipAttempt,
  bookingMembershipCanonicalJson,
  bookingMembershipSnapshotHealth,
  loadPublishedBookingMembershipSnapshot,
  runBookingMembershipRefresh,
} from "../api/seq/_lib/booking-membership-snapshot.mjs";
import {
  BOOKING_MEMBERSHIP_MAX_AGE_MS,
  BOOKING_STOP_DEFINITION_CACHE_MAX_BYTES,
  BOOKING_STOP_DEFINITION_CACHE_MAX_ENTRIES,
  BOOKING_STOP_DEFINITION_CACHE_SCHEMA,
  BOOKING_STOP_DEFINITION_CACHE_TTL_SECONDS,
  BOOKING_STOP_DEFINITION_MATCHER_VERSION,
  BOOKING_STOP_DEFINITION_MAX_AGE_MS,
  BOOKING_STOP_DEFINITION_ROTOR_HORIZON_MS,
  BOOKING_STOP_DEFINITION_ROTOR_MAX_READS,
  BOOKING_STOP_DEFINITION_ROTOR_PHASE_MS,
  BOOKING_STOP_DEFINITION_SWEEP_MAX_AGE_MS,
} from "../api/seq/_lib/booking-stop-contract.mjs";
import {
  bookingStopDefinitionCacheRevision as revisionFor,
  buildDefinitionAnswersDocument,
  definitionAnswersDurable,
  definitionCacheAlert,
  definitionCacheFits,
  definitionCacheDecision,
  definitionCacheTelemetry,
  definitionRotorQuota,
  readDefinitionAnswersDocument,
  readDefinitionCacheDocument,
  selectDefinitionRotorReads,
  summarizeDefinitionCacheTelemetry,
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

// ─── Revision and switch ─────────────────────────────────────────────────────

test("revision is keyed to the link matcher, only on Vercel, and switched off by BOOKING_STOP_DEFINITION_CACHE=off", () => {
  const fingerprint = "a".repeat(64);
  assert.equal(revisionFor({}, { matcherFingerprint: fingerprint }), null, "not on Vercel");
  assert.equal(revisionFor({ VERCEL: "1" }, { matcherFingerprint: null }), null, "no fingerprint");
  assert.equal(revisionFor({ VERCEL: "1" }, { matcherFingerprint: "xyz" }), null, "bad fingerprint");
  assert.equal(revisionFor({ VERCEL: "1", BOOKING_STOP_DEFINITION_CACHE: " OFF " }, { matcherFingerprint: fingerprint }), null);
  const revision = revisionFor({ VERCEL: "1" }, { matcherFingerprint: fingerprint });
  assert.equal(revision, `matcher-v${BOOKING_STOP_DEFINITION_MATCHER_VERSION}-${"a".repeat(32)}`);
  // A redeploy (new deployment id or commit) with the same matcher keeps the key.
  assert.equal(revisionFor({ VERCEL: "1", VERCEL_DEPLOYMENT_ID: "dpl_a" }, { matcherFingerprint: fingerprint }), revision);
  assert.equal(revisionFor({ VERCEL_ENV: "production", VERCEL_DEPLOYMENT_ID: "dpl_b" }, { matcherFingerprint: fingerprint }), revision);
  // A matcher change moves the key.
  assert.notEqual(revisionFor({ VERCEL: "1" }, { matcherFingerprint: "b".repeat(64) }), revision);
  // The live revision uses the real matcher's fingerprint.
  assert.equal(bookingStopDefinitionCacheRevision({}), null);
  assert.equal(
    bookingStopDefinitionCacheRevision({ VERCEL: "1" }),
    `matcher-v${BOOKING_STOP_DEFINITION_MATCHER_VERSION}-${bookingStopDefinitionMatcherFingerprint().slice(0, 32)}`,
  );
});

test("matcher pin: changing the scheduling-link matcher requires bumping BOOKING_STOP_DEFINITION_MATCHER_VERSION", () => {
  // If this fails you changed what a cached "has link" answer means. Bump
  // BOOKING_STOP_DEFINITION_MATCHER_VERSION in booking-stop-contract.mjs AND
  // add the new hash under the new version here. Never just edit the hash for
  // the current version: that would let old cached answers survive a matcher
  // change.
  const PINS = {
    1: "dbb32e4f7b8d29972a189c9d706dbbd81cc3637a7f43e19e1ecf1fb0e5c2ca38",
  };
  const hash = createHash("sha256");
  hash.update(readFileSync(new URL("../api/seq/_lib/scheduling-links.mjs", import.meta.url)));
  hash.update("\n");
  hash.update(String(campaignHasCandidateSchedulingLink));
  assert.equal(hash.digest("hex"), PINS[BOOKING_STOP_DEFINITION_MATCHER_VERSION]);
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

test("cold start reads everything once and stores only {n,e,l,r} per id", async () => {
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
  assert.equal(doc.revision, "matcher-test-a");
  assert.deepEqual(Object.keys(doc.entries).sort(), cold.reads);
  for (const [id, entry] of Object.entries(doc.entries)) {
    assert.deepEqual(Object.keys(entry).sort(), ["e", "l", "n", "r"]);
    assert.equal(entry.n, bookingStopCatalogNameSha256(h.state.rows.find((row) => row.id === id).name));
    assert.equal(entry.r, T0);
  }
  assert.equal(JSON.stringify(doc).includes("book.raydar.xyz"), false, "no step text is stored");
  assert.deepEqual(bindingOf(cold.out), bindingOf(await h.fullRead()));
});

test("warm cache: 1 catalog read plus only the selection-deciding rows, binding identical to a full read", async () => {
  const h = harness();
  await h.load();
  for (const offset of [1, 5, 12, 40]) {
    h.state.now = T0 + offset * MIN;
    const warm = await h.measure(() => h.load());
    assert.equal(warm.catalogReads, 1);
    assert.deepEqual(warm.reads, ["plain001"], `+${offset} min`);
    assert.equal(warm.out.definitionFreshReads, 1);
    assert.equal(warm.out.definitionCacheHits, 4);
    assert.equal(warm.out.dangerClassSequences, 1);
    assert.equal(warm.out.definitionCache.state, "warm");
    assert.deepEqual(bindingOf(warm.out), bindingOf(await h.fullRead()));
    assert.equal(warm.out.scannedSequences, 5);
  }
});

test("read count: a healthy run on a 200-row catalog costs 1 catalog read plus the selection-deciding rows and the changed rows", async () => {
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
  const deciding = () => rows.filter((row) =>
    row.enabled && !isNudgeSequence(row, [NUDGE]) && definitions[row.id] !== LINK)
    .map(({ id }) => id).sort();
  const h = harness({ rows, definitions });
  const cold = await h.measure(() => h.load());
  assert.equal(cold.reads.length, 200);
  h.state.now += 10 * MIN;
  const steady = await h.measure(() => h.load());
  assert.equal(steady.catalogReads, 1);
  assert.deepEqual(steady.reads, deciding());
  assert.equal(steady.out.dangerClassSequences, deciding().length);

  // Five catalog-visible changes: two new ids, a rename, and an enable flip
  // in each direction. Exactly those five plus the selection-deciding rows.
  h.state.now += 10 * MIN;
  rows.push({ id: "new00001", name: "New outreach", enabled: true });
  rows.push({ id: "new00002", name: "New disabled", enabled: false });
  definitions.new00001 = LINK;
  definitions.new00002 = NO_LINK;
  rows[1].name = "Outreach 1 renamed";
  rows[3].enabled = true; // index 3 started disabled
  rows[4].enabled = false; // index 4 started enabled
  const changed = await h.measure(() => h.load());
  const expected = [...new Set([
    ...deciding(), "new00001", "new00002", "seq00001", "seq00003", "seq00004",
  ])].sort();
  assert.deepEqual(changed.reads, expected);
  assert.deepEqual(bindingOf(changed.out), bindingOf(await h.fullRead()));
});

// ─── The protection property ────────────────────────────────────────────────

test("a scheduling link added to a selection-deciding row is seen on the very next load (no cache gap)", async () => {
  const h = harness();
  await h.load();
  h.state.now = T0 + 10 * MIN;
  const before = await h.load();
  assert.equal(selectedIds(before).includes("plain001"), false);
  h.state.definitions.plain001 = LINK; // no catalog field moves
  h.state.now += 1;
  const seen = await h.measure(() => h.load());
  assert.deepEqual(seen.reads, ["plain001"]);
  assert.equal(selectedIds(seen.out).includes("plain001"), true);
  assert.notEqual(seen.out.scopeDigest, before.scopeDigest);
  assert.deepEqual(bindingOf(seen.out), bindingOf(await h.fullRead()));
});

test("a cached 'no link' on a selection-deciding row is never served, whatever its age or source", () => {
  const nameSha256 = bookingStopCatalogNameSha256("Plain outreach");
  const entry = { n: nameSha256, e: true, l: false, r: T0 };
  for (const ageMs of [0, 1, MIN, 29 * MIN, 5 * HOUR]) {
    assert.deepEqual(
      definitionCacheDecision(entry, { nameSha256, enabled: true, nudge: false, nowMs: T0 + ageMs }).use,
      false,
    );
  }
  // The same "no link" may be served once it cannot decide selection.
  assert.equal(definitionCacheDecision(entry, { nameSha256, enabled: true, nudge: true, nowMs: T0 + MIN }).use, true);
  assert.equal(definitionCacheDecision({ ...entry, e: false }, { nameSha256, enabled: false, nudge: false, nowMs: T0 + MIN }).use, true);
  // A cached "has link" may be served: it only keeps the row in scope.
  assert.equal(definitionCacheDecision({ ...entry, l: true }, { nameSha256, enabled: true, nudge: false, nowMs: T0 + MIN }).use, true);
});

test("equivalence property: every served answer can only widen selection; with true answers the binding equals a full read", async () => {
  function prng(seed) {
    let value = seed >>> 0;
    return () => {
      value = (value * 1664525 + 1013904223) >>> 0;
      return value / 2 ** 32;
    };
  }
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
    await h.load();
    h.state.now += 10 * MIN;
    const cached = await h.measure(() => h.load());
    const full = await h.fullRead();
    assert.deepEqual(bindingOf(cached.out), bindingOf(full), `seed ${seed}`);
    assert.equal(cached.reads.length, full.dangerClassSequences, `seed ${seed}`);

    // Now flip every definition behind the cache's back (no catalog signal):
    // the cached scope must still contain every id a full read selects.
    for (const row of rows) {
      definitions[row.id] = definitions[row.id] === LINK ? NO_LINK : LINK;
    }
    h.state.now += MIN;
    const stale = await h.load();
    const truth = await h.fullRead();
    for (const id of selectedIds(truth)) {
      assert.ok(selectedIds(stale).includes(id), `seed ${seed}: ${id} lost`);
    }
  }
});

// ─── Invalidation on every change signal ────────────────────────────────────

test("every catalog-visible change signal forces a read of exactly that row", async () => {
  const cases = [
    ["new id", (h) => {
      h.state.rows.push({ id: "brandnew", name: "Brand new", enabled: false });
      h.state.definitions.brandnew = LINK;
    }, ["brandnew"]],
    ["rename", (h) => { h.state.rows[0].name = "Sourcing - Counsel v2"; }, ["linked01"]],
    ["enable flip off to on", (h) => { h.state.rows[2].enabled = true; }, ["offplain"]],
    ["enable flip on to off", (h) => { h.state.rows[0].enabled = false; }, ["linked01"]],
  ];
  for (const [label, mutate, expected] of cases) {
    const h = harness();
    await h.load();
    h.state.now += 10 * MIN;
    mutate(h);
    const run = await h.measure(() => h.load());
    assert.deepEqual(run.reads, [...expected, "plain001"].sort(), label);
    assert.deepEqual(bindingOf(run.out), bindingOf(await h.fullRead()), label);
  }
});

test("disabled-to-enabled with a fresh link selects the row on the same load", async () => {
  const h = harness();
  await h.load();
  h.state.now += 10 * MIN;
  h.state.definitions.offplain = LINK; // steps edited while disabled
  h.state.rows[2].enabled = true;
  const run = await h.measure(() => h.load());
  assert.deepEqual(run.reads, ["offplain", "plain001"]);
  assert.equal(selectedIds(run.out).includes("offplain"), true);
});

test("a returning id is read again: rows that leave the catalog are dropped from the cache", async () => {
  const h = harness();
  await h.load();
  const removed = h.state.rows.splice(0, 1)[0];
  h.state.now += MIN;
  await h.load();
  assert.equal(Object.hasOwn(h.state.store.doc.entries, "linked01"), false);
  h.state.rows.unshift(removed);
  h.state.now += MIN;
  const back = await h.measure(() => h.load());
  assert.deepEqual(back.reads, ["linked01", "plain001"]);
});

test("a matcher change (new revision) ignores the whole document and reads everything", async () => {
  const store = { doc: null };
  const a = harness({ revision: "matcher-v1-a", store });
  await a.load();
  const b = harness({ revision: "matcher-v2-b", store });
  b.state.now = a.state.now + MIN;
  const run = await b.measure(() => b.load());
  assert.equal(run.reads.length, 5);
  assert.equal(run.out.definitionCache.state, "foreign_revision");
  assert.equal(store.doc.revision, "matcher-v2-b");
});

test("a key change that makes a cached 'no link' row selection-deciding reads it on that same load", async () => {
  const h = harness();
  await h.load(); // named001 is name-matched: its "no link" may be served
  h.state.now = T0 + 20 * MIN;
  const sameKeys = await h.measure(() => h.load());
  assert.equal(sameKeys.reads.includes("named001"), false);
  const newKeys = await h.measure(() => h.load({ sequenceKeys: ["Something else"] }));
  assert.equal(newKeys.reads.includes("named001"), true);
  const fullWithNewKeys = await h.fullRead({ sequenceKeys: ["Something else"] });
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
  h.state.now += 10 * MIN;
  const warm = await h.measure(() => h.load());
  assert.deepEqual(warm.reads, ["plain001"]);
  assert.equal(warm.out.definitionSequencesRead, warm.out.catalogSequences - warm.out.excludedColdSequences);
  assert.deepEqual(bindingOf(warm.out), bindingOf(await h.fullRead()));

  h.state.policy = NO_POLICY; // policy withdrawn
  const unexcluded = await h.measure(() => h.load({ coldExclusionPolicy: NO_POLICY }));
  assert.deepEqual(unexcluded.reads, ["cold0001", "plain001"]);
});

// ─── Maximum-age bounds ─────────────────────────────────────────────────────

test("refresh bound: a servable answer is used at 6h minus 1 ms and re-read at exactly 6h", async () => {
  const h = harness();
  await h.load();
  h.state.now = T0 + BOOKING_STOP_DEFINITION_MAX_AGE_MS - 1;
  const inside = await h.measure(() => h.load());
  assert.deepEqual(inside.reads, ["plain001"]);
  h.state.now = T0 + BOOKING_STOP_DEFINITION_MAX_AGE_MS;
  const edge = await h.measure(() => h.load());
  assert.deepEqual(edge.reads, ["linked01", "named001", "offlink1", "offplain", "plain001"]);
});

test("sweep bound: the sweep trusts a published answer one snapshot lifetime longer, and never beyond", async () => {
  const h = harness();
  const published = await h.load({ definitionDurableAnswers: true });
  const digest = published.scopeDigest;
  assert.ok(h.state.answers.has(digest));
  h.state.now = T0 + BOOKING_STOP_DEFINITION_SWEEP_MAX_AGE_MS - 1;
  const inside = await h.measure(() => h.sweep(digest));
  assert.deepEqual(inside.reads, ["plain001"]);
  h.state.now = T0 + BOOKING_STOP_DEFINITION_SWEEP_MAX_AGE_MS;
  const edge = await h.measure(() => h.sweep(digest));
  assert.equal(edge.reads.length, 5);
  // A caller can never lengthen trust past the sweep bound: an oversized
  // value falls back to the refresh bound.
  const h2 = harness();
  await h2.load();
  h2.state.now = T0 + BOOKING_STOP_DEFINITION_MAX_AGE_MS;
  const capped = await h2.measure(() => h2.load({ definitionMaxAgeMs: 48 * HOUR }));
  assert.equal(capped.reads.length, 5);
});

test("sticky true: a cached 'has link' stays selected until the bound, then the fresh 'no link' is read on every load", async () => {
  const h = harness();
  await h.load();
  h.state.definitions.linked01 = NO_LINK; // link removed: cached true only widens
  h.state.now = T0 + BOOKING_STOP_DEFINITION_MAX_AGE_MS - MIN;
  const before = await h.measure(() => h.load());
  assert.equal(selectedIds(before.out).includes("linked01"), true);
  h.state.now = T0 + BOOKING_STOP_DEFINITION_MAX_AGE_MS + MIN;
  const after = await h.measure(() => h.load());
  assert.equal(after.reads.includes("linked01"), true);
  assert.equal(selectedIds(after.out).includes("linked01"), false);
  h.state.now += MIN;
  const next = await h.measure(() => h.load());
  assert.deepEqual(next.reads, ["linked01", "plain001"]);
});

// ─── Failures fail toward protection ────────────────────────────────────────

test("a throttled required read fails the whole load; an expired entry is never reused and r never moves forward", async () => {
  const h = harness();
  await h.load();
  const linkedBefore = clone(h.state.store.doc.entries.linked01);
  h.state.now = T0 + BOOKING_STOP_DEFINITION_MAX_AGE_MS; // linked01 expired
  h.state.failRead = (id) => (id === "linked01" ? throttled() : null);
  await assert.rejects(() => h.load(), { code: "PARAFORM_THROTTLED" });
  assert.deepEqual(h.state.store.doc.entries.linked01, linkedBefore);
  h.state.now += MIN;
  await assert.rejects(() => h.load(), { code: "PARAFORM_THROTTLED" });
  // A throttled selection-deciding read fails the load too.
  h.state.failRead = (id) => (id === "plain001" ? throttled() : null);
  await assert.rejects(() => h.load(), { code: "PARAFORM_THROTTLED" });
  h.state.failRead = null;
  h.state.now += MIN;
  const recovered = await h.measure(() => h.load());
  // linked01's valid read from the previous attempt was persisted.
  assert.deepEqual(recovered.reads, ["named001", "offlink1", "offplain", "plain001"]);
});

test("a failed load still reports the definition reads it spent (error.definitionCache)", async () => {
  const h = harness();
  await h.load();
  h.state.now = T0 + BOOKING_STOP_DEFINITION_MAX_AGE_MS;
  h.state.failRead = (id) => (id === "offplain" ? throttled() : null);
  const error = await h.load().catch((caught) => caught);
  assert.equal(error.code, "PARAFORM_THROTTLED");
  assert.equal(error.definitionCache.state, "warm");
  assert.equal(error.definitionCache.freshReads, 2); // linked01, plain001 before offplain
  assert.equal(error.definitionCache.write, "written");
  // The refresh loader carries it into the attempt summary.
  const refresh = createRefreshScopeLoader({ loaderOptions: h.options() });
  await assert.rejects(() => refresh.scopeLoader(), { code: "PARAFORM_THROTTLED" });
  assert.equal(refresh.definitionCache().loads, 1);
  assert.equal(refresh.definitionCache().freshReads >= 1, true);
});

test("valid reads completed before a failure ARE persisted; the next run reads only the remainder", async () => {
  const h = harness();
  await h.load();
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
  assert.deepEqual(next.reads, ["new00003", "plain001"]);
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

// ─── Rotor ──────────────────────────────────────────────────────────────────

test("a throttled ROTOR read keeps the valid cached entry, stops the rotor after one request, and the load succeeds", async () => {
  const h = harness();
  await h.load();
  h.state.now = T0 + 20 * MIN; // the four servable entries are 20 min old
  const onceCalls = [];
  const run = await h.measure(() => h.load({
    definitionRotor: true,
    readCampaignOnce: async (id, options) => {
      onceCalls.push({ id, timeoutMs: options?.timeoutMs });
      throw throttled();
    },
  }));
  assert.equal(run.out.complete, true);
  assert.equal(run.out.definitionCache.rotorPlanned, 1); // ceil(4 * 10 / 350)
  assert.equal(run.out.definitionCache.rotorFailures, 1);
  assert.equal(run.out.definitionCache.rotorReads, 0);
  assert.equal(onceCalls.length, 1, "single-shot: one request, then stop");
  assert.ok(onceCalls[0].timeoutMs > 0 && onceCalls[0].timeoutMs <= BOOKING_STOP_DEFINITION_ROTOR_PHASE_MS);
  assert.deepEqual(run.reads, ["plain001"]); // the required read still happened
  assert.deepEqual(bindingOf(run.out), bindingOf(await h.fullRead()));
});

test("a rotor read that returns a bad shape fails the whole load, as a required read does", async () => {
  const h = harness();
  await h.load();
  h.state.now = T0 + 20 * MIN;
  await assert.rejects(() => h.load({
    definitionRotor: true,
    readCampaignOnce: async () => ({ steps: null }),
  }), { code: "BOOKING_STOP_SEQUENCE_CAMPAIGN_INVALID" });
});

test("the rotor respects its phase deadline: an exhausted deadline plans reads but makes none", async () => {
  const h = harness();
  await h.load();
  h.state.now = T0 + 20 * MIN;
  const run = await h.measure(() => h.load({ definitionRotor: true, deadline: h.state.now }));
  assert.equal(run.out.definitionCache.rotorPlanned, 1);
  assert.equal(run.out.definitionCache.rotorReads, 0);
  assert.deepEqual(run.reads, ["plain001"]);
});

test("rotor selection: quota ceil(count/35), horizon filter, oldest first, stable tie-break, total cap", () => {
  assert.equal(definitionRotorQuota(251), 8);
  assert.equal(definitionRotorQuota(35), 1);
  assert.equal(definitionRotorQuota(36), 2);
  assert.equal(definitionRotorQuota(0), 0);
  const nowMs = T0 + HOUR;
  const candidates = [
    { id: "young", r: nowMs - 5 * MIN },
    { id: "old", r: nowMs - 50 * MIN },
    { id: "mid", r: nowMs - 15 * MIN },
    { id: "tie-a", r: nowMs - 30 * MIN },
    { id: "tie-b", r: nowMs - 30 * MIN },
  ];
  const picked = selectDefinitionRotorReads(candidates, { nowMs, count: 70 });
  assert.deepEqual(picked.slice(0, 1), ["old"]);
  assert.equal(picked.length, 2);
  assert.deepEqual(selectDefinitionRotorReads([...candidates].reverse(), { nowMs, count: 70 }), picked);
  assert.equal(selectDefinitionRotorReads(candidates, { nowMs, count: 1000 }).includes("young"), false);
  const many = Array.from({ length: 3000 }, (_, index) => ({ id: `x${index}`, r: nowMs - HOUR }));
  assert.equal(
    selectDefinitionRotorReads(many, { nowMs, count: 3000 }).length,
    BOOKING_STOP_DEFINITION_ROTOR_MAX_READS,
  );
});

// ─── Documents, racing writers ──────────────────────────────────────────────

test("malformed, foreign, future-dated or oversized documents are misses and never select fewer ids", async () => {
  const h = harness();
  await h.load();
  const good = clone(h.state.store.doc);
  h.state.now += 10 * MIN;
  const reference = selectedIds(await h.fullRead());
  const withEntry = (id, patch) => ({
    ...good,
    entries: { ...good.entries, [id]: { ...good.entries[id], ...patch } },
  });
  const oversized = {
    ...good,
    entries: Object.fromEntries(Array.from(
      { length: BOOKING_STOP_DEFINITION_CACHE_MAX_ENTRIES + 1 },
      (_, index) => [`pad${index}`, good.entries.offplain],
    )),
  };
  for (const [label, doc, expectRead] of [
    ["wrong schema", { ...good, schema: "other" }, "all"],
    ["foreign revision", { ...good, revision: "matcher-other" }, "all"],
    ["entries array", { ...good, entries: [] }, "all"],
    ["not an object", "garbage", "all"],
    ["oversized", oversized, "all"],
    ["future r", withEntry("linked01", { r: h.state.now + MIN }), "linked01"],
    ["non-boolean l", withEntry("linked01", { l: "yes" }), "linked01"],
    ["bad name hash", withEntry("linked01", { n: "x" }), "linked01"],
    // A cached "no link" on a row that truly has one, where it decides
    // selection: never served, so the row is read and stays selected.
    ["cached false where the truth is a link", withEntry("linked01", { l: false }), "linked01"],
  ]) {
    h.state.store.doc = clone(doc);
    const run = await h.measure(() => h.load({ definitionCacheWriter: async () => {} }));
    if (expectRead === "all") assert.equal(run.reads.length, 5, label);
    else assert.ok(run.reads.includes(expectRead), label);
    for (const id of reference) {
      assert.ok(selectedIds(run.out).includes(id), `${label}: ${id}`);
    }
  }
  assert.equal(readDefinitionCacheDocument(oversized, { revision: "matcher-test-a", nowMs: h.state.now }).state, "oversize");
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

test("oversized write is skipped, reported, and alerts; nothing else alerts", async () => {
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
  const quiet = harness();
  assert.equal(definitionCacheAlert((await quiet.load()).definitionCache), null);
});

test("an older writer landing last can never extend an entry's trust window", async () => {
  const h = harness();
  await h.load(); // r = T0
  const early = clone(h.state.store.doc);
  h.state.now = T0 + 3 * HOUR;
  h.state.rows[0].name = "Sourcing - Counsel v2"; // forces a linked01 read at T0+3h
  await h.load();
  h.state.rows[0].name = "Sourcing - Counsel";
  h.state.store.doc = early; // a slower concurrent writer lands last
  h.state.now = T0 + BOOKING_STOP_DEFINITION_MAX_AGE_MS;
  const run = await h.measure(() => h.load());
  // The stored r is the OLDER read, so linked01 expires earlier, never later.
  assert.ok(run.reads.includes("linked01"));
});

test("merge-on-write keeps a racing writer's newer real read and drops nothing newer", async () => {
  const h = harness();
  await h.load();
  h.state.now += 10 * MIN;
  h.state.rows.push({ id: "brandnew", name: "Brand new", enabled: false });
  h.state.definitions.brandnew = NO_LINK;
  const racer = clone(h.state.store.doc);
  racer.entries.linked01 = { ...racer.entries.linked01, r: h.state.now };
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

test("answers durability: only a warm read-back holding every answer, identical, counts", () => {
  const n = "a".repeat(64);
  const digest = "d".repeat(64);
  const answers = new Map([
    ["x", { n, e: true, l: true, r: 100 }],
    ["y", { n, e: false, l: false, r: 100 }],
  ]);
  const parse = (doc) => readDefinitionAnswersDocument(doc, { revision: "rev", digest, nowMs: 200 });
  const doc = buildDefinitionAnswersDocument({ revision: "rev", digest, nowMs: 200, entries: answers });
  assert.equal(definitionAnswersDurable(answers, parse(doc)), true);
  assert.equal(definitionAnswersDurable(answers, parse(null)), false, "absent read-back is not durable");
  assert.equal(definitionAnswersDurable(answers, parse({ ...doc, digest: "e".repeat(64) })), false, "another digest");
  assert.equal(definitionAnswersDurable(answers, parse({ ...doc, revision: "other" })), false, "another matcher");
  const partial = structuredClone(doc);
  delete partial.entries.y;
  assert.equal(definitionAnswersDurable(answers, parse(partial)), false, "partial");
  const flipped = structuredClone(doc);
  flipped.entries.x.l = false;
  assert.equal(definitionAnswersDurable(answers, parse(flipped)), false, "different answer");
  assert.equal(definitionAnswersDurable(answers, null), false);
});

// ─── Refresh integration ────────────────────────────────────────────────────

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

test("refresh read counts: a cold publishing run pays each definition about once; warm runs pay the deciding rows plus a rotor slice", async () => {
  const h = harness();
  const store = memoryStore();
  const cold = await refreshOnce(h, store);
  assert.equal(cold.result.ok, true, JSON.stringify(cold.result));
  assert.equal(cold.catalogReads, 2); // scopeBefore + scopeAfter
  // Before the cache this run paid 10 definition reads. scopeAfter re-reads
  // only the selection-deciding row.
  assert.deepEqual(cold.reads, ["linked01", "named001", "offlink1", "offplain", "plain001", "plain001"]);
  assert.equal(cold.telemetry.loads, 2);
  assert.equal(cold.telemetry.freshReads, 6);
  assert.equal(cold.telemetry.durable, true);

  h.state.now = T0 + 10 * MIN; // next cron
  const second = await refreshOnce(h, store);
  assert.equal(second.result.ok, true);
  // plain001 in both loads, plus the rotor's one slice in the first.
  assert.equal(second.reads.filter((id) => id === "plain001").length, 2);
  assert.equal(second.reads.length, 3);
  assert.equal(second.telemetry.rotorReads, 1);

  // The sweep's own scope load binds the same scope and accepts the
  // refresh's generation, reading only the selection-deciding row.
  h.state.now = T0 + 17 * MIN;
  const publishedDigest = store.values.get(BOOKING_MEMBERSHIP_KEYS.current).scope.digest;
  const writesBefore = h.state.writes;
  const sweep = await h.measure(() => h.sweep(publishedDigest));
  assert.deepEqual(sweep.reads, ["plain001"]);
  assert.equal(h.state.writes, writesBefore, "the sweep never writes the cache document");
  const accepted = await sweepAccepts(h, store, sweep.out);
  assert.equal(accepted.ok, true, JSON.stringify(accepted).slice(0, 200));

  // Telemetry never enters the binding, and the attempt record keeps counts only.
  const attempt = bookingMembershipAttempt({ status: "success", result: second.result, definitionCache: second.telemetry });
  assert.equal(attempt.definitionCache.loads, 2);
  assert.equal(attempt.definitionCache.durable, true);
  assert.equal(JSON.stringify(store.values.get(BOOKING_MEMBERSHIP_KEYS.current)).includes("definitionFreshReads"), false);
  // Health shows the refresh attempt's cache telemetry.
  store.values.set(BOOKING_MEMBERSHIP_KEYS.attempt, attempt);
  const health = await bookingMembershipSnapshotHealth({ read: store.get, now: h.state.now });
  assert.equal(health.latestAttemptDefinitionCache.loads, 2);
  assert.equal(health.latestAttemptDefinitionCache.rotorReads, 1);
});

test("a link added to a selection-deciding row DURING the refresh walk is still caught as drift", async () => {
  const h = harness();
  const store = memoryStore();
  await h.load();
  h.state.now += 10 * MIN;
  await assert.rejects(() => refreshOnce(h, store, {
    onMembership: () => { h.state.definitions.plain001 = LINK; },
  }), { code: "BOOKING_MEMBERSHIP_SCOPE_DRIFT" });
  // The next refresh picks it up and publishes it in scope.
  h.state.now += 10 * MIN;
  const next = await refreshOnce(h, store);
  assert.equal(next.result.ok, true);
  assert.equal(
    store.values.get(BOOKING_MEMBERSHIP_KEYS.current).scope.selectedSequenceIds.includes("plain001"),
    true,
  );
});

test("a new catalog row between the two refresh loads still throws BOOKING_MEMBERSHIP_SCOPE_DRIFT", async () => {
  const h = harness();
  const store = memoryStore();
  await h.load();
  h.state.now += 10 * MIN;
  await assert.rejects(() => refreshOnce(h, store, {
    onMembership: () => {
      if (!h.state.rows.some(({ id }) => id === "latelink")) {
        h.state.rows.push({ id: "latelink", name: "Late link", enabled: true });
        h.state.definitions.latelink = LINK;
      }
    },
  }), { code: "BOOKING_MEMBERSHIP_SCOPE_DRIFT" });
});

test("a cache write failure that changes no served answer does not fail the refresh (overlay covers the second load)", async () => {
  const h = harness();
  const store = memoryStore();
  const run = await refreshOnce(h, store, {
    loaderOverrides: {
      definitionCacheReader: async () => null, // KV empty
      definitionCacheWriter: async () => { throw new Error("kv write failed"); },
    },
  });
  assert.equal(run.result.ok, true, JSON.stringify(run.result));
  assert.deepEqual(run.reads, ["linked01", "named001", "offlink1", "offplain", "plain001", "plain001"]);
  assert.deepEqual(run.telemetry.writes, ["failed", "failed"]);
  assert.equal(run.telemetry.durable, true); // nothing stored contradicts it
});

test("a refresh that served a cached answer fails when its published answers cannot be written, and the sweep keeps binding the previous generation", async () => {
  const h = harness();
  const store = memoryStore();
  const first = await refreshOnce(h, store);
  assert.equal(first.result.ok, true);
  const publishedBefore = clone(store.values.get(BOOKING_MEMBERSHIP_KEYS.current));
  // The link is removed from linked01 (enabled, name-unmatched). No catalog
  // field moves, so only a re-read (expiry here) can see it.
  h.state.definitions.linked01 = NO_LINK;
  h.state.now = T0 + BOOKING_STOP_DEFINITION_MAX_AGE_MS;
  h.state.failAnswersWrite = true;
  const error = await refreshOnce(h, store).catch((caught) => caught);
  assert.equal(error.code, "BOOKING_STOP_DEFINITION_CACHE_NOT_DURABLE");
  assert.equal(error.definitionCache.durable, false);
  // Nothing new was published ...
  assert.deepEqual(store.values.get(BOOKING_MEMBERSHIP_KEYS.current), publishedBefore);
  // ... and the sweep, which serves the answers of the PUBLISHED digest (not
  // the refresh's newer mutable document), still binds that scope.
  h.state.now += 5 * MIN;
  const sweep = await h.sweep(publishedBefore.scope.digest);
  assert.equal(sweep.scopeDigest, publishedBefore.scope.digest);
  assert.deepEqual(selectedIds(sweep), publishedBefore.scope.selectedSequenceIds);
  // Once the write lands, the refresh publishes the narrower truth and the
  // sweep binds it.
  h.state.failAnswersWrite = false;
  h.state.now += 5 * MIN;
  const recovered = await refreshOnce(h, store);
  assert.equal(recovered.result.ok, true);
  assert.equal(recovered.telemetry.durable, true);
  const current = store.values.get(BOOKING_MEMBERSHIP_KEYS.current);
  assert.equal(current.scope.selectedSequenceIds.includes("linked01"), false);
  h.state.now += 7 * MIN;
  assert.equal((await sweepAccepts(h, store, await h.sweep(current.scope.digest))).ok, true);
});

test("sweep grace: an answer the published refresh served is not re-read (and contradicted) by the sweep minutes later", async () => {
  const h = harness();
  const store = memoryStore();
  await h.load(); // every servable answer read at T0
  h.state.definitions.linked01 = NO_LINK; // removed later, invisible in the catalog
  // Refresh just inside the 6-hour bound serves the cached "has link".
  h.state.now = T0 + BOOKING_STOP_DEFINITION_MAX_AGE_MS - 3 * MIN;
  const refresh = await refreshOnce(h, store, { rotor: false });
  assert.equal(refresh.result.ok, true, JSON.stringify(refresh.result));
  assert.equal(refresh.reads.includes("linked01"), false);
  const digest = store.values.get(BOOKING_MEMBERSHIP_KEYS.current).scope.digest;
  // The sweep runs 7 minutes later, past 6 hours: with the refresh bound it
  // would re-read, disagree, and fail closed; with the sweep bound it binds.
  h.state.now += 7 * MIN;
  const withRefreshBound = await h.sweep(digest, {
    definitionMaxAgeMs: BOOKING_STOP_DEFINITION_MAX_AGE_MS,
  });
  const rejected = await sweepAccepts(h, store, withRefreshBound);
  assert.equal(rejected.ok, false);
  assert.equal(rejected.detail, "current_invalid_or_scope_mismatch");
  const sweep = await h.measure(() => h.sweep(digest));
  assert.equal(sweep.reads.includes("linked01"), false);
  const accepted = await sweepAccepts(h, store, sweep.out);
  assert.equal(accepted.ok, true, JSON.stringify(accepted).slice(0, 200));
});

// ─── 48-hour simulation ─────────────────────────────────────────────────────

test("48-hour simulation: refresh :01 with rotor + drift load, sweep :08; bounds hold, deciding rows always live, no bursts", async () => {
  // 271 non-cold rows shaped like the measured catalog: 20 selection-deciding,
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
  const D = 20;
  const h = harness({ rows, definitions });
  const deciding = (row) =>
    row.enabled && !isNudgeSequence(row, [NUDGE]) && definitions[row.id] !== LINK;
  const runs = [];
  const overlays = new Map();
  let publishedDigest = null;
  for (let step = 0; step < 48 * 6; step += 1) {
    for (const [kind, offset] of [["refresh", 0], ["drift", 3 * MIN], ["sweep", 7 * MIN]]) {
      h.state.now = T0 + step * 10 * MIN + offset;
      if (kind === "refresh") overlays.set(step, new Map());
      const bound = kind === "sweep"
        ? BOOKING_STOP_DEFINITION_SWEEP_MAX_AGE_MS
        : BOOKING_STOP_DEFINITION_MAX_AGE_MS;
      const run = await h.measure(() => (kind === "sweep"
        ? h.sweep(publishedDigest, { concurrency: 2 })
        : h.load({
          concurrency: 2,
          definitionRotor: kind === "refresh",
          definitionMaxAgeMs: bound,
          definitionOverlay: overlays.get(step),
          definitionDurableAnswers: true,
        })));
      // The drift load's scope is the one a refresh publishes.
      if (kind === "drift") publishedDigest = run.out.scopeDigest;
      for (const row of rows) {
        const age = h.state.now - h.state.lastRead.get(row.id);
        if (deciding(row)) assert.equal(age, 0, `${kind} step ${step}: ${row.id} not read live`);
        else assert.ok(age < bound, `${kind} step ${step}: ${row.id} answer ${age} ms old`);
      }
      runs.push({ kind, step, reads: run.reads.length });
    }
  }
  const after = runs.filter(({ step }) => step >= 6);
  const max = (kind) => Math.max(...after.filter((run) => run.kind === kind).map(({ reads }) => reads));
  assert.ok(max("refresh") <= D + BOOKING_STOP_DEFINITION_ROTOR_MAX_READS, `refresh burst ${max("refresh")}`);
  assert.equal(max("sweep"), D);
  assert.equal(max("drift"), D);
  const lastDay = runs.filter(({ step }) => step >= 24 * 6);
  const perDay = lastDay.reduce((sum, { reads }) => sum + reads, 0);
  // Before the cache: 3 loads x 144 runs x 271 definitions = 117,072 a day.
  // Now: 3 x 144 x D (6,480 at D = 20) plus about 144 x ceil(251/35) rotor.
  assert.ok(perDay <= 3 * 144 * D + 144 * 8, `steady-state definition reads per day ${perDay}`);
});

// ─── Contract and telemetry hygiene ──────────────────────────────────────────

test("contract constants: the sweep bound is the refresh bound plus one snapshot lifetime; the TTL outlives it", () => {
  assert.equal(BOOKING_STOP_DEFINITION_MAX_AGE_MS, 6 * HOUR);
  assert.equal(
    BOOKING_STOP_DEFINITION_SWEEP_MAX_AGE_MS,
    BOOKING_STOP_DEFINITION_MAX_AGE_MS + BOOKING_MEMBERSHIP_MAX_AGE_MS,
  );
  assert.ok(BOOKING_STOP_DEFINITION_CACHE_TTL_SECONDS * 1000 > BOOKING_STOP_DEFINITION_SWEEP_MAX_AGE_MS);
  assert.ok(BOOKING_STOP_DEFINITION_ROTOR_HORIZON_MS < BOOKING_STOP_DEFINITION_MAX_AGE_MS);
  assert.ok(BOOKING_STOP_DEFINITION_ROTOR_PHASE_MS <= 20 * 1000);
});

test("telemetry projection is counts-only and drops anything else", () => {
  const projected = definitionCacheTelemetry({
    state: "warm",
    write: "verified",
    durable: true,
    freshReads: 3,
    requiredReads: 2,
    rotorReads: 1,
    cacheHits: 7,
    writeAttempts: -1,
    oldestHitAgeMs: 1234.4,
    secret: "Fe26.2**cookie",
    ids: ["a"],
  });
  assert.deepEqual(projected, {
    state: "warm",
    write: "verified",
    durable: true,
    freshReads: 3,
    requiredReads: 2,
    rotorReads: 1,
    rotorPlanned: 0,
    rotorFailures: 0,
    cacheHits: 7,
    writeAttempts: 0,
    oldestHitAgeMs: 1234,
  });
  assert.equal(definitionCacheTelemetry(null), null);
  assert.equal(definitionCacheTelemetry({ state: "made-up" }).state, null);
  assert.equal(summarizeDefinitionCacheTelemetry([
    { durable: true }, { durable: false },
  ]).durable, false);
});

test("default KV reader/writer: an unconfigured store reads everything, reports read_error (strict reader), and skips the write", async () => {
  const h = harness();
  const { definitionCacheReader, definitionCacheWriter, ...rest } = h.options();
  assert.equal(typeof definitionCacheReader, "function");
  assert.equal(typeof definitionCacheWriter, "function");
  const scope = await discoverBookingStopSequences(rest); // defaults, no KV env in tests
  assert.equal(scope.definitionFreshReads, 5);
  // Strict: "unreachable" is never mistaken for "absent".
  assert.equal(scope.definitionCache.state, "read_error");
  // The merge re-read fails too, so nothing is written.
  assert.equal(scope.definitionCache.write, "failed");
});

// ─── Review regressions (PR 231 second review) ──────────────────────────────
// The sweep used to serve from the refresh's MUTABLE cache document, whose
// production reader (kvGet) turns a transport failure into "missing". These
// pin the replacement: the sweep serves only the write-once answers document
// of the published digest, and the refresh proves that document durable with
// a positive read-back.

const publishedDigestOf = (store) =>
  store.values.get(BOOKING_MEMBERSHIP_KEYS.current).scope.digest;

test("review: a KV blip on the mutable cache document during a refresh (null read-back, failed write) cannot split the refresh and sweep scopes", async () => {
  const h = harness();
  const store = memoryStore();
  assert.equal((await refreshOnce(h, store)).result.ok, true);
  h.state.definitions.linked01 = NO_LINK; // link removed, catalog unchanged
  h.state.now = T0 + BOOKING_STOP_DEFINITION_MAX_AGE_MS; // refresh must re-read it
  let readerCalls = 0;
  const run = await refreshOnce(h, store, {
    loaderOverrides: {
      definitionCacheReader: async () => {
        readerCalls += 1;
        return readerCalls === 1 ? clone(h.state.store.doc) : null;
      },
      definitionCacheWriter: async () => { throw new Error("kv write failed"); },
    },
  });
  assert.equal(run.result.ok, true, JSON.stringify(run.result));
  // The mutable document still says linked01 has a link ...
  assert.equal(h.state.store.doc.entries.linked01.l, true);
  // ... but the sweep never reads it: it serves the published answers.
  h.state.now += 5 * MIN;
  const sweep = await h.sweep(publishedDigestOf(store));
  assert.equal((await sweepAccepts(h, store, sweep)).ok, true);
  assert.equal(selectedIds(sweep).includes("linked01"), false);
});

test("review: a refresh that served a cached answer fails NOT_DURABLE when the answers read-back is unreachable, absent, or a lost write", async () => {
  for (const [label, setup] of [
    ["write fails, read-back null", (h) => {
      h.state.failAnswersWrite = true;
      h.state.failAnswersRead = () => null;
      return { definitionAnswersReader: async () => null };
    }],
    ["write fails, read-back throws", (h) => {
      h.state.failAnswersWrite = true;
      h.state.failAnswersRead = () => new Error("KV_UNAVAILABLE");
      return {};
    }],
    ["write silently lost", () => ({
      definitionAnswersWriter: async () => {},
    })],
  ]) {
    const h = harness();
    const store = memoryStore();
    await h.load(); // every servable answer read at T0
    h.state.now = T0 + 3 * HOUR; // the refresh serves them from cache
    const publishedBefore = clone(store.values.get(BOOKING_MEMBERSHIP_KEYS.current) ?? null);
    const error = await refreshOnce(h, store, {
      rotor: false,
      loaderOverrides: setup(h),
    }).catch((caught) => caught);
    assert.equal(error?.code, "BOOKING_STOP_DEFINITION_CACHE_NOT_DURABLE", label);
    assert.equal(error.definitionCache.durable, false, label);
    assert.deepEqual(store.values.get(BOOKING_MEMBERSHIP_KEYS.current) ?? null, publishedBefore, label);
  }
});

test("review: a load that served nothing does not need its answers stored, and the sweep then reads live and agrees", async () => {
  const h = harness();
  h.state.failAnswersWrite = true;
  const cold = await h.load({ definitionDurableAnswers: true }); // every answer a real read
  assert.equal(cold.definitionCache.durable, null);
  assert.equal(h.state.answers.size, 0);
  h.state.now += 7 * MIN;
  const sweep = await h.measure(() => h.sweep(cold.scopeDigest));
  assert.equal(sweep.reads.length, 5, "no published answers: every definition read live");
  assert.equal(sweep.out.definitionCache.state, "missing");
  assert.deepEqual(bindingOf(sweep.out), bindingOf(cold));
  // A refresh's second load serves the first load's reads (overlay), so a
  // publishing refresh does need them stored: it fails rather than publish.
  const store = memoryStore();
  const error = await refreshOnce(h, store).catch((caught) => caught);
  assert.equal(error?.code, "BOOKING_STOP_DEFINITION_CACHE_NOT_DURABLE");
});

test("review: one KV blip on the sweep's answers read is retried, and the sweep never touches the mutable cache document", async () => {
  const h = harness();
  const store = memoryStore();
  await h.load();
  h.state.definitions.linked01 = NO_LINK; // link removed, catalog unchanged
  h.state.now = T0 + 3 * HOUR;
  assert.equal((await refreshOnce(h, store, { rotor: false })).result.ok, true);
  h.state.now += 7 * MIN;
  let blips = 1;
  h.state.failAnswersRead = () => (blips-- > 0 ? new Error("KV_UNAVAILABLE") : null);
  const sweep = await h.measure(() => h.sweep(publishedDigestOf(store), {
    definitionCacheReader: async () => { throw new Error("the sweep must not read the cache document"); },
    definitionCacheWriter: async () => { throw new Error("the sweep must not write the cache document"); },
    definitionAnswersWriter: async () => { throw new Error("the sweep must not write answers"); },
  }));
  assert.deepEqual(sweep.reads, ["plain001"]);
  assert.equal(sweep.out.definitionCache.state, "warm");
  assert.equal(sweep.out.definitionCache.write, "not_needed");
  assert.equal((await sweepAccepts(h, store, sweep.out)).ok, true);
});

test("review: a slow writer clobbering the mutable document after the refresh publishes cannot make the next sweep fail closed", async () => {
  const h = harness();
  const store = memoryStore();
  await refreshOnce(h, store); // T0: everything read, published
  const stale = clone(h.state.store.doc); // linked01 {l: true, r: T0}
  h.state.definitions.linked01 = NO_LINK;
  h.state.now = T0 + BOOKING_STOP_DEFINITION_MAX_AGE_MS; // refresh re-reads linked01
  const refresh = await refreshOnce(h, store);
  assert.equal(refresh.result.ok, true);
  assert.equal(refresh.telemetry.durable, true);
  h.state.store.doc = stale; // a slower writer's merge lands last
  h.state.now += 7 * MIN;
  const next = await h.sweep(publishedDigestOf(store));
  assert.equal((await sweepAccepts(h, store, next)).ok, true);
  assert.equal(selectedIds(next).includes("linked01"), false);
});

test("review: answers are content-addressed, so a newer refresh's answers never leak into the sweep of an older published digest", async () => {
  const h = harness();
  const store = memoryStore();
  await h.load();
  h.state.definitions.linked01 = NO_LINK;
  h.state.now = T0 + 3 * HOUR;
  assert.equal((await refreshOnce(h, store, { rotor: false })).result.ok, true);
  const oldDigest = publishedDigestOf(store);
  // A later load reads linked01 (rename) and stores the narrower answer under
  // ITS digest; the published pointer still names the old one.
  h.state.rows[0].name = "Sourcing - Counsel v2";
  h.state.now += 2 * MIN;
  const later = await h.load({ definitionDurableAnswers: true });
  assert.notEqual(later.scopeDigest, oldDigest);
  h.state.rows[0].name = "Sourcing - Counsel";
  h.state.now += 5 * MIN;
  const sweep = await h.sweep(oldDigest);
  assert.equal((await sweepAccepts(h, store, sweep)).ok, true);
});

test("review: a catalog past the size cap switches the cache off, so an older under-cap document is never served and no refresh fails NOT_DURABLE", async () => {
  const count = BOOKING_STOP_DEFINITION_CACHE_MAX_ENTRIES - 24;
  const rows = Array.from({ length: count }, (_, index) => ({
    id: `row${String(index).padStart(5, "0")}`,
    name: `Row ${index}`,
    enabled: index < 10, // a few selected link-bearing rows, the rest disabled
  }));
  const definitions = Object.fromEntries(rows.map(({ id }) => [id, LINK]));
  const h = harness({ rows, definitions });
  const store = memoryStore();
  const warm = await refreshOnce(h, store);
  assert.equal(warm.result.ok, true);
  assert.equal(Object.keys(h.state.store.doc.entries).length, count);
  // The catalog grows past the cap and a cached answer changes.
  for (let index = count; index < BOOKING_STOP_DEFINITION_CACHE_MAX_ENTRIES + 6; index += 1) {
    const id = `row${String(index).padStart(5, "0")}`;
    h.state.rows.push({ id, name: `Row ${index}`, enabled: false });
    h.state.definitions[id] = NO_LINK;
  }
  h.state.definitions.row00020 = NO_LINK; // a served (disabled) answer changes
  h.state.now = T0 + BOOKING_STOP_DEFINITION_MAX_AGE_MS - 30 * MIN;
  const writesBefore = h.state.writes;
  const answersBefore = h.state.answersWrites;
  const run = await refreshOnce(h, store);
  assert.equal(run.result.ok, true, JSON.stringify(run.result));
  assert.deepEqual(run.telemetry.states, ["oversize", "oversize"]);
  assert.deepEqual(run.telemetry.writes, ["oversize", "oversize"]);
  assert.equal(run.telemetry.cacheHits, 0, "the old under-cap document is not served");
  assert.equal(h.state.writes, writesBefore);
  assert.equal(h.state.answersWrites, answersBefore);
  assert.equal(
    store.values.get(BOOKING_MEMBERSHIP_KEYS.current).scope.linkSequenceCount,
    count - 1,
    "the changed answer is read live",
  );
  const sweep = await h.measure(() => h.sweep(publishedDigestOf(store)));
  assert.equal(sweep.reads.length, h.state.rows.length);
  assert.equal((await sweepAccepts(h, store, sweep.out)).ok, true);
  const alert = definitionCacheAlert(run.telemetry);
  assert.equal(alert.key, "definition-cache-oversize");
  assert.match(alert.message, /switched off/u);
});

test("review: definitionCacheFits bounds entries and worst-case bytes", () => {
  const ids = (length, width = 8) =>
    Array.from({ length }, (_, index) => String(index).padStart(width, "0"));
  assert.equal(definitionCacheFits({ revision: "rev", ids: ids(271), nowMs: T0 }), true);
  assert.equal(definitionCacheFits({ revision: "rev", ids: ids(BOOKING_STOP_DEFINITION_CACHE_MAX_ENTRIES), nowMs: T0 }), true);
  assert.equal(definitionCacheFits({ revision: "rev", ids: ids(BOOKING_STOP_DEFINITION_CACHE_MAX_ENTRIES + 1), nowMs: T0 }), false);
  assert.equal(definitionCacheFits({ revision: "rev", ids: ids(900, 600), nowMs: T0 }), false, "byte cap");
});

test("review: the default answers reader throws on an unconfigured or unreachable store, so a refresh that served a cached answer fails NOT_DURABLE", async () => {
  const h = harness();
  await h.load();
  h.state.now = T0 + 3 * HOUR;
  const { definitionAnswersReader, definitionAnswersWriter, ...rest } = h.options();
  assert.equal(typeof definitionAnswersReader, "function");
  assert.equal(typeof definitionAnswersWriter, "function");
  const error = await discoverBookingStopSequences({
    ...rest,
    definitionDurableAnswers: true,
  }).catch((caught) => caught);
  assert.equal(error?.code, "BOOKING_STOP_DEFINITION_CACHE_NOT_DURABLE");
  await assert.rejects(() => kvGetStrict("seqguard:any"), { code: "KV_UNAVAILABLE" });
});
