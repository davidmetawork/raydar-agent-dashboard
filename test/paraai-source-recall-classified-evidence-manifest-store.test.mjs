import assert from "node:assert/strict";
import {
  createHash,
} from "node:crypto";
import {
  readFile,
  readdir,
} from "node:fs/promises";
import test from "node:test";

import {
  SOURCE_RECALL_CLASSIFIED_EVIDENCE_MANIFEST_SHARD_SIZE,
  SOURCE_RECALL_CLASSIFIED_EVIDENCE_MANIFEST_STORE_VERSION,
  SourceRecallClassifiedEvidenceManifestStoreError,
  sourceRecallClassifiedEvidenceManifestInitializationShape,
  sourceRecallClassifiedEvidenceManifestPlan,
} from "../api/paraai/_lib/source-recall-classified-evidence-manifest-store.mjs";

function canonicalJson(value) {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  if (typeof value === "number") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  return `{${Object.keys(value).sort().map(
    (key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`,
  ).join(",")}}`;
}

function digest(value) {
  return createHash("sha256")
    .update(String(value), "utf8")
    .digest("hex");
}

function semanticDigest(domain, value) {
  return createHash("sha256")
    .update(domain, "utf8")
    .update("\0", "utf8")
    .update(canonicalJson(value), "utf8")
    .digest("hex");
}

function member(index) {
  return {
    outcome: "stable",
    pageNumber: Math.floor(index / 100) + 1,
    readsCompleted: 2,
    referenceDigest: digest(`reference:${index}`),
    referenceIdDigest: digest(`reference-id:${index}`),
    referenceOrdinal: index % 100,
    resolutionDigest: digest(`resolution:${index}`),
    workItemDigest: digest(`work-item:${index}`),
    workKeyDigest: digest(`work-key:${index}`),
  };
}

function seed(memberCount) {
  const members = Array.from(
    { length: memberCount },
    (_, index) => member(index),
  );
  return {
    completeProofDigest: digest("complete-proof"),
    contractPinsDigest: digest("contract-pins"),
    decisionBoundaryAtMs:
      Date.parse("2026-07-29T00:00:00.000Z"),
    headPageSetDigest: digest("head-page-set"),
    indexedManifestDigest: digest("indexed-manifest"),
    issuedFromRedisAtMs:
      Date.parse("2026-07-29T01:00:00.000Z"),
    manifestKeyDigest: digest("manifest-key"),
    memberSetDigest: semanticDigest(
      "phase4-recall-classified-manifest-members-v1",
      members,
    ),
    members,
    notAfterMs:
      Date.parse("2026-07-30T00:00:00.000Z"),
    pageCount: Math.max(1, Math.ceil(memberCount / 100)),
    recallReferenceHeadEpochDigest:
      digest("head-epoch"),
    recallReferenceHeadRecordDigest:
      digest("head-record"),
    recallReferenceHeadRevisionDigest:
      digest("head-revision"),
    referenceCount: memberCount,
    referenceManifestDigest:
      digest("reference-manifest"),
    scannedCount: memberCount,
    settledReadsCompleted: memberCount * 2,
    stablePassSemanticDigest: digest("stable-pass"),
    version: "recall-classified-manifest-seed-dark-v1",
    workKeyDigest: digest("manifest-work-key"),
  };
}

function expectCode(code) {
  return (error) => {
    assert.equal(
      error instanceof
        SourceRecallClassifiedEvidenceManifestStoreError,
      true,
    );
    assert.equal(error.code, code);
    return true;
  };
}

test("the full Recall classified plan uses exact twenty-member digest-only shards", () => {
  const plan =
    sourceRecallClassifiedEvidenceManifestPlan(seed(21));
  assert.equal(
    SOURCE_RECALL_CLASSIFIED_EVIDENCE_MANIFEST_STORE_VERSION,
    "recall-classified-evidence-manifest-store-dark-v1",
  );
  assert.equal(
    SOURCE_RECALL_CLASSIFIED_EVIDENCE_MANIFEST_SHARD_SIZE,
    20,
  );
  assert.equal(plan.memberCount, 21);
  assert.equal(plan.shardCount, 2);
  assert.deepEqual(
    plan.shards.map(
      (shard) => shard.descriptor.memberCount,
    ),
    [20, 1],
  );
  assert.deepEqual(
    plan.shards.map(
      (shard) => shard.descriptor.firstMemberOrdinal,
    ),
    [0, 20],
  );
  assert.equal(
    new Set(
      plan.shardIndex.map(
        (descriptor) => descriptor.shardKeyDigest,
      ),
    ).size,
    2,
  );
  const serialized = JSON.stringify(plan);
  assert.doesNotMatch(
    serialized,
    /candidate|email|linkedin|transcript|responseBody/u,
  );
  assert.match(
    plan.manifestStorageDigest,
    /^[a-f0-9]{64}$/u,
  );
  assert.equal(
    sourceRecallClassifiedEvidenceManifestPlan(seed(21))
      .manifestStorageDigest,
    plan.manifestStorageDigest,
  );
});

test("the maximum 20,000-member universe stays bounded to 1,000 shards and compact member tuples fit the reviewed request envelope", () => {
  const plan =
    sourceRecallClassifiedEvidenceManifestPlan(seed(20_000));
  assert.equal(plan.memberCount, 20_000);
  assert.equal(plan.shardCount, 1_000);
  assert.equal(
    Math.max(
      ...plan.shards.map(
        (shard) => shard.memberIndex.length,
      ),
    ),
    20,
  );
  const shape =
    sourceRecallClassifiedEvidenceManifestInitializationShape(
      seed(20_000),
    );
  assert.equal(shape.shardCount, 1_000);
  assert.ok(shape.indexBytes < 256 * 1_024);
  assert.ok(shape.maxShardBytes < 256 * 1_024);
  assert.ok(
    shape.inputBytes
      < 9 * 1_024 * 1_024 - 64 * 1_024,
  );
});

test("plain seed validation rejects sparse, proxied, duplicate, and over-bound member universes", () => {
  const sparse = seed(2);
  delete sparse.members[0];
  for (const value of [
    new Proxy(seed(1), {}),
    sparse,
    {
      ...seed(2),
      members: [
        member(0),
        member(0),
      ],
    },
    seed(20_001),
  ]) {
    assert.throws(
      () =>
        sourceRecallClassifiedEvidenceManifestPlan(value),
      expectCode(
        "SOURCE_RECALL_CLASSIFIED_EVIDENCE_MANIFEST_SEED_INVALID",
      ),
    );
  }
});

async function productionFiles(directory) {
  const entries = await readdir(directory, {
    withFileTypes: true,
  });
  const files = [];
  for (const entry of entries) {
    const child = new URL(
      `${entry.name}${entry.isDirectory() ? "/" : ""}`,
      directory,
    );
    if (entry.isDirectory()) {
      files.push(...await productionFiles(child));
    } else if (/\.(?:mjs|js|ts)$/u.test(entry.name)) {
      files.push(child);
    }
  }
  return files;
}

test("the full-manifest store remains a hard-dark private leaf with no route, worker, coordinator, health, or gate importer", async () => {
  const libraryRoot = new URL(
    "../api/paraai/_lib/",
    import.meta.url,
  );
  const storeUrl = new URL(
    "source-recall-classified-evidence-manifest-store.mjs",
    libraryRoot,
  );
  const source = await readFile(storeUrl, "utf8");
  assert.doesNotMatch(source, /\bconsole\./u);
  assert.doesNotMatch(
    source,
    /PARAAI_(?:CURATE_ENABLED|ENROLL_APPROVED|MATCH_STAGE_ENABLED)/u,
  );
  assert.doesNotMatch(
    source,
    /source-(?:capture-coordinator|authority-store|watermark)/u,
  );
  assert.doesNotMatch(source, /phase4-curation/u);
  const files = await productionFiles(
    new URL("../api/paraai/", import.meta.url),
  );
  const importers = [];
  for (const file of files) {
    if (file.href === storeUrl.href) continue;
    const candidate = await readFile(file, "utf8");
    if (
      candidate.includes(
        "source-recall-classified-evidence-manifest-store",
      )
    ) {
      importers.push(file.pathname);
    }
  }
  assert.deepEqual(importers, []);
});
