import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import assert from "node:assert/strict";

import {
  autoEligibility,
  automationApprovalSource,
  automationCallCutoff,
  automationCallReadiness,
  automationConfig,
  automationExecutionEnabled,
  automationFailureTransition,
  automationFreezeDecision,
  automationGraceDecision,
  automationRetryDecision,
  automationStepSuccessTransition,
  enqueueOrganicExceptions,
  needsPhase1Routing,
  resolveCallEndedAt,
  trackedAutomationStep,
  unstoredPhase1FreezeDecision,
} from "../api/paraai/_lib/auto.mjs";
import { enforceTranscriptSemantics } from "../api/paraai/_lib/extract.mjs";
import { buildPreferences } from "../api/paraai/_lib/pipeline.mjs";
import {
  isCanonicalScreenerSource,
  isRecallCompletionSignal,
  recallWebhookEvent,
  verifyRecallWebhook,
} from "../api/paraai/_lib/recall-webhook.mjs";
import { handleRecallWebhook } from "../api/paraai/recall-webhook.mjs";

const webhookSecretBytes = Buffer.from("recall-webhook-test-secret");
const webhookSecret = `whsec_${webhookSecretBytes.toString("base64")}`;
const webhookId = "msg_test_123";
const webhookTimestamp = 1_784_240_000;

function signedHeaders(payload, {
  id = webhookId,
  timestamp = webhookTimestamp,
  secretBytes = webhookSecretBytes,
} = {}) {
  const signature = createHmac("sha256", secretBytes)
    .update(`${id}.${timestamp}.${payload}`)
    .digest("base64");
  return {
    "webhook-id": id,
    "webhook-timestamp": String(timestamp),
    "webhook-signature": `v1,${signature}`,
  };
}

function greenJob(overrides = {}) {
  const base = {
    id: "bot_12345678",
    state: "ready_to_submit",
    callStartedAt: "2026-07-16T20:00:00.000Z",
    callSourceVerified: true,
    identity: {
      candidateUserId: "candidate-user-123",
      signals: ["linkedin", "name"],
      ambiguous: false,
    },
    submission: {
      name: "Candidate Example",
      email: "candidate@example.com",
      linkedinUrl: "https://www.linkedin.com/in/candidate-example",
      resumeUri: "s3://resumes/candidate.pdf",
      screeningCallLink: "https://monitor.raydar.xyz/c/bot_12345678",
    },
    reviewPreferences: {
      locations: ["new_york"],
      workplaceTypes: ["REMOTE"],
      idealFundingRounds: ["SERIES_A"],
      requiresSponsorship: ["Not available"],
      salaryMin: 200000,
    },
    reviewPolicy: { locationSource: "screening_call" },
    extracted: {
      marketStatus: {
        activelyOnMarket: true,
        openToOpportunities: true,
        consentToTalentNetwork: true,
        evidence: ["I am actively looking and open to a new role."],
        evidenceVerified: true,
        consentVerifiedFromTranscript: true,
      },
    },
  };
  return {
    ...base,
    ...overrides,
    identity: { ...base.identity, ...(overrides.identity || {}) },
    submission: { ...base.submission, ...(overrides.submission || {}) },
    reviewPreferences: { ...base.reviewPreferences, ...(overrides.reviewPreferences || {}) },
    reviewPolicy: { ...base.reviewPolicy, ...(overrides.reviewPolicy || {}) },
    extracted: {
      ...base.extracted,
      ...(overrides.extracted || {}),
      marketStatus: {
        ...base.extracted.marketStatus,
        ...(overrides.extracted?.marketStatus || {}),
      },
    },
  };
}

const eligibilityConfig = {
  strictScreenerSource: true,
};

test("Recall webhook verification accepts an authentic raw-body signature", () => {
  const payload = JSON.stringify({ event: "transcript.done", data: { bot_id: "bot_12345678" } });
  assert.deepEqual(verifyRecallWebhook({
    secret: webhookSecret,
    headers: signedHeaders(payload),
    payload,
    nowMs: webhookTimestamp * 1000,
  }), {
    id: webhookId,
    timestamp: webhookTimestamp,
  });
});

test("Recall webhook verification rejects body tampering and replayed timestamps", () => {
  const payload = JSON.stringify({ event: "transcript.done", data: { bot_id: "bot_12345678" } });
  assert.throws(
    () => verifyRecallWebhook({
      secret: webhookSecret,
      headers: signedHeaders(payload),
      payload: `${payload} `,
      nowMs: webhookTimestamp * 1000,
    }),
    (error) => error?.code === "RECALL_SIGNATURE_INVALID",
  );
  assert.throws(
    () => verifyRecallWebhook({
      secret: webhookSecret,
      headers: signedHeaders(payload),
      payload,
      nowMs: (webhookTimestamp + 301) * 1000,
    }),
    (error) => error?.code === "RECALL_TIMESTAMP_INVALID",
  );
});

test("Recall events normalize transcript and terminal bot status shapes", () => {
  assert.deepEqual(recallWebhookEvent({
    event: "TRANSCRIPT.DONE",
    data: {
      bot: {
        id: "bot_12345678",
        metadata: { source: "paraform-auto" },
      },
    },
  }), {
    event: "transcript.done",
    botId: "bot_12345678",
    status: "",
    metadata: { source: "paraform-auto" },
  });
  const terminal = recallWebhookEvent({
    type: "bot.status_change",
    data: {
      data: {
        code: "CALL_ENDED",
        bot: {
          id: "bot_87654321",
          metadata: { source: "paraform-auto" },
        },
      },
    },
  });
  assert.equal(terminal.botId, "bot_87654321");
  assert.equal(terminal.status, "call_ended");
  assert.equal(isRecallCompletionSignal(terminal), true);
  assert.equal(isRecallCompletionSignal({ event: "recording.done" }), true);
  assert.equal(isRecallCompletionSignal({ event: "bot.status_change", status: "in_call_recording" }), false);
});

test("Recall intake accepts every exact production screener dispatch path", () => {
  assert.equal(isCanonicalScreenerSource("paraform-auto"), true);
  assert.equal(isCanonicalScreenerSource("paraform-reconciliation"), true);
  assert.equal(isCanonicalScreenerSource("fyxer-guardian-n8n"), true);
  assert.equal(isCanonicalScreenerSource("paraform-auto-guardian"), true);
  assert.equal(isCanonicalScreenerSource("paraform-reconciliation-guardian"), true);
  assert.equal(isCanonicalScreenerSource("fyxer-guardian-n8n-guardian"), true);
  assert.equal(isCanonicalScreenerSource("manual-test"), false);
  assert.equal(isCanonicalScreenerSource("paraform-auto-guardian-guardian"), false);
  assert.equal(isCanonicalScreenerSource(""), false);
});

test("Recall intake remains paused until every continuous-automation gate is open", () => {
  const live = {
    enabled: true,
    detectEnabled: true,
    prepareEnabled: true,
    autoSubmitApproved: true,
    dryRun: false,
    notBeforeMs: Date.parse("2026-07-16T20:00:00.000Z"),
    phase1DeployedAtMs: Date.parse("2026-07-25T00:00:00.000Z"),
  };
  assert.equal(automationExecutionEnabled(live), true);
  for (const override of [
    { enabled: false },
    { detectEnabled: false },
    { prepareEnabled: false },
    { autoSubmitApproved: false },
    { dryRun: true },
    { notBeforeMs: null },
    { phase1DeployedAtMs: null },
  ]) {
    assert.equal(automationExecutionEnabled({ ...live, ...override }), false);
  }
  assert.equal(automationExecutionEnabled({
    ...live,
    consentRequiredAtMs: null,
  }), true, "the retired consent cutoff cannot pause automation");
});

test("automation cutoff rejects old webhook jobs but preserves explicit backfill authority", () => {
  const config = { notBeforeMs: Date.parse("2026-07-16T20:00:00.000Z") };
  const oldCall = { joinAt: "2026-07-16T19:59:59.999Z" };
  const newCall = { joinAt: "2026-07-16T20:00:00.000Z" };
  assert.deepEqual(automationCallCutoff(oldCall, config), {
    allowed: false,
    terminal: true,
    reason: "call predates automation cutoff",
  });
  assert.deepEqual(automationCallCutoff(newCall, config), {
    allowed: true,
    reason: null,
  });
  assert.deepEqual(automationCallCutoff(oldCall, config, { historicalAuthorized: true }), {
    allowed: true,
    reason: null,
  });
});

test("automation config removes consent and pins Phase 1 safety controls", () => {
  const config = automationConfig({
    PARAAI_AUTOMATION_APPROVED: "true",
    PARAAI_AUTO_DETECT_ENABLED: "true",
    PARAAI_AUTO_PREPARE_ENABLED: "true",
    PARAAI_AUTOSUBMIT_APPROVED: "true",
    PARAAI_AUTOMATION_DRY_RUN: "false",
    PARAAI_AUTO_NOT_BEFORE: "2026-07-16T20:00:00.000Z",
    PARAAI_PHASE1_DEPLOYED_AT: "2026-07-25T00:00:00.000Z",
    PARAAI_ORGANIC_EXCEPTION_BOT_IDS: "bot_12345678,invalid",
    PARAAI_RESUME_WAIT_MINUTES: "60",
    PARAAI_MAX_STEP_ATTEMPTS: "20",
    PARAAI_CONSENT_REQUIRED_AT: "invalid-retired-value",
  });
  assert.equal(config.phase1DeployedAtMs, Date.parse("2026-07-25T00:00:00.000Z"));
  assert.deepEqual([...config.organicExceptionBotIds], ["bot_12345678"]);
  assert.equal(config.resumeWaitMinutes, 60);
  assert.equal(config.maxStepAttempts, 20);
  assert.equal("consentRequiredAtMs" in config, false);
  assert.equal(automationExecutionEnabled(config), true);
});

test("Phase 3 gates are closed by default and pin one common enable anchor", () => {
  const closed = automationConfig({});
  assert.equal(closed.matchStageEnabled, false);
  assert.equal(closed.matchShadow, false);
  assert.equal(closed.curateEnabled, false);
  assert.equal(closed.enrollApproved, false);
  assert.equal(closed.matchStageEnabledAtMs, null);

  const enabledAt = "2026-07-26T00:00:00.000Z";
  const shadow = automationConfig({
    PARAAI_MATCH_STAGE_ENABLED: "true",
    PARAAI_MATCH_SHADOW: "true",
    PARAAI_CURATE_ENABLED: "false",
    PARAAI_ENROLL_APPROVED: "false",
    PARAAI_MATCH_STAGE_ENABLED_AT: enabledAt,
  });
  assert.equal(shadow.matchStageEnabled, true);
  assert.equal(shadow.matchShadow, true);
  assert.equal(shadow.curateEnabled, false);
  assert.equal(shadow.enrollApproved, false);
  assert.equal(shadow.matchStageEnabledAtMs, Date.parse(enabledAt));
});

test("call end timestamp precedence and one-hour grace are deterministic", () => {
  assert.equal(resolveCallEndedAt({
    endedAt: "2026-07-24T12:45:00.000Z",
    joinAt: "2026-07-24T12:00:00.000Z",
    durationSecs: 1800,
  }), Date.parse("2026-07-24T12:45:00.000Z"));
  assert.equal(resolveCallEndedAt({
    joinAt: "2026-07-24T12:00:00.000Z",
    durationSecs: 2700,
  }), Date.parse("2026-07-24T12:45:00.000Z"));
  assert.equal(
    resolveCallEndedAt({}, "2026-07-24T12:46:00.000Z"),
    Date.parse("2026-07-24T12:46:00.000Z"),
  );

  const job = { callEndedAt: "2026-07-24T12:45:00.000Z" };
  const config = { resumeWaitMinutes: 60 };
  assert.deepEqual(
    automationGraceDecision(job, config, Date.parse("2026-07-24T13:44:59.999Z")),
    {
      ready: false,
      dueAt: Date.parse("2026-07-24T13:45:00.000Z"),
      reason: "one-hour post-call grace period",
    },
  );
  assert.deepEqual(
    automationGraceDecision(job, config, Date.parse("2026-07-24T13:45:00.000Z")),
    {
      ready: true,
      dueAt: Date.parse("2026-07-24T13:45:00.000Z"),
      reason: null,
    },
  );
});

test("Phase 1 freezes pre-deploy jobs except explicit organic and backfill authority", () => {
  const config = {
    phase1DeployedAtMs: Date.parse("2026-07-25T00:00:00.000Z"),
    organicExceptionBotIds: new Set(["bot_except_123"]),
  };
  assert.equal(automationFreezeDecision({
    id: "bot_old_1234",
    createdAt: "2026-07-24T23:59:59.999Z",
  }, config).frozen, true);
  assert.equal(automationFreezeDecision({
    id: "bot_old_1234",
    createdAt: null,
  }, config).frozen, true);
  assert.deepEqual(automationFreezeDecision({
    id: "bot_new_1234",
    createdAt: "2026-07-25T00:00:00.000Z",
  }, config), {
    frozen: false,
    mode: "organic",
    reason: null,
  });
  assert.equal(automationFreezeDecision({
    id: "bot_except_123",
    createdAt: "2026-07-20T00:00:00.000Z",
  }, config).mode, "organic_exception");
  assert.equal(automationFreezeDecision({
    id: "bot_old_1234",
    createdAt: "2026-07-20T00:00:00.000Z",
  }, config, {
    queueSource: "authorized_backfill",
  }).mode, "authorized_backfill");

  const oldUnstored = unstoredPhase1FreezeDecision(
    "bot_old_5678",
    {
      joinAt: "2026-07-24T22:55:00.000Z",
      durationSecs: 300,
    },
    config,
  );
  assert.equal(oldUnstored.frozen, true);
  assert.equal(oldUnstored.endedAt, Date.parse("2026-07-24T23:00:00.000Z"));
  assert.equal(unstoredPhase1FreezeDecision(
    "bot_new_5678",
    {
      joinAt: "2026-07-24T23:58:00.000Z",
      durationSecs: 180,
    },
    config,
  ).frozen, false);
});

test("Phase 1 reroutes legacy ready jobs and replays only the pinned organic exceptions", async () => {
  assert.equal(needsPhase1Routing({
    state: "ready_to_submit",
    reviewPolicy: { provenance: {} },
  }), true);
  assert.equal(needsPhase1Routing({
    state: "ready_to_submit",
    reviewPolicy: { preferenceRouting: {} },
  }), false);
  assert.equal(needsPhase1Routing({
    state: "awaiting_approval",
    reviewPolicy: {},
  }), false);

  const calls = [];
  const results = await enqueueOrganicExceptions({
    config: {
      organicExceptionBotIds: new Set([
        "bot_except_123",
        "bot_except_456",
        "bot_except_789",
        "bot_except_abc",
        "bot_except_def",
        "bot_except_ghi",
      ]),
    },
    enqueueImpl: async (botId, options) => {
      calls.push({ botId, options });
      return { botId, enqueued: true };
    },
    now: 1_784_956_800_000,
    eventNonce: () => `nonce-${calls.length + 1}`,
  });
  assert.equal(results.length, 6);
  assert.deepEqual(calls.map(({ botId, options }) => ({
    botId,
    source: options.source,
    dueAt: options.dueAt,
    eventId: options.eventId,
  })), [
    {
      botId: "bot_except_123",
      source: "phase1_organic_exception",
      dueAt: 1_784_956_800_000,
      eventId: "phase1-organic:bot_except_123:nonce-1",
    },
    {
      botId: "bot_except_456",
      source: "phase1_organic_exception",
      dueAt: 1_784_956_800_000,
      eventId: "phase1-organic:bot_except_456:nonce-2",
    },
    {
      botId: "bot_except_789",
      source: "phase1_organic_exception",
      dueAt: 1_784_956_800_000,
      eventId: "phase1-organic:bot_except_789:nonce-3",
    },
    {
      botId: "bot_except_abc",
      source: "phase1_organic_exception",
      dueAt: 1_784_956_800_000,
      eventId: "phase1-organic:bot_except_abc:nonce-4",
    },
    {
      botId: "bot_except_def",
      source: "phase1_organic_exception",
      dueAt: 1_784_956_800_000,
      eventId: "phase1-organic:bot_except_def:nonce-5",
    },
    {
      botId: "bot_except_ghi",
      source: "phase1_organic_exception",
      dueAt: 1_784_956_800_000,
      eventId: "phase1-organic:bot_except_ghi:nonce-6",
    },
  ]);

  let partialCalls = 0;
  await assert.rejects(
    enqueueOrganicExceptions({
      config: { organicExceptionBotIds: new Set(["bot_except_123"]) },
      enqueueImpl: async () => { partialCalls++; },
    }),
    (error) => error?.code === "PHASE1_EXCEPTION_COUNT_INVALID",
  );
  assert.equal(partialCalls, 0);
});

test("step failure counters are durable, independent, and reset only on same-step success", () => {
  const base = {
    id: "bot_12345678",
    state: "ready_to_submit",
    automation: {},
    journal: [],
  };
  const first = automationFailureTransition(base, {
    code: "HTTP_503",
    message: "profile unavailable",
    step: "prepare",
  }, { maxAttempts: 2, now: Date.parse("2026-07-25T00:00:00.000Z") });
  assert.equal(first.automation.stepFailures.prepare.count, 1);
  assert.deepEqual(
    {
      code: first.journal.at(-1).code,
      message: first.journal.at(-1).message,
      step: first.journal.at(-1).step,
    },
    { code: "HTTP_503", message: "profile unavailable", step: "prepare" },
  );
  const other = automationFailureTransition(first, {
    code: "AUTH_EXPIRED",
    message: "session expired",
    step: "submit",
  }, { maxAttempts: 2, now: Date.parse("2026-07-25T00:01:00.000Z") });
  assert.equal(other.automation.stepFailures.prepare.count, 1);
  assert.equal(other.automation.stepFailures.submit.count, 1);
  const reset = automationStepSuccessTransition(other, "prepare");
  assert.equal(reset.automation.stepFailures.prepare, undefined);
  assert.equal(reset.automation.stepFailures.submit.count, 1);
  const ceiling = automationFailureTransition(reset, {
    code: "AUTH_EXPIRED",
    message: "session still expired",
    step: "submit",
  }, { maxAttempts: 2, now: Date.parse("2026-07-25T00:02:00.000Z") });
  assert.equal(ceiling.state, "needs_review");
  assert.equal(ceiling.reviewReasons[0].code, "technical_failure_ceiling");
  assert.match(ceiling.reviewReasons[0].message, /session still expired/);
});

test("worker step tracking preserves earlier successes when a later step fails", async () => {
  const succeeded = new Set();
  assert.equal(await trackedAutomationStep("call_read", async () => "ok", succeeded), "ok");
  await assert.rejects(
    trackedAutomationStep("prepare", async () => {
      throw new Error("profile unavailable");
    }, succeeded),
    (error) => error?.step === "prepare",
  );
  assert.deepEqual([...succeeded], ["call_read"]);
});

test("final transcript events stop retrying settled no-shows without racing late success artifacts", () => {
  const config = {
    strictScreenerSource: true,
    notBeforeMs: Date.parse("2026-07-16T20:00:00.000Z"),
  };
  const noShow = {
    joinAt: "2026-07-16T20:01:00.000Z",
    source: { isScreener: true },
    verdict: { verdict: "no_show" },
    media: { hasTranscript: false },
    transcript: [],
  };
  assert.deepEqual(automationCallReadiness(noShow, config, {
    queueSource: "recall:transcript.done",
    queueAttempts: 9,
  }), {
    ready: false,
    terminal: false,
    reason: "call artifacts are still settling",
  });
  assert.deepEqual(automationCallReadiness(noShow, config, {
    queueSource: "recall:transcript.done",
    queueAttempts: 10,
  }), {
    ready: false,
    terminal: true,
    reason: "call verdict is no_show",
  });
  assert.equal(automationCallReadiness(noShow, config, {
    queueSource: "recall:bot.done",
    queueAttempts: 4,
  }).terminal, false);
  assert.equal(automationCallReadiness(noShow, config, {
    queueSource: "recall:bot.done",
    queueAttempts: 20,
  }).terminal, true);
  for (const verdict of ["recorded", "pending", "unknown", "in_progress", "unexpected_future_verdict"]) {
    assert.equal(automationCallReadiness({
      ...noShow,
      verdict: { verdict },
    }, config, {
      queueSource: "recall:transcript.done",
      queueAttempts: 100,
    }).terminal, false, verdict);
  }

  const lateSuccess = {
    ...noShow,
    verdict: { verdict: "success" },
  };
  assert.equal(automationCallReadiness(lateSuccess, config, {
    queueSource: "recall:transcript.done",
    queueAttempts: 20,
  }).terminal, false);
  assert.deepEqual(automationCallReadiness({
    ...lateSuccess,
    media: { hasTranscript: true },
    transcript: [
      { role: "candidate", text: "I joined and I am actively exploring a new role with the right engineering team." },
      { role: "candidate", text: "I am open to discussing the opportunity and sharing the relevant details." },
    ],
  }, config, {
    queueSource: "recall:transcript.done",
    queueAttempts: 20,
  }), {
    ready: true,
    terminal: false,
    reason: null,
  });
});

test("automatic submission provenance is derived from durable queue authority", () => {
  assert.equal(automationApprovalSource("authorized_backfill"), "authorized_backfill_2026-07-16");
  assert.equal(automationApprovalSource("recall:transcript.done"), "recall_verified_automation");
  assert.equal(automationApprovalSource("recovery_status"), "recall_verified_automation");
});

test("transient pre-write failures retry with bounded backoff while proven business failures terminate", () => {
  assert.deepEqual(automationRetryDecision("AUTO_PROCESS_FAILED", "detected", 0), {
    retry: true,
    delayMs: 30_000,
  });
  assert.deepEqual(automationRetryDecision("HTTP_503", "ready_to_submit", 3), {
    retry: true,
    delayMs: 240_000,
  });
  assert.deepEqual(automationRetryDecision("PREPARE_FAILED", "error", 20), {
    retry: true,
    delayMs: 900_000,
  });
  assert.deepEqual(automationRetryDecision("NOT_SUCCESSFUL_SCREEN", "error", 0), {
    retry: false,
    delayMs: 30_000,
  });
  for (const code of [
    "ALREADY_SUBMITTED",
    "FUTURE_NEXT_STEP",
    "HAS_REPLIED",
    "ALREADY_ENROLLED",
    "INTERNAL_CANDIDATE",
  ]) {
    assert.equal(automationRetryDecision(code, "error", 0).retry, false, code);
  }
});

test("a returned preparation error carries a structured durable failure", async () => {
  const source = await readFile(new URL("../api/paraai/_lib/auto.mjs", import.meta.url), "utf8");
  assert.match(
    source,
    /if \(job\.state === "error"\)[\s\S]*normalizeFailureRecord\([\s\S]*automationRetryDecision\([\s\S]*failure,/,
  );
  assert.match(source, /persistAutomationFailure\([\s\S]*result\.failure/);
});

test("paused signed Recall completion is durably queued before a 202 acknowledgement", async () => {
  const payload = JSON.stringify({
    event: "transcript.done",
    data: {
      bot: {
        id: "bot_12345678",
        metadata: { source: "paraform-auto" },
      },
    },
  });
  const enqueued = [];
  const response = await handleRecallWebhook(new Request("https://monitor.raydar.xyz/api/paraai/recall-webhook", {
    method: "POST",
    headers: signedHeaders(payload),
    body: payload,
  }), {
    secret: webhookSecret,
    verify: (input) => verifyRecallWebhook({ ...input, nowMs: webhookTimestamp * 1000 }),
    hasStore: () => true,
    enqueue: async (botId, options) => {
      enqueued.push({ botId, options });
      return { enqueued: true, duplicate: false };
    },
    getAutomationConfig: () => ({
      enabled: true,
      detectEnabled: false,
      prepareEnabled: true,
      autoSubmitApproved: true,
      dryRun: false,
      notBeforeMs: webhookTimestamp * 1000,
      phase1DeployedAtMs: webhookTimestamp * 1000,
      resumeWaitMinutes: 60,
    }),
  });
  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), {
    ok: true,
    queued: true,
    duplicate: false,
    paused: true,
  });
  assert.equal(enqueued.length, 1);
  assert.equal(enqueued[0].botId, "bot_12345678");
  assert.equal(enqueued[0].options.source, "recall:transcript.done");
  assert.equal(enqueued[0].options.eventId, webhookId);
  assert.equal(enqueued[0].options.callEndedAt, new Date(webhookTimestamp * 1000).toISOString());
  assert.equal(enqueued[0].options.dueAt, (webhookTimestamp + 3600) * 1000);
});

test("Recall intake rejects bad signatures and ignores irrelevant events without touching the queue", async () => {
  let writes = 0;
  const enqueue = async () => { writes++; return { enqueued: true, duplicate: false }; };
  const canonical = JSON.stringify({
    event: "transcript.done",
    data: { bot: { id: "bot_12345678", metadata: { source: "paraform-auto" } } },
  });
  const invalid = await handleRecallWebhook(new Request("https://monitor.raydar.xyz/api/paraai/recall-webhook", {
    method: "POST",
    headers: signedHeaders(canonical),
    body: `${canonical} `,
  }), {
    secret: webhookSecret,
    verify: (input) => verifyRecallWebhook({ ...input, nowMs: webhookTimestamp * 1000 }),
    enqueue,
  });
  assert.equal(invalid.status, 401);

  for (const body of [
    {
      event: "transcript.processing",
      data: { bot: { id: "bot_12345678", metadata: { source: "paraform-auto" } } },
    },
    {
      event: "transcript.done",
      data: { bot: { id: "bot_12345678", metadata: { source: "manual-test" } } },
    },
  ]) {
    const payload = JSON.stringify(body);
    const response = await handleRecallWebhook(new Request("https://monitor.raydar.xyz/api/paraai/recall-webhook", {
      method: "POST",
      headers: signedHeaders(payload),
      body: payload,
    }), {
      secret: webhookSecret,
      verify: (input) => verifyRecallWebhook({ ...input, nowMs: webhookTimestamp * 1000 }),
      enqueue,
    });
    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), { ok: true, ignored: true });
  }
  assert.equal(writes, 0);
});

test("Recall asks for retry only when a canonical signed event cannot enter the durable queue", async () => {
  const payload = JSON.stringify({
    event: "bot.done",
    data: { bot: { id: "bot_12345678", metadata: { source: "paraform-auto" } } },
  });
  const request = () => new Request("https://monitor.raydar.xyz/api/paraai/recall-webhook", {
    method: "POST",
    headers: signedHeaders(payload),
    body: payload,
  });
  const base = {
    secret: webhookSecret,
    verify: (input) => verifyRecallWebhook({ ...input, nowMs: webhookTimestamp * 1000 }),
  };
  const missingStore = await handleRecallWebhook(request(), {
    ...base,
    hasStore: () => false,
  });
  assert.equal(missingStore.status, 503);
  assert.deepEqual(await missingStore.json(), { ok: false, error: "state_store_not_configured" });

  const unavailable = await handleRecallWebhook(request(), {
    ...base,
    hasStore: () => true,
    enqueue: async () => { throw new Error("offline"); },
  });
  assert.equal(unavailable.status, 503);
  assert.deepEqual(await unavailable.json(), { ok: false, error: "queue_unavailable" });
});

test("automatic eligibility admits a complete, source-verified green-lane job", () => {
  assert.deepEqual(autoEligibility(greenJob(), eligibilityConfig), {
    eligible: true,
    reasons: [],
  });
});

test("automatic eligibility never gates on consent or market evidence", () => {
  const result = autoEligibility(greenJob({
    callStartedAt: null,
    extracted: {
      marketStatus: {
        activelyOnMarket: false,
        openToOpportunities: false,
        consentToTalentNetwork: false,
        evidence: [],
        evidenceVerified: false,
        consentVerifiedFromTranscript: false,
      },
    },
  }), eligibilityConfig);
  assert.deepEqual(result, { eligible: true, reasons: [] });
});

test("automatic eligibility leaves resume handling to the timed resume gate", () => {
  const result = autoEligibility(greenJob({
    callSourceVerified: false,
    submission: { resumeUri: "" },
  }), eligibilityConfig);
  assert.equal(result.eligible, false);
  assert.deepEqual(result.reasons, ["call source"]);
});

test("OTE survives only when candidate language literally discusses OTE", () => {
  const extracted = {
    compensation: { baseMin: 180000, ote: 250000 },
  };
  assert.equal(enforceTranscriptSemantics(extracted, [
    { role: "agent", text: "Would an OTE of $250k work?" },
    { role: "candidate", text: "My target total compensation is around $250k." },
  ]).compensation.ote, null);
  assert.equal(enforceTranscriptSemantics(extracted, [
    { role: "candidate", text: "I would target $250k OTE." },
  ]).compensation.ote, 250000);
  assert.equal(enforceTranscriptSemantics(extracted, [
    { role: "candidate", text: "My on-target earnings expectation is $250k." },
  ]).compensation.ote, 250000);
});

test("widening evidence is verified against the candidate transcript and exact salary", () => {
  const rows = [
    { role: "candidate", text: "I would consider different companies, but startups are not for me." },
    { role: "candidate", text: "My old target was $160,000, but I am flexible now." },
    { role: "candidate", text: "I am not open to relocating." },
  ];
  const verified = enforceTranscriptSemantics({
    relocation: {
      open: true,
      scope: "Open to moving to Chicago.",
      evidence: "Open to moving to Chicago.",
    },
    compensation: {
      baseMin: 180000,
      baseMinIsHardFloor: true,
      baseMinEvidence: "My minimum is $180,000.",
    },
    openToStartups: true,
    startupOpennessEvidence: "I would consider startups.",
  }, rows);
  assert.equal(verified.relocation.open, false);
  assert.equal(verified.compensation.baseMinIsHardFloor, false);
  assert.equal(verified.openToStartups, false);
});

test("candidate quotes verify relocation, startup openness, and the matching hard floor amount", () => {
  const rows = [
    { role: "candidate", text: "I am open to moving to Chicago for the right job." },
    { role: "candidate", text: "I am open to startups at any stage." },
    { role: "candidate", text: "My minimum salary is $180,000." },
  ];
  const verified = enforceTranscriptSemantics({
    relocation: {
      open: true,
      scope: "Chicago",
      evidence: "I am open to moving to Chicago for the right job.",
    },
    compensation: {
      baseMin: 180000,
      baseMinIsHardFloor: true,
      baseMinEvidence: "My minimum salary is $180,000.",
    },
    openToStartups: true,
    startupOpennessEvidence: "I am open to startups at any stage.",
  }, rows);
  assert.equal(verified.relocation.open, true);
  assert.equal(verified.compensation.baseMinIsHardFloor, true);
  assert.equal(verified.openToStartups, true);
});

test("final Paraform sharing consent is verified from the adjacent candidate answer", () => {
  const extracted = {
    marketStatus: {
      activelyOnMarket: true,
      openToOpportunities: true,
      consentToTalentNetwork: true,
      evidence: ["I am actively looking right now."],
    },
  };
  const verified = enforceTranscriptSemantics(extracted, [
    { role: "candidate", text: "I am actively looking right now." },
    {
      role: "agent",
      text: "Just to confirm, are you currently open to new opportunities, and is it okay for Raydar to share your profile, resume, this screening call, and these preferences with Paraform's Talent Network so Para AI can match you?",
    },
    { role: "candidate", text: "Yes, absolutely." },
  ]);
  assert.equal(verified.marketStatus.openToOpportunities, true);
  assert.equal(verified.marketStatus.consentToTalentNetwork, true);
  assert.equal(verified.marketStatus.consentVerifiedFromTranscript, true);
  assert.equal(verified.marketStatus.evidenceVerified, true);
});

test("model-written market evidence and consent cannot survive without transcript proof", () => {
  const verified = enforceTranscriptSemantics({
    marketStatus: {
      activelyOnMarket: true,
      openToOpportunities: true,
      consentToTalentNetwork: true,
      evidence: ["I am actively looking and consent to sharing."],
    },
  }, [
    { role: "candidate", text: "I am happy in my current role." },
  ]);
  assert.deepEqual(verified.marketStatus, {
    activelyOnMarket: null,
    openToOpportunities: null,
    consentToTalentNetwork: null,
    evidence: [],
    evidenceVerified: false,
    consentVerifiedFromTranscript: false,
  });
});

test("null native OTE never becomes zero in the Para AI payload", () => {
  const preferences = buildPreferences({
    paraformLocations: ["new_york"],
    workplaceTypes: ["REMOTE"],
    compensation: { baseMin: 180000, ote: null },
    companyStages: ["SERIES_A"],
    sponsorship: { required: false, statuses: ["CITIZEN"] },
  }, {
    ote: null,
  });
  assert.equal("ote" in preferences, false);
});

test("an already-started submission can only enter read-only reconciliation", async () => {
  const pipeline = await readFile(new URL("../api/paraai/_lib/pipeline.mjs", import.meta.url), "utf8");
  const automation = await readFile(new URL("../api/paraai/_lib/auto.mjs", import.meta.url), "utf8");
  const mutation = pipeline.indexOf('trpcPost("agency.submitTalentNetworkCandidate"');
  assert.ok(mutation > 0);
  assert.ok(pipeline.indexOf("if (intent.attemptStartedAt)") < mutation);
  assert.ok(pipeline.indexOf('if (started.status !== "started")') < mutation);
  assert.match(pipeline, /SUBMISSION_ATTEMPT_ALREADY_STARTED/);
  assert.match(
    automation,
    /if \(intent && !intent\.attemptStartedAt\)[\s\S]*?submitJob\(job,[\s\S]*?reconcileSubmittedJob\(job\)/,
  );
});
