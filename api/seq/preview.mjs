import { cors, requireAuth, hasCookie, buildPlan } from "./_lib/core.mjs";

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
    res.status(200).json({
      ok: true,
      sequence: plan.seq.name,
      templated: plan.templated,
      sendAs: plan.sendAs,
      totalRows: rows.length,
      matched: plan.matchedCount,
      unmatched: plan.unmatchedCount,
      unmatchedSample: plan.unmatched.slice(0, 20).map((r) => ({ name: `${r.firstName || ""} ${r.lastName || ""}`.trim(), email: r.email })),
      groups: plan.groups.map((g) => ({ role: g.title, target: g.targetName, willCreateSequence: plan.templated && !g.exists, candidates: g.candidate_user_ids.length })),
    });
  } catch (e) {
    const expired = e.code === "AUTH_EXPIRED";
    res.status(200).json({ ok: false, error: expired ? "expired" : "error", detail: String(e.message || e).slice(0, 200) });
  }
}
