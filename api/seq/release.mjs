// Release due "⏳SeqDelay" cohorts: runs daily via Vercel cron (see vercel.json), or
// manually. ?list=1 just returns pending cohorts (used by the Sequences page).
// For each due project: members -> booked/in-sequence checks (run NOW, at release —
// the whole point of the delay) -> ensure role sequence (TPL) or target (SEQ) ->
// enroll the clean ones -> backfill lead emails -> delete the delay project.
import { cors, requireAuth, hasCookie, listDelayProjects, projectMembers, deleteDelayProject, ensureRoleSequence, enrollIntoCampaign, enrolledElsewhereSet, bookedSet, archiveImportSet, setLeadEmail, ccuIndex, trpcGet } from "./_lib/core.mjs";
import { protectedRecruiterForRoleTitle } from "./_lib/protected.mjs";

export const config = { maxDuration: 300 };

function isCron(req) {
  if (req.headers["x-vercel-cron"]) return true; // set by Vercel's cron invoker
  const secret = process.env.CRON_SECRET;
  if (secret && (req.headers["authorization"] || "") === `Bearer ${secret}`) return true;
  return false;
}

export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (!isCron(req) && !(await requireAuth(req, res))) return;
  if (!hasCookie()) return res.status(200).json({ ok: false, error: "no_cookie" });
  try {
    const url = new URL(req.url, "http://x");
    const pending = await listDelayProjects();
    const today = new Date().toISOString().slice(0, 10);

    if (url.searchParams.get("list")) {
      const withCounts = [];
      for (const p of pending) {
        const m = await projectMembers(p.projectId);
        withCounts.push({ dueDate: p.dueDate, sendAs: p.sendAs, kind: p.kind, label: p.label, candidates: m.length, due: p.dueDate <= today });
      }
      return res.status(200).json({ ok: true, pending: withCounts.sort((a, b) => a.dueDate.localeCompare(b.dueDate)) });
    }

    const due = pending.filter((p) => p.dueDate <= today);
    if (!due.length) return res.status(200).json({ ok: true, released: 0, pending: pending.length, note: "nothing due" });

    const already = await enrolledElsewhereSet();
    const results = [];
    for (const p of due) {
      // GUARDRAIL: never release a protected recruiter's delayed cohort (e.g.
      // Kyra's). Remove the wrongful cohort so it can't email anyone.
      const prot = protectedRecruiterForRoleTitle(p.key) || protectedRecruiterForRoleTitle(p.label);
      if (prot) {
        await deleteDelayProject(p.projectId).catch(() => {});
        results.push({ label: p.label, enrolled: 0, protectedBlocked: true, recruiter: prot.displayName, note: "protected recruiter — cohort removed, not enrolled" });
        continue;
      }
      try {
        const members = await projectMembers(p.projectId);
        if (!members.length) { await deleteDelayProject(p.projectId); results.push({ label: p.label, enrolled: 0, note: "empty — removed" }); continue; }
        const [booked, archiveImports] = await Promise.all([
          bookedSet(members.map((m) => m.id)),
          archiveImportSet(members.map((m) => m.id)),
        ]);
        const keep = members.filter((m) =>
          !archiveImports.has(m.id)
          && !booked.has(m.id)
          && !already.has(m.id));
        const skippedArchive = members.filter((m) =>
          archiveImports.has(m.id)).length;
        const skippedBooked = members.filter((m) =>
          !archiveImports.has(m.id) && booked.has(m.id)).length;
        const skippedInSeq = members.filter((m) =>
          !archiveImports.has(m.id)
          && !booked.has(m.id)
          && already.has(m.id)).length;

        let targetId = null;
        if (p.kind === "TPL") {
          const ensured = await ensureRoleSequence(p.key, p.sendAs, null);
          targetId = ensured.id;
        } else {
          // verify the target sequence still exists
          const seqs = (await trpcGet("campaigns.getListOfCampaignsOptimized", {})) || [];
          if (!seqs.some((s) => s.id === p.key)) { results.push({ label: p.label, error: "target sequence no longer exists — left scheduled" }); continue; }
          targetId = p.key;
        }
        let enrolled = 0;
        if (keep.length) {
          const r = await enrollIntoCampaign(targetId, keep.map((m) => m.id));
          enrolled = r.enrolled;
          keep.forEach((m) => already.add(m.id)); // a later due project shouldn't double-enroll
          try {
            const idx = await ccuIndex(targetId);
            for (const m of keep) { const hit = idx.get(m.id); if (hit && !hit.email && m.email) await setLeadEmail(hit.ccuId, m.email); }
          } catch { /* non-fatal */ }
        }
        await deleteDelayProject(p.projectId);
        results.push({ label: p.label, dueDate: p.dueDate, enrolled, skippedArchive, skippedBooked, skippedInSeq });
      } catch (e) {
        // leave the project in place — next daily run retries
        results.push({ label: p.label, error: String(e.message || e).slice(0, 160) });
      }
    }
    res.status(200).json({ ok: true, released: results.length, results, ranAt: new Date().toISOString() });
  } catch (e) {
    const expired = e.code === "AUTH_EXPIRED";
    res.status(200).json({ ok: false, error: expired ? "expired" : "error", detail: String(e.message || e).slice(0, 200) });
  }
}
