// GET /api/roster/source?name=<candidate full name>
// Candidate-source auto-detection for the Candidates tab: finds the candidate
// in the Paraform CRM by exact name match and reports whether they carry the
// "Connector Referral" tag. Read-only; the UI persists the answer via the
// webview's /api/roster-note so this runs at most once per row.
//
// Input shape is the PROVEN one from projectEmailIndex (core.mjs) — the CRM
// list silently strips unknown fields (page/search/direction were all wrong
// guesses), so we fetch the 250 most-recently-updated CRM candidates with the
// exact documented filter shape and match by name locally. The list is cached
// in module memory ~10 min (serverless instance lifetime permitting).
import { cors, requireAuth, hasCookie, CONFIG, headers, BASE } from "../seq/_lib/core.mjs";

export const config = { maxDuration: 30 };

let cache = { at: 0, items: null };
const TTL = 10 * 60 * 1000;

async function crmItems() {
  const now = Date.now();
  if (cache.items && now - cache.at < TTL) return cache.items;
  const input = {
    cursor: 0, limit: 250,
    filters: { recruiters: [CONFIG.RECRUITER_ID], agency_id: CONFIG.AGENCY_ID, sort: { field: "updated_at", order: "desc" } },
    project_id: null, role_specific_id: null,
  };
  const url = `${BASE}/trpc/candidateUser.getCRMExternalCandidates?input=` +
    encodeURIComponent(JSON.stringify({ json: input, meta: { values: { project_id: ["undefined"], role_specific_id: ["undefined"] }, v: 1 } }));
  const r = await fetch(url, { headers: headers(), signal: AbortSignal.timeout(20000) });
  if (r.status === 401) { const e = new Error("AUTH_EXPIRED"); e.code = "AUTH_EXPIRED"; throw e; }
  const items = (await r.json())?.result?.data?.json?.items || [];
  cache = { at: now, items };
  return items;
}

async function tagsForCandidate(id) {
  // list items may not embed tags — fetch the candidate record for them
  const url = `${BASE}/trpc/candidateUser.getCandidateUserById?input=` +
    encodeURIComponent(JSON.stringify({ json: { candidate_user_id: id } }));
  const r = await fetch(url, { headers: headers(), signal: AbortSignal.timeout(15000) });
  if (!r.ok) return null;
  const j = (await r.json())?.result?.data?.json || {};
  const raw = j.tags || j.candidate_tags || j.candidate_user_tags || [];
  return raw.map((t) => String(t?.name ?? t?.tag ?? t).toLowerCase());
}

export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (!(await requireAuth(req, res))) return;
  const name = String(req.query?.name || "").trim();
  if (!name || name.length < 2) return res.status(400).json({ ok: false, error: "name required" });
  if (!hasCookie()) return res.status(200).json({ ok: false, error: "no_cookie", source: null, matched: false });

  try {
    const norm = (s) => String(s || "").trim().toLowerCase().replace(/\s+/g, " ");
    const items = await crmItems();
    const hit = items.find((c) => norm(c.name) === norm(name));
    if (!hit) return res.status(200).json({ ok: true, name, matched: false, source: null, scanned: items.length });

    // tags: prefer embedded, else fetch the record
    let tags = (hit.tags || hit.candidate_tags || []).map((t) => String(t?.name ?? t).toLowerCase());
    if (!tags.length) tags = (await tagsForCandidate(hit.id)) || [];
    const isConnector = tags.some((t) => t.includes("connector"));
    return res.status(200).json({
      ok: true, name, matched: true,
      source: isConnector ? "Connector" : null,
      candidateUserId: hit.id, tags: tags.slice(0, 10),
    });
  } catch (e) {
    const msg = String(e?.message || e);
    const auth = e?.code === "AUTH_EXPIRED" || /401/.test(msg);
    return res.status(auth ? 503 : 500).json({ ok: false, error: auth ? "AUTH_EXPIRED" : msg.slice(0, 150) });
  }
}
