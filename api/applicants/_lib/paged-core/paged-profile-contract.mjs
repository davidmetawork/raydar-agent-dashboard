import {
  APPLICANT_PROFILE_V1_FACT_SET_VERSION,
  APPLICANT_PROFILE_V2_FACT_SET_VERSION,
  applicantProfileFactSetDigest,
  projectApplicantProfileV1,
  projectApplicantProfileV2,
} from './applicant-profile-contract.mjs';
import { applicationSourceFactsFromNormalized } from './application-source-facts.mjs';
import { historicalV4SourceAttribution, historicalV4SourceAttributionProblem,
  withoutApplicationSourceFacts } from './historical-source-attribution.mjs';
import { payloadHash } from './stable-json.mjs';

export const PAGED_PROFILE_PINS_V1_VERSION = 'applicant-paged-profile-pins-v1';
export const PAGED_PROFILE_PINS_VERSION = 'applicant-paged-profile-pins-v2';
const clone = value => value == null ? null : JSON.parse(JSON.stringify(value));
const iso = value => value == null ? null : new Date(value).toISOString();
const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : null;
const failure = code => Object.assign(new Error(code), { code });

/** Keep selection and authority metadata, never a second copy of profile facts. */
export function pagedProfilePins(projected) {
  if (!projected?.application || !projected?.profile || !projected.factSetDigest
    || projected.factSetVersion !== APPLICANT_PROFILE_V2_FACT_SET_VERSION) return null;
  return Object.freeze({
    version: PAGED_PROFILE_PINS_VERSION,
    factSetVersion: APPLICANT_PROFILE_V2_FACT_SET_VERSION,
    application: clone(projected.application),
    paraform: clone(projected.profile.paraform),
    applicationSource: clone(projected.profile.applicationSource),
    resume: clone(projected.profile.resume),
    selectedResume: clone(projected.profile.selectedResume),
    actionability: clone(projected.actionability),
    invitation: clone(projected.invitation),
    inputRevision: projected.inputRevision ?? null,
    decisionRevision: projected.decisionRevision ?? null,
    factsCurrent: projected.factsCurrent === true,
    factSetDigest: projected.factSetDigest,
  });
}

function selectedPayload(pins, record, kind) {
  const summary = pins[kind];
  if (summary?.validity !== 'usable') return { candidate: null, summary, changed: false };
  if (!record) throw failure('APPLICANT_PAGED_PROFILE_REFERENCE_MISSING');
  const resume = kind === 'resume';
  const app = pins.application;
  const tenant = resume ? app.tenantScopeId : app.providerTenantScopeId ?? app.tenantScopeId;
  if (record.tenantScopeId !== tenant || record.personId !== app.personId
    || record.sourceObservationId !== app.sourceObservationId
    || record.factVersion !== summary.factVersion || iso(record.observedAt) !== summary.observedAt
    || (resume && (record.applicationId !== app.applicationId
      || record.artifactId !== pins.selectedResume?.artifactId
      || record.artifactDigest !== pins.selectedResume?.digest
      || record.parserVersion !== pins.selectedResume?.parserVersion))) {
    throw failure('APPLICANT_PAGED_PROFILE_REFERENCE_SCOPE_CHANGED');
  }
  const denied = record.scopeTombstoned === true || record.payloadState === 'tombstoned';
  const expired = record.expired === true;
  if (denied || expired) return {
    candidate: null, changed: true, privacyRestricted: denied,
    summary: { ...summary, state: 'unavailable', validity: denied ? 'privacy_restricted' : 'retention_expired' },
  };
  if (record.payloadState !== 'available' || !record.payload || Array.isArray(record.payload)) {
    throw failure('APPLICANT_PAGED_PROFILE_PAYLOAD_UNAVAILABLE');
  }
  const effectiveFreshness = record.freshness === 'stale' ? 'stale' : summary.freshness;
  const freshnessChanged = effectiveFreshness !== summary.freshness;
  return {
    candidate: {
      scope: { tenantScopeId: tenant, personId: app.personId },
      sourceObservationId: app.sourceObservationId,
      state: 'verified', observedAt: summary.observedAt,
      factVersion: summary.factVersion, freshness: effectiveFreshness,
      facts: record.payload,
      ...(resume ? { applicationId: app.applicationId,
        artifact: { id: record.artifactId, digest: record.artifactDigest }, parserVersion: record.parserVersion } : {}),
    },
    summary: { ...summary, freshness: effectiveFreshness }, changed: freshnessChanged,
  };
}

function selectedApplicationSource(pins, source, { attributionConflict = false } = {}) {
  const summary = pins.applicationSource;
  if (!['usable', 'attribution_conflict'].includes(summary?.validity)) {
    return { candidate: null, summary, changed: false };
  }
  const normalized = object(source);
  if (!normalized) throw failure('APPLICANT_PAGED_PROFILE_REFERENCE_MISSING');
  if (!/^[0-9a-f]{64}$/u.test(summary.normalizedHash || '')
    || summary.factVersion !== summary.normalizedHash
    || payloadHash(normalized) !== summary.normalizedHash) {
    throw failure('APPLICANT_PAGED_PROFILE_APPLICATION_SOURCE_DIGEST_MISMATCH');
  }
  const app = pins.application;
  const selectedSummary = attributionConflict
    ? { ...summary, state: 'unavailable', validity: 'attribution_conflict' } : summary;
  return {
    candidate: {
      applicationId: app.applicationId,
      scope: { tenantScopeId: app.tenantScopeId, personId: app.personId },
      sourceObservationId: app.sourceObservationId,
      normalizedHash: summary.normalizedHash,
      state: attributionConflict ? 'conflict' : 'verified', observedAt: summary.observedAt,
      factVersion: summary.factVersion, freshness: summary.freshness,
      facts: applicationSourceFactsFromNormalized(normalized, {
        provider: summary.provider, observedAt: summary.observedAt,
      }),
    },
    summary: selectedSummary,
    changed: attributionConflict && summary.validity !== 'attribution_conflict',
  };
}

/** Reapply Core's existing fact selector to the exact immutable payload references.
 * Privacy and retention may remove facts immediately; this never promotes a
 * newly changed selection into current decision or Rules authority. */
export function projectPinnedApplicantProfile({ pins, source = null, paraform = null, resume = null,
  current = true, problems = [] } = {}) {
  if (!pins) return null;
  const legacy = pins.version === PAGED_PROFILE_PINS_V1_VERSION;
  if (!legacy && (pins.version !== PAGED_PROFILE_PINS_VERSION
    || pins.factSetVersion !== APPLICANT_PROFILE_V2_FACT_SET_VERSION)) {
    throw failure('APPLICANT_PAGED_PROFILE_PINS_INVALID');
  }
  const sourceAttributionConflict = Boolean(historicalV4SourceAttribution(source, {
    provider: pins.applicationSource?.provider,
  }));
  const providerSelection = selectedPayload(pins, paraform, 'paraform');
  const applicationSelection = legacy
    ? { candidate: null, summary: null, changed: false }
    : selectedApplicationSource(pins, source, { attributionConflict: sourceAttributionConflict });
  const resumeSelection = selectedPayload(pins, resume, 'resume');
  let resumeSourceChanged = false;
  if (sourceAttributionConflict && resumeSelection.candidate) {
    const filtered = withoutApplicationSourceFacts(resumeSelection.candidate.facts);
    resumeSourceChanged = filtered.changed;
    resumeSelection.candidate = { ...resumeSelection.candidate, facts: filtered.facts };
  }
  const selected = (legacy ? projectApplicantProfileV1 : projectApplicantProfileV2)({
    application: pins.application,
    paraformProfile: providerSelection.candidate,
    applicationSource: applicationSelection.candidate,
    resume: resumeSelection.candidate,
    actionability: pins.actionability,
  });
  const { appliedTo, ...applicationIdentity } = pins.application;
  const profile = {
    ...selected.profile,
    paraform: clone(providerSelection.summary),
    ...(legacy ? {} : { applicationSource: clone(applicationSelection.summary) }),
    resume: clone(resumeSelection.summary),
    selectedResume: resumeSelection.changed ? null : clone(pins.selectedResume),
  };
  const digest = applicantProfileFactSetDigest({
    version: legacy ? APPLICANT_PROFILE_V1_FACT_SET_VERSION : APPLICANT_PROFILE_V2_FACT_SET_VERSION,
    application: applicationIdentity, appliedTo, facts: profile.facts,
    sources: legacy
      ? { paraform: profile.paraform, resume: profile.resume }
      : { paraform: profile.paraform, applicationSource: profile.applicationSource, resume: profile.resume },
  });
  const attributionSelectionChanged = applicationSelection.changed || resumeSourceChanged;
  const selectionChanged = providerSelection.changed || attributionSelectionChanged || resumeSelection.changed;
  if (!selectionChanged && digest !== pins.factSetDigest) throw failure('APPLICANT_PAGED_PROFILE_DIGEST_MISMATCH');
  // Clock-based freshness/retention changes affect displayed facts and Rules.
  // They do not revoke an exact source/readiness authorization for a human.
  const privacyRestricted = providerSelection.privacyRestricted || resumeSelection.privacyRestricted;
  const authorityCurrent = current === true && !privacyRestricted && !sourceAttributionConflict;
  // V1 pins remain readable during the bounded rematerialization but can never
  // become Rules authority under the V2 fact contract.
  const factsCurrent = !legacy && authorityCurrent && !selectionChanged && pins.factsCurrent === true;
  return Object.freeze({
    contractVersion: selected.contractVersion,
    factSetVersion: selected.factSetVersion,
    application: clone(pins.application), profile: Object.freeze(profile),
    actionability: authorityCurrent ? clone(pins.actionability) : {
      eligibility: sourceAttributionConflict && !privacyRestricted ? 'hard_hold' : 'unknown',
      reasons: [privacyRestricted ? 'privacy_restricted'
        : sourceAttributionConflict ? 'historical_v4_source_identity_conflict' : 'profile_version_changed'],
      readinessRevision: null, canCreateApproval: false, approvalState: 'unavailable',
    },
    invitation: clone(pins.invitation), inputRevision: pins.inputRevision,
    decisionRevision: pins.decisionRevision, factsCurrent,
    factSetDigest: digest, expectedFactSetDigest: pins.factSetDigest,
    problems: sourceAttributionConflict ? [historicalV4SourceAttributionProblem(),
      ...clone(problems).filter(problem => problem.code !== 'historical_v4_source_identity_conflict')]
      : clone(problems),
  });
}
