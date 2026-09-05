import { readFile } from "node:fs/promises";

import { collectResumeSourceBundle } from "./collector.mjs";
import { extractCandidateEvidenceClaims } from "./claim-extractor.mjs";
import { buildEvidenceLedger } from "./evidence-ledger.mjs";
import {
  STRATEGIST_FALLBACK_MODEL,
  STRATEGIST_MAX_OUTPUT_TOKENS,
  STRATEGIST_PRIMARY_MODEL,
  STRATEGIST_PROMPT_VERSION,
  resumeStrategistForecastInput,
  runResumeStrategist,
} from "../models/anthropic-strategist.mjs";
import {
  GROUNDING_PROMPT_VERSION,
  GROUNDING_VALIDATOR_BATCH_SIZE,
  GROUNDING_VALIDATOR_MODEL,
  validateClaimsToCompletion,
} from "../models/openai-validator.mjs";
import {
  applyValidatedClaimsToAst,
  collectContentNodes,
  compressUnderfilledResume,
  draftClaimsFromAst,
  prepareResumeRender,
  resumeAstDigest,
  verifyRenderedPdf,
} from "../../../../resume-renderer-v2/index.mjs";
import { createArtifactManifest, assertArtifactReadback } from "../../../../resume-renderer-v2/manifest.mjs";
import { RESUME_TEMPLATE_VERSION } from "../../../../resume-renderer-v2/contract.mjs";
import { privatePath, privateReservationId } from "../blob.mjs";
import { canonicalJson, assertGenerationReady, sha256 } from "./source-bundle.mjs";
import {
  GENERATION_BUDGET_CENTS,
  GENERATION_DEADLINE_MS,
  ResumePipelineError,
  createGenerationBudget,
  actualModelCostCents,
  forecastModelCostCents,
  pipelineError,
} from "./pipeline-runtime.mjs";
import { renderResumeWithService, extractPdfWithRenderer } from "./pipeline-renderer.mjs";
import { processResumeSupplements } from "./pipeline-supplements.mjs";
import { createPreparationCommand, preparationResult } from "../domain/preparation.mjs";

const BRAND_ASSET_URL = new URL("../../../../resume-renderer-v2/assets/raydar-lockup.svg", import.meta.url);
const clean = (value, limit = 500) => String(value ?? "").replace(/[\r\n]+/gu, " ").trim().slice(0, limit);
const LAYOUT_RETRY_INSTRUCTIONS = Object.freeze({
  RESUME_PAGE_TWO_UNDERFILLED: "The previous layout left page two underfilled; produce a tighter one-page document by selecting only the strongest role-relevant evidence within the one-page limits.",
  RESUME_PAGE_LIMIT_EXCEEDED: "The previous layout exceeded two pages; reduce it to the strongest role-relevant evidence and target one page within the one-page limits.",
});

function layoutRetryCheckpoint(checkpoint, code) {
  const feedback = LAYOUT_RETRY_INSTRUCTIONS[code];
  if (!feedback) return null;
  const stages = checkpoint?.pipeline?.stages || {};
  return {
    ...(checkpoint || {}),
    pipeline: {
      ...(checkpoint?.pipeline || {}),
      layout_feedback: code,
      stages: Object.fromEntries(Object.entries(stages).filter(([stage]) => ["collect", "evidence"].includes(stage))),
    },
  };
}

function effectiveStrategyInstructions(versionInstructions, layoutFeedback) {
  return [clean(versionInstructions, 8_000), LAYOUT_RETRY_INSTRUCTIONS[layoutFeedback] || ""].filter(Boolean).join("\n\n");
}

async function officialBrandAsset() {
  const bytes = await readFile(BRAND_ASSET_URL);
  if (!bytes.length) throw new ResumePipelineError("official_brand_asset_missing", "The official Raydar resume lockup is unavailable.");
  return `data:image/svg+xml;base64,${bytes.toString("base64")}`;
}

function generationFailureDetails(error, generation, triggerKind) {
  error.details = {
    ...(error.details && typeof error.details === "object" ? error.details : {}),
    generationId: generation?.id || null,
    triggerKind,
    priorArtifactId: generation?.prior_artifact_id || null,
  };
  return error;
}

function safeFailureDetail(error) {
  const base = clean(error?.safeMessage || error?.message || "Resume preparation failed safely before publication.");
  const code = error?.details?.contractCode === "RESUME_FILLER_OR_REPETITION"
    ? error.details.contractCode
    : null;
  const path = String(error?.details?.contractPath || "");
  const safePath = path.length <= 160
    && /^document\.(?:candidate\.(?:name|headline|contact\[\d{1,2}\])|summary|sections\[\d{1,2}\]\.entries\[\d{1,2}\]\.(?:header|body)\[\d{1,2}\])$/u.test(path)
    ? path
    : null;
  if (!code) return base;
  const suffix = `Contract ${code}${safePath ? ` at ${safePath}` : ""}.`;
  return clean(base.includes(suffix) ? base : `${base} ${suffix}`);
}

function stageInputDigest(value) {
  return sha256(canonicalJson(value));
}

function validatorPhaseForecast(claims, {
  env = process.env,
  maxAttempts = 3,
  maxRewriteRounds = 2,
} = {}) {
  const packets = Array.isArray(claims) ? claims : [];
  const batches = [];
  for (let index = 0; index < packets.length; index += GROUNDING_VALIDATOR_BATCH_SIZE) {
    batches.push(packets.slice(index, index + GROUNDING_VALIDATOR_BATCH_SIZE));
  }
  if (!batches.length) {
    throw new ResumePipelineError("validator_claims_required", "Grounding validation requires candidate claims.");
  }
  // Every batch can consume every provider retry in every rewrite round. Use
  // the largest batch for all possible calls so output allowance and request
  // overhead scale with batch count before any request leaves the worker.
  const largestBatch = batches.reduce((largest, batch) => (
    Buffer.byteLength(canonicalJson(batch), "utf8") > Buffer.byteLength(canonicalJson(largest), "utf8") ? batch : largest
  ), batches[0]);
  const calls = batches.length
    * Math.max(1, Math.min(5, Number(maxAttempts) || 3))
    * (Math.max(1, Math.min(3, Number(maxRewriteRounds) || 2)) + 1);
  return forecastModelCostCents({
    model: GROUNDING_VALIDATOR_MODEL,
    input: largestBatch,
    maximumOutputTokens: 3_000,
    attempts: calls,
    env,
  });
}

function validatorUsageAudits(history) {
  return (Array.isArray(history) ? history : []).flatMap((round) => {
    if (Array.isArray(round?.attempts) && round.attempts.length) return round.attempts;
    return round?.audit ? [round.audit] : [];
  });
}

function modelReservationReplayError() {
  return new ResumePipelineError(
    "provider_outcome_uncertain",
    "A prior model request may have been accepted, so resume preparation stopped before sending a duplicate request.",
    { retryable: true },
  );
}

function supplementOcrStage(supplementId) {
  const key = String(supplementId || "unknown").replace(/[^a-z0-9_-]/giu, "-").slice(0, 160);
  return `supplement_ocr:${key}`;
}

function artifactMetadata({ kind, pathname, bytes, digest, pageCount = null, textDigest = null, at, reservationId = null, writeFencingToken = null }) {
  return {
    kind,
    private_object_key: pathname,
    digest,
    size_bytes: Buffer.byteLength(bytes),
    page_count: pageCount,
    text_digest: textDigest,
    archive_readback_at: at,
    archived_at: at,
    object_reservation_id: reservationId,
    object_write_fencing_token: writeFencingToken,
  };
}

export async function runResumePreparation(context, {
  store,
  collectSources = collectResumeSourceBundle,
  extractClaims = extractCandidateEvidenceClaims,
  makeLedger = buildEvidenceLedger,
  strategist = runResumeStrategist,
  validator = validateClaimsToCompletion,
  renderer = renderResumeWithService,
  extractPdf = extractPdfWithRenderer,
  processSupplements = processResumeSupplements,
  putObject = null,
  readObject = null,
  brandAsset = officialBrandAsset,
  env = process.env,
  fetchImpl = globalThis.fetch,
  now = Date.now,
  executionFence = null,
  candidateOriginalExtractionCache = null,
} = {}) {
  if (!store) throw new TypeError("resume pipeline store is required");
  putObject ||= (pathname, bytes, contentType) => store.putPrivateObject(pathname, bytes, contentType);
  readObject ||= (pathname) => store.readPrivateObject(pathname);
  executionFence ||= {
    jobId: context?.job?.id,
    workerId: context?.workerId,
    fencingToken: context?.fencingToken,
    controlEpoch: context?.controlEpoch,
  };
  if (!executionFence) throw new ResumePipelineError("execution_fence_required", "Resume preparation requires its active worker execution fence.");
  const pairId = String(context?.job?.subject_id || "");
  if (!pairId || context?.job?.subject_type !== "pair") {
    throw new ResumePipelineError("prepare_resume_subject_invalid", "The resume job is not bound to a candidate-role item.");
  }
  const initialCheckpoint = context.job.checkpoint && typeof context.job.checkpoint === "object"
    ? context.job.checkpoint
    : {};
  const triggerKind = ["initial", "regenerate", "retry"].includes(initialCheckpoint.trigger_kind)
    ? initialCheckpoint.trigger_kind
    : "initial";
  const reusablePipeline = triggerKind === "retry"
    && initialCheckpoint.refresh_sources !== true
    && !Object.keys(initialCheckpoint.pipeline?.stages || {}).length
    && typeof store.loadRetryPipeline === "function"
    ? await store.loadRetryPipeline({ pairId, excludingJobId: context.job.id })
    : null;
  let checkpoint = {
    ...initialCheckpoint,
    pipeline: {
      ...(reusablePipeline || {}),
      ...(initialCheckpoint.pipeline || {}),
      schema_version: "raydar.submissions-v2.resume-pipeline-checkpoint.v1",
      stages: { ...(reusablePipeline?.stages || {}), ...(initialCheckpoint.pipeline?.stages || {}) },
    },
  };
  let generation = null;
  let command = null;
  let reservedCents = 0;
  let pendingModelCharge = null;
  let actualSpentCents = 0;
  let actualSpendUnknown = false;

  const publishCheckpoint = async (patch = {}) => {
    checkpoint = {
      ...checkpoint,
      pipeline: { ...checkpoint.pipeline, ...patch, stages: { ...checkpoint.pipeline.stages, ...(patch.stages || {}) } },
    };
    await context.checkpoint(checkpoint);
    return checkpoint;
  };

  const loadStage = async (stage) => {
    const reference = checkpoint.pipeline.stages?.[stage];
    if (!reference) return null;
    const value = await store.loadCheckpoint(reference);
    const currentContext = `resume-checkpoint:${generation?.id}:${stage}`;
    if (reference.context === currentContext) return value;
    const cloned = await saveStage(stage, value);
    const progress = {
      collect: { fromStatuses: ["queued", "collecting"], status: "collecting", stage: "collect" },
      evidence: { fromStatuses: ["collecting", "extracting"], status: "extracting", stage: "evidence" },
      strategy: { fromStatuses: ["extracting", "strategizing"], status: "strategizing", stage: "strategy" },
      validate: { fromStatuses: ["strategizing", "validating"], status: "validating", stage: "validate" },
      render: { fromStatuses: ["validating", "rendering"], status: "rendering", stage: "render" },
    }[stage];
    if (progress) {
      await store.updateGeneration({
        generationId: generation.id,
        ...progress,
        executionFence,
      });
    }
    return cloned;
  };

  const saveStage = async (stage, value, { costCents = 0, actualCents = null } = {}) => {
    const reference = await store.saveCheckpoint({ generationId: generation.id, stage, value, executionFence });
    await store.recordStage({
      generationId: generation.id,
      stage,
      attempt: context.job.attempt_count,
      inputDigest: stageInputDigest({ stage, source: generation.source_digest || null }),
      outputKey: reference.key,
      outputDigest: reference.digest,
      objectReservationId: reference.reservation_id,
      objectWriteFencingToken: reference.write_fencing_token,
      objectDigest: reference.object_digest,
      status: "succeeded",
      costCents,
      actualCents,
      executionFence,
    });
    await publishCheckpoint({ stages: { [stage]: reference } });
    return reference.value ?? value;
  };

  try {
    await publishCheckpoint({ active_stage: "starting" });
    candidateOriginalExtractionCache ||= store.candidateOriginalExtractionCache || null;
    let loaded = await store.loadPairContext(pairId, checkpoint);
    const pair = loaded.pair;
    command = createPreparationCommand({ pair, job: context.job, checkpoint });
    const expectedPairVersion = Number(checkpoint.expected_pair_version || pair.state_version);
    if (!Number.isInteger(expectedPairVersion) || expectedPairVersion < 1) {
      throw new ResumePipelineError("expected_pair_version_invalid", "The resume job is missing its pair version fence.");
    }
    const createdDeadline = now() + GENERATION_DEADLINE_MS;
    generation = await store.startGeneration({
      pairId,
      triggerKind,
      idempotencyKey: `resume-job:${context.job.id}:attempt:${Math.max(1, Number(context.job.attempt_count) || 1)}`,
      expectedPairVersion,
      commandId: context.job.command_id || null,
      primaryModelPin: STRATEGIST_PRIMARY_MODEL,
      fallbackModelPin: STRATEGIST_FALLBACK_MODEL,
      validatorModelPin: GROUNDING_VALIDATOR_MODEL,
      promptPin: `${STRATEGIST_PROMPT_VERSION}+${GROUNDING_PROMPT_VERSION}`,
      templatePin: RESUME_TEMPLATE_VERSION,
      deadlineAt: new Date(createdDeadline).toISOString(),
      budgetCents: GENERATION_BUDGET_CENTS,
      priorArtifactId: pair.current_artifact_id || null,
      executionFence,
    });
    if (generation.status === "succeeded") return {
      checkpoint,
      generation_id: generation.id,
      existing: true,
      result: preparationResult({ command, outcome: "existing", generationId: generation.id, sourceDigest: generation.source_digest }),
    };
    if (Number(generation.job_spent_cents || 0) >= GENERATION_BUDGET_CENTS) {
      throw new ResumePipelineError("generation_budget_exhausted", "Resume preparation reached its two-dollar model-cost ceiling.");
    }
    const deadlineAt = Date.parse(generation.deadline_at);
    const budget = createGenerationBudget({
      deadlineAt,
      budgetCents: generation.budget_cents,
      spentCents: generation.spent_cents,
      now,
    });
    await publishCheckpoint({ generation_id: generation.id, deadline_at: generation.deadline_at, spent_cents: budget.spentCents });

    if (loaded.pendingSupplements?.length) {
      budget.assertTime(30_000);
      await publishCheckpoint({ active_stage: "supplements" });
      await store.updateGeneration({ generationId: generation.id, fromStatuses: ["queued", "collecting"], status: "collecting", stage: "supplements", spentCents: budget.spentCents, executionFence });
      await processSupplements(loaded.pendingSupplements, {
        env,
        fetchImpl,
        signal: context.signal,
        budget,
        reserveModelCall: async ({ supplementId, inputDigest, costCents, minimumRemainingMs }) => {
          if (typeof store.reserveModelStage !== "function" || typeof store.recordStage !== "function") {
            throw new ResumePipelineError("model_charge_store_missing", "Resume model-cost accounting is unavailable.");
          }
          budget.reserve(costCents, { minimumRemainingMs });
          reservedCents = budget.spentCents;
          const charge = {
            stage: supplementOcrStage(supplementId),
            attempt: context.job.attempt_count,
            inputDigest,
            reservedCents: costCents,
          };
          const reservation = await store.reserveModelStage({
            generationId: generation.id,
            ...charge,
            executionFence,
          });
          if (reservation?.replay) throw modelReservationReplayError();
          pendingModelCharge = charge;
          await publishCheckpoint({ active_stage: "supplements", spent_cents: budget.spentCents });
          await store.updateGeneration({
            generationId: generation.id,
            fromStatuses: ["queued", "collecting"],
            status: "collecting",
            stage: "supplements",
            spentCents: budget.spentCents,
            executionFence,
          });
          return charge;
        },
        settleModelCall: async ({ stage, attempt, inputDigest, reservedCents: chargeCents, actualCents }) => {
          await store.recordStage({
            generationId: generation.id,
            stage,
            attempt,
            inputDigest,
            status: "succeeded",
            costCents: chargeCents,
            actualCents,
            executionFence,
          });
          if (actualCents == null) actualSpendUnknown = true;
          else actualSpentCents += actualCents;
          pendingModelCharge = null;
        },
        attemptCount: context.job.attempt_count,
        maxAttempts: context.job.max_attempts,
        readObject: (pathname) => store.readPrivateObject(pathname),
        putObject: (pathname, bytes, contentType) => store.putPrivateObject(pathname, bytes, contentType),
        extractPdf: (bytes, options = {}) => extractPdf(bytes, {
          ...options,
          env,
          fetchImpl,
          signal: context.signal,
          timeoutMs: Math.min(60_000, Math.max(1_000, deadlineAt - now())),
        }),
        updateSupplement: (input) => store.updateSupplementProcessing({ ...input, generationId: generation.id, executionFence }),
        reserveObject: (input) => store.reservePrivateObject({ ...input, generationId: generation.id, executionFence }),
        renewObject: (input) => store.renewPrivateObjectWrite({ ...input, generationId: generation.id, executionFence }),
      });
      loaded = await store.loadPairContext(pairId, checkpoint);
      if (loaded.pendingSupplements?.length) {
        throw new ResumePipelineError("supplement_processing_incomplete", "Uploaded resume context did not reach a terminal parse state.", { retryable: false });
      }
    }

    let collected = await loadStage("collect");
    if (!collected) {
      budget.assertTime(45_000);
      await publishCheckpoint({ active_stage: "collect" });
      await store.updateGeneration({ generationId: generation.id, fromStatuses: ["queued", "collecting"], status: "collecting", stage: "collect", spentCents: budget.spentCents, executionFence });
      const candidateBundle = await collectSources({
        candidateUserId: pair.candidate_user_id,
        roleId: pair.role_id,
        supplements: loaded.supplements,
        knownRaydarDigests: loaded.knownRaydarDigests,
      }, {
        extractResumeImpl: (bytes) => extractPdf(bytes, { env, fetchImpl, signal: context.signal, timeoutMs: Math.min(60_000, Math.max(1_000, deadlineAt - now())) }),
        env,
        fetchImpl,
        now,
        candidateOriginalExtractionCache,
      });
      collected = await saveStage("collect", { bundle: candidateBundle });
    }
    const bundle = collected.bundle || collected;
    const sourceRecords = await store.persistSources(generation.id, bundle, executionFence);
    const strategyInstructions = effectiveStrategyInstructions(
      loaded.versionInstructions,
      checkpoint.pipeline.layout_feedback,
    );
    await store.setGenerationDigests({
      generationId: generation.id,
      sourceDigest: bundle.sourceDigest,
      instructionDigest: strategyInstructions ? sha256(strategyInstructions) : null,
      executionFence,
    });
    try { assertGenerationReady(bundle); }
    catch (error) {
      throw new ResumePipelineError("candidate_original_resume_missing", "Add the candidate's original resume in Paraform, then Recheck.", {
        retryable: false,
        cause: error,
        details: bundle.readiness?.blocker,
      });
    }

    let evidence = await loadStage("evidence");
    if (!evidence) {
      budget.assertTime(20_000);
      await publishCheckpoint({ active_stage: "evidence" });
      await store.updateGeneration({ generationId: generation.id, fromStatuses: ["collecting", "extracting"], status: "extracting", stage: "evidence", spentCents: budget.spentCents, executionFence });
      const extractedClaims = extractClaims(bundle);
      const ledger = makeLedger(bundle, extractedClaims);
      evidence = await saveStage("evidence", { extractedClaims, ledger });
    }

    let strategy = await loadStage("strategy");
    if (!strategy) {
      const forecast = forecastModelCostCents({
        model: STRATEGIST_PRIMARY_MODEL,
        input: resumeStrategistForecastInput({ bundle, ledger: evidence.ledger, versionInstructions: strategyInstructions }),
        maximumOutputTokens: STRATEGIST_MAX_OUTPUT_TOKENS,
        attempts: 2,
        env,
      });
      budget.reserve(forecast, { minimumRemainingMs: 60_000 });
      reservedCents = budget.spentCents;
      const strategyCharge = {
        stage: "strategy",
        attempt: context.job.attempt_count,
        inputDigest: stageInputDigest({ stage: "strategy", source: generation.source_digest || null }),
        reservedCents: forecast,
      };
      if (typeof store.reserveModelStage !== "function") {
        throw new ResumePipelineError("model_charge_store_missing", "Resume model-cost accounting is unavailable.");
      }
      const strategyReservation = await store.reserveModelStage({ generationId: generation.id, ...strategyCharge, executionFence });
      if (strategyReservation?.replay) throw modelReservationReplayError();
      pendingModelCharge = strategyCharge;
      await publishCheckpoint({ active_stage: "strategy", spent_cents: budget.spentCents });
      await store.updateGeneration({ generationId: generation.id, fromStatuses: ["extracting", "strategizing"], status: "strategizing", stage: "strategy", spentCents: budget.spentCents, executionFence });
      strategy = await strategist({ bundle, ledger: evidence.ledger, versionInstructions: strategyInstructions }, {
        env,
        fetchImpl,
        signal: context.signal,
        now,
      });
      const actualCents = actualModelCostCents({ model: STRATEGIST_PRIMARY_MODEL, audits: strategy.attempts || [strategy.audit], env });
      if (actualCents == null) actualSpendUnknown = true;
      else actualSpentCents += actualCents;
      if (typeof store.settleModelStage === "function") await store.settleModelStage({ generationId: generation.id, stage: "strategy", attempt: context.job.attempt_count, actualCents, executionFence });
      pendingModelCharge = null;
      strategy = await saveStage("strategy", strategy, { costCents: forecast, actualCents });
    }

    let validation = await loadStage("validate");
    if (!validation) {
      const draftClaims = draftClaimsFromAst(strategy.strategy.document, evidence.ledger);
      const forecast = validatorPhaseForecast(draftClaims, { env, maxAttempts: 3, maxRewriteRounds: 2 });
      budget.reserve(forecast, { minimumRemainingMs: 45_000 });
      reservedCents = budget.spentCents;
      const validationCharge = {
        stage: "validate",
        attempt: context.job.attempt_count,
        inputDigest: stageInputDigest({ stage: "validate", source: generation.source_digest || null }),
        reservedCents: forecast,
      };
      if (typeof store.reserveModelStage !== "function") {
        throw new ResumePipelineError("model_charge_store_missing", "Resume model-cost accounting is unavailable.");
      }
      const validationReservation = await store.reserveModelStage({ generationId: generation.id, ...validationCharge, executionFence });
      if (validationReservation?.replay) throw modelReservationReplayError();
      pendingModelCharge = validationCharge;
      await publishCheckpoint({ active_stage: "validate", spent_cents: budget.spentCents });
      await store.updateGeneration({ generationId: generation.id, fromStatuses: ["strategizing", "validating"], status: "validating", stage: "validate", spentCents: budget.spentCents, executionFence });
      const result = await validator(draftClaims, {
        env,
        fetchImpl,
        signal: context.signal,
        deadlineAt,
        maxAttempts: 3,
        maxRewriteRounds: 2,
        now,
      });
      const ast = applyValidatedClaimsToAst(strategy.strategy.document, result.claims);
      const validationAudits = validatorUsageAudits(result.history);
      const actualCents = actualModelCostCents({ model: GROUNDING_VALIDATOR_MODEL, audits: validationAudits, env });
      if (actualCents == null) actualSpendUnknown = true;
      else actualSpentCents += actualCents;
      if (typeof store.settleModelStage === "function") await store.settleModelStage({ generationId: generation.id, stage: "validate", attempt: context.job.attempt_count, actualCents, executionFence });
      pendingModelCharge = null;
      validation = await saveStage("validate", { result, draftClaims, ast }, { costCents: forecast, actualCents });
    }
    await store.persistClaims({
      generationId: generation.id,
      sourceRecords,
      draftClaims: validation.draftClaims,
      validation: validation.result,
      executionFence,
    });

    let rendered = await loadStage("render");
    if (!rendered) {
      budget.assertTime(30_000);
      await publishCheckpoint({ active_stage: "render", spent_cents: budget.spentCents });
      await store.updateGeneration({ generationId: generation.id, fromStatuses: ["validating", "rendering"], status: "rendering", stage: "render", spentCents: budget.spentCents, executionFence });
      const allowedClaimIds = evidence.ledger.claims.map((claim) => claim.claimId);
      const renderAst = compressUnderfilledResume(validation.ast);
      const selectedClaimIds = [...new Set(collectContentNodes(renderAst).flatMap((node) => node.claim_ids))];
      const prepared = prepareResumeRender(renderAst, {
        allowedClaimIds,
        selectedClaimIds,
        officialBrandAsset: await brandAsset(),
        practice: false,
      });
      let result;
      try {
        result = await renderer({
          renderId: `generation-${String(generation.id).replace(/[^A-Za-z0-9._:-]/gu, "-")}`,
          ast: prepared.ast,
          validatedClaimIds: selectedClaimIds,
          expectedAstSha256: resumeAstDigest(prepared.ast),
          practice: false,
        }, {
          env,
          fetchImpl,
          signal: context.signal,
          timeoutMs: Math.min(90_000, Math.max(1_000, deadlineAt - now())),
        });
      } catch (error) {
        const retryCheckpoint = layoutRetryCheckpoint(checkpoint, error?.code);
        if (!retryCheckpoint) throw error;
        checkpoint = retryCheckpoint;
        throw new ResumePipelineError("resume_layout_retry_required", "Resume preparation is retrying automatically with a tighter one-page plan.", {
          retryable: true,
          checkpoint,
          cause: error,
          details: { layoutError: error.code },
        });
      }
      const plan = { ...result.plan, expectedPages: Number(result.preflight?.pageCount) };
      const pdfVerification = verifyRenderedPdf({
        pdfBytes: result.pdfBytes,
        pdfExtractedText: result.pdfExtractedText,
        atsText: result.atsText,
        plan,
        preflight: result.preflight,
      });
      rendered = await saveStage("render", {
        result: { ...result, pdfBytes: result.pdfBytes.toString("base64") },
        render: {
          ...prepared,
          plan,
          rendererVersion: result.rendererVersion,
          templateVersion: result.templateVersion,
          brandAssetId: result.brandAssetId,
          brandAssetSha256: result.brandAssetSha256,
          atsText: result.atsText,
          atsSha256: result.atsSha256,
        },
        pdfVerification,
      });
    }

    budget.assertTime(15_000);
    await publishCheckpoint({ active_stage: "archive", spent_cents: budget.spentCents });
    await store.updateGeneration({ generationId: generation.id, fromStatuses: ["rendering", "archiving"], status: "archiving", stage: "archive", spentCents: budget.spentCents, executionFence });
    const artifactId = `${generation.id}-${generation.generation_version}`;
    const paths = {
      pdf: privatePath("pdf", artifactId),
      ats: privatePath("ats", artifactId),
      manifest: privatePath("manifest", artifactId),
    };
    const pdfBytes = Buffer.from(rendered.result.pdfBytes, "base64");
    const atsBytes = Buffer.from(rendered.result.atsText, "utf8");
    const manifest = createArtifactManifest({
      generationId: generation.id,
      version: generation.generation_version,
      pair: { candidateUserId: pair.candidate_user_id, roleId: pair.role_id },
      sourceBundle: bundle,
      evidenceLedger: evidence.ledger,
      strategyAudit: strategy.audit,
      validatorHistory: validation.result.history,
      validatedClaimPackets: validation.result.claims,
      render: rendered.render,
      pdfVerification: rendered.pdfVerification,
      artifactPaths: paths,
      createdAt: new Date(generation.created_at).toISOString(),
      practice: false,
    });
    const manifestBytes = Buffer.from(manifest.manifestJson, "utf8");
    const artifactBodies = {
      pdf: { bytes: pdfBytes, contentType: "application/pdf" },
      ats: { bytes: atsBytes, contentType: "text/plain; charset=utf-8" },
      manifest: { bytes: manifestBytes, contentType: "application/json" },
    };
    const reservations = {};
    for (const kind of ["pdf", "ats", "manifest"]) {
      reservations[kind] = await store.reservePrivateObject({
        reservationId: privateReservationId(paths[kind]), objectKey: paths[kind], purpose: "resume_artifact",
        ownerRef: generation.id, expectedDigest: sha256(artifactBodies[kind].bytes),
        expiresAt: now() + 24 * 60 * 60_000,
        generationId: generation.id, executionFence,
      });
    }
    for (const kind of ["pdf", "ats", "manifest"]) {
      await store.renewPrivateObjectWrite({
        reservationId: reservations[kind].id,
        objectKey: paths[kind],
        expectedDigest: sha256(artifactBodies[kind].bytes),
        writeFencingToken: reservations[kind].write_fencing_token,
        generationId: generation.id,
        executionFence,
      });
      await putObject(paths[kind], artifactBodies[kind].bytes, artifactBodies[kind].contentType, { env });
    }
    const [pdfReadback, atsReadback, manifestReadback] = await Promise.all([
      readObject(paths.pdf, { env }), readObject(paths.ats, { env }), readObject(paths.manifest, { env }),
    ]);
    assertArtifactReadback({
      expected: manifest,
      pdfBytes: pdfReadback.bytes,
      atsBytes: atsReadback.bytes,
      manifestBytes: manifestReadback.bytes,
    });
    const archiveAt = new Date(now()).toISOString();
    const artifacts = [
      artifactMetadata({ kind: "pdf", pathname: paths.pdf, bytes: pdfBytes, digest: sha256(pdfBytes), pageCount: rendered.pdfVerification.preflight.pageCount, textDigest: rendered.pdfVerification.pdfTextSha256, at: archiveAt, reservationId: reservations.pdf.id, writeFencingToken: Number(reservations.pdf.write_fencing_token) }),
      artifactMetadata({ kind: "ats", pathname: paths.ats, bytes: atsBytes, digest: sha256(atsBytes), textDigest: rendered.render.atsSha256, at: archiveAt, reservationId: reservations.ats.id, writeFencingToken: Number(reservations.ats.write_fencing_token) }),
      artifactMetadata({ kind: "manifest", pathname: paths.manifest, bytes: manifestBytes, digest: sha256(manifestBytes), textDigest: sha256(manifest.manifestJson), at: archiveAt, reservationId: reservations.manifest.id, writeFencingToken: Number(reservations.manifest.write_fencing_token) }),
    ];
    const archiveReference = await store.saveCheckpoint({ generationId: generation.id, stage: "archive", value: { paths, artifacts }, executionFence });
    const archived = archiveReference.value || { paths, artifacts };
    await publishCheckpoint({ active_stage: "promote", stages: { archive: archiveReference } });
    await store.assertExecutionFence({
      jobId: context.job.id,
      workerId: context.workerId,
      fencingToken: context.fencingToken,
      controlEpoch: context.controlEpoch,
    });
    const promoted = await store.promoteArtifacts({ generationId: generation.id, artifacts: archived.artifacts, checkpointReservation: {
      id: archiveReference.reservation_id, object_key: archiveReference.key, digest: archiveReference.object_digest,
      write_fencing_token: archiveReference.write_fencing_token,
    } }, {
      jobId: context.job.id,
      workerId: context.workerId,
      fencingToken: context.fencingToken,
      controlEpoch: context.controlEpoch,
    });
    checkpoint = await publishCheckpoint({ active_stage: "complete", promoted: true, spent_cents: budget.spentCents });
    return {
      checkpoint,
      generation_id: generation.id,
      artifact_version: Number(generation.generation_version),
      pair_version: Number(promoted.pair.state_version),
      result: preparationResult({
        command,
        outcome: "prepared",
        generationId: generation.id,
        artifactId: promoted.pair.current_artifact_id,
        sourceDigest: bundle.sourceDigest,
        reservedCents: budget.spentCents,
        actualCents: actualSpendUnknown ? null : actualSpentCents,
      }),
    };
  } catch (error) {
    if (pendingModelCharge && generation && typeof store.settleModelStage === "function") {
      try {
        await store.settleModelStage({ generationId: generation.id, stage: pendingModelCharge.stage, attempt: pendingModelCharge.attempt, actualCents: null, executionFence });
      } catch {}
    }
    const normalized = pipelineError(error, {
      safeMessage: "Resume preparation failed safely before publication.",
      retryable: true,
      checkpoint,
    });
    normalized.safeMessage = safeFailureDetail(normalized);
    normalized.message = normalized.safeMessage;
    if (command) normalized.preparationResult = preparationResult({
      command,
      outcome: normalized.code === "generation_execution_fence_lost" ? "superseded" : normalized.code === "provider_outcome_uncertain" ? "uncertain" : "failed",
      generationId: generation?.id,
      sourceDigest: generation?.source_digest,
      reasonCode: normalized.code,
      safeDetail: normalized.safeMessage,
      reservedCents: Math.max(Number(generation?.spent_cents) || 0, reservedCents),
    });
    throw generationFailureDetails(normalized, generation, triggerKind);
  }
}

export async function settleResumePreparationFailure(error, context, { store, executionFence } = {}) {
  const generationId = error?.details?.generationId;
  if (!store || !generationId) return false;
  const reasonCode = error.code === "candidate_original_resume_missing"
    ? "candidate_original_resume_missing"
    : "resume_preparation_failed";
  const triggerKind = error?.details?.triggerKind || context?.job?.checkpoint?.trigger_kind || "initial";
  const hasPriorArtifact = Boolean(error?.details?.priorArtifactId);
  if (triggerKind === "regenerate" || hasPriorArtifact) {
    await store.failRegeneration({ generationId, reasonCode, safeDetail: safeFailureDetail(error), executionFence });
  } else {
    await store.failInitialGeneration({ generationId, reasonCode, safeDetail: safeFailureDetail(error), executionFence });
  }
  return true;
}

export const resumePipelineInternals = Object.freeze({
  artifactMetadata,
  effectiveStrategyInstructions,
  layoutRetryCheckpoint,
  safeFailureDetail,
  officialBrandAsset,
  stageInputDigest,
  supplementOcrStage,
  validatorPhaseForecast,
  validatorUsageAudits,
});
