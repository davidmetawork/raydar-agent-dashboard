import assert from 'node:assert/strict';
import test from 'node:test';
import { runResumePreparation } from '../api/submissions-v2/_lib/resume/pipeline.mjs';
import { validateClaimsToCompletion } from '../api/submissions-v2/_lib/models/openai-validator.mjs';
import { ResumePipelineError, createGenerationBudget } from '../api/submissions-v2/_lib/resume/pipeline-runtime.mjs';

function fixture({ spent = 170, failWrite = false, failUsage = false, failure = null } = {}) {
  const at = Date.now();
  const nodes = Array.from({ length: 12 }, (_, i) => ({ id: `node-${i}`, text: `Fact ${i}`, claim_ids: [`c${i}`], emphasis: [] }));
  const values = {
    collect: { bundle: { schemaVersion: 'raydar.submissions-v2.source-bundle.v1', sourceDigest: 'fixture', readiness: { canGenerate: true }, sources: [] } },
    evidence: { ledger: { claims: nodes.map((n, i) => ({ claimId: `c${i}`, evidenceId: `e${i}`, sourceKey: 'candidate_original_resume', sourceId: 'resume', locator: `fixture:${i}`, quote: n.text, trustRank: 500 })) } },
    strategy: { strategy: { document: { candidate: { name: nodes[0], headline: nodes[1], contact: [] }, sections: [{ entries: [{ header: [], body: nodes.slice(2) }] }] } } },
  };
  const checkpoints = [];
  const writes = [];
  const fetches = [];
  let durable = spent;
  let priorSpend = 0;
  let generationAttempt = 1;
  let chargedWrites = 0;
  const ctx = { job: { id: 'job-fixture', subject_type: 'pair', subject_id: 'pair', attempt_count: 1, checkpoint: { pipeline: { stages: Object.fromEntries(Object.keys(values).map(stage => [stage, { key: stage, context: `resume-checkpoint:g:${stage}` }])) } } }, checkpoint: async value => checkpoints.push(structuredClone(value)) };
  const store = {
    loadPairContext: async () => ({ pair: { state_version: 1 }, supplements: [] }),
    startGeneration: async () => {
      if (ctx.job.attempt_count !== generationAttempt) {
        priorSpend += durable; durable = 0; generationAttempt = ctx.job.attempt_count;
      }
      return { id: generationAttempt === 1 ? 'g' : `g${generationAttempt}`, status: 'validating', deadline_at: new Date(at + 300000).toISOString(), budget_cents: 200 - priorSpend, spent_cents: durable, job_spent_cents: priorSpend };
    },
    saveCheckpoint: async ({ generationId, stage, value }) => ({ key: stage, context: `resume-checkpoint:${generationId}:${stage}`, value }),
    recordStage: async () => {},
    loadCheckpoint: async ref => values[ref.key],
    persistSources: async () => [], setGenerationDigests: async () => {},
    updateGeneration: async row => {
      writes.push(row.spentCents);
      if (row.spentCents !== spent) chargedWrites++;
      if ((failWrite && chargedWrites === 1) || (failUsage && chargedWrites === 2)) throw new Error('durable write failed');
      if (row.spentCents !== undefined) durable = row.spentCents;
    },
  };
  const run = () => runResumePreparation(ctx, {
    store, now: () => at, env: { SUBMISSIONS_V2_OPENAI_API_KEY: 'fixture-key' },
    validator: async (claims, options) => {
      await validateClaimsToCompletion(claims, { ...options, maxAttempts: 1, sleep: async () => {} });
      throw new ResumePipelineError('fixture_validated', 'Validation completed');
    },
    fetchImpl: async (_url, init) => {
      fetches.push(durable);
      assert.equal(checkpoints.at(-1).pipeline.spent_cents, durable, 'checkpoint and generation reservation precede fetch');
      await new Promise(resolve => setTimeout(resolve, 2));
      if (failure === 'network') throw new Error('network lost');
      if (failure === 'json') return { ok: true, json: async () => { throw new Error('bad JSON'); } };
      const body = JSON.parse(init.body);
      const claims = JSON.parse(body.input[1].content[0].text.match(/<UNTRUSTED_CLAIM_PACKETS_JSON>\n([\s\S]+)\n<\/UNTRUSTED_CLAIM_PACKETS_JSON>/u)[1]).claims;
      return { ok: true, json: async () => ({ usage: failure === 'usage' ? undefined : { input_tokens: 50, output_tokens: 20 }, output_text: JSON.stringify({ schema_version: 'raydar.resume.grounding-validation.v1', results: claims.map(c => ({ claim_id: c.id, verdict: 'supported', evidence_ids: [c.evidence[0].evidenceId], rewrite: null, reason_code: 'direct_support' })) }) }) };
    },
  });
  return { run, fetches, writes, ctx, get durable() { return priorSpend + durable; } };
}

test('actual pipeline waits at 170 cents for each 19-cent batch reservation and settles both at 172', { timeout: 2000 }, async () => {
  const f = fixture();
  await assert.rejects(f.run, e => e.code === 'fixture_validated');
  assert.deepEqual(f.fetches, [189, 190]);
  assert.equal(f.durable, 172);
});

test('queued reservations dispatch no fetch after durable reservation persistence fails', { timeout: 2000 }, async () => {
  const f = fixture({ spent: 0, failWrite: true });
  await assert.rejects(f.run);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(f.fetches.length, 0);
  assert.equal(f.durable, 0);
});

for (const failure of ['network', 'json', 'usage']) test(`actual pipeline releases waiting batches on ${failure} failure and retains crash reservation on automatic retry`, { timeout: 2000 }, async () => {
  const f = fixture({ failure });
  await assert.rejects(f.run);
  assert.equal(f.fetches.length, 1);
  assert.equal(f.durable, 189);
  f.ctx.job.attempt_count++;
  await assert.rejects(f.run);
  assert.equal(f.fetches.length, 1, 'automatic retry cannot forget uncertain provider spend');
  assert.equal(f.durable, 189);
});

test('usage persistence failure wakes a waiting batch without another provider fetch', { timeout: 2000 }, async () => {
  const f = fixture({ failUsage: true });
  await assert.rejects(f.run);
  assert.equal(f.fetches.length, 1);
  assert.equal(f.durable, 189);
});

test('overforecast ceiling remains sticky after another concurrent reservation refunds', () => {
  const budget = createGenerationBudget({ deadlineAt: 10000, spentCents: 170, now: () => 1 });
  const a = budget.reserveAttempt(10);
  const b = budget.reserveAttempt(10);
  budget.settleAttempt(a, 30);
  budget.settleAttempt(b, 1);
  assert.equal(budget.spentCents, 200);
  assert.throws(() => budget.reserveAttempt(1), e => e.code === 'generation_budget_exhausted');
});

test('cached stage cloning preserves a durable OCR reservation through a crash', async () => {
  let durable = 0;
  let pending = true;
  let ocrCalls = 0;
  const at = Date.now();
  const ctx = {
    job: { id: 'job-ocr', subject_type: 'pair', subject_id: 'pair', attempt_count: 2, checkpoint: { pipeline: { stages: { collect: { key: 'old', context: 'resume-checkpoint:old:collect' } } } } },
    checkpoint: async () => {},
  };
  const store = {
    loadPairContext: async () => ({ pair: { state_version: 1 }, pendingSupplements: pending ? [{}] : [] }),
    startGeneration: async () => ({ id: 'new', status: 'queued', deadline_at: new Date(at + 300000).toISOString(), spent_cents: 0, budget_cents: 200 }),
    updateGeneration: async ({ spentCents }) => { if (spentCents !== undefined) durable = spentCents; },
    loadCheckpoint: async () => ({ bundle: {} }),
    saveCheckpoint: async ({ value }) => ({ key: 'new', value }),
    recordStage: async () => {},
    persistSources: async () => { throw new ResumePipelineError('fixture_crash', 'Crash after clone'); },
  };
  await assert.rejects(() => runResumePreparation(ctx, {
    store, now: () => at,
    processSupplements: async (_items, { budget, onCostReserved }) => {
      budget.reserve(20);
      await onCostReserved();
      assert.equal(durable, 20, 'OCR reservation is durable before provider dispatch');
      ocrCalls++;
      pending = false;
    },
  }), e => e.code === 'fixture_crash');
  assert.equal(ocrCalls, 1);
  assert.equal(durable, 20, 'cloning an older checkpoint cannot erase charged OCR cost');
});
