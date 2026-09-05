import { createHash,randomUUID } from 'node:crypto';
import { requestDigest } from '../api/submissions-v2/_lib/enrichment.mjs';
import { setRuntimeControls } from '../api/submissions-v2/_lib/db.mjs';

export const CANDIDATES=Object.freeze([
  {id:'preview-ada',name:'Ada Sample',scenario:'positive',text:'Yes, I am interested in the Platform Engineer role at Example Cloud.'},
  {id:'preview-ben',name:'Ben Example',scenario:'negative',text:'No thank you. I am not interested in this role.'},
  {id:'preview-cora',name:'Cora Demo',scenario:'question',text:'What is the salary range for this role?'},
  {id:'preview-dana',name:'Dana Sample',scenario:'late_contract',text:'Yes, I am interested. Please move forward.'},
  {id:'preview-eli',name:'Eli Example',scenario:'manual',text:'Synthetic candidate for the Add Candidate workflow.'},
  {id:'preview-finn',name:'Finn Demo',scenario:'failure',text:'Yes, I am interested in the Platform Engineer role at Example Cloud.'},
]);
export const ROLES=Object.freeze([
  {id:'preview-platform',company:'Example Cloud',title:'Platform Engineer',active:true},
  {id:'preview-product',company:'Example Studio',title:'Product Engineer',active:true},
  {id:'preview-inactive',company:'Example Archive',title:'Archived Engineer',active:false},
]);
const digest=value=>createHash('sha256').update(String(value)).digest('hex');

export async function initializePreviewData({sql}) {
  await sql.unsafe(`create schema if not exists preview;
    create table if not exists preview.environment(singleton boolean primary key default true check(singleton),marker text not null,created_at timestamptz not null default clock_timestamp());
    create table if not exists preview.provider_state(key text primary key,value jsonb not null,updated_at timestamptz not null default clock_timestamp());
    create table if not exists preview.command_receipts(key text primary key,digest text not null,result jsonb not null);`);
  await sql`insert into preview.environment(marker) values ('raydar-submissions-rebuild-local-v1') on conflict do nothing`;
  const existing=(await sql`select marker from preview.environment where singleton`)[0];
  if(existing?.marker!=='raydar-submissions-rebuild-local-v1') throw new Error('Preview database marker mismatch.');
  for(const candidate of CANDIDATES) {
    await sql`insert into submissions_v2.candidate_index(candidate_user_id,display_name,normalized_name,search_key,email_match_hmac_current,email_match_hmac_current_version,paraform_profile_url,last_confirmed_at,source_digest,active)
      values (${candidate.id},${candidate.name},${candidate.name.toLowerCase()},${candidate.name.toLowerCase()},${digest(candidate.id)},'preview-v1',${`https://www.paraform.com/candidate/${candidate.id}`},clock_timestamp(),${digest(candidate.name)},true)
      on conflict(candidate_user_id) do update set last_confirmed_at=clock_timestamp()`;
  }
  for(const role of ROLES) {
    await sql`insert into submissions_v2.role_index(role_id,company_name,role_title,search_key,active,destination_url,last_confirmed_at,source_digest)
      values (${role.id},${role.company},${role.title},${`${role.company} ${role.title}`.toLowerCase()},${role.active},${`https://www.paraform.com/browse?role=${role.id}`},clock_timestamp(),${digest(role.id)})
      on conflict(role_id) do update set last_confirmed_at=clock_timestamp()`;
  }
  const controls=(await sql`select * from submissions_v2.runtime_controls where singleton`)[0];
  const seeded=await sql`select 1 from preview.provider_state where key='initialized'`;
  if(!seeded.length) {
    await setRuntimeControls({actorEmail:'preview@raydar.test',reason:'Initialize isolated user-testing environment',ui:true,ingestion:true,generation:true,masterInbox:true,curated:true},sql);
    await sql`insert into preview.provider_state(key,value) values ('initialized','true'::jsonb)`;
  }
  return {candidates:CANDIDATES,roles:ROLES,controlEpoch:Number(controls.control_epoch)};
}

export function createScenarios({sql,service}) {
  async function setState(key,value,tx=sql) { await tx`insert into preview.provider_state(key,value) values (${key},${tx.json(value)}) on conflict(key) do update set value=excluded.value,updated_at=clock_timestamp()`; }
  async function state(key) { return (await sql`select value from preview.provider_state where key=${key}`)[0]?.value; }
  async function reply(scenario) {
    const candidate=CANDIDATES.find(item=>item.scenario===scenario);
    if(!candidate || scenario==='manual') throw Object.assign(new Error('Unknown reply scenario.'),{status:400,code:'preview_scenario_unknown'});
    let event=await state(`event:${candidate.id}`);
    if(!event) {
      const receivedAt=new Date().toISOString();
      event={id:`preview-reply-${candidate.id}`,eventKey:`preview:mailbox:message:${candidate.id}`,contractVersion:1,family:'new_match',mailboxId:'preview-mailbox',providerMessageId:`preview-message-${candidate.id}`,
        senderMatchHmac:{key_version:'preview-v1',digest:digest(candidate.id)},roleIds:scenario==='late_contract'?[]:['preview-platform'],
        payload:{receivedAt,candidateText:candidate.text,sentMessageText:scenario==='late_contract'?'':'Would you like the Platform Engineer role at Example Cloud?',
          senderDisplayName:candidate.name,sourceMessageId:`preview-source-${candidate.id}`,conversationId:`preview-conversation-${candidate.id}`,contentDigest:digest(candidate.text),
          parentRfcMessageId:`<preview-offer-${candidate.id}@raydar.test>`,bindingKind:'exact_outbound_parent_and_recipient'}};
      await setState(`event:${candidate.id}`,event);
    }
    if(scenario==='failure' && await state(`fail_resume:${candidate.id}`)===undefined) await setState(`fail_resume:${candidate.id}`,true);
    const accepted=await service.intakeMasterInbox(event);
    return {...accepted,scenario,candidate:candidate.name};
  }
  async function lateContract() {
    const event=await state('event:preview-dana');
    if(!event) throw Object.assign(new Error('Load the missing-contract reply first.'),{status:409,code:'preview_reply_required'});
    const contract={contractKey:'preview-offer-dana',contractVersion:1,family:'new_match',candidateId:'preview-dana',roleIds:['preview-platform'],producer:'preview-mailroom',producerVersion:'1',rfcMessageId:event.payload.parentRfcMessageId,sentAt:new Date(Date.parse(event.payload.receivedAt)-60_000).toISOString()};
    contract.payloadDigest=requestDigest(contract);
    const input={schemaVersion:1,enrichmentId:'preview-enrichment-dana-v1',eventKey:'preview:enrichment:dana:v1',semanticIdentity:{consumer:'submissions_v2',mailboxId:event.mailboxId,providerMessageId:event.providerMessageId},originalEventKey:event.eventKey,contract,reason:'late_outbound_contract',evidence:{bindingKind:event.payload.bindingKind,parentRfcMessageId:event.payload.parentRfcMessageId,senderMatchHmac:event.senderMatchHmac,originalContentDigest:event.payload.contentDigest,sourceMessageId:event.payload.sourceMessageId}};
    return service.intakeEnrichment(input);
  }
  async function enqueue(kind,pairId,key=randomUUID(),tx=sql) {
    const controls=(await tx`select control_epoch from submissions_v2.runtime_controls where singleton`)[0];
    const rows=await tx`insert into submissions_v2.jobs(kind,subject_type,subject_id,idempotency_key,required_control,control_epoch,checkpoint,priority)
      values (${kind},'pair',${pairId},${`preview:${kind}:${pairId}:${key}`},'ingestion',${controls.control_epoch},'{}'::jsonb,10) on conflict do nothing returning id`;
    return rows[0];
  }
  async function command(key,input,work) {
    return sql.begin(async tx=>{
      await tx`select pg_advisory_xact_lock(hashtextextended(${`preview-command:${key}`},0))`;
      const old=(await tx`select * from preview.command_receipts where key=${key}`)[0];
      const expected=requestDigest(input);
      if(old) {if(old.digest!==expected)throw Object.assign(new Error('The test command identity was reused with different content.'),{code:'preview_replay_conflict',status:409});return {...old.result,replay:true};}
      const result=await work(tx);
      await tx`insert into preview.command_receipts(key,digest,result) values (${key},${expected},${tx.json(result)})`;
      return result;
    });
  }
  return {reply,lateContract,setState,state,
    async starter() {const results=[];for(const scenario of ['positive','negative','question','late_contract','failure'])results.push(await reply(scenario));return {results};},
    async changeFailure(candidateId,enabled) {
      if(!CANDIDATES.some(item=>item.id===candidateId)) throw new Error('Unknown synthetic candidate.');
      await setState(`fail_resume:${candidateId}`,Boolean(enabled));return {candidateId,enabled:Boolean(enabled)};
    },
    async changeOriginal(candidateId,missing) {
      if(!CANDIDATES.some(item=>item.id===candidateId)) throw new Error('Unknown synthetic candidate.');
      await setState(`missing_original:${candidateId}`,Boolean(missing));return {candidateId,missing:Boolean(missing)};
    },
    async prove(pairId,idempotencyKey) {
      return command(idempotencyKey,{action:'prove',pairId},async tx=>{
      const pair=await service.pair(pairId);
      if(!pair?.pair?.candidate_id) throw new Error('Unknown test candidate-role pair.');
      const proof={candidateUserId:pair.pair.candidate_id,roleId:pair.pair.role_id,applicationId:`preview-application-${pairId}`,status:'SUBMITTED',submittedAt:new Date().toISOString()};
      await setState(`proof:${proof.candidateUserId}:${proof.roleId}`,proof,tx);
      await enqueue('proof_reconcile',pairId,idempotencyKey,tx);
      return {saved:true,proof,meaning:'A synthetic application was created in the test provider. The worker must still verify it.'};
      });
    },
    async setRoleActive(roleId,active,idempotencyKey) {
      return command(idempotencyKey,{action:'role',roleId,active},async tx=>{
      if(!ROLES.some(item=>item.id===roleId))throw new Error('Unknown synthetic role.');
      await tx`update submissions_v2.role_index set active=${Boolean(active)},last_confirmed_at=clock_timestamp() where role_id=${roleId}`;
      for(const pair of await tx`select id from submissions_v2.candidate_role_pairs where role_id=${roleId}`) await enqueue('recheck_pair',pair.id,idempotencyKey,tx);
      return {roleId,active:Boolean(active)};
      });
    },
  };
}
