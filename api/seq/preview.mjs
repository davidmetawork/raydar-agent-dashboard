import { cors, requireAuth, hasCookie, buildPlan, enrolledElsewhereSet } from "./_lib/core.mjs";

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
    let skipEstimate = 0;
    const groups = plan.groups.map((g) => {
      const gs = (g.rows || []).filter((r) => r.candidate_user_id && already.has(r.candidate_user_id)).length;
      skipEstimate += gs;
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
      unmatchedSample: plan.unmatched.slice(0, 20).map((r) => ({ name: `${r.firstName || ""} ${r.lastName || ""}`.trim(), email: r.email })),
      groups,
    });
  } catch (e) {
    const expired = e.code === "AUTH_EXPIRED";
    res.status(200).json({ ok: false, error: expired ? "expired" : "error", detail: String(e.message || e).slice(0, 200) });
  }
}
