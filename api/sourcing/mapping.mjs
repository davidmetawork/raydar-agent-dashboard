import { randomUUID } from "node:crypto";
import {
  cors,
  createSourcingProject,
  createSourcingSequenceShell,
  deleteSourcingSequence,
  getSourcingCampaign,
  getRoleWorkspace,
  listSourcingGmailAccounts,
  listSourcingProjects,
  listSourcingSequences,
  requireSourcingAccess,
  sourcingConfig,
  updateSourcingSequenceSettings,
  updateSourcingSequenceSteps,
} from "./_lib/core.mjs";
import { acquireRoleLock, getRoleState, releaseRoleLock, saveRoleState, storeConfigured } from "./_lib/store.mjs";
import { validateRoleMapping } from "../../sourcing-domain.mjs";
import { provisionRoleAssets } from "./_lib/provision.mjs";
import { deriveAgentCriteria, deriveNativeFilters, normalizeRankingConfig } from "../../sourcing-filters.mjs";

const ROLE_ID = /^[a-zA-Z0-9_-]{6,80}$/;
const queryOf = (req) => req.query || (typeof req.url === "string" ? Object.fromEntries(new URL(req.url, "http://local").searchParams) : {});

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (!storeConfigured()) return res.status(503).json({ ok: false, error: "state_store_not_configured" });
  if (!(await requireSourcingAccess(req, res, "role-read"))) return;
  const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
  const roleId = String((req.method === "GET" ? queryOf(req).roleId : body.roleId) || "").trim();
  if (!ROLE_ID.test(roleId)) return res.status(400).json({ ok: false, error: "valid roleId required" });
  if (req.method === "GET") {
    const state = await getRoleState(roleId);
    return res.status(200).json({ ok: true, state });
  }
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "GET or POST only" });
  let roleLockToken = null;
  try {
    roleLockToken = await acquireRoleLock(roleId);
    if (!roleLockToken) return res.status(409).json({ ok: false, error: "role_busy" });
    const config = sourcingConfig();
    if (!config.projectWritesApproved) {
      return res.status(503).json({ ok: false, error: "paraform_project_approval_required", capability: "project" });
    }
    if (!config.sequenceWritesApproved) {
      return res.status(503).json({ ok: false, error: "paraform_sequence_approval_required", capability: "sequence" });
    }
    const cap = Number(body.candidateCap || 100);
    if (!Number.isInteger(cap) || cap < 1 || cap > 100) throw new Error("candidateCap must be an integer from 1 to 100");
    const [workspace, previous] = await Promise.all([
      getRoleWorkspace(roleId),
      getRoleState(roleId),
    ]);
    const provisioned = await provisionRoleAssets({
      roleId,
      workspace,
      requestedProjectId: String(body.reviewProjectId || "").trim() || null,
      requestedSequenceId: String(body.sequenceId || "").trim() || null,
      adapters: {
        listProjects: listSourcingProjects,
        listSequences: listSourcingSequences,
        createProject: createSourcingProject,
        getCampaign: getSourcingCampaign,
        listGmailAccounts: listSourcingGmailAccounts,
        createSequenceShell: createSourcingSequenceShell,
        updateSequenceSettings: updateSourcingSequenceSettings,
        updateSequenceSteps: updateSourcingSequenceSteps,
        deleteSequence: deleteSourcingSequence,
      },
    });
    const mapping = validateRoleMapping({
      roleId,
      reviewProjectId: provisioned.project.id,
      sequenceId: provisioned.sequence.id,
    });
    const versions = Array.isArray(previous?.rubricVersions) ? previous.rubricVersions : [];
    let activeRubricVersionId = previous?.activeRubricVersionId || null;
    const active = versions.find((version) => version.id === activeRubricVersionId);
    const sourceChanged = active && JSON.stringify({ rubric: active.rubric, searchIdeas: active.searchIdeas }) !==
      JSON.stringify({ rubric: workspace.rubric, searchIdeas: workspace.searchIdeas });
    if (!versions.length || sourceChanged) {
      activeRubricVersionId = `rubric-${randomUUID()}`;
      versions.push({
        id: activeRubricVersionId,
        version: Math.max(0, ...versions.map((version) => Number(version.version) || 0)) + 1,
        rubric: workspace.rubric,
        searchIdeas: workspace.searchIdeas,
        adjustments: active?.adjustments || [],
        nativeFilters: active?.nativeFilters || deriveNativeFilters(workspace.rubric),
        agentCriteria: active?.agentCriteria || deriveAgentCriteria(workspace.rubric, active?.adjustments || []),
        rankingConfig: normalizeRankingConfig(active?.rankingConfig || {}, cap),
        parentVersionId: active?.id || null,
        createdAt: new Date().toISOString(),
        createdBy: req.authedEmail,
      });
    } else if (active && (!active.nativeFilters || !active.rankingConfig)) {
      active.nativeFilters = active.nativeFilters || deriveNativeFilters(active.rubric || workspace.rubric);
      active.agentCriteria = active.agentCriteria || deriveAgentCriteria(active.rubric || workspace.rubric, active.adjustments || []);
      active.rankingConfig = normalizeRankingConfig(active.rankingConfig || {}, cap);
    }
    const state = await saveRoleState(roleId, {
      ...(previous || {}),
      mapping: {
        ...mapping,
        reviewProjectName: provisioned.project.name,
        sequenceName: provisioned.sequence.name,
        candidateCap: cap,
        targetName: provisioned.targetName,
        projectCreated: provisioned.projectCreated,
        sequenceCreated: provisioned.sequenceCreated,
        projectMatch: provisioned.projectMatch,
        sequenceMatch: provisioned.sequenceMatch,
        sequenceWarnings: provisioned.sequenceWarnings,
        sequenceAudit: provisioned.sequenceAudit,
        preparedAt: new Date().toISOString(),
      },
      activeRubricVersionId,
      rubricVersions: versions,
      ownerEmail: req.authedEmail,
      createdAt: previous?.createdAt || new Date().toISOString(),
    });
    return res.status(200).json({ ok: true, state, provisioned });
  } catch (error) {
    const expired = error?.code === "AUTH_EXPIRED";
    return res.status(expired ? 503 : 400).json({ ok: false, error: expired ? "paraform_session_expired" : "mapping_invalid", detail: String(error?.message || error).slice(0, 500) });
  } finally {
    if (roleLockToken) await releaseRoleLock(roleId, roleLockToken).catch(() => {});
  }
}
