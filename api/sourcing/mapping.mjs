import { randomUUID } from "node:crypto";
import {
  cors,
  getRoleWorkspace,
  listSourcingProjects,
  listSourcingSequences,
  requireSourcingAccess,
  sourcingConfig,
} from "./_lib/core.mjs";
import { getRoleState, saveRoleState, storeConfigured } from "./_lib/store.mjs";
import { validateRoleMapping } from "../../sourcing-domain.mjs";

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
  try {
    const mapping = validateRoleMapping({
      roleId,
      reviewProjectId: body.reviewProjectId,
      sequenceId: body.sequenceId,
    });
    const config = sourcingConfig();
    if (!config.projectWritesApproved) {
      return res.status(503).json({ ok: false, error: "paraform_project_approval_required", capability: "project" });
    }
    if (mapping.sequenceId && !config.sequenceWritesApproved) {
      return res.status(503).json({ ok: false, error: "paraform_sequence_approval_required", capability: "sequence" });
    }
    const cap = Number(body.candidateCap || 100);
    if (!Number.isInteger(cap) || cap < 1 || cap > 100) throw new Error("candidateCap must be an integer from 1 to 100");
    const [workspace, projects, sequences, previous] = await Promise.all([
      getRoleWorkspace(roleId),
      listSourcingProjects(),
      mapping.sequenceId ? listSourcingSequences() : Promise.resolve([]),
      getRoleState(roleId),
    ]);
    const project = projects.find((item) => item.id === mapping.reviewProjectId);
    if (!project) throw new Error("review project is missing or not editable");
    const sequence = mapping.sequenceId ? sequences.find((item) => item.id === mapping.sequenceId) : null;
    if (mapping.sequenceId && !sequence) throw new Error("sequence not found");
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
        parentVersionId: active?.id || null,
        createdAt: new Date().toISOString(),
        createdBy: req.authedEmail,
      });
    }
    const state = await saveRoleState(roleId, {
      ...(previous || {}),
      mapping: {
        ...mapping,
        reviewProjectName: project.name,
        sequenceName: sequence?.name || null,
        candidateCap: cap,
      },
      activeRubricVersionId,
      rubricVersions: versions,
      ownerEmail: req.authedEmail,
      createdAt: previous?.createdAt || new Date().toISOString(),
    });
    return res.status(200).json({ ok: true, state });
  } catch (error) {
    return res.status(400).json({ ok: false, error: "mapping_invalid", detail: String(error?.message || error).slice(0, 200) });
  }
}
