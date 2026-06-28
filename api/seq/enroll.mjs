import { cors, requireAuth, hasCookie, buildPlan, ensureRoleSequence, enrollIntoCampaign } from "./_lib/core.mjs";

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
    const results = [];
    for (const g of plan.groups) {
      try {
        let targetId = g.targetId;
        let createdSequence = false;
        if (plan.templated) {
          const ensured = await ensureRoleSequence(g.title, plan.sendAs, plan.seqs);
          targetId = ensured.id; createdSequence = ensured.created;
        }
        const r = await enrollIntoCampaign(targetId, g.candidate_user_ids);
        results.push({ role: g.title, target: g.targetName, targetId, createdSequence, enrolled: r.enrolled });
      } catch (e) {
        results.push({ role: g.title, target: g.targetName, error: String(e.message || e).slice(0, 160) });
      }
    }
    const enrolledTotal = results.reduce((n, r) => n + (r.enrolled || 0), 0);
    res.status(200).json({
      ok: true, sequence: plan.seq.name, sendAs: plan.sendAs,
      enrolledTotal, unmatched: plan.unmatchedCount,
      unmatchedSample: plan.unmatched.slice(0, 50).map((r) => ({ name: `${r.firstName || ""} ${r.lastName || ""}`.trim(), email: r.email, linkedin: r.linkedinUrl })),
      groups: results, ranAt: new Date().toISOString(),
    });
  } catch (e) {
    const expired = e.code === "AUTH_EXPIRED";
    res.status(200).json({ ok: false, error: expired ? "expired" : "error", detail: String(e.message || e).slice(0, 200) });
  }
}
