import { timingSafeEqual } from 'node:crypto';
import { kv, K } from './_lib/kv.mjs';
import { readApplicantAckBatch } from './_lib/paged.mjs';
import { PAGED_ACK_VERSION, normalizePagedAckBatch } from './_lib/paged-core/paged-ack-contract.mjs';

export const config = { maxDuration: 30 };
function authenticate(req) {
  const secret = process.env.APPHUB_SYNC_KEY;
  if (!secret) return false;
  const wanted = Buffer.from(`Bearer ${secret}`), supplied = Buffer.from(req.headers?.authorization || '');
  return wanted.length === supplied.length && timingSafeEqual(wanted, supplied);
}
export async function storePagedAcknowledgements(acks, { kvImpl = kv } = {}) {
  const value = await kvImpl(['EVAL', `
    local items=cjson.decode(ARGV[1])
    local receipts={}
    local delivery={invited=true,mailroom_accepted=true,sendgrid_delivered=true,
      scheduler_verified=true,ready_to_email=true,waiting_for_provider=true}
    for _,item in ipairs(items) do
      local state='stored'
      local currentRaw=redis.call('HGET',KEYS[1],item.monitorKey)
      local current=currentRaw and cjson.decode(currentRaw) or nil
      local oldRaw=redis.call('HGET',KEYS[2],item.monitorKey)
      local old=oldRaw and cjson.decode(oldRaw) or nil
      if current and current.requestId and current.requestId~=item.requestId then
        state='superseded'
      elseif old and old.requestId==item.requestId and delivery[old.status] then
        state='preserved_delivery'
      else
        local ack=item.ackPayload
        ack.at=item.createdAt
        redis.call('HSET',KEYS[2],item.monitorKey,cjson.encode(ack))
      end
      table.insert(receipts,{id=item.id,requestId=item.requestId,monitorKey=item.monitorKey,state=state})
    end
    return cjson.encode(receipts)`, 2, K.decisions, K.acks, JSON.stringify(acks)]);
  return typeof value === 'string' ? JSON.parse(value) : value;
}

export function createPagedSyncHandler({ auth = authenticate, readBatch = readApplicantAckBatch,
  storeBatch = storePagedAcknowledgements } = {}) {
  return async (req, res) => {
    if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });
    if (!auth(req)) return res.status(401).json({ ok: false, error: 'unauthorized' });
    res.setHeader('Cache-Control','no-store');
    let batch;
    try {
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
      batch = normalizePagedAckBatch(body);
      if (body.version !== PAGED_ACK_VERSION || body.digest !== batch.digest) throw new Error();
    } catch { return res.status(400).json({ ok: false, error: 'invalid_ack_batch' }); }
    try {
      const core = await readBatch({ generationId: batch.generation.id, generationDigest: batch.generation.digest,
        ackIds: batch.acks.map(ack => ack.id) });
      const verified = normalizePagedAckBatch({ generation: { id: core.generationId, digest: core.generationDigest }, acks: core.acks });
      if (verified.digest !== batch.digest) return res.status(409).json({ ok: false, error: 'ack_identity_changed' });
      const receipts = await storeBatch(verified.acks);
      return res.status(200).json({ ok: true, version: PAGED_ACK_VERSION, digest: verified.digest,
        generationId: verified.generation.id, generationDigest: verified.generation.digest, receipts });
    } catch {
      return res.status(502).json({ ok: false, error: 'ack_batch_unavailable' });
    }
  };
}
export default createPagedSyncHandler();
