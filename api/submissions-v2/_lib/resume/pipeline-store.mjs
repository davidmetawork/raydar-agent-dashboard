import { database } from "../db.mjs";
import { assertGenerationFence, assertWorkerFence, createRepository } from "../repository.mjs";
import { decryptJson, encryptJson } from "../private-data.mjs";
import { privatePath, privateReservationId, putPrivateObject, readPrivateObject } from "../blob.mjs";
import { canonicalJson, sha256 } from "./source-bundle.mjs";
import { ResumePipelineError, checkpointDigest } from "./pipeline-runtime.mjs";

const clean = (value, limit = 500) => String(value ?? "").replace(/[\r\n]+/gu, " ").trim().slice(0, limit);
const UUID_OID = 2950;

function safeCheckpointId(generationId, stage) {
  return `${String(generationId).replace(/[^a-z0-9_-]/giu, "-")}-${String(stage).replace(/[^a-z0-9_-]/giu, "-")}`;
}

function envelopeFromBytes(value) {
  try { return JSON.parse(Buffer.from(value).toString("utf8")); }
  catch {
    throw new ResumePipelineError("supplement_envelope_invalid", "A private resume supplement could not be decoded.");
  }
}

async function readEncryptedText(row, { env, blobs, pairId }) {
  if (row.text_value_encrypted) {
    const envelope = envelopeFromBytes(row.text_value_encrypted);
    const value = decryptJson(envelope, { env, context: `supplement:${pairId}:${row.supplement_kind === "generation_instruction" ? "instruction" : "evidence"}` });
    return clean(value?.text, 250_000);
  }
  if (row.scan_state !== "clean" || row.parse_state !== "parsed" || !row.extracted_text_object_key) {
    throw new ResumePipelineError("supplement_not_ready", "An uploaded resume supplement has not completed safe scanning and parsing.", { retryable: row.scan_state === "pending" || row.parse_state === "pending" });
  }
  const object = await blobs.readPrivateObject(row.extracted_text_object_key, { env });
  return Buffer.from(object.bytes).toString("utf8").trim().slice(0, 250_000);
}

function sourceRows(bundle) {
  return bundle.sources.map((source) => ({
    source_key: source.key,
    status: source.status,
    requiredness: source.requiredness,
    origin: source.origin,
    source_id: source.sourceId,
    source_locator: source.locator,
    captured_at: source.capturedAt,
    source_updated_at: source.sourceUpdatedAt,
    content_digest: source.contentSha256,
    normalized_text_digest: source.normalizedTextSha256,
    item_count: Object.values(source.counts || {}).reduce((sum, value) => sum + (Number(value) || 0), 0) || null,
    accuracy_impact: source.accuracyImpact,
    remediation: source.remediation,
  }));
}

export function createResumePipelineStore({
  sql = database(),
  repository = createRepository({ sql }),
  blobs = { putPrivateObject, readPrivateObject },
  env = process.env,
} = {}) {
  return {
    repository,
    sql,

    async loadPairContext(pairId, checkpoint = {}) {
      const pair = await repository.pair(pairId);
      if (!pair) throw new ResumePipelineError("pair_not_found", "The candidate-role item is no longer available.");
      const requestedIds = Array.isArray(checkpoint.supplement_ids)
        ? [...new Set(checkpoint.supplement_ids.map(String))]
        : [];
      const rows = await sql`
        select * from submissions_v2.resume_supplements
         where pair_id=${pairId} and active and not quarantined
           and supplement_kind='evidence'
           and (generation_id is null)
           and (
             text_value_encrypted is not null
             or (scan_state='clean' and parse_state='parsed' and extracted_text_object_key is not null)
             or id=any(${sql.array(requestedIds, UUID_OID)})
           )
         order by created_at, id
      `;
      const supplements = [];
      const pendingSupplements = [];
      for (const row of rows) {
        if (!row.text_value_encrypted
          && (row.scan_state !== "clean" || row.parse_state !== "parsed" || !row.extracted_text_object_key)) {
          pendingSupplements.push(row);
          continue;
        }
        const normalizedText = await readEncryptedText(row, { env, blobs, pairId });
        if (normalizedText) supplements.push({
          id: row.id,
          normalizedText,
          evidenceBasis: row.evidence_basis,
          sourceNote: row.source_or_correction_note,
          digest: row.digest,
        });
      }
      let versionInstructions = "";
      if (checkpoint.instruction_encrypted) {
        const encoded = Buffer.from(String(checkpoint.instruction_encrypted), "base64");
        const envelope = envelopeFromBytes(encoded);
        versionInstructions = clean(decryptJson(envelope, { env, context: `supplement:${pairId}:instruction` })?.text, 8_000);
      }
      const digests = await sql`
        select digest, text_digest from submissions_v2.resume_artifacts where pair_id=${pairId}
      `;
      const configured = String(env.SUBMISSIONS_V2_KNOWN_RAYDAR_RESUME_DIGESTS || "").split(",");
      const knownRaydarDigests = [...new Set([
        ...configured,
        ...digests.flatMap((row) => [row.digest, row.text_digest]),
      ].map((value) => String(value || "").trim().toLowerCase()).filter((value) => /^[a-f0-9]{64}$/u.test(value)))];
      return { pair, supplements, pendingSupplements, versionInstructions, knownRaydarDigests };
    },

    async loadRetryPipeline({ pairId, excludingJobId }) {
      const rows = await sql`
        select checkpoint->'pipeline' as pipeline
          from submissions_v2.jobs
         where kind='prepare_resume'
           and subject_type='pair'
           and subject_id=${pairId}
           and id<>${excludingJobId}::uuid
           and jsonb_typeof(checkpoint->'pipeline'->'stages')='object'
           and jsonb_object_length(checkpoint->'pipeline'->'stages')>0
         order by updated_at desc
         limit 1
      `;
      const pipeline = rows[0]?.pipeline;
      return pipeline && typeof pipeline === "object" ? pipeline : null;
    },

    async saveCheckpoint({ generationId, stage, value, executionFence }) {
      const context = `resume-checkpoint:${generationId}:${stage}`;
      const pathname = privatePath("checkpoints", safeCheckpointId(generationId, stage));
      const readExisting = async () => {
        try {
          const object = await blobs.readPrivateObject(pathname, { env });
          const storedValue = decryptJson(envelopeFromBytes(object.bytes), { env, context });
          return { bytes: Buffer.from(object.bytes), value: storedValue, digest: sha256(object.bytes) };
        } catch (error) {
          if (error?.status === 404 || error?.statusCode === 404 || ["artifact_not_found", "blob_not_found", "not_found", "store_not_found"].includes(error?.code)) return null;
          throw error;
        }
      };
      let existing = await readExisting();
      let storedValue = existing?.value ?? value;
      let bytes = existing?.bytes ?? Buffer.from(canonicalJson(encryptJson(value, { env, context, deterministic: true })));
      let objectDigest = existing?.digest ?? sha256(bytes);
      let reservation;
      try {
        reservation = await repository.reservePrivateObject({
          reservationId: privateReservationId(pathname), objectKey: pathname, purpose: "resume_checkpoint",
          ownerRef: generationId, expectedDigest: objectDigest, expiresAt: Date.now() + 24 * 60 * 60_000,
          generationId, executionFence,
        });
      } catch (error) {
        if (error?.code !== "private_object_reservation_conflict") throw error;
        existing = await readExisting();
        if (!existing) throw error;
        storedValue = existing.value;
        bytes = existing.bytes;
        objectDigest = existing.digest;
        reservation = await repository.reservePrivateObject({
          reservationId: privateReservationId(pathname), objectKey: pathname, purpose: "resume_checkpoint",
          ownerRef: generationId, expectedDigest: objectDigest, expiresAt: Date.now() + 24 * 60 * 60_000,
          generationId, executionFence,
        });
      }
      if (reservation.state === "committed") {
        const readback = existing || await readExisting();
        if (!readback || readback.digest !== objectDigest) {
          throw new ResumePipelineError("resume_checkpoint_readback_mismatch", "A committed resume checkpoint failed integrity verification.");
        }
        return { key: pathname, digest: checkpointDigest(storedValue), context, value: storedValue, reservation_id: reservation.id, object_digest: objectDigest, write_fencing_token: Number(reservation.write_fencing_token) };
      }
      await repository.renewPrivateObjectWrite({ reservationId: reservation.id, objectKey: pathname, expectedDigest: objectDigest, writeFencingToken: reservation.write_fencing_token, generationId, executionFence });
      if (!existing) await blobs.putPrivateObject(pathname, bytes, "application/json", { env });
      const readback = await blobs.readPrivateObject(pathname, { env });
      if (sha256(readback.bytes) !== objectDigest) {
        throw new ResumePipelineError("resume_checkpoint_readback_mismatch", "A resume stage checkpoint failed integrity verification.");
      }
      return { key: pathname, digest: checkpointDigest(storedValue), context, value: storedValue, reservation_id: reservation.id, object_digest: objectDigest, write_fencing_token: Number(reservation.write_fencing_token) };
    },

    async loadCheckpoint(reference) {
      if (!reference?.key || !reference?.context || !reference?.digest) return null;
      const object = await blobs.readPrivateObject(reference.key, { env });
      const envelope = envelopeFromBytes(object.bytes);
      const value = decryptJson(envelope, { env, context: reference.context });
      if (checkpointDigest(value) !== reference.digest) {
        throw new ResumePipelineError("resume_checkpoint_digest_mismatch", "A resume stage checkpoint failed integrity verification.");
      }
      return value;
    },

    async startGeneration(input) { return repository.startResumeGeneration(input); },
    async updateGeneration(input) { return repository.updateResumeGeneration(input); },
    async persistSources(generationId, bundle, executionFence) { return repository.persistResumeSources(generationId, sourceRows(bundle), executionFence); },
    async updateSupplementProcessing(input) { return repository.updateSupplementProcessing(input); },
    async readPrivateObject(pathname) { return blobs.readPrivateObject(pathname, { env }); },
    async putPrivateObject(pathname, bytes, contentType) { return blobs.putPrivateObject(pathname, bytes, contentType, { env }); },
    async reservePrivateObject(input) { return repository.reservePrivateObject(input); },
    async renewPrivateObjectWrite(input) { return repository.renewPrivateObjectWrite(input); },

    async setGenerationDigests({ generationId, sourceDigest, instructionDigest = null, executionFence }) {
      return sql.begin(async (tx) => {
        await assertGenerationFence(tx, executionFence, generationId);
        const rows = await tx`
          update submissions_v2.resume_generations
             set source_digest=${sourceDigest}, instruction_digest=${instructionDigest}
           where id=${generationId} returning *
        `;
        if (!rows.length) throw new ResumePipelineError("generation_not_found", "The resume generation record is unavailable.");
        return rows[0];
      });
    },

    async recordStage({ generationId, stage, attempt, inputDigest, outputKey = null, outputDigest = null, objectReservationId = null, objectWriteFencingToken = null, objectDigest = null, status, costCents = 0, errorCode = null, safeDetail = null, executionFence }) {
      return sql.begin(async (tx) => {
        await assertGenerationFence(tx, executionFence, generationId);
        const rows = await tx`
          insert into submissions_v2.resume_stage_runs(
          generation_id, stage, attempt, input_digest, output_object_key, output_digest,
          status, cost_cents, completed_at, safe_error_code, safe_error_detail
        ) values (
          ${generationId}, ${stage}, ${Math.max(1, Math.min(3, Number(attempt) || 1))}, ${inputDigest},
          ${outputKey}, ${outputDigest}, ${status}, ${Math.max(0, Math.min(200, Number(costCents) || 0))},
          ${status === "running" ? null : new Date().toISOString()}, ${errorCode}, ${safeDetail}
        ) on conflict (generation_id, stage, attempt) do update set
          output_object_key=excluded.output_object_key, output_digest=excluded.output_digest,
          status=excluded.status, cost_cents=excluded.cost_cents,
          completed_at=excluded.completed_at, safe_error_code=excluded.safe_error_code,
          safe_error_detail=excluded.safe_error_detail
        returning *
        `;
        if (objectReservationId) {
          const committed = await tx`
          update submissions_v2.private_object_reservations
             set state='committed', committed_at=coalesce(committed_at, clock_timestamp()),
                 write_owner=null, write_lease_expires_at=null
           where id=${objectReservationId} and object_key=${outputKey} and expected_digest=${objectDigest}
             and (state='committed' or (state='pending' and write_fencing_token=${Number(objectWriteFencingToken)}
               and write_lease_expires_at >= clock_timestamp())) returning id
          `;
          if (!committed.length) throw new ResumePipelineError("private_object_reservation_fence_lost", "A resume checkpoint lost its private-object reservation.");
        }
        return rows[0];
      });
    },

    async persistClaims({ generationId, sourceRecords, draftClaims, validation, executionFence }) {
      const sourceByKey = new Map(sourceRecords.map((row) => [row.source_key, row]));
      const retainedById = new Map(validation.claims.map((claim) => [claim.id, claim]));
      const removedById = new Map(validation.removed.map((claim) => [claim.id, claim]));
      const packetById = new Map(draftClaims.map((claim) => [claim.id, claim]));
      await sql.begin(async (tx) => {
        await assertGenerationFence(tx, executionFence, generationId);
        for (const packet of draftClaims) {
          const retained = retainedById.get(packet.id);
          const removed = removedById.get(packet.id);
          const claimRows = await tx`
            insert into submissions_v2.resume_claims(
              generation_id, claim_key, original_wording, final_wording, claim_kind, retained, final_status
            ) values (
              ${generationId}, ${packet.id}, ${packet.text}, ${retained?.text || null}, 'resume_text',
              ${Boolean(retained)}, ${retained ? "passed" : "removed"}
            ) on conflict (generation_id, claim_key) do update set
              final_wording=excluded.final_wording, retained=excluded.retained,
              final_status=excluded.final_status, updated_at=clock_timestamp()
            returning *
          `;
          const claim = claimRows[0];
          for (const evidence of packet.evidence || []) {
            const source = sourceByKey.get(evidence.sourceKey);
            if (!source) throw new ResumePipelineError("claim_source_record_missing", "A validated claim lost its source record.");
            await tx`
              insert into submissions_v2.claim_evidence_links(
                claim_id, resume_source_id, candidate_side, exact_locator, exact_excerpt, evidence_digest
              ) values (
                ${claim.id}, ${source.id}, true, ${evidence.locator}, ${evidence.exactQuote},
                ${sha256(`${evidence.evidenceId}:${evidence.exactQuote}`)}
              ) on conflict (claim_id, resume_source_id, exact_locator) do nothing
            `;
          }
          const verdicts = validation.history.flatMap((round) => (
            (round.validation?.results || []).filter((item) => item.claim_id === packet.id)
          )).slice(0, 3);
          for (const [index, verdict] of verdicts.entries()) {
            const result = verdict.verdict === "supported" ? "passed"
              : verdict.verdict === "supportable_after_narrowing" ? "narrowed"
                : "removed";
            await tx`
              insert into submissions_v2.claim_validations(
                claim_id, attempt, validator_model_pin, result, rewrite_text, reason,
                input_digest, output_digest
              ) values (
                ${claim.id}, ${index + 1}, 'gpt-5.4-2026-03-05', ${result}, ${verdict.rewrite},
                ${verdict.reason_code}, ${sha256(canonicalJson(packetById.get(packet.id)))},
                ${sha256(canonicalJson(verdict))}
              ) on conflict (claim_id, attempt) do nothing
            `;
          }
          if (!retained && !removed) {
            throw new ResumePipelineError("claim_validation_incomplete", "A resume claim has no terminal validation result.");
          }
        }
      });
    },

    async assertExecutionFence({ jobId, workerId, fencingToken, controlEpoch }) {
      const rows = await sql`
        select j.id from submissions_v2.jobs j
        cross join submissions_v2.lock_runtime_controls() c
         where j.id=${jobId} and j.state='running' and j.lease_owner=${workerId}
           and j.fencing_token=${Number(fencingToken)} and j.control_epoch=${Number(controlEpoch)}
           and j.lease_expires_at >= clock_timestamp() and c.control_epoch=${Number(controlEpoch)}
           and submissions_v2.job_control_enabled(j.required_control, c)
         for share of j
      `;
      if (!rows.length) throw new ResumePipelineError("execution_fence_lost", "Resume preparation stopped because its worker lease or runtime control changed.");
      return true;
    },

    async promoteArtifacts(input, execution) {
      await this.assertExecutionFence(execution);
      return repository.promoteResumeArtifacts({ ...input, execution });
    },

    async failInitialGeneration({ generationId, reasonCode, safeDetail, actorId = "submissions-v2-worker", executionFence }) {
      return sql.begin(async (tx) => {
        await assertWorkerFence(tx, executionFence, "generation");
        const generation = (await tx`select * from submissions_v2.resume_generations where id=${generationId} for update`)[0];
        if (!generation) throw new ResumePipelineError("generation_not_found", "The resume generation record is unavailable.");
        const pair = (await tx`select * from submissions_v2.candidate_role_pairs where id=${generation.pair_id} for update`)[0];
        if (!pair || Number(pair.state_version) !== Number(generation.expected_pair_version)) {
          throw new ResumePipelineError("stale_pair_version", "The candidate-role item changed before resume failure routing.");
        }
        await tx`
          update submissions_v2.resume_generations set status='failed', stage='failed',
                 safe_failure_code=${reasonCode}, safe_failure_detail=${clean(safeDetail)},
                 completed_at=clock_timestamp()
           where id=${generationId}
        `;
        const updated = (await tx`
          update submissions_v2.candidate_role_pairs
             set intent_state='interested', workflow_state='needs_review', state_version=state_version+1
           where id=${pair.id} and state_version=${pair.state_version} returning *
        `)[0];
        await tx`
          insert into submissions_v2.review_items(pair_id, reason_code, safe_detail, evidence)
          values (${pair.id}, ${reasonCode}, ${clean(safeDetail)}, ${tx.json({ generation_id: generationId })})
          on conflict do nothing
        `;
        if (reasonCode === "resume_preparation_failed") {
          await tx`
            insert into submissions_v2.notification_outbox(kind, destination_id, safe_payload, dedupe_key, pair_id)
            values ('resume_preparation_failed', ${process.env.SUBMISSIONS_V2_SLACK_CHANNEL_ID || "paraform-submission-notifications"},
                    ${tx.json({ monitor_url: "https://monitor.raydar.xyz/#submissions-v2" })}, ${`resume-failed:${generationId}`}, ${pair.id})
            on conflict do nothing
          `;
        }
        await tx`
          insert into submissions_v2.pair_events(
            pair_id, actor_type, actor_id, source, event_type,
            from_intent_state, to_intent_state, from_workflow_state, to_workflow_state,
            from_submission_status, to_submission_status, expected_version, new_version,
            reason_code, idempotency_key, metadata
          ) values (
            ${pair.id}, 'worker', ${actorId}, 'resume_generation', 'resume_failed',
            ${pair.intent_state}, ${updated.intent_state}, ${pair.workflow_state}, ${updated.workflow_state},
            ${pair.submission_status}, ${updated.submission_status}, ${pair.state_version}, ${updated.state_version},
            ${reasonCode}, ${`pair:resume-failed:${generationId}`}, ${tx.json({ generation_id: generationId })}
          )
        `;
        return updated;
      });
    },

    async failRegeneration({ generationId, reasonCode, safeDetail, executionFence }) {
      return sql.begin(async (tx) => {
        await assertWorkerFence(tx, executionFence, "generation");
        const rows = await tx`
          update submissions_v2.resume_generations set status='failed', stage='failed',
                 safe_failure_code=${reasonCode}, safe_failure_detail=${clean(safeDetail)},
                 completed_at=clock_timestamp()
           where id=${generationId} and status <> 'succeeded' returning *
        `;
        if (!rows.length) throw new ResumePipelineError("generation_fence_lost", "The regeneration changed before failure routing.");
        return rows[0];
      });
    },

    async abandonGenerationForRetry({ generationId, reasonCode, safeDetail, executionFence }) {
      return sql.begin(async (tx) => {
        await assertGenerationFence(tx, executionFence, generationId);
        const rows = await tx`
          update submissions_v2.resume_generations
             set status='failed', stage='retry_scheduled', safe_failure_code=${clean(reasonCode, 120)},
                 safe_failure_detail=${clean(safeDetail)}, completed_at=clock_timestamp()
           where id=${generationId} and status in (
             'queued', 'collecting', 'extracting', 'strategizing', 'validating', 'rendering', 'archiving'
           ) returning *
        `;
        if (!rows.length) throw new ResumePipelineError("generation_fence_lost", "The resume generation changed before its safe retry.");
        return rows[0];
      });
    },

    async resumeAfterRecheck({ pairId, expectedPairVersion, actorId = "submissions-v2-worker", executionFence }) {
      return sql.begin(async (tx) => {
        await assertWorkerFence(tx, executionFence, "ingestion");
        const pair = (await tx`
          select * from submissions_v2.candidate_role_pairs
           where id=${pairId} and case_hidden_at is null for update
        `)[0];
        if (!pair || Number(pair.state_version) !== Number(expectedPairVersion)) {
          throw new ResumePipelineError("stale_pair_version", "The candidate-role item changed before Recheck completed.");
        }
        if (pair.workflow_state !== "needs_review") return { pair, job: null, unchanged: true };
        await tx`
          update submissions_v2.review_items
             set action_state='resolved', resolved_at=clock_timestamp(), resolved_by=${actorId},
                 resolution_note='Candidate-original resume confirmed by Recheck'
           where pair_id=${pairId} and action_state='open'
             and reason_code='candidate_original_resume_missing'
        `;
        const remaining = await tx`
          select count(*)::integer as count from submissions_v2.review_items
           where pair_id=${pairId} and action_state='open'
        `;
        if (Number(remaining[0]?.count) > 0) return { pair, job: null, unchanged: true };
        const updated = (await tx`
          update submissions_v2.candidate_role_pairs
             set intent_state='interested', workflow_state='preparing_resume', state_version=state_version+1
           where id=${pairId} and state_version=${pair.state_version} returning *
        `)[0];
        const controls = (await tx`select * from submissions_v2.lock_runtime_controls()`)[0];
        if (!controls) throw new ResumePipelineError("submissions_v2_controls_unavailable", "Submissions V2 controls are unavailable.");
        const key = `resume:recheck:${pairId}:${updated.state_version}`;
        const inserted = await tx`
          insert into submissions_v2.jobs(
            kind, subject_type, subject_id, idempotency_key, required_control,
            priority, max_attempts, checkpoint, control_epoch
          ) values (
            'prepare_resume', 'pair', ${pairId}, ${key}, 'generation', 45, 3,
            ${tx.json({ trigger_kind: "retry", expected_pair_version: Number(updated.state_version) })},
            ${controls.control_epoch}
          ) on conflict (kind, idempotency_key) do nothing
          returning *
        `;
        const job = inserted[0] || (await tx`
          select * from submissions_v2.jobs where kind='prepare_resume' and idempotency_key=${key} for share
        `)[0];
        if (!job) throw new ResumePipelineError("resume_job_enqueue_failed", "The resume recheck could not queue its generation job.");
        await tx`
          insert into submissions_v2.pair_events(
            pair_id, actor_type, actor_id, source, event_type,
            from_intent_state, to_intent_state, from_workflow_state, to_workflow_state,
            from_submission_status, to_submission_status, expected_version, new_version,
            idempotency_key, metadata
          ) values (
            ${pairId}, 'worker', ${actorId}, 'recheck', 'original_resume_confirmed',
            ${pair.intent_state}, ${updated.intent_state}, ${pair.workflow_state}, ${updated.workflow_state},
            ${pair.submission_status}, ${updated.submission_status}, ${pair.state_version}, ${updated.state_version},
            ${`pair:recheck:${pairId}:${updated.state_version}`}, ${tx.json({ job_id: job.id })}
          )
        `;
        return { pair: updated, job, unchanged: false };
      });
    },
  };
}

export const resumePipelineStoreInternals = Object.freeze({ readEncryptedText, safeCheckpointId, sourceRows });
