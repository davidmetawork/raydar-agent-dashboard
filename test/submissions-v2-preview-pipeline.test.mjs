import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { createDatabase } from "../api/submissions-v2/_lib/db.mjs";
import { createPreviewRuntime } from "../submissions-preview/runtime.mjs";
import { previewProviderInternals } from "../submissions-preview/providers.mjs";

const databaseUrl = String(process.env.SUBMISSIONS_V2_PREVIEW_PIPELINE_TEST_DATABASE_URL || "").trim();
let stateRoot;
let runtime;

const key = () => randomBytes(40).toString("base64url");

async function drain(maximum = 16) {
  for (let index = 0; index < maximum; index += 1) {
    await runtime.cycle();
    const active = await runtime.sql`
      select count(*)::integer as count from submissions_v2.jobs
       where state in ('queued','running') and scheduled_at <= clock_timestamp()
         and attempt_count < max_attempts
    `;
    if (Number(active[0]?.count || 0) === 0) return;
  }
  assert.fail(`Preview worker did not drain its bounded queue in ${maximum} cycles.`);
}

before(async () => {
  if (!databaseUrl) return;
  let target;
  try { target = new URL(databaseUrl); }
  catch { throw new Error("Preview pipeline tests require their exact isolated loopback database URL."); }
  if (!new Set(["postgres:", "postgresql:"]).has(target.protocol)
    || target.hostname !== "127.0.0.1" || target.port !== "55439"
    || target.username !== "submissions_dev" || target.pathname !== "/submissions_preview_pipeline_test"
    || target.password || target.search || target.hash) {
    throw new Error("Preview pipeline tests require submissions_dev@127.0.0.1:55439/submissions_preview_pipeline_test.");
  }
  const reset = createDatabase({ databaseUrl, max: 1 });
  try { await reset.unsafe("drop schema if exists submissions_v2 cascade; drop schema if exists preview cascade;"); }
  finally { await reset.end({ timeout: 5 }); }
  stateRoot = await mkdtemp(join(tmpdir(), "submissions-preview-pipeline-"));
  const encryption = randomBytes(32).toString("base64url");
  const download = key();
  const ingest = key();
  runtime = await createPreviewRuntime({
    marker: "raydar-submissions-rebuild-local-v1",
    databaseUrl,
    stateRoot,
    rendererOrigin: "http://127.0.0.1:4527",
    env: {
      SUBMISSIONS_V2_DATABASE_URL: databaseUrl,
      SUBMISSIONS_V2_ENCRYPTION_KEY: encryption,
      SUBMISSIONS_V2_DOWNLOAD_SECRET: download,
      SUBMISSIONS_V2_UPLOAD_SECRET: download,
      SUBMISSIONS_V2_RETENTION_HMAC_KEY: download,
      SUBMISSIONS_V2_INGEST_KEY: ingest,
      SUBMISSIONS_V2_UI_ENABLED: "true",
      SUBMISSIONS_V2_INGESTION_ENABLED: "true",
      SUBMISSIONS_V2_GENERATION_ENABLED: "true",
      SUBMISSIONS_V2_MASTER_INBOX_ENABLED: "true",
      SUBMISSIONS_V2_CURATED_ENABLED: "true",
      SUBMISSIONS_V2_SLACK_CHANNEL_ID: "C0123456789",
    },
  });
});

after(async () => {
  await runtime?.close();
  if (stateRoot) await rm(stateRoot, { recursive: true, force: true });
});

test("synthetic classification keeps decisive and question replies on their expected paths", () => {
  const role = [{ role_id: "preview-platform", company: "Example Cloud", title: "Platform Engineer" }];
  const positive = previewProviderInternals.classificationFor({
    candidate_authored_text: "Yes, I am interested.", offered_roles: role,
  });
  const negative = previewProviderInternals.classificationFor({
    candidate_authored_text: "No thank you.", offered_roles: role,
  });
  const question = previewProviderInternals.classificationFor({
    candidate_authored_text: "What is the salary range?", offered_roles: role,
  });
  assert.equal(positive.decisions[0].label, "interested");
  assert.equal(negative.decisions[0].label, "not_interested");
  assert.equal(question.decisions[0].label, "needs_review");
  assert.equal(question.decisions[0].review_reason, "candidate_question");
  assert.equal(positive.attempts[0].model, "preview-deterministic-v1");
});

test("the isolated preview drives a positive reply through the real resume pipeline and native renderer", {
  timeout: 120_000,
  skip: !databaseUrl && "SUBMISSIONS_V2_PREVIEW_PIPELINE_TEST_DATABASE_URL is required",
}, async () => {
  const accepted = await runtime.scenarios.reply("positive");
  assert.equal(accepted.accepted, true);
  await drain();

  const pairs = await runtime.sql`
    select * from submissions_v2.candidate_role_pairs
     where candidate_user_id='preview-ada' and role_id='preview-platform'
  `;
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].workflow_state, "interested");
  assert.equal(pairs[0].resume_ready_at instanceof Date, true);
  assert.ok(pairs[0].current_artifact_id);

  const generation = (await runtime.sql`
    select * from submissions_v2.resume_generations where pair_id=${pairs[0].id}
     order by generation_version desc limit 1
  `)[0];
  assert.equal(generation.status, "succeeded");
  assert.equal(generation.stage, "complete");
  const artifacts = await runtime.sql`
    select kind,private_object_key,validation_status,archive_readback_at,current_state
      from submissions_v2.resume_artifacts where generation_id=${generation.id} order by kind
  `;
  assert.deepEqual(artifacts.map((row) => row.kind), ["ats", "manifest", "pdf"]);
  assert.ok(artifacts.every((row) => row.validation_status === "passed" && row.archive_readback_at instanceof Date));
  assert.equal(artifacts.find((row) => row.kind === "pdf").current_state, "current");
  const pdf = await runtime.blobs.readPrivateObject(artifacts.find((row) => row.kind === "pdf").private_object_key);
  assert.equal(pdf.bytes.subarray(0, 5).toString("ascii"), "%PDF-");

  const sources = await runtime.sql`
    select source_key,status,origin from submissions_v2.resume_sources
     where generation_id=${generation.id} order by source_key
  `;
  const original = sources.find((row) => row.source_key === "candidate_original_resume");
  assert.deepEqual(original, { source_key: "candidate_original_resume", status: "present", origin: "candidate_original" });

  const proof = await runtime.scenarios.prove(pairs[0].id, `preview-proof-${randomUUID()}`);
  assert.equal(proof.proof.applicationId, `preview-application-${pairs[0].id}`);
  await drain();
  const proven = (await runtime.sql`select * from submissions_v2.candidate_role_pairs where id=${pairs[0].id}`)[0];
  assert.equal(proven.submission_status, "proven");
  assert.equal(proven.submission_application_id, proof.proof.applicationId);
  assert.equal(proven.submission_authoritative_path, "preview.provider_state");
});

test("the Boolean failure flag fails safely inside the real pipeline and can be turned off", {
  timeout: 120_000,
  skip: !databaseUrl && "SUBMISSIONS_V2_PREVIEW_PIPELINE_TEST_DATABASE_URL is required",
}, async () => {
  const accepted = await runtime.scenarios.reply("failure");
  assert.equal(accepted.accepted, true);
  await drain();
  const pair = (await runtime.sql`
    select * from submissions_v2.candidate_role_pairs
     where candidate_user_id='preview-finn' and role_id='preview-platform'
  `)[0];
  assert.equal(pair.workflow_state, "needs_review");
  const review = (await runtime.sql`
    select * from submissions_v2.review_items
     where pair_id=${pair.id} and action_state='open' order by opened_at desc limit 1
  `)[0];
  assert.equal(review.reason_code, "resume_preparation_failed");
  assert.equal((await runtime.scenarios.state("fail_resume:preview-finn")), true);

  await runtime.scenarios.changeFailure("preview-finn", false);
  assert.equal((await runtime.scenarios.state("fail_resume:preview-finn")), false);
  const retry = await runtime.service.command({
    actorEmail: "preview@raydar.test",
    idempotencyKey: `preview-retry-${randomUUID()}`,
    body: { action: "retry_preparation", case_id: pair.id, expected_version: Number(pair.state_version) },
  });
  assert.ok(retry.job_id);
  await drain();
  const recovered = (await runtime.sql`select * from submissions_v2.candidate_role_pairs where id=${pair.id}`)[0];
  assert.equal(recovered.workflow_state, "interested");
  assert.ok(recovered.current_artifact_id);
});

test('missing original restoration recollects through Recheck and preparation retry without stale evidence', {
  timeout: 120_000,
  skip: !databaseUrl && 'SUBMISSIONS_V2_PREVIEW_PIPELINE_TEST_DATABASE_URL is required',
}, async () => {
  for (const [action, roleId] of [['recheck','preview-platform'],['retry_preparation','preview-product']]) {
    await runtime.scenarios.changeOriginal('preview-eli', true);
    await runtime.service.command({actorEmail:'preview@raydar.test',idempotencyKey:`preview-missing-${randomUUID()}`,
      body:{action:'add_candidate',candidate_id:'preview-eli',role_id:roleId}});
    await drain();
    const pair=(await runtime.sql`select * from submissions_v2.candidate_role_pairs where candidate_user_id='preview-eli' and role_id=${roleId}`)[0];
    assert.equal(pair.workflow_state,'needs_review');
    assert.equal(pair.current_artifact_id,null);
    const generation=(await runtime.sql`select * from submissions_v2.resume_generations where pair_id=${pair.id} order by generation_version desc limit 1`)[0];
    assert.equal(generation.spent_cents,0);
    await runtime.scenarios.changeOriginal('preview-eli', false);
    await runtime.service.command({actorEmail:'preview@raydar.test',idempotencyKey:`preview-original-restored-${randomUUID()}`,
      body:{action,case_id:pair.id,expected_version:Number(pair.state_version)}});
    await drain();
    const recovered=(await runtime.sql`select * from submissions_v2.candidate_role_pairs where id=${pair.id}`)[0];
    assert.equal(recovered.workflow_state,'interested',action);
    assert.ok(recovered.current_artifact_id);
    assert.equal((await runtime.sql`select count(*)::integer as count from submissions_v2.candidate_role_pairs where candidate_user_id='preview-eli' and role_id=${roleId}`)[0].count,1);
  }
});
