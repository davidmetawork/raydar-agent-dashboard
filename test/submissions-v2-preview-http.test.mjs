import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac,randomUUID} from 'node:crypto';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {STATE_ROOT} from '../submissions-preview/config.mjs';

const origin=process.env.SUBMISSIONS_V2_PREVIEW_HTTP_ORIGIN||'';
if(origin&&origin!=='http://127.0.0.1:4525')throw new Error('HTTP acceptance only permits the isolated loopback preview.');
async function session(){const home=await fetch(origin);assert.equal(home.status,200);const cookie=home.headers.get('set-cookie').split(';')[0];const identity=await fetch(`${origin}/api/submissions-v2/session`,{headers:{cookie}}).then(response=>response.json());return {cookie,csrf:identity.csrf_token};}
test('preview HTTP rejects unauthenticated and cross-site mutations and exposes no remote sign-in dependency',{skip:!origin},async()=>{
  assert.equal((await fetch(`${origin}/api/submissions-v2/counts`)).status,401);
  const {cookie,csrf}=await session();
  const payload=JSON.stringify({action:'unknown_preview_action'});
  for(const headers of [{cookie},{cookie,origin:'https://example.com','x-raydar-csrf':csrf},{cookie,origin,'x-raydar-csrf':'wrong'}]) {
    const response=await fetch(`${origin}/api/submissions-v2/command`,{method:'POST',headers:{...headers,'content-type':'application/json','idempotency-key':randomUUID()},body:payload});assert.equal(response.status,403);
  }
  const home=await fetch(origin).then(response=>response.text());
  assert.equal(home.includes('accounts.google.com'),false);
  const script=await fetch(`${origin}/submissions-v2.js`).then(response=>response.text());
  assert.equal(script.includes('https://www.paraform.com'),false);
  assert.ok(script.includes('/preview/candidates'));
  const bad=await fetch(`${origin}/api/submissions-v2/intake/receipt?kind=reply&eventId=missing`,{headers:{'x-raydar-event-id':'missing','x-raydar-timestamp':new Date().toISOString(),'x-raydar-signature':'invalid'}});assert.equal(bad.status,401);
});
test('signed source receipts report durable acceptance and the ready PDF uses one private download ticket',{skip:!origin},async()=>{
  const {cookie,csrf}=await session(),keys=JSON.parse(await readFile(join(STATE_ROOT,'preview-keys.json'),'utf8'));
  const eventId='preview-reply-preview-ada',timestamp=new Date().toISOString();
  const signature=createHmac('sha256',keys.ingest).update(`submissions.receipt.v1\n${timestamp}\n${eventId}\nreply`).digest('base64url');
  const receipt=await fetch(`${origin}/api/submissions-v2/intake/receipt?kind=reply&eventId=${eventId}`,{headers:{'x-raydar-event-id':eventId,'x-raydar-timestamp':timestamp,'x-raydar-signature':signature}}).then(response=>response.json());
  assert.equal(receipt.received,true);assert.match(receipt.requestDigest,/^[a-f0-9]{64}$/);
  const list=await fetch(`${origin}/api/submissions-v2/list?page=interested`,{headers:{cookie}}).then(response=>response.json());
  const ada=list.rows.find(row=>row.candidate_id==='preview-ada');assert.ok(ada?.artifact_ready,'Load the starter scenarios and let Ada finish first.');
  assert.ok(Number.isFinite(Date.parse(ada.signal_at)));
  const response=await fetch(`${origin}/api/submissions-v2/pairs/${ada.case_id}/resume/download-ticket`,{method:'POST',headers:{cookie,origin,'x-raydar-csrf':csrf,'content-type':'application/json','idempotency-key':randomUUID()},body:JSON.stringify({expected_version:ada.state_version})});
  assert.equal(response.status,200);const ticket=await response.json();assert.ok(ticket.url.startsWith('/api/submissions-v2/download?'));
  const pdfResponse=await fetch(new URL(ticket.url,origin),{headers:{cookie}});assert.equal(pdfResponse.status,200);assert.match(pdfResponse.headers.get('content-type'),/^application\/pdf/);
  const bytes=Buffer.from(await pdfResponse.arrayBuffer());assert.equal(bytes.subarray(0,5).toString(),'%PDF-');
  const output=join(STATE_ROOT,'acceptance');await mkdir(output,{recursive:true,mode:0o700});await writeFile(join(output,'ada-ready.pdf'),bytes,{mode:0o600});
  assert.equal((await fetch(new URL(ticket.url,origin),{headers:{cookie}})).status,410);
});
