import { createHash } from 'node:crypto';
import { EMAIL_FAMILIES } from './contracts.mjs';

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
export const requestDigest = value => createHash('sha256').update(canonicalJson(value)).digest('hex');
const fail = (code, message, status=409) => { throw Object.assign(new Error(message), {code,status}); };
const bounded = (value, length=500) => typeof value === 'string' && value.length > 0 && value.length <= length;
const sameOrderedRoleIds = (left, right) => left.length === right.length && left.every((value, index) => value === right[index]);

export function validateEnrichment(input) {
  const identity=input?.semanticIdentity, contract=input?.contract, evidence=input?.evidence;
  if (input?.schemaVersion !== 1 || input?.reason !== 'late_outbound_contract'
    || !bounded(input.enrichmentId,200) || !bounded(input.eventKey) || !bounded(input.originalEventKey)
    || identity?.consumer !== 'submissions_v2' || !bounded(identity.mailboxId,200) || !bounded(identity.providerMessageId)
    || contract?.contractVersion !== 1 || !bounded(contract.contractKey) || !EMAIL_FAMILIES.has(contract.family)
    || !bounded(contract.candidateId,200) || !bounded(contract.producer,100) || !bounded(contract.producerVersion,100)
    || !/^[a-f0-9]{64}$/.test(contract.payloadDigest || '') || !bounded(contract.rfcMessageId)
    || !Number.isFinite(Date.parse(contract.sentAt)) || !Array.isArray(contract.roleIds) || !contract.roleIds.length || contract.roleIds.length>20
    || contract.roleIds.some(id => !bounded(id,200)) || new Set(contract.roleIds).size!==contract.roleIds.length
    || evidence?.bindingKind !== 'exact_outbound_parent_and_recipient' || evidence.parentRfcMessageId !== contract.rfcMessageId
    || !bounded(evidence.sourceMessageId,1000) || !bounded(evidence.senderMatchHmac?.key_version,100)
    || !bounded(evidence.senderMatchHmac?.digest) || !/^[a-f0-9]{64}$/.test(evidence.originalContentDigest || '')) {
    fail('enrichment_contract_invalid','The enrichment contract or exact ancestry evidence is incomplete.',400);
  }
  return input;
}

export function createEnrichmentRepository({sql,reserveFirstResponse,enqueue,pairAdvisoryLockKey}) {
  const getReceipt = async (kind,eventId,tx=sql) => (await tx`select * from submissions_v2.intake_receipts where kind=${kind} and event_id=${eventId}`)[0] || null;
  const saveReceipt = async ({kind,eventId,digest,result},tx=sql) => {
    await tx`insert into submissions_v2.intake_receipts(kind,event_id,request_digest,result) values (${kind},${eventId},${digest},${tx.json(result)}) on conflict do nothing`;
    const row=await getReceipt(kind,eventId,tx);
    if (row.request_digest!==digest) fail('intake_replay_conflict','The intake identity was already used with different content.');
    return row;
  };
  return {
    intakeReceipt: getReceipt,
    async reserveIntakeRequest({eventId,mailboxId,providerMessageId,digest}) {
      return sql.begin(async tx=>{
        await tx`insert into submissions_v2.intake_request_guards(event_id,mailbox_id,provider_message_id,request_digest) values (${eventId},${mailboxId},${providerMessageId},${digest}) on conflict do nothing`;
        const rows=await tx`select * from submissions_v2.intake_request_guards where event_id=${eventId} or (mailbox_id=${mailboxId} and provider_message_id=${providerMessageId})`;
        if(rows.length!==1 || rows[0].event_id!==eventId || rows[0].mailbox_id!==mailboxId || rows[0].provider_message_id!==providerMessageId || rows[0].request_digest!==digest) fail('intake_replay_conflict','The source identity was already reserved with different content.');
        return rows[0];
      });
    },
    recordIntakeReceipt: input => sql.begin(tx=>saveReceipt(input,tx)),
    async applySourceEnrichment(input) {
      validateEnrichment(input);
      const digest=requestDigest(input), {semanticIdentity:identity,contract,evidence}=input;
      return sql.begin(async tx=>{
        await tx`insert into submissions_v2.enrichment_request_keys(event_key,enrichment_id,request_digest)
          values (${input.eventKey},${input.enrichmentId},${digest}) on conflict do nothing`;
        const identities=await tx`select * from submissions_v2.enrichment_request_keys where event_key=${input.eventKey} or enrichment_id=${input.enrichmentId}`;
        if(identities.length!==1 || identities[0].event_key!==input.eventKey || identities[0].enrichment_id!==input.enrichmentId || identities[0].request_digest!==digest) {
          fail('intake_replay_conflict','The enrichment transport identity was already used with different content.');
        }
        await tx`select pg_advisory_xact_lock(hashtextextended(${`enrichment:${input.enrichmentId}`},0))`;
        const receipt=await getReceipt('enrichment',input.enrichmentId,tx);
        if(receipt) {
          if(receipt.request_digest!==digest) fail('intake_replay_conflict','The enrichment identity was already used with different content.');
          return {...receipt.result,existing:true};
        }
        const source=(await tx`select * from submissions_v2.source_events where source_family='email' and mailbox_id=${identity.mailboxId} and provider_message_id=${identity.providerMessageId} for update`)[0];
        if(!source) fail('enrichment_source_not_found','The original source has not been accepted.',404);
        const original=source.envelope || {};
        const originalRoleIds=Array.isArray(original.offered_roles)
          ? original.offered_roles.map(role=>String(role?.role_id||'').trim()).filter(Boolean)
          : [];
        if(source.idempotency_key!==input.originalEventKey || source.content_digest!==evidence.originalContentDigest
          || original.sender_match_hmac?.digest!==evidence.senderMatchHmac.digest
          || original.sender_match_hmac?.key_version!==evidence.senderMatchHmac.key_version
          || original.raw_record_ref!==evidence.sourceMessageId
          || !original.parent_rfc_message_id || original.parent_rfc_message_id!==evidence.parentRfcMessageId
          || contract.family!==original.source_family || Date.parse(contract.sentAt)>Date.parse(source.received_at)) {
          fail('enrichment_evidence_mismatch','The enrichment does not match the immutable original message evidence.');
        }
        if(originalRoleIds.length && !sameOrderedRoleIds(originalRoleIds,contract.roleIds)) {
          fail('enrichment_original_offer_mismatch','The late contract cannot replace the original offered-role order.');
        }
        const candidates=await tx`select * from submissions_v2.candidate_index where active and (email_match_hmac_current=${evidence.senderMatchHmac.digest} or email_match_hmac_previous=${evidence.senderMatchHmac.digest}) order by candidate_user_id for share`;
        const called=candidates.filter(row=>row.has_recorded_call);
        const candidate=candidates.length===1?candidates[0]:called.length===1?called[0]:null;
        if(candidate?.candidate_user_id!==contract.candidateId) fail('enrichment_candidate_mismatch','The original sender does not uniquely resolve to the contract candidate.');
        const roles=await tx`select * from submissions_v2.role_index where active and role_id=any(${tx.array(contract.roleIds,25)}) for share`;
        if(roles.length!==contract.roleIds.length) fail('enrichment_role_unavailable','Every contract role must be active in the current role index.');
        const prior=await tx`select 1 from submissions_v2.signal_role_decisions where signal_id=${source.id} union all select 1 from submissions_v2.pair_signal_links where signal_id=${source.id} limit 1`;
        const eligible=['needs_role','needs_candidate'].includes(source.processing_state) && !prior.length;
        let disposition=eligible?'queued':'already_settled',job=null;
        if(eligible) {
          const roleIds=[];
          // Lock exact pairs in a stable order, but preserve the original offer order.
          for(const roleId of [...contract.roleIds].sort()) await tx`select pg_advisory_xact_lock(hashtextextended(${pairAdvisoryLockKey(contract.candidateId,roleId)},0))`;
          for(const [order,roleId] of contract.roleIds.entries()) {
            const claim=await reserveFirstResponse(tx,{candidateId:contract.candidateId,roleId,eventId:source.event_id,sourceFamily:'email'});
            if(!claim) continue;
            const role=roles.find(row=>row.role_id===roleId);
            await tx`insert into submissions_v2.source_offered_roles(signal_id,role_id,company_snapshot,role_label_snapshot,role_url_snapshot,offered_order,content_digest) values (${source.id},${roleId},${role.company_name},${role.role_title},${role.destination_url},${order},${contract.payloadDigest}) on conflict do nothing`;
            await tx`update submissions_v2.first_response_claims set signal_id=${source.id},committed_at=coalesce(committed_at,clock_timestamp()) where id=${claim.id} and released_at is null`;
            roleIds.push(roleId);
          }
          disposition=roleIds.length?'queued':'ignored_later';
          await tx`update submissions_v2.source_events set processing_state=${roleIds.length?'ready':'ignored_later'},safe_error_code=null,safe_error_detail=null,processed_at=${roleIds.length?null:new Date()} where id=${source.id}`;
          await tx`update submissions_v2.review_items set action_state='resolved',resolved_at=clock_timestamp(),resolved_by='inbox-contract',resolution_note='Exact outbound contract arrived after the reply.' where unresolved_signal_id=${source.id} and action_state='open'`;
          if(roleIds.length) job=await enqueue(tx,{kind:'classify_email_reply',subjectType:'signal',subjectId:source.id,idempotencyKey:`enrichment:${source.id}`,requiredControl:'master_inbox',priority:20,checkpoint:{signal_id:source.id,candidate_id:contract.candidateId,role_ids:roleIds}});
        }
        const safeEvidence={bindingKind:evidence.bindingKind,parentRfcMessageId:evidence.parentRfcMessageId,originalContentDigest:evidence.originalContentDigest,sourceMessageId:evidence.sourceMessageId,senderMatchHmac:evidence.senderMatchHmac,producer:contract.producer,producerVersion:contract.producerVersion,sentAt:contract.sentAt};
        await tx`insert into submissions_v2.source_enrichments(enrichment_id,signal_id,request_digest,contract_key,contract_digest,candidate_user_id,ordered_role_ids,evidence,disposition) values (${input.enrichmentId},${source.id},${digest},${contract.contractKey},${contract.payloadDigest},${contract.candidateId},${tx.json(contract.roleIds)},${tx.json(safeEvidence)},${disposition})`;
        const result={accepted:true,existing:false,signal_id:source.id,disposition,queued:Boolean(job),job_id:job?.id||null};
        await saveReceipt({kind:'enrichment',eventId:input.enrichmentId,digest,result},tx);
        return result;
      });
    }
  };
}
