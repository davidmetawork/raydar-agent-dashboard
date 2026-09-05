import test from 'node:test';
import assert from 'node:assert/strict';
import {compareSnapshots,planLegacyRepair} from '../scripts/submissions-rebuild-validation.mjs';

test('shadow parity protects first source, intent, negatives, artifact and proof across a staged transfer',()=>{
  const row={candidate_id:'synthetic',role_id:'role-a',first_signal_id:'source-a',intent_state:'not_interested',negative_history_digest:'history-a',submission_status:'none',artifact_digest:null,state_version:0};
  const before={complete:true,pairs:[row]};
  assert.equal(compareSnapshots(before,structuredClone(before)).ok,true);
  for(const [field,value] of [['first_signal_id','source-b'],['intent_state','interested'],['negative_history_digest','history-b'],['submission_status','proven'],['artifact_digest','artifact-b']]) {
    assert.equal(compareSnapshots(before,{complete:true,pairs:[{...row,[field]:value}]}).ok,false);
  }
  assert.equal(compareSnapshots(before,{complete:true,pairs:[]}).errors[0].reason,'pair_missing');
  assert.throws(()=>compareSnapshots(before,{complete:false,pairs:[row]}),/partial/);
  assert.throws(()=>compareSnapshots(before,{complete:true,pairs:[row,row]}),/duplicate/);
  for (const field of ['first_signal_id','intent_state','submission_status','artifact_digest','negative_history_digest','state_version']) {
    const incomplete={...row}; delete incomplete[field];
    assert.throws(()=>compareSnapshots({complete:true,pairs:[incomplete]},{complete:true,pairs:[incomplete]}),/omits protected fact/);
  }
  assert.throws(()=>compareSnapshots(before,before,{allowedChanges:[{candidate_id:'synthetic',role_id:'role-a',fields:['everything']}]}),/recognized fields/);
  const after={complete:true,pairs:[{...row,intent_state:'interested'}]};
  assert.equal(compareSnapshots(before,after,{allowedChanges:[{candidate_id:'synthetic',role_id:'role-a',fields:['intent']}]}).ok,true);
});
test('bounded repair planning remains evidence-dependent and creates no external effects',()=>{
  assert.deepEqual(planLegacyRepair([]).items,[]);
  assert.equal(planLegacyRepair([]).externalEffects,0);
  assert.throws(()=>planLegacyRepair([{}]),error=>error.code==='enrichment_contract_invalid');
  assert.throws(()=>planLegacyRepair([{}],{maxItems:0}),/bounded/);
});
