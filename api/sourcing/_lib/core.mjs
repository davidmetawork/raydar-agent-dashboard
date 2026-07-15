// Paraform adapter for the Sourcing workspace. Every capability has a separate
// deployment flag so sanctioned role reads cannot implicitly enable Search,
// Project writes, or Sequence enrollment.

import {
  authConfig,
  cors,
  hasCookie,
  requireAuth,
  trpcGet,
  trpcPost,
} from "../../seq/_lib/core.mjs";
import { createHash, timingSafeEqual } from "node:crypto";
import {
  buildRoleRubric,
  FEEDBACK_REASONS,
  normalizeActiveRoles,
  normalizeSearchIdeas,
} from "./model.mjs";

const ACCESS_KEY = process.env.SOURCING_ACCESS_KEY || "";
const ROLE_READ_APPROVED = process.env.PARAFORM_SOURCING_ROLE_READ_APPROVED === "true";
const SEARCH_APPROVED = process.env.PARAFORM_SOURCING_SEARCH_APPROVED === "true";
const PROJECT_WRITES_APPROVED = process.env.PARAFORM_SOURCING_PROJECT_WRITES_APPROVED === "true";
const SEQUENCE_WRITES_APPROVED = process.env.PARAFORM_SOURCING_SEQUENCE_WRITES_APPROVED === "true";

export { cors, hasCookie, trpcPost };

export function sourcingConfig() {
  const auth = authConfig();
  return {
    ...auth,
    authRequired: Boolean(auth.authRequired || ACCESS_KEY),
    authModes: [auth.authRequired ? "google" : null, ACCESS_KEY ? "access-key" : null].filter(Boolean),
    roleReadApproved: ROLE_READ_APPROVED,
    searchApproved: SEARCH_APPROVED,
    projectWritesApproved: PROJECT_WRITES_APPROVED,
    sequenceWritesApproved: SEQUENCE_WRITES_APPROVED,
    nativeAccessApproved: SEARCH_APPROVED,
    paraformSessionConfigured: hasCookie(),
    readOnly: !SEARCH_APPROVED,
    writesEnabled: PROJECT_WRITES_APPROVED,
    feedbackReasons: FEEDBACK_REASONS,
  };
}

function equalSecret(a, b) {
  const left = createHash("sha256").update(String(a || "")).digest();
  const right = createHash("sha256").update(String(b || "")).digest();
  return timingSafeEqual(left, right);
}

export async function requireSourcingAuth(req, res) {
  const cfg = sourcingConfig();
  if (!cfg.authRequired) {
    res.status(503).json({ ok: false, error: "auth_not_configured" });
    return false;
  }
  const key = req.headers["x-app-key"] || "";
  if (ACCESS_KEY && equalSecret(key, ACCESS_KEY)) {
    req.authedEmail = "access-key@raydar.internal";
    return true;
  }
  if (authConfig().authRequired) return requireAuth(req, res);
  res.status(401).json({ ok: false, error: "auth_required" });
  return false;
}

export async function requireSourcingAccess(req, res, capability = "role-read") {
  if (!(await requireSourcingAuth(req, res))) return false;
  const cfg = sourcingConfig();
  const approved = {
    "role-read": cfg.roleReadApproved,
    search: cfg.searchApproved,
    project: cfg.projectWritesApproved,
    sequence: cfg.sequenceWritesApproved,
  }[capability];
  if (!approved) {
    res.status(503).json({ ok: false, error: `paraform_${capability.replace("-", "_")}_approval_required`, capability });
    return false;
  }
  if (!cfg.paraformSessionConfigured) {
    res.status(503).json({ ok: false, error: "no_cookie", capability });
    return false;
  }
  return true;
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
    readOnly: !SEARCH_APPROVED,
    writesEnabled: PROJECT_WRITES_APPROVED,
  };
}

export async function listSourcingProjects() {
  const rows = (await trpcGet("candidateProjects.getProjectsByUserId", { show_agency_projects: true })) || [];
  return rows
    .filter((row) => row?.id && row?.permissions?.canEdit !== false)
    .map((row) => ({ id: String(row.id), name: String(row.name || "Untitled project"), candidateCount: row.candidate_count ?? null }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function listSourcingSequences() {
  const rows = (await trpcGet("campaigns.getListOfCampaignsOptimized", {})) || [];
  return rows
    .filter((row) => row?.id)
    .map((row) => ({ id: String(row.id), name: String(row.name || "Untitled sequence"), enabled: Boolean(row.enabled), leads: row.leads_count ?? null }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function nativeSearchCreateSession() {
  return trpcPost("sourcing.createSession", {});
}

export async function nativeSearchSubmit(sessionId, query) {
  return trpcPost("sourcing.submitNlSearch", { sessionId, query });
}

export async function nativeSearchApply(sessionId, filters, name) {
  return trpcPost("sourcing.applyFilters", { sessionId, filters, ...(name ? { name } : {}) });
}

export async function nativeSearchPaginate(sessionId, page, pageSize) {
  return trpcPost("sourcing.paginate", { sessionId, page, pageSize });
}

export async function nativeSaveCandidate(linkedinSlug, projectId, projectName) {
  return trpcPost("sourcing.saveCandidate", {
    linkedinSlug,
    destination: { type: "project", id: projectId, name: projectName || "Review project" },
  });
}
