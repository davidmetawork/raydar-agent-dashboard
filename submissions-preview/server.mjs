import { createServer } from 'node:http';
import {createHmac,randomUUID} from 'node:crypto';
import {readFile,writeFile,unlink,lstat} from 'node:fs/promises';
import {resolve,dirname,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {previewConfig,secretEqual,deniedNetwork} from './config.mjs';
import {createPreviewRuntime} from './runtime.mjs';
import {readRawBody,safeError} from '../api/submissions-v2/_lib/http.mjs';
import {CANDIDATES,ROLES} from './scenarios.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const ACTOR='preview@raydar.test';
const esc=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
function html(title,body) {return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><link rel="stylesheet" href="/submissions-v2.css"><link rel="stylesheet" href="/preview/style.css"></head><body><div class="preview-banner">ISOLATED TEST APP · Synthetic candidate data and simulated external providers</div><main class="shell preview-document"><a href="/">← Back to Submissions</a><h1>${esc(title)}</h1>${body}</main></body></html>`;}
function json(res,status,value) {res.writeHead(status,{'content-type':'application/json; charset=utf-8'});res.end(JSON.stringify(value));}
function failure(code,message,status=403) {throw Object.assign(new Error(message),{code,status});}
function present(result) {
  if(!result || typeof result!=='object')return result;
  if(result instanceof Date)return result.toISOString();
  if(Array.isArray(result))return result.map(present);
  const out=Object.fromEntries(Object.entries(result).map(([key,value])=>[key,present(value)]));
  if(out.candidate_id)out.candidate_url=`/preview/candidate?id=${encodeURIComponent(out.candidate_id)}`;
  if(out.role_id && out.role_url)out.role_url=`/preview/role?id=${encodeURIComponent(out.role_id)}`;
  if(out.signal_id) {out.signal_url=`/preview/source?id=${encodeURIComponent(out.signal_id)}`;if(out.admission_source)out.admission_source.url=out.signal_url;}
  if(typeof out.url==='string' && out.url.startsWith('https://www.paraform.com/'))out.url=`/preview/${out.company?'role':'candidate'}?id=${encodeURIComponent(out.id||out.role_id||'')}`;
  if(out.redirect_url && out.case_id)out.redirect_url=`/preview/paraform?case=${encodeURIComponent(out.case_id)}`;
  return out;
}

export async function startPreviewServer(input=process.env) {
  const config=await previewConfig(input),nativeFetch=globalThis.fetch;
  config.rendererOrigin='http://127.0.0.1:4526';
  config.fetchImpl=(value,options)=>{let url;try{url=new URL(typeof value==='string'?value:value.url);}catch{return deniedNetwork();}if(url.origin!==config.rendererOrigin)return deniedNetwork();return nativeFetch(value,{...options,redirect:'error'});};
  globalThis.fetch=config.fetchImpl;
  let runtime;
  try {runtime=await createPreviewRuntime(config);} catch(error){globalThis.fetch=nativeFetch;throw error;}
  const token=createHmac('sha256',config.keys.session).update('preview-session-v1').digest('base64url');
  const csrf=createHmac('sha256',config.keys.session).update('preview-csrf-v1').digest('base64url');
  function session(req) {return String(req.headers.cookie||'').split(';').some(item=>secretEqual(item.trim(),`raydar_preview=${token}`));}
  function requireSession(req,{mutation=false}={}) {
    if(!session(req))failure('preview_session_required','Open the test app before using its API.',401);
    if(mutation && (req.headers.origin!==config.origin || !secretEqual(req.headers['x-raydar-csrf'],csrf)))failure('preview_csrf_required','This test action requires the app session and same-origin confirmation.');
  }
  async function body(req) {const raw=await readRawBody(req,250_000);try{return JSON.parse(raw||'{}');}catch{failure('invalid_json','The request body is not valid JSON.',400);}}
  function idempotency(req) {const key=String(req.headers['idempotency-key']||'');if(!/^[A-Za-z0-9._:-]{8,200}$/.test(key))failure('idempotency_key_required','A command identity is required.',400);return key;}
  async function machine(req,url,kind) {
    const raw=req.method==='GET'?url.searchParams.get('kind')||'':await readRawBody(req,250_000);
    const timestamp=req.headers['x-raydar-timestamp'],eventId=req.headers['x-raydar-event-id'],signature=req.headers['x-raydar-signature'];
    const scope=kind==='receipt'?'submissions.receipt.v1':kind==='enrichment'?'submissions.email_reply.enrichment.v1':'submissions.email_reply.v1';
    const expected=createHmac('sha256',config.keys.ingest).update(`${scope}\n${timestamp}\n${eventId}\n${raw}`).digest('base64url');
    if(!eventId||!Number.isFinite(Date.parse(timestamp))||Math.abs(Date.now()-Date.parse(timestamp))>300_000||!secretEqual(signature,expected))failure('machine_signature_invalid','Machine signature validation failed.',401);
    if(kind==='receipt') {if(eventId!==url.searchParams.get('eventId'))failure('event_identity_mismatch','Receipt identity mismatch.',400);return runtime.service.intakeReceipt(raw,eventId);}
    let input;try{input=JSON.parse(raw);}catch{failure('invalid_json','Invalid intake JSON.',400);}
    if(eventId!==(kind==='enrichment'?input.enrichmentId:input.id||input.event_id))failure('event_identity_mismatch','Event identity mismatch.',400);
    if(idempotency(req)!==(input.eventKey||input.idempotency_key))failure('event_identity_mismatch','Idempotency identity mismatch.',400);
    return kind==='enrichment'?runtime.service.intakeEnrichment(input):runtime.service.intakeMasterInbox(input);
  }
  const server=createServer(async(req,res)=>{
    res.setHeader('Cache-Control','private, no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
    try {
      if(req.headers.host!==`127.0.0.1:${config.port}`)failure('preview_host_invalid','Use the exact loopback test URL.');
      const url=new URL(req.url,config.origin),path=url.pathname;
      const query=Object.fromEntries(url.searchParams);
      if(path==='/live')return json(res,200,{ok:true,test_environment:true});
      const intake={'/api/submissions-v2/intake/master-inbox':'reply','/api/submissions-v2/intake/master-inbox-enrichment':'enrichment','/api/submissions-v2/intake/receipt':'receipt'}[path];
      if(intake) {if(req.method!==(intake==='receipt'?'GET':'POST'))failure('method_not_allowed','Invalid method.',405);return json(res,intake==='receipt'?200:202,{ok:true,...await machine(req,url,intake)});}
      if(path==='/'||path==='/submissions-v2') {
        if(req.method!=='GET')failure('method_not_allowed','Invalid method.',405);
        if(req.headers['sec-fetch-site']==='cross-site')failure('preview_cross_site','Open the loopback test URL directly.');
        res.setHeader('Set-Cookie',`raydar_preview=${token}; Path=/; HttpOnly; SameSite=Strict`);
        let page=await readFile(resolve(root,'submissions-v2.html'),'utf8');
        page=page.replace(/\s*<link[^>]*rel="icon"[^>]*>/u,'').replace(/\s*<script src="\/auth-session.js"><\/script>/u,'').replace(/\s*<script src="https:\/\/accounts.google.com[^>]*><\/script>/u,'')
          .replace('<body>','<body><div class="preview-banner">ISOLATED TEST APP · Synthetic candidate data and simulated providers</div><div id="preview-controls"></div>')
          .replace('</head>','<link rel="stylesheet" href="/preview/style.css"></head>').replace('</body>','<script type="module" src="/preview/panel.js"></script></body>');
        res.setHeader('content-type','text/html; charset=utf-8');return res.end(page);
      }
      const staticFiles={'/submissions-v2.js':'submissions-v2.js','/submissions-v2.css':'submissions-v2.css','/submissions-v2-ui-state.mjs':'submissions-v2-ui-state.mjs','/preview/panel.js':'submissions-preview/panel.js','/preview/style.css':'submissions-preview/style.css'};
      if(staticFiles[path]||path.startsWith('/fonts/')) {
        if(req.method!=='GET')failure('method_not_allowed','Invalid method.',405);
        const file=resolve(root,staticFiles[path]||path.slice(1));
        if(!file.startsWith(root+sep))failure('path_invalid','Invalid asset.',400);
        let data=await readFile(file);
        if(path==='/submissions-v2.js')data=Buffer.from(data.toString().replace('}, 30_000);','}, 2_000);').replace('if (typeof pickerHost.showSaveFilePicker === "function")', 'if (false /* Preview uses the secure PDF viewer. */)').replaceAll('https://www.paraform.com/candidates','/preview/candidates'));
        res.setHeader('content-type',path.endsWith('.css')?'text/css':path.endsWith('.woff2')?'font/woff2':path.endsWith('.otf')?'font/otf':'text/javascript');return res.end(data);
      }
      requireSession(req,{mutation:req.method!=='GET'});
      if(path==='/api/auth/config')return json(res,200,{googleClientId:'isolated-preview',durableSessionEnabled:true});
      if(path==='/api/submissions-v2/session')return json(res,200,{ok:true,authenticated:true,identity:{email:ACTOR},csrf_token:csrf,controls:{ui:true,ingestion:true,generation:true,master_inbox:true,curated:true},test_environment:true});
      if(path==='/preview/status')return json(res,200,{ok:true,...await runtime.status()});
      if(path==='/preview/candidates') {
        res.setHeader('content-type','text/html; charset=utf-8');
        return res.end(html('Synthetic candidate directory',`<p>Choose these names in Add Candidate. Every profile here is synthetic.</p><ul>${CANDIDATES.map(candidate=>`<li><a href="/preview/candidate?id=${encodeURIComponent(candidate.id)}">${esc(candidate.name)}</a></li>`).join('')}</ul>`));
      }
      if(path==='/preview/scenario') {
        if(req.method!=='POST')failure('method_not_allowed','Use POST.',405);const commandId=idempotency(req);const input=await body(req);let result;
        if(input.action==='starter')result=await runtime.scenarios.starter();
        else if(input.action==='late_contract')result=await runtime.scenarios.lateContract();
        else if(input.action==='reply')result=await runtime.scenarios.reply(input.scenario);
        else if(input.action==='failure')result=await runtime.scenarios.changeFailure(input.candidate_id,input.enabled);
        else if(input.action==='original')result=await runtime.scenarios.changeOriginal(input.candidate_id,input.missing);
        else if(input.action==='pause') {await runtime.scenarios.setState('worker_paused',Boolean(input.enabled));result={paused:Boolean(input.enabled)};}
        else if(input.action==='role')result=await runtime.scenarios.setRoleActive(input.role_id,input.active,commandId);
        else failure('scenario_unknown','Unknown test action.',400);
        return json(res,200,{ok:true,...result});
      }
      if(path==='/preview/prove') {if(req.method!=='POST')failure('method_not_allowed','Use POST.',405);return json(res,200,{ok:true,...await runtime.scenarios.prove((await body(req)).case_id,idempotency(req))});}
      if(path==='/preview/paraform') {
        const {pair}=await runtime.service.pair(query.case);
        res.setHeader('content-type','text/html; charset=utf-8');return res.end(html('Simulated Paraform application',`<p><strong>${esc(pair.candidate_name)}</strong> · ${esc(pair.company)} · ${esc(pair.role_title)}</p><p>Opening this page records an open event only. Create a test application below to let the worker observe exact application proof.</p><button class="button primary" id="preview-submit" data-case="${esc(query.case)}">Create test application</button><p id="preview-result" role="status"></p><script type="module" src="/preview/panel.js"></script>`));
      }
      if(path==='/preview/candidate'||path==='/preview/role') {
        const record=(path.endsWith('candidate')?CANDIDATES:ROLES).find(item=>item.id===query.id);
        if(!record)failure('preview_record_not_found','Synthetic record not found.',404);
        res.setHeader('content-type','text/html; charset=utf-8');return res.end(html(record.name||record.title,`<p>This is a synthetic ${path.endsWith('candidate')?'candidate':'role'} profile for testing.</p><p>${esc(record.company||record.text)}</p>`));
      }
      if(path==='/preview/source') {
        const source=await runtime.repository.source(query.id);if(!source)failure('source_not_found','Source not found.',404);
        const candidate=CANDIDATES.find(item=>source.provider_message_id===`preview-message-${item.id}`);
        res.setHeader('content-type','text/html; charset=utf-8');return res.end(html('Test source message',`<p>${esc(candidate?.name||'Recruiter action')}</p><blockquote>${esc(candidate?.text||'An authenticated test recruiter added this candidate.')}</blockquote><p>Message state: ${esc(source.processing_state)}</p>`));
      }
      const prefix='/api/submissions-v2/';
      if(path.startsWith(prefix)) {
        const key=path.slice(prefix.length),svc=runtime.service;
        if(['list','counts','health','review-context'].includes(key)) {
          if(req.method!=='GET')failure('method_not_allowed','Use GET.',405);
          const result=key==='list'?await svc.list(query):key==='counts'?await svc.counts():key==='health'?await svc.health():await svc.reviewContext(query);
          return json(res,200,{ok:true,...present(result)});
        }
        if(key.startsWith('search/'))return json(res,200,{ok:true,...present(await svc.search(key.slice(7),query))});
        if(key==='command') {if(req.method!=='POST')failure('method_not_allowed','Use POST.',405);return json(res,200,{ok:true,...present(await svc.command({actorEmail:ACTOR,idempotencyKey:idempotency(req),body:await body(req)}))});}
        if(key==='download') {
          const result=await svc.download({actorEmail:ACTOR,ticket:query.ticket});res.setHeader('content-type',result.content_type);res.setHeader('content-disposition',`inline; filename="${result.filename.replace(/["\\]/g,'_')}"`);return res.end(result.bytes);
        }
        const match=key.match(/^pairs\/([^/]+)(?:\/(jobs|resume\/download-ticket|submit-open))?$/);
        if(match) {
          if(!match[2])return json(res,200,{ok:true,...present(await svc.pair(match[1]))});
          if(match[2]==='jobs')return json(res,200,{ok:true,...await svc.jobs({pair_id:match[1]})});
          if(req.method!=='POST')failure('method_not_allowed','Use POST.',405);
          const args={actorEmail:ACTOR,idempotencyKey:idempotency(req),pairId:match[1],body:await body(req)};
          return json(res,200,{ok:true,...present(await (match[2]==='submit-open'?svc.openSubmit(args):svc.issueDownload(args)))});
        }
      }
      failure('not_found','Page not found.',404);
    }catch(error){const safe=safeError(error);return json(res,safe.status,safe.body);}
  });
  return finishPreviewStartup({server,runtime,config,nativeFetch});
}
export async function finishPreviewStartup({server,runtime,config,nativeFetch}) {
  const pidPath=resolve(config.stateRoot,'preview.pid');
  let ownsPid=false,closePromise=null;
  const stopListening=()=>server.listening
    ? new Promise((resolveClose,rejectClose)=>server.close(error=>error?rejectClose(error):resolveClose()))
    : Promise.resolve();
  const cleanup=async({suppressErrors=false}={})=>{
    const failures=[];
    try{await stopListening();}catch(error){failures.push(error);}
    try{await runtime.close();}catch(error){failures.push(error);}
    globalThis.fetch=nativeFetch;
    if(ownsPid)try{await unlink(pidPath);}catch(error){if(error?.code!=='ENOENT')failures.push(error);}
    if(!suppressErrors && failures.length)throw failures[0];
  };
  try {
    await new Promise((resolveListen,rejectListen)=>{server.once('error',rejectListen);server.listen(config.port,'127.0.0.1',resolveListen);});
    try{if((await lstat(pidPath)).isSymbolicLink())throw new Error('Preview PID file cannot be a symbolic link.');}catch(error){if(error.code!=='ENOENT')throw error;}
    await writeFile(pidPath,String(process.pid),{mode:0o600});ownsPid=true;
    runtime.start();
  } catch(error) {
    await cleanup({suppressErrors:true});
    throw error;
  }
  const close=()=>closePromise??=(cleanup());
  return {server,runtime,config,close};
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const app=await startPreviewServer();
  console.log(`Submissions test app: ${app.config.origin} (synthetic providers; isolated database)`);
  let closing=false;
  for(const signal of ['SIGINT','SIGTERM'])process.on(signal,async()=>{if(closing)return;closing=true;await app.close();process.exit(0);});
}
