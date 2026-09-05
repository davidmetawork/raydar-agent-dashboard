import {randomUUID} from 'node:crypto';
import {MARKER} from './config.mjs';
import { createDatabase,readRuntimeControls,claimJobs,checkpointJob,completeJob,failJob,heartbeatJob } from '../api/submissions-v2/_lib/db.mjs';
import { createRepository } from '../api/submissions-v2/_lib/repository.mjs';
import { createService } from '../api/submissions-v2/_lib/service.mjs';
import { createResumePipelineStore } from '../api/submissions-v2/_lib/resume/pipeline-store.mjs';
import { runMigrations } from '../scripts/migrate-submissions-v2.mjs';
import { createWorkerHandlers } from '../submissions-v2-worker/worker-handlers.mjs';
import { runWorkerCycleWithProgress } from '../submissions-v2-worker/runner.mjs';
import { createWorkerProgressStore } from '../submissions-v2-worker/worker-progress.mjs';
import { createLocalPrivateStorage } from './storage.mjs';
import { createPreviewProviders } from './providers.mjs';
import { initializePreviewData,createScenarios } from './scenarios.mjs';

export async function createPreviewRuntime(config) {
  const target=new URL(config.databaseUrl);
  if(config.marker!==MARKER || !['postgres:','postgresql:'].includes(target.protocol) || target.hostname!=='127.0.0.1' || target.port!=='55439' || target.username!=='submissions_dev' || !['/submissions_preview','/submissions_preview_pipeline_test'].includes(target.pathname) || target.search || target.hash) throw new Error('The preview runtime refuses an unrecognized database.');
  const probe=createDatabase({databaseUrl:config.databaseUrl,max:1});
  try {
    const exists=(await probe`select to_regclass('preview.environment') as marker,to_regnamespace('submissions_v2') as app_schema,to_regnamespace('preview') as preview_schema`)[0];
    if(exists.marker) {if((await probe`select marker from preview.environment where singleton`)[0]?.marker!==MARKER)throw new Error('Preview database marker mismatch.');}
    else if(exists.app_schema || exists.preview_schema) throw new Error('Preview startup refuses an existing unmarked application schema.');
    else {
      await probe.unsafe('create schema preview; create table preview.environment(singleton boolean primary key default true check(singleton),marker text not null,created_at timestamptz not null default clock_timestamp());');
      await probe`insert into preview.environment(marker) values (${MARKER})`;
    }
  } finally {await probe.end({timeout:5});}
  await runMigrations({databaseUrl:config.databaseUrl,logger:{info(){}}});
  const sql=createDatabase({databaseUrl:config.databaseUrl,max:8});
  await initializePreviewData({sql});
  const blobs=createLocalPrivateStorage(config.stateRoot);
  const providers=await createPreviewProviders({sql,env:config.env,blobs,config});
  const repository=createRepository({sql,env:config.env});
  const service=createService({repository,env:config.env,blob:blobs,classifier:providers.classifier,fetchImpl:config.fetchImpl});
  const resumeStore=createResumePipelineStore({sql,repository,blobs,env:config.env});
  const handlers=createWorkerHandlers({sql,env:config.env,repository,service,resumeStore,...providers,fetchImpl:config.fetchImpl});
  const workerId=`preview-worker-${randomUUID()}`;
  const progress=createWorkerProgressStore({sql,workerKey:'submissions-preview',workerId});
  const scenarios=createScenarios({sql,service});
  const allowedHandlers=['classify_email_reply','prepare_resume','recheck_pair','proof_reconcile','deliver_notification'];
  for(const kind of Object.keys(handlers)) if(!allowedHandlers.includes(kind)) handlers[kind]=async()=>{throw Object.assign(new Error('This provider scan is outside the isolated preview.'),{code:'preview_provider_scan_disabled',retryable:false});};
  const options={workerId,env:config.env,handlers,limit:1,readRuntimeControls:()=>readRuntimeControls(sql),
    claimJobs:input=>claimJobs(input,sql),checkpointJob:input=>checkpointJob(input,sql),completeJob:input=>completeJob(input,sql),failJob:input=>failJob(input,sql),heartbeatJob:input=>heartbeatJob(input,sql)};
  let running=null,closed=false,timer=null,lastResult=null;
  async function cycle() {
    if(closed || running || await scenarios.state('worker_paused')===true) return lastResult;
    running=runWorkerCycleWithProgress(options,{progress});
    try { lastResult=await running;return lastResult; }
    finally {running=null;}
  }
  async function status() {
    const ready=await progress.readReadiness({enabledKinds:allowedHandlers});
    const counts=await service.counts();
    const rows=await sql`select kind,state,count(*)::integer as count from submissions_v2.jobs group by kind,state order by kind,state`;
    return {test_environment:true,provider_mode:'synthetic',worker_paused:await scenarios.state('worker_paused')===true,worker:ready,counts:counts.counts,jobs:rows,last_result:lastResult};
  }
  function start() {timer=setInterval(()=>cycle().catch(error=>{lastResult={ok:false,error:error.code||'preview_worker_failed'};}),1000);timer.unref();}
  async function close() {closed=true;if(timer)clearInterval(timer);await running?.catch(()=>{});await providers.close?.();await sql.end({timeout:5});}
  return {sql,service,repository,blobs,providers,resumeStore,scenarios,cycle,status,start,close};
}
