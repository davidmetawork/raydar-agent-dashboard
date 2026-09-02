// Batch read of the compact list-row cards the sync loop derives from each
// prewarmed profile (headline, location, top-3 experience, top-3 education).
//
// GET /api/applicants/cards?cus=<cuId>,<cuId>,…  ->  { ok, cards: {cuId: card} }
//
// This exists so the Applicants list can render Recruiter-style rows from ONE
// hash read per screenful instead of a profile fetch per row. Read-only: the
// cards hash has exactly one writer (POST /api/applicants/sync), per the
// ownership contract in _lib/kv.mjs.
//
// Missing ids are simply absent from the map — a cuId with no prewarmed
// profile yet is a normal state (the row falls back to snapshot fields), not
// an error, so unknown and invalid ids never fail the batch.

import { cors, requireAuth } from "./_lib/core.mjs";
import { hashGetMany, K, kvConfigured } from "./_lib/kv.mjs";
import { PROFILE_KEY_RE } from "./sync.mjs";

export const config = { maxDuration: 30 };

// The UI batches its visible rows; this cap bounds one HMGET's argument list.
// Overflow is truncated rather than rejected — a too-eager caller should get
// the first screenful, not a 400.
export const MAX_CARD_IDS = 60;

export function parseCus(raw) {
  const seen = new Set();
  for (const part of String(raw ?? "").split(",")) {
    const cu = part.trim();
    if (!cu || !PROFILE_KEY_RE.test(cu) || seen.has(cu)) continue;
    seen.add(cu);
    if (seen.size >= MAX_CARD_IDS) break;
  }
  return [...seen];
}

export function createCardsHandler({
  corsHandler = cors,
  authHandler = requireAuth,
  kvReady = kvConfigured,
  readHashMany = hashGetMany,
} = {}) {
  return async function handler(req, res) {
    if (corsHandler(req, res)) return;
    if (req.method !== "GET") return res.status(405).json({ ok: false, error: "GET only" });
    if (!(await authHandler(req, res))) return;
    if (!kvReady()) return res.status(503).json({ ok: false, error: "state_store_not_configured" });

    res.setHeader("Cache-Control", "no-store");
    const ids = parseCus(req.query?.cus);
    // No usable ids is an empty answer, not a client error: the list calls this
    // on every render, including the one before any row has a cuId.
    if (!ids.length) return res.status(200).json({ ok: true, cards: {} });

    try {
      const cards = await readHashMany(K.cards, ids);
      return res.status(200).json({ ok: true, cards });
    } catch (error) {
      return res.status(502).json({
        ok: false,
        error: "cards_unavailable",
        detail: String(error?.message || error).slice(0, 180),
      });
    }
  };
}

export default createCardsHandler();
