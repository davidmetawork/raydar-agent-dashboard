import {
  ResumeContractError,
  canonicalJson,
  deepFreeze,
  normalizeEvidenceText,
  sha256,
} from "../api/submissions-v2/_lib/resume/source-bundle.mjs";
import {
  GROUNDING_PROMPT_VERSION,
  GROUNDING_VALIDATOR_MODEL,
} from "../api/submissions-v2/_lib/models/openai-validator.mjs";
import {
  STRATEGIST_FALLBACK_MODEL,
  STRATEGIST_PRIMARY_MODEL,
  STRATEGIST_PROMPT_VERSION,
} from "../api/submissions-v2/_lib/models/anthropic-strategist.mjs";
import { collectContentNodes } from "./contract.mjs";

const PRIVATE_PREFIX = "submissions/resumes/v2/";

function requiredText(value, field, limit = 2_000) {
  const result = normalizeEvidenceText(value).slice(0, limit);
  if (!result) throw new ResumeContractError("ARTIFACT_MANIFEST_INVALID", `${field} is required`, { field });
  return result;
}

function iso(value, field) {
  const result = new Date(value);
  if (!Number.isFinite(result.getTime())) {
    throw new ResumeContractError("ARTIFACT_MANIFEST_INVALID", `${field} must be an ISO date`, { field });
  }
  return result.toISOString();
}

function privatePath(value, field) {
  const result = requiredText(value, field, 2_000);
  if (!result.startsWith(PRIVATE_PREFIX) || result.includes("..") || result.includes("\\")) {
    throw new ResumeContractError("ARTIFACT_PATH_INVALID", `${field} must use the private V2 prefix`, { field });
  }
  return result;
}

function validatedClaims(render, claims) {
  const byId = new Map((claims || []).map((claim) => [claim.id, claim]));
  if (byId.size !== claims?.length) {
    throw new ResumeContractError("ARTIFACT_VALIDATION_INVALID", "Validated claim ids must be unique");
  }
  const missing = collectContentNodes(render.ast).map((node) => node.id).filter((id) => !byId.has(id));
  if (missing.length) {
    throw new ResumeContractError("ARTIFACT_VALIDATION_INCOMPLETE", "Every retained resume claim must pass validation", { missing });
  }
  return collectContentNodes(render.ast).map((node) => {
    const packet = byId.get(node.id);
    if (normalizeEvidenceText(packet.text) !== node.text) {
      throw new ResumeContractError("ARTIFACT_VALIDATION_TEXT_MISMATCH", "Rendered claim differs from its validated wording", {
        id: node.id,
      });
    }
    const evidenceIds = [...new Set(
      packet.validatedEvidenceIds
      || packet.evidence?.map((item) => item.evidenceId)
      || [],
    )].sort();
    if (!evidenceIds.length) {
      throw new ResumeContractError("ARTIFACT_VALIDATION_EVIDENCE_MISSING", "Validated claim lacks candidate evidence", {
        id: node.id,
      });
    }
    return { id: node.id, textSha256: sha256(node.text), evidenceIds };
  });
}

function assertPins(strategyAudit, validatorHistory) {
  if (!strategyAudit || ![STRATEGIST_PRIMARY_MODEL, STRATEGIST_FALLBACK_MODEL].includes(strategyAudit.model)) {
    throw new ResumeContractError("ARTIFACT_MODEL_PIN_INVALID", "Artifact strategy must use an approved pinned model");
  }
  if (strategyAudit.promptVersion !== STRATEGIST_PROMPT_VERSION || strategyAudit.effort !== "high") {
    throw new ResumeContractError("ARTIFACT_MODEL_PIN_INVALID", "Artifact strategy prompt or effort pin is invalid");
  }
  const audits = (validatorHistory || []).map((entry) => entry.audit).filter(Boolean);
  if (!audits.length || audits.some((audit) => (
    audit.model !== GROUNDING_VALIDATOR_MODEL
    || audit.promptVersion !== GROUNDING_PROMPT_VERSION
    || audit.effort !== "high"
  ))) {
    throw new ResumeContractError("ARTIFACT_VALIDATOR_PIN_INVALID", "Artifact validation must use the pinned independent validator");
  }
}

export function createArtifactManifest({
  generationId,
  version,
  pair,
  sourceBundle,
  evidenceLedger,
  strategyAudit,
  validatorHistory,
  validatedClaimPackets,
  render,
  pdfVerification,
  artifactPaths,
  createdAt = new Date().toISOString(),
  practice = false,
}) {
  if (sourceBundle?.sourceDigest !== evidenceLedger?.sourceDigest) {
    throw new ResumeContractError("ARTIFACT_SOURCE_LEDGER_MISMATCH", "Source and evidence ledgers do not match");
  }
  if (render?.practice !== Boolean(practice)) {
    throw new ResumeContractError("ARTIFACT_PRACTICE_MISMATCH", "Practice disposition differs from render output");
  }
  assertPins(strategyAudit, validatorHistory);
  const claimValidation = validatedClaims(render, validatedClaimPackets);
  const numericVersion = Number(version);
  if (!Number.isInteger(numericVersion) || numericVersion < 1) {
    throw new ResumeContractError("ARTIFACT_MANIFEST_INVALID", "Artifact version must be a positive integer");
  }
  const paths = {
    pdf: privatePath(artifactPaths?.pdf, "artifactPaths.pdf"),
    ats: privatePath(artifactPaths?.ats, "artifactPaths.ats"),
    manifest: privatePath(artifactPaths?.manifest, "artifactPaths.manifest"),
  };
  if (new Set(Object.values(paths)).size !== 3) {
    throw new ResumeContractError("ARTIFACT_PATH_INVALID", "PDF, ATS, and manifest paths must be distinct");
  }
  const payload = {
    schemaVersion: "raydar.submissions-v2.resume-artifact-manifest.v1",
    generationId: requiredText(generationId, "generationId", 500),
    version: numericVersion,
    pair: {
      candidateUserId: requiredText(pair?.candidateUserId, "pair.candidateUserId", 500),
      roleId: requiredText(pair?.roleId, "pair.roleId", 500),
    },
    createdAt: iso(createdAt, "createdAt"),
    practice: Boolean(practice),
    promotionEligible: !practice,
    source: {
      schemaVersion: sourceBundle.schemaVersion,
      sourceDigest: sourceBundle.sourceDigest,
      capturedAt: sourceBundle.capturedAt,
      coverage: sourceBundle.sources.map((source) => ({
        key: source.key,
        status: source.status,
        requiredness: source.requiredness,
        origin: source.origin,
        sourceId: source.sourceId,
        locator: source.locator,
        contentSha256: source.contentSha256,
        normalizedTextSha256: source.normalizedTextSha256,
      })),
      cautions: sourceBundle.readiness.cautions,
    },
    evidence: {
      ledgerDigest: evidenceLedger.ledgerDigest,
      claims: evidenceLedger.claims.map((claim) => ({
        claimId: claim.claimId,
        evidenceId: claim.evidenceId,
        sourceKey: claim.sourceKey,
        sourceId: claim.sourceId,
        locator: claim.locator,
        exactQuote: claim.quote,
        quoteSha256: claim.quoteSha256,
        trustRank: claim.trustRank,
      })),
      clusters: evidenceLedger.clusters,
    },
    strategy: strategyAudit,
    validation: {
      validatorModel: GROUNDING_VALIDATOR_MODEL,
      promptVersion: GROUNDING_PROMPT_VERSION,
      history: validatorHistory,
      retainedClaims: claimValidation,
    },
    render: {
      templateVersion: render.templateVersion,
      rendererVersion: render.rendererVersion,
      astSha256: render.astSha256,
      htmlSha256: render.htmlSha256,
      brandAssetId: render.brandAssetId,
      brandAssetSha256: render.brandAssetSha256,
      plan: render.plan,
      preflight: pdfVerification.preflight,
    },
    artifacts: {
      paths,
      pdfSha256: pdfVerification.pdfSha256,
      pdfByteLength: pdfVerification.pdfByteLength,
      pdfTextSha256: pdfVerification.pdfTextSha256,
      atsSha256: render.atsSha256,
    },
  };
  const payloadJson = canonicalJson(payload);
  const envelope = {
    schemaVersion: "raydar.submissions-v2.resume-artifact-envelope.v1",
    payloadSha256: sha256(payloadJson),
    payload,
  };
  const manifestJson = canonicalJson(envelope);
  return deepFreeze({
    envelope,
    manifestJson,
    manifestSha256: sha256(manifestJson),
    promotionEligible: envelope.payload.promotionEligible,
  });
}

export function assertArtifactReadback({ expected, pdfBytes, atsBytes, manifestBytes }) {
  const actual = {
    pdfSha256: sha256(Buffer.from(pdfBytes || [])),
    atsSha256: sha256(Buffer.from(atsBytes || [])),
    manifestSha256: sha256(Buffer.from(manifestBytes || [])),
  };
  const wanted = {
    pdfSha256: expected?.envelope?.payload?.artifacts?.pdfSha256,
    atsSha256: expected?.envelope?.payload?.artifacts?.atsSha256,
    manifestSha256: expected?.manifestSha256,
  };
  if (actual.pdfSha256 !== wanted.pdfSha256
    || actual.atsSha256 !== wanted.atsSha256
    || actual.manifestSha256 !== wanted.manifestSha256) {
    throw new ResumeContractError("ARTIFACT_READBACK_MISMATCH", "Archived resume artifact digests do not match readback", {
      actual,
      expected: wanted,
    });
  }
  return true;
}
