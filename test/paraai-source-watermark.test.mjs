import test from "node:test";
import assert from "node:assert/strict";
import {
  createHash,
  createHmac,
} from "node:crypto";
import { readFile } from "node:fs/promises";

import {
  SOURCE_WATERMARK_APPROVED_COLLECTORS,
  SOURCE_WATERMARK_AUTHORITY_KEY_ENV,
  SOURCE_WATERMARK_AUTHORITY_RECEIPT_VERSION,
  SOURCE_IDENTITY_BINDING_AUTHORITY_KEY_ENV,
  SOURCE_IDENTITY_BINDING_RECEIPT_VERSION,
  SOURCE_IDENTITY_BINDING_SOURCE_ARTIFACT_DIGEST,
  SOURCE_IDENTITY_POINT_READ_PROCEDURES,
  SOURCE_WATERMARK_POLICY_VERSION,
  SOURCE_WATERMARK_SOURCES,
  SourceWatermarkInvariantError,
  buildCanonicalSourceAliasMap,
  buildPhase4WriteBoundaryAttestation,
  buildSourceWatermarkCertificate,
  buildSourceWatermarkGeneration,
  q37NewestSuccessfulCallDecision,
  sourceWatermarkAliasSetDigest,
  sourceWatermarkFactSetDigest,
  sourceWatermarkPublicStatus,
  validatePhase4WriteBoundaryAttestation,
  validateSourceWatermarkGeneration,
} from "../api/paraai/_lib/source-watermark.mjs";
import {
  activateSourceAuthorityGeneration,
  consumeSourceAuthorityWriteReservation,
  getSourceAuthorityOperationalStatus,
  readCurrentSourceAuthority,
  reserveSourceAuthorityWrite,
} from "../api/paraai/_lib/source-authority-store.mjs";

const T = "2026-07-26T00:00:00.000Z";
const COMMITTED_AT = "2026-07-26T00:06:00.000Z";
const digest = (character) => character.repeat(64);

const CANDIDATE_A = digest("a");
const CANDIDATE_B = digest("b");
const CANDIDATE_C = digest("c");
const CANDIDATE_USER_A = digest("1");
const CANDIDATE_USER_B = digest("2");
const RECORD_RECALL_A = digest("3");
const RECORD_RECALL_B = digest("4");
const RECORD_HUMAN_A = digest("5");
const RECORD_HUMAN_B = digest("6");
const REVISION_RECALL_A = "31".repeat(32);
const REVISION_RECALL_B = "41".repeat(32);
const REVISION_HUMAN_A = "51".repeat(32);
const REVISION_HUMAN_B = "61".repeat(32);
const RECALL_EPOCH = digest("d");
const PARAFORM_EPOCH = digest("e");
const ALIAS_EPOCH = "ab".repeat(32);
const GENERATION_NONCE = digest("7");
const COMMIT_REVISION = digest("8");
const JOB_REVISION = digest("9");
const WRITE_SCOPE = digest("0");
const JOB_BINDING = "15".repeat(32);
const SETTLED_RESULT = "16".repeat(32);
const DURABLE_GENERATION_REVISION = "10".repeat(32);
const RESERVED_JOB_REVISION = "11".repeat(32);
const AUTHORITY_NONCE = "12".repeat(32);
const RESERVATION_NONCE = "13".repeat(32);
const AUTHORITY_KEY_BYTES = Buffer.alloc(32, 0x42);
const AUTHORITY_KEY = AUTHORITY_KEY_BYTES.toString("base64url");
const IDENTITY_KEY_BYTES = Buffer.alloc(32, 0x24);
const IDENTITY_KEY = IDENTITY_KEY_BYTES.toString("base64url");
process.env[SOURCE_WATERMARK_AUTHORITY_KEY_ENV] = AUTHORITY_KEY;
process.env[SOURCE_IDENTITY_BINDING_AUTHORITY_KEY_ENV] =
  IDENTITY_KEY;
process.env.KV_REST_API_URL = "https://kv.test.invalid";
process.env.KV_REST_API_TOKEN = "test-token";

function canonicalJson(value) {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => (
    `${JSON.stringify(key)}:${canonicalJson(value[key])}`
  )).join(",")}}`;
}

function semanticDigest(namespace, value) {
  return createHash("sha256")
    .update(namespace)
    .update("\0")
    .update(canonicalJson(value))
    .digest("hex");
}

function authorityKeyId(key = AUTHORITY_KEY_BYTES) {
  return createHash("sha256")
    .update("phase4-source-authority-key-id-v1")
    .update("\0")
    .update(key)
    .digest("hex");
}

function signAuthorityReceipt(
  material,
  key = AUTHORITY_KEY_BYTES,
) {
  return createHmac("sha256", key)
    .update("phase4-source-authority-receipt-v1")
    .update("\0")
    .update(canonicalJson(material))
    .digest("hex");
}

function identityBindingKeyId(key = IDENTITY_KEY_BYTES) {
  return createHash("sha256")
    .update("phase4-source-identity-binding-key-id-v1")
    .update("\0")
    .update(key)
    .digest("hex");
}

function signIdentityBindingReceipt(
  material,
  key = IDENTITY_KEY_BYTES,
) {
  return createHmac("sha256", key)
    .update("phase4-source-identity-binding-receipt-v1")
    .update("\0")
    .update(canonicalJson(material))
    .digest("hex");
}

function sourceEpochsFromGeneration(generation) {
  return {
    recall:
      generation.sources.recall.certificate.sourceEpochDigest,
    paraformHuman:
      generation.sources.paraformHuman
        .certificate.sourceEpochDigest,
    aliases: generation.aliasMap.aliasEpochDigest,
  };
}

function generationAuthorityReceiptFixture(
  generation,
  overrides = {},
) {
  const now = Date.now();
  const {
    receiptMac: overrideMac,
    signingKey = AUTHORITY_KEY_BYTES,
    ...fields
  } = overrides;
  const material = {
    version: SOURCE_WATERMARK_AUTHORITY_RECEIPT_VERSION,
    policyVersion: SOURCE_WATERMARK_POLICY_VERSION,
    kind: "source_generation_current",
    generationRecordDigest: generation.recordDigest,
    manifestDigest: generation.manifestDigest,
    commitRevisionDigest: generation.commitRevisionDigest,
    durableGenerationRevisionDigest:
      DURABLE_GENERATION_REVISION,
    decisionBoundaryAt: generation.decisionBoundaryAt,
    sourceEpochs: sourceEpochsFromGeneration(generation),
    aliasMapDigest: generation.aliasMap.aliasMapDigest,
    aliasEvidenceDigest:
      generation.aliasEvidence.evidenceDigest,
    collectorPinsDigest: semanticDigest(
      "phase4-source-approved-collector-pins-v1",
      SOURCE_WATERMARK_APPROVED_COLLECTORS,
    ),
    issuedAt: new Date(now - 1_000).toISOString(),
    expiresAt: new Date(now + 50_000).toISOString(),
    receiptNonceDigest: AUTHORITY_NONCE,
    authorityKeyIdDigest: authorityKeyId(),
    ...fields,
  };
  const receiptMac = overrideMac
    || signAuthorityReceipt(material, signingKey);
  return {
    ...material,
    receiptMac,
  };
}

function generationAuthorityReceiptDigest(receipt) {
  return semanticDigest(
    "phase4-source-generation-authority-receipt-v1",
    receipt,
  );
}

function writeAuthorityReceiptFixture({
  generation,
  generationAuthorityReceipt,
  attestation,
  overrides = {},
}) {
  const issuedMs = Math.max(
    Date.now(),
    Date.parse(attestation.observedAt),
  );
  const {
    receiptMac: overrideMac,
    signingKey = AUTHORITY_KEY_BYTES,
    ...fields
  } = overrides;
  const material = {
    version: SOURCE_WATERMARK_AUTHORITY_RECEIPT_VERSION,
    policyVersion: SOURCE_WATERMARK_POLICY_VERSION,
    kind: "phase4_write_cas_reserved",
    generationRecordDigest: generation.recordDigest,
    manifestDigest: generation.manifestDigest,
    commitRevisionDigest: generation.commitRevisionDigest,
    durableGenerationRevisionDigest:
      generationAuthorityReceipt.durableGenerationRevisionDigest,
    generationAuthorityReceiptDigest:
      generationAuthorityReceiptDigest(
        generationAuthorityReceipt,
      ),
    sourceEpochs: sourceEpochsFromGeneration(generation),
    attestationDigest: attestation.attestationDigest,
    canonicalCandidateDigest:
      attestation.canonicalCandidateDigest,
    candidateUserAliasDigest:
      attestation.candidateUserAliasDigest,
    jobRevisionDigest: attestation.jobRevisionDigest,
    writeScopeDigest: attestation.writeScopeDigest,
    reservedJobRevisionDigest: RESERVED_JOB_REVISION,
    reservationNonceDigest: RESERVATION_NONCE,
    issuedAt: new Date(issuedMs).toISOString(),
    expiresAt: new Date(issuedMs + 10_000).toISOString(),
    authorityKeyIdDigest: authorityKeyId(),
    ...fields,
  };
  const receiptMac = overrideMac
    || signAuthorityReceipt(material, signingKey);
  return {
    ...material,
    receiptMac,
  };
}

function sourceRecordForCandidate(candidate) {
  return candidate === CANDIDATE_B
    ? RECORD_RECALL_B
    : RECORD_RECALL_A;
}

function sourceRecordForAlias(candidateUser) {
  return candidateUser === CANDIDATE_USER_B
    ? RECORD_HUMAN_B
    : RECORD_HUMAN_A;
}

function sourceRevisionForCandidate(candidate) {
  return candidate === CANDIDATE_B
    ? REVISION_RECALL_B
    : REVISION_RECALL_A;
}

function sourceRevisionForAlias(candidateUser) {
  return candidateUser === CANDIDATE_USER_B
    ? REVISION_HUMAN_B
    : REVISION_HUMAN_A;
}

function aliasEvidenceEntry(entry) {
  return {
    ...entry,
    recallRecordDigest:
      entry.recallRecordDigest
      || sourceRecordForCandidate(
        entry.canonicalCandidateDigest,
      ),
    paraformHumanRecordDigest:
      entry.paraformHumanRecordDigest
      || sourceRecordForAlias(
        entry.candidateUserAliasDigest,
      ),
    recallRecordRevisionDigest:
      entry.recallRecordRevisionDigest
      || sourceRevisionForCandidate(
        entry.canonicalCandidateDigest,
      ),
    paraformHumanRecordRevisionDigest:
      entry.paraformHumanRecordRevisionDigest
      || sourceRevisionForAlias(
        entry.candidateUserAliasDigest,
      ),
  };
}

function identityBindingReceiptFixture(
  entry,
  {
    decisionBoundaryAt = T,
    overrides = {},
  } = {},
) {
  const {
    receiptMac: overrideMac,
    signingKey = IDENTITY_KEY_BYTES,
    ...fields
  } = overrides;
  const material = {
    version: SOURCE_IDENTITY_BINDING_RECEIPT_VERSION,
    policyVersion: SOURCE_WATERMARK_POLICY_VERSION,
    kind: "cross_source_identity_binding",
    canonicalCandidateDigest:
      entry.canonicalCandidateDigest,
    candidateUserAliasDigest:
      entry.candidateUserAliasDigest,
    recallRecordDigest: entry.recallRecordDigest,
    recallRecordRevisionDigest:
      entry.recallRecordRevisionDigest,
    paraformHumanRecordDigest:
      entry.paraformHumanRecordDigest,
    paraformHumanRecordRevisionDigest:
      entry.paraformHumanRecordRevisionDigest,
    recallPointReadProcedure:
      SOURCE_IDENTITY_POINT_READ_PROCEDURES.recall,
    recallNormalizedInputDigest: semanticDigest(
      "test-recall-point-read-input-v1",
      entry.recallRecordDigest,
    ),
    paraformHumanPointReadProcedure:
      SOURCE_IDENTITY_POINT_READ_PROCEDURES.paraformHuman,
    paraformHumanNormalizedInputDigest: semanticDigest(
      "test-paraform-point-read-input-v1",
      entry.paraformHumanRecordDigest,
    ),
    decisionBoundaryAt,
    observedAt: "2026-07-26T00:00:30.000Z",
    collectorArtifactDigest:
      SOURCE_IDENTITY_BINDING_SOURCE_ARTIFACT_DIGEST,
    joinEvidenceDigest: semanticDigest(
      "test-identity-join-evidence-v1",
      {
        canonicalCandidateDigest:
          entry.canonicalCandidateDigest,
        candidateUserAliasDigest:
          entry.candidateUserAliasDigest,
      },
    ),
    receiptNonceDigest: "14".repeat(32),
    authorityKeyIdDigest: identityBindingKeyId(),
    ...fields,
  };
  return {
    ...material,
    receiptMac: overrideMac
      || signIdentityBindingReceipt(material, signingKey),
  };
}

function aliasMapFixture(entries, overrides = {}) {
  const decisionBoundaryAt =
    overrides.decisionBoundaryAt || T;
  const normalizedEntries = entries.map((entry) => {
    const normalized = aliasEvidenceEntry(entry);
    return {
      ...normalized,
      identityBindingReceipt:
        entry.identityBindingReceipt === null
          ? null
          : entry.identityBindingReceipt
            || identityBindingReceiptFixture(normalized, {
              decisionBoundaryAt,
            }),
    };
  });
  const semanticDigest = sourceWatermarkAliasSetDigest({
    decisionBoundaryAt,
    entries: normalizedEntries,
  });
  const passes = overrides.passes || [
    {
      passNumber: 1,
      startedAt: "2026-07-26T00:01:00.000Z",
      completedAt: "2026-07-26T00:02:00.000Z",
      exhaustive: true,
      cursorExhausted: true,
      pageCount: 1,
      edgeCount: normalizedEntries.length,
      semanticDigest,
      epochAtStart: ALIAS_EPOCH,
      epochAtEnd: ALIAS_EPOCH,
    },
    {
      passNumber: 2,
      startedAt: "2026-07-26T00:03:00.000Z",
      completedAt: "2026-07-26T00:04:00.000Z",
      exhaustive: true,
      cursorExhausted: true,
      pageCount: 1,
      edgeCount: normalizedEntries.length,
      semanticDigest,
      epochAtStart: ALIAS_EPOCH,
      epochAtEnd: ALIAS_EPOCH,
    },
  ];
  return buildCanonicalSourceAliasMap(normalizedEntries, {
    decisionBoundaryAt,
    ...SOURCE_WATERMARK_APPROVED_COLLECTORS.aliases,
    authoritative: true,
    snapshotComplete: true,
    passes,
    ...overrides,
  });
}

const recallSuccess = ({
  candidate = CANDIDATE_A,
  record = RECORD_RECALL_A,
  endedAt = "2026-07-25T20:00:00.000Z",
} = {}) => ({
  source: SOURCE_WATERMARK_SOURCES.RECALL,
  recordDigest: record,
  recordRevisionDigest:
    record === RECORD_RECALL_B
      ? REVISION_RECALL_B
      : REVISION_RECALL_A,
  classification: "success",
  identityStatus: "resolved",
  identityKind: "canonical_candidate",
  identityDigest: candidate,
  endedAt,
  provenanceVerified: true,
});

const humanSuccess = ({
  candidateUser = CANDIDATE_USER_A,
  record = RECORD_HUMAN_A,
  endedAt = "2026-07-25T21:00:00.000Z",
} = {}) => ({
  source: SOURCE_WATERMARK_SOURCES.PARAFORM_HUMAN,
  recordDigest: record,
  recordRevisionDigest:
    record === RECORD_HUMAN_B
      ? REVISION_HUMAN_B
      : REVISION_HUMAN_A,
  classification: "success",
  identityStatus: "resolved",
  identityKind: "candidate_user_alias",
  identityDigest: candidateUser,
  endedAt,
  provenanceVerified: true,
});

function issueCounts(facts) {
  return {
    pendingCount: facts.filter(
      (fact) => fact.classification === "pending",
    ).length,
    conflictCount: facts.filter((fact) => (
      fact.classification === "conflict"
      || fact.identityStatus === "conflict"
    )).length,
    unresolvedCount: facts.filter((fact) => (
      fact.classification === "success"
      && fact.identityStatus === "unresolved"
    )).length,
    invalidCount: facts.filter((fact) => (
      ["success", "failure"].includes(fact.classification)
      && fact.provenanceVerified !== true
    )).length,
  };
}

function certificateFixture(
  source,
  facts,
  {
    decisionBoundaryAt = T,
    epoch = source === SOURCE_WATERMARK_SOURCES.RECALL
      ? RECALL_EPOCH
      : PARAFORM_EPOCH,
    passOne = {},
    passTwo = {},
    passes = null,
  } = {},
) {
  const semanticDigest = sourceWatermarkFactSetDigest({
    source,
    decisionBoundaryAt,
    facts,
  });
  const counts = issueCounts(facts);
  const rows = passes || [
    {
      passNumber: 1,
      startedAt: "2026-07-26T00:01:00.000Z",
      completedAt: "2026-07-26T00:02:00.000Z",
      exhaustive: true,
      cursorExhausted: true,
      pageCount: 1,
      factCount: facts.length,
      ...counts,
      semanticDigest,
      epochAtStart: epoch,
      epochAtEnd: epoch,
      ...passOne,
    },
    {
      passNumber: 2,
      startedAt: "2026-07-26T00:03:00.000Z",
      completedAt: "2026-07-26T00:04:00.000Z",
      exhaustive: true,
      cursorExhausted: true,
      pageCount: 1,
      factCount: facts.length,
      ...counts,
      semanticDigest,
      epochAtStart: epoch,
      epochAtEnd: epoch,
      ...passTwo,
    },
  ];
  return buildSourceWatermarkCertificate({
    source,
    decisionBoundaryAt,
    ...(source === SOURCE_WATERMARK_SOURCES.RECALL
      ? SOURCE_WATERMARK_APPROVED_COLLECTORS.recall
      : SOURCE_WATERMARK_APPROVED_COLLECTORS.paraform_human),
    facts,
    passes: rows,
  });
}

function generationFixture({
  status = "planned",
  decisionBoundaryAt = T,
  recallFacts = [recallSuccess()],
  humanFacts = [humanSuccess()],
  recallCertificate = null,
  humanCertificate = null,
  aliasEntries = [{
    canonicalCandidateDigest: CANDIDATE_A,
    candidateUserAliasDigest: CANDIDATE_USER_A,
  }],
  aliasMap = null,
  committedAt = status === "committed" ? COMMITTED_AT : null,
  commitRevisionDigest =
    status === "committed" ? COMMIT_REVISION : null,
} = {}) {
  const recallCert = recallCertificate || certificateFixture(
    SOURCE_WATERMARK_SOURCES.RECALL,
    recallFacts,
    { decisionBoundaryAt },
  );
  const humanCert = humanCertificate || certificateFixture(
    SOURCE_WATERMARK_SOURCES.PARAFORM_HUMAN,
    humanFacts,
    { decisionBoundaryAt },
  );
  return buildSourceWatermarkGeneration({
    decisionBoundaryAt,
    generationNonceDigest: GENERATION_NONCE,
    status,
    committedAt,
    commitRevisionDigest,
    recall: {
      certificate: recallCert,
      facts: recallFacts,
    },
    paraformHuman: {
      certificate: humanCert,
      facts: humanFacts,
    },
    aliasMap: aliasMap || aliasMapFixture(
      aliasEntries,
    ),
  });
}

function currentEpochs(overrides = {}) {
  return {
    recall: RECALL_EPOCH,
    paraformHuman: PARAFORM_EPOCH,
    aliases: ALIAS_EPOCH,
    ...overrides,
  };
}

function createAuthorityKvFake({
  nowMs = Date.now(),
} = {}) {
  const records = new Map();
  const commands = [];
  const redisTime = () => [
    String(Math.floor(nowMs / 1_000)),
    String((nowMs % 1_000) * 1_000),
  ];
  const read = (key) => records.get(key) || "";
  const parse = (key) => {
    const raw = read(key);
    return raw ? JSON.parse(raw) : null;
  };
  const write = (key, value) => {
    const raw = JSON.stringify(value);
    records.set(key, raw);
    return raw;
  };
  const kv = async (command) => {
    commands.push(command);
    const script = command[1];
    const keys = command.slice(3, 3 + Number(command[2]));
    const args = command.slice(3 + Number(command[2]));
    const time = redisTime();

    if (script.includes("proposed.activatedAtMs = nowMs")) {
      const current = parse(keys[0]);
      if (current) {
        if (
          !args[0]
          || current.generationRecordDigest !== args[0]
          || current.durableGenerationRevisionDigest !== args[1]
          || current.durableRecordReceiptDigest !== args[2]
          || current.sourceEpochs.recall !== args[3]
          || current.sourceEpochs.paraformHuman !== args[4]
          || current.sourceEpochs.aliases !== args[5]
        ) {
          return [-3, read(keys[0]), ...time];
        }
      } else if (args[0]) {
        return [-4, "", ...time];
      }
      if (current && Number(args[6]) < nowMs) {
        return [-7, read(keys[0]), ...time];
      }
      const proposed = JSON.parse(args[7]);
      if (
        proposed.evidenceCeilingAtMs
          > nowMs + Number(args[8])
      ) {
        return [-8, "", ...time];
      }
      proposed.activatedAtMs = nowMs;
      return [1, write(keys[0], proposed), ...time];
    }

    if (script.includes("reservation.status = 'consumed'")) {
      const active = parse(keys[0]);
      const job = parse(keys[1]);
      const reservation = parse(keys[2]);
      if (!active || !job || !reservation) {
        return [-4, read(keys[2]), ...time];
      }
      if (
        active.generationRecordDigest !== args[0]
        || active.durableGenerationRevisionDigest !== args[1]
        || active.durableRecordReceiptDigest !== args[2]
        || active.sourceEpochs.recall !== args[3]
        || active.sourceEpochs.paraformHuman !== args[4]
        || active.sourceEpochs.aliases !== args[5]
        || createHash("sha1").update(read(keys[0]))
          .digest("hex") !== args[15]
      ) {
        return [-3, read(keys[2]), ...time];
      }
      if (
        job.jobBindingDigest !== args[6]
        || job.canonicalCandidateDigest !== args[7]
        || job.candidateUserAliasDigest !== args[8]
        || job.jobRevisionDigest !== args[9]
        || job.writeScopeDigest !== args[10]
      ) {
        return [-5, read(keys[2]), ...time];
      }
      if (
        reservation.reservationRecordSha1 !== args[11]
        || reservation.reservationNonceDigest !== args[12]
        || reservation.durableRecordReceiptDigest !== args[2]
        || reservation.jobBindingDigest !== args[6]
        || reservation.jobRevisionDigest !== args[9]
        || reservation.writeScopeDigest !== args[10]
        || reservation.activeRecordSha1 !== args[15]
      ) {
        return [-6, read(keys[2]), ...time];
      }
      if (reservation.status === "consumed") {
        return reservation.settledResultDigest === args[13]
          ? [2, read(keys[2]), ...time]
          : [-9, read(keys[2]), ...time];
      }
      if (reservation.expiresAtMs < nowMs) {
        return [-7, read(keys[2]), ...time];
      }
      reservation.status = "consumed";
      reservation.settledResultDigest = args[13];
      reservation.consumedAtMs = nowMs;
      return [1, write(keys[2], reservation), ...time];
    }

    if (script.includes("local reservation = {")) {
      const active = parse(keys[0]);
      const job = parse(keys[1]);
      if (!active || !job) {
        return [-4, read(keys[0]), read(keys[1]), "", ...time];
      }
      if (
        active.generationRecordDigest !== args[0]
        || active.durableGenerationRevisionDigest !== args[1]
        || active.durableRecordReceiptDigest !== args[2]
        || active.sourceEpochs.recall !== args[3]
        || active.sourceEpochs.paraformHuman !== args[4]
        || active.sourceEpochs.aliases !== args[5]
        || createHash("sha1").update(read(keys[0]))
          .digest("hex") !== args[20]
      ) {
        return [
          -3,
          read(keys[0]),
          read(keys[1]),
          "",
          ...time,
        ];
      }
      if (
        job.version !== 1
        || job.policyVersion !== args[6]
        || job.status !== "ready"
        || job.jobBindingDigest !== args[7]
        || job.canonicalCandidateDigest !== args[8]
        || job.candidateUserAliasDigest !== args[9]
        || job.jobRevisionDigest !== args[10]
        || job.writeScopeDigest !== args[11]
      ) {
        return [
          -5,
          read(keys[0]),
          read(keys[1]),
          "",
          ...time,
        ];
      }
      const existing = parse(keys[2]);
      if (existing) {
        const exact = (
          existing.durableRecordReceiptDigest === args[2]
          && existing.jobBindingDigest === args[7]
          && existing.canonicalCandidateDigest === args[8]
          && existing.candidateUserAliasDigest === args[9]
          && existing.jobRevisionDigest === args[10]
          && existing.writeScopeDigest === args[11]
          && existing.activeRecordSha1 === args[20]
        );
        return [
          exact ? 2 : -6,
          read(keys[0]),
          read(keys[1]),
          read(keys[2]),
          ...time,
        ];
      }
      const expiresAtMs = Math.min(
        nowMs + Number(args[12]),
        Number(args[13]),
      );
      if (expiresAtMs <= nowMs) {
        return [
          -7,
          read(keys[0]),
          read(keys[1]),
          "",
          ...time,
        ];
      }
      const reservation = {
        version: 1,
        policyVersion: args[6],
        status: "reserved",
        generationRecordDigest: args[0],
        durableGenerationRevisionDigest: args[1],
        durableRecordReceiptDigest: args[2],
        activeRecordSha1: args[20],
        sourceEpochs: {
          recall: args[3],
          paraformHuman: args[4],
          aliases: args[5],
        },
        jobBindingDigest: args[7],
        canonicalCandidateDigest: args[8],
        candidateUserAliasDigest: args[9],
        jobRevisionDigest: args[10],
        writeScopeDigest: args[11],
        q37DecisionDigest: args[14],
        callType: args[15],
        callEndedAt: args[16],
        reservedJobRevisionDigest: args[17],
        reservationNonceDigest: args[18],
        issuedAtMs: nowMs,
        expiresAtMs,
        settledResultDigest: null,
        consumedAtMs: null,
      };
      reservation.reservationRecordSha1 = createHash("sha1")
        .update(JSON.stringify(reservation))
        .digest("hex");
      return [
        1,
        read(keys[0]),
        read(keys[1]),
        write(keys[2], reservation),
        ...time,
      ];
    }

    return [read(keys[0]), ...time];
  };
  const putJob = (job = {}) => {
    const value = {
      version: 1,
      policyVersion: SOURCE_WATERMARK_POLICY_VERSION,
      status: "ready",
      jobBindingDigest: JOB_BINDING,
      canonicalCandidateDigest: CANDIDATE_A,
      candidateUserAliasDigest: CANDIDATE_USER_A,
      jobRevisionDigest: JOB_REVISION,
      writeScopeDigest: WRITE_SCOPE,
      ...job,
    };
    records.set(
      `paraai:phase4:source-authority:job:v1:${value.jobBindingDigest}`,
      JSON.stringify(value),
    );
    return value;
  };
  return {
    kv,
    putJob,
    records,
    commands,
    advance(ms) {
      nowMs += ms;
    },
  };
}

test("source certificate requires two exhaustive stable passes", () => {
  const facts = [recallSuccess()];
  const certificate = certificateFixture(
    SOURCE_WATERMARK_SOURCES.RECALL,
    facts,
  );
  assert.equal(certificate.complete, true);
  assert.equal(certificate.historyMode, "source_exhaustion");
  assert.equal(certificate.passCount, 2);
  assert.equal(certificate.factCount, 1);
  assert.equal(certificate.stablePasses, true);
  assert.equal(certificate.exhaustive, true);
  assert.equal(certificate.cursorExhausted, true);
  assert.equal(certificate.sourceEpochDigest, RECALL_EPOCH);
  assert.deepEqual(certificate.reasons, []);
  assert.equal(Object.isFrozen(certificate), true);
  assert.equal(Object.isFrozen(certificate.passes), true);
});

test("source fact digest is deterministic across input order", () => {
  const facts = [
    recallSuccess({
      candidate: CANDIDATE_B,
      record: RECORD_RECALL_B,
    }),
    recallSuccess(),
  ];
  const forward = sourceWatermarkFactSetDigest({
    source: SOURCE_WATERMARK_SOURCES.RECALL,
    decisionBoundaryAt: T,
    facts,
  });
  const reversed = sourceWatermarkFactSetDigest({
    source: SOURCE_WATERMARK_SOURCES.RECALL,
    decisionBoundaryAt: T,
    facts: [...facts].reverse(),
  });
  assert.equal(forward, reversed);
});

test("one pass, partial pagination, or a cap cannot certify a source", () => {
  const facts = [recallSuccess()];
  const onePass = certificateFixture(
    SOURCE_WATERMARK_SOURCES.RECALL,
    facts,
    {
      passes: [{
        passNumber: 1,
        startedAt: "2026-07-26T00:01:00.000Z",
        completedAt: "2026-07-26T00:02:00.000Z",
        exhaustive: true,
        cursorExhausted: true,
        pageCount: 1,
        factCount: 1,
        pendingCount: 0,
        conflictCount: 0,
        unresolvedCount: 0,
        invalidCount: 0,
        semanticDigest: sourceWatermarkFactSetDigest({
          source: SOURCE_WATERMARK_SOURCES.RECALL,
          decisionBoundaryAt: T,
          facts,
        }),
        epochAtStart: RECALL_EPOCH,
        epochAtEnd: RECALL_EPOCH,
      }],
    },
  );
  const partial = certificateFixture(
    SOURCE_WATERMARK_SOURCES.RECALL,
    facts,
    {
      passTwo: {
        exhaustive: false,
        cursorExhausted: false,
      },
    },
  );
  assert.equal(onePass.complete, false);
  assert.ok(onePass.reasons.includes("stable_passes_missing"));
  assert.equal(partial.complete, false);
  assert.ok(partial.reasons.includes("source_not_exhaustive"));
  assert.ok(partial.reasons.includes("cursor_not_exhausted"));
});

test("semantic drift or source epoch movement fails closed", () => {
  const facts = [recallSuccess()];
  const semanticDrift = certificateFixture(
    SOURCE_WATERMARK_SOURCES.RECALL,
    facts,
    { passTwo: { semanticDigest: digest("f") } },
  );
  const withinPassEpochDrift = certificateFixture(
    SOURCE_WATERMARK_SOURCES.RECALL,
    facts,
    { passTwo: { epochAtEnd: digest("f") } },
  );
  const betweenPassEpochDrift = certificateFixture(
    SOURCE_WATERMARK_SOURCES.RECALL,
    facts,
    {
      passTwo: {
        epochAtStart: digest("f"),
        epochAtEnd: digest("f"),
      },
    },
  );
  for (const certificate of [
    semanticDrift,
    withinPassEpochDrift,
    betweenPassEpochDrift,
  ]) {
    assert.equal(certificate.complete, false);
  }
  assert.ok(
    semanticDrift.reasons.includes("semantic_digest_mismatch"),
  );
  assert.ok(
    semanticDrift.reasons.includes(
      "stable_pass_digest_mismatch",
    ),
  );
  assert.ok(
    withinPassEpochDrift.reasons.includes("source_epoch_moved"),
  );
  assert.ok(
    betweenPassEpochDrift.reasons.includes("source_epoch_moved"),
  );
});

test("pass count mismatches, non-sequential scans, and pre-boundary scans fail closed", () => {
  const facts = [recallSuccess()];
  const countMismatch = certificateFixture(
    SOURCE_WATERMARK_SOURCES.RECALL,
    facts,
    { passTwo: { factCount: 0 } },
  );
  const nonSequential = certificateFixture(
    SOURCE_WATERMARK_SOURCES.RECALL,
    facts,
    {
      passTwo: {
        startedAt: "2026-07-26T00:01:30.000Z",
      },
    },
  );
  const preBoundary = certificateFixture(
    SOURCE_WATERMARK_SOURCES.RECALL,
    facts,
    {
      passOne: {
        startedAt: "2026-07-25T23:58:00.000Z",
        completedAt: "2026-07-26T00:00:30.000Z",
      },
    },
  );
  assert.ok(countMismatch.reasons.includes("fact_count_mismatch"));
  assert.ok(
    nonSequential.reasons.includes("passes_not_sequential"),
  );
  assert.ok(preBoundary.reasons.includes("pass_predates_boundary"));
  assert.equal(countMismatch.complete, false);
  assert.equal(nonSequential.complete, false);
  assert.equal(preBoundary.complete, false);
});

test("pending, conflict, unresolved success, and invalid provenance remain incomplete", () => {
  const rows = [
    {
      label: "pending_facts",
      fact: {
        source: SOURCE_WATERMARK_SOURCES.RECALL,
        recordDigest: RECORD_RECALL_A,
        classification: "pending",
        identityStatus: "unresolved",
        endedAt: null,
        provenanceVerified: false,
      },
    },
    {
      label: "source_conflicts",
      fact: {
        source: SOURCE_WATERMARK_SOURCES.RECALL,
        recordDigest: RECORD_RECALL_A,
        classification: "conflict",
        identityStatus: "conflict",
        endedAt: null,
        provenanceVerified: false,
      },
    },
    {
      label: "unresolved_success_identity",
      fact: {
        source: SOURCE_WATERMARK_SOURCES.RECALL,
        recordDigest: RECORD_RECALL_A,
        classification: "success",
        identityStatus: "unresolved",
        endedAt: "2026-07-25T20:00:00.000Z",
        provenanceVerified: true,
      },
    },
    {
      label: "invalid_provenance",
      fact: {
        ...recallSuccess(),
        provenanceVerified: false,
      },
    },
  ];
  for (const { label, fact } of rows) {
    const certificate = certificateFixture(
      SOURCE_WATERMARK_SOURCES.RECALL,
      [fact],
    );
    assert.equal(certificate.complete, false);
    assert.ok(certificate.reasons.includes(label));
  }
});

test("source facts reject duplicates, post-boundary calls, and cross-source identity kinds", () => {
  assert.throws(
    () => sourceWatermarkFactSetDigest({
      source: SOURCE_WATERMARK_SOURCES.RECALL,
      decisionBoundaryAt: T,
      facts: [recallSuccess(), recallSuccess()],
    }),
    (error) => (
      error instanceof SourceWatermarkInvariantError
      && error.code === "SOURCE_FACT_DUPLICATE"
    ),
  );
  assert.throws(
    () => sourceWatermarkFactSetDigest({
      source: SOURCE_WATERMARK_SOURCES.RECALL,
      decisionBoundaryAt: T,
      facts: [recallSuccess({
        endedAt: "2026-07-26T00:00:00.001Z",
      })],
    }),
    /after decisionBoundaryAt/,
  );
  assert.throws(
    () => sourceWatermarkFactSetDigest({
      source: SOURCE_WATERMARK_SOURCES.PARAFORM_HUMAN,
      decisionBoundaryAt: T,
      facts: [{
        ...humanSuccess(),
        identityKind: "canonical_candidate",
      }],
    }),
    /identity kind/,
  );
  assert.throws(
    () => sourceWatermarkFactSetDigest({
      source: SOURCE_WATERMARK_SOURCES.RECALL,
      decisionBoundaryAt: T,
      facts: [{
        ...recallSuccess(),
        source: SOURCE_WATERMARK_SOURCES.PARAFORM_HUMAN,
      }],
    }),
    (error) => error.code === "SOURCE_FACT_SOURCE_MISMATCH",
  );
});

test("collector versions and immutable code commitments are exact release pins", () => {
  assert.equal(
    SOURCE_WATERMARK_APPROVED_COLLECTORS.recall
      .artifact.mergeCommit,
    "e26818f6dc16725d132534cc8da5c7b84e6826e3",
  );
  assert.equal(
    SOURCE_WATERMARK_APPROVED_COLLECTORS.recall
      .artifact.runtimeFileSha256,
    "b03ef301a7fe6037c81fa81a833f72231f1be8707fd001d117fdad15626dd04e",
  );
  assert.equal(
    SOURCE_WATERMARK_APPROVED_COLLECTORS.paraform_human
      .artifact.runtimeFileSha256,
    "d5e1a75cb8884af409fd7750fb54ced80185c2881b48b3a2042e9b95af621c11",
  );
  assert.equal(
    SOURCE_WATERMARK_APPROVED_COLLECTORS.aliases
      .collectorCodeCommitmentDigest,
    null,
  );
  const facts = [recallSuccess()];
  const certificate = certificateFixture(
    SOURCE_WATERMARK_SOURCES.RECALL,
    facts,
  );
  for (const overrides of [
    { collectorVersion: "recall-source-v999" },
    { collectorCodeCommitmentDigest: digest("f") },
  ]) {
    assert.throws(
      () => buildSourceWatermarkCertificate({
        source: SOURCE_WATERMARK_SOURCES.RECALL,
        decisionBoundaryAt: T,
        ...SOURCE_WATERMARK_APPROVED_COLLECTORS.recall,
        ...overrides,
        facts,
        passes: certificate.passes,
      }),
      (error) => error.code === "SOURCE_COLLECTOR_PIN_MISMATCH",
    );
  }
  const aliases = aliasMapFixture([{
    canonicalCandidateDigest: CANDIDATE_A,
    candidateUserAliasDigest: CANDIDATE_USER_A,
  }]);
  assert.throws(
    () => buildCanonicalSourceAliasMap(aliases.entries, {
      decisionBoundaryAt: T,
      ...SOURCE_WATERMARK_APPROVED_COLLECTORS.aliases,
      collectorVersion: "source-alias-evidence-v999",
      authoritative: true,
      snapshotComplete: true,
      passes: aliases.passes,
    }),
    (error) => error.code === "SOURCE_COLLECTOR_PIN_MISMATCH",
  );
});

test("alias map is a deterministic one-to-one canonical binding", () => {
  const entries = [
    {
      canonicalCandidateDigest: CANDIDATE_B,
      candidateUserAliasDigest: CANDIDATE_USER_B,
    },
    {
      canonicalCandidateDigest: CANDIDATE_A,
      candidateUserAliasDigest: CANDIDATE_USER_A,
    },
  ];
  const forward = aliasMapFixture(entries);
  const reverse = aliasMapFixture(
    [...entries].reverse(),
  );
  assert.equal(forward.complete, true);
  assert.equal(forward.authoritative, true);
  assert.equal(forward.snapshotComplete, true);
  assert.equal(forward.epochStable, true);
  assert.equal(forward.aliasEpochDigest, ALIAS_EPOCH);
  assert.equal(forward.conflictCount, 0);
  assert.equal(forward.canonicalCandidateCount, 2);
  assert.equal(forward.candidateUserAliasCount, 2);
  assert.equal(forward.aliasMapDigest, reverse.aliasMapDigest);
});

test("alias map requires an authoritative complete snapshot with a stable epoch", () => {
  const entries = [{
    canonicalCandidateDigest: CANDIDATE_A,
    candidateUserAliasDigest: CANDIDATE_USER_A,
  }];
  const nonAuthoritative = aliasMapFixture(entries, {
    authoritative: false,
  });
  const incomplete = aliasMapFixture(entries, {
    snapshotComplete: false,
  });
  const stable = aliasMapFixture(entries);
  const moved = aliasMapFixture(entries, {
    passes: stable.passes.map((pass, index) => ({
      ...pass,
      epochAtEnd: index === 1 ? digest("f") : ALIAS_EPOCH,
    })),
  });
  for (const aliasMap of [
    nonAuthoritative,
    incomplete,
    moved,
  ]) {
    assert.equal(aliasMap.complete, false);
  }
  assert.equal(moved.epochStable, false);
  assert.equal(moved.aliasEpochDigest, null);
});

test("alias fan-in, fan-out, and duplicate edges fail closed", () => {
  const fanOut = aliasMapFixture([
    {
      canonicalCandidateDigest: CANDIDATE_A,
      candidateUserAliasDigest: CANDIDATE_USER_A,
    },
    {
      canonicalCandidateDigest: CANDIDATE_A,
      candidateUserAliasDigest: CANDIDATE_USER_B,
    },
  ]);
  const fanIn = aliasMapFixture([
    {
      canonicalCandidateDigest: CANDIDATE_A,
      candidateUserAliasDigest: CANDIDATE_USER_A,
    },
    {
      canonicalCandidateDigest: CANDIDATE_B,
      candidateUserAliasDigest: CANDIDATE_USER_A,
    },
  ]);
  const duplicate = aliasMapFixture([
    {
      canonicalCandidateDigest: CANDIDATE_A,
      candidateUserAliasDigest: CANDIDATE_USER_A,
    },
    {
      canonicalCandidateDigest: CANDIDATE_A,
      candidateUserAliasDigest: CANDIDATE_USER_A,
    },
  ]);
  assert.equal(fanOut.complete, false);
  assert.equal(fanOut.canonicalConflictCount, 1);
  assert.equal(fanIn.complete, false);
  assert.equal(fanIn.aliasConflictCount, 1);
  assert.equal(duplicate.complete, false);
  assert.equal(duplicate.duplicateEntryCount, 1);
});

test("cross-source alias edges require a separately authenticated binding receipt", () => {
  const entry = aliasEvidenceEntry({
    canonicalCandidateDigest: CANDIDATE_A,
    candidateUserAliasDigest: CANDIDATE_USER_A,
  });
  const missing = aliasMapFixture([{
    ...entry,
    identityBindingReceipt: null,
  }]);
  const validReceipt = identityBindingReceiptFixture(entry);
  const forged = aliasMapFixture([{
    ...entry,
    identityBindingReceipt: {
      ...validReceipt,
      receiptMac: digest("f"),
    },
  }]);
  const savedKey =
    process.env[SOURCE_IDENTITY_BINDING_AUTHORITY_KEY_ENV];
  delete process.env[SOURCE_IDENTITY_BINDING_AUTHORITY_KEY_ENV];
  let unavailable;
  try {
    unavailable = aliasMapFixture([{
      ...entry,
      identityBindingReceipt: validReceipt,
    }]);
  } finally {
    process.env[SOURCE_IDENTITY_BINDING_AUTHORITY_KEY_ENV] =
      savedKey;
  }

  for (const aliasMap of [missing, forged, unavailable]) {
    assert.equal(aliasMap.complete, false);
    assert.equal(aliasMap.identityBindingProvenCount, 0);
    assert.equal(aliasMap.identityBindingUnprovenCount, 1);
    assert.ok(
      aliasMap.reasons.includes(
        "identity_binding_receipts_unproven",
      ),
    );
  }
});

test("a swapped structural bijection cannot prove cross-source identity", () => {
  const first = aliasEvidenceEntry({
    canonicalCandidateDigest: CANDIDATE_A,
    candidateUserAliasDigest: CANDIDATE_USER_A,
  });
  const second = aliasEvidenceEntry({
    canonicalCandidateDigest: CANDIDATE_B,
    candidateUserAliasDigest: CANDIDATE_USER_B,
  });
  const swapped = aliasMapFixture([
    {
      ...first,
      candidateUserAliasDigest: CANDIDATE_USER_B,
      identityBindingReceipt:
        identityBindingReceiptFixture(first),
    },
    {
      ...second,
      candidateUserAliasDigest: CANDIDATE_USER_A,
      identityBindingReceipt:
        identityBindingReceiptFixture(second),
    },
  ]);
  assert.equal(swapped.canonicalConflictCount, 0);
  assert.equal(swapped.aliasConflictCount, 0);
  assert.equal(swapped.identityBindingProvenCount, 0);
  assert.equal(swapped.complete, false);
});

test("Q37 selects the newest successful source and ignores newer failures", () => {
  const facts = [
    recallSuccess({ endedAt: "2026-07-25T20:00:00.000Z" }),
    {
      ...recallSuccess({
        record: RECORD_RECALL_B,
        endedAt: "2026-07-25T23:00:00.000Z",
      }),
      classification: "failure",
    },
    humanSuccess({ endedAt: "2026-07-25T21:00:00.000Z" }),
  ];
  const decision = q37NewestSuccessfulCallDecision({
    decisionBoundaryAt: T,
    facts,
  });
  assert.equal(decision.decision, "selected");
  assert.equal(decision.callType, "human");
  assert.equal(decision.endedAt, "2026-07-25T21:00:00.000Z");
});

test("Q37 handles both recency directions and exact cross-type ties", () => {
  const agentNewest = q37NewestSuccessfulCallDecision({
    decisionBoundaryAt: T,
    facts: [
      humanSuccess({ endedAt: "2026-07-25T20:00:00.000Z" }),
      recallSuccess({ endedAt: "2026-07-25T21:00:00.000Z" }),
    ],
  });
  const tie = q37NewestSuccessfulCallDecision({
    decisionBoundaryAt: T,
    facts: [
      humanSuccess({ endedAt: "2026-07-25T21:00:00.000Z" }),
      recallSuccess({ endedAt: "2026-07-25T21:00:00.000Z" }),
    ],
  });
  assert.equal(agentNewest.callType, "agent");
  assert.equal(tie.decision, "review_ambiguous_tie");
  assert.equal(tie.callType, null);
});

test("Q37 accepts an exact same-type tie without inventing ambiguity", () => {
  const decision = q37NewestSuccessfulCallDecision({
    decisionBoundaryAt: T,
    facts: [
      recallSuccess({
        record: RECORD_RECALL_A,
        endedAt: "2026-07-25T21:00:00.000Z",
      }),
      recallSuccess({
        record: RECORD_RECALL_B,
        endedAt: "2026-07-25T21:00:00.000Z",
      }),
    ],
  });
  assert.equal(decision.decision, "selected");
  assert.equal(decision.callType, "agent");
});

test("Q37 cannot select from pending, conflicting, or unverified source evidence", () => {
  const pending = q37NewestSuccessfulCallDecision({
    decisionBoundaryAt: T,
    facts: [{
      source: SOURCE_WATERMARK_SOURCES.RECALL,
      recordDigest: RECORD_RECALL_A,
      classification: "pending",
      identityStatus: "unresolved",
      endedAt: null,
      provenanceVerified: false,
    }],
  });
  const unresolved = q37NewestSuccessfulCallDecision({
    decisionBoundaryAt: T,
    facts: [{
      source: SOURCE_WATERMARK_SOURCES.RECALL,
      recordDigest: RECORD_RECALL_A,
      classification: "success",
      identityStatus: "unresolved",
      endedAt: "2026-07-25T21:00:00.000Z",
      provenanceVerified: true,
    }],
  });
  assert.equal(pending.decision, "review_incomplete_source");
  assert.equal(unresolved.decision, "review_incomplete_source");
  assert.equal(pending.callType, null);
  assert.equal(unresolved.callType, null);
});

test("combined generation binds both source certificates, aliases, and Q37", () => {
  const generation = generationFixture();
  assert.equal(generation.status, "planned");
  assert.equal(generation.intrinsicSourceComplete, true);
  assert.equal(generation.intrinsicQ37Ready, true);
  assert.equal(generation.q37.humanCount, 1);
  assert.equal(generation.q37.reviewCount, 0);
  assert.match(generation.manifestDigest, /^[a-f0-9]{64}$/);
  assert.equal(
    validateSourceWatermarkGeneration(generation).recordDigest,
    generation.recordDigest,
  );
});

test("persisted certificate, alias, manifest, and record tampering are rejected", () => {
  const generation = generationFixture();
  const factTamper = structuredClone(generation);
  factTamper.sources.recall.facts[0].endedAt =
    "2026-07-25T19:00:00.000Z";
  assert.throws(
    () => validateSourceWatermarkGeneration(factTamper),
    (error) => error.code === "SOURCE_CERTIFICATE_DIGEST_MISMATCH",
  );

  const aliasTamper = structuredClone(generation);
  aliasTamper.aliasMap.entries[0].candidateUserAliasDigest =
    digest("f");
  assert.throws(
    () => validateSourceWatermarkGeneration(aliasTamper),
    (error) => error.code === "SOURCE_ALIAS_MAP_DIGEST_MISMATCH",
  );

  const manifestTamper = structuredClone(generation);
  manifestTamper.manifestDigest = digest("f");
  assert.throws(
    () => validateSourceWatermarkGeneration(manifestTamper),
    (error) => error.code === "SOURCE_WATERMARK_MANIFEST_MISMATCH",
  );

  const recordTamper = structuredClone(generation);
  recordTamper.recordDigest = digest("f");
  assert.throws(
    () => validateSourceWatermarkGeneration(recordTamper),
    (error) => error.code === "SOURCE_WATERMARK_RECORD_MISMATCH",
  );
});

test("combined manifest is deterministic across source fact order", () => {
  const recallFacts = [
    recallSuccess(),
    recallSuccess({
      candidate: CANDIDATE_B,
      record: RECORD_RECALL_B,
    }),
  ];
  const humanFacts = [
    humanSuccess(),
    humanSuccess({
      candidateUser: CANDIDATE_USER_B,
      record: RECORD_HUMAN_B,
    }),
  ];
  const aliasEntries = [
    {
      canonicalCandidateDigest: CANDIDATE_A,
      candidateUserAliasDigest: CANDIDATE_USER_A,
    },
    {
      canonicalCandidateDigest: CANDIDATE_B,
      candidateUserAliasDigest: CANDIDATE_USER_B,
    },
  ];
  const first = generationFixture({
    recallFacts,
    humanFacts,
    aliasEntries,
  });
  const second = generationFixture({
    recallFacts: [...recallFacts].reverse(),
    humanFacts: [...humanFacts].reverse(),
    aliasEntries: [...aliasEntries].reverse(),
  });
  assert.equal(first.manifestDigest, second.manifestDigest);
  assert.equal(
    first.q37.decisionSetDigest,
    second.q37.decisionSetDigest,
  );
});

test("both sources must use the exact common decision boundary", () => {
  const otherBoundary = "2026-07-25T23:59:00.000Z";
  const humanFacts = [humanSuccess({
    endedAt: "2026-07-25T21:00:00.000Z",
  })];
  const mismatchedHuman = certificateFixture(
    SOURCE_WATERMARK_SOURCES.PARAFORM_HUMAN,
    humanFacts,
    { decisionBoundaryAt: otherBoundary },
  );
  assert.throws(
    () => generationFixture({
      humanFacts,
      humanCertificate: mismatchedHuman,
    }),
    (error) => (
      error instanceof SourceWatermarkInvariantError
      && error.code === "SOURCE_BOUNDARY_MISMATCH"
    ),
  );
});

test("missing canonical alias coverage keeps a planned generation incomplete", () => {
  const generation = generationFixture({
    recallFacts: [recallSuccess({
      candidate: CANDIDATE_B,
    })],
  });
  assert.equal(generation.intrinsicSourceComplete, false);
  assert.equal(generation.intrinsicQ37Ready, false);
  assert.equal(generation.q37.identityIssueCount, 1);
});

test("a bijective alias edge without matching source-record proof remains incomplete", () => {
  const aliasMap = aliasMapFixture([{
    canonicalCandidateDigest: CANDIDATE_A,
    candidateUserAliasDigest: CANDIDATE_USER_B,
    recallRecordDigest: RECORD_RECALL_A,
    // This record proves candidate-user A, not the declared B edge.
    paraformHumanRecordDigest: RECORD_HUMAN_A,
  }]);
  assert.equal(aliasMap.complete, true);
  const generation = generationFixture({ aliasMap });
  assert.equal(generation.aliasEvidence.sourceProven, false);
  assert.equal(generation.aliasEvidence.unprovenEntryCount, 1);
  assert.equal(generation.intrinsicSourceComplete, false);
  assert.equal(generation.intrinsicQ37Ready, false);
});

test("an incomplete source or ambiguous Q37 generation cannot be committed", () => {
  const pending = {
    source: SOURCE_WATERMARK_SOURCES.RECALL,
    recordDigest: RECORD_RECALL_A,
    classification: "pending",
    identityStatus: "unresolved",
    endedAt: null,
    provenanceVerified: false,
  };
  assert.throws(
    () => generationFixture({
      status: "committed",
      recallFacts: [pending],
    }),
    (error) => (
      error instanceof SourceWatermarkInvariantError
      && error.code === "SOURCE_WATERMARK_COMMIT_NOT_READY"
    ),
  );
  assert.throws(
    () => generationFixture({
      status: "committed",
      recallFacts: [recallSuccess({
        endedAt: "2026-07-25T21:00:00.000Z",
      })],
      humanFacts: [humanSuccess({
        endedAt: "2026-07-25T21:00:00.000Z",
      })],
    }),
    (error) => (
      error instanceof SourceWatermarkInvariantError
      && error.code === "SOURCE_WATERMARK_COMMIT_NOT_READY"
    ),
  );
});

test("commit metadata is state-bound and cannot predate the stable capture", () => {
  assert.throws(
    () => generationFixture({
      committedAt: COMMITTED_AT,
      commitRevisionDigest: COMMIT_REVISION,
    }),
    /planned generations cannot carry commit metadata/,
  );
  assert.throws(
    () => generationFixture({
      status: "committed",
      committedAt: "2026-07-26T00:03:30.000Z",
    }),
    (error) => (
      error.code === "SOURCE_WATERMARK_COMMIT_PREDATES_CAPTURE"
    ),
  );
});

test("public readiness is false without a committed current generation", () => {
  const empty = sourceWatermarkPublicStatus();
  const planned = sourceWatermarkPublicStatus({
    generation: generationFixture(),
    // Former caller-supplied "current" assertions are deliberately ignored.
    currentManifestDigest: digest("f"),
    currentSourceEpochs: currentEpochs(),
  });
  assert.equal(empty.status, "not_committed");
  assert.equal(empty.sourceWatermarkComplete, false);
  assert.equal(empty.phase4Q37Ready, false);
  assert.equal(planned.status, "not_committed");
  assert.equal(planned.sourceWatermarkComplete, false);
  assert.equal(planned.phase4Q37Ready, false);
});

test("synthetic facts and caller assertions cannot replace private store authority", () => {
  const generation = generationFixture({ status: "committed" });
  const savedKey = process.env[SOURCE_WATERMARK_AUTHORITY_KEY_ENV];
  delete process.env[SOURCE_WATERMARK_AUTHORITY_KEY_ENV];
  try {
    const status = sourceWatermarkPublicStatus({
      generation,
      currentManifestDigest: generation.manifestDigest,
      currentSourceEpochs: currentEpochs(),
      generationAuthorityReceipt:
        generationAuthorityReceiptFixture(generation),
    });
    assert.equal(status.status, "store_required");
    assert.equal(status.phase4Q37Ready, false);
    assert.throws(
      () => buildPhase4WriteBoundaryAttestation({
        generation,
        generationAuthorityReceipt:
          generationAuthorityReceiptFixture(generation),
        canonicalCandidateDigest: CANDIDATE_A,
        candidateUserAliasDigest: CANDIDATE_USER_A,
        jobRevisionDigest: JOB_REVISION,
        writeScopeDigest: WRITE_SCOPE,
      }),
      (error) => error.code === "SOURCE_AUTHORITY_STORE_REQUIRED",
    );
  } finally {
    process.env[SOURCE_WATERMARK_AUTHORITY_KEY_ENV] = savedKey;
  }
});

test("caller-fed durable generation receipts never create public readiness", () => {
  const generation = generationFixture({ status: "committed" });
  const authorityReceipt =
    generationAuthorityReceiptFixture(generation);
  const ready = sourceWatermarkPublicStatus({
    generation,
    generationAuthorityReceipt: authorityReceipt,
  });
  const missing = sourceWatermarkPublicStatus({
    generation,
  });
  const tamperedRevision = {
    ...authorityReceipt,
    durableGenerationRevisionDigest: digest("f"),
  };
  const untrusted = sourceWatermarkPublicStatus({
    generation,
    generationAuthorityReceipt: tamperedRevision,
  });
  assert.equal(ready.status, "store_required");
  assert.equal(ready.sourceWatermarkComplete, false);
  assert.equal(ready.phase4Q37Ready, false);
  assert.equal(missing.status, "store_required");
  assert.equal(missing.phase4Q37Ready, false);
  assert.equal(untrusted.status, "store_required");
  assert.equal(untrusted.phase4Q37Ready, false);
});

test("validly signed future and expired authority clocks fail closed", () => {
  const generation = generationFixture({ status: "committed" });
  const future = generationAuthorityReceiptFixture(generation, {
    issuedAt: "2099-01-01T00:00:00.000Z",
    expiresAt: "2099-01-01T00:00:30.000Z",
  });
  const expired = generationAuthorityReceiptFixture(generation, {
    issuedAt: "2026-07-26T00:10:00.000Z",
    expiresAt: "2026-07-26T00:10:30.000Z",
  });
  for (const receipt of [future, expired]) {
    const status = sourceWatermarkPublicStatus({
      generation,
      generationAuthorityReceipt: receipt,
    });
    assert.equal(status.status, "store_required");
    assert.equal(status.phase4Q37Ready, false);
  }
});

test("public readiness is aggregate-only and strips all source and identity digests", () => {
  const generation = generationFixture({ status: "committed" });
  const status = sourceWatermarkPublicStatus({
    generation,
    generationAuthorityReceipt:
      generationAuthorityReceiptFixture(generation),
  });
  const serialized = JSON.stringify(status);
  for (const privateDigest of [
    CANDIDATE_A,
    CANDIDATE_USER_A,
    RECORD_RECALL_A,
    RECORD_HUMAN_A,
    RECALL_EPOCH,
    PARAFORM_EPOCH,
    ALIAS_EPOCH,
  ]) {
    assert.equal(serialized.includes(privateDigest), false);
  }
  assert.equal("decisions" in status.q37, false);
  assert.equal("entries" in status.aliases, false);
  assert.equal("passes" in status.sources.recall, false);
});

test("invalid persisted generation fails closed in public status", () => {
  const generation = structuredClone(
    generationFixture({ status: "committed" }),
  );
  generation.manifestDigest = digest("f");
  const status = sourceWatermarkPublicStatus({
    generation,
    generationAuthorityReceipt:
      generationAuthorityReceiptFixture(generation),
  });
  assert.equal(status.status, "invalid");
  assert.equal(status.sourceWatermarkComplete, false);
  assert.equal(status.phase4Q37Ready, false);
});

test("pure write APIs cannot mint or validate operational authority", () => {
  const generation = generationFixture({ status: "committed" });
  const generationAuthorityReceipt =
    generationAuthorityReceiptFixture(generation);
  for (const operation of [
    () => buildPhase4WriteBoundaryAttestation({
      generation,
      generationAuthorityReceipt,
      canonicalCandidateDigest: CANDIDATE_A,
      candidateUserAliasDigest: CANDIDATE_USER_A,
      jobRevisionDigest: JOB_REVISION,
      writeScopeDigest: WRITE_SCOPE,
    }),
    () => validatePhase4WriteBoundaryAttestation({
      generation,
      generationAuthorityReceipt,
    }),
  ]) {
    assert.throws(
      operation,
      (error) => (
        error.code === "SOURCE_AUTHORITY_STORE_REQUIRED"
      ),
    );
  }
  assert.equal(
    sourceWatermarkPublicStatus({
      generation,
      generationAuthorityReceipt,
    }).phase4Q37Ready,
    false,
  );
});

test("KV authority alone reports a current ready generation from Redis TIME", async () => {
  const fake = createAuthorityKvFake();
  const generation = generationFixture({ status: "committed" });
  const activated = await activateSourceAuthorityGeneration(
    { generation },
    { kvImpl: fake.kv },
  );
  const current = await readCurrentSourceAuthority({
    kvImpl: fake.kv,
  });
  const status = await getSourceAuthorityOperationalStatus({
    kvImpl: fake.kv,
  });

  assert.equal(
    activated.active.generationRecordDigest,
    generation.recordDigest,
  );
  assert.equal(
    current.active.durableRecordReceiptDigest,
    activated.active.durableRecordReceiptDigest,
  );
  assert.equal(
    current.generationAuthorityReceipt
      .durableRecordReceiptDigest,
    activated.active.durableRecordReceiptDigest,
  );
  assert.equal(status.status, "ready");
  assert.equal(status.current, true);
  assert.equal(status.sourceWatermarkComplete, true);
  assert.equal(status.phase4Q37Ready, true);
  assert.match(
    fake.commands[0][1],
    /redis\.call\('TIME'\)/u,
  );
  assert.match(
    fake.commands[0][1],
    /durableGenerationRevisionDigest/u,
  );
  assert.match(
    fake.commands[0][1],
    /durableRecordReceiptDigest/u,
  );
});

test("simultaneous fresh revisions cannot both remain current", async () => {
  const fake = createAuthorityKvFake();
  const generation = generationFixture({ status: "committed" });
  const first = await activateSourceAuthorityGeneration(
    { generation },
    { kvImpl: fake.kv },
  );
  const attempts = await Promise.allSettled([
    activateSourceAuthorityGeneration(
      {
        generation,
        expectedActiveGenerationReceipt:
          first.generationAuthorityReceipt,
      },
      { kvImpl: fake.kv },
    ),
    activateSourceAuthorityGeneration(
      {
        generation,
        expectedActiveGenerationReceipt:
          first.generationAuthorityReceipt,
      },
      { kvImpl: fake.kv },
    ),
  ]);
  assert.equal(
    attempts.filter((attempt) => attempt.status === "fulfilled")
      .length,
    1,
  );
  const rejected = attempts.find(
    (attempt) => attempt.status === "rejected",
  );
  assert.equal(
    rejected.reason.code,
    "SOURCE_AUTHORITY_ACTIVE_REVISION_CONFLICT",
  );
  const current = await readCurrentSourceAuthority({
    kvImpl: fake.kv,
  });
  assert.notEqual(
    current.active.durableGenerationRevisionDigest,
    first.active.durableGenerationRevisionDigest,
  );
});

test("reserve compares current generation epochs and exact durable job state", async () => {
  const fake = createAuthorityKvFake();
  await activateSourceAuthorityGeneration(
    { generation: generationFixture({ status: "committed" }) },
    { kvImpl: fake.kv },
  );
  fake.putJob();
  const reserved = await reserveSourceAuthorityWrite(
    {
      jobBindingDigest: JOB_BINDING,
      canonicalCandidateDigest: CANDIDATE_A,
      candidateUserAliasDigest: CANDIDATE_USER_A,
      jobRevisionDigest: JOB_REVISION,
      writeScopeDigest: WRITE_SCOPE,
    },
    { kvImpl: fake.kv },
  );
  assert.equal(reserved.allowed, false);
  assert.equal(reserved.status, "reserved");
  assert.equal(reserved.duplicate, false);
  assert.match(
    reserved.reservationReceipt.reservationRecordSha1,
    /^[a-f0-9]{40}$/u,
  );
  const reserveCommand = fake.commands.find(
    (command) => command[1].includes("local reservation = {"),
  );
  assert.equal(reserveCommand[2], 3);
  assert.match(reserveCommand[1], /redis\.call\('TIME'\)/u);
  assert.match(
    reserveCommand[1],
    /active\.generationRecordDigest ~= ARGV\[1\]/u,
  );
  assert.match(
    reserveCommand[1],
    /active\.durableGenerationRevisionDigest ~= ARGV\[2\]/u,
  );
  assert.match(
    reserveCommand[1],
    /active\.sourceEpochs\.aliases ~= ARGV\[6\]/u,
  );
  assert.match(
    reserveCommand[1],
    /job\.jobRevisionDigest ~= ARGV\[11\]/u,
  );
  assert.match(
    reserveCommand[1],
    /job\.writeScopeDigest ~= ARGV\[12\]/u,
  );
});

test("consume authorizes once and an exact retry returns the settled result", async () => {
  const fake = createAuthorityKvFake();
  await activateSourceAuthorityGeneration(
    { generation: generationFixture({ status: "committed" }) },
    { kvImpl: fake.kv },
  );
  fake.putJob();
  const reserved = await reserveSourceAuthorityWrite(
    {
      jobBindingDigest: JOB_BINDING,
      canonicalCandidateDigest: CANDIDATE_A,
      candidateUserAliasDigest: CANDIDATE_USER_A,
      jobRevisionDigest: JOB_REVISION,
      writeScopeDigest: WRITE_SCOPE,
    },
    { kvImpl: fake.kv },
  );
  const input = {
    reservationReceipt: reserved.reservationReceipt,
    expectedJobBindingDigest: JOB_BINDING,
    expectedJobRevisionDigest: JOB_REVISION,
    expectedWriteScopeDigest: WRITE_SCOPE,
    settledResultDigest: SETTLED_RESULT,
  };
  const first = await consumeSourceAuthorityWriteReservation(
    input,
    { kvImpl: fake.kv },
  );
  const retry = await consumeSourceAuthorityWriteReservation(
    input,
    { kvImpl: fake.kv },
  );
  assert.equal(first.allowed, true);
  assert.equal(first.duplicate, false);
  assert.equal(retry.allowed, false);
  assert.equal(retry.duplicate, true);
  assert.equal(retry.settledResultDigest, SETTLED_RESULT);
  await assert.rejects(
    consumeSourceAuthorityWriteReservation(
      {
        ...input,
        settledResultDigest: digest("f"),
      },
      { kvImpl: fake.kv },
    ),
    (error) => (
      error.code === "SOURCE_AUTHORITY_SETTLED_RESULT_CONFLICT"
    ),
  );
  const consumeCommand = fake.commands.find(
    (command) => command[1].includes(
      "reservation.status = 'consumed'",
    ),
  );
  assert.match(consumeCommand[1], /redis\.call\('TIME'\)/u);
  assert.match(
    consumeCommand[1],
    /reservation\.status == 'consumed'/u,
  );
});

test("old receipts and cross-job or cross-scope replay fail after replacement", async () => {
  const fake = createAuthorityKvFake();
  const generation = generationFixture({ status: "committed" });
  const first = await activateSourceAuthorityGeneration(
    { generation },
    { kvImpl: fake.kv },
  );
  fake.putJob();
  const reserved = await reserveSourceAuthorityWrite(
    {
      jobBindingDigest: JOB_BINDING,
      canonicalCandidateDigest: CANDIDATE_A,
      candidateUserAliasDigest: CANDIDATE_USER_A,
      jobRevisionDigest: JOB_REVISION,
      writeScopeDigest: WRITE_SCOPE,
    },
    { kvImpl: fake.kv },
  );
  const second = await activateSourceAuthorityGeneration(
    {
      generation,
      expectedActiveGenerationReceipt:
        first.generationAuthorityReceipt,
    },
    { kvImpl: fake.kv },
  );
  assert.notEqual(
    second.active.durableRecordReceiptDigest,
    first.active.durableRecordReceiptDigest,
  );
  await assert.rejects(
    activateSourceAuthorityGeneration(
      {
        generation,
        expectedActiveGenerationReceipt:
          first.generationAuthorityReceipt,
      },
      { kvImpl: fake.kv },
    ),
    (error) => (
      error.code === "SOURCE_AUTHORITY_ACTIVE_REVISION_CONFLICT"
    ),
  );
  const consumeInput = {
    reservationReceipt: reserved.reservationReceipt,
    expectedJobBindingDigest: JOB_BINDING,
    expectedJobRevisionDigest: JOB_REVISION,
    expectedWriteScopeDigest: WRITE_SCOPE,
    settledResultDigest: SETTLED_RESULT,
  };
  await assert.rejects(
    consumeSourceAuthorityWriteReservation(
      consumeInput,
      { kvImpl: fake.kv },
    ),
    (error) => (
      error.code === "SOURCE_AUTHORITY_ACTIVE_REVISION_CONFLICT"
    ),
  );
  for (const overrides of [
    { expectedJobBindingDigest: digest("f") },
    { expectedJobRevisionDigest: digest("f") },
    { expectedWriteScopeDigest: digest("f") },
  ]) {
    await assert.rejects(
      consumeSourceAuthorityWriteReservation(
        { ...consumeInput, ...overrides },
        { kvImpl: fake.kv },
      ),
      (error) => (
        error.code
          === "SOURCE_AUTHORITY_RESERVATION_EXPECTATION_MISMATCH"
      ),
    );
  }
});

test("missing keys/store and malformed durable state remain dark", async () => {
  const fake = createAuthorityKvFake();
  fake.records.set(
    "paraai:phase4:source-authority:active:v1",
    JSON.stringify({ version: 1 }),
  );
  await assert.rejects(
    readCurrentSourceAuthority({ kvImpl: fake.kv }),
    (error) => (
      error.code === "SOURCE_AUTHORITY_DURABLE_STATE_MALFORMED"
    ),
  );
  assert.equal(
    (await getSourceAuthorityOperationalStatus({
      kvImpl: fake.kv,
    })).phase4Q37Ready,
    false,
  );

  const savedAuthority =
    process.env[SOURCE_WATERMARK_AUTHORITY_KEY_ENV];
  const savedUrl = process.env.KV_REST_API_URL;
  const savedToken = process.env.KV_REST_API_TOKEN;
  delete process.env[SOURCE_WATERMARK_AUTHORITY_KEY_ENV];
  delete process.env.KV_REST_API_URL;
  delete process.env.KV_REST_API_TOKEN;
  try {
    const status = await getSourceAuthorityOperationalStatus({
      kvImpl: fake.kv,
    });
    assert.equal(status.status, "store_unavailable");
    assert.equal(status.current, false);
    assert.equal(status.phase4Q37Ready, false);
    await assert.rejects(
      readCurrentSourceAuthority({ kvImpl: fake.kv }),
      (error) => error.code === "SOURCE_AUTHORITY_UNAVAILABLE",
    );
  } finally {
    process.env[SOURCE_WATERMARK_AUTHORITY_KEY_ENV] =
      savedAuthority;
    process.env.KV_REST_API_URL = savedUrl;
    process.env.KV_REST_API_TOKEN = savedToken;
  }
});

test("stale or future Redis TIME cannot issue operational authority", async () => {
  const fake = createAuthorityKvFake();
  await activateSourceAuthorityGeneration(
    { generation: generationFixture({ status: "committed" }) },
    { kvImpl: fake.kv },
  );
  for (const clockMove of [60_000, -120_000]) {
    fake.advance(clockMove);
    await assert.rejects(
      readCurrentSourceAuthority({ kvImpl: fake.kv }),
      (error) => (
        error.code === "SOURCE_AUTHORITY_REDIS_TIME_SKEWED"
      ),
    );
    const status = await getSourceAuthorityOperationalStatus({
      kvImpl: fake.kv,
    });
    assert.equal(status.current, false);
    assert.equal(status.phase4Q37Ready, false);
  }
});

test("dashboard health exposes only aggregate dark readiness and keeps enrollment closed", async () => {
  const source = await readFile(
    new URL("../api/paraai/health.mjs", import.meta.url),
    "utf8",
  );
  assert.match(
    source,
    /sourceWatermarkPublicStatus\(\)/,
  );
  assert.match(
    source,
    /sourceWatermarkComplete:\s*sourceWatermark\.sourceWatermarkComplete/,
  );
  assert.match(
    source,
    /phase4Q37Ready:\s*sourceWatermark\.phase4Q37Ready/,
  );
  const enrollment = source.slice(
    source.indexOf("health.enrollmentReady = Boolean("),
    source.indexOf("health.automation.ready = Boolean("),
  );
  assert.match(enrollment, /health\.phase4Q37Ready/);
});

test("authority receipt minting is not exported from the policy module", async () => {
  const policy = await import(
    "../api/paraai/_lib/source-watermark.mjs"
  );
  const authorityStore = await import(
    "../api/paraai/_lib/source-authority-store.mjs"
  );
  for (const name of [
    ...Object.keys(policy),
    ...Object.keys(authorityStore),
  ]) {
    assert.doesNotMatch(
      name,
      /(mint|issue|sign).*(authority|generation|reservation).*receipt/i,
    );
  }
});

test("policy module stays capture-independent and contains no identifier-shaped public fields", () => {
  const status = sourceWatermarkPublicStatus();
  assert.equal(
    status.policyVersion,
    SOURCE_WATERMARK_POLICY_VERSION,
  );
  assert.deepEqual(
    Object.keys(status).sort(),
    [
      "aliases",
      "committed",
      "current",
      "decisionBoundaryAt",
      "manifestDigest",
      "phase4Q37Ready",
      "policyVersion",
      "q37",
      "sourceWatermarkComplete",
      "sources",
      "status",
    ].sort(),
  );
});
