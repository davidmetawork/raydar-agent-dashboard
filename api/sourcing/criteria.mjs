import { randomUUID } from "node:crypto";
import { cors, requireSourcingAccess } from "./_lib/core.mjs";
import {
  acquireRoleLock,
  getRoleState,
  releaseRoleLock,
  saveRoleState,
  storeConfigured,
} from "./_lib/store.mjs";
import {
  deriveAgentCriteria,
  deriveNativeFilters,
  normalizeNativeFilters,
  normalizeRankingConfig,
} from "../../sourcing-filters.mjs";

const ROLE_ID = /^[a-zA-Z0-9_-]{6,80}$/;
const text = (value) => String(value ?? "").trim();

export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "POST only" });
  if (!storeConfigured()) return res.status(503).json({ ok: false, error: "state_store_not_configured" });
  if (!(await requireSourcingAccess(req, res, "search"))) return;
  const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
  const roleId = text(body.roleId);
  if (!ROLE_ID.test(roleId)) return res.status(400).json({ ok: false, error: "valid_roleId_required" });
  let token = null;
  try {
    token = await acquireRoleLock(roleId);
    if (!token) return res.status(409).json({ ok: false, error: "role_busy" });
    const state = await getRoleState(roleId);
    if (!state?.mapping) return res.status(409).json({ ok: false, error: "role_mapping_required" });
    const parent = state.rubricVersions?.find((version) => version.id === state.activeRubricVersionId);
    if (!parent) return res.status(409).json({ ok: false, error: "role_rubric_required" });
    const nativeFilters = normalizeNativeFilters(body.nativeFilters || parent.nativeFilters || deriveNativeFilters(parent.rubric));
    const agentCriteria = text(body.agentCriteria || parent.agentCriteria || deriveAgentCriteria(parent.rubric, parent.adjustments)).slice(0, 12_000);
    if (!agentCriteria) throw new Error("Agent requirements cannot be empty");
    const rankingConfig = normalizeRankingConfig(body.rankingConfig || parent.rankingConfig, state.mapping.candidateCap);
    const unchanged = JSON.stringify({ nativeFilters, agentCriteria, rankingConfig }) ===
      JSON.stringify({
        nativeFilters: normalizeNativeFilters(parent.nativeFilters || deriveNativeFilters(parent.rubric)),
        agentCriteria: text(parent.agentCriteria || deriveAgentCriteria(parent.rubric, parent.adjustments)),
        rankingConfig: normalizeRankingConfig(parent.rankingConfig, state.mapping.candidateCap),
      });
    if (unchanged) return res.status(200).json({ ok: true, state, rubricVersion: parent, unchanged: true });
    const revision = {
      ...parent,
      id: `rubric-${randomUUID()}`,
      version: Math.max(0, ...state.rubricVersions.map((version) => Number(version.version) || 0)) + 1,
      parentVersionId: parent.id,
      nativeFilters,
      agentCriteria,
      rankingConfig,
      createdAt: new Date().toISOString(),
      createdBy: req.authedEmail,
    };
    const next = await saveRoleState(roleId, {
      ...state,
      activeRubricVersionId: revision.id,
      rubricVersions: [...state.rubricVersions, revision].slice(-30),
    });
    return res.status(200).json({ ok: true, state: next, rubricVersion: revision, unchanged: false });
  } catch (error) {
    return res.status(400).json({ ok: false, error: "criteria_invalid", detail: text(error?.message || error).slice(0, 300) });
  } finally {
    if (token) await releaseRoleLock(roleId, token).catch(() => {});
  }
}
