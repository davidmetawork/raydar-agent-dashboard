import { randomUUID } from "node:crypto";
import { cors, indexAdd, requirePrepAuth, saveJob, storeConfigured } from "./_lib/core.mjs";

// POST { candidate:{ candidate_user_id? | name? | paraform_url? }, role_id,
//        round, notes?, role_title?, company? }  ->  { ok:true, id }
// candidate_user_id comes from the Prep tab's CRM picker (exact identity,
// no name resolution); name/paraform_url remain the free-text fallback.
// Signed-in Raydar users only. Writes a queued job the Fly runner will claim.
const clean = (v, max) => String(v ?? "").trim().slice(0, max);

export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "POST only" });
  if (!storeConfigured()) return res.status(503).json({ ok: false, error: "state_store_not_configured" });
  if (!(await requirePrepAuth(req, res))) return;
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const cand = body.candidate && typeof body.candidate === "object" ? body.candidate : {};
    const name = clean(cand.name, 140);
    const paraformUrl = clean(cand.paraform_url, 500);
    const candidateUserId = clean(cand.candidate_user_id, 64);
    if (candidateUserId && !/^[A-Za-z0-9_-]{8,64}$/.test(candidateUserId)) {
      return res.status(400).json({ ok: false, error: "candidate_user_id is not a valid id" });
    }
    if (paraformUrl) {
      let host = "";
      try { host = new URL(paraformUrl).hostname.toLowerCase(); } catch { /* invalid URL */ }
      if (host !== "paraform.com" && !host.endsWith(".paraform.com")) {
        return res.status(400).json({ ok: false, error: "paraform_url must be a paraform.com link" });
      }
    }
    // Hard identity gate (2026-07-19): free-text names can no longer queue a
    // job. Every job carries an exact id (from the CRM picker) or a
    // paraform.com URL the runner parses deterministically. This removes the
    // "candidate not found by name" failure class entirely.
    if (!paraformUrl && !candidateUserId) {
      return res.status(400).json({ ok: false, error: "candidate must be picked from the CRM or given as a paraform.com URL" });
    }
    const roleId = clean(body.role_id, 100);
    if (!roleId) return res.status(400).json({ ok: false, error: "role_id required" });
    const round = body.round;
    if (!Number.isInteger(round) || round < 1 || round > 9) {
      return res.status(400).json({ ok: false, error: "round must be an integer 1-9" });
    }
    const notes = clean(body.notes, 4000);
    const roleTitle = clean(body.role_title, 200);
    const company = clean(body.company, 200);

    const id = randomUUID();
    const now = new Date().toISOString();
    const job = {
      id,
      created_at: now,
      requested_by: req.authedEmail || "",
      candidate: {
        ...(candidateUserId ? { candidate_user_id: candidateUserId } : {}),
        ...(name ? { name } : {}),
        ...(paraformUrl ? { paraform_url: paraformUrl } : {}),
      },
      role_id: roleId,
      ...(roleTitle ? { role_title: roleTitle } : {}),
      ...(company ? { company } : {}),
      round,
      ...(notes ? { notes } : {}),
      status: "queued",
      history: [{ at: now, status: "queued", note: "requested via dashboard" }],
    };
    await saveJob(job);
    await indexAdd(id);
    return res.status(200).json({ ok: true, id });
  } catch (e) {
    return res.status(500).json({ ok: false, error: "enqueue_failed", detail: String(e.message || e).slice(0, 200) });
  }
}
