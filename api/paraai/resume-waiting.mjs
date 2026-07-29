import {
  activateResumeChaseGeneration,
  ackResumeAskTerminal,
  claimResumeAskSuppression,
  confirmResumeAskSuppression,
  enqueueAutoJob,
  getJob,
  getResumeAskSuppression,
  hashedResumeCandidateId,
  listWaitingResumeJobs,
  resumeChaseChainId,
  saveJob,
  stopResumeAskSuppression,
  storeConfigured,
  transition,
} from "./_lib/store.mjs";
import {
  HUMAN_INTRO_RESUME_AMBIGUOUS_CODE,
  HUMAN_INTRO_RESUME_AMBIGUOUS_MESSAGE,
  HUMAN_INTRO_RESUME_REVIEW_CODE,
  HUMAN_INTRO_RESUME_REVIEW_MESSAGE,
  humanIntroProvenance,
} from "./_lib/human-intro.mjs";
import {
  RESUME_RECEIVED_REVIEW_CODE,
  RESUME_RECEIVED_REVIEW_MESSAGE,
  resumeChaseInitialAckDeadline,
  resumeChaseNextDeliveryAckDeadline,
  resumeWaitSettings,
} from "./_lib/resume-wait.mjs";
import {
  requestPathname,
  verifyResumeSignal,
} from "./_lib/resume-signal.mjs";

export const config = { maxDuration: 30 };

function json(value, status = 200) {
  return Response.json(value, {
    status,
    headers: { "cache-control": "private, no-store" },
  });
}

function compact(value, limit = 200) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, limit);
}

function deliverableEmail(value) {
  const email = compact(value, 254).toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return null;
  return ["@paraform.com", "@raydar.xyz", "@raydargroup.com"]
    .some((suffix) => email.endsWith(suffix))
    ? null
    : email;
}

function canonicalInstant(value) {
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function bookingSourceId(value) {
  const selected = String(value || "").trim();
  return /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u.test(selected)
    ? selected
    : null;
}

function resumeLinkDisposition(job) {
  if (callType(job) !== "human") return null;
  const selected = compact(
    job?.resumeLinkDisposition
    || job?.humanCallMeta?.resumeLinkDisposition,
    30,
  );
  return new Set([
    "none",
    "unusable",
    "ambiguous",
    "received",
    "received_review",
  ]).has(selected)
    ? selected
    : null;
}

function resumeReceipt(job) {
  const disposition = resumeLinkDisposition(job);
  const receipt = job?.resumeReceipt || job?.humanCallMeta?.resumeReceipt;
  let expectedSource = "calendar_resume_link";
  if (
    job?.humanIntro === true
    && (
      job?.humanCallMeta?.source
      || job?.humanCallMeta?.parserVersion
    )
  ) {
    try {
      expectedSource = humanIntroProvenance(
        job?.humanCallMeta?.source,
        job?.humanCallMeta?.parserVersion,
      ).resumeReceiptSource;
    } catch {
      return null;
    }
  }
  if (
    !receipt
    || typeof receipt !== "object"
    || Array.isArray(receipt)
    || receipt.source !== expectedSource
    || !["received", "received_review"].includes(receipt.status)
    || receipt.status !== disposition
    || !/^[a-f0-9]{64}$/u.test(String(receipt.artifactSha256 || ""))
    || !new Set([
      "application/pdf",
      "application/msword",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/rtf",
    ]).has(receipt.mimeType)
  ) {
    return null;
  }
  return {
    source: expectedSource,
    status: receipt.status,
    artifactSha256: receipt.artifactSha256,
    mimeType: receipt.mimeType,
  };
}

function callType(job) {
  const explicit = compact(job?.callType || job?.call?.type || "", 30).toLowerCase();
  if (explicit === "human" || explicit === "agent") return explicit;
  return String(job?.id || "").startsWith("hc-") ? "human" : "agent";
}

function sharedDeliveryAckDeadline(suppression, terminalAckHours) {
  const chainDeadline = resumeChaseNextDeliveryAckDeadline(
    suppression?.chain,
    { terminalAckHours },
  );
  const carriedTouch = Number(
    suppression?.currentGeneration?.lastDeliveredTouch,
  );
  const carriedAt = canonicalInstant(
    suppression?.currentGeneration?.lastSentAt,
  );
  const carriedDeadline = [1, 2].includes(carriedTouch) && carriedAt
    ? resumeChaseNextDeliveryAckDeadline({
        claims: {
          [carriedTouch]: {
            touch: carriedTouch,
            deliveredAt: carriedAt,
          },
        },
      }, { terminalAckHours })
    : null;
  return Math.max(chainDeadline || 0, carriedDeadline || 0) || null;
}

function resumeWaitState(job, suppression) {
  const wait = job?.automation?.resumeWait || {};
  const settings = resumeWaitSettings();
  const enteredAt = compact(
    wait.enteredAt
    || [...(job?.journal || [])].reverse().find((row) => row?.state === "waiting_for_resume")?.at
    || job?.updatedAt,
    40,
  ) || null;
  const checkCount = Number(wait.scheduledChecks ?? wait.checkCount ?? wait.checks ?? wait.attempt ?? 0);
  const terminal = wait?.terminalAck;
  const storedClaimDeadlineAt = canonicalInstant(
    wait?.claimableThroughAt,
  );
  const initialClaimDeadline = resumeChaseInitialAckDeadline({
    source: wait?.source || job?.automation?.mode || "organic",
    enteredAt,
    callEndedAt: job?.callEndedAt,
    terminalAckHours: settings.terminalAckHours,
    backfillTerminalAckDays: settings.backfillTerminalAckDays,
  });
  const nextDeliveryDeadline = sharedDeliveryAckDeadline(
    suppression,
    settings.terminalAckHours,
  );
  const effectiveClaimDeadlineAt = Math.max(
    Date.parse(storedClaimDeadlineAt || "") || 0,
    initialClaimDeadline || 0,
    nextDeliveryDeadline || 0,
  ) || null;
  const effectiveClaimDeadlineIso = effectiveClaimDeadlineAt == null
    ? null
    : new Date(effectiveClaimDeadlineAt).toISOString();
  return {
    source: compact(wait.source || job?.automation?.mode || "organic", 40) || "organic",
    enteredAt,
    expiresAt: compact(wait.expiresAt, 40) || null,
    claimableThroughAt: compact(
      effectiveClaimDeadlineIso,
      40,
    ) || null,
    checkCount: Number.isFinite(checkCount) ? Math.max(0, Math.floor(checkCount)) : 0,
    terminalAck: terminal && typeof terminal === "object"
      ? {
          status: compact(terminal.status, 30) || "awaiting_ack",
          openedAt: canonicalInstant(terminal.openedAt),
          opsDeadlineAt: canonicalInstant(terminal.opsDeadlineAt),
          outcome: compact(terminal.outcome, 30) || null,
          acknowledgedAt: canonicalInstant(terminal.acknowledgedAt),
        }
      : null,
  };
}

function claimDeadlineExtension(job, suppression) {
  const wait = job?.automation?.resumeWait;
  const storedDeadlineAt = Date.parse(
    String(wait?.claimableThroughAt || ""),
  );
  const settings = resumeWaitSettings();
  const initialDeadlineAt = resumeChaseInitialAckDeadline({
    source: wait?.source || job?.automation?.mode || "organic",
    enteredAt: wait?.enteredAt,
    callEndedAt: job?.callEndedAt,
    terminalAckHours: settings.terminalAckHours,
    backfillTerminalAckDays: settings.backfillTerminalAckDays,
  });
  const nextDeliveryDeadlineAt = sharedDeliveryAckDeadline(
    suppression,
    settings.terminalAckHours,
  );
  const effectiveDeadlineAt = Math.max(
    initialDeadlineAt || 0,
    nextDeliveryDeadlineAt || 0,
  ) || null;
  const terminalDeadlineAt = Date.parse(
    String(wait?.terminalAck?.opsDeadlineAt || ""),
  );
  if (
    job?.state !== "waiting_for_resume"
    || !Number.isFinite(effectiveDeadlineAt)
    || (
      Number.isFinite(storedDeadlineAt)
      && effectiveDeadlineAt <= storedDeadlineAt
      && (
        wait?.terminalAck?.status !== "awaiting_ack"
        || (
          Number.isFinite(terminalDeadlineAt)
          && effectiveDeadlineAt <= terminalDeadlineAt
        )
      )
    )
  ) {
    return null;
  }
  return effectiveDeadlineAt;
}

function withClaimDeadline(job, deadlineAt) {
  const deadline = new Date(deadlineAt).toISOString();
  const terminal = job?.automation?.resumeWait?.terminalAck;
  const terminalDeadlineAt = terminal?.status === "awaiting_ack"
    ? Math.max(
        Date.parse(String(terminal.opsDeadlineAt || "")) || 0,
        deadlineAt,
      )
    : null;
  return transition(job, "waiting_for_resume", {
    automation: {
      ...(job.automation || {}),
      status: "waiting_for_resume",
      resumeWait: {
        ...job.automation.resumeWait,
        claimableThroughAt: deadline,
        ...(terminal?.status === "awaiting_ack"
          ? {
              nextCheckAt: new Date(terminalDeadlineAt).toISOString(),
              terminalAck: {
                ...terminal,
                opsDeadlineAt:
                  new Date(terminalDeadlineAt).toISOString(),
              },
            }
          : {}),
      },
    },
    journalDetail:
      "resume terminal acknowledgement deadline extended for the next legitimate chase delivery",
  });
}

async function persistClaimDeadline(
  job,
  suppression,
  {
    save,
    loadJob,
  },
) {
  let current = job;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const deadlineAt = claimDeadlineExtension(current, suppression);
    if (deadlineAt == null) return current;
    try {
      return await save(
        withClaimDeadline(current, deadlineAt),
        current.revision,
      );
    } catch (error) {
      if (error?.code !== "REVISION_CONFLICT" || attempt > 0) throw error;
      current = await loadJob(current.id);
      if (!current) throw error;
    }
  }
  return current;
}

function suppressionSummary(record, chaseChainId) {
  const chain = record?.chain;
  const satisfaction = record?.candidateSatisfaction;
  const current = record?.currentGeneration;
  const superseded = Boolean(
    current?.chainId
    && current.chainId !== chaseChainId,
  );
  const deliveredClaimTouch = Object.entries(chain?.claims || {})
    .reduce((highest, [touch, claim]) => (
      claim?.deliveredAt
        ? Math.max(highest, Number(touch) || 0)
        : highest
    ), 0);
  const carriedTouch = current?.terminalAck?.outcome === "delivered"
    ? 3
    : Number(current?.lastDeliveredTouch);
  const chainTouch = Math.max(
    Number(chain?.lastDeliveredTouch) || 0,
    deliveredClaimTouch,
    chain?.terminalAck?.outcome === "delivered" ? 3 : 0,
  );
  const lastTouch = Math.max(
    Number.isInteger(carriedTouch) ? carriedTouch : 0,
    Number.isInteger(chainTouch) ? chainTouch : 0,
  ) || null;
  const touchCapReached = Boolean(
    !superseded
    && lastTouch === 3
  );
  const sentAtCandidates = [];
  if (lastTouch && carriedTouch === lastTouch && current?.lastSentAt) {
    sentAtCandidates.push(current.lastSentAt);
  }
  if (lastTouch && chainTouch === lastTouch && chain?.lastSentAt) {
    sentAtCandidates.push(chain.lastSentAt);
  }
  const lastSentAt = sentAtCandidates
    .map((value) => compact(value, 40))
    .filter(Boolean)
    .sort()
    .at(-1) || null;
  return {
    candidateSatisfied: satisfaction?.satisfied === true,
    candidateSatisfactionReason: compact(satisfaction?.reason, 80) || null,
    chainStopped: Boolean(
      superseded
      || touchCapReached
      || chain?.stopped
      || chain?.status === "stopped",
    ),
    chainStopReason: superseded
      ? "superseded_by_newer_chain"
      : touchCapReached
        ? "candidate_touch_cap_reached"
      : compact(chain?.stopReason, 80) || null,
    chainStoppedAt: canonicalInstant(chain?.stoppedAt),
    chainCancellationAt: canonicalInstant(
      chain?.cancellationAt
      || (chain?.stopReason === "cancelled" ? chain?.stoppedAt : null),
    ),
    lastTouch,
    lastSentAt,
  };
}

function waitingFeedRow(job, suppression) {
  const candidateUserId = compact(job?.identity?.candidateUserId, 200);
  const chainAnchorAt = canonicalInstant(
    job?.automation?.resumeWait?.enteredAt,
  );
  if (!candidateUserId || !chainAnchorAt) return null;
  const bookingCreatedAt = canonicalInstant(job?.bookingCreatedAt);
  const bookingCreatedAtSource = bookingCreatedAt
    ? compact(job?.bookingCreatedAtSource, 80) || null
    : null;
  const sourceId = bookingSourceId(
    callType(job) === "agent"
      ? job?.bookingSourceId || job?.candidate?.paraformEventId
      : job?.bookingSourceId || job?.humanCallMeta?.sourceId,
  );
  const chaseChainId = resumeChaseChainId(job.id, chainAnchorAt);
  return {
    jobId: compact(job?.id, 100),
    candidateUserId,
    candidateHash: hashedResumeCandidateId(candidateUserId),
    chaseChainId,
    candidateName: compact(job?.submission?.name || job?.identity?.candidateName, 120) || null,
    email: deliverableEmail(job?.submission?.email || job?.identity?.email),
    callType: callType(job),
    bookingCreatedAt,
    bookingCreatedAtSource,
    bookingSourceId: sourceId,
    resumeLinkDisposition: resumeLinkDisposition(job),
    resumeReceipt: resumeReceipt(job),
    callEndedAt: compact(job?.callEndedAt, 40) || null,
    scheduledAt: canonicalInstant(job?.candidate?.scheduledStart),
    resumeWait: resumeWaitState(job, suppression),
    suppression: suppressionSummary(suppression, chaseChainId),
  };
}

function parseAction(rawBody) {
  let body;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return null;
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const action = compact(body.action, 30);
  if (!new Set([
    "claim_send",
    "confirm_send",
    "stop",
    "ack_terminal",
    "record_booking_created_at",
  ]).has(action)) return null;
  const jobId = compact(body.jobId, 100);
  if (!/^[A-Za-z0-9_-]{8,100}$/.test(jobId)) return null;
  const chaseChainId = compact(body.chaseChainId, 80).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(chaseChainId)) return null;
  const candidateHash = body.candidateHash == null ? "" : compact(body.candidateHash, 80);
  if (candidateHash && !/^[a-f0-9]{64}$/.test(candidateHash)) return null;
  if (action === "record_booking_created_at") {
    const sourceId = bookingSourceId(body.bookingSourceId);
    const bookingCreatedAt = canonicalInstant(body.bookingCreatedAt);
    if (!sourceId || !bookingCreatedAt) return null;
    return {
      action,
      jobId,
      candidateHash,
      chaseChainId,
      bookingSourceId: sourceId,
      bookingCreatedAt,
    };
  }
  if (action === "stop") {
    const reason = compact(body.reason || "stopped", 80);
    if (!/^[A-Za-z0-9:_-]{1,80}$/.test(reason)) return null;
    return { action, jobId, candidateHash, chaseChainId, reason };
  }
  const touch = Number(body.touch);
  const eventId = typeof body.eventId === "string" ? body.eventId.trim() : "";
  if (!Number.isInteger(touch) || touch < 1 || touch > 3 || !eventId || eventId.length > 240) {
    return null;
  }
  if (action === "claim_send") {
    const dueAt = body.dueAt == null ? null : compact(body.dueAt, 40);
    if (dueAt && !Number.isFinite(Date.parse(dueAt))) return null;
    return { action, jobId, candidateHash, chaseChainId, touch, eventId, dueAt };
  }
  const acknowledgedAt = body.acknowledgedAt == null
    ? null
    : compact(body.acknowledgedAt, 40);
  if (acknowledgedAt && !Number.isFinite(Date.parse(acknowledgedAt))) return null;
  const deliveredAt = body.deliveredAt == null
    ? null
    : compact(body.deliveredAt, 40);
  if (deliveredAt && !Number.isFinite(Date.parse(deliveredAt))) return null;
  const deliveryDigest = body.deliveryDigest == null ? "" : compact(body.deliveryDigest, 240);
  if (action === "ack_terminal") {
    const outcome = compact(body.outcome, 30);
    if (touch !== 3 || !["delivered", "terminal_no_send"].includes(outcome)) {
      return null;
    }
    return {
      action,
      jobId,
      candidateHash,
      chaseChainId,
      touch,
      eventId,
      outcome,
      acknowledgedAt,
      deliveryDigest,
    };
  }
  return {
    action,
    jobId,
    candidateHash,
    chaseChainId,
    touch,
    eventId,
    deliveredAt,
    deliveryDigest,
  };
}

async function resolveActionCandidate(action, loadJob) {
  const job = await loadJob(action.jobId);
  const candidateUserId = compact(job?.identity?.candidateUserId, 200);
  if (!job || !candidateUserId) return null;
  const candidateHash = hashedResumeCandidateId(candidateUserId);
  if (action.candidateHash && action.candidateHash !== candidateHash) return null;
  const chainAnchorAt = canonicalInstant(
    job?.automation?.resumeWait?.enteredAt,
  );
  if (
    !chainAnchorAt
    || action.chaseChainId !== resumeChaseChainId(job.id, chainAnchorAt)
  ) {
    return null;
  }
  return { job, candidateUserId, chainAnchorAt };
}

async function enqueueTerminalClosure(job, enqueue, nowMs, outcome) {
  if (
    job?.state !== "waiting_for_resume"
    || job?.automation?.resumeWait?.terminalAck?.status !== "awaiting_ack"
  ) {
    return null;
  }
  return enqueue(job.id, {
    source: "resume_chase_terminal_ack",
    eventId: `resume-terminal-ack:${job.id}:${outcome}`,
    dueAt: nowMs,
    now: nowMs,
  });
}

async function saveHardResumeReview(
  job,
  {
    code,
    message,
    save,
  },
) {
  if (job?.state !== "waiting_for_resume") return job;
  const existingReasons = Array.isArray(job?.reviewReasons)
    ? job.reviewReasons
    : [];
  const reviewReasons = [
    ...existingReasons.filter((reason) => reason?.code !== code),
    {
      code,
      message,
      soft: false,
    },
  ];
  return save(transition(job, "needs_review", {
    reviewReason: code,
    reviewReasons,
    automation: {
      ...(job.automation || {}),
      status: "needs_review",
      reasons: reviewReasons.map((reason) => (
        reason.message || reason.code
      )),
    },
    journalDetail: message,
  }), job.revision);
}

export async function handleResumeWaiting(request, {
  secret = process.env.PARAAI_RESUME_SIGNAL_SECRET,
  verify = verifyResumeSignal,
  hasStore = storeConfigured,
  listWaiting = listWaitingResumeJobs,
  loadJob = getJob,
  getSuppression = getResumeAskSuppression,
  activateGeneration = activateResumeChaseGeneration,
  claimSuppression = claimResumeAskSuppression,
  confirmSuppression = confirmResumeAskSuppression,
  stopSuppression = stopResumeAskSuppression,
  ackTerminal = ackResumeAskTerminal,
  enqueue = enqueueAutoJob,
  save = saveJob,
  now = () => Date.now(),
} = {}) {
  if (!["GET", "POST"].includes(request.method)) {
    return json({ ok: false, error: "GET_or_POST_only" }, 405);
  }
  const rawBody = await request.text();
  const nowMs = Number(now());
  try {
    verify({
      secret,
      headers: request.headers,
      method: request.method,
      pathname: requestPathname(request),
      rawBody,
      nowMs,
    });
  } catch {
    return json({ ok: false, error: "unauthorized" }, 401);
  }
  if (!hasStore()) return json({ ok: false, error: "state_store_not_configured" }, 503);

  if (request.method === "GET") {
    try {
      const listed = await listWaiting(500, {
        withCompleteness: true,
      });
      const jobs = Array.isArray(listed)
        ? listed
        : Array.isArray(listed?.jobs)
          ? listed.jobs
          : [];
      const storeComplete = !Array.isArray(listed) && listed?.complete === true;
      await Promise.all(jobs.map((job) => {
        const candidateUserId = compact(
          job?.identity?.candidateUserId,
          200,
        );
        const chainAnchorAt = canonicalInstant(
          job?.automation?.resumeWait?.enteredAt,
        );
        if (!candidateUserId || !chainAnchorAt) return null;
        return activateGeneration(candidateUserId, {
          jobId: job.id,
          chainId: resumeChaseChainId(job.id, chainAnchorAt),
          chainAnchorAt,
          chainCallEndedAt: canonicalInstant(job?.callEndedAt) || "",
          activatedAt: new Date(nowMs).toISOString(),
        });
      }));
      await Promise.all(jobs.map((job) => {
        if (
          resumeLinkDisposition(job) !== "received"
          || resumeReceipt(job)?.status !== "received"
        ) {
          return null;
        }
        const candidateUserId = compact(
          job?.identity?.candidateUserId,
          200,
        );
        const chainAnchorAt = canonicalInstant(
          job?.automation?.resumeWait?.enteredAt,
        );
        if (!candidateUserId || !chainAnchorAt) return null;
        return stopSuppression(candidateUserId, {
          jobId: job.id,
          chainId: resumeChaseChainId(job.id, chainAnchorAt),
          chainAnchorAt,
          chainCallEndedAt: canonicalInstant(job?.callEndedAt) || "",
          reason: "resume_received",
          stoppedAt: new Date(nowMs).toISOString(),
        });
      }));
      const records = await Promise.all(jobs.map((job) => {
        const candidateUserId = compact(job?.identity?.candidateUserId, 200);
        const chainAnchorAt = canonicalInstant(
          job?.automation?.resumeWait?.enteredAt,
        );
        return candidateUserId && chainAnchorAt
          ? getSuppression(candidateUserId, {
              chainId: resumeChaseChainId(job.id, chainAnchorAt),
            })
          : null;
      }));
      const reconciledJobs = await Promise.all(jobs.map((job, index) => (
        persistClaimDeadline(job, records[index], {
          save,
          loadJob,
        })
      )));
      const waiting = reconciledJobs
        .map((job, index) => waitingFeedRow(job, records[index]))
        .filter(Boolean);
      const complete = Boolean(
        storeComplete
        && waiting.length === reconciledJobs.length
      );
      return json({
        ok: true,
        generatedAt: new Date(nowMs).toISOString(),
        count: waiting.length,
        complete,
        totalWaiting: complete
          ? Number(listed?.totalWaiting ?? waiting.length)
          : null,
        waiting,
      });
    } catch {
      return json({ ok: false, error: "waiting_feed_unavailable" }, 503);
    }
  }

  const action = parseAction(rawBody);
  if (!action) return json({ ok: false, error: "invalid_request" }, 400);
  try {
    const resolved = await resolveActionCandidate(action, loadJob);
    if (!resolved) return json({ ok: true, status: "not_found", allowed: false });
    let { job } = resolved;
    const { candidateUserId, chainAnchorAt } = resolved;
    const chaseScope = {
      jobId: action.jobId,
      chainId: action.chaseChainId,
      chainAnchorAt,
      chainCallEndedAt: canonicalInstant(job?.callEndedAt) || "",
    };
    if (action.action === "record_booking_created_at") {
      const persistedSourceId = callType(job) === "agent"
        ? bookingSourceId(
            job?.bookingSourceId || job?.candidate?.paraformEventId,
          )
        : null;
      if (
        !persistedSourceId
        || persistedSourceId !== action.bookingSourceId
      ) {
        return json({
          ok: true,
          status: "source_conflict",
          recorded: false,
          idempotent: false,
        }, 409);
      }
      const existingAt = canonicalInstant(job?.bookingCreatedAt);
      const existingSource = compact(
        job?.bookingCreatedAtSource,
        80,
      ) || null;
      if (existingAt) {
        const idempotent = (
          existingAt === action.bookingCreatedAt
          && existingSource === "gmail_paraform_booking_notification"
        );
        return json({
          ok: true,
          status: idempotent ? "existing" : "booking_time_conflict",
          recorded: idempotent,
          idempotent,
        }, idempotent ? 200 : 409);
      }
      await save(transition(job, job.state, {
        bookingSourceId: persistedSourceId,
        bookingCreatedAt: action.bookingCreatedAt,
        bookingCreatedAtSource:
          "gmail_paraform_booking_notification",
        journalDetail:
          "immutable booking creation time resolved from exact Paraform Gmail notification",
      }), job.revision);
      return json({
        ok: true,
        status: "recorded",
        recorded: true,
        idempotent: false,
      });
    }
    if (action.action === "claim_send") {
      const disposition = resumeLinkDisposition(job);
      const receipt = resumeReceipt(job);
      const receiptDisposition = [
        "received",
        "received_review",
      ].includes(disposition);
      const inconsistentReceipt = receiptDisposition && !receipt;
      if (
        (disposition === "received" && receipt?.status === "received")
        || (
          disposition === "received_review"
          && receipt?.status === "received_review"
        )
        || disposition === "ambiguous"
        || inconsistentReceipt
      ) {
        const received = (
          disposition === "received"
          && receipt?.status === "received"
        );
        const result = await stopSuppression(candidateUserId, {
          ...chaseScope,
          reason: received
            ? "resume_received"
            : RESUME_RECEIVED_REVIEW_CODE,
          stoppedAt: new Date(nowMs).toISOString(),
        });
        if (!received) {
          const review = disposition === "ambiguous"
            ? {
                code: HUMAN_INTRO_RESUME_AMBIGUOUS_CODE,
                message: HUMAN_INTRO_RESUME_AMBIGUOUS_MESSAGE,
              }
            : {
                code: HUMAN_INTRO_RESUME_REVIEW_CODE,
                message: HUMAN_INTRO_RESUME_REVIEW_MESSAGE,
              };
          job = await saveHardResumeReview(job, {
            ...review,
            save,
          });
        }
        return json({
          ok: true,
          status: received
            ? "candidate_satisfied"
            : "resume_review_required",
          allowed: false,
          idempotent: Boolean(result.idempotent),
          confirmed: false,
        });
      }
      if (!canonicalInstant(job?.bookingCreatedAt)) {
        return json({
          ok: true,
          status: "booking_time_unresolved",
          allowed: false,
          idempotent: false,
          confirmed: false,
        });
      }
      if (job.state === "waiting_for_resume") {
        const sharedState = await getSuppression(candidateUserId, {
          chainId: action.chaseChainId,
        });
        job = await persistClaimDeadline(job, sharedState, {
          save,
          loadJob,
        });
        const waitState = resumeWaitState(job, sharedState);
        const claimableThroughAt = Date.parse(
          String(waitState.claimableThroughAt || ""),
        );
        if (
          Number.isFinite(claimableThroughAt)
          && nowMs > claimableThroughAt
        ) {
          return json({
            ok: true,
            status: "deadline_elapsed",
            allowed: false,
            idempotent: false,
            confirmed: false,
          });
        }
      }
      const result = await claimSuppression(candidateUserId, {
        eventId: action.eventId,
        touch: action.touch,
        ...chaseScope,
        source: "resume_chase",
        claimedAt: new Date(nowMs).toISOString(),
        dueAt: action.dueAt,
      });
      return json({
        ok: true,
        status: result.status,
        allowed: result.allowed,
        idempotent: result.idempotent,
        confirmed: Boolean(result.confirmed),
      });
    }
    if (action.action === "confirm_send") {
      const result = await confirmSuppression(candidateUserId, {
        eventId: action.eventId,
        touch: action.touch,
        ...chaseScope,
        deliveredAt: action.deliveredAt || new Date(nowMs).toISOString(),
        deliveryDigest: action.deliveryDigest,
      });
      if (result.confirmed === true) {
        job = await persistClaimDeadline(job, {
          chain: result.record,
        }, {
          save,
          loadJob,
        });
      }
      if (result.confirmed === true && action.touch === 3) {
        await enqueueTerminalClosure(job, enqueue, nowMs, "delivered");
      }
      return json({
        ok: true,
        status: result.status,
        confirmed: result.confirmed,
        idempotent: result.idempotent,
      }, result.confirmed === true ? 200 : 409);
    }
    if (action.action === "ack_terminal") {
      const result = await ackTerminal(candidateUserId, {
        eventId: action.eventId,
        touch: action.touch,
        ...chaseScope,
        outcome: action.outcome,
        acknowledgedAt:
          action.acknowledgedAt || new Date(nowMs).toISOString(),
        deliveryDigest: action.deliveryDigest,
      });
      if (result.acknowledged === true) {
        await enqueueTerminalClosure(job, enqueue, nowMs, action.outcome);
      }
      return json({
        ok: true,
        status: result.status,
        acknowledged: result.acknowledged,
        idempotent: result.idempotent,
        outcome: result.outcome || action.outcome,
      }, result.acknowledged === true ? 200 : 409);
    }
    const result = await stopSuppression(candidateUserId, {
      ...chaseScope,
      reason: action.reason,
      stoppedAt: new Date(nowMs).toISOString(),
    });
    if (
      result.stopped === true
      && action.reason === RESUME_RECEIVED_REVIEW_CODE
    ) {
      await saveHardResumeReview(job, {
        code: RESUME_RECEIVED_REVIEW_CODE,
        message: RESUME_RECEIVED_REVIEW_MESSAGE,
        save,
      });
    }
    return json({
      ok: true,
      status: result.status,
      stopped: result.stopped,
      idempotent: result.idempotent,
    });
  } catch {
    return json({ ok: false, error: "suppression_unavailable" }, 503);
  }
}

export default {
  async fetch(request) {
    return handleResumeWaiting(request);
  },
};
