import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';

export const MONITOR_CHUNK_VERSION = 'applicant-core-monitor-chunks-v1';
export const MONITOR_CHUNK_BYTES = 500_000;
export const MONITOR_CHUNK_MAX_COMPRESSED_BYTES = 8_000_000;
const TTL_SECONDS = 900;
const digest = data => createHash('sha256').update(data).digest('hex');
const fail = (code, status = 400) => Object.assign(new Error(code), { code, status });
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const keys = ['version','codec','decodedBytes','decodedSha256','compressedBytes','compressedSha256','chunkCount'];

function validateManifest(value, maxDecodedBytes) {
  if (!object(value) || Object.keys(value).length !== keys.length || keys.some(k => !(k in value))
    || value.version !== MONITOR_CHUNK_VERSION || value.codec !== 'gzip-base64'
    || !Number.isSafeInteger(value.decodedBytes) || value.decodedBytes < 2 || value.decodedBytes > maxDecodedBytes
    || !Number.isSafeInteger(value.compressedBytes) || value.compressedBytes < 1
    || value.compressedBytes > MONITOR_CHUNK_MAX_COMPRESSED_BYTES
    || value.chunkCount !== Math.ceil(value.compressedBytes / MONITOR_CHUNK_BYTES)
    || !/^[a-f0-9]{64}$/.test(value.decodedSha256) || !/^[a-f0-9]{64}$/.test(value.compressedSha256)) {
    throw fail('invalid_transport_chunk_manifest');
  }
  return Object.fromEntries(keys.map(k => [k, value[k]]));
}
function chunkKey(manifest, index) {
  return `apphub:transport:${manifest.compressedSha256}:${index}`;
}
function validateChunk(value, maxDecodedBytes) {
  if (!object(value) || Object.keys(value).sort().join(',') !== 'data,index,manifest') {
    throw fail('invalid_transport_chunk');
  }
  const manifest = validateManifest(value.manifest, maxDecodedBytes);
  const index = value.index;
  if (!Number.isSafeInteger(index) || index < 0 || index >= manifest.chunkCount
    || typeof value.data !== 'string' || value.data.length > Math.ceil(MONITOR_CHUNK_BYTES / 3) * 4
    || !/^[A-Za-z0-9+/]+={0,2}$/.test(value.data)) throw fail('invalid_transport_chunk');
  const bytes = Buffer.from(value.data, 'base64');
  const expectedBytes = Math.min(MONITOR_CHUNK_BYTES, manifest.compressedBytes - index * MONITOR_CHUNK_BYTES);
  if (bytes.length !== expectedBytes || bytes.toString('base64') !== value.data) throw fail('invalid_transport_chunk');
  return { manifest, index, data: value.data };
}

// Uploads are immutable, short-lived transport artifacts. They cannot move
// the active generation or write decisions; final assembly enters the same
// existing validation and publication path as a single request.
export async function storeTransportChunk(value, { readJson, writeImmutableJson, maxDecodedBytes }) {
  const chunk = validateChunk(value, maxDecodedBytes);
  const key = chunkKey(chunk.manifest, chunk.index);
  await writeImmutableJson(key, chunk, TTL_SECONDS);
  const stored = await readJson(key);
  if (!stored || JSON.stringify(validateChunk(stored, maxDecodedBytes)) !== JSON.stringify(chunk)) {
    throw fail('transport_chunk_conflict', 409);
  }
  return { stored: true, compressedSha256: chunk.manifest.compressedSha256, index: chunk.index };
}

export async function readTransportChunks(value, { readJson, maxDecodedBytes }) {
  const manifest = validateManifest(value, maxDecodedBytes);
  const stored = await Promise.all(Array.from({ length: manifest.chunkCount }, (_, i) => readJson(chunkKey(manifest, i))));
  if (stored.some(row => !row)) throw fail('transport_chunks_missing', 409);
  const chunks = stored.map((row, index) => {
    const chunk = validateChunk(row, maxDecodedBytes);
    if (chunk.index !== index || JSON.stringify(chunk.manifest) !== JSON.stringify(manifest)) {
      throw fail('transport_chunk_conflict', 409);
    }
    return Buffer.from(chunk.data, 'base64');
  });
  const compressed = Buffer.concat(chunks);
  if (compressed.length !== manifest.compressedBytes || digest(compressed) !== manifest.compressedSha256) {
    throw fail('invalid_transport_chunk_digest');
  }
  let decoded;
  try { decoded = gunzipSync(compressed, { maxOutputLength: maxDecodedBytes + 1 }); }
  catch { throw fail('invalid_transport_chunk_payload'); }
  if (decoded.length !== manifest.decodedBytes || decoded.length > maxDecodedBytes
    || digest(decoded) !== manifest.decodedSha256) throw fail('invalid_transport_chunk_payload');
  try {
    const body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(decoded));
    if (!object(body) || ['transport','transportChunk','transportRef'].some(k => k in body)) throw Error();
    return body;
  } catch { throw fail('invalid_transport_chunk_payload'); }
}
