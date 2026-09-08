import assert from 'node:assert/strict';
import {createHash,randomBytes} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import test from 'node:test';
import {storeTransportChunk,readTransportChunks,MONITOR_CHUNK_VERSION,MONITOR_CHUNK_BYTES} from '../api/applicants/_lib/transport-chunks.mjs';
import {createSyncHandler,MAX_TRANSPORT_DECODED_BYTES} from '../api/applicants/sync.mjs';
const sha=x=>createHash('sha256').update(x).digest('hex');
function encode(body){
 const raw=Buffer.from(JSON.stringify(body)),compressed=gzipSync(raw,{level:9});
 const manifest={version:MONITOR_CHUNK_VERSION,codec:'gzip-base64',decodedBytes:raw.length,decodedSha256:sha(raw),
  compressedBytes:compressed.length,compressedSha256:sha(compressed),chunkCount:Math.ceil(compressed.length/MONITOR_CHUNK_BYTES)};
 return {manifest,chunks:Array.from({length:manifest.chunkCount},(_,index)=>({manifest,index,data:compressed.subarray(index*MONITOR_CHUNK_BYTES,(index+1)*MONITOR_CHUNK_BYTES).toString('base64')}))};
}
function store(){const data=new Map();return{data,options:{maxDecodedBytes:MAX_TRANSPORT_DECODED_BYTES,
 readJson:async key=>data.get(key),writeImmutableJson:async(key,value,ttl)=>{assert.equal(ttl,900);if(!data.has(key))data.set(key,structuredClone(value));}}};}
const body={snapshot:{retainedEvidence:randomBytes(3_000_000).toString('base64')},queue:[]};
const encoded=encode(body);
test('a publication beyond the single gzip limit reassembles exactly from bounded immutable chunks',async()=>{
 assert.ok(encoded.manifest.compressedBytes>2_500_000);const s=store();
 for(const chunk of encoded.chunks){assert.ok(Buffer.byteLength(JSON.stringify({transportChunk:chunk}))<700000);
  assert.equal((await storeTransportChunk(chunk,s.options)).stored,true);
  assert.equal((await storeTransportChunk(chunk,s.options)).stored,true);
 }
 assert.deepEqual(await readTransportChunks(encoded.manifest,s.options),body);
});
test('missing, changed and poisoned chunks refuse assembly',async()=>{
 const s=store();await assert.rejects(readTransportChunks(encoded.manifest,s.options),{code:'transport_chunks_missing'});
 for(const c of encoded.chunks)await storeTransportChunk(c,s.options);
 const key=[...s.data.keys()][0];s.data.get(key).data='A'+s.data.get(key).data.slice(1);
 await assert.rejects(readTransportChunks(encoded.manifest,s.options),{code:'invalid_transport_chunk_digest'});
 await assert.rejects(storeTransportChunk(encoded.chunks[0],s.options),{code:'transport_chunk_conflict'});
});
test('manifest bounds, decoded digest and recursive transport envelopes stay fenced',async()=>{
 const s=store();for(const patch of [{chunkCount:99},{decodedBytes:32000001},{compressedBytes:8000001},{codec:'unknown'}]){
  await assert.rejects(readTransportChunks({...encoded.manifest,...patch},s.options),{code:'invalid_transport_chunk_manifest'});
 }
 const wrong=encode({value:'unchanged'});wrong.manifest.decodedSha256='a'.repeat(64);
 for(const c of wrong.chunks)await storeTransportChunk(c,s.options);
 await assert.rejects(readTransportChunks(wrong.manifest,s.options),{code:'invalid_transport_chunk_payload'});
 const nested=encode({transportRef:encoded.manifest});for(const c of nested.chunks)await storeTransportChunk(c,s.options);
 await assert.rejects(readTransportChunks(nested.manifest,s.options),{code:'invalid_transport_chunk_payload'});
});
test('the machine endpoint authenticates before storage and a chunk cannot mutate the active publication',async()=>{
 const previous=process.env.APPHUB_SYNC_KEY;process.env.APPHUB_SYNC_KEY='transport-fixture';
 try{
  const s=store();let otherWrites=0;
  const handler=createSyncHandler({...s.options,kvReady:()=>true,writeJson:()=>{otherWrites++;},writeHash:()=>{otherWrites++;},activateGeneration:()=>{otherWrites++;}});
  const call=async(body,authorization='Bearer transport-fixture')=>{const res={setHeader(){},status(n){this.statusCode=n;return this;},json(x){this.body=x;return this;}};
   await handler({method:'POST',headers:{authorization},body},res);return res;};
  assert.equal((await call({transportChunk:encoded.chunks[0]},'wrong')).statusCode,401);assert.equal(s.data.size,0);
  assert.equal((await call({transportChunk:encoded.chunks[0],acks:{}})).statusCode,400);assert.equal(s.data.size,0);
  assert.equal((await call({transportChunk:encoded.chunks[0]})).body.transportChunk.stored,true);
  assert.equal((await call({transportRef:encoded.manifest})).statusCode,409);assert.equal(otherWrites,0);
 }finally{if(previous===undefined)delete process.env.APPHUB_SYNC_KEY;else process.env.APPHUB_SYNC_KEY=previous;}
});
