import { cors } from "../seq/_lib/core.mjs";
import { requireOperator } from "../_lib/operator-access.mjs";

const TIMEOUT_MS = 12_000;
const ACTIONS = new Set([
  "select_profile", "confirm_absent", "set_field", "set_call_outcome",
  "set_role_verdict", "attach_resume", "retry", "resume", "abandon",
]);
const OUTCOMES = new Set(["open", "resolved", "all"]);
const FILE_TYPES = new Set([
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
]);

function config() {
  return {
    base: String(process.env.POST_CALL_BASE || "").replace(/\/$/, ""),
    key: process.env.POST_CALL_MONITOR_API_KEY || "",
  };
}

function parseBody(req) {
  if (typeof req.body === "string") return JSON.parse(req.body || "{}");
  return req.body && typeof req.body === "object" ? req.body : {};
}

function safeString(value, max = 512) {
  return String(value || "").trim().slice(0, max);
}

function safeChanges(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const entries = Object.entries(value).slice(0, 24);
  const out = {};
  for (const [key, raw] of entries) {
    if (!/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(key)) continue;
    if (raw == null || ["string", "number", "boolean"].includes(typeof raw)) out[key] = typeof raw === "string" ? raw.slice(0, 8_000) : raw;
    else if (Array.isArray(raw) && raw.length <= 50 && raw.every((item) => ["string", "number", "boolean"].includes(typeof item))) {
      out[key] = raw.map((item) => typeof item === "string" ? item.slice(0, 1_000) : item);
    }
  }
  return out;
}

async function upstream(path, access, init = {}) {
  const { base, key } = config();
  const response = await fetch(`${base}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${key}`,
      accept: "application/json",
      "content-type": "application/json",
      "x-raydar-actor-email": access.email,
      ...(init.headers || {}),
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const body = await response.json().catch(() => ({}));
  return { response, body };
}

function withActor(body, access) {
  return { ...body, actor: { email: access.email, role: access.role, capabilities: access.capabilities } };
}

export default async function handler(req, res) {
  if (cors(req, res)) return;
  res.setHeader("cache-control", "no-store");
  const access = await requireOperator(req, res, req.method === "GET" ? "reviewRead" : "reviewWrite");
  if (!access) return;

  const { base, key } = config();
  if (!base || !key) return res.status(503).json({ ok: false, configured: false, error: "post_call_monitor_not_configured" });

  try {
    if (req.method === "GET") {
      const id = safeString(req.query?.id, 160);
      const status = OUTCOMES.has(String(req.query?.status || "open")) ? String(req.query.status || "open") : "open";
      const cursor = safeString(req.query?.cursor, 400);
      const limit = Math.max(1, Math.min(50, Number(req.query?.limit) || 50));
      const query = new URLSearchParams({ status, limit: String(limit) });
      if (id) query.set("id", id);
      if (cursor) query.set("cursor", cursor);
      const { response, body } = await upstream(`/api/v1/reviews?${query}`, access);
      return res.status(response.status).json(withActor({ ok: response.ok && body.ok !== false, configured: true, ...body }, access));
    }

    if (req.method !== "POST") return res.status(405).json({ ok: false, error: "method_not_allowed" });
    const payload = parseBody(req);
    const action = safeString(payload.action, 64);
    const reviewId = safeString(payload.reviewId, 160);
    const version = Number(payload.version);
    if (!reviewId) return res.status(400).json({ ok: false, error: "review_id_required" });
    if (!Number.isInteger(version) || version < 0) return res.status(400).json({ ok: false, error: "review_version_required" });

    if (action === "prepare_resume") {
      if (!access.capabilities.resumeUpload) return res.status(403).json({ ok: false, error: "resume_upload_forbidden" });
      const fileName = safeString(payload.fileName, 240);
      const mimeType = safeString(payload.mimeType, 180).toLowerCase();
      const sizeBytes = Number(payload.sizeBytes);
      const sha256 = safeString(payload.sha256, 64).toLowerCase();
      if (!fileName || !FILE_TYPES.has(mimeType) || !Number.isInteger(sizeBytes) || sizeBytes < 1 || sizeBytes > 15 * 1024 * 1024 || !/^[a-f0-9]{64}$/.test(sha256)) {
        return res.status(400).json({ ok: false, error: "resume_metadata_invalid" });
      }
      const { response, body } = await upstream("/api/v1/review-files", access, {
        method: "POST",
        headers: { "if-match": `"${version}"` },
        body: JSON.stringify({ schemaVersion: 1, reviewId, fileName, mimeType, sizeBytes, sha256 }),
      });
      return res.status(response.status).json(withActor({ ok: response.ok && body.ok !== false, ...body }, access));
    }

    if (!ACTIONS.has(action)) return res.status(400).json({ ok: false, error: "review_action_not_allowed" });
    const reason = safeString(payload.reason, 1_000);
    if (!reason) return res.status(400).json({ ok: false, error: "review_reason_required" });
    const bodyOut = { schemaVersion: 1, reviewId, action, reason };
    const changes = safeChanges(payload.changes);
    if (changes && Object.keys(changes).length) bodyOut.changes = changes;
    const { response, body } = await upstream("/api/v1/review-actions", access, {
      method: "POST",
      headers: { "if-match": `"${version}"` },
      body: JSON.stringify(bodyOut),
    });
    return res.status(response.status).json(withActor({ ok: response.ok && body.ok !== false, ...body }, access));
  } catch (error) {
    return res.status(502).json({ ok: false, configured: true, error: "post_call_proxy_failed", detail: String(error?.message || error).slice(0, 180) });
  }
}
