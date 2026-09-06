import {requireAuth} from './core.mjs';
import {kv,K} from './kv.mjs';

// Falsy so a future boolean-style caller cannot mistake an ack rejection for
// a saved request; Rules uses strict equality to distinguish it from `false`
// (an existing decision).
export const APPLICANT_REQUEST_ALREADY_EMAILED = 0;

// These failures occur before Core admits the decision. Delivery/identity
// holds and ambiguous provider outcomes must never use this retry path.
export const RETRYABLE_INTERVIEW_ADMISSION_FAILURES = new Set([
  'APPLICANT_CORE_RULE_RUN_IDEMPOTENCY_CONFLICT',
  '22P02',
]);
export const SOURCE_STALE_INTERVIEW_FAILURE = 'APPLICANT_CORE_DECISION_SOURCE_REVISION_STALE';
export const RETRYABLE_INTERVIEW_FAILURES = new Set([
  ...RETRYABLE_INTERVIEW_ADMISSION_FAILURES,
  SOURCE_STALE_INTERVIEW_FAILURE,
]);

function validTime(value) {
  const raw = String(value || '');
  const time = Date.parse(raw);
  return Number.isFinite(time) && new Date(time).toISOString() === raw ? time : null;
}

export function retryableInterviewRequest(decision, ack, expectedRequestId, {
  currentInputRevision=null,
  currentPublicationAt=null,
}={}) {
  const ruleDecision = decision?.actorType === 'rule'
    || (!decision?.actorType && String(decision?.by || '').startsWith('rule:'));
  const by = String(decision?.by || '').trim().toLowerCase();
  const humanOrRuleDecision = decision?.actorType === 'human' || decision?.actorType === 'rule'
    || (!decision?.actorType && (by.startsWith('rule:') || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(by)));
  const exactFailedRequest = Boolean(expectedRequestId && decision?.action === 'interview'
    && decision.requestId === expectedRequestId
    && ack?.requestId === expectedRequestId && ack.status === 'blocked');
  if (!exactFailedRequest) return false;
  if (RETRYABLE_INTERVIEW_ADMISSION_FAILURES.has(ack.reason)) return ruleDecision;
  if (ack.reason !== SOURCE_STALE_INTERVIEW_FAILURE || !humanOrRuleDecision) return false;
  const previousInputRevision = String(decision?.inputRevision || '');
  const nextInputRevision = String(currentInputRevision || '');
  const publicationAt = validTime(currentPublicationAt);
  const decisionAt = validTime(decision?.at);
  const ackAt = validTime(ack?.at);
  return Boolean(previousInputRevision && nextInputRevision
    && previousInputRevision !== nextInputRevision
    && publicationAt != null && decisionAt != null && ackAt != null
    && publicationAt > decisionAt && publicationAt > ackAt);
}

export async function requireApplicantMutation(req,res) {
  if (process.env.AUTH_DISABLED==='1' || process.env.AUTH_DISABLED==='true') {
    res.status(503).json({ok:false,error:'applicant_auth_unavailable'});return false;
  }
  if (!(await requireAuth(req,res))) return false;
  let origin;
  try {origin=new URL(req.headers?.origin || '').host;} catch {}
  const email = String(req.authedEmail || '').trim().toLowerCase();
  if (!origin || origin!==req.headers?.host || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    res.status(403).json({ok:false,error:'same_origin_signed_in_request_required'});return false;
  }
  // Downstream decision records must identify the authenticated principal from
  // this server-side assertion, never from a browser body field. Keep both the
  // canonical id and email for human/rule authorization audit joins.
  req.authedEmail = email;
  req.applicantActor = { type: 'human', id: email, email };
  return true;
}

// One atomic applicant-key write: parallel rules/clicks cannot overwrite an
// unacknowledged request, and retrying the same request is idempotent.
export async function saveApplicantRequest(key,record,{
  allowRejected=false,rejectSentAck=false,kvImpl=kv,
  retryOfRequestId=null,retryFailureReason=null,retryCurrentInputRevision=null,
  retryPublicationAt=null,retryPreviousInputRevision=null,retryDecisionAt=null,retryAckAt=null,
}={}) {
  const scopedRetry = retryOfRequestId != null;
  if (scopedRetry && (!retryOfRequestId || record?.action !== 'interview'
    || !RETRYABLE_INTERVIEW_FAILURES.has(retryFailureReason))) return false;
  const sourceStaleRetry = scopedRetry && retryFailureReason === SOURCE_STALE_INTERVIEW_FAILURE;
  if (sourceStaleRetry && (!retryCurrentInputRevision || !retryPreviousInputRevision
    || record?.inputRevision !== retryCurrentInputRevision
    || retryCurrentInputRevision === retryPreviousInputRevision
    || record?.recovery?.kind !== 'source_revision_retry'
    || record.recovery.previousRequestId !== retryOfRequestId
    || record.recovery.failureReason !== SOURCE_STALE_INTERVIEW_FAILURE
    || record.recovery.previousInputRevision !== retryPreviousInputRevision
    || record.recovery.currentInputRevision !== retryCurrentInputRevision
    || record.recovery.sourcePublicationAt !== retryPublicationAt
    || validTime(retryPublicationAt) == null || validTime(retryDecisionAt) == null
    || validTime(retryAckAt) == null
    || validTime(retryPublicationAt) <= validTime(retryDecisionAt)
    || validTime(retryPublicationAt) <= validTime(retryAckAt))) return false;
  const rejectSentAckForInterview=rejectSentAck && record?.action==='interview';
  const result=Number(await kvImpl(['EVAL',`
    local raw=redis.call('HGET',KEYS[1],ARGV[1])
    if raw then
      local old=cjson.decode(raw)
      if old.requestId==ARGV[3] then return 1 end
      local ackraw=redis.call('HGET',KEYS[2],ARGV[1])
      if (ARGV[6] or '')~='' then
        if old.action~='interview' or old.requestId~=ARGV[6] or not ackraw then return 0 end
        local legacyRule=(not old.actorType or old.actorType==cjson.null or old.actorType=='') and string.sub(tostring(old.by or ''),1,5)=='rule:'
        local retryAck=cjson.decode(ackraw)
        if retryAck.requestId~=ARGV[6] or retryAck.status~='blocked' or retryAck.reason~=ARGV[7] then return 0 end
        if ARGV[7]=='APPLICANT_CORE_DECISION_SOURCE_REVISION_STALE' then
          local legacyActor=not old.actorType or old.actorType==cjson.null or old.actorType==''
          local legacyBy=string.lower(tostring(old.by or ''))
          local legacyHuman=legacyActor and string.match(legacyBy,'^[^%s@]+@[^%s@]+%.[^%s@]+$')~=nil
          if old.actorType~='human' and old.actorType~='rule' and not legacyRule and not legacyHuman then return 0 end
          local next=cjson.decode(ARGV[2])
          if type(old.inputRevision)~='string' or old.inputRevision==''
            or type(next.inputRevision)~='string' or next.inputRevision==''
            or old.inputRevision~=ARGV[10] or next.inputRevision~=ARGV[8]
            or old.inputRevision==next.inputRevision then return 0 end
          if type(next.recovery)~='table' or next.recovery.kind~='source_revision_retry'
            or next.recovery.previousRequestId~=ARGV[6] or next.recovery.failureReason~=ARGV[7]
            or next.recovery.previousInputRevision~=ARGV[10]
            or next.recovery.currentInputRevision~=ARGV[8]
            or next.recovery.sourcePublicationAt~=ARGV[9] then return 0 end
          if type(old.at)~='string' or old.at=='' or type(retryAck.at)~='string' or retryAck.at==''
            or old.at~=ARGV[11] or retryAck.at~=ARGV[12]
            or ARGV[9]=='' or ARGV[9]<=old.at or ARGV[9]<=retryAck.at then return 0 end
        elseif old.actorType~='rule' and not legacyRule then return 0 end
      end
      if ARGV[4]~='1' or not ackraw then return 0 end
      local ack=cjson.decode(ackraw)
      if old.requestId and ack.requestId~=old.requestId then return 0 end
      if ack.status~='blocked' or ack.reason=='human_pass' or ack.reason=='interview_dispatch_pending' then return 0 end
    elseif (ARGV[6] or '')~='' then
      return 0
    end
    if ARGV[5]=='1' then
      local ackraw=redis.call('HGET',KEYS[2],ARGV[1])
      if ackraw then
        local ack=cjson.decode(ackraw)
        if ack.status=='invited' or ack.status=='sendgrid_delivered' then return -1 end
      end
    end
    redis.call('HSET',KEYS[1],ARGV[1],ARGV[2])
    return 1`,2,K.decisions,K.acks,key,JSON.stringify(record),record.requestId,allowRejected?'1':'0',rejectSentAckForInterview?'1':'0',
    ...(scopedRetry ? [retryOfRequestId,retryFailureReason,
      sourceStaleRetry ? retryCurrentInputRevision : '',sourceStaleRetry ? retryPublicationAt : '',
      sourceStaleRetry ? retryPreviousInputRevision : '',sourceStaleRetry ? retryDecisionAt : '',
      sourceStaleRetry ? retryAckAt : ''] : [])]));
  if (rejectSentAckForInterview && result===-1) return APPLICANT_REQUEST_ALREADY_EMAILED;
  return result===1;
}

export async function saveApplicantAck(key,ack) {
  return Number(await kv(['EVAL',`
    local raw=redis.call('HGET',KEYS[1],ARGV[1])
    if raw then
      local req=cjson.decode(raw)
      if req.requestId and req.requestId~=ARGV[3] then return 0 end
    elseif ARGV[3]~='' then return 0 end
    redis.call('HSET',KEYS[2],ARGV[1],ARGV[2])
    return 1`,2,K.decisions,K.acks,key,JSON.stringify(ack),ack.requestId||'']))===1;
}
