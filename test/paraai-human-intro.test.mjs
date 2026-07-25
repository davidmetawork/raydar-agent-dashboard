import { createHmac } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";

import {
  HUMAN_INTRO_PARSER_VERSION,
  HUMAN_INTRO_SOURCE,
  humanIntroCallFromJob,
  humanIntroCallRecord,
  humanIntroEventId,
  humanIntroJobId,
  humanIntroPayloadDigest,
  humanIntroResumeQueueOptions,
  isHumanIntroJob,
  normalizeHumanIntroPayload,
  persistedHumanIntroMetadata,
  sourceIdFromHumanIntroJob,
} from "../api/paraai/_lib/human-intro.mjs";
import {
  HUMAN_CALL_SOFT_REVIEW_CODE,
  HUMAN_CALL_SOFT_REVIEW_MESSAGE,
  humanCallReadiness,
  isHumanCallJob,
} from "../api/paraai/_lib/human-call.mjs";
import {
  humanProfileReviewDecision,
} from "../api/paraai/_lib/pipeline.mjs";
import {
  reviewActionFor,
} from "../api/paraai/_lib/review.mjs";
import {
  handleHumanIntroCompleted,
  humanIntroSignalEnabled,
} from "../api/paraai/human-intro-completed.mjs";

const SOURCE_ID = "a".repeat(64);
const ARTIFACT_SHA256 = "b".repeat(64);
const JOB_ID = `hi-${SOURCE_ID}`;
const SECRET = "human-intro-signal-test-secret-0001";
const NOW = Date.parse("2026-07-25T12:00:00.000Z");

function payload(overrides = {}) {
  return {
    source: HUMAN_INTRO_SOURCE,
    parserVersion: HUMAN_INTRO_PARSER_VERSION,
    sourceId: SOURCE_ID,
    eventId: humanIntroEventId(SOURCE_ID),
    bookingCreatedAt: "2026-07-20T08:00:00.000Z",
    candidateName: "Candidate Example",
    inviteeEmail: "candidate@example.com",
    linkedinUrl: "https://www.linkedin.com/in/candidate-example",
    resumeLinkDisposition: "none",
    resumeReceipt: null,
    scheduledStart: "2026-07-24T09:00:00.000Z",
    scheduledEnd: "2026-07-24T09:30:00.000Z",
    ...overrides,
  };
}

function receiptPayload(status = "received") {
  return payload({
    resumeLinkDisposition: status,
    resumeReceipt: {
      source: "calendar_resume_link",
      status,
      artifactSha256: ARTIFACT_SHA256,
      mimeType: status === "received"
        ? "application/pdf"
        : "application/rtf",
    },
  });
}

function signedRequest(body, {
  timestamp = Math.floor(NOW / 1000),
  secret = SECRET,
} = {}) {
  const rawBody = JSON.stringify(body);
  const pathname = "/api/paraai/human-intro-completed";
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

function routing() {
  return Object.fromEntries([
    "locations",
    "workplaceTypes",
    "idealFundingRounds",
    "salaryMin",
    "requiresSponsorship",
  ].map((field) => [field, {
    stated: null,
    routed: field === "salaryMin" ? 120_000 : ["default"],
    rule: "select_all_default",
  }]));
}

function preparedJob(overrides = {}) {
  const call = humanIntroCallRecord(payload());
  const base = {
    id: JOB_ID,
    revision: 4,
    state: "needs_review",
    humanCall: true,
    humanIntro: true,
    callType: "human",
    callStartedAt: call.joinAt,
    callEndedAt: call.endedAt,
    candidate: call.candidate,
    humanCallMeta: persistedHumanIntroMetadata(call),
    submission: {
      name: call.candidate.fullName,
      email: call.candidate.email,
      linkedinUrl: call.candidate.linkedin,
      resumeUri: "s3://resumes/candidate-example.pdf",
      resumeStatus: "on_file",
      screeningCallLink: "",
    },
    reviewReason: HUMAN_CALL_SOFT_REVIEW_CODE,
    reviewReasons: [{
      code: HUMAN_CALL_SOFT_REVIEW_CODE,
      message: HUMAN_CALL_SOFT_REVIEW_MESSAGE,
      soft: true,
    }],
    reviewPreferences: {
      locations: ["new_york"],
      workplaceTypes: ["REMOTE", "HYBRID", "ON_SITE"],
      idealFundingRounds: ["PRE_SEED", "SEED"],
      salaryMin: 120_000,
      requiresSponsorship: ["Not available"],
    },
    reviewPolicy: {
      humanIntroWithoutTranscript: true,
      preferenceRouting: routing(),
    },
    journal: [],
  };
  return {
    ...base,
    ...overrides,
    humanCallMeta: {
      ...base.humanCallMeta,
      ...(overrides.humanCallMeta || {}),
    },
    submission: {
      ...base.submission,
      ...(overrides.submission || {}),
    },
    automation: {
      ...(base.automation || {}),
      ...(overrides.automation || {}),
    },
  };
}

function waitingJob(overrides = {}) {
  return preparedJob({
    state: "waiting_for_resume",
    submission: {
      resumeUri: "",
      resumeStatus: "missing",
    },
    automation: {
      status: "waiting_for_resume",
      resumeWait: {
        source: "calendar_human_intro",
        enteredAt: "2026-07-24T09:30:00.000Z",
        firstCheckAt: "2026-07-24T10:30:00.000Z",
        expiresAt: "2026-07-31T09:30:00.000Z",
        claimableThroughAt: "2026-07-25T11:30:00.000Z",
        scheduledChecks: 0,
        nextCheckAt: "2026-07-24T10:30:00.000Z",
        lastCheckedAt: null,
        lastTrigger: null,
      },
    },
    ...overrides,
  });
}

test("Calendar intro ids are deterministic opaque hi- keys and never hc- Paraform ids", () => {
  assert.equal(humanIntroJobId(SOURCE_ID), JOB_ID);
  assert.equal(sourceIdFromHumanIntroJob(JOB_ID), SOURCE_ID);
  assert.equal(isHumanIntroJob(JOB_ID), true);
  assert.equal(isHumanCallJob(JOB_ID), false);
  assert.equal(isHumanIntroJob(`hc-${SOURCE_ID}`), false);
  assert.throws(
    () => humanIntroJobId("raw-calendar-event-id"),
    /valid opaque Calendar source id/u,
  );
});

test("Calendar intake receiver gate is independently off by default and auth remains first", async () => {
  assert.equal(humanIntroSignalEnabled({}), false);
  assert.equal(humanIntroSignalEnabled({
    PARAAI_HUMAN_INTRO_SIGNAL_ENABLED: "true",
  }), true);
  let reads = 0;
  const disabled = await handleHumanIntroCompleted(
    signedRequest(payload()),
    {
      secret: SECRET,
      enabled: false,
      hasStore: () => {
        reads += 1;
        return true;
      },
      now: () => NOW,
    },
  );
  assert.equal(disabled.status, 503);
  assert.deepEqual(await disabled.json(), {
    ok: false,
    error: "human_intro_disabled",
  });
  assert.equal(reads, 0);

  const unauthorized = await handleHumanIntroCompleted(
    signedRequest(payload(), {
      secret: "wrong-secret-long-enough-0000001",
    }),
    {
      secret: SECRET,
      enabled: false,
      hasStore: () => {
        reads += 1;
        return true;
      },
      now: () => NOW,
    },
  );
  assert.equal(unauthorized.status, 401);
  assert.equal(reads, 0);
});

test("signed Role Chat payload normalizes to profile-only manual provenance without a Paraform call id", () => {
  const normalized = normalizeHumanIntroPayload(payload());
  const call = humanIntroCallRecord(normalized);
  assert.equal(call.humanIntro, true);
  assert.equal(call.humanPopulation, "role_chat");
  assert.equal(call.transcriptPresent, false);
  assert.deepEqual(humanCallReadiness(call), {
    ready: true,
    terminal: false,
    reason: null,
    profileOnly: true,
  });
  const metadata = persistedHumanIntroMetadata(call);
  assert.equal(metadata.manualOnly, true);
  assert.equal(metadata.provenanceVerified, true);
  assert.equal(metadata.sourceId, SOURCE_ID);
  assert.equal(metadata.payloadDigest, humanIntroPayloadDigest(payload()));
  assert.match(metadata.payloadDigest, /^[a-f0-9]{64}$/u);
  assert.equal(Object.hasOwn(metadata, "paraformCallId"), false);
  const rebuilt = humanIntroCallFromJob({
    ...preparedJob(),
    humanCallMeta: metadata,
  });
  assert.equal(rebuilt.humanIntroSourceId, SOURCE_ID);
  assert.equal(rebuilt.candidate.email, "candidate@example.com");
  assert.equal(
    humanIntroPayloadDigest(
      Object.fromEntries(Object.entries(payload()).reverse()),
    ),
    metadata.payloadDigest,
  );
});

test("Calendar resume descriptors are strict, digest-bound, and never persist a raw link", () => {
  const received = receiptPayload();
  const normalized = normalizeHumanIntroPayload(received);
  assert.deepEqual(normalized.resumeReceipt, {
    source: "calendar_resume_link",
    status: "received",
    artifactSha256: ARTIFACT_SHA256,
    mimeType: "application/pdf",
  });
  assert.notEqual(
    humanIntroPayloadDigest(received),
    humanIntroPayloadDigest(payload()),
  );
  const call = humanIntroCallRecord(received);
  const metadata = persistedHumanIntroMetadata(call);
  assert.equal(metadata.resumeLinkDisposition, "received");
  assert.deepEqual(metadata.resumeReceipt, normalized.resumeReceipt);
  const rebuilt = humanIntroCallFromJob({
    ...preparedJob({
      resumeLinkDisposition: "received",
      resumeReceipt: normalized.resumeReceipt,
    }),
    candidate: call.candidate,
    callStartedAt: call.joinAt,
    callEndedAt: call.endedAt,
    humanCallMeta: metadata,
  });
  assert.deepEqual(rebuilt.resumeReceipt, normalized.resumeReceipt);
  assert.equal(JSON.stringify(metadata).includes("https://"), false);

  for (const invalid of [
    payload({
      resumeLinkDisposition: "received",
      resumeReceipt: null,
    }),
    payload({
      resumeLinkDisposition: "none",
      resumeReceipt: normalized.resumeReceipt,
    }),
    payload({
      resumeLinkDisposition: "unusable",
      resumeReceipt: {
        ...normalized.resumeReceipt,
        status: "unusable",
      },
    }),
    payload({
      resumeLinkDisposition: "received",
      resumeReceipt: {
        ...normalized.resumeReceipt,
        rawUrl: "https://private.example/resume.pdf",
      },
    }),
  ]) {
    assert.throws(
      () => normalizeHumanIntroPayload(invalid),
      /HUMAN_INTRO_RESUME_/u,
    );
  }
});

test("Calendar received-review and ambiguous dispositions open hard review lanes", () => {
  const context = {
    submission: {
      name: "Candidate Example",
      email: "candidate@example.com",
      linkedinUrl: "https://linkedin.com/in/candidate-example",
      resumeUri: "",
    },
    preferences: {
      locations: ["new_york"],
      workplaceTypes: ["REMOTE"],
      idealFundingRounds: ["SEED"],
      salaryMin: 120_000,
      requiresSponsorship: ["Not available"],
    },
  };
  for (const [resumeLinkDisposition, expectedCode] of [
    ["received_review", "calendar_resume_received_review"],
    ["ambiguous", "calendar_resume_link_ambiguous"],
  ]) {
    const decision = humanProfileReviewDecision({
      profileOnly: true,
    }, {
      ...context,
      resumeLinkDisposition,
    });
    assert.equal(decision.state, "needs_review");
    assert.equal(decision.reviewReason, expectedCode);
    assert.equal(
      decision.reviewReasons.find((reason) => (
        reason.code === expectedCode
      ))?.soft,
      false,
    );
  }
});

test("resume-ready Calendar intake creates one soft card and lifecycle replay is a 200 no-op", async () => {
  let stored = null;
  let prepares = 0;
  let lockReleases = 0;
  const options = {
    secret: SECRET,
    enabled: true,
    hasStore: () => true,
    load: async () => stored,
    acquire: async () => "lock-token",
    release: async () => {
      lockReleases += 1;
    },
    prepare: async ({
      botId,
      strictReads,
      callRecord,
      force,
    }) => {
      prepares += 1;
      assert.equal(botId, JOB_ID);
      assert.equal(strictReads, true);
      assert.equal(callRecord.humanIntro, true);
      assert.equal(callRecord.humanIntroSourceId, SOURCE_ID);
      assert.equal(force, false);
      stored ||= preparedJob();
      return stored;
    },
    enqueue: async () => {
      assert.fail("resume-ready soft cards must not enter the worker queue");
    },
    now: () => NOW,
  };

  const first = await handleHumanIntroCompleted(
    signedRequest(payload()),
    options,
  );
  assert.equal(first.status, 202);
  assert.deepEqual(await first.json(), {
    ok: true,
    jobId: JOB_ID,
    state: "needs_review",
    prepared: true,
    duplicate: false,
    recovered: false,
  });
  const second = await handleHumanIntroCompleted(
    signedRequest(payload()),
    options,
  );
  assert.equal(second.status, 200);
  assert.deepEqual(await second.json(), {
    ok: true,
    jobId: JOB_ID,
    state: "needs_review",
    prepared: true,
    duplicate: true,
    recovered: false,
  });
  assert.equal(prepares, 1);
  assert.equal(lockReleases, 2);
  assert.equal(stored.humanCallMeta.manualOnly, true);
  assert.equal(stored.reviewReasons[0].message,
    "human intro call without transcript — preferences confirmed manually");
  assert.equal(reviewActionFor(stored).allowed, true);
});

test("Calendar intake without a resume enters the shared wait queue and replay repairs queueing idempotently", async () => {
  let stored = null;
  let prepares = 0;
  const enqueues = [];
  const options = {
    secret: SECRET,
    enabled: true,
    hasStore: () => true,
    load: async () => stored,
    acquire: async () => "lock-token",
    release: async () => {},
    prepare: async ({ force }) => {
      prepares += 1;
      assert.equal(force, false);
      stored = waitingJob();
      return stored;
    },
    enqueue: async (jobId, queueOptions) => {
      enqueues.push({ jobId, queueOptions });
      return {
        enqueued: enqueues.length === 1,
        duplicate: enqueues.length > 1,
      };
    },
    now: () => NOW,
  };

  const first = await handleHumanIntroCompleted(
    signedRequest(payload()),
    options,
  );
  assert.equal(first.status, 202);
  assert.deepEqual(await first.json(), {
    ok: true,
    jobId: JOB_ID,
    state: "waiting_for_resume",
    prepared: true,
    duplicate: false,
    recovered: false,
    resumeWaitQueued: true,
    resumeWaitQueueDuplicate: false,
  });
  const replay = await handleHumanIntroCompleted(
    signedRequest(payload()),
    options,
  );
  assert.equal(replay.status, 200);
  assert.deepEqual(await replay.json(), {
    ok: true,
    jobId: JOB_ID,
    state: "waiting_for_resume",
    prepared: true,
    duplicate: true,
    recovered: false,
    resumeWaitQueued: false,
    resumeWaitQueueDuplicate: true,
  });
  assert.equal(prepares, 1);
  assert.equal(enqueues.length, 2);
  assert.equal(enqueues[0].jobId, JOB_ID);
  assert.deepEqual(
    enqueues[0].queueOptions,
    humanIntroResumeQueueOptions(stored, { now: NOW }),
  );
  assert.equal(stored.reviewReason, HUMAN_CALL_SOFT_REVIEW_CODE);
  assert.equal(reviewActionFor(stored).allowed, false);
});

test("matching transient Calendar preparation is force-recovered while settled lifecycle states are 200 duplicates", async () => {
  for (const state of ["resolving_identity", "extracting"]) {
    let prepares = 0;
    const response = await handleHumanIntroCompleted(
      signedRequest(payload()),
      {
        secret: SECRET,
        enabled: true,
        hasStore: () => true,
        load: async () => preparedJob({ state }),
        acquire: async () => "lock-token",
        release: async () => {},
        prepare: async ({ force }) => {
          prepares += 1;
          assert.equal(force, true);
          return preparedJob();
        },
        now: () => NOW,
      },
    );
    assert.equal(response.status, 202, state);
    assert.equal((await response.json()).recovered, true, state);
    assert.equal(prepares, 1, state);
  }

  for (const state of [
    "needs_identity_review",
    "ready_to_submit",
    "awaiting_approval",
    "awaiting_matches",
    "ready_to_enroll",
    "enrolled",
  ]) {
    let prepares = 0;
    const response = await handleHumanIntroCompleted(
      signedRequest(payload()),
      {
        secret: SECRET,
        enabled: true,
        hasStore: () => true,
        load: async () => preparedJob({ state }),
        acquire: async () => "lock-token",
        release: async () => {},
        prepare: async () => {
          prepares += 1;
          assert.fail("settled lifecycle replay must not re-prepare");
        },
        now: () => NOW,
      },
    );
    assert.equal(response.status, 200, state);
    assert.equal((await response.json()).duplicate, true, state);
    assert.equal(prepares, 0, state);
  }
});

test("same Calendar source with changed immutable booking facts fails with a payload conflict", async () => {
  const changes = [
    { candidateName: "Different Candidate" },
    { inviteeEmail: "different@example.com" },
    { linkedinUrl: "https://www.linkedin.com/in/different-candidate" },
    {
      scheduledStart: "2026-07-25T13:00:00.000Z",
      scheduledEnd: "2026-07-25T13:30:00.000Z",
    },
  ];
  for (const change of changes) {
    let prepared = false;
    let saved = null;
    const response = await handleHumanIntroCompleted(
      signedRequest(payload(change)),
      {
        secret: SECRET,
        enabled: true,
        hasStore: () => true,
        load: async () => preparedJob(),
        acquire: async () => "lock-token",
        release: async () => {},
        save: async (next, revision) => {
          saved = { ...next, revision: revision + 1 };
          return saved;
        },
        prepare: async () => {
          prepared = true;
          assert.fail("payload conflict must not mutate the existing job");
        },
        now: () => NOW,
      },
    );
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), {
      ok: false,
      error: "job_payload_conflict",
    });
    assert.equal(prepared, false);
    assert.equal(
      saved.reviewReasons.some((reason) => (
        reason.code === "human_intro_payload_conflict"
        && reason.soft === false
      )),
      true,
    );
    assert.equal(
      saved.humanCallMeta.payloadConflict.incomingDigest,
      humanIntroPayloadDigest(payload(change)),
    );
    assert.equal(
      reviewActionFor(saved).allowed,
      false,
      "a later same-source slot must disable the old T+1 soft action",
    );
  }
});

test("profile-only readiness waits on resume and stacks hard blockers before one-click", () => {
  const decision = humanProfileReviewDecision(
    { profileOnly: true },
    {
      submission: {
        name: "Candidate Example",
        email: "candidate@example.com",
        linkedinUrl: "",
        resumeUri: "",
      },
      preferences: preparedJob().reviewPreferences,
    },
  );
  assert.equal(decision.state, "waiting_for_resume");
  assert.deepEqual(
    decision.reviewReasons.map((reason) => [reason.code, reason.soft]),
    [
      [HUMAN_CALL_SOFT_REVIEW_CODE, true],
      ["candidate_linkedin_missing", false],
    ],
  );
  assert.equal(reviewActionFor(preparedJob({
    submission: { resumeUri: "" },
  })).allowed, false);
  assert.equal(reviewActionFor(preparedJob({
    submission: { linkedinUrl: "" },
  })).allowed, false);
  const conflictDecision = humanProfileReviewDecision(
    { profileOnly: true },
    {
      submission: preparedJob().submission,
      preferences: preparedJob().reviewPreferences,
      payloadConflict: {
        incomingDigest: "b".repeat(64),
      },
    },
  );
  assert.equal(
    conflictDecision.reviewReasons.some((reason) => (
      reason.code === "human_intro_payload_conflict"
      && reason.soft === false
    )),
    true,
  );
});

test("Calendar intake rejects unsigned, future, schema-expanded, and conflicting jobs", async () => {
  const unauthorized = await handleHumanIntroCompleted(
    signedRequest(payload(), { secret: "wrong-secret-long-enough-0000001" }),
    {
      secret: SECRET,
      enabled: true,
      hasStore: () => true,
      load: async () => null,
      acquire: async () => "lock-token",
      release: async () => {},
      now: () => NOW,
    },
  );
  assert.equal(unauthorized.status, 401);

  const future = await handleHumanIntroCompleted(
    signedRequest(payload({
      scheduledStart: "2026-07-25T13:00:00.000Z",
      scheduledEnd: "2026-07-25T13:30:00.000Z",
    })),
    {
      secret: SECRET,
      enabled: true,
      hasStore: () => true,
      load: async () => null,
      acquire: async () => "lock-token",
      release: async () => {},
      now: () => NOW,
    },
  );
  assert.equal(future.status, 409);

  const expanded = await handleHumanIntroCompleted(
    signedRequest(payload({ callId: "not-a-Paraform-call" })),
    {
      secret: SECRET,
      enabled: true,
      hasStore: () => true,
      now: () => NOW,
    },
  );
  assert.equal(expanded.status, 400);

  const conflict = await handleHumanIntroCompleted(
    signedRequest(payload()),
    {
      secret: SECRET,
      enabled: true,
      hasStore: () => true,
      load: async () => ({
        ...preparedJob(),
        humanCallMeta: {
          ...preparedJob().humanCallMeta,
          paraformCallId: "calendar-id-must-not-be-reinterpreted",
        },
      }),
      acquire: async () => "lock-token",
      release: async () => {},
      now: () => NOW,
    },
  );
  assert.equal(conflict.status, 409);
});
