import { cors, requireSourcingAccess, sourcingConfig } from "./_lib/core.mjs";
import { executeNativeSearch, newRunId } from "./_lib/native.mjs";
import {
  createRun,
  getRoleState,
  listRuns,
  markCandidatesSeen,
  saveRun,
  seenCandidateIds,
  storeConfigured,
} from "./_lib/store.mjs";

const ROLE_ID = /^[a-zA-Z0-9_-]{6,80}$/;
const queryOf = (req) => req.query || (typeof req.url === "string" ? Object.fromEntries(new URL(req.url, "http://local").searchParams) : {});
const defaultLanes = [
  { id: "lane-core", name: "Core match", rationale: "Closest interpretation of the must-haves." },
  { id: "lane-adjacent", name: "Adjacent titles", rationale: "Transferable profiles without diluting core requirements." },
  { id: "lane-company", name: "Company-led", rationale: "Target-company and talent-density angle." },
];

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
  const requestedCap = Number(body.candidateCap || mapping.candidateCap || 100);
  const candidateCap = Math.min(mapping.candidateCap || 100, requestedCap);
  if (!Number.isInteger(candidateCap) || candidateCap < 1 || candidateCap > 100) {
    return res.status(400).json({ ok: false, error: "candidateCap must be 1-100" });
  }
  const ideas = Array.isArray(rubricVersion.searchIdeas) && rubricVersion.searchIdeas.length
    ? rubricVersion.searchIdeas.slice(0, 3)
    : defaultLanes;
  const lanes = ideas.map((lane, index) => ({
    id: String(lane.id || `lane-${index + 1}`),
    name: String(lane.name || `Lane ${index + 1}`),
    rationale: String(lane.rationale || lane.query || defaultLanes[index]?.rationale || "Role-derived search angle").slice(0, 1200),
  }));
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
    lanes,
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
    const seen = await seenCandidateIds(roleId);
    const result = await executeNativeSearch({
      rubric: run.rubric,
      lanes,
      adjustments: run.adjustments,
      candidateCap,
      reviewProject: { id: mapping.reviewProjectId, name: mapping.reviewProjectName },
      seenCandidateIds: seen,
      fileToProject: cfg.projectWritesApproved,
    });
    const completed = {
      ...run,
      state: "review",
      nativeLanes: result.lanes,
      candidates: result.candidates,
      counts: {
        discovered: result.discoveredCount,
        review: result.candidates.filter((candidate) => candidate.state === "in_review").length,
        deduped: result.candidates.filter((candidate) => candidate.state === "dedup_blocked").length,
        projectFiled: result.projectFiledCount,
      },
      completedAt: new Date().toISOString(),
    };
    const saved = await saveRun(completed, run.revision);
    await markCandidatesSeen(roleId, result.candidates.map((candidate) => candidate.candidateId));
    return res.status(200).json({ ok: true, run: saved });
  } catch (error) {
    const failed = { ...run, state: "failed", error: String(error?.message || error).slice(0, 240), completedAt: new Date().toISOString() };
    try { await saveRun(failed, run.revision); } catch {}
    return res.status(502).json({ ok: false, error: "native_search_failed", runId: run.id, detail: failed.error });
  }
}
