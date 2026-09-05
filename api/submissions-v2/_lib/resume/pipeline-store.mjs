import { database } from "../db.mjs";
import { assertGenerationFence, assertWorkerFence, createRepository } from "../repository.mjs";
import { decryptJson, encryptJson } from "../private-data.mjs";
import { privatePath, privateReservationId, putPrivateObject, readPrivateObject } from "../blob.mjs";
import { canonicalJson, sha256 } from "./source-bundle.mjs";
import { ResumePipelineError, checkpointDigest } from "./pipeline-runtime.mjs";
import { candidateOriginalExtractionRecord } from "./candidate-original-reuse.mjs";

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

function extractionContext(identity) {
  return `candidate-original-extraction:${sha256(canonicalJson(identity))}`;
}

export function createResumePipelineStore({
  sql = database(),
  repository = createRepository({ sql }),
  blobs = { putPrivateObject, readPrivateObject },
  env = process.env,
} = {}) {
  const candidateOriginalExtractionCache = {
    async load(identity) {
      const rows = await sql`
        select candidate_user_id, source_id, source_locator, content_digest,
               normalized_text_encrypted, normalized_text_digest, page_count, captured_at
          from submissions_v2.candidate_original_extraction_cache
         where candidate_user_id=${identity.candidate_id}
           and source_id=${identity.source_id}
           and source_locator=${identity.source_locator}
           and content_digest=${identity.content_digest}
           and expires_at > clock_timestamp()
      `;
      const row = rows[0];
      if (!row) return null;
      const payload = decryptJson(envelopeFromBytes(row.normalized_text_encrypted), {
        env,
        context: extractionContext(identity),
      });
      if (sha256(String(payload?.normalized_text || "")) !== row.normalized_text_digest) {
        throw new ResumePipelineError("candidate_original_cache_digest_mismatch", "Candidate-original extraction cache integrity verification failed.");
      }
      return candidateOriginalExtractionRecord(identity, {
        text: payload?.normalized_text,
        pageCount: row.page_count,
      }, { capturedAt: row.captured_at });
    },
    async save(record) {
      const identity = {
        candidate_id: record.candidate_id,
        source_id: record.source_id,
        source_locator: record.source_locator,
        content_digest: record.content_digest,
      };
      const envelope = encryptJson({ normalized_text: record.normalized_text }, {
        env,
        context: extractionContext(identity),
        deterministic: true,
      });
      const expiresAt = new Date(Date.parse(record.captured_at) + (31 * 24 * 60 * 60_000)).toISOString();
      await sql`
        insert into submissions_v2.candidate_original_extraction_cache(
          candidate_user_id, source_id, source_locator, content_digest,
          normalized_text_encrypted, normalized_text_digest, page_count, captured_at, expires_at
        ) values (
          ${identity.candidate_id}, ${identity.source_id}, ${identity.source_locator}, ${identity.content_digest},
          ${Buffer.from(canonicalJson(envelope), "utf8")}, ${record.normalized_text_digest}, ${record.page_count}, ${record.captured_at}, ${expiresAt}
        ) on conflict (candidate_user_id, source_id, source_locator, content_digest) do update set
          normalized_text_encrypted=excluded.normalized_text_encrypted,
          normalized_text_digest=excluded.normalized_text_digest,
          page_count=excluded.page_count,
          captured_at=excluded.captured_at,
          expires_at=excluded.expires_at,
          updated_at=clock_timestamp()
      `;
    },
  };
  return {
    repository,
    sql,
    candidateOriginalExtractionCache,

    async purgeExpiredCandidateOriginalExtractions({ limit = 100 } = {}) {
      const capped = Math.max(1, Math.min(1_000, Number(limit) || 100));
      const rows = await sql`
        with expired as (
          select candidate_user_id, source_id, source_locator, content_digest
            from submissions_v2.candidate_original_extraction_cache
           where expires_at <= clock_timestamp()
           order by expires_at
           limit ${capped}
           for update skip locked
        )
        delete from submissions_v2.candidate_original_extraction_cache cache
         using expired
         where cache.candidate_user_id=expired.candidate_user_id
           and cache.source_id=expired.source_id
           and cache.source_locator=expired.source_locator
           and cache.content_digest=expired.content_digest
        returning cache.content_digest
      `;
      return rows.length;
    },

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
        select checkpoint->'pipeline' as pipeline,
               checkpoint->>'safe_failure_code' as safe_failure_code
          from submissions_v2.jobs
         where kind='prepare_resume'
           and subject_type='pair'
           and subject_id=${pairId}
           and id<>${excludingJobId}::uuid
         order by updated_at desc
         limit 1
      `;
      const latest = rows[0], pipeline = latest?.pipeline;
      if (latest?.safe_failure_code === "candidate_original_resume_missing") return null;
      return pipeline && typeof pipeline === "object" && Object.keys(pipeline.stages || {}).length
        ? pipeline
        : null;
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

    async reserveModelStage({ generationId, stage, attempt, inputDigest, reservedCents, executionFence }) {
      return sql.begin(async (tx) => {
        await assertGenerationFence(tx, executionFence, generationId);
        const boundedAttempt = Math.max(1, Math.min(3, Number(attempt) || 1));
        const boundedReserved = Math.max(1, Math.min(200, Number(reservedCents) || 0));
        let rows = await tx`
          select * from submissions_v2.resume_stage_runs
           where generation_id=${generationId} and stage=${stage} and attempt=${boundedAttempt}
           for update
        `;
        const replay = rows.length > 0;
        if (replay && rows[0].input_digest !== inputDigest) {
          throw new ResumePipelineError("model_stage_input_conflict", "A model-call reservation was already used for different input.");
        }
        if (!replay) rows = await tx`
          insert into submissions_v2.resume_stage_runs(
            generation_id, stage, attempt, input_digest, status, cost_cents,
            reserved_cents, charge_outcome, reservation_at
          ) values (
            ${generationId}, ${stage}, ${boundedAttempt}, ${inputDigest}, 'running',
            ${boundedReserved}, ${boundedReserved}, 'reserved', clock_timestamp()
          )
          returning *
        `;
        // A surviving reservation cannot prove whether the provider accepted
        // the request before the worker stopped. Preserve its full forecast as
        // spent and make the ambiguity explicit instead of sending it again.
        if (replay && rows[0].charge_outcome === "reserved") rows = await tx`
          update submissions_v2.resume_stage_runs
             set charge_outcome='unknown'
           where id=${rows[0].id}
          returning *
        `;
        // The generation row is what a later job attempt sums. Move its spend
        // fence in the same transaction as the provider-call reservation so a
        // process crash cannot make the next generation forget this charge.
        const total = Number((await tx`
          select coalesce(sum(reserved_cents), 0)::integer as total
            from submissions_v2.resume_stage_runs
           where generation_id=${generationId}
        `)[0]?.total || 0);
        const generationRows = await tx`
          update submissions_v2.resume_generations
             set spent_cents=greatest(spent_cents, ${total}), updated_at=clock_timestamp()
           where id=${generationId} and ${total} <= budget_cents
          returning id
        `;
        if (!generationRows.length) {
          throw new ResumePipelineError("generation_budget_exhausted", "Resume preparation reached its two-dollar model-cost ceiling.");
        }
        return { ...rows[0], replay };
      });
    },

    async settleModelStage({ generationId, stage, attempt, actualCents = null, executionFence }) {
      return sql.begin(async (tx) => {
        await assertGenerationFence(tx, executionFence, generationId);
        const actual = actualCents == null ? null : Math.max(0, Math.min(200, Math.ceil(Number(actualCents) || 0)));
        const rows = await tx`
          update submissions_v2.resume_stage_runs
             set charge_outcome=case when charge_outcome='settled' then 'settled' else ${actual == null ? "unknown" : "settled"} end,
                 actual_cents=case when charge_outcome='settled' then actual_cents else ${actual} end,
                 settled_at=case when charge_outcome='settled' or ${actual == null} then settled_at else clock_timestamp() end
           where generation_id=${generationId} and stage=${stage}
             and attempt=${Math.max(1, Math.min(3, Number(attempt) || 1))}
             and reserved_cents > 0
             and (${actual}::integer is null or ${actual} <= reserved_cents)
           returning *
        `;
        if (!rows.length) throw new ResumePipelineError("model_charge_settlement_invalid", "The model-charge reservation could not be settled safely.");
        return rows[0];
      });
    },

    async recordStage({ generationId, stage, attempt, inputDigest, outputKey = null, outputDigest = null, objectReservationId = null, objectWriteFencingToken = null, objectDigest = null, status, costCents = 0, actualCents = null, errorCode = null, safeDetail = null, executionFence }) {
      return sql.begin(async (tx) => {
        await assertGenerationFence(tx, executionFence, generationId);
        const boundedAttempt = Math.max(1, Math.min(3, Number(attempt) || 1));
        const boundedCost = Math.max(0, Math.min(200, Number(costCents) || 0));
        const boundedActual = actualCents == null ? null : Math.max(0, Math.min(200, Math.ceil(Number(actualCents) || 0)));
        const chargeOutcome = boundedCost > 0 ? (boundedActual == null ? "unknown" : "settled") : "not_called";
        const reservationAt = boundedCost > 0 ? new Date().toISOString() : null;
        const settledAt = boundedCost > 0 && boundedActual != null ? new Date().toISOString() : null;
        const completedAt = status === "running" ? null : new Date().toISOString();
        // Model-cost reservation creates this stage row before the checkpoint
        // exists. Updating it first preserves the durable row identity used by
        // the private-object binding trigger. INSERT ... ON CONFLICT cannot do
        // that: its BEFORE INSERT trigger would transiently claim the object
        // path under a new UUID before PostgreSQL reaches conflict resolution.
        let rows = await tx`
          update submissions_v2.resume_stage_runs
             set output_object_key=${outputKey}, output_digest=${outputDigest}, status=${status},
                 cost_cents=greatest(cost_cents, ${boundedCost}),
                 actual_cents=coalesce(${boundedActual}, actual_cents),
                 charge_outcome=case when reserved_cents > 0 and ${boundedActual}::integer is null
                   then 'unknown' else ${chargeOutcome} end,
                 settled_at=coalesce(${settledAt}, settled_at), completed_at=${completedAt},
                 safe_error_code=${errorCode}, safe_error_detail=${safeDetail}
           where generation_id=${generationId} and stage=${stage} and attempt=${boundedAttempt}
             and input_digest=${inputDigest}
          returning *
        `;
        if (!rows.length) {
          const conflicts = await tx`
            select input_digest from submissions_v2.resume_stage_runs
             where generation_id=${generationId} and stage=${stage} and attempt=${boundedAttempt}
          `;
          if (conflicts.length) {
            throw new ResumePipelineError("stage_run_input_conflict", "A resume stage attempt was already used for different input.");
          }
          rows = await tx`
          insert into submissions_v2.resume_stage_runs(
          generation_id, stage, attempt, input_digest, output_object_key, output_digest,
          status, cost_cents, reserved_cents, actual_cents, charge_outcome, reservation_at, settled_at,
          completed_at, safe_error_code, safe_error_detail
        ) values (
          ${generationId}, ${stage}, ${boundedAttempt}, ${inputDigest},
          ${outputKey}, ${outputDigest}, ${status}, ${boundedCost}, ${boundedCost},
          ${boundedActual}, ${chargeOutcome}, ${reservationAt}, ${settledAt},
          ${completedAt}, ${errorCode}, ${safeDetail}
        )
        returning *
        `;
        }
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
            ${tx.json({ trigger_kind: "retry", expected_pair_version: Number(updated.state_version), refresh_sources: true })},
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
