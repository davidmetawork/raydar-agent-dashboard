import test from 'node:test';
import assert from 'node:assert/strict';
import feed from '../api/master-inbox/feed.mjs';
import attachment from '../api/master-inbox/attachment.mjs';
import draftAttachment from '../api/master-inbox/draft-attachment.mjs';
import {createSessionToken,SESSION_COOKIE} from '../api/auth/_lib/session.mjs';
const response=()=>({headers:{},statusCode:0,body:null,setHeader(key,value){this.headers[key.toLowerCase()]=value;},status(code){this.statusCode=code;return this;},json(value){this.body=value;return this;},end(){return this;}});
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
  await t.test('native and provider files route to their own authorized endpoints without buffering bytes',async()=>{
    for(const [handler,path]of [[attachment,'attachment'],[draftAttachment,'draft-attachment']]){
      globalThis.fetch=async(url,init)=>{assert.equal(new URL(url).pathname,`/api/${path}`);assert.equal(new URL(url).searchParams.get('redirect'),'1');assert.equal(init.redirect,'manual');assert.equal(init.headers.authorization,'Bearer test-only-service-key');return new Response(null,{status:302,headers:{location:'https://objects.example/private.pdf?signature=test'}});};
      const res=response();await handler({method:'GET',query:{id:'file-id'},headers},res);assert.equal(res.statusCode,302);assert.equal(res.headers.location,'https://objects.example/private.pdf?signature=test');assert.match(res.headers['cache-control'],/no-store/);assert.equal(res.headers['referrer-policy'],'no-referrer');assert.equal(res.body,null);
    }
  });
  await t.test('unsafe download redirects are rejected at the proxy',async()=>{
    globalThis.fetch=async()=>new Response(null,{status:302,headers:{location:'http://objects.example/file'}});const res=response();await attachment({method:'GET',query:{id:'file-id'},headers},res);assert.equal(res.statusCode,502);
  });
});
