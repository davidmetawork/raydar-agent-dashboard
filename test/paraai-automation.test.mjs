import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import assert from "node:assert/strict";

import { autoEligibility } from "../api/paraai/_lib/auto.mjs";
import { enforceTranscriptSemantics } from "../api/paraai/_lib/extract.mjs";
import { buildPreferences } from "../api/paraai/_lib/pipeline.mjs";
import {
  isCanonicalScreenerSource,
  isRecallCompletionSignal,
  recallWebhookEvent,
  verifyRecallWebhook,
} from "../api/paraai/_lib/recall-webhook.mjs";

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

test("Recall intake accepts only the two canonical screener dispatch paths", () => {
  assert.equal(isCanonicalScreenerSource("paraform-auto"), true);
  assert.equal(isCanonicalScreenerSource("paraform-reconciliation"), true);
  assert.equal(isCanonicalScreenerSource("fyxer-guardian-n8n"), false);
  assert.equal(isCanonicalScreenerSource("manual-test"), false);
  assert.equal(isCanonicalScreenerSource(""), false);
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
