import { createHash, randomUUID } from "node:crypto";

import { evaluateRule, inScope } from "./rules.mjs";
import { ruleSubjectFromApplicantV2 } from "./rule-run-v2.mjs";

export const PAGED_RULE_PREVIEW_COMMAND_VERSION="applicant-monitor-paged-rule-preview-command-v1";
export const PAGED_RULE_RUN_COMMAND_VERSION="applicant-monitor-paged-rule-run-command-v1";
export const PAGED_RULE_EVALUATOR_REQUEST_VERSION="applicant-core-paged-rule-evaluator-request-v1";
export const PAGED_RULE_EVALUATOR_RESPONSE_VERSION="applicant-monitor-paged-rule-evaluator-response-v1";
export const PAGED_RULE_EVALUATOR_VERSION="raydar-monitor-applicant-rules-v1";
export const PAGED_RULE_EVALUATOR_BATCH_MAX=500;
const SHA=/^[a-f0-9]{64}$/u,UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const canonical=value=>value===null||typeof value!=="object"?value:Array.isArray(value)?value.map(canonical):Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])]));
export const pagedRuleDigest=value=>createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
const withoutDigest=source=>Object.fromEntries(Object.entries(source).filter(([key])=>key!=="commandDigest"));
const ruleVersions=rules=>rules.map(rule=>({id:String(rule.id),version:Number(rule.version||1)})).sort((a,b)=>a.id.localeCompare(b.id)||a.version-b.version);

export function buildPagedRulePreviewCommand({operationId=randomUUID(),authorizerId,authenticatedAt,evaluatedAt=authenticatedAt,generation,rules}={}){
  if(!UUID.test(operationId)||!authorizerId||!Number.isFinite(Date.parse(authenticatedAt||""))||!Number.isFinite(Date.parse(evaluatedAt||""))
    ||!UUID.test(generation?.generationId||"")||!SHA.test(generation?.digest||"")||!Number.isSafeInteger(Number(generation?.sequence))||generation.sequence<1
    ||!Array.isArray(rules)||!rules.length||rules.length>512)throw new Error("paged_rule_preview_command_invalid");
  const versions=ruleVersions(rules),scope={kind:"review_pending_all"};
  const command={version:PAGED_RULE_PREVIEW_COMMAND_VERSION,operationId:operationId.toLowerCase(),trigger:"manual_preview",
    authorizerId:String(authorizerId).trim().toLowerCase(),authenticatedAt:new Date(authenticatedAt).toISOString(),evaluatedAt:new Date(evaluatedAt).toISOString(),
    generationId:generation.generationId.toLowerCase(),generationDigest:generation.digest.toLowerCase(),generationSequence:Number(generation.sequence),
    evaluatorVersion:PAGED_RULE_EVALUATOR_VERSION,rulesetDigest:pagedRuleDigest(rules),ruleVersions:versions,ruleVersionsDigest:pagedRuleDigest(versions),
    rules,scope,scopeDigest:pagedRuleDigest(scope)};
  return Object.freeze({...command,commandDigest:pagedRuleDigest(command)});
}

export function buildPagedRuleRunCommand({runId=randomUUID(),preview,authorizerId,authenticatedAt}={}){
  if(!UUID.test(runId)||!String(authorizerId||"").trim()||preview?.state!=="ready"||!UUID.test(preview?.id||"")||!SHA.test(preview?.resultDigest||"")
    ||!SHA.test(preview?.rulesetDigest||"")||!UUID.test(preview?.generationId||"")||!SHA.test(preview?.generationDigest||"")
    ||!Number.isSafeInteger(Number(preview?.generationSequence))||!Number.isFinite(Date.parse(authenticatedAt||"")))throw new Error("paged_rule_run_command_invalid");
  const command={version:PAGED_RULE_RUN_COMMAND_VERSION,operationId:runId.toLowerCase(),trigger:"run_rules_now",previewId:preview.id.toLowerCase(),
    previewResultDigest:preview.resultDigest.toLowerCase(),authorizerId:String(authorizerId).trim().toLowerCase(),authenticatedAt:new Date(authenticatedAt).toISOString(),
    generationId:preview.generationId.toLowerCase(),generationDigest:preview.generationDigest.toLowerCase(),generationSequence:Number(preview.generationSequence),
    evaluatorVersion:PAGED_RULE_EVALUATOR_VERSION,rulesetDigest:preview.rulesetDigest.toLowerCase()};
  return Object.freeze({...command,commandDigest:pagedRuleDigest(command)});
}

function decide(rules,subject,now){
  const live=rules.filter(rule=>rule.state==="live"),watching=rules.filter(rule=>rule.state==="watching"),matches=[],watchingMatches=[],skips=[];
  for(const rule of live){if(!inScope(rule,subject.row))continue;const result=evaluateRule(rule,subject,{now});if(result.matched)matches.push({rule,evidence:result.evidence});else if(result.skipped)skips.push(result.reason);}
  for(const rule of watching){if(!inScope(rule,subject.row))continue;const result=evaluateRule(rule,subject,{now});if(result.matched)watchingMatches.push({ruleId:rule.id,ruleVersion:rule.version||1,evidence:result.evidence});else if(result.skipped)skips.push(result.reason);}
  const winner=matches.find(item=>item.rule.action==="pass")||matches[0]||null;
  return winner?{outcome:winner.rule.action,ruleId:winner.rule.id,ruleVersion:winner.rule.version||1,evidence:{winner:winner.evidence,alsoMatched:matches.filter(item=>item!==winner).map(item=>({ruleId:item.rule.id,ruleVersion:item.rule.version||1,action:item.rule.action})),watchingMatches},skipReason:null}
    :{outcome:"no_match",ruleId:null,ruleVersion:null,evidence:{watchingMatches},skipReason:skips[0]||null};
}

export function evaluatePagedRulePage(request,{fundedEmployerSnapshots={}}={}){
  if(request?.version!==PAGED_RULE_EVALUATOR_REQUEST_VERSION||request.evaluatorVersion!==PAGED_RULE_EVALUATOR_VERSION
    ||!UUID.test(request.previewId||"")||!Number.isSafeInteger(Number(request.batchNumber))||request.batchNumber<1
    ||!SHA.test(request.rulesetDigest||"")||pagedRuleDigest(request.rules)!==request.rulesetDigest||!Array.isArray(request.items)
    ||!request.items.length||request.items.length>PAGED_RULE_EVALUATOR_BATCH_MAX)throw new Error("paged_rule_evaluator_request_invalid");
  const requestDigest=pagedRuleDigest(request),clock=Date.parse(request.evaluatedAt);if(!Number.isFinite(clock))throw new Error("paged_rule_evaluator_request_invalid");
  const items=request.items.map(item=>{
    if(item.projectionUnavailableReason!=null&&item.projectionUnavailableReason!=="profile_v2_fact_set_unavailable"){
      throw new Error("paged_rule_evaluator_request_invalid");
    }
    const authority={applicationId:item.applicationId,rowVersionId:item.rowVersionId,rowRevision:Number(item.rowRevision),monitorKey:item.monitorKey,
      inputRevision:item.inputRevision,readinessRevision:item.readinessRevision??null,
      factSetDigest:item.factSetDigest,decisionRevision:Number(item.decisionRevision)};
    if(item.projectionUnavailableReason)return {...authority,outcome:"no_match",ruleId:null,ruleVersion:null,
      evidence:{watchingMatches:[]},skipReason:item.projectionUnavailableReason};
    const row=item.row||{...item.indexPayload,key:item.monitorKey,inputRevision:item.inputRevision,decisionRevision:Number(item.decisionRevision)};
    const base=ruleSubjectFromApplicantV2(row,item.projection,{now:clock});
    const subject=base?{...base,fundedEmployerSnapshots}:null;
    const result=subject?decide(request.rules,subject,clock):{outcome:"no_match",ruleId:null,ruleVersion:null,evidence:{},skipReason:"profile_v2_fact_set_missing"};
    return {...authority,...result};
  });
  const material={version:PAGED_RULE_EVALUATOR_RESPONSE_VERSION,previewId:request.previewId,batchNumber:Number(request.batchNumber),requestDigest,items};
  return Object.freeze({...material,responseDigest:pagedRuleDigest(material)});
}

export function verifyPagedRuleCommand(command){return command?.commandDigest===pagedRuleDigest(withoutDigest(command));}
