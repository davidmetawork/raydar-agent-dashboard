import { enqueueAutoJob, storeConfigured } from "./_lib/store.mjs";
import {
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

export default {
  async fetch(request) {
    if (request.method !== "POST") return json({ ok: false, error: "POST_only" }, 405);
    if (!storeConfigured()) return json({ ok: false, error: "state_store_not_configured" }, 503);
    const raw = await request.text();
    let verified;
    try {
      verified = verifyRecallWebhook({
        secret: process.env.RECALL_WORKSPACE_VERIFICATION_SECRET || process.env.RECALL_SVIX_WEBHOOK_SECRET,
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
    if (String(event.metadata?.source || "") !== "paraform-auto") {
      return json({ ok: true, ignored: true }, 202);
    }
    const queued = await enqueueAutoJob(event.botId, {
      source: `recall:${event.event}`,
      eventId: verified.id,
      dueAt: Date.now(),
    });
    return json({ ok: true, queued: queued.enqueued, duplicate: queued.duplicate }, 202);
  },
};
