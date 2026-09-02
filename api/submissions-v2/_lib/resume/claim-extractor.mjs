import {
  ResumeContractError,
  canonicalJson,
  deepFreeze,
  normalizeEvidenceText,
  sha256,
} from "./source-bundle.mjs";

const CANDIDATE_SOURCE_KEYS = new Set([
  "candidate_original_resume",
  "candidate_call",
  "candidate_linkedin",
  "recruiter_supplements",
]);
const USABLE_STATUSES = new Set(["present", "partial", "stale"]);
const DEFAULT_MAX_SOURCE_CHARACTERS = 250_000;
const DEFAULT_MAX_TOTAL_SPANS = 5_000;
const MAX_SPAN_CHARACTERS = 700;

function splitLongSpan(value) {
  if (value.length <= MAX_SPAN_CHARACTERS) return [value];
  const chunks = [];
  let remaining = value;
  while (remaining.length > MAX_SPAN_CHARACTERS) {
    let splitAt = MAX_SPAN_CHARACTERS;
    while (splitAt >= Math.floor(MAX_SPAN_CHARACTERS * 0.6) && !/\s/u.test(remaining[splitAt])) splitAt -= 1;
    if (splitAt < Math.floor(MAX_SPAN_CHARACTERS * 0.6)) splitAt = MAX_SPAN_CHARACTERS;
    chunks.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

function sourceSpans(source) {
  // Extracted PDFs often contain visual line breaks between individual words;
  // fixed bounded passages preserve the complete exact source while avoiding
  // hundreds of tiny claims and repeated JSON metadata in the model request.
  return splitLongSpan(source.normalizedText);
}

function claimTypeFor(value) {
  if (/\b(?:19|20)\d{2}\b/u.test(value) && value.length <= 120) return "dates_or_tenure";
  if (/\b(?:university|college|bachelor|master|ph\.?d|degree)\b/iu.test(value)) return "education";
  if (/\b\d+(?:\.\d+)?%|\$\d|\b\d+[x×]\b/iu.test(value)) return "measured_outcome";
  if (/\b(?:prefer|seeking|looking for|open to|compensation|salary|remote|hybrid|relocat)\b/iu.test(value)) {
    return "preference";
  }
  return "candidate_fact";
}

function extractedClaim(source, value, sourceIndex) {
  const locator = `${source.locator}#evidence-span-${sourceIndex + 1}`;
  const identity = {
    sourceKey: source.key,
    sourceId: source.sourceId,
    sourceDigest: source.normalizedTextSha256,
    locator,
    quote: value,
  };
  return {
    claimId: `xc_${sha256(canonicalJson(identity)).slice(0, 24)}`,
    claimType: claimTypeFor(value),
    subject: `${source.sourceType} evidence span ${sourceIndex + 1}`,
    value,
    sourceKey: source.key,
    sourceId: source.sourceId,
    quote: value,
    locator,
    effectiveAt: source.sourceUpdatedAt,
  };
}

export function extractCandidateEvidenceClaims(bundle, {
  maxSourceCharacters = DEFAULT_MAX_SOURCE_CHARACTERS,
  maxTotalSpans = DEFAULT_MAX_TOTAL_SPANS,
} = {}) {
  if (!bundle || bundle.schemaVersion !== "raydar.submissions-v2.source-bundle.v1") {
    throw new ResumeContractError("SOURCE_BUNDLE_INVALID", "A normalized V2 source bundle is required");
  }
  const sourceLimit = Math.max(10_000, Math.min(1_000_000, Number(maxSourceCharacters) || DEFAULT_MAX_SOURCE_CHARACTERS));
  const totalLimit = Math.max(100, Math.min(20_000, Number(maxTotalSpans) || DEFAULT_MAX_TOTAL_SPANS));
  const claims = [];
  for (const source of bundle.sources) {
    if (!CANDIDATE_SOURCE_KEYS.has(source.key) || !USABLE_STATUSES.has(source.status)) continue;
    if (source.normalizedText.length > sourceLimit) {
      throw new ResumeContractError("EVIDENCE_SOURCE_TOO_LARGE", "Candidate evidence source exceeds the bounded extraction limit", {
        sourceKey: source.key,
        characters: source.normalizedText.length,
        limit: sourceLimit,
      });
    }
    const spans = sourceSpans(source);
    if (claims.length + spans.length > totalLimit) {
      throw new ResumeContractError("EVIDENCE_SPAN_LIMIT_EXCEEDED", "Candidate evidence exceeds the bounded claim limit", {
        sourceKey: source.key,
        limit: totalLimit,
      });
    }
    spans.forEach((span, index) => claims.push(extractedClaim(source, span, index)));
  }
  if (!claims.length) {
    throw new ResumeContractError("CANDIDATE_EVIDENCE_EMPTY", "No candidate-side evidence spans were available for claim extraction");
  }
  return deepFreeze(claims);
}
