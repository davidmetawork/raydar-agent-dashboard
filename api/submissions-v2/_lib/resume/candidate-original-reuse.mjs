import { deepFreeze, normalizeEvidenceText, sha256 } from "./source-bundle.mjs";

export const CANDIDATE_ORIGINAL_EXTRACTION_SCHEMA = "raydar.submissions-v2.candidate-original-extraction.v1";
const clean = (value, limit = 2_000) => String(value ?? "").trim().slice(0, limit);
const validDigest = (value) => /^[a-f0-9]{64}$/u.test(String(value || "")) ? String(value) : null;

export function candidateOriginalExtractionIdentity({ candidateUserId, resumeId, locator, bytes }) {
  const candidateId = clean(candidateUserId, 500);
  const sourceId = clean(resumeId, 500);
  const sourceLocator = clean(locator, 2_000);
  const contentDigest = Buffer.isBuffer(bytes) || bytes instanceof Uint8Array ? sha256(bytes) : validDigest(bytes);
  if (!candidateId || !sourceId || !sourceLocator || !contentDigest) throw Object.assign(new TypeError("Candidate-original reuse requires exact candidate, source, locator, and digest."), { code: "candidate_original_reuse_identity_invalid" });
  return deepFreeze({ candidate_id: candidateId, source_id: sourceId, source_locator: sourceLocator, content_digest: contentDigest });
}

export function candidateOriginalExtractionRecord(identity, extraction, { capturedAt = new Date().toISOString() } = {}) {
  const text = normalizeEvidenceText(extraction?.text).slice(0, 250_000);
  const captured = new Date(capturedAt).getTime();
  if (!identity?.candidate_id || !text || !Number.isFinite(captured)) throw Object.assign(new TypeError("A cache record needs candidate-original extraction evidence."), { code: "candidate_original_reuse_record_invalid" });
  return deepFreeze({ schema_version: CANDIDATE_ORIGINAL_EXTRACTION_SCHEMA, ...identity, normalized_text: text, normalized_text_digest: sha256(text), page_count: Number(extraction?.pageCount) || null, captured_at: new Date(captured).toISOString() });
}

export function reusableCandidateOriginalExtraction(record, identity, { now = Date.now, maxAgeMs = 31 * 24 * 60 * 60_000 } = {}) {
  if (!record || record.schema_version !== CANDIDATE_ORIGINAL_EXTRACTION_SCHEMA || !identity) return null;
  if (record.candidate_id !== identity.candidate_id || record.source_id !== identity.source_id || record.source_locator !== identity.source_locator || record.content_digest !== identity.content_digest || record.normalized_text_digest !== sha256(normalizeEvidenceText(record.normalized_text))) return null;
  const age = Number(now()) - Date.parse(record.captured_at || "");
  if (!Number.isFinite(age) || age < 0 || age > maxAgeMs) return null;
  return deepFreeze({ text: record.normalized_text, pageCount: record.page_count, reused: true, record });
}

export async function reuseCandidateOriginalExtraction({ candidateUserId, resumeId, locator, bytes, extract }, { load = async () => null, save = async () => {}, now = Date.now, maxAgeMs } = {}) {
  if (typeof extract !== "function") throw new TypeError("Candidate-original extraction requires an extractor.");
  const identity = candidateOriginalExtractionIdentity({ candidateUserId, resumeId, locator, bytes });
  const cached = reusableCandidateOriginalExtraction(await load(identity), identity, { now, maxAgeMs });
  if (cached) return cached;
  const record = candidateOriginalExtractionRecord(identity, await extract(), { capturedAt: new Date(now()).toISOString() });
  await save(record);
  return deepFreeze({ text: record.normalized_text, pageCount: record.page_count, reused: false, record });
}
