import { cors } from "../seq/_lib/core.mjs";
import { requireReviewOperator, requireSameOrigin } from "../_lib/operator-access.mjs";
import { safeUpstreamBase } from "../_lib/safe-upstream.mjs";

const TIMEOUT_MS = 280_000;
const ACTIONS = new Set([
  "select_profile", "confirm_absent", "set_field", "set_call_outcome",
  "set_role_verdict", "attach_resume", "retry", "resume", "abandon", "assign", "set_priority",
]);
const OUTCOMES = new Set(["open", "continuing", "resolved", "failed", "all"]);
const FILE_TYPES = new Set([
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
]);
const CALL_OUTCOMES = new Set(["completed_success", "no_show", "failed", "incomplete", "cancelled_or_rescheduled", "ambiguous"]);
const WORKPLACES = new Set(["REMOTE", "HYBRID", "ON_SITE"]);
const FUNDING_ROUNDS = new Set(["PRE_SEED", "SEED", "SERIES_A", "SERIES_B", "SERIES_C", "SERIES_D_PLUS", "UNKNOWN"]);
const VISA_AUTHORIZATIONS = new Set(["NO_VISA_AUTHORIZATION_NEEDED", "NEEDS_NEW_VISA_AUTHORIZATION"]);

function config() {
  try {
    return {
      base: safeUpstreamBase(process.env.POST_CALL_BASE, {
        allowedOrigins: process.env.POST_CALL_ALLOWED_ORIGINS,
        service: "post_call",
      }),
      feedKey: process.env.POST_CALL_REVIEW_FEED_API_KEY || process.env.POST_CALL_MONITOR_API_KEY || "",
      actionKey: process.env.POST_CALL_REVIEW_ACTION_API_KEY || process.env.POST_CALL_MONITOR_API_KEY || "",
      error: null,
    };
  } catch (error) {
    return {
      base: "",
      feedKey: process.env.POST_CALL_REVIEW_FEED_API_KEY || process.env.POST_CALL_MONITOR_API_KEY || "",
      actionKey: process.env.POST_CALL_REVIEW_ACTION_API_KEY || process.env.POST_CALL_MONITOR_API_KEY || "",
      error: String(error?.message || error),
    };
  }
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

function validStringList(value, allowed = null, maxLength = 160) {
  return Array.isArray(value) && value.length > 0 && value.length <= 50
    && value.every((item) => typeof item === "string" && item.trim().length > 0 && item.length <= maxLength && (!allowed || allowed.has(item)));
}

function validateChanges(action, changes) {
  if (action === "select_profile") return Boolean(changes?.candidateUserId && /^[a-zA-Z0-9_-]{3,160}$/.test(changes.candidateUserId));
  if (action === "set_call_outcome") return Boolean(changes && CALL_OUTCOMES.has(changes.callOutcome));
  if (action === "set_role_verdict") return Boolean(changes && ["good", "bad"].includes(changes.roleVerdict));
  if (action === "assign") return Boolean(changes && ["user", "team"].includes(changes.ownerType || "user")
    && typeof changes.ownerId === "string" && changes.ownerId.trim() && changes.ownerId.length <= 254
    && typeof changes.ownerLabel === "string" && changes.ownerLabel.trim() && changes.ownerLabel.length <= 200);
  if (action === "set_priority") return Boolean(changes && ["urgent", "high", "normal", "low"].includes(changes.priority));
  if (action !== "set_field") return true;
  if (!changes || !Object.keys(changes).length) return false;
  for (const [field, value] of Object.entries(changes)) {
    if (field === "fullName" && !(typeof value === "string" && value.trim().length > 0 && value.length <= 200)) return false;
    else if (field === "email" && !(typeof value === "string" && value.length <= 320 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value))) return false;
    else if (field === "phone" && !(typeof value === "string" && value.length <= 64 && value.replace(/\D/g, "").length >= 7)) return false;
    else if (field === "linkedinUrl") {
      try {
        const url = new URL(value);
        if (url.protocol !== "https:" || !["linkedin.com", "www.linkedin.com"].includes(url.hostname.toLowerCase()) || !url.pathname.toLowerCase().startsWith("/in/")) return false;
      } catch { return false; }
    } else if (field === "locations" && !validStringList(value)) return false;
    else if (field === "minimumBaseSalary" && !(Number.isInteger(value) && value > 0 && value <= 10_000_000)) return false;
    else if (field === "workplaces" && !validStringList(value, WORKPLACES)) return false;
    else if (field === "fundingRounds" && !validStringList(value, FUNDING_ROUNDS)) return false;
    else if (field === "visaAuthorization" && !VISA_AUTHORIZATIONS.has(value)) return false;
    else if (!["fullName", "email", "phone", "linkedinUrl", "locations", "minimumBaseSalary", "workplaces", "fundingRounds", "visaAuthorization"].includes(field)) return false;
  }
  return true;
}

async function upstream(path, access, key, init = {}) {
  const { base } = config();
  const response = await fetch(`${base}${path}`, {
    ...init,
    redirect: "error",
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

function sendUpstream(res, response, body, access, extra = {}) {
  if (response.status === 401 || response.status === 403) {
    return res.status(502).json(withActor({
      ok: false,
      configured: true,
      error: "post_call_service_authorization_failed",
      detail: "The Review service could not authorize this request; nothing was changed.",
    }, access));
  }
  return res.status(response.status).json(withActor({ ok: response.ok && body.ok !== false, ...extra, ...body }, access));
}

export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (!requireSameOrigin(req, res)) return;
  res.setHeader("cache-control", "no-store");
  const access = await requireReviewOperator(req, res, req.method === "GET" ? "reviewRead" : "reviewWrite");
  if (!access) return;

  const { base, feedKey, actionKey, error: configError } = config();
  const serviceKey = req.method === "GET" ? feedKey : actionKey;
  if (!base || !serviceKey) return res.status(503).json({ ok: false, configured: false, error: "post_call_monitor_not_configured", detail: configError || undefined });

  try {
    if (req.method === "GET") {
      const id = safeString(req.query?.id, 160);
      const status = OUTCOMES.has(String(req.query?.status || "open")) ? String(req.query.status || "open") : "open";
      const cursor = safeString(req.query?.cursor, 400);
      const limit = Math.max(1, Math.min(50, Number(req.query?.limit) || 50));
      const query = new URLSearchParams({ status, limit: String(limit) });
      if (cursor) query.set("cursor", cursor);
      for (const key of ["category", "owner", "recruiter", "callType", "sla", "search"]) {
        const value = safeString(req.query?.[key], key === "search" ? 240 : 254);
        if (value) query.set(key, value);
      }
      const path = String(req.query?.metrics || "") === "1"
        ? "/api/v2/reviews/metrics"
        : id ? `/api/v2/reviews/${encodeURIComponent(id)}` : `/api/v2/reviews?${query}`;
      const { response, body } = await upstream(path, access, feedKey);
      return sendUpstream(res, response, body, access, { configured: true });
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
      if (!fileName || /[\\/\0]/.test(fileName) || !FILE_TYPES.has(mimeType) || !Number.isInteger(sizeBytes) || sizeBytes < 1 || sizeBytes > 25 * 1024 * 1024 || !/^[a-f0-9]{64}$/.test(sha256)) {
        return res.status(400).json({ ok: false, error: "resume_metadata_invalid" });
      }
      const { response, body } = await upstream(`/api/v2/reviews/${encodeURIComponent(reviewId)}/resume-files`, access, actionKey, {
        method: "POST",
        headers: { "if-match": `"${version}"` },
        body: JSON.stringify({ schemaVersion: 2, reviewId, fileName, mimeType, sizeBytes, sha256 }),
      });
      return sendUpstream(res, response, body, access);
    }

    if (!ACTIONS.has(action)) return res.status(400).json({ ok: false, error: "review_action_not_allowed" });
    if (["select_profile", "confirm_absent", "abandon"].includes(action) && !access.capabilities.reviewIdentityOverride) {
      return res.status(403).json({ ok: false, error: "review_admin_required" });
    }
    if (action === "set_priority" && !access.capabilities.reviewPriority) return res.status(403).json({ ok: false, error: "review_admin_required" });
    if (action === "assign" && !access.capabilities.reviewAssign) return res.status(403).json({ ok: false, error: "review_assignment_forbidden" });
    const approveSend = payload.approveSend === true;
    if (approveSend && (action !== "resume" || !access.capabilities.reviewSendApproval)) {
      return res.status(403).json({ ok: false, error: "review_send_approval_forbidden" });
    }
    const reason = safeString(payload.reason, 1_000);
    if (!reason) return res.status(400).json({ ok: false, error: "review_reason_required" });
    const bodyOut = { schemaVersion: 2, reviewId, action, reason };
    const changes = safeChanges(payload.changes);
    if (action === "select_profile" && !changes?.candidateUserId) {
      return res.status(400).json({ ok: false, error: "candidate_user_id_required" });
    }
    if (!validateChanges(action, changes)) return res.status(400).json({ ok: false, error: "review_value_invalid" });
    if (changes && Object.keys(changes).length) bodyOut.changes = changes;
    if (approveSend) bodyOut.approveSend = true;
    const { response, body } = await upstream(`/api/v2/reviews/${encodeURIComponent(reviewId)}/actions`, access, actionKey, {
      method: "POST",
      headers: { "if-match": `"${version}"` },
      body: JSON.stringify(bodyOut),
    });
    return sendUpstream(res, response, body, access);
  } catch (error) {
    return res.status(502).json({ ok: false, configured: true, error: "post_call_proxy_failed", detail: String(error?.message || error).slice(0, 180) });
  }
}
