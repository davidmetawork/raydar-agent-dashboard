// Private, hard-dark full-manifest assembly for retained Recall
// classification evidence.
//
// One point-manifest seed is consumed exactly once to atomically persist a
// digest-only member index split into bounded HMAC-sealed plan shards. Later
// calls select only the next durable shard, re-prove each immutable retained
// member through the leaf store, and compare-and-set the shard plus index.
// Completion re-reads and verifies every retained shard before sealing a root.
//
// A completed Recall manifest proves only Recall reference coverage and
// success/failure classification durability. Identity, Q37, pinnability,
// source authority, curation, enrollment, outreach, operational readiness,
// and every candidate-facing write remain false. This module has no route,
// worker, coordinator, health, source-tick, or gate importer.

import {
  createHash,
  createHmac,
  timingSafeEqual,
} from "node:crypto";
import {
  types as nodeTypes,
} from "node:util";

import {
  SOURCE_RECALL_CLASSIFIED_EVIDENCE_EXPIRY_SAFETY_MARGIN_MS,
  createSourceRecallClassifiedEvidencePersistenceAdapter,
} from "./source-recall-classified-evidence-persistence-adapter.mjs";
import {
  SOURCE_RECALL_CLASSIFIED_EVIDENCE_SEAL_ENV,
  canonicalizeSourceRecallClassifiedManifestSeed,
  sourceRecallClassifiedEvidenceRetentionKey,
  verifySourceRecallClassifiedEvidenceRecordAgainstMember,
} from "./source-recall-classified-evidence-store.mjs";
import {
  consumeSourceRecallClassifiedManifestSeedCapability,
} from "./source-recall-point-observation-manifest-store.mjs";

export const
SOURCE_RECALL_CLASSIFIED_EVIDENCE_MANIFEST_STORE_VERSION =
  "recall-classified-evidence-manifest-store-dark-v1";
export const
SOURCE_RECALL_CLASSIFIED_EVIDENCE_MANIFEST_RECORD_VERSION = 1;
export const
SOURCE_RECALL_CLASSIFIED_EVIDENCE_MANIFEST_SHARD_VERSION = 1;
export const
SOURCE_RECALL_CLASSIFIED_EVIDENCE_MANIFEST_SHARD_SIZE = 20;

const SOURCE = "recall";
const MAX_MEMBERS = 20_000;
const MAX_SHARDS = Math.ceil(
  MAX_MEMBERS
    / SOURCE_RECALL_CLASSIFIED_EVIDENCE_MANIFEST_SHARD_SIZE,
);
const MAX_RAW_BYTES = 256 * 1_024;
const DIGEST = /^[a-f0-9]{64}$/u;
const INDEX_PREFIX =
  "paraai:phase4:recall-classified-evidence:v1:manifest:";
const SEAL_VERSION =
  "recall-classified-evidence-manifest-hmac-sha256-v1";
const SEAL_KEY_ID_DOMAIN =
  "recall-classified-evidence-manifest-seal-key-id-v1";
const FACTORY_KEYS = Object.freeze([
  "persistence",
  "sealSecret",
]);
const PERSISTENCE_METHODS = Object.freeze([
  "compareAndSet",
  "initializeManifest",
  "read",
  "readMany",
]);
const PERSISTENCE_ALLOWED_METHODS = new Set([
  ...PERSISTENCE_METHODS,
  "retain",
]);
const MEMBER_KEYS = Object.freeze([
  "outcome",
  "pageNumber",
  "readsCompleted",
  "referenceDigest",
  "referenceIdDigest",
  "referenceOrdinal",
  "resolutionDigest",
  "workItemDigest",
  "workKeyDigest",
]);
const INDEXED_MEMBER_KEYS = Object.freeze([
  "memberOrdinal",
  ...MEMBER_KEYS,
]);
const DESCRIPTOR_KEYS = Object.freeze([
  "firstMemberOrdinal",
  "memberCount",
  "memberIndexDigest",
  "shardKeyDigest",
  "shardNumber",
]);
const MEMBER_PROOF_KEYS = Object.freeze([
  "classification",
  "classificationEvidenceDigest",
  "classificationProofComplete",
  "logicalExpiresAtMs",
  "memberPageNumber",
  "memberReferenceDigest",
  "memberReferenceIdDigest",
  "memberReferenceOrdinal",
  "observedExpiresAtMs",
  "recordDigest",
  "recordSeal",
  "sealKeyId",
  "settlementStatus",
  "version",
  "workItemDigest",
  "workKeyDigest",
]);
const FALSE_FLAGS = Object.freeze([
  "authorityAvailable",
  "candidateFacingWriteAvailable",
  "candidateIdentityResolutionAvailable",
  "curationAvailable",
  "enrollmentAvailable",
  "operational",
  "outreachAvailable",
  "pinnable",
  "q37TransitionAvailable",
]);
const INDEX_KEYS = Object.freeze([
  "authorityAvailable",
  "candidateFacingWriteAvailable",
  "candidateIdentityResolutionAvailable",
  "completeProofDigest",
  "completeRootDigest",
  "completedShards",
  "contractPinsDigest",
  "curationAvailable",
  "decisionBoundaryAtMs",
  "durableAttestationAvailable",
  "enrollmentAvailable",
  "expiresAtMs",
  "globalReferenceSetCoverageAvailable",
  "kind",
  "manifestIssuedFromRedisAtMs",
  "manifestKeyDigest",
  "manifestNotAfterMs",
  "manifestStorageDigest",
  "memberCount",
  "memberIndexDigest",
  "memberSetDigest",
  "nextShardNumber",
  "operational",
  "outreachAvailable",
  "pinnable",
  "policyVersion",
  "q37TransitionAvailable",
  "recordSeal",
  "referenceManifestCoverageComplete",
  "referenceManifestDigest",
  "revision",
  "sealKeyId",
  "sealVersion",
  "shardCount",
  "shardIndex",
  "shardIndexDigest",
  "shardSize",
  "source",
  "sourceFactsAvailable",
  "status",
  "successClassificationAvailable",
  "terminalFailureCount",
  "terminalSuccessCount",
  "version",
  "workKeyDigest",
]);
const SHARD_KEYS = Object.freeze([
  "authorityAvailable",
  "candidateFacingWriteAvailable",
  "candidateIdentityResolutionAvailable",
  "classificationDigest",
  "curationAvailable",
  "enrollmentAvailable",
  "expiresAtMs",
  "kind",
  "manifestKeyDigest",
  "manifestStorageDigest",
  "memberCount",
  "memberIndex",
  "memberIndexDigest",
  "memberProofs",
  "operational",
  "outreachAvailable",
  "pinnable",
  "policyVersion",
  "q37TransitionAvailable",
  "recordSeal",
  "sealKeyId",
  "sealVersion",
  "shardContentDigest",
  "shardKeyDigest",
  "shardNumber",
  "source",
  "status",
  "terminalFailureCount",
  "terminalSuccessCount",
  "version",
]);
const WORK_KEYS = Object.freeze([
  "manifestStorageDigest",
]);

export class SourceRecallClassifiedEvidenceManifestStoreError
  extends Error {
  constructor(code) {
    super(code);
    this.name =
      "SourceRecallClassifiedEvidenceManifestStoreError";
    this.code = code;
  }
}

function fail(code) {
  throw new SourceRecallClassifiedEvidenceManifestStoreError(
    code,
  );
}

function deepFreeze(value) {
  if (
    value
    && typeof value === "object"
    && !Object.isFrozen(value)
  ) {
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

function canonicalJson(value) {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  if (
    typeof value === "number"
    && Number.isSafeInteger(value)
    && !Object.is(value, -0)
  ) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (
    value
    && typeof value === "object"
    && !nodeTypes.isProxy(value)
  ) {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => (
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    )).join(",")}}`;
  }
  fail(
    "SOURCE_RECALL_CLASSIFIED_EVIDENCE_MANIFEST_RECORD_INVALID",
  );
}

function plainRecordSnapshot(value, code) {
  if (
    value === null
    || typeof value !== "object"
    || Array.isArray(value)
    || nodeTypes.isProxy(value)
  ) {
    fail(code);
  }
  const prototype = Object.getPrototypeOf(value);
  if (
    prototype !== Object.prototype
    && prototype !== null
  ) {
    fail(code);
  }
  if (Object.getOwnPropertySymbols(value).length !== 0) {
    fail(code);
  }
  const snapshot = Object.create(null);
  for (const [key, descriptor] of Object.entries(
    Object.getOwnPropertyDescriptors(value),
  )) {
    if (
      !Object.prototype.hasOwnProperty.call(
        descriptor,
        "value",
      )
      || descriptor.enumerable !== true
    ) {
      fail(code);
    }
    snapshot[key] = descriptor.value;
  }
  return snapshot;
}

function exactRecord(value, keys, code) {
  const record = plainRecordSnapshot(value, code);
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length
    || actual.some(
      (key, index) => key !== expected[index],
    )
  ) {
    fail(code);
  }
  return record;
}

function exactDigest(value, code) {
  if (typeof value !== "string" || !DIGEST.test(value)) {
    fail(code);
  }
  return value;
}

function exactTimestamp(value, code) {
  if (
    !Number.isSafeInteger(value)
    || Object.is(value, -0)
    || value <= 0
  ) {
    fail(code);
  }
  return value;
}

function exactNonnegativeInteger(value, code) {
  if (
    !Number.isSafeInteger(value)
    || Object.is(value, -0)
    || value < 0
  ) {
    fail(code);
  }
  return value;
}

function semanticDigest(domain, value) {
  return createHash("sha256")
    .update(domain, "utf8")
    .update("\0", "utf8")
    .update(canonicalJson(value), "utf8")
    .digest("hex");
}

function sealSecret(value) {
  const code =
    "SOURCE_RECALL_CLASSIFIED_EVIDENCE_MANIFEST_CONFIGURATION_INVALID";
  if (
    typeof value !== "string"
    || value.includes("\0")
    || Buffer.byteLength(value, "utf8") < 32
    || Buffer.byteLength(value, "utf8") > 4_096
  ) {
    fail(code);
  }
  return value;
}

function sealKeyId(secret) {
  return createHash("sha256")
    .update(`${SEAL_KEY_ID_DOMAIN}\0`, "utf8")
    .update(secret, "utf8")
    .digest("hex");
}

function recordSeal(unsigned, secret) {
  return createHmac("sha256", secret)
    .update(`${SEAL_VERSION}\0`, "utf8")
    .update(canonicalJson(unsigned), "utf8")
    .digest("hex");
}

function safeSealEqual(actual, expected) {
  if (!DIGEST.test(actual) || !DIGEST.test(expected)) {
    return false;
  }
  return timingSafeEqual(
    Buffer.from(actual, "hex"),
    Buffer.from(expected, "hex"),
  );
}

function sealed(unsigned, secret) {
  return deepFreeze({
    ...unsigned,
    recordSeal: recordSeal(unsigned, secret),
  });
}

function manifestStorageDigest(seed) {
  return semanticDigest(
    "phase4-recall-classified-evidence-manifest-storage-v1",
    {
      policyVersion:
        SOURCE_RECALL_CLASSIFIED_EVIDENCE_MANIFEST_STORE_VERSION,
      completeProofDigest: seed.completeProofDigest,
      manifestKeyDigest: seed.manifestKeyDigest,
      memberSetDigest: seed.memberSetDigest,
      referenceManifestDigest:
        seed.referenceManifestDigest,
      workKeyDigest: seed.workKeyDigest,
    },
  );
}

function indexKey(storageDigest) {
  return `${INDEX_PREFIX}{${storageDigest}}:index`;
}

function shardKey(storageDigest, shardNumber) {
  return `${indexKey(storageDigest)}:shard:${shardNumber}`;
}

function canonicalMember(value, code) {
  const member = exactRecord(value, MEMBER_KEYS, code);
  for (const field of [
    "referenceDigest",
    "referenceIdDigest",
    "resolutionDigest",
    "workItemDigest",
    "workKeyDigest",
  ]) {
    exactDigest(member[field], code);
  }
  exactTimestamp(member.pageNumber, code);
  exactNonnegativeInteger(member.referenceOrdinal, code);
  if (
    member.outcome !== "stable"
    || member.readsCompleted !== 2
  ) {
    fail(code);
  }
  return deepFreeze({ ...member });
}

function canonicalIndexedMember(value, code) {
  const indexed = exactRecord(
    value,
    INDEXED_MEMBER_KEYS,
    code,
  );
  const member = canonicalMember(
    Object.fromEntries(
      MEMBER_KEYS.map((key) => [key, indexed[key]]),
    ),
    code,
  );
  const memberOrdinal = exactNonnegativeInteger(
    indexed.memberOrdinal,
    code,
  );
  return deepFreeze({
    memberOrdinal,
    ...member,
  });
}

function encodedIndexedMember(value) {
  return [
    value.memberOrdinal,
    value.pageNumber,
    value.referenceOrdinal,
    value.referenceDigest,
    value.referenceIdDigest,
    value.resolutionDigest,
    value.workItemDigest,
    value.workKeyDigest,
  ];
}

function decodedIndexedMember(value, code) {
  if (
    !Array.isArray(value)
    || value.length !== 8
    || Object.keys(value).length !== 8
  ) {
    fail(code);
  }
  return canonicalIndexedMember({
    memberOrdinal: value[0],
    pageNumber: value[1],
    referenceOrdinal: value[2],
    referenceDigest: value[3],
    referenceIdDigest: value[4],
    resolutionDigest: value[5],
    workItemDigest: value[6],
    workKeyDigest: value[7],
    outcome: "stable",
    readsCompleted: 2,
  }, code);
}

export function sourceRecallClassifiedEvidenceManifestPlan(
  seedValue,
) {
  const code =
    "SOURCE_RECALL_CLASSIFIED_EVIDENCE_MANIFEST_SEED_INVALID";
  let seed;
  try {
    seed =
      canonicalizeSourceRecallClassifiedManifestSeed(
        seedValue,
      );
  } catch {
    fail(code);
  }
  if (seed.members.length > MAX_MEMBERS) fail(code);
  const storageDigest = manifestStorageDigest(seed);
  const shards = [];
  for (
    let offset = 0, shardNumber = 0;
    offset < seed.members.length;
    offset +=
      SOURCE_RECALL_CLASSIFIED_EVIDENCE_MANIFEST_SHARD_SIZE,
    shardNumber += 1
  ) {
    const memberIndex = seed.members
      .slice(
        offset,
        offset
          + SOURCE_RECALL_CLASSIFIED_EVIDENCE_MANIFEST_SHARD_SIZE,
      )
      .map((member, index) => deepFreeze({
        memberOrdinal: offset + index,
        ...member,
      }));
    const memberIndexDigest = semanticDigest(
      "phase4-recall-classified-evidence-manifest-shard-members-v1",
      memberIndex,
    );
    const shardKeyDigest = semanticDigest(
      "phase4-recall-classified-evidence-manifest-shard-key-v1",
      {
        manifestStorageDigest: storageDigest,
        memberIndexDigest,
        shardNumber,
      },
    );
    shards.push(deepFreeze({
      descriptor: deepFreeze({
        firstMemberOrdinal: offset,
        memberCount: memberIndex.length,
        memberIndexDigest,
        shardKeyDigest,
        shardNumber,
      }),
      memberIndex,
    }));
  }
  if (shards.length > MAX_SHARDS) fail(code);
  const shardIndex = shards.map(
    ({ descriptor }) => descriptor,
  );
  return deepFreeze({
    manifestStorageDigest: storageDigest,
    memberCount: seed.members.length,
    memberIndexDigest: semanticDigest(
      "phase4-recall-classified-evidence-manifest-members-v1",
      shards.flatMap((shard) => shard.memberIndex),
    ),
    shardCount: shards.length,
    shardIndex,
    shardIndexDigest: semanticDigest(
      "phase4-recall-classified-evidence-manifest-shard-index-v1",
      shardIndex,
    ),
    shardSize:
      SOURCE_RECALL_CLASSIFIED_EVIDENCE_MANIFEST_SHARD_SIZE,
    shards,
  });
}

function falseFlags() {
  return Object.fromEntries(
    FALSE_FLAGS.map((key) => [key, false]),
  );
}

function indexUnsigned(seed, plan, secret) {
  const complete = plan.shardCount === 0;
  return {
    version:
      SOURCE_RECALL_CLASSIFIED_EVIDENCE_MANIFEST_RECORD_VERSION,
    policyVersion:
      SOURCE_RECALL_CLASSIFIED_EVIDENCE_MANIFEST_STORE_VERSION,
    kind: "recall_classified_evidence_manifest_dark",
    source: SOURCE,
    status: complete
      ? "complete_dark"
      : "assembling_dark",
    revision: 0,
    manifestStorageDigest: plan.manifestStorageDigest,
    manifestKeyDigest: seed.manifestKeyDigest,
    workKeyDigest: seed.workKeyDigest,
    contractPinsDigest: seed.contractPinsDigest,
    decisionBoundaryAtMs: seed.decisionBoundaryAtMs,
    referenceManifestDigest:
      seed.referenceManifestDigest,
    completeProofDigest: seed.completeProofDigest,
    memberSetDigest: seed.memberSetDigest,
    manifestIssuedFromRedisAtMs:
      seed.issuedFromRedisAtMs,
    manifestNotAfterMs: seed.notAfterMs,
    expiresAtMs: seed.notAfterMs,
    memberCount: plan.memberCount,
    memberIndexDigest: plan.memberIndexDigest,
    shardSize: plan.shardSize,
    shardCount: plan.shardCount,
    shardIndex: plan.shardIndex,
    shardIndexDigest: plan.shardIndexDigest,
    nextShardNumber: 0,
    completedShards: 0,
    terminalSuccessCount: 0,
    terminalFailureCount: 0,
    completeRootDigest: complete
      ? semanticDigest(
        "phase4-recall-classified-evidence-manifest-root-v1",
        [],
      )
      : null,
    sealVersion: SEAL_VERSION,
    sealKeyId: sealKeyId(secret),
    durableAttestationAvailable: complete,
    referenceManifestCoverageComplete: complete,
    globalReferenceSetCoverageAvailable: complete,
    sourceFactsAvailable: complete,
    successClassificationAvailable: complete,
    ...falseFlags(),
  };
}

function shardContentMaterial(record) {
  const {
    recordSeal: _recordSeal,
    shardContentDigest: _shardContentDigest,
    ...material
  } = record;
  return material;
}

function shardUnsigned(
  seed,
  plan,
  selected,
  secret,
) {
  const descriptor = selected.descriptor;
  const base = {
    version:
      SOURCE_RECALL_CLASSIFIED_EVIDENCE_MANIFEST_SHARD_VERSION,
    policyVersion:
      SOURCE_RECALL_CLASSIFIED_EVIDENCE_MANIFEST_STORE_VERSION,
    kind:
      "recall_classified_evidence_manifest_shard_dark",
    source: SOURCE,
    status: "planned_dark",
    manifestStorageDigest: plan.manifestStorageDigest,
    manifestKeyDigest: seed.manifestKeyDigest,
    shardNumber: descriptor.shardNumber,
    shardKeyDigest: descriptor.shardKeyDigest,
    memberCount: descriptor.memberCount,
    memberIndexDigest: descriptor.memberIndexDigest,
    memberIndex: selected.memberIndex.map(
      encodedIndexedMember,
    ),
    memberProofs: null,
    classificationDigest: null,
    terminalSuccessCount: 0,
    terminalFailureCount: 0,
    expiresAtMs: seed.notAfterMs,
    sealVersion: SEAL_VERSION,
    sealKeyId: sealKeyId(secret),
    ...falseFlags(),
  };
  return {
    ...base,
    shardContentDigest: semanticDigest(
      "phase4-recall-classified-evidence-manifest-shard-content-v1",
      base,
    ),
  };
}

// Validation-only maximum-shape accounting. It returns counts and byte sizes,
// never records, keys, capabilities, or a usable seal.
export function sourceRecallClassifiedEvidenceManifestInitializationShape(
  seedValue,
) {
  const seed =
    canonicalizeSourceRecallClassifiedManifestSeed(
      seedValue,
    );
  const plan =
    sourceRecallClassifiedEvidenceManifestPlan(seed);
  const measurementSecret =
    "classified-manifest-byte-measurement-only";
  const indexRaw = canonicalJson(sealed(
    indexUnsigned(seed, plan, measurementSecret),
    measurementSecret,
  ));
  const shardRaws = plan.shards.map(
    (shard) => canonicalJson(sealed(
      shardUnsigned(
        seed,
        plan,
        shard,
        measurementSecret,
      ),
      measurementSecret,
    )),
  );
  const inputBytes = Buffer.byteLength(
    JSON.stringify({
      index: {
        key: indexKey(plan.manifestStorageDigest),
        proposedRaw: indexRaw,
      },
      shards: shardRaws.map(
        (proposedRaw, shardNumber) => ({
          key: shardKey(
            plan.manifestStorageDigest,
            shardNumber,
          ),
          proposedRaw,
        }),
      ),
      issuedAtMs: seed.issuedFromRedisAtMs,
      notAfterMs: seed.notAfterMs,
      expiresAtMs: seed.notAfterMs,
    }),
    "utf8",
  );
  return deepFreeze({
    indexBytes: Buffer.byteLength(indexRaw, "utf8"),
    inputBytes,
    maxShardBytes: shardRaws.length === 0
      ? 0
      : Math.max(
        ...shardRaws.map(
          (raw) => Buffer.byteLength(raw, "utf8"),
        ),
      ),
    shardCount: shardRaws.length,
  });
}

function retainedShardUnsigned(
  shard,
  proofs,
) {
  const terminalSuccessCount = proofs.filter(
    (proof) => proof.classification === "success",
  ).length;
  const terminalFailureCount =
    proofs.length - terminalSuccessCount;
  const classificationDigest = semanticDigest(
    "phase4-recall-classified-evidence-manifest-shard-classifications-v1",
    proofs,
  );
  const next = {
    ...shard,
    status: "retained_dark",
    expiresAtMs: Math.min(
      shard.expiresAtMs,
      ...proofs.map(
        (proof) => proof.logicalExpiresAtMs,
      ),
    ),
    memberProofs: proofs,
    classificationDigest,
    terminalSuccessCount,
    terminalFailureCount,
  };
  delete next.recordSeal;
  next.shardContentDigest = semanticDigest(
    "phase4-recall-classified-evidence-manifest-shard-content-v1",
    shardContentMaterial(next),
  );
  return next;
}

function canonicalDescriptor(value, index, code) {
  const descriptor = exactRecord(
    value,
    DESCRIPTOR_KEYS,
    code,
  );
  for (const field of [
    "memberIndexDigest",
    "shardKeyDigest",
  ]) {
    exactDigest(descriptor[field], code);
  }
  const shardNumber = exactNonnegativeInteger(
    descriptor.shardNumber,
    code,
  );
  const firstMemberOrdinal = exactNonnegativeInteger(
    descriptor.firstMemberOrdinal,
    code,
  );
  const memberCount = exactTimestamp(
    descriptor.memberCount,
    code,
  );
  if (
    shardNumber !== index
    || memberCount
      > SOURCE_RECALL_CLASSIFIED_EVIDENCE_MANIFEST_SHARD_SIZE
    || (
      index === 0
        ? firstMemberOrdinal !== 0
        : firstMemberOrdinal < 1
    )
  ) {
    fail(code);
  }
  return deepFreeze({ ...descriptor });
}

function canonicalIndex(value, secret) {
  const code =
    "SOURCE_RECALL_CLASSIFIED_EVIDENCE_MANIFEST_INDEX_INVALID";
  const record = exactRecord(value, INDEX_KEYS, code);
  const unsigned = Object.fromEntries(
    INDEX_KEYS
      .filter((key) => key !== "recordSeal")
      .map((key) => [key, record[key]]),
  );
  if (
    record.version
      !== SOURCE_RECALL_CLASSIFIED_EVIDENCE_MANIFEST_RECORD_VERSION
    || record.policyVersion
      !== SOURCE_RECALL_CLASSIFIED_EVIDENCE_MANIFEST_STORE_VERSION
    || record.kind
      !== "recall_classified_evidence_manifest_dark"
    || record.source !== SOURCE
    || !["assembling_dark", "complete_dark"].includes(
      record.status,
    )
    || record.sealVersion !== SEAL_VERSION
    || record.sealKeyId !== sealKeyId(secret)
    || !safeSealEqual(
      record.recordSeal,
      recordSeal(unsigned, secret),
    )
    || FALSE_FLAGS.some(
      (key) => record[key] !== false,
    )
  ) {
    fail(code);
  }
  for (const field of [
    "completeProofDigest",
    "contractPinsDigest",
    "manifestKeyDigest",
    "manifestStorageDigest",
    "memberIndexDigest",
    "memberSetDigest",
    "referenceManifestDigest",
    "sealKeyId",
    "shardIndexDigest",
    "workKeyDigest",
  ]) {
    exactDigest(record[field], code);
  }
  exactTimestamp(record.decisionBoundaryAtMs, code);
  exactTimestamp(
    record.manifestIssuedFromRedisAtMs,
    code,
  );
  exactTimestamp(record.manifestNotAfterMs, code);
  exactTimestamp(record.expiresAtMs, code);
  const memberCount = exactNonnegativeInteger(
    record.memberCount,
    code,
  );
  const shardCount = exactNonnegativeInteger(
    record.shardCount,
    code,
  );
  const nextShardNumber = exactNonnegativeInteger(
    record.nextShardNumber,
    code,
  );
  const completedShards = exactNonnegativeInteger(
    record.completedShards,
    code,
  );
  const terminalSuccessCount = exactNonnegativeInteger(
    record.terminalSuccessCount,
    code,
  );
  const terminalFailureCount = exactNonnegativeInteger(
    record.terminalFailureCount,
    code,
  );
  exactNonnegativeInteger(record.revision, code);
  if (
    memberCount > MAX_MEMBERS
    || shardCount > MAX_SHARDS
    || record.shardSize
      !== SOURCE_RECALL_CLASSIFIED_EVIDENCE_MANIFEST_SHARD_SIZE
    || !Array.isArray(record.shardIndex)
    || record.shardIndex.length !== shardCount
    || Object.keys(record.shardIndex).length
      !== shardCount
    || nextShardNumber > shardCount
    || completedShards !== nextShardNumber
    || terminalSuccessCount + terminalFailureCount
      > memberCount
    || record.expiresAtMs > record.manifestNotAfterMs
  ) {
    fail(code);
  }
  const shardIndex = record.shardIndex.map(
    (descriptor, index) =>
      canonicalDescriptor(descriptor, index, code),
  );
  let expectedOrdinal = 0;
  for (const descriptor of shardIndex) {
    if (
      descriptor.firstMemberOrdinal !== expectedOrdinal
    ) {
      fail(code);
    }
    expectedOrdinal += descriptor.memberCount;
  }
  if (
    expectedOrdinal !== memberCount
    || semanticDigest(
      "phase4-recall-classified-evidence-manifest-shard-index-v1",
      shardIndex,
    ) !== record.shardIndexDigest
    || record.manifestStorageDigest !== semanticDigest(
      "phase4-recall-classified-evidence-manifest-storage-v1",
      {
        policyVersion:
          SOURCE_RECALL_CLASSIFIED_EVIDENCE_MANIFEST_STORE_VERSION,
        completeProofDigest: record.completeProofDigest,
        manifestKeyDigest: record.manifestKeyDigest,
        memberSetDigest: record.memberSetDigest,
        referenceManifestDigest:
          record.referenceManifestDigest,
        workKeyDigest: record.workKeyDigest,
      },
    )
  ) {
    fail(code);
  }
  const complete = record.status === "complete_dark";
  if (
    complete
      ? (
        nextShardNumber !== shardCount
        || completedShards !== shardCount
        || terminalSuccessCount + terminalFailureCount
          !== memberCount
        || !DIGEST.test(record.completeRootDigest)
        || record.durableAttestationAvailable !== true
        || record.referenceManifestCoverageComplete
          !== true
        || record.globalReferenceSetCoverageAvailable
          !== true
        || record.sourceFactsAvailable !== true
        || record.successClassificationAvailable !== true
      )
      : (
        record.completeRootDigest !== null
        || record.durableAttestationAvailable !== false
        || record.referenceManifestCoverageComplete
          !== false
        || record.globalReferenceSetCoverageAvailable
          !== false
        || record.sourceFactsAvailable !== false
        || record.successClassificationAvailable !== false
      )
  ) {
    fail(code);
  }
  return deepFreeze({
    ...record,
    shardIndex,
  });
}

function canonicalMemberProof(value, expected, code) {
  const proof = exactRecord(
    value,
    MEMBER_PROOF_KEYS,
    code,
  );
  for (const field of [
    "classificationEvidenceDigest",
    "memberReferenceDigest",
    "memberReferenceIdDigest",
    "recordDigest",
    "recordSeal",
    "sealKeyId",
    "workItemDigest",
    "workKeyDigest",
  ]) {
    exactDigest(proof[field], code);
  }
  exactTimestamp(proof.logicalExpiresAtMs, code);
  exactTimestamp(proof.observedExpiresAtMs, code);
  exactTimestamp(proof.memberPageNumber, code);
  exactNonnegativeInteger(
    proof.memberReferenceOrdinal,
    code,
  );
  if (
    proof.version !== 1
    || proof.settlementStatus !== "terminal"
    || proof.classificationProofComplete !== true
    || !["success", "failure"].includes(
      proof.classification,
    )
    || proof.workKeyDigest !== expected.workKeyDigest
    || proof.workItemDigest !== expected.workItemDigest
    || proof.memberPageNumber !== expected.pageNumber
    || proof.memberReferenceOrdinal
      !== expected.referenceOrdinal
    || proof.memberReferenceDigest
      !== expected.referenceDigest
    || proof.memberReferenceIdDigest
      !== expected.referenceIdDigest
    || proof.observedExpiresAtMs
      > proof.logicalExpiresAtMs
  ) {
    fail(code);
  }
  return deepFreeze({ ...proof });
}

function canonicalShard(
  value,
  secret,
  descriptor = null,
) {
  const code =
    "SOURCE_RECALL_CLASSIFIED_EVIDENCE_MANIFEST_SHARD_INVALID";
  const record = exactRecord(value, SHARD_KEYS, code);
  const unsigned = Object.fromEntries(
    SHARD_KEYS
      .filter((key) => key !== "recordSeal")
      .map((key) => [key, record[key]]),
  );
  if (
    record.version
      !== SOURCE_RECALL_CLASSIFIED_EVIDENCE_MANIFEST_SHARD_VERSION
    || record.policyVersion
      !== SOURCE_RECALL_CLASSIFIED_EVIDENCE_MANIFEST_STORE_VERSION
    || record.kind
      !== "recall_classified_evidence_manifest_shard_dark"
    || record.source !== SOURCE
    || !["planned_dark", "retained_dark"].includes(
      record.status,
    )
    || record.sealVersion !== SEAL_VERSION
    || record.sealKeyId !== sealKeyId(secret)
    || !safeSealEqual(
      record.recordSeal,
      recordSeal(unsigned, secret),
    )
    || FALSE_FLAGS.some(
      (key) => record[key] !== false,
    )
  ) {
    fail(code);
  }
  for (const field of [
    "manifestKeyDigest",
    "manifestStorageDigest",
    "memberIndexDigest",
    "sealKeyId",
    "shardContentDigest",
    "shardKeyDigest",
  ]) {
    exactDigest(record[field], code);
  }
  const shardNumber = exactNonnegativeInteger(
    record.shardNumber,
    code,
  );
  const memberCount = exactTimestamp(
    record.memberCount,
    code,
  );
  exactTimestamp(record.expiresAtMs, code);
  if (
    shardNumber >= MAX_SHARDS
    || memberCount
      > SOURCE_RECALL_CLASSIFIED_EVIDENCE_MANIFEST_SHARD_SIZE
    || !Array.isArray(record.memberIndex)
    || record.memberIndex.length !== memberCount
    || Object.keys(record.memberIndex).length
      !== memberCount
  ) {
    fail(code);
  }
  const memberIndex = record.memberIndex.map(
    (member) => decodedIndexedMember(member, code),
  );
  for (let index = 0; index < memberIndex.length; index += 1) {
    if (
      index > 0
      && memberIndex[index].memberOrdinal
        !== memberIndex[index - 1].memberOrdinal + 1
    ) {
      fail(code);
    }
  }
  if (
    semanticDigest(
      "phase4-recall-classified-evidence-manifest-shard-members-v1",
      memberIndex,
    ) !== record.memberIndexDigest
    || semanticDigest(
      "phase4-recall-classified-evidence-manifest-shard-key-v1",
      {
        manifestStorageDigest:
          record.manifestStorageDigest,
        memberIndexDigest: record.memberIndexDigest,
        shardNumber,
      },
    ) !== record.shardKeyDigest
    || semanticDigest(
      "phase4-recall-classified-evidence-manifest-shard-content-v1",
      shardContentMaterial(record),
    ) !== record.shardContentDigest
  ) {
    fail(code);
  }
  if (
    descriptor !== null
    && (
      descriptor.shardNumber !== shardNumber
      || descriptor.memberCount !== memberCount
      || descriptor.firstMemberOrdinal
        !== memberIndex[0].memberOrdinal
      || descriptor.memberIndexDigest
        !== record.memberIndexDigest
      || descriptor.shardKeyDigest
        !== record.shardKeyDigest
    )
  ) {
    fail(code);
  }
  let memberProofs = null;
  if (record.status === "planned_dark") {
    if (
      record.memberProofs !== null
      || record.classificationDigest !== null
      || record.terminalSuccessCount !== 0
      || record.terminalFailureCount !== 0
    ) {
      fail(code);
    }
  } else {
    if (
      !Array.isArray(record.memberProofs)
      || record.memberProofs.length !== memberCount
      || Object.keys(record.memberProofs).length
        !== memberCount
    ) {
      fail(code);
    }
    memberProofs = record.memberProofs.map(
      (proof, index) =>
        canonicalMemberProof(
          proof,
          memberIndex[index],
          code,
        ),
    );
    const successes = memberProofs.filter(
      (proof) => proof.classification === "success",
    ).length;
    if (
      record.terminalSuccessCount !== successes
      || record.terminalFailureCount
        !== memberCount - successes
      || record.expiresAtMs > Math.min(
        ...memberProofs.map(
          (proof) => proof.logicalExpiresAtMs,
        ),
      )
      || record.classificationDigest !== semanticDigest(
        "phase4-recall-classified-evidence-manifest-shard-classifications-v1",
        memberProofs,
      )
    ) {
      fail(code);
    }
  }
  return deepFreeze({
    ...record,
    memberProofs,
  });
}

function decodedShardMembers(record) {
  const code =
    "SOURCE_RECALL_CLASSIFIED_EVIDENCE_MANIFEST_SHARD_INVALID";
  return record.memberIndex.map(
    (member) => decodedIndexedMember(member, code),
  );
}

function reproveRetainedShards(index, shards) {
  const code =
    "SOURCE_RECALL_CLASSIFIED_EVIDENCE_MANIFEST_COVERAGE_INCOMPLETE";
  if (shards.length !== index.shardCount) fail(code);
  const members = [];
  const summaries = [];
  let successes = 0;
  let failures = 0;
  let earliestShardExpiresAtMs =
    index.manifestNotAfterMs;
  for (let shardNumber = 0; shardNumber < shards.length; shardNumber += 1) {
    const shard = shards[shardNumber].record;
    if (
      shard.status !== "retained_dark"
      || shard.shardNumber !== shardNumber
      || shard.manifestStorageDigest
        !== index.manifestStorageDigest
      || shard.manifestKeyDigest
        !== index.manifestKeyDigest
      || shard.expiresAtMs > index.manifestNotAfterMs
    ) {
      fail(code);
    }
    members.push(...decodedShardMembers(shard));
    successes += shard.terminalSuccessCount;
    failures += shard.terminalFailureCount;
    earliestShardExpiresAtMs = Math.min(
      earliestShardExpiresAtMs,
      shard.expiresAtMs,
    );
    summaries.push({
      classificationDigest: shard.classificationDigest,
      recordSeal: shard.recordSeal,
      shardContentDigest: shard.shardContentDigest,
      shardKeyDigest: shard.shardKeyDigest,
      shardNumber,
    });
  }
  if (
    members.length !== index.memberCount
    || index.expiresAtMs > earliestShardExpiresAtMs
    || semanticDigest(
      "phase4-recall-classified-evidence-manifest-members-v1",
      members,
    ) !== index.memberIndexDigest
  ) {
    fail(code);
  }
  return deepFreeze({
    failures,
    successes,
    summaries,
  });
}

function parseRaw(raw, maxCode) {
  if (
    typeof raw !== "string"
    || raw.length === 0
    || Buffer.byteLength(raw, "utf8") > MAX_RAW_BYTES
  ) {
    fail(maxCode);
  }
  try {
    return JSON.parse(raw);
  } catch {
    fail(maxCode);
  }
}

function snapshotResult(value, code) {
  const result = exactRecord(
    value,
    ["expiresAtMs", "raw", "redisNowMs"],
    code,
  );
  if (
    !Number.isSafeInteger(result.redisNowMs)
    || result.redisNowMs <= 0
    || !Number.isSafeInteger(result.expiresAtMs)
    || !(
      typeof result.raw === "string"
      || result.raw === null
    )
    || (
      result.raw === null
      && result.expiresAtMs !== -2
    )
    || (
      typeof result.raw === "string"
      && result.expiresAtMs <= result.redisNowMs
    )
  ) {
    fail(code);
  }
  return result;
}

function indexSnapshot(resultValue, secret) {
  const code =
    "SOURCE_RECALL_CLASSIFIED_EVIDENCE_MANIFEST_PERSISTENCE_RESULT_INVALID";
  const result = snapshotResult(resultValue, code);
  if (result.raw === null) {
    fail(
      "SOURCE_RECALL_CLASSIFIED_EVIDENCE_MANIFEST_NOT_FOUND",
    );
  }
  const record = canonicalIndex(
    parseRaw(result.raw, code),
    secret,
  );
  if (
    canonicalJson(record) !== result.raw
    || result.expiresAtMs > record.expiresAtMs
  ) {
    fail(code);
  }
  return deepFreeze({
    ...result,
    record,
  });
}

function shardSnapshot(
  resultValue,
  secret,
  descriptor,
) {
  const code =
    "SOURCE_RECALL_CLASSIFIED_EVIDENCE_MANIFEST_PERSISTENCE_RESULT_INVALID";
  const result = snapshotResult(resultValue, code);
  if (result.raw === null) {
    fail(
      "SOURCE_RECALL_CLASSIFIED_EVIDENCE_MANIFEST_SHARD_MISSING",
    );
  }
  const record = canonicalShard(
    parseRaw(result.raw, code),
    secret,
    descriptor,
  );
  if (
    canonicalJson(record) !== result.raw
    || result.expiresAtMs > record.expiresAtMs
  ) {
    fail(code);
  }
  return deepFreeze({
    ...result,
    record,
  });
}

function persistenceInterface(value) {
  const code =
    "SOURCE_RECALL_CLASSIFIED_EVIDENCE_MANIFEST_PERSISTENCE_INVALID";
  const persistence = plainRecordSnapshot(value, code);
  if (
    Object.keys(persistence).some(
      (key) => !PERSISTENCE_ALLOWED_METHODS.has(key),
    )
  ) {
    fail(code);
  }
  for (const method of PERSISTENCE_METHODS) {
    if (typeof persistence[method] !== "function") {
      fail(code);
    }
  }
  return Object.freeze(
    Object.fromEntries(
      PERSISTENCE_METHODS.map(
        (method) => [method, persistence[method]],
      ),
    ),
  );
}

function workHandle(value) {
  const code =
    "SOURCE_RECALL_CLASSIFIED_EVIDENCE_MANIFEST_WORK_INVALID";
  const work = exactRecord(value, WORK_KEYS, code);
  exactDigest(work.manifestStorageDigest, code);
  return deepFreeze({ ...work });
}

function semanticallySameIndex(first, second) {
  const immutableIdentity = (record) => ({
    completeProofDigest: record.completeProofDigest,
    contractPinsDigest: record.contractPinsDigest,
    decisionBoundaryAtMs: record.decisionBoundaryAtMs,
    kind: record.kind,
    manifestKeyDigest: record.manifestKeyDigest,
    manifestNotAfterMs: record.manifestNotAfterMs,
    manifestStorageDigest: record.manifestStorageDigest,
    memberCount: record.memberCount,
    memberIndexDigest: record.memberIndexDigest,
    memberSetDigest: record.memberSetDigest,
    policyVersion: record.policyVersion,
    referenceManifestDigest:
      record.referenceManifestDigest,
    sealKeyId: record.sealKeyId,
    sealVersion: record.sealVersion,
    shardCount: record.shardCount,
    shardIndex: record.shardIndex,
    shardIndexDigest: record.shardIndexDigest,
    shardSize: record.shardSize,
    source: record.source,
    version: record.version,
    workKeyDigest: record.workKeyDigest,
  });
  return canonicalJson(immutableIdentity(first))
    === canonicalJson(immutableIdentity(second));
}

function aggregateFor(
  index,
  snapshot,
  statusOverride = null,
  awaitingMembers = 0,
  unsettledMembers = 0,
) {
  return deepFreeze({
    status: statusOverride ?? (
      index.status === "complete_dark"
        ? "classified_manifest_complete_dark"
        : "classified_manifest_assembling_dark"
    ),
    manifestDigest: index.completeRootDigest,
    manifestStorageDigest: index.manifestStorageDigest,
    memberCount: index.memberCount,
    shardCount: index.shardCount,
    completedShards: index.completedShards,
    nextShardNumber: index.nextShardNumber,
    terminalSuccessCount: index.terminalSuccessCount,
    terminalFailureCount: index.terminalFailureCount,
    awaitingMembers,
    unsettledMembers,
    retainedAtRedisMs: snapshot.redisNowMs,
    expiresAtMs: snapshot.expiresAtMs,
    durableAttestationAvailable:
      index.durableAttestationAvailable,
    referenceManifestCoverageComplete:
      index.referenceManifestCoverageComplete,
    globalReferenceSetCoverageAvailable:
      index.globalReferenceSetCoverageAvailable,
    sourceFactsAvailable: index.sourceFactsAvailable,
    successClassificationAvailable:
      index.successClassificationAvailable,
    ...falseFlags(),
  });
}

function readManyResult(value, keys) {
  const code =
    "SOURCE_RECALL_CLASSIFIED_EVIDENCE_MANIFEST_PERSISTENCE_RESULT_INVALID";
  const result = exactRecord(
    value,
    ["records", "redisNowMs"],
    code,
  );
  const redisNowMs = exactTimestamp(
    result.redisNowMs,
    code,
  );
  if (
    !Array.isArray(result.records)
    || result.records.length !== keys.length
    || Object.keys(result.records).length !== keys.length
  ) {
    fail(code);
  }
  const records = result.records.map((value, index) => {
    const record = exactRecord(
      value,
      ["expiresAtMs", "key", "raw"],
      code,
    );
    if (
      record.key !== keys[index]
      || !Number.isSafeInteger(record.expiresAtMs)
      || !(
        typeof record.raw === "string"
        || record.raw === null
      )
      || (
        record.raw === null
        && record.expiresAtMs !== -2
      )
      || (
        typeof record.raw === "string"
        && record.expiresAtMs <= redisNowMs
      )
    ) {
      fail(code);
    }
    return deepFreeze({ ...record });
  });
  return deepFreeze({ records, redisNowMs });
}

function completeIndexUnsigned(index, summaries) {
  const completeRootDigest = semanticDigest(
    "phase4-recall-classified-evidence-manifest-root-v1",
    summaries,
  );
  const next = {
    ...index,
    status: "complete_dark",
    revision: index.revision + 1,
    completeRootDigest,
    durableAttestationAvailable: true,
    referenceManifestCoverageComplete: true,
    globalReferenceSetCoverageAvailable: true,
    sourceFactsAvailable: true,
    successClassificationAvailable: true,
  };
  delete next.recordSeal;
  return next;
}

export function createSourceRecallClassifiedEvidenceManifestStore(
  options,
) {
  const code =
    "SOURCE_RECALL_CLASSIFIED_EVIDENCE_MANIFEST_OPTIONS_INVALID";
  const selected = exactRecord(options, FACTORY_KEYS, code);
  const persistence = persistenceInterface(
    selected.persistence,
  );
  const secret = sealSecret(selected.sealSecret);

  async function readIndex(workValue) {
    const work = workHandle(workValue);
    const snapshot = indexSnapshot(
      await persistence.read({
        key: indexKey(work.manifestStorageDigest),
      }),
      secret,
    );
    if (
      snapshot.record.manifestStorageDigest
        !== work.manifestStorageDigest
    ) {
      fail(
        "SOURCE_RECALL_CLASSIFIED_EVIDENCE_MANIFEST_BINDING_MISMATCH",
      );
    }
    return snapshot;
  }

  async function readAllShards(index) {
    const snapshots = [];
    for (
      let offset = 0;
      offset < index.shardCount;
      offset += 20
    ) {
      const descriptors =
        index.shardIndex.slice(offset, offset + 20);
      const keys = descriptors.map(
        (descriptor) => shardKey(
          index.manifestStorageDigest,
          descriptor.shardNumber,
        ),
      );
      const batch = readManyResult(
        await persistence.readMany({ keys }),
        keys,
      );
      snapshots.push(
        ...batch.records.map((record, indexInBatch) =>
          shardSnapshot(
            {
              raw: record.raw,
              redisNowMs: batch.redisNowMs,
              expiresAtMs: record.expiresAtMs,
            },
            secret,
            descriptors[indexInBatch],
          )),
      );
    }
    return snapshots;
  }

  async function finalizeManifest(snapshot) {
    const index = snapshot.record;
    if (index.status === "complete_dark") {
      const shards = await readAllShards(index);
      const proof = reproveRetainedShards(
        index,
        shards,
      );
      if (
        semanticDigest(
          "phase4-recall-classified-evidence-manifest-root-v1",
          proof.summaries,
        ) !== index.completeRootDigest
        || proof.successes
          !== index.terminalSuccessCount
        || proof.failures
          !== index.terminalFailureCount
      ) {
        fail(
          "SOURCE_RECALL_CLASSIFIED_EVIDENCE_MANIFEST_ROOT_INVALID",
        );
      }
      return aggregateFor(index, snapshot);
    }
    if (
      index.completedShards !== index.shardCount
      || index.nextShardNumber !== index.shardCount
    ) {
      return aggregateFor(index, snapshot);
    }
    const shards = await readAllShards(index);
    const proof = reproveRetainedShards(index, shards);
    if (
      proof.successes !== index.terminalSuccessCount
      || proof.failures !== index.terminalFailureCount
      || proof.successes + proof.failures
        !== index.memberCount
    ) {
      fail(
        "SOURCE_RECALL_CLASSIFIED_EVIDENCE_MANIFEST_COVERAGE_INCOMPLETE",
      );
    }
    const complete = sealed(
      completeIndexUnsigned(index, proof.summaries),
      secret,
    );
    const nextRaw = canonicalJson(complete);
    const result = await persistence.compareAndSet({
      key: indexKey(index.manifestStorageDigest),
      expectedRaw: snapshot.raw,
      nextRaw,
      expiresAtMs: snapshot.expiresAtMs,
      nextExpiresAtMs: snapshot.expiresAtMs,
      notAfterMs: complete.expiresAtMs,
    });
    if (result.status === "expired") {
      fail(
        "SOURCE_RECALL_CLASSIFIED_EVIDENCE_MANIFEST_EXPIRED",
      );
    }
    if (result.status === "conflict") {
      return finalizeManifest(
        indexSnapshot(
          {
            raw: result.raw,
            redisNowMs: result.redisNowMs,
            expiresAtMs: result.expiresAtMs,
          },
          secret,
        ),
      );
    }
    const retained = indexSnapshot(
      {
        raw: result.raw,
        redisNowMs: result.redisNowMs,
        expiresAtMs: result.expiresAtMs,
      },
      secret,
    );
    if (retained.raw !== nextRaw) {
      fail(
        "SOURCE_RECALL_CLASSIFIED_EVIDENCE_MANIFEST_BINDING_MISMATCH",
      );
    }
    return aggregateFor(retained.record, retained);
  }

  async function initializeSourceRecallClassifiedEvidenceManifest(
    seedCapability,
  ) {
    let consumed;
    try {
      consumed =
        consumeSourceRecallClassifiedManifestSeedCapability(
          seedCapability,
        );
    } catch {
      fail(
        "SOURCE_RECALL_CLASSIFIED_EVIDENCE_MANIFEST_CAPABILITY_INVALID",
      );
    }
    let seed;
    try {
      seed =
        canonicalizeSourceRecallClassifiedManifestSeed(
          consumed,
        );
    } catch {
      fail(
        "SOURCE_RECALL_CLASSIFIED_EVIDENCE_MANIFEST_SEED_INVALID",
      );
    }
    const plan =
      sourceRecallClassifiedEvidenceManifestPlan(seed);
    const proposedIndex = sealed(
      indexUnsigned(seed, plan, secret),
      secret,
    );
    const proposedShards = plan.shards.map(
      (shard) => sealed(
        shardUnsigned(seed, plan, shard, secret),
        secret,
      ),
    );
    const proposedRaw = canonicalJson(proposedIndex);
    const shardInputs = proposedShards.map(
      (shard, shardNumber) => ({
        key: shardKey(
          plan.manifestStorageDigest,
          shardNumber,
        ),
        proposedRaw: canonicalJson(shard),
      }),
    );
    if (
      Buffer.byteLength(proposedRaw, "utf8")
        > MAX_RAW_BYTES
      || shardInputs.some(
        (shard) =>
          Buffer.byteLength(shard.proposedRaw, "utf8")
            > MAX_RAW_BYTES,
      )
    ) {
      fail(
        "SOURCE_RECALL_CLASSIFIED_EVIDENCE_MANIFEST_RECORD_TOO_LARGE",
      );
    }
    const result = await persistence.initializeManifest({
      index: {
        key: indexKey(plan.manifestStorageDigest),
        proposedRaw,
      },
      shards: shardInputs,
      issuedAtMs: seed.issuedFromRedisAtMs,
      notAfterMs: seed.notAfterMs,
      expiresAtMs: seed.notAfterMs,
    });
    if (
      !["created", "existing"].includes(result.status)
    ) {
      fail(
        result.status === "expired"
          ? "SOURCE_RECALL_CLASSIFIED_EVIDENCE_MANIFEST_EXPIRED"
          : "SOURCE_RECALL_CLASSIFIED_EVIDENCE_MANIFEST_CONFLICT",
      );
    }
    const snapshot = indexSnapshot(
      {
        raw: result.raw,
        redisNowMs: result.redisNowMs,
        expiresAtMs: result.expiresAtMs,
      },
      secret,
    );
    if (
      result.status === "created"
        ? snapshot.raw !== proposedRaw
        : !semanticallySameIndex(
          snapshot.record,
          proposedIndex,
        )
    ) {
      fail(
        "SOURCE_RECALL_CLASSIFIED_EVIDENCE_MANIFEST_BINDING_MISMATCH",
      );
    }
    if (
      result.status === "existing"
      && snapshot.record.status !== "complete_dark"
    ) {
      const shards = await readAllShards(snapshot.record);
      if (
        shards.some(
          (shard, index) =>
            shard.record.status === "planned_dark"
            && canonicalJson(shard.record)
              !== shardInputs[index].proposedRaw,
        )
      ) {
        fail(
          "SOURCE_RECALL_CLASSIFIED_EVIDENCE_MANIFEST_BINDING_MISMATCH",
        );
      }
    }
    const aggregate = snapshot.record.status
      === "complete_dark"
      ? await finalizeManifest(snapshot)
      : aggregateFor(snapshot.record, snapshot);
    return deepFreeze({
      ...aggregate,
      work: deepFreeze({
        manifestStorageDigest:
          plan.manifestStorageDigest,
      }),
    });
  }

  async function advanceSourceRecallClassifiedEvidenceManifest(
    workValue,
  ) {
    const snapshot = await readIndex(workValue);
    const index = snapshot.record;
    if (
      index.status === "complete_dark"
      || index.nextShardNumber === index.shardCount
    ) {
      return finalizeManifest(snapshot);
    }
    const descriptor =
      index.shardIndex[index.nextShardNumber];
    const selectedKey = shardKey(
      index.manifestStorageDigest,
      descriptor.shardNumber,
    );
    let shard = shardSnapshot(
      await persistence.read({ key: selectedKey }),
      secret,
      descriptor,
    );
    if (
      shard.record.manifestStorageDigest
        !== index.manifestStorageDigest
      || shard.record.manifestKeyDigest
        !== index.manifestKeyDigest
      || shard.record.expiresAtMs
        > index.manifestNotAfterMs
    ) {
      fail(
        "SOURCE_RECALL_CLASSIFIED_EVIDENCE_MANIFEST_BINDING_MISMATCH",
      );
    }
    if (shard.record.status === "planned_dark") {
      const indexedMembers =
        decodedShardMembers(shard.record);
      const leafKeys = indexedMembers.map(
        (member) =>
          sourceRecallClassifiedEvidenceRetentionKey(
            index.manifestKeyDigest,
            member.workKeyDigest,
          ),
      );
      // Leaf keys are deliberately distributed rather than sharing the
      // manifest's Redis Cluster hash tag. Read them independently so this
      // bounded shard step never issues a cross-slot multi-key command.
      const leafSnapshots = await Promise.all(
        leafKeys.map(async (key) => ({
          key,
          ...snapshotResult(
            await persistence.read({ key }),
            "SOURCE_RECALL_CLASSIFIED_EVIDENCE_MANIFEST_PERSISTENCE_RESULT_INVALID",
          ),
        })),
      );
      const awaitingMembers = leafSnapshots.filter(
        (record) => record.raw === null,
      ).length;
      if (awaitingMembers > 0) {
        return aggregateFor(
          index,
          snapshot,
          "classified_manifest_awaiting_members_dark",
          awaitingMembers,
          0,
        );
      }
      const proofs = leafSnapshots.map(
        (record, memberIndex) =>
          verifySourceRecallClassifiedEvidenceRecordAgainstMember({
            expected: {
              completeProofDigest:
                index.completeProofDigest,
              contractPinsDigest:
                index.contractPinsDigest,
              decisionBoundaryAtMs:
                index.decisionBoundaryAtMs,
              manifestKeyDigest:
                index.manifestKeyDigest,
              member: Object.fromEntries(
                MEMBER_KEYS.map((key) => [
                  key,
                  indexedMembers[memberIndex][key],
                ]),
              ),
              memberSetDigest: index.memberSetDigest,
              notAfterMs: index.manifestNotAfterMs,
              referenceManifestDigest:
                index.referenceManifestDigest,
            },
            raw: record.raw,
            redisNowMs: record.redisNowMs,
            expiresAtMs: record.expiresAtMs,
            sealSecret: secret,
          }),
      );
      const unsettledMembers = proofs.filter(
        (proof) =>
          proof.settlementStatus !== "terminal"
          || proof.classificationProofComplete !== true
          || !["success", "failure"].includes(
            proof.classification,
          )
      ).length;
      if (unsettledMembers > 0) {
        return aggregateFor(
          index,
          snapshot,
          "classified_manifest_unsettled_members_dark",
          0,
          unsettledMembers,
        );
      }
      const retainedShard = sealed(
        retainedShardUnsigned(
          shard.record,
          proofs,
        ),
        secret,
      );
      const nextRaw = canonicalJson(retainedShard);
      const stored = await persistence.compareAndSet({
        key: selectedKey,
        expectedRaw: shard.raw,
        nextRaw,
        expiresAtMs: shard.expiresAtMs,
        nextExpiresAtMs: Math.min(
          shard.expiresAtMs,
          retainedShard.expiresAtMs
            - SOURCE_RECALL_CLASSIFIED_EVIDENCE_EXPIRY_SAFETY_MARGIN_MS,
          ...proofs.map(
            (proof) => proof.observedExpiresAtMs,
          ),
        ),
        notAfterMs: retainedShard.expiresAtMs,
      });
      if (stored.status === "expired") {
        fail(
          "SOURCE_RECALL_CLASSIFIED_EVIDENCE_MANIFEST_EXPIRED",
        );
      }
      shard = shardSnapshot(
        {
          raw: stored.raw,
          redisNowMs: stored.redisNowMs,
          expiresAtMs: stored.expiresAtMs,
        },
        secret,
        descriptor,
      );
      if (
        shard.record.status !== "retained_dark"
        || shard.record.manifestStorageDigest
          !== index.manifestStorageDigest
        || shard.record.manifestKeyDigest
          !== index.manifestKeyDigest
      ) {
        fail(
          "SOURCE_RECALL_CLASSIFIED_EVIDENCE_MANIFEST_CAS_CONFLICT",
        );
      }
    }
    const latest = await readIndex(workValue);
    if (
      latest.record.nextShardNumber
        > descriptor.shardNumber
    ) {
      return latest.record.nextShardNumber
        === latest.record.shardCount
        ? finalizeManifest(latest)
        : aggregateFor(latest.record, latest);
    }
    if (
      latest.record.nextShardNumber
        !== descriptor.shardNumber
      || latest.record.revision !== index.revision
    ) {
      fail(
        "SOURCE_RECALL_CLASSIFIED_EVIDENCE_MANIFEST_CAS_CONFLICT",
      );
    }
    const nextIndex = {
      ...latest.record,
      revision: latest.record.revision + 1,
      expiresAtMs: Math.min(
        latest.record.expiresAtMs,
        shard.record.expiresAtMs,
      ),
      nextShardNumber:
        latest.record.nextShardNumber + 1,
      completedShards:
        latest.record.completedShards + 1,
      terminalSuccessCount:
        latest.record.terminalSuccessCount
        + shard.record.terminalSuccessCount,
      terminalFailureCount:
        latest.record.terminalFailureCount
        + shard.record.terminalFailureCount,
    };
    delete nextIndex.recordSeal;
    const sealedIndex = sealed(nextIndex, secret);
    const nextIndexRaw = canonicalJson(sealedIndex);
    const updated = await persistence.compareAndSet({
      key: indexKey(index.manifestStorageDigest),
      expectedRaw: latest.raw,
      nextRaw: nextIndexRaw,
      expiresAtMs: latest.expiresAtMs,
      nextExpiresAtMs: Math.min(
        latest.expiresAtMs,
        shard.expiresAtMs,
      ),
      notAfterMs: nextIndex.expiresAtMs,
    });
    if (updated.status === "expired") {
      fail(
        "SOURCE_RECALL_CLASSIFIED_EVIDENCE_MANIFEST_EXPIRED",
      );
    }
    if (updated.status === "conflict") {
      const reconciled = indexSnapshot(
        {
          raw: updated.raw,
          redisNowMs: updated.redisNowMs,
          expiresAtMs: updated.expiresAtMs,
        },
        secret,
      );
      if (
        reconciled.record.nextShardNumber
          <= descriptor.shardNumber
      ) {
        fail(
          "SOURCE_RECALL_CLASSIFIED_EVIDENCE_MANIFEST_CAS_CONFLICT",
        );
      }
      return reconciled.record.nextShardNumber
        === reconciled.record.shardCount
        ? finalizeManifest(reconciled)
        : aggregateFor(reconciled.record, reconciled);
    }
    const retainedIndex = indexSnapshot(
      {
        raw: updated.raw,
        redisNowMs: updated.redisNowMs,
        expiresAtMs: updated.expiresAtMs,
      },
      secret,
    );
    return retainedIndex.record.nextShardNumber
      === retainedIndex.record.shardCount
      ? finalizeManifest(retainedIndex)
      : aggregateFor(
        retainedIndex.record,
        retainedIndex,
      );
  }

  async function readSourceRecallClassifiedEvidenceManifest(
    workValue,
  ) {
    const snapshot = await readIndex(workValue);
    return snapshot.record.status === "complete_dark"
      ? finalizeManifest(snapshot)
      : aggregateFor(snapshot.record, snapshot);
  }

  return Object.freeze({
    advanceSourceRecallClassifiedEvidenceManifest,
    initializeSourceRecallClassifiedEvidenceManifest,
    readSourceRecallClassifiedEvidenceManifest,
  });
}

let defaultStore = null;

function productionStore() {
  if (defaultStore === null) {
    defaultStore =
      createSourceRecallClassifiedEvidenceManifestStore({
        persistence:
          createSourceRecallClassifiedEvidencePersistenceAdapter(),
        sealSecret: String(
          process.env[
            SOURCE_RECALL_CLASSIFIED_EVIDENCE_SEAL_ENV
          ] || "",
        ),
      });
  }
  return defaultStore;
}

export function initializeSourceRecallClassifiedEvidenceManifest(
  seedCapability,
) {
  return productionStore()
    .initializeSourceRecallClassifiedEvidenceManifest(
      seedCapability,
    );
}

export function advanceSourceRecallClassifiedEvidenceManifest(
  work,
) {
  return productionStore()
    .advanceSourceRecallClassifiedEvidenceManifest(work);
}

export function readSourceRecallClassifiedEvidenceManifest(
  work,
) {
  return productionStore()
    .readSourceRecallClassifiedEvidenceManifest(work);
}
