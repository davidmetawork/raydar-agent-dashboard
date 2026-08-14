// Auth + response helpers for the revenue endpoints.
//
// Reuses the shared Raydar Google session (`__Secure-raydar_session`) via
// seq/_lib/core.mjs rather than inventing a second auth path. That cookie is
// Domain=raydar.xyz, which is precisely why these endpoints live in THIS repo
// and not in webview/: webview is fetched cross-origin with ACAO:* and no
// credentialed fetches, so it can never attribute a write to a person.

import { cors, requireAuth } from "../../seq/_lib/core.mjs";

export { cors, requireAuth };

// Anyone signed in may ADD a deal — friction there costs us data, and a missing
// placement is a worse failure than a duplicate one. Editing, voiding and
// deleting are narrower: they can silently change a number people are paid
// against, so they stay with David unless the allowlist is widened explicitly.
const DEFAULT_EDITORS = ["david@raydar.xyz"];

export function editors() {
  const configured = String(process.env.REVENUE_EDITORS || "")
    .split(",").map((email) => email.trim().toLowerCase()).filter(Boolean);
  return configured.length ? configured : DEFAULT_EDITORS;
}

export const isEditor = (email) => editors().includes(String(email || "").trim().toLowerCase());

/**
 * Guard for mutating an existing row. Call AFTER requireAuth.
 * Returns true when the caller may proceed; otherwise it has already answered.
 */
export function requireEditor(req, res) {
  if (isEditor(req.authedEmail)) return true;
  res.status(403).json({
    ok: false,
    error: "editor_only",
    detail: "Editing or removing an existing deal is restricted. Ask David, or add a new deal instead.",
  });
  return false;
}

export function readJsonBody(req) {
  try {
    return { body: typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {}) };
  } catch {
    return { error: "invalid_json" };
  }
}

/** This payload carries client names, candidate labels and amounts. Never cache it. */
export function privateJson(res, status, payload) {
  res.setHeader("Cache-Control", "no-store");
  return res.status(status).json(payload);
}
