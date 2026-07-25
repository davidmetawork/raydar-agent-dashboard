import {
  enqueueAutoJob,
  listWaitingResumeJobs,
  recordResumeAttachedSignal,
  resumeChaseChainId,
  stopResumeAskSuppression,
  storeConfigured,
} from "./_lib/store.mjs";
import {
  requestPathname,
  resumeSignalId,
  verifyResumeSignal,
} from "./_lib/resume-signal.mjs";

export const config = { maxDuration: 30 };

function json(value, status = 200) {
  return Response.json(value, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

function parseAttachBody(rawBody) {
  let body;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return null;
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const candidateUserId = typeof body.candidateUserId === "string"
    ? body.candidateUserId.trim()
    : "";
  const eventId = body.eventId == null
    ? ""
    : typeof body.eventId === "string" ? body.eventId.trim() : null;
  if (!candidateUserId || candidateUserId.length > 200 || eventId == null || eventId.length > 240) {
    return null;
  }
  return { candidateUserId, eventId };
}

export async function handleResumeAttached(request, {
  secret = process.env.PARAAI_RESUME_SIGNAL_SECRET,
  verify = verifyResumeSignal,
  hasStore = storeConfigured,
  listWaiting = listWaitingResumeJobs,
  recordSignal = recordResumeAttachedSignal,
  stopSuppression = stopResumeAskSuppression,
  enqueue = enqueueAutoJob,
  now = () => Date.now(),
} = {}) {
  if (request.method !== "POST") return json({ ok: false, error: "POST_only" }, 405);
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
  const body = parseAttachBody(rawBody);
  if (!body) return json({ ok: false, error: "invalid_request" }, 400);
  if (!hasStore()) return json({ ok: false, error: "state_store_not_configured" }, 503);

  const signedRequestId = resumeSignalId({
    eventId: body.eventId,
    rawBody,
  });
  const queueSource = `resume_attached:${signedRequestId}`;
  let matches;
  try {
    // Keep a short-lived, PII-free race marker. It lets the worker notice an
    // upload that lands after its profile read but just before it saves the
    // waiting transition. Outside that narrow hand-off window the endpoint is
    // still an operational no-op: it does not re-due a job or write the
    // candidate-global satisfaction or chain-local chase records.
    await recordSignal(body.candidateUserId, {
      eventId: signedRequestId,
      receivedAt: new Date(nowMs).toISOString(),
    });
    const jobs = await listWaiting(500);
    matches = jobs.filter((job) => (
      job?.state === "waiting_for_resume"
      && String(job?.identity?.candidateUserId || "") === body.candidateUserId
    ));
    if (matches.length) {
      await Promise.all(matches.map((job) => {
        const chainAnchorAt = String(
          job?.automation?.resumeWait?.enteredAt || "",
        );
        return stopSuppression(body.candidateUserId, {
          reason: "resume_attached",
          stoppedAt: new Date(nowMs).toISOString(),
          jobId: job.id,
          chainAnchorAt,
          chainCallEndedAt: job.callEndedAt || "",
          chainId: resumeChaseChainId(job.id, chainAnchorAt),
        });
      }));
    }
    const results = await Promise.all(matches.map((job) => enqueue(job.id, {
      source: queueSource,
      eventId: `resume-attached:${resumeSignalId({
        eventId: `${signedRequestId}:${String(job.id || "")}`,
      })}`,
      dueAt: nowMs,
      now: nowMs,
    })));
    return json({
      ok: true,
      matched: matches.length,
      enqueued: results.filter((result) => result?.enqueued === true).length,
      duplicate: results.filter((result) => result?.duplicate === true).length,
      stopped: matches.length ? 1 : 0,
    }, 202);
  } catch {
    return json({ ok: false, error: "signal_unavailable" }, 503);
  }
}

export default {
  async fetch(request) {
    return handleResumeAttached(request);
  },
};
