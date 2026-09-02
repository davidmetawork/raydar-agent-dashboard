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
import { profileReceiptReady } from "./_lib/profile-readiness.mjs";
import {requireApplicantMutation,saveApplicantRequest} from './_lib/request-safety.mjs';

export const config = { maxDuration: 30 };

const ACTIONS = new Set(["pass", "interview", "undo"]);

export function createDecisionHandler({
  corsHandler = cors,
  authHandler = requireApplicantMutation,
  kvReady = kvConfigured,
  readAck = (key) => hashGetJson(K.acks, key),
  readQueue = () => getJson(K.queue),
  readCard = (cuId) => hashGetJson(K.cards, cuId),
  readProfileReceipt = (cuId) => hashGetJson(K.profileReady, cuId),
  writeDecision = (key, record) => saveApplicantRequest(key,record,{allowRejected:true}),
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
        return res.status(409).json({ok:false,error:'request_may_already_be_processing'});
      }
      const queue = await readQueue();
      const row = (Array.isArray(queue?.rows) ? queue.rows : []).find((item) => item?.key === key);
      const profileKey = row?.profileKey || row?.cuId;
      if (!profileKey) {
        return res.status(409).json({ ok: false, error: "applicant_not_in_current_review_queue" });
      }
      if(!/^[a-z0-9-]{16,80}$/i.test(String(body.requestId || ''))
        || !row.inputRevision || body.inputRevision!==row.inputRevision
        || body.readinessRevision!==row.readinessRevision
        || Number(body.decisionRevision)!==Number(row.decisionRevision)) {
        return res.status(409).json({ok:false,error:'applicant_changed_refresh_required'});
      }
      if(action==='interview' && row.interviewAllowed!==true) {
        return res.status(409).json({ok:false,error:'interview_not_ready',reason:row.readinessReason});
      }
      const [card, receipt] = await Promise.all([
        readCard(profileKey),
        readProfileReceipt(profileKey),
      ]);
      if (!card
        || (("expCount" in card || "eduCount" in card)
          && !(Number(card.expCount) > 0 || Number(card.eduCount) > 0))
        || !profileReceiptReady(receipt, Date.parse(now()))) {
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
      Object.assign(decision,{requestId:body.requestId,inputRevision:row.inputRevision,
        readinessRevision:row.readinessRevision,decisionRevision:Number(row.decisionRevision),status:'pending'});
      if(!await writeDecision(key, decision)) return res.status(409).json({ok:false,error:'request_already_pending'});
      return res.status(202).json({ ok: true, key, decision,status:'pending' });
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
