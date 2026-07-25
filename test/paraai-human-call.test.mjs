import { createHmac } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";

import {
  HUMAN_CALL_QUEUE_SOURCE,
  callIdFromHumanJob,
  fetchHumanCall,
  humanCallEventId,
  humanCallJobId,
  humanCallReadiness,
  humanTranscriptSubstance,
  isHumanCallJob,
  normalizeHumanCallRecord,
  normalizeHumanTranscript,
} from "../api/paraai/_lib/human-call.mjs";
import {
  automationApprovalSourceForJob,
  processAutoJob,
} from "../api/paraai/_lib/auto.mjs";
import {
  humanProfileReviewDecision,
} from "../api/paraai/_lib/pipeline.mjs";
import {
  handleHumanCallCompleted,
  humanCallSignalEnabled,
} from "../api/paraai/human-call-completed.mjs";

const CALL_ID = "call_test_12345";
const JOB_ID = `hc-${CALL_ID}`;
const NOW = Date.parse("2026-07-25T12:00:00.000Z");
const SECRET = "human-call-signal-test-secret-0001";

function words(value) {
  return [{ punctuated_word: value }];
}

function substantiveTranscript() {
  return [
    { speaker_id: 0, words: words("a".repeat(1_200)) },
    { speaker_id: 1, words: words("b".repeat(900)) },
    { speaker_id: 0, words: words("c".repeat(300)) },
  ];
}

function alzenCall(overrides = {}) {
  return {
    id: CALL_ID,
    event_title: "Candidate Example / Alzen",
    event_scheduled_at: "2026-07-25T09:00:00.000Z",
    event_duration_minutes: 30,
    meeting_platform: "PHONE",
    user: { name: "Alzen Flores" },
    candidate_user_id: "candidate-user-test",
    candidate_user: {
      id: "candidate-user-test",
      candidate: {
        name: "Candidate Example",
        email: "candidate@example.com",
        linkedin_user: "https://www.linkedin.com/in/candidate-example",
        phone_number: "+1 212 555 0100",
      },
    },
    attendee_emails: ["candidate@example.com"],
    recording_transcript: substantiveTranscript(),
    ...overrides,
  };
}

function signedRequest(body, {
  timestamp = Math.floor(NOW / 1000),
  secret = SECRET,
} = {}) {
  const rawBody = JSON.stringify(body);
  const pathname = "/api/paraai/human-call-completed";
  const signature = createHmac("sha256", secret)
    .update(`${timestamp}.POST.${pathname}.${rawBody}`)
    .digest("hex");
  return new Request(`https://monitor.raydar.xyz${pathname}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-raydar-timestamp": String(timestamp),
      "x-raydar-signature": `v1=${signature}`,
    },
    body: rawBody,
  });
}

test("human-call ids and deterministic handoff ids preserve unambiguous Paraform semantics", () => {
  assert.equal(humanCallJobId(CALL_ID), JOB_ID);
  assert.equal(callIdFromHumanJob(JOB_ID), CALL_ID);
  assert.equal(isHumanCallJob(JOB_ID), true);
  assert.equal(isHumanCallJob("calendar-event-12345"), false);
  assert.match(humanCallEventId(CALL_ID), /^[a-f0-9]{64}$/u);
  assert.equal(humanCallEventId(CALL_ID), humanCallEventId(CALL_ID));
  assert.throws(() => humanCallJobId("calendar/event"), /valid Paraform human-call id/u);
});

test("substance gate and normalization use only the louder/quieter principal pair", () => {
  const transcript = [
    { speaker_id: "agent", words: "a".repeat(1_200) },
    { speaker_id: "candidate", words: "b".repeat(900) },
    { speaker_id: "observer", words: "noise".repeat(100) },
    { speaker_id: "agent", words: "c".repeat(200) },
  ];
  const substance = humanTranscriptSubstance(transcript);
  assert.equal(substance.speakers, 3);
  assert.equal(substance.substantive, true);
  const normalized = normalizeHumanTranscript(transcript);
  assert.equal(normalized.rows.some((row) => row.speaker === "observer"), false);
  assert.deepEqual(
    [...new Set(normalized.rows.map((row) => `${row.speaker}:${row.role}`))].sort(),
    ["agent:agent", "candidate:candidate"],
  );

  assert.equal(humanTranscriptSubstance([
    { speaker_id: 0, words: "x".repeat(2_000) },
    { speaker_id: 1, words: "y".repeat(399) },
  ]).substantive, false);
  assert.equal(humanTranscriptSubstance([
    { speaker_id: 0, words: "x".repeat(2_000) },
  ]).substantive, false);
});

test("Alzen Paraform phone calls normalize for the shared extractor and one-hour clock", () => {
  const call = normalizeHumanCallRecord(alzenCall(), { callId: CALL_ID });
  assert.equal(call.humanCall, true);
  assert.equal(call.humanPopulation, "phone_screen");
  assert.equal(call.candidateUserId, "candidate-user-test");
  assert.equal(call.candidate.fullName, "Candidate Example");
  assert.equal(call.candidate.email, "candidate@example.com");
  assert.equal(call.joinAt, "2026-07-25T09:00:00.000Z");
  assert.equal(call.endedAt, "2026-07-25T09:30:00.000Z");
  assert.equal(call.screeningCallLink, `https://www.paraform.com/calls/${CALL_ID}`);
  assert.equal(call.substance.substantive, true);
  assert.deepEqual(humanCallReadiness(call), {
    ready: true,
    terminal: false,
    reason: null,
    profileOnly: false,
  });
  assert.equal(call.transcript.some((row) => row.role === "candidate"), true);
  assert.equal(call.transcript.some((row) => row.role === "agent"), true);
});

test("fetchHumanCall uses candidateUserMeeting.getCallById and fails closed on mismatched records", async () => {
  const calls = [];
  const call = await fetchHumanCall(CALL_ID, {
    trpcGetImpl: async (proc, input) => {
      calls.push({ proc, input });
      return alzenCall();
    },
  });
  assert.deepEqual(calls, [{
    proc: "candidateUserMeeting.getCallById",
    input: { id: CALL_ID },
  }]);
  assert.equal(call.id, CALL_ID);
  await assert.rejects(
    fetchHumanCall(CALL_ID, {
      trpcGetImpl: async () => alzenCall({ id: "different_call_123" }),
    }),
    (error) => error?.code === "HUMAN_CALL_ID_MISMATCH",
  );
});

test("an exact no-transcript David Role Chat record is profile-only and always a soft review", () => {
  const call = normalizeHumanCallRecord({
    id: CALL_ID,
    event_title: "Role Chat | Grace Example and David Phillips",
    event_scheduled_at: "2026-07-25T09:00:00.000Z",
    event_ended_at: "2026-07-25T09:30:00.000Z",
    meeting_platform: "GOOGLE_MEET",
    user: { name: "David Phillips" },
    candidate_user_id: "candidate-user-role-chat",
    candidate_user: {
      id: "candidate-user-role-chat",
      candidate: {
        name: "Grace Example",
        email: "grace@example.com",
        linkedin_user: "https://www.linkedin.com/in/grace-example",
      },
    },
    recording_transcript: null,
  }, { callId: CALL_ID });
  assert.equal(call.humanPopulation, "role_chat");
  assert.equal(call.transcriptPresent, false);
  const readiness = humanCallReadiness(call);
  assert.deepEqual(readiness, {
    ready: true,
    terminal: false,
    reason: null,
    profileOnly: true,
  });
  assert.deepEqual(humanProfileReviewDecision(readiness), {
    state: "needs_review",
    reviewReason: "human_intro_without_transcript",
    reviewReasons: [{
      code: "human_intro_without_transcript",
      message: "human intro call without transcript — preferences confirmed manually",
      soft: true,
    }],
  });
});

test("signed human-call completion creates a human job and enqueues exactly hc-<Paraform call id>", async () => {
  const eventId = humanCallEventId(CALL_ID);
  const created = [];
  const enqueued = [];
  const response = await handleHumanCallCompleted(
    signedRequest({ callId: CALL_ID, eventId }),
    {
      secret: SECRET,
      enabled: true,
      hasStore: () => true,
      create: async (job) => {
        created.push(job);
        return { ...job, revision: 0 };
      },
      enqueue: async (jobId, options) => {
        enqueued.push({ jobId, options });
        return { enqueued: true, duplicate: false };
      },
      getAutomationConfig: () => ({}),
      now: () => NOW,
    },
  );
  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), {
    ok: true,
    enqueued: true,
    duplicate: false,
    paused: true,
  });
  assert.equal(created.length, 1);
  assert.equal(created[0].id, JOB_ID);
  assert.equal(created[0].humanCall, true);
  assert.equal(created[0].callType, "human");
  assert.equal(created[0].humanCallMeta.paraformCallId, CALL_ID);
  assert.equal(enqueued.length, 1);
  assert.equal(enqueued[0].jobId, JOB_ID);
  assert.equal(enqueued[0].options.source, HUMAN_CALL_QUEUE_SOURCE);
  assert.equal(enqueued[0].options.dueAt, NOW);
  assert.doesNotMatch(enqueued[0].options.eventId, /candidate@example/u);
});

test("human-call completion rejects bad signatures and non-deterministic event ids", async () => {
  const validEventId = humanCallEventId(CALL_ID);
  const unauthorized = await handleHumanCallCompleted(
    signedRequest({ callId: CALL_ID, eventId: validEventId }, {
      secret: "wrong-human-call-signal-secret-000",
    }),
    {
      secret: SECRET,
      enabled: true,
      hasStore: () => true,
      now: () => NOW,
    },
  );
  assert.equal(unauthorized.status, 401);

  const invalid = await handleHumanCallCompleted(
    signedRequest({ callId: CALL_ID, eventId: "not-the-derived-event" }),
    {
      secret: SECRET,
      enabled: true,
      hasStore: () => true,
      now: () => NOW,
    },
  );
  assert.equal(invalid.status, 400);
  assert.deepEqual(await invalid.json(), {
    ok: false,
    error: "invalid_request",
  });
});

test("human-call receiver gate is independently off by default after authentication", async () => {
  assert.equal(humanCallSignalEnabled({}), false);
  assert.equal(humanCallSignalEnabled({
    PARAAI_HUMAN_CALL_SIGNAL_ENABLED: "true",
  }), true);
  const eventId = humanCallEventId(CALL_ID);
  let storeReads = 0;
  const disabled = await handleHumanCallCompleted(
    signedRequest({ callId: CALL_ID, eventId }),
    {
      secret: SECRET,
      enabled: false,
      hasStore: () => {
        storeReads += 1;
        return true;
      },
      now: () => NOW,
    },
  );
  assert.equal(disabled.status, 503);
  assert.deepEqual(await disabled.json(), {
    ok: false,
    error: "human_call_disabled",
  });
  assert.equal(storeReads, 0);

  const unauthorized = await handleHumanCallCompleted(
    signedRequest({ callId: CALL_ID, eventId }, {
      secret: "wrong-human-call-signal-secret-000",
    }),
    {
      secret: SECRET,
      enabled: false,
      hasStore: () => {
        storeReads += 1;
        return true;
      },
      now: () => NOW,
    },
  );
  assert.equal(unauthorized.status, 401);
  assert.equal(storeReads, 0);
});

test("durable human metadata preserves human approval provenance after resume re-due", () => {
  assert.equal(
    automationApprovalSourceForJob(
      { id: JOB_ID, humanCall: true },
      "resume_attached:opaque-signal",
    ),
    "paraform_human_call_verified_automation",
  );
  assert.equal(
    automationApprovalSourceForJob(
      { id: "bot_agent_12345", humanCall: false },
      "resume_attached:opaque-signal",
    ),
    "recall_verified_automation",
  );
});

test("processAutoJob treats a profile-only Role Chat soft card as terminal and never submits", async () => {
  let submits = 0;
  const softReviewJob = {
    id: JOB_ID,
    revision: 4,
    state: "needs_review",
    humanCall: true,
    callType: "human",
    callStartedAt: "2026-07-25T09:00:00.000Z",
    callEndedAt: "2026-07-25T09:30:00.000Z",
    humanCallMeta: {
      paraformCallId: CALL_ID,
      population: "role_chat",
      profileOnly: true,
      provenanceVerified: true,
    },
    automation: {
      mode: "human_call",
      freezeReason: null,
      status: "needs_review",
    },
    reviewReason: "human_intro_without_transcript",
    reviewReasons: [{
      code: "human_intro_without_transcript",
      message: "Human intro call without transcript — preferences confirmed manually",
      soft: true,
    }],
    journal: [],
  };
  const result = await processAutoJob(JOB_ID, {
    config: {
      enabled: true,
      detectEnabled: true,
      prepareEnabled: true,
      autoSubmitApproved: true,
      dryRun: false,
      notBeforeMs: 0,
      phase1DeployedAtMs: 0,
      resumeWaitEnabled: false,
      resumeSignalConfigured: true,
      strictScreenerSource: true,
      organicExceptionBotIds: new Set(),
      maxStepAttempts: 20,
    },
    queueSource: "resume_attached:opaque-signal",
    getJobImpl: async () => softReviewJob,
    submitJobImpl: async () => {
      submits += 1;
      throw new Error("profile-only Role Chat must never auto-submit");
    },
  });
  assert.equal(result.action, "complete");
  assert.equal(result.state, "needs_review");
  assert.equal(submits, 0);
});
