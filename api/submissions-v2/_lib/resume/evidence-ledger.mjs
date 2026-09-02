import {
  ResumeContractError,
  canonicalJson,
  deepFreeze,
  normalizeEvidenceText,
  sha256,
} from "./source-bundle.mjs";

export const CANDIDATE_SOURCE_TRUST = Object.freeze({
  candidate_original_resume: 500,
  candidate_call: 400,
  candidate_linkedin: 300,
  recruiter_supplements: 200,
});

export const CLAIM_RELATIONSHIPS = Object.freeze([
  "corroborating",
  "complementary",
  "time_reconcilable",
  "conflicting",
]);

const ORIENTATION_ONLY_SOURCE_KEYS = new Set(["role_record", "role_context", "company_context", "role_intake"]);

function requiredText(value, field, limit = 2_000) {
  const result = normalizeEvidenceText(value).slice(0, limit);
  if (!result) throw new ResumeContractError("CLAIM_FIELD_REQUIRED", `${field} is required`, { field });
  return result;
}

function optionalText(value, limit = 2_000) {
  return normalizeEvidenceText(value).slice(0, limit) || null;
}

function normalizedClaimValue(value) {
  return normalizeEvidenceText(value).toLocaleLowerCase("en-US");
}

function isoOrNull(value, field) {
  if (value == null || value === "") return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new ResumeContractError("CLAIM_DATE_INVALID", `${field} must be an ISO date`, { field });
  }
  return date.toISOString();
}

function evidenceIdFor(value) {
  return `ev_${sha256(canonicalJson(value)).slice(0, 24)}`;
}

function claimIdFor(value) {
  return `cl_${sha256(canonicalJson(value)).slice(0, 24)}`;
}

function relationshipFor(left, right) {
  if (left.normalizedValue === right.normalizedValue) return "corroborating";
  if (left.effectiveAt && right.effectiveAt && left.effectiveAt !== right.effectiveAt) {
    return "time_reconcilable";
  }
  if (["identity", "employer", "title", "dates", "location", "education", "credential"].includes(left.claimType)) {
    return "conflicting";
  }
  if (left.normalizedValue.includes(right.normalizedValue)
    || right.normalizedValue.includes(left.normalizedValue)) {
    return "complementary";
  }
  return "conflicting";
}

function assertQuote(source, quote, sourceKey) {
  const normalizedQuote = normalizeEvidenceText(quote);
  if (!normalizedQuote) {
    throw new ResumeContractError("EVIDENCE_QUOTE_REQUIRED", "Every claim requires exact source wording", { sourceKey });
  }
  if (!source.normalizedText.includes(normalizedQuote)) {
    throw new ResumeContractError(
      "EVIDENCE_QUOTE_NOT_FOUND",
      "The exact evidence quote is not present in the normalized source",
      { sourceKey, quoteSha256: sha256(normalizedQuote) },
    );
  }
  return normalizedQuote;
}

function normalizeExtractedClaim(raw, sourceMap) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ResumeContractError("EXTRACTED_CLAIM_INVALID", "Each extracted claim must be an object");
  }
  const sourceKey = requiredText(raw.sourceKey, "claim.sourceKey", 120);
  const source = sourceMap.get(sourceKey);
  if (!source) {
    throw new ResumeContractError("CLAIM_SOURCE_UNKNOWN", `Claim references unknown source: ${sourceKey}`, { sourceKey });
  }
  if (source.scope !== "candidate" || ORIENTATION_ONLY_SOURCE_KEYS.has(sourceKey)) {
    throw new ResumeContractError(
      "CLIENT_CONTEXT_CANNOT_PROVE_CLAIM",
      "Client-side role or intake context cannot validate a candidate claim",
      { sourceKey },
    );
  }
  if (!CANDIDATE_SOURCE_TRUST[sourceKey]) {
    throw new ResumeContractError("CLAIM_SOURCE_NOT_TRUSTED", `Source cannot prove candidate facts: ${sourceKey}`, { sourceKey });
  }
  if (!['present', 'partial', 'stale'].includes(source.status)) {
    throw new ResumeContractError(
      "CLAIM_SOURCE_UNAVAILABLE",
      `Claim source has no usable evidence content: ${sourceKey}`,
      { sourceKey, status: source.status },
    );
  }
  const claimType = requiredText(raw.claimType, "claim.claimType", 120);
  const subject = requiredText(raw.subject, "claim.subject", 500);
  const value = requiredText(raw.value, "claim.value", 4_000);
  const quote = assertQuote(source, raw.quote, sourceKey);
  const locator = requiredText(raw.locator ?? source.locator, "claim.locator", 2_000);
  const normalized = {
    claimType,
    subject,
    normalizedSubject: normalizedClaimValue(subject),
    value,
    normalizedValue: normalizedClaimValue(value),
    sourceKey,
    sourceType: source.sourceType,
    sourceId: optionalText(raw.sourceId ?? source.sourceId, 500),
    sourceDigest: source.normalizedTextSha256,
    quote,
    quoteSha256: sha256(quote),
    locator,
    effectiveAt: isoOrNull(raw.effectiveAt, "claim.effectiveAt"),
    sourceUpdatedAt: source.sourceUpdatedAt,
    trustRank: CANDIDATE_SOURCE_TRUST[sourceKey],
  };
  const evidenceId = evidenceIdFor(normalized);
  return {
    ...normalized,
    evidenceId,
    claimId: optionalText(raw.claimId, 200) || claimIdFor({
      claimType,
      subject: normalized.normalizedSubject,
      value: normalized.normalizedValue,
      evidenceId,
    }),
  };
}

function buildClusters(claims) {
  const bySubject = new Map();
  for (const claim of claims) {
    const key = `${claim.claimType}\0${claim.normalizedSubject}`;
    if (!bySubject.has(key)) bySubject.set(key, []);
    bySubject.get(key).push(claim);
  }
  return [...bySubject.entries()].map(([subjectKey, entries]) => {
    const relationships = [];
    for (let left = 0; left < entries.length; left += 1) {
      for (let right = left + 1; right < entries.length; right += 1) {
        relationships.push({
          leftClaimId: entries[left].claimId,
          rightClaimId: entries[right].claimId,
          relationship: relationshipFor(entries[left], entries[right]),
        });
      }
    }
    const conflict = relationships.some((item) => item.relationship === "conflicting");
    const selected = [...entries].sort((left, right) => {
      if (right.trustRank !== left.trustRank) return right.trustRank - left.trustRank;
      const rightTime = Date.parse(right.sourceUpdatedAt || right.effectiveAt || 0) || 0;
      const leftTime = Date.parse(left.sourceUpdatedAt || left.effectiveAt || 0) || 0;
      if (rightTime !== leftTime) return rightTime - leftTime;
      return left.claimId.localeCompare(right.claimId);
    })[0];
    return {
      clusterId: `cluster_${sha256(subjectKey).slice(0, 20)}`,
      claimType: selected.claimType,
      subject: selected.subject,
      claimIds: entries.map((item) => item.claimId).sort(),
      relationships,
      hasConflict: conflict,
      selectedClaimId: selected.claimId,
      selectionReason: conflict
        ? "highest_applicable_trusted_source"
        : "best_available_candidate_evidence",
    };
  }).sort((left, right) => left.clusterId.localeCompare(right.clusterId));
}

export function buildEvidenceLedger(bundle, extractedClaims) {
  if (!bundle || bundle.schemaVersion !== "raydar.submissions-v2.source-bundle.v1") {
    throw new ResumeContractError("SOURCE_BUNDLE_INVALID", "A normalized V2 source bundle is required");
  }
  if (!Array.isArray(extractedClaims)) {
    throw new ResumeContractError("EXTRACTED_CLAIMS_REQUIRED", "extractedClaims must be an array");
  }
  const sourceMap = new Map(bundle.sources.map((source) => [source.key, source]));
  const claims = extractedClaims.map((claim) => normalizeExtractedClaim(claim, sourceMap));
  const ids = new Set();
  for (const claim of claims) {
    if (ids.has(claim.claimId)) {
      throw new ResumeContractError("CLAIM_ID_DUPLICATE", `Duplicate claim id: ${claim.claimId}`, { claimId: claim.claimId });
    }
    ids.add(claim.claimId);
  }
  const clusters = buildClusters(claims);
  const ledgerDigest = sha256(canonicalJson({ sourceDigest: bundle.sourceDigest, claims, clusters }));
  return deepFreeze({
    schemaVersion: "raydar.submissions-v2.evidence-ledger.v1",
    sourceDigest: bundle.sourceDigest,
    ledgerDigest,
    pair: bundle.pair,
    claims: claims.sort((left, right) => left.claimId.localeCompare(right.claimId)),
    clusters,
  });
}

export function assertDraftClaimsGrounded(draftClaims, ledger) {
  if (!ledger || ledger.schemaVersion !== "raydar.submissions-v2.evidence-ledger.v1") {
    throw new ResumeContractError("EVIDENCE_LEDGER_INVALID", "A V2 evidence ledger is required");
  }
  if (!Array.isArray(draftClaims) || !draftClaims.length) {
    throw new ResumeContractError("DRAFT_CLAIMS_REQUIRED", "At least one draft claim is required");
  }
  const evidenceById = new Map(ledger.claims.map((claim) => [claim.evidenceId, claim]));
  const draftIds = new Set();
  const normalized = draftClaims.map((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new ResumeContractError("DRAFT_CLAIM_INVALID", "Each draft claim must be an object");
    }
    const id = requiredText(raw.id, "draftClaim.id", 200);
    if (draftIds.has(id)) throw new ResumeContractError("DRAFT_CLAIM_ID_DUPLICATE", `Duplicate draft claim id: ${id}`, { id });
    draftIds.add(id);
    const text = requiredText(raw.text, "draftClaim.text", 4_000);
    if (!Array.isArray(raw.evidenceIds) || !raw.evidenceIds.length) {
      throw new ResumeContractError("DRAFT_CLAIM_UNGROUNDED", `Draft claim has no evidence: ${id}`, { id });
    }
    const evidenceIds = [...new Set(raw.evidenceIds.map((value) => requiredText(value, `${id}.evidenceId`, 200)))];
    for (const evidenceId of evidenceIds) {
      if (!evidenceById.has(evidenceId)) {
        throw new ResumeContractError(
          "DRAFT_EVIDENCE_UNKNOWN",
          `Draft claim references unknown evidence: ${evidenceId}`,
          { id, evidenceId },
        );
      }
    }
    return { id, text, evidenceIds };
  });
  return deepFreeze(normalized);
}

export function evidenceForValidator(draftClaims, ledger) {
  const grounded = assertDraftClaimsGrounded(draftClaims, ledger);
  const evidenceById = new Map(ledger.claims.map((claim) => [claim.evidenceId, claim]));
  return deepFreeze(grounded.map((claim) => ({
    id: claim.id,
    text: claim.text,
    evidence: claim.evidenceIds.map((evidenceId) => {
      const item = evidenceById.get(evidenceId);
      return {
        evidenceId,
        sourceKey: item.sourceKey,
        sourceId: item.sourceId,
        locator: item.locator,
        exactQuote: item.quote,
        trustRank: item.trustRank,
      };
    }),
  })));
}
