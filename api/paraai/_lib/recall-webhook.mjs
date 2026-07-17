import { createHmac, timingSafeEqual } from "node:crypto";

const WEBHOOK_SECRET_PREFIX = "whsec_";
const BOT_ID = /^[A-Za-z0-9_-]{8,100}$/;
const DEFAULT_TOLERANCE_SECONDS = 5 * 60;
const SCREENER_WORKFLOW_SOURCES = new Set([
  "paraform-auto",
  "paraform-reconciliation",
]);

export function isCanonicalScreenerSource(value) {
  return SCREENER_WORKFLOW_SOURCES.has(String(value || ""));
}

function headerValue(headers, name) {
  if (!headers) return "";
  if (typeof headers.get === "function") return String(headers.get(name) || "");
  const value = headers[name] ?? headers[name.toLowerCase()] ?? headers[name.toUpperCase()];
  return Array.isArray(value) ? value.join(" ") : String(value || "");
}

function verifiedSignature(secret, message, signatures) {
  const key = Buffer.from(secret.slice(WEBHOOK_SECRET_PREFIX.length), "base64");
  if (!key.length) return false;
  const expected = createHmac("sha256", key).update(message).digest();
  for (const versioned of String(signatures || "").split(/\s+/)) {
    const [version, encoded] = versioned.split(",", 2);
    if (version !== "v1" || !encoded) continue;
    let received;
    try { received = Buffer.from(encoded, "base64"); } catch { continue; }
    if (received.length === expected.length && timingSafeEqual(received, expected)) return true;
  }
  return false;
}

export function verifyRecallWebhook({
  secret,
  headers,
  payload,
  nowMs = Date.now(),
  toleranceSeconds = DEFAULT_TOLERANCE_SECONDS,
} = {}) {
  const configured = String(secret || "").trim();
  if (!configured.startsWith(WEBHOOK_SECRET_PREFIX)) {
    const error = new Error("Recall webhook verification secret is missing or invalid");
    error.code = "RECALL_SECRET_INVALID";
    throw error;
  }
  const id = headerValue(headers, "webhook-id") || headerValue(headers, "svix-id");
  const timestamp = headerValue(headers, "webhook-timestamp") || headerValue(headers, "svix-timestamp");
  const signature = headerValue(headers, "webhook-signature") || headerValue(headers, "svix-signature");
  if (!id || !timestamp || !signature) {
    const error = new Error("Recall webhook verification headers are missing");
    error.code = "RECALL_SIGNATURE_MISSING";
    throw error;
  }
  const timestampSeconds = Number(timestamp);
  const tolerance = Math.max(30, Number(toleranceSeconds) || DEFAULT_TOLERANCE_SECONDS);
  if (!Number.isFinite(timestampSeconds) || Math.abs(nowMs / 1000 - timestampSeconds) > tolerance) {
    const error = new Error("Recall webhook timestamp is outside the replay window");
    error.code = "RECALL_TIMESTAMP_INVALID";
    throw error;
  }
  const raw = typeof payload === "string" ? payload : Buffer.isBuffer(payload) ? payload.toString("utf8") : "";
  if (!verifiedSignature(configured, `${id}.${timestamp}.${raw}`, signature)) {
    const error = new Error("Recall webhook signature did not match");
    error.code = "RECALL_SIGNATURE_INVALID";
    throw error;
  }
  return { id, timestamp: timestampSeconds };
}

export function recallWebhookEvent(body = {}) {
  const event = String(body?.event || body?.type || "").trim().toLowerCase();
  const bot =
    body?.data?.bot ||
    body?.data?.data?.bot ||
    body?.bot ||
    null;
  const botId = String(
    bot?.id ||
    body?.data?.bot_id ||
    body?.data?.botId ||
    body?.bot_id ||
    body?.botId ||
    "",
  ).trim();
  const status = String(
    body?.data?.data?.code ||
    body?.data?.status?.code ||
    body?.data?.code ||
    body?.status?.code ||
    "",
  ).trim().toLowerCase();
  return {
    event,
    botId: BOT_ID.test(botId) ? botId : "",
    status,
    metadata: bot?.metadata && typeof bot.metadata === "object" ? bot.metadata : {},
  };
}

export function isRecallCompletionSignal({ event = "", status = "" } = {}) {
  const normalizedEvent = String(event).toLowerCase();
  const normalizedStatus = String(status).toLowerCase();
  if (["transcript.done", "recording.done", "bot.done"].includes(normalizedEvent)) return true;
  if (normalizedEvent.startsWith("bot.") && ["call_ended", "done"].includes(normalizedStatus)) return true;
  return false;
}
