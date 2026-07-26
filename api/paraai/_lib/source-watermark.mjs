// Pure Phase 4 upstream-source barrier.
//
// This module has no environment, vendor, queue, or store dependency. It
// validates normalized Recall and Paraform-human snapshots, binds them to one
// immutable decision boundary, resolves only digest-based one-to-one aliases,
// applies Q37, and validates a store-owned write-boundary attestation.
//
// Raw source IDs, candidate IDs, candidate-user IDs, names, emails, links, and
// response bodies do not belong in this contract. Identifier-shaped inputs are
// domain-separated lowercase SHA-256 digests only.

import { createHash } from "node:crypto";

export const SOURCE_WATERMARK_POLICY_VERSION =
  "phase4-source-watermark-v1";
export const SOURCE_WATERMARK_CERTIFICATE_VERSION = 1;
export const SOURCE_WATERMARK_GENERATION_VERSION = 1;
export const PHASE4_WRITE_ATTESTATION_VERSION = 1;

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
const COLLECTOR_VERSION = /^[a-z0-9][a-z0-9._-]{0,79}$/u;
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

function optionalDigest(value, field) {
  if (value == null) return null;
  return digest(value, field);
}

function sourceName(value, field = "source") {
  if (!SOURCE_SET.has(value)) {
    throw new TypeError(`${field} must be a supported source`);
  }
  return value;
}

function collectorVersion(value) {
  if (
    typeof value !== "string"
    || !COLLECTOR_VERSION.test(value)
  ) {
    throw new TypeError(
      "collectorVersion must be a bounded lowercase version token",
    );
  }
  return value;
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
  const recordDigest = digest(
    fact.recordDigest,
    `${source} facts[${index}].recordDigest`,
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
      && fact.provenanceVerified !== true
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
  facts = [],
  passes = [],
} = {}) {
  const normalizedSource = sourceName(source);
  const boundary = canonicalTimestamp(
    decisionBoundaryAt,
    "decisionBoundaryAt",
  );
  const normalizedCollectorVersion =
    collectorVersion(rawCollectorVersion);
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
    collectorVersion: normalizedCollectorVersion,
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

function aliasEntry(raw, index) {
  const entry = object(raw, `alias entries[${index}]`);
  const canonicalCandidateDigest = digest(
    entry.canonicalCandidateDigest,
    `alias entries[${index}].canonicalCandidateDigest`,
  );
  const candidateUserAliasDigest = digest(
    entry.candidateUserAliasDigest,
    `alias entries[${index}].candidateUserAliasDigest`,
  );
  if (canonicalCandidateDigest === candidateUserAliasDigest) {
    throw new TypeError(
      "canonical and candidate-user alias digests must be domain-separated",
    );
  }
  return {
    canonicalCandidateDigest,
    candidateUserAliasDigest,
  };
}

export function buildCanonicalSourceAliasMap(
  entries = [],
  {
    authoritative = false,
    snapshotComplete = false,
    epochAtStart = null,
    epochAtEnd = null,
  } = {},
) {
  const normalizedAuthoritative = strictBoolean(
    authoritative,
    "alias map authoritative",
  );
  const normalizedSnapshotComplete = strictBoolean(
    snapshotComplete,
    "alias map snapshotComplete",
  );
  const normalizedEpochAtStart = optionalDigest(
    epochAtStart,
    "alias map epochAtStart",
  );
  const normalizedEpochAtEnd = optionalDigest(
    epochAtEnd,
    "alias map epochAtEnd",
  );
  const epochStable = Boolean(
    normalizedEpochAtStart
    && normalizedEpochAtEnd
    && normalizedEpochAtStart === normalizedEpochAtEnd
  );
  const normalized = array(entries, "alias entries")
    .map(aliasEntry)
    .sort((left, right) => (
      left.canonicalCandidateDigest.localeCompare(
        right.canonicalCandidateDigest,
      )
      || left.candidateUserAliasDigest.localeCompare(
        right.candidateUserAliasDigest,
      )
    ));
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
  const complete =
    normalizedAuthoritative
    && normalizedSnapshotComplete
    && epochStable
    && duplicateEntryCount === 0
    && conflictCount === 0;
  const material = {
    version: 1,
    mapping: "candidate_user_to_canonical_candidate_bijection",
    authoritative: normalizedAuthoritative,
    snapshotComplete: normalizedSnapshotComplete,
    epochStable,
    epochAtStart: normalizedEpochAtStart,
    epochAtEnd: normalizedEpochAtEnd,
    aliasEpochDigest: epochStable
      ? normalizedEpochAtStart
      : null,
    entries: deduped,
    canonicalCandidateCount: aliasesByCanonical.size,
    candidateUserAliasCount: canonicalsByAlias.size,
    duplicateEntryCount,
    canonicalConflictCount,
    aliasConflictCount,
    conflictCount,
    complete,
  };
  return deepFreeze({
    ...material,
    aliasMapDigest: semanticDigest(
      "phase4-source-alias-map-v1",
      material,
    ),
  });
}

function canonicalAliasMap(value) {
  const raw = object(value, "aliasMap");
  const rebuilt = buildCanonicalSourceAliasMap(raw.entries, {
    authoritative: raw.authoritative,
    snapshotComplete: raw.snapshotComplete,
    epochAtStart: raw.epochAtStart,
    epochAtEnd: raw.epochAtEnd,
  });
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
      && fact.provenanceVerified !== true
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
  if (!aliasMap.complete) {
    return { candidateByAlias, knownCandidates };
  }
  for (const entry of aliasMap.entries) {
    candidateByAlias.set(
      entry.candidateUserAliasDigest,
      entry.canonicalCandidateDigest,
    );
    knownCandidates.add(entry.canonicalCandidateDigest);
  }
  return { candidateByAlias, knownCandidates };
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
    if (fact.classification !== "success") continue;
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

  const decisions = [...factsByCandidate.entries()]
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
  };
  return deepFreeze({
    ...material,
    decisionSetDigest: semanticDigest(
      "phase4-q37-decision-set-v1",
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
  const q37 = generationQ37({
    recallFacts: recallBundle.facts,
    paraformFacts: paraformBundle.facts,
    aliasMap: normalizedAliasMap,
  });
  const intrinsicSourceComplete = Boolean(
    recallBundle.certificate.complete
    && paraformBundle.certificate.complete
    && normalizedAliasMap.complete
    && q37.identityIssueCount === 0
  );
  const intrinsicQ37Ready = Boolean(
    intrinsicSourceComplete
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
      canonicalCandidateCount: 0,
      candidateUserAliasCount: 0,
      duplicateEntryCount: 0,
      conflictCount: 0,
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

export function sourceWatermarkPublicStatus({
  generation = null,
  currentManifestDigest = null,
  currentSourceEpochs = null,
} = {}) {
  // A future runtime must supply only durable server-owned state here. This
  // projection validates and redacts that state; it is not a request-body
  // authorization mechanism.
  if (!generation) return emptyPublicStatus();
  let normalized;
  try {
    normalized = validateSourceWatermarkGeneration(generation);
  } catch {
    return emptyPublicStatus("invalid");
  }
  const committed = normalized.status === "committed";
  let manifestCurrent = false;
  try {
    manifestCurrent = Boolean(
      committed
      && optionalDigest(
        currentManifestDigest,
        "currentManifestDigest",
      ) === normalized.manifestDigest
    );
  } catch {
    manifestCurrent = false;
  }
  const epochCurrent =
    committed
    && currentEpochsMatch(normalized, currentSourceEpochs);
  const current = manifestCurrent && epochCurrent;
  const sourceWatermarkComplete = Boolean(
    committed
    && current
    && normalized.intrinsicSourceComplete
  );
  const phase4Q37Ready = Boolean(
    sourceWatermarkComplete
    && normalized.intrinsicQ37Ready
  );
  const status = !committed
    ? "not_committed"
    : !normalized.intrinsicSourceComplete
      ? "incomplete"
      : !current
        ? "stale"
        : phase4Q37Ready
          ? "ready"
          : "review";
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
      canonicalCandidateCount:
        normalized.aliasMap.canonicalCandidateCount,
      candidateUserAliasCount:
        normalized.aliasMap.candidateUserAliasCount,
      duplicateEntryCount:
        normalized.aliasMap.duplicateEntryCount,
      conflictCount: normalized.aliasMap.conflictCount,
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

function candidateDecision(generation, canonicalCandidateDigest) {
  return generation.q37.decisions.find(
    (row) => (
      row.canonicalCandidateDigest
        === canonicalCandidateDigest
    ),
  ) || null;
}

export function buildPhase4WriteBoundaryAttestation({
  generation,
  canonicalCandidateDigest,
  candidateUserAliasDigest,
  jobRevisionDigest,
  writeScopeDigest,
  observedAt,
} = {}) {
  const normalized = committedReadyGeneration(generation);
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

export function validatePhase4WriteBoundaryAttestation({
  generation,
  attestation,
  currentManifestDigest,
  currentSourceEpochs,
  expectedCanonicalCandidateDigest,
  expectedCandidateUserAliasDigest,
  expectedJobRevisionDigest,
  expectedWriteScopeDigest,
  observedAt,
} = {}) {
  // The generation, attestation, current manifest/epochs, and expected write
  // digests must all be read or derived inside one server-owned atomic write
  // boundary. These SHA-256 bindings detect substitution; they are not a MAC
  // and must never grant authority to caller-supplied values.
  const normalized = committedReadyGeneration(generation);
  const currentManifest = digest(
    currentManifestDigest,
    "currentManifestDigest",
  );
  invariant(
    currentManifest === normalized.manifestDigest,
    "SOURCE_WRITE_GENERATION_STALE",
    "current generation manifest does not match the attestation generation",
  );
  invariant(
    currentEpochsMatch(normalized, currentSourceEpochs),
    "SOURCE_WRITE_EPOCH_STALE",
    "a source epoch changed after generation commit",
  );
  const raw = object(attestation, "write attestation");
  const rebuilt = buildPhase4WriteBoundaryAttestation({
    generation: normalized,
    canonicalCandidateDigest:
      raw.canonicalCandidateDigest,
    candidateUserAliasDigest:
      raw.candidateUserAliasDigest,
    jobRevisionDigest: raw.jobRevisionDigest,
    writeScopeDigest: raw.writeScopeDigest,
    observedAt: raw.observedAt,
  });
  for (const field of [
    "version",
    "policyVersion",
    "manifestDigest",
    "commitRevisionDigest",
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
  ]) {
    let matches = false;
    try {
      matches = canonicalJson(raw[field])
        === canonicalJson(rebuilt[field]);
    } catch {
      matches = false;
    }
    invariant(
      matches,
      "SOURCE_WRITE_ATTESTATION_TAMPERED",
      "write attestation fields do not match its evidence",
    );
  }
  invariant(
    raw.attestationDigest === rebuilt.attestationDigest,
    "SOURCE_WRITE_ATTESTATION_TAMPERED",
    "write attestation digest does not match its evidence",
  );
  invariant(
    raw.manifestDigest === normalized.manifestDigest
      && raw.commitRevisionDigest
        === normalized.commitRevisionDigest,
    "SOURCE_WRITE_ATTESTATION_GENERATION_MISMATCH",
    "write attestation is bound to another generation",
  );
  const expected = {
    canonicalCandidateDigest: digest(
      expectedCanonicalCandidateDigest,
      "expectedCanonicalCandidateDigest",
    ),
    candidateUserAliasDigest: digest(
      expectedCandidateUserAliasDigest,
      "expectedCandidateUserAliasDigest",
    ),
    jobRevisionDigest: digest(
      expectedJobRevisionDigest,
      "expectedJobRevisionDigest",
    ),
    writeScopeDigest: digest(
      expectedWriteScopeDigest,
      "expectedWriteScopeDigest",
    ),
  };
  for (const [field, value] of Object.entries(expected)) {
    invariant(
      rebuilt[field] === value,
      "SOURCE_WRITE_EXPECTATION_MISMATCH",
      "write attestation does not match the atomic write inputs",
    );
  }
  const currentObservedAt = canonicalTimestamp(
    observedAt,
    "observedAt",
  );
  invariant(
    Date.parse(currentObservedAt)
      >= Date.parse(rebuilt.observedAt),
    "SOURCE_WRITE_ATTESTATION_FROM_FUTURE",
    "write attestation observation is in the future",
  );
  return deepFreeze({
    allowed: true,
    policyVersion: SOURCE_WATERMARK_POLICY_VERSION,
    manifestDigest: normalized.manifestDigest,
    decisionBoundaryAt: normalized.decisionBoundaryAt,
    callType: rebuilt.callType,
    callEndedAt: rebuilt.callEndedAt,
    attestedAt: rebuilt.observedAt,
    validatedAt: currentObservedAt,
  });
}
