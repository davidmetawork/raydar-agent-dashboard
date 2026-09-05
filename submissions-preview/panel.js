const root=document.getElementById('preview-controls');
const statusNode=document.getElementById('preview-result');
let csrf='';
const session=await fetch('/api/submissions-v2/session').then(response=>response.json());
csrf=session.csrf_token;
const esc=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
async function post(path,body) {
  const response=await fetch(path,{method:'POST',headers:{'content-type':'application/json','x-raydar-csrf':csrf,'idempotency-key':crypto.randomUUID()},body:JSON.stringify(body)});
  const result=await response.json();if(!response.ok)throw new Error(result.detail||result.error||'Test action failed.');return result;
}
const submit=document.getElementById('preview-submit');
if(submit)submit.addEventListener('click',async()=>{
  submit.disabled=true;
  try{await post('/preview/prove',{case_id:submit.dataset.case});statusNode.textContent='Test application created. The worker will check its exact candidate and role before showing Submitted. You can return to Submissions.';}
  catch(error){statusNode.textContent=error.message;submit.disabled=false;}
});
if(root) {
  root.innerHTML=`<details class="preview-panel" open><summary>Test workspace <span>Load examples and try the full flow</span></summary>
    <div class="preview-panel-body">
      <p>These examples use real app commands, database records, resume rendering, and download checks. Candidate sources, model answers, notifications, and Paraform are simulated.</p>
      <div class="preview-actions"><button type="button" data-test-action="starter">Load five examples</button><button type="button" data-test-action="late_contract">Publish Dana’s missing contract</button><button type="button" data-test-action="replay">Replay Ada’s reply</button><button type="button" data-test-action="refresh">Refresh status</button></div>
      <div class="preview-guide"><div><strong>Ada</strong><span>Positive → ready resume → Submit</span></div><div><strong>Ben</strong><span>Negative → Not Interested</span></div><div><strong>Cora</strong><span>Question → Needs Review</span></div><div><strong>Dana</strong><span>Missing contract → repair same source</span></div><div><strong>Finn</strong><span>Preparation failure → safe retry</span></div><div><strong>Eli</strong><span>Use Add Candidate to test manual entry</span></div></div>
      <details class="preview-advanced"><summary>Failure and pause controls</summary><div class="preview-actions"><label>Resume test <select id="preview-candidate"><option value="preview-ada">Ada Sample</option><option value="preview-finn" selected>Finn Demo</option><option value="preview-eli">Eli Example</option></select></label><button type="button" data-test-action="failure_on">Make preparation fail</button><button type="button" data-test-action="failure_off">Restore preparation</button><button type="button" data-test-action="original_hide">Hide original resume</button><button type="button" data-test-action="original_restore">Restore original resume</button><button type="button" data-test-action="pause">Pause worker</button><button type="button" data-test-action="resume">Resume worker</button></div><p>To test a failed regeneration, first download Ada’s ready resume, enable failure, then select Regenerate. Her previous good resume remains available. Restore preparation before retrying.</p></details>
      <div class="preview-status" id="preview-status" role="status">Connecting to the test worker…</div><p class="preview-feedback" id="preview-feedback" role="status"></p>
    </div></details>`;
  const feedback=document.getElementById('preview-feedback');
  async function refresh() {
    const response=await fetch('/preview/status');const result=await response.json();
    if(!response.ok)throw new Error(result.detail||result.error);
    const counts=result.counts||{},queue=result.jobs.filter(job=>job.state==='queued'||job.state==='running').reduce((n,job)=>n+job.count,0);
    const worker=result.worker_paused?'Paused':result.worker?.ready?'Ready':result.worker?.cycle_running?'Working':result.worker?.reason||'Starting';
    document.getElementById('preview-status').innerHTML=`<strong>Worker: ${esc(worker)}</strong><span>${counts.interested||0} interested · ${counts.needs_review||0} need review · ${counts.not_interested||0} not interested · ${queue} queued/running jobs</span>`;
  }
  root.addEventListener('click',async event=>{
    const button=event.target.closest('[data-test-action]');if(!button)return;
    const action=button.dataset.testAction;button.disabled=true;feedback.textContent='Working…';
    try {
      if(action==='starter'){await post('/preview/scenario',{action:'starter'});feedback.textContent='Five examples loaded. The worker will process them; the list refreshes automatically.';}
      else if(action==='late_contract'){const result=await post('/preview/scenario',{action:'late_contract'});feedback.textContent=result.existing?'Dana’s contract was already accepted; replay created no duplicate.':'Dana’s exact contract was accepted. The original source is retained and eligible work is queued.';}
      else if(action==='replay'){const result=await post('/preview/scenario',{action:'reply',scenario:'positive'});feedback.textContent=result.existing?'Ada’s reply was already accepted. No duplicate source, pair, or preparation job was created.':'Ada’s reply was loaded for the first time.';}
      else if(action.startsWith('failure_')){const enabled=action==='failure_on';await post('/preview/scenario',{action:'failure',candidate_id:document.getElementById('preview-candidate').value,enabled});feedback.textContent=enabled?'The selected candidate’s next preparation will fail safely.':'Preparation is restored. Use Retry preparation or Regenerate in the candidate row.';}
      else if(action.startsWith('original_')){const missing=action==='original_hide';await post('/preview/scenario',{action:'original',candidate_id:document.getElementById('preview-candidate').value,missing});feedback.textContent=missing?'The selected candidate’s original resume is unavailable for the next preparation.':'The original resume is available again. Use Retry preparation in the candidate row.';}
      else if(action==='pause'||action==='resume'){await post('/preview/scenario',{action:'pause',enabled:action==='pause'});feedback.textContent=action==='pause'?'The worker will pause after any current job finishes.':'The worker is running again.';}
      else feedback.textContent='Status refreshed.';
      await refresh();
    }catch(error){feedback.textContent=error.message;}
    finally{button.disabled=false;}
  });
  await refresh().catch(error=>{feedback.textContent=error.message;});
  setInterval(()=>refresh().catch(()=>{}),3000);
}
