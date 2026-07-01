import { cors, requireAuth, hasCookie, buildPlan, ensureRoleSequence, enrollIntoCampaign, createCandidate, addToProject } from "./_lib/core.mjs";

export const config = { maxDuration: 300 };

// Run fn over items with bounded concurrency (CrustData enrichment can be slow;
// 26 sequential creates would risk the function timeout).
async function mapPool(items, limit, fn) {
  const out = new Array(items.length);
  let idx = 0;
  const worker = async () => {
    while (true) { const i = idx++; if (i >= items.length) break; out[i] = await fn(items[i], i); }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length || 1) }, worker));
  return out;
}

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
    let createdTotal = 0, failedTotal = 0;
    const createFailures = [];
    for (const g of plan.groups) {
      try {
        // 1) Create/upsert the not-yet-in-CRM applicants from their LinkedIn URL.
        //    Idempotent by URL, so re-runs return the existing id (no duplicates).
        const createResults = await mapPool(g.toCreate || [], 4, async (row) => {
          const url = (row.linkedinUrl || "").trim();
          if (!url) return { ok: false, email: row.email, reason: "no LinkedIn URL" };
          try {
            const { id } = await createCandidate(url);
            return id ? { ok: true, id } : { ok: false, email: row.email, reason: "no id returned" };
          } catch (e) {
            return { ok: false, email: row.email, reason: String(e.message || e).slice(0, 120) };
          }
        });
        const createdIds = [];
        for (const cr of createResults) {
          if (cr.ok) { createdIds.push(cr.id); createdTotal++; }
          else { failedTotal++; createFailures.push({ email: cr.email, reason: cr.reason }); }
        }
        // 2) Best-effort: file the new candidates under "LinkedIn Job Applicants".
        if (createdIds.length) { try { await addToProject(createdIds); } catch { /* non-fatal */ } }

        // 3) Enroll everyone in this role: those already in CRM + the ones we just created.
        const ids = [...new Set([...g.existingIds, ...createdIds])];
        if (!ids.length) {
          results.push({ role: g.title, target: g.targetName, enrolled: 0, created: createdIds.length, note: "no enrollable candidates" });
          continue;
        }
        let targetId = g.targetId;
        let createdSequence = false;
        if (plan.templated) {
          const ensured = await ensureRoleSequence(g.title, plan.sendAs, plan.seqs);
          targetId = ensured.id; createdSequence = ensured.created;
        }
        const r = await enrollIntoCampaign(targetId, ids);
        results.push({ role: g.title, target: g.targetName, targetId, createdSequence, created: createdIds.length, enrolled: r.enrolled });
      } catch (e) {
        results.push({ role: g.title, target: g.targetName, error: String(e.message || e).slice(0, 160) });
      }
    }
    const enrolledTotal = results.reduce((n, r) => n + (r.enrolled || 0), 0);
    res.status(200).json({
      ok: true, sequence: plan.seq.name, sendAs: plan.sendAs,
      enrolledTotal, createdTotal, failedTotal,
      createFailures: createFailures.slice(0, 50),
      groups: results, ranAt: new Date().toISOString(),
    });
  } catch (e) {
    const expired = e.code === "AUTH_EXPIRED";
    res.status(200).json({ ok: false, error: expired ? "expired" : "error", detail: String(e.message || e).slice(0, 200) });
  }
}
