import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
import test from 'node:test';
import {normalizeApplicantRowV2} from '../api/applicants/_lib/profile-v2.mjs';
const page=await readFile(new URL('../applicants.html',import.meta.url),'utf8');
const functions=page.slice(page.indexOf('function ackFor(key)'),page.indexOf('function setDecisionFilter'))
  +page.slice(page.indexOf('function decidedStatusHtml'),page.indexOf('function retryInterviewButtonHtml'));
function harness({state='queued',requestId='saved-request',currentDecision=true,ackStatus='blocked',action='interview'}={}){
 const decision={action,requestId:'saved-request',by:'operator',at:null};
 const STATE={local:{},decisions:{key:decision},acks:{key:{requestId:'saved-request',status:ackStatus,reason:'HUB_RECEIPT_CHANGED'}}};
 const invitation={state,requestId,currentDecision,reason:'Current reason'};
 const h=runInNewContext(functions+';({decisionStatus,decidedStatusHtml})',{
  STATE,SENT_ACK_STATUSES:new Set(['invited','sendgrid_delivered']),queueRows:()=>[{key:'key'}],streamRows:()=>[],
  applicantRowV2:()=>({invitation}),decisionByline:()=> 'operator',esc:x=>String(x),interviewHold:()=>null,
 });
 return {status:()=>h.decisionStatus('key',decision),html:()=>h.decidedStatusHtml('key',decision),STATE};
}
test('current queued request replaces its historical hold in card and profile status without changing acknowledgement',()=>{
 const h=harness();const before=JSON.stringify(h.STATE);
 assert.equal(h.status(),'queued');assert.match(h.html(),/Invitation queued/);
 assert.doesNotMatch(h.html(),/HUB_RECEIPT_CHANGED|Interview held/);assert.equal(JSON.stringify(h.STATE),before);
});
test('a different request or non-current Core decision cannot hide an acknowledgement hold',()=>{
 for(const options of [{requestId:'old-request'},{currentDecision:false}]){
  const h=harness(options);assert.equal(h.status(),'blocked');assert.match(h.html(),/HUB_RECEIPT_CHANGED/);
 }
});
test('current holds and sent evidence keep their distinct states',()=>{
 const hold=harness({state:'held'});assert.equal(hold.status(),'blocked');assert.match(hold.html(),/Current reason/);
 const sent=harness({ackStatus:'sendgrid_delivered'});assert.equal(sent.status(),'emailed');assert.match(sent.html(),/Emailed/);
 const accepted=harness({state:'externally_committed'});assert.equal(accepted.status(),'queued');assert.match(accepted.html(),/Provider accepted · delivery pending/);
});
test('V2 display adapter preserves exact invitation request provenance',()=>{
 const row=normalizeApplicantRowV2({key:'key',application:{applicationId:'app',tenantScopeId:'tenant',personId:'person',sourceObservationId:'source'},
 invitation:{state:'queued',requestId:'saved-request',decisionEventId:'decision-id',currentDecision:true,updatedAt:'2026-09-08T03:05:00Z'}});
 assert.equal(row.invitation.requestId,'saved-request');assert.equal(row.invitation.decisionEventId,'decision-id');
 assert.equal(row.invitation.currentDecision,true);assert.equal(row.invitation.updatedAt,'2026-09-08T03:05:00Z');
});
