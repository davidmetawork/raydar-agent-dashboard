import { enqueueAutoJob, storeConfigured } from "./_lib/store.mjs";
import { automationConfig, automationExecutionEnabled } from "./_lib/auto.mjs";
import {
  isCanonicalScreenerSource,
  isRecallCompletionSignal,
  recallWebhookEvent,
  verifyRecallWebhook,
} from "./_lib/recall-webhook.mjs";

export const config = { maxDuration: 30 };

function json(value, status = 200) {
  return Response.json(value, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

export async function handleRecallWebhook(request, {
  enqueue = enqueueAutoJob,
  hasStore = storeConfigured,
  getAutomationConfig = automationConfig,
  verify = verifyRecallWebhook,
  secret = process.env.RECALL_SVIX_WEBHOOK_SECRET || process.env.RECALL_WORKSPACE_VERIFICATION_SECRET,
} = {}) {
  if (request.method !== "POST") return json({ ok: false, error: "POST_only" }, 405);
  const raw = await request.text();
  let verified;
  try {
    verified = verify({
      secret,
      headers: request.headers,
      payload: raw,
    });
  } catch (error) {
    return json({ ok: false, error: String(error?.code || "verification_failed") }, 401);
  }
  let body;
  try { body = JSON.parse(raw); }
  catch { return json({ ok: false, error: "invalid_json" }, 400); }
  const event = recallWebhookEvent(body);
  if (!event.botId || !isRecallCompletionSignal(event)) {
    return json({ ok: true, ignored: true }, 202);
  }
  if (!isCanonicalScreenerSource(event.metadata?.source)) {
    return json({ ok: true, ignored: true }, 202);
  }
  if (!hasStore()) return json({ ok: false, error: "state_store_not_configured" }, 503);
  let queued;
  try {
    queued = await enqueue(event.botId, {
      source: `recall:${event.event}`,
      eventId: verified.id,
      dueAt: Date.now(),
    });
  } catch {
    return json({ ok: false, error: "queue_unavailable" }, 503);
  }
  const paused = !automationExecutionEnabled(getAutomationConfig());
  return json({
    ok: true,
    queued: queued.enqueued,
    duplicate: queued.duplicate,
    paused,
  }, 202);
}

export default {
  async fetch(request) {
    return handleRecallWebhook(request);
  },
};
