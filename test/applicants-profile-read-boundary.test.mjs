import assert from 'node:assert/strict';
import test from 'node:test';
import {createProfileHandler} from '../api/applicants/profile.mjs';

const query={applicationId:'10000000-0000-4000-8000-000000000001',
  generationId:'20000000-0000-4000-8000-000000000001',generationDigest:'a'.repeat(64),rowDigest:'b'.repeat(64)};
function response(){return {headers:{},setHeader(k,v){this.headers[k]=v;},
  status(code){this.statusCode=code;return this;},json(body){this.body=body;return this;}};}
async function readFailure(error){
  const res=response();
  await createProfileHandler({corsHandler:()=>false,authHandler:async()=>true,kvReady:()=>true,pagedEnabled:()=>true,
    readPaged:async()=>{throw error;},readJson:()=>{throw Error('No legacy fallback');}})({method:'GET',query},res);
  return res;
}

test('paged profile handler distinguishes authoritative SQL refusals from known temporary read failures',async()=>{
  for(const message of ['APPLICANT_VIEW_ROW_UNAVAILABLE','APPLICANT_VIEW_GENERATION_UNAVAILABLE']){
    const res=await readFailure(Object.assign(new Error(message),{code:'55000'}));
    assert.equal(res.statusCode,409);assert.equal(res.body.error,'applicant_profile_changed_refresh_required');
    assert.equal(res.body.retryable,undefined);assert.equal(res.headers['Cache-Control'],'no-store');
  }
  for(const code of ['APPLICANT_PAGED_PROFILE_REFERENCE_SCOPE_CHANGED','APPLICANT_PAGED_PROFILE_DIGEST_MISMATCH']){
    const res=await readFailure(Object.assign(new Error('Sensitive candidate detail'),{code}));
    assert.equal(res.statusCode,409);assert.doesNotMatch(JSON.stringify(res.body),/Sensitive/);
  }
  for(const code of ['57014','53300','57P01','08006','ECONNRESET','CONNECT_TIMEOUT','CONNECTION_CLOSED']){
    const res=await readFailure(Object.assign(new Error('Private connection and candidate detail'),{code}));
    assert.equal(res.statusCode,503);assert.equal(res.body.retryable,true);assert.equal(res.headers['Retry-After'],'60');
    assert.equal(res.body.error,'applicant_profile_read_temporarily_unavailable');
    assert.doesNotMatch(JSON.stringify(res.body),/Private/);
  }
  const unknown=await readFailure(new Error('Private unknown integrity failure'));
  assert.equal(unknown.statusCode,500);assert.equal(unknown.body.retryable,undefined);
  assert.equal(unknown.body.error,'applicant_profile_read_failed_refresh_required');
  assert.doesNotMatch(JSON.stringify(unknown.body),/Private/);
});

test('a contained reconstruction refusal is not returned as a successful profile refresh',async()=>{
  const res=response();
  await createProfileHandler({corsHandler:()=>false,authHandler:async()=>true,kvReady:()=>true,pagedEnabled:()=>true,
    readPaged:async()=>({profile:{source:'profile_reconstruction_pending',profileV2:null},row:{applicationId:query.applicationId}})})
    ({method:'GET',query},res);
  assert.equal(res.statusCode,409);assert.equal(res.body.error,'applicant_profile_changed_refresh_required');
});

test('profile authentication refuses before any stored or legacy profile read',async()=>{
  for(const status of [401,403]){
    const res=response();let reads=0;
    await createProfileHandler({corsHandler:()=>false,authHandler:async(req,response)=>{
      response.status(status).json({ok:false,error:'auth_required'});return false;},
      kvReady:()=>true,pagedEnabled:()=>true,readPaged:async()=>{reads++;}})({method:'GET',query},res);
    assert.equal(res.statusCode,status);assert.equal(reads,0);
  }
});
