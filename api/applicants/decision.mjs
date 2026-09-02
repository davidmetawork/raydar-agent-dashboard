// Human decisions from the Review queue. `pass` and `interview` write one
// apphub:decisions hash field; `undo` deletes it — but only while the loop has
// not acked the key, because after an ack the invite email may already be out
// and an undo would lie about it. (There is a small window where the loop has
// pulled an approval but not yet acked it; the product accepts that race —
// approvals send first and acks land the same cycle.)

import { cors, requireAuth } from "./_lib/core.mjs";
import { PASS_REASON_IDS, decisionRecord } from "./_lib/decision-record.mjs";
import {
  getJson,
  hashDel,
  hashGetJson,
  hashSetJson,
  K,
  kvConfigured,
  validKey,
} from "./_lib/kv.mjs";

export const config = { maxDuration: 30 };

const ACTIONS = new Set(["pass", "interview", "undo"]);

export function createDecisionHandler({
  corsHandler = cors,
  authHandler = requireAuth,
  kvReady = kvConfigured,
  readAck = (key) => hashGetJson(K.acks, key),
  readQueue = () => getJson(K.queue),
  readCard = (cuId) => hashGetJson(K.cards, cuId),
  writeDecision = (key, record) => hashSetJson(K.decisions, { [key]: record }),
  deleteDecision = (key) => hashDel(K.decisions, key),
  now = () => new Date().toISOString(),
} = {}) {
  return async function handler(req, res) {
    if (corsHandler(req, res)) return;
    if (req.method !== "POST") return res.status(405).json({ ok: false, error: "POST only" });
    if (!(await authHandler(req, res))) return;
    if (!kvReady()) return res.status(503).json({ ok: false, error: "state_store_not_configured" });

    let body;
    try { body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {}); }
    catch { return res.status(400).json({ ok: false, error: "invalid_json" }); }

    const key = String(body.key || "").trim();
    const action = String(body.action || "");
    if (!validKey(key)) return res.status(400).json({ ok: false, error: "invalid_key" });
    if (!ACTIONS.has(action)) return res.status(400).json({ ok: false, error: "unsupported_action" });

    res.setHeader("Cache-Control", "no-store");
    try {
      if (action === "undo") {
        const ack = await readAck(key);
        if (ack) return res.status(409).json({ ok: false, error: "already_acked", ack });
        await deleteDecision(key);
        return res.status(200).json({ ok: true, key, undone: true });
      }
      const queue = await readQueue();
      const row = (Array.isArray(queue?.rows) ? queue.rows : []).find((item) => item?.key === key);
      if (!row?.cuId) {
        return res.status(409).json({ ok: false, error: "applicant_not_in_current_review_queue" });
      }
      if (!(await readCard(row.cuId))) {
        return res.status(409).json({ ok: false, error: "profile_cache_not_ready" });
      }
      // Shared with the rules tick so a human decision and an automatic one
      // are the same shape downstream (see _lib/decision-record.mjs).
      // A reason only makes sense on a Pass, and only from the fixed list.
      // Anything else is dropped rather than rejected: a reason is a bonus,
      // and losing one must never cost the decision itself.
      const reason = action === "pass" && PASS_REASON_IDS.has(String(body.reason || ""))
        ? String(body.reason)
        : null;
      const decision = decisionRecord({
        action,
        at: now(),
        by: req.authedEmail,
        name: body.name,
        roleTitle: body.roleTitle,
        reason,
      });
      await writeDecision(key, decision);
      return res.status(200).json({ ok: true, key, decision });
    } catch (error) {
      return res.status(502).json({
        ok: false,
        error: "decision_unavailable",
        detail: String(error?.message || error).slice(0, 180),
      });
    }
  };
}

export default createDecisionHandler();
