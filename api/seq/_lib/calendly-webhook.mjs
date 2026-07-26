// Calendly webhook signature verification — fail closed.
//
// Calendly signs with the `Calendly-Webhook-Signature` header:
//     t=<unix_seconds>,v1=<hex hmac_sha256>
// where the HMAC message is `${t}.${rawBody}` and the key is the subscription's
// signing key (a plain UTF-8 string we choose at subscription-creation time —
// unlike Svix, it is NOT base64 and has no prefix).
//
// The raw body bytes matter: a re-serialised JSON object will not hash
// identically, so callers must pass the exact string they received.
import { createHmac, timingSafeEqual } from "node:crypto";

const DEFAULT_TOLERANCE_SECONDS = 5 * 60;

function headerValue(headers, name) {
  if (!headers) return "";
  if (typeof headers.get === "function") return String(headers.get(name) || "");
  const value = headers[name] ?? headers[name.toLowerCase()] ?? headers[name.toUpperCase()];
  return Array.isArray(value) ? value.join(" ") : String(value || "");
}

export function parseSignatureHeader(raw) {
  const out = { t: "", v1: [] };
  for (const part of String(raw || "").split(",")) {
    const [k, v] = part.split("=", 2).map((s) => (s || "").trim());
    if (k === "t") out.t = v || "";
    else if (k === "v1" && v) out.v1.push(v);
  }
  return out;
}

export function verifyCalendlyWebhook({
  secret,
  headers,
  payload,
  nowMs = Date.now(),
  toleranceSeconds = DEFAULT_TOLERANCE_SECONDS,
} = {}) {
  const key = String(secret || "").trim();
  if (!key) {
    const e = new Error("Calendly webhook signing key is not configured");
    e.code = "CALENDLY_SECRET_MISSING";
    throw e;
  }
  const header = headerValue(headers, "calendly-webhook-signature");
  if (!header) {
    const e = new Error("Calendly webhook signature header is missing");
    e.code = "CALENDLY_SIGNATURE_MISSING";
    throw e;
  }
  const { t, v1 } = parseSignatureHeader(header);
  const ts = Number(t);
  if (!t || !Number.isFinite(ts) || !v1.length) {
    const e = new Error("Calendly webhook signature header is malformed");
    e.code = "CALENDLY_SIGNATURE_MALFORMED";
    throw e;
  }
  // Replay protection. Reject both far-past and far-future timestamps.
  if (Math.abs(nowMs / 1000 - ts) > toleranceSeconds) {
    const e = new Error("Calendly webhook timestamp outside tolerance");
    e.code = "CALENDLY_TIMESTAMP_STALE";
    throw e;
  }
  const expected = createHmac("sha256", key).update(`${t}.${payload}`).digest();
  for (const encoded of v1) {
    let received;
    try { received = Buffer.from(encoded, "hex"); } catch { continue; }
    if (received.length === expected.length && timingSafeEqual(received, expected)) {
      return { timestamp: ts };
    }
  }
  const e = new Error("Calendly webhook signature did not match");
  e.code = "CALENDLY_SIGNATURE_INVALID";
  throw e;
}

/** Normalise the parts of a Calendly payload we act on. */
export function calendlyWebhookEvent(body) {
  const event = String(body?.event || "");
  const p = body?.payload || {};
  return {
    event,
    inviteeUri: p.uri || null,
    email: String(p.email || "").trim().toLowerCase(),
    name: p.name || null,
    createdAt: p.created_at || null,
    status: p.status || null,
    eventUri: p.event || p.scheduled_event?.uri || null,
    startsAt: p.scheduled_event?.start_time || null,
    eventName: p.scheduled_event?.name || null,
  };
}
