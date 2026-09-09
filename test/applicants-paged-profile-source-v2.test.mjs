import assert from "node:assert/strict";
import test from "node:test";

import { pagedFeedResponse, projectPagedDocument, readApplicantPage } from
  "../api/applicants/_lib/paged.mjs";
import { applicationSourceFactsFromNormalized } from
  "../api/applicants/_lib/paged-core/application-source-facts.mjs";
import { projectApplicantProfileV1, projectApplicantProfileV2 } from
  "../api/applicants/_lib/paged-core/applicant-profile-contract.mjs";
import { PAGED_PROFILE_PINS_V1_VERSION, pagedProfilePins, projectPinnedApplicantProfile } from
  "../api/applicants/_lib/paged-core/paged-profile-contract.mjs";
import { payloadHash } from "../api/applicants/_lib/paged-core/stable-json.mjs";

const applicationId = "11111111-1111-4111-8111-111111111111";
const observationId = "22222222-2222-4222-8222-222222222222";
const application = { applicationId, tenantScopeId: "tenant-one", personId: "person-one",
  sourceObservationId: observationId, rowRevision: observationId,
  appliedTo: { roleVersionId: "role-version-one", roleId: "role-one", title: "Engineer",
    hiringCompany: { roleVersion: { name: "Client Co", version: "role-version-one",
      observedAt: "2026-09-09T12:00:00Z" } } } };
const source = { contact: { name: "Exact Application Person" }, context_snapshot: { candidate_detail: {
  headline: "Principal Engineer",
  experience_entries: [{ id: "work-one", company: "Exact Source Co", title: "Engineer" }],
} } };

function documentFor(pins, selectedSource = source, patch = {}) {
  const value = { current: true, source: selectedSource, profile: null, resume: null,
    row: { id: "33333333-3333-4333-8333-333333333333", application_id: applicationId,
      row_revision: 7, row_digest: "a".repeat(64), monitor_key: "candidate:role",
      role_id: "role-one", role_title: "Staff Platform Engineer",
      source_job_id: "workable-job-789", company: "Context Works",
      application_date: "2026-09-08",
      index_payload: { profilePins: pins, appliedAt: "2026-09-09T12:00:00Z", tier: "A" },
      source_observation_id: observationId, fact_set_digest: pins.factSetDigest,
      source_status: "current", partition: "ready", view_states: ["ready"], problems: [],
      decision_revision: 0, created_at: "2026-09-09T12:00:00Z" } };
  return { ...value, ...patch, row: { ...value.row, ...(patch.row || {}) } };
}

test("paged Monitor reconstructs exact application-source facts and rehashes the raw source", () => {
  const normalizedHash = payloadHash(source);
  const selected = { ...projectApplicantProfileV2({ application,
    applicationSource: { applicationId, sourceProvider: "workable",
      scope: { tenantScopeId: "tenant-one", personId: "person-one" },
      sourceObservationId: observationId, normalizedHash, factVersion: normalizedHash,
      state: "verified", observedAt: "2026-09-09T12:00:00Z", freshness: "current",
      facts: applicationSourceFactsFromNormalized(source, {
        provider: "workable", observedAt: "2026-09-09T12:00:00.000Z",
      }) }, actionability: { eligibility: "ready" } }),
    factsCurrent: true, inputRevision: "input-seven", decisionRevision: 0 };
  const pins = pagedProfilePins(selected);
  const projected = projectPagedDocument(documentFor(pins));
  assert.equal(projected.row.name, "Exact Application Person");
  assert.equal(projected.profile.title, "Principal Engineer");
  assert.equal(projected.profileV2.profile.facts.experiences.entries[0].companyName, "Exact Source Co");
  assert.equal(projected.profileV2.profile.applicationSource.normalizedHash, normalizedHash);
  assert.equal(projected.row.factsCurrent, true);
  assert.throws(() => projectPinnedApplicantProfile({ pins, source: {
    ...source, contact: { name: "Changed Application Person" },
  } }), /APPLICATION_SOURCE_DIGEST_MISMATCH/u,
  "the pure digest check remains strict");
  const contained = projectPagedDocument(documentFor(pins, {
    ...source, contact: { name: "Changed Application Person" },
  }), { now: Date.parse("2026-09-09T12:01:40Z") });
  assert.equal(contained.row.state, "profile_preparing");
  assert.equal(contained.row.viewAuthority, null);
  assert.equal(contained.row.interviewAllowed, false);
  assert.equal(contained.row.interviewWhenReadyAllowed, false);
  assert.equal(contained.profileV2, null);
  assert.equal(contained.photo, null);
  assert.equal(contained.row.linkedin, null);
  assert.equal(contained.row.problems[0].code,
    "paged_profile_application_source_digest_mismatch");
  assert.equal(contained.row.problems[0].owner, "Applicant Core");
  assert.equal(contained.row.problems[0].ageSeconds, 100);
});

test("legacy pins stay display-readable but never become Rules-current", () => {
  const projected = { ...projectApplicantProfileV1({ application,
    actionability: { eligibility: "waiting" } }), factsCurrent: true,
    inputRevision: "input-six", decisionRevision: 0 };
  const pins = { version: PAGED_PROFILE_PINS_V1_VERSION,
    application: projected.application, paraform: projected.profile.paraform,
    resume: projected.profile.resume, selectedResume: projected.profile.selectedResume,
    actionability: projected.actionability, inputRevision: projected.inputRevision,
    decisionRevision: projected.decisionRevision, factsCurrent: true,
    factSetDigest: projected.factSetDigest };
  const restored = projectPagedDocument(documentFor(pins));
  assert.equal(restored.row.name, "Exact Application Person");
  assert.equal(restored.profileV2.factSetVersion, "applicant-profile-v2-fact-set-v1");
  assert.equal(restored.row.factsCurrent, false);
  assert.equal(restored.row.state, "profile_preparing");
  assert.deepEqual(restored.row.viewStates, ["preparing"]);
});

test("one malformed legacy profile is contained without hiding its healthy sibling or cursor", async () => {
  const provider = { scope: { tenantScopeId: "tenant-one", personId: "person-one" },
    sourceObservationId: observationId, state: "verified", observedAt: "2026-09-09T12:00:00Z",
    factVersion: "provider-one", freshness: "current", facts: { title: "Provider Engineer" } };
  const legacy = { ...projectApplicantProfileV1({ application, paraformProfile: provider,
    actionability: { eligibility: "ready" } }), factsCurrent: true,
    inputRevision: "legacy-input", decisionRevision: 4 };
  const malformedPins = { version: PAGED_PROFILE_PINS_V1_VERSION,
    application: legacy.application, paraform: { ...legacy.profile.paraform, observedAt: null },
    resume: legacy.profile.resume, selectedResume: legacy.profile.selectedResume,
    actionability: legacy.actionability, inputRevision: legacy.inputRevision,
    decisionRevision: legacy.decisionRevision, factsCurrent: true,
    factSetDigest: legacy.factSetDigest };
  const malformed = documentFor(malformedPins, source, { profile: {
    tenantScopeId: "tenant-one", personId: "person-one", sourceObservationId: observationId,
    factVersion: "provider-one", observedAt: "2026-09-09T12:00:00Z",
    payloadState: "available", freshness: "current", payload: { title: "Provider Engineer" },
  }, row: { monitor_key: "legacy:role", decision_action: "interview",
    decision_at: "2026-09-09T12:00:10Z", decision_revision: 4,
    index_payload: { profilePins: malformedPins, tier: "A", decisionRequestId: "saved-request" } } });
  assert.throws(() => projectPinnedApplicantProfile({ pins: malformedPins,
    source, paraform: malformed.profile, current: true }),
  /REFERENCE_SCOPE_CHANGED/u, "the pure legacy scope check remains strict");
  const directlyContained = projectPagedDocument(malformed, {
    now: Date.parse("2026-09-09T12:02:00Z"),
  });
  assert.equal(directlyContained.row.problems[0].firstObservedAt,
    malformed.row.created_at);
  assert.equal(directlyContained.row.problems[0].ageSeconds, 120);

  const healthyApplicationId = "55555555-5555-4555-8555-555555555555";
  const healthyObservationId = "77777777-7777-4777-8777-777777777777";
  const healthyApplication = { ...application, applicationId: healthyApplicationId,
    sourceObservationId: healthyObservationId };
  const normalizedHash = payloadHash(source);
  const healthyProjection = { ...projectApplicantProfileV2({ application: healthyApplication,
    applicationSource: { applicationId: healthyApplicationId, sourceProvider: "workable",
      scope: { tenantScopeId: "tenant-one", personId: "person-one" },
      sourceObservationId: healthyObservationId, normalizedHash, factVersion: normalizedHash,
      state: "verified", observedAt: "2026-09-09T12:00:00Z", freshness: "current",
      facts: applicationSourceFactsFromNormalized(source) },
    actionability: { eligibility: "ready" } }), factsCurrent: true };
  const healthyPins = pagedProfilePins(healthyProjection);
  const healthy = documentFor(healthyPins, source, { row: {
    id: "44444444-4444-4444-8444-444444444444", application_id: healthyApplicationId,
    source_observation_id: healthyObservationId, monitor_key: "healthy:role",
    index_payload: { profilePins: healthyPins, appliedAt: "2026-09-09T12:00:00Z" },
  } });
  const after = { primary: "2026-09-09T11:00:00Z", secondary: "2026-09-09",
    key: "legacy:role" };
  const manifest = { generationId: "66666666-6666-4666-8666-666666666666",
    generationDigest: "b".repeat(64), rowCount: 2, counts: { ready: 2, preparing: 0 } };
  const pool = { connect: async () => ({ query: async sql => {
    if (sql.includes("read_applicant_view_manifest")) return { rows: [{ value: manifest }] };
    if (sql.includes("read_applicant_view_page")) return { rows: [{ value: {
      generation: { generationId: manifest.generationId,
        generationDigest: manifest.generationDigest }, documents: [malformed, healthy], after,
    } }] };
    return { rows: [] };
  }, release() {} }) };
  const result = await readApplicantPage({ view: "all", limit: 2 }, { pool });
  assert.equal(result.applicants.length, 2);
  const contained = result.applicants[0];
  assert.equal(contained.row.applicationId, applicationId);
  assert.equal(contained.row.rowVersionId, malformed.row.id);
  assert.equal(contained.row.roleTitle, "Staff Platform Engineer");
  assert.equal(contained.row.company, "Context Works");
  assert.equal(contained.row.sourceJobId, "workable-job-789");
  assert.equal(contained.row.appliedAt, "2026-09-08");
  assert.equal(contained.row.tier, null);
  assert.equal(contained.row.decisionAction, "interview");
  assert.equal(contained.row.savedDecisionRequestId, "saved-request");
  assert.equal(contained.row.inputRevision, null);
  assert.equal(contained.row.rowCurrent, false);
  assert.equal(contained.row.name, "Applicant");
  assert.equal(contained.profileV2, null);
  assert.equal(contained.card.imageSrc, null);
  assert.equal(contained.row.problems[0].code, "paged_profile_reference_scope_changed");
  assert.equal(result.applicants[1].row.name, "Exact Application Person");
  assert.equal(result.applicants[1].profile.title, "Principal Engineer");
  const cursor = JSON.parse(Buffer.from(result.page.nextCursor, "base64url").toString("utf8"));
  assert.deepEqual(cursor.after, after);
  assert.equal(cursor.generationId, manifest.generationId);
  const response = pagedFeedResponse(result);
  assert.equal(response.nextCursor, result.page.nextCursor);
  assert.deepEqual(response.profilePreparingRows.map(row => row.applicationId),
    [applicationId]);
  assert.equal(response.snapshot.queue.length, 1);
  assert.equal(response.snapshot.queue[0].applicationId, healthyApplicationId);
  assert.equal(response.applicantRowsV2[contained.row.key], undefined);
  assert.equal(response.photos[contained.row.profileKey], undefined);
  assert.equal(response.cards[contained.row.profileKey].imageSrc, null);
  assert.equal(response.problems[0].reason,
    "Stored profile evidence no longer matches this retained applicant row.");
  assert.equal(response.problems[0].owner, "Applicant Core");
  assert.equal(response.problems[0].nextAction,
    "Refresh this applicant’s stored profile from current identity and source records.");
});
