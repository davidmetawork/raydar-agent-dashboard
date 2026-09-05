import assert from "node:assert/strict";
import test from "node:test";

import { factsFromProfile } from "../api/applicants/_lib/facts.mjs";
import { buildGeneration, readPublishedArtifacts, validPublication } from "../api/applicants/_lib/generation.mjs";
import { K } from "../api/applicants/_lib/kv.mjs";
import { sourceObservationIdFor } from "../api/applicants/_lib/profile-readiness.mjs";
import { sourceProfileDigest } from "../api/applicants/_lib/source-profile-digest.mjs";
import {
  FACTS_CAS_LUA,
  parseArgs,
  rebuildActiveFacts,
} from "../scripts/rebuild-applicant-facts.mjs";

const PROFILE_KEY = "core:aaaaaaaaaa";
const OBSERVATION_ID = "source-observation-1";

function sourceProfile() {
  return {
    profileSource: "applicant_hub",
    historyState: "data",
    sourceObservationId: OBSERVATION_ID,
    updatedAt: "2026-09-05T10:00:00.000Z",
    experiences: Array.from({ length: 16 }, (_, index) => ({
      companyId: `company-${index + 1}`,
      companyName: `Synthetic Company ${index + 1}`,
      roleTitle: "Engineer",
      start: `${2000 + index}-01-01`,
      end: `${2000 + index}-06-01`,
      current: false,
    })),
    education: [],
  };
}

function harness({ mutateOnEval = null } = {}) {
  const profile = sourceProfile();
  const receipt = {
    source: "applicant_hub",
    durable: true,
    historyState: "data",
    sourceObservationId: OBSERVATION_ID,
    payloadDigest: sourceProfileDigest(profile),
  };
  const row = {
    key: `${PROFILE_KEY}:role1`,
    profileKey: PROFILE_KEY,
    sourceObservationId: OBSERVATION_ID,
  };
  const generation = buildGeneration({
    generationId: "facts-rebuild-fixture",
    snapshot: { generatedAt: "2026-09-05T12:00:00.000Z", stream: [row], profilePreparing: 0 },
    queue: [],
    counts: { total: 1, stream: 1, queue: 0, profilePreparing: 0 },
    sourceCutoff: "fixture-cutoff",
    sourceWatermark: "fixture-watermark",
    publishedAt: "2026-09-05T12:00:00.000Z",
  });
  const strings = new Map([
    [K.activeGeneration, JSON.stringify(generation.pointer)],
    [`${K.generation(generation.pointer.generationId)}:snapshot`, JSON.stringify(generation.snapshot)],
    [`${K.generation(generation.pointer.generationId)}:queue`, JSON.stringify(generation.queue)],
    [`${K.generation(generation.pointer.generationId)}:counts`, JSON.stringify(generation.counts)],
    [K.sourceProfile(PROFILE_KEY), JSON.stringify(profile)],
  ]);
  const receipts = new Map([[PROFILE_KEY, JSON.stringify(receipt)]]);
  const facts = new Map();
  const commands = [];
  let mutated = false;

  const kvImpl = async (command) => {
    commands.push(command);
    const [operation, ...args] = command;
    if (operation === "GET") return strings.get(args[0]) ?? null;
    if (operation === "MGET") return args.map((key) => strings.get(key) ?? null);
    if (operation === "HMGET") return args.slice(1).map((field) => receipts.get(field) ?? null);
    if (operation === "HGET") {
      if (args[0] === K.sourceProfileReady) return receipts.get(args[1]) ?? null;
      if (args[0] === K.facts) return facts.get(args[1]) ?? null;
      return null;
    }
    if (operation === "EVAL") {
      assert.equal(args[0], FACTS_CAS_LUA);
      assert.equal(args[1], 4);
      if (!mutated && mutateOnEval) {
        mutated = true;
        mutateOnEval({ strings, receipts, profile, receipt });
      }
      const [profileRedisKey, receiptHash, factsHash, activeKey,
        field, expectedProfile, expectedReceipt, factsRaw, expectedActive] = args.slice(2);
      assert.equal(receiptHash, K.sourceProfileReady);
      assert.equal(factsHash, K.facts);
      if ((strings.get(profileRedisKey) ?? null) !== expectedProfile
        || (receipts.get(field) ?? null) !== expectedReceipt) return 0;
      if ((strings.get(activeKey) ?? null) !== expectedActive) return -1;
      facts.set(field, factsRaw);
      return 1;
    }
    throw new Error(`unexpected operation ${operation}`);
  };
  return { kvImpl, strings, receipts, facts, commands, profile, receipt };
}

const dependencies = {
  K,
  validPublication,
  readPublishedArtifacts,
  factsFromProfile,
  sourceProfileDigest,
  sourceObservationIdFor,
};

test("facts rebuild defaults to dry-run and rejects an ambiguous mode", () => {
  assert.deepEqual(parseArgs([]), { apply: false, help: false });
  assert.deepEqual(parseArgs(["--dry-run"]), { apply: false, help: false });
  assert.deepEqual(parseArgs(["--apply"]), { apply: true, help: false });
  assert.throws(() => parseArgs(["--apply", "--dry-run"]), /mode_conflict/);
});

test("dry-run stages only guarded active source profiles and performs no write command", async () => {
  const store = harness();
  const report = await rebuildActiveFacts({ apply: false, kvImpl: store.kvImpl, ...dependencies });
  assert.equal(report.mode, "dry-run");
  assert.equal(report.targetCount, 1);
  assert.equal(report.eligibleCount, 1);
  assert.equal(report.attemptedCount, 0);
  assert.equal(store.facts.size, 0);
  assert.equal(store.commands.some(([operation]) => operation === "EVAL" || operation === "HSET"), false);
  assert.match(report.targetSetDigest, /^[a-f0-9]{64}$/);
  assert.match(report.stagedFactsDigest, /^[a-f0-9]{64}$/);
});

test("dry-run skips a source whose observation or stored payload digest is not exact", async (t) => {
  await t.test("observation mismatch", async () => {
    const store = harness();
    store.receipts.set(PROFILE_KEY, JSON.stringify({
      ...store.receipt,
      sourceObservationId: "source-observation-2",
    }));
    const report = await rebuildActiveFacts({ apply: false, kvImpl: store.kvImpl, ...dependencies });
    assert.equal(report.eligibleCount, 0);
    assert.equal(report.skipped.observation_mismatch, 1);
  });
  await t.test("payload digest mismatch", async () => {
    const store = harness();
    store.receipts.set(PROFILE_KEY, JSON.stringify({
      ...store.receipt,
      payloadDigest: "f".repeat(64),
    }));
    const report = await rebuildActiveFacts({ apply: false, kvImpl: store.kvImpl, ...dependencies });
    assert.equal(report.eligibleCount, 0);
    assert.equal(report.skipped.profile_digest_mismatch, 1);
  });
});

test("apply writes only facts and reads back the complete allCompanies projection", async () => {
  const store = harness();
  const report = await rebuildActiveFacts({ apply: true, kvImpl: store.kvImpl, ...dependencies });
  assert.equal(report.writtenCount, 1);
  assert.equal(report.readbackVerifiedCount, 1);
  assert.equal(report.sourceRaceCount, 0);
  const written = JSON.parse(store.facts.get(PROFILE_KEY));
  assert.equal(written.jobs.length, 14);
  assert.equal(written.allCompanies.length, 16);
  const evalCommand = store.commands.find(([operation]) => operation === "EVAL");
  assert.equal(evalCommand[5], K.facts);
  assert.equal(store.commands.some(([operation]) => operation === "SET" || operation === "HSET"), false);
});

for (const [label, mutate] of [
  ["source profile", ({ strings, profile }) => {
    strings.set(K.sourceProfile(PROFILE_KEY), JSON.stringify({ ...profile, title: "New publisher value" }));
  }],
  ["source receipt", ({ receipts, receipt }) => {
    receipts.set(PROFILE_KEY, JSON.stringify({ ...receipt, sourceObservationId: "source-observation-2" }));
  }],
]) {
  test(`apply loses the CAS when an intermediate publisher changes the raw ${label}`, async () => {
    const store = harness({ mutateOnEval: mutate });
    const report = await rebuildActiveFacts({ apply: true, kvImpl: store.kvImpl, ...dependencies });
    assert.equal(report.writtenCount, 0);
    assert.equal(report.sourceRaceCount, 1);
    assert.equal(report.readbackVerifiedCount, 0);
    assert.equal(store.facts.size, 0);
  });
}

test("apply loses the CAS when the active generation changes before the write", async () => {
  const store = harness({
    mutateOnEval: ({ strings }) => strings.set(K.activeGeneration, JSON.stringify({ replaced: true })),
  });
  const report = await rebuildActiveFacts({ apply: true, kvImpl: store.kvImpl, ...dependencies });
  assert.equal(report.writtenCount, 0);
  assert.equal(report.generationRaceCount, 1);
  assert.equal(store.facts.size, 0);
});
