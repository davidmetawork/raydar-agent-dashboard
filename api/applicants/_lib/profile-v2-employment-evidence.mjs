// Source-authority contract for employer-list Rules over Applicant Profile V2.
//
// Core owns the selected fact set and its freshness. Monitor may evaluate an
// immutable funded-employer snapshot only when the selected work-history
// envelope and every retained entry still carry the same current source
// metadata as the exact application/revision pins. The fact-set digest is a
// fact-set identity; it is never presented as a legacy source-payload digest.

export const PROFILE_V2_EMPLOYMENT_EVIDENCE_VERSION = "applicant-profile-v2-employment-evidence-v1";
export const PROFILE_V2_FACT_SET_VERSION = "applicant-profile-v2-fact-set-v2";

const SHA256 = /^[a-f0-9]{64}$/u;
const text = (value) => typeof value === "string" && value.trim() ? value.trim() : null;
const validTimestamp = (value) => Boolean(text(value) && Number.isFinite(Date.parse(value)));

function historyEntryEvidence(entry) {
  return Object.freeze({
    source: text(entry?.source),
    observedAt: text(entry?.observedAt),
    factVersion: text(entry?.factVersion),
    freshness: text(entry?.freshness),
    state: text(entry?.state),
  });
}

/** Copy only source authority, never employer values, from Core's selected
 * Profile V2 fact set. Employer identity values continue to come from the
 * long-standing Rules facts adapter and immutable membership snapshot. */
export function employmentEvidenceFromApplicantV2(projection) {
  const history = projection?.profile?.facts?.experiences;
  return Object.freeze({
    version: PROFILE_V2_EMPLOYMENT_EVIDENCE_VERSION,
    factSetVersion: text(projection?.factSetVersion),
    applicationId: text(projection?.application?.applicationId)?.toLowerCase() ?? null,
    sourceObservationId: text(projection?.application?.sourceObservationId),
    factSetDigest: text(projection?.factSetDigest)?.toLowerCase() ?? null,
    inputRevision: text(projection?.inputRevision),
    decisionRevision: Number(projection?.decisionRevision),
    factsCurrent: projection?.factsCurrent === true,
    history: Object.freeze({
      source: text(history?.source),
      observedAt: text(history?.observedAt),
      factVersion: text(history?.factVersion),
      freshness: text(history?.freshness),
      state: text(history?.state),
      entries: Object.freeze((Array.isArray(history?.entries) ? history.entries : [])
        .map(historyEntryEvidence)),
    }),
  });
}

/** Returns the existing employer-fact skip vocabulary so preview, manual run,
 * counters, and UI explanations remain compatible with legacy subjects. */
export function profileV2EmploymentEvidenceStatus(subject) {
  const evidence = subject?.employmentFactsEvidence;
  const history = evidence?.history;
  if (!evidence || evidence.version !== PROFILE_V2_EMPLOYMENT_EVIDENCE_VERSION
    || evidence.factSetVersion !== PROFILE_V2_FACT_SET_VERSION
    || !text(evidence.applicationId) || !text(evidence.sourceObservationId)
    || !SHA256.test(evidence.factSetDigest || "") || !text(evidence.inputRevision)
    || !Number.isSafeInteger(evidence.decisionRevision)
    || !history || !text(history.source) || !validTimestamp(history.observedAt)
    || !text(history.factVersion) || !Array.isArray(history.entries)) {
    return "employment_facts_source_unbound";
  }

  const expectedObservationId = text(subject?.row?.sourceObservationId
    ?? subject?.row?.source_observation_id);
  const entriesCurrent = history.entries.length > 0 && history.entries.every((entry) =>
    entry.source === history.source
      && entry.observedAt === history.observedAt
      && entry.factVersion === history.factVersion
      && entry.freshness === "current"
      && entry.state === history.state
      && validTimestamp(entry.observedAt));
  if (evidence.factsCurrent !== true
    || evidence.applicationId !== text(subject?.applicationId)?.toLowerCase()
    || evidence.sourceObservationId !== expectedObservationId
    || evidence.factSetDigest !== text(subject?.factSetDigest)?.toLowerCase()
    || evidence.inputRevision !== text(subject?.row?.inputRevision)
    || evidence.decisionRevision !== Number(subject?.row?.decisionRevision)
    || !["paraform_linkedin", "resume", "selected_resume", "application_source"].includes(history.source)
    || !["verified", "fallback"].includes(history.state)
    || history.freshness !== "current"
    || !entriesCurrent) {
    return "employment_facts_source_mismatch";
  }
  return null;
}
