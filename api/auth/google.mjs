import { issueSession, sessionConfig, verifyGoogleCredential } from "./_lib/session.mjs";
import { checkLoginRateLimit } from "./_lib/login-rate-limit.mjs";

const MAX_CREDENTIAL_LENGTH = 8_192;
const MAX_BODY_BYTES = 16 * 1_024;

function requestProblem(status) {
  return Object.assign(new Error(status === 413 ? "request_too_large" : "invalid_request"), { status });
}

function parseBody(value) {
  let body = value;
  if (typeof body === "string") {
    if (Buffer.byteLength(body, "utf8") > MAX_BODY_BYTES) throw requestProblem(413);
    try { body = JSON.parse(body); }
    catch { throw requestProblem(400); }
  } else {
    let serialized;
    try { serialized = JSON.stringify(body); }
    catch { throw requestProblem(400); }
    if (typeof serialized !== "string") throw requestProblem(400);
    if (Buffer.byteLength(serialized, "utf8") > MAX_BODY_BYTES) throw requestProblem(413);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw requestProblem(400);
  if (typeof body.credential !== "string" || !body.credential || body.credential.length > MAX_CREDENTIAL_LENGTH) {
    throw requestProblem(400);
  }
  return body;
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ ok: false, error: "method_not_allowed" });
  }
  const config = sessionConfig();
  if (!config.authRequired || !config.durableSessionEnabled) {
    return res.status(503).json({ ok: false, error: "auth_session_not_configured" });
  }
  const limit = await checkLoginRateLimit(req);
  if (!limit.allowed) {
    res.setHeader("Retry-After", String(limit.retryAfterSeconds));
    return res.status(429).json({ ok: false, error: "auth_rate_limited" });
  }
  try {
    const body = parseBody(req.body);
    const identity = await verifyGoogleCredential(body.credential);
    const session = issueSession(identity);
    res.setHeader("Set-Cookie", session.cookie);
    return res.status(200).json({
      ok: true,
      authenticated: true,
      email: identity.email,
      expiresAt: session.expiresAt,
      sessionDays: config.sessionDays,
    });
  } catch (error) {
    if (error?.status === 400 || error?.status === 413) {
      return res.status(error.status).json({ ok: false, error: error.message });
    }
    const forbidden = error?.code === "forbidden";
    return res.status(forbidden ? 403 : 401).json({ ok: false, error: error?.code || "auth_check_failed" });
  }
}
