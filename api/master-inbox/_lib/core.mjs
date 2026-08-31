import { createHmac } from "node:crypto";
import { authConfig, requireAuth } from "../../seq/_lib/core.mjs";
import { sessionFromRequest } from "../../auth/_lib/session.mjs";

export async function requireMasterInboxAuth(req, res) {
  if (!authConfig().authRequired) {
    res.status(503).json({ ok: false, error: "auth_not_configured" });
    return false;
  }
  const allowed = await requireAuth(req, res);
  if (!allowed) return false;
  const durable = sessionFromRequest(req);
  if (durable) req.masterInboxSessionExpiresAt = Number(durable.expiresAt) * 1000;
  else {
    // requireAuth has already verified this Google credential; this local
    // decode only carries its provider expiry into the short-lived service
    // assertion so a scheduled release cannot outlive the Monitor session.
    const token = String(req.headers?.authorization || "").replace(/^Bearer\s+/i, "");
    try { req.masterInboxSessionExpiresAt = Number(JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8")).exp) * 1000; }
    catch { req.masterInboxSessionExpiresAt = 0; }
  }
  return true;
}

export function privateJson(res) {
  res.setHeader("cache-control", "private, no-store, max-age=0");
  res.setHeader("x-content-type-options", "nosniff");
}

export function serviceConfig(env = process.env) {
  return { base: String(env.MASTER_INBOX_BASE || "").replace(/\/$/, ""), key: env.MASTER_INBOX_SERVICE_KEY || "", assertionKey: env.MASTER_INBOX_SESSION_ASSERTION_KEY || "" };
}

export async function proxy(req, path, { method = req.method, body, timeout = 25_000 } = {}) {
  const config = serviceConfig();
  if (!config.base || !config.key) return { ok: false, status: 503, body: { ok: false, configured: false, error: "master_inbox_not_configured" } };
  const response = await fetch(`${config.base}${path}`, {
    method,
    headers: { authorization: `Bearer ${config.key}`, "x-raydar-actor": req.authedEmail, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(timeout)
  });
  const payload = await response.json().catch(() => ({}));
  return { ok: response.ok, status: response.status, body: payload };
}

export function requestBody(req) {
  return typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
}

export function sessionProof({ actor, draftId, revision, scheduledFor, sessionExpiresAt }) {
  const key = serviceConfig().assertionKey;
  if (key.length < 32) throw Object.assign(new Error("session_assertion_not_configured"), { status: 503 });
  const scheduled = scheduledFor && Number.isFinite(Date.parse(scheduledFor)) ? Date.parse(scheduledFor) : Date.now();
  const requestedExpiry = Math.max(Date.now() + 120_000, scheduled + 120_000);
  if (!Number.isFinite(sessionExpiresAt) || sessionExpiresAt <= requestedExpiry) throw Object.assign(new Error("monitor_session_expires_before_send"), { status: 409 });
  const payload = { actor, draftId, revision: Number(revision), iat: Date.now(), exp: requestedExpiry, sessionExp: sessionExpiresAt, nonce: crypto.randomUUID() };
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${encoded}.${createHmac("sha256", key).update(encoded).digest("base64url")}`;
}

export function relay(res, result) {
  return res.status(result.status).json(result.body);
}
