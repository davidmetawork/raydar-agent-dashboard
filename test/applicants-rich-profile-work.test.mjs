import test from 'node:test';
import assert from 'node:assert/strict';
import { richProfileWork } from '../api/applicants/_lib/rich-profile-work.mjs';
import { createSyncHandler } from '../api/applicants/sync.mjs';
import { K } from '../api/applicants/_lib/kv.mjs';
import { normalizeRichProfile, richCardFromProfile } from '../api/applicants/_lib/rich-profile.mjs';
import { publishInto, sourceReceiptsFor } from './helpers/applicant-generation.mjs';

const AT = '2026-09-07T18:00:00.000Z';
const row = id => ({ key: `application${id}:role000000001`, profileKey: `core:application00000000000000${id}`,
  sourceObservationId: `source-${id}`, richProfileBinding: {
    sourceObservationId: `source-${id}`, candidateUserId: `candidate-${id}`, connectionReceiptId: `receipt-${id}`,
  } });
const card = r => richCardFromProfile(normalizeRichProfile({ ...r.richProfileBinding,
  profileEnrichedAt: AT, experiences: [{ companyId: 'company-one', companyName: 'Example', roleTitle: 'Engineer', talentRank: 'A',
    logo: 'https://storage.googleapis.com/paraform-company-logo-urls/company-logos/example.png' }], education: [] }, { cachedAt: AT }));
const ready = cards => Object.fromEntries(Object.entries(cards).map(([key, value]) => [key, {
  source: 'paraform', sourceObservationId: value.sourceObservationId,
  candidateUserId: value.candidateUserId, connectionReceiptId: value.connectionReceiptId,
  profileEnrichedAt: value.profileEnrichedAt, richProfileRetainedUntil: value.richProfileRetainedUntil,
}]));

test('the whole published cohort reconciles without counting missing evidence as success', () => {
  const queue = Array.from({ length: 8 }, (_, i) => row(i + 1));
  delete queue[0].richProfileBinding;
  const receipts = sourceReceiptsFor(queue);
  delete receipts[queue[1].profileKey];
  const cards = Object.fromEntries(queue.slice(3).map(r => [r.profileKey, card(r)]));
  cards[queue[3].profileKey].candidateUserId = 'wrong-person';
  cards[queue[4].profileKey].richProfileRetainedUntil = AT;
  cards[queue[5].profileKey].exp = [];
  const report = richProfileWork({ queue, profilePreparing: [{ profileKey: 'preparing-one' }] }, receipts, cards, ready(cards), { now: Date.parse(AT) });
  assert.deepEqual(report.counts, { total: 8, profilePreparing: 1, totalIncludingPreparing: 9, bound: 6, unbound: 1, sourceUnavailable: 1,
    available: 3, missing: 1, bindingMismatch: 1, expired: 1, withHistory: 2, sparse: 1, withLogos: 2, withRatings: 2 });
  assert.equal(report.bindings.length, 6);
  assert.deepEqual(report.repairProfileKeys, queue.slice(2, 5).map(item => item.profileKey));
  assert.equal(report.counts.total, report.counts.bound + report.counts.unbound + report.counts.sourceUnavailable);
  assert.equal(report.counts.bound, report.counts.available + report.counts.missing + report.counts.bindingMismatch + report.counts.expired);
  assert.equal(report.repairProfileKeys.length, report.counts.missing + report.counts.bindingMismatch + report.counts.expired);
});

test('conflicting application bindings and changed source receipts cannot become work', () => {
  const first = row(1);
  const conflict = { ...first, richProfileBinding: { ...first.richProfileBinding, candidateUserId: 'other' } };
  const sourceMismatch = row(2);
  const receipts = sourceReceiptsFor([first, sourceMismatch]);
  receipts[sourceMismatch.profileKey].sourceObservationId = 'new-observation';
  const result = richProfileWork({ queue: [first, conflict, sourceMismatch] }, receipts, {}, {}, { now: Date.parse(AT) });
  assert.equal(result.counts.total, 2);
  assert.equal(result.counts.unbound, 1);
  assert.equal(result.counts.sourceUnavailable, 1);
  assert.deepEqual(result.bindings, []);
});

test('an expiring legacy receipt cannot substitute for durable source authority', () => {
  const selected = row(1);
  for (const receipt of [
    { source: 'applicant_hub', sourceObservationId: selected.sourceObservationId, expiresAt: '2026-10-01T00:00:00Z' },
    { source: 'paraform', durable: true, historyState: 'data', sourceObservationId: selected.sourceObservationId },
    { source: 'applicant_hub', durable: false, historyState: 'data', sourceObservationId: selected.sourceObservationId },
  ]) {
    const result = richProfileWork({ queue: [selected] }, { [selected.profileKey]: receipt }, {}, {}, { now: Date.parse(AT) });
    assert.equal(result.counts.sourceUnavailable, 1);
    assert.deepEqual(result.bindings, []);
  }
});

test('a partial card write without its exact completion receipt is never available', () => {
  const selected = row(1);
  const sourceReceipts = sourceReceiptsFor([selected]);
  const cards = { [selected.profileKey]: card(selected) };
  const report = receipts => richProfileWork({ queue: [selected] }, sourceReceipts, cards, receipts, { now: Date.parse(AT) });
  assert.equal(report({}).counts.missing, 1);
  assert.deepEqual(report({}).repairProfileKeys, [selected.profileKey]);
  for (const field of ['candidateUserId', 'sourceObservationId', 'connectionReceiptId', 'profileEnrichedAt', 'richProfileRetainedUntil']) {
    const receipts = ready(cards);
    receipts[selected.profileKey][field] = 'different';
    assert.equal(report(receipts).counts.bindingMismatch, 1, field);
    assert.equal(report(receipts).counts.available, 0, field);
    assert.deepEqual(report(receipts).repairProfileKeys, [selected.profileKey], field);
  }
  assert.equal(report(ready(cards)).counts.available, 1);
  assert.deepEqual(report(ready(cards)).repairProfileKeys, []);
});

test('an old fresh completion receipt repairs only its partial write', () => {
  const partial = row(1);
  const healthy = row(2);
  const queue = [partial, healthy];
  const cards = Object.fromEntries(queue.map(item => [item.profileKey, card(item)]));
  const receipts = ready(cards);
  receipts[partial.profileKey].profileEnrichedAt = '2026-09-06T18:00:00.000Z';

  const report = richProfileWork({ queue }, sourceReceiptsFor(queue), cards, receipts, { now: Date.parse(AT) });
  assert.equal(report.counts.bindingMismatch, 1);
  assert.equal(report.counts.available, 1);
  assert.deepEqual(report.repairProfileKeys, [partial.profileKey]);
  assert.equal(report.repairProfileKeys.length, report.counts.missing + report.counts.bindingMismatch + report.counts.expired);
  assert.ok(report.bindings.some(binding => binding.profileKey === report.repairProfileKeys[0]));
  assert.equal(report.repairProfileKeys.includes(healthy.profileKey), false);
});

const secret = 'synthetic-profile-maintenance-key';
const savedKey = process.env.APPHUB_SYNC_KEY;
test.before(() => { process.env.APPHUB_SYNC_KEY = secret; });
test.after(() => { if (savedKey === undefined) delete process.env.APPHUB_SYNC_KEY; else process.env.APPHUB_SYNC_KEY = savedKey; });
function fixture() {
  const queue = [row(1)];
  const state = { [K.sourceProfileReady]: sourceReceiptsFor(queue), [K.richCards]: {} };
  publishInto(state, { snapshot: { generatedAt: AT, stream: [] }, queue });
  const reads = [];
  const deps = { kvReady: () => true, now: () => AT,
    readJson: async key => { reads.push(key); return state[key] ?? null; },
    readHash: async key => { reads.push(key); return state[key] ?? {}; },
    writeJson: async () => assert.fail('no writes'), writeHash: async () => assert.fail('no writes'),
    activateGeneration: async () => assert.fail('no generation writes'),
  };
  return { queue, state, reads, deps };
}
async function get(f, headers = { authorization: `Bearer ${secret}` }) {
  const res = { setHeader() {}, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
  await createSyncHandler(f.deps)({ method: 'GET', query: { richProfileWork: '1' }, headers }, res);
  return res;
}

test('authenticated work read uses current generation and never reads decisions or sends', async () => {
  const f = fixture();
  const response = await get(f);
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.generation.generationId, f.state[K.activeGeneration].generationId);
  assert.equal(response.body.observedAt, AT);
  assert.equal(response.body.counts.missing, 1);
  assert.deepEqual(response.body.repairProfileKeys, [f.queue[0].profileKey]);
  assert.deepEqual(response.body.bindings[0], { profileKey: f.queue[0].profileKey, ...f.queue[0].richProfileBinding });
  assert.equal(f.reads.includes(K.decisions), false);
  assert.equal(f.reads.includes(K.acks), false);
});

test('unauthenticated, absent publication, store failure and generation race fail closed', async () => {
  const f = fixture();
  assert.equal((await get(f, {})).statusCode, 401);
  assert.equal(f.reads.length, 0);
  delete f.state[K.activeGeneration];
  assert.equal((await get(f)).statusCode, 503);
  const failure = fixture();
  failure.deps.readHash = async () => { throw new Error('store unavailable'); };
  assert.equal((await get(failure)).statusCode, 502);
  const malformed = fixture();
  malformed.deps.readHash = async () => null;
  assert.equal((await get(malformed)).statusCode, 503);
  const changed = fixture();
  changed.deps.readHash = async key => {
    changed.state[K.activeGeneration] = { ...changed.state[K.activeGeneration], generationId: 'changed' };
    return changed.state[key] ?? {};
  };
  assert.equal((await get(changed)).statusCode, 409);
});
