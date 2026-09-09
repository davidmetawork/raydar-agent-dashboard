import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createDecisionHandler } from '../api/applicants/decision.mjs';
import { projectPagedDocument } from '../api/applicants/_lib/paged.mjs';
import { pagedProfilePins, projectPinnedApplicantProfile } from '../api/applicants/_lib/paged-core/paged-profile-contract.mjs';

const fixtures = JSON.parse(await readFile(new URL('./fixtures/historical-source-attribution-pins.json', import.meta.url)));
const generation = { generationId: '10000000-0000-4000-8000-000000000001', generationDigest: 'a'.repeat(64) };

function documentFor(name, { fresh = true } = {}) {
  const input = JSON.parse(JSON.stringify(fixtures.cases[name])
    .replaceAll('"application-attribution"', '"10000000-0000-4000-8000-000000000011"')
    .replaceAll('"source-attribution"', '"10000000-0000-4000-8000-000000000012"')
    .replaceAll('"person-attribution"', '"10000000-0000-4000-8000-000000000013"'));
  const pins = fresh ? pagedProfilePins({ ...projectPinnedApplicantProfile(input), factsCurrent: false,
    inputRevision: 'current-input', decisionRevision: 3,
    actionability: { eligibility: 'hard_hold', reasons: ['historical_v4_source_identity_conflict'],
      readinessRevision: 'current-readiness', canCreateApproval: false, approvalState: 'forbidden' },
  }) : input.pins;
  return { current: true, source: input.source, profile: input.paraform, resume: input.resume,
    row: { id: '10000000-0000-4000-8000-000000000002', application_id: pins.application.applicationId,
      monitor_key: `core:${pins.application.applicationId.replaceAll('-', '')}`, row_revision: 7,
      row_digest: 'b'.repeat(64), source_observation_id: pins.application.sourceObservationId,
      source_status: 'current', partition: 'ready', view_states: ['ready', 'problems'],
      role_title: 'Target Role', company: 'Target Company', fact_set_digest: pins.factSetDigest,
      input_revision: pins.inputRevision, readiness_revision: pins.actionability.readinessRevision,
      decision_revision: pins.decisionRevision,
      index_payload: { profilePins: pins, interviewAllowed: true, interviewWhenReadyAllowed: true }, problems: [] } };
}

function requestFor(projected) {
  const { row, profileV2 } = projected;
  return { key: row.key, action: 'pass', requestId: '10000000-0000-4000-8000-000000000003',
    ...generation, viewAuthority: row.viewAuthority, applicationId: row.applicationId,
    sourceObservationId: row.sourceObservationId, rowRevision: profileV2.application.rowRevision,
    inputRevision: profileV2.inputRevision, readinessRevision: profileV2.actionability.readinessRevision,
    decisionRevision: profileV2.decisionRevision };
}

async function invoke(projected, body, { finalRead = null } = {}) {
  let reads = 0;
  const writes = [];
  const handler = createDecisionHandler({ corsHandler: () => false, authHandler: async () => true,
    kvReady: () => true, pagedEnabled: () => true,
    readPagedAuthority: async () => ({ generation, ...(++reads > 1 && finalRead ? finalRead : projected) }),
    writeDecision: async (key, record) => { writes.push({ key, record }); return true; } });
  const response = { setHeader() {}, status(value) { this.statusCode = value; return this; },
    json(value) { this.body = value; return this; } };
  await handler({ method: 'POST', body, applicantActor: { id: 'fixture', email: 'fixture@example.invalid' } }, response);
  return { response, writes, reads };
}

test('fresh Ready safe fallback preserves exact Pass metadata but never Interview or Rules', async () => {
  for (const name of ['safe_provider', 'safe_resume']) {
    const projected = projectPagedDocument(documentFor(name));
    assert.equal(projected.row.passAllowed, true);
    assert.equal(projected.row.rowCurrent, true);
    assert.equal(projected.row.profileUpdatePending, false);
    assert.equal(projected.profileV2.factsCurrent, false);
    assert.equal(projected.row.interviewAllowed, false);
    assert.equal(projected.row.interviewWhenReadyAllowed, false);
    const body = requestFor(projected);
    const accepted = await invoke(projected, body);
    assert.equal(accepted.response.statusCode, 202);
    assert.equal(accepted.reads, 2);
    assert.equal(accepted.writes.length, 1);
    assert.deepEqual(accepted.writes[0].record.viewAuthority, projected.row.viewAuthority);
    assert.equal(accepted.writes[0].record.readinessRevision, body.readinessRevision);
    const interview = await invoke(projected, { ...body, action: 'interview' });
    assert.equal(interview.response.statusCode, 409);
    assert.equal(interview.response.body.error, 'interview_hard_hold');
    assert.equal(interview.writes.length, 0);
  }
});

test('old, non-current, Preparing, changed raw metadata and unavailable scoped payloads refuse Pass', async () => {
  for (const name of ['safe_provider', 'safe_resume']) {
    const current = projectPagedDocument(documentFor(name));
    const body = requestFor(current);
    const kind = name === 'safe_provider' ? 'profile' : 'resume';
    const changes = [
      value => { value.current = false; },
      value => { value.row.partition = 'preparing'; },
      value => { value.row.application_id = '10000000-0000-4000-8000-000000000099'; },
      value => { value.row.source_observation_id = '10000000-0000-4000-8000-000000000099'; },
      value => { value.row.fact_set_digest = 'c'.repeat(64); },
      value => { value.row.input_revision = 'changed-input'; },
      value => { value.row.readiness_revision = 'changed-readiness'; },
      value => { value.row.decision_revision += 1; },
      value => { value[kind].scopeTombstoned = true; },
      value => { value[kind].expired = true; },
      value => { value[kind].freshness = 'stale'; },
      value => { value[kind].personId = 'foreign-person'; },
      value => { value[kind].tenantScopeId = 'foreign-tenant'; },
      value => { value[kind].sourceObservationId = 'foreign-source'; },
      value => { value.source.application = { job_title: 'Changed' }; },
    ];
    const documents = [documentFor(name, { fresh: false }), ...changes.map(change => {
      const document = documentFor(name); change(document); return document;
    })];
    for (const document of documents) {
      const projected = projectPagedDocument(document);
      assert.notEqual(projected.row.passAllowed, true);
      assert.equal(projected.row.viewAuthority, null);
      const refused = await invoke(projected, body);
      assert.equal(refused.response.statusCode, 409, JSON.stringify(projected.row));
      assert.equal(refused.writes.length, 0);
    }
    for (const change of [
      value => { value[kind].expired = true; },
      value => { value[kind] = null; },
      value => { value[kind].personId = 'foreign-person'; },
      value => { value.source.application = { job_title: 'Changed' }; },
    ]) {
      const changed = documentFor(name); change(changed);
      const finalRead = await invoke(current, body, { finalRead: projectPagedDocument(changed) });
      assert.equal(finalRead.reads, 2);
      assert.equal(finalRead.response.statusCode, 409);
      assert.equal(finalRead.writes.length, 0);
    }
    for (const change of [
      value => { value.row.viewAuthority.rowDigest = 'd'.repeat(64); },
      value => { value.row.viewAuthority.rowRevision += 1; },
      value => { value.profileV2.inputRevision = 'new-input'; },
      value => { value.profileV2.actionability.readinessRevision = 'new-readiness'; },
      value => { value.profileV2.decisionRevision += 1; },
      value => { value.profileV2.application.rowRevision = 'new-source'; },
    ]) {
      const changed = structuredClone(current); change(changed);
      const finalRead = await invoke(current, body, { finalRead: changed });
      assert.equal(finalRead.response.statusCode, 409);
      assert.equal(finalRead.writes.length, 0);
    }
    for (const patch of [
      { viewAuthority: { ...body.viewAuthority, rowDigest: 'd'.repeat(64) } },
      { applicationId: '10000000-0000-4000-8000-000000000099' },
      { sourceObservationId: '10000000-0000-4000-8000-000000000099' },
      { inputRevision: 'old-input' }, { readinessRevision: 'old-readiness' }, { decisionRevision: 2 },
    ]) {
      const refused = await invoke(current, { ...body, ...patch });
      assert.equal(refused.response.statusCode, 409);
      assert.equal(refused.writes.length, 0);
    }
  }
  const noFallback = projectPagedDocument(documentFor('conflicting_native_shape'));
  assert.equal(noFallback.row.passAllowed, false);
  assert.equal(noFallback.row.viewAuthority, null);
  assert.ok(noFallback.row.viewStates.includes('preparing'));
});
