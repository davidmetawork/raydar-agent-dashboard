import { canonicalLinkedinProfileUrl } from './linkedin-profile-url.mjs';

export const HISTORICAL_V4_SOURCE_ATTRIBUTION_VERSION = 'historical-v4-source-identity-v1';
export const HISTORICAL_V4_SOURCE_IDENTITY_CONFLICT = 'HISTORICAL_V4_SOURCE_IDENTITY_CONFLICT';
const V4_EVIDENCE_VERSION = 'applicant-hub-linkedin-v4-evidence-v1';
const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : null;

/** Interpret retained evidence, including observations written before the Hub
 * admission guard. A receipt or shared email never resolves conflicting URLs. */
export function historicalV4SourceAttribution(normalized, { provider = null } = {}) {
  const source = object(normalized) || {};
  if ((provider ?? source.source_type) !== 'linkedin_applications') return null;
  const context = object(source.sourceContext) ?? object(source.source_context) ?? {};
  const historical = object(context.historical_v4) ?? object(source.historical_v4);
  if (historical?.version !== V4_EVIDENCE_VERSION
    && source.schema_version !== V4_EVIDENCE_VERSION
    && source.context_snapshot?.schema_version !== V4_EVIDENCE_VERSION
    && context.context_snapshot?.schema_version !== V4_EVIDENCE_VERSION) return null;
  const raw = object(source.raw_xlsx_row) ?? object(context.raw_xlsx_row)
    ?? object(historical?.selected_evidence?.rawXlsxRow)
    ?? object(source.selected_evidence?.rawXlsxRow)
    ?? object(source.context_snapshot?.candidate_detail) ?? {};
  const declared = canonicalLinkedinProfileUrl(source.applicant?.linkedin_url);
  const selected = canonicalLinkedinProfileUrl(raw['Profile URL']);
  // Missing evidence remains a different class. Markers cannot create or
  // remove a conflict: both exact canonical identities must prove it here.
  if (!declared || !selected || declared === selected) return null;
  return Object.freeze({ version: HISTORICAL_V4_SOURCE_ATTRIBUTION_VERSION,
    state: 'conflict', reasonCode: HISTORICAL_V4_SOURCE_IDENTITY_CONFLICT });
}

export function historicalV4SourceAttributionProblem() {
  return Object.freeze({ code: 'historical_v4_source_identity_conflict',
    domain: 'profile', state: 'open',
    reason: 'The archived profile identity conflicts with the declared application identity',
    owner: 'Human review',
    nextAction: 'Verify the exact source attribution or replace the conflicting source evidence' });
}

/** Old resume preparations could retain source-derived fields. Those fields
 * are not an independent fallback when the source attribution is refused. */
export function withoutApplicationSourceFacts(value) {
  const facts = object(value) || {};
  const rejected = new Set(Object.keys(facts).filter(key =>
    facts.provenance?.[key]?.source === 'application_source'));
  if (!rejected.size) return { facts: value, changed: false };
  const filtered = Object.fromEntries(Object.entries(facts).filter(([key]) =>
    key !== 'provenance' && !rejected.has(key)));
  const provenance = Object.fromEntries(Object.entries(facts.provenance || {})
    .filter(([key]) => !rejected.has(key)));
  if (Object.keys(provenance).length) filtered.provenance = provenance;
  return { facts: Object.freeze(filtered), changed: true };
}
