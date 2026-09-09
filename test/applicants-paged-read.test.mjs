import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { createFeedHandler } from '../api/applicants/feed.mjs';
import { createProfileHandler } from '../api/applicants/profile.mjs';
import { createPagedSyncHandler } from '../api/applicants/paged-sync.mjs';
import { normalizePagedAckBatch } from '../api/applicants/_lib/paged-core/paged-ack-contract.mjs';
import { readActivePagedViewPage } from '../api/applicants/_lib/paged-core/paged-view-read.mjs';
import { K } from '../api/applicants/_lib/kv.mjs';

const id = n => `10000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const digest = 'a'.repeat(64);
const response = () => ({ headers: {}, setHeader(k,v) { this.headers[k]=v; },
  status(code) { this.statusCode=code;return this; },json(body) { this.body=body;return this; } });
const deps = { corsHandler:()=>false,authHandler:async()=>true,kvReady:()=>true,pagedEnabled:()=>true };
const failLegacy = () => { throw new Error('Unexpected legacy read'); };

test('paged feed reads acknowledgements only for returned rows and keeps global counts', async () => {
  const reads=[];
  const query={view:'preparing',limit:'50',roleId:'role-one',cursor:'opaque'};
  const handler=createFeedHandler({...deps,readActive:failLegacy,readHash:failLegacy,readArtifacts:failLegacy,
    readPaged:async request=>{
      assert.equal(request,query);
      return {manifest:{generationId:id(1),generationDigest:digest,rowCount:100000,counts:{preparing:98765}},
        page:{nextCursor:'next'},view:'preparing',applicants:[{row:{applicationId:id(2),key:'core:one',
          viewStates:['preparing'],problems:[]},card:{name:'Source Person'}}]};
    },readMany:async(key,keys)=>{reads.push([key,keys]);return {};} });
  const res=response();await handler({method:'GET',headers:{},query},res);
  assert.equal(res.statusCode,200);
  assert.deepEqual(reads,[[K.decisions,['core:one']],[K.acks,['core:one']]]);
  assert.equal(res.body.profilePreparing,98765);
  assert.equal(res.body.profilePreparingRows[0].applicationId,id(2));
  assert.equal(res.body.nextCursor,'next');
  const manifestResponse=response();
  await createFeedHandler({...deps,readPaged:failLegacy,readMany:failLegacy,
    readPagedManifest:async()=>({generationId:id(1)})})({method:'GET',headers:{},query:{manifestOnly:'1'}},manifestResponse);
  assert.equal(manifestResponse.body.manifest.generationId,id(1));
});

test('profile opening requires the exact application and stored generation without provider/cache fallback',async()=>{
  const query={applicationId:id(2),generationId:id(1),generationDigest:digest,rowDigest:'b'.repeat(64)};
  let reads=0;
  const handler=createProfileHandler({...deps,readJson:failLegacy,readMany:failLegacy,readPaged:async request=>{
    reads++;assert.equal(request,query);
    return {profile:{name:'Stored Person',profileV2:{factSetDigest:digest}},row:{applicationId:id(2)},generation:{generationId:id(1)}};
  }});
  const missing=response();await handler({method:'GET',query:{cu:'legacy-person'}},missing);
  assert.equal(missing.statusCode,400);assert.equal(reads,0);
  const res=response();await handler({method:'GET',query},res);
  assert.equal(res.statusCode,200);assert.equal(res.body.profileV2.factSetDigest,digest);assert.equal(reads,1);
  const denied=response();await createProfileHandler({...deps,readJson:failLegacy,
    readPaged:async()=>{throw new Error('Privacy restricted');}})({method:'GET',query},denied);
  assert.equal(denied.statusCode,409);
});

test('page cursors retain generation and global filter scope and refuse cross-scope replay', async()=>{
  const calls=[];
  const pool={connect:async()=>({query:async(sql,args)=>{
    calls.push([sql,args]);
    if(sql.includes('read_applicant_view_page'))return {rows:[{value:{generation:{generationId:id(1),generationDigest:digest},
      documents:[{row:{id:id(4),application_id:id(2)}}],after:{primary:'2026-09-01T00:00:00Z',secondary:'2026-09-01',key:'core:one'}}}]};
    return {rows:[]};
  },release(){}})};
  const request={pool,generationId:id(1),generationDigest:digest,roleId:'role-one',query:'Alice',view:'ready'};
  const first=await readActivePagedViewPage(request);
  const second=await readActivePagedViewPage({...request,cursor:first.nextCursor});
  assert.equal(second.rows[0].application_id,id(2));
  assert.equal(JSON.parse(calls.filter(([sql])=>sql.includes('read_applicant_view_page')).at(-1)[1][0]).after.key,'core:one');
  for(const patch of [{generationId:id(9)},{generationDigest:'f'.repeat(64)},{roleId:'role-two'},{query:'Bob'},{view:'decided'}]) {
    await assert.rejects(readActivePagedViewPage({...request,...patch,cursor:first.nextCursor}),{code:'APPLICANT_VIEW_PAGE_CURSOR_STALE'});
  }
  assert.equal(calls.filter(([sql])=>sql==='COMMIT').length,2);
});

test('paged acknowledgement transport verifies Core before writing and replays identical receipts',async()=>{
  const batch=normalizePagedAckBatch({generation:{id:id(1),digest},acks:[{id:id(2),inboxId:id(3),
    requestId:'request-one',monitorKey:'core:one',createdAt:'2026-09-09T00:00:00Z',ackPayload:{requestId:'request-one',status:'requested'}}]});
  let writes=0;
  const handler=createPagedSyncHandler({auth:()=>true,
    readBatch:async query=>{assert.deepEqual(query.ackIds,[id(2)]);return {generationId:id(1),generationDigest:digest,acks:batch.acks};},
    storeBatch:async rows=>{writes++;return rows.map(row=>({id:row.id,requestId:row.requestId,monitorKey:row.monitorKey,state:'stored'}));}});
  const first=response(),retry=response();
  await handler({method:'POST',body:batch},first);await handler({method:'POST',body:batch},retry);
  assert.equal(first.statusCode,200);assert.deepEqual(first.body,retry.body);assert.equal(writes,2);
  const mismatch=response();
  await createPagedSyncHandler({auth:()=>true,readBatch:async()=>({generationId:id(1),generationDigest:digest,
    acks:batch.acks.map(ack=>({...ack,ackPayload:{...ack.ackPayload,status:'blocked'}}))}),storeBatch:failLegacy})({method:'POST',body:batch},mismatch);
  assert.equal(mismatch.statusCode,409);
  const unauth=response();await createPagedSyncHandler({auth:()=>false,readBatch:failLegacy,storeBatch:failLegacy})({method:'POST',body:batch},unauth);
  assert.equal(unauth.statusCode,401);
});

function pagingUi() {
  const html=readFileSync(new URL('../applicants.html',import.meta.url),'utf8');
  const code=html.slice(html.indexOf('function applicantPageView()'),html.indexOf('function markFeedUnavailable('));
  const state={view:'review',chip:null,sort:'newest',query:'',role:'all',checked:new Set(['selected']),modal:{key:'open'},
    generation:{generationId:id(1),digest},snapshot:{queue:[{key:'one',applicationId:id(2)}],stream:[]},
    profilePreparingRows:[],problems:[],profiles:{open:{name:'Open Person'}},decisions:{},acks:{},cards:{},photos:{},applicantRowsV2:{},paged:true};
  const page={sequence:1,nextCursor:'next',loaded:1,error:null,loading:false,checking:false};
  const context={STATE:state,APPLICANT_PAGE:page,URLSearchParams,Set,PROFILE_RETRY_AT:new Map(),
    queueRows:()=>state.snapshot.queue,streamRows:()=>state.snapshot.stream,profilePreparingRows:()=>state.profilePreparingRows,
    richGenerationKey:()=>state.generation?.generationId,resetRichCards(){},reconcileLocal(){},renderAll(){},
    document:{querySelectorAll:()=>[]},$:()=>({clientHeight:100,scrollTop:150,classList:{remove(){},toggle(){}},style:{}}),
    relTime:()=>'',setPillDescription(){},loadFeed:async()=>{throw new Error('Unexpected list reset');}};
  vm.createContext(context);vm.runInContext(code,context);
  return {context,state,page};
}

test('append preserves selection, modal and loaded rows and rejects generation/duplicate corruption before mutation',()=>{
  const {context,state,page}=pagingUi();
  const body={generation:{generationId:id(1),digest},snapshot:{queue:[{key:'two',applicationId:id(3)}],stream:[]},
    manifest:{generationId:id(1)},nextCursor:'next-2',profilePreparingRows:[]};
  context.applyPagedFeed(body,{append:true});
  assert.equal(state.snapshot.queue.length,2);assert.equal(state.checked.has('selected'),true);
  assert.equal(state.modal.key,'open');assert.equal(state.profiles.open.name,'Open Person');assert.equal(page.loaded,2);
  assert.throws(()=>context.applyPagedFeed(body,{append:true}),/repeated/);
  assert.throws(()=>context.applyPagedFeed({...body,generation:{generationId:id(9),digest}},{append:true}),/changed/);
  assert.equal(state.snapshot.queue.length,2);assert.equal(page.nextCursor,'next-2');
});

test('background publication changes show an update without resetting deep browsing',async()=>{
  const {context,state,page}=pagingUi();
  context.fetch=async()=>({ok:true,json:async()=>({manifest:{generationId:id(9)}})});
  await context.checkPagedUpdates();
  assert.equal(page.updates,true);assert.equal(state.generation.generationId,id(1));
  assert.equal(state.snapshot.queue[0].key,'one');assert.equal(state.modal.key,'open');
});
