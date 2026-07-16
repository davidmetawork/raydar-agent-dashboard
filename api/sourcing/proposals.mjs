import { randomUUID } from "node:crypto";
import { cors, requireSourcingAuth } from "./_lib/core.mjs";
import {
  acquireRoleLock,
  acquireRunLock,
  getRoleState,
  getRun,
  releaseRoleLock,
  releaseRunLock,
  saveRunAndRoleState,
  storeConfigured,
} from "./_lib/store.mjs";
import { proposeNextRun } from "../../sourcing-domain.mjs";

export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "POST only" });
  if (!storeConfigured()) return res.status(503).json({ ok: false, error: "state_store_not_configured" });
  if (!(await requireSourcingAuth(req, res))) return;
  let runId = "";
  let roleId = "";
  let runLockToken = null;
  let roleLockToken = null;
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    runId = String(body.runId || "");
    runLockToken = await acquireRunLock(runId);
    if (!runLockToken) return res.status(409).json({ ok: false, error: "run_busy" });
    const run = await getRun(runId);
    if (!run) return res.status(404).json({ ok: false, error: "run_not_found" });
    if (Number(body.expectedRevision) !== Number(run.revision)) return res.status(409).json({ ok: false, error: "revision_conflict" });
    const proposed = proposeNextRun(run.candidates.map((candidate) => candidate.feedback || {})).proposals;
    const acceptedReasons = new Set(Array.isArray(body.acceptedReasons) ? body.acceptedReasons.map(String) : []);
    const accepted = proposed.filter((proposal) => acceptedReasons.has(proposal.reason));
    if (!accepted.length) return res.status(400).json({ ok: false, error: "select_at_least_one_proposal" });
    roleId = run.roleId;
    roleLockToken = await acquireRoleLock(roleId);
    if (!roleLockToken) return res.status(409).json({ ok: false, error: "role_busy" });
    const roleState = await getRoleState(roleId);
    if (!roleState) return res.status(409).json({ ok: false, error: "role_mapping_required" });
    const parent = roleState.rubricVersions.find((version) => version.id === roleState.activeRubricVersionId);
    const revision = {
      id: `rubric-${randomUUID()}`,
      version: Math.max(0, ...roleState.rubricVersions.map((version) => Number(version.version) || 0)) + 1,
      parentVersionId: parent?.id || null,
      rubric: run.rubric,
      searchIdeas: parent?.searchIdeas || [],
      adjustments: [...(parent?.adjustments || []), ...accepted.map((proposal) => ({ ...proposal, approvedFromRunId: run.id }))],
      nativeFilters: parent?.nativeFilters,
      agentCriteria: parent?.agentCriteria,
      rankingConfig: parent?.rankingConfig,
      createdAt: new Date().toISOString(),
      createdBy: req.authedEmail,
    };
    const decision = {
      id: `decision-${randomUUID()}`,
      acceptedReasons: [...acceptedReasons],
      accepted,
      rubricVersionId: revision.id,
      actor: req.authedEmail,
      note: String(body.note || "").trim().slice(0, 1000) || null,
      at: new Date().toISOString(),
    };
    const saved = await saveRunAndRoleState(
      { ...run, proposalDecisions: [...(run.proposalDecisions || []), decision] },
      run.revision,
      roleId,
      {
      ...roleState,
      activeRubricVersionId: revision.id,
      rubricVersions: [...roleState.rubricVersions, revision],
      },
    );
    return res.status(200).json({ ok: true, run: saved.run, rubricVersion: revision });
  } catch (error) {
    const conflict = error?.code === "REVISION_CONFLICT";
    return res.status(conflict ? 409 : 400).json({ ok: false, error: conflict ? "revision_conflict" : "proposal_invalid", detail: String(error?.message || error).slice(0, 200) });
  } finally {
    if (roleLockToken) await releaseRoleLock(roleId, roleLockToken).catch(() => {});
    if (runLockToken) await releaseRunLock(runId, runLockToken).catch(() => {});
  }
}
