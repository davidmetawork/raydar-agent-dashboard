import { cors, requireSourcingAccess, trpcPost } from "./_lib/core.mjs";
import { acquireRunLock, getRun, releaseRunLock, saveRun, storeConfigured } from "./_lib/store.mjs";
import { applyEnrollmentResults, planEnrollment, queueEnrollment } from "./_lib/enrollment.mjs";
import { bookedSet, ccuIndex, enrolledElsewhereSet } from "../seq/_lib/core.mjs";

export const config = { maxDuration: 300 };

export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "POST only" });
  if (!storeConfigured()) return res.status(503).json({ ok: false, error: "state_store_not_configured" });
  if (!(await requireSourcingAccess(req, res, "sequence"))) return;
  let runId = "";
  let lockToken = null;
  let claimedRun = null;
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    runId = String(body.runId || "");
    lockToken = await acquireRunLock(runId);
    if (!lockToken) return res.status(409).json({ ok: false, error: "run_busy" });
    const run = await getRun(runId);
    if (!run) return res.status(404).json({ ok: false, error: "run_not_found" });
    if (Number(body.expectedRevision) !== Number(run.revision)) return res.status(409).json({ ok: false, error: "revision_conflict" });
    const selected = new Set(Array.isArray(body.candidateIds) ? body.candidateIds.map(String) : []);
    const candidates = run.candidates.filter((candidate) => selected.has(candidate.id));
    if (!candidates.length) return res.status(400).json({ ok: false, error: "select_good_candidates" });
    if (String(body.confirmation || "") !== `ENROLL ${candidates.length}`) {
      return res.status(400).json({ ok: false, error: "confirmation_mismatch", expected: `ENROLL ${candidates.length}` });
    }
    if (!run.mapping?.sequenceId) return res.status(409).json({ ok: false, error: "sequence_mapping_required" });
    if (candidates.some((candidate) => !["good", "enrollment_queued"].includes(candidate.state) || candidate.projectStatus !== "filed" || !candidate.candidateUserId)) {
      return res.status(409).json({ ok: false, error: "only_project_filed_good_candidates_can_enroll" });
    }

    // Persist the intent before the external write. If Paraform succeeds but a
    // later response/readback is interrupted, the queued state can be safely
    // reconciled on retry instead of silently losing the successful write.
    const queuedAt = new Date().toISOString();
    const claimedCandidates = run.candidates.map((candidate) => selected.has(candidate.id)
      ? queueEnrollment(candidate, { source: "sourcing-enroll-claim", at: queuedAt })
      : candidate);
    claimedRun = candidates.some((candidate) => candidate.state === "good")
      ? await saveRun({ ...run, candidates: claimedCandidates }, run.revision)
      : run;
    const claimed = claimedRun.candidates.filter((candidate) => selected.has(candidate.id));
    const ids = claimed.map((candidate) => candidate.candidateUserId);
    const [already, booked, membershipBefore] = await Promise.all([
      enrolledElsewhereSet({ strict: true }),
      bookedSet(ids),
      ccuIndex(claimedRun.mapping.sequenceId, { strict: true }),
    ]);
    const { preblocked, reconciled, keep } = planEnrollment(claimed, { already, booked, membership: membershipBefore });
    let vendorBlocked = new Map();
    if (keep.length) {
      const response = await trpcPost("campaigns.addToCampaigns", {
        campaign_ids: [claimedRun.mapping.sequenceId],
        candidate_user_ids: keep.map((candidate) => candidate.candidateUserId),
        source: "SOURCING",
      });
      vendorBlocked = new Map((response?.blocked_candidates || []).map((item) => [item.candidate_user_id, item.company_name || "blocked_company"]));
    }
    const membership = keep.length ? await ccuIndex(claimedRun.mapping.sequenceId, { strict: true }) : membershipBefore;
    const at = new Date().toISOString();
    const updated = applyEnrollmentResults(claimedRun.candidates, selected, {
      preblocked,
      reconciled,
      vendorBlocked,
      membership,
      sequenceId: claimedRun.mapping.sequenceId,
      at,
    });
    const saved = await saveRun({ ...claimedRun, candidates: updated }, claimedRun.revision);
    const enrolled = updated.filter((candidate) => selected.has(candidate.id) && candidate.state === "enrolled").length;
    return res.status(200).json({ ok: true, run: saved, enrolled, blocked: claimed.length - enrolled });
  } catch (error) {
    return res.status(claimedRun ? 502 : 400).json({
      ok: false,
      error: "enrollment_failed",
      detail: String(error?.message || error).slice(0, 220),
      retryable: Boolean(claimedRun),
      recoveryState: claimedRun ? "enrollment_queued" : null,
      runId: runId || null,
    });
  } finally {
    if (lockToken) await releaseRunLock(runId, lockToken).catch(() => {});
  }
}
