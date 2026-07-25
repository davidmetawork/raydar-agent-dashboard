import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  RESUME_WAIT_TERMINAL_ACK_DEADLINE_MS,
  RESUME_WAIT_TERMINAL_REASON,
  automationConfig,
  automationExecutionEnabled,
  automationGraceDecision,
  backfillReviewDecision,
  enqueueBackfill,
  ensureRecentResumeAttachRedue,
  isPhase1ResumeWaitCard,
  isResumeAttachTrigger,
  isTerminalResumeWaitReview,
  phase1ResumeWaitSweepTransition,
  resumeWaitCheckDecision,
  resumeWaitFoundTransition,
  resumeWaitMissingTransition,
  resumeWaitPlan,
  resumeWaitTerminalAttachMissingTransition,
  resumeWaitTerminalDeadlineTransition,
  resumeWaitTerminalSettleDecision,
  resumeWaitTerminalTransition,
  sweepPhase1ResumeWaitCards,
} from "../api/paraai/_lib/auto.mjs";
import { runAutomationCycle } from "../api/paraai/worker.mjs";
import {
  STATES,
  existingTalentNetworkTransition,
} from "../api/paraai/_lib/pipeline.mjs";

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;
const anchor = Date.parse("2026-07-25T00:00:00.000Z");
const liveConfig = {
  resumeWaitEnabled: true,
  resumeWaitMinutes: 60,
  resumeRetryDays: 7,
};
const readyConfig = {
  ...liveConfig,
  enabled: true,
  detectEnabled: true,
  prepareEnabled: true,
  autoSubmitApproved: true,
  dryRun: false,
  notBeforeMs: anchor,
  phase1DeployedAtMs: anchor,
  resumeSignalConfigured: true,
};

function waitingJob(wait, overrides = {}) {
  return {
    id: "bot_resume_1234",
    revision: 3,
    state: "waiting_for_resume",
    callEndedAt: new Date(anchor).toISOString(),
    identity: { candidateUserId: "candidate-user-test" },
    submission: { resumeUri: "", resumeStatus: "missing" },
    automation: { resumeWait: wait },
    reviewReasons: [],
    journal: [],
    ...overrides,
  };
}

function backfillJob(id, overrides = {}) {
  const base = waitingJob(null, {
    id,
    state: "needs_review",
    automation: { mode: "backfill_only" },
    extracted: { roleTypes: ["sales"] },
    submission: {
      resumeUri: "",
      resumeStatus: "missing",
      email: "candidate@example.com",
      linkedinUrl: "https://www.linkedin.com/in/candidate-test",
    },
    reviewPolicy: { preferenceRouting: { stageSource: "screening_call" } },
    reviewReason: "no_resume_phase1",
    reviewReasons: [{
      code: "no_resume_phase1",
      message: "no resume on profile (resume-wait ships Phase 2)",
      soft: false,
    }],
  });
  return {
    ...base,
    ...overrides,
    identity: { ...base.identity, ...(overrides.identity || {}) },
    submission: { ...base.submission, ...(overrides.submission || {}) },
    automation: { ...base.automation, ...(overrides.automation || {}) },
  };
}

test("Phase 2 gate is closed by default and config pins the seven-day policy", () => {
  const closed = automationConfig({});
  assert.equal(closed.resumeWaitEnabled, false);
  assert.equal(closed.resumeWaitMinutes, 60);
  assert.equal(closed.resumeRetryDays, 7);
  assert.equal(closed.resumeTerminalAckHours, 24);
  assert.equal(closed.resumeBackfillTerminalAckDays, 21);
  assert.equal(RESUME_WAIT_TERMINAL_ACK_DEADLINE_MS, DAY_MS);

  const open = automationConfig({
    PARAAI_RESUME_WAIT_ENABLED: "true",
    PARAAI_RESUME_WAIT_MINUTES: "60",
    PARAAI_RESUME_RETRY_DAYS: "7",
    PARAAI_RESUME_TERMINAL_ACK_HOURS: "0.5",
    PARAAI_RESUME_BACKFILL_TERMINAL_ACK_DAYS: "5",
    PARAAI_RESUME_SIGNAL_SECRET: "configured-test-secret-24chars",
  });
  assert.equal(open.resumeWaitEnabled, true);
  assert.equal(open.resumeRetryDays, 7);
  assert.equal(
    open.resumeTerminalAckHours,
    1,
    "organic terminal acknowledgement window cannot be below one hour",
  );
  assert.equal(open.resumeBackfillTerminalAckDays, 14);
  assert.equal(open.resumeSignalConfigured, true);
  assert.equal(STATES.has("waiting_for_resume"), true);
  const executionBase = {
    enabled: true,
    detectEnabled: true,
    prepareEnabled: true,
    autoSubmitApproved: true,
    dryRun: false,
    notBeforeMs: anchor,
    phase1DeployedAtMs: anchor,
    resumeWaitEnabled: true,
  };
  assert.equal(automationExecutionEnabled({
    ...executionBase,
    resumeSignalConfigured: false,
  }), false);
  assert.equal(automationExecutionEnabled({
    ...executionBase,
    resumeSignalConfigured: true,
  }), true);
});

test("organic resume waiting performs exactly eight scheduled reads through T+7d", () => {
  const wait = resumeWaitPlan({
    source: "organic",
    anchorAt: anchor,
    waitMinutes: 60,
    retryDays: 7,
  });
  assert.deepEqual(wait, {
    source: "organic",
    enteredAt: "2026-07-25T00:00:00.000Z",
    firstCheckAt: "2026-07-25T01:00:00.000Z",
    expiresAt: "2026-08-01T00:00:00.000Z",
    claimableThroughAt: "2026-07-26T02:00:00.000Z",
    scheduledChecks: 0,
    nextCheckAt: "2026-07-25T01:00:00.000Z",
    lastCheckedAt: null,
    lastTrigger: null,
  });

  const scheduledAt = [
    anchor + HOUR_MS,
    ...Array.from({ length: 7 }, (_, index) => anchor + (index + 1) * DAY_MS),
  ];
  let job = waitingJob(wait);
  for (let index = 0; index < scheduledAt.length; index++) {
    const result = resumeWaitMissingTransition(job, liveConfig, {
      queueSource: "recovery_status",
      now: scheduledAt[index],
      probeStartedAt: scheduledAt[index] - 10,
    });
    job = result.job;
    assert.equal(job.automation.resumeWait.scheduledChecks, index + 1);
    assert.equal(result.expired, index === scheduledAt.length - 1);
    assert.equal(result.settling === true, index === scheduledAt.length - 1);
  }

  assert.equal(job.state, "waiting_for_resume");
  assert.equal(job.reviewReason, null);
  assert.equal(job.automation.resumeWait.scheduledChecks, 8);
  assert.equal(
    job.automation.resumeWait.terminalAck.opsDeadlineAt,
    new Date(
      anchor + 7 * DAY_MS + RESUME_WAIT_TERMINAL_ACK_DEADLINE_MS,
    ).toISOString(),
  );
  assert.equal(
    job.automation.resumeWait.nextCheckAt,
    new Date(anchor + 7 * DAY_MS + RESUME_WAIT_TERMINAL_ACK_DEADLINE_MS).toISOString(),
  );
  const awaitingAck = resumeWaitTerminalSettleDecision(job, {
    now: anchor + 7 * DAY_MS + RESUME_WAIT_TERMINAL_ACK_DEADLINE_MS - 1,
    config: liveConfig,
  });
  assert.equal(awaitingAck.settling, true);
  assert.equal(awaitingAck.acknowledged, false);
  assert.equal(awaitingAck.readyToClose, false);
  assert.equal(awaitingAck.delayMs, 1_000);
  assert.equal(awaitingAck.markerSinceAt, anchor + 7 * DAY_MS - 10);
  assert.equal(
    awaitingAck.opsDeadlineAt,
    anchor + 7 * DAY_MS + RESUME_WAIT_TERMINAL_ACK_DEADLINE_MS,
  );
  const deadline = resumeWaitTerminalSettleDecision(job, {
    now: anchor + 7 * DAY_MS + RESUME_WAIT_TERMINAL_ACK_DEADLINE_MS,
    config: liveConfig,
  });
  assert.equal(deadline.deadlineElapsed, true);
  assert.equal(deadline.outcome, "ops_deadline_elapsed");
  job = resumeWaitTerminalTransition(job, liveConfig, {
    queueSource: "recovery_status",
    now: anchor + 7 * DAY_MS + RESUME_WAIT_TERMINAL_ACK_DEADLINE_MS,
    terminalOutcome: deadline.outcome,
  });
  assert.equal(job.state, "needs_review");
  assert.equal(job.reviewReason, "no_resume_after_7_days");
  assert.deepEqual(job.reviewReasons, [{
    code: "no_resume_after_7_days",
    message: RESUME_WAIT_TERMINAL_REASON,
    soft: false,
  }]);
  assert.equal(job.automation.resumeWait.scheduledChecks, 8);
  assert.equal(job.automation.resumeWait.nextCheckAt, null);
  assert.equal(job.journal.filter((row) => /^resume check /.test(row.detail || "")).length, 8);
  assert.equal(job.journal.at(-2).detail, "resume check 8/8: none on file");
  assert.equal(
    job.journal.at(-1).detail,
    "resume wait closed at the terminal acknowledgement operations deadline",
  );
});

test("touch-3 acknowledgement closes early while a pre-expiry stop does not", () => {
  const beforeExpiry = waitingJob(resumeWaitPlan({
    source: "organic",
    anchorAt: anchor,
    waitMinutes: 60,
    retryDays: 7,
  }));
  assert.equal(
    resumeWaitTerminalSettleDecision(beforeExpiry, {
      now: anchor + DAY_MS,
      sharedState: {
        chain: {
          stopped: true,
          stoppedAt: new Date(anchor + HOUR_MS).toISOString(),
          stopReason: "candidate_replied",
        },
      },
      config: liveConfig,
    }).settling,
    false,
    "an early chain stop cannot end passive profile checks",
  );

  let terminal = beforeExpiry;
  const scheduledAt = [
    anchor + HOUR_MS,
    ...Array.from({ length: 7 }, (_, index) => (
      anchor + (index + 1) * DAY_MS
    )),
  ];
  for (const now of scheduledAt) {
    terminal = resumeWaitMissingTransition(terminal, liveConfig, {
      queueSource: "recovery_status",
      now,
      probeStartedAt: now - 10,
    }).job;
  }
  const deliveredAt = scheduledAt.at(-1) + 60_000;
  const decision = resumeWaitTerminalSettleDecision(terminal, {
    now: deliveredAt,
    sharedState: {
      chain: {
        terminalAck: {
          touch: 3,
          outcome: "delivered",
          acknowledgedAt: new Date(deliveredAt).toISOString(),
        },
      },
    },
    config: liveConfig,
  });
  assert.equal(decision.readyToClose, true);
  assert.equal(decision.deadlineElapsed, false);
  assert.equal(decision.outcome, "delivered");
});

test("common-T0 backfill remains claimable through later delivery waves", () => {
  const jobs = Array.from({ length: 25 }, (_, index) => {
    const id = `bot_backfill_wave_${String(index).padStart(2, "0")}`;
    const wait = resumeWaitPlan({
      source: "authorized_backfill",
      anchorAt: anchor,
      waitMinutes: 60,
      retryDays: 7,
    });
    let job = waitingJob(wait, {
      id,
      callEndedAt: new Date(anchor - (25 - index) * HOUR_MS).toISOString(),
    });
    const scheduledAt = [
      anchor + HOUR_MS,
      ...Array.from({ length: 7 }, (_, day) => (
        anchor + (day + 1) * DAY_MS
      )),
    ];
    for (const now of scheduledAt) {
      job = resumeWaitMissingTransition(job, {
        ...liveConfig,
        resumeBackfillTerminalAckDays: 21,
      }, {
        queueSource: "authorized_backfill",
        now,
        probeStartedAt: now - 1,
      }).job;
    }
    return job;
  });
  const laterWave = jobs.at(-1);
  assert.equal(
    laterWave.automation.resumeWait.terminalAck.opsDeadlineAt,
    new Date(anchor + 21 * DAY_MS).toISOString(),
  );
  assert.ok(
    Date.parse(laterWave.automation.resumeWait.claimableThroughAt)
      > anchor + 13 * DAY_MS,
    "the 25th same-T0 chain must remain claimable through legitimate touch 3",
  );
});

test("confirmed prior touches monotonically extend the persisted terminal deadline", () => {
  let job = waitingJob({
    ...resumeWaitPlan({
      source: "organic",
      anchorAt: anchor,
      waitMinutes: 60,
      retryDays: 7,
    }),
    scheduledChecks: 8,
    nextCheckAt: new Date(anchor + 8 * DAY_MS).toISOString(),
    terminalAck: {
      status: "awaiting_ack",
      openedAt: new Date(anchor + 7 * DAY_MS).toISOString(),
      markerSinceAt: new Date(anchor + 7 * DAY_MS).toISOString(),
      claimableThroughAt: new Date(anchor + 8 * DAY_MS).toISOString(),
      opsDeadlineAt: new Date(anchor + 8 * DAY_MS).toISOString(),
    },
  });
  const touch1SentAt = anchor + 9 * DAY_MS;
  let decision = resumeWaitTerminalSettleDecision(job, {
    now: touch1SentAt,
    sharedState: {
      chain: {
        claims: {
          1: {
            touch: 1,
            deliveredAt: new Date(touch1SentAt).toISOString(),
          },
        },
      },
    },
    config: liveConfig,
  });
  assert.equal(decision.deadlineExtended, true);
  assert.equal(decision.opsDeadlineAt, anchor + 13 * DAY_MS);
  job = resumeWaitTerminalDeadlineTransition(job, {
    opsDeadlineAt: decision.opsDeadlineAt,
    now: touch1SentAt,
  });
  assert.equal(
    job.automation.resumeWait.terminalAck.opsDeadlineAt,
    new Date(anchor + 13 * DAY_MS).toISOString(),
  );

  const touch2SentAt = anchor + 12 * DAY_MS;
  decision = resumeWaitTerminalSettleDecision(job, {
    now: touch2SentAt,
    sharedState: {
      chain: {
        claims: {
          1: {
            touch: 1,
            deliveredAt: new Date(touch1SentAt).toISOString(),
          },
          2: {
            touch: 2,
            deliveredAt: new Date(touch2SentAt).toISOString(),
          },
        },
      },
    },
    config: liveConfig,
  });
  assert.equal(decision.deadlineExtended, true);
  assert.equal(decision.opsDeadlineAt, anchor + 17 * DAY_MS);
});

test("attach reads are immediate, do not consume scheduled checks, and are consumed once", () => {
  const first = resumeWaitMissingTransition(
    waitingJob(resumeWaitPlan({
      source: "organic",
      anchorAt: anchor,
      waitMinutes: 60,
      retryDays: 7,
    })),
    liveConfig,
    { queueSource: "recovery_status", now: anchor + HOUR_MS },
  ).job;
  const attachSource = `resume_attached:${"a".repeat(64)}`;
  assert.equal(isResumeAttachTrigger(attachSource, first.automation.resumeWait), true);

  const attached = resumeWaitMissingTransition(first, liveConfig, {
    queueSource: attachSource,
    now: anchor + 2 * HOUR_MS,
  });
  assert.equal(attached.expired, false);
  assert.equal(attached.job.automation.resumeWait.scheduledChecks, 1);
  assert.equal(attached.job.automation.resumeWait.nextCheckAt, "2026-07-26T00:00:00.000Z");
  assert.equal(attached.job.automation.resumeWait.lastTrigger, attachSource);
  assert.equal(attached.job.journal.at(-1).detail, "resume check 1/8 (attach trigger): none on file");

  assert.deepEqual(
    resumeWaitCheckDecision(attached.job, liveConfig, {
      queueSource: attachSource,
      now: anchor + 3 * HOUR_MS,
    }),
    {
      check: false,
      scheduled: false,
      attachTriggered: false,
      trigger: "scheduled",
      dueAt: anchor + DAY_MS,
      totalScheduledChecks: 8,
    },
  );
  const nextScheduled = resumeWaitMissingTransition(attached.job, liveConfig, {
    queueSource: attachSource,
    now: anchor + DAY_MS,
  });
  assert.equal(nextScheduled.job.automation.resumeWait.scheduledChecks, 2);
  assert.equal(nextScheduled.job.automation.resumeWait.lastTrigger, attachSource);
  assert.equal(
    resumeWaitCheckDecision(nextScheduled.job, liveConfig, {
      queueSource: attachSource,
      now: anchor + 2 * DAY_MS,
    }).scheduled,
    true,
  );

  const secondAttach = `resume_attached:${"b".repeat(64)}`;
  const found = resumeWaitFoundTransition(attached.job, "s3://resumes/test.pdf", liveConfig, {
    queueSource: secondAttach,
    now: anchor + 4 * HOUR_MS,
  });
  assert.equal(found.state, "ready_to_submit");
  assert.equal(found.submission.resumeUri, "s3://resumes/test.pdf");
  assert.equal(found.automation.resumeWait.scheduledChecks, 1);
  assert.equal(found.automation.resumeWait.nextCheckAt, null);
  assert.equal(found.automation.resumeWait.lastTrigger, secondAttach);
});

test("Calendar resume checks preserve the soft manual-intro reason until a resume restores the card", () => {
  const wait = resumeWaitPlan({
    source: "calendar_human_intro",
    anchorAt: anchor,
    waitMinutes: 60,
    retryDays: 7,
  });
  const calendarJob = waitingJob(wait, {
    id: `hi-${"a".repeat(64)}`,
    humanCall: true,
    humanIntro: true,
    reviewReason: "human_intro_without_transcript",
    reviewReasons: [{
      code: "human_intro_without_transcript",
      message: "human intro call without transcript — preferences confirmed manually",
      soft: true,
    }],
  });
  const missing = resumeWaitMissingTransition(
    calendarJob,
    liveConfig,
    {
      queueSource: "calendar_human_intro_resume_wait",
      now: anchor + HOUR_MS,
    },
  ).job;
  assert.equal(missing.state, "waiting_for_resume");
  assert.equal(
    missing.reviewReason,
    "human_intro_without_transcript",
  );
  assert.deepEqual(
    missing.reviewReasons.map((reason) => reason.code),
    ["human_intro_without_transcript"],
  );

  const found = resumeWaitFoundTransition(
    missing,
    "s3://resumes/calendar-candidate.pdf",
    liveConfig,
    {
      queueSource: `resume_attached:${"b".repeat(64)}`,
      now: anchor + HOUR_MS + 1,
    },
  );
  assert.equal(found.state, "needs_review");
  assert.equal(
    found.reviewReason,
    "human_intro_without_transcript",
  );
  assert.deepEqual(
    found.reviewReasons.map((reason) => reason.code),
    ["human_intro_without_transcript"],
  );
});

test("day-7 terminal settle catches an attach after its first marker check", async () => {
  const scheduledAt = [
    anchor + HOUR_MS,
    ...Array.from({ length: 7 }, (_, index) => anchor + (index + 1) * DAY_MS),
  ];
  let job = waitingJob(resumeWaitPlan({
    source: "organic",
    anchorAt: anchor,
    waitMinutes: 60,
    retryDays: 7,
  }));
  for (const now of scheduledAt) {
    job = resumeWaitMissingTransition(job, liveConfig, {
      queueSource: "recovery_status",
      now,
      probeStartedAt: now - 25,
    }).job;
  }
  assert.equal(job.state, "waiting_for_resume");
  assert.equal(resumeWaitTerminalSettleDecision(job, {
    now: scheduledAt.at(-1),
  }).settling, true);

  let enqueues = 0;
  const firstCheck = await ensureRecentResumeAttachRedue(job, {
    probeStartedAt: scheduledAt.at(-1) - 25,
    now: scheduledAt.at(-1) + 1,
    getSignalImpl: async () => null,
    enqueueImpl: async () => {
      enqueues += 1;
      return { enqueued: true, duplicate: false };
    },
  });
  assert.equal(firstCheck.redue, false);
  assert.equal(enqueues, 0);

  const eventHash = "c".repeat(64);
  const attachAfterFirstCheck = await ensureRecentResumeAttachRedue(job, {
    probeStartedAt: scheduledAt.at(-1) - 25,
    now: scheduledAt.at(-1) + RESUME_WAIT_TERMINAL_ACK_DEADLINE_MS,
    getSignalImpl: async () => ({
      eventHash,
      receivedAt: new Date(scheduledAt.at(-1) + 2).toISOString(),
    }),
    enqueueImpl: async (botId, options) => {
      enqueues += 1;
      assert.equal(botId, job.id);
      assert.deepEqual(options, {
        source: `resume_attached:${eventHash}`,
        eventId: `resume-race:${job.id}:${eventHash}`,
        dueAt: scheduledAt.at(-1) + RESUME_WAIT_TERMINAL_ACK_DEADLINE_MS,
        now: scheduledAt.at(-1) + RESUME_WAIT_TERMINAL_ACK_DEADLINE_MS,
      });
      return { enqueued: true, duplicate: false };
    },
  });
  assert.equal(attachAfterFirstCheck.redue, true);
  assert.equal(enqueues, 1);

  const terminal = resumeWaitTerminalTransition(job, liveConfig, {
    queueSource: `resume_attached:${eventHash}`,
    now: scheduledAt.at(-1) + RESUME_WAIT_TERMINAL_ACK_DEADLINE_MS + 1,
  });
  assert.equal(isTerminalResumeWaitReview(terminal), true);
  assert.equal(terminal.automation.resumeWait.scheduledChecks, 8);
  assert.equal(terminal.automation.resumeWait.lastTrigger, `resume_attached:${eventHash}`);

  assert.equal(
    resumeWaitTerminalAttachMissingTransition(terminal, liveConfig, {
      queueSource: `resume_attached:${eventHash}`,
      now: scheduledAt.at(-1) + RESUME_WAIT_TERMINAL_ACK_DEADLINE_MS + 2,
    }),
    terminal,
    "the same attach event is consumed exactly once",
  );
  const laterAttach = `resume_attached:${"d".repeat(64)}`;
  const found = resumeWaitFoundTransition(
    terminal,
    "s3://resumes/late.pdf",
    liveConfig,
    {
      queueSource: laterAttach,
      now: scheduledAt.at(-1) + RESUME_WAIT_TERMINAL_ACK_DEADLINE_MS + 3,
    },
  );
  assert.equal(found.state, "ready_to_submit");
  assert.equal(found.submission.resumeUri, "s3://resumes/late.pdf");
  assert.equal(found.automation.resumeWait.lastTrigger, laterAttach);
});

test("terminal attach preserves a human review lane and marker enqueue failures are retryable", async () => {
  const wait = {
    ...resumeWaitPlan({
      source: "organic",
      anchorAt: anchor,
      waitMinutes: 60,
      retryDays: 7,
    }),
    scheduledChecks: 8,
    nextCheckAt: null,
  };
  const terminal = resumeWaitTerminalTransition(waitingJob(wait, {
    id: "hc-human12345",
    humanCall: true,
    reviewReason: "human_intro_without_transcript",
    reviewReasons: [{
      code: "human_intro_without_transcript",
      message: "Human intro call without transcript — preferences confirmed manually",
      soft: true,
    }],
  }), liveConfig, {
    queueSource: "recovery_status",
    now: anchor + 7 * DAY_MS,
  });
  assert.deepEqual(
    terminal.reviewReasons.map((reason) => reason.code),
    [
      "human_intro_without_transcript",
      "no_resume_after_7_days",
    ],
  );
  const found = resumeWaitFoundTransition(
    terminal,
    "s3://resumes/human.pdf",
    liveConfig,
    {
      queueSource: `resume_attached:${"e".repeat(64)}`,
      now: anchor + 7 * DAY_MS + 1,
    },
  );
  assert.equal(found.state, "needs_review");
  assert.equal(found.reviewReason, "human_intro_without_transcript");
  assert.equal(found.humanCall, true);
  assert.equal(found.reviewReasons.length, 1);

  await assert.rejects(
    ensureRecentResumeAttachRedue(waitingJob(wait), {
      probeStartedAt: anchor,
      now: anchor + 1,
      getSignalImpl: async () => ({
        eventHash: "f".repeat(64),
        receivedAt: new Date(anchor + 1).toISOString(),
      }),
      enqueueImpl: async () => { throw new Error("queue unavailable"); },
    }),
    (error) => (
      error?.code === "RESUME_ATTACH_REDUE_FAILED" &&
      error?.step === "resume_attach_redue"
    ),
  );
});

test("an unresolved received resume becomes attachment-pending review, not no-resume", () => {
  const wait = {
    ...resumeWaitPlan({
      source: "organic",
      anchorAt: anchor,
      waitMinutes: 60,
      retryDays: 7,
    }),
    scheduledChecks: 8,
    nextCheckAt: new Date(anchor + 8 * DAY_MS).toISOString(),
    terminalAck: {
      status: "awaiting_ack",
      openedAt: new Date(anchor + 7 * DAY_MS).toISOString(),
      markerSinceAt: new Date(anchor + 7 * DAY_MS).toISOString(),
      claimableThroughAt: new Date(anchor + 8 * DAY_MS).toISOString(),
      opsDeadlineAt: new Date(anchor + 8 * DAY_MS).toISOString(),
    },
  };
  const job = waitingJob(wait);
  const stoppedAt = anchor + 6 * DAY_MS;
  const decision = resumeWaitTerminalSettleDecision(job, {
    now: anchor + 7 * DAY_MS,
    sharedState: {
      chain: {
        stopped: true,
        stoppedAt: new Date(stoppedAt).toISOString(),
        stopReason: "resume_received",
        reasonUpdatedAt:
          new Date(stoppedAt + 60 * 60_000).toISOString(),
      },
    },
    config: liveConfig,
  });
  assert.equal(decision.readyToClose, true);
  assert.equal(decision.stopReason, "resume_received");
  assert.equal(decision.acknowledgedAt, stoppedAt);
  const reviewed = resumeWaitTerminalTransition(job, liveConfig, {
    now: anchor + 7 * DAY_MS,
    terminalOutcome: decision.outcome,
    acknowledgedAt: decision.acknowledgedAt,
    terminalStopReason: decision.stopReason,
  });
  assert.equal(
    reviewed.reviewReason,
    "resume_attachment_pending_after_7_days",
  );
  assert.match(
    reviewed.reviewReasons[0].message,
    /received.*pending profile attachment/iu,
  );
  assert.doesNotMatch(reviewed.reviewReasons[0].message, /^No resume/iu);
});

test("only the exact Phase 1 no-resume card sweeps into a newly anchored wait", () => {
  const card = waitingJob(null, {
    state: "needs_review",
    automation: { resumeWaitSweepEligible: true },
    reviewReason: "no_resume_phase1",
    reviewReasons: [{
      code: "no_resume_phase1",
      message: "no resume on profile (resume-wait ships Phase 2)",
      soft: false,
    }],
  });
  assert.equal(isPhase1ResumeWaitCard(card), true);
  assert.equal(isPhase1ResumeWaitCard({
    ...card,
    reviewReason: "identity",
  }), false);

  const swept = phase1ResumeWaitSweepTransition(card, liveConfig, { now: anchor });
  assert.equal(swept.state, "waiting_for_resume");
  assert.equal(swept.reviewReason, null);
  assert.deepEqual(swept.reviewReasons, []);
  assert.equal(swept.automation.resumeWait.source, "phase1_sweep");
  assert.equal(swept.automation.resumeWait.enteredAt, "2026-07-25T00:00:00.000Z");
  assert.equal(swept.automation.resumeWait.firstCheckAt, "2026-07-25T01:00:00.000Z");
});

test("the Phase 1 sweep is gate-safe and repairs a saved-but-not-enqueued sweep", async () => {
  let listCalls = 0;
  const disabled = await sweepPhase1ResumeWaitCards({
    config: { ...readyConfig, resumeWaitEnabled: false },
    listJobsImpl: async () => { listCalls++; return []; },
  });
  assert.equal(disabled.disabled, true);
  assert.equal(disabled.reason, "resume_wait_disabled");
  assert.equal(listCalls, 0);

  const automationNotReady = await sweepPhase1ResumeWaitCards({
    config: { ...readyConfig, autoSubmitApproved: false },
    listJobsImpl: async () => { listCalls++; return []; },
  });
  assert.equal(automationNotReady.disabled, true);
  assert.equal(automationNotReady.reason, "automation_not_ready");
  assert.equal(listCalls, 0);

  const card = waitingJob(null, {
    state: "needs_review",
    automation: { resumeWaitSweepEligible: true },
    reviewReason: "no_resume_phase1",
    reviewReasons: [{ code: "no_resume_phase1", message: "legacy", soft: false }],
  });
  let stored = card;
  let enqueueAttempts = 0;
  const first = await sweepPhase1ResumeWaitCards({
    config: readyConfig,
    now: anchor,
    listJobsImpl: async () => [stored],
    saveJobImpl: async (next, revision) => {
      stored = { ...next, revision: revision + 1 };
      return stored;
    },
    enqueueImpl: async () => {
      enqueueAttempts++;
      throw new Error("temporary queue outage");
    },
  });
  assert.equal(first.swept, 1);
  assert.equal(first.enqueued, 0);
  assert.equal(stored.state, "waiting_for_resume");

  const repaired = await sweepPhase1ResumeWaitCards({
    config: readyConfig,
    now: anchor + 1_000,
    listJobsImpl: async () => [stored],
    saveJobImpl: async () => { throw new Error("already-swept job must not be saved again"); },
    enqueueImpl: async (botId, options) => {
      enqueueAttempts++;
      assert.equal(botId, stored.id);
      assert.equal(options.source, "phase1_resume_sweep");
      assert.equal(options.dueAt, anchor + HOUR_MS);
      return { enqueued: true, duplicate: false };
    },
  });
  assert.equal(repaired.swept, 0);
  assert.equal(repaired.enqueued, 1);
  assert.equal(enqueueAttempts, 2);
});

test("recovery sweep failure is degraded and cannot block the primary queue tick", async () => {
  const calls = [];
  const cycle = await runAutomationCycle({
    mode: "recover",
    config: readyConfig,
    sweepImpl: async ({ config }) => {
      calls.push(["sweep", config]);
      const error = new Error("temporary sweep outage");
      error.code = "SWEEP_TEMPORARY";
      throw error;
    },
    tickImpl: async ({ config }) => {
      calls.push(["tick", config]);
      return { ok: true, processed: [{ botId: "bot_tick_1234" }] };
    },
  });
  assert.deepEqual(calls.map(([name]) => name), ["sweep", "tick"]);
  assert.equal(calls[0][1], readyConfig);
  assert.equal(calls[1][1], readyConfig);
  assert.equal(cycle.resumeSweep, null);
  assert.deepEqual(cycle.resumeSweepError, {
    error: "SWEEP_TEMPORARY",
    detail: "temporary sweep outage",
  });
  assert.equal(cycle.tick.processed[0].botId, "bot_tick_1234");
});

test("authorized backfill persists a common T0 and reroute requirement before enqueue", async () => {
  const order = [];
  const current = backfillJob("bot_resume_1234");
  let anchored = null;
  let eventId = null;
  const results = await enqueueBackfill([current.id], {
    config: liveConfig,
    now: anchor,
    getBackfillAnchorImpl: async () => ({
      version: 1,
      anchorAt: new Date(anchor).toISOString(),
    }),
    getJobImpl: async () => current,
    saveJobImpl: async (next, revision) => {
      order.push("save");
      anchored = { ...next, revision: revision + 1 };
      return anchored;
    },
    enqueueImpl: async (botId, options) => {
      order.push("enqueue");
      assert.equal(botId, current.id);
      assert.equal(options.source, "authorized_backfill");
      assert.equal(options.dueAt, anchor);
      eventId = options.eventId;
      return { botId, enqueued: true, duplicate: false };
    },
  });

  assert.deepEqual(order, ["save", "enqueue"]);
  assert.equal(results[0].batchEntryAt, "2026-07-25T00:00:00.000Z");
  assert.equal(anchored.state, "ready_to_submit");
  assert.equal(anchored.reviewReason, null);
  assert.deepEqual(anchored.reviewReasons, []);
  assert.equal(anchored.automation.mode, "authorized_backfill");
  assert.equal(anchored.automation.preferenceRerouteRequired, true);
  assert.equal(anchored.automation.resumeWait.source, "authorized_backfill");
  assert.equal(anchored.automation.resumeWait.enteredAt, "2026-07-25T00:00:00.000Z");
  assert.equal(eventId, `backfill:${current.id}:${anchor}`);
  assert.deepEqual(
    automationGraceDecision(anchored, liveConfig, anchor + HOUR_MS - 1),
    {
      ready: false,
      dueAt: anchor + HOUR_MS,
      reason: "one-hour post-call grace period",
    },
  );
});

test("disjoint authorized-backfill requests share one durable Phase 2 anchor", async () => {
  const ids = ["bot_batch_part01", "bot_batch_part02"];
  const stored = new Map(ids.map((id) => [id, backfillJob(id)]));
  let durableAnchor = null;
  const getBackfillAnchorImpl = async ({ now }) => {
    durableAnchor ||= {
      version: 1,
      anchorAt: new Date(now).toISOString(),
    };
    return durableAnchor;
  };
  const saveJobImpl = async (next, revision) => {
    const saved = { ...next, revision: revision + 1 };
    stored.set(saved.id, saved);
    return saved;
  };
  const enqueueImpl = async (botId, options) => ({
    botId,
    enqueued: true,
    duplicate: false,
    dueAt: options.dueAt,
  });

  const first = await enqueueBackfill([ids[0]], {
    config: liveConfig,
    now: anchor,
    getBackfillAnchorImpl,
    getJobImpl: async (id) => stored.get(id),
    saveJobImpl,
    enqueueImpl,
  });
  const second = await enqueueBackfill([ids[1]], {
    config: liveConfig,
    now: anchor + 2 * HOUR_MS,
    getBackfillAnchorImpl,
    getJobImpl: async (id) => stored.get(id),
    saveJobImpl,
    enqueueImpl,
  });

  assert.equal(first[0].batchEntryAt, new Date(anchor).toISOString());
  assert.equal(second[0].batchEntryAt, first[0].batchEntryAt);
  assert.equal(
    stored.get(ids[0]).automation.resumeWait.enteredAt,
    stored.get(ids[1]).automation.resumeWait.enteredAt,
  );
  assert.equal(
    stored.get(ids[0]).automation.resumeWait.firstCheckAt,
    stored.get(ids[1]).automation.resumeWait.firstCheckAt,
  );
});

test("supervised backfill preserves identity, contact, sponsorship, technical, and human lanes", async () => {
  const cases = [
    [
      "bot_identity_01",
      backfillJob("bot_identity_01", { identity: { ambiguous: true } }),
      "identity_review",
    ],
    [
      "bot_linkedin_01",
      backfillJob("bot_linkedin_01", { submission: { linkedinUrl: "" } }),
      "linkedin_review",
    ],
    [
      "bot_email_0001",
      backfillJob("bot_email_0001", { submission: { email: "" } }),
      "email_review",
    ],
    [
      "bot_sponsor_001",
      backfillJob("bot_sponsor_001", {
        reviewReason: "sponsorship",
        reviewReasons: [{
          code: "sponsorship",
          message: "Sponsorship eligibility requires human review",
          soft: false,
        }],
      }),
      "hard_review_reason",
    ],
    [
      "bot_techfail_01",
      backfillJob("bot_techfail_01", {
        automation: {
          lastFailure: {
            code: "PROFILE_READ_FAILED",
            message: "profile unavailable",
            step: "profile_read",
          },
        },
      }),
      "technical_review",
    ],
    [
      "bot_error_0001",
      backfillJob("bot_error_0001", { state: "error" }),
      "state_preserved",
    ],
    [
      "hc-humanbackfill",
      backfillJob("hc-humanbackfill", { humanCall: true }),
      "human_call_lane",
    ],
  ];
  for (const [, job, reason] of cases) {
    assert.deepEqual(backfillReviewDecision(job), {
      eligible: false,
      reason,
      reasons: reason === "hard_review_reason"
        ? ["sponsorship", "sponsorship eligibility requires human review"]
        : [],
    });
  }
  assert.equal(backfillReviewDecision(backfillJob("bot_legacy_0001")).eligible, true);

  const jobs = new Map(cases.map(([id, job]) => [id, job]));
  let saves = 0;
  let enqueues = 0;
  const results = await enqueueBackfill(cases.map(([id]) => id), {
    config: liveConfig,
    now: anchor,
    getBackfillAnchorImpl: async () => ({
      version: 1,
      anchorAt: new Date(anchor).toISOString(),
    }),
    getJobImpl: async (id) => jobs.get(id),
    saveJobImpl: async () => { saves += 1; assert.fail("hard review rows must not be mutated"); },
    enqueueImpl: async () => { enqueues += 1; assert.fail("hard review rows must not enqueue"); },
  });
  assert.equal(saves, 0);
  assert.equal(enqueues, 0);
  assert.deepEqual(
    results.map((result) => [result.botId, result.preserved, result.error]),
    cases.map(([id, , reason]) => [id, true, reason]),
  );
});

test("backfill isolates rows and reuses the persisted common T0 and deterministic event on retry", async () => {
  const ids = ["bot_backfill_a1", "bot_backfill_b2", "bot_backfill_c3"];
  const readFailureId = "bot_readfail_01";
  const stored = new Map(ids.map((id) => [id, backfillJob(id)]));
  let saveCalls = 0;
  let round = 1;
  const events = [];
  const getJobImpl = async (id) => {
    if (id === readFailureId) {
      const error = new Error("read unavailable");
      error.code = "READ_TEMPORARY";
      throw error;
    }
    return stored.get(id);
  };
  const saveJobImpl = async (next, revision) => {
    saveCalls += 1;
    const saved = { ...next, revision: revision + 1 };
    stored.set(saved.id, saved);
    return saved;
  };
  const enqueueImpl = async (id, options) => {
    events.push({ round, id, ...options });
    if (round === 1 && id === ids[1]) {
      const error = new Error("queue unavailable");
      error.code = "QUEUE_TEMPORARY";
      throw error;
    }
    return { botId: id, enqueued: true, duplicate: false };
  };

  const first = await enqueueBackfill(
    [ids[0], readFailureId, ids[1], ids[2], ids[0]],
    {
      config: liveConfig,
      now: anchor,
      getBackfillAnchorImpl: async () => ({
        version: 1,
        anchorAt: new Date(anchor).toISOString(),
      }),
      getJobImpl,
      saveJobImpl,
      enqueueImpl,
    },
  );
  assert.equal(saveCalls, 3);
  assert.equal(first[0].enqueued, true);
  assert.equal(first[1].error, "READ_TEMPORARY");
  assert.equal(first[2].error, "QUEUE_TEMPORARY");
  assert.equal(first[3].enqueued, true, "a failed row must not block later rows");
  assert.equal(first[4].error, "duplicate_input");
  for (const id of ids) {
    const job = stored.get(id);
    assert.equal(job.automation.backfillBatchEntryAt, new Date(anchor).toISOString());
    assert.equal(job.automation.resumeWait.enteredAt, new Date(anchor).toISOString());
    assert.equal(job.automation.resumeWait.firstCheckAt, new Date(anchor + HOUR_MS).toISOString());
  }
  const firstEvents = new Map(
    events.filter((event) => event.round === 1).map((event) => [event.id, event.eventId]),
  );

  round = 2;
  const journalsBeforeRetry = new Map(
    ids.map((id) => [id, stored.get(id).journal.length]),
  );
  const second = await enqueueBackfill(ids, {
    config: liveConfig,
    now: anchor + DAY_MS,
    getBackfillAnchorImpl: async () => ({
      version: 1,
      anchorAt: new Date(anchor).toISOString(),
    }),
    getJobImpl,
    saveJobImpl: async () => assert.fail("an anchored retry must not save or shift T0"),
    enqueueImpl,
  });
  assert.equal(saveCalls, 3);
  assert.equal(second.every((result) => result.enqueued), true);
  for (const id of ids) {
    const retryEvent = events.find((event) => event.round === 2 && event.id === id);
    assert.equal(retryEvent.eventId, firstEvents.get(id));
    assert.equal(retryEvent.eventId, `backfill:${id}:${anchor}`);
    assert.equal(stored.get(id).automation.resumeWait.enteredAt, new Date(anchor).toISOString());
    assert.equal(stored.get(id).journal.length, journalsBeforeRetry.get(id));
  }
});

test("an already-submitted returning candidate leaves resume wait for the per-call match leg", () => {
  const wait = resumeWaitPlan({
    source: "organic",
    anchorAt: anchor,
    waitMinutes: 60,
    retryDays: 7,
  });
  const transitioned = existingTalentNetworkTransition(waitingJob(wait), {
    checkedAt: "2026-07-25T02:00:00.000Z",
    approvalSource: "recall_verified_automation",
  });
  assert.equal(transitioned.state, "awaiting_matches");
  assert.equal(transitioned.matchLegStartedAt, "2026-07-25T02:00:00.000Z");
  assert.equal(transitioned.submitReadbackVerified, true);
  assert.equal(transitioned.automation.resumeWait.source, "organic");
  assert.match(transitioned.journal.at(-1).detail, /submission write skipped/);
});

test("submission-intent recovery stops resume asks before its reconciliation reschedule", async () => {
  const source = await readFile(
    new URL("../api/paraai/_lib/auto.mjs", import.meta.url),
    "utf8",
  );
  assert.match(
    source,
    /if \(intent && !intent\.attemptStartedAt\)[\s\S]*?submitJob\(job,[\s\S]*?await stopResumeChase\([\s\S]*?return \{[\s\S]*?detail: "submission accepted; approval pending"/,
  );
});
