// Browser read for the Applicants tab: one call returns the loop's snapshot
// plus the human-decision and loop-ack overlays, keyed by `<cuId>:<roleId>`.
// The UI joins them client-side (decisions overlay the queue, acks flip
// "Queued to send" to "Emailed").

import { cors, requireAuth } from "./_lib/core.mjs";
import { getJson, hashGetAllJson, K, kvConfigured } from "./_lib/kv.mjs";

export const config = { maxDuration: 30 };

export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (req.method !== "GET") return res.status(405).json({ ok: false, error: "GET only" });
  if (!(await requireAuth(req, res))) return;
  if (!kvConfigured()) return res.status(503).json({ ok: false, error: "state_store_not_configured" });
  try {
    const [snapshot, queueDoc, decisions, acks] = await Promise.all([
      getJson(K.snapshot),
      getJson(K.queue),
      hashGetAllJson(K.decisions),
      hashGetAllJson(K.acks),
    ]);
    // The queue is stored under its own key (size isolation); merge it back so
    // the page keeps reading one snapshot shape. A queue embedded directly in
    // the snapshot (older publisher) wins only if the split doc is absent.
    if (snapshot && queueDoc && Array.isArray(queueDoc.rows)) {
      snapshot.queue = queueDoc.rows;
    }
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({ ok: true, snapshot, decisions, acks });
  } catch (error) {
    return res.status(502).json({
      ok: false,
      error: "feed_unavailable",
      detail: String(error?.message || error).slice(0, 180),
    });
  }
}
