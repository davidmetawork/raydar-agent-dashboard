// Read-only Paraform role intelligence for the Sourcing workspace.
// Native Search sessions and all candidate/project/sequence writes are
// intentionally absent until Paraform sanctions the access path.

import {
  authConfig,
  cors,
  hasCookie,
  requireAuth,
  trpcGet,
} from "../../seq/_lib/core.mjs";
import {
  buildRoleRubric,
  FEEDBACK_REASONS,
  normalizeActiveRoles,
  normalizeSearchIdeas,
} from "./model.mjs";

const NATIVE_ACCESS_APPROVED = process.env.PARAFORM_SOURCING_ACCESS_APPROVED === "true";

export { cors };

export function sourcingConfig() {
  const auth = authConfig();
  return {
    ...auth,
    nativeAccessApproved: NATIVE_ACCESS_APPROVED,
    paraformSessionConfigured: hasCookie(),
    readOnly: true,
    writesEnabled: false,
    feedbackReasons: FEEDBACK_REASONS,
  };
}

export async function requireSourcingAccess(req, res) {
  const cfg = sourcingConfig();
  if (!cfg.authRequired) {
    res.status(503).json({ ok: false, error: "auth_not_configured", readOnly: true, writesEnabled: false });
    return false;
  }
  if (!cfg.nativeAccessApproved) {
    res.status(503).json({ ok: false, error: "paraform_approval_required", readOnly: true, writesEnabled: false });
    return false;
  }
  if (!cfg.paraformSessionConfigured) {
    res.status(503).json({ ok: false, error: "no_cookie", readOnly: true, writesEnabled: false });
    return false;
  }
  return requireAuth(req, res);
}

export async function listSourcingRoles() {
  const raw = await trpcGet("activeRoles.getActiveRoles", {});
  return normalizeActiveRoles(raw);
}

export async function getRoleWorkspace(roleId) {
  const calls = [
    ["detail", "role.getRoleByIdDetailed", { role_id: roleId }],
    ["requirements", "role.getRoleRequirements", { role_id: roleId }],
    ["filters", "candidates.getCandidateFiltersByRoleId", { role_id: roleId }],
    ["ideas", "sourcing.getRoleSearchIdeas", { roleId }],
  ];
  const settled = await Promise.allSettled(calls.map(([, proc, input]) => trpcGet(proc, input)));
  const data = {};
  const unavailable = [];
  settled.forEach((result, index) => {
    const [key] = calls[index];
    if (result.status === "fulfilled") data[key] = result.value;
    else unavailable.push(key);
  });
  if (!data.detail && !data.requirements && !data.filters) {
    const error = new Error("role intelligence unavailable");
    error.code = unavailable.length === calls.length ? "ROLE_UNAVAILABLE" : "PARTIAL_FAILURE";
    throw error;
  }
  return {
    roleId,
    rubric: buildRoleRubric(data),
    searchIdeas: normalizeSearchIdeas(data.ideas),
    unavailable,
    readOnly: true,
    writesEnabled: false,
  };
}
