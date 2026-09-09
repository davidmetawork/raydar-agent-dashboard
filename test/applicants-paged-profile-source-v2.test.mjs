import assert from "node:assert/strict";
import test from "node:test";

import { projectPagedDocument } from "../api/applicants/_lib/paged.mjs";
import { applicationSourceFactsFromNormalized } from
  "../api/applicants/_lib/paged-core/application-source-facts.mjs";
import { projectApplicantProfileV1, projectApplicantProfileV2 } from
  "../api/applicants/_lib/paged-core/applicant-profile-contract.mjs";
import { PAGED_PROFILE_PINS_V1_VERSION, pagedProfilePins } from
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

function documentFor(pins, selectedSource = source) {
  return { current: true, source: selectedSource, profile: null, resume: null,
    row: { id: "33333333-3333-4333-8333-333333333333", application_id: applicationId,
      row_revision: 7, row_digest: "a".repeat(64), monitor_key: "candidate:role",
      index_payload: { profilePins: pins, appliedAt: "2026-09-09T12:00:00Z" },
      source_observation_id: observationId, fact_set_digest: pins.factSetDigest,
      source_status: "current", partition: "ready", view_states: ["ready"], problems: [],
      decision_revision: 0 } };
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
  assert.throws(() => projectPagedDocument(documentFor(pins, {
    ...source, contact: { name: "Changed Application Person" },
  })), /APPLICATION_SOURCE_DIGEST_MISMATCH/u);
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
