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
  trpcPostWithMeta,
} from "../../seq/_lib/core.mjs";
import { createHash, timingSafeEqual } from "node:crypto";
import {
  buildRoleRubric,
  buildSequenceContext,
  FEEDBACK_REASONS,
  normalizeActiveRoles,
  normalizeSearchIdeas,
} from "./model.mjs";
import {
  getSourceCache,
  setSourceCache,
  storeConfigured,
  takeRoleReadSlot,
} from "./store.mjs";

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
  const raw = await cachedRoleRead("active-roles", 300, () => trpcGet("activeRoles.getActiveRoles", {}));
  return normalizeActiveRoles(raw);
}

export async function getRoleWorkspace(roleId) {
  const detail = await cachedRoleRead(`role-detail:${roleId}`, 1800, () =>
    trpcGet("role.getRoleByIdDetailed", { role_id: roleId }));
  return {
    roleId,
    rubric: buildRoleRubric({ detail }),
    sequenceContext: buildSequenceContext(detail),
    searchIdeas: normalizeSearchIdeas(detail?.searchIdeas || detail?.search_ideas),
    unavailable: ["filters", "ideas"],
    readOnly: !SEARCH_APPROVED,
    writesEnabled: PROJECT_WRITES_APPROVED,
  };
}

async function cachedRoleRead(key, ttlSeconds, loader) {
  if (!storeConfigured()) {
    const error = new Error("role read cache is not configured");
    error.code = "STATE_STORE_UNAVAILABLE";
    throw error;
  }
  const cached = await getSourceCache(key);
  if (cached !== null) return cached;
  if (!(await takeRoleReadSlot())) {
    const error = new Error("Paraform role-read limit reached; retry after one minute");
    error.code = "ROLE_RATE_LIMIT";
    throw error;
  }
  const value = await loader();
  await setSourceCache(key, value, ttlSeconds);
  return value;
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

export async function createSourcingProject(name) {
  const project = await trpcPost("candidateProjects.createProject", { name });
  if (!project?.id) throw new Error("Paraform createProject returned no id");
  return { id: String(project.id), name: String(project.name || name) };
}

export async function getSourcingCampaign(sequenceId) {
  return trpcGet("campaigns.getCampaign", { campaign_id: sequenceId });
}

export async function listSourcingGmailAccounts() {
  const rows = (await trpcGet("gmail.getActiveUserGmailAccounts", {})) || [];
  return rows.map((row) => ({
    id: String(row?.account_id || row?.id || ""),
    email: String(row?.email || "").trim().toLowerCase(),
  })).filter((row) => row.id && row.email);
}

export async function createSourcingSequenceShell({ name, roleId, projectId }) {
  const sequence = await trpcPost("campaigns.createCampaignFromScratch", {
    name,
    timezone: "America/Los_Angeles",
    role_id: roleId,
    project_id: projectId,
    auto_add_project_candidates: false,
  });
  if (!sequence?.id) throw new Error("Paraform createCampaignFromScratch returned no id");
  return { id: String(sequence.id), name: String(sequence.name || name) };
}

export async function updateSourcingSequenceSteps(sequenceId, steps) {
  return trpcPost("campaigns.updateSequenceSteps", { campaign_id: sequenceId, steps });
}

export async function updateSourcingSequenceSettings(sequenceId, settings) {
  const startDate = settings.startDate instanceof Date ? settings.startDate : new Date(settings.startDate);
  if (Number.isNaN(startDate.getTime())) throw new Error("valid sequence start date required");
  return trpcPostWithMeta("campaigns.updateSequence", {
    sequence_id: sequenceId,
    name: settings.name,
    role_id: null,
    enabled: false,
    timezone: "America/Los_Angeles",
    start_type: "DATE_TIME",
    start_date: startDate.toISOString(),
    days_to_send: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"],
    time_start: "09:00",
    time_end: "18:00",
    daily_limit: 20,
    include_signature: false,
    enable_tracking: true,
    prioritize_existing_candidates: false,
    auto_add_project_candidates: false,
    send_from_account_ids: settings.accountIds,
  }, { start_date: ["Date"] });
}

export async function deleteSourcingSequence(sequenceId) {
  return trpcPost("campaigns.deleteSequence", { sequence_id: sequenceId });
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
