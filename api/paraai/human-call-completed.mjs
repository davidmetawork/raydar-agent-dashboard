import {
  automationConfig,
  automationExecutionEnabled,
} from "./_lib/auto.mjs";
import {
  HUMAN_CALL_QUEUE_SOURCE,
  humanCallEventId,
  humanCallJobId,
  paraformHumanCallId,
} from "./_lib/human-call.mjs";
import {
  requestPathname,
  resumeSignalId,
  verifyResumeSignal,
} from "./_lib/resume-signal.mjs";
import {
  createJob,
  enqueueAutoJob,
  storeConfigured,
} from "./_lib/store.mjs";

export const config = { maxDuration: 30 };

function json(value, status = 200) {
  return Response.json(value, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

export function parseHumanCallCompletedBody(rawBody) {
  let body;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return null;
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  let callId;
  try {
    callId = paraformHumanCallId(body.callId);
  } catch {
    return null;
  }
  const eventId = typeof body.eventId === "string"
    ? body.eventId.trim()
    : "";
  if (eventId !== humanCallEventId(callId)) return null;
  return { callId, eventId };
}

export function humanCallSignalEnabled(env = process.env) {
  return ["1", "true", "yes", "on"].includes(
    String(env.PARAAI_HUMAN_CALL_SIGNAL_ENABLED || "").toLowerCase(),
  );
}

export async function handleHumanCallCompleted(request, {
  secret = process.env.PARAAI_RESUME_SIGNAL_SECRET,
  verify = verifyResumeSignal,
  hasStore = storeConfigured,
  create = createJob,
  enqueue = enqueueAutoJob,
  getAutomationConfig = automationConfig,
  enabled = humanCallSignalEnabled(),
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
    return json({ ok: false, error: "human_call_disabled" }, 503);
  }
  const body = parseHumanCallCompletedBody(rawBody);
  if (!body || !Number.isFinite(nowMs)) {
    return json({ ok: false, error: "invalid_request" }, 400);
  }
  if (!hasStore()) {
    return json({ ok: false, error: "state_store_not_configured" }, 503);
  }

  const jobId = humanCallJobId(body.callId);
  const detectedAt = new Date(nowMs).toISOString();
  try {
    const job = await create({
      id: jobId,
      state: "detected",
      humanCall: true,
      callType: "human",
      detectedAt,
      createdAt: detectedAt,
      humanCallMeta: {
        paraformCallId: body.callId,
        intakeEventId: resumeSignalId({ eventId: body.eventId }),
        provenanceVerified: false,
      },
      journal: [{
        state: "detected",
        at: detectedAt,
        detail: "signed Paraform human-call completion detected",
      }],
    });
    if (job?.humanCall !== true || String(job?.id || "") !== jobId) {
      return json({ ok: false, error: "job_id_conflict" }, 409);
    }
    const queued = await enqueue(jobId, {
      source: HUMAN_CALL_QUEUE_SOURCE,
      eventId: `human-call:${resumeSignalId({
        eventId: body.eventId,
        rawBody,
      })}`,
      dueAt: nowMs,
      now: nowMs,
    });
    const paused = !automationExecutionEnabled(getAutomationConfig());
    return json({
      ok: true,
      enqueued: queued?.enqueued === true,
      duplicate: queued?.duplicate === true,
      paused,
    }, 202);
  } catch {
    return json({ ok: false, error: "queue_unavailable" }, 503);
  }
}

export default {
  async fetch(request) {
    return handleHumanCallCompleted(request);
  },
};
