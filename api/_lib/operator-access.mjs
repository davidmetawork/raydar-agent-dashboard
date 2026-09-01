import { requireAuth } from "../seq/_lib/core.mjs";

function emails(value) {
  return new Set(String(value || "").split(",").map((item) => item.trim().toLowerCase()).filter(Boolean));
}

function mutationOrigins(env = process.env) {
  const configured = String(env.DASHBOARD_MUTATION_ORIGINS || "").split(",").map((item) => item.trim()).filter(Boolean);
  return new Set((configured.length ? configured : [
    "https://monitor.raydar.xyz",
    "https://raydar-agent-dashboard.vercel.app",
    "http://localhost:3000",
  ]).map((item) => {
    try { return new URL(item).origin.toLowerCase(); } catch { return ""; }
  }).filter(Boolean));
}

export function operatorAccess(email, env = process.env) {
  const normalized = String(email || "").trim().toLowerCase();
  // These names intentionally match the owning post-call service. Review is a
  // deliberately small staff-only work surface: anyone allowlisted to see its
  // candidate queue may resolve its blockers. Mailroom permissions remain
  // separate, and the emergency read-only switch still fails all mutations
  // closed without changing who can read the queue.
  const admins = emails(env.POST_CALL_REVIEW_ADMIN_EMAILS);
  const assistants = emails(env.POST_CALL_REVIEW_ASSISTANT_EMAILS);
  const operators = emails(env.POST_CALL_REVIEW_OPERATOR_EMAILS);
  const recruiters = emails(env.POST_CALL_REVIEW_RECRUITER_EMAILS);
  const mailroomEditors = emails(env.MAILROOM_EDITOR_EMAILS);
  const mailroomViewers = emails(env.MAILROOM_VIEWER_EMAILS);
  const reviewReadOnly = String(env.POST_CALL_REVIEW_READ_ONLY || "").trim().toLowerCase() === "true";

  const admin = admins.has(normalized);
  const assistant = assistants.has(normalized);
  const operator = operators.has(normalized);
  const recruiter = recruiters.has(normalized);
  const reviewRead = admin || assistant || operator || recruiter;
  const reviewWrite = !reviewReadOnly && reviewRead;
  const mailroomWrite = admin || mailroomEditors.has(normalized);
  const mailroomRead = mailroomWrite || mailroomViewers.has(normalized);

  return {
    email: normalized,
    role: admin ? "admin" : assistant ? "assistant" : operator ? "operator" : recruiter ? "recruiter" : mailroomWrite ? "mailroom_editor" : "viewer",
    capabilities: {
      reviewRead,
      reviewWrite,
      resumeUpload: reviewWrite,
      reviewAssign: reviewWrite,
      reviewIdentityOverride: reviewWrite,
      reviewSendApproval: reviewWrite,
      reviewPriority: !reviewReadOnly && admin,
      mailroomRead,
      mailroomWrite,
    },
  };
}

// Review is itself the authorization boundary: the dashboard's existing
// Google session has already restricted the viewer to an approved Raydar
// domain, and every mutation still goes through the same-origin proxy plus the
// owning workflow's exact action, field, version, manifest, and readback gates.
// Keep this separate from operatorAccess so no other PII or Mailroom surface
// inherits Review's intentionally simple "if you can see it, you can fix it"
// rule.
export function reviewAccess(email, env = process.env) {
  const access = operatorAccess(email, env);
  const reviewReadOnly = String(env.POST_CALL_REVIEW_READ_ONLY || "").trim().toLowerCase() === "true";
  const reviewWrite = !reviewReadOnly;
  return {
    ...access,
    role: access.role === "viewer" || access.role === "mailroom_editor" ? "reviewer" : access.role,
    capabilities: {
      ...access.capabilities,
      reviewRead: true,
      reviewWrite,
      resumeUpload: reviewWrite,
      reviewAssign: reviewWrite,
      reviewIdentityOverride: reviewWrite,
      reviewSendApproval: reviewWrite,
    },
  };
}

export function requireSameOrigin(req, res, env = process.env) {
  if (["GET", "HEAD", "OPTIONS"].includes(String(req.method || "GET").toUpperCase())) return true;
  const origin = String(req.headers?.origin || "").trim();
  const forwardedHost = String(req.headers?.["x-forwarded-host"] || req.headers?.host || "").split(",")[0].trim().toLowerCase();
  const forwardedProto = String(req.headers?.["x-forwarded-proto"] || "https").split(",")[0].trim().toLowerCase();
  let parsed;
  try { parsed = new URL(origin); } catch { parsed = null; }
  if (!parsed || !forwardedHost || !mutationOrigins(env).has(parsed.origin.toLowerCase())
      || parsed.host.toLowerCase() !== forwardedHost || parsed.protocol !== `${forwardedProto}:`) {
    res.status(403).json({ ok: false, error: "same_origin_required" });
    return false;
  }
  return true;
}

export const operatorAccessInternals = { emails, mutationOrigins };

export async function requireOperator(req, res, capability) {
  if (!(await requireAuth(req, res))) return null;
  // requireAuth intentionally supports an open pre-auth bootstrap mode for old
  // surfaces. These PII/action proxies are newer and always fail closed.
  if (!req.authedEmail) {
    res.status(503).json({ ok: false, error: "operator_auth_not_configured" });
    return null;
  }
  const access = operatorAccess(req.authedEmail);
  if (capability && !access.capabilities[capability]) {
    res.status(403).json({ ok: false, error: "operator_role_forbidden", role: access.role });
    return null;
  }
  return access;
}

export async function requireReviewOperator(req, res, capability) {
  if (!(await requireAuth(req, res))) return null;
  if (!req.authedEmail) {
    res.status(503).json({ ok: false, error: "operator_auth_not_configured" });
    return null;
  }
  const access = reviewAccess(req.authedEmail);
  if (capability && !access.capabilities[capability]) {
    res.status(403).json({ ok: false, error: "review_read_only", role: access.role });
    return null;
  }
  return access;
}
