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
const AUTHORITY_NONCE = "12".repeat(32);
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
    .update("phase4-source-identity-binding-receipt-v2")
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

function sourceBindingResolutionDigest(entry, binding) {
  return semanticDigest(
    "phase4-source-identity-resolution-evidence-v2",
    {
      canonicalCandidateDigest:
        entry.canonicalCandidateDigest,
      candidateUserAliasDigest:
        entry.candidateUserAliasDigest,
      source: binding.source,
      sourceRecordDigest: binding.sourceRecordDigest,
      sourceRecordRevisionDigest:
        binding.sourceRecordRevisionDigest,
      sourcePointReadProcedure:
        binding.sourcePointReadProcedure,
      sourceNormalizedInputDigest:
        binding.sourceNormalizedInputDigest,
      identityPointReadProcedure:
        binding.identityPointReadProcedure,
      identityNormalizedInputDigest:
        binding.identityNormalizedInputDigest,
      identityPointRecordDigest:
        binding.identityPointRecordDigest,
      identityPointRecordRevisionDigest:
        binding.identityPointRecordRevisionDigest,
      decisionBoundaryAt: binding.decisionBoundaryAt,
      observedAt: binding.observedAt,
      sourceCollectorArtifactDigest:
        binding.sourceCollectorArtifactDigest,
      identityCollectorArtifactDigest:
        binding.identityCollectorArtifactDigest,
    },
  );
}

function identityBindingReceiptFixture(
  entry,
  {
    source = SOURCE_WATERMARK_SOURCES.RECALL,
    decisionBoundaryAt = T,
    overrides = {},
  } = {},
) {
  const {
    receiptMac: overrideMac,
    signingKey = IDENTITY_KEY_BYTES,
    resolutionEvidenceDigest:
      overrideResolutionEvidenceDigest,
    ...fields
  } = overrides;
  const recall =
    source === SOURCE_WATERMARK_SOURCES.RECALL;
  const sourceRecordDigest = recall
    ? entry.recallRecordDigest
      || sourceRecordForCandidate(
        entry.canonicalCandidateDigest,
      )
    : entry.paraformHumanRecordDigest
      || sourceRecordForAlias(
        entry.candidateUserAliasDigest,
      );
  const sourceRecordRevisionDigest = recall
    ? entry.recallRecordRevisionDigest
      || sourceRevisionForCandidate(
        entry.canonicalCandidateDigest,
      )
    : entry.paraformHumanRecordRevisionDigest
      || sourceRevisionForAlias(
        entry.candidateUserAliasDigest,
      );
  const bindingWithoutResolution = {
    version: SOURCE_IDENTITY_BINDING_RECEIPT_VERSION,
    policyVersion: SOURCE_WATERMARK_POLICY_VERSION,
    kind: "source_identity_binding",
    source,
    sourceRecordDigest,
    sourceRecordRevisionDigest,
    sourcePointReadProcedure: recall
      ? SOURCE_IDENTITY_POINT_READ_PROCEDURES.recallSource
      : SOURCE_IDENTITY_POINT_READ_PROCEDURES
        .paraformHumanSource,
    sourceNormalizedInputDigest: semanticDigest(
      "test-source-point-read-input-v2",
      { source, sourceRecordDigest },
    ),
    identityPointReadProcedure:
      SOURCE_IDENTITY_POINT_READ_PROCEDURES
        .candidateUserIdentity,
    identityNormalizedInputDigest: semanticDigest(
      "test-candidate-user-point-read-input-v1",
      entry.candidateUserAliasDigest,
    ),
    identityPointRecordDigest: semanticDigest(
      "test-candidate-user-point-record-v1",
      {
        canonicalCandidateDigest:
          entry.canonicalCandidateDigest,
        candidateUserAliasDigest:
          entry.candidateUserAliasDigest,
      },
    ),
    identityPointRecordRevisionDigest: semanticDigest(
      "test-candidate-user-point-revision-v1",
      entry.candidateUserAliasDigest,
    ),
    decisionBoundaryAt,
    observedAt: "2026-07-26T00:00:30.000Z",
    sourceCollectorArtifactDigest:
      SOURCE_WATERMARK_APPROVED_COLLECTORS[
        source
      ].collectorCodeCommitmentDigest,
    // Deliberately unapproved: production has no reviewed identity collector.
    identityCollectorArtifactDigest: digest("c"),
    receiptNonceDigest: "14".repeat(32),
    authorityKeyIdDigest: identityBindingKeyId(),
    ...fields,
  };
  const bindingMaterial = {
    ...bindingWithoutResolution,
    resolutionEvidenceDigest:
      overrideResolutionEvidenceDigest
      || sourceBindingResolutionDigest(
        entry,
        bindingWithoutResolution,
      ),
  };
  const signedMaterial = {
    version: SOURCE_IDENTITY_BINDING_RECEIPT_VERSION,
    policyVersion: SOURCE_WATERMARK_POLICY_VERSION,
    kind: "source_identity_binding",
    canonicalCandidateDigest:
      entry.canonicalCandidateDigest,
    candidateUserAliasDigest:
      entry.candidateUserAliasDigest,
    binding: bindingMaterial,
  };
  return {
    ...bindingMaterial,
    receiptMac: overrideMac
      || signIdentityBindingReceipt(
        signedMaterial,
        signingKey,
      ),
  };
}

function aliasEvidenceEntry(
  entry,
  {
    decisionBoundaryAt = T,
  } = {},
) {
  const base = {
    canonicalCandidateDigest:
      entry.canonicalCandidateDigest,
    candidateUserAliasDigest:
      entry.candidateUserAliasDigest,
  };
  const sources = entry.sources || [
    SOURCE_WATERMARK_SOURCES.RECALL,
    SOURCE_WATERMARK_SOURCES.PARAFORM_HUMAN,
  ];
  return {
    ...base,
    bindings: entry.bindings || sources.map((source) => (
      identityBindingReceiptFixture(
        { ...entry, ...base },
        { source, decisionBoundaryAt },
      )
    )),
  };
}

function aliasMapFixture(entries, overrides = {}) {
  const decisionBoundaryAt =
    overrides.decisionBoundaryAt || T;
  const normalizedEntries = entries.map((entry) => {
    return aliasEvidenceEntry(entry, {
      decisionBoundaryAt,
    });
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
  const kv = async (command) => {
    commands.push(command);
    return [
      records.get(command[3]) || "",
      String(Math.floor(nowMs / 1_000)),
      String((nowMs % 1_000) * 1_000),
    ];
  };
  globalThis.fetch = async (_url, { body }) => ({
    ok: true,
    async text() {
      return JSON.stringify({
        result: await kv(JSON.parse(body)),
      });
    },
  });
  return { records, commands };
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

test("Paraform meeting evidence stays dark without a pinned human discriminator", () => {
  const certificate = certificateFixture(
    SOURCE_WATERMARK_SOURCES.PARAFORM_HUMAN,
    [humanSuccess()],
  );
  assert.equal(certificate.complete, false);
  assert.ok(
    certificate.reasons.includes(
      "paraform_human_discriminator_unpinned",
    ),
  );
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

test("alias map derives a deterministic dark one-to-one binding", () => {
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
  assert.equal(forward.complete, false);
  assert.equal(forward.authoritative, false);
  assert.equal(forward.snapshotComplete, false);
  assert.equal(forward.epochStable, true);
  assert.equal(forward.aliasEpochDigest, ALIAS_EPOCH);
  assert.equal(forward.conflictCount, 0);
  assert.equal(forward.canonicalCandidateCount, 2);
  assert.equal(forward.candidateUserAliasCount, 2);
  assert.ok(
    forward.reasons.includes(
      "identity_collector_artifact_unpinned",
    ),
  );
  assert.equal(forward.aliasMapDigest, reverse.aliasMapDigest);
});

test("caller snapshot assertions cannot override derived alias authority", () => {
  const entries = [{
    canonicalCandidateDigest: CANDIDATE_A,
    candidateUserAliasDigest: CANDIDATE_USER_A,
  }];
  const nonAuthoritative = aliasMapFixture(entries, {
    authoritative: true,
  });
  const incomplete = aliasMapFixture(entries, {
    snapshotComplete: true,
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

test("per-source bindings remain dark without a reviewed identity collector", () => {
  const entry = aliasEvidenceEntry({
    canonicalCandidateDigest: CANDIDATE_A,
    candidateUserAliasDigest: CANDIDATE_USER_A,
  });
  const missing = aliasMapFixture([{
    ...entry,
    bindings: [],
  }]);
  const validReceipt = identityBindingReceiptFixture(
    entry,
    { source: SOURCE_WATERMARK_SOURCES.RECALL },
  );
  const forged = aliasMapFixture([{
    ...entry,
    bindings: [{
      ...validReceipt,
      receiptMac: digest("f"),
    }],
  }]);
  const savedKey =
    process.env[SOURCE_IDENTITY_BINDING_AUTHORITY_KEY_ENV];
  delete process.env[SOURCE_IDENTITY_BINDING_AUTHORITY_KEY_ENV];
  let unavailable;
  try {
    unavailable = aliasMapFixture([{
      ...entry,
      bindings: [validReceipt],
    }]);
  } finally {
    process.env[SOURCE_IDENTITY_BINDING_AUTHORITY_KEY_ENV] =
      savedKey;
  }

  assert.equal(missing.edgeWithoutBindingCount, 1);
  assert.ok(
    missing.reasons.includes(
      "alias_edges_without_source_binding",
    ),
  );
  for (const aliasMap of [forged, unavailable]) {
    assert.equal(aliasMap.complete, false);
    assert.equal(aliasMap.bindingCount, 1);
    assert.equal(aliasMap.identityBindingProvenCount, 0);
    assert.equal(aliasMap.identityBindingUnprovenCount, 1);
    assert.equal(
      aliasMap.entries[0].bindings[0]
        .identityBindingFailureCode,
      "SOURCE_IDENTITY_BINDING_IDENTITY_ARTIFACT_UNAVAILABLE",
    );
  }
});

test("empty snapshots and signer-chosen resolution digests never prove identity completeness", () => {
  const empty = aliasMapFixture([]);
  assert.equal(empty.complete, false);
  assert.ok(
    empty.reasons.includes(
      "identity_binding_receipts_missing",
    ),
  );

  const entry = aliasEvidenceEntry({
    canonicalCandidateDigest: CANDIDATE_A,
    candidateUserAliasDigest: CANDIDATE_USER_A,
  });
  const arbitraryJoin = aliasMapFixture([{
    ...entry,
    bindings: [
      identityBindingReceiptFixture(entry, {
        overrides: {
          resolutionEvidenceDigest: digest("f"),
        },
      }),
    ],
  }]);
  assert.equal(arbitraryJoin.complete, false);
  assert.equal(
    arbitraryJoin.identityBindingProvenCount,
    0,
  );
  assert.equal(
    arbitraryJoin.entries[0].bindings[0]
      .identityBindingFailureCode,
    "SOURCE_IDENTITY_BINDING_RESOLUTION_MISMATCH",
  );
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
    },
    {
      ...second,
      candidateUserAliasDigest: CANDIDATE_USER_A,
    },
  ]);
  assert.equal(swapped.canonicalConflictCount, 0);
  assert.equal(swapped.aliasConflictCount, 0);
  assert.equal(swapped.identityBindingProvenCount, 0);
  assert.equal(swapped.complete, false);
});

test("source bindings cover the exact union, including one-source candidates", () => {
  const pair = {
    canonicalCandidateDigest: CANDIDATE_A,
    candidateUserAliasDigest: CANDIDATE_USER_A,
  };
  const recallOnly = generationFixture({
    recallFacts: [recallSuccess()],
    humanFacts: [],
    aliasEntries: [{
      ...pair,
      sources: [SOURCE_WATERMARK_SOURCES.RECALL],
    }],
  });
  const humanOnly = generationFixture({
    recallFacts: [],
    humanFacts: [humanSuccess()],
    aliasEntries: [{
      ...pair,
      sources: [
        SOURCE_WATERMARK_SOURCES.PARAFORM_HUMAN,
      ],
    }],
  });
  const both = generationFixture();

  for (const generation of [recallOnly, humanOnly]) {
    assert.equal(
      generation.aliasEvidence.sourceRecordCount,
      1,
    );
    assert.equal(
      generation.aliasEvidence.bindingRecordCount,
      1,
    );
    assert.equal(
      generation.aliasEvidence.sourceRecordUniverseEqual,
      true,
    );
    assert.equal(
      generation.aliasEvidence.candidateUniverseEqual,
      true,
    );
    assert.equal(generation.aliasEvidence.universeEqual, true);
    assert.equal(generation.q37.candidateCount, 1);
    assert.equal(generation.q37.reviewCount, 1);
  }
  assert.equal(both.aliasEvidence.sourceRecordCount, 2);
  assert.equal(both.aliasEvidence.bindingRecordCount, 2);
  assert.equal(both.aliasEvidence.missingBindingCount, 0);
  assert.equal(both.aliasEvidence.extraBindingCount, 0);
});

test("missing or extra per-source bindings break exact union equality", () => {
  const pair = {
    canonicalCandidateDigest: CANDIDATE_A,
    candidateUserAliasDigest: CANDIDATE_USER_A,
  };
  const missing = generationFixture({
    aliasEntries: [{
      ...pair,
      sources: [SOURCE_WATERMARK_SOURCES.RECALL],
    }],
  });
  const extra = generationFixture({
    humanFacts: [],
    aliasEntries: [pair],
  });
  assert.equal(missing.aliasEvidence.missingBindingCount, 1);
  assert.equal(
    missing.aliasEvidence.sourceRecordUniverseEqual,
    false,
  );
  assert.equal(missing.aliasEvidence.universeEqual, false);
  assert.equal(extra.aliasEvidence.extraBindingCount, 1);
  assert.equal(
    extra.aliasEvidence.sourceRecordUniverseEqual,
    false,
  );
  assert.equal(extra.aliasEvidence.universeEqual, false);
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

test("generation Q37 groups mapped pending facts before making a candidate decision", () => {
  const pair = {
    canonicalCandidateDigest: CANDIDATE_A,
    candidateUserAliasDigest: CANDIDATE_USER_A,
  };
  const pending = {
    ...recallSuccess({
      candidate: CANDIDATE_A,
      record: RECORD_RECALL_B,
    }),
    classification: "pending",
    endedAt: null,
    provenanceVerified: false,
  };
  const successBinding = identityBindingReceiptFixture(
    pair,
    { source: SOURCE_WATERMARK_SOURCES.RECALL },
  );
  const pendingBinding = identityBindingReceiptFixture(
    {
      ...pair,
      recallRecordDigest: RECORD_RECALL_B,
      recallRecordRevisionDigest: REVISION_RECALL_B,
    },
    { source: SOURCE_WATERMARK_SOURCES.RECALL },
  );
  const baseline = generationFixture({
    humanFacts: [],
    aliasEntries: [{
      ...pair,
      bindings: [successBinding],
    }],
  });
  const withPending = generationFixture({
    recallFacts: [recallSuccess(), pending],
    humanFacts: [],
    aliasEntries: [{
      ...pair,
      bindings: [successBinding, pendingBinding],
    }],
  });
  assert.equal(withPending.q37.identityIssueCount, 0);
  assert.equal(withPending.q37.candidateCount, 1);
  assert.equal(withPending.q37.reviewCount, 1);
  assert.notEqual(
    withPending.q37.hypotheticalDecisionSetDigest,
    baseline.q37.hypotheticalDecisionSetDigest,
  );
});

test("combined generation binds both source certificates, aliases, and Q37", () => {
  const generation = generationFixture();
  assert.equal(generation.status, "planned");
  assert.equal(generation.intrinsicSourceComplete, false);
  assert.equal(generation.intrinsicQ37Ready, false);
  assert.equal(generation.q37.operational, false);
  assert.equal(generation.q37.selectedCount, 0);
  assert.equal(generation.q37.humanCount, 0);
  assert.equal(generation.q37.reviewCount, 1);
  assert.deepEqual(generation.q37.reasons, [
    "human_intro_source_unpinned",
    "paraform_human_discriminator_unpinned",
  ]);
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
    paraformHumanRecordRevisionDigest: REVISION_HUMAN_A,
  }]);
  assert.equal(aliasMap.complete, false);
  const generation = generationFixture({ aliasMap });
  assert.equal(generation.aliasEvidence.sourceProven, false);
  assert.equal(generation.aliasEvidence.mismatchedBindingCount, 1);
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
      error.code === "SOURCE_WATERMARK_COMMIT_NOT_READY"
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
  const generation = generationFixture();
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
    assert.equal(status.status, "not_committed");
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
  const generation = generationFixture();
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
  assert.equal(ready.status, "not_committed");
  assert.equal(ready.sourceWatermarkComplete, false);
  assert.equal(ready.phase4Q37Ready, false);
  assert.equal(missing.status, "not_committed");
  assert.equal(missing.phase4Q37Ready, false);
  assert.equal(untrusted.status, "not_committed");
  assert.equal(untrusted.phase4Q37Ready, false);
});

test("validly signed future and expired authority clocks fail closed", () => {
  const generation = generationFixture();
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
    assert.equal(status.status, "not_committed");
    assert.equal(status.phase4Q37Ready, false);
  }
});

test("public readiness is aggregate-only and strips all source and identity digests", () => {
  const generation = generationFixture();
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
    generationFixture(),
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
  const generation = generationFixture();
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

test("public source activation is structurally unavailable", async () => {
  const authorityStore = await import(
    "../api/paraai/_lib/source-authority-store.mjs"
  );
  const source = await readFile(
    new URL(
      "../api/paraai/_lib/source-authority-store.mjs",
      import.meta.url,
    ),
    "utf8",
  );
  assert.equal(
    "activateSourceAuthorityGeneration" in authorityStore,
    false,
  );
  assert.doesNotMatch(source, /ACTIVATE_GENERATION_LUA/u);
  assert.doesNotMatch(source, /proposed\.activatedAtMs/u);
});

test("runtime authority stays dark until the freshness coordinator is reviewed", async () => {
  const fake = createAuthorityKvFake();
  let callerKvUsed = false;
  const callerStore = {
    kvImpl: async () => {
      callerKvUsed = true;
      throw new Error("caller KV must never run");
    },
  };
  const status = await getSourceAuthorityOperationalStatus(
    callerStore,
  );
  assert.equal(
    status.status,
    "capture_coordinator_unavailable",
  );
  assert.equal(status.current, false);
  assert.equal(status.sourceWatermarkComplete, false);
  assert.equal(status.phase4Q37Ready, false);
  assert.equal(fake.commands.length, 0);
  assert.equal(callerKvUsed, false);

  await assert.rejects(
    reserveSourceAuthorityWrite(
      {
        jobBindingDigest: JOB_BINDING,
        canonicalCandidateDigest: CANDIDATE_A,
        candidateUserAliasDigest: CANDIDATE_USER_A,
        jobRevisionDigest: JOB_REVISION,
        writeScopeDigest: WRITE_SCOPE,
      },
      callerStore,
    ),
    (error) => (
      error.code
        === "SOURCE_AUTHORITY_CAPTURE_COORDINATOR_UNAVAILABLE"
    ),
  );
  await assert.rejects(
    consumeSourceAuthorityWriteReservation(
      {
        reservationReceipt: {},
        expectedJobBindingDigest: JOB_BINDING,
        expectedJobRevisionDigest: JOB_REVISION,
        expectedWriteScopeDigest: WRITE_SCOPE,
        settledResultDigest: SETTLED_RESULT,
      },
      callerStore,
    ),
    (error) => (
      error.code
        === "SOURCE_AUTHORITY_CAPTURE_COORDINATOR_UNAVAILABLE"
    ),
  );
  assert.equal(fake.commands.length, 0);
  assert.equal(callerKvUsed, false);
});

test("dormant reservation transitions preserve exact CAS and replay fences", async () => {
  const source = await readFile(
    new URL(
      "../api/paraai/_lib/source-authority-store.mjs",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(
    source,
    /const SOURCE_CAPTURE_COORDINATOR_AVAILABLE = false;/u,
  );
  assert.match(source, /Redis-TIME freshness lease/u);
  assert.doesNotMatch(source, /\bkvImpl\b/u);
  assert.match(
    source,
    /redis\.sha1hex\(activeRaw\) ~= ARGV\[21\]/u,
  );
  assert.match(
    source,
    /local jobSnapshotSha1 = redis\.sha1hex\(jobRaw\)/u,
  );
  assert.match(
    source,
    /reservation\.reservedJobRevisionDigest ~= ARGV\[17\]/u,
  );
  assert.match(
    source,
    /redis\.sha1hex\(reservationRaw\) ~= ARGV\[21\]/u,
  );
  assert.match(
    source,
    /redis\.sha1hex\(activeRaw\) ~= ARGV\[25\]/u,
  );
  assert.match(
    source,
    /redis\.sha1hex\(jobRaw\) ~= ARGV\[13\]/u,
  );
  assert.match(
    source,
    /if existing\.expiresAtMs >= nowMs or settlementRaw then/u,
  );
  assert.match(source, /elseif settlementRaw then/u);
  assert.match(source, /local settlement = \{/u);
});
test("missing keys/store and malformed durable state remain dark", async () => {
  const fake = createAuthorityKvFake();
  fake.records.set(
    "paraai:phase4:source-authority:active:v1",
    JSON.stringify({ version: 1 }),
  );
  await assert.rejects(
    readCurrentSourceAuthority(),
    (error) => (
      error.code === "SOURCE_AUTHORITY_DURABLE_STATE_MALFORMED"
    ),
  );
  assert.equal(
    (await getSourceAuthorityOperationalStatus()).phase4Q37Ready,
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
    const status = await getSourceAuthorityOperationalStatus();
    assert.equal(status.status, "store_unavailable");
    assert.equal(status.current, false);
    assert.equal(status.phase4Q37Ready, false);
    await assert.rejects(
      readCurrentSourceAuthority(),
      (error) => error.code === "SOURCE_AUTHORITY_UNAVAILABLE",
    );
  } finally {
    process.env[SOURCE_WATERMARK_AUTHORITY_KEY_ENV] =
      savedAuthority;
    process.env.KV_REST_API_URL = savedUrl;
    process.env.KV_REST_API_TOKEN = savedToken;
  }
});

test("receipt TTL alone cannot establish source freshness", async () => {
  const source = await readFile(
    new URL(
      "../api/paraai/_lib/source-authority-store.mjs",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(source, /Redis-TIME freshness lease/u);
  assert.match(source, /fresh stable/u);
  assert.match(source, /capture \(including/u);
  assert.match(source, /upstream head\/delta invalidation/u);
  const status = await getSourceAuthorityOperationalStatus();
  assert.equal(
    status.status,
    "capture_coordinator_unavailable",
  );
  assert.equal(status.current, false);
  assert.equal(status.phase4Q37Ready, false);
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
