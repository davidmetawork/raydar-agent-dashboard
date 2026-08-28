import { requireAuth } from "../seq/_lib/core.mjs";

const RAYDAR_DOMAINS = new Set(["raydar.xyz", "raydargroup.com"]);

function emails(value) {
  return new Set(String(value || "").split(",").map((item) => item.trim().toLowerCase()).filter(Boolean));
}

function combinedEmails(...values) {
  return new Set(values.flatMap((value) => [...emails(value)]));
}

export function operatorAccess(email, env = process.env) {
  const normalized = String(email || "").trim().toLowerCase();
  const domain = normalized.split("@")[1] || "";
  // Accept the service-owned role names as well as the older dashboard aliases;
  // the upstream service still derives and enforces its own role independently.
  const admins = combinedEmails(env.POST_CALL_REVIEW_ADMIN_EMAILS, env.POST_CALL_MONITOR_ADMIN_EMAILS);
  const reviewers = combinedEmails(env.POST_CALL_REVIEW_ASSISTANT_EMAILS, env.POST_CALL_REVIEWER_EMAILS);
  const mailroomEditors = emails(env.MAILROOM_EDITOR_EMAILS);
  const reviewReadOnly = String(env.POST_CALL_REVIEW_READ_ONLY || "").trim().toLowerCase() === "true";

  // David remains the safe bootstrap administrator. Every other write role is
  // explicit in env, except Review work which is intentionally available to a
  // signed-in Raydar teammate (including David's assistant).
  const admin = normalized === "david@raydar.xyz" || admins.has(normalized);
  const reviewWrite = !reviewReadOnly && (admin || reviewers.has(normalized) || RAYDAR_DOMAINS.has(domain));
  const mailroomWrite = admin || mailroomEditors.has(normalized);

  return {
    email: normalized,
    role: admin ? "admin" : mailroomWrite ? "mailroom_editor" : reviewWrite ? "reviewer" : "viewer",
    capabilities: {
      reviewRead: Boolean(normalized),
      reviewWrite,
      resumeUpload: reviewWrite,
      mailroomRead: Boolean(normalized),
      mailroomWrite,
    },
  };
}

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
