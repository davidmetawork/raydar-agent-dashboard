// GET /api/roster/source?name=<candidate full name>
// Candidate-source auto-detection for the Candidates tab: finds the candidate
// in the Paraform CRM by exact name match and reports the evidence needed to
// pick a Source. Read-only; the UI persists the answer via the webview's
// /api/roster-note so this runs at most once per row.
//
// DETECTION (validated 2026-07-12 against 281 David-labeled roster rows,
// 98.6% agreement):
//   • source_info === "CONNECTOR_REFERRAL" (Paraform system-stamped entry)
//     → Connector. Primary signal — more precise than the tag (one live case
//     of a connector tag on a MANUAL record contradicting David's label).
//   • "connector" tag → Connector (playbook rule: the system tag wins).
//   • Everything else → source: null. The response also carries `si`
//     (source_info) so callers can corroborate a booking-form "Neither"
//     answer: si === "SOURCING" backs Outreach. The full rule set (calendar
//     self-report + these overrides) runs in the hourly interview-sheet
//     mirror agent; this endpoint is the CRM half.
//
// The scan must be DEEP: sequence sends churn updated_at on thousands of CRM
// rows, so even recently-active candidates sit 2000–4000 deep (measured live
// 2026-07-12: Han Kim @2108, Johnny Creciun @3668). Paraform has NO
// server-side candidate search (every search param is silently stripped), so
// we page 6×1000 rows (~12s cold) and cache in module memory ~10 min.
import { cors, requireAuth, hasCookie, CONFIG, headers, BASE } from "../seq/_lib/core.mjs";

export const config = { maxDuration: 60 };

let cache = { at: 0, byName: null };
const TTL = 10 * 60 * 1000;
const norm = (s) => String(s || "").trim().toLowerCase().replace(/\s+/g, " ");

async function crmByName() {
  const now = Date.now();
  if (cache.byName && now - cache.at < TTL) return cache.byName;
  const byName = {};
  let cursor = 0;
  for (let page = 0; page < 6; page++) {
    const input = {
      cursor, limit: 1000,
      filters: { recruiters: [CONFIG.RECRUITER_ID], agency_id: CONFIG.AGENCY_ID, sort: { field: "updated_at", direction: "desc" } },
      project_id: null, role_specific_id: null,
    };
    const url = `${BASE}/trpc/candidateUser.getCRMExternalCandidates?input=` +
      encodeURIComponent(JSON.stringify({ json: input, meta: { values: { project_id: ["undefined"], role_specific_id: ["undefined"] }, v: 1 } }));
    const r = await fetch(url, { headers: headers(), signal: AbortSignal.timeout(25000) });
    if (r.status === 401) { const e = new Error("AUTH_EXPIRED"); e.code = "AUTH_EXPIRED"; throw e; }
    const j = (await r.json())?.result?.data?.json || {};
    const items = j.items || [];
    for (const it of items) {
      const n = norm(it.name);
      if (!byName[n]) byName[n] = { id: it.id, si: it.source_info || null, tags: (it.tags || []).map((t) => String(t?.name ?? t).toLowerCase()) };
      else byName[n].dup = true; // homonym — callers must not trust a name-keyed answer
    }
    if (!items.length || j.next_cursor == null) break;
    cursor = j.next_cursor;
  }
  cache = { at: now, byName };
  return byName;
}

export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (!(await requireAuth(req, res))) return;
  const name = String(req.query?.name || "").trim();
  if (!name || name.length < 2) return res.status(400).json({ ok: false, error: "name required" });
  if (!hasCookie()) return res.status(200).json({ ok: false, error: "no_cookie", source: null, matched: false });

  try {
    const byName = await crmByName();
    const hit = byName[norm(name)];
    if (!hit) return res.status(200).json({ ok: true, name, matched: false, source: null, si: null, scanned: Object.keys(byName).length });
    if (hit.dup) return res.status(200).json({ ok: true, name, matched: true, ambiguous: true, source: null, si: null });

    const isConnector = hit.si === "CONNECTOR_REFERRAL" || (hit.tags || []).some((t) => t.includes("connector"));
    return res.status(200).json({
      ok: true, name, matched: true,
      source: isConnector ? "Connector" : null,
      si: hit.si, candidateUserId: hit.id, tags: (hit.tags || []).slice(0, 10),
    });
  } catch (e) {
    const msg = String(e?.message || e);
    const auth = e?.code === "AUTH_EXPIRED" || /401/.test(msg);
    return res.status(auth ? 503 : 500).json({ ok: false, error: auth ? "AUTH_EXPIRED" : msg.slice(0, 150) });
  }
}
