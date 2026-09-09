import { payloadHash } from './stable-json.mjs';
export const PAGED_ACK_VERSION = 'applicant-core-paged-acks-v1';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const fail = () => Object.assign(new Error('APPLICANT_PAGED_ACK_BATCH_INVALID'), { code: 'APPLICANT_PAGED_ACK_BATCH_INVALID' });
export function normalizePagedAckBatch({ generation, acks } = {}) {
  if (!UUID.test(generation?.id || '') || !/^[0-9a-f]{64}$/.test(generation?.digest || '')
    || !Array.isArray(acks) || !acks.length || acks.length > 100) throw fail();
  const ids = new Set();
  const rows = acks.map(row => {
    if (!UUID.test(row?.id || '') || !UUID.test(row?.inboxId || '') || ids.has(row.id)
      || typeof row.requestId !== 'string' || !row.requestId || row.requestId.length > 512
      || typeof row.monitorKey !== 'string' || !row.monitorKey || row.monitorKey.length > 1_024
      || !['requested','blocked','skipped'].includes(row.ackPayload?.status)
      || row.ackPayload.requestId !== row.requestId || !Number.isFinite(new Date(row.createdAt).getTime())) throw fail();
    ids.add(row.id);
    return { id: row.id, inboxId: row.inboxId, requestId: row.requestId, monitorKey: row.monitorKey,
      createdAt: new Date(row.createdAt).toISOString(), ackPayload: JSON.parse(JSON.stringify(row.ackPayload)) };
  }).sort((a,b) => a.id.localeCompare(b.id));
  const payload = { version: PAGED_ACK_VERSION, generation: { id: generation.id, digest: generation.digest }, acks: rows };
  if (Buffer.byteLength(JSON.stringify(payload)) > 256_000) throw fail();
  return { ...payload, digest: payloadHash(payload) };
}
export function verifyPagedAckReceipt(receipt, batch) {
  if (receipt?.version !== PAGED_ACK_VERSION || receipt.digest !== batch.digest
    || receipt.generationId !== batch.generation.id || receipt.generationDigest !== batch.generation.digest
    || !Array.isArray(receipt.receipts) || receipt.receipts.length !== batch.acks.length) throw fail();
  const results = new Map(receipt.receipts.map(row => [row.id, row]));
  if (results.size !== batch.acks.length) throw fail();
  for (const row of batch.acks) {
    const actual = results.get(row.id);
    if (!actual || actual.requestId !== row.requestId || actual.monitorKey !== row.monitorKey
      || !['stored','superseded','preserved_delivery'].includes(actual.state)) throw fail();
  }
  return batch.acks.map(row => row.id);
}
