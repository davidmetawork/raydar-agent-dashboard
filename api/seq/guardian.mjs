// PROTECTED-RECRUITER GUARDIAN — the continuous safety net behind the standing
// rule that Raydar never messages certain recruiters' candidates (e.g. Kyra
// Wyman's). Runs on a Vercel cron (see vercel.json) and can be invoked manually.
//
// For every live sequence whose role belongs to a protected recruiter
// (api/seq/_lib/protected.mjs) it: disables the sequence and pauses every
// unpaused lead — reversible (enabled:true / is_paused:false to undo). This is
// what would have caught the 2026-07-20 "Corporate Counsel" incident within the
// hour instead of relying on a human noticing sent mail. Enrollment-time
// refusal (enroll.mjs / release.mjs) is the primary prevention; this is the net.
import { cors, requireAuth, hasCookie, trpcGet, trpcPost, campaignLeads } from "./_lib/core.mjs";
import { protectedRecruiterForSequence } from "./_lib/protected.mjs";
import { notifySlack } from "../paraai/_lib/core.mjs";

export const config = { maxDuration: 120 };

function isCron(req) {
  if (req.headers["x-vercel-cron"]) return true;
  const secret = process.env.CRON_SECRET;
  if (secret && (req.headers["authorization"] || "") === `Bearer ${secret}`) return true;
  return false;
}

export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (!isCron(req) && !(await requireAuth(req, res))) return;
  if (!hasCookie()) return res.status(200).json({ ok: false, error: "no_cookie" });
  const apply = new URL(req.url, "http://x").searchParams.get("dry") !== "1";
  try {
    const seqs = (await trpcGet("campaigns.getListOfCampaignsOptimized", {})) || [];
    const flagged = seqs
      .map((s) => ({ seq: s, prot: protectedRecruiterForSequence(s) }))
      .filter((x) => x.prot);

    const actions = [];
    for (const { seq, prot } of flagged) {
      const leads = await campaignLeads(seq.id).catch(() => []);
      const unpaused = leads.filter((l) => !l.is_paused && l.ccu_id);
      const wasEnabled = seq.enabled !== false;
      if (!wasEnabled && unpaused.length === 0) continue; // already contained

      if (apply) {
        if (wasEnabled) {
          await trpcPost("campaigns.bulkSetSequencesEnabled", { sequence_ids: [seq.id], enabled: false }, 1).catch(() => {});
          await trpcPost("campaigns.updateSequence", { sequence_id: seq.id, name: seq.name, enabled: false }, 1).catch(() => {});
        }
        for (const l of unpaused) {
          await trpcPost("campaigns.updateCandidatePauseStatus", { campaign_to_candidate_user_id: l.ccu_id, is_paused: true }, 1).catch(() => {});
        }
      }
      actions.push({ sequenceId: seq.id, name: seq.name, recruiter: prot.displayName, disabled: wasEnabled, pausedLeads: unpaused.length, totalLeads: leads.length });
    }

    // Actionable alert only — a protected sequence that was live/sending is a
    // process failure the team should know about; a fully-contained state is silent.
    if (apply && actions.length) {
      const lines = actions.map((a) => `• ${a.name} — ${a.recruiter} (${a.disabled ? "disabled" : "already off"}, paused ${a.pausedLeads}/${a.totalLeads})`);
      await notifySlack(`🛑 Protected-recruiter guardian stopped ${actions.length} sequence(s):\n${lines.join("\n")}`).catch(() => {});
    }
    return res.status(200).json({ ok: true, apply, flagged: flagged.length, acted: actions.length, actions, ranAt: new Date().toISOString() });
  } catch (e) {
    const expired = e.code === "AUTH_EXPIRED";
    return res.status(200).json({ ok: false, error: expired ? "expired" : "error", detail: String(e.message || e).slice(0, 200) });
  }
}
