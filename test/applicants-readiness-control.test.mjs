import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

const page=await readFile(new URL('../applicants.html',import.meta.url),'utf8');
const start=page.indexOf('function interviewControl(row) {');
const end=page.indexOf('\nfunction rowCardHtml(',start);
assert.ok(start>=0 && end>start,'exercise the actual shared list/profile control');
const source=page.slice(start,end);
const controlFor=projected=>new Function('applicantRowV2',source+'\nreturn interviewControl;')(()=>projected)({key:'core:held-native-class'});

test('a readable source profile without current actionability cannot advertise ready Interview',()=>{
 for(const projected of [null,{}, {profile:{facts:{name:{value:'Applicant'}}}}, {actionability:{eligibility:'unknown'}}]) {
  assert.deepEqual(controlFor(projected),{label:'Preparing',enabled:false,title:'Applicant readiness is being checked.'});
 }
});

test('current ready and authorized waiting controls retain their distinct actions',()=>{
 assert.deepEqual(controlFor({actionability:{eligibility:'ready'}}),{label:'Interview',enabled:true,title:'Request interview'});
 const waiting=controlFor({actionability:{eligibility:'waiting',canCreateApproval:true,approvalState:'required'}});
 assert.equal(waiting.label,'Interview when ready');
 assert.equal(waiting.enabled,true);
 assert.match(waiting.title,/Save the interview request/);
});

test('hard holds, stops, and waiting without approval authority remain disabled',()=>{
 for(const actionability of [{eligibility:'hard_hold',reasons:['source_held']},{eligibility:'stopped',reasons:['withdrawn']},
  {eligibility:'waiting',canCreateApproval:false,approvalState:'required'},
  {eligibility:'waiting',canCreateApproval:true,approvalState:'approved'}]) {
  const control=controlFor({actionability});
  assert.equal(control.label,'Interview held');
  assert.equal(control.enabled,false);
 }
});
