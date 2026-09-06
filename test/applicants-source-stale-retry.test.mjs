import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import test from 'node:test';

import {createDecisionHandler} from '../api/applicants/decision.mjs';
import {buildGeneration} from '../api/applicants/_lib/generation.mjs';
import {
  saveApplicantRequest,
  SOURCE_STALE_INTERVIEW_FAILURE,
} from '../api/applicants/_lib/request-safety.mjs';

const OLD = 'source-stale-old-request';
const NEXT = 'source-stale-new-request';
const KEY = 'core:sourcestalefixture1234';
const DECISION_AT = '2026-09-05T20:00:00.000Z';
const ACK_AT = '2026-09-05T20:02:00.000Z';
const PUBLICATION_AT = '2026-09-05T20:03:00.000Z';
const PREVIOUS_INPUT = 'input-before-source-change';
const CURRENT_INPUT = 'input-after-source-change';
const oldDecision = {
  action: 'interview', requestId: OLD, actorType: 'human', actorId: 'original@example.test',
  by: 'original@example.test', at: DECISION_AT, inputRevision: PREVIOUS_INPUT,
};
const oldAck = {requestId: OLD, status: 'blocked', reason: SOURCE_STALE_INTERVIEW_FAILURE, at: ACK_AT};

function harness(options={}) {
  const row = {
    key: KEY, profileKey: 'source-stale-profile', name: 'Synthetic Applicant', roleTitle: 'Engineer',
    inputRevision: CURRENT_INPUT, readinessRevision: 'current-readiness', decisionRevision: 4,
    ...options.row,
  };
  const snapshot = {stream: [], profilePreparing: 0};
  if (!Object.hasOwn(options, 'snapshotGeneratedAt') || options.snapshotGeneratedAt !== null) {
    snapshot.generatedAt = options.snapshotGeneratedAt ?? PUBLICATION_AT;
  }
  const artifacts = buildGeneration({
    generationId: 'source-stale-retry-generation',
    publishedAt: PUBLICATION_AT,
    snapshot,
    queue: [row],
    counts: {total: 1, queue: 1, stream: 0, profilePreparing: 0},
  });
  if (Object.hasOwn(options, 'queueGeneratedAt')) artifacts.queue.generatedAt = options.queueGeneratedAt;
  const saved = [];
  const handler = createDecisionHandler({
    corsHandler: () => false,
    authHandler: async (req) => {
      req.authedEmail = 'operator@example.test';
      req.applicantActor = {id: 'operator@example.test', email: 'operator@example.test'};
      return true;
    },
    kvReady: () => true,
    readActive: async () => artifacts.pointer,
    readArtifacts: async () => artifacts,
    readDecision: async () => Object.hasOwn(options, 'decision') ? options.decision : oldDecision,
    readAck: async () => Object.hasOwn(options, 'ack') ? options.ack : oldAck,
    writeDecision: async (...args) => { saved.push(args); return options.writeResult ?? true; },
    now: () => '2026-09-06T12:00:00.000Z',
  });
  const body = {
    key: KEY, action: 'interview', requestId: NEXT, retryOfRequestId: OLD,
    generationId: artifacts.pointer.generationId, generationDigest: artifacts.pointer.digest,
    inputRevision: row.inputRevision, readinessRevision: row.readinessRevision,
    decisionRevision: row.decisionRevision,
  };
  return {saved, body, async call(patch={}) {
    const res = {statusCode: 200, setHeader() {}, status(code) { this.statusCode = code; return this; },
      json(value) { this.body = value; return this; }};
    await handler({method: 'POST', body: {...body, ...patch}}, res);
    return res;
  }};
}

test('a source-stale request becomes a fresh human request only after a newer publication and input revision', async () => {
  const h = harness();
  const res = await h.call({by: 'forged@example.test', actorType: 'rule'});
  assert.equal(res.statusCode, 202);
  assert.equal(h.saved.length, 1);
  const [key, record, options] = h.saved[0];
  assert.equal(key, KEY);
  assert.equal(record.actorType, 'human');
  assert.equal(record.actorId, 'operator@example.test');
  assert.equal(record.authorizedBy, 'operator@example.test');
  assert.equal(record.inputRevision, CURRENT_INPUT);
  assert.deepEqual(record.recovery, {
    kind: 'source_revision_retry',
    previousRequestId: OLD,
    failureReason: SOURCE_STALE_INTERVIEW_FAILURE,
    previousActorType: 'human',
    previousActorId: 'original@example.test',
    previousDecisionAt: DECISION_AT,
    previousRuleRunId: null,
    previousInputRevision: PREVIOUS_INPUT,
    currentInputRevision: CURRENT_INPUT,
    sourcePublicationAt: PUBLICATION_AT,
  });
  assert.deepEqual(options, {
    retryOfRequestId: OLD,
    retryFailureReason: SOURCE_STALE_INTERVIEW_FAILURE,
    rejectSentAck: true,
    retryCurrentInputRevision: CURRENT_INPUT,
    retryPublicationAt: PUBLICATION_AT,
    retryPreviousInputRevision: PREVIOUS_INPUT,
    retryDecisionAt: DECISION_AT,
    retryAckAt: ACK_AT,
  });
});

test('typed and legacy human/rule provenance are accepted; migration and missing provenance are not', async () => {
  for (const decision of [
    {...oldDecision, actorType: 'human'},
    {...oldDecision, actorType: 'rule', actorId: 'rule-current', by: 'rule:current'},
    {...oldDecision, actorType: undefined, actorId: undefined, by: 'legacy@example.test'},
    {...oldDecision, actorType: undefined, actorId: undefined, by: 'rule:legacy'},
  ]) {
    const h = harness({decision});
    assert.equal((await h.call()).statusCode, 202, JSON.stringify(decision));
  }
  for (const decision of [
    {...oldDecision, actorType: 'migration'},
    {...oldDecision, actorType: undefined, actorId: undefined, by: ''},
  ]) {
    const h = harness({decision});
    assert.equal((await h.call()).statusCode, 409, JSON.stringify(decision));
    assert.equal(h.saved.length, 0);
  }
});

test('same or missing source revisions and non-fresh publication evidence fail closed', async () => {
  for (const {options, status=409, error='interview_retry_unavailable'} of [
    {options: {row: {inputRevision: PREVIOUS_INPUT}}},
    {options: {row: {inputRevision: ''}}, error: 'applicant_changed_refresh_required'},
    {options: {decision: {...oldDecision, inputRevision: ''}}},
    {options: {snapshotGeneratedAt: null}},
    {options: {snapshotGeneratedAt: ACK_AT}},
    {options: {snapshotGeneratedAt: DECISION_AT}},
    {options: {snapshotGeneratedAt: 'invalid'}},
    {options: {snapshotGeneratedAt: '2026-09-05T20:03:00Z'}},
    {options: {queueGeneratedAt: '2026-09-05T20:04:00.000Z'}, status: 503, error: 'generation_unavailable'},
    {options: {ack: {...oldAck, at: null}}},
    {options: {decision: {...oldDecision, at: null}}},
  ]) {
    const h = harness(options);
    const res = await h.call();
    assert.equal(res.statusCode, status, JSON.stringify(options));
    assert.equal(res.body.error, error);
    assert.equal(h.saved.length, 0);
  }
});

test('matching ack, current actionability and prior-send gates remain mandatory', async () => {
  for (const options of [
    {ack: {...oldAck, requestId: 'different-old-request'}},
    {ack: {...oldAck, status: 'invited'}},
    {ack: {...oldAck, reason: 'provider_timeout'}},
    {row: {hardHoldCode: 'identity_conflict'}},
    {row: {externalPriorSendAt: '2026-09-01T10:00:00.000Z'}},
    {row: {status: 'emailed'}},
  ]) {
    const h = harness(options);
    const res = await h.call();
    assert.equal(res.statusCode, 409, JSON.stringify(options));
    assert.equal(h.saved.length, 0);
  }
});

test('the atomic write contract receives exact old and current source evidence and rejects invalid options before KV', async () => {
  let command = null;
  const record = {action: 'interview', requestId: NEXT, inputRevision: CURRENT_INPUT, recovery: {
    kind: 'source_revision_retry',
    previousRequestId: OLD,
    failureReason: SOURCE_STALE_INTERVIEW_FAILURE,
    previousInputRevision: PREVIOUS_INPUT,
    currentInputRevision: CURRENT_INPUT,
    sourcePublicationAt: PUBLICATION_AT,
  }};
  const result = await saveApplicantRequest(KEY, record, {
    allowRejected: true,
    rejectSentAck: true,
    retryOfRequestId: OLD,
    retryFailureReason: SOURCE_STALE_INTERVIEW_FAILURE,
    retryCurrentInputRevision: CURRENT_INPUT,
    retryPublicationAt: PUBLICATION_AT,
    retryPreviousInputRevision: PREVIOUS_INPUT,
    retryDecisionAt: DECISION_AT,
    retryAckAt: ACK_AT,
    kvImpl: async (value) => { command = value; return 1; },
  });
  assert.equal(result, true);
  assert.deepEqual(command.slice(-7), [
    OLD, SOURCE_STALE_INTERVIEW_FAILURE, CURRENT_INPUT, PUBLICATION_AT,
    PREVIOUS_INPUT, DECISION_AT, ACK_AT,
  ]);

  for (const patch of [
    {retryCurrentInputRevision: PREVIOUS_INPUT},
    {retryPreviousInputRevision: CURRENT_INPUT},
    {retryPublicationAt: ACK_AT},
    {retryDecisionAt: null},
    {retryAckAt: null},
    {record: {...record, recovery: {...record.recovery, previousRequestId: 'wrong-request'}}},
  ]) {
    let called = false;
    const accepted = await saveApplicantRequest(KEY, patch.record || record, {
      retryOfRequestId: OLD,
      retryFailureReason: SOURCE_STALE_INTERVIEW_FAILURE,
      retryCurrentInputRevision: CURRENT_INPUT,
      retryPublicationAt: PUBLICATION_AT,
      retryPreviousInputRevision: PREVIOUS_INPUT,
      retryDecisionAt: DECISION_AT,
      retryAckAt: ACK_AT,
      ...patch,
      kvImpl: async () => { called = true; return 1; },
    });
    assert.equal(accepted, false, JSON.stringify(patch));
    assert.equal(called, false);
  }
});

// Optional local integration: execute the exact Redis Lua against a disposable
// in-memory hash simulator. Set APPLICANT_LUA_TEST_PYTHON to a Python
// interpreter containing lupa. No production Redis is used.
const LUA_HARNESS = String.raw`
import json,sys
from lupa import LuaRuntime
data=json.load(sys.stdin)
lua=LuaRuntime(unpack_returned_tuples=True)
state=data['state']
writes=[]
def decode(raw):
  value=json.loads(raw)
  return lua.table_from(value,recursive=True) if isinstance(value,(dict,list)) else value
def redis_call(op,key,field,*args):
  if op=='HGET': return state.get(key,{}).get(field)
  if op=='HSET':
    state.setdefault(key,{})[field]=args[0]
    writes.append([key,field])
    return 1
  raise ValueError(op)
lua.globals().cjson=lua.table_from({'decode':decode})
lua.globals().redis=lua.table_from({'call':redis_call})
results=[]
for command in data['commands']:
  n=command[2]
  lua.globals().KEYS=lua.table_from(command[3:3+n])
  lua.globals().ARGV=lua.table_from(command[3+n:])
  results.append(lua.execute(command[1]))
json.dump({'results':results,'state':state,'writes':writes},sys.stdout)
`;

async function sourceRetryCommand() {
  let command;
  const record = {
    action: 'interview', requestId: NEXT, inputRevision: CURRENT_INPUT,
    recovery: {
      kind: 'source_revision_retry', previousRequestId: OLD,
      failureReason: SOURCE_STALE_INTERVIEW_FAILURE,
      previousInputRevision: PREVIOUS_INPUT, currentInputRevision: CURRENT_INPUT,
      sourcePublicationAt: PUBLICATION_AT,
    },
  };
  const saved = await saveApplicantRequest(KEY, record, {
    allowRejected: true,
    rejectSentAck: true,
    retryOfRequestId: OLD,
    retryFailureReason: SOURCE_STALE_INTERVIEW_FAILURE,
    retryCurrentInputRevision: CURRENT_INPUT,
    retryPublicationAt: PUBLICATION_AT,
    retryPreviousInputRevision: PREVIOUS_INPUT,
    retryDecisionAt: DECISION_AT,
    retryAckAt: ACK_AT,
    kvImpl: async (value) => { command = value; return 1; },
  });
  assert.equal(saved, true);
  return command;
}

test('source-stale atomic Lua accepts supported provenance and rejects stale evidence races',
  {skip: !process.env.APPLICANT_LUA_TEST_PYTHON}, async () => {
    const command = await sourceRetryCommand();
    const execute = (decision, ack, commands=[command]) => {
      const state = {'apphub:decisions': {}, 'apphub:acks': {}};
      if (decision) state['apphub:decisions'][KEY] = JSON.stringify(decision);
      if (ack) state['apphub:acks'][KEY] = JSON.stringify(ack);
      const out = spawnSync(process.env.APPLICANT_LUA_TEST_PYTHON, ['-c', LUA_HARNESS], {
        input: JSON.stringify({state, commands}), encoding: 'utf8',
      });
      assert.equal(out.status, 0, out.stderr);
      return JSON.parse(out.stdout);
    };

    for (const decision of [
      oldDecision,
      {...oldDecision, actorType: 'rule', actorId: 'rule-current', by: 'rule:current'},
      {...oldDecision, actorType: undefined, actorId: undefined, by: 'legacy@example.test'},
      {...oldDecision, actorType: undefined, actorId: undefined, by: 'rule:legacy'},
    ]) {
      const result = execute(decision, oldAck);
      assert.deepEqual(result.results, [1], JSON.stringify(decision));
      assert.equal(result.writes.length, 1);
    }

    const repeated = execute(oldDecision, oldAck, [command, command]);
    assert.deepEqual(repeated.results, [1, 1]);
    assert.equal(repeated.writes.length, 1);

    const publicationNotNewer = structuredClone(command);
    publicationNotNewer[13] = ACK_AT;
    const replacement = JSON.parse(publicationNotNewer[6]);
    replacement.recovery.sourcePublicationAt = ACK_AT;
    publicationNotNewer[6] = JSON.stringify(replacement);

    for (const [decision, ack, commands] of [
      [{...oldDecision, actorType: 'migration'}, oldAck],
      [{...oldDecision, inputRevision: CURRENT_INPUT}, oldAck],
      [oldDecision, oldAck, [publicationNotNewer]],
      [{...oldDecision, requestId: 'changed-old-request'}, oldAck],
      [oldDecision, {...oldAck, requestId: 'changed-old-request'}],
      [{...oldDecision, inputRevision: 'changed-old-input'}, oldAck],
      [{...oldDecision, at: '2026-09-05T20:00:01.000Z'}, oldAck],
      [oldDecision, {...oldAck, at: '2026-09-05T20:02:01.000Z'}],
    ]) {
      const result = execute(decision, ack, commands);
      assert.deepEqual(result.results, [0]);
      assert.equal(result.writes.length, 0);
    }
  });
