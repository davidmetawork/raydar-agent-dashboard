import assert from 'node:assert/strict';
import test from 'node:test';
import {spawnSync} from 'node:child_process';
import {createDecisionHandler} from '../api/applicants/decision.mjs';
import {buildGeneration} from '../api/applicants/_lib/generation.mjs';
import {saveApplicantRequest} from '../api/applicants/_lib/request-safety.mjs';

const OLD = 'request-old-1234567890';
const NEXT = 'request-new-1234567890';
const KEY = 'core:applicationfixture1234';
const REASON = 'APPLICANT_CORE_RULE_RUN_IDEMPOTENCY_CONFLICT';
const oldDecision = {action:'interview',requestId:OLD,actorType:'rule',actorId:'rule-fixture',
  at:'2026-09-05T20:00:00Z',ruleRun:{id:'run-fixture'}};
const oldAck = {requestId:OLD,status:'blocked',reason:REASON};

function harness(options={}) {
  const row = {key:KEY,profileKey:'profilefixture1234',name:'Alex Example',roleTitle:'Engineer',
    inputRevision:'input-fixture',readinessRevision:'readiness-fixture',decisionRevision:3,
    ...options.row};
  const artifacts = buildGeneration({generationId:'retry-fixture-generation',
    snapshot:{stream:[],profilePreparing:0},queue:[row],counts:{total:1,queue:1,stream:0,profilePreparing:0}});
  const saved=[];
  let activeReads=0;
  const handler=createDecisionHandler({
    corsHandler:()=>false,
    authHandler:async(req)=>{req.authedEmail='operator@example.test';
      req.applicantActor={id:'operator@example.test',email:'operator@example.test'};return true;},
    kvReady:()=>true,
    readActive:async()=>{activeReads++; return options.advance && activeReads>1
      ? {...artifacts.pointer,generationId:'changed-generation'} : artifacts.pointer;},
    readArtifacts:async()=>artifacts,
    readDecision:async()=>Object.hasOwn(options,'decision') ? options.decision : oldDecision,
    readAck:async()=>Object.hasOwn(options,'ack') ? options.ack : oldAck,
    writeDecision:async(...args)=>{saved.push(args);return options.writeResult ?? true;},
    now:()=> '2026-09-06T19:45:00Z',
  });
  const baseBody={key:KEY,action:'interview',requestId:NEXT,retryOfRequestId:OLD,
    generationId:artifacts.pointer.generationId,generationDigest:artifacts.pointer.digest,
    inputRevision:row.inputRevision,readinessRevision:row.readinessRevision,decisionRevision:row.decisionRevision};
  return {saved,baseBody,async call(patch={}) {
    const res={statusCode:200,setHeader(){},status(code){this.statusCode=code;return this;},
      json(value){this.body=value;return this;}};
    await handler({method:'POST',body:{...baseBody,...patch}},res);return res;
  }};
}

for(const reason of [REASON,'22P02']) test(`retry ${reason} becomes a new authenticated human request with provenance`,async()=>{
  const h=harness({ack:{...oldAck,reason}});
  const res=await h.call({by:'forged@example.test',actorId:'forged',name:'Wrong person',recovery:{previousRequestId:'forged'}});
  assert.equal(res.statusCode,202);
  assert.equal(h.saved.length,1);
  const [key,record,options]=h.saved[0];
  assert.equal(key,KEY);
  assert.equal(record.name,'Alex Example');
  assert.equal(record.actorType,'human');
  assert.equal(record.actorId,'operator@example.test');
  assert.equal(record.authorizedBy,'operator@example.test');
  assert.equal(record.requestId,NEXT);
  assert.equal(record.deliveryState,'requested');
  assert.deepEqual(record.recovery,{kind:'technical_admission_retry',previousRequestId:OLD,
    failureReason:reason,previousActorType:'rule',previousActorId:'rule-fixture',
    previousDecisionAt:oldDecision.at,previousRuleRunId:'run-fixture'});
  assert.deepEqual(options,{retryOfRequestId:OLD,retryFailureReason:reason,rejectSentAck:true});
});

test('legacy rule provenance remains retryable while explicit human and unproven actors do not',async()=>{
  const legacy={action:'interview',requestId:OLD,by:'rule:legacy-fixture'};
  const h=harness({decision:legacy});assert.equal((await h.call()).statusCode,202);
  for(const decision of [{...oldDecision,actorType:'human',by:'rule:forged'},
    {...oldDecision,actorType:'migration'},{action:'interview',requestId:OLD}]) {
    const rejected=harness({decision});assert.equal((await rejected.call()).statusCode,409);
    assert.equal(rejected.saved.length,0);
  }
});

test('retry rejects malformed, same-ID and wrong-action requests',async()=>{
  for(const patch of [{retryOfRequestId:''},{retryOfRequestId:null},{retryOfRequestId:'short'},
    {retryOfRequestId:NEXT},{action:'pass'},{action:'undo'}]) {
    const h=harness();const res=await h.call(patch);
    assert.equal(res.statusCode,400,JSON.stringify(patch));assert.equal(h.saved.length,0);
  }
});

test('only the exact current failed Interview and matching terminal ack can be retried',async()=>{
  for(const options of [
    {decision:null},{decision:{...oldDecision,requestId:'different-request-123456'}},
    {decision:{...oldDecision,action:'pass'}},{decision:{action:'interview'}},
    {ack:null},{ack:{...oldAck,requestId:'different-request-123456'}},
    ...['pending','invited','sendgrid_delivered','delivery_review'].map(status=>({ack:{...oldAck,status}})),
    ...['human_pass','interview_dispatch_pending','delivery_reconciliation_required','identity_conflict','provider_timeout']
      .map(reason=>({ack:{...oldAck,reason}})),
  ]) {
    const h=harness(options);const res=await h.call();
    assert.equal(res.statusCode,409,JSON.stringify(options));assert.equal(h.saved.length,0);
  }
});

test('current hard holds and exact-role prior-send facts still refuse a retry',async()=>{
  for(const row of [
    {identityConflict:true},{privacyHold:true},{withdrawn:true},{recipientConflict:true},
    {hardHoldCode:'delivery_reconciliation_required'},
    {externalPriorSendAt:'2026-09-01T10:00:00Z'},
    {external_prior_send_at:'2026-09-01T10:00:00Z'},
    ...['emailed','booked','replied'].map(status=>({status})),
  ]) {
    const h=harness({row});const res=await h.call();
    assert.equal(res.statusCode,409,JSON.stringify(row));assert.equal(h.saved.length,0);
  }
});

test('stale generation/revisions and publication advancing during preparation write nothing',async()=>{
  for(const patch of [{generationId:'old-generation'}, {generationDigest:'0'.repeat(64)},
    {inputRevision:'old-input'}, {readinessRevision:'old-readiness'},{decisionRevision:2}]) {
    const h=harness();const res=await h.call(patch);assert.equal(res.statusCode,409);assert.equal(h.saved.length,0);
  }
  const h=harness({advance:true});const res=await h.call();assert.equal(res.statusCode,409);assert.equal(h.saved.length,0);
});

test('a lost atomic comparison reports a refresh without claiming the request was saved',async()=>{
  const h=harness({writeResult:false});const res=await h.call();
  assert.equal(res.statusCode,409);assert.equal(res.body.error,'applicant_request_changed_refresh_required');
});

test('replaying the identical successful HTTP request is idempotent even after its ack changes',async()=>{
  const first=harness();await first.call();const stored=first.saved[0][1];
  const h=harness({decision:stored,ack:{requestId:NEXT,status:'invited'}});const res=await h.call();
  assert.equal(res.statusCode,202);assert.equal(res.body.idempotent,true);assert.deepEqual(res.body.decision,stored);
  assert.equal(h.saved.length,0);
});

test('ordinary human requests retain their existing write options',async()=>{
  const h=harness();delete h.baseBody.retryOfRequestId;const res=await h.call();
  assert.equal(res.statusCode,202);assert.deepEqual(h.saved[0][2],{});assert.equal(h.saved[0][1].recovery,undefined);
});

test('invalid scoped retry options cannot invoke KV',async()=>{
  for(const opts of [{retryOfRequestId:OLD,retryFailureReason:'provider_timeout'},
    {retryOfRequestId:'',retryFailureReason:REASON}]) {
    assert.equal(await saveApplicantRequest(KEY,{action:'interview',requestId:NEXT},{...opts,
      kvImpl:()=>{throw new Error('must not execute');}}),false);
  }
});

// Optional local integration: execute the exact Redis Lua, not a JavaScript
// copy of its conditions. Use a disposable Python venv containing lupa and set
// APPLICANT_LUA_TEST_PYTHON to that venv's interpreter. No production Redis is used.
const LUA_HARNESS = String.raw`
import json,sys
from lupa import LuaRuntime
data=json.load(sys.stdin)
lua=LuaRuntime(unpack_returned_tuples=True)
state=data['state']
writes=[]
def decode(raw):
  value=json.loads(raw)
  return lua.table_from(value,recursive=True) if isinstance(value,(dict,list)) else value
def redis_call(op,key,field,*args):
  if op=='HGET': return state.get(key,{}).get(field)
  if op=='HSET':
    state.setdefault(key,{})[field]=args[0]
    writes.append([key,field])
    return 1
  raise ValueError(op)
lua.globals().cjson=lua.table_from({'decode':decode})
lua.globals().redis=lua.table_from({'call':redis_call})
results=[]
for command in data['commands']:
  n=command[2]
  lua.globals().KEYS=lua.table_from(command[3:3+n])
  lua.globals().ARGV=lua.table_from(command[3+n:])
  results.append(lua.execute(command[1]))
json.dump({'results':results,'state':state,'writes':writes},sys.stdout)
`;

test('atomic Lua permits one scoped replacement, rejects races and preserves same-request idempotency',
  {skip:!process.env.APPLICANT_LUA_TEST_PYTHON},async()=>{
    const commandFor=async(requestId=NEXT)=>{
      let command;
      await saveApplicantRequest(KEY,{action:'interview',requestId},{allowRejected:true,rejectSentAck:true,
        retryOfRequestId:OLD,retryFailureReason:REASON,kvImpl:async(value)=>{command=value;return 1;}});
      return command;
    };
    const first=await commandFor();const competitor=await commandFor('competing-request-123456');
    const execute=(decision,ack,commands=[first])=>{
      const state={'apphub:decisions':{},'apphub:acks':{}};
      if(decision)state['apphub:decisions'][KEY]=JSON.stringify(decision);
      if(ack)state['apphub:acks'][KEY]=JSON.stringify(ack);
      const out=spawnSync(process.env.APPLICANT_LUA_TEST_PYTHON,['-c',LUA_HARNESS],
        {input:JSON.stringify({state,commands}),encoding:'utf8'});
      assert.equal(out.status,0,out.stderr);return JSON.parse(out.stdout);
    };
    const success=execute(oldDecision,oldAck,[first,first,competitor]);
    assert.deepEqual(success.results,[1,1,0]);assert.equal(success.writes.length,1);
    assert.equal(JSON.parse(success.state['apphub:decisions'][KEY]).requestId,NEXT);
    assert.deepEqual(execute({action:'interview',requestId:OLD,by:'rule:legacy'},oldAck).results,[1]);
    for(const [decision,ack] of [
      [null,oldAck],[oldDecision,null],
      [{...oldDecision,requestId:'changed-request-123456'},oldAck],
      [{...oldDecision,action:'pass'},oldAck],
      [{...oldDecision,actorType:'human',by:'rule:forged'},oldAck],
      [{action:'interview',requestId:OLD},oldAck],
      [oldDecision,{...oldAck,requestId:'changed-request-123456'}],
      [oldDecision,{...oldAck,status:'invited'}],
      [oldDecision,{...oldAck,status:'sendgrid_delivered'}],
      [oldDecision,{...oldAck,status:'pending'}],
      [oldDecision,{...oldAck,reason:'interview_dispatch_pending'}],
      [oldDecision,{...oldAck,reason:'human_pass'}],
      [oldDecision,{...oldAck,reason:'22P02'}],
    ]) {
      const result=execute(decision,ack);assert.deepEqual(result.results,[0]);assert.equal(result.writes.length,0);
    }
  });
