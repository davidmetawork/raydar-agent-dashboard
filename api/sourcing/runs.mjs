import { cors, requireSourcingAccess, sourcingConfig } from "./_lib/core.mjs";
import { executeHybridSearch, newRunId } from "./_lib/native.mjs";
import {
  createRun,
  filedCandidateIds,
  getRoleState,
  listRuns,
  markCandidatesFiled,
  saveRun,
  storeConfigured,
} from "./_lib/store.mjs";
import { deriveAgentCriteria, deriveNativeFilters, normalizeRankingConfig } from "../../sourcing-filters.mjs";

const ROLE_ID = /^[a-zA-Z0-9_-]{6,80}$/;
const queryOf = (req) => req.query || (typeof req.url === "string" ? Object.fromEntries(new URL(req.url, "http://local").searchParams) : {});

export const config = { maxDuration: 300 };

function summary(run) {
  return {
    id: run.id,
    roleId: run.roleId,
    state: run.state,
    revision: run.revision,
    createdAt: run.createdAt,
    completedAt: run.completedAt || null,
    counts: run.counts || {},
    rubricVersionId: run.rubricVersionId,
  };
}

export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (!storeConfigured()) return res.status(503).json({ ok: false, error: "state_store_not_configured" });
  if (req.method === "GET") {
    if (!(await requireSourcingAccess(req, res, "role-read"))) return;
    const roleId = String(queryOf(req).roleId || "").trim();
    if (!ROLE_ID.test(roleId)) return res.status(400).json({ ok: false, error: "valid roleId required" });
    const runs = await listRuns(roleId, 12);
    return res.status(200).json({ ok: true, runs: runs.map(summary) });
  }
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "GET or POST only" });
  if (!(await requireSourcingAccess(req, res, "search"))) return;
  const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
  const roleId = String(body.roleId || "").trim();
  if (!ROLE_ID.test(roleId)) return res.status(400).json({ ok: false, error: "valid roleId required" });
  const state = await getRoleState(roleId);
  const mapping = state?.mapping;
  const rubricVersion = state?.rubricVersions?.find((version) => version.id === state.activeRubricVersionId);
  if (!mapping || !rubricVersion) return res.status(409).json({ ok: false, error: "role_mapping_required" });
  const rankingConfig = normalizeRankingConfig(rubricVersion.rankingConfig || {}, mapping.candidateCap || 100);
  const candidateCap = rankingConfig.poolSize;
  const nativeFilters = rubricVersion.nativeFilters || deriveNativeFilters(rubricVersion.rubric);
  const agentCriteria = rubricVersion.agentCriteria || deriveAgentCriteria(rubricVersion.rubric, rubricVersion.adjustments || []);
  const run = {
    id: newRunId(),
    roleId,
    rubricVersionId: rubricVersion.id,
    rubric: rubricVersion.rubric,
    adjustments: rubricVersion.adjustments || [],
    state: "running",
    revision: 0,
    candidateCap,
    mapping,
    nativeFilters,
    agentCriteria,
    rankingConfig,
    candidates: [],
    feedbackEvents: [],
    proposalDecisions: [],
    counts: {},
    createdBy: req.authedEmail,
    createdAt: new Date().toISOString(),
  };
  await createRun(run);
  try {
    const cfg = sourcingConfig();
    const alreadyFiled = await filedCandidateIds(roleId);
    if (!cfg.rankingConfigured) throw new Error("OpenAI ranking is not configured");
    const result = await executeHybridSearch({
      rubric: run.rubric,
      nativeFilters,
      agentCriteria,
      adjustments: run.adjustments,
      rankingConfig,
      reviewProject: { id: mapping.reviewProjectId, name: mapping.reviewProjectName },
      seenCandidateIds: alreadyFiled,
      fileToProject: cfg.projectWritesApproved,
      searchName: mapping.targetName || `${run.rubric?.role?.company || "Raydar"} - ${run.rubric?.role?.title || "Sourcing"}`,
    });
    const completed = {
      ...run,
      state: "review",
      nativeSearch: result.search,
      ranking: result.ranking,
      candidates: result.candidates,
      counts: {
        discovered: result.discoveredCount,
        evaluated: result.evaluatedCount,
        qualified: result.qualifiedCount,
        selected: result.selectedCount,
        agentRejected: result.rejectedCount,
        review: result.reviewCount,
        deduped: result.dedupedCount,
        projectFiled: result.projectFiledCount,
      },
      completedAt: new Date().toISOString(),
    };
    const saved = await saveRun(completed, run.revision);
    try {
      await markCandidatesFiled(roleId, result.candidates
        .filter((candidate) => candidate.projectStatus === "filed")
        .map((candidate) => candidate.candidateId));
    } catch (error) {
      // The completed run is the durable source of truth and the next run heals
      // this index from history. Never report a failed Search after Project
      // writes and the completed audit record have both succeeded.
      console.error("sourcing filed-index reconciliation deferred", error);
    }
    return res.status(200).json({ ok: true, run: saved });
  } catch (error) {
    const failed = { ...run, state: "failed", error: String(error?.message || error).slice(0, 240), completedAt: new Date().toISOString() };
    try { await saveRun(failed, run.revision); } catch {}
    return res.status(502).json({ ok: false, error: "native_search_failed", runId: run.id, detail: failed.error });
  }
}
