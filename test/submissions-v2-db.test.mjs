import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { after, before, test } from "node:test";

import {
  claimSourceCursor,
  commitSourceCursor,
  checkpointJob,
  claimJobs,
  completeJob,
  createDatabase,
  heartbeatJob,
  heartbeatSourceCursor,
  readRuntimeControls,
  setRuntimeControls,
} from "../api/submissions-v2/_lib/db.mjs";
import {
  PairStateError,
  assertPairState,
  nextPairState,
} from "../api/submissions-v2/_lib/state.mjs";
import { runMigrations } from "../scripts/migrate-submissions-v2.mjs";
import { createRepository, repositoryInternals } from "../api/submissions-v2/_lib/repository.mjs";
import { rowDto } from "../api/submissions-v2/_lib/presentation.mjs";
import { createService } from "../api/submissions-v2/_lib/service.mjs";
import { createResumePipelineStore } from "../api/submissions-v2/_lib/resume/pipeline-store.mjs";
import { omissionDecisions } from "../api/submissions-v2/_lib/omission-prepass.mjs";

const databaseUrl = process.env.SUBMISSIONS_V2_TEST_DATABASE_URL
  || "postgresql://localhost:5432/raydar_submissions_v2_test";
const digest = (value) => createHash("sha256").update(String(value)).digest("hex");
let sql;

async function sourceEvent({ family = "manual", key = randomUUID(), receivedAt = new Date(), envelope = {}, senderDisplayName = null } = {}) {
  const id = randomUUID();
  const isEmail = family === "email";
  await sql`
    insert into submissions_v2.source_events (
      id, source_family, source_version, event_id, provider, mailbox_id,
      provider_message_id, direction, received_at, content_digest, idempotency_key, envelope, sender_display_name
    ) values (
      ${id}, ${family}, ${isEmail ? "submissions.email_reply.v1" : "manual.v1"}, ${`event-${key}`},
      ${isEmail ? "gmail" : null}, ${isEmail ? "mailbox-test" : null},
      ${isEmail ? `message-${key}` : null}, ${isEmail ? "inbound" : "manual"},
      ${receivedAt}, ${digest(key)}, ${`source:${key}`}, ${sql.json(envelope)}, ${senderDisplayName}
    )
  `;
  return id;
}

async function preparingPair({ candidate = `candidate-${randomUUID()}`, role = `role-${randomUUID()}` } = {}) {
  const signal = await sourceEvent();
  const id = randomUUID();
  await sql`
    insert into submissions_v2.candidate_role_pairs (
      id, candidate_user_id, role_id, first_signal_id, intent_state,
      workflow_state, original_signal_at, role_state
    ) values (
      ${id}, ${candidate}, ${role}, ${signal}, 'interested',
      'preparing_resume', clock_timestamp(), 'active'
    )
  `;
  return { id, signal, candidate, role };
}

before(async () => {
  await runMigrations({ databaseUrl, logger: { info() {} } });
  sql = createDatabase({ databaseUrl, max: 8 });
  await sql.unsafe(await readFile(new URL("../scripts/provision-submissions-v2-roles.sql", import.meta.url), "utf8"));
  await sql.unsafe(`
    truncate table
      submissions_v2.private_object_bindings,
      submissions_v2.case_deletion_audit,
      submissions_v2.case_deletions,
      submissions_v2.download_tickets,
      submissions_v2.download_audit,
      submissions_v2.private_object_reservations,
      submissions_v2.notification_outbox,
      submissions_v2.submission_proofs,
      submissions_v2.artifact_deletions,
      submissions_v2.resume_artifacts,
      submissions_v2.claim_validations,
      submissions_v2.claim_evidence_links,
      submissions_v2.resume_claims,
      submissions_v2.resume_supplements,
      submissions_v2.resume_sources,
      submissions_v2.resume_stage_runs,
      submissions_v2.resume_generations,
      submissions_v2.job_attempts,
      submissions_v2.jobs,
      submissions_v2.api_commands,
      submissions_v2.role_index,
      submissions_v2.candidate_index,
      submissions_v2.source_health,
      submissions_v2.source_runs,
      submissions_v2.source_cursors,
      submissions_v2.curated_snapshots,
      submissions_v2.classification_attempts,
      submissions_v2.not_interested_entries,
      submissions_v2.review_items,
      submissions_v2.pair_events,
      submissions_v2.candidate_role_pairs,
      submissions_v2.signal_role_decisions,
      submissions_v2.source_offered_roles,
      submissions_v2.source_events
    restart identity cascade
  `);
});

after(async () => {
  await sql?.end({ timeout: 5 });
});

test("migrations are digest-checked and idempotent", async () => {
  const result = await runMigrations({ databaseUrl, logger: { info() {} } });
  assert.deepEqual(result.applied, []);
  assert.deepEqual(result.skipped, [
    "001_foundation.sql", "002_guards_and_leases.sql",
    "003_case_retention.sql", "004_supplement_quarantine.sql", "005_isolated_case_purge.sql",
    "006_notification_delivery_fences.sql",
    "007_upload_reservations.sql",
    "008_download_completion_audit.sql",
    "009_resilience_and_redemption.sql",
    "010_first_response_privacy_and_audit.sql",
    "011_isolated_routine_object_purge.sql",
    "012_runtime_control_read_lock.sql",
    "013_worker_source_control_check.sql",
    "014_api_review_binding_source_offers.sql",
    "015_proof_during_resume_preparation.sql",
    "016_review_submission_proof.sql",
    "017_omission_prepass_evidence.sql",
  ]);
  const tables = await sql`
    select count(*)::integer as count
      from information_schema.tables
     where table_schema = 'submissions_v2'
  `;
  assert.ok(tables[0].count >= 30);
  assert.equal((await sql`select has_function_privilege('public', 'submissions_v2.set_runtime_controls(text,text,boolean,boolean,boolean,boolean,boolean)', 'EXECUTE') as allowed`)[0].allowed, false);
  assert.equal((await sql`select has_function_privilege('public', 'submissions_v2.lock_runtime_controls()', 'EXECUTE') as allowed`)[0].allowed, false);
  const purgeRole = (await sql`select 1 as present from pg_roles where rolname='submissions_v2_purge'`)[0];
  if (purgeRole) {
    assert.equal((await sql`select has_function_privilege('submissions_v2_purge', 'submissions_v2.set_runtime_controls(text,text,boolean,boolean,boolean,boolean,boolean)', 'EXECUTE') as allowed`)[0].allowed, false);
  }
});

test("notification claims retire operational rows and hold expired uncertain deliveries", async () => {
  const prior = await readRuntimeControls(sql);
  assert.equal((await sql`select count(*)::int as count from submissions_v2.notification_outbox`)[0].count, 0);
  assert.equal((await sql`select count(*)::int as count from submissions_v2.jobs`)[0].count, 0);
  const ids = Array.from({ length: 4 }, () => randomUUID());
  const jobId = randomUUID();
  const workerId = `notification-test-${randomUUID()}`;
  const enabled = await setRuntimeControls({
    actorEmail: "admin@raydar.xyz", reason: "Enable isolated notification policy regression",
    ui: prior.ui_enabled, ingestion: true, generation: prior.generation_enabled,
    masterInbox: prior.master_inbox_enabled, curated: prior.curated_enabled,
  }, sql);
  try {
    await sql`
      insert into submissions_v2.jobs(id, kind, subject_type, subject_id, idempotency_key, required_control, control_epoch)
      values (${jobId}, 'deliver_notification', 'outbox', 'notification_outbox', ${jobId}, 'ingestion', ${enabled.control_epoch})
    `;
    const [job] = await claimJobs({ workerId, kinds: ["deliver_notification"], limit: 1, leaseSeconds: 120, controlEpoch: enabled.control_epoch }, sql);
    assert.equal(job.id, jobId);
    const fixtures = [
      [ids[0], "source_delayed", "pending"], [ids[1], "daily_digest", "failed"],
      [ids[2], "submission_added", "sending"], [ids[3], "submission_added", "pending"],
    ];
    for (const [id, kind, state] of fixtures) {
      await sql`
        insert into submissions_v2.notification_outbox(
          id, kind, destination_id, safe_payload, dedupe_key, state, next_attempt_at, lease_owner, lease_expires_at
        ) values (
          ${id}, ${kind}, 'C123TEST', ${sql.json({})}, ${id}, ${state},
          clock_timestamp() - interval '1 minute', ${state === "sending" ? "expired-worker" : null},
          case when ${state === "sending"} then clock_timestamp() - interval '1 minute' else null end
        )
      `;
    }
    const claimed = await createRepository({ sql, env: {} }).claimNotifications({
      workerId, limit: 10, leaseSeconds: 120,
      executionFence: { jobId, workerId, fencingToken: Number(job.fencing_token), controlEpoch: Number(enabled.control_epoch) },
    });
    assert.deepEqual(claimed.map((row) => row.id), [ids[3]]);
    const rows = await sql`
      select id, state, safe_error_code, lease_owner, lease_expires_at
        from submissions_v2.notification_outbox where id=any(${sql.array(ids, 2950)})
    `;
    const byId = new Map(rows.map((row) => [row.id, row]));
    for (const id of ids.slice(0, 3)) {
      assert.equal(byId.get(id).state, "held");
      assert.equal(byId.get(id).safe_error_code, id === ids[2] ? "delivery_outcome_unknown" : "notification_kind_retired");
      assert.equal(byId.get(id).lease_owner, null);
      assert.equal(byId.get(id).lease_expires_at, null);
    }
    assert.equal(byId.get(ids[3]).state, "sending");
    assert.equal(byId.get(ids[3]).lease_owner, workerId);
  } finally {
    try {
      await sql`delete from submissions_v2.notification_outbox where id=any(${sql.array(ids, 2950)})`;
      await sql`delete from submissions_v2.job_attempts where job_id=${jobId}`;
      await sql`delete from submissions_v2.jobs where id=${jobId}`;
    } finally {
      await setRuntimeControls({
        actorEmail: "admin@raydar.xyz", reason: "Restore notification policy regression controls",
        ui: prior.ui_enabled, ingestion: prior.ingestion_enabled, generation: prior.generation_enabled,
        masterInbox: prior.master_inbox_enabled, curated: prior.curated_enabled,
      }, sql);
    }
  }
});

test("authoritative submission proof may persist while resume preparation remains fenced", async () => {
  const prior = await readRuntimeControls(sql);
  const enabled = await setRuntimeControls({
    actorEmail: "admin@raydar.xyz",
    reason: "Enable focused submission-proof lifecycle regression",
    ui: true,
    ingestion: true,
    generation: true,
    masterInbox: prior.master_inbox_enabled,
    curated: prior.curated_enabled,
  }, sql);
  const rollback = new Error("rollback focused proof fixture");
  try {
    await assert.rejects(sql.begin(async (tx) => {
      const sourceId = randomUUID();
      const pairId = randomUUID();
      const proofJobId = randomUUID();
      const initialGenerationId = randomUUID();
      const transactionSql = (strings, ...values) => tx(strings, ...values);
      transactionSql.begin = async (callback) => callback(transactionSql);
      transactionSql.json = tx.json;
      transactionSql.array = tx.array;
      const repository = createRepository({ sql: transactionSql });
      await tx`
        insert into submissions_v2.source_events(
          id, source_family, source_version, event_id, received_at, content_digest, idempotency_key, envelope
        ) values (
          ${sourceId}, 'manual', 'manual.v1', ${`event-${sourceId}`}, clock_timestamp(),
          ${digest(sourceId)}, ${`source:${sourceId}`}, '{}'::jsonb
        )
      `;
      await tx`
        insert into submissions_v2.jobs(
          id, kind, subject_type, subject_id, idempotency_key, required_control, control_epoch,
          state, lease_owner, lease_expires_at, fencing_token, attempt_count, started_at
        ) values (
          ${proofJobId}, 'proof_reconcile', 'source', 'submission_proof', ${`proof:${proofJobId}`}, 'ingestion',
          ${enabled.control_epoch}, 'running', 'proof-worker', clock_timestamp() + interval '2 minutes', 1, 1, clock_timestamp()
        )
      `;
      await tx`
        insert into submissions_v2.candidate_role_pairs(
          id, candidate_user_id, role_id, first_signal_id, intent_state, workflow_state, original_signal_at
        ) values (
          ${pairId}, 'candidate-proof-preparing', 'role-proof-preparing', ${sourceId},
          'interested', 'preparing_resume', clock_timestamp()
        )
      `;
      await tx`
        insert into submissions_v2.resume_generations(
          id, pair_id, generation_version, trigger_kind, idempotency_key, status, stage,
          expected_pair_version, first_signal_id, primary_model_pin, fallback_model_pin,
          validator_model_pin, prompt_pin, template_pin, deadline_at
        ) values (
          ${initialGenerationId}, ${pairId}, 1, 'initial', ${`generation:${initialGenerationId}`},
          'validating', 'validate', 1, ${sourceId}, 'primary-test', 'fallback-test',
          'validator-test', 'prompt-test', 'template-test', clock_timestamp() + interval '5 minutes'
        )
      `;
      const updated = await repository.applySubmissionProof({
        pairId,
        applicationId: "application-proof-preparing",
        authoritativePath: "application.getRecruiterApplicationData",
        evidenceDigest: "a".repeat(64),
        observedAt: new Date().toISOString(),
        checkedAt: new Date().toISOString(),
        executionFence: { jobId: proofJobId, workerId: "proof-worker", fencingToken: 1, controlEpoch: Number(enabled.control_epoch) },
      });
      assert.equal(updated.workflow_state, "preparing_resume");
      assert.equal(updated.submission_status, "proven");
      assert.equal(Number(updated.state_version), 1);

      const failed = await repository.failResumeGeneration({
        generationId: initialGenerationId,
        reasonCode: "candidate_original_resume_missing",
        safeDetail: "Focused proof lifecycle fixture.",
      });
      assert.equal(failed.workflow_state, "needs_review");
      assert.equal(failed.submission_status, "proven");
      assert.equal(Number(failed.state_version), 2);
      const retry = await repository.enqueuePairAction({
        actorEmail: "admin@raydar.xyz",
        idempotencyKey: `proof-retry:${randomUUID()}`,
        pairId,
        expectedVersion: 2,
        action: "retry_preparation",
        kind: "prepare_resume",
        requiredControl: "generation",
        checkpoint: { trigger_kind: "retry" },
      });
      assert.ok(retry.job_id);
      assert.equal((await repository.pair(pairId)).submission_status, "proven");

      const regeneratingPairId = randomUUID();
      const activeGenerationId = randomUUID();
      await tx`
        insert into submissions_v2.candidate_role_pairs(
          id, candidate_user_id, role_id, first_signal_id, intent_state, workflow_state,
          original_signal_at, current_artifact_id, resume_ready_at
        ) values (
          ${regeneratingPairId}, 'candidate-proof-regenerating', 'role-proof-regenerating', ${sourceId},
          'interested', 'interested', clock_timestamp(), ${randomUUID()}, clock_timestamp()
        )
      `;
      await tx`
        insert into submissions_v2.resume_generations(
          id, pair_id, generation_version, trigger_kind, idempotency_key, status, stage,
          expected_pair_version, first_signal_id, primary_model_pin, fallback_model_pin,
          validator_model_pin, prompt_pin, template_pin, deadline_at
        ) values (
          ${activeGenerationId}, ${regeneratingPairId}, 1, 'regenerate', ${`generation:${activeGenerationId}`},
          'validating', 'validate', 1, ${sourceId}, 'primary-test', 'fallback-test',
          'validator-test', 'prompt-test', 'template-test', clock_timestamp() + interval '5 minutes'
        )
      `;
      const regenerating = await repository.applySubmissionProof({
        pairId: regeneratingPairId,
        applicationId: "application-proof-regenerating",
        authoritativePath: "application.getRecruiterApplicationData",
        evidenceDigest: "b".repeat(64),
        observedAt: new Date().toISOString(),
        checkedAt: new Date().toISOString(),
        executionFence: { jobId: proofJobId, workerId: "proof-worker", fencingToken: 1, controlEpoch: Number(enabled.control_epoch) },
      });
      assert.equal(Number(regenerating.state_version), 1);
      assert.equal(regenerating.submission_status, "proven");
      assert.equal(Number((await tx`
        select expected_pair_version from submissions_v2.resume_generations where id=${activeGenerationId}
      `)[0].expected_pair_version), 1);

      for (const intent of ["interested", "unclear"]) {
        const reviewPairId = randomUUID();
        await tx`
          insert into submissions_v2.candidate_role_pairs(
            id, candidate_user_id, role_id, first_signal_id, intent_state, workflow_state, original_signal_at
          ) values (${reviewPairId}, ${`review-candidate-${reviewPairId}`}, 'review-role', ${sourceId},
                    ${intent}, 'needs_review', clock_timestamp())
        `;
        await tx`
          insert into submissions_v2.review_items(pair_id, reason_code)
          values (${reviewPairId}, ${intent === 'interested' ? 'resume_preparation_failed' : 'candidate_question'})
        `;
        const proof = await repository.applySubmissionProof({
          pairId: reviewPairId, applicationId: `review-application-${reviewPairId}`,
          authoritativePath: "application.getRecruiterApplicationData", evidenceDigest: "c".repeat(64),
          observedAt: new Date().toISOString(), checkedAt: new Date().toISOString(),
          executionFence: { jobId: proofJobId, workerId: "proof-worker", fencingToken: 1, controlEpoch: Number(enabled.control_epoch) },
        });
        assert.equal(proof.submission_status, "proven");
        assert.equal(proof.intent_state, intent, "provider proof never manufactures positive interest");
        assert.equal(proof.first_signal_id, sourceId);
        assert.equal(proof.current_artifact_id, null);
        assert.equal(Number(proof.state_version), 2);
        assert.equal((await tx`select count(*)::integer as count from submissions_v2.review_items where pair_id=${reviewPairId} and action_state='open'`)[0].count, 0);
        assert.equal((await tx`select count(*)::integer as count from submissions_v2.jobs where subject_id=${reviewPairId}`)[0].count, 0);
        assert.ok(!(await repository.list({ page: "needs_review" })).rows.some((row) => row.pair_id === reviewPairId));
        assert.ok((await repository.list({ page: "interested" })).rows.some((row) => row.pair_id === reviewPairId));
      }

      const provenResumePair = async (intent) => {
        const pairId = randomUUID();
        const generationId = randomUUID();
        const artifactId = randomUUID();
        await tx`
          insert into submissions_v2.candidate_role_pairs(
            id, candidate_user_id, role_id, first_signal_id, intent_state, workflow_state, original_signal_at
          ) values (
            ${pairId}, ${`proven-resume-${intent}-${pairId}`}, ${`proven-role-${intent}`}, ${sourceId},
            ${intent}, 'needs_review', clock_timestamp()
          )
        `;
        await tx`
          insert into submissions_v2.review_items(pair_id, reason_code)
          values (${pairId}, ${intent === "interested" ? "resume_preparation_failed" : "candidate_question"})
        `;
        await tx`
          insert into submissions_v2.resume_generations(
            id, pair_id, generation_version, trigger_kind, idempotency_key, status, stage,
            expected_pair_version, first_signal_id, primary_model_pin, fallback_model_pin,
            validator_model_pin, prompt_pin, template_pin, deadline_at, completed_at
          ) values (
            ${generationId}, ${pairId}, 1, 'initial', ${`proven-resume-generation:${generationId}`},
            'succeeded', 'complete', 1, ${sourceId}, 'primary-test', 'fallback-test',
            'validator-test', 'prompt-test', 'template-test', clock_timestamp(), clock_timestamp()
          )
        `;
        await tx`
          insert into submissions_v2.resume_artifacts(
            id, pair_id, generation_id, artifact_version, kind, private_object_key,
            digest, size_bytes, page_count, validation_status, archive_readback_at, archived_at, current_state
          ) values (
            ${artifactId}, ${pairId}, ${generationId}, 1, 'pdf',
            ${`submissions/resumes/v2/pdf/${artifactId}`}, ${digest(`proven-resume:${artifactId}`)},
            100, 1, 'passed', clock_timestamp(), clock_timestamp(), 'current'
          )
        `;
        await tx`
          update submissions_v2.candidate_role_pairs
             set current_artifact_id=${artifactId}, resume_ready_at=clock_timestamp(),
                 state_version=state_version+1
           where id=${pairId}
        `;
        const proof = await repository.applySubmissionProof({
          pairId, applicationId: `proven-resume-application-${pairId}`,
          authoritativePath: "application.getRecruiterApplicationData",
          evidenceDigest: digest(`proof:${pairId}`), observedAt: new Date().toISOString(), checkedAt: new Date().toISOString(),
          executionFence: { jobId: proofJobId, workerId: "proof-worker", fencingToken: 1, controlEpoch: Number(enabled.control_epoch) },
        });
        assert.equal(proof.workflow_state, "needs_review");
        assert.equal(proof.submission_status, "proven");
        assert.equal(proof.intent_state, intent);
        assert.equal(proof.current_artifact_id, artifactId);
        return { pairId, generationId, artifactId, version: Number(proof.state_version) };
      };

      const interestedProof = await provenResumePair("interested");
      const interestedDownload = await repository.issueDownload({
        actorEmail: "admin@raydar.xyz", idempotencyKey: `proven-download:${randomUUID()}`,
        pairId: interestedProof.pairId, expectedVersion: interestedProof.version,
        ticketId: randomUUID(), expiresAt: new Date(Date.now() + 60_000).toISOString(),
      });
      assert.equal(interestedDownload.artifact.id, interestedProof.artifactId);
      const regeneration = await repository.regenerate({
        actorEmail: "admin@raydar.xyz", idempotencyKey: `proven-regenerate:${randomUUID()}`,
        pairId: interestedProof.pairId, expectedVersion: interestedProof.version,
        evidenceEncrypted: null, evidenceDigest: null, evidenceBasis: null, sourceNote: null,
        instructionsEncrypted: null, uploads: [],
      });
      assert.ok(regeneration.job_id);
      await tx`
        update submissions_v2.jobs
           set state='running', lease_owner='proven-regeneration-worker',
               lease_expires_at=clock_timestamp() + interval '2 minutes', fencing_token=1,
               attempt_count=1, started_at=clock_timestamp()
         where id=${regeneration.job_id}
      `;
      const started = await repository.startResumeGeneration({
        pairId: interestedProof.pairId, triggerKind: "regenerate",
        idempotencyKey: `resume-job:${regeneration.job_id}:attempt:1`,
        expectedPairVersion: interestedProof.version, commandId: null,
        primaryModelPin: "primary-test", fallbackModelPin: "fallback-test",
        validatorModelPin: "validator-test", promptPin: "prompt-test", templatePin: "template-test",
        deadlineAt: new Date(Date.now() + 60_000).toISOString(), priorArtifactId: interestedProof.artifactId,
        executionFence: {
          jobId: regeneration.job_id, workerId: "proven-regeneration-worker", fencingToken: 1,
          controlEpoch: Number(enabled.control_epoch),
        },
      });
      assert.equal(started.pair_id, interestedProof.pairId);
      assert.equal(started.trigger_kind, "regenerate");
      assert.deepEqual((await tx`
        select intent_state, workflow_state, submission_status, current_artifact_id
          from submissions_v2.candidate_role_pairs where id=${interestedProof.pairId}
      `)[0], {
        intent_state: "interested", workflow_state: "needs_review", submission_status: "proven",
        current_artifact_id: interestedProof.artifactId,
      });

      const unclearProof = await provenResumePair("unclear");
      const unclearDownload = await repository.issueDownload({
        actorEmail: "admin@raydar.xyz", idempotencyKey: `unclear-proven-download:${randomUUID()}`,
        pairId: unclearProof.pairId, expectedVersion: unclearProof.version,
        ticketId: randomUUID(), expiresAt: new Date(Date.now() + 60_000).toISOString(),
      });
      assert.equal(unclearDownload.artifact.id, unclearProof.artifactId);
      await assert.rejects(
        repository.regenerate({
          actorEmail: "admin@raydar.xyz", idempotencyKey: `unclear-proven-regenerate:${randomUUID()}`,
          pairId: unclearProof.pairId, expectedVersion: unclearProof.version,
          evidenceEncrypted: null, evidenceDigest: null, evidenceBasis: null, sourceNote: null,
          instructionsEncrypted: null, uploads: [],
        }),
        (error) => error.code === "pair_not_resume_ready",
      );
      assert.equal((await tx`
        select count(*)::integer as count from submissions_v2.jobs
         where kind='prepare_resume' and subject_id=${unclearProof.pairId}::text
      `)[0].count, 0);
      await tx`set constraints submissions_v2.candidate_role_pairs_review_consistency,
        submissions_v2.review_items_pair_consistency, submissions_v2.candidate_role_pairs_proof_consistency,
        submissions_v2.submission_proofs_pair_consistency immediate`;
      throw rollback;
    }), (error) => error === rollback);
  } finally {
    await setRuntimeControls({
      actorEmail: "admin@raydar.xyz",
      reason: "Restore controls after focused submission-proof lifecycle regression",
      ui: prior.ui_enabled,
      ingestion: prior.ingestion_enabled,
      generation: prior.generation_enabled,
      masterInbox: prior.master_inbox_enabled,
      curated: prior.curated_enabled,
    }, sql);
  }
});

test("candidate-role advisory lock keys are collision-safe UTF-8 accepted by Postgres", async () => {
  const key = repositoryInternals.pairAdvisoryLockKey("candidate\u0000with-delimiter", "role/with/slash");
  assert.equal(key.includes("\u0000"), false);
  assert.deepEqual(JSON.parse(key), ["candidate\u0000with-delimiter", "role/with/slash"]);
  const rows = await sql`select hashtextextended(${key}, 0)::text as lock_hash`;
  assert.match(rows[0].lock_hash, /^-?\d+$/u);
});

test("the pure state contract rejects invalid and stale pair transitions", () => {
  const current = {
    intent_state: "interested",
    workflow_state: "preparing_resume",
    submission_status: "none",
    state_version: 4,
  };
  const next = nextPairState(current, {
    workflow_state: "interested",
    current_artifact_id: randomUUID(),
    resume_ready_at: new Date().toISOString(),
  }, 4);
  assert.equal(next.state_version, 5);
  assert.throws(() => nextPairState(current, { workflow_state: "not_interested" }, 3), PairStateError);
  assert.throws(() => assertPairState({
    ...current,
    workflow_state: "interested",
  }), /current artifact/);
  const provenPreparing = { ...current, submission_status: "proven" };
  assertPairState(provenPreparing);
  const provenReview = nextPairState(provenPreparing, { workflow_state: "needs_review" }, 4);
  const provenRetry = nextPairState(provenReview, { workflow_state: "preparing_resume" }, 5);
  const provenReady = nextPairState(provenRetry, {
    workflow_state: "interested",
    current_artifact_id: randomUUID(),
    resume_ready_at: new Date().toISOString(),
  }, 6);
  assert.equal(provenReady.submission_status, "proven");
  assert.throws(() => nextPairState(provenReady, {
    intent_state: "not_interested",
    workflow_state: "not_interested",
  }, 7), /candidate intent|cannot be reclassified/);
});

test("source evidence is replay-safe and immutable while processing state may advance", async () => {
  const key = randomUUID();
  const id = await sourceEvent({ family: "email", key });
  await assert.rejects(
    sourceEvent({ family: "email", key: `${key}-other` }).then(async (otherId) => {
      await sql`
        update submissions_v2.source_events
           set mailbox_id = 'mailbox-test', provider_message_id = ${`message-${key}`}
         where id = ${otherId}
      `;
    }),
    /source event evidence is immutable|duplicate key/,
  );
  await sql`
    update submissions_v2.source_events
       set processing_state = 'ready', processed_at = clock_timestamp()
     where id = ${id}
  `;
  await assert.rejects(
    sql`update submissions_v2.source_events set content_digest = ${digest("changed")} where id = ${id}`,
    /source event evidence is immutable/,
  );
});

test("email intake cannot commit a source after its private-object write lease expires", async () => {
  const repository = createRepository({ sql });
  const prior = await readRuntimeControls(sql);
  await setRuntimeControls({
    actorEmail: "admin@raydar.xyz", reason: "Enable source-object lease regression",
    ui: prior.ui_enabled, ingestion: true, generation: prior.generation_enabled,
    masterInbox: true, curated: prior.curated_enabled,
  }, sql);
  const reservationId = randomUUID();
  const eventId = randomUUID();
  const objectKey = `submissions/resumes/v2/events/${eventId}.json`;
  const objectDigest = digest(`object:${eventId}`);
  await sql`
    insert into submissions_v2.private_object_reservations(
      id, object_key, purpose, owner_ref, expected_digest, state, expires_at,
      write_owner, write_lease_expires_at, write_fencing_token
    ) values (
      ${reservationId}, ${objectKey}, 'source_event', ${eventId}, ${objectDigest}, 'pending',
      clock_timestamp() + interval '1 day', 'expired-writer', clock_timestamp() - interval '1 second', 1
    )
  `;
  const event = {
    schema_version: "submissions.email_reply.v1", event_id: eventId,
    provider: "master_inbox", mailbox_id: "mailbox-test", provider_message_id: `message-${eventId}`,
    provider_thread_id: `thread-${eventId}`, outbound_message_id: `outbound-${eventId}`,
    sent_at: new Date().toISOString(), received_at: new Date().toISOString(),
    content_digest: digest(`content:${eventId}`), sender_display_name: "Candidate",
    sender_match_hmac: null, previous_sender_match_hmac: null, machine_message: false,
    idempotency_key: `source:${eventId}`,
  };
  await assert.rejects(
    repository.recordEmailSource({
      event, safeEnvelope: {}, privateObjectKey: objectKey,
      objectReservationId: reservationId, objectWriteFencingToken: 1,
      objectDigest, processingState: "ready", candidateResolution: null,
    }),
    (error) => error.code === "private_object_reservation_fence_lost",
  );
  assert.equal((await sql`select count(*)::integer as count from submissions_v2.source_events where idempotency_key=${event.idempotency_key}`)[0].count, 0);
  assert.equal((await sql`select state from submissions_v2.private_object_reservations where id=${reservationId}`)[0].state, "pending");
});

test("email intake keeps one immutable provider-event object owner through commit", async () => {
  const repository = createRepository({ sql, env: { SUBMISSIONS_V2_SLACK_CHANNEL_ID: "C123TEST" } });
  const prior = await readRuntimeControls(sql);
  await setRuntimeControls({
    actorEmail: "admin@raydar.xyz", reason: "Enable source object binding regression",
    ui: prior.ui_enabled, ingestion: true, generation: prior.generation_enabled,
    masterInbox: true, curated: prior.curated_enabled,
  }, sql);
  const eventId = `binding-${randomUUID()}`;
  const objectKey = `submissions/resumes/v2/events/${randomUUID()}`;
  const objectDigest = digest(`object:${eventId}`);
  const reservation = await repository.reservePrivateObject({
    reservationId: randomUUID(), objectKey, purpose: "source_event", ownerRef: eventId,
    expectedDigest: objectDigest, expiresAt: Date.now() + 24 * 60 * 60_000,
  });
  const leased = await repository.renewPrivateObjectWrite({
    reservationId: reservation.id, objectKey, expectedDigest: objectDigest,
    writeFencingToken: reservation.write_fencing_token,
  });
  const event = {
    schema_version: "submissions.email_reply.v1", event_id: eventId,
    provider: "master_inbox", mailbox_id: "mailbox-test", provider_message_id: `message-${eventId}`,
    provider_thread_id: `thread-${eventId}`, outbound_message_id: `outbound-${eventId}`,
    sent_at: new Date().toISOString(), received_at: new Date().toISOString(),
    content_digest: digest(`content:${eventId}`), sender_display_name: "Candidate <candidate@example.com>",
    sender_match_hmac: null, previous_sender_match_hmac: null, machine_message: false,
    idempotency_key: `source:${eventId}`, offered_roles: [],
  };
  const recorded = await repository.recordEmailSource({
    event, safeEnvelope: {}, privateObjectKey: objectKey,
    objectReservationId: reservation.id, objectWriteFencingToken: leased.write_fencing_token,
    objectDigest, processingState: "needs_role", candidateResolution: null,
  });
  const persisted = (await sql`
    select reservation.owner_ref, reservation.state, binding.owner_table,
           binding.owner_id, binding.owner_binding_ref
      from submissions_v2.private_object_reservations reservation
      join submissions_v2.private_object_bindings binding on binding.object_key=reservation.object_key
     where reservation.id=${reservation.id}
  `)[0];
  assert.equal(recorded.source.event_id, eventId);
  assert.deepEqual(persisted, {
    owner_ref: eventId,
    state: "committed",
    owner_table: "source_events",
    owner_id: recorded.source.id,
    owner_binding_ref: eventId,
  });
  const admission = (await sql`
    select kind, pair_id, safe_payload, dedupe_key
      from submissions_v2.notification_outbox
     where dedupe_key=${`submission-added:signal:${recorded.source.id}`}
  `)[0];
  assert.equal(admission.kind, "submission_added");
  assert.equal(admission.pair_id, null);
  assert.equal((await sql`
    select count(*)::integer as count from submissions_v2.notification_outbox
     where dedupe_key=${`submission-added:signal:${recorded.source.id}`}
  `)[0].count, 1);
  assert.deepEqual({ ...admission.safe_payload, added_at: undefined }, {
    candidate_name: "Candidate", company: "Not yet identified",
    role_title: "Not yet identified", signal: "Needs review · Email reply",
    added_at: undefined, monitor_url: "https://monitor.raydar.xyz/#submissions",
  });
  const review = (await sql`
    select opened_at from submissions_v2.review_items
     where unresolved_signal_id=${recorded.source.id}
  `)[0];
  assert.equal(admission.safe_payload.added_at, new Date(review.opened_at).toISOString());
});

test("exact pair identity, first response, review consistency, and pair ledger are database-enforced", async () => {
  const pair = await preparingPair();
  const laterSignal = await sourceEvent();
  await assert.rejects(
    sql`
      insert into submissions_v2.candidate_role_pairs (
        candidate_user_id, role_id, first_signal_id, intent_state, workflow_state, original_signal_at
      ) values (${pair.candidate}, ${pair.role}, ${laterSignal}, 'interested', 'preparing_resume', clock_timestamp())
    `,
    /duplicate key/,
  );
  await assert.rejects(
    sql`update submissions_v2.candidate_role_pairs set candidate_user_id = 'changed' where id = ${pair.id}`,
    /identity and first signal are immutable/,
  );
  await sql`
    insert into submissions_v2.pair_events (
      pair_id, actor_type, actor_id, source, event_type, expected_version, new_version, idempotency_key
    ) values (${pair.id}, 'human', 'teammate@raydar.xyz', 'manual', 'pair_created', 0, 1, ${randomUUID()})
  `;
  await assert.rejects(
    sql`update submissions_v2.pair_events set event_type = 'rewritten' where pair_id = ${pair.id}`,
    /append-only/,
  );

  const reviewSignal = await sourceEvent();
  const reviewPair = randomUUID();
  await sql.begin(async (transaction) => {
    await transaction`
      insert into submissions_v2.candidate_role_pairs (
        id, candidate_user_id, role_id, first_signal_id, intent_state, workflow_state, original_signal_at
      ) values (${reviewPair}, ${`candidate-${randomUUID()}`}, ${`role-${randomUUID()}`},
                ${reviewSignal}, 'interested', 'needs_review', clock_timestamp())
    `;
    await transaction`
      insert into submissions_v2.review_items (pair_id, reason_code, safe_detail)
      values (${reviewPair}, 'candidate_original_resume_missing', 'Original resume is unavailable')
    `;
  });
  await assert.rejects(
    sql`update submissions_v2.review_items set action_state = 'resolved', resolved_at = clock_timestamp(), resolved_by = 'teammate@raydar.xyz' where pair_id = ${reviewPair}`,
    /Needs Review pair requires an open blocking reason/,
  );
});

test("human review can bind a missing-role signal to an exact active Paraform role", async () => {
  const repository = createRepository({ sql });
  const prior = await readRuntimeControls(sql);
  await setRuntimeControls({
    actorEmail: "admin@raydar.xyz", reason: "Enable missing-role recovery regression",
    ui: true, ingestion: true, generation: prior.generation_enabled, masterInbox: true,
    curated: prior.curated_enabled,
  }, sql);
  const candidateId = `candidate-role-recovery-${randomUUID()}`;
  const roleId = `role-recovery-${randomUUID()}`;
  const signalId = randomUUID();
  const eventId = `event-role-recovery-${randomUUID()}`;
  await sql`
    insert into submissions_v2.candidate_index(
      candidate_user_id, display_name, normalized_name, search_key, active,
      paraform_profile_url, last_confirmed_at, source_digest
    ) values (
      ${candidateId}, 'Role Recovery Candidate', 'role recovery candidate', 'role recovery candidate', true,
      ${`https://www.paraform.com/candidates?candidate=${candidateId}`}, clock_timestamp(), ${digest(candidateId)}
    )
  `;
  await sql`
    insert into submissions_v2.role_index(
      role_id, company_name, role_title, search_key, active, destination_url, last_confirmed_at, source_digest
    ) values (
      ${roleId}, 'Recovery Company', 'Recovery Engineer', 'recovery company recovery engineer', true,
      ${`https://www.paraform.com/browse?role=${roleId}`}, clock_timestamp(), ${digest(roleId)}
    )
  `;
  await sql`
    insert into submissions_v2.source_events(
      id, source_family, source_version, event_id, provider, mailbox_id, provider_message_id,
      direction, received_at, content_digest, processing_state, safe_error_code,
      safe_error_detail, idempotency_key, envelope
    ) values (
      ${signalId}, 'email', 'submissions.email_reply.v1', ${eventId}, 'master_inbox', 'mailbox-test',
      ${`message-${eventId}`}, 'inbound', clock_timestamp(), ${digest(signalId)}, 'needs_role',
      'role_unclear', 'The exact offered role was not present in the source contract.',
      ${`source:${signalId}`}, ${sql.json({ candidate_resolution: { candidate_user_id: candidateId } })}
    )
  `;
  await sql`
    insert into submissions_v2.review_items(unresolved_signal_id, reason_code, safe_detail)
    values (${signalId}, 'role_unclear', 'Select the exact role confirmed from the source email.')
  `;
  const result = await repository.bindUnresolvedSignal({
    actorEmail: "recruiter@raydar.xyz", idempotencyKey: randomUUID(), signalId,
    candidateId, roleIds: [roleId], note: "Confirmed the role from the linked source email.",
  });
  assert.deepEqual(result.role_ids, [roleId]);
  assert.ok(result.job_id);
  assert.equal((await sql`select count(*)::integer as count from submissions_v2.source_offered_roles where signal_id=${signalId} and role_id=${roleId}`)[0].count, 1);
  assert.equal((await sql`select count(*)::integer as count from submissions_v2.first_response_claims where signal_id=${signalId} and role_id=${roleId} and released_at is null`)[0].count, 1);
  assert.equal((await sql`select processing_state from submissions_v2.source_events where id=${signalId}`)[0].processing_state, "ready");
  await sql`update submissions_v2.candidate_index set active=false where candidate_user_id=${candidateId}`;
  await setRuntimeControls({
    actorEmail: "admin@raydar.xyz", reason: "Restore controls after missing-role recovery regression",
    ui: prior.ui_enabled, ingestion: prior.ingestion_enabled, generation: prior.generation_enabled,
    masterInbox: prior.master_inbox_enabled, curated: prior.curated_enabled,
  }, sql);
});

test("resolving a pre-release source Review row creates only a held lineage marker", async () => {
  const prior = await readRuntimeControls(sql);
  const enabled = await setRuntimeControls({
    actorEmail: "admin@raydar.xyz", reason: "Enable source-lineage notification regression",
    ui: true, ingestion: true, generation: true, masterInbox: true,
    curated: prior.curated_enabled,
  }, sql);
  const candidateId = `lineage-candidate-${randomUUID()}`;
  const roleA = `lineage-role-a-${randomUUID()}`;
  const roleB = `lineage-role-b-${randomUUID()}`;
  const signalId = randomUUID();
  const eventId = `lineage-event-${randomUUID()}`;
  await sql`
    insert into submissions_v2.candidate_index(
      candidate_user_id, display_name, normalized_name, search_key, active,
      paraform_profile_url, last_confirmed_at, source_digest
    ) values (
      ${candidateId}, 'Lineage Candidate', 'lineage candidate', 'lineage candidate', true,
      ${`https://www.paraform.com/candidates?candidate_profile_id=${candidateId}`}, clock_timestamp(), ${digest(candidateId)}
    )
  `;
  await sql`
    insert into submissions_v2.role_index(
      role_id, company_name, role_title, search_key, active, destination_url, last_confirmed_at, source_digest
    ) values
      (${roleA}, 'Lineage Company', 'Lineage Engineer A', 'lineage company lineage engineer a', true,
       ${`https://www.paraform.com/browse?role=${roleA}`}, clock_timestamp(), ${digest(roleA)}),
      (${roleB}, 'Lineage Company', 'Lineage Engineer B', 'lineage company lineage engineer b', true,
       ${`https://www.paraform.com/browse?role=${roleB}`}, clock_timestamp(), ${digest(roleB)})
  `;
  await sql`
    insert into submissions_v2.source_events(
      id, source_family, source_version, event_id, provider, mailbox_id, provider_message_id,
      direction, received_at, content_digest, processing_state, safe_error_code,
      safe_error_detail, idempotency_key, envelope, sender_display_name
    ) values (
      ${signalId}, 'email', 'submissions.email_reply.v1', ${eventId}, 'master_inbox', 'mailbox-test',
      ${`message-${eventId}`}, 'inbound', clock_timestamp(), ${digest(signalId)}, 'needs_role',
      'role_unclear', 'The exact role requires review.', ${`source:${signalId}`},
      ${sql.json({ candidate_resolution: { candidate_user_id: candidateId } })}, 'Lineage Candidate'
    )
  `;
  await sql`
    insert into submissions_v2.review_items(unresolved_signal_id, reason_code, safe_detail)
    values (${signalId}, 'role_unclear', 'Select the exact role.')
  `;
  const repository = createRepository({ sql, env: { SUBMISSIONS_V2_SLACK_CHANNEL_ID: "C123TEST" } });
  const bound = await repository.bindUnresolvedSignal({
    actorEmail: "recruiter@raydar.xyz", idempotencyKey: randomUUID(), signalId,
    candidateId, roleIds: [roleA, roleB], note: "Confirmed exact roles from source.",
  });
  const claimed = (await claimJobs({
    workerId: "lineage-worker", kinds: ["classify_email_reply"], limit: 50,
    leaseSeconds: 120, controlEpoch: enabled.control_epoch,
  }, sql)).find((row) => row.id === bound.job_id);
  assert.ok(claimed);
  const applied = await repository.applyClassifiedSignal({
    signalId, candidateId,
    decisions: [
      { role_id: roleA, label: "interested", quote: "Yes, I am interested.", review_reason: null, negative_reason: null },
      { role_id: roleB, label: "interested", quote: "Yes, I am interested.", review_reason: null, negative_reason: null },
    ],
    attempts: [{ outcome: "accepted", model: "test-model" }],
    executionFence: {
      jobId: claimed.id, workerId: claimed.lease_owner,
      fencingToken: Number(claimed.fencing_token), controlEpoch: Number(enabled.control_epoch),
    },
  });
  assert.equal(applied.created_count, 2);
  const notifications = await sql`
    select dedupe_key, pair_id, state, safe_error_code from submissions_v2.notification_outbox
     where dedupe_key in (
       ${`submission-added:signal:${signalId}`},
       ${`submission-added:pair:${applied.pairs[0].pair_id}`},
       ${`submission-added:pair:${applied.pairs[1].pair_id}`}
     )
     order by dedupe_key
  `;
  assert.equal(notifications.length, 2);
  const signalMarker = notifications.find((row) => row.dedupe_key === `submission-added:signal:${signalId}`);
  assert.deepEqual(signalMarker, {
    dedupe_key: `submission-added:signal:${signalId}`, pair_id: applied.pairs[0].pair_id,
    state: "held", safe_error_code: "pre_release_admission_suppressed",
  });
  const additionalRole = notifications.find((row) => row.pair_id === applied.pairs[1].pair_id);
  assert.deepEqual(additionalRole, {
    dedupe_key: `submission-added:pair:${applied.pairs[1].pair_id}`, pair_id: applied.pairs[1].pair_id,
    state: "pending", safe_error_code: null,
  });
  await setRuntimeControls({
    actorEmail: "admin@raydar.xyz", reason: "Restore source-lineage notification regression controls",
    ui: prior.ui_enabled, ingestion: prior.ingestion_enabled, generation: prior.generation_enabled,
    masterInbox: prior.master_inbox_enabled, curated: prior.curated_enabled,
  }, sql);
});

test("the API principal reads evidence only for visible Review and reuses only verified active identity", async () => {
  const candidateId = `review-evidence-${randomUUID()}`;
  const signalId = await sourceEvent({ family: "email", senderDisplayName: "Source Alias",
    envelope: { candidate_resolution: { candidate_user_id: candidateId, ambiguous: false } } });
  const unrelatedId = await sourceEvent({ family: "email" });
  await sql`
    insert into submissions_v2.candidate_index(candidate_user_id, display_name, normalized_name, search_key, active, paraform_profile_url, last_confirmed_at, source_digest)
    values (${candidateId}, 'Canonical Evidence Person', 'canonical evidence person', 'canonical evidence person', true,
      ${`https://www.paraform.com/candidates/${candidateId}`}, clock_timestamp(), ${digest(candidateId)})
  `;
  await sql`insert into submissions_v2.review_items(unresolved_signal_id, reason_code) values (${signalId}, 'role_unclear')`;
  const asApi = async (fn) => sql.begin(async (tx) => {
    await tx`set local role submissions_v2_api`;
    return fn(createRepository({ sql: tx }));
  });
  assert.equal((await asApi((repo) => repo.sourceForReview({ signalId }))).id, signalId);
  assert.equal(await asApi((repo) => repo.sourceForReview({ signalId: unrelatedId })), null);
  const matched = (await asApi((repo) => repo.list({ page: 'needs_review', query: 'canonical evidence' }))).rows;
  assert.equal(matched.length, 1);
  assert.equal(matched[0].candidate_user_id, candidateId);
  assert.equal((await asApi((repo) => repo.list({ page: 'needs_review', query: 'Source Alias' }))).rows[0].candidate_user_id, candidateId);
  await sql`insert into submissions_v2.review_items(unresolved_signal_id, reason_code) values (${signalId}, 'candidate_ambiguous')`;
  assert.equal((await asApi((repo) => repo.list({ page: 'needs_review', query: 'Source Alias' }))).rows[0].candidate_user_id, null);
  await sql`update submissions_v2.review_items set action_state='resolved', resolved_at=clock_timestamp(), resolved_by='test@raydar.xyz' where unresolved_signal_id=${signalId}`;
  assert.equal(await asApi((repo) => repo.sourceForReview({ signalId })), null);
  const pair = await preparingPair();
  await sql.begin(async (tx) => {
    await tx`update submissions_v2.candidate_role_pairs set workflow_state='needs_review', state_version=state_version+1 where id=${pair.id}`;
    await tx`insert into submissions_v2.review_items(pair_id, reason_code) values (${pair.id}, 'candidate_original_resume_missing')`;
  });
  assert.equal((await asApi((repo) => repo.sourceForReview({ caseId: pair.id }))).id, pair.signal);
  await sql`update submissions_v2.candidate_role_pairs set case_hidden_at=clock_timestamp(), state_version=state_version+1 where id=${pair.id}`;
  assert.equal(await asApi((repo) => repo.sourceForReview({ caseId: pair.id })), null);
  const health = await asApi((repo) => repo.health());
  assert.equal(health.database, 'current');
});

test("the API principal can attest an exact review role without broader offered-role mutation rights", async () => {
  const prior = await readRuntimeControls(sql);
  const candidateId = `api-role-candidate-${randomUUID()}`;
  const roleId = `api-role-${randomUUID()}`;
  const signalId = randomUUID();
  const eventId = `api-role-event-${randomUUID()}`;
  try {
    await setRuntimeControls({
      actorEmail: "admin@raydar.xyz", reason: "Enable API-principal review-binding regression",
      ui: true, ingestion: true, generation: prior.generation_enabled, masterInbox: true,
      curated: prior.curated_enabled,
    }, sql);
    await sql`
      insert into submissions_v2.candidate_index(
        candidate_user_id, display_name, normalized_name, search_key, active,
        paraform_profile_url, last_confirmed_at, source_digest
      ) values (
        ${candidateId}, 'API Role Candidate', 'api role candidate', 'api role candidate', true,
        ${`https://www.paraform.com/candidates?candidate=${candidateId}`}, clock_timestamp(), ${digest(candidateId)}
      )
    `;
    await sql`
      insert into submissions_v2.role_index(
        role_id, company_name, role_title, search_key, active, destination_url, last_confirmed_at, source_digest
      ) values (
        ${roleId}, 'API Role Company', 'API Role Engineer', 'api role company api role engineer', true,
        ${`https://www.paraform.com/browse?role=${roleId}`}, clock_timestamp(), ${digest(roleId)}
      )
    `;
    await sql`
      insert into submissions_v2.source_events(
        id, source_family, source_version, event_id, provider, mailbox_id, provider_message_id,
        direction, received_at, content_digest, processing_state, safe_error_code,
        safe_error_detail, idempotency_key, envelope
      ) values (
        ${signalId}, 'email', 'submissions.email_reply.v1', ${eventId}, 'master_inbox', 'mailbox-test',
        ${`message-${eventId}`}, 'inbound', clock_timestamp(), ${digest(signalId)}, 'needs_role',
        'role_unclear', 'The exact offered role was not present in the source contract.',
        ${`source:${signalId}`}, ${sql.json({ candidate_resolution: { candidate_user_id: candidateId } })}
      )
    `;
    await sql`
      insert into submissions_v2.review_items(unresolved_signal_id, reason_code, safe_detail)
      values (${signalId}, 'role_unclear', 'Select the exact role confirmed from the source email.')
    `;

    let privileges;
    const apiDatabase = {
      begin: (work) => sql.begin(async (apiSql) => {
        await apiSql.unsafe("set local role submissions_v2_api");
        privileges = (await apiSql`
          select
            current_user as role_name,
            has_table_privilege(current_user, 'submissions_v2.source_offered_roles', 'select') as can_select,
            has_table_privilege(current_user, 'submissions_v2.source_offered_roles', 'insert') as can_insert,
            has_table_privilege(current_user, 'submissions_v2.source_offered_roles', 'update') as can_update,
            has_table_privilege(current_user, 'submissions_v2.source_offered_roles', 'delete') as can_delete,
            has_table_privilege(current_user, 'submissions_v2.source_offered_roles', 'truncate') as can_truncate
        `)[0];
        assert.equal(privileges.role_name, "submissions_v2_api");
        assert.equal(privileges.can_select, true);
        assert.equal(privileges.can_insert, true);
        assert.equal(privileges.can_update, false);
        assert.equal(privileges.can_delete, false);
        assert.equal(privileges.can_truncate, false);
        await apiSql`select 1 from submissions_v2.source_offered_roles where false`;
        return work(apiSql);
      }),
    };
    const result = await createRepository({ sql: apiDatabase }).bindUnresolvedSignal({
      actorEmail: "recruiter@raydar.xyz", idempotencyKey: randomUUID(), signalId,
      candidateId, roleIds: [roleId], note: "Exact role confirmed from immutable source evidence.",
    });

    assert.deepEqual(result.role_ids, [roleId]);
    assert.ok(result.job_id);
    assert.equal((await sql`
      select count(*)::integer as count from submissions_v2.source_offered_roles
       where signal_id=${signalId} and role_id=${roleId}
    `)[0].count, 1);
    assert.equal((await sql`
      select count(*)::integer as count from submissions_v2.jobs
       where id=${result.job_id} and kind='classify_email_reply' and state='queued'
    `)[0].count, 1);
    assert.equal((await sql`
      select processing_state from submissions_v2.source_events where id=${signalId}
    `)[0].processing_state, "ready");
  } finally {
    await setRuntimeControls({
      actorEmail: "admin@raydar.xyz", reason: "Restore controls after API-principal review-binding regression",
      ui: prior.ui_enabled, ingestion: prior.ingestion_enabled, generation: prior.generation_enabled,
      masterInbox: prior.master_inbox_enabled, curated: prior.curated_enabled,
    }, sql);
  }
});

test("the API principal closes an all-existing source binding as an audited duplicate without pair work", async () => {
  const prior = await readRuntimeControls(sql);
  const candidateId = `api-duplicate-candidate-${randomUUID()}`;
  const roleId = `api-duplicate-role-${randomUUID()}`;
  const priorSignalId = randomUUID();
  const signalId = randomUUID();
  const pairId = randomUUID();
  const priorEventId = `api-duplicate-prior-${randomUUID()}`;
  const duplicateEventId = `api-duplicate-source-${randomUUID()}`;
  const idempotencyKey = randomUUID();
  const note = "Confirmed this source maps to the already-recorded first response.";
  try {
    await setRuntimeControls({
      actorEmail: "admin@raydar.xyz", reason: "Enable API-principal duplicate-disposition regression",
      ui: true, ingestion: true, generation: prior.generation_enabled, masterInbox: true,
      curated: prior.curated_enabled,
    }, sql);
    await sql`
      insert into submissions_v2.candidate_index(
        candidate_user_id, display_name, normalized_name, search_key, active,
        paraform_profile_url, last_confirmed_at, source_digest
      ) values (
        ${candidateId}, 'Duplicate Recovery Candidate', 'duplicate recovery candidate', 'duplicate recovery candidate', true,
        ${`https://www.paraform.com/candidates?candidate=${candidateId}`}, clock_timestamp(), ${digest(candidateId)}
      )
    `;
    await sql`
      insert into submissions_v2.role_index(
        role_id, company_name, role_title, search_key, active, destination_url, last_confirmed_at, source_digest
      ) values (
        ${roleId}, 'Duplicate Recovery Company', 'Duplicate Recovery Engineer', 'duplicate recovery company duplicate recovery engineer', true,
        ${`https://www.paraform.com/browse?role=${roleId}`}, clock_timestamp(), ${digest(roleId)}
      )
    `;
    await sql`
      insert into submissions_v2.source_events(
        id, source_family, source_version, event_id, provider, mailbox_id, provider_message_id,
        direction, received_at, content_digest, processing_state, idempotency_key
      ) values (
        ${priorSignalId}, 'email', 'submissions.email_reply.v1', ${priorEventId}, 'master_inbox', 'mailbox-test',
        ${`message-${priorEventId}`}, 'inbound', clock_timestamp(), ${digest(priorSignalId)}, 'resolved', ${`source:${priorSignalId}`}
      )
    `;
    await sql`
      insert into submissions_v2.candidate_role_pairs(
        id, candidate_user_id, role_id, first_signal_id, intent_state, workflow_state,
        original_signal_at, role_state, submission_status
      ) values (
        ${pairId}, ${candidateId}, ${roleId}, ${priorSignalId}, 'interested', 'preparing_resume',
        clock_timestamp(), 'active', 'none'
      )
    `;
    await sql`
      insert into submissions_v2.first_response_claims(
        candidate_user_id, role_id, event_id, source_family, signal_id, committed_at
      ) values (${candidateId}, ${roleId}, ${priorEventId}, 'email', ${priorSignalId}, clock_timestamp())
    `;
    await sql`
      insert into submissions_v2.source_events(
        id, source_family, source_version, event_id, provider, mailbox_id, provider_message_id,
        direction, received_at, content_digest, processing_state, safe_error_code,
        safe_error_detail, idempotency_key, envelope
      ) values (
        ${signalId}, 'email', 'submissions.email_reply.v1', ${duplicateEventId}, 'master_inbox', 'mailbox-test',
        ${`message-${duplicateEventId}`}, 'inbound', clock_timestamp(), ${digest(signalId)}, 'needs_role',
        'role_unclear', 'The exact offered role was not present in the source contract.',
        ${`source:${signalId}`}, ${sql.json({ candidate_resolution: { candidate_user_id: candidateId } })}
      )
    `;
    await sql`
      insert into submissions_v2.review_items(unresolved_signal_id, reason_code, safe_detail)
      values (${signalId}, 'role_unclear', 'Select the exact role confirmed from the source email.')
    `;
    const beforePair = await sql`
      select id, intent_state, workflow_state, state_version, submission_status, first_signal_id
        from submissions_v2.candidate_role_pairs where id=${pairId}
    `;
    const beforeClaim = await sql`
      select candidate_user_id, role_id, event_id, source_family, signal_id, committed_at, released_at
        from submissions_v2.first_response_claims where candidate_user_id=${candidateId} and role_id=${roleId}
    `;
    const apiDatabase = {
      begin: (work) => sql.begin(async (apiSql) => {
        await apiSql.unsafe("set local role submissions_v2_api");
        return work(apiSql);
      }),
    };
    const repository = createRepository({ sql: apiDatabase });
    const result = await repository.bindUnresolvedSignal({
      actorEmail: "recruiter@raydar.xyz", idempotencyKey, signalId,
      candidateId, roleIds: [roleId], note,
    });
    assert.deepEqual(result, {
      signal_id: signalId, candidate_id: candidateId, role_ids: [roleId],
      duplicate: true, existing_pair_ids: [pairId], job_id: null,
    });
    const replay = await repository.bindUnresolvedSignal({
      actorEmail: "recruiter@raydar.xyz", idempotencyKey, signalId,
      candidateId, roleIds: [roleId], note,
    });
    assert.deepEqual(replay, { ...result, replay: true });
    assert.deepEqual(await sql`
      select id, intent_state, workflow_state, state_version, submission_status, first_signal_id
        from submissions_v2.candidate_role_pairs where id=${pairId}
    `, beforePair);
    assert.deepEqual(await sql`
      select candidate_user_id, role_id, event_id, source_family, signal_id, committed_at, released_at
        from submissions_v2.first_response_claims where candidate_user_id=${candidateId} and role_id=${roleId}
    `, beforeClaim);
    assert.equal((await sql`
      select processing_state from submissions_v2.source_events where id=${signalId}
    `)[0].processing_state, "ignored_later");
    const review = (await sql`
      select action_state, resolved_by, resolution_note
        from submissions_v2.review_items where unresolved_signal_id=${signalId}
    `)[0];
    assert.deepEqual(review, { action_state: "resolved", resolved_by: "recruiter@raydar.xyz", resolution_note: note });
    assert.equal((await sql`
      select count(*)::integer as count from submissions_v2.source_offered_roles
       where signal_id=${signalId} and role_id=${roleId}
    `)[0].count, 1);
    assert.equal((await sql`
      select count(*)::integer as count from submissions_v2.jobs where subject_id=${signalId}::text
    `)[0].count, 0);
    assert.equal((await sql`
      select count(*)::integer as count from submissions_v2.signal_role_decisions where signal_id=${signalId}
    `)[0].count, 0);
    assert.equal((await sql`
      select count(*)::integer as count from submissions_v2.pair_signal_links where signal_id=${signalId}
    `)[0].count, 0);

    const mixedRoleId = `api-duplicate-mixed-role-${randomUUID()}`;
    const mixedSignalId = randomUUID();
    await sql`
      insert into submissions_v2.role_index(
        role_id, company_name, role_title, search_key, active, destination_url, last_confirmed_at, source_digest
      ) values (
        ${mixedRoleId}, 'Duplicate Recovery Company', 'Second Exact Role', 'duplicate recovery company second exact role', true,
        ${`https://www.paraform.com/browse?role=${mixedRoleId}`}, clock_timestamp(), ${digest(mixedRoleId)}
      )
    `;
    await sql`
      insert into submissions_v2.source_events(
        id, source_family, source_version, event_id, provider, mailbox_id, provider_message_id,
        direction, received_at, content_digest, processing_state, safe_error_code,
        safe_error_detail, idempotency_key, envelope
      ) values (
        ${mixedSignalId}, 'email', 'submissions.email_reply.v1', ${`api-duplicate-mixed-${randomUUID()}`}, 'master_inbox', 'mailbox-test',
        ${`message-${mixedSignalId}`}, 'inbound', clock_timestamp(), ${digest(mixedSignalId)}, 'needs_role',
        'role_unclear', 'The exact offered role was not present in the source contract.',
        ${`source:${mixedSignalId}`}, ${sql.json({ candidate_resolution: { candidate_user_id: candidateId } })}
      )
    `;
    await sql`
      insert into submissions_v2.review_items(unresolved_signal_id, reason_code, safe_detail)
      values (${mixedSignalId}, 'role_unclear', 'Select the exact role confirmed from the source email.')
    `;
    await assert.rejects(
      repository.bindUnresolvedSignal({
        actorEmail: "recruiter@raydar.xyz", idempotencyKey: randomUUID(), signalId: mixedSignalId,
        candidateId, roleIds: [roleId, mixedRoleId], note,
      }),
      (error) => error?.code === "mixed_existing_pairs",
    );
    assert.equal((await sql`
      select processing_state from submissions_v2.source_events where id=${mixedSignalId}
    `)[0].processing_state, "needs_role");
    assert.equal((await sql`
      select action_state from submissions_v2.review_items where unresolved_signal_id=${mixedSignalId}
    `)[0].action_state, "open");
    assert.equal((await sql`
      select count(*)::integer as count from submissions_v2.source_offered_roles where signal_id=${mixedSignalId}
    `)[0].count, 0);
    assert.equal((await sql`
      select count(*)::integer as count from submissions_v2.first_response_claims
       where candidate_user_id=${candidateId} and role_id=${mixedRoleId}
    `)[0].count, 0);
    assert.equal((await sql`
      select count(*)::integer as count from submissions_v2.jobs where subject_id=${mixedSignalId}::text
    `)[0].count, 0);
  } finally {
    await setRuntimeControls({
      actorEmail: "admin@raydar.xyz", reason: "Restore controls after API-principal duplicate-disposition regression",
      ui: prior.ui_enabled, ingestion: prior.ingestion_enabled, generation: prior.generation_enabled,
      masterInbox: prior.master_inbox_enabled, curated: prior.curated_enabled,
    }, sql);
  }
});

test("a multi-role reply releases unmentioned roles for their later first response", async () => {
  const repository = createRepository({ sql, env: { SUBMISSIONS_V2_SLACK_CHANNEL_ID: "C123TEST" } });
  const prior = await readRuntimeControls(sql);
  const enabled = await setRuntimeControls({
    actorEmail: "admin@raydar.xyz", reason: "Enable multi-role first-response release regression",
    ui: prior.ui_enabled, ingestion: true, generation: true, masterInbox: true,
    curated: prior.curated_enabled,
  }, sql);
  const candidateId = `candidate-multi-${randomUUID()}`;
  const roleA = `role-a-${randomUUID()}`;
  const roleB = `role-b-${randomUUID()}`;
  const signalId = randomUUID();
  const eventId = `event-multi-${randomUUID()}`;
  await sql`
    insert into submissions_v2.candidate_index(
      candidate_user_id, display_name, normalized_name, search_key, active,
      paraform_profile_url, last_confirmed_at, source_digest
    ) values (
      ${candidateId}, 'Multi Role Candidate', 'multi role candidate', 'multi role candidate', true,
      ${`https://www.paraform.com/candidates?candidate=${candidateId}`}, clock_timestamp(), ${digest(candidateId)}
    )
  `;
  for (const [roleId, title] of [[roleA, "Role A"], [roleB, "Role B"]]) {
    await sql`
      insert into submissions_v2.role_index(
        role_id, company_name, role_title, search_key, active, destination_url, last_confirmed_at, source_digest
      ) values (
        ${roleId}, 'Multi Company', ${title}, ${`multi company ${title.toLowerCase()}`}, true,
        ${`https://www.paraform.com/browse?role=${roleId}`}, clock_timestamp(), ${digest(roleId)}
      )
    `;
  }
  await sql`
    insert into submissions_v2.source_events(
      id, source_family, source_version, event_id, provider, mailbox_id, provider_message_id,
      direction, received_at, content_digest, processing_state, idempotency_key, envelope
    ) values (
      ${signalId}, 'email', 'submissions.email_reply.v1', ${eventId}, 'master_inbox', 'mailbox-test',
      ${`message-${eventId}`}, 'inbound', clock_timestamp(), ${digest(signalId)}, 'ready',
      ${`source:${signalId}`}, ${sql.json({ candidate_resolution: { candidate_user_id: candidateId } })}
    )
  `;
  await sql`
    insert into submissions_v2.source_offered_roles(
      signal_id, role_id, company_snapshot, role_label_snapshot, role_url_snapshot, offered_order, content_digest
    ) values
      (${signalId}, ${roleA}, 'Multi Company', 'Role A', ${`https://www.paraform.com/browse?role=${roleA}`}, 0, ${digest(`${signalId}:${roleA}`)}),
      (${signalId}, ${roleB}, 'Multi Company', 'Role B', ${`https://www.paraform.com/browse?role=${roleB}`}, 1, ${digest(`${signalId}:${roleB}`)})
  `;
  await sql`
    insert into submissions_v2.first_response_claims(
      candidate_user_id, role_id, event_id, source_family, signal_id, committed_at
    ) values
      (${candidateId}, ${roleA}, ${eventId}, 'email', ${signalId}, clock_timestamp()),
      (${candidateId}, ${roleB}, ${eventId}, 'email', ${signalId}, clock_timestamp())
  `;
  const jobId = randomUUID();
  await sql`
    insert into submissions_v2.jobs(id, kind, subject_type, subject_id, idempotency_key, required_control, control_epoch)
    values (${jobId}, 'classify_email_reply', 'signal', ${signalId}, ${`job:${jobId}`}, 'master_inbox', ${enabled.control_epoch})
  `;
  const claimed = (await claimJobs({
    workerId: "multi-role-worker", kinds: ["classify_email_reply"], limit: 1,
    leaseSeconds: 120, controlEpoch: enabled.control_epoch,
  }, sql))[0];
  await repository.applyClassifiedSignal({
    signalId, candidateId,
    decisions: [{ role_id: roleA, label: "interested", quote: "I am interested in Role A.", review_reason: null, negative_reason: null }],
    attempts: [{ outcome: "accepted", model: "test-model" }],
    executionFence: {
      jobId: claimed.id, workerId: claimed.lease_owner,
      fencingToken: Number(claimed.fencing_token), controlEpoch: Number(enabled.control_epoch),
    },
  });
  const claims = await sql`
    select role_id, released_at is not null as released, release_reason
      from submissions_v2.first_response_claims where signal_id=${signalId} order by role_id
  `;
  assert.deepEqual([...claims], [
    { role_id: roleA, released: false, release_reason: null },
    { role_id: roleB, released: true, release_reason: "unmentioned_role" },
  ]);
  const later = await repository.claimEmailFirstResponse({
    eventId: `later-${randomUUID()}`, idempotencyKey: `later:${randomUUID()}`,
    candidateId, offeredRoles: [{ role_id: roleB }],
  });
  assert.deepEqual(later.eligible_role_ids, [roleB]);
  assert.equal(later.ignored_later, false);
  await sql`update submissions_v2.candidate_index set active=false where candidate_user_id=${candidateId}`;
  await setRuntimeControls({
    actorEmail: "admin@raydar.xyz", reason: "Restore controls after multi-role first-response release regression",
    ui: prior.ui_enabled, ingestion: prior.ingestion_enabled, generation: prior.generation_enabled,
    masterInbox: prior.master_inbox_enabled, curated: prior.curated_enabled,
  }, sql);
});

test("a later classified reply never attaches to an existing or hidden first-response pair", async () => {
  const repository = createRepository({ sql });
  const priorControls = await readRuntimeControls(sql);
  const enabled = await setRuntimeControls({
    actorEmail: "admin@raydar.xyz", reason: "Enable hidden-pair classification regression",
    ui: priorControls.ui_enabled, ingestion: true, generation: true, masterInbox: true,
    curated: priorControls.curated_enabled,
  }, sql);
  const candidateId = `candidate-${randomUUID()}`;
  const roleId = `role-${randomUUID()}`;
  await sql`
    insert into submissions_v2.candidate_index(
      candidate_user_id, display_name, normalized_name, search_key,
      active, paraform_profile_url, last_confirmed_at, source_digest
    ) values (${candidateId}, 'Hidden Candidate', 'hidden candidate', 'hidden candidate',
              true, ${`https://www.paraform.com/candidates?candidate=${candidateId}`}, clock_timestamp(), ${digest(candidateId)})
  `;
  await sql`
    insert into submissions_v2.role_index(role_id, company_name, role_title, search_key, active, destination_url, last_confirmed_at, source_digest)
    values (${roleId}, 'Hidden Company', 'Engineer', 'hidden company engineer', true, ${`https://www.paraform.com/browse?role=${roleId}`}, clock_timestamp(), ${digest(roleId)})
  `;
  const pair = await preparingPair({ candidate: candidateId, role: roleId });
  await sql`update submissions_v2.candidate_role_pairs set case_hidden_at=clock_timestamp(), state_version=state_version+1 where id=${pair.id}`;
  const signalId = randomUUID();
  await sql`
    insert into submissions_v2.source_events(
      id, source_family, source_version, event_id, provider, mailbox_id, provider_message_id,
      direction, received_at, content_digest, processing_state, idempotency_key, envelope
    ) values (
      ${signalId}, 'email', 'submissions.email_reply.v1', ${`event-${signalId}`}, 'master_inbox',
      'mailbox-test', ${`message-${signalId}`}, 'inbound', clock_timestamp(), ${digest(signalId)},
      'ready', ${`source:${signalId}`}, ${sql.json({ candidate_resolution: { candidate_user_id: candidateId } })}
    )
  `;
  await sql`
    insert into submissions_v2.source_offered_roles(signal_id, role_id, company_snapshot, role_label_snapshot, role_url_snapshot, content_digest)
    values (${signalId}, ${roleId}, 'Hidden Company', 'Engineer', ${`https://www.paraform.com/browse?role=${roleId}`}, ${digest(`${signalId}:${roleId}`)})
  `;
  const jobId = randomUUID();
  await sql`
    insert into submissions_v2.jobs(id, kind, subject_type, subject_id, idempotency_key, required_control, control_epoch)
    values (${jobId}, 'classify_email_reply', 'signal', ${signalId}, ${`job:${jobId}`}, 'master_inbox', ${enabled.control_epoch})
  `;
  const claimed = (await claimJobs({ workerId: 'hidden-pair-worker', kinds: ['classify_email_reply'], limit: 1, leaseSeconds: 120, controlEpoch: enabled.control_epoch }, sql))[0];
  const result = await repository.applyClassifiedSignal({
    signalId, candidateId,
    decisions: [{ role_id: roleId, label: 'interested', quote: 'Yes', review_reason: null, negative_reason: null }],
    attempts: [{ outcome: 'accepted', model: 'test-model' }],
    executionFence: { jobId: claimed.id, workerId: claimed.lease_owner, fencingToken: Number(claimed.fencing_token), controlEpoch: Number(enabled.control_epoch) },
  });
  assert.equal(result.created_count, 0);
  assert.equal(result.pairs[0].state, 'ignored_later');
  assert.equal((await sql`select count(*)::integer as count from submissions_v2.pair_signal_links where signal_id=${signalId}`)[0].count, 0);
  assert.equal((await sql`select count(*)::integer as count from submissions_v2.signal_role_decisions where signal_id=${signalId}`)[0].count, 0);
  assert.equal((await sql`select processing_state from submissions_v2.source_events where id=${signalId}`)[0].processing_state, 'ignored_later');
  await sql`update submissions_v2.candidate_index set active=false where candidate_user_id=${candidateId}`;
  await setRuntimeControls({
    actorEmail: "admin@raydar.xyz", reason: "Restore controls after hidden-pair classification regression",
    ui: priorControls.ui_enabled, ingestion: priorControls.ingestion_enabled, generation: priorControls.generation_enabled,
    masterInbox: priorControls.master_inbox_enabled, curated: priorControls.curated_enabled,
  }, sql);
});

test("a later hidden-pair email is dropped before Blob storage and classifier access", async () => {
  const prior = await readRuntimeControls(sql);
  await setRuntimeControls({
    actorEmail: "admin@raydar.xyz", reason: "Enable intake privacy regression",
    ui: prior.ui_enabled, ingestion: true, generation: prior.generation_enabled,
    masterInbox: true, curated: prior.curated_enabled,
  }, sql);
  const candidateId = `candidate-${randomUUID()}`;
  const roleId = `role-${randomUUID()}`;
  const matchHmac = `match-${randomUUID()}`;
  await sql`
    insert into submissions_v2.candidate_index(
      candidate_user_id, display_name, normalized_name, search_key, active,
      email_match_hmac_current, email_match_hmac_current_version,
      paraform_profile_url, last_confirmed_at, source_digest
    ) values (
      ${candidateId}, 'Private Candidate', 'private candidate', 'private candidate', true,
      ${matchHmac}, 'v1', ${`https://www.paraform.com/candidates?candidate=${candidateId}`},
      clock_timestamp(), ${digest(candidateId)}
    )
  `;
  const pair = await preparingPair({ candidate: candidateId, role: roleId });
  await sql`update submissions_v2.candidate_role_pairs set case_hidden_at=clock_timestamp(), state_version=state_version+1 where id=${pair.id}`;
  let blobWrites = 0;
  let classifierCalls = 0;
  const service = createService({
    repository: createRepository({ sql }),
    env: {
      SUBMISSIONS_V2_UI_ENABLED: "true", SUBMISSIONS_V2_INGESTION_ENABLED: "true",
      SUBMISSIONS_V2_GENERATION_ENABLED: "true", SUBMISSIONS_V2_MASTER_INBOX_ENABLED: "true",
      SUBMISSIONS_V2_CURATED_ENABLED: "true",
      SUBMISSIONS_V2_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64url"),
    },
    classifier: async () => { classifierCalls += 1; return {}; },
    blob: { putPrivateObject: async () => { blobWrites += 1; } },
  });
  const eventId = `privacy-${randomUUID()}`;
  const result = await service.intakeMasterInbox({
    id: eventId, eventKey: `master-inbox:${eventId}:${roleId}`, contractVersion: 1,
    family: "new_match", mailboxId: "privacy-mailbox", providerMessageId: eventId,
    senderMatchHmac: { key_version: "v1", digest: matchHmac }, roleId,
    payload: { receivedAt: new Date().toISOString(), candidateText: "Yes, please submit me.", sentMessageText: "Are you interested?", conversationId: eventId },
  });
  assert.equal(result.processing_state, "ignored_later");
  assert.equal(result.signal_id, null);
  assert.equal(blobWrites, 0);
  assert.equal(classifierCalls, 0);
  assert.equal((await sql`select count(*)::integer as count from submissions_v2.source_events where provider_message_id=${eventId}`)[0].count, 0);
  assert.equal((await sql`select event_count from submissions_v2.privacy_safe_metrics where metric_key='later_signal_dropped'`)[0].event_count >= 1, true);
  await setRuntimeControls({
    actorEmail: "admin@raydar.xyz", reason: "Restore controls after intake privacy regression",
    ui: prior.ui_enabled, ingestion: prior.ingestion_enabled, generation: prior.generation_enabled,
    masterInbox: prior.master_inbox_enabled, curated: prior.curated_enabled,
  }, sql);
});

test("a new review reason for an existing unresolved entry never announces a new admission", async () => {
  const repository = createRepository({ sql, env: { SUBMISSIONS_V2_SLACK_CHANNEL_ID: "C123TEST" } });
  const prior = await readRuntimeControls(sql);
  const enabled = await setRuntimeControls({
    actorEmail: "admin@raydar.xyz", reason: "Enable first-review admission regression",
    ui: true, ingestion: true, generation: true, masterInbox: true, curated: prior.curated_enabled,
  }, sql);
  try {
    for (const historical of [false, true]) {
      const signalId = await sourceEvent({ family: "email", senderDisplayName: "Review Candidate" });
      const originalTime = "2026-09-01T12:00:00.000Z";
      if (historical) {
        await sql`
          insert into submissions_v2.review_items(unresolved_signal_id, reason_code, safe_detail, opened_at)
          values (${signalId}, 'candidate_not_found', 'Select the exact candidate.', ${originalTime})
        `;
      }
      const jobId = randomUUID();
      await sql`
        insert into submissions_v2.jobs(id, kind, subject_type, subject_id, idempotency_key, required_control, control_epoch)
        values (${jobId}, 'classify_email_reply', 'signal', ${signalId}, ${`job:${jobId}`}, 'master_inbox', ${enabled.control_epoch})
      `;
      const claimed = (await claimJobs({
        workerId: `first-review-${jobId}`, kinds: ["classify_email_reply"], limit: 50,
        leaseSeconds: 120, controlEpoch: enabled.control_epoch,
      }, sql)).find((row) => row.id === jobId);
      assert.ok(claimed);
      const input = {
        signalId, attempts: [{ outcome: "failed", model: "test-model", reason: "provider_timeout" }],
        safeDetail: "Classification stopped safely.",
        executionFence: {
          jobId, workerId: claimed.lease_owner, fencingToken: Number(claimed.fencing_token),
          controlEpoch: Number(enabled.control_epoch),
        },
      };
      assert.deepEqual((await repository.routeClassificationFailure(input)).pairs, []);
      assert.equal((await repository.routeClassificationFailure(input)).existing, true);
      const rows = await sql`
        select state, safe_error_code, safe_payload from submissions_v2.notification_outbox
         where dedupe_key=${`submission-added:signal:${signalId}`}
      `;
      assert.equal(rows.length, 1);
      assert.equal(rows[0].state, historical ? "held" : "pending");
      assert.equal(rows[0].safe_error_code, historical ? "pre_release_admission_suppressed" : null);
      const firstReview = (await sql`
        select opened_at from submissions_v2.review_items
         where unresolved_signal_id=${signalId} order by opened_at, id limit 1
      `)[0];
      assert.equal(rows[0].safe_payload.added_at, new Date(firstReview.opened_at).toISOString());
      if (historical) assert.equal(rows[0].safe_payload.added_at, originalTime);
      assert.equal((await sql`select count(*)::int as count from submissions_v2.review_items where unresolved_signal_id=${signalId}`)[0].count, historical ? 2 : 1);
    }
  } finally {
    await setRuntimeControls({
      actorEmail: "admin@raydar.xyz", reason: "Restore first-review admission regression controls",
      ui: prior.ui_enabled, ingestion: prior.ingestion_enabled, generation: prior.generation_enabled,
      masterInbox: prior.master_inbox_enabled, curated: prior.curated_enabled,
    }, sql);
  }
});

test("classification-failure replay stays terminal until an approved retry recovers the same pair", async () => {
  const repository = createRepository({ sql, env: { SUBMISSIONS_V2_SLACK_CHANNEL_ID: "C123TEST" } });
  const priorControls = await readRuntimeControls(sql);
  const enabled = await setRuntimeControls({
    actorEmail: "admin@raydar.xyz", reason: "Enable classification-failure replay regression",
    ui: priorControls.ui_enabled, ingestion: true, generation: true, masterInbox: true,
    curated: priorControls.curated_enabled,
  }, sql);
  const candidateId = `candidate-${randomUUID()}`;
  const roleId = `role-${randomUUID()}`;
  const signalId = randomUUID();
  await sql`
    insert into submissions_v2.candidate_index(
      candidate_user_id, display_name, normalized_name, search_key, active,
      paraform_profile_url, last_confirmed_at, source_digest
    ) values (
      ${candidateId}, 'Replay Candidate', 'replay candidate', 'replay candidate', true,
      ${`https://www.paraform.com/candidates?candidate=${candidateId}`}, clock_timestamp(), ${digest(candidateId)}
    )
  `;
  await sql`
    insert into submissions_v2.role_index(
      role_id, company_name, role_title, search_key, active, destination_url, last_confirmed_at, source_digest
    ) values (
      ${roleId}, 'Replay Company', 'Replay Role', 'replay company replay role', true,
      ${`https://www.paraform.com/browse?role=${roleId}`}, clock_timestamp(), ${digest(roleId)}
    )
  `;
  await sql`
    insert into submissions_v2.source_events(
      id, source_family, source_version, event_id, provider, mailbox_id, provider_message_id,
      direction, received_at, content_digest, processing_state, idempotency_key, envelope
    ) values (
      ${signalId}, 'email', 'submissions.email_reply.v1', ${`event-${signalId}`}, 'master_inbox',
      'mailbox-test', ${`message-${signalId}`}, 'inbound', clock_timestamp(), ${digest(signalId)},
      'ready', ${`source:${signalId}`}, ${sql.json({ candidate_resolution: { candidate_user_id: candidateId } })}
    )
  `;
  await sql`
    insert into submissions_v2.source_offered_roles(
      signal_id, role_id, company_snapshot, role_label_snapshot, role_url_snapshot, content_digest
    ) values (
      ${signalId}, ${roleId}, 'Replay Company', 'Replay Role',
      ${`https://www.paraform.com/browse?role=${roleId}`}, ${digest(`${signalId}:${roleId}`)}
    )
  `;
  const jobId = randomUUID();
  await sql`
    insert into submissions_v2.jobs(id, kind, subject_type, subject_id, idempotency_key, required_control, control_epoch)
    values (${jobId}, 'classify_email_reply', 'signal', ${signalId}, ${`job:${jobId}`}, 'master_inbox', ${enabled.control_epoch})
  `;
  const claimed = (await claimJobs({
    workerId: 'classification-replay-worker', kinds: ['classify_email_reply'], limit: 1,
    leaseSeconds: 120, controlEpoch: enabled.control_epoch,
  }, sql))[0];
  const input = {
    signalId,
    attempts: [{ outcome: 'failed', model: 'test-model', reason: 'provider_timeout' }],
    safeDetail: 'Both classifier paths failed safely.',
    executionFence: {
      jobId: claimed.id, workerId: claimed.lease_owner,
      fencingToken: Number(claimed.fencing_token), controlEpoch: Number(enabled.control_epoch),
    },
  };
  const first = await repository.routeClassificationFailure(input);
  const replay = await repository.routeClassificationFailure(input);
  assert.equal(first.existing, undefined);
  assert.equal(replay.existing, true);
  assert.equal((await sql`select processing_state from submissions_v2.source_events where id=${signalId}`)[0].processing_state, 'quarantined');
  assert.equal((await sql`select count(*)::integer as count from submissions_v2.review_items where pair_id=${first.pairs[0]}`)[0].count, 1);
  assert.equal((await sql`select count(*)::integer as count from submissions_v2.pair_signal_links where signal_id=${signalId}`)[0].count, 1);
  assert.equal((await sql`
    select count(*)::integer as count from submissions_v2.notification_outbox
     where pair_id=${first.pairs[0]} and kind='classification_failed'
  `)[0].count, 1);
  assert.equal((await sql`
    select count(*)::integer as count from submissions_v2.notification_outbox
     where pair_id=${first.pairs[0]} and kind='submission_added'
  `)[0].count, 1);
  const retryJobId = randomUUID();
  await sql`
    insert into submissions_v2.jobs(id, kind, subject_type, subject_id, idempotency_key, required_control, control_epoch)
    values (${retryJobId}, 'classify_email_reply', 'signal', ${signalId}, ${`job:${retryJobId}`}, 'master_inbox', ${enabled.control_epoch})
  `;
  const retryClaim = (await claimJobs({
    workerId: 'classification-retry-worker', kinds: ['classify_email_reply'], limit: 1,
    leaseSeconds: 120, controlEpoch: enabled.control_epoch,
  }, sql))[0];
  const recovered = await repository.applyClassifiedSignal({
    signalId,
    candidateId,
    decisions: [{ role_id: roleId, label: 'interested', quote: 'Yes, I am interested.', review_reason: null, negative_reason: null }],
    attempts: [{ outcome: 'accepted', model: 'test-model' }],
    executionFence: {
      jobId: retryClaim.id, workerId: retryClaim.lease_owner,
      fencingToken: Number(retryClaim.fencing_token), controlEpoch: Number(enabled.control_epoch),
    },
  });
  assert.equal(recovered.created_count, 0);
  assert.equal(recovered.recovered_count, 1);
  assert.equal(recovered.pairs[0].pair_id, first.pairs[0]);
  assert.equal((await sql`select processing_state from submissions_v2.source_events where id=${signalId}`)[0].processing_state, 'resolved');
  assert.equal((await sql`select workflow_state from submissions_v2.candidate_role_pairs where id=${first.pairs[0]}`)[0].workflow_state, 'preparing_resume');
  assert.equal((await sql`select count(*)::integer as count from submissions_v2.review_items where pair_id=${first.pairs[0]} and action_state='open'`)[0].count, 0);
  assert.equal((await sql`select count(*)::integer as count from submissions_v2.jobs where kind='prepare_resume' and subject_id=${first.pairs[0]}::text`)[0].count, 1);
  const attemptAudit = await sql`
    select attempt, execution_id, attempt_in_execution, outcome
      from submissions_v2.classification_attempts where signal_id=${signalId} order by attempt
  `;
  assert.equal(attemptAudit.length, 2);
  assert.equal(attemptAudit[0].outcome, 'timeout');
  assert.equal(attemptAudit[1].outcome, 'passed');
  assert.notEqual(attemptAudit[0].execution_id, attemptAudit[1].execution_id);
  await sql`update submissions_v2.candidate_index set active=false where candidate_user_id=${candidateId}`;
  await setRuntimeControls({
    actorEmail: "admin@raydar.xyz", reason: "Restore controls after classification-failure replay regression",
    ui: priorControls.ui_enabled, ingestion: priorControls.ingestion_enabled, generation: priorControls.generation_enabled,
    masterInbox: priorControls.master_inbox_enabled, curated: priorControls.curated_enabled,
  }, sql);
});

test("human recovery commands reject terminal sources and non-Interested resume retries", async () => {
  const repository = createRepository({ sql });
  const prior = await readRuntimeControls(sql);
  await setRuntimeControls({
    actorEmail: "admin@raydar.xyz", reason: "Enable human recovery authority regression",
    ui: true, ingestion: true, generation: true, masterInbox: true, curated: prior.curated_enabled,
  }, sql);
  const terminalSignal = await sourceEvent();
  await sql`update submissions_v2.source_events set processing_state='resolved', processed_at=clock_timestamp() where id=${terminalSignal}`;
  await assert.rejects(
    repository.bindUnresolvedSignal({
      actorEmail: "recruiter@raydar.xyz", idempotencyKey: randomUUID(),
      signalId: terminalSignal, candidateId: "candidate-other", roleIds: [], note: "wrong candidate",
    }),
    (error) => error.code === "source_not_unresolved",
  );

  const pair = await preparingPair();
  await sql`
    update submissions_v2.candidate_role_pairs
       set intent_state='not_interested', workflow_state='not_interested', state_version=state_version+1
     where id=${pair.id}
  `;
  await assert.rejects(
    repository.enqueuePairAction({
      actorEmail: "recruiter@raydar.xyz", idempotencyKey: randomUUID(),
      pairId: pair.id, expectedVersion: 2, action: "retry_preparation",
      kind: "prepare_resume", requiredControl: "generation", checkpoint: { trigger_kind: "retry" },
    }),
    (error) => error.code === "resume_retry_not_eligible",
  );
  const maliciousJobId = randomUUID();
  await sql`
    insert into submissions_v2.jobs(
      id, kind, subject_type, subject_id, idempotency_key, required_control, control_epoch,
      state, lease_owner, lease_expires_at, fencing_token, attempt_count, started_at
    ) values (
      ${maliciousJobId}, 'prepare_resume', 'pair', ${pair.id}::text, ${randomUUID()}, 'generation',
      ${(await readRuntimeControls(sql)).control_epoch}, 'running', 'malicious-worker',
      clock_timestamp() + interval '2 minutes', 1, 1, clock_timestamp()
    )
  `;
  await assert.rejects(
    repository.startResumeGeneration({
      pairId: pair.id, triggerKind: "retry", idempotencyKey: randomUUID(), expectedPairVersion: 2,
      primaryModelPin: "claude-opus-5", fallbackModelPin: "claude-opus-4.8",
      validatorModelPin: "gpt-5.4", promptPin: "test", templatePin: "test",
      deadlineAt: new Date(Date.now() + 60_000).toISOString(),
      executionFence: {
        jobId: maliciousJobId, workerId: "malicious-worker", fencingToken: 1,
        controlEpoch: (await readRuntimeControls(sql)).control_epoch,
      },
    }),
    (error) => error.code === "generation_pair_not_eligible",
  );
});

test("regeneration rejects overlapping work and list progress stays active across retry gaps", async () => {
  const pair = await preparingPair();
  const repository = createRepository({ sql });
  const preparingRows = await repository.list({ page: "interested" });
  const visiblePreparing = preparingRows.rows.find((row) => row.pair_id === pair.id);
  assert.equal(visiblePreparing?.workflow_state, "preparing_resume");
  assert.equal(visiblePreparing?.current_artifact_id, null);
  const preparingCounts = await repository.counts();
  assert.ok(Number(preparingCounts.interested) >= 1);
  assert.ok(Number(preparingCounts.actionable) >= 1);
  const priorGenerationId = randomUUID();
  await sql`
    insert into submissions_v2.resume_generations(
      id, pair_id, generation_version, trigger_kind, idempotency_key, status, stage,
      expected_pair_version, first_signal_id, primary_model_pin, fallback_model_pin,
      validator_model_pin, prompt_pin, template_pin, deadline_at, completed_at
    ) values (
      ${priorGenerationId}, ${pair.id}, 1, 'initial', ${`generation:${priorGenerationId}`}, 'succeeded', 'complete',
      1, ${pair.signal}, 'opus-test', 'opus-fallback-test', 'validator-test',
      'prompt-test', 'template-test', clock_timestamp() + interval '5 minutes', clock_timestamp()
    )
  `;
  const artifactId = randomUUID();
  const atsArtifactId = randomUUID();
  const manifestArtifactId = randomUUID();
  await sql`
    insert into submissions_v2.resume_artifacts(
      id, pair_id, generation_id, artifact_version, kind, private_object_key,
      digest, size_bytes, page_count, validation_status, archive_readback_at, archived_at, current_state
    ) values (
      ${artifactId}, ${pair.id}, ${priorGenerationId}, 1, 'pdf',
      ${`submissions/resumes/v2/pdf/${artifactId}`}, ${digest("prior-resume")}, 100, 1,
      'passed', clock_timestamp(), clock_timestamp(), 'current'
    ), (
      ${atsArtifactId}, ${pair.id}, ${priorGenerationId}, 1, 'ats',
      ${`submissions/resumes/v2/ats/${atsArtifactId}`}, ${digest("prior-ats")}, 100, null,
      'passed', clock_timestamp(), clock_timestamp(), 'current'
    ), (
      ${manifestArtifactId}, ${pair.id}, ${priorGenerationId}, 1, 'manifest',
      ${`submissions/resumes/v2/manifests/${manifestArtifactId}`}, ${digest("prior-manifest")}, 100, null,
      'passed', clock_timestamp(), clock_timestamp(), 'current'
    )
  `;
  await sql`
    update submissions_v2.candidate_role_pairs
       set workflow_state='interested', current_artifact_id=${artifactId}, resume_ready_at=clock_timestamp(),
           state_version=state_version+1
     where id=${pair.id}
  `;
  const activeGenerationId = randomUUID();
  await sql`
    insert into submissions_v2.resume_generations(
      id, pair_id, generation_version, trigger_kind, idempotency_key, status, stage,
      expected_pair_version, first_signal_id, primary_model_pin, fallback_model_pin,
      validator_model_pin, prompt_pin, template_pin, prior_artifact_id, deadline_at
    ) values (
      ${activeGenerationId}, ${pair.id}, 2, 'regenerate', ${`generation:${activeGenerationId}`}, 'validating', 'validate',
      2, ${pair.signal}, 'opus-test', 'opus-fallback-test', 'validator-test',
      'prompt-test', 'template-test', ${artifactId}, clock_timestamp() + interval '5 minutes'
    )
  `;
  const activeRows = await repository.list({ page: "interested" });
  assert.equal(activeRows.rows.find((row) => row.pair_id === pair.id)?.generation_status, "validating");
  await assert.rejects(
    repository.regenerate({
      actorEmail: "admin@raydar.xyz", idempotencyKey: `regenerate:${randomUUID()}`,
      pairId: pair.id, expectedVersion: 2, evidenceBasis: null, sourceNote: null,
    }),
    (error) => error.code === "resume_regeneration_in_progress" && error.status === 409,
  );
  assert.equal((await sql`
    select count(*)::integer as count from submissions_v2.jobs
     where subject_type='pair' and subject_id=${pair.id} and kind='prepare_resume'
  `)[0].count, 0);

  await sql`
    update submissions_v2.resume_generations
       set status='failed', stage='retry_scheduled', completed_at=clock_timestamp()
     where id=${activeGenerationId}
  `;
  const retryJobId = randomUUID();
  await sql`
    insert into submissions_v2.jobs(
      id, kind, subject_type, subject_id, idempotency_key, required_control,
      state, priority, max_attempts, checkpoint, control_epoch
    ) values (
      ${retryJobId}, 'prepare_resume', 'pair', ${pair.id}, ${`retry-gap:${retryJobId}`}, 'generation',
      'queued', 40, 3, '{}'::jsonb,
      (select control_epoch from submissions_v2.runtime_controls where singleton=true)
    )
  `;
  const retryGapRows = await repository.list({ page: "interested" });
  assert.equal(retryGapRows.rows.find((row) => row.pair_id === pair.id)?.generation_status, "queued");
  await assert.rejects(
    repository.regenerate({
      actorEmail: "admin@raydar.xyz", idempotencyKey: `regenerate:${randomUUID()}`,
      pairId: pair.id, expectedVersion: 2, evidenceBasis: null, sourceNote: null,
    }),
    (error) => error.code === "resume_regeneration_in_progress" && error.status === 409,
  );
});

test("artifact promotion requires the complete validated PDF, ATS, and manifest set", async () => {
  const pair = await preparingPair();
  const generationId = randomUUID();
  const deadline = new Date(Date.now() + 5 * 60_000);
  await sql`
    insert into submissions_v2.resume_generations (
      id, pair_id, generation_version, trigger_kind, idempotency_key, status, stage,
      expected_pair_version, first_signal_id, primary_model_pin, fallback_model_pin,
      validator_model_pin, prompt_pin, template_pin, deadline_at
    ) values (
      ${generationId}, ${pair.id}, 1, 'initial', ${randomUUID()}, 'archiving', 'archive',
      1, ${pair.signal}, 'claude-opus-5', 'claude-opus-5', 'gpt-5.4-2026-03-05',
      'resume-v2', 'raydar-resume-v1', ${deadline}
    )
  `;
  const pdfId = randomUUID();
  await sql`
    insert into submissions_v2.resume_artifacts (
      id, pair_id, generation_id, artifact_version, kind, private_object_key, digest,
      size_bytes, page_count, text_digest, validation_status, archive_readback_at,
      archived_at, current_state
    ) values (
      ${pdfId}, ${pair.id}, ${generationId}, 1, 'pdf', ${`submissions/resumes/v2/${pair.id}/resume.pdf`},
      ${digest("pdf")}, 1000, 1, ${digest("text")}, 'passed', clock_timestamp(), clock_timestamp(), 'current'
    )
  `;
  await assert.rejects(
    sql`
      update submissions_v2.candidate_role_pairs
         set workflow_state = 'interested', current_artifact_id = ${pdfId},
             resume_ready_at = clock_timestamp(), state_version = state_version + 1
       where id = ${pair.id}
    `,
    /PDF, ATS, and manifest/,
  );
  for (const kind of ["ats", "manifest"]) {
    await sql`
      insert into submissions_v2.resume_artifacts (
        pair_id, generation_id, artifact_version, kind, private_object_key, digest,
        size_bytes, text_digest, validation_status, archive_readback_at, archived_at, current_state
      ) values (
        ${pair.id}, ${generationId}, 1, ${kind}, ${`submissions/resumes/v2/${pair.id}/${kind}.txt`},
        ${digest(kind)}, 500, ${digest(`${kind}-text`)}, 'passed', clock_timestamp(), clock_timestamp(), 'current'
      )
    `;
  }
  await sql`
    update submissions_v2.candidate_role_pairs
       set workflow_state = 'interested', current_artifact_id = ${pdfId},
           resume_ready_at = clock_timestamp(), state_version = state_version + 1
     where id = ${pair.id}
  `;
  const rows = await sql`select workflow_state from submissions_v2.candidate_role_pairs where id = ${pair.id}`;
  assert.equal(rows[0].workflow_state, "interested");
});

test("download tickets replay one issuance and redeem exactly once", async () => {
  const repository = createRepository({ sql });
  const priorControls = await readRuntimeControls(sql);
  await setRuntimeControls({
    actorEmail: "test@raydar.xyz", reason: "Enable UI for download command test",
    ui: true, ingestion: priorControls.ingestion_enabled, generation: priorControls.generation_enabled,
    masterInbox: priorControls.master_inbox_enabled, curated: priorControls.curated_enabled,
  }, sql);
  const pair = await preparingPair();
  const generationId = randomUUID();
  const deadline = new Date(Date.now() + 5 * 60_000);
  await sql`
    insert into submissions_v2.resume_generations (
      id, pair_id, generation_version, trigger_kind, idempotency_key, status, stage,
      expected_pair_version, first_signal_id, primary_model_pin, fallback_model_pin,
      validator_model_pin, prompt_pin, template_pin, deadline_at
    ) values (
      ${generationId}, ${pair.id}, 1, 'initial', ${randomUUID()}, 'succeeded', 'complete',
      1, ${pair.signal}, 'claude-opus-5', 'claude-opus-5', 'gpt-5.4-2026-03-05',
      'resume-v2', 'raydar-resume-v1', ${deadline}
    )
  `;
  let pdfId;
  for (const kind of ["pdf", "ats", "manifest"]) {
    const artifactId = randomUUID();
    if (kind === "pdf") pdfId = artifactId;
    await sql`
      insert into submissions_v2.resume_artifacts (
        id, pair_id, generation_id, artifact_version, kind, private_object_key, digest,
        size_bytes, page_count, text_digest, validation_status, archive_readback_at,
        archived_at, current_state
      ) values (
        ${artifactId}, ${pair.id}, ${generationId}, 1, ${kind},
        ${`submissions/resumes/v2/${pair.id}/${kind}`}, ${digest(kind)}, 500,
        ${kind === "pdf" ? 1 : null}, ${digest(`${kind}-text`)}, 'passed',
        clock_timestamp(), clock_timestamp(), 'current'
      )
    `;
  }
  await sql`
    update submissions_v2.candidate_role_pairs
       set workflow_state='interested', current_artifact_id=${pdfId},
           resume_ready_at=clock_timestamp(), state_version=state_version+1
     where id=${pair.id}
  `;
  const ticketId = randomUUID();
  const expiresAt = Date.now() + 5 * 60_000;
  const first = await repository.issueDownload({
    actorEmail: "recruiter@raydar.xyz", idempotencyKey: `download:${pair.id}`,
    pairId: pair.id, expectedVersion: 2, ticketId, expiresAt,
  });
  const replay = await repository.issueDownload({
    actorEmail: "recruiter@raydar.xyz", idempotencyKey: `download:${pair.id}`,
    pairId: pair.id, expectedVersion: 2, ticketId: randomUUID(), expiresAt: Date.now() + 60_000,
  });
  assert.equal(replay.ticket_id, first.ticket_id);
  await repository.redeemDownloadTicket({
    ticketId, actorEmail: "recruiter@raydar.xyz", artifactId: pdfId, pairId: pair.id,
    pathname: first.artifact.private_object_key, disposition: "attachment", requestDigest: digest("request"),
  });
  await assert.rejects(() => repository.redeemDownloadTicket({
    ticketId, actorEmail: "recruiter@raydar.xyz", artifactId: pdfId, pairId: pair.id,
    pathname: first.artifact.private_object_key, disposition: "attachment", requestDigest: digest("request"),
  }), (error) => error.code === "download_ticket_already_used" && error.status === 410);
  const raceTicketId = randomUUID();
  const raced = await repository.issueDownload({
    actorEmail: "recruiter@raydar.xyz", idempotencyKey: `download-race:${pair.id}`,
    pairId: pair.id, expectedVersion: 2, ticketId: raceTicketId, expiresAt: Date.now() + 5 * 60_000,
  });
  assert.ok(await repository.downloadableArtifact({ artifactId: pdfId, pairId: pair.id, pathname: raced.artifact.private_object_key }));
  await sql`
    update submissions_v2.candidate_role_pairs
       set case_hidden_at=clock_timestamp(), state_version=state_version+1
     where id=${pair.id}
  `;
  await assert.rejects(() => repository.redeemDownloadTicket({
    ticketId: raceTicketId, actorEmail: "recruiter@raydar.xyz", artifactId: pdfId, pairId: pair.id,
    pathname: raced.artifact.private_object_key, disposition: "attachment", requestDigest: digest("race-request"),
  }), (error) => error.code === "artifact_not_found");
  assert.equal((await sql`select state from submissions_v2.download_tickets where ticket_id=${raceTicketId}`)[0].state, "issued");
  const audits = await sql`
    select result from submissions_v2.download_audit where ticket_id=${ticketId} order by requested_at, id
  `;
  assert.deepEqual(audits.map((row) => row.result), ["issued", "completed"]);
  await setRuntimeControls({
    actorEmail: "test@raydar.xyz", reason: "Restore controls after download command test",
    ui: priorControls.ui_enabled, ingestion: priorControls.ingestion_enabled,
    generation: priorControls.generation_enabled, masterInbox: priorControls.master_inbox_enabled,
    curated: priorControls.curated_enabled,
  }, sql);
});

test("DB-time leases use SKIP LOCKED, fencing tokens, and durable control epochs", async () => {
  const prior = await readRuntimeControls(sql);
  const enabled = await setRuntimeControls({
    actorEmail: "admin@raydar.xyz",
    reason: "Enable nonproduction generation lease test",
    ui: prior.ui_enabled,
    ingestion: prior.ingestion_enabled,
    generation: true,
    masterInbox: prior.master_inbox_enabled,
    curated: prior.curated_enabled,
  }, sql);
  const jobIds = [randomUUID(), randomUUID(), randomUUID()];
  for (const [index, id] of jobIds.entries()) {
    await sql`
      insert into submissions_v2.jobs (
        id, kind, subject_type, subject_id, idempotency_key, required_control, control_epoch, priority
      ) values (${id}, 'resume_prepare', 'pair', ${`pair-${index}`}, ${randomUUID()}, 'generation',
                ${enabled.control_epoch}, ${index})
    `;
  }
  const [left, right] = await Promise.all([
    claimJobs({ workerId: "worker-left", kinds: ["resume_prepare"], limit: 1, leaseSeconds: 60, controlEpoch: enabled.control_epoch }, sql),
    claimJobs({ workerId: "worker-right", kinds: ["resume_prepare"], limit: 1, leaseSeconds: 60, controlEpoch: enabled.control_epoch }, sql),
  ]);
  assert.equal(left.length, 1);
  assert.equal(right.length, 1);
  assert.notEqual(left[0].id, right[0].id);
  const first = left[0];
  assert.equal(await completeJob({
    jobId: first.id,
    workerId: "worker-left",
    fencingToken: first.fencing_token - 1,
    controlEpoch: enabled.control_epoch,
  }, sql), null);
  const heartbeat = await heartbeatJob({
    jobId: first.id,
    workerId: "worker-left",
    fencingToken: first.fencing_token,
    controlEpoch: enabled.control_epoch,
    leaseSeconds: 90,
  }, sql);
  assert.equal(heartbeat.state, "running");
  const completed = await completeJob({
    jobId: first.id,
    workerId: "worker-left",
    fencingToken: first.fencing_token,
    controlEpoch: enabled.control_epoch,
    checkpoint: { stage: "done" },
  }, sql);
  assert.equal(completed.state, "succeeded");

  const running = right[0];
  const disabled = await setRuntimeControls({
    actorEmail: "admin@raydar.xyz",
    reason: "Fence nonproduction generation lease test",
    ui: enabled.ui_enabled,
    ingestion: enabled.ingestion_enabled,
    generation: false,
    masterInbox: enabled.master_inbox_enabled,
    curated: enabled.curated_enabled,
  }, sql);
  assert.equal(Number(disabled.control_epoch), Number(enabled.control_epoch) + 1);
  const queued = await sql`select state, hold_reason from submissions_v2.jobs where id = ${jobIds[2]}`;
  assert.deepEqual(queued[0], { state: "held", hold_reason: "control_disabled" });
  const fenced = await checkpointJob({
    jobId: running.id,
    workerId: "worker-right",
    fencingToken: running.fencing_token,
    controlEpoch: enabled.control_epoch,
    checkpoint: { stage: "bounded-stage-complete" },
  }, sql);
  assert.equal(fenced.state, "held");
  assert.equal(fenced.hold_reason, "control_disabled");
  assert.equal(await completeJob({
    jobId: running.id,
    workerId: "worker-right",
    fencingToken: running.fencing_token,
    controlEpoch: enabled.control_epoch,
  }, sql), null);
  const audits = await sql`
    select count(*)::integer as count from submissions_v2.runtime_control_events
     where control_epoch in (${enabled.control_epoch}, ${disabled.control_epoch})
  `;
  assert.equal(audits[0].count, 2);
});

test("source checkpoints advance only under the current enabled control epoch", async () => {
  const prior = await readRuntimeControls(sql);
  const enabled = await setRuntimeControls({
    actorEmail: "admin@raydar.xyz",
    reason: "Enable nonproduction Curated cursor test",
    ui: prior.ui_enabled,
    ingestion: true,
    generation: prior.generation_enabled,
    masterInbox: prior.master_inbox_enabled,
    curated: true,
  }, sql);
  await sql`
    insert into submissions_v2.source_cursors (
      source_key, activation_cursor, checkpoint, control_epoch
    ) values ('curated', ${sql.json({ activated: true })}, ${sql.json({ offset: 0 })}, ${enabled.control_epoch})
    on conflict (source_key) do update
      set activation_cursor = excluded.activation_cursor,
          checkpoint = excluded.checkpoint,
          control_epoch = excluded.control_epoch,
          lease_owner = null,
          lease_expires_at = null
  `;
  const [left, right] = await Promise.all([
    claimSourceCursor({ sourceKey: "curated", workerId: "source-left", leaseSeconds: 60, controlEpoch: enabled.control_epoch }, sql),
    claimSourceCursor({ sourceKey: "curated", workerId: "source-right", leaseSeconds: 60, controlEpoch: enabled.control_epoch }, sql),
  ]);
  const claim = left || right;
  assert.ok(claim);
  assert.equal(Boolean(left) + Boolean(right), 1);
  assert.equal(await heartbeatSourceCursor({
    sourceKey: "curated",
    workerId: claim.lease_owner,
    fencingToken: Number(claim.fencing_token) - 1,
    controlEpoch: enabled.control_epoch,
  }, sql), null);
  const heartbeat = await heartbeatSourceCursor({
    sourceKey: "curated",
    workerId: claim.lease_owner,
    fencingToken: claim.fencing_token,
    controlEpoch: enabled.control_epoch,
  }, sql);
  assert.equal(heartbeat.lease_owner, claim.lease_owner);
  const committed = await commitSourceCursor({
    sourceKey: "curated",
    workerId: claim.lease_owner,
    fencingToken: claim.fencing_token,
    controlEpoch: enabled.control_epoch,
    checkpoint: { offset: 100 },
    fullSuccess: true,
  }, sql);
  assert.deepEqual(committed.checkpoint, { offset: 100 });
  assert.ok(committed.last_full_success_at);
  assert.equal(committed.lease_owner, null);

  const disabled = await setRuntimeControls({
    actorEmail: "admin@raydar.xyz",
    reason: "Disable nonproduction Curated cursor test",
    ui: enabled.ui_enabled,
    ingestion: enabled.ingestion_enabled,
    generation: enabled.generation_enabled,
    masterInbox: enabled.master_inbox_enabled,
    curated: false,
  }, sql);
  assert.equal(await claimSourceCursor({
    sourceKey: "curated",
    workerId: "source-disabled",
    leaseSeconds: 60,
    controlEpoch: disabled.control_epoch,
  }, sql), null);
});

test("curated reconciliation is source-fenced, monotonic, and retains an unresolved decisive signal", async () => {
  const repository = createRepository({ sql, env: { SUBMISSIONS_V2_SLACK_CHANNEL_ID: "C123TEST" } });
  const prior = await readRuntimeControls(sql);
  const enabled = await setRuntimeControls({
    actorEmail: "admin@raydar.xyz", reason: "Enable curated durability regression",
    ui: prior.ui_enabled, ingestion: true, generation: true,
    masterInbox: prior.master_inbox_enabled, curated: true,
  }, sql);
  const candidateId = `curated-candidate-${randomUUID()}`;
  const roleId = `curated-role-${randomUUID()}`;
  await sql`
    insert into submissions_v2.role_index(
      role_id, company_name, role_title, search_key, active, destination_url, last_confirmed_at, source_digest
    ) values (${roleId}, 'Curated Company', 'Curated Engineer', 'curated company curated engineer', true,
              ${`https://www.paraform.com/browse?role=${roleId}`}, clock_timestamp(), ${digest(roleId)})
  `;
  const jobId = randomUUID();
  await sql`
    insert into submissions_v2.jobs(id, kind, subject_type, subject_id, idempotency_key, required_control, control_epoch)
    values (${jobId}, 'reconcile_curated', 'source', 'curated', ${`job:${jobId}`}, 'curated', ${enabled.control_epoch})
  `;
  const claimedJob = (await claimJobs({
    workerId: "curated-durability-worker", kinds: ["reconcile_curated"], limit: 1,
    leaseSeconds: 120, controlEpoch: enabled.control_epoch,
  }, sql))[0];
  const executionFence = {
    jobId: claimedJob.id, workerId: claimedJob.lease_owner,
    fencingToken: Number(claimedJob.fencing_token), controlEpoch: Number(enabled.control_epoch),
  };
  await sql`
    insert into submissions_v2.source_cursors(source_key, control_epoch)
    values ('curated', ${enabled.control_epoch})
    on conflict (source_key) do update set control_epoch=excluded.control_epoch, lease_owner=null, lease_expires_at=null
  `;
  const sourceClaim = await claimSourceCursor({
    sourceKey: "curated", workerId: "curated-durability-worker",
    leaseSeconds: 120, controlEpoch: enabled.control_epoch,
  }, sql);
  const sourceFence = {
    sourceKey: "curated", workerId: sourceClaim.lease_owner,
    fencingToken: Number(sourceClaim.fencing_token), controlEpoch: Number(enabled.control_epoch),
  };
  const observation = (status, at) => ({
    candidate_user_id: candidateId, role_id: roleId, status, observed_at: at,
    digest: digest(`${candidateId}:${roleId}:${status}:${at}`),
  });
  await repository.applyCuratedObservations([observation("PENDING", "2026-09-01T20:00:00.000Z")], {
    seed: true, executionFence, sourceFence,
  });
  const missing = await repository.applyCuratedObservations([observation("APPLIED_TO_ROLE", "2026-09-01T20:05:00.000Z")], {
    executionFence, sourceFence,
  });
  assert.equal(missing[0].pending, true);
  let snapshot = (await repository.curatedSnapshots(candidateId))[0];
  assert.equal(snapshot.resolved, false);
  assert.equal(snapshot.pending_status, "APPLIED_TO_ROLE");
  const neutral = await repository.applyCuratedObservations([observation("PENDING", "2026-09-01T20:10:00.000Z")], {
    executionFence, sourceFence,
  });
  assert.equal(neutral[0].pending, true);
  snapshot = (await repository.curatedSnapshots(candidateId))[0];
  assert.equal(snapshot.last_confirmed_status, "PENDING");
  assert.equal(snapshot.pending_status, "APPLIED_TO_ROLE");
  await sql`
    insert into submissions_v2.candidate_index(
      candidate_user_id, display_name, normalized_name, search_key, active,
      paraform_profile_url, last_confirmed_at, source_digest
    ) values (${candidateId}, 'Curated Candidate', 'curated candidate', 'curated candidate', true,
              ${`https://www.paraform.com/candidates?candidate=${candidateId}`}, clock_timestamp(), ${digest(candidateId)})
  `;
  const recovered = await repository.applyCuratedObservations([observation("PENDING", "2026-09-01T20:15:00.000Z")], {
    executionFence, sourceFence,
  });
  assert.equal(recovered[0].applied, true);
  const pair = (await sql`
    select * from submissions_v2.candidate_role_pairs
     where candidate_user_id=${candidateId} and role_id=${roleId}
  `)[0];
  assert.equal(pair.intent_state, "interested");
  snapshot = (await repository.curatedSnapshots(candidateId))[0];
  assert.equal(snapshot.resolved, true);
  assert.equal(snapshot.pending_status, null);
  const stale = await repository.applyCuratedObservations([observation("NOT_INTERESTED", "2026-09-01T20:01:00.000Z")], {
    executionFence, sourceFence,
  });
  assert.equal(stale[0].stale, true);
  await assert.rejects(
    repository.applyCuratedObservations([observation("NOT_INTERESTED", "2026-09-01T20:20:00.000Z")], {
      executionFence, sourceFence: { ...sourceFence, fencingToken: sourceFence.fencingToken - 1 },
    }),
    (error) => error.code === "source_fence_lost",
  );
  await setRuntimeControls({
    actorEmail: "admin@raydar.xyz", reason: "Restore controls after curated durability regression",
    ui: prior.ui_enabled, ingestion: prior.ingestion_enabled, generation: prior.generation_enabled,
    masterInbox: prior.master_inbox_enabled, curated: prior.curated_enabled,
  }, sql);
});

test("candidate reconciliation deactivates missing profiles only after a fenced full cycle", async () => {
  const repository = createRepository({ sql, env: { SUBMISSIONS_V2_RETENTION_HMAC_KEY: "candidate-index-test-key".repeat(3) } });
  const prior = await readRuntimeControls(sql);
  const enabled = await setRuntimeControls({
    actorEmail: "admin@raydar.xyz", reason: "Enable candidate-index reconciliation test",
    ui: prior.ui_enabled, ingestion: true, generation: prior.generation_enabled,
    masterInbox: prior.master_inbox_enabled, curated: prior.curated_enabled,
  }, sql);
  for (const id of ["candidate-still-present", "candidate-now-missing"]) {
    await sql`
      insert into submissions_v2.candidate_index(
        candidate_user_id, display_name, normalized_name, search_key,
        paraform_profile_url, last_confirmed_at, source_digest, reconciliation_cycle
      ) values (
        ${id}, ${id}, ${id}, ${id}, ${`https://www.paraform.com/candidates?candidate=${id}`},
        clock_timestamp() - interval '1 hour', ${digest(id)}, 'prior-cycle'
      )
    `;
  }
  const jobId = randomUUID();
  await sql`
    insert into submissions_v2.jobs(
      id, kind, subject_type, subject_id, idempotency_key, required_control, control_epoch
    ) values (
      ${jobId}, 'index_candidates', 'source', 'candidate_index', ${randomUUID()}, 'ingestion', ${enabled.control_epoch}
    )
  `;
  const claimed = (await claimJobs({
    workerId: "candidate-index-worker", kinds: ["index_candidates"], limit: 1,
    leaseSeconds: 120, controlEpoch: enabled.control_epoch,
  }, sql))[0];
  const executionFence = {
    jobId: claimed.id, workerId: claimed.lease_owner,
    fencingToken: Number(claimed.fencing_token), controlEpoch: Number(enabled.control_epoch),
  };
  await sql`
    insert into submissions_v2.source_cursors(source_key, control_epoch)
    values ('candidate_index', ${enabled.control_epoch})
    on conflict (source_key) do update set control_epoch=excluded.control_epoch, lease_owner=null, lease_expires_at=null
  `;
  const sourceClaim = await claimSourceCursor({
    sourceKey: "candidate_index", workerId: "candidate-index-worker",
    leaseSeconds: 120, controlEpoch: enabled.control_epoch,
  }, sql);
  const sourceFence = {
    sourceKey: "candidate_index", workerId: sourceClaim.lease_owner,
    fencingToken: Number(sourceClaim.fencing_token), controlEpoch: Number(enabled.control_epoch),
  };
  await assert.rejects(
    repository.upsertCandidateIndex([], {
      cycleId: "stale-cycle", executionFence,
      sourceFence: { ...sourceFence, fencingToken: sourceFence.fencingToken - 1 },
    }),
    (error) => error.code === "source_fence_lost",
  );
  const permanentlyPurgedId = `candidate-permanently-purged-${randomUUID()}`;
  await sql`
    insert into submissions_v2.candidate_index_suppressions(candidate_hmac)
    values (${digest(`submissions-v2-candidate-suppression:v1\0${permanentlyPurgedId}`)})
  `;
  const indexed = await repository.upsertCandidateIndex([{
    candidate_user_id: "candidate-still-present", display_name: "Candidate Present",
    search_key: "candidate present", email_hmac: null, email_hmac_version: null,
    paraform_url: "https://www.paraform.com/candidates?candidate=candidate-still-present",
    linkedin_url: null, raydar_url: "/applicants?candidate=candidate-still-present",
    owner_email: null, has_recorded_call: false, confirmed_at: new Date().toISOString(),
    source_digest: digest("candidate-still-present-current"),
  }, {
    candidate_user_id: permanentlyPurgedId, display_name: "Purged Candidate",
    search_key: "purged candidate", email_hmac: null, email_hmac_version: null,
    paraform_url: `https://www.paraform.com/candidates?candidate=${permanentlyPurgedId}`,
    linkedin_url: null, raydar_url: `/applicants?candidate=${permanentlyPurgedId}`,
    owner_email: null, has_recorded_call: false, confirmed_at: new Date().toISOString(),
    source_digest: digest("candidate-permanently-purged-current"),
  }], { cycleId: "full-cycle", executionFence, sourceFence });
  assert.equal(indexed.suppressed_count, 1);
  assert.equal((await sql`select count(*)::integer as count from submissions_v2.candidate_index where candidate_user_id=${permanentlyPurgedId}`)[0].count, 0);
  const beforeFinalize = await sql`select active from submissions_v2.candidate_index where candidate_user_id='candidate-now-missing'`;
  assert.equal(beforeFinalize[0].active, true);
  const finalized = await repository.finalizeCandidateIndexCycle({ cycleId: "full-cycle", executionFence, sourceFence });
  assert.ok(finalized.deactivated_count >= 1);
  const rows = await sql`
    select candidate_user_id, active
      from submissions_v2.candidate_index
     where candidate_user_id in ('candidate-still-present', 'candidate-now-missing')
     order by candidate_user_id
  `;
  assert.deepEqual([...rows], [
    { candidate_user_id: "candidate-now-missing", active: false },
    { candidate_user_id: "candidate-still-present", active: true },
  ]);
  await commitSourceCursor({
    sourceKey: "candidate_index", workerId: sourceClaim.lease_owner,
    fencingToken: sourceClaim.fencing_token, controlEpoch: enabled.control_epoch,
    checkpoint: {}, fullSuccess: true,
  }, sql);
});

test("first recruiter addition queues one exact admission notification and later adds do not repeat it", async () => {
  const prior = await readRuntimeControls(sql);
  await setRuntimeControls({
    actorEmail: "admin@raydar.xyz", reason: "Enable admission notification regression",
    ui: true, ingestion: true, generation: true,
    masterInbox: prior.master_inbox_enabled, curated: prior.curated_enabled,
  }, sql);
  const candidateId = `addition-candidate-${randomUUID()}`;
  const roleId = `addition-role-${randomUUID()}`;
  await sql`
    insert into submissions_v2.candidate_index(
      candidate_user_id, display_name, normalized_name, search_key, active,
      paraform_profile_url, last_confirmed_at, source_digest
    ) values (
      ${candidateId}, 'Addition Candidate', 'addition candidate', 'addition candidate', true,
      ${`https://www.paraform.com/candidates?candidate_profile_id=${candidateId}`}, clock_timestamp(), ${digest(candidateId)}
    )
  `;
  await sql`
    insert into submissions_v2.role_index(
      role_id, company_name, role_title, search_key, active,
      destination_url, last_confirmed_at, source_digest
    ) values (
      ${roleId}, 'Addition Company', 'Addition Engineer', 'addition company addition engineer', true,
      ${`https://www.paraform.com/browse?role=${roleId}`}, clock_timestamp(), ${digest(roleId)}
    )
  `;
  const apiDatabase = {
    begin: (work) => sql.begin(async (tx) => {
      await tx.unsafe("set local role submissions_v2_api");
      return work(tx);
    }),
  };
  const repository = createRepository({ sql: apiDatabase, env: { SUBMISSIONS_V2_SLACK_CHANNEL_ID: "C123TEST" } });
  const first = await repository.addCandidate({
    actorEmail: "recruiter@raydar.xyz", idempotencyKey: randomUUID(), candidateId, roleId,
  });
  const later = await repository.addCandidate({
    actorEmail: "recruiter@raydar.xyz", idempotencyKey: randomUUID(), candidateId, roleId,
  });
  assert.equal(first.existing, false);
  assert.equal(later.existing, true);
  assert.equal(later.case_id, first.case_id);
  const rows = await sql`
    select n.kind, n.dedupe_key, n.safe_payload, p.created_at
      from submissions_v2.notification_outbox n
      join submissions_v2.candidate_role_pairs p on p.id=n.pair_id
     where n.pair_id=${first.case_id}
  `;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, "submission_added");
  assert.equal(rows[0].dedupe_key, `submission-added:pair:${first.case_id}`);
  assert.deepEqual({ ...rows[0].safe_payload, added_at: undefined }, {
    candidate_name: "Addition Candidate", company: "Addition Company",
    role_title: "Addition Engineer", signal: "Interested · Recruiter addition",
    added_at: undefined, monitor_url: "https://monitor.raydar.xyz/#submissions",
  });
  assert.equal(rows[0].safe_payload.added_at, new Date(rows[0].created_at).toISOString());
  await setRuntimeControls({
    actorEmail: "admin@raydar.xyz", reason: "Restore admission notification regression controls",
    ui: prior.ui_enabled, ingestion: prior.ingestion_enabled, generation: prior.generation_enabled,
    masterInbox: prior.master_inbox_enabled, curated: prior.curated_enabled,
  }, sql);
});

async function rearmControls(run) {
  const prior = await readRuntimeControls(sql);
  await setRuntimeControls({
    actorEmail: "admin@raydar.xyz", reason: "Enable resume re-arm regression",
    ui: true, ingestion: true, generation: true,
    masterInbox: prior.master_inbox_enabled, curated: prior.curated_enabled,
  }, sql);
  try {
    return await run();
  } finally {
    await setRuntimeControls({
      actorEmail: "admin@raydar.xyz", reason: "Restore resume re-arm regression controls",
      ui: prior.ui_enabled, ingestion: prior.ingestion_enabled, generation: prior.generation_enabled,
      masterInbox: prior.master_inbox_enabled, curated: prior.curated_enabled,
    }, sql);
  }
}

async function indexedCandidateRole(label) {
  const candidateId = `${label}-candidate-${randomUUID()}`;
  const roleId = `${label}-role-${randomUUID()}`;
  await sql`
    insert into submissions_v2.candidate_index(
      candidate_user_id, display_name, normalized_name, search_key, active,
      paraform_profile_url, last_confirmed_at, source_digest
    ) values (
      ${candidateId}, 'Rearm Candidate', 'rearm candidate', ${`rearm candidate ${candidateId}`}, true,
      ${`https://www.paraform.com/candidates?candidate_profile_id=${candidateId}`}, clock_timestamp(), ${digest(candidateId)}
    )
  `;
  await sql`
    insert into submissions_v2.role_index(
      role_id, company_name, role_title, search_key, active,
      destination_url, last_confirmed_at, source_digest
    ) values (
      ${roleId}, 'Rearm Company', 'Rearm Engineer', ${`rearm company rearm engineer ${roleId}`}, true,
      ${`https://www.paraform.com/browse?role=${roleId}`}, clock_timestamp(), ${digest(roleId)}
    )
  `;
  return { candidateId, roleId };
}

// The exact production shape this repair exists for: Paraform proved the
// application, which resolved every open preparation blocker, so the pair sits
// in Needs Review with a proven submission and no resume to show.
async function provenPairWithoutResume({ candidateId, roleId, intent = "interested" }) {
  const signal = await sourceEvent();
  const id = randomUUID();
  const applicationId = `application-${randomUUID()}`;
  const evidence = digest(`rearm-proof:${id}`);
  await sql.begin(async (tx) => {
    await tx`
      insert into submissions_v2.candidate_role_pairs(
        id, candidate_user_id, role_id, first_signal_id, intent_state, workflow_state,
        original_signal_at, role_state, role_checked_at, submission_status, submission_proven_at,
        submission_application_id, submission_authoritative_path, submission_evidence_digest
      ) values (
        ${id}, ${candidateId}, ${roleId}, ${signal}, ${intent}, 'needs_review',
        clock_timestamp(), 'active', clock_timestamp(), 'proven', clock_timestamp(),
        ${applicationId}, 'application.getRecruiterApplicationData', ${evidence}
      )
    `;
    await tx`
      insert into submissions_v2.submission_proofs(
        pair_id, application_id, authoritative_path, evidence_digest, observed_at, source_checked_at
      ) values (
        ${id}, ${applicationId}, 'application.getRecruiterApplicationData', ${evidence},
        clock_timestamp(), clock_timestamp()
      )
    `;
  });
  return { id, signal };
}

async function failedResumeGeneration(pair) {
  const generationId = randomUUID();
  await sql`
    insert into submissions_v2.resume_generations(
      id, pair_id, generation_version, trigger_kind, idempotency_key, status, stage,
      expected_pair_version, first_signal_id, primary_model_pin, fallback_model_pin,
      validator_model_pin, prompt_pin, template_pin, safe_failure_code, safe_failure_detail,
      spent_cents, deadline_at, completed_at
    ) values (
      ${generationId}, ${pair.id}, 1, 'initial', ${`resume-job:${generationId}:attempt:1`}, 'failed', 'budget_exhausted',
      1, ${pair.signal}, 'opus-test', 'opus-fallback-test', 'validator-test', 'prompt-test', 'template-test',
      'resume_preparation_failed', 'Resume preparation reached its two-dollar model-cost ceiling.',
      200, clock_timestamp() + interval '5 minutes', clock_timestamp()
    )
  `;
  return generationId;
}

async function readyInterestedPair({ candidateId, roleId }) {
  const signal = await sourceEvent();
  const id = randomUUID();
  const generationId = randomUUID();
  await sql`
    insert into submissions_v2.candidate_role_pairs(
      id, candidate_user_id, role_id, first_signal_id, intent_state, workflow_state,
      original_signal_at, role_state, role_checked_at
    ) values (
      ${id}, ${candidateId}, ${roleId}, ${signal}, 'interested', 'preparing_resume',
      clock_timestamp(), 'active', clock_timestamp()
    )
  `;
  await sql`
    insert into submissions_v2.resume_generations(
      id, pair_id, generation_version, trigger_kind, idempotency_key, status, stage,
      expected_pair_version, first_signal_id, primary_model_pin, fallback_model_pin,
      validator_model_pin, prompt_pin, template_pin, deadline_at, completed_at
    ) values (
      ${generationId}, ${id}, 1, 'initial', ${`generation:${generationId}`}, 'succeeded', 'complete',
      1, ${signal}, 'opus-test', 'opus-fallback-test', 'validator-test', 'prompt-test', 'template-test',
      clock_timestamp() + interval '5 minutes', clock_timestamp()
    )
  `;
  const artifactId = randomUUID();
  const atsArtifactId = randomUUID();
  const manifestArtifactId = randomUUID();
  await sql`
    insert into submissions_v2.resume_artifacts(
      id, pair_id, generation_id, artifact_version, kind, private_object_key,
      digest, size_bytes, page_count, validation_status, archive_readback_at, archived_at, current_state
    ) values (
      ${artifactId}, ${id}, ${generationId}, 1, 'pdf',
      ${`submissions/resumes/v2/pdf/${artifactId}`}, ${digest(`rearm-pdf:${artifactId}`)}, 100, 1,
      'passed', clock_timestamp(), clock_timestamp(), 'current'
    ), (
      ${atsArtifactId}, ${id}, ${generationId}, 1, 'ats',
      ${`submissions/resumes/v2/ats/${atsArtifactId}`}, ${digest(`rearm-ats:${atsArtifactId}`)}, 100, null,
      'passed', clock_timestamp(), clock_timestamp(), 'current'
    ), (
      ${manifestArtifactId}, ${id}, ${generationId}, 1, 'manifest',
      ${`submissions/resumes/v2/manifests/${manifestArtifactId}`}, ${digest(`rearm-manifest:${manifestArtifactId}`)}, 100, null,
      'passed', clock_timestamp(), clock_timestamp(), 'current'
    )
  `;
  await sql`
    update submissions_v2.candidate_role_pairs
       set workflow_state='interested', current_artifact_id=${artifactId},
           resume_ready_at=clock_timestamp(), state_version=state_version+1
     where id=${id}
  `;
  return { id, signal, artifactId };
}

const preparationJobs = (pairId) => sql`
  select id, state, checkpoint, priority, required_control, command_id
    from submissions_v2.jobs
   where kind='prepare_resume' and subject_type='pair' and subject_id=${pairId}
   order by created_at, id
`;

const pairFacts = async (pairId) => (await sql`
  select intent_state, workflow_state, submission_status, state_version::integer as state_version
    from submissions_v2.candidate_role_pairs where id=${pairId}
`)[0];

test("re-adding a proven candidate with no resume re-arms preparation and announces nothing new", async () => {
  await rearmControls(async () => {
    const { candidateId, roleId } = await indexedCandidateRole("rearm-proven");
    const pair = await provenPairWithoutResume({ candidateId, roleId });
    await failedResumeGeneration(pair);
    const repository = createRepository({ sql, env: { SUBMISSIONS_V2_SLACK_CHANNEL_ID: "C123TEST" } });
    const listed = (await repository.list({ page: "interested" })).rows.find((row) => row.pair_id === pair.id);
    assert.equal(listed.intent_state, "interested", "the list must carry intent so capabilities can be decided");
    assert.equal(rowDto(listed).capabilities.can_prepare_resume, true);
    assert.equal(rowDto(listed).capabilities.can_regenerate, false);
    const result = await repository.addCandidate({
      actorEmail: "recruiter@raydar.xyz", idempotencyKey: randomUUID(), candidateId, roleId,
    });
    assert.equal(result.existing, true);
    assert.equal(result.case_id, pair.id);
    assert.equal(result.rearm, "queued");
    assert.equal(result.resume_queued, true);
    assert.equal(result.resume_ready, false);
    assert.equal(result.preparing, false);
    assert.equal(result.state, "preparing_resume");
    assert.equal(result.state_version, 2);
    assert.deepEqual(await pairFacts(pair.id), {
      intent_state: "interested", workflow_state: "preparing_resume",
      submission_status: "proven", state_version: 2,
    });
    const jobs = await preparationJobs(pair.id);
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].id, result.job_id);
    assert.equal(jobs[0].state, "queued");
    assert.equal(jobs[0].required_control, "generation");
    assert.equal(jobs[0].priority, 50);
    assert.deepEqual(jobs[0].checkpoint, {
      trigger_kind: "retry", expected_pair_version: 2, rearmed: true, rearm_source: "add_candidate",
    });
    const events = await sql`
      select from_intent_state, to_intent_state, from_workflow_state, to_workflow_state,
             expected_version::integer as expected_version, new_version::integer as new_version, metadata
        from submissions_v2.pair_events where pair_id=${pair.id} and event_type='preparation_rearmed'
    `;
    assert.equal(events.length, 1);
    assert.equal(events[0].from_workflow_state, "needs_review");
    assert.equal(events[0].to_workflow_state, "preparing_resume");
    assert.equal(events[0].expected_version, 1);
    assert.equal(events[0].new_version, 2);
    assert.equal(events[0].metadata.job_id, result.job_id);
    assert.equal(events[0].metadata.submission_status, "proven");
    assert.equal(events[0].metadata.resolved_review_count, 0);
    assert.equal((await sql`
      select count(*)::integer as count from submissions_v2.notification_outbox where pair_id=${pair.id}
    `)[0].count, 0, "a re-arm is not a new entry and must never announce itself");
  });
});

test("re-adding a candidate whose resume is ready or already preparing changes nothing", async () => {
  await rearmControls(async () => {
    const repository = createRepository({ sql, env: { SUBMISSIONS_V2_SLACK_CHANNEL_ID: "C123TEST" } });

    const ready = await indexedCandidateRole("rearm-ready");
    const readyPair = await readyInterestedPair(ready);
    const readyResult = await repository.addCandidate({
      actorEmail: "recruiter@raydar.xyz", idempotencyKey: randomUUID(),
      candidateId: ready.candidateId, roleId: ready.roleId,
    });
    assert.equal(readyResult.existing, true);
    assert.equal(readyResult.rearm, "resume_ready");
    assert.equal(readyResult.resume_ready, true);
    assert.equal(readyResult.resume_queued, false);
    assert.equal(readyResult.job_id, null);
    assert.equal(readyResult.state, "interested");
    assert.equal(readyResult.state_version, 2);
    assert.deepEqual(await pairFacts(readyPair.id), {
      intent_state: "interested", workflow_state: "interested",
      submission_status: "none", state_version: 2,
    });
    assert.equal((await preparationJobs(readyPair.id)).length, 0);

    const busy = await indexedCandidateRole("rearm-busy");
    const busyPair = await provenPairWithoutResume(busy);
    const controls = await readRuntimeControls(sql);
    const queuedJobId = randomUUID();
    await sql`
      insert into submissions_v2.jobs(
        id, kind, subject_type, subject_id, idempotency_key, required_control,
        control_epoch, state, priority
      ) values (
        ${queuedJobId}, 'prepare_resume', 'pair', ${busyPair.id}, ${`resume-fixture:${queuedJobId}`},
        'generation', ${controls.control_epoch}, 'queued', 50
      )
    `;
    const busyResult = await repository.addCandidate({
      actorEmail: "recruiter@raydar.xyz", idempotencyKey: randomUUID(),
      candidateId: busy.candidateId, roleId: busy.roleId,
    });
    assert.equal(busyResult.existing, true);
    assert.equal(busyResult.rearm, "preparing");
    assert.equal(busyResult.preparing, true);
    assert.equal(busyResult.resume_queued, false);
    assert.equal(busyResult.job_id, null);
    assert.equal(busyResult.state_version, 1);
    assert.deepEqual(await pairFacts(busyPair.id), {
      intent_state: "interested", workflow_state: "needs_review",
      submission_status: "proven", state_version: 1,
    });
    const busyJobs = await preparationJobs(busyPair.id);
    assert.equal(busyJobs.length, 1, "a queued preparation job is never doubled");
    assert.equal(busyJobs[0].id, queuedJobId);
  });
});

test("the recruiter's re-add is the interest decision for an unclear proven pair but never for a decline", async () => {
  await rearmControls(async () => {
    const repository = createRepository({ sql, env: { SUBMISSIONS_V2_SLACK_CHANNEL_ID: "C123TEST" } });

    const unclear = await indexedCandidateRole("rearm-unclear");
    const unclearPair = await provenPairWithoutResume({ ...unclear, intent: "unclear" });
    const unclearResult = await repository.addCandidate({
      actorEmail: "recruiter@raydar.xyz", idempotencyKey: randomUUID(),
      candidateId: unclear.candidateId, roleId: unclear.roleId,
    });
    assert.equal(unclearResult.rearm, "queued");
    assert.deepEqual(await pairFacts(unclearPair.id), {
      intent_state: "interested", workflow_state: "preparing_resume",
      submission_status: "proven", state_version: 2,
    });
    const unclearEvent = (await sql`
      select metadata from submissions_v2.pair_events
       where pair_id=${unclearPair.id} and event_type='preparation_rearmed'
    `)[0];
    assert.equal(unclearEvent.metadata.prior_intent_state, "unclear");

    const classifying = await indexedCandidateRole("rearm-classifying");
    const classifyingSignal = await sourceEvent();
    const classifyingId = randomUUID();
    await sql`
      insert into submissions_v2.candidate_role_pairs(
        id, candidate_user_id, role_id, first_signal_id, intent_state, workflow_state,
        original_signal_at, role_state
      ) values (
        ${classifyingId}, ${classifying.candidateId}, ${classifying.roleId}, ${classifyingSignal},
        'unknown', 'classifying', clock_timestamp(), 'active'
      )
    `;
    const classifyingResult = await repository.addCandidate({
      actorEmail: "recruiter@raydar.xyz", idempotencyKey: randomUUID(),
      candidateId: classifying.candidateId, roleId: classifying.roleId,
    });
    assert.equal(classifyingResult.rearm, "review_required", "an unclassified reply is not yet an interest decision");
    assert.equal(classifyingResult.job_id, null);
    assert.deepEqual(await pairFacts(classifyingId), {
      intent_state: "unknown", workflow_state: "classifying",
      submission_status: "none", state_version: 1,
    });

    const declined = await indexedCandidateRole("rearm-declined");
    const declinedSignal = await sourceEvent();
    const declinedId = randomUUID();
    await sql`
      insert into submissions_v2.candidate_role_pairs(
        id, candidate_user_id, role_id, first_signal_id, intent_state, workflow_state,
        original_signal_at, role_state, role_checked_at
      ) values (
        ${declinedId}, ${declined.candidateId}, ${declined.roleId}, ${declinedSignal},
        'not_interested', 'not_interested', clock_timestamp(), 'active', clock_timestamp()
      )
    `;
    const declinedResult = await repository.addCandidate({
      actorEmail: "recruiter@raydar.xyz", idempotencyKey: randomUUID(),
      candidateId: declined.candidateId, roleId: declined.roleId,
    });
    assert.equal(declinedResult.rearm, "not_interested");
    assert.equal(declinedResult.resume_queued, false);
    assert.equal(declinedResult.job_id, null);
    assert.equal(declinedResult.state, "not_interested");
    assert.deepEqual(await pairFacts(declinedId), {
      intent_state: "not_interested", workflow_state: "not_interested",
      submission_status: "none", state_version: 1,
    });
    assert.equal((await preparationJobs(declinedId)).length, 0);
  });
});

test("re-arming clears only resume blockers and defers to every other open Review reason", async () => {
  await rearmControls(async () => {
    const repository = createRepository({ sql, env: { SUBMISSIONS_V2_SLACK_CHANNEL_ID: "C123TEST" } });

    const blocked = await indexedCandidateRole("rearm-blocked");
    const blockedPair = await provenPairWithoutResume(blocked);
    await sql`
      insert into submissions_v2.review_items(pair_id, reason_code, safe_detail)
      values (${blockedPair.id}, 'role_unavailable', 'The exact role is no longer active.')
    `;
    const blockedResult = await repository.addCandidate({
      actorEmail: "recruiter@raydar.xyz", idempotencyKey: randomUUID(),
      candidateId: blocked.candidateId, roleId: blocked.roleId,
    });
    assert.equal(blockedResult.rearm, "review_required");
    assert.equal(blockedResult.resume_queued, false);
    assert.equal(blockedResult.job_id, null);
    assert.deepEqual(await pairFacts(blockedPair.id), {
      intent_state: "interested", workflow_state: "needs_review",
      submission_status: "proven", state_version: 1,
    });
    assert.equal((await preparationJobs(blockedPair.id)).length, 0);
    assert.equal((await sql`
      select action_state from submissions_v2.review_items where pair_id=${blockedPair.id}
    `)[0].action_state, "open");

    const resumable = await indexedCandidateRole("rearm-resume-blocker");
    const resumablePair = await provenPairWithoutResume(resumable);
    await failedResumeGeneration(resumablePair);
    await sql`
      insert into submissions_v2.review_items(pair_id, reason_code, safe_detail)
      values (${resumablePair.id}, 'resume_preparation_failed', 'Resume preparation exhausted safe recovery.')
    `;
    const resumableResult = await repository.addCandidate({
      actorEmail: "recruiter@raydar.xyz", idempotencyKey: randomUUID(),
      candidateId: resumable.candidateId, roleId: resumable.roleId,
    });
    assert.equal(resumableResult.rearm, "queued");
    assert.deepEqual(await pairFacts(resumablePair.id), {
      intent_state: "interested", workflow_state: "preparing_resume",
      submission_status: "proven", state_version: 2,
    });
    const resolved = (await sql`
      select action_state, resolved_by, resolution_note from submissions_v2.review_items
       where pair_id=${resumablePair.id}
    `)[0];
    assert.equal(resolved.action_state, "resolved");
    assert.equal(resolved.resolved_by, "recruiter@raydar.xyz");
    assert.equal(resolved.resolution_note, "Recruiter re-added the candidate; resume preparation re-armed.");
    const resolvedEvent = (await sql`
      select metadata from submissions_v2.pair_events
       where pair_id=${resumablePair.id} and event_type='preparation_rearmed'
    `)[0];
    assert.equal(resolvedEvent.metadata.resolved_review_count, 1);
  });
});

test("the Generate resume command re-arms one exact fenced pair and refuses every other state", async () => {
  await rearmControls(async () => {
    const repository = createRepository({ sql, env: { SUBMISSIONS_V2_SLACK_CHANNEL_ID: "C123TEST" } });

    const stranded = await indexedCandidateRole("prepare-command");
    const strandedPair = await provenPairWithoutResume(stranded);
    await failedResumeGeneration(strandedPair);
    await assert.rejects(
      repository.prepareResume({
        actorEmail: "recruiter@raydar.xyz", idempotencyKey: randomUUID(),
        pairId: strandedPair.id, expectedVersion: 7,
      }),
      (error) => error.code === "stale_pair_version" && error.status === 409,
    );
    const prepared = await repository.prepareResume({
      actorEmail: "recruiter@raydar.xyz", idempotencyKey: randomUUID(),
      pairId: strandedPair.id, expectedVersion: 1,
    });
    assert.equal(prepared.case_id, strandedPair.id);
    assert.equal(prepared.state, "preparing_resume");
    assert.equal(prepared.state_version, 2);
    assert.equal(prepared.resume_queued, true);
    const jobs = await preparationJobs(strandedPair.id);
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].id, prepared.job_id);
    assert.equal(jobs[0].checkpoint.rearm_source, "prepare_resume");
    assert.equal((await sql`
      select count(*)::integer as count from submissions_v2.notification_outbox where pair_id=${strandedPair.id}
    `)[0].count, 0);
    await assert.rejects(
      repository.prepareResume({
        actorEmail: "recruiter@raydar.xyz", idempotencyKey: randomUUID(),
        pairId: strandedPair.id, expectedVersion: 2,
      }),
      (error) => error.code === "resume_preparation_in_progress" && error.status === 409,
    );

    const ready = await indexedCandidateRole("prepare-ready");
    const readyPair = await readyInterestedPair(ready);
    await assert.rejects(
      repository.prepareResume({
        actorEmail: "recruiter@raydar.xyz", idempotencyKey: randomUUID(),
        pairId: readyPair.id, expectedVersion: 2,
      }),
      (error) => error.code === "resume_already_ready" && error.status === 409
        && error.current.case_id === readyPair.id,
    );
  });
});

test("a re-armed pair passes the worker's retry claim guard on its new version", async () => {
  await rearmControls(async () => {
    const { candidateId, roleId } = await indexedCandidateRole("rearm-claim");
    const pair = await provenPairWithoutResume({ candidateId, roleId });
    await failedResumeGeneration(pair);
    const repository = createRepository({ sql, env: { SUBMISSIONS_V2_SLACK_CHANNEL_ID: "C123TEST" } });
    const rearmed = await repository.addCandidate({
      actorEmail: "recruiter@raydar.xyz", idempotencyKey: randomUUID(), candidateId, roleId,
    });
    assert.equal(rearmed.rearm, "queued");
    const controls = await readRuntimeControls(sql);
    await sql`
      update submissions_v2.jobs
         set state='running', lease_owner='rearm-resume-worker',
             lease_expires_at=clock_timestamp() + interval '2 minutes',
             fencing_token=1, control_epoch=${controls.control_epoch},
             attempt_count=1, started_at=clock_timestamp()
       where id=${rearmed.job_id}
    `;
    const generation = await repository.startResumeGeneration({
      pairId: pair.id, triggerKind: "retry", idempotencyKey: `resume-job:${rearmed.job_id}:attempt:1`,
      expectedPairVersion: rearmed.state_version,
      primaryModelPin: "claude-opus-5", fallbackModelPin: "claude-opus-4.8",
      validatorModelPin: "gpt-5.4", promptPin: "test", templatePin: "test",
      deadlineAt: new Date(Date.now() + 60_000).toISOString(),
      executionFence: {
        jobId: rearmed.job_id, workerId: "rearm-resume-worker",
        fencingToken: 1, controlEpoch: Number(controls.control_epoch),
      },
    });
    assert.equal(generation.pair_id, pair.id);
    assert.equal(generation.trigger_kind, "retry");
    assert.equal(Number(generation.expected_pair_version), 2);
    assert.equal(generation.status, "queued");
  });
});

test("re-adding a soft-deleted case leaves the hidden pair and its restore point untouched", async () => {
  await rearmControls(async () => {
    const { candidateId, roleId } = await indexedCandidateRole("rearm-hidden");
    const pair = await provenPairWithoutResume({ candidateId, roleId });
    await failedResumeGeneration(pair);
    await sql`
      insert into submissions_v2.review_items(pair_id, reason_code, safe_detail)
      values (${pair.id}, 'resume_preparation_failed', 'Resume preparation did not finish.')
    `;
    // A soft delete hides the pair and pins the recovery manifest to this state_version;
    // Add Candidate is the one path that can still see the row, so it must write nothing.
    await sql`
      update submissions_v2.candidate_role_pairs
         set case_hidden_at=clock_timestamp(), state_version=state_version+1
       where id=${pair.id}
    `;
    const before = await pairFacts(pair.id);
    const repository = createRepository({ sql, env: { SUBMISSIONS_V2_SLACK_CHANNEL_ID: "C123TEST" } });
    const result = await repository.addCandidate({
      actorEmail: "recruiter@raydar.xyz", idempotencyKey: randomUUID(), candidateId, roleId,
    });
    assert.equal(result.existing, true);
    assert.equal(result.rearm, "review_required");
    assert.equal(result.resume_queued, false);
    assert.equal(result.job_id, null);
    assert.deepEqual(await pairFacts(pair.id), before, "a hidden case must keep its restore version");
    assert.ok((await sql`
      select case_hidden_at from submissions_v2.candidate_role_pairs where id=${pair.id}
    `)[0].case_hidden_at, "the deletion must survive the re-add");
    assert.equal((await preparationJobs(pair.id)).length, 0);
    assert.equal((await sql`
      select count(*)::integer as count from submissions_v2.pair_events
       where pair_id=${pair.id} and event_type='preparation_rearmed'
    `)[0].count, 0);
    assert.equal((await sql`
      select count(*)::integer as count from submissions_v2.review_items
       where pair_id=${pair.id} and action_state='open'
    `)[0].count, 1, "the resume blocker stays open for the restore");
  });
});

test("scheduler queues every due reconciliation, index, proof, notification, digest, health, and purge lane", async () => {
  const prior = await readRuntimeControls(sql);
  await setRuntimeControls({
    actorEmail: "admin@raydar.xyz",
    reason: "Enable nonproduction scheduler coverage test",
    ui: true,
    ingestion: true,
    generation: true,
    masterInbox: true,
    curated: true,
  }, sql);
  const repository = createRepository({ sql });
  const result = await repository.scheduleTick({
    minuteKey: "2026-09-01T15:07",
    fiveMinuteKey: "2026-09-01T15:05",
    hourKey: "2026-09-01T15",
    pacificDayKey: "2026-09-01",
    dailyDigestDue: true,
    nightlyDue: true,
    purgeDue: true,
  });
  assert.deepEqual(new Set(result.jobs.map((job) => job.kind)), new Set([
    "reconcile_master_inbox", "reconcile_sequence_inbox", "reconcile_curated", "proof_reconcile", "deliver_notification",
    "source_health", "index_candidates", "index_roles", "daily_digest", "purge",
  ]));
  await setRuntimeControls({
    actorEmail: "admin@raydar.xyz",
    reason: "Restore nonproduction scheduler coverage test controls",
    ui: prior.ui_enabled,
    ingestion: prior.ingestion_enabled,
    generation: prior.generation_enabled,
    masterInbox: prior.master_inbox_enabled,
    curated: prior.curated_enabled,
  }, sql);
});

test("expired resume generations recover to Retry preparation without touching a live worker lease", async () => {
  const prior = await readRuntimeControls(sql);
  await setRuntimeControls({ actorEmail: 'test@raydar.xyz', reason: 'Enable orphan recovery regression',
    ui: true, generation: true, ingestion: prior.ingestion_enabled,
    masterInbox: prior.master_inbox_enabled, curated: prior.curated_enabled }, sql);
  const pair = await preparingPair();
  const generationId = randomUUID();
  await sql`
    insert into submissions_v2.resume_generations(
      id, pair_id, generation_version, trigger_kind, idempotency_key, status, stage,
      expected_pair_version, first_signal_id, primary_model_pin, fallback_model_pin,
      validator_model_pin, prompt_pin, template_pin, spent_cents, deadline_at
    ) values (
      ${generationId}, ${pair.id}, 1, 'initial', ${`resume-job:expired:attempt:1`}, 'strategizing', 'strategy',
      1, ${pair.signal}, 'opus-test', 'opus-fallback-test', 'validator-test',
      'prompt-test', 'template-test', 87, clock_timestamp() - interval '1 minute'
    )
  `;
  await sql`
    insert into submissions_v2.resume_stage_runs(generation_id, stage, attempt, input_digest, status)
    values (${generationId}, 'strategy', 1, ${digest('expired-stage')}, 'running')
  `;
  const submittedPair = await preparingPair();
  const submittedGenerationId = randomUUID();
  const submittedApplicationId = `application-${randomUUID()}`;
  const submittedEvidenceDigest = digest(`submitted-proof:${submittedPair.id}`);
  await sql.begin(async (tx) => {
    await tx`
      insert into submissions_v2.submission_proofs(
        pair_id, application_id, authoritative_path, evidence_digest, observed_at, source_checked_at
      ) values (
        ${submittedPair.id}, ${submittedApplicationId}, 'application.getRecruiterApplicationData',
        ${submittedEvidenceDigest}, clock_timestamp(), clock_timestamp()
      )
    `;
    await tx`
      update submissions_v2.candidate_role_pairs
         set submission_status='proven', submission_proven_at=clock_timestamp(),
             submission_application_id=${submittedApplicationId},
             submission_authoritative_path='application.getRecruiterApplicationData',
             submission_evidence_digest=${submittedEvidenceDigest}
       where id=${submittedPair.id}
    `;
  });
  await sql`
    insert into submissions_v2.resume_generations(
      id, pair_id, generation_version, trigger_kind, idempotency_key, status, stage,
      expected_pair_version, first_signal_id, primary_model_pin, fallback_model_pin,
      validator_model_pin, prompt_pin, template_pin, deadline_at
    ) values (
      ${submittedGenerationId}, ${submittedPair.id}, 1, 'initial', ${`resume-job:submitted-expired:attempt:1`},
      'strategizing', 'strategy', 1, ${submittedPair.signal}, 'opus-test', 'opus-fallback-test',
      'validator-test', 'prompt-test', 'template-test', clock_timestamp() - interval '1 minute'
    )
  `;
  const repository = createRepository({ sql, env: { SUBMISSIONS_V2_SLACK_CHANNEL_ID: 'C01234567' } });
  const recovered = await repository.recoverExpiredResumeGenerations();
  assert.deepEqual(
    [...recovered.recovered].sort((left, right) => left.generation_id.localeCompare(right.generation_id)),
    [
      { generation_id: generationId, pair_id: pair.id, routed_to_review: true },
      { generation_id: submittedGenerationId, pair_id: submittedPair.id, routed_to_review: false },
    ].sort((left, right) => left.generation_id.localeCompare(right.generation_id)),
  );
  assert.deepEqual((await sql`select workflow_state, state_version from submissions_v2.candidate_role_pairs where id=${pair.id}`)[0], {
    workflow_state: 'needs_review', state_version: '2',
  });
  assert.deepEqual((await sql`select status, stage, safe_failure_code from submissions_v2.resume_generations where id=${generationId}`)[0], {
    status: 'failed', stage: 'recovery_failed', safe_failure_code: 'generation_deadline_exhausted',
  });
  assert.equal((await sql`select status from submissions_v2.resume_stage_runs where generation_id=${generationId}`)[0].status, 'held');
  assert.equal((await sql`select count(*)::integer as count from submissions_v2.review_items where pair_id=${pair.id} and reason_code='resume_preparation_failed' and action_state='open'`)[0].count, 1);
  assert.deepEqual((await sql`
    select intent_state, workflow_state, submission_status, state_version
      from submissions_v2.candidate_role_pairs where id=${submittedPair.id}
  `)[0], {
    intent_state: 'interested', workflow_state: 'needs_review', submission_status: 'proven', state_version: '2',
  });
  assert.deepEqual((await sql`
    select status, stage, safe_failure_code from submissions_v2.resume_generations where id=${submittedGenerationId}
  `)[0], { status: 'failed', stage: 'recovery_failed', safe_failure_code: 'generation_deadline_exhausted' });
  assert.equal((await sql`
    select count(*)::integer as count from submissions_v2.review_items where pair_id=${submittedPair.id}
  `)[0].count, 0);
  assert.equal((await sql`
    select count(*)::integer as count from submissions_v2.notification_outbox where pair_id=${submittedPair.id}
  `)[0].count, 0);
  await setRuntimeControls({ actorEmail: 'test@raydar.xyz', reason: 'Restore orphan recovery controls',
    ui: prior.ui_enabled, generation: prior.generation_enabled, ingestion: prior.ingestion_enabled,
    masterInbox: prior.master_inbox_enabled, curated: prior.curated_enabled }, sql);
});

test("expired resume recovery never overtakes a live preparation-job lease", async () => {
  const pair = await preparingPair();
  const generationId = randomUUID();
  const jobId = randomUUID();
  const prior = await readRuntimeControls(sql);
  const controls = await setRuntimeControls({ actorEmail: 'test@raydar.xyz', reason: 'Enable live lease recovery guard regression',
    ui: true, generation: true, ingestion: prior.ingestion_enabled,
    masterInbox: prior.master_inbox_enabled, curated: prior.curated_enabled }, sql);
  await sql`
    insert into submissions_v2.resume_generations(
      id, pair_id, generation_version, trigger_kind, idempotency_key, status, stage,
      expected_pair_version, first_signal_id, primary_model_pin, fallback_model_pin,
      validator_model_pin, prompt_pin, template_pin, deadline_at
    ) values (
      ${generationId}, ${pair.id}, 1, 'initial', ${`resume-job:${jobId}:attempt:1`}, 'strategizing', 'strategy',
      1, ${pair.signal}, 'opus-test', 'opus-fallback-test', 'validator-test',
      'prompt-test', 'template-test', clock_timestamp() - interval '1 minute'
    )
  `;
  await sql`
    insert into submissions_v2.jobs(
      id, kind, subject_type, subject_id, idempotency_key, required_control, control_epoch,
      state, lease_owner, lease_expires_at, fencing_token, attempt_count, started_at
    ) values (
      ${jobId}, 'prepare_resume', 'pair', ${pair.id}, ${`resume-fixture:${jobId}`}, 'generation', ${controls.control_epoch},
      'running', 'live-resume-worker', clock_timestamp() + interval '2 minutes', 1, 1, clock_timestamp()
    )
  `;
  const recovered = await createRepository({ sql, env: { SUBMISSIONS_V2_SLACK_CHANNEL_ID: 'C01234567' } }).recoverExpiredResumeGenerations();
  assert.deepEqual(recovered.recovered, []);
  assert.equal((await sql`select status from submissions_v2.resume_generations where id=${generationId}`)[0].status, 'strategizing');
  assert.equal((await sql`select workflow_state from submissions_v2.candidate_role_pairs where id=${pair.id}`)[0].workflow_state, 'preparing_resume');
  await setRuntimeControls({ actorEmail: 'test@raydar.xyz', reason: 'Restore live lease recovery guard controls',
    ui: prior.ui_enabled, generation: prior.generation_enabled, ingestion: prior.ingestion_enabled,
    masterInbox: prior.master_inbox_enabled, curated: prior.curated_enabled }, sql);
});

test("a resumed worker job receives only its unspent two-dollar model reserve", async () => {
  const pair = await preparingPair();
  const prior = await readRuntimeControls(sql);
  const controls = await setRuntimeControls({
    actorEmail: 'test@raydar.xyz', reason: 'Enable bounded resume budget regression',
    ui: prior.ui_enabled, ingestion: prior.ingestion_enabled, generation: true,
    masterInbox: prior.master_inbox_enabled, curated: prior.curated_enabled,
  }, sql);
  const jobId = randomUUID();
  await sql`
    insert into submissions_v2.jobs(
      id, kind, subject_type, subject_id, idempotency_key, required_control, control_epoch,
      state, lease_owner, lease_expires_at, fencing_token, attempt_count, started_at
    ) values (
      ${jobId}, 'prepare_resume', 'pair', ${pair.id}, ${`resume-fixture:${jobId}`}, 'generation', ${controls.control_epoch},
      'running', 'resume-budget-worker', clock_timestamp() + interval '2 minutes', 1, 1, clock_timestamp()
    )
  `;
  await sql`
    insert into submissions_v2.resume_generations(
      pair_id, generation_version, trigger_kind, idempotency_key, status, stage,
      expected_pair_version, first_signal_id, primary_model_pin, fallback_model_pin,
      validator_model_pin, prompt_pin, template_pin, spent_cents, deadline_at, completed_at
    ) values (
      ${pair.id}, 1, 'initial', ${`resume-job:${jobId}:attempt:1`}, 'failed', 'retry_scheduled',
      1, ${pair.signal}, 'opus-test', 'opus-fallback-test', 'validator-test',
      'prompt-test', 'template-test', 183, clock_timestamp() + interval '5 minutes', clock_timestamp()
    )
  `;
  const repository = createRepository({ sql });
  const generation = await repository.startResumeGeneration({
    pairId: pair.id, triggerKind: 'initial', idempotencyKey: `resume-job:${jobId}:attempt:2`, expectedPairVersion: 1,
    primaryModelPin: 'claude-opus-5', fallbackModelPin: 'claude-opus-4-8', validatorModelPin: 'gpt-5.4-2026-03-05',
    promptPin: 'test', templatePin: 'test', deadlineAt: new Date(Date.now() + 60_000).toISOString(),
    executionFence: { jobId, workerId: 'resume-budget-worker', fencingToken: 1, controlEpoch: Number(controls.control_epoch) },
  });
  assert.equal(Number(generation.job_spent_cents), 183);
  assert.equal(Number(generation.budget_cents), 17);
  await setRuntimeControls({
    actorEmail: 'test@raydar.xyz', reason: 'Restore controls after bounded resume budget regression',
    ui: prior.ui_enabled, ingestion: prior.ingestion_enabled, generation: prior.generation_enabled,
    masterInbox: prior.master_inbox_enabled, curated: prior.curated_enabled,
  }, sql);
});

test("administrator case deletion is hidden, encrypted-manifest-backed, fenced, recoverable, and append-only audited", async () => {
  const repository = createRepository({ sql });
  const pair = await preparingPair();
  const generationId = randomUUID();
  await sql`
    insert into submissions_v2.resume_generations(
      id, pair_id, generation_version, trigger_kind, idempotency_key, status, stage,
      expected_pair_version, first_signal_id, primary_model_pin, fallback_model_pin,
      validator_model_pin, prompt_pin, template_pin, deadline_at
    ) values (
      ${generationId}, ${pair.id}, 1, 'initial', ${`generation:${generationId}`}, 'queued', 'queued',
      1, ${pair.signal}, 'opus-test', 'opus-fallback-test', 'validator-test',
      'prompt-test', 'template-test', clock_timestamp() + interval '5 minutes'
    )
  `;
  const artifactId = randomUUID();
  await sql`
    insert into submissions_v2.resume_artifacts(
      id, pair_id, generation_id, artifact_version, kind, private_object_key,
      digest, size_bytes, validation_status, current_state
    ) values (
      ${artifactId}, ${pair.id}, ${generationId}, 1, 'pdf',
      ${`submissions/resumes/v2/artifacts/${artifactId}`}, ${digest("artifact")}, 100,
      'pending', 'staged'
    )
  `;
  const supplementId = randomUUID();
  await sql`
    insert into submissions_v2.resume_supplements(
      id, pair_id, supplement_kind, text_value_encrypted, creator_email,
      digest, scan_state, parse_state, evidence_basis, source_or_correction_note
    ) values (
      ${supplementId}, ${pair.id}, 'evidence', ${Buffer.from("encrypted-context")},
      'admin@raydar.xyz', ${digest("supplement")}, 'clean', 'parsed', 'sourced', 'Candidate supplied context'
    )
  `;
  const controls = await readRuntimeControls(sql);
  const jobId = randomUUID();
  await sql`
    insert into submissions_v2.jobs(
      id, kind, subject_type, subject_id, idempotency_key, required_control, control_epoch
    ) values (
      ${jobId}, 'prepare_resume', 'pair', ${pair.id}, ${`job:${jobId}`}, 'generation', ${controls.control_epoch}
    )
  `;

  const deleteKey = `delete-case:${randomUUID()}`;
  const deleteReservation = await repository.reserveCaseRetentionCommand({
    actorEmail: "admin@raydar.xyz", action: "soft_delete_case", idempotencyKey: deleteKey,
    pairId: pair.id, expectedVersion: 1, reason: "Approved private deletion",
  });
  const snapshot = await repository.caseDeletionManifest({ pairId: pair.id, expectedVersion: 1 });
  const deletionId = randomUUID();
  const requestedAt = "2026-09-01T20:00:00.000Z";
  const recoveryDeadline = "2026-10-01T20:00:00.000Z";
  const manifest = {
    manifest_version: 1, deletion_id: deletionId, pair_id: pair.id,
    requested_at: requestedAt, recovery_deadline: recoveryDeadline,
    reason: "Approved private deletion", reason_digest: digest("Approved private deletion"), snapshot,
  };
  const manifestObjectKey = `submissions/resumes/v2/case_manifests/${deletionId}`;
  const manifestDigest = digest("encrypted-manifest");
  const objectReservation = await repository.reservePrivateObject({
    reservationId: randomUUID(), purpose: "case_manifest", ownerRef: pair.id,
    objectKey: manifestObjectKey, expectedDigest: manifestDigest,
    expiresAt: Date.now() + 24 * 60 * 60_000,
  });
  const deleted = await repository.softDeleteCase({
    actorEmail: "admin@raydar.xyz", commandId: deleteReservation.command_id,
    pairId: pair.id, expectedVersion: 1, deletionId, requestedAt, recoveryDeadline,
    encryptedManifestObjectKey: manifestObjectKey,
    manifestDigest, tombstoneCaseHmac: digest(`hmac:${pair.id}`), tombstoneCandidateHmac: digest(`candidate:${pair.candidate}`), manifest,
    objectReservationId: objectReservation.id, objectWriteFencingToken: objectReservation.write_fencing_token,
  });
  assert.equal(deleted.state, "soft_deleted");
  assert.equal(deleted.state_version, 2);
  assert.equal(await repository.pair(pair.id), null);
  assert.equal((await repository.archive({ candidateId: pair.candidate, roleId: pair.role })).length, 0);
  assert.equal((await repository.jobs({ pairId: pair.id })).length, 0);
  const hidden = (await sql`select * from submissions_v2.candidate_role_pairs where id=${pair.id}`)[0];
  assert.ok(hidden.case_hidden_at);
  assert.equal(Number(hidden.state_version), 2);
  assert.equal((await sql`select current_state from submissions_v2.resume_artifacts where id=${artifactId}`)[0].current_state, "deleted");
  assert.equal((await sql`select active from submissions_v2.resume_supplements where id=${supplementId}`)[0].active, false);
  assert.equal((await sql`select status from submissions_v2.resume_generations where id=${generationId}`)[0].status, "cancelled");
  const cancelledJob = (await sql`select state, fencing_token from submissions_v2.jobs where id=${jobId}`)[0];
  assert.equal(cancelledJob.state, "cancelled");
  assert.equal(Number(cancelledJob.fencing_token), 1);
  const lateStore = createResumePipelineStore({ sql, repository, blobs: {
    putPrivateObject: async () => assert.fail("a cancelled generation must not write private data"),
    readPrivateObject: async () => assert.fail("a cancelled generation must not read private data"),
  } });
  await assert.rejects(() => lateStore.recordStage({
    generationId, stage: "late", attempt: 1, inputDigest: digest("late"), status: "succeeded",
    executionFence: { jobId, workerId: "expired-worker", fencingToken: 0, controlEpoch: Number(controls.control_epoch) },
  }), (error) => ["execution_fence_lost", "generation_execution_fence_lost"].includes(error.code));
  assert.equal((await sql`select count(*)::integer as count from submissions_v2.resume_stage_runs where generation_id=${generationId} and stage='late'`)[0].count, 0);
  assert.equal((await repository.duePurges()).cases.length, 0);

  const deleteReplay = await repository.reserveCaseRetentionCommand({
    actorEmail: "admin@raydar.xyz", action: "soft_delete_case", idempotencyKey: deleteKey,
    pairId: pair.id, expectedVersion: 1, reason: "Approved private deletion",
  });
  assert.equal(deleteReplay.replay, true);
  assert.equal(deleteReplay.result.deletion_id, deletionId);

  const restoreKey = `restore-case:${randomUUID()}`;
  const restoreReservation = await repository.reserveCaseRetentionCommand({
    actorEmail: "admin@raydar.xyz", action: "restore_case", idempotencyKey: restoreKey,
    pairId: pair.id, expectedVersion: 2,
  });
  const recoverable = await repository.caseDeletionForRestore({ pairId: pair.id });
  assert.equal(recoverable.id, deletionId);
  const restoreControls = await readRuntimeControls(sql);
  await setRuntimeControls({
    actorEmail: "test@raydar.xyz", reason: "Enable generation for case restoration test",
    ui: restoreControls.ui_enabled, ingestion: restoreControls.ingestion_enabled, generation: true,
    masterInbox: restoreControls.master_inbox_enabled, curated: restoreControls.curated_enabled,
  }, sql);
  const restored = await repository.restoreCase({
    actorEmail: "admin@raydar.xyz", commandId: restoreReservation.command_id,
    pairId: pair.id, expectedVersion: 2, deletionId, manifest,
  });
  assert.equal(restored.state, "restored");
  assert.equal(restored.state_version, 3);
  assert.ok(restored.resumed_job_id);
  assert.equal(Number((await repository.pair(pair.id)).state_version), 3);
  await setRuntimeControls({
    actorEmail: "test@raydar.xyz", reason: "Restore controls after case restoration test",
    ui: restoreControls.ui_enabled, ingestion: restoreControls.ingestion_enabled,
    generation: restoreControls.generation_enabled, masterInbox: restoreControls.master_inbox_enabled,
    curated: restoreControls.curated_enabled,
  }, sql);
  assert.equal((await sql`select current_state from submissions_v2.resume_artifacts where id=${artifactId}`)[0].current_state, "staged");
  assert.equal((await sql`select active from submissions_v2.resume_supplements where id=${supplementId}`)[0].active, true);
  const artifactDeletion = (await sql`select * from submissions_v2.artifact_deletions where artifact_id=${artifactId}`)[0];
  assert.ok(artifactDeletion.restored_at);
  assert.equal(artifactDeletion.restored_by, "admin@raydar.xyz");
  const deletion = (await sql`select * from submissions_v2.case_deletions where id=${deletionId}`)[0];
  assert.equal(deletion.state, "restored");
  assert.ok(deletion.restored_at);
  const audit = await sql`select event_type from submissions_v2.case_deletion_audit where deletion_id=${deletionId} order by id`;
  assert.deepEqual(audit.map((row) => row.event_type), ["soft_deleted", "restored"]);
  await assert.rejects(
    sql`update submissions_v2.case_deletion_audit set actor_email='changed@raydar.xyz' where deletion_id=${deletionId}`,
    /permanent append-only audit/,
  );
});

test("a due case cannot claim another pair's object path across storage tables", async () => {
  const pairA = await preparingPair();
  const pairB = await preparingPair();
  const generationB = randomUUID();
  await sql`
    insert into submissions_v2.resume_generations(
      id, pair_id, generation_version, trigger_kind, idempotency_key, status, stage,
      expected_pair_version, first_signal_id, primary_model_pin, fallback_model_pin,
      validator_model_pin, prompt_pin, template_pin, deadline_at
    ) values (
      ${generationB}, ${pairB.id}, 1, 'initial', ${`owner-regression:${generationB}`},
      'queued', 'queued', 1, ${pairB.signal}, 'opus-test', 'opus-fallback-test',
      'validator-test', 'prompt-test', 'template-test', clock_timestamp() + interval '5 minutes'
    )
  `;
  const crossPairArtifact = randomUUID();
  const crossPairPath = `submissions/resumes/v2/ats/${crossPairArtifact}`;
  await sql`
    insert into submissions_v2.private_object_reservations(
      id, object_key, purpose, owner_ref, expected_digest, state, expires_at, committed_at
    ) values (
      ${randomUUID()}, ${crossPairPath}, 'resume_artifact', ${generationB},
      ${digest("cross-pair-artifact")}, 'committed', clock_timestamp() + interval '1 day', clock_timestamp()
    )
  `;
  await assert.rejects(
    sql`
      insert into submissions_v2.resume_artifacts(
        id, pair_id, generation_id, artifact_version, kind, private_object_key,
        digest, size_bytes, validation_status, current_state
      ) values (
        ${crossPairArtifact}, ${pairA.id}, ${generationB}, 99, 'ats', ${crossPairPath},
        ${digest("cross-pair-artifact")}, 100, 'pending', 'staged'
      )
    `,
    /resume_artifacts_generation_pair_fk|foreign key constraint/,
  );
  await assert.rejects(
    sql`
      insert into submissions_v2.resume_supplements(
        id, pair_id, generation_id, supplement_kind, text_value_encrypted,
        creator_email, digest, scan_state, parse_state, evidence_basis,
        source_or_correction_note
      ) values (
        ${randomUUID()}, ${pairA.id}, ${generationB}, 'generation_instruction',
        ${Buffer.from("encrypted instruction")}, 'recruiter@raydar.xyz',
        ${digest("cross-pair-instruction")}, 'not_applicable', 'not_applicable',
        'sourced', 'Cross-pair instruction attempt'
      )
    `,
    /resume_supplements_generation_pair_fk|foreign key constraint/,
  );
  const artifactB = randomUUID();
  const protectedPath = `submissions/resumes/v2/pdf/${artifactB}`;
  await sql`
    insert into submissions_v2.resume_artifacts(
      id, pair_id, generation_id, artifact_version, kind, private_object_key,
      digest, size_bytes, validation_status, current_state
    ) values (
      ${artifactB}, ${pairB.id}, ${generationB}, 1, 'pdf', ${protectedPath},
      ${digest("protected-artifact")}, 100, 'pending', 'staged'
    )
  `;

  // Simulate an in-place 001-010 upgrade: the owner row exists before the
  // registry, then migration 011 reconstructs and validates it transactionally.
  await sql`delete from submissions_v2.private_object_bindings where object_key=${protectedPath}`;
  await sql`select submissions_v2.backfill_private_object_bindings()`;

  await assert.rejects(
    sql`
      insert into submissions_v2.resume_supplements(
        id, pair_id, supplement_kind, object_key, creator_email, mime_type,
        original_name, size_bytes, digest, scan_state, parse_state,
        evidence_basis, source_or_correction_note
      ) values (
        ${randomUUID()}, ${pairA.id}, 'evidence', ${protectedPath}, 'attacker@raydar.xyz',
        'application/pdf', 'poison.pdf', 100, ${digest("poison")}, 'pending', 'pending',
        'sourced', 'Cross-pair purge poison attempt'
      )
    `,
    /private object path already belongs to another record/,
  );
  await assert.rejects(
    sql`
      insert into submissions_v2.private_object_reservations(
        id, object_key, purpose, owner_ref, expected_digest, expires_at
      ) values (
        ${randomUUID()}, ${protectedPath}, 'case_manifest', ${pairA.id},
        ${digest("poison-reservation")}, clock_timestamp() + interval '1 day'
      )
    `,
    /private object path is already reserved or owned by another record/,
  );

  const movableSupplement = randomUUID();
  const movablePath = `submissions/resumes/v2/supplements/${movableSupplement}`;
  await sql`
    insert into submissions_v2.resume_supplements(
      id, pair_id, supplement_kind, object_key, creator_email, mime_type,
      original_name, size_bytes, digest, scan_state, parse_state,
      evidence_basis, source_or_correction_note
    ) values (
      ${movableSupplement}, ${pairB.id}, 'evidence', ${movablePath}, 'candidate@example.com',
      'application/pdf', 'candidate.pdf', 100, ${digest("movable")}, 'pending', 'pending',
      'sourced', 'Owner relation immutability regression'
    )
  `;
  await assert.rejects(
    sql`update submissions_v2.resume_supplements set pair_id=${pairA.id} where id=${movableSupplement}`,
    /supplement owner relation is immutable/,
  );

  const binding = (await sql`
    select owner_table, owner_column, owner_id, owner_pair_id, reservation_id
      from submissions_v2.private_object_bindings where object_key=${protectedPath}
  `)[0];
  assert.deepEqual(binding, {
    owner_table: "resume_artifacts",
    owner_column: "private_object_key",
    owner_id: artifactB,
    owner_pair_id: pairB.id,
    reservation_id: null,
  });
});

test("quarantined upload cleanup returns only 24-hour-old objects and marks DB state idempotently after deletion", async () => {
  const repository = createRepository({ sql });
  const pair = await preparingPair();
  const oldId = randomUUID();
  const youngId = randomUUID();
  for (const [id, createdAt] of [
    [oldId, new Date(Date.now() - 48 * 60 * 60 * 1_000)],
    [youngId, new Date(Date.now() - 60 * 60 * 1_000)],
  ]) {
    await sql`
      insert into submissions_v2.resume_supplements(
        id, pair_id, supplement_kind, object_key, creator_email, created_at,
        mime_type, original_name, size_bytes, digest, scan_state, parse_state,
        active, quarantined, evidence_basis, source_or_correction_note
      ) values (
        ${id}, ${pair.id}, 'evidence', ${`submissions/resumes/v2/supplements/${id}`},
        'admin@raydar.xyz', ${createdAt}, 'application/pdf', 'upload.pdf', 100,
        ${digest(id)}, 'pending', 'pending', true, true, 'sourced', 'Quarantined upload'
      )
    `;
  }
  const due = await repository.dueQuarantinedSupplements({ before: new Date().toISOString(), limit: 10, workerId: "worker-test" });
  assert.deepEqual([...due].map((row) => row.supplement_id), [oldId]);
  assert.equal(due[0].object_key, `submissions/resumes/v2/supplements/${oldId}`);
  const purged = await repository.markQuarantinedSupplementPurged({ supplementId: oldId, workerId: "worker-test", fencingToken: due[0].quarantine_cleanup_fencing_token });
  assert.equal(purged.purged, true);
  assert.equal(purged.already_purged, false);
  const retained = (await sql`select active, private_object_purged_at from submissions_v2.resume_supplements where id=${oldId}`)[0];
  assert.equal(retained.active, false);
  assert.ok(retained.private_object_purged_at);
  await assert.rejects(
    () => repository.markQuarantinedSupplementPurged({ supplementId: oldId, workerId: "worker-test", fencingToken: due[0].quarantine_cleanup_fencing_token }),
    (error) => error.code === "supplement_quarantine_purge_fence_lost",
  );
  assert.equal((await sql`select count(*)::integer as count from submissions_v2.pair_events where idempotency_key=${`supplement-quarantine-purge:${oldId}`}`)[0].count, 1);
  assert.equal((await sql`select count(*)::integer as count from submissions_v2.resume_supplements where id=${youngId}`)[0].count, 1);
});

test("the API principal dismisses only an idle unresolved signal with an idempotent audited command", async () => {
  const prior = await readRuntimeControls(sql);
  const signalId = randomUUID();
  const eventId = `dismiss-review-${randomUUID()}`;
  const idempotencyKey = randomUUID();
  const staleKey = randomUUID();
  const note = "Confirmed this was a calendar-service notification, not a candidate response.";
  const apiDatabase = {
    begin: (work) => sql.begin(async (apiSql) => {
      await apiSql.unsafe("set local role submissions_v2_api");
      return work(apiSql);
    }),
  };
  const repository = createRepository({ sql: apiDatabase });
  try {
    await setRuntimeControls({
      actorEmail: "admin@raydar.xyz", reason: "Enable Review dismissal regression",
      ui: true, ingestion: prior.ingestion_enabled, generation: prior.generation_enabled,
      masterInbox: prior.master_inbox_enabled, curated: prior.curated_enabled,
    }, sql);
    await sql`
      insert into submissions_v2.source_events(
        id, source_family, source_version, event_id, provider, mailbox_id, provider_message_id,
        direction, received_at, content_digest, processing_state, safe_error_code,
        safe_error_detail, idempotency_key, envelope, sender_display_name
      ) values (
        ${signalId}, 'email', 'submissions.email_reply.v1', ${eventId}, 'gmail', 'david-raydar-xyz',
        ${`message-${eventId}`}, 'inbound', clock_timestamp(), ${digest(signalId)}, 'needs_role',
        'role_unclear', 'The exact offered role was not present in the source contract.',
        ${`source:${signalId}`}, ${sql.json({ source_family: 'fit_follow_up_with_matches' })}, 'Calendar assistant'
      )
    `;
    await sql`
      insert into submissions_v2.review_items(unresolved_signal_id, reason_code, safe_detail)
      values (${signalId}, 'role_unclear', 'Select the exact role confirmed from the source email.')
    `;
    const result = await repository.dismissUnresolvedSignal({
      actorEmail: "recruiter@raydar.xyz", idempotencyKey, signalId,
      dismissalReason: "irrelevant_notification", note,
    });
    assert.deepEqual(result, {
      outcome: "dismissed", destination: "removed_from_review",
      signal_id: signalId, affected_count: 1,
    });
    assert.deepEqual([...(await sql`
      select processing_state, safe_error_code from submissions_v2.source_events where id=${signalId}
    `)], [{ processing_state: "ignored_later", safe_error_code: "review_dismissed" }]);
    assert.deepEqual([...(await sql`
      select action_state, resolved_by, resolution_note from submissions_v2.review_items where unresolved_signal_id=${signalId}
    `)], [{ action_state: "dismissed", resolved_by: "recruiter@raydar.xyz", resolution_note: note }]);
    const audit = (await sql`
      select action, status, result from submissions_v2.api_commands
       where actor_email='recruiter@raydar.xyz' and idempotency_key=${idempotencyKey}
    `)[0];
    assert.equal(audit.action, "dismiss_review");
    assert.equal(audit.status, "succeeded");
    assert.deepEqual(audit.result, result);
    assert.deepEqual(await repository.dismissUnresolvedSignal({
      actorEmail: "recruiter@raydar.xyz", idempotencyKey, signalId,
      dismissalReason: "irrelevant_notification", note,
    }), { ...result, replay: true });
    await assert.rejects(
      repository.dismissUnresolvedSignal({
        actorEmail: "recruiter@raydar.xyz", idempotencyKey: staleKey, signalId,
        dismissalReason: "irrelevant_notification", note,
      }),
      (error) => error.code === "review_dismiss_not_eligible" && error.status === 409,
    );
    const untouched = (await sql`
      select
        (select count(*)::integer from submissions_v2.candidate_role_pairs where first_signal_id=${signalId}) as pairs,
        (select count(*)::integer from submissions_v2.first_response_claims where signal_id=${signalId}) as claims,
        (select count(*)::integer from submissions_v2.jobs where subject_id=${signalId}::text) as jobs,
        (select count(*)::integer from submissions_v2.signal_role_decisions where signal_id=${signalId}) as decisions,
        (select count(*)::integer from submissions_v2.pair_signal_links where signal_id=${signalId}) as links,
        (select count(*)::integer from submissions_v2.api_commands where idempotency_key=${staleKey}) as rolled_back_commands
    `)[0];
    assert.deepEqual(untouched, { pairs: 0, claims: 0, jobs: 0, decisions: 0, links: 0, rolled_back_commands: 0 });
  } finally {
    await setRuntimeControls({
      actorEmail: "admin@raydar.xyz", reason: "Restore controls after Review dismissal regression",
      ui: prior.ui_enabled, ingestion: prior.ingestion_enabled, generation: prior.generation_enabled,
      masterInbox: prior.master_inbox_enabled, curated: prior.curated_enabled,
    }, sql);
  }
});

test("Review decisions cannot clear a resume-specific blocker through the generic resolution path", async () => {
  const prior = await readRuntimeControls(sql);
  const pair = await preparingPair();
  const idempotencyKey = randomUUID();
  const apiDatabase = {
    begin: (work) => sql.begin(async (apiSql) => {
      await apiSql.unsafe("set local role submissions_v2_api");
      return work(apiSql);
    }),
  };
  try {
    await setRuntimeControls({
      actorEmail: "admin@raydar.xyz", reason: "Enable Review action-precondition regression",
      ui: true, ingestion: prior.ingestion_enabled, generation: prior.generation_enabled,
      masterInbox: prior.master_inbox_enabled, curated: prior.curated_enabled,
    }, sql);
    const current = await sql.begin(async (tx) => {
      const updated = (await tx`
        update submissions_v2.candidate_role_pairs
           set workflow_state='needs_review', state_version=state_version+1
         where id=${pair.id} returning *
      `)[0];
      await tx`
        insert into submissions_v2.review_items(pair_id, reason_code, safe_detail)
        values (${pair.id}, 'candidate_original_resume_missing', 'The candidate-original resume is unavailable.')
      `;
      return updated;
    });
    const repository = createRepository({ sql: apiDatabase });
    await assert.rejects(
      repository.transition({
        actorEmail: "recruiter@raydar.xyz", idempotencyKey, pairId: pair.id,
        expectedVersion: Number(current.state_version), destination: "interested",
        note: "Attempted generic clearance", action: "resolve_review",
      }),
      (error) => error.code === "review_resolution_not_eligible" && error.status === 409,
    );
    assert.deepEqual([...(await sql`
      select workflow_state, state_version from submissions_v2.candidate_role_pairs where id=${pair.id}
    `)], [{ workflow_state: "needs_review", state_version: current.state_version }]);
    assert.equal((await sql`
      select count(*)::integer as count from submissions_v2.review_items
       where pair_id=${pair.id} and reason_code='candidate_original_resume_missing' and action_state='open'
    `)[0].count, 1);
    assert.equal((await sql`
      select count(*)::integer as count from submissions_v2.api_commands where idempotency_key=${idempotencyKey}
    `)[0].count, 0);
  } finally {
    await setRuntimeControls({
      actorEmail: "admin@raydar.xyz", reason: "Restore controls after Review action-precondition regression",
      ui: prior.ui_enabled, ingestion: prior.ingestion_enabled, generation: prior.generation_enabled,
      masterInbox: prior.master_inbox_enabled, curated: prior.curated_enabled,
    }, sql);
  }
});

test("a classifier role-unclear pair can be resolved only with an active exact source offer", async () => {
  const prior = await readRuntimeControls(sql);
  const apiDatabase = {
    begin: (work) => sql.begin(async (apiSql) => {
      await apiSql.unsafe("set local role submissions_v2_api");
      return work(apiSql);
    }),
  };
  const repository = createRepository({ sql: apiDatabase });
  const fixture = async ({ offered = true, candidateActive = true, roleActive = true } = {}) => {
    const candidateId = `role-unclear-candidate-${randomUUID()}`;
    const roleId = `role-unclear-role-${randomUUID()}`;
    const signalId = await sourceEvent({ family: "email", envelope: { candidate_resolution: { candidate_user_id: candidateId } } });
    const pairId = randomUUID();
    await sql`
      insert into submissions_v2.candidate_index(
        candidate_user_id, display_name, normalized_name, search_key, active,
        paraform_profile_url, last_confirmed_at, source_digest
      ) values (
        ${candidateId}, 'Exact Role Candidate', 'exact role candidate', 'exact role candidate', ${candidateActive},
        ${`https://www.paraform.com/candidates?candidate=${candidateId}`}, clock_timestamp(), ${digest(candidateId)}
      )
    `;
    await sql`
      insert into submissions_v2.role_index(
        role_id, company_name, role_title, search_key, active, destination_url, last_confirmed_at, source_digest
      ) values (
        ${roleId}, 'Exact Role Company', 'Exact Role Engineer', 'exact role company exact role engineer', ${roleActive},
        ${`https://www.paraform.com/browse?role=${roleId}`}, clock_timestamp(), ${digest(roleId)}
      )
    `;
    if (offered) {
      await sql`
        insert into submissions_v2.source_offered_roles(
          signal_id, role_id, company_snapshot, role_label_snapshot, role_url_snapshot, content_digest
        ) values (
          ${signalId}, ${roleId}, 'Exact Role Company', 'Exact Role Engineer',
          ${`https://www.paraform.com/browse?role=${roleId}`}, ${digest(`offered:${signalId}:${roleId}`)}
        )
      `;
    }
    await sql.begin(async (tx) => {
      await tx`
        insert into submissions_v2.candidate_role_pairs(
          id, candidate_user_id, role_id, first_signal_id, intent_state, workflow_state, original_signal_at, role_state
        ) values (
          ${pairId}, ${candidateId}, ${roleId}, ${signalId}, 'unclear', 'needs_review', clock_timestamp(), 'active'
        )
      `;
      await tx`
        insert into submissions_v2.review_items(pair_id, reason_code, safe_detail, evidence)
        values (${pairId}, 'role_unclear', 'The exact offered role is known but requires a human decision.', ${tx.json({ signal_id: signalId, role_id: roleId })})
      `;
    });
    return { candidateId, roleId, signalId, pairId };
  };
  try {
    await setRuntimeControls({
      actorEmail: "admin@raydar.xyz", reason: "Enable exact classifier role-unclear resolution regression",
      ui: true, ingestion: prior.ingestion_enabled, generation: true,
      masterInbox: prior.master_inbox_enabled, curated: prior.curated_enabled,
    }, sql);

    const matched = await fixture();
    const idempotencyKey = randomUUID();
    const resolved = await repository.transition({
      actorEmail: "recruiter@raydar.xyz", idempotencyKey, pairId: matched.pairId,
      expectedVersion: 1, destination: "interested", note: "Candidate selected the exact offered role.", action: "resolve_review",
    });
    assert.deepEqual(resolved, { case_id: matched.pairId, state: "preparing_resume", state_version: 2 });
    assert.deepEqual((await sql`
      select intent_state, workflow_state, state_version from submissions_v2.candidate_role_pairs where id=${matched.pairId}
    `)[0], { intent_state: "interested", workflow_state: "preparing_resume", state_version: "2" });
    assert.equal((await sql`
      select count(*)::integer as count from submissions_v2.review_items where pair_id=${matched.pairId} and action_state='open'
    `)[0].count, 0);
    assert.equal((await sql`
      select count(*)::integer as count from submissions_v2.jobs where subject_id=${matched.pairId}::text and kind='prepare_resume' and state='queued'
    `)[0].count, 1);
    assert.deepEqual(await repository.transition({
      actorEmail: "recruiter@raydar.xyz", idempotencyKey, pairId: matched.pairId,
      expectedVersion: 1, destination: "interested", note: "Candidate selected the exact offered role.", action: "resolve_review",
    }), { ...resolved, replay: true });

    for (const blocked of [
      await fixture({ offered: false }),
      await fixture({ candidateActive: false }),
      await fixture({ roleActive: false }),
    ]) {
      const blockedKey = randomUUID();
      await assert.rejects(
        repository.transition({
          actorEmail: "recruiter@raydar.xyz", idempotencyKey: blockedKey, pairId: blocked.pairId,
          expectedVersion: 1, destination: "interested", note: "Attempted role-unclear clearance", action: "resolve_review",
        }),
        (error) => error.code === "review_resolution_not_eligible" && error.status === 409,
      );
      assert.deepEqual((await sql`
        select intent_state, workflow_state, state_version from submissions_v2.candidate_role_pairs where id=${blocked.pairId}
      `)[0], { intent_state: "unclear", workflow_state: "needs_review", state_version: "1" });
      assert.equal((await sql`
        select count(*)::integer as count from submissions_v2.review_items where pair_id=${blocked.pairId} and action_state='open' and reason_code='role_unclear'
      `)[0].count, 1);
      assert.equal((await sql`
        select count(*)::integer as count from submissions_v2.api_commands where idempotency_key=${blockedKey}
      `)[0].count, 0);
    }
  } finally {
    await setRuntimeControls({
      actorEmail: "admin@raydar.xyz", reason: "Restore controls after exact classifier role-unclear resolution regression",
      ui: prior.ui_enabled, ingestion: prior.ingestion_enabled, generation: prior.generation_enabled,
      masterInbox: prior.master_inbox_enabled, curated: prior.curated_enabled,
    }, sql);
  }
});

test("a fenced live role recheck clears only role availability and never invents unclear intent", async () => {
  const prior = await readRuntimeControls(sql);
  const enabled = await setRuntimeControls({
    actorEmail: "admin@raydar.xyz", reason: "Enable exact role-recheck regression",
    ui: true, ingestion: true, generation: true,
    masterInbox: prior.master_inbox_enabled, curated: prior.curated_enabled,
  }, sql);
  const repository = createRepository({ sql });
  try {
    const interested = await preparingPair();
    await sql`
      insert into submissions_v2.role_index(
        role_id, company_name, role_title, search_key, active, destination_url,
        last_confirmed_at, source_digest
      ) values (
        ${interested.role}, 'Acme', 'Engineer', 'acme engineer', false,
        ${`https://www.paraform.com/browse?role=${interested.role}`},
        clock_timestamp() - interval '1 day', ${digest(`inactive:${interested.role}`)}
      )
    `;
    const reviewed = await sql.begin(async (tx) => {
      const updated = (await tx`
        update submissions_v2.candidate_role_pairs
           set workflow_state='needs_review', role_state='unavailable', state_version=state_version+1
         where id=${interested.id} returning *
      `)[0];
      await tx`
        insert into submissions_v2.review_items(pair_id, reason_code, safe_detail)
        values (${interested.id}, 'role_unavailable', 'The exact role is unavailable.')
      `;
      return updated;
    });
    const jobId = randomUUID();
    await sql`
      insert into submissions_v2.jobs(
        id, kind, subject_type, subject_id, idempotency_key, required_control, control_epoch,
        state, lease_owner, lease_expires_at, fencing_token, attempt_count, started_at
      ) values (
        ${jobId}, 'recheck_pair', 'pair', ${interested.id}::text, ${`role-recheck:${jobId}`},
        'ingestion', ${enabled.control_epoch}, 'running', 'role-worker',
        clock_timestamp() + interval '2 minutes', 1, 1, clock_timestamp()
      )
    `;
    const liveRole = {
      role_id: interested.role, company_name: "Acme", role_title: "Engineer",
      search_key: "acme engineer", paraform_url: `https://www.paraform.com/browse?role=${interested.role}`,
      owner_email: null, provider_updated_at: null, source_digest: digest(`active:${interested.role}`),
    };
    const fence = {
      jobId, workerId: "role-worker", fencingToken: 1, controlEpoch: Number(enabled.control_epoch),
    };
    const active = await repository.applyRoleRecheck({
      pairId: interested.id, expectedPairVersion: Number(reviewed.state_version),
      role: liveRole, confirmedAt: new Date().toISOString(), executionFence: fence,
    });
    assert.equal(active.role_active, true);
    assert.equal(active.state, "preparing_resume");
    assert.ok(active.prepare_job_id);
    assert.deepEqual((await sql`
      select workflow_state, role_state, state_version from submissions_v2.candidate_role_pairs where id=${interested.id}
    `)[0], { workflow_state: "preparing_resume", role_state: "active", state_version: "3" });
    assert.equal((await sql`
      select count(*)::integer as count from submissions_v2.review_items
       where pair_id=${interested.id} and action_state='open'
    `)[0].count, 0);
    assert.deepEqual(await repository.applyRoleRecheck({
      pairId: interested.id, expectedPairVersion: Number(reviewed.state_version),
      role: liveRole, confirmedAt: new Date().toISOString(), executionFence: fence,
    }), { ...active, replay: true });

    const unclearSignal = await sourceEvent();
    const unclearPairId = randomUUID();
    const unclearRoleId = `role-${randomUUID()}`;
    await sql.begin(async (tx) => {
      await tx`
        insert into submissions_v2.role_index(
          role_id, company_name, role_title, search_key, active, destination_url,
          last_confirmed_at, source_digest
        ) values (
          ${unclearRoleId}, 'Beta', 'Designer', 'beta designer', false,
          ${`https://www.paraform.com/browse?role=${unclearRoleId}`}, clock_timestamp(),
          ${digest(`inactive:${unclearRoleId}`)}
        )
      `;
      await tx`
        insert into submissions_v2.candidate_role_pairs(
          id, candidate_user_id, role_id, first_signal_id, intent_state, workflow_state,
          original_signal_at, role_state
        ) values (
          ${unclearPairId}, ${`candidate-${randomUUID()}`}, ${unclearRoleId}, ${unclearSignal},
          'unclear', 'needs_review', clock_timestamp(), 'unavailable'
        )
      `;
      await tx`
        insert into submissions_v2.review_items(pair_id, reason_code, safe_detail)
        values (${unclearPairId}, 'role_unavailable', 'The exact role is unavailable.')
      `;
    });
    const unclearJobId = randomUUID();
    await sql`
      insert into submissions_v2.jobs(
        id, kind, subject_type, subject_id, idempotency_key, required_control, control_epoch,
        state, lease_owner, lease_expires_at, fencing_token, attempt_count, started_at
      ) values (
        ${unclearJobId}, 'recheck_pair', 'pair', ${unclearPairId}::text, ${`role-recheck:${unclearJobId}`},
        'ingestion', ${enabled.control_epoch}, 'running', 'role-worker-unclear',
        clock_timestamp() + interval '2 minutes', 1, 1, clock_timestamp()
      )
    `;
    const unclear = await repository.applyRoleRecheck({
      pairId: unclearPairId, expectedPairVersion: 1,
      role: {
        role_id: unclearRoleId, company_name: "Beta", role_title: "Designer",
        search_key: "beta designer", paraform_url: `https://www.paraform.com/browse?role=${unclearRoleId}`,
        owner_email: null, provider_updated_at: null, source_digest: digest(`active:${unclearRoleId}`),
      },
      confirmedAt: new Date().toISOString(),
      executionFence: { jobId: unclearJobId, workerId: "role-worker-unclear", fencingToken: 1, controlEpoch: Number(enabled.control_epoch) },
    });
    assert.equal(unclear.state, "needs_review");
    assert.equal(unclear.prepare_job_id, null);
    assert.deepEqual([...(await sql`
      select reason_code from submissions_v2.review_items where pair_id=${unclearPairId} and action_state='open'
    `)], [{ reason_code: "reply_unclear_or_conditional" }]);
    assert.deepEqual((await sql`
      select intent_state, workflow_state, role_state from submissions_v2.candidate_role_pairs where id=${unclearPairId}
    `)[0], { intent_state: "unclear", workflow_state: "needs_review", role_state: "active" });
  } finally {
    await setRuntimeControls({
      actorEmail: "admin@raydar.xyz", reason: "Restore controls after exact role-recheck regression",
      ui: prior.ui_enabled, ingestion: prior.ingestion_enabled, generation: prior.generation_enabled,
      masterInbox: prior.master_inbox_enabled, curated: prior.curated_enabled,
    }, sql);
  }
});

test("explicit role catalog preserves inactive ambiguity and requires only worker read access", async () => {
  const marker = `named-catalog-${randomUUID()}`;
  const rollback = new Error("rollback explicit catalog fixtures");
  await assert.rejects(sql.begin(async (tx) => {
    await tx`
      insert into submissions_v2.role_index(
        role_id, company_name, role_title, search_key, active, destination_url,
        last_confirmed_at, source_digest
      ) values
        (${`${marker}-active`}, 'Example Inc', 'AI Engineer', 'example ai engineer', true,
         'https://www.paraform.com/browse?role=example-active', clock_timestamp(), ${digest("active")}),
        (${`${marker}-inactive`}, 'Example Inc', 'AI Engineer', 'example ai engineer', false,
         'https://www.paraform.com/browse?role=example-inactive', clock_timestamp(), ${digest("inactive")})
    `;
    await tx.unsafe("set local role submissions_v2_worker");
    const repository = createRepository({ sql: tx });
    const catalog = await repository.explicitRoleCatalog();
    assert.equal(catalog.status, "ready");
    assert.equal(catalog.complete, true);
    const matches = catalog.roles.filter((role) => role.role_id.startsWith(marker));
    assert.equal(matches.length, 2);
    assert.deepEqual(matches.map((role) => role.active), [true, false]);
    assert.ok(matches.every((role) => role.last_confirmed_at && role.source_digest));
    assert.match(catalog.digest, /^[a-f0-9]{64}$/);
    assert.equal((await repository.explicitRoleCatalog()).digest, catalog.digest);
    throw rollback;
  }), (error) => error === rollback);
});

test("explicit role catalog refuses partial uniqueness beyond its complete-read bound", async () => {
  const marker = `named-catalog-limit-${randomUUID()}`;
  const rollback = new Error("rollback oversized catalog fixtures");
  await assert.rejects(sql.begin(async (tx) => {
    await tx`
      insert into submissions_v2.role_index(
        role_id, company_name, role_title, search_key, active, destination_url,
        last_confirmed_at, source_digest
      ) select ${marker} || '-' || ordinal, 'Example Inc', 'AI Engineer',
               'example ai engineer', true,
               'https://www.paraform.com/browse?role=example-' || ordinal,
               clock_timestamp(), ${digest("bounded")}
          from generate_series(1, 5001) as ordinal
    `;
    const catalog = await createRepository({ sql: tx }).explicitRoleCatalog();
    assert.deepEqual(catalog, { status: "unavailable", complete: false, roles: [], digest: null });
    throw rollback;
  }), (error) => error === rollback);
});

// One control write for the whole omission group: every extra epoch bump adds
// contention on the single runtime-controls row that every other suite reads.
let omissionControls = null;
async function omissionFixture(label) {
  if (!omissionControls) {
    omissionControls = (async () => {
      const prior = await readRuntimeControls(sql);
      return setRuntimeControls({
        actorEmail: "admin@raydar.xyz", reason: "Enable omission pre-pass regressions",
        ui: prior.ui_enabled, ingestion: true, generation: true, masterInbox: true,
        curated: prior.curated_enabled,
      }, sql);
    })();
  }
  const enabled = await omissionControls;
  const candidateId = `omission-candidate-${randomUUID()}`;
  const roleIds = [`omission-role-a-${randomUUID()}`, `omission-role-b-${randomUUID()}`, `omission-role-c-${randomUUID()}`];
  const signalId = randomUUID();
  const eventId = `omission-event-${randomUUID()}`;
  await sql`
    insert into submissions_v2.candidate_index(
      candidate_user_id, display_name, normalized_name, search_key, active,
      paraform_profile_url, last_confirmed_at, source_digest
    ) values (
      ${candidateId}, 'Omission Candidate', 'omission candidate', 'omission candidate', true,
      ${`https://www.paraform.com/candidates?candidate=${candidateId}`}, clock_timestamp(), ${digest(candidateId)}
    )
  `;
  const envelope = {
    candidate_resolution: { candidate_user_id: candidateId },
    schema_version: "submissions.email_reply.v1",
    adapter_version: "gmail-role-interest-v2",
    provider: "gmail",
    provider_message_id: `message-${eventId}`,
    outbound_message_id: `outbound-${eventId}`,
    source_evidence: null,
  };
  await sql`
    insert into submissions_v2.source_events(
      id, source_family, source_version, event_id, provider, mailbox_id, provider_message_id,
      direction, received_at, content_digest, processing_state, idempotency_key, envelope
    ) values (
      ${signalId}, 'email', 'submissions.email_reply.v1', ${eventId}, 'gmail', 'mailbox-test',
      ${`message-${eventId}`}, 'inbound', clock_timestamp(), ${digest(signalId)}, 'ready',
      ${`source:${signalId}`}, ${sql.json(envelope)}
    )
  `;
  for (const [index, roleId] of roleIds.entries()) {
    await sql`
      insert into submissions_v2.role_index(
        role_id, company_name, role_title, search_key, active, destination_url, last_confirmed_at, source_digest
      ) values (
        ${roleId}, 'Omission Company', ${`Omission Role ${index}`}, ${`omission company omission role ${index}`}, true,
        ${`https://www.paraform.com/browse?role=${roleId}`}, clock_timestamp(), ${digest(roleId)}
      )
    `;
    await sql`
      insert into submissions_v2.source_offered_roles(
        signal_id, role_id, company_snapshot, role_label_snapshot, role_url_snapshot, offered_order, content_digest
      ) values (
        ${signalId}, ${roleId}, 'Omission Company', ${`Omission Role ${index}`},
        ${`https://www.paraform.com/browse?role=${roleId}`}, ${index}, ${digest(`${signalId}:${roleId}`)}
      )
    `;
    await sql`
      insert into submissions_v2.first_response_claims(
        candidate_user_id, role_id, event_id, source_family, signal_id, committed_at
      ) values (${candidateId}, ${roleId}, ${eventId}, 'email', ${signalId}, clock_timestamp())
    `;
  }
  const jobId = randomUUID();
  await sql`
    insert into submissions_v2.jobs(id, kind, subject_type, subject_id, idempotency_key, required_control, control_epoch)
    values (${jobId}, 'classify_email_reply', 'signal', ${signalId}, ${`job:${jobId}`}, 'master_inbox', ${enabled.control_epoch})
  `;
  const claimed = (await claimJobs({
    workerId: `omission-worker-${label}`, kinds: ["classify_email_reply"], limit: 1,
    leaseSeconds: 120, controlEpoch: enabled.control_epoch,
  }, sql)).find((row) => row.id === jobId);
  assert.ok(claimed, "the omission fixture must own its own classification job");
  return {
    candidateId, roleIds, signalId, envelope,
    event: { ...envelope, candidate_authored_text: "Please put me forward for the first one.", offered_roles: roleIds.map((role_id) => ({ role_id })) },
    executionFence: {
      jobId: claimed.id, workerId: claimed.lease_owner,
      fencingToken: Number(claimed.fencing_token), controlEpoch: Number(enabled.control_epoch),
    },
  };
}

test("with the omission pre-pass off an unnamed offered role stays open for a later reply", async () => {
  const fixture = await omissionFixture("off");
  const decisions = [{ role_id: fixture.roleIds[0], label: "interested", quote: "Please put me forward for the first one.", review_reason: null, negative_reason: null }];
  const omissions = omissionDecisions({ event: fixture.event, decisions, env: {} });
  assert.deepEqual(omissions, { mode: "off", skipped: "prepass_off", decisions: [] });
  const applied = await createRepository({ sql, env: { SUBMISSIONS_V2_SLACK_CHANNEL_ID: "C123TEST" } }).applyClassifiedSignal({
    signalId: fixture.signalId, candidateId: fixture.candidateId,
    decisions, omissions: omissions.decisions,
    attempts: [{ outcome: "accepted", model: "test-model" }],
    executionFence: fixture.executionFence,
  });
  assert.equal(applied.created_count, 1);
  const pairs = await sql`
    select role_id, workflow_state from submissions_v2.candidate_role_pairs
     where candidate_user_id=${fixture.candidateId} order by role_id
  `;
  assert.deepEqual([...pairs].map((row) => row.workflow_state), ["preparing_resume"]);
  const claims = await sql`
    select role_id, release_reason from submissions_v2.first_response_claims
     where signal_id=${fixture.signalId} and released_at is not null
  `;
  assert.deepEqual([...claims].map((row) => row.release_reason).sort(), ["unmentioned_role", "unmentioned_role"]);
});

test("with the omission pre-pass on every unnamed offered role closes on quote-free evidence", async () => {
  const fixture = await omissionFixture("apply");
  const decisions = [{ role_id: fixture.roleIds[0], label: "interested", quote: "Please put me forward for the first one.", review_reason: null, negative_reason: null }];
  const omissions = omissionDecisions({ event: fixture.event, decisions, env: { SUBMISSIONS_V2_OMISSION_PREPASS: "apply" } });
  assert.equal(omissions.skipped, null);
  const applied = await createRepository({ sql, env: { SUBMISSIONS_V2_SLACK_CHANNEL_ID: "C123TEST" } }).applyClassifiedSignal({
    signalId: fixture.signalId, candidateId: fixture.candidateId,
    decisions, omissions: omissions.decisions,
    attempts: [{ outcome: "accepted", model: "test-model" }],
    executionFence: fixture.executionFence,
  });
  assert.equal(applied.created_count, 3);

  const pairs = await sql`
    select id, role_id, intent_state, workflow_state from submissions_v2.candidate_role_pairs
     where candidate_user_id=${fixture.candidateId}
  `;
  const byRole = new Map([...pairs].map((row) => [row.role_id, row]));
  assert.deepEqual(byRole.get(fixture.roleIds[0]).workflow_state, "preparing_resume");
  for (const roleId of fixture.roleIds.slice(1)) {
    assert.deepEqual(
      { intent: byRole.get(roleId).intent_state, workflow: byRole.get(roleId).workflow_state },
      { intent: "not_interested", workflow: "not_interested" },
    );
  }

  const recorded = await sql`
    select role_id, decision_label, exact_quote, evidence_kind, validation
      from submissions_v2.signal_role_decisions where signal_id=${fixture.signalId}
  `;
  const omitted = [...recorded].filter((row) => row.evidence_kind === "omission_prepass_v1");
  assert.equal(omitted.length, 2);
  for (const row of omitted) {
    assert.equal(row.decision_label, "not_interested");
    assert.equal(row.exact_quote, null);
    assert.equal(row.validation.quote_validated, false);
    assert.equal(row.validation.omission_evidence.kind, "omission_prepass_v1");
    assert.deepEqual(row.validation.omission_evidence.named_role_ids, [fixture.roleIds[0]]);
    assert.match(row.validation.omission_evidence.offered_role_set_digest, /^[a-f0-9]{64}$/u);
  }
  assert.equal([...recorded].find((row) => row.role_id === fixture.roleIds[0]).evidence_kind, null);

  const entries = await sql`
    select p.role_id, ni.grounded_reason, ni.exact_quote
      from submissions_v2.not_interested_entries ni
      join submissions_v2.candidate_role_pairs p on p.id=ni.pair_id
     where ni.source_event_id=${fixture.signalId}
  `;
  assert.equal(entries.length, 2);
  for (const row of entries) {
    assert.equal(row.exact_quote, null);
    assert.equal(row.grounded_reason, "Not named in a reply that accepted other roles offered in the same message.");
  }

  // One reply is one Slack post; a role the candidate never mentioned is
  // recorded on the page but never announced.
  const notifications = await sql`
    select p.role_id from submissions_v2.notification_outbox n
      join submissions_v2.candidate_role_pairs p on p.id=n.pair_id
     where n.kind='not_interested' and p.candidate_user_id=${fixture.candidateId}
  `;
  assert.deepEqual([...notifications], []);
  const openClaims = await sql`
    select count(*)::integer as count from submissions_v2.first_response_claims
     where signal_id=${fixture.signalId} and released_at is not null
  `;
  assert.equal(openClaims[0].count, 0);
});

test("an unrecognised classifier review reason is surfaced instead of silently rewritten", async () => {
  const fixture = await omissionFixture("unknown-reason");
  const applied = await createRepository({ sql, env: { SUBMISSIONS_V2_SLACK_CHANNEL_ID: "C123TEST" } }).applyClassifiedSignal({
    signalId: fixture.signalId, candidateId: fixture.candidateId,
    decisions: [
      { role_id: fixture.roleIds[0], label: "needs_review", quote: "Please put me forward", review_reason: "role_mapping_conflict", negative_reason: null },
      { role_id: fixture.roleIds[1], label: "needs_review", quote: "Please put me forward", review_reason: "candidate_question", negative_reason: null },
      { role_id: fixture.roleIds[2], label: "needs_review", quote: "Please put me forward", review_reason: "drop table review_items;", negative_reason: null },
    ],
    attempts: [{ outcome: "accepted", model: "test-model" }],
    executionFence: fixture.executionFence,
  });
  assert.equal(applied.created_count, 3);
  const reviews = await sql`
    select p.role_id, r.reason_code, r.safe_detail, r.evidence
      from submissions_v2.review_items r
      join submissions_v2.candidate_role_pairs p on p.id=r.pair_id
     where p.candidate_user_id=${fixture.candidateId}
  `;
  const byRole = new Map([...reviews].map((row) => [row.role_id, row]));
  const unknown = byRole.get(fixture.roleIds[0]);
  assert.equal(unknown.reason_code, "reply_unclear_or_conditional");
  assert.equal(unknown.safe_detail, "The classifier returned an unrecognised review reason: role_mapping_conflict.");
  assert.equal(unknown.evidence.unrecognised_review_reason, "role_mapping_conflict");

  const known = byRole.get(fixture.roleIds[1]);
  assert.equal(known.reason_code, "candidate_question");
  assert.equal(known.safe_detail, null);
  assert.equal(known.evidence.unrecognised_review_reason, undefined);

  // A reason that is not a code is sanitised before it is ever stored or shown.
  const hostile = byRole.get(fixture.roleIds[2]);
  assert.equal(hostile.reason_code, "reply_unclear_or_conditional");
  assert.equal(hostile.safe_detail, "The classifier returned an unrecognised review reason: droptablereview_items.");
});

test("a human submission mark opens Paraform proof reconciliation and stays reversible until proof lands", async () => {
  const repository = createRepository({ sql });
  const priorControls = await readRuntimeControls(sql);
  const enabled = await setRuntimeControls({
    actorEmail: "test@raydar.xyz", reason: "Enable UI and ingestion for the manual submission mark regression",
    ui: true, ingestion: true, generation: priorControls.generation_enabled,
    masterInbox: priorControls.master_inbox_enabled, curated: priorControls.curated_enabled,
  }, sql);
  const readyPair = async () => {
    const pair = await preparingPair();
    const generationId = randomUUID();
    await sql`
      insert into submissions_v2.resume_generations(
        id, pair_id, generation_version, trigger_kind, idempotency_key, status, stage,
        expected_pair_version, first_signal_id, primary_model_pin, fallback_model_pin,
        validator_model_pin, prompt_pin, template_pin, deadline_at, completed_at
      ) values (
        ${generationId}, ${pair.id}, 1, 'initial', ${`mark-generation:${generationId}`}, 'succeeded', 'complete',
        1, ${pair.signal}, 'primary-test', 'fallback-test', 'validator-test',
        'prompt-test', 'template-test', clock_timestamp(), clock_timestamp()
      )
    `;
    let pdfId;
    for (const kind of ["pdf", "ats", "manifest"]) {
      const artifactId = randomUUID();
      if (kind === "pdf") pdfId = artifactId;
      await sql`
        insert into submissions_v2.resume_artifacts(
          id, pair_id, generation_id, artifact_version, kind, private_object_key, digest,
          size_bytes, page_count, text_digest, validation_status, archive_readback_at, archived_at, current_state
        ) values (
          ${artifactId}, ${pair.id}, ${generationId}, 1, ${kind},
          ${`submissions/resumes/v2/${pair.id}/${kind}`}, ${digest(`${pair.id}:${kind}`)}, 500,
          ${kind === "pdf" ? 1 : null}, ${digest(`${pair.id}:${kind}-text`)}, 'passed',
          clock_timestamp(), clock_timestamp(), 'current'
        )
      `;
    }
    await sql`
      update submissions_v2.candidate_role_pairs
         set workflow_state='interested', current_artifact_id=${pdfId},
             resume_ready_at=clock_timestamp(), state_version=state_version+1
       where id=${pair.id}
    `;
    return { ...pair, artifactId: pdfId, version: 2 };
  };
  const pairRow = async (pairId) => (await sql`
    select submission_status, submission_opened_at, state_version
      from submissions_v2.candidate_role_pairs where id=${pairId}
  `)[0];
  const markEvents = async (pairId) => sql`
    select event_type, actor_id, source, expected_version, new_version, metadata
      from submissions_v2.pair_events
     where pair_id=${pairId} and event_type in ('submission_marked','submission_unmarked')
     order by created_at, id
  `;
  try {
    const pair = await readyPair();
    const marked = await repository.markSubmitted({
      actorEmail: "david@raydar.xyz", idempotencyKey: `mark:${pair.id}`, pairId: pair.id, expectedVersion: pair.version,
    });
    assert.equal(marked.case_id, pair.id);
    assert.equal(marked.state_version, 3);
    assert.equal(marked.submission_status, "opened");
    assert.equal(marked.manual_mark.marked_by, "david@raydar.xyz");
    assert.match(marked.manual_mark.marked_at, /^\d{4}-\d{2}-\d{2}T/u);
    const openedRow = await pairRow(pair.id);
    assert.equal(openedRow.submission_status, "opened");
    assert.ok(openedRow.submission_opened_at, "the mark opens the Paraform submission window");
    assert.equal(Number(openedRow.state_version), 3);
    const firstEvents = await markEvents(pair.id);
    assert.equal(firstEvents.length, 1);
    assert.deepEqual(
      { ...firstEvents[0], metadata: firstEvents[0].metadata.opened_by_mark },
      {
        event_type: "submission_marked", actor_id: "david@raydar.xyz", source: "mark_submitted",
        expected_version: "2", new_version: "3", metadata: true,
      },
    );
    assert.equal(firstEvents[0].metadata.role_id, pair.role);
    const proofJobs = await sql`
      select checkpoint, required_control, priority from submissions_v2.jobs
       where kind='proof_reconcile' and subject_type='pair' and subject_id=${pair.id}::text
       order by scheduled_at
    `;
    assert.deepEqual(proofJobs.map((job) => Number(job.checkpoint.delay_minutes)), [5, 30, 120]);
    assert.deepEqual([...new Set(proofJobs.map((job) => job.checkpoint.trigger))], ["manual_mark"]);
    assert.deepEqual([...new Set(proofJobs.map((job) => job.required_control))], ["ingestion"]);

    const detail = await repository.pair(pair.id);
    assert.equal(detail.submission_marked_by, "david@raydar.xyz");
    assert.equal(new Date(detail.submission_marked_at).toISOString(), marked.manual_mark.marked_at);
    const listed = (await repository.list({ page: "interested" })).rows.find((row) => row.pair_id === pair.id);
    assert.equal(listed.submission_marked_by, "david@raydar.xyz");
    assert.equal(new Date(listed.submission_marked_at).toISOString(), marked.manual_mark.marked_at);

    const replay = await repository.markSubmitted({
      actorEmail: "david@raydar.xyz", idempotencyKey: `mark:${pair.id}`, pairId: pair.id, expectedVersion: pair.version,
    });
    assert.equal(replay.replay, true);
    assert.equal(replay.state_version, 3);
    assert.equal((await markEvents(pair.id)).length, 1);

    await assert.rejects(() => repository.markSubmitted({
      actorEmail: "david@raydar.xyz", idempotencyKey: `mark-stale:${pair.id}`, pairId: pair.id, expectedVersion: pair.version,
    }), (error) => error.code === "stale_pair_version" && error.status === 409 && Number(error.current.state_version) === 3);

    const again = await repository.markSubmitted({
      actorEmail: "david@raydar.xyz", idempotencyKey: `mark-again:${pair.id}`, pairId: pair.id, expectedVersion: 3,
    });
    assert.equal(again.already_marked, true);
    assert.equal(again.state_version, 3);
    assert.equal(again.manual_mark.marked_by, "david@raydar.xyz");
    assert.equal((await markEvents(pair.id)).length, 1);

    const unmarked = await repository.unmarkSubmitted({
      actorEmail: "david@raydar.xyz", idempotencyKey: `unmark:${pair.id}`, pairId: pair.id, expectedVersion: 3,
    });
    assert.equal(unmarked.state_version, 4);
    assert.equal(unmarked.manual_mark, null);
    assert.equal(unmarked.submission_status, "opened", "undoing the mark never rewinds the Paraform submission window");
    const clearedDetail = await repository.pair(pair.id);
    assert.equal(clearedDetail.submission_marked_at, null);
    assert.equal(clearedDetail.submission_marked_by, null);
    assert.deepEqual((await markEvents(pair.id)).map((event) => event.event_type), ["submission_marked", "submission_unmarked"]);

    await assert.rejects(() => repository.unmarkSubmitted({
      actorEmail: "david@raydar.xyz", idempotencyKey: `unmark-twice:${pair.id}`, pairId: pair.id, expectedVersion: 4,
    }), (error) => error.code === "pair_not_marked" && error.status === 409);

    const remarked = await repository.markSubmitted({
      actorEmail: "david@raydar.xyz", idempotencyKey: `mark-second:${pair.id}`, pairId: pair.id, expectedVersion: 4,
    });
    assert.equal(remarked.state_version, 5);
    const remarkedRow = await pairRow(pair.id);
    assert.equal(remarkedRow.submission_status, "opened");
    assert.equal(remarkedRow.submission_opened_at.getTime(), openedRow.submission_opened_at.getTime(),
      "an already-opened pair keeps its first submission window");
    assert.equal((await markEvents(pair.id)).at(-1).metadata.opened_by_mark, false);

    const proofJobId = randomUUID();
    await sql`
      insert into submissions_v2.jobs(
        id, kind, subject_type, subject_id, idempotency_key, required_control, control_epoch,
        state, lease_owner, lease_expires_at, fencing_token, attempt_count, started_at
      ) values (
        ${proofJobId}, 'proof_reconcile', 'source', 'submission_proof', ${`mark-proof:${proofJobId}`}, 'ingestion',
        ${enabled.control_epoch}, 'running', 'mark-proof-worker', clock_timestamp() + interval '2 minutes', 1, 1, clock_timestamp()
      )
    `;
    const proven = await repository.applySubmissionProof({
      pairId: pair.id, applicationId: `mark-application-${pair.id}`,
      authoritativePath: "application.getRecruiterApplicationData", evidenceDigest: digest(`mark-proof:${pair.id}`),
      observedAt: new Date().toISOString(), checkedAt: new Date().toISOString(),
      executionFence: { jobId: proofJobId, workerId: "mark-proof-worker", fencingToken: 1, controlEpoch: Number(enabled.control_epoch) },
    });
    assert.equal(proven.submission_status, "proven");
    assert.equal(Number(proven.state_version), 6);
    for (const method of ["markSubmitted", "unmarkSubmitted"]) {
      await assert.rejects(() => repository[method]({
        actorEmail: "david@raydar.xyz", idempotencyKey: `${method}-proven:${pair.id}`, pairId: pair.id, expectedVersion: 6,
      }), (error) => error.code === "proven_pair_immutable" && error.status === 409);
    }

    const reviewPair = await preparingPair();
    await sql.begin(async (tx) => {
      await tx`
        update submissions_v2.candidate_role_pairs
           set workflow_state='needs_review', state_version=state_version+1 where id=${reviewPair.id}
      `;
      await tx`insert into submissions_v2.review_items(pair_id, reason_code) values (${reviewPair.id}, 'candidate_question')`;
    });
    await assert.rejects(() => repository.markSubmitted({
      actorEmail: "david@raydar.xyz", idempotencyKey: `mark-review:${reviewPair.id}`, pairId: reviewPair.id, expectedVersion: 2,
    }), (error) => error.code === "pair_not_submit_ready" && error.status === 409);
    assert.equal((await markEvents(reviewPair.id)).length, 0);
  } finally {
    await setRuntimeControls({
      actorEmail: "test@raydar.xyz", reason: "Restore controls after the manual submission mark regression",
      ui: priorControls.ui_enabled, ingestion: priorControls.ingestion_enabled, generation: priorControls.generation_enabled,
      masterInbox: priorControls.master_inbox_enabled, curated: priorControls.curated_enabled,
    }, sql);
  }
});
