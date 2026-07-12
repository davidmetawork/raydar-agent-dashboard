// GET /api/roster/source?name=<candidate full name>
// Candidate-source auto-detection for the Candidates tab: looks the candidate
// up in the Paraform CRM and reports whether they carry the "Connector
// Referral" tag. Read-only against Paraform; the UI persists the answer via
// the webview's /api/roster-note so this lookup runs at most once per row.
//
// Response: { ok, name, source: "Connector"|null, matched: bool, candidateUserId }
//   source "Connector"  → tag found
//   source null + matched → candidate exists but no tag (UI leaves source blank
//                            for David to set: Job Post vs Outreach isn't
//                            derivable from the CRM)
//   matched false        → no CRM candidate by that name (unknown)
import { cors, requireAuth, hasCookie, trpcGet } from "../seq/_lib/core.mjs";

export const config = { maxDuration: 30 };

export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (!(await requireAuth(req, res))) return;
  const name = String(req.query?.name || "").trim();
  if (!name || name.length < 2) return res.status(400).json({ ok: false, error: "name required" });
  if (!hasCookie()) return res.status(200).json({ ok: false, error: "no_cookie", source: null, matched: false });

  try {
    // MANDATORY sort shape — the CRM list silently ignores malformed sorts and
    // returns added_at order (a past bug class); updated_at keeps recent people
    // on page 1 so a single page is enough for a name lookup.
    const out = await trpcGet("candidateUser.getCRMExternalCandidates", {
      page: 1, page_size: 25,
      filters: { search: name, sort: { field: "updated_at", direction: "desc" } },
    });
    const list = out?.external_candidates || out?.candidates || [];
    const norm = (s) => String(s || "").trim().toLowerCase().replace(/\s+/g, " ");
    const hit = list.find((c) => norm(c.name || c.full_name || c.candidate_name) === norm(name)) || list[0] || null;
    if (!hit) return res.status(200).json({ ok: true, name, matched: false, source: null });

    const tags = (hit.tags || hit.candidate_tags || []).map((t) => String(t?.name ?? t).toLowerCase());
    const isConnector = tags.some((t) => t.includes("connector"));
    return res.status(200).json({
      ok: true, name, matched: true,
      source: isConnector ? "Connector" : null,
      candidateUserId: hit.candidate_user_id || hit.id || null,
      tags: tags.slice(0, 10),
    });
  } catch (e) {
    const msg = String(e?.message || e);
    const auth = /401|AUTH_EXPIRED/i.test(msg);
    return res.status(auth ? 503 : 500).json({ ok: false, error: auth ? "AUTH_EXPIRED" : msg.slice(0, 150) });
  }
}
