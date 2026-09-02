import assert from "node:assert/strict";
import test from "node:test";

import {
  createGenerationBudget,
  forecastModelCostCents,
  ResumePipelineError,
} from "../api/submissions-v2/_lib/resume/pipeline-runtime.mjs";
import {
  extractPdfWithRenderer,
  renderResumeWithService,
} from "../api/submissions-v2/_lib/resume/pipeline-renderer.mjs";
import {
  processResumeSupplements,
  scanSupplementForMalware,
} from "../api/submissions-v2/_lib/resume/pipeline-supplements.mjs";
import { createResumePipelineStore } from "../api/submissions-v2/_lib/resume/pipeline-store.mjs";
import {
  runResumePreparation,
  settleResumePreparationFailure,
} from "../api/submissions-v2/_lib/resume/pipeline.mjs";
import { sha256 } from "../api/submissions-v2/_lib/resume/source-bundle.mjs";
import {
  createWorkerHandlers,
  WORKER_JOB_KINDS,
  workerHandlerInternals,
} from "../submissions-v2-worker/worker-handlers.mjs";
import {
  proofReaderInternals,
  readExactSubmissionProof,
  readExactSubmissionProofs,
} from "../submissions-v2-worker/proof-reader.mjs";
import { runClaimedJob } from "../submissions-v2-worker/runner.mjs";

const NOW = new Date("2026-08-31T20:00:00.000Z");
const RENDER_ENV = {
  SUBMISSIONS_V2_RENDERER_URL: "https://renderer.invalid",
  SUBMISSIONS_V2_RENDERER_KEY: "k".repeat(32),
};

function fakeSql(onQuery = async () => []) {
  const sql = async (strings, ...values) => onQuery(strings.join("?"), values);
  sql.json = (value) => value;
  sql.array = (value) => value;
  sql.begin = async (callback) => callback(sql);
  return sql;
}

function context(kind, {
  subjectType = "pair",
  subjectId = "pair-1",
  checkpoint = {},
  attemptCount = 1,
  maxAttempts = 3,
} = {}) {
  const checkpoints = [];
  return {
    checkpoints,
    value: {
      job: {
        id: `job-${kind}`,
        kind,
        subject_type: subjectType,
        subject_id: subjectId,
        checkpoint,
        attempt_count: attemptCount,
        max_attempts: maxAttempts,
      },
      workerId: "worker-1",
      fencingToken: 8,
      controlEpoch: 12,
      signal: new AbortController().signal,
      checkpoint: async (value) => { checkpoints.push(value); return value; },
    },
  };
}

function handlerSet(overrides = {}) {
  const { repository: repositoryOverride = {}, sql: sqlOverride, ...rest } = overrides;
  const sql = sqlOverride || fakeSql();
  const repository = {
    recordSourceHealth: async () => ({}),
    duePrivateObjectReservations: async () => [],
    markPrivateObjectReservationPurged: async () => ({}),
    releasePrivateObjectReservationCleanup: async () => ({}),
    dueUploadReservations: async () => [],
    markUploadReservationPurged: async () => ({}),
    releaseUploadReservationCleanup: async () => ({}),
    releaseQuarantinedSupplementCleanup: async () => ({}),
    ...repositoryOverride,
  };
  return createWorkerHandlers({
    env: {},
    sql,
    repository,
    service: { processSignal: async () => ({ created_count: 0 }) },
    resumeStore: {},
    runResume: async () => ({ checkpoint: { stage: "complete" } }),
    settleResumeFailure: async () => true,
    candidatePage: async () => ({ rows: [], next_cursor: null }),
    activeRoles: async () => ({ rows: [], confirmed_at: NOW.toISOString() }),
    curatedPopulation: async () => [],
    curatedCandidate: async () => [],
    collectSources: async () => ({ schemaVersion: "raydar.submissions-v2.source-bundle.v1", sourceDigest: "digest", readiness: { canGenerate: false } }),
    extractPdf: async () => ({ text: "resume", pageCount: 1 }),
    masterInbox: async () => ({ ok: true }),
    proofReader: async () => null,
    notify: async () => ({ receipt: "receipt" }),
    fetchImpl: async () => { throw new Error("unexpected fetch"); },
    sleepImpl: async () => {},
    deleteObject: async () => {},
    sourceLease: {
      claimSourceCursor: async () => null,
      commitSourceCursor: async () => null,
      releaseSourceCursor: async () => null,
    },
    now: () => new Date(NOW),
    ...rest,
  });
}

test("resume budget reserves pessimistic model cost and fails closed at two dollars", () => {
  const forecast = forecastModelCostCents({
    model: "claude-opus-5",
    input: "supported source context",
    maximumOutputTokens: 12_000,
    attempts: 2,
  });
  assert.equal(forecast, 61);
  const budget = createGenerationBudget({ deadlineAt: 10_000, now: () => 1_000 });
  budget.reserve(150);
  assert.throws(
    () => budget.reserve(51),
    (error) => error.code === "generation_budget_exhausted" && error.retryable === false,
  );
  assert.equal(budget.spentCents, 150);
});

test("resume budget and unknown model prices fail closed before a provider call", () => {
  const expired = createGenerationBudget({ deadlineAt: 1_000, now: () => 1_000 });
  assert.throws(() => expired.assertTime(), (error) => error.code === "generation_deadline_exhausted");
  assert.throws(
    () => forecastModelCostCents({ model: "unapproved-model", input: "x", maximumOutputTokens: 1 }),
    (error) => error.code === "model_price_unconfigured",
  );
});

test("renderer extraction sends the pinned contract and verifies the source digest", async () => {
  const pdf = Buffer.from("%PDF-1.7\nfixture");
  let request;
  const result = await extractPdfWithRenderer(pdf, {
    env: RENDER_ENV,
    fetchImpl: async (url, init) => {
      request = { url, init, body: JSON.parse(init.body) };
      return new Response(JSON.stringify({
        ok: true,
        schemaVersion: "raydar.resume.extract-result.v1",
        pdfSha256: sha256(pdf),
        text: "Candidate resume text",
        pageCount: 1,
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  assert.equal(request.url, "https://renderer.invalid/extract-v2");
  assert.equal(request.body.schema_version, "raydar.resume.extract-request.v1");
  assert.equal(request.init.headers.authorization, `Bearer ${RENDER_ENV.SUBMISSIONS_V2_RENDERER_KEY}`);
  assert.deepEqual(result, { text: "Candidate resume text", pageCount: 1 });
});

test("renderer output is accepted only when every returned artifact digest matches", async () => {
  const pdf = Buffer.from("%PDF-1.7\nrendered");
  const atsText = "Jane Doe\nEngineer";
  const pdfText = "Jane Doe Engineer";
  const expectedAstSha256 = "a".repeat(64);
  const fetchImpl = async () => new Response(JSON.stringify({
    ok: true,
    schemaVersion: "raydar.resume.render-result.v1",
    astSha256: expectedAstSha256,
    practice: false,
    pdfBase64: pdf.toString("base64"),
    pdfSha256: sha256(pdf),
    atsText,
    atsSha256: sha256(atsText),
    pdfExtractedText: pdfText,
    pdfTextSha256: sha256(pdfText),
  }), { status: 200 });
  const rendered = await renderResumeWithService({
    renderId: "render-1",
    ast: { schema_version: "fixture" },
    validatedClaimIds: [],
    expectedAstSha256,
  }, { env: RENDER_ENV, fetchImpl });
  assert.deepEqual(rendered.pdfBytes, pdf);

  await assert.rejects(
    () => renderResumeWithService({ renderId: "render-2", ast: {}, validatedClaimIds: [], expectedAstSha256 }, {
      env: RENDER_ENV,
      fetchImpl: async () => new Response(JSON.stringify({
        ok: true,
        schemaVersion: "raydar.resume.render-result.v1",
        astSha256: expectedAstSha256,
        practice: false,
        pdfBase64: pdf.toString("base64"),
        pdfSha256: "0".repeat(64),
        atsText,
        atsSha256: sha256(atsText),
        pdfExtractedText: pdfText,
        pdfTextSha256: sha256(pdfText),
      }), { status: 200 }),
    }),
    (error) => error.code === "resume_renderer_digest_mismatch",
  );
});

test("pending PDF supplements are integrity-checked, parsed, read back, and made available", async () => {
  const bytes = Buffer.from("%PDF-1.7\nfixture supplement");
  const objects = new Map([["private/upload.pdf", { bytes, content_type: "application/pdf" }]]);
  const updates = [];
  const row = {
    id: "supplement-pdf",
    object_key: "private/upload.pdf",
    mime_type: "application/pdf",
    size_bytes: bytes.length,
    digest: sha256(bytes),
    scan_state: "pending",
    parse_state: "pending",
  };
  const result = await processResumeSupplements([row], {
    budget: { assertTime() {} },
    readObject: async (key) => objects.get(key),
    putObject: async (key, value, contentType) => { objects.set(key, { bytes: Buffer.from(value), content_type: contentType }); },
    scanSupplement: async () => ({ verdict: "clean" }),
    extractPdf: async () => ({ text: "Verified PDF context", pageCount: 1 }),
    reserveObject: async (input) => ({ id: "reservation-pdf", write_fencing_token: 1, ...input }),
    updateSupplement: async (value) => updates.push(value),
  });
  assert.equal(result.length, 1);
  assert.equal(updates[0].scanState, "clean");
  assert.equal(updates[0].parseState, "parsed");
  assert.deepEqual(updates[0].objectReservation, { id: "reservation-pdf", digest: sha256(Buffer.from("Verified PDF context")), write_fencing_token: 1 });
  assert.match(updates[0].extractedTextObjectKey, /^submissions\/resumes\/v2\/supplement_text\//u);
  assert.equal(objects.get(updates[0].extractedTextObjectKey).bytes.toString("utf8"), "Verified PDF context");
});

test("pending image supplements use bounded transcription cost and reach parsed instead of staying pending", async () => {
  const bytes = Buffer.from([0xff, 0xd8, 0xff, ...Buffer.from("image fixture")]);
  const objects = new Map([["private/upload.jpg", { bytes, content_type: "image/jpeg" }]]);
  const updates = [];
  const reservations = [];
  const budget = {
    spentCents: 0,
    assertTime() {},
    reserve(value) { reservations.push(value); this.spentCents += value; },
  };
  await processResumeSupplements([{
    id: "supplement-image",
    object_key: "private/upload.jpg",
    mime_type: "image/jpeg",
    size_bytes: bytes.length,
    digest: sha256(bytes),
    scan_state: "pending",
    parse_state: "pending",
  }], {
    budget,
    readObject: async (key) => objects.get(key),
    putObject: async (key, value, contentType) => { objects.set(key, { bytes: Buffer.from(value), content_type: contentType }); },
    scanSupplement: async () => ({ verdict: "clean" }),
    extractImage: async () => ({ text: "Visible image context" }),
    reserveObject: async (input) => ({ id: "reservation-image", write_fencing_token: 1, ...input }),
    updateSupplement: async (value) => updates.push(value),
  });
  assert.equal(reservations.length, 1);
  assert.ok(reservations[0] > 0 && reservations[0] <= 200);
  assert.equal(updates[0].scanState, "clean");
  assert.equal(updates[0].parseState, "parsed");
});

test("unsafe supplements are rejected terminally and transient parsing exhausts to failed", async () => {
  const invalid = Buffer.from("not a supported file");
  const rejected = [];
  await assert.rejects(
    () => processResumeSupplements([{
      id: "supplement-invalid",
      object_key: "private/invalid.pdf",
      mime_type: "application/pdf",
      size_bytes: invalid.length,
      digest: sha256(invalid),
      scan_state: "pending",
      parse_state: "pending",
    }], {
      readObject: async () => ({ bytes: invalid, content_type: "application/pdf" }),
      scanSupplement: async () => assert.fail("magic mismatch must fail before scanner"),
      reserveObject: async (input) => ({ id: "reservation-invalid", write_fencing_token: 1, ...input }),
      updateSupplement: async (value) => rejected.push(value),
    }),
    (error) => error.code === "supplement_magic_rejected" && error.retryable === false,
  );
  assert.equal(rejected[0].scanState, "rejected");
  assert.equal(rejected[0].parseState, "failed");

  const image = Buffer.from([0xff, 0xd8, 0xff, ...Buffer.from("retry fixture")]);
  const failed = [];
  await assert.rejects(
    () => processResumeSupplements([{
      id: "supplement-retry",
      object_key: "private/retry.jpg",
      mime_type: "image/jpeg",
      size_bytes: image.length,
      digest: sha256(image),
      scan_state: "pending",
      parse_state: "pending",
    }], {
      attemptCount: 3,
      maxAttempts: 3,
      budget: { spentCents: 0, assertTime() {}, reserve() {} },
      readObject: async () => ({ bytes: image, content_type: "image/jpeg" }),
      scanSupplement: async () => ({ verdict: "clean" }),
      extractImage: async () => { throw new ResumePipelineError("ocr_transient", "OCR unavailable.", { retryable: true }); },
      reserveObject: async (input) => ({ id: "reservation-retry", write_fencing_token: 1, ...input }),
      updateSupplement: async (value) => failed.push(value),
    }),
    (error) => error.code === "ocr_transient" && error.retryable === false,
  );
  assert.equal(failed[0].scanState, "failed");
  assert.equal(failed[0].parseState, "failed");
});

test("malware scan is mandatory, authenticated, and digest-bound before parsing", async () => {
  const bytes = Buffer.from("scanner fixture");
  const env = {
    SUBMISSIONS_V2_MALWARE_SCANNER_URL: "https://scanner.invalid/v1/scan",
    SUBMISSIONS_V2_MALWARE_SCANNER_KEY: "s".repeat(32),
  };
  let request;
  const clean = await scanSupplementForMalware(bytes, "application/pdf", {
    env,
    fetchImpl: async (url, init) => {
      request = { url, init, body: JSON.parse(init.body) };
      return new Response(JSON.stringify({
        ok: true,
        schemaVersion: "raydar.malware-scan.result.v1",
        contentSha256: sha256(bytes),
        verdict: "clean",
        engine: "ClamAV",
        signatureVersion: "daily-2026-08-31",
        scannedAt: NOW.toISOString(),
      }), { status: 200 });
    },
  });
  assert.equal(clean.verdict, "clean");
  assert.equal(request.body.schema_version, "raydar.malware-scan.request.v1");
  assert.equal(request.body.content_sha256, sha256(bytes));
  assert.equal(request.init.headers.authorization, `Bearer ${env.SUBMISSIONS_V2_MALWARE_SCANNER_KEY}`);

  await assert.rejects(
    () => scanSupplementForMalware(bytes, "application/pdf", {
      env,
      fetchImpl: async () => new Response(JSON.stringify({
        ok: true,
        schemaVersion: "raydar.malware-scan.result.v1",
        contentSha256: sha256(bytes),
        verdict: "infected",
        engine: "ClamAV",
        signatureVersion: "daily-2026-08-31",
      }), { status: 200 }),
    }),
    (error) => error.code === "supplement_malware_rejected" && error.retryable === false,
  );
  await assert.rejects(
    () => scanSupplementForMalware(bytes, "application/pdf", { env: {} }),
    (error) => error.code === "supplement_scanner_not_configured" && error.retryable === false,
  );
});

test("initial generation blocks only on a missing candidate-original resume and keeps failure context", async () => {
  const checkpoints = new Map();
  const updates = [];
  const store = {
    loadPairContext: async () => ({
      pair: { id: "pair-1", candidate_user_id: "candidate-1", role_id: "role-1", state_version: 4, current_artifact_id: null },
      supplements: [],
      versionInstructions: "",
      knownRaydarDigests: [],
    }),
    startGeneration: async () => ({
      id: "generation-1",
      status: "queued",
      generation_version: 1,
      expected_pair_version: 4,
      source_digest: null,
      deadline_at: new Date(NOW.getTime() + 5 * 60_000).toISOString(),
      budget_cents: 200,
      spent_cents: 0,
      prior_artifact_id: null,
    }),
    loadCheckpoint: async (reference) => checkpoints.get(reference.key) || null,
    saveCheckpoint: async ({ generationId, stage, value }) => {
      const reference = { key: `${generationId}:${stage}`, digest: sha256(JSON.stringify(value)), context: stage };
      checkpoints.set(reference.key, value);
      return reference;
    },
    recordStage: async () => ({}),
    updateGeneration: async (value) => { updates.push(value); return value; },
    persistSources: async () => [],
    setGenerationDigests: async () => ({}),
  };
  const ctx = context("prepare_resume", { checkpoint: { expected_pair_version: 4 } }).value;
  await assert.rejects(
    () => runResumePreparation(ctx, {
      store,
      collectSources: async () => ({
        schemaVersion: "raydar.submissions-v2.source-bundle.v1",
        sourceDigest: "source-digest",
        readiness: { canGenerate: false, blocker: { reasonCode: "candidate_original_resume_missing" } },
        sources: [],
      }),
      now: () => NOW.getTime(),
    }),
    (error) => error.code === "candidate_original_resume_missing"
      && error.retryable === false
      && error.details.generationId === "generation-1"
      && error.details.triggerKind === "initial",
  );
  assert.ok(updates.some((row) => row.stage === "collect"));
});

test("resume failure settlement preserves an existing resume on regeneration", async () => {
  const calls = [];
  const store = {
    failInitialGeneration: async (value) => calls.push(["initial", value]),
    failRegeneration: async (value) => calls.push(["regenerate", value]),
  };
  const error = Object.assign(new ResumePipelineError("resume_preparation_failed", "safe failure"), {
    details: { generationId: "generation-2", triggerKind: "regenerate", priorArtifactId: "artifact-1" },
  });
  assert.equal(await settleResumePreparationFailure(error, {}, { store }), true);
  assert.equal(calls[0][0], "regenerate");
  assert.equal(calls[0][1].reasonCode, "resume_preparation_failed");
});

test("missing original resume routes to review without the technical-failure Slack alert", async () => {
  let notificationInserts = 0;
  const sql = fakeSql(async (query) => {
    if (query.includes("select j.id from submissions_v2.jobs")) return [{ id: "job-prepare-resume" }];
    if (query.includes("from submissions_v2.resume_generations")) {
      return [{ id: "generation-1", pair_id: "pair-1", expected_pair_version: 3 }];
    }
    if (query.includes("from submissions_v2.candidate_role_pairs")) {
      return [{ id: "pair-1", state_version: 3, intent_state: "interested", workflow_state: "preparing_resume", submission_status: "none" }];
    }
    if (query.includes("update submissions_v2.candidate_role_pairs")) {
      return [{ id: "pair-1", state_version: 4, intent_state: "interested", workflow_state: "needs_review", submission_status: "none" }];
    }
    if (query.includes("insert into submissions_v2.notification_outbox")) notificationInserts += 1;
    return [];
  });
  const store = createResumePipelineStore({ sql, repository: {} });
  const executionFence = { jobId: "job-prepare-resume", workerId: "worker-1", fencingToken: 8, controlEpoch: 12 };
  await store.failInitialGeneration({
    generationId: "generation-1",
    reasonCode: "candidate_original_resume_missing",
    safeDetail: "Add the candidate's original resume in Paraform, then Recheck.",
    executionFence,
  });
  assert.equal(notificationInserts, 0);
  await store.failInitialGeneration({
    generationId: "generation-1",
    reasonCode: "resume_preparation_failed",
    safeDetail: "Resume preparation failed safely.",
    executionFence,
  });
  assert.equal(notificationInserts, 1);
});

test("worker exposes exactly the twelve canonical job kinds", () => {
  assert.deepEqual(WORKER_JOB_KINDS, [
    "classify_email_reply", "prepare_resume", "recheck_pair", "reconcile_master_inbox",
    "reconcile_curated", "index_candidates", "index_roles", "proof_reconcile",
    "deliver_notification", "source_health", "daily_digest", "purge",
  ]);
  assert.deepEqual(Object.keys(handlerSet()).sort(), [...WORKER_JOB_KINDS].sort());
});

test("candidate-index pages share one durable source-fenced cycle across hourly jobs", async () => {
  const continuationKeys = [];
  let sourceCheckpoint = {};
  let sourceFencingToken = 6;
  const sql = fakeSql(async (query, values) => {
    if (query.includes("from submissions_v2.runtime_controls")) return [{ control_epoch: 6 }];
    if (query.includes("insert into submissions_v2.jobs")) {
      continuationKeys.push(values.find((value) => String(value).startsWith("index-candidates:")));
      return [{ id: `continuation-${continuationKeys.length}` }];
    }
    return [];
  });
  const repository = {
    upsertCandidateIndex: async (rows, options) => {
      assert.equal(options.sourceFence.sourceKey, "candidate_index");
      assert.equal(options.sourceFence.fencingToken, sourceFencingToken);
      return { changed_count: rows.length };
    },
    recordSourceHealth: async () => ({}),
  };
  const candidatePage = async (cursor) => ({ rows: [{ candidate_user_id: `candidate-${cursor}` }], next_cursor: Number(cursor) + 1 });
  const sourceLease = {
    claimSourceCursor: async () => ({ checkpoint: sourceCheckpoint, fencing_token: ++sourceFencingToken, last_full_success_at: null }),
    commitSourceCursor: async (value) => { sourceCheckpoint = value.checkpoint; return { checkpoint: sourceCheckpoint }; },
    releaseSourceCursor: async () => assert.fail("unexpected release"),
  };
  const handlers = handlerSet({ sql, repository, candidatePage, sourceLease });
  const first = context("index_candidates", { subjectType: "source", subjectId: "candidate_index" });
  first.value.job.id = "hourly-cycle-a";
  const firstResult = await handlers.index_candidates(first.value);
  const second = context("index_candidates", { subjectType: "source", subjectId: "candidate_index" });
  second.value.job.id = "hourly-cycle-b";
  const secondResult = await handlers.index_candidates(second.value);
  assert.equal(firstResult.checkpoint.cursor, 5);
  assert.equal(firstResult.checkpoint.cycle_id, "hourly-cycle-a");
  assert.equal(secondResult.checkpoint.cursor, 10);
  assert.equal(secondResult.checkpoint.cycle_id, "hourly-cycle-a");
  assert.equal(continuationKeys.length, 2);
  assert.notEqual(continuationKeys[0], continuationKeys[1]);
});

test("email classification delegates by immutable signal id and checkpoints only safe metadata", async () => {
  let signalId;
  let overrides;
  const handlers = handlerSet({
    service: { processSignal: async (id, value) => { signalId = id; overrides = value; return { created_count: 1 }; } },
  });
  const ctx = context("classify_email_reply", {
    subjectType: "signal",
    subjectId: "signal-1",
    checkpoint: { candidate_id: "candidate-1", role_ids: ["role-2", "role-1", "role-2"] },
  });
  const result = await handlers.classify_email_reply(ctx.value);
  assert.equal(signalId, "signal-1");
  assert.equal(overrides.candidateId, "candidate-1");
  assert.deepEqual(overrides.roleIds, ["role-2", "role-1"]);
  assert.deepEqual(overrides.executionFence, {
    jobId: "job-classify_email_reply", workerId: "worker-1", fencingToken: 8, controlEpoch: 12,
  });
  assert.equal(typeof overrides.beforeApply, "function");
  assert.equal(result.checkpoint.created_count, 1);
  assert.deepEqual(Object.keys(result.checkpoint).sort(), ["candidate_id", "created_count", "role_ids", "signal_id", "stage"]);
});

test("resume worker retries transient failures but routes terminal attempts once", async () => {
  const failure = new ResumePipelineError("provider_unavailable", "Provider unavailable.", { retryable: true });
  const transient = handlerSet({ runResume: async () => { throw failure; } });
  await assert.rejects(
    () => transient.prepare_resume(context("prepare_resume", { attemptCount: 1, maxAttempts: 3 }).value),
    (error) => error.code === "provider_unavailable" && error.retryable === true,
  );

  let settled = 0;
  const terminal = handlerSet({
    runResume: async () => { throw failure; },
    settleResumeFailure: async () => { settled += 1; return true; },
  });
  const result = await terminal.prepare_resume(context("prepare_resume", { attemptCount: 3, maxAttempts: 3 }).value);
  assert.equal(settled, 1);
  assert.equal(result.checkpoint.terminal_routed, true);
  assert.equal(result.checkpoint.safe_failure_code, "provider_unavailable");
});

test("resume worker closes only the timed-out generation before an automatic retry", async () => {
  const failure = Object.assign(
    new ResumePipelineError("generation_deadline_exhausted", "Resume preparation reached its five-minute deadline.", { retryable: true }),
    { details: { generationId: "generation-timeout", triggerKind: "retry", priorArtifactId: null } },
  );
  const abandoned = [];
  const handlers = handlerSet({
    runResume: async () => { throw failure; },
    resumeStore: { abandonGenerationForRetry: async (value) => abandoned.push(value) },
  });
  await assert.rejects(
    () => handlers.prepare_resume(context("prepare_resume", { attemptCount: 1, maxAttempts: 3 }).value),
    (error) => error.code === "generation_deadline_exhausted" && error.retryable === true,
  );
  assert.equal(abandoned.length, 1);
  assert.equal(abandoned[0].generationId, "generation-timeout");
  assert.equal(abandoned[0].reasonCode, "generation_deadline_exhausted");
});

test("recheck leaves the pair in review until the candidate-original resume is readable", async () => {
  let resumed = 0;
  const handlers = handlerSet({
    resumeStore: {
      loadPairContext: async () => ({ pair: { candidate_user_id: "candidate-1", role_id: "role-1", state_version: 2 }, knownRaydarDigests: [] }),
      resumeAfterRecheck: async () => { resumed += 1; return {}; },
    },
    collectSources: async () => ({
      schemaVersion: "raydar.submissions-v2.source-bundle.v1",
      sourceDigest: "digest",
      readiness: { canGenerate: false },
    }),
  });
  const result = await handlers.recheck_pair(context("recheck_pair", { checkpoint: { expected_pair_version: 2 } }).value);
  assert.equal(result.checkpoint.stage, "original_resume_still_missing");
  assert.equal(resumed, 0);
});

test("curated reconciliation uses a leased, paced population batch and advances only after apply", async () => {
  const order = [];
  let commit;
  const repository = {
    applyCuratedObservations: async (observations, options) => {
      order.push("apply");
      assert.equal(options.seed, true);
      assert.equal(observations.length, 2);
      return observations.map(() => ({ applied: true }));
    },
    recordSourceHealth: async () => ({}),
  };
  const handlers = handlerSet({
    repository,
    curatedPopulation: async () => [{ candidateUserId: "candidate-b" }, { candidateUserId: "candidate-a" }],
    curatedCandidate: async (candidateUserId) => [{ role_id: "role-1", status: candidateUserId === "candidate-a" ? "APPLIED_TO_ROLE" : "NOT_INTERESTED" }],
    sourceLease: {
      claimSourceCursor: async () => ({ checkpoint: { cursor: 0 }, fencing_token: 7, last_full_success_at: null }),
      commitSourceCursor: async (value) => { order.push("commit"); commit = value; return { ok: true }; },
      releaseSourceCursor: async () => assert.fail("unexpected release"),
    },
  });
  const result = await handlers.reconcile_curated(context("reconcile_curated", { subjectType: "source", subjectId: "curated" }).value);
  assert.deepEqual(order, ["apply", "commit"]);
  assert.equal(commit.fencingToken, 7);
  assert.equal(commit.checkpoint.cursor, 0);
  assert.equal(commit.fullSuccess, true);
  assert.equal(result.checkpoint.observation_count, 2);
});

test("proof reads require exact candidate and role ids and retain an evidence digest", async () => {
  const calls = [];
  const pair = { id: "pair-1", candidate_user_id: "candidate-1", role_id: "role-1" };
  const proof = await readExactSubmissionProof(pair, {
    now: new Date("2026-07-29T12:00:00.000Z"),
    trpcGetImpl: async (path, input) => {
      calls.push([path, input]);
      if (path === "roleSlots.getMySingleSubmissionData") return {
        latestSingleSubmissions: [
          { applicationId: "wrong-role", candidateUserId: "candidate-1", roleId: "role-2", status: "SUBMITTED" },
          { applicationId: "application-1", candidateUserId: "candidate-1", roleId: "role-1", status: "SUBMITTED", submittedAt: "2026-07-28T18:00:00.000Z" },
        ],
      };
      return [];
    },
  });
  assert.equal(calls[0][1].weekStart, "2026-07-27T07:00:00.000Z");
  assert.equal(proof.applicationId, "application-1");
  assert.equal(proof.authoritativePath, "roleSlots.getMySingleSubmissionData");
  assert.match(proof.evidenceDigest, /^[a-f0-9]{64}$/u);

  const noFuzzyProof = await readExactSubmissionProof(pair, {
    trpcGetImpl: async (path) => path === "roleSlots.getMySingleSubmissionData"
      ? { latestSingleSubmissions: [{ applicationId: "application-2", candidateUserId: "candidate-1", roleId: "role-other", status: "SUBMITTED" }] }
      : [],
  });
  assert.equal(noFuzzyProof, null);

  const exactButUnsubmitted = await readExactSubmissionProof(pair, {
    trpcGetImpl: async (path) => path === "roleSlots.getMySingleSubmissionData"
      ? { latestSingleSubmissions: [{ applicationId: "application-pending", candidateUserId: "candidate-1", roleId: "role-1", status: "PENDING", createdAt: "2026-07-28T18:00:00.000Z" }] }
      : [],
  });
  assert.equal(exactButUnsubmitted, null);

  const requestWithoutApplication = await readExactSubmissionProof(pair, {
    trpcGetImpl: async (path) => path === "submissionRequest.getRecruiterSubmissionRequestHistory"
      ? [{ id: "request-not-application", state: "SUBMITTED", created_at: "2026-07-28T18:00:00.000Z", candidate: { candidate_user_id: "candidate-1" }, role: { id: "role-1" } }]
      : { latestSingleSubmissions: [], allRecentSingleSubmissions: [] },
  });
  assert.equal(requestWithoutApplication, null);

  await assert.rejects(
    () => readExactSubmissionProofs([pair], { trpcGetImpl: async () => null }),
    (error) => error.code === "submission_ledger_shape_invalid",
  );
  await assert.rejects(
    () => readExactSubmissionProofs([pair], {
      trpcGetImpl: async (path) => path === "roleSlots.getMySingleSubmissionData"
        ? { latestSingleSubmissions: [] }
        : {},
    }),
    (error) => error.code === "submission_history_shape_invalid",
  );
});

test("Pacific week start is correct in both daylight and standard time", () => {
  assert.equal(proofReaderInternals.mondayPacific(new Date("2026-07-29T12:00:00.000Z")), "2026-07-27T07:00:00.000Z");
  assert.equal(proofReaderInternals.mondayPacific(new Date("2026-01-07T12:00:00.000Z")), "2026-01-05T08:00:00.000Z");
});

test("submission proof reconciliation reads both authoritative Paraform surfaces only once per batch", async () => {
  let calls = 0;
  const proofs = await readExactSubmissionProofs([
    { id: "pair-1", candidate_user_id: "candidate-1", role_id: "role-1" },
    { id: "pair-2", candidate_user_id: "candidate-2", role_id: "role-2" },
  ], {
    trpcGetImpl: async (path) => {
      calls += 1;
      if (path === "roleSlots.getMySingleSubmissionData") return {
        latestSingleSubmissions: [
          { id: "application-1", candidateUserId: "candidate-1", roleId: "role-1" },
          { id: "application-2", candidateUserId: "candidate-2", roleId: "role-2" },
        ],
      };
      return [];
    },
  });
  assert.equal(calls, 2);
  assert.deepEqual(proofs.map((proof) => proof.pairId), ["pair-1", "pair-2"]);
});

test("notification delivery settles each outbox row independently", async () => {
  const settled = [];
  const pending = [
    { id: "notification-1", kind: "daily_digest", safe_payload: { interested: 2 } },
    { id: "notification-2", kind: "daily_digest", safe_payload: { needs_review: 1 } },
  ];
  let claimed;
  const repository = {
    claimNotifications: async () => {
      claimed = pending.shift() || null;
      return claimed ? [claimed] : [];
    },
    deliverNotification: async ({ deliver }) => ({ sent: true, receipt: await deliver(claimed) }),
    settleNotification: async (value) => settled.push(value),
  };
  let count = 0;
  const handlers = handlerSet({
    repository,
    notify: async () => {
      count += 1;
      if (count === 2) throw Object.assign(new Error("Slack unavailable"), { code: "slack_unavailable", deliveryOutcome: "not_sent" });
      return { receipt: "receipt-1" };
    },
  });
  const deliveryContext = context("deliver_notification", { subjectType: "source", subjectId: "slack" });
  const result = await handlers.deliver_notification(deliveryContext.value);
  assert.equal(result.checkpoint.sent_count, 1);
  assert.deepEqual(deliveryContext.checkpoints.map((checkpoint) => checkpoint.stage), [
    "notification_claim", "notification_send", "notification_claim", "notification_send", "notification_claim",
  ]);
  assert.equal(settled.length, 1);
  assert.equal(settled[0].sent, false);
  assert.equal(settled[0].errorCode, "slack_unavailable");
  assert.equal(settled[0].retryAt, "2026-08-31T20:05:00.000Z");
});

test("ordinary worker has no delete path and delegates every purge to the isolated service", async () => {
  let repositoryCalls = 0;
  const handlers = handlerSet({
    repository: new Proxy({}, { get() { repositoryCalls += 1; return async () => assert.fail("ordinary worker must not inspect or mutate purge rows"); } }),
  });
  const result = await handlers.purge(context("purge", { subjectType: "retention", subjectId: "daily" }).value);
  assert.equal(repositoryCalls, 0);
  assert.equal(result.checkpoint.stage, "purge_delegated");
  assert.equal(result.checkpoint.ordinary_worker_delete_capability, false);
});

test("Master Inbox worker request is authenticated and requires an explicit success receipt", async () => {
  const env = {
    SUBMISSIONS_V2_MASTER_INBOX_RECONCILE_URL: "https://monitor.invalid/api/master-inbox/reconcile",
    SUBMISSIONS_V2_MASTER_INBOX_WORKER_KEY: "m".repeat(32),
  };
  let request;
  const result = await workerHandlerInternals.reconcileMasterInbox({
    env,
    signal: new AbortController().signal,
    fetchImpl: async (url, init) => {
      request = { url, init };
      return new Response(JSON.stringify({ ok: true, reconciled_count: 4 }), { status: 200 });
    },
  });
  assert.equal(result.reconciled_count, 4);
  assert.equal(request.init.headers.authorization, `Bearer ${env.SUBMISSIONS_V2_MASTER_INBOX_WORKER_KEY}`);
  await assert.rejects(
    () => workerHandlerInternals.reconcileMasterInbox({
      env,
      fetchImpl: async () => new Response(JSON.stringify({ ok: false }), { status: 200 }),
    }),
    (error) => error.code === "master_inbox_reconcile_failed",
  );
});

test("runner treats a lost checkpoint or completion fence as held and never reports success", async () => {
  const job = { id: "job-1", kind: "source_health", fencing_token: 9, attempt_count: 1, max_attempts: 3, checkpoint: {} };
  let failed;
  const checkpointLost = await runClaimedJob(job, {
    workerId: "worker-1",
    controlEpoch: 5,
    handlers: { source_health: async (ctx) => { await ctx.checkpoint({ stage: "working" }); } },
    checkpointJob: async () => null,
    completeJob: async () => assert.fail("unexpected completion"),
    failJob: async (value) => { failed = value; },
  });
  assert.equal(checkpointLost.state, "failed");
  assert.equal(failed.errorCode, "execution_fence_lost");
  assert.equal(failed.retry, false);

  const completionLost = await runClaimedJob(job, {
    workerId: "worker-1",
    controlEpoch: 5,
    handlers: { source_health: async () => ({ checkpoint: { stage: "done" } }) },
    checkpointJob: async () => ({}),
    completeJob: async () => null,
    failJob: async () => assert.fail("unexpected failure"),
  });
  assert.equal(completionLost.state, "held");
});

test("runner renews a long job lease with the same control epoch and fence", async () => {
  const job = { id: "job-lease", kind: "prepare_resume", fencing_token: 14, attempt_count: 1, max_attempts: 3, checkpoint: {} };
  let heartbeatCallback;
  let heartbeatDelay;
  let heartbeatInput;
  let cancelled = false;
  const result = await runClaimedJob(job, {
    workerId: "worker-lease",
    controlEpoch: 22,
    handlers: {
      prepare_resume: async () => {
        await heartbeatCallback();
        return { checkpoint: { stage: "done" } };
      },
    },
    heartbeatJob: async (value) => { heartbeatInput = value; return { id: job.id }; },
    scheduleHeartbeat: (callback, delay) => {
      heartbeatCallback = callback;
      heartbeatDelay = delay;
      return { unref() {} };
    },
    cancelHeartbeat: () => { cancelled = true; },
    checkpointJob: async () => ({}),
    completeJob: async () => ({}),
    failJob: async () => assert.fail("unexpected failure"),
  });
  assert.equal(result.state, "succeeded");
  assert.equal(heartbeatDelay, 60_000);
  assert.deepEqual(heartbeatInput, {
    jobId: "job-lease",
    workerId: "worker-lease",
    fencingToken: 14,
    controlEpoch: 22,
    leaseSeconds: 300,
  });
  assert.equal(cancelled, true);
});
