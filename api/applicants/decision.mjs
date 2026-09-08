// Human decisions from the Review queue. `pass` and `interview` write one
// apphub:decisions hash field; `undo` deletes it — but only while the loop has
// not acked the key, because after an ack the invite email may already be out
// and an undo would lie about it. (There is a small window where the loop has
// pulled an approval but not yet acked it; the product accepts that race —
// approvals send first and acks land the same cycle.)

import { cors, requireAuth } from "./_lib/core.mjs";
import { PASS_REASON_IDS, decisionRecord } from "./_lib/decision-record.mjs";
import {
  actionabilityFor,
  interviewDecisionAllowed,
  interviewDecisionHold,
  readActivePublication,
  readPublishedArtifacts,
  verifyGeneration,
} from "./_lib/generation.mjs";
import { applicantRowsV2FromSnapshot } from "./_lib/profile-v2.mjs";
import {
  getJson,
  hashGetJson,
  K,
  kvConfigured,
  validKey,
} from "./_lib/kv.mjs";
import {
  requireApplicantMutation,
  saveApplicantRequest,
  retryableInterviewRequest,
  SOURCE_STALE_INTERVIEW_FAILURE,
} from './_lib/request-safety.mjs';

export const config = { maxDuration: 30 };

const ACTIONS = new Set(["pass", "interview", "undo"]);

export function createDecisionHandler({
  corsHandler = cors,
  authHandler = requireApplicantMutation,
  kvReady = kvConfigured,
  readAck = (key) => hashGetJson(K.acks, key),
  readDecision = (key) => hashGetJson(K.decisions, key),
  readJson = getJson,
  readActive = () => readActivePublication({ readJson }),
  readArtifacts = (pointer) => readPublishedArtifacts(pointer, { readJson }),
  writeDecision = (key, record, options = {}) => saveApplicantRequest(key,record,{allowRejected:true,...options}),
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
    const retryRequested = Object.prototype.hasOwnProperty.call(body, 'retryOfRequestId');
    const retryOfRequestId = retryRequested ? body.retryOfRequestId : null;
    if (retryRequested && (action !== 'interview'
      || typeof retryOfRequestId !== 'string'
      || !/^[a-z0-9-]{16,80}$/i.test(retryOfRequestId)
      || retryOfRequestId === body.requestId)) {
      return res.status(400).json({ok:false,error:'invalid_retry_request'});
    }

    res.setHeader("Cache-Control", "no-store");
    try {
      if (action === "undo") {
        return res.status(409).json({ok:false,error:'request_may_already_be_processing'});
      }
      const generation = await readActive();
      if (!generation) return res.status(503).json({ ok: false, error: "generation_unavailable" });
      const artifacts = await readArtifacts(generation);
      if (!artifacts || !verifyGeneration(artifacts).ok) {
        return res.status(503).json({ ok: false, error: "generation_unavailable" });
      }
      if (String(body.generationId || "") !== generation.generationId
        || String(body.generationDigest || "") !== generation.digest) {
        return res.status(409).json({ ok: false, error: "applicant_changed_refresh_required" });
      }
      const row = (Array.isArray(artifacts.queue?.rows) ? artifacts.queue.rows : []).find((item) => item?.key === key);
      const profileKey = row?.profileKey || row?.cuId;
      if (!profileKey) {
        return res.status(409).json({ ok: false, error: "applicant_not_in_current_review_queue" });
      }
      const profileV2 = applicantRowsV2FromSnapshot(artifacts.snapshot)[key] ?? null;
      const v2Actionability = profileV2?.actionability ?? null;
      const currentInputRevision = profileV2?.inputRevision || row.inputRevision;
      const currentReadinessRevision = v2Actionability?.readinessRevision || row.readinessRevision;
      const currentDecisionRevision = profileV2?.decisionRevision ?? row.decisionRevision;
      const requestRevisionMismatch = !/^[a-z0-9-]{16,80}$/i.test(String(body.requestId || ''))
        || !currentInputRevision || body.inputRevision !== currentInputRevision
        || body.readinessRevision !== currentReadinessRevision
        || Number(body.decisionRevision) !== Number(currentDecisionRevision);
      const v2IdentityMismatch = profileV2 && (
        !profileV2.inputRevision || profileV2.decisionRevision == null || !v2Actionability?.readinessRevision
        || String(body.applicationId || "") !== profileV2.application.applicationId
        || String(body.sourceObservationId || "") !== profileV2.application.sourceObservationId
        || String(body.rowRevision || "") !== String(profileV2.application.rowRevision || "")
      );
      if (requestRevisionMismatch || v2IdentityMismatch) {
        return res.status(409).json({ ok: false, error: "applicant_changed_refresh_required" });
      }
      const actionability = {
        ...actionabilityFor(row),
        ...(v2Actionability ? {
          eligibility: v2Actionability.eligibility,
          readinessRevision: v2Actionability.readinessRevision,
          approvalState: v2Actionability.approvalState,
          canCreateApproval: v2Actionability.canCreateApproval,
        } : {}),
      };
      const v2InterviewAllowed = !v2Actionability || v2Actionability.eligibility === "ready"
        || (v2Actionability.eligibility === "waiting"
          && v2Actionability.canCreateApproval === true
          && v2Actionability.approvalState === "required");
      if (action === "interview" && (!interviewDecisionAllowed(row) || !v2InterviewAllowed)) {
        return res.status(409).json({
          ok: false,
          error: "interview_hard_hold",
          reason: v2Actionability?.reasons?.[0] || interviewDecisionHold(row) || "applicant_readiness_pending",
        });
      }
      let retryDecision = null;
      let retryAck = null;
      let retryPublicationAt = null;
      if (retryRequested) {
        [retryDecision,retryAck] = await Promise.all([readDecision(key),readAck(key)]);
        if (retryDecision?.action === 'interview' && retryDecision.requestId === body.requestId
          && ['technical_admission_retry','source_revision_retry'].includes(retryDecision.recovery?.kind)
          && retryDecision.recovery.previousRequestId === retryOfRequestId
          && retryDecision.actorId === (req.applicantActor?.id || req.authedEmail)) {
          return res.status(202).json({ok:true,key,decision:retryDecision,
            status:retryDecision.status || 'pending',idempotent:true});
        }
        const snapshotGeneratedAt = String(artifacts.snapshot?.generatedAt || '');
        const queueGeneratedAt = String(artifacts.queue?.generatedAt || '');
        retryPublicationAt = snapshotGeneratedAt && snapshotGeneratedAt === queueGeneratedAt
          ? snapshotGeneratedAt : null;
        if (!retryableInterviewRequest(retryDecision,retryAck,retryOfRequestId,{
          currentInputRevision,
          currentPublicationAt:retryPublicationAt,
        })) {
          return res.status(409).json({ok:false,error:'interview_retry_unavailable'});
        }
        if (row.externalPriorSendAt || row.external_prior_send_at
          || ['emailed','booked','replied'].includes(String(row.status || ''))) {
          return res.status(409).json({ok:false,error:'already_emailed_for_role'});
        }
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
        by: req.applicantActor?.email || req.authedEmail,
        actorType: "human",
        actorId: req.applicantActor?.id || req.authedEmail,
        authorizedBy: req.applicantActor?.email || req.authedEmail,
        name: row.name,
        roleTitle: row.roleTitle,
        reason,
      });
      Object.assign(decision,{requestId:body.requestId,inputRevision:currentInputRevision,
        readinessRevision:currentReadinessRevision,decisionRevision:Number(currentDecisionRevision),status:'pending',
        ...(action === "interview" ? {
          deliveryState: "requested",
          ...(v2Actionability?.eligibility === "waiting" ? { requestMode: "when_ready" } : {}),
          ...(profileV2 ? { application: {
            id: profileV2.application.applicationId,
            sourceObservationId: profileV2.application.sourceObservationId,
            rowRevision: profileV2.application.rowRevision,
          } } : {}),
        } : {}),
        generationId: generation.generationId,
        generationDigest: generation.digest,
        ...(action === "interview" ? actionability : {}),
        ...(retryRequested ? {recovery:{
          kind:retryAck.reason === SOURCE_STALE_INTERVIEW_FAILURE
            ? 'source_revision_retry' : 'technical_admission_retry',
          previousRequestId:retryOfRequestId,
          failureReason:retryAck.reason,
          previousActorType:retryDecision.actorType || null,
          previousActorId:retryDecision.actorId || retryDecision.by || null,
          previousDecisionAt:retryDecision.at || null,
          previousRuleRunId:retryDecision.ruleRun?.id || null,
          ...(retryAck.reason === SOURCE_STALE_INTERVIEW_FAILURE ? {
            previousInputRevision:retryDecision.inputRevision,
            currentInputRevision,
            sourcePublicationAt:retryPublicationAt,
          } : {}),
        }} : {}),
      });
      // The immutable row and its revisions were checked above, but the
      // publisher may still have advanced the active pointer while the
      // request was being assembled. Refuse a write against that stale page.
      const currentGeneration = await readActive();
      if (!currentGeneration
        || currentGeneration.generationId !== generation.generationId
        || currentGeneration.digest !== generation.digest) {
        return res.status(409).json({
          ok: false,
          error: "applicant_changed_refresh_required",
          generationId: currentGeneration?.generationId || null,
          generationDigest: currentGeneration?.digest || null,
        });
      }
      const writeOptions = retryRequested ? {
        retryOfRequestId,retryFailureReason:retryAck.reason,rejectSentAck:true,
        ...(retryAck.reason === SOURCE_STALE_INTERVIEW_FAILURE ? {
          retryCurrentInputRevision:currentInputRevision,
          retryPublicationAt,
          retryPreviousInputRevision:retryDecision.inputRevision,
          retryDecisionAt:retryDecision.at,
          retryAckAt:retryAck.at,
        } : {}),
      } : {};
      if(!await writeDecision(key, decision, writeOptions)) {
        return res.status(409).json({ok:false,error:retryRequested
          ? 'applicant_request_changed_refresh_required' : 'request_already_pending'});
      }
      return res.status(202).json({ ok: true, key, decision,status:'pending',
        ...(action === "interview" ? { delivery: { state: "requested", label: "Interview requested · preparing" } } : {}) });
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
