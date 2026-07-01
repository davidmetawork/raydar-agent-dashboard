import { cors, requireAuth, hasCookie, buildPlan, ensureRoleSequence, enrollIntoCampaign, createCandidate, addToProject, setCandidateEmail, setLeadEmail, ccuIndex, enrolledElsewhereSet } from "./_lib/core.mjs";

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
    // Who is already in ANY of the recruiter's sequences -> skip them (don't re-message;
    // also makes a re-run a no-op). One scan up front, shared across all groups.
    const already = await enrolledElsewhereSet();

    const results = [];
    let createdTotal = 0, failedTotal = 0, skippedTotal = 0;
    const createFailures = [], skippedSample = [];
    for (const g of plan.groups) {
      try {
        // 1) Resolve each row to a candidate_user_id (create-from-LinkedIn if new;
        //    idempotent by URL). Keep the CSV email alongside for the email fix.
        const resolved = await mapPool(g.rows || [], 4, async (row) => {
          if (row.candidate_user_id) return { ok: true, cu: row.candidate_user_id, email: row.email };
          const url = (row.linkedinUrl || "").trim();
          if (!url) return { ok: false, email: row.email, reason: "no LinkedIn URL" };
          try {
            const { id } = await createCandidate(url);
            return id ? { ok: true, cu: id, email: row.email, created: true } : { ok: false, email: row.email, reason: "no id returned" };
          } catch (e) {
            return { ok: false, email: row.email, reason: String(e.message || e).slice(0, 120) };
          }
        });

        // 2) Split into skip (already in a sequence) / keep, tally create failures.
        const keep = []; // {cu,email}
        const createdIds = [];
        for (const r of resolved) {
          if (!r.ok) { failedTotal++; createFailures.push({ email: r.email, reason: r.reason }); continue; }
          if (already.has(r.cu)) { skippedTotal++; if (skippedSample.length < 50) skippedSample.push({ email: r.email, role: g.title }); continue; }
          keep.push({ cu: r.cu, email: r.email });
          if (r.created) createdIds.push(r.cu);
        }
        if (createdIds.length) createdTotal += createdIds.length;

        if (!keep.length) {
          results.push({ role: g.title, target: g.targetName, enrolled: 0, created: createdIds.length, skipped: resolved.filter((r) => r.ok && already.has(r.cu)).length, note: "nobody new to enroll" });
          continue;
        }

        // 3) File new candidates + set their email from the CSV BEFORE enrolling.
        if (createdIds.length) { try { await addToProject(createdIds); } catch { /* non-fatal */ } }
        await mapPool(keep, 4, (k) => setCandidateEmail(k.cu, k.email));

        // 4) Ensure the role sequence, enroll the keepers.
        let targetId = g.targetId;
        let createdSequence = false;
        if (plan.templated) {
          const ensured = await ensureRoleSequence(g.title, plan.sendAs, plan.seqs);
          targetId = ensured.id; createdSequence = ensured.created;
        }
        const r = await enrollIntoCampaign(targetId, keep.map((k) => k.cu));

        // 5) Set each lead's send-to email from the CSV where enrichment left it blank.
        try {
          const idx = await ccuIndex(targetId);
          await mapPool(keep, 4, async (k) => {
            const hit = idx.get(k.cu);
            if (hit && !hit.email && k.email) await setLeadEmail(hit.ccuId, k.email);
          });
        } catch { /* non-fatal */ }

        const groupSkipped = resolved.filter((x) => x.ok && already.has(x.cu)).length;
        results.push({ role: g.title, target: g.targetName, targetId, createdSequence, created: createdIds.length, enrolled: r.enrolled, skipped: groupSkipped });
      } catch (e) {
        results.push({ role: g.title, target: g.targetName, error: String(e.message || e).slice(0, 160) });
      }
    }
    const enrolledTotal = results.reduce((n, r) => n + (r.enrolled || 0), 0);
    res.status(200).json({
      ok: true, sequence: plan.seq.name, sendAs: plan.sendAs,
      enrolledTotal, createdTotal, failedTotal, skippedTotal,
      createFailures: createFailures.slice(0, 50),
      skippedSample,
      groups: results, ranAt: new Date().toISOString(),
    });
  } catch (e) {
    const expired = e.code === "AUTH_EXPIRED";
    res.status(200).json({ ok: false, error: expired ? "expired" : "error", detail: String(e.message || e).slice(0, 200) });
  }
}
