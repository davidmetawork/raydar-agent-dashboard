import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { pagedFeedResponse, projectPagedDocument } from '../api/applicants/_lib/paged.mjs';

const fixtures = JSON.parse(await readFile(new URL('./fixtures/historical-source-attribution-pins.json', import.meta.url)));
const documentFor = input => ({ current: true, source: input.source,
  profile: input.paraform, resume: input.resume,
  row: { id: 'row-attribution', application_id: input.pins.application.applicationId,
    monitor_key: 'core:attribution', row_revision: 7, row_digest: 'a'.repeat(64),
    source_observation_id: input.pins.application.sourceObservationId,
    source_status: 'held', partition: 'ready', view_states: ['ready'],
    role_title: 'Target Role', company: 'Target Company',
    fact_set_digest: input.pins.factSetDigest, input_revision: 'retained-input',
    readiness_revision: 'retained-readiness', decision_revision: 3,
    decision_action: 'pass', decision_at: '2026-09-08T01:00:00.000Z',
    index_payload: { profilePins: input.pins, interviewAllowed: true,
      interviewWhenReadyAllowed: true, decisionRequestId: 'retained-decision' }, problems: [] } });

test('retained conflicting source pins become an explicit preparation problem without leaking raw careers', () => {
  for (const name of ['conflicting_source', 'conflicting_native_shape', 'safe_provider', 'safe_resume', 'legacy_resume']) {
    const document = documentFor(fixtures.cases[name]);
    const before = JSON.stringify(document);
    const result = projectPagedDocument(document);
    assert.doesNotMatch(JSON.stringify(result), /Archived Source (Title|Employer|School)|Copied Wrong/);
    assert.equal(result.row.applicationId, document.row.application_id);
    assert.equal(result.row.sourceObservationId, document.row.source_observation_id);
    assert.equal(result.row.decisionAction, 'pass');
    assert.equal(result.row.decisionRevision, 3);
    assert.equal(result.row.savedDecisionRequestId, 'retained-decision');
    assert.equal(result.row.problems[0].code, 'historical_v4_source_identity_conflict');
    assert.match(result.row.problems[0].reason, /archived profile identity conflicts/);
    assert.equal(result.row.reason, 'historical_v4_source_identity_conflict');
    assert.equal(result.row.factsCurrent, false);
    assert.equal(result.row.rowCurrent, false);
    assert.equal(result.row.profileUpdatePending, true);
    assert.equal(result.row.viewAuthority, null);
    assert.equal(result.row.interviewAllowed, false);
    assert.equal(result.row.interviewWhenReadyAllowed, false);
    const independentFallback = ['safe_provider', 'safe_resume', 'legacy_resume'].includes(name);
    assert.equal(result.row.viewStates.includes('preparing'), !independentFallback);
    const feed = pagedFeedResponse({ manifest: { generationId: 'generation-one',
      generationDigest: 'a'.repeat(64), rowCount: 1, counts: {} }, page: {}, view: 'all', applicants: [result] });
    assert.equal(feed.profilePreparingRows.length, independentFallback ? 0 : 1);
    assert.equal(feed.snapshot.queue.length, independentFallback ? 1 : 0);
    assert.ok(result.row.viewStates.includes('problems'));
    assert.equal(JSON.stringify(document), before, 'retained evidence and decisions are immutable');
    if (name === 'safe_provider') assert.equal(result.profile.title, 'Verified Provider Title');
    else assert.equal(result.profile.title, null);
    if (name.includes('resume')) assert.match(result.profileV2.profile.facts.about.value, /Independently selected resume content/);
  }
});

test('unaffected historical and Workable documents keep frozen fact digests and currentness', () => {
  for (const name of ['valid_v4', 'workable_unchanged']) {
    const input = fixtures.cases[name];
    const result = projectPagedDocument(documentFor(input));
    assert.equal(result.profileV2.factSetDigest, input.expectedBefore.factSetDigest);
    assert.equal(result.row.factsCurrent, true);
    assert.equal(result.row.rowCurrent, true);
    assert.equal(result.row.profileUpdatePending, false);
    assert.deepEqual(result.row.problems, []);
    assert.equal(result.profile.title, 'Archived Source Title');
  }
});
