import {requireAuth} from './core.mjs';
import {kv,K} from './kv.mjs';

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
export async function saveApplicantRequest(key,record,{allowRejected=false}={}) {
  return Number(await kv(['EVAL',`
    local raw=redis.call('HGET',KEYS[1],ARGV[1])
    if raw then
      local old=cjson.decode(raw)
      if old.requestId==ARGV[3] then return 1 end
      local ackraw=redis.call('HGET',KEYS[2],ARGV[1])
      if ARGV[4]~='1' or not ackraw then return 0 end
      local ack=cjson.decode(ackraw)
      if old.requestId and ack.requestId~=old.requestId then return 0 end
      if ack.status~='blocked' or ack.reason=='human_pass' or ack.reason=='interview_dispatch_pending' then return 0 end
    end
    redis.call('HSET',KEYS[1],ARGV[1],ARGV[2])
    return 1`,2,K.decisions,K.acks,key,JSON.stringify(record),record.requestId,allowRejected?'1':'0']))===1;
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
