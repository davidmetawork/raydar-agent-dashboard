import {
  HUMAN_INTRO_PAYLOAD_CONFLICT_CODE,
  HUMAN_INTRO_PAYLOAD_CONFLICT_MESSAGE,
  humanIntroCallRecord,
  humanIntroJobId,
  humanIntroPayloadDigest,
  humanIntroProvenance,
  humanIntroResumeQueueOptions,
  normalizeHumanIntroPayload,
} from "./_lib/human-intro.mjs";
import {
  HUMAN_CALL_SOFT_REVIEW_CODE,
  HUMAN_CALL_SOFT_REVIEW_MESSAGE,
} from "./_lib/human-call.mjs";
import {
  prepareJob,
} from "./_lib/pipeline.mjs";
import {
  requestPathname,
  verifyResumeSignal,
} from "./_lib/resume-signal.mjs";
import {
  acquireJobLock,
  enqueueAutoJob,
  getJob,
  releaseJobLock,
  saveJob,
  storeConfigured,
  transition,
} from "./_lib/store.mjs";

export const config = { maxDuration: 120 };

function json(value, status = 200) {
  return Response.json(value, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

export function parseHumanIntroCompletedBody(rawBody) {
  try {
    return normalizeHumanIntroPayload(JSON.parse(rawBody));
  } catch {
    return null;
  }
}

const RECOVERABLE_PREP_STATES = new Set([
  "detected",
  "resolving_identity",
  "extracting",
]);

export function humanIntroSignalEnabled(env = process.env) {
  return ["1", "true", "yes", "on"].includes(
    String(env.PARAAI_HUMAN_INTRO_SIGNAL_ENABLED || "").toLowerCase(),
  );
}

function matchingJob(job, payload) {
  let provenance;
  try {
    provenance = humanIntroProvenance(
      payload?.source,
      payload?.parserVersion,
    );
  } catch {
    return false;
  }
  return Boolean(
    job
    && job.id === humanIntroJobId(payload.sourceId)
    && job.humanCall === true
    && job.humanIntro === true
    && job.callType === "human"
    && job.humanCallMeta?.calendarIntro === true
    && job.humanCallMeta?.manualOnly === true
    && job.humanCallMeta?.sourceId === payload.sourceId
    && job.humanCallMeta?.source === provenance.source
    && job.humanCallMeta?.parserVersion === provenance.parserVersion
    && job.humanCallMeta?.bookingCreatedAtSource
      === provenance.bookingCreatedAtSource
    && job.humanCallMeta?.platform === provenance.platform
    && job.humanCallMeta?.provenanceVerified === true
    && !Object.hasOwn(job.humanCallMeta, "paraformCallId")
  );
}

function matchingPayload(job, payload) {
  return (
    String(job?.humanCallMeta?.payloadDigest || "")
    === humanIntroPayloadDigest(payload)
  );
}

function profileReviewCard(job) {
  const reasons = Array.isArray(job?.reviewReasons)
    ? job.reviewReasons
    : [];
  return Boolean(
    reasons.some((reason) => (
      reason?.code === HUMAN_CALL_SOFT_REVIEW_CODE
      && reason?.message === HUMAN_CALL_SOFT_REVIEW_MESSAGE
      && reason?.soft === true
    ))
    && job?.reviewPolicy?.humanIntroWithoutTranscript === true
    && job?.reviewPolicy?.preferenceRouting
  );
}

function preparedHumanIntro(job) {
  if (job?.state === "needs_identity_review") return true;
  return (
    ["needs_review", "waiting_for_resume"].includes(job?.state)
    && profileReviewCard(job)
  );
}

async function enqueueResumeWait(job, enqueue, nowMs) {
  if (job?.state !== "waiting_for_resume") return null;
  return enqueue(
    job.id,
    humanIntroResumeQueueOptions(job, { now: nowMs }),
  );
}

async function markPayloadConflict(
  job,
  payload,
  {
    save,
    nowMs,
  },
) {
  const incomingDigest = humanIntroPayloadDigest(payload);
  const reasons = Array.isArray(job?.reviewReasons)
    ? job.reviewReasons
    : [];
  const alreadyMarked = (
    job?.humanCallMeta?.payloadConflict?.incomingDigest
      === incomingDigest
    && reasons.some((reason) => (
      reason?.code === HUMAN_INTRO_PAYLOAD_CONFLICT_CODE
      && reason?.soft !== true
    ))
  );
  if (alreadyMarked) return job;
  const conflictReason = {
    code: HUMAN_INTRO_PAYLOAD_CONFLICT_CODE,
    message: HUMAN_INTRO_PAYLOAD_CONFLICT_MESSAGE,
    soft: false,
  };
  const nextReasons = [
    ...reasons.filter((reason) => (
      reason?.code !== HUMAN_INTRO_PAYLOAD_CONFLICT_CODE
    )),
    conflictReason,
  ];
  return save(transition(job, job.state, {
    humanCallMeta: {
      ...(job.humanCallMeta || {}),
      payloadConflict: {
        detectedAt: new Date(nowMs).toISOString(),
        incomingDigest,
      },
    },
    ...(job.state === "needs_review" ? {
      reviewReason: HUMAN_INTRO_PAYLOAD_CONFLICT_CODE,
    } : {}),
    reviewReasons: nextReasons,
    journalDetail: HUMAN_INTRO_PAYLOAD_CONFLICT_CODE,
  }), job.revision);
}

export async function handleHumanIntroCompleted(request, {
  secret = process.env.PARAAI_RESUME_SIGNAL_SECRET,
  verify = verifyResumeSignal,
  hasStore = storeConfigured,
  load = getJob,
  prepare = prepareJob,
  acquire = acquireJobLock,
  release = releaseJobLock,
  save = saveJob,
  enqueue = enqueueAutoJob,
  enabled = humanIntroSignalEnabled(),
  now = () => Date.now(),
} = {}) {
  if (request.method !== "POST") {
    return json({ ok: false, error: "POST_only" }, 405);
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
  if (!enabled) {
    return json({ ok: false, error: "human_intro_disabled" }, 503);
  }
  const payload = parseHumanIntroCompletedBody(rawBody);
  if (!payload || !Number.isFinite(nowMs)) {
    return json({ ok: false, error: "invalid_request" }, 400);
  }
  if (!hasStore()) {
    return json({ ok: false, error: "state_store_not_configured" }, 503);
  }

  const jobId = humanIntroJobId(payload.sourceId);
  let lockToken = null;
  try {
    lockToken = await acquire(jobId);
    if (!lockToken) {
      return json({ ok: false, error: "job_busy" }, 503);
    }
    const existing = await load(jobId);
    if (existing && !matchingJob(existing, payload)) {
      return json({ ok: false, error: "job_id_conflict" }, 409);
    }
    if (existing && !matchingPayload(existing, payload)) {
      await markPayloadConflict(existing, payload, {
        save,
        nowMs,
      });
      return json({ ok: false, error: "job_payload_conflict" }, 409);
    }
    // The Calendar slot must have ended before it can create a review card.
    if (Date.parse(payload.scheduledEnd) > nowMs) {
      return json({ ok: false, error: "call_not_completed" }, 409);
    }
    if (
      existing
      && !RECOVERABLE_PREP_STATES.has(String(existing.state || ""))
    ) {
      const queued = await enqueueResumeWait(existing, enqueue, nowMs);
      return json({
        ok: true,
        jobId,
        state: existing.state,
        prepared: preparedHumanIntro(existing),
        duplicate: true,
        recovered: false,
        ...(queued ? {
          resumeWaitQueued: queued.enqueued === true,
          resumeWaitQueueDuplicate: queued.duplicate === true,
        } : {}),
      });
    }
    const job = await prepare({
      botId: jobId,
      strictReads: true,
      callRecord: humanIntroCallRecord(payload),
      force: Boolean(existing),
    });
    if (
      !matchingJob(job, payload)
      || !matchingPayload(job, payload)
      || !preparedHumanIntro(job)
    ) {
      return json({ ok: false, error: "prepared_job_invalid" }, 409);
    }
    const queued = await enqueueResumeWait(job, enqueue, nowMs);
    return json({
      ok: true,
      jobId,
      state: job.state,
      prepared: job.state !== "needs_identity_review",
      duplicate: Boolean(existing),
      recovered: Boolean(existing),
      ...(queued ? {
        resumeWaitQueued: queued.enqueued === true,
        resumeWaitQueueDuplicate: queued.duplicate === true,
      } : {}),
    }, 202);
  } catch {
    return json({
      ok: false,
      error: "human_intro_preparation_unavailable",
      jobId,
    }, 503);
  } finally {
    if (lockToken) await release(jobId, lockToken).catch(() => {});
  }
}

export default {
  async fetch(request) {
    return handleHumanIntroCompleted(request);
  },
};
