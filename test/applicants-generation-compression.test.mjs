import test from 'node:test';
import assert from 'node:assert/strict';
import { gunzipSync } from 'node:zlib';
import { encodeStoredGenerationArtifact, decodeStoredGenerationArtifact, buildGeneration, publishGeneration, readPublishedArtifacts } from '../api/applicants/_lib/generation.mjs';
import { respondApplicantFeed } from '../api/applicants/feed.mjs';

test('large immutable generations round-trip through bounded compressed storage and idempotent retries', async () => {
  const snapshot = { generatedAt:'2026-09-08T00:00:00Z',stream:[],profilePreparing:[],
    applicantRowsV2:Object.fromEntries(Array.from({length:5000},(_,i)=>['candidate-'+i,{facts:'retained history '.repeat(230)}])) };
  const generation = buildGeneration({generationId:'compressed-generation',snapshot,queue:[],
    sourceCutoff:'current',sourceWatermark:5,counts:{total:0,stream:0,queue:0,profilePreparing:0}});
  const state=new Map(); let activations=0;
  const readJson=async key=>state.get(key)||null;
  const writeImmutableJson=async(key,value)=>{if(state.has(key))return null;state.set(key,value);return 'OK'};
  const activate=async()=>{activations++;return true};
  await publishGeneration({generation,readJson,writeImmutableJson,activate});
  await publishGeneration({generation,readJson,writeImmutableJson,activate});
  const stored=[...state.values()].find(x=>x?.storageVersion);
  assert.ok(stored.decodedBytes>16_000_000);
  assert.ok(JSON.stringify(stored).length<1_000_000);
  const actual=await readPublishedArtifacts(generation.pointer,{readJson});
  assert.deepEqual(actual.snapshot,generation.snapshot);
  assert.equal(activations,2);
  state.set([...state.keys()].find(x=>x.endsWith(':snapshot')),{...stored,sha256:'0'.repeat(64)});
  await assert.rejects(readPublishedArtifacts(generation.pointer,{readJson}),/generation_storage_digest_mismatch/);
});

test('storage refuses corrupt and oversized expansion envelopes and reads legacy JSON',()=>{
  const legacy={key:'unchanged'};assert.equal(decodeStoredGenerationArtifact(legacy),legacy);
  const encoded=encodeStoredGenerationArtifact({facts:'x'.repeat(1_100_000)});
  assert.throws(()=>decodeStoredGenerationArtifact({...encoded,decodedBytes:40_000_001}),/generation_storage_invalid/);
  assert.throws(()=>decodeStoredGenerationArtifact({...encoded,decodedBytes:10}));
  assert.throws(()=>decodeStoredGenerationArtifact({...encoded,storageVersion:'unknown'}),/generation_storage_invalid/);
});

test('large browser feed uses transparent HTTP gzip with the complete response',()=>{
  const body={applicantRowsV2:{retained:'facts'.repeat(300_000)}};const headers={};let wire;
  const res={setHeader:(k,v)=>{headers[k]=v},status:n=>{assert.equal(n,200);return res},end:b=>{wire=b}};
  respondApplicantFeed({headers:{'accept-encoding':'gzip, deflate, br'}},res,body);
  assert.equal(headers['Content-Encoding'],'gzip');assert.deepEqual(JSON.parse(gunzipSync(wire)),body);
});
