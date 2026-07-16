import { cors, findResumeUri, getResume, requireAuth, scanCrm } from "./_lib/core.mjs";
import { candidateSummary, resolveCandidateCall, searchCandidates } from "./_lib/search.mjs";

export const config = { maxDuration: 120 };

const CACHE_TTL_MS = Number(process.env.PARAAI_SEARCH_CACHE_MS || 10 * 60 * 1000);
let cache = { at: 0, items: null, pending: null };

async function crmItems() {
  const now = Date.now();
  if (cache.items && now - cache.at < CACHE_TTL_MS) return cache.items;
  if (cache.pending) return cache.pending;
  cache.pending = scanCrm().then((items) => {
    cache = { at: Date.now(), items, pending: null };
    return items;
  }).catch((error) => {
    cache.pending = null;
    throw error;
  });
  return cache.pending;
}

function query(req) {
  if (req.query && typeof req.query === "object") return req.query;
  try { return Object.fromEntries(new URL(req.url, "http://localhost").searchParams.entries()); }
  catch { return {}; }
}

export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (req.method !== "GET") return res.status(405).json({ ok: false, error: "GET only" });
  if (!(await requireAuth(req, res))) return;
  res.setHeader("Cache-Control", "private, no-store");
  const q = query(req);
  try {
    const items = await crmItems();
    const candidateUserId = String(q.candidateUserId || "").trim();
    if (candidateUserId) {
      const candidate = items.find((item) => String(item?.id || "") === candidateUserId);
      if (!candidate) return res.status(404).json({ ok: false, error: "candidate_not_found" });
      const [resolved, resume] = await Promise.all([
        resolveCandidateCall(candidate, items),
        getResume(candidateUserId).catch(() => null),
      ]);
      const resumeStatus = findResumeUri(resume) ? "on_file" : "missing";
      return res.status(200).json({ ok: true, candidate: candidateSummary(candidate), resumeStatus, ...resolved });
    }
    const name = String(q.q || q.name || "").trim();
    if (name.length < 2) return res.status(400).json({ ok: false, error: "type_at_least_two_characters" });
    return res.status(200).json({ ok: true, query: name, results: searchCandidates(items, name) });
  } catch (error) {
    const authExpired = error?.code === "AUTH_EXPIRED" || /AUTH_EXPIRED|401/.test(String(error?.message || error));
    return res.status(authExpired ? 503 : 502).json({
      ok: false,
      error: authExpired ? "AUTH_EXPIRED" : "candidate_search_failed",
      detail: String(error?.message || error).slice(0, 200),
    });
  }
}
