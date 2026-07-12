import { cors, requireAuth, hasCookie, buildPlan, enrolledElsewhereSet, bookedSet } from "./_lib/core.mjs";

export const config = { maxDuration: 120 }; // full-membership scan can take ~10-30s

export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (!(await requireAuth(req, res))) return;
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  if (!hasCookie()) return res.status(200).json({ ok: false, error: "no_cookie" });
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const { sequenceId, rows = [], sendAs } = body;
    if (!sequenceId || !rows.length) return res.status(400).json({ ok: false, error: "sequenceId and rows required" });
    const plan = await buildPlan({ sequenceId, rows, sendAs });
    // Estimate skips (already in a sequence). Read-only, so we can only check rows we
    // already resolved to a candidate id (CRM-matched). Brand-new applicants that turn
    // out to exist under a different email are caught at enroll time — so this is a
    // lower bound. Reported as an estimate.
    const already = await enrolledElsewhereSet();
    // Booked check only applies to CRM-matched rows (brand-new applicants can't have
    // booked). Enroll re-checks authoritatively after upsert.
    const matchedIds = plan.groups.flatMap((g) => (g.rows || []).filter((r) => r.candidate_user_id).map((r) => r.candidate_user_id));
    const booked = await bookedSet(matchedIds);
    let skipEstimate = 0, bookedEstimate = 0;
    const groups = plan.groups.map((g) => {
      let gs = 0, gb = 0;
      for (const r of (g.rows || [])) {
        if (!r.candidate_user_id) continue;
        if (booked.has(r.candidate_user_id)) { gb++; gs++; }
        else if (already.has(r.candidate_user_id)) gs++;
      }
      skipEstimate += gs; bookedEstimate += gb;
      return {
        role: g.title,
        target: g.targetName,
        willCreateSequence: plan.templated && !g.exists,
        candidates: g.candidateCount,
        alreadyInCrm: g.existingIds.length,
        willCreateInCrm: g.toCreate.length,
        willSkip: gs,
      };
    });
    res.status(200).json({
      ok: true,
      sequence: plan.seq.name,
      templated: plan.templated,
      sendAs: plan.sendAs,
      totalRows: rows.length,
      matched: plan.matchedCount,
      unmatched: plan.unmatchedCount,
      skipEstimate,
      bookedEstimate,
      unmatchedSample: plan.unmatched.slice(0, 20).map((r) => ({ name: `${r.firstName || ""} ${r.lastName || ""}`.trim(), email: r.email })),
      groups,
    });
  } catch (e) {
    const expired = e.code === "AUTH_EXPIRED";
    res.status(200).json({ ok: false, error: expired ? "expired" : "error", detail: String(e.message || e).slice(0, 200) });
  }
}
