import { createHmac, timingSafeEqual } from "node:crypto";
import { sessionConfig, sessionFromRequest } from "../../auth/_lib/session.mjs";

const text = (value, limit = 500) => String(value ?? "").trim().slice(0, limit);
const secret = () => text(process.env.AUTH_SESSION_SECRET, 500);
const strongSecret = (value) => Buffer.byteLength(String(value || "").trim(), "utf8") >= 32;

function equal(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  return a.length === b.length && timingSafeEqual(a, b);
}

function bearer(req) {
  const match = String(req?.headers?.authorization || "").match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : "";
}

export async function readRawBody(req, limit = 1_000_000) {
  if (typeof req?.body === "string") return req.body;
  if (Buffer.isBuffer(req?.body)) return req.body.toString("utf8");
  if (req?.body && typeof req.body === "object") return JSON.stringify(req.body);
  if (!req || typeof req[Symbol.asyncIterator] !== "function") return "";
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > limit) throw Object.assign(new Error("Request body is too large."), { code: "request_too_large", status: 413 });
    chunks.push(bytes);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function origins() {
  return new Set((process.env.SUBMISSIONS_V2_ALLOWED_ORIGINS || "https://monitor.raydar.xyz,http://localhost:3000,http://127.0.0.1:3000")
    .split(",").map((value) => value.trim()).filter(Boolean));
}

export function jsonBody(req) {
  if (typeof req?.body === "string") {
    try { return JSON.parse(req.body || "{}"); } catch { return {}; }
  }
  return req?.body && typeof req.body === "object" ? req.body : {};
}

export function csrfToken(identity, authSecret = secret()) {
  if (!identity?.email || authSecret.length < 32) return "";
  return createHmac("sha256", authSecret).update(`submissions-v2\0${identity.email}`).digest("base64url");
}

export function humanIdentity(req) {
  const session = sessionFromRequest(req);
  if (session) return { ...session, authType: "session" };
  const configured = text(process.env.SUBMISSIONS_V2_HUMAN_API_KEY, 2_000);
  const supplied = bearer(req);
  if (strongSecret(configured) && supplied && equal(configured, supplied)) {
    return { email: "internal-api@raydar.xyz", domain: "raydar.xyz", authType: "bearer" };
  }
  return null;
}

export function requireHuman(req, res, { mutation = false } = {}) {
  res.setHeader("Cache-Control", "private, no-store, max-age=0");
  res.setHeader("Vary", "Cookie, Authorization, Origin");
  const auth = sessionConfig();
  if (!auth.durableSessionEnabled && !strongSecret(process.env.SUBMISSIONS_V2_HUMAN_API_KEY)) {
    res.status(503).json({ ok: false, error: "submissions_v2_auth_not_configured" });
    return null;
  }
  const identity = humanIdentity(req);
  if (!identity) {
    res.status(401).json({ ok: false, error: "auth_required" });
    return null;
  }
  if (mutation && identity.authType === "session") {
    const origin = text(req.headers?.origin, 500);
    if (!origin || !origins().has(origin)) {
      res.status(403).json({ ok: false, error: "origin_not_allowed" });
      return null;
    }
    if (!equal(text(req.headers?.["x-raydar-csrf"], 500), csrfToken(identity))) {
      res.status(403).json({ ok: false, error: "csrf_required" });
      return null;
    }
  }
  req.authedEmail = identity.email;
  req.submissionsIdentity = identity;
  return identity;
}

export function requireIdempotency(req, res) {
  const key = text(req.headers?.["idempotency-key"], 200);
  if (!/^[A-Za-z0-9._:-]{8,200}$/.test(key)) {
    res.status(400).json({ ok: false, error: "idempotency_key_required" });
    return null;
  }
  return key;
}

export function requireAdmin(req, res, options = {}) {
  const identity = requireHuman(req, res, options);
  if (!identity) return null;
  const allowed = new Set(String(process.env.SUBMISSIONS_V2_ADMIN_EMAILS || "david@raydar.xyz")
    .split(",").map((value) => value.trim().toLowerCase()).filter(Boolean));
  if (!allowed.has(String(identity.email || "").toLowerCase())) {
    res.status(403).json({ ok: false, error: "admin_required" });
    return null;
  }
  return identity;
}

export function requireCron(req, res) {
  const configured = text(process.env.SUBMISSIONS_V2_SCHEDULER_KEY, 2_000);
  if (!strongSecret(configured) || !equal(configured, bearer(req))) {
    res.status(strongSecret(configured) ? 401 : 503).json({ ok: false, error: strongSecret(configured) ? "cron_auth_required" : "cron_auth_not_configured" });
    return false;
  }
  return true;
}

export function verifySignedMachine(req, res, { secretName, scope, replaySeconds = 300 } = {}) {
  const configured = text(process.env[secretName], 2_000);
  if (!strongSecret(configured)) { res.status(503).json({ ok: false, error: "machine_auth_not_configured" }); return null; }
  const timestamp = text(req.headers?.["x-raydar-timestamp"], 40);
  const signature = text(req.headers?.["x-raydar-signature"], 200);
  const eventId = text(req.headers?.["x-raydar-event-id"], 200);
  const at = Date.parse(timestamp);
  if (!eventId || !Number.isFinite(at) || Math.abs(Date.now() - at) > replaySeconds * 1000) {
    res.status(401).json({ ok: false, error: "machine_replay_window_failed" }); return null;
  }
  const raw = typeof req.body === "string" ? req.body : JSON.stringify(req.body || {});
  const expected = createHmac("sha256", configured).update(`${scope}\n${timestamp}\n${eventId}\n${raw}`).digest("base64url");
  if (!equal(signature, expected)) { res.status(401).json({ ok: false, error: "machine_signature_invalid" }); return null; }
  return { eventId, timestamp, raw };
}

export function verifyInboxMachine(req, res, raw) {
  const configured = text(process.env.SUBMISSIONS_V2_INGEST_KEY, 2_000);
  if (!strongSecret(configured)) {
    res.status(503).json({ ok: false, error: "machine_auth_not_configured" });
    return null;
  }
  const timestamp = text(req.headers?.["x-raydar-timestamp"], 40);
  const signature = text(req.headers?.["x-raydar-signature"], 200);
  const eventId = text(req.headers?.["x-raydar-event-id"], 200);
  const at = Date.parse(timestamp);
  if (!eventId || !Number.isFinite(at) || Math.abs(Date.now() - at) > 300_000) {
    res.status(401).json({ ok: false, error: "machine_replay_window_failed" });
    return null;
  }
  const expected = createHmac("sha256", configured).update(`submissions.email_reply.v1\n${timestamp}\n${eventId}\n${raw}`).digest("base64url");
  if (!equal(signature, expected)) {
    res.status(401).json({ ok: false, error: "machine_signature_invalid" });
    return null;
  }
  return { authType: "hmac", eventId, timestamp, raw };
}

export function safeError(error) {
  const code = text(error?.code || "submissions_v2_failed", 100).toLowerCase();
  const status = Number(error?.status) || (code.includes("not_found") ? 404 : code.includes("stale") || code.includes("conflict") ? 409 : 500);
  return { status, body: { ok: false, error: code, detail: text(error?.safeMessage || error?.message || "Request failed", 240), ...(error?.current ? { current: error.current } : {}) } };
}

export function sendError(res, error) {
  const safe = safeError(error);
  return res.status(safe.status).json(safe.body);
}
