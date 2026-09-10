import test from 'node:test';
import assert from 'node:assert/strict';
import feed from '../api/master-inbox/feed.mjs';
import attachment from '../api/master-inbox/attachment.mjs';
import draftAttachment from '../api/master-inbox/draft-attachment.mjs';
import {createSessionToken,SESSION_COOKIE} from '../api/auth/_lib/session.mjs';
const response=()=>({headers:{},statusCode:0,body:null,sent:null,setHeader(key,value){this.headers[key.toLowerCase()]=value;},status(code){this.statusCode=code;return this;},json(value){this.body=value;return this;},send(value){this.sent=value;return this;},end(){return this;}});
test('Master Inbox proxy preserves exact filters and private authenticated file downloads',async t=>{
  const original={...process.env};const priorFetch=globalThis.fetch;
  Object.assign(process.env,{GOOGLE_CLIENT_ID:'test-only',AUTH_SESSION_SECRET:'local-test-only-hmac-key-longer-than-32-chars',MASTER_INBOX_BASE:'https://inbox.invalid',MASTER_INBOX_SERVICE_KEY:'test-only-service-key'});
  t.after(()=>{globalThis.fetch=priorFetch;for(const key of Object.keys(process.env))if(!(key in original))delete process.env[key];Object.assign(process.env,original);});
  const headers={cookie:`${SESSION_COOKIE}=${createSessionToken({email:'test@raydar.xyz'})}`};
  await t.test('all supported structured filters reach the service unchanged',async()=>{
    const queries={q:'subject:"Interview Request"',mailbox:'box-a',folder:'all-mail',from:'candidate@example.com',cc:'reviewer@example.com',subject:'role',filename:'.pdf',after:'2026-09-01',before:'2026-09-09',read:'unread',starred:'true',hasAttachment:'false',label:'important'};
    let called;globalThis.fetch=async(url,init)=>{assert.equal(init.headers['x-raydar-actor'],'test@raydar.xyz');if(url.includes('/conversations?')){called=new URL(url);return Response.json({ok:true,rows:[],coverage:{observedAt:'test'}});}return Response.json({ok:true,rows:[{id:'box-a'}]});};
    const res=response();await feed({method:'GET',query:queries,headers},res);assert.equal(res.statusCode,200);for(const [key,value]of Object.entries(queries))assert.equal(called.searchParams.get(key),value);
  });
  await t.test('repeated filters and unauthenticated reads make no service call',async()=>{
    let calls=0;globalThis.fetch=async()=>{calls++;throw Error('unexpected');};
    const repeated=response();await feed({method:'GET',query:{from:['a@example.com','b@example.com']},headers},repeated);assert.equal(repeated.statusCode,400);
    const unauthorized=response();await feed({method:'GET',query:{},headers:{}},unauthorized);assert.equal(unauthorized.statusCode,401);assert.equal(calls,0);
  });
  // The deployed service answers a download with 200 and the bytes. This is
  // the only response production produces today, and the split this page came
  // from turned it into a 502, so it is asserted first.
  await t.test('a 200-with-bytes download is relayed as 200 with its bytes',async()=>{
    let seen;globalThis.fetch=async(url,init)=>{seen=new URL(url);assert.equal(init.headers.authorization,'Bearer test-only-service-key');assert.equal(init.headers['x-raydar-actor'],'test@raydar.xyz');return new Response(new Uint8Array([37,80,68,70]),{status:200,headers:{'content-type':'application/pdf','content-disposition':'attachment; filename="file.pdf"'}});};
    const res=response();await attachment({method:'GET',query:{id:'file-id'},headers},res);
    assert.equal(res.statusCode,200);assert.equal(seen.pathname,'/api/attachment');assert.equal(seen.searchParams.get('id'),'file-id');
    assert.equal(res.headers['content-type'],'application/pdf');assert.equal(res.headers['content-disposition'],'attachment; filename="file.pdf"');
    assert.deepEqual([...res.sent],[37,80,68,70]);assert.match(res.headers['cache-control'],/no-store/);assert.equal(res.body,null);
  });
  await t.test('a service error keeps its own status instead of becoming a 502',async()=>{
    globalThis.fetch=async()=>Response.json({ok:false,error:'attachment_not_found'},{status:404});
    const res=response();await attachment({method:'GET',query:{id:'missing'},headers},res);assert.equal(res.statusCode,404);assert.deepEqual(res.body,{ok:false,error:'attachment_not_found'});
  });
  // Forward compatibility only: no deployed service path returns a redirect.
  await t.test('a signed https redirect would be relayed when the service grows one',async()=>{
    globalThis.fetch=async(url,init)=>{assert.equal(init.redirect,'manual');return new Response(null,{status:302,headers:{location:'https://objects.example/private.pdf?signature=test'}});};
    const res=response();await attachment({method:'GET',query:{id:'file-id'},headers},res);
    assert.equal(res.statusCode,302);assert.equal(res.headers.location,'https://objects.example/private.pdf?signature=test');assert.equal(res.headers['referrer-policy'],'no-referrer');assert.equal(res.sent,null);
  });
  // The service is POST-only for draft attachments, so the page must never
  // link a GET at it; the proxy refuses one rather than forwarding a 405.
  await t.test('draft attachments are POST only at the proxy',async()=>{
    let calls=0;globalThis.fetch=async()=>{calls++;throw Error('unexpected');};
    const res=response();await draftAttachment({method:'GET',query:{id:'file-id'},headers},res);
    assert.equal(res.statusCode,405);assert.deepEqual(res.body,{ok:false,error:'method_not_allowed'});assert.equal(calls,0);
  });
  await t.test('unsafe download redirects are rejected at the proxy',async()=>{
    globalThis.fetch=async()=>new Response(null,{status:302,headers:{location:'http://objects.example/file'}});const res=response();await attachment({method:'GET',query:{id:'file-id'},headers},res);assert.equal(res.statusCode,502);
  });
});
