// Browser read for the Applicants tab: one call returns the loop's snapshot
// plus the human-decision and loop-ack overlays, keyed by `<cuId>:<roleId>`,
// and the photos hash (cuId → public Paraform photo URL) for row avatars.
// It also derives a compact list of candidates whose prewarmed card confirms
// there is no experience or education history, so the UI can filter the full
// queue without fetching every profile or shipping every card to the browser.
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
      const [snapshot, queueDoc, decisions, acks, photos, cards] = await Promise.all([
        readJson(K.snapshot),
        readJson(K.queue),
        readHash(K.decisions),
        readHash(K.acks),
        readHash(K.photos),
        readHash(K.cards),
      ]);
      // The queue is stored under its own key (size isolation); merge it back so
      // the page keeps reading one snapshot shape. A queue embedded directly in
      // the snapshot (older publisher) wins only if the split doc is absent.
      if (snapshot && queueDoc && Array.isArray(queueDoc.rows)) {
        snapshot.queue = queueDoc.rows;
      }
      const noLinkedinHistory = Object.entries(cards)
        .filter(([, card]) => Number(card?.expCount) === 0 && Number(card?.eduCount) === 0)
        .map(([cuId]) => cuId);
      res.setHeader("Cache-Control", "no-store");
      return res.status(200).json({ ok: true, snapshot, decisions, acks, photos, noLinkedinHistory });
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
