import {readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {requestDigest,validateEnrichment} from '../api/submissions-v2/_lib/enrichment.mjs';

const identity=row=>`${row.candidate_user_id||row.candidate_id}\0${row.role_id}`;
function stableFact(row) {
  // A caller's complete flag does not make omitted protected facts complete.
  // Require explicit nulls so two equally incomplete exports cannot pass parity.
  for (const field of ['first_signal_id','intent_state','submission_status','artifact_digest','negative_history_digest','state_version']) {
    if (!Object.hasOwn(row,field)) throw new Error(`Snapshot omits protected fact ${field}.`);
  }
  if (!Number.isSafeInteger(row.state_version) || row.state_version < 0
    || !['unknown','unclear','interested','not_interested','needs_review'].includes(row.intent_state)
    || !['none','opened','proven'].includes(row.submission_status)) throw new Error('Snapshot contains an invalid durable fact.');
  return {candidate_id:row.candidate_user_id||row.candidate_id,role_id:row.role_id,first_signal_id:row.first_signal_id||row.signal_id||null,
    intent:row.intent_state||row.intent?.state||null,submission:row.submission_status||row.submission?.state||'none',
    artifact_digest:row.artifact_digest||null,negative_history_digest:row.negative_history_digest||null,state_version:Number(row.state_version||0)};
}
export function compareSnapshots(before,after,{allowedChanges=[]}={}) {
  if(!Array.isArray(before?.pairs)||!Array.isArray(after?.pairs))throw new Error('Both snapshots need a complete pairs array.');
  if(before.complete!==true||after.complete!==true)throw new Error('Parity cannot be claimed from partial snapshots.');
  const previous=new Map(),next=new Map(),errors=[];
  for(const [label,rows,index] of [['before',before.pairs,previous],['after',after.pairs,next]])for(const row of rows){
    if(!row.role_id||!(row.candidate_user_id||row.candidate_id))throw new Error(`${label} contains an unresolved pair identity.`);
    const key=identity(row);if(index.has(key))throw new Error(`${label} has a duplicate candidate-role pair.`);index.set(key,stableFact(row));
  }
  const permitted=new Set(['intent','submission','artifact_digest','negative_history_digest','state_version','first_signal_id','new_pair']);
  const allow=new Map();
  for (const item of allowedChanges) {
    if (!item.role_id || !(item.candidate_user_id || item.candidate_id) || !Array.isArray(item.fields)
      || item.fields.some(field=>!permitted.has(field)) || allow.has(identity(item))) throw new Error('Allowed changes need one exact identity and recognized fields.');
    allow.set(identity(item),new Set(item.fields));
  }
  for(const [key,row] of previous){
    const updated=next.get(key);if(!updated){errors.push({candidate_id:row.candidate_id,role_id:row.role_id,reason:'pair_missing'});continue;}
    for(const field of Object.keys(row))if(row[field]!==updated[field]&&!allow.get(key)?.has(field))errors.push({candidate_id:row.candidate_id,role_id:row.role_id,reason:'unexpected_fact_change',field});
  }
  for(const [key,row] of next)if(!previous.has(key)&&!allow.get(key)?.has('new_pair'))errors.push({candidate_id:row.candidate_id,role_id:row.role_id,reason:'unexpected_new_pair'});
  return {schemaVersion:1,mode:'offline_shadow_parity',ok:errors.length===0,previousCount:previous.size,nextCount:next.size,errors,beforeDigest:requestDigest(before),afterDigest:requestDigest(after),externalEffects:0};
}
export function planLegacyRepair(enrichments,{maxItems=100}={}) {
  if(!Array.isArray(enrichments)||enrichments.length>maxItems)throw new Error('Repair input must be a bounded array.');
  const seen=new Set();
  const items=enrichments.map(input=>{
    validateEnrichment(input);const key=`${input.semanticIdentity.mailboxId}\0${input.semanticIdentity.providerMessageId}`;
    if(seen.has(key))throw new Error('Only one proposed enrichment per source is allowed in a repair plan.');seen.add(key);
    return {enrichmentId:input.enrichmentId,sourceDigest:input.evidence.originalContentDigest,requestDigest:requestDigest(input),candidateId:input.contract.candidateId,orderedRoleIds:input.contract.roleIds,contractDigest:input.contract.payloadDigest,
      proposedAction:'submit_enrichment_for_authoritative_validation',eligibility:'requires_current_database_evidence',expectedReplay:'no_op'};
  });
  return {schemaVersion:1,mode:'dry_run',itemCount:items.length,items,manifestDigest:requestDigest(items),externalEffects:0};
}
async function main(){
  const args=Object.fromEntries(process.argv.slice(2).filter(arg=>arg.startsWith('--')).map(arg=>{const at=arg.indexOf('=');return [arg.slice(2,at),arg.slice(at+1)];}));
  const read=async path=>JSON.parse(await readFile(resolve(path),'utf8'));
  let result;
  if(args.mode==='parity')result=compareSnapshots(await read(args.before),await read(args.after),args.allowed?{allowedChanges:await read(args.allowed)}:{});
  else if(args.mode==='repair-plan')result=planLegacyRepair(await read(args.input));
  else throw new Error('Use --mode=parity --before=... --after=... [--allowed=...] or --mode=repair-plan --input=... . This tool never executes a repair or provider action.');
  if(args.output)await writeFile(resolve(args.output),JSON.stringify(result,null,2)+'\n',{mode:0o600});
  console.log(JSON.stringify(result,null,2));if(result.ok===false)process.exitCode=1;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))await main();
