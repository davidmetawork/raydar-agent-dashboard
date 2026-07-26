// Phase 4 upstream-source barrier.
//
// Evidence normalization remains vendor, queue, and store independent. The
// authorization boundary reads one server-held HMAC key and verifies receipts
// that only a private durable-store transition may mint; this module exports
// no signer. Missing authority always leaves readiness and writes closed.
//
// Raw source IDs, candidate IDs, candidate-user IDs, names, emails, links, and
// response bodies do not belong in this contract. Identifier-shaped inputs are
// domain-separated lowercase SHA-256 digests only.

import {
  createHash,
  createHmac,
  timingSafeEqual,
} from "node:crypto";

export const SOURCE_WATERMARK_POLICY_VERSION =
  "phase4-source-watermark-v5";
export const SOURCE_WATERMARK_CERTIFICATE_VERSION = 5;
export const SOURCE_WATERMARK_GENERATION_VERSION = 5;
export const PHASE4_WRITE_ATTESTATION_VERSION = 5;
export const SOURCE_WATERMARK_AUTHORITY_RECEIPT_VERSION = 1;
export const SOURCE_WATERMARK_AUTHORITY_KEY_ENV =
  "PARAAI_SOURCE_WATERMARK_AUTHORITY_KEY";
export const SOURCE_IDENTITY_BINDING_RECEIPT_VERSION = 2;
export const SOURCE_IDENTITY_BINDING_AUTHORITY_KEY_ENV =
  "PARAAI_SOURCE_IDENTITY_BINDING_AUTHORITY_KEY";
export const SOURCE_IDENTITY_POINT_READ_PROCEDURES =
  Object.freeze({
    recallSource: "GET /api/v1/bot/{id}/",
    paraformHumanSource:
      "candidateUserMeeting.getCallById",
    candidateUserIdentity:
      "candidateUser.getCandidateUserById",
  });

// Artifact commitments are derived from the exact immutable production file,
// its focused test, and the merge commit that put both on main:
//
//   sha256(
//     "phase4-source-collector-artifact-v1" || NUL
//     || canonical_json({source, mergeCommit, runtimePath,
//                        runtimeFileSha256, focusedTestPath,
//                        focusedTestFileSha256})
//   )
//
// This deliberately records the real merged artifacts rather than an
// invented "code commitment" literal. There is no merged alias collector or
// signer yet, so aliases carry no artifact commitment and can become complete
// only when every edge has a separately authenticated identity receipt.
const SOURCE_COLLECTOR_ARTIFACT_MERGE_COMMIT =
  "e26818f6dc16725d132534cc8da5c7b84e6826e3";
const RECALL_COLLECTOR_ARTIFACT = Object.freeze({
  source: "recall",
  mergeCommit: SOURCE_COLLECTOR_ARTIFACT_MERGE_COMMIT,
  runtimePath: "calls-app/api/_lib/recall.js",
  runtimeFileSha256:
    "b03ef301a7fe6037c81fa81a833f72231f1be8707fd001d117fdad15626dd04e",
  focusedTestPath: "calls-app/test/source-page.test.mjs",
  focusedTestFileSha256:
    "1ad5bcbe46d08fe3bc19dd8e41a1c9b53f3517bbbe61694e7e941762db6e928d",
});
const PARAFORM_HUMAN_COLLECTOR_ARTIFACT = Object.freeze({
  source: "paraform_human",
  mergeCommit: SOURCE_COLLECTOR_ARTIFACT_MERGE_COMMIT,
  runtimePath: "webview/api/_lib/paraform-meetings.js",
  runtimeFileSha256:
    "d5e1a75cb8884af409fd7750fb54ced80185c2881b48b3a2042e9b95af621c11",
  focusedTestPath: "webview/test/paraform-source-page.test.mjs",
  focusedTestFileSha256:
    "d3a1511d1716c6c6c7a8baa0de6252fd44b6d477c46b49b354164fb42e7d55ee",
});

function collectorArtifactCommitment(artifact) {
  return semanticDigest(
    "phase4-source-collector-artifact-v1",
    artifact,
  );
}

export const SOURCE_IDENTITY_BINDING_SOURCE_ARTIFACT_DIGEST =
  semanticDigest(
    "phase4-source-identity-binding-input-artifacts-v1",
    {
      recall: collectorArtifactCommitment(
        RECALL_COLLECTOR_ARTIFACT,
      ),
      paraformHuman: collectorArtifactCommitment(
        PARAFORM_HUMAN_COLLECTOR_ARTIFACT,
      ),
    },
  );

// There is no reviewed alias/identity collector, Paraform human-vs-agent
// discriminator, signed human-intro source, or freshness coordinator yet.
// Null is the release pin: no caller-provided digest can stand in for one.
export const SOURCE_IDENTITY_BINDING_IDENTITY_ARTIFACT_DIGEST =
  null;
export const SOURCE_Q37_DISCRIMINATOR_ARTIFACT_DIGEST = null;
export const SOURCE_HUMAN_INTRO_ARTIFACT_DIGEST = null;

// These are release pins, not caller-selectable compatibility ranges. A
// collector change must deliberately rotate both its version and immutable
// code commitment here before its evidence can participate in Phase 4.
export const SOURCE_WATERMARK_APPROVED_COLLECTORS =
  Object.freeze({
    recall: Object.freeze({
      collectorVersion: "recall-source-v1",
      collectorCodeCommitmentDigest:
        collectorArtifactCommitment(RECALL_COLLECTOR_ARTIFACT),
      artifact: RECALL_COLLECTOR_ARTIFACT,
    }),
    paraform_human: Object.freeze({
      collectorVersion: "paraform-human-source-v1",
      collectorCodeCommitmentDigest:
        collectorArtifactCommitment(
          PARAFORM_HUMAN_COLLECTOR_ARTIFACT,
        ),
      artifact: PARAFORM_HUMAN_COLLECTOR_ARTIFACT,
    }),
    aliases: Object.freeze({
      collectorVersion: "source-alias-evidence-v1",
      collectorCodeCommitmentDigest: null,
      artifact: null,
      sourceArtifactsDigest:
        SOURCE_IDENTITY_BINDING_SOURCE_ARTIFACT_DIGEST,
    }),
  });

export const SOURCE_WATERMARK_SOURCES = Object.freeze({
  RECALL: "recall",
  PARAFORM_HUMAN: "paraform_human",
});

const SOURCE_LIST = Object.freeze([
  SOURCE_WATERMARK_SOURCES.RECALL,
  SOURCE_WATERMARK_SOURCES.PARAFORM_HUMAN,
]);
const SOURCE_SET = new Set(SOURCE_LIST);
const DIGEST = /^[a-f0-9]{64}$/u;
const FACT_CLASSIFICATIONS = new Set([
  "success",
  "failure",
  "pending",
  "conflict",
]);
const IDENTITY_STATUSES = new Set([
  "resolved",
  "unresolved",
  "conflict",
]);
const IDENTITY_KINDS = new Set([
  "canonical_candidate",
  "candidate_user_alias",
]);
const GENERATION_STATUSES = new Set(["planned", "committed"]);
const AUTHORITY_RECEIPT_KINDS = Object.freeze({
  GENERATION_CURRENT: "source_generation_current",
  WRITE_CAS_RESERVED: "phase4_write_cas_reserved",
});
const AUTHORITY_KEY = /^[A-Za-z0-9_-]{43,}$/u;
const AUTHORITY_CLOCK_SKEW_MS = 5_000;
const GENERATION_RECEIPT_MAX_LIFETIME_MS = 60_000;
const WRITE_RECEIPT_MAX_LIFETIME_MS = 15_000;

export class SourceWatermarkInvariantError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = "SourceWatermarkInvariantError";
    this.code = code;
  }
}

function invariant(condition, code, message = code) {
  if (!condition) {
    throw new SourceWatermarkInvariantError(code, message);
  }
}

function object(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`);
  }
  return value;
}

function array(value, field) {
  if (!Array.isArray(value)) {
    throw new TypeError(`${field} must be an array`);
  }
  return value;
}

function strictBoolean(value, field) {
  if (typeof value !== "boolean") {
    throw new TypeError(`${field} must be a boolean`);
  }
  return value;
}

function nonNegativeInteger(value, field) {
  if (!Number.isInteger(value) || value < 0) {
    throw new TypeError(`${field} must be a non-negative integer`);
  }
  return value;
}

function positiveInteger(value, field) {
  if (!Number.isInteger(value) || value < 1) {
    throw new TypeError(`${field} must be a positive integer`);
  }
  return value;
}

function digest(value, field) {
  if (typeof value !== "string" || !DIGEST.test(value)) {
    throw new TypeError(`${field} must be a lowercase sha256 digest`);
  }
  return value;
}

function sourceName(value, field = "source") {
  if (!SOURCE_SET.has(value)) {
    throw new TypeError(`${field} must be a supported source`);
  }
  return value;
}

function approvedCollectorPin(source, version, commitment) {
  const approved = SOURCE_WATERMARK_APPROVED_COLLECTORS[source];
  const commitmentMatches = approved?.collectorCodeCommitmentDigest
    == null
    ? commitment == null
    : commitment === approved.collectorCodeCommitmentDigest;
  invariant(
    Boolean(approved)
      && version === approved.collectorVersion
      && commitmentMatches,
    "SOURCE_COLLECTOR_PIN_MISMATCH",
    `${source} collector version and code commitment are not approved`,
  );
  return approved;
}

function canonicalTimestamp(value, field) {
  if (typeof value !== "string") {
    throw new TypeError(`${field} must be a canonical ISO timestamp`);
  }
  const parsed = Date.parse(value);
  if (
    !Number.isFinite(parsed)
    || new Date(parsed).toISOString() !== value
  ) {
    throw new TypeError(`${field} must be a canonical ISO timestamp`);
  }
  return value;
}

function optionalTimestamp(value, field) {
  if (value == null) return null;
  return canonicalTimestamp(value, field);
}

function enumValue(value, allowed, field) {
  if (!allowed.has(value)) {
    throw new TypeError(`${field} is invalid`);
  }
  return value;
}

function canonicalJson(value) {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("canonical digest values must be finite");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => (
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    )).join(",")}}`;
  }
  throw new TypeError("canonical digest values must be JSON-safe");
}

function semanticDigest(namespace, value) {
  return createHash("sha256")
    .update(namespace)
    .update("\0")
    .update(canonicalJson(value))
    .digest("hex");
}

function deepFreeze(value) {
  if (
    value
    && typeof value === "object"
    && !Object.isFrozen(value)
  ) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function expectedIdentityKind(source) {
  return source === SOURCE_WATERMARK_SOURCES.RECALL
    ? "canonical_candidate"
    : "candidate_user_alias";
}

function normalizeSourceFact(raw, {
  source,
  decisionBoundaryAt,
  index,
}) {
  const fact = object(raw, `${source} facts[${index}]`);
  if (
    Object.prototype.hasOwnProperty.call(fact, "source")
    && fact.source !== source
  ) {
    throw new SourceWatermarkInvariantError(
      "SOURCE_FACT_SOURCE_MISMATCH",
      `${source} facts[${index}] declares a different source`,
    );
  }
  const recordDigest = digest(
    fact.recordDigest,
    `${source} facts[${index}].recordDigest`,
  );
  const recordRevisionDigest = fact.recordRevisionDigest == null
    ? null
    : digest(
      fact.recordRevisionDigest,
      `${source} facts[${index}].recordRevisionDigest`,
    );
  const classification = enumValue(
    fact.classification,
    FACT_CLASSIFICATIONS,
    `${source} facts[${index}].classification`,
  );
  const identityStatus = enumValue(
    fact.identityStatus,
    IDENTITY_STATUSES,
    `${source} facts[${index}].identityStatus`,
  );
  const provenanceVerified = strictBoolean(
    fact.provenanceVerified,
    `${source} facts[${index}].provenanceVerified`,
  );
  const endedAt = optionalTimestamp(
    fact.endedAt,
    `${source} facts[${index}].endedAt`,
  );
  if (["success", "failure"].includes(classification) && !endedAt) {
    throw new TypeError(
      `${source} terminal facts require an endedAt timestamp`,
    );
  }
  if (
    endedAt
    && Date.parse(endedAt) > Date.parse(decisionBoundaryAt)
  ) {
    throw new RangeError(
      `${source} fact cannot end after decisionBoundaryAt`,
    );
  }

  let identityKind = null;
  let identityDigest = null;
  if (identityStatus === "resolved") {
    identityKind = enumValue(
      fact.identityKind,
      IDENTITY_KINDS,
      `${source} facts[${index}].identityKind`,
    );
    identityDigest = digest(
      fact.identityDigest,
      `${source} facts[${index}].identityDigest`,
    );
    if (identityKind !== expectedIdentityKind(source)) {
      throw new TypeError(
        `${source} resolved identity kind is not canonical for its source`,
      );
    }
  } else if (
    fact.identityKind != null
    || fact.identityDigest != null
  ) {
    throw new TypeError(
      `${source} unresolved identities cannot carry an identity value`,
    );
  }

  return {
    source,
    recordDigest,
    recordRevisionDigest,
    classification,
    identityStatus,
    identityKind,
    identityDigest,
    endedAt,
    provenanceVerified,
  };
}

function normalizeSourceFacts({
  source,
  decisionBoundaryAt,
  facts,
}) {
  const normalizedSource = sourceName(source);
  const boundary = canonicalTimestamp(
    decisionBoundaryAt,
    "decisionBoundaryAt",
  );
  const rows = array(facts, `${normalizedSource} facts`)
    .map((fact, index) => normalizeSourceFact(fact, {
      source: normalizedSource,
      decisionBoundaryAt: boundary,
      index,
    }))
    .sort((left, right) => (
      left.recordDigest.localeCompare(right.recordDigest)
    ));
  const seen = new Set();
  for (const row of rows) {
    if (seen.has(row.recordDigest)) {
      throw new SourceWatermarkInvariantError(
        "SOURCE_FACT_DUPLICATE",
        `${normalizedSource} fact record digest is duplicated`,
      );
    }
    seen.add(row.recordDigest);
  }
  return rows;
}

function factIssueCounts(facts) {
  let pendingCount = 0;
  let conflictCount = 0;
  let unresolvedCount = 0;
  let invalidCount = 0;
  for (const fact of facts) {
    if (fact.classification === "pending") pendingCount += 1;
    if (
      fact.classification === "conflict"
      || fact.identityStatus === "conflict"
    ) {
      conflictCount += 1;
    }
    if (
      fact.classification === "success"
      && fact.identityStatus === "unresolved"
    ) {
      unresolvedCount += 1;
    }
    if (
      ["success", "failure"].includes(fact.classification)
      && (
        fact.provenanceVerified !== true
        || fact.recordRevisionDigest == null
      )
    ) {
      invalidCount += 1;
    }
  }
  return {
    pendingCount,
    conflictCount,
    unresolvedCount,
    invalidCount,
  };
}

function sourceFactDigest(source, decisionBoundaryAt, facts) {
  return semanticDigest("phase4-source-facts-v1", {
    policyVersion: SOURCE_WATERMARK_POLICY_VERSION,
    source,
    decisionBoundaryAt,
    facts,
  });
}

export function sourceWatermarkFactSetDigest({
  source,
  decisionBoundaryAt,
  facts = [],
} = {}) {
  const normalizedSource = sourceName(source);
  const boundary = canonicalTimestamp(
    decisionBoundaryAt,
    "decisionBoundaryAt",
  );
  const normalizedFacts = normalizeSourceFacts({
    source: normalizedSource,
    decisionBoundaryAt: boundary,
    facts,
  });
  return sourceFactDigest(
    normalizedSource,
    boundary,
    normalizedFacts,
  );
}

function normalizePass(raw, {
  source,
  decisionBoundaryAt,
  index,
}) {
  const pass = object(raw, `${source} passes[${index}]`);
  const passNumber = positiveInteger(
    pass.passNumber,
    `${source} passes[${index}].passNumber`,
  );
  if (passNumber !== index + 1) {
    throw new TypeError(`${source} pass numbers must be contiguous`);
  }
  const startedAt = canonicalTimestamp(
    pass.startedAt,
    `${source} passes[${index}].startedAt`,
  );
  const completedAt = canonicalTimestamp(
    pass.completedAt,
    `${source} passes[${index}].completedAt`,
  );
  if (Date.parse(completedAt) < Date.parse(startedAt)) {
    throw new RangeError(`${source} pass cannot complete before it starts`);
  }
  return {
    passNumber,
    startedAt,
    completedAt,
    exhaustive: strictBoolean(
      pass.exhaustive,
      `${source} passes[${index}].exhaustive`,
    ),
    cursorExhausted: strictBoolean(
      pass.cursorExhausted,
      `${source} passes[${index}].cursorExhausted`,
    ),
    pageCount: positiveInteger(
      pass.pageCount,
      `${source} passes[${index}].pageCount`,
    ),
    factCount: nonNegativeInteger(
      pass.factCount,
      `${source} passes[${index}].factCount`,
    ),
    pendingCount: nonNegativeInteger(
      pass.pendingCount,
      `${source} passes[${index}].pendingCount`,
    ),
    conflictCount: nonNegativeInteger(
      pass.conflictCount,
      `${source} passes[${index}].conflictCount`,
    ),
    unresolvedCount: nonNegativeInteger(
      pass.unresolvedCount,
      `${source} passes[${index}].unresolvedCount`,
    ),
    invalidCount: nonNegativeInteger(
      pass.invalidCount,
      `${source} passes[${index}].invalidCount`,
    ),
    semanticDigest: digest(
      pass.semanticDigest,
      `${source} passes[${index}].semanticDigest`,
    ),
    epochAtStart: digest(
      pass.epochAtStart,
      `${source} passes[${index}].epochAtStart`,
    ),
    epochAtEnd: digest(
      pass.epochAtEnd,
      `${source} passes[${index}].epochAtEnd`,
    ),
    boundaryPredatesPass:
      Date.parse(decisionBoundaryAt) <= Date.parse(startedAt),
  };
}

function certificateBuildResult({
  source,
  decisionBoundaryAt,
  collectorVersion: rawCollectorVersion,
  collectorCodeCommitmentDigest:
    rawCollectorCodeCommitmentDigest,
  facts = [],
  passes = [],
} = {}) {
  const normalizedSource = sourceName(source);
  const boundary = canonicalTimestamp(
    decisionBoundaryAt,
    "decisionBoundaryAt",
  );
  const normalizedCollectorCodeCommitmentDigest = digest(
    rawCollectorCodeCommitmentDigest,
    "collectorCodeCommitmentDigest",
  );
  const approvedCollector = approvedCollectorPin(
    normalizedSource,
    rawCollectorVersion,
    normalizedCollectorCodeCommitmentDigest,
  );
  const normalizedFacts = normalizeSourceFacts({
    source: normalizedSource,
    decisionBoundaryAt: boundary,
    facts,
  });
  const counts = factIssueCounts(normalizedFacts);
  const factSetDigest = sourceFactDigest(
    normalizedSource,
    boundary,
    normalizedFacts,
  );
  const normalizedPasses = array(passes, `${normalizedSource} passes`)
    .map((pass, index) => normalizePass(pass, {
      source: normalizedSource,
      decisionBoundaryAt: boundary,
      index,
    }));

  const reasons = new Set();
  if (
    normalizedSource
      === SOURCE_WATERMARK_SOURCES.PARAFORM_HUMAN
    && SOURCE_Q37_DISCRIMINATOR_ARTIFACT_DIGEST == null
  ) {
    reasons.add("paraform_human_discriminator_unpinned");
  }
  if (normalizedPasses.length < 2) {
    reasons.add("stable_passes_missing");
  }
  for (let index = 0; index < normalizedPasses.length; index += 1) {
    const pass = normalizedPasses[index];
    if (!pass.boundaryPredatesPass) {
      reasons.add("pass_predates_boundary");
    }
    if (!pass.exhaustive) reasons.add("source_not_exhaustive");
    if (!pass.cursorExhausted) reasons.add("cursor_not_exhausted");
    if (pass.factCount !== normalizedFacts.length) {
      reasons.add("fact_count_mismatch");
    }
    for (const field of [
      "pendingCount",
      "conflictCount",
      "unresolvedCount",
      "invalidCount",
    ]) {
      if (pass[field] !== counts[field]) {
        reasons.add("issue_count_mismatch");
      }
    }
    if (pass.semanticDigest !== factSetDigest) {
      reasons.add("semantic_digest_mismatch");
    }
    if (pass.epochAtStart !== pass.epochAtEnd) {
      reasons.add("source_epoch_moved");
    }
    const prior = normalizedPasses[index - 1];
    if (
      prior
      && Date.parse(pass.startedAt) < Date.parse(prior.completedAt)
    ) {
      reasons.add("passes_not_sequential");
    }
  }
  const semanticDigests = new Set(
    normalizedPasses.map((pass) => pass.semanticDigest),
  );
  if (semanticDigests.size > 1) {
    reasons.add("stable_pass_digest_mismatch");
  }
  const epochDigests = new Set(
    normalizedPasses.flatMap((pass) => [
      pass.epochAtStart,
      pass.epochAtEnd,
    ]),
  );
  if (epochDigests.size > 1) reasons.add("source_epoch_moved");
  if (counts.pendingCount > 0) reasons.add("pending_facts");
  if (counts.conflictCount > 0) reasons.add("source_conflicts");
  if (counts.unresolvedCount > 0) reasons.add("unresolved_success_identity");
  if (counts.invalidCount > 0) reasons.add("invalid_provenance");

  const reasonList = [...reasons].sort();
  const sourceEpochDigest = epochDigests.size === 1
    ? [...epochDigests][0]
    : null;
  const complete = reasonList.length === 0;
  const material = {
    version: SOURCE_WATERMARK_CERTIFICATE_VERSION,
    policyVersion: SOURCE_WATERMARK_POLICY_VERSION,
    source: normalizedSource,
    collectorVersion: approvedCollector.collectorVersion,
    collectorCodeCommitmentDigest:
      approvedCollector.collectorCodeCommitmentDigest,
    decisionBoundaryAt: boundary,
    historyMode: "source_exhaustion",
    passCount: normalizedPasses.length,
    passes: normalizedPasses,
    factCount: normalizedFacts.length,
    factSetDigest,
    ...counts,
    sourceEpochDigest,
    stablePasses:
      normalizedPasses.length >= 2
      && semanticDigests.size === 1,
    exhaustive:
      normalizedPasses.length >= 2
      && normalizedPasses.every((pass) => pass.exhaustive),
    cursorExhausted:
      normalizedPasses.length >= 2
      && normalizedPasses.every((pass) => pass.cursorExhausted),
    complete,
    reasons: reasonList,
  };
  const certificate = deepFreeze({
    ...material,
    certificateDigest: semanticDigest(
      "phase4-source-certificate-v1",
      material,
    ),
  });
  return {
    certificate,
    facts: deepFreeze(normalizedFacts),
  };
}

export function buildSourceWatermarkCertificate(input = {}) {
  return certificateBuildResult(input).certificate;
}

function configuredIdentityBindingKey() {
  const encoded = process.env[
    SOURCE_IDENTITY_BINDING_AUTHORITY_KEY_ENV
  ];
  let key = null;
  if (typeof encoded === "string" && AUTHORITY_KEY.test(encoded)) {
    try {
      const decoded = Buffer.from(encoded, "base64url");
      if (
        decoded.length >= 32
        && decoded.toString("base64url") === encoded
      ) {
        key = decoded;
      }
    } catch {
      key = null;
    }
  }
  invariant(
    key,
    "SOURCE_IDENTITY_BINDING_AUTHORITY_UNAVAILABLE",
    "identity-binding authority key is unavailable or malformed",
  );
  return key;
}

function identityBindingKeyIdDigest(key) {
  return createHash("sha256")
    .update("phase4-source-identity-binding-key-id-v1")
    .update("\0")
    .update(key)
    .digest("hex");
}

function identityBindingReceiptMac(key, material) {
  return createHmac("sha256", key)
    .update("phase4-source-identity-binding-receipt-v2")
    .update("\0")
    .update(canonicalJson(material))
    .digest("hex");
}

function sourceBindingV2(raw, {
  entryIndex,
  bindingIndex,
}) {
  const field =
    `alias entries[${entryIndex}].bindings[${bindingIndex}]`;
  const binding = object(raw, field);
  exactKeys(
    binding,
    [
      "version",
      "policyVersion",
      "kind",
      "source",
      "sourceRecordDigest",
      "sourceRecordRevisionDigest",
      "sourcePointReadProcedure",
      "sourceNormalizedInputDigest",
      "identityPointReadProcedure",
      "identityNormalizedInputDigest",
      "identityPointRecordDigest",
      "identityPointRecordRevisionDigest",
      "resolutionEvidenceDigest",
      "decisionBoundaryAt",
      "observedAt",
      "sourceCollectorArtifactDigest",
      "identityCollectorArtifactDigest",
      "receiptNonceDigest",
      "authorityKeyIdDigest",
      "receiptMac",
    ],
    "SOURCE_IDENTITY_BINDING_RECEIPT_SHAPE_INVALID",
    field,
  );
  return {
    version: binding.version,
    policyVersion: binding.policyVersion,
    kind: binding.kind,
    source: sourceName(binding.source, `${field}.source`),
    sourceRecordDigest: digest(
      binding.sourceRecordDigest,
      `${field}.sourceRecordDigest`,
    ),
    sourceRecordRevisionDigest: digest(
      binding.sourceRecordRevisionDigest,
      `${field}.sourceRecordRevisionDigest`,
    ),
    sourcePointReadProcedure: String(
      binding.sourcePointReadProcedure,
    ),
    sourceNormalizedInputDigest: digest(
      binding.sourceNormalizedInputDigest,
      `${field}.sourceNormalizedInputDigest`,
    ),
    identityPointReadProcedure: String(
      binding.identityPointReadProcedure,
    ),
    identityNormalizedInputDigest: digest(
      binding.identityNormalizedInputDigest,
      `${field}.identityNormalizedInputDigest`,
    ),
    identityPointRecordDigest: digest(
      binding.identityPointRecordDigest,
      `${field}.identityPointRecordDigest`,
    ),
    identityPointRecordRevisionDigest: digest(
      binding.identityPointRecordRevisionDigest,
      `${field}.identityPointRecordRevisionDigest`,
    ),
    resolutionEvidenceDigest: digest(
      binding.resolutionEvidenceDigest,
      `${field}.resolutionEvidenceDigest`,
    ),
    decisionBoundaryAt: canonicalTimestamp(
      binding.decisionBoundaryAt,
      `${field}.decisionBoundaryAt`,
    ),
    observedAt: canonicalTimestamp(
      binding.observedAt,
      `${field}.observedAt`,
    ),
    sourceCollectorArtifactDigest: digest(
      binding.sourceCollectorArtifactDigest,
      `${field}.sourceCollectorArtifactDigest`,
    ),
    identityCollectorArtifactDigest: digest(
      binding.identityCollectorArtifactDigest,
      `${field}.identityCollectorArtifactDigest`,
    ),
    receiptNonceDigest: digest(
      binding.receiptNonceDigest,
      `${field}.receiptNonceDigest`,
    ),
    authorityKeyIdDigest: digest(
      binding.authorityKeyIdDigest,
      `${field}.authorityKeyIdDigest`,
    ),
    receiptMac: digest(
      binding.receiptMac,
      `${field}.receiptMac`,
    ),
  };
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

function verifySourceBindingV2(binding, {
  entry,
  decisionBoundaryAt,
}) {
  invariant(
    binding.version === SOURCE_IDENTITY_BINDING_RECEIPT_VERSION
      && binding.policyVersion
        === SOURCE_WATERMARK_POLICY_VERSION
      && binding.kind === "source_identity_binding",
    "SOURCE_IDENTITY_BINDING_RECEIPT_VERSION_INVALID",
    "source identity-binding receipt version is invalid",
  );
  const expectedSourceProcedure = binding.source
      === SOURCE_WATERMARK_SOURCES.RECALL
    ? SOURCE_IDENTITY_POINT_READ_PROCEDURES.recallSource
    : SOURCE_IDENTITY_POINT_READ_PROCEDURES
      .paraformHumanSource;
  invariant(
    binding.sourcePointReadProcedure
        === expectedSourceProcedure
      && binding.identityPointReadProcedure
        === SOURCE_IDENTITY_POINT_READ_PROCEDURES
          .candidateUserIdentity,
    "SOURCE_IDENTITY_BINDING_POINT_READ_MISMATCH",
    "source identity binding does not use the pinned point reads",
  );
  invariant(
    binding.decisionBoundaryAt === decisionBoundaryAt
      && Date.parse(binding.observedAt)
        >= Date.parse(decisionBoundaryAt),
    "SOURCE_IDENTITY_BINDING_TIME_MISMATCH",
    "source identity binding does not share the capture boundary",
  );
  invariant(
    binding.sourceCollectorArtifactDigest
      === SOURCE_WATERMARK_APPROVED_COLLECTORS[
        binding.source
      ].collectorCodeCommitmentDigest,
    "SOURCE_IDENTITY_BINDING_ARTIFACT_MISMATCH",
    "source identity binding is not pinned to its source collector",
  );
  invariant(
    binding.resolutionEvidenceDigest
      === sourceBindingResolutionDigest(entry, binding),
    "SOURCE_IDENTITY_BINDING_RESOLUTION_MISMATCH",
    "source identity binding resolution evidence is not canonical",
  );
  invariant(
    SOURCE_IDENTITY_BINDING_IDENTITY_ARTIFACT_DIGEST != null,
    "SOURCE_IDENTITY_BINDING_IDENTITY_ARTIFACT_UNAVAILABLE",
    "no reviewed candidate-user identity collector is pinned",
  );
  invariant(
    binding.identityCollectorArtifactDigest
      === SOURCE_IDENTITY_BINDING_IDENTITY_ARTIFACT_DIGEST,
    "SOURCE_IDENTITY_BINDING_ARTIFACT_MISMATCH",
    "source identity binding is not pinned to the identity collector",
  );
  const key = configuredIdentityBindingKey();
  invariant(
    binding.authorityKeyIdDigest
      === identityBindingKeyIdDigest(key),
    "SOURCE_IDENTITY_BINDING_KEY_MISMATCH",
    "source identity binding was issued by another key",
  );
  const { receiptMac, ...bindingMaterial } = binding;
  const expectedMac = identityBindingReceiptMac(key, {
    version: SOURCE_IDENTITY_BINDING_RECEIPT_VERSION,
    policyVersion: SOURCE_WATERMARK_POLICY_VERSION,
    kind: "source_identity_binding",
    canonicalCandidateDigest:
      entry.canonicalCandidateDigest,
    candidateUserAliasDigest:
      entry.candidateUserAliasDigest,
    binding: bindingMaterial,
  });
  invariant(
    timingSafeEqual(
      Buffer.from(receiptMac, "hex"),
      Buffer.from(expectedMac, "hex"),
    ),
    "SOURCE_IDENTITY_BINDING_RECEIPT_INVALID",
    "source identity-binding receipt MAC is invalid",
  );
  return true;
}

function aliasEntryV2(raw, index) {
  const field = `alias entries[${index}]`;
  const entry = object(raw, field);
  exactKeys(
    entry,
    [
      "canonicalCandidateDigest",
      "candidateUserAliasDigest",
      "bindings",
    ],
    "SOURCE_ALIAS_ENTRY_SHAPE_INVALID",
    field,
  );
  const canonicalCandidateDigest = digest(
    entry.canonicalCandidateDigest,
    `${field}.canonicalCandidateDigest`,
  );
  const candidateUserAliasDigest = digest(
    entry.candidateUserAliasDigest,
    `${field}.candidateUserAliasDigest`,
  );
  if (canonicalCandidateDigest === candidateUserAliasDigest) {
    throw new TypeError(
      "canonical and candidate-user alias digests must be domain-separated",
    );
  }
  const bindings = array(entry.bindings, `${field}.bindings`)
    .map((binding, bindingIndex) => sourceBindingV2(binding, {
      entryIndex: index,
      bindingIndex,
    }))
    .sort((left, right) => (
      left.source.localeCompare(right.source)
      || left.sourceRecordDigest.localeCompare(
        right.sourceRecordDigest,
      )
      || left.sourceRecordRevisionDigest.localeCompare(
        right.sourceRecordRevisionDigest,
      )
    ));
  return {
    canonicalCandidateDigest,
    candidateUserAliasDigest,
    bindings,
  };
}

function normalizedAliasEntriesV2(
  entries,
  {
    decisionBoundaryAt,
  },
) {
  return array(entries, "alias entries")
    .map((raw, index) => {
      const entry = aliasEntryV2(raw, index);
      const bindings = entry.bindings.map((binding) => {
        let failureCode = null;
        try {
          verifySourceBindingV2(binding, {
            entry,
            decisionBoundaryAt,
          });
        } catch (error) {
          failureCode =
            error?.code
            || "SOURCE_IDENTITY_BINDING_RECEIPT_INVALID";
        }
        return {
          ...binding,
          identityBindingProven: failureCode == null,
          identityBindingFailureCode: failureCode,
          receiptDigest: semanticDigest(
            "phase4-source-identity-binding-receipt-v2",
            {
              canonicalCandidateDigest:
                entry.canonicalCandidateDigest,
              candidateUserAliasDigest:
                entry.candidateUserAliasDigest,
              binding,
            },
          ),
        };
      });
      return {
        ...entry,
        bindings,
        identityBindingProven:
          bindings.length > 0
          && bindings.every(
            (binding) => binding.identityBindingProven,
          ),
      };
    })
    .sort((left, right) => (
      left.canonicalCandidateDigest.localeCompare(
        right.canonicalCandidateDigest,
      )
      || left.candidateUserAliasDigest.localeCompare(
        right.candidateUserAliasDigest,
      )
    ));
}

function aliasEdgeSetDigest(decisionBoundaryAt, entries) {
  return semanticDigest("phase4-source-alias-edges-v3", {
    policyVersion: SOURCE_WATERMARK_POLICY_VERSION,
    decisionBoundaryAt,
    collector: SOURCE_WATERMARK_APPROVED_COLLECTORS.aliases,
    entries,
  });
}

export function sourceWatermarkAliasSetDigest({
  decisionBoundaryAt,
  entries = [],
} = {}) {
  const boundary = canonicalTimestamp(
    decisionBoundaryAt,
    "alias map decisionBoundaryAt",
  );
  return aliasEdgeSetDigest(
    boundary,
    normalizedAliasEntriesV2(entries, {
      decisionBoundaryAt: boundary,
    }),
  );
}

function normalizeAliasPass(raw, {
  decisionBoundaryAt,
  index,
}) {
  const pass = object(raw, `alias passes[${index}]`);
  const passNumber = positiveInteger(
    pass.passNumber,
    `alias passes[${index}].passNumber`,
  );
  if (passNumber !== index + 1) {
    throw new TypeError("alias pass numbers must be contiguous");
  }
  const startedAt = canonicalTimestamp(
    pass.startedAt,
    `alias passes[${index}].startedAt`,
  );
  const completedAt = canonicalTimestamp(
    pass.completedAt,
    `alias passes[${index}].completedAt`,
  );
  if (Date.parse(completedAt) < Date.parse(startedAt)) {
    throw new RangeError(
      "alias pass cannot complete before it starts",
    );
  }
  return {
    passNumber,
    startedAt,
    completedAt,
    exhaustive: strictBoolean(
      pass.exhaustive,
      `alias passes[${index}].exhaustive`,
    ),
    cursorExhausted: strictBoolean(
      pass.cursorExhausted,
      `alias passes[${index}].cursorExhausted`,
    ),
    pageCount: positiveInteger(
      pass.pageCount,
      `alias passes[${index}].pageCount`,
    ),
    edgeCount: nonNegativeInteger(
      pass.edgeCount,
      `alias passes[${index}].edgeCount`,
    ),
    semanticDigest: digest(
      pass.semanticDigest,
      `alias passes[${index}].semanticDigest`,
    ),
    epochAtStart: digest(
      pass.epochAtStart,
      `alias passes[${index}].epochAtStart`,
    ),
    epochAtEnd: digest(
      pass.epochAtEnd,
      `alias passes[${index}].epochAtEnd`,
    ),
    boundaryPredatesPass:
      Date.parse(decisionBoundaryAt) <= Date.parse(startedAt),
  };
}

export function buildCanonicalSourceAliasMap(
  entries = [],
  {
    decisionBoundaryAt,
    collectorVersion,
    collectorCodeCommitmentDigest,
    passes = [],
  } = {},
) {
  const boundary = canonicalTimestamp(
    decisionBoundaryAt,
    "alias map decisionBoundaryAt",
  );
  const normalizedCollectorCodeCommitmentDigest =
    collectorCodeCommitmentDigest == null
      ? null
      : digest(
        collectorCodeCommitmentDigest,
        "alias collectorCodeCommitmentDigest",
      );
  const approvedCollector = approvedCollectorPin(
    "aliases",
    collectorVersion,
    normalizedCollectorCodeCommitmentDigest,
  );
  const normalized = normalizedAliasEntriesV2(entries, {
    decisionBoundaryAt: boundary,
  });
  const edgeSetDigest = aliasEdgeSetDigest(boundary, normalized);
  const normalizedPasses = array(passes, "alias passes")
    .map((pass, index) => normalizeAliasPass(pass, {
      decisionBoundaryAt: boundary,
      index,
    }));
  const exact = new Set();
  const deduped = [];
  let duplicateEntryCount = 0;
  for (const entry of normalized) {
    const key = (
      `${entry.canonicalCandidateDigest}:`
      + entry.candidateUserAliasDigest
    );
    if (exact.has(key)) {
      duplicateEntryCount += 1;
      continue;
    }
    exact.add(key);
    deduped.push(entry);
  }
  invariant(
    duplicateEntryCount === 0,
    "SOURCE_ALIAS_DUPLICATE_EDGE",
    "duplicate alias edges cannot be persisted losslessly",
  );

  const aliasesByCanonical = new Map();
  const canonicalsByAlias = new Map();
  for (const entry of deduped) {
    const aliases = aliasesByCanonical.get(
      entry.canonicalCandidateDigest,
    ) || new Set();
    aliases.add(entry.candidateUserAliasDigest);
    aliasesByCanonical.set(entry.canonicalCandidateDigest, aliases);
    const canonicals = canonicalsByAlias.get(
      entry.candidateUserAliasDigest,
    ) || new Set();
    canonicals.add(entry.canonicalCandidateDigest);
    canonicalsByAlias.set(entry.candidateUserAliasDigest, canonicals);
  }
  const canonicalConflictCount = [...aliasesByCanonical.values()]
    .filter((aliases) => aliases.size !== 1).length;
  const aliasConflictCount = [...canonicalsByAlias.values()]
    .filter((canonicals) => canonicals.size !== 1).length;
  const conflictCount =
    canonicalConflictCount + aliasConflictCount;
  const reasons = new Set();
  if (
    SOURCE_IDENTITY_BINDING_IDENTITY_ARTIFACT_DIGEST == null
  ) {
    reasons.add("identity_collector_artifact_unpinned");
  }
  if (deduped.length === 0) {
    reasons.add("identity_binding_receipts_missing");
  }
  if (normalizedPasses.length < 2) {
    reasons.add("stable_passes_missing");
  }
  for (let index = 0; index < normalizedPasses.length; index += 1) {
    const pass = normalizedPasses[index];
    if (!pass.boundaryPredatesPass) {
      reasons.add("pass_predates_boundary");
    }
    if (!pass.exhaustive) reasons.add("source_not_exhaustive");
    if (!pass.cursorExhausted) {
      reasons.add("cursor_not_exhausted");
    }
    if (pass.edgeCount !== normalized.length) {
      reasons.add("edge_count_mismatch");
    }
    if (pass.semanticDigest !== edgeSetDigest) {
      reasons.add("semantic_digest_mismatch");
    }
    if (pass.epochAtStart !== pass.epochAtEnd) {
      reasons.add("source_epoch_moved");
    }
    const prior = normalizedPasses[index - 1];
    if (
      prior
      && Date.parse(pass.startedAt) < Date.parse(prior.completedAt)
    ) {
      reasons.add("passes_not_sequential");
    }
  }
  const semanticDigests = new Set(
    normalizedPasses.map((pass) => pass.semanticDigest),
  );
  if (semanticDigests.size > 1) {
    reasons.add("stable_pass_digest_mismatch");
  }
  const epochDigests = new Set(
    normalizedPasses.flatMap((pass) => [
      pass.epochAtStart,
      pass.epochAtEnd,
    ]),
  );
  if (epochDigests.size !== 1) reasons.add("source_epoch_moved");
  if (conflictCount > 0) reasons.add("alias_conflicts");
  const bindings = deduped.flatMap((entry) => entry.bindings);
  const bindingCount = bindings.length;
  const identityBindingProvenCount = bindings.filter(
    (binding) => binding.identityBindingProven,
  ).length;
  const identityBindingUnprovenCount =
    bindingCount - identityBindingProvenCount;
  const edgeWithoutBindingCount = deduped.filter(
    (entry) => entry.bindings.length === 0,
  ).length;
  if (edgeWithoutBindingCount > 0) {
    reasons.add("alias_edges_without_source_binding");
  }
  if (identityBindingUnprovenCount > 0) {
    reasons.add("identity_binding_receipts_unproven");
  }
  const reasonList = [...reasons].sort();
  const epochStable = epochDigests.size === 1;
  const stablePasses =
    normalizedPasses.length >= 2
    && semanticDigests.size === 1;
  const exhaustive =
    normalizedPasses.length >= 2
    && normalizedPasses.every((pass) => pass.exhaustive);
  const cursorExhausted =
    normalizedPasses.length >= 2
    && normalizedPasses.every(
      (pass) => pass.cursorExhausted,
    );
  const authoritative = Boolean(
    SOURCE_IDENTITY_BINDING_IDENTITY_ARTIFACT_DIGEST
      != null
    && bindingCount > 0
    && identityBindingUnprovenCount === 0
  );
  const snapshotComplete = Boolean(
    authoritative
    && stablePasses
    && exhaustive
    && cursorExhausted
    && duplicateEntryCount === 0
    && conflictCount === 0
    && edgeWithoutBindingCount === 0
  );
  const complete = reasonList.length === 0;
  const material = {
    version: 5,
    policyVersion: SOURCE_WATERMARK_POLICY_VERSION,
    mapping: "candidate_user_to_canonical_candidate_bijection",
    decisionBoundaryAt: boundary,
    collectorVersion: approvedCollector.collectorVersion,
    collectorCodeCommitmentDigest:
      approvedCollector.collectorCodeCommitmentDigest,
    authoritative,
    snapshotComplete,
    passCount: normalizedPasses.length,
    passes: normalizedPasses,
    stablePasses,
    exhaustive,
    cursorExhausted,
    edgeSetDigest,
    epochStable,
    aliasEpochDigest: epochStable
      ? [...epochDigests][0]
      : null,
    entries: deduped,
    canonicalCandidateCount: aliasesByCanonical.size,
    candidateUserAliasCount: canonicalsByAlias.size,
    duplicateEntryCount,
    canonicalConflictCount,
    aliasConflictCount,
    conflictCount,
    bindingCount,
    edgeWithoutBindingCount,
    identityBindingProvenCount,
    identityBindingUnprovenCount,
    complete,
    reasons: reasonList,
  };
  return deepFreeze({
    ...material,
    aliasMapDigest: semanticDigest(
      "phase4-source-alias-map-v2",
      material,
    ),
  });
}

function persistedAliasInputEntries(entries) {
  return array(entries, "aliasMap.entries").map(
    (rawEntry, entryIndex) => {
      const entry = object(
        rawEntry,
        `aliasMap.entries[${entryIndex}]`,
      );
      return {
        canonicalCandidateDigest:
          entry.canonicalCandidateDigest,
        candidateUserAliasDigest:
          entry.candidateUserAliasDigest,
        bindings: array(
          entry.bindings,
          `aliasMap.entries[${entryIndex}].bindings`,
        ).map((rawBinding, bindingIndex) => {
          const binding = object(
            rawBinding,
            (
              `aliasMap.entries[${entryIndex}]`
              + `.bindings[${bindingIndex}]`
            ),
          );
          const {
            identityBindingProven: _identityBindingProven,
            identityBindingFailureCode:
              _identityBindingFailureCode,
            receiptDigest: _receiptDigest,
            ...receiptMaterial
          } = binding;
          return receiptMaterial;
        }),
      };
    },
  );
}

function canonicalAliasMap(value) {
  const raw = object(value, "aliasMap");
  const rebuilt = buildCanonicalSourceAliasMap(
    persistedAliasInputEntries(raw.entries),
    {
      decisionBoundaryAt: raw.decisionBoundaryAt,
      collectorVersion: raw.collectorVersion,
      collectorCodeCommitmentDigest:
        raw.collectorCodeCommitmentDigest,
      passes: raw.passes,
    },
  );
  invariant(
    raw.aliasMapDigest === rebuilt.aliasMapDigest,
    "SOURCE_ALIAS_MAP_DIGEST_MISMATCH",
    "alias map digest does not match its entries",
  );
  return rebuilt;
}

function q37FromNormalizedFacts(facts) {
  const incomplete = facts.filter((fact) => (
    ["pending", "conflict"].includes(fact.classification)
    || (
      ["success", "failure"].includes(fact.classification)
      && (
        fact.provenanceVerified !== true
        || fact.recordRevisionDigest == null
      )
    )
    || (
      fact.classification === "success"
      && fact.identityStatus !== "resolved"
    )
  ));
  if (incomplete.length > 0) {
    const material = {
      decision: "review_incomplete_source",
      callType: null,
      endedAt: null,
      evidenceDigest: semanticDigest(
        "phase4-q37-incomplete-evidence-v1",
        incomplete.map((fact) => ({
          source: fact.source,
          recordDigest: fact.recordDigest,
          classification: fact.classification,
          identityStatus: fact.identityStatus,
          provenanceVerified: fact.provenanceVerified,
        })),
      ),
    };
    return deepFreeze({
      ...material,
      decisionDigest: semanticDigest(
        "phase4-q37-decision-v1",
        material,
      ),
    });
  }
  const successful = facts
    .filter((fact) => fact.classification === "success")
    .sort((left, right) => (
      Date.parse(left.endedAt) - Date.parse(right.endedAt)
      || left.source.localeCompare(right.source)
      || left.recordDigest.localeCompare(right.recordDigest)
    ));
  if (successful.length === 0) {
    const material = {
      decision: "none",
      callType: null,
      endedAt: null,
      evidenceDigest: semanticDigest(
        "phase4-q37-evidence-v1",
        [],
      ),
    };
    return deepFreeze({
      ...material,
      decisionDigest: semanticDigest(
        "phase4-q37-decision-v1",
        material,
      ),
    });
  }
  const mostRecentMs = Math.max(...successful.map(
    (fact) => Date.parse(fact.endedAt),
  ));
  const mostRecent = successful.filter(
    (fact) => Date.parse(fact.endedAt) === mostRecentMs,
  );
  const callTypes = new Set(mostRecent.map((fact) => (
    fact.source === SOURCE_WATERMARK_SOURCES.RECALL
      ? "agent"
      : "human"
  )));
  const evidenceDigest = semanticDigest(
    "phase4-q37-evidence-v1",
    mostRecent.map((fact) => ({
      source: fact.source,
      recordDigest: fact.recordDigest,
      endedAt: fact.endedAt,
    })),
  );
  const ambiguous = callTypes.size !== 1;
  const material = {
    decision: ambiguous
      ? "review_ambiguous_tie"
      : "selected",
    callType: ambiguous ? null : [...callTypes][0],
    endedAt: new Date(mostRecentMs).toISOString(),
    evidenceDigest,
  };
  return deepFreeze({
    ...material,
    decisionDigest: semanticDigest(
      "phase4-q37-decision-v1",
      material,
    ),
  });
}

export function q37NewestSuccessfulCallDecision({
  decisionBoundaryAt,
  facts = [],
} = {}) {
  const boundary = canonicalTimestamp(
    decisionBoundaryAt,
    "decisionBoundaryAt",
  );
  const normalized = [];
  for (const source of SOURCE_LIST) {
    const rows = array(facts, "facts").filter(
      (fact) => fact?.source === source,
    );
    normalized.push(...normalizeSourceFacts({
      source,
      decisionBoundaryAt: boundary,
      facts: rows,
    }));
  }
  if (normalized.length !== facts.length) {
    throw new TypeError("facts contain an unsupported source");
  }
  return q37FromNormalizedFacts(normalized);
}

function revalidateCertificate(certificate, facts) {
  const raw = object(certificate, "source certificate");
  const rebuilt = certificateBuildResult({
    source: raw.source,
    decisionBoundaryAt: raw.decisionBoundaryAt,
    collectorVersion: raw.collectorVersion,
    collectorCodeCommitmentDigest:
      raw.collectorCodeCommitmentDigest,
    facts,
    passes: raw.passes,
  });
  invariant(
    raw.certificateDigest
      === rebuilt.certificate.certificateDigest,
    "SOURCE_CERTIFICATE_DIGEST_MISMATCH",
    "source certificate digest does not match its evidence",
  );
  return rebuilt;
}

function sourceBundle(raw, expectedSource, decisionBoundaryAt) {
  const bundle = object(raw, `${expectedSource} source bundle`);
  const rebuilt = revalidateCertificate(
    bundle.certificate,
    bundle.facts,
  );
  invariant(
    rebuilt.certificate.source === expectedSource,
    "SOURCE_CERTIFICATE_SOURCE_MISMATCH",
    "source certificate is bound to the wrong source",
  );
  invariant(
    rebuilt.certificate.decisionBoundaryAt
      === decisionBoundaryAt,
    "SOURCE_BOUNDARY_MISMATCH",
    "both source certificates must share the exact decision boundary",
  );
  return rebuilt;
}

function aliasLookup(aliasMap) {
  const candidateByAlias = new Map();
  const knownCandidates = new Set();
  for (const entry of aliasMap.entries) {
    candidateByAlias.set(
      entry.candidateUserAliasDigest,
      entry.canonicalCandidateDigest,
    );
    knownCandidates.add(entry.canonicalCandidateDigest);
  }
  return { candidateByAlias, knownCandidates };
}

function aliasSourceEvidence({
  aliasMap,
  recallFacts,
  paraformFacts,
}) {
  const sourceFacts = [...recallFacts, ...paraformFacts];
  const resolvedFacts = sourceFacts.filter(
    (fact) => fact.identityStatus === "resolved",
  );
  const factKey = (fact) => (
    `${fact.source}:${fact.recordDigest}:`
    + (fact.recordRevisionDigest || "missing")
  );
  const bindingKey = (binding) => (
    `${binding.source}:${binding.sourceRecordDigest}:`
    + binding.sourceRecordRevisionDigest
  );
  const factsByRecord = new Map(
    resolvedFacts.map((fact) => [factKey(fact), fact]),
  );
  const bindingsByRecord = new Map();
  const bindingRows = [];
  let duplicateBindingCount = 0;
  let extraBindingCount = 0;
  let mismatchedBindingCount = 0;
  let unprovenBindingCount = 0;
  const reachableCandidates = new Set();
  const reachablePairs = new Set();
  for (const entry of aliasMap.entries) {
    let edgeReachable = false;
    for (const binding of entry.bindings) {
      const key = bindingKey(binding);
      const rows = bindingsByRecord.get(key) || [];
      if (rows.length > 0) duplicateBindingCount += 1;
      rows.push({ entry, binding });
      bindingsByRecord.set(key, rows);
      const fact = factsByRecord.get(key);
      if (!fact) {
        extraBindingCount += 1;
      }
      const identityMatches = Boolean(
        fact
        && (
          fact.source === SOURCE_WATERMARK_SOURCES.RECALL
            ? fact.identityKind === "canonical_candidate"
              && fact.identityDigest
                === entry.canonicalCandidateDigest
            : fact.identityKind === "candidate_user_alias"
              && fact.identityDigest
                === entry.candidateUserAliasDigest
        )
      );
      if (fact && !identityMatches) {
        mismatchedBindingCount += 1;
      }
      if (!binding.identityBindingProven) {
        unprovenBindingCount += 1;
      }
      if (fact && identityMatches) {
        edgeReachable = true;
        reachableCandidates.add(
          entry.canonicalCandidateDigest,
        );
        reachablePairs.add(
          `${entry.canonicalCandidateDigest}:`
          + entry.candidateUserAliasDigest,
        );
      }
      bindingRows.push({
        source: binding.source,
        sourceRecordDigest:
          binding.sourceRecordDigest,
        sourceRecordRevisionDigest:
          binding.sourceRecordRevisionDigest,
        canonicalCandidateDigest:
          entry.canonicalCandidateDigest,
        candidateUserAliasDigest:
          entry.candidateUserAliasDigest,
        factMatched: Boolean(fact && identityMatches),
        proven: binding.identityBindingProven === true,
      });
    }
    if (!edgeReachable) {
      reachablePairs.delete(
        `${entry.canonicalCandidateDigest}:`
        + entry.candidateUserAliasDigest,
      );
    }
  }
  const sourceRecordKeys = [...factsByRecord.keys()].sort();
  const bindingRecordKeys = [...bindingsByRecord.keys()].sort();
  const missingBindingCount = sourceRecordKeys.filter(
    (key) => (bindingsByRecord.get(key) || []).length !== 1,
  ).length;
  const nullRevisionFactCount = resolvedFacts.filter(
    (fact) => fact.recordRevisionDigest == null,
  ).length;
  const aliasCandidates = new Set(
    aliasMap.entries.map(
      (entry) => entry.canonicalCandidateDigest,
    ),
  );
  const candidateUniverseEqual = (
    aliasCandidates.size === reachableCandidates.size
    && [...aliasCandidates].every(
      (candidate) => reachableCandidates.has(candidate),
    )
  );
  const sourceRecordUniverseEqual = (
    canonicalJson(sourceRecordKeys)
      === canonicalJson(bindingRecordKeys)
  );
  const universeEqual = Boolean(
    sourceRecordUniverseEqual
    && candidateUniverseEqual
    && reachablePairs.size === aliasMap.entries.length
  );
  const provenEntryCount = aliasMap.entries.filter((entry) => (
    entry.bindings.length > 0
    && entry.bindings.every((binding) => {
      const fact = factsByRecord.get(bindingKey(binding));
      return Boolean(
        binding.identityBindingProven
        && fact
        && (
          fact.source === SOURCE_WATERMARK_SOURCES.RECALL
            ? fact.identityDigest
                === entry.canonicalCandidateDigest
            : fact.identityDigest
                === entry.candidateUserAliasDigest
        )
      );
    })
  )).length;
  const unprovenEntryCount =
    aliasMap.entries.length - provenEntryCount;
  const sourceProven = Boolean(
    aliasMap.complete
    && universeEqual
    && missingBindingCount === 0
    && extraBindingCount === 0
    && duplicateBindingCount === 0
    && mismatchedBindingCount === 0
    && nullRevisionFactCount === 0
    && unprovenBindingCount === 0
    && unprovenEntryCount === 0
  );
  const material = {
    decisionBoundaryAt: aliasMap.decisionBoundaryAt,
    aliasMapDigest: aliasMap.aliasMapDigest,
    edgeSetDigest: aliasMap.edgeSetDigest,
    collectorVersion: aliasMap.collectorVersion,
    collectorCodeCommitmentDigest:
      aliasMap.collectorCodeCommitmentDigest,
    aliasEpochDigest: aliasMap.aliasEpochDigest,
    passCount: aliasMap.passCount,
    sourceProven,
    sourceRecordUniverseEqual,
    candidateUniverseEqual,
    universeEqual,
    sourceRecordCount: sourceRecordKeys.length,
    bindingRecordCount: bindingRecordKeys.length,
    missingBindingCount,
    extraBindingCount,
    duplicateBindingCount,
    mismatchedBindingCount,
    nullRevisionFactCount,
    unprovenBindingCount,
    provenEntryCount,
    unprovenEntryCount,
    sourceRecordUniverseDigest: semanticDigest(
      "phase4-source-record-universe-v1",
      sourceRecordKeys,
    ),
    bindingRecordUniverseDigest: semanticDigest(
      "phase4-source-binding-record-universe-v1",
      bindingRecordKeys,
    ),
    candidateUniverseDigest: semanticDigest(
      "phase4-source-candidate-universe-v1",
      [...reachableCandidates].sort(),
    ),
    aliasEdgeUniverseDigest: semanticDigest(
      "phase4-source-alias-edge-universe-v1",
      [...reachablePairs].sort(),
    ),
    provenEdgeDigest: semanticDigest(
      "phase4-source-proven-alias-bindings-v2",
      bindingRows,
    ),
  };
  return deepFreeze({
    ...material,
    evidenceDigest: semanticDigest(
      "phase4-source-alias-evidence-v2",
      material,
    ),
  });
}

function generationQ37({
  recallFacts,
  paraformFacts,
  aliasMap,
}) {
  const { candidateByAlias, knownCandidates } =
    aliasLookup(aliasMap);
  const factsByCandidate = new Map(
    [...knownCandidates].map((candidate) => [candidate, []]),
  );
  let identityIssueCount = 0;

  for (const fact of [...recallFacts, ...paraformFacts]) {
    if (
      fact.identityStatus !== "resolved"
      || !fact.identityDigest
    ) {
      identityIssueCount += 1;
      continue;
    }
    const canonicalCandidateDigest =
      fact.source === SOURCE_WATERMARK_SOURCES.RECALL
        ? fact.identityDigest
        : candidateByAlias.get(fact.identityDigest);
    if (
      !canonicalCandidateDigest
      || !knownCandidates.has(canonicalCandidateDigest)
    ) {
      identityIssueCount += 1;
      continue;
    }
    factsByCandidate.get(canonicalCandidateDigest).push(fact);
  }

  const hypotheticalDecisions = [...factsByCandidate.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([canonicalCandidateDigest, facts]) => {
      const decision = q37FromNormalizedFacts(facts);
      const material = {
        canonicalCandidateDigest,
        decision: decision.decision,
        callType: decision.callType,
        endedAt: decision.endedAt,
        evidenceDigest: decision.evidenceDigest,
      };
      return {
        ...material,
        decisionDigest: semanticDigest(
          "phase4-q37-candidate-decision-v1",
          material,
        ),
      };
    });
  const darkReasons = [
    "human_intro_source_unpinned",
    "paraform_human_discriminator_unpinned",
  ];
  const decisions = hypotheticalDecisions.map((decision) => {
    const material = {
      canonicalCandidateDigest:
        decision.canonicalCandidateDigest,
      decision: "review_source_contract_unpinned",
      callType: null,
      endedAt: null,
      evidenceDigest: semanticDigest(
        "phase4-q37-dark-evidence-v1",
        {
          hypotheticalDecisionDigest:
            decision.decisionDigest,
          reasons: darkReasons,
        },
      ),
    };
    return {
      ...material,
      decisionDigest: semanticDigest(
        "phase4-q37-candidate-decision-v2",
        material,
      ),
    };
  });
  const count = (decision) => decisions.filter(
    (row) => row.decision === decision,
  ).length;
  const typeCount = (callType) => decisions.filter(
    (row) => (
      row.decision === "selected"
      && row.callType === callType
    ),
  ).length;
  const material = {
    operational: false,
    paraformHumanDiscriminatorPinned: false,
    humanIntroSourcePinned: false,
    reasons: darkReasons,
    decisions,
    candidateCount: decisions.length,
    selectedCount: count("selected"),
    agentCount: typeCount("agent"),
    humanCount: typeCount("human"),
    noneCount: count("none"),
    reviewCount: decisions.filter(
      (row) => row.decision.startsWith("review_"),
    ).length,
    identityIssueCount,
    hypotheticalDecisionSetDigest: semanticDigest(
      "phase4-q37-hypothetical-decision-set-v1",
      hypotheticalDecisions,
    ),
  };
  return deepFreeze({
    ...material,
    decisionSetDigest: semanticDigest(
      "phase4-q37-decision-set-v2",
      material,
    ),
  });
}

function latestPassCompletedAt(...certificates) {
  return certificates
    .flatMap((certificate) => certificate.passes)
    .reduce((latest, pass) => (
      Date.parse(pass.completedAt) > Date.parse(latest)
        ? pass.completedAt
        : latest
    ), certificates[0].decisionBoundaryAt);
}

export function buildSourceWatermarkGeneration({
  decisionBoundaryAt,
  generationNonceDigest,
  status = "planned",
  committedAt = null,
  commitRevisionDigest = null,
  recall,
  paraformHuman,
  aliasMap,
} = {}) {
  const boundary = canonicalTimestamp(
    decisionBoundaryAt,
    "decisionBoundaryAt",
  );
  const nonce = digest(
    generationNonceDigest,
    "generationNonceDigest",
  );
  enumValue(status, GENERATION_STATUSES, "generation status");
  const recallBundle = sourceBundle(
    recall,
    SOURCE_WATERMARK_SOURCES.RECALL,
    boundary,
  );
  const paraformBundle = sourceBundle(
    paraformHuman,
    SOURCE_WATERMARK_SOURCES.PARAFORM_HUMAN,
    boundary,
  );
  const normalizedAliasMap = canonicalAliasMap(aliasMap);
  invariant(
    normalizedAliasMap.decisionBoundaryAt === boundary,
    "SOURCE_ALIAS_BOUNDARY_MISMATCH",
    "alias evidence must share the exact source decision boundary",
  );
  const normalizedAliasEvidence = aliasSourceEvidence({
    aliasMap: normalizedAliasMap,
    recallFacts: recallBundle.facts,
    paraformFacts: paraformBundle.facts,
  });
  const q37 = generationQ37({
    recallFacts: recallBundle.facts,
    paraformFacts: paraformBundle.facts,
    aliasMap: normalizedAliasMap,
  });
  const intrinsicSourceComplete = Boolean(
    recallBundle.certificate.complete
    && paraformBundle.certificate.complete
    && normalizedAliasMap.complete
    && normalizedAliasEvidence.sourceProven
    && q37.identityIssueCount === 0
  );
  const intrinsicQ37Ready = Boolean(
    intrinsicSourceComplete
    && q37.operational === true
    && q37.reviewCount === 0
  );
  const manifestMaterial = {
    version: SOURCE_WATERMARK_GENERATION_VERSION,
    policyVersion: SOURCE_WATERMARK_POLICY_VERSION,
    decisionBoundaryAt: boundary,
    generationNonceDigest: nonce,
    recallCertificateDigest:
      recallBundle.certificate.certificateDigest,
    paraformHumanCertificateDigest:
      paraformBundle.certificate.certificateDigest,
    aliasMapDigest: normalizedAliasMap.aliasMapDigest,
    aliasEvidenceDigest:
      normalizedAliasEvidence.evidenceDigest,
    collectorPinsDigest: semanticDigest(
      "phase4-source-approved-collector-pins-v1",
      SOURCE_WATERMARK_APPROVED_COLLECTORS,
    ),
    q37DecisionSetDigest: q37.decisionSetDigest,
  };
  const manifestDigest = semanticDigest(
    "phase4-source-watermark-manifest-v1",
    manifestMaterial,
  );

  let normalizedCommittedAt = null;
  let normalizedCommitRevisionDigest = null;
  if (status === "committed") {
    invariant(
      intrinsicQ37Ready,
      "SOURCE_WATERMARK_COMMIT_NOT_READY",
      "an incomplete or ambiguous generation cannot be committed",
    );
    normalizedCommittedAt = canonicalTimestamp(
      committedAt,
      "committedAt",
    );
    normalizedCommitRevisionDigest = digest(
      commitRevisionDigest,
      "commitRevisionDigest",
    );
    const captureCompletedAt = latestPassCompletedAt(
      recallBundle.certificate,
      paraformBundle.certificate,
      normalizedAliasMap,
    );
    invariant(
      Date.parse(normalizedCommittedAt)
        >= Date.parse(captureCompletedAt),
      "SOURCE_WATERMARK_COMMIT_PREDATES_CAPTURE",
      "generation commit cannot predate source capture",
    );
  } else if (
    committedAt != null
    || commitRevisionDigest != null
  ) {
    throw new TypeError(
      "planned generations cannot carry commit metadata",
    );
  }

  const material = {
    version: SOURCE_WATERMARK_GENERATION_VERSION,
    policyVersion: SOURCE_WATERMARK_POLICY_VERSION,
    status,
    decisionBoundaryAt: boundary,
    generationNonceDigest: nonce,
    manifestDigest,
    committedAt: normalizedCommittedAt,
    commitRevisionDigest: normalizedCommitRevisionDigest,
    intrinsicSourceComplete,
    intrinsicQ37Ready,
    sources: {
      recall: {
        certificate: recallBundle.certificate,
        facts: recallBundle.facts,
      },
      paraformHuman: {
        certificate: paraformBundle.certificate,
        facts: paraformBundle.facts,
      },
    },
    aliasMap: normalizedAliasMap,
    aliasEvidence: normalizedAliasEvidence,
    q37,
  };
  return deepFreeze({
    ...material,
    recordDigest: semanticDigest(
      "phase4-source-watermark-record-v1",
      material,
    ),
  });
}

export function validateSourceWatermarkGeneration(value) {
  const raw = object(value, "source watermark generation");
  const rebuilt = buildSourceWatermarkGeneration({
    decisionBoundaryAt: raw.decisionBoundaryAt,
    generationNonceDigest: raw.generationNonceDigest,
    status: raw.status,
    committedAt: raw.committedAt,
    commitRevisionDigest: raw.commitRevisionDigest,
    recall: raw.sources?.recall,
    paraformHuman: raw.sources?.paraformHuman,
    aliasMap: raw.aliasMap,
  });
  invariant(
    raw.manifestDigest === rebuilt.manifestDigest,
    "SOURCE_WATERMARK_MANIFEST_MISMATCH",
    "source watermark manifest does not match its evidence",
  );
  invariant(
    raw.recordDigest === rebuilt.recordDigest,
    "SOURCE_WATERMARK_RECORD_MISMATCH",
    "source watermark record does not match its evidence",
  );
  return rebuilt;
}

function emptySourcePublicStatus() {
  return {
    complete: false,
    exhaustive: false,
    cursorExhausted: false,
    stablePasses: false,
    passCount: 0,
    factCount: 0,
    pendingCount: 0,
    conflictCount: 0,
    unresolvedCount: 0,
    invalidCount: 0,
  };
}

function publicSourceStatus(certificate) {
  return {
    complete: certificate.complete === true,
    exhaustive: certificate.exhaustive === true,
    cursorExhausted: certificate.cursorExhausted === true,
    stablePasses: certificate.stablePasses === true,
    passCount: certificate.passCount,
    factCount: certificate.factCount,
    pendingCount: certificate.pendingCount,
    conflictCount: certificate.conflictCount,
    unresolvedCount: certificate.unresolvedCount,
    invalidCount: certificate.invalidCount,
  };
}

function emptyPublicStatus(status = "not_committed") {
  return deepFreeze({
    policyVersion: SOURCE_WATERMARK_POLICY_VERSION,
    status,
    committed: false,
    current: false,
    decisionBoundaryAt: null,
    manifestDigest: null,
    sourceWatermarkComplete: false,
    phase4Q37Ready: false,
    sources: {
      recall: emptySourcePublicStatus(),
      paraformHuman: emptySourcePublicStatus(),
    },
    aliases: {
      complete: false,
      authoritative: false,
      snapshotComplete: false,
      epochStable: false,
      sourceProven: false,
      canonicalCandidateCount: 0,
      candidateUserAliasCount: 0,
      duplicateEntryCount: 0,
      conflictCount: 0,
      identityBindingProvenCount: 0,
      identityBindingUnprovenCount: 0,
    },
    q37: {
      candidateCount: 0,
      selectedCount: 0,
      agentCount: 0,
      humanCount: 0,
      noneCount: 0,
      reviewCount: 0,
      identityIssueCount: 0,
    },
  });
}

function currentEpochsMatch(generation, currentSourceEpochs) {
  if (
    !currentSourceEpochs
    || typeof currentSourceEpochs !== "object"
    || Array.isArray(currentSourceEpochs)
  ) {
    return false;
  }
  try {
    return (
      digest(
        currentSourceEpochs.recall,
        "current Recall epoch",
      ) === generation.sources.recall.certificate.sourceEpochDigest
      && digest(
        currentSourceEpochs.paraformHuman,
        "current Paraform-human epoch",
      ) === (
        generation.sources.paraformHuman
          .certificate.sourceEpochDigest
      )
      && digest(
        currentSourceEpochs.aliases,
        "current alias-map epoch",
      ) === generation.aliasMap.aliasEpochDigest
    );
  } catch {
    return false;
  }
}

function exactKeys(value, expected, code, field) {
  const actual = Object.keys(object(value, field)).sort();
  const required = [...expected].sort();
  invariant(
    canonicalJson(actual) === canonicalJson(required),
    code,
    `${field} has an unexpected shape`,
  );
}

function collectorPinsDigest() {
  return semanticDigest(
    "phase4-source-approved-collector-pins-v1",
    SOURCE_WATERMARK_APPROVED_COLLECTORS,
  );
}

function configuredAuthorityKey() {
  const encoded = process.env[
    SOURCE_WATERMARK_AUTHORITY_KEY_ENV
  ];
  let key = null;
  if (typeof encoded === "string" && AUTHORITY_KEY.test(encoded)) {
    try {
      const decoded = Buffer.from(encoded, "base64url");
      if (
        decoded.length >= 32
        && decoded.toString("base64url") === encoded
      ) {
        key = decoded;
      }
    } catch {
      key = null;
    }
  }
  invariant(
    key,
    "SOURCE_AUTHORITY_UNAVAILABLE",
    "source authority key is unavailable or malformed",
  );
  return key;
}

function authorityKeyIdDigest(key) {
  return createHash("sha256")
    .update("phase4-source-authority-key-id-v1")
    .update("\0")
    .update(key)
    .digest("hex");
}

function authorityReceiptMac(key, material) {
  return createHmac("sha256", key)
    .update("phase4-source-authority-receipt-v1")
    .update("\0")
    .update(canonicalJson(material))
    .digest("hex");
}

function verifyAuthorityMac(raw, material) {
  const key = configuredAuthorityKey();
  const expectedKeyId = authorityKeyIdDigest(key);
  invariant(
    material.authorityKeyIdDigest === expectedKeyId,
    "SOURCE_AUTHORITY_KEY_MISMATCH",
    "authority receipt was issued by another key",
  );
  const suppliedMac = digest(
    raw.receiptMac,
    "authority receiptMac",
  );
  const expectedMac = authorityReceiptMac(key, material);
  invariant(
    timingSafeEqual(
      Buffer.from(suppliedMac, "hex"),
      Buffer.from(expectedMac, "hex"),
    ),
    "SOURCE_AUTHORITY_RECEIPT_INVALID",
    "authority receipt MAC is invalid",
  );
  return suppliedMac;
}

function authorityReceiptTimes(
  raw,
  {
    field,
    maxLifetimeMs,
  },
) {
  const issuedAt = canonicalTimestamp(
    raw.issuedAt,
    `${field}.issuedAt`,
  );
  const expiresAt = canonicalTimestamp(
    raw.expiresAt,
    `${field}.expiresAt`,
  );
  const issuedMs = Date.parse(issuedAt);
  const expiresMs = Date.parse(expiresAt);
  const nowMs = Date.now();
  invariant(
    expiresMs >= issuedMs
      && expiresMs - issuedMs <= maxLifetimeMs,
    "SOURCE_AUTHORITY_RECEIPT_LIFETIME_INVALID",
    "authority receipt lifetime is invalid",
  );
  invariant(
    issuedMs <= nowMs + AUTHORITY_CLOCK_SKEW_MS,
    "SOURCE_AUTHORITY_RECEIPT_FROM_FUTURE",
    "authority receipt was issued in the future",
  );
  invariant(
    expiresMs >= nowMs
      && nowMs - issuedMs
        <= maxLifetimeMs + AUTHORITY_CLOCK_SKEW_MS,
    "SOURCE_AUTHORITY_RECEIPT_STALE",
    "authority receipt is stale",
  );
  return { issuedAt, expiresAt, issuedMs, expiresMs, nowMs };
}

function generationAuthorityReceipt(generation, value) {
  const raw = object(value, "generation authority receipt");
  exactKeys(
    raw,
    [
      "version",
      "policyVersion",
      "kind",
      "generationRecordDigest",
      "manifestDigest",
      "commitRevisionDigest",
      "durableGenerationRevisionDigest",
      "decisionBoundaryAt",
      "sourceEpochs",
      "aliasMapDigest",
      "aliasEvidenceDigest",
      "collectorPinsDigest",
      "issuedAt",
      "expiresAt",
      "receiptNonceDigest",
      "authorityKeyIdDigest",
      "receiptMac",
    ],
    "SOURCE_AUTHORITY_RECEIPT_SHAPE_INVALID",
    "generation authority receipt",
  );
  invariant(
    raw.version === SOURCE_WATERMARK_AUTHORITY_RECEIPT_VERSION
      && raw.policyVersion === SOURCE_WATERMARK_POLICY_VERSION
      && raw.kind
        === AUTHORITY_RECEIPT_KINDS.GENERATION_CURRENT,
    "SOURCE_AUTHORITY_RECEIPT_VERSION_INVALID",
    "generation authority receipt version is invalid",
  );
  exactKeys(
    raw.sourceEpochs,
    ["recall", "paraformHuman", "aliases"],
    "SOURCE_AUTHORITY_RECEIPT_SHAPE_INVALID",
    "generation authority sourceEpochs",
  );
  const times = authorityReceiptTimes(raw, {
    field: "generation authority receipt",
    maxLifetimeMs: GENERATION_RECEIPT_MAX_LIFETIME_MS,
  });
  const material = {
    version: raw.version,
    policyVersion: raw.policyVersion,
    kind: raw.kind,
    generationRecordDigest: digest(
      raw.generationRecordDigest,
      "generation authority generationRecordDigest",
    ),
    manifestDigest: digest(
      raw.manifestDigest,
      "generation authority manifestDigest",
    ),
    commitRevisionDigest: digest(
      raw.commitRevisionDigest,
      "generation authority commitRevisionDigest",
    ),
    durableGenerationRevisionDigest: digest(
      raw.durableGenerationRevisionDigest,
      "generation authority durableGenerationRevisionDigest",
    ),
    decisionBoundaryAt: canonicalTimestamp(
      raw.decisionBoundaryAt,
      "generation authority decisionBoundaryAt",
    ),
    sourceEpochs: {
      recall: digest(
        raw.sourceEpochs.recall,
        "generation authority Recall epoch",
      ),
      paraformHuman: digest(
        raw.sourceEpochs.paraformHuman,
        "generation authority Paraform-human epoch",
      ),
      aliases: digest(
        raw.sourceEpochs.aliases,
        "generation authority alias epoch",
      ),
    },
    aliasMapDigest: digest(
      raw.aliasMapDigest,
      "generation authority aliasMapDigest",
    ),
    aliasEvidenceDigest: digest(
      raw.aliasEvidenceDigest,
      "generation authority aliasEvidenceDigest",
    ),
    collectorPinsDigest: digest(
      raw.collectorPinsDigest,
      "generation authority collectorPinsDigest",
    ),
    issuedAt: times.issuedAt,
    expiresAt: times.expiresAt,
    receiptNonceDigest: digest(
      raw.receiptNonceDigest,
      "generation authority receiptNonceDigest",
    ),
    authorityKeyIdDigest: digest(
      raw.authorityKeyIdDigest,
      "generation authority authorityKeyIdDigest",
    ),
  };
  const receiptMac = verifyAuthorityMac(raw, material);
  invariant(
    material.generationRecordDigest === generation.recordDigest
      && material.manifestDigest === generation.manifestDigest
      && material.commitRevisionDigest
        === generation.commitRevisionDigest
      && material.decisionBoundaryAt
        === generation.decisionBoundaryAt
      && material.aliasMapDigest
        === generation.aliasMap.aliasMapDigest
      && material.aliasEvidenceDigest
        === generation.aliasEvidence.evidenceDigest
      && material.collectorPinsDigest === collectorPinsDigest()
      && currentEpochsMatch(generation, material.sourceEpochs),
    "SOURCE_AUTHORITY_GENERATION_MISMATCH",
    "authority receipt is not bound to this exact generation",
  );
  const captureCompletedAt = latestPassCompletedAt(
    generation.sources.recall.certificate,
    generation.sources.paraformHuman.certificate,
    generation.aliasMap,
  );
  invariant(
    times.issuedMs >= Date.parse(generation.decisionBoundaryAt)
      && times.issuedMs >= Date.parse(captureCompletedAt)
      && times.issuedMs >= Date.parse(generation.committedAt),
    "SOURCE_AUTHORITY_RECEIPT_PREDATES_GENERATION",
    "authority receipt predates generation evidence or commit",
  );
  const receipt = {
    ...material,
    receiptMac,
  };
  return deepFreeze({
    ...receipt,
    receiptDigest: semanticDigest(
      "phase4-source-generation-authority-receipt-v1",
      receipt,
    ),
  });
}

export function sourceWatermarkPublicStatus({
  generation = null,
} = {}) {
  // Operational readiness is deliberately not decidable from a caller-fed
  // generation or receipt. The KV authority module must atomically read the
  // current durable record before it can report current/ready. This pure
  // evidence module therefore remains dark for every caller-supplied value.
  if (!generation) return emptyPublicStatus();
  let normalized;
  try {
    normalized = validateSourceWatermarkGeneration(generation);
  } catch {
    return emptyPublicStatus("invalid");
  }
  const committed = normalized.status === "committed";
  const current = false;
  const sourceWatermarkComplete = false;
  const phase4Q37Ready = false;
  const status = !committed
    ? "not_committed"
    : !normalized.intrinsicSourceComplete
      ? "incomplete"
      : "store_required";
  return deepFreeze({
    policyVersion: SOURCE_WATERMARK_POLICY_VERSION,
    status,
    committed,
    current,
    decisionBoundaryAt: committed
      ? normalized.decisionBoundaryAt
      : null,
    manifestDigest: committed
      ? normalized.manifestDigest
      : null,
    sourceWatermarkComplete,
    phase4Q37Ready,
    sources: {
      recall: publicSourceStatus(
        normalized.sources.recall.certificate,
      ),
      paraformHuman: publicSourceStatus(
        normalized.sources.paraformHuman.certificate,
      ),
    },
    aliases: {
      complete: normalized.aliasMap.complete,
      authoritative: normalized.aliasMap.authoritative,
      snapshotComplete: normalized.aliasMap.snapshotComplete,
      epochStable: normalized.aliasMap.epochStable,
      sourceProven: normalized.aliasEvidence.sourceProven,
      canonicalCandidateCount:
        normalized.aliasMap.canonicalCandidateCount,
      candidateUserAliasCount:
        normalized.aliasMap.candidateUserAliasCount,
      duplicateEntryCount:
        normalized.aliasMap.duplicateEntryCount,
      conflictCount: normalized.aliasMap.conflictCount,
      identityBindingProvenCount:
        normalized.aliasMap.identityBindingProvenCount,
      identityBindingUnprovenCount:
        normalized.aliasMap.identityBindingUnprovenCount,
    },
    q37: {
      candidateCount: normalized.q37.candidateCount,
      selectedCount: normalized.q37.selectedCount,
      agentCount: normalized.q37.agentCount,
      humanCount: normalized.q37.humanCount,
      noneCount: normalized.q37.noneCount,
      reviewCount: normalized.q37.reviewCount,
      identityIssueCount: normalized.q37.identityIssueCount,
    },
  });
}

function committedReadyGeneration(generation) {
  const normalized = validateSourceWatermarkGeneration(generation);
  invariant(
    normalized.status === "committed"
      && normalized.intrinsicQ37Ready,
    "SOURCE_WATERMARK_NOT_COMMITTED_READY",
    "a committed ready source generation is required",
  );
  return normalized;
}

function authorizedReadyGeneration(
  generation,
  authorityReceipt,
) {
  const normalized = committedReadyGeneration(generation);
  return {
    generation: normalized,
    authorityReceipt: generationAuthorityReceipt(
      normalized,
      authorityReceipt,
    ),
  };
}

function candidateDecision(generation, canonicalCandidateDigest) {
  return generation.q37.decisions.find(
    (row) => (
      row.canonicalCandidateDigest
        === canonicalCandidateDigest
    ),
  ) || null;
}

function phase4WriteAttestationMaterial({
  generation: normalized,
  authorityReceipt,
  canonicalCandidateDigest,
  candidateUserAliasDigest,
  jobRevisionDigest,
  writeScopeDigest,
  observedAt,
}) {
  const candidate = digest(
    canonicalCandidateDigest,
    "canonicalCandidateDigest",
  );
  const candidateUser = digest(
    candidateUserAliasDigest,
    "candidateUserAliasDigest",
  );
  const jobRevision = digest(
    jobRevisionDigest,
    "jobRevisionDigest",
  );
  const writeScope = digest(
    writeScopeDigest,
    "writeScopeDigest",
  );
  const at = canonicalTimestamp(observedAt, "observedAt");
  invariant(
    Date.parse(at) >= Date.parse(normalized.committedAt),
    "SOURCE_ATTESTATION_PREDATES_COMMIT",
    "write attestation cannot predate generation commit",
  );
  const aliasBound = normalized.aliasMap.entries.some((entry) => (
    entry.canonicalCandidateDigest === candidate
    && entry.candidateUserAliasDigest === candidateUser
  ));
  invariant(
    aliasBound,
    "SOURCE_ATTESTATION_ALIAS_MISMATCH",
    "write attestation identity is not in the canonical alias map",
  );
  const decision = candidateDecision(normalized, candidate);
  invariant(
    decision?.decision === "selected"
      && ["agent", "human"].includes(decision.callType),
    "SOURCE_ATTESTATION_Q37_NOT_SELECTED",
    "write attestation requires a non-ambiguous successful-call decision",
  );
  const material = {
    version: PHASE4_WRITE_ATTESTATION_VERSION,
    policyVersion: SOURCE_WATERMARK_POLICY_VERSION,
    manifestDigest: normalized.manifestDigest,
    commitRevisionDigest: normalized.commitRevisionDigest,
    durableGenerationRevisionDigest:
      authorityReceipt.durableGenerationRevisionDigest,
    generationAuthorityReceiptDigest:
      authorityReceipt.receiptDigest,
    decisionBoundaryAt: normalized.decisionBoundaryAt,
    canonicalCandidateDigest: candidate,
    candidateUserAliasDigest: candidateUser,
    q37DecisionDigest: decision.decisionDigest,
    callType: decision.callType,
    callEndedAt: decision.endedAt,
    jobRevisionDigest: jobRevision,
    writeScopeDigest: writeScope,
    sourceEpochs: {
      recall:
        normalized.sources.recall.certificate.sourceEpochDigest,
      paraformHuman:
        normalized.sources.paraformHuman
          .certificate.sourceEpochDigest,
      aliases: normalized.aliasMap.aliasEpochDigest,
    },
    observedAt: at,
  };
  return deepFreeze({
    ...material,
    attestationDigest: semanticDigest(
      "phase4-source-write-attestation-v1",
      material,
    ),
  });
}

export function buildPhase4WriteBoundaryAttestation() {
  throw new SourceWatermarkInvariantError(
    "SOURCE_AUTHORITY_STORE_REQUIRED",
    "write evidence must be reserved by the current KV authority store",
  );
}

function canonicalWriteAttestation(
  generation,
  authorityReceipt,
  value,
) {
  const raw = object(value, "write attestation");
  exactKeys(
    raw,
    [
      "version",
      "policyVersion",
      "manifestDigest",
      "commitRevisionDigest",
      "durableGenerationRevisionDigest",
      "generationAuthorityReceiptDigest",
      "decisionBoundaryAt",
      "canonicalCandidateDigest",
      "candidateUserAliasDigest",
      "q37DecisionDigest",
      "callType",
      "callEndedAt",
      "jobRevisionDigest",
      "writeScopeDigest",
      "sourceEpochs",
      "observedAt",
      "attestationDigest",
    ],
    "SOURCE_WRITE_ATTESTATION_TAMPERED",
    "write attestation",
  );
  const observedAt = canonicalTimestamp(
    raw.observedAt,
    "write attestation observedAt",
  );
  const observedMs = Date.parse(observedAt);
  const nowMs = Date.now();
  invariant(
    observedMs >= Date.parse(authorityReceipt.issuedAt)
      && observedMs <= nowMs + AUTHORITY_CLOCK_SKEW_MS
      && nowMs - observedMs
        <= WRITE_RECEIPT_MAX_LIFETIME_MS
          + AUTHORITY_CLOCK_SKEW_MS,
    "SOURCE_WRITE_ATTESTATION_STALE",
    "write attestation is stale or from the future",
  );
  const rebuilt = phase4WriteAttestationMaterial({
    generation,
    authorityReceipt,
    canonicalCandidateDigest:
      raw.canonicalCandidateDigest,
    candidateUserAliasDigest:
      raw.candidateUserAliasDigest,
    jobRevisionDigest: raw.jobRevisionDigest,
    writeScopeDigest: raw.writeScopeDigest,
    observedAt,
  });
  invariant(
    canonicalJson(raw) === canonicalJson(rebuilt),
    "SOURCE_WRITE_ATTESTATION_TAMPERED",
    "write attestation does not match its authoritative evidence",
  );
  return rebuilt;
}

function writeCasAuthorityReceipt({
  generation,
  generationAuthority,
  attestation,
  value,
}) {
  const raw = object(value, "write CAS authority receipt");
  exactKeys(
    raw,
    [
      "version",
      "policyVersion",
      "kind",
      "generationRecordDigest",
      "manifestDigest",
      "commitRevisionDigest",
      "durableGenerationRevisionDigest",
      "generationAuthorityReceiptDigest",
      "sourceEpochs",
      "attestationDigest",
      "canonicalCandidateDigest",
      "candidateUserAliasDigest",
      "jobRevisionDigest",
      "writeScopeDigest",
      "reservedJobRevisionDigest",
      "reservationNonceDigest",
      "issuedAt",
      "expiresAt",
      "authorityKeyIdDigest",
      "receiptMac",
    ],
    "SOURCE_WRITE_AUTHORITY_RECEIPT_SHAPE_INVALID",
    "write CAS authority receipt",
  );
  invariant(
    raw.version === SOURCE_WATERMARK_AUTHORITY_RECEIPT_VERSION
      && raw.policyVersion === SOURCE_WATERMARK_POLICY_VERSION
      && raw.kind
        === AUTHORITY_RECEIPT_KINDS.WRITE_CAS_RESERVED,
    "SOURCE_WRITE_AUTHORITY_RECEIPT_VERSION_INVALID",
    "write CAS authority receipt version is invalid",
  );
  exactKeys(
    raw.sourceEpochs,
    ["recall", "paraformHuman", "aliases"],
    "SOURCE_WRITE_AUTHORITY_RECEIPT_SHAPE_INVALID",
    "write CAS authority sourceEpochs",
  );
  const times = authorityReceiptTimes(raw, {
    field: "write CAS authority receipt",
    maxLifetimeMs: WRITE_RECEIPT_MAX_LIFETIME_MS,
  });
  const material = {
    version: raw.version,
    policyVersion: raw.policyVersion,
    kind: raw.kind,
    generationRecordDigest: digest(
      raw.generationRecordDigest,
      "write authority generationRecordDigest",
    ),
    manifestDigest: digest(
      raw.manifestDigest,
      "write authority manifestDigest",
    ),
    commitRevisionDigest: digest(
      raw.commitRevisionDigest,
      "write authority commitRevisionDigest",
    ),
    durableGenerationRevisionDigest: digest(
      raw.durableGenerationRevisionDigest,
      "write authority durableGenerationRevisionDigest",
    ),
    generationAuthorityReceiptDigest: digest(
      raw.generationAuthorityReceiptDigest,
      "write authority generationAuthorityReceiptDigest",
    ),
    sourceEpochs: {
      recall: digest(
        raw.sourceEpochs.recall,
        "write authority Recall epoch",
      ),
      paraformHuman: digest(
        raw.sourceEpochs.paraformHuman,
        "write authority Paraform-human epoch",
      ),
      aliases: digest(
        raw.sourceEpochs.aliases,
        "write authority alias epoch",
      ),
    },
    attestationDigest: digest(
      raw.attestationDigest,
      "write authority attestationDigest",
    ),
    canonicalCandidateDigest: digest(
      raw.canonicalCandidateDigest,
      "write authority canonicalCandidateDigest",
    ),
    candidateUserAliasDigest: digest(
      raw.candidateUserAliasDigest,
      "write authority candidateUserAliasDigest",
    ),
    jobRevisionDigest: digest(
      raw.jobRevisionDigest,
      "write authority jobRevisionDigest",
    ),
    writeScopeDigest: digest(
      raw.writeScopeDigest,
      "write authority writeScopeDigest",
    ),
    reservedJobRevisionDigest: digest(
      raw.reservedJobRevisionDigest,
      "write authority reservedJobRevisionDigest",
    ),
    reservationNonceDigest: digest(
      raw.reservationNonceDigest,
      "write authority reservationNonceDigest",
    ),
    issuedAt: times.issuedAt,
    expiresAt: times.expiresAt,
    authorityKeyIdDigest: digest(
      raw.authorityKeyIdDigest,
      "write authority authorityKeyIdDigest",
    ),
  };
  const receiptMac = verifyAuthorityMac(raw, material);
  invariant(
    material.reservedJobRevisionDigest
      !== material.jobRevisionDigest,
    "SOURCE_WRITE_CAS_REVISION_INVALID",
    "write reservation must advance the durable job revision",
  );
  invariant(
    times.issuedMs >= Date.parse(attestation.observedAt)
      && times.expiresMs
        <= Date.parse(generationAuthority.expiresAt),
    "SOURCE_WRITE_AUTHORITY_TIME_MISMATCH",
    "write reservation is outside its generation authority window",
  );
  invariant(
    material.generationRecordDigest === generation.recordDigest
      && material.manifestDigest === generation.manifestDigest
      && material.commitRevisionDigest
        === generation.commitRevisionDigest
      && material.durableGenerationRevisionDigest
        === generationAuthority.durableGenerationRevisionDigest
      && material.generationAuthorityReceiptDigest
        === generationAuthority.receiptDigest
      && currentEpochsMatch(generation, material.sourceEpochs)
      && material.attestationDigest
        === attestation.attestationDigest
      && material.canonicalCandidateDigest
        === attestation.canonicalCandidateDigest
      && material.candidateUserAliasDigest
        === attestation.candidateUserAliasDigest
      && material.jobRevisionDigest
        === attestation.jobRevisionDigest
      && material.writeScopeDigest
        === attestation.writeScopeDigest,
    "SOURCE_WRITE_AUTHORITY_MISMATCH",
    "write reservation is not bound to the exact current write",
  );
  const receipt = { ...material, receiptMac };
  return deepFreeze({
    ...receipt,
    receiptDigest: semanticDigest(
      "phase4-source-write-cas-authority-receipt-v1",
      receipt,
    ),
  });
}

export function validatePhase4WriteBoundaryAttestation() {
  throw new SourceWatermarkInvariantError(
    "SOURCE_AUTHORITY_STORE_REQUIRED",
    "write authorization must be consumed by the current KV authority store",
  );
}
