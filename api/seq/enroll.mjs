import { cors, requireAuth, hasCookie, buildPlan, ensureRoleSequence, enrollIntoCampaign, setCandidateEmail, setLeadEmail, ccuIndex, enrolledElsewhereSet, archiveImportSet, createDelayProject, resolveSequenceCandidate } from "./_lib/core.mjs";
// External-booking-aware check: native Raydar and legacy Calendly bookings are
// both protected during the measured overlap window.
import { bookedSetWithSources as bookedSet } from "./_lib/booking-stop.mjs";
import { protectedRecruiterForRole } from "./_lib/protected.mjs";

export const config = { maxDuration: 300 };

// Run Paraform reads and writes with bounded concurrency.
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
    const delayDays = Math.max(0, Math.min(60, parseInt(body.delayDays, 10) || 0));
    if (!sequenceId || !rows.length) return res.status(400).json({ ok: false, error: "sequenceId and rows required" });

    const plan = await buildPlan({ sequenceId, rows, sendAs });

    // ── Delayed mode: resolve existing candidates now and park every unmatched
    // identity for Applicant Hub / identity authority. File resolved identities into
    // dated "⏳SeqDelay" projects and stop. The daily
    // release cron enrolls them on the due date — running the booked/in-sequence
    // checks THEN, so people who book during the window are never messaged.
    if (delayDays > 0) {
      const due = new Date(Date.now() + delayDays * 86400e3).toISOString().slice(0, 10);
      let scheduledTotal = 0, failedTotal = 0;
      const createFailures = [], parkedIdentitySample = [], scheduled = [], protectedBlocked = [];
      let parkedIdentityTotal = 0;
      for (const g of plan.groups) {
        // GUARDRAIL: never enroll a protected recruiter's role (e.g. Kyra's).
        const prot = protectedRecruiterForRole({ roleTitle: g.title });
        if (prot) { protectedBlocked.push({ role: g.title, recruiter: prot.displayName, candidates: (g.rows || []).length }); continue; }
        const resolved = await mapPool(
          g.rows || [],
          4,
          (row) => resolveSequenceCandidate(row),
        );
        const archiveImports = await archiveImportSet(
          resolved.filter((r) => r.ok && !r.isNew).map((r) => r.cu),
        );
        const good = resolved.filter((r) => r.ok && !archiveImports.has(r.cu));
        failedTotal += archiveImports.size;
        for (const r of resolved) {
          if (r.ok) continue;
          if (r.parkedIdentity) {
            parkedIdentityTotal++;
            if (parkedIdentitySample.length < 50) {
              parkedIdentitySample.push({ email: r.email, role: g.title, reason: r.reason });
            }
            continue;
          }
          failedTotal++;
          createFailures.push({ email: r.email, reason: r.reason });
        }
        await mapPool(good, 4, (k) => setCandidateEmail(k.cu, k.email));
        if (!good.length) { scheduled.push({ role: g.title, target: g.targetName, scheduled: 0, note: "no valid candidates" }); continue; }
        const nameArgs = plan.templated
          ? { dueDate: due, sendAs: plan.sendAs, kind: "TPL", key: g.title }
          : { dueDate: due, sendAs: plan.sendAs, kind: "SEQ", key: g.targetId, label: g.targetName };
        await createDelayProject(nameArgs, good.map((r) => r.cu));
        scheduledTotal += good.length;
        scheduled.push({ role: g.title, target: g.targetName, scheduled: good.length, dueDate: due });
      }
      return res.status(200).json({
        ok: true, delayed: true, dueDate: due, sequence: plan.seq.name, sendAs: plan.sendAs,
        scheduledTotal, failedTotal, createFailures: createFailures.slice(0, 50),
        parkedIdentityTotal, parkedIdentitySample,
        protectedBlocked, groups: scheduled, ranAt: new Date().toISOString(),
      });
    }

    // Who is already in ANY of the recruiter's sequences -> skip them (don't re-message;
    // also makes a re-run a no-op). One scan up front, shared across all groups.
    const already = await enrolledElsewhereSet();

    const results = [];
    let failedTotal = 0, skippedTotal = 0, skippedBookedTotal = 0, skippedArchiveTotal = 0;
    const createFailures = [], parkedIdentitySample = [], skippedSample = [], protectedBlocked = [];
    let parkedIdentityTotal = 0;
    for (const g of plan.groups) {
      // GUARDRAIL: never enroll a protected recruiter's role (e.g. Kyra's).
      const prot = protectedRecruiterForRole({ roleTitle: g.title });
      if (prot) { protectedBlocked.push({ role: g.title, recruiter: prot.displayName, candidates: (g.rows || []).length }); continue; }
      try {
        // 1) Resolve each row to a candidate_user_id. Unmatched identities always park
        //    for Applicant Hub / identity authority. Track isNew so we only
        //    booked-check pre-existing people.
        const resolved = await mapPool(
          g.rows || [],
          4,
          (row) => resolveSequenceCandidate(row),
        );

        // 1b) Booked check — only pre-existing candidates can have booked a call, so
        //     only they hit getCandidateProfileInfo (fast for fresh LinkedIn cohorts).
        const preexisting = resolved.filter((r) => r.ok && !r.isNew).map((r) => r.cu);
        const [booked, archiveImports] = await Promise.all([
          bookedSet(preexisting),
          archiveImportSet(preexisting),
        ]);

        // 2) Split into skip / keep, tally reasons.
        const keep = []; // {cu,email}
        let groupSkipped = 0;
        for (const r of resolved) {
          if (!r.ok) {
            if (r.parkedIdentity) {
              parkedIdentityTotal++;
              if (parkedIdentitySample.length < 50) {
                parkedIdentitySample.push({ email: r.email, role: g.title, reason: r.reason });
              }
            } else {
              failedTotal++;
              createFailures.push({ email: r.email, reason: r.reason });
            }
            continue;
          }
          if (archiveImports.has(r.cu)) { skippedArchiveTotal++; groupSkipped++; if (skippedSample.length < 50) skippedSample.push({ email: r.email, role: g.title, reason: "historical archive import" }); continue; }
          if (booked.has(r.cu)) { skippedBookedTotal++; groupSkipped++; if (skippedSample.length < 50) skippedSample.push({ email: r.email, role: g.title, reason: "already booked a call" }); continue; }
          if (already.has(r.cu)) { skippedTotal++; groupSkipped++; if (skippedSample.length < 50) skippedSample.push({ email: r.email, role: g.title, reason: "already in another sequence" }); continue; }
          keep.push({ cu: r.cu, email: r.email });
        }

        if (!keep.length) {
          results.push({ role: g.title, target: g.targetName, enrolled: 0, skipped: groupSkipped, note: "nobody new to enroll" });
          continue;
        }

        // 3) Set the resolved candidates' email from the CSV BEFORE enrolling.
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

        results.push({ role: g.title, target: g.targetName, targetId, createdSequence, enrolled: r.enrolled, skipped: groupSkipped });
      } catch (e) {
        results.push({ role: g.title, target: g.targetName, error: String(e.message || e).slice(0, 160) });
      }
    }
    const enrolledTotal = results.reduce((n, r) => n + (r.enrolled || 0), 0);
    res.status(200).json({
      ok: true, sequence: plan.seq.name, sendAs: plan.sendAs,
      enrolledTotal, createdTotal: 0, failedTotal,
      skippedTotal: skippedTotal + skippedBookedTotal + skippedArchiveTotal, skippedInSequence: skippedTotal, skippedBookedTotal, skippedArchiveTotal,
      createFailures: createFailures.slice(0, 50),
      parkedIdentityTotal, parkedIdentitySample,
      skippedSample, protectedBlocked,
      groups: results, ranAt: new Date().toISOString(),
    });
  } catch (e) {
    const expired = e.code === "AUTH_EXPIRED";
    res.status(200).json({ ok: false, error: expired ? "expired" : "error", detail: String(e.message || e).slice(0, 200) });
  }
}
