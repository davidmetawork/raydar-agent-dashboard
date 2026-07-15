import { cors, requireSourcingAccess, trpcPost } from "./_lib/core.mjs";
import { getRun, saveRun, storeConfigured } from "./_lib/store.mjs";
import { bookedSet, ccuIndex, enrolledElsewhereSet } from "../seq/_lib/core.mjs";
import { transitionCandidate } from "../../sourcing-domain.mjs";

export const config = { maxDuration: 300 };

function throughEnrollment(candidate, finalState, evidence) {
  let next = candidate;
  if (next.state === "good") next = transitionCandidate(next, "project_queued", evidence);
  if (next.state === "project_queued") next = transitionCandidate(next, "project_filed", evidence);
  if (next.state === "project_filed") next = transitionCandidate(next, "enrollment_queued", evidence);
  return transitionCandidate(next, finalState, evidence);
}

export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "POST only" });
  if (!storeConfigured()) return res.status(503).json({ ok: false, error: "state_store_not_configured" });
  if (!(await requireSourcingAccess(req, res, "sequence"))) return;
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const run = await getRun(String(body.runId || ""));
    if (!run) return res.status(404).json({ ok: false, error: "run_not_found" });
    if (Number(body.expectedRevision) !== Number(run.revision)) return res.status(409).json({ ok: false, error: "revision_conflict" });
    const selected = new Set(Array.isArray(body.candidateIds) ? body.candidateIds.map(String) : []);
    const candidates = run.candidates.filter((candidate) => selected.has(candidate.id));
    if (!candidates.length) return res.status(400).json({ ok: false, error: "select_good_candidates" });
    if (String(body.confirmation || "") !== `ENROLL ${candidates.length}`) {
      return res.status(400).json({ ok: false, error: "confirmation_mismatch", expected: `ENROLL ${candidates.length}` });
    }
    if (!run.mapping?.sequenceId) return res.status(409).json({ ok: false, error: "sequence_mapping_required" });
    if (candidates.some((candidate) => candidate.state !== "good" || candidate.projectStatus !== "filed" || !candidate.candidateUserId)) {
      return res.status(409).json({ ok: false, error: "only_project_filed_good_candidates_can_enroll" });
    }
    const ids = candidates.map((candidate) => candidate.candidateUserId);
    const [already, booked] = await Promise.all([enrolledElsewhereSet(), bookedSet(ids)]);
    const preblocked = new Map();
    for (const candidate of candidates) {
      if (booked.has(candidate.candidateUserId)) preblocked.set(candidate.id, "booked_or_later");
      else if (already.has(candidate.candidateUserId)) preblocked.set(candidate.id, "already_in_sequence");
    }
    const keep = candidates.filter((candidate) => !preblocked.has(candidate.id));
    let vendorBlocked = new Map();
    if (keep.length) {
      const response = await trpcPost("campaigns.addToCampaigns", {
        campaign_ids: [run.mapping.sequenceId],
        candidate_user_ids: keep.map((candidate) => candidate.candidateUserId),
        source: "SOURCING",
      });
      vendorBlocked = new Map((response?.blocked_candidates || []).map((item) => [item.candidate_user_id, item.company_name || "blocked_company"]));
    }
    const membership = await ccuIndex(run.mapping.sequenceId);
    const at = new Date().toISOString();
    const updated = run.candidates.map((candidate) => {
      if (!selected.has(candidate.id)) return candidate;
      const reason = preblocked.get(candidate.id) || vendorBlocked.get(candidate.candidateUserId);
      if (reason) return { ...throughEnrollment(candidate, "enrollment_blocked", { source: "sourcing-enroll", at, reason }), enrollmentStatus: "blocked", enrollmentReason: reason };
      if (!membership.has(candidate.candidateUserId)) return { ...throughEnrollment(candidate, "enrollment_blocked", { source: "sourcing-enroll", at, reason: "membership_readback_failed" }), enrollmentStatus: "blocked", enrollmentReason: "membership_readback_failed" };
      return { ...throughEnrollment(candidate, "enrolled", { source: "sourcing-enroll", at }), enrollmentStatus: "enrolled", enrolledAt: at, sequenceId: run.mapping.sequenceId };
    });
    const saved = await saveRun({ ...run, candidates: updated }, run.revision);
    const enrolled = updated.filter((candidate) => selected.has(candidate.id) && candidate.state === "enrolled").length;
    return res.status(200).json({ ok: true, run: saved, enrolled, blocked: candidates.length - enrolled });
  } catch (error) {
    return res.status(400).json({ ok: false, error: "enrollment_failed", detail: String(error?.message || error).slice(0, 220) });
  }
}
