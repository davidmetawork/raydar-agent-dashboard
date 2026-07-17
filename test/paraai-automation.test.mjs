import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import assert from "node:assert/strict";

import {
  autoEligibility,
  automationApprovalSource,
  automationCallCutoff,
  automationExecutionEnabled,
  automationRetryDecision,
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
  consentRequiredAtMs: Date.parse("2026-07-16T19:00:00.000Z"),
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
    consentRequiredAtMs: Date.parse("2026-07-16T19:00:00.000Z"),
  };
  assert.equal(automationExecutionEnabled(live), true);
  for (const override of [
    { enabled: false },
    { detectEnabled: false },
    { prepareEnabled: false },
    { autoSubmitApproved: false },
    { dryRun: true },
    { notBeforeMs: null },
    { consentRequiredAtMs: null },
  ]) {
    assert.equal(automationExecutionEnabled({ ...live, ...override }), false);
  }
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

test("a returned preparation error remains queued for the retry policy", async () => {
  const source = await readFile(new URL("../api/paraai/_lib/auto.mjs", import.meta.url), "utf8");
  assert.match(
    source,
    /if \(job\.state === "error"\)[\s\S]*automationRetryDecision\(job\.error\?\.code, job\.state, queueAttempts\)/,
  );
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
      consentRequiredAtMs: webhookTimestamp * 1000,
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

test("automatic eligibility requires consent only on and after the pinned cutoff", () => {
  const withoutConsent = {
    extracted: { marketStatus: { consentToTalentNetwork: null } },
  };
  const beforeCutoff = greenJob({
    callStartedAt: "2026-07-16T18:59:59.999Z",
    ...withoutConsent,
  });
  const atCutoff = greenJob({
    callStartedAt: "2026-07-16T19:00:00.000Z",
    ...withoutConsent,
  });
  assert.equal(autoEligibility(beforeCutoff, eligibilityConfig).eligible, true);
  assert.deepEqual(autoEligibility(atCutoff, eligibilityConfig).reasons, ["talent-network consent"]);
});

test("automatic eligibility cannot bypass the consent cutoff with a missing call timestamp", () => {
  assert.deepEqual(
    autoEligibility(greenJob({ callStartedAt: null }), eligibilityConfig).reasons,
    ["call timestamp"],
  );
});

test("automatic eligibility fails closed for unverified source and missing resume", () => {
  const result = autoEligibility(greenJob({
    callSourceVerified: false,
    submission: { resumeUri: "" },
  }), eligibilityConfig);
  assert.equal(result.eligible, false);
  assert.deepEqual([...result.reasons].sort(), ["call source", "resume"]);
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
