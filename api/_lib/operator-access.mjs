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
  // These names intentionally match the owning post-call service.  Domain
  // membership is authentication, not authorization: candidate PII and review
  // mutations stay unavailable until the exact operator is allowlisted.
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
  const reviewWrite = !reviewReadOnly && (admin || assistant || operator);
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
      reviewIdentityOverride: !reviewReadOnly && admin,
      reviewPriority: !reviewReadOnly && admin,
      mailroomRead,
      mailroomWrite,
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

// Review itself is the authorization boundary: a validated Dashboard session
// may resolve the case it can see, without granting access to any other PII or
// Mailroom surface. The emergency read-only switch remains fail-closed.
export function reviewAccess(email, env = process.env) {
  const base = operatorAccess(email, env);
  const readOnly = String(env.POST_CALL_REVIEW_READ_ONLY || '').trim().toLowerCase() === 'true';
  const reviewWrite = !readOnly;
  return {
    ...base,
    role: base.role === 'viewer' ? 'reviewer' : base.role,
    capabilities: {
      ...base.capabilities,
      reviewRead: true,
      reviewWrite,
      resumeUpload: reviewWrite,
      reviewAssign: reviewWrite,
      reviewIdentityOverride: reviewWrite,
      reviewSendApproval: reviewWrite,
    },
  };
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
    res.status(503).json({ ok: false, error: 'operator_auth_not_configured' });
    return null;
  }
  const access = reviewAccess(req.authedEmail);
  if (capability && !access.capabilities[capability]) {
    res.status(403).json({ ok: false, error: 'review_read_only', role: access.role });
    return null;
  }
  return access;
}
