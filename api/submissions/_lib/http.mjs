import { cors, cronAuth, requireAuth } from "../../seq/_lib/core.mjs";

export function bodyOf(req) {
  if (typeof req.body === "string") {
    try { return JSON.parse(req.body || "{}"); } catch { return {}; }
  }
  return req.body && typeof req.body === "object" ? req.body : {};
}

export async function requireHuman(req, res) {
  if (cors(req, res)) return false;
  res.setHeader("Cache-Control", "no-store");
  return requireAuth(req, res);
}

export function requireCron(req, res) {
  if (cors(req, res)) return false;
  res.setHeader("Cache-Control", "no-store");
  const auth = cronAuth(req);
  if (auth.ok) return true;
  res.status(401).json({ ok: false, error: "cron_auth_required", reason: auth.reason });
  return false;
}

export function sendError(res, error) {
  const status = Number(error?.status) || (
    error?.code === "AUTH_EXPIRED" ? 503 : 500
  );
  return res.status(status).json({
    ok: false,
    error: String(error?.code || "SUBMISSIONS_FAILED"),
    detail: error?.detail || String(error?.message || "request failed").slice(0, 300),
  });
}

