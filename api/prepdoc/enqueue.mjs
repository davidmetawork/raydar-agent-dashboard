import { randomUUID } from "node:crypto";
import { cors, indexAdd, requirePrepAuth, saveJob, storeConfigured } from "./_lib/core.mjs";

// POST { candidate:{ name? | paraform_url? }, role_id, round, notes?,
//        role_title?, company? }  ->  { ok:true, id }
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
    if (paraformUrl) {
      let host = "";
      try { host = new URL(paraformUrl).hostname.toLowerCase(); } catch { /* invalid URL */ }
      if (host !== "paraform.com" && !host.endsWith(".paraform.com")) {
        return res.status(400).json({ ok: false, error: "paraform_url must be a paraform.com link" });
      }
    }
    if (!name && !paraformUrl) {
      return res.status(400).json({ ok: false, error: "candidate name or paraform_url required" });
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
