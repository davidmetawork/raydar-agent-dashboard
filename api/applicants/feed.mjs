// Browser read for the Applicants tab: one call returns the loop's snapshot
// plus the human-decision and loop-ack overlays, keyed by `<cuId>:<roleId>`,
// and the photos hash (cuId → public Paraform photo URL) for row avatars.
// The UI joins them client-side (decisions overlay the queue, acks flip
// "Queued to send" to "Emailed").

import { cors, requireAuth } from "./_lib/core.mjs";
import { getJson, hashGetAllJson, K, kvConfigured } from "./_lib/kv.mjs";

export const config = { maxDuration: 30 };

export function createFeedHandler({
  corsHandler = cors,
  authHandler = requireAuth,
  kvReady = kvConfigured,
  readJson = getJson,
  readHash = hashGetAllJson,
} = {}) {
  return async function handler(req, res) {
    if (corsHandler(req, res)) return;
    if (req.method !== "GET") return res.status(405).json({ ok: false, error: "GET only" });
    if (!(await authHandler(req, res))) return;
    if (!kvReady()) return res.status(503).json({ ok: false, error: "state_store_not_configured" });
    try {
      const [snapshot, queueDoc, decisions, acks, photos, counts] = await Promise.all([
        readJson(K.snapshot),
        readJson(K.queue),
        readHash(K.decisions),
        readHash(K.acks),
        readHash(K.photos),
        readJson(K.counts),
      ]);
      // The queue is stored under its own key (size isolation); merge it back so
      // the page keeps reading one snapshot shape. A queue embedded directly in
      // the snapshot (older publisher) wins only if the split doc is absent.
      if (snapshot && queueDoc && Array.isArray(queueDoc.rows)) {
        snapshot.queue = queueDoc.rows;
      }
      res.setHeader("Cache-Control", "no-store");
      // `counts` carries sync's count-drop tripwire doc (apphub:counts); the
      // tab shows a warning banner when counts.alert is set, data untouched.
      return res.status(200).json({ ok: true, snapshot, decisions, acks, photos, counts });
    } catch (error) {
      return res.status(502).json({
        ok: false,
        error: "feed_unavailable",
        detail: String(error?.message || error).slice(0, 180),
      });
    }
  };
}

export default createFeedHandler();
