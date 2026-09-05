import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";

import { runMigrations } from "../scripts/migrate-submissions-v2.mjs";
import { createDatabase } from "../api/submissions-v2/_lib/db.mjs";
import { createResumePipelineStore } from "../api/submissions-v2/_lib/resume/pipeline-store.mjs";
import { candidateOriginalExtractionRecord } from "../api/submissions-v2/_lib/resume/candidate-original-reuse.mjs";
import { sha256 } from "../api/submissions-v2/_lib/resume/source-bundle.mjs";

const databaseUrl = process.env.SUBMISSIONS_V2_CACHE_TEST_DATABASE_URL || process.env.SUBMISSIONS_V2_TEST_DATABASE_URL || "";
const env = { SUBMISSIONS_V2_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64") };
const digest = (value) => createHash("sha256").update(String(value)).digest("hex");
let sql;

before(async () => { if(!databaseUrl)return;await runMigrations({databaseUrl,logger:{info(){}}});sql = createDatabase({ databaseUrl, max: 2 }); });
after(async () => { await sql?.end({ timeout: 5 }); });

test("encrypted candidate-original cache reads only an unexpired exact source tuple and purges independently", {skip:!databaseUrl}, async () => {
  const store = createResumePipelineStore({ sql, env });
  const candidate = `cache-candidate-${randomUUID()}`;
  const identity = { candidate_id: candidate, source_id: "resume-1", source_locator: `paraform:candidate:${candidate}:resume`, content_digest: sha256("original bytes") };
  const record = candidateOriginalExtractionRecord(identity, { text: "Candidate original work history", pageCount: 2 }, { capturedAt: new Date(Date.now()-60_000).toISOString() });
  await store.candidateOriginalExtractionCache.save(record);
  const raw = (await sql`select normalized_text_encrypted from submissions_v2.candidate_original_extraction_cache where candidate_user_id=${candidate}`)[0];
  assert.equal(Buffer.from(raw.normalized_text_encrypted).includes(Buffer.from("Candidate original work history")), false);
  assert.equal((await store.candidateOriginalExtractionCache.load(identity)).normalized_text, "Candidate original work history");
  assert.equal(await store.candidateOriginalExtractionCache.load({ ...identity, content_digest: "0".repeat(64) }), null);
  await sql`update submissions_v2.candidate_original_extraction_cache set expires_at=clock_timestamp() - interval '1 second' where candidate_user_id=${candidate}`;
  assert.equal(await store.candidateOriginalExtractionCache.load(identity), null);
  assert.equal(await store.purgeExpiredCandidateOriginalExtractions({ limit: 10 }), 1);
});

test("OCR reservations are durable before provider work, replay unknown, and keep the reserved job spend", {skip:!databaseUrl}, async () => {
  const store = createResumePipelineStore({ sql, env });
  const candidate = `cost-candidate-${randomUUID()}`;
  const role = `cost-role-${randomUUID()}`;
  const sourceId = randomUUID();
  const pairId = randomUUID();
  const jobId = randomUUID();
  const generationId = randomUUID();
  const controls = (await sql`
    update submissions_v2.runtime_controls
       set generation_enabled=true, control_epoch=control_epoch+1
     returning control_epoch
  `)[0];
  const epoch = Number(controls.control_epoch);
  await sql`
    insert into submissions_v2.source_events(id, source_family, source_version, event_id, received_at, content_digest, idempotency_key, envelope)
    values (${sourceId}, 'manual', 'manual.v1', ${`cache-event-${sourceId}`}, clock_timestamp(), ${digest(sourceId)}, ${`cache-source-${sourceId}`}, '{}'::jsonb)
  `;
  await sql`
    insert into submissions_v2.candidate_role_pairs(id, candidate_user_id, role_id, first_signal_id, intent_state, workflow_state, original_signal_at)
    values (${pairId}, ${candidate}, ${role}, ${sourceId}, 'interested', 'preparing_resume', clock_timestamp())
  `;
  await sql`
    insert into submissions_v2.jobs(id, kind, subject_type, subject_id, idempotency_key, required_control, control_epoch, state, lease_owner, lease_expires_at, fencing_token, attempt_count, started_at)
    values (${jobId}, 'prepare_resume', 'pair', ${pairId}, ${`cache-job-${jobId}`}, 'generation', ${epoch}, 'running', 'cache-worker', clock_timestamp() + interval '2 minutes', 1, 1, clock_timestamp())
  `;
  await sql`
    insert into submissions_v2.resume_generations(id, pair_id, generation_version, trigger_kind, idempotency_key, status, stage, expected_pair_version, first_signal_id, primary_model_pin, fallback_model_pin, validator_model_pin, prompt_pin, template_pin, deadline_at)
    values (${generationId}, ${pairId}, 1, 'initial', ${`cache-generation-${generationId}`}, 'extracting', 'evidence', 1, ${sourceId}, 'primary', 'fallback', 'validator', 'prompt', 'template', clock_timestamp() + interval '5 minutes')
  `;
  const fence = { jobId, workerId: "cache-worker", fencingToken: 1, controlEpoch: epoch };
  const ocrStage = `supplement_ocr:${randomUUID()}`;
  const ocrInputDigest = digest("exact supplement image bytes and prompt");
  const firstReservation = await store.reserveModelStage({ generationId, stage: ocrStage, attempt: 1, inputDigest: ocrInputDigest, reservedCents: 61, executionFence: fence });
  assert.equal(firstReservation.replay, false);
  let charge = (await sql`select reserved_cents, actual_cents, charge_outcome from submissions_v2.resume_stage_runs where generation_id=${generationId} and stage=${ocrStage}`)[0];
  assert.deepEqual({ reserved: charge.reserved_cents, actual: charge.actual_cents, outcome: charge.charge_outcome }, { reserved: 61, actual: null, outcome: "reserved" });
  assert.equal((await sql`select spent_cents from submissions_v2.resume_generations where id=${generationId}`)[0].spent_cents, 61);
  const replay = await store.reserveModelStage({ generationId, stage: ocrStage, attempt: 1, inputDigest: ocrInputDigest, reservedCents: 61, executionFence: fence });
  assert.equal(replay.replay, true);
  assert.equal(replay.charge_outcome, "unknown");
  assert.equal((await sql`select spent_cents from submissions_v2.resume_generations where id=${generationId}`)[0].spent_cents, 61);
  await assert.rejects(
    () => store.reserveModelStage({ generationId, stage: ocrStage, attempt: 1, inputDigest: digest("different supplement bytes"), reservedCents: 61, executionFence: fence }),
    (error) => error.code === "model_stage_input_conflict",
  );
  await store.settleModelStage({ generationId, stage: ocrStage, attempt: 1, actualCents: null, executionFence: fence });
  charge = (await sql`select reserved_cents, actual_cents, charge_outcome from submissions_v2.resume_stage_runs where generation_id=${generationId} and stage=${ocrStage}`)[0];
  assert.deepEqual({ reserved: charge.reserved_cents, actual: charge.actual_cents, outcome: charge.charge_outcome }, { reserved: 61, actual: null, outcome: "unknown" });
  await store.reserveModelStage({ generationId, stage: "validate", attempt: 1, inputDigest: digest("validate"), reservedCents: 80, executionFence: fence });
  await store.settleModelStage({ generationId, stage: "validate", attempt: 1, actualCents: 7, executionFence: fence });
  const validateId = (await sql`select id from submissions_v2.resume_stage_runs where generation_id=${generationId} and stage='validate'`)[0].id;
  await store.recordStage({
    generationId,
    stage: "validate",
    attempt: 1,
    inputDigest: digest("validate"),
    status: "succeeded",
    costCents: 80,
    actualCents: 7,
    executionFence: fence,
  });
  charge = (await sql`select reserved_cents, actual_cents, charge_outcome from submissions_v2.resume_stage_runs where generation_id=${generationId} and stage='validate'`)[0];
  assert.deepEqual({ reserved: charge.reserved_cents, actual: charge.actual_cents, outcome: charge.charge_outcome }, { reserved: 80, actual: 7, outcome: "settled" });
  assert.equal((await sql`select id from submissions_v2.resume_stage_runs where generation_id=${generationId} and stage='validate'`)[0].id, validateId);
  assert.equal((await sql`select spent_cents from submissions_v2.resume_generations where id=${generationId}`)[0].spent_cents, 141);
});
