// Shared Review controls (plain browser script, no modules, no bundler).
//
// The Review board (review.html) and the Fit Follow Ups tab (calls-today.html)
// need the same three things for a parked follow-up: say in plain English what
// is blocking it, render exactly the controls the server says are allowed, and
// give one button that applies the change AND resumes the workflow in the same
// POST (the backend has no separate "resume after save" step — one action does
// both, and a live obligation comes back status:"continuing").
//
// Everything here is a pure function of (item, actor) plus an explicit root
// element for DOM reads, so a host page can render a panel anywhere without
// this file owning any page state. All fetches are same-origin relative URLs
// through /api/post-call/review; no storage of any kind.
(function () {
  const esc=(value)=>String(value??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  const label=(value)=>String(value||"").replace(/[_-]+/g," ").replace(/\b\w/g,c=>c.toUpperCase());

  // System/provider failures arrive as SCREAMING_CASE reason codes
  // (PROVIDER_AUTH_CIRCUIT_OPEN, WORKFLOW_ERROR, ACTIVATION_REVOKED). Genuine
  // human-decision reasons are lower snake_case
  // (booking_call_identity_conflict, call_linked_profile_ambiguous,
  // external_effect_outcome_unknown). The difference decides whether a
  // review_identity park is a question for David or a machine that fell over.
  const optionCopy=(value)=>OPTION_COPY[value]||label(value);

  // Nothing the server writes is trusted to be plain English. reasonCode is
  // machine text by contract, but summary / nextStep / identityCandidatesMessage
  // and every error `detail` are freeform, and the backend genuinely emits
  // machine tokens (INVALID_PATCH, REVIEW_VALUE_INVALID, PROVIDER_AUTH_CIRCUIT_OPEN).
  // David reads this panel; a token in it is a bug report he cannot act on. So
  // anything that carries an identifier-shaped word is swapped for our own
  // calm sentence instead of being rendered as prose.
  const PLAIN_FALLBACK="That didn't work — try again, and if it keeps happening tell engineering.";
  function looksMachine(word){
    const raw=String(word||"");
    if(raw.includes("@")||raw.includes("://")||raw.includes("."))return false; // emails, URLs, filenames are real content
    return raw.replace(/^[^A-Za-z0-9_]+|[^A-Za-z0-9_]+$/g,"").includes("_");
  }
  function plainText(value,fallback){
    const text=String(value??"").trim();
    if(!text||text.length>400)return fallback;
    return text.split(/\s+/).some(looksMachine)?fallback:text;
  }
  function plainError(value){
    const text=String(value??"").trim();
    if(!text||!/\s/.test(text))return PLAIN_FALLBACK; // a bare token is never a sentence
    return plainText(text,PLAIN_FALLBACK);
  }

  const SYSTEM_REASON=/^[A-Z][A-Z0-9_]*$/;
  const SYSTEM_REASON_WORDS={
    PROVIDER_AUTH_CIRCUIT_OPEN:"Paraform was unreachable",
    PROVIDER_AUTH_EXPIRED:"the Paraform session had expired",
    ACTIVATION_REVOKED:"the Paraform session had expired",
    WORKFLOW_ERROR:"the workflow hit an error",
  };
  // A relabelled park says one thing in blockedState and another in
  // technicalEvidence.obligationState (see effectiveState below). The server's
  // own summary for those rows is the dead end David hit — "The follow-up
  // workflow needs a system repair" — so the panel asks the real question
  // instead. review_preferences uses this copy whether or not it was
  // relabelled: the backend guesses missing preferences itself now, so the
  // honest instruction is "press Continue", not "type these five things".
  const STATE_COPY={
    review_identity:{headline:"Which Paraform profile is this call attached to?",body:"Search Paraform or paste the profile link, then continue."},
    review_preferences:{headline:"Ready to continue",body:"Missing preferences are filled in automatically now; press Continue and the follow-up carries on."},
    review_profile:{headline:"Some candidate details are missing",body:"Fill in what you know and continue."},
  };
  // Paraform's location enum, mirrored from api/paraai/_lib/extract.mjs
  // (PARAAI_LOCATIONS). The backend validates locations against exactly this
  // lowercase snake_case set, so the control has to be a picker: typed prose
  // like "San Francisco" or "Remote US" is rejected upstream with
  // REVIEW_VALUE_INVALID after David believed he had answered the question.
  // (Remote is a workplace type over there, not a location.)
  const LOCATIONS=["new_york","san_francisco","south_bay_area","los_angeles","boston","seattle","texas","chicago","europe","latam","korea","canada","australia","india","uk","washington_dc","asia","denver","florida","minnesota","sacramento"];
  const FIELD_OPTIONS={callOutcome:["completed_success","no_show","failed","incomplete","cancelled_or_rescheduled","ambiguous"],roleVerdict:["good","bad"],workplaces:["REMOTE","HYBRID","ON_SITE"],visaAuthorization:["NO_VISA_AUTHORIZATION_NEEDED","NEEDS_NEW_VISA_AUTHORIZATION"],fundingRounds:["PRE_SEED","SEED","SERIES_A","SERIES_B","SERIES_C","SERIES_D_PLUS","UNKNOWN"],locations:LOCATIONS};
  const ARRAY_FIELDS=new Set(["locations","workplaces","fundingRounds"]);
  const SYSTEM_FIELDS=new Set(["candidateUserId","confirmedAbsent","resumeToken"]);
  const FIELD_COPY={fullName:"Full name",email:"Email address",phone:"Phone number",linkedinUrl:"LinkedIn profile",locations:"Location preferences",minimumBaseSalary:"Minimum base salary",workplaces:"Workplace preferences",fundingRounds:"Funding-stage preferences",visaAuthorization:"Visa requirement",callOutcome:"Call outcome",roleVerdict:"Interview result",callTranscript:"Call transcript"};
  const OPTION_COPY={uk:"UK",washington_dc:"Washington DC",latam:"Latin America",asia:"Asia",europe:"Europe",south_bay_area:"South Bay Area",no_show:"No show"};
  const RESUME_TYPES=["application/pdf","application/msword","application/vnd.openxmlformats-officedocument.wordprocessingml.document"];
  const CONTINUING=["validating","continuing"];

  async function api(url,options={}){
    const response=await fetch(url,{credentials:"same-origin",cache:"no-store",...options,headers:{"content-type":"application/json",...(options.headers||{})}});
    const body=await response.json().catch(()=>({}));
    // The message on this error is rendered straight into a toast, so it is
    // scrubbed here — the raw server text stays on the error for engineering.
    if(!response.ok||body.ok===false){const raw=body.detail||body.error||"";const error=new Error(plainError(raw));error.status=response.status;error.body=body;error.serverMessage=String(raw||"");throw error}
    return body;
  }

  function technical(item){return (item&&(item.technicalEvidence?.evidence||item.evidence))||{}}
  function blockedState(item){return item?.technicalEvidence?.blockedState||""}
  function reasonCode(item){return technical(item).reasonCode||item?.technicalEvidence?.reasonCode||""}

  // THE SECOND LIVE DEFECT this module fixes. An epoch switch relabelled 34
  // open reviews: their reasonCode became ACTIVATION_REVOKED and their
  // blockedState became "review_profile", while the obligation's real state
  // stayed in technicalEvidence.obligationState (review_identity /
  // review_preferences / review_profile) — and the server kept sending the
  // allowedActions and allowedFields of that REAL state. Rendering off the
  // relabelled blockedState gave David a "system repair" headline with no
  // working control; rendering off obligationState gives him the question the
  // server is actually still willing to answer. Only a machine reasonCode can
  // relabel a row, so a genuine human-decision park is never second-guessed.
  function obligationState(item){return String(item?.technicalEvidence?.obligationState||"")}
  function effectiveState(item){
    const declared=blockedState(item),real=obligationState(item);
    if(!SYSTEM_REASON.test(String(reasonCode(item)||"")))return declared;
    return real.startsWith("review_")&&real!==declared?real:declared;
  }
  // Whether the epoch switch wrote over this row's labels at all. Wider than
  // "the two states disagree" on purpose: a third of the relabelled rows are
  // review_profile in both fields, and those carry the same useless summary
  // ("The follow-up workflow needs a system repair") that sent David looking
  // for an engineer. What marks them is a machine reasonCode sitting on top of
  // a real, still-answerable obligation state.
  function isRelabelled(item){return SYSTEM_REASON.test(String(reasonCode(item)||""))&&obligationState(item).startsWith("review_")}
  function canWrite(actor){return Boolean(actor?.capabilities?.reviewWrite)}
  function can(actor,action){const c=actor?.capabilities||{};if(["select_profile","confirm_absent","abandon"].includes(action))return Boolean(c.reviewIdentityOverride);if(action==="approve_send")return Boolean(c.reviewSendApproval);return Boolean(c.reviewWrite)}
  function isContinuing(item){return CONTINUING.includes(String(item?.status||""))}
  function profiles(item){const raw=item?.identityCandidates||technical(item).profiles||technical(item).candidateProfiles||[];return (Array.isArray(raw)?raw:[]).sort((a,b)=>Number(b.currentCallAttached)-Number(a.currentCallAttached))}
  function paraformProfileUrl(id){return `https://www.paraform.com/candidates?candidate_profile_id=${encodeURIComponent(String(id||""))}`}
  function profileId(profile){return profile.candidateUserId||profile.id||profile.profileId}

  // THE LIVE DEFECT this module fixes: three calls parked on
  // blockedState=review_identity with reasonCode=PROVIDER_AUTH_CIRCUIT_OPEN (a
  // Paraform auth outage, since fixed). Nothing about the candidate was wrong
  // and no identity picker could help, but the identity branch hid retry and
  // resume — so the row had no working button and identity-picker copy. When
  // the reason is SCREAMING_CASE and the server still allows resume, the
  // honest primary is "Try again".
  // A true provider stall carries no obligationState at all — the workflow
  // never got far enough to have one. A relabelled row does, so it keeps its
  // picker and its lookup instead of being reduced to "Try again", which on
  // those rows would resume straight back into the same question.
  function isSystemIdentityStall(item){
    return blockedState(item)==="review_identity"
      && SYSTEM_REASON.test(String(reasonCode(item)||""))
      && !obligationState(item).startsWith("review_")
      && (item?.allowedActions||[]).includes("resume");
  }
  function systemProblemSentence(code){
    const why=SYSTEM_REASON_WORDS[code]||"the service it needed was down";
    return `The system hit a problem here (${why}), nothing about the candidate is wrong. Try again to pick this call back up.`;
  }

  // THE FOURTH LIVE DEFECT this module fixes: David pasted a Paraform profile
  // link, select_profile was accepted, and then the workflow's readback of
  // that saved choice failed because another Raydar job had tripped the
  // shared Paraform request ceiling (evidence.errorCode PROVIDER_CIRCUIT_OPEN,
  // reasonCode reviewer_selected_profile_unreadable — lower snake_case, so
  // neither isSystemIdentityStall nor isRelabelled catch it, and the panel
  // fell through to the plain identity picker again with no sign his choice
  // had been saved. Unlike isSystemIdentityStall this is not SCREAMING_CASE
  // and it does carry a real obligation state — the row is genuinely in
  // review_identity (or another review_* park), just unable to read Paraform
  // back right now. reasonCode suffixed _unreadable/_unavailable, or an
  // errorCode naming a provider circuit breaker, both mean the same thing:
  // nothing about the candidate is wrong, Paraform was busy. Generalised
  // to any review_* park (not just identity) so the same sentence covers a
  // profile, preferences, or delivery row hitting the same ceiling.
  const PROVIDER_CIRCUIT_CODE=/^PROVIDER_[A-Z0-9_]*CIRCUIT[A-Z0-9_]*$/;
  function isProviderCircuitReason(code){return /_unreadable$|_unavailable$/.test(String(code||""))}
  function isProviderBusyStall(item){
    const state=effectiveState(item);
    if(!state.startsWith("review_")||!(item?.allowedActions||[]).includes("resume"))return false;
    if(isProviderCircuitReason(reasonCode(item)))return true;
    const evidence=technical(item);
    if(PROVIDER_CIRCUIT_CODE.test(String(evidence.errorCode||"")))return true;
    if(PROVIDER_CIRCUIT_CODE.test(String(item?.identityCandidatesErrorCode||"")))return true;
    return false;
  }
  const PROVIDER_BUSY_COPY={headline:"Paraform was busy when we checked your choice",body:"Your choice is saved. Try again in a few minutes and this follow-up continues from there; another Raydar job was using Paraform at the limit."};

  // One plain-English sentence for one blocker. Never invents an action: a
  // park with allowedActions=[] says so out loud, because the server 403s
  // anything a human clicks on it.
  function blockerCopy(item,actor){
    const allowed=item?.allowedActions||[],status=String(item?.status||"open");
    if(isContinuing(item))return {headline:"This follow-up is continuing",body:"Your change was saved. It leaves this list as soon as the workflow moves on."};
    if(status==="resolved")return {headline:"This follow-up is done",body:"Nothing is blocked here any more.",noAction:true};
    if(isSystemIdentityStall(item))return {headline:plainText(item?.summary,"The system could not look this call up"),body:systemProblemSentence(reasonCode(item)),system:true};
    // Unlike isSystemIdentityStall this is never `system:true`: the row keeps
    // its normal render (picker, fields, whatever else is allowed) with Try
    // again simply pushed to the front as the primary button, because a real
    // choice or answer is sitting on this row and it stays available as a
    // secondary path rather than being hidden.
    if(isProviderBusyStall(item))return {...PROVIDER_BUSY_COPY};
    if(!allowed.length){
      return status==="failed"
        ? {headline:"This one needs a system repair",body:"Nothing you can click here would work; it needs a system repair before it can move.",noAction:true}
        : {headline:"Nothing for you to do here yet, the system is retrying this itself",body:"No button is hidden from you; there is genuinely nothing to press on this one right now.",noAction:true};
    }
    // A send-approval park has no field and no picker: the whole panel is one
    // button that releases a written email. The generic fallback below tells
    // David to "fix what is asked below" with nothing below to fix — the least
    // useful copy on the highest-stakes action here.
    if(reasonCode(item)==="send_approval_required"&&allowed.includes("resume")){
      return canWrite(actor)&&!can(actor,"approve_send")
        ? {headline:"This candidate's email is ready to send",body:"Releasing it needs send approval, which this account does not have."}
        : {headline:"This candidate's email is ready to send",body:"Nothing else needs fixing — press Approve and send to release it."};
    }
    // A relabelled row's own summary is the useless one ("needs a system
    // repair"), and every preferences park now has the same one-button answer,
    // so both take our copy for the state the server is really in.
    const state=effectiveState(item),stated=STATE_COPY[state];
    // A relabelled IDENTITY row is held, not offered. Until the service restores
    // the row's real state, any action on it would resume the workflow at the
    // wrong step (past the profile readback that proves the person is the right
    // one). The service repairs these itself on its next pass; the picker comes
    // back with the real question and nothing wrong can be sent meanwhile.
    if(isRelabelled(item)&&state==="review_identity"){
      return {headline:"Being restored automatically",body:"An earlier system switch mislabelled this one. It comes back with its real question within a few minutes; nothing to press yet.",noAction:true};
    }
    if(stated&&(isRelabelled(item)||state==="review_preferences")){
      // Some relabelled rows have no field to fill and no profile to pick —
      // the server left them only retry/resume. Asking for details that have
      // no box would be the same dead end in nicer words.
      if(state!=="review_identity"&&!normalizedFields(item).length&&!allowed.includes("attach_resume")){
        return {headline:"Ready to continue",body:"Nothing here needs your input; press Continue and the follow-up carries on."};
      }
      return {...stated};
    }
    // summary/nextStep are freeform backend prose, so they go through the same
    // plain-English guard as everything else: a field name or an obligation id
    // is replaced by copy David can act on rather than shown to him raw.
    return {headline:plainText(item?.summary,"Review required"),body:plainText(item?.nextStep,"Fix what is asked below and this follow-up carries on by itself.")};
  }

  function profileCards(item,actor,options={}){
    const rows=profiles(item);
    if(effectiveState(item)!=="review_identity")return "";
    if(!rows.length){
      const unavailable=item.identityCandidatesStatus==="unavailable";
      // The same provider circuit that blocked the readback also blocks a
      // fresh candidate search — say that plainly, ahead of the generic
      // "search unavailable" copy below, so it never reads as a dead lookup.
      if(unavailable&&PROVIDER_CIRCUIT_CODE.test(String(item?.identityCandidatesErrorCode||"")))return `<div class="control-block"><p class="hint">Paraform is busy right now (another Raydar job is using it). Search comes back in a few minutes; pasting the profile link still works.</p></div>`;
      // A search that came back empty is not a search that worked: the server
      // only enriches identityCandidates when it labelled the row
      // review_identity itself, so on a relabelled row it always returns
      // nothing. Say that plainly and point at the path that does work.
      if(options.identityQuery)return `<div class="control-block"><p class="hint">Search is unavailable for this row; paste the Paraform profile link instead.</p></div>`;
      if(isRelabelled(item))return "";
      return `<div class="control-block"><p class="hint">${esc(plainText(item.identityCandidatesMessage,"No Paraform profile was found for this call."))}</p>${unavailable?'<button class="button ghost small" data-role="reload-profiles">Try loading profiles again</button>':""}</div>`;
    }
    const attached=rows.filter(profile=>profile.currentCallAttached===true);
    const autoId=attached.length===1?profileId(attached[0]):null;
    const readonly=!canWrite(actor);
    return `<div class="control-block"><div class="profiles">${rows.map((profile,index)=>{
      const id=profileId(profile);
      const facts=[profile.email,profile.linkedinUrl,profile.talentNetwork?"Talent Network":null,profile.hasPreferences?"Preferences":null,profile.hasResume?"Résumé":null].filter(Boolean);
      const attachment=profile.currentCallAttached===true;
      const selected=String(id)===String(autoId);
      const name=profile.name||`Profile ${index+1}`;
      return `<div class="profile ${selected?"selected":""}" data-profile="${esc(id)}" role="button" tabindex="${readonly?"-1":"0"}" aria-pressed="${selected}" aria-disabled="${readonly}"><div class="profile-title"><b>${esc(name)}</b><a class="paraform-link" href="${esc(paraformProfileUrl(id))}" target="_blank" rel="noopener noreferrer" aria-label="Open ${esc(name)} in Paraform" title="Open in Paraform"><img src="/assets/paraform-logo.svg" alt=""></a></div><span class="${attachment?"call-attached":"call-missing"}">${attachment?"This call is attached":"Call attachment not confirmed"}</span><span>${esc(facts.join(" · ")||id)}</span></div>`;
    }).join("")}</div><p class="hint">Choose the profile that has this call attached.</p></div>`;
  }

  function profileLookup(item,actor,options={}){
    const allowed=new Set(item?.allowedActions||[]);
    if(effectiveState(item)!=="review_identity"||!allowed.has("select_profile")||!can(actor,"select_profile"))return "";
    return `<div class="control-block lookup"><div class="lookup-row"><label class="sr-only" for="fix-profile-search">Search Paraform</label><input id="fix-profile-search" data-role="profile-search" type="search" value="${esc(options.identityQuery||"")}" placeholder="Search Paraform by name, email, or LinkedIn" autocomplete="off"><button class="button ghost" data-role="profile-search-button">Search</button></div><div class="search-state" data-role="profile-search-status" role="status" aria-live="polite"></div><div class="lookup-or">or</div><div class="lookup-row"><label class="sr-only" for="fix-profile-link">Paraform profile link</label><input id="fix-profile-link" data-role="profile-link" type="url" placeholder="Paste Paraform profile link" autocomplete="off"><button class="button ghost" data-role="profile-link-button">Use link and continue</button></div></div>`;
  }

  // Only the fields the server allowlists, narrowed to the ones it actually
  // asked for (missing + conflicting) so one row is one question.
  function normalizedFields(item){
    const fields=(item?.allowedFields||[]).map(field=>typeof field==="string"?{name:field,label:FIELD_COPY[field]||label(field)}:field).filter(field=>field&&field.name&&!SYSTEM_FIELDS.has(field.name));
    const evidence=technical(item);
    const requested=new Set([...(Array.isArray(evidence.missing)?evidence.missing:[]),...(Array.isArray(evidence.conflictingFields)?evidence.conflictingFields:[])]);
    const exact=fields.filter(field=>requested.has(field.name));
    return exact.length?exact:fields;
  }
  function currentValue(item,name){const evidence=technical(item);return evidence.current?.[name]??evidence.candidate?.[name]??evidence.booking?.[name]??""}

  function fieldControls(item,actor){
    const fields=normalizedFields(item);
    const allowed=new Set(item?.allowedActions||[]);
    if(!fields.length||!["set_field","set_call_outcome","set_role_verdict"].some(action=>allowed.has(action)))return "";
    const readonly=canWrite(actor)?"":"disabled";
    return `<div class="control-block"><div class="fields">${fields.map(field=>{
      const name=field.name,raw=currentValue(item,name);
      const values=Array.isArray(raw)?raw.map(String):String(raw||"").split(",").map(value=>value.trim()).filter(Boolean);
      const options=field.options||FIELD_OPTIONS[name];
      const title=field.label||FIELD_COPY[name]||label(name);
      if(options){
        const multiple=ARRAY_FIELDS.has(name);
        return `<div class="field"><label for="fix-field-${esc(name)}">${esc(title)}</label><select id="fix-field-${esc(name)}" data-field="${esc(name)}" ${multiple?'data-kind="array" multiple size="4"':""} ${readonly}>${multiple?"":'<option value="">Choose…</option>'}${options.map(option=>`<option value="${esc(option)}" ${values.includes(String(option))?"selected":""}>${esc(optionCopy(option))}</option>`).join("")}</select>${multiple?'<p class="hint">Select every option that applies.</p>':""}</div>`;
      }
      const list=ARRAY_FIELDS.has(name),transcript=/transcript/i.test(name);
      return `<div class="field"><label for="fix-field-${esc(name)}">${esc(title)}</label>${transcript?`<textarea id="fix-field-${esc(name)}" data-field="${esc(name)}" maxlength="8000" placeholder="Paste the transcript with speaker names" ${readonly}>${esc(raw)}</textarea>`:`<input id="fix-field-${esc(name)}" data-field="${esc(name)}" ${list?'data-kind="array"':''} ${name==="minimumBaseSalary"?'type="number" min="1" step="1000"':name==="linkedinUrl"?'type="url" placeholder="https://www.linkedin.com/in/…"':'type="text"'} value="${esc(Array.isArray(raw)?raw.join(", "):raw)}" autocomplete="off" ${readonly} />`}${list?'<p class="hint">Separate multiple values with commas.</p>':transcript?'<p class="hint">Up to 8,000 characters — the service silently drops anything past that, so the box stops there too.</p>':""}</div>`;
    }).join("")}</div></div>`;
  }

  function resumeInput(item){
    if(!(item?.allowedActions||[]).includes("attach_resume"))return "";
    return `<div class="control-block"><div class="field"><label for="fix-resume">Résumé</label><input id="fix-resume" data-role="resume" type="file" accept=".pdf,.doc,.docx,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document" /><p class="hint">PDF, DOC, or DOCX up to 25 MB.</p></div></div>`;
  }

  // One row, one control, one button: the first button in this order is the
  // primary and every other allowed one is a quiet ghost beside it. Assign,
  // priority and abandon are deliberately absent — abandon stays on the
  // Review board, where the confirmation and the audit trail already live.
  function actionButtons(item,actor){
    if(!canWrite(actor))return "";
    const allowed=new Set(item?.allowedActions||[]);
    const rows=profiles(item);
    const identity=effectiveState(item)==="review_identity";
    const identityChoice=identity&&allowed.has("select_profile");
    const uncertainIdentity=identityChoice&&reasonCode(item)==="external_effect_outcome_unknown";
    const identityUnavailable=identityChoice&&item.identityCandidatesStatus==="unavailable";
    const sendApproval=reasonCode(item)==="send_approval_required";
    // Preferences are guessed by the backend now, so the honest primary on a
    // preferences park is a plain resume: nothing has to be typed. The fields
    // stay on screen under a disclosure, and bindPanel flips this same button
    // to set_field the moment one of them is edited, so an answer David does
    // type is never dropped on the floor by a "Continue" that sends {}.
    const guessedPreferences=effectiveState(item)==="review_preferences"&&allowed.has("resume");
    const buttons=[];
    const push=(action,text,kind,extra)=>{if(!buttons.some(row=>row[0]===action))buttons.push([action,text,kind||(buttons.length?"ghost":"primary"),extra||""])};
    if(isSystemIdentityStall(item))push("resume","Try again");
    // Pushed first so it is the primary button; select_profile/confirm_absent
    // below still render underneath (push() makes anything after the first
    // call a ghost), which is what keeps the picker as a secondary path
    // rather than hiding it the way a true system stall does.
    if(isProviderBusyStall(item))push("resume","Try again");
    if(allowed.has("select_profile")&&rows.length&&can(actor,"select_profile")&&!isSystemIdentityStall(item))push("select_profile","Use this profile and continue");
    if(guessedPreferences)push("resume","Continue","primary",normalizedFields(item).length&&allowed.has("set_field")?'data-base-action="resume" data-base-label="Continue" data-alt-action="set_field" data-alt-label="Save and continue"':"");
    if(allowed.has("set_field")&&normalizedFields(item).length&&!guessedPreferences)push("set_field","Save and continue");
    if(allowed.has("set_call_outcome"))push("set_call_outcome","Save and continue");
    if(allowed.has("set_role_verdict"))push("set_role_verdict","Save and continue");
    if(allowed.has("attach_resume"))push("attach_resume","Upload résumé and continue");
    // A relabelled row with nothing to correct did not fail — it was mislabelled
    // while it waited. "Try again" would read as "that went wrong"; the honest
    // word for letting the workflow carry on is Continue.
    if(isRelabelled(item)&&!buttons.length&&!sendApproval&&allowed.has("resume")&&!identityChoice)push("resume","Continue");
    // retry and resume are the fallback for a row with nothing to correct. When
    // a control is on screen its save button already resumes the workflow in
    // the same POST, so a second "Continue" beside it would only be a way to
    // skip the question that was asked.
    if(!buttons.length&&allowed.has("resume")&&!identityChoice&&sendApproval&&can(actor,"approve_send"))push("resume","Approve and send");
    if(!buttons.length&&allowed.has("retry")&&!identityChoice)push("retry","Try again");
    if(!buttons.length&&allowed.has("resume")&&!identityChoice&&(!sendApproval||can(actor,"approve_send")))push("resume",sendApproval?"Approve and send":"Continue");
    if(allowed.has("confirm_absent")&&can(actor,"confirm_absent")&&identity&&!identityUnavailable&&!uncertainIdentity&&!isSystemIdentityStall(item))push("confirm_absent",rows.length?"None of these profiles":"No Paraform profile exists","warn");
    // A send approval this account cannot give is not a broken row and not an
    // empty one: whatever else is on it (a retry, say) will not release the
    // email, so the panel says so instead of leaving David to guess whether he
    // pressed the wrong thing or the row is stuck.
    const approvalGap=sendApproval&&!can(actor,"approve_send")
      ? `<p class="hint">Nothing here sends it. Ask for send approval, or hand this one to someone who has it on the Review board.</p>`
      : "";
    if(!buttons.length)return approvalGap||`<p class="hint">There is nothing to press on this one from here; the Review board has the rest.</p>`;
    return `<div class="review-actions">${buttons.map(([action,text,kind,extra])=>`<button class="button ${kind}" data-action="${action}"${extra?` ${extra}`:""}>${esc(text)}</button>`).join("")}</div>${approvalGap}`;
  }

  // The whole panel for one parked follow-up, as an HTML string.
  function renderPanel(item,actor,options={}){
    if(!item)return `<div class="fix"><p class="fix-copy">This follow-up could not be loaded.</p></div>`;
    const copy=blockerCopy(item,actor);
    const head=`<div class="fix-kicker">${isContinuing(item)?"In progress":"What needs to happen"}</div><h3 class="fix-title">${esc(copy.headline)}</h3>${copy.body?`<p class="fix-copy">${esc(copy.body)}</p>`:""}`;
    if(isContinuing(item)||copy.noAction)return `<div class="fix">${head}</div>`;
    if(!canWrite(actor))return `<div class="fix">${head}<p class="hint">You have read-only access, so nothing here can be changed.</p></div>`;
    // A system stall is one button. The identity search and paste-link would
    // only put a question in front of David that nobody asked, and while the
    // provider is down the search fails the same way the workflow did.
    if(copy.system)return `<div class="fix">${head}${actionButtons(item,actor)}</div>`;
    // On a preferences park the fields are an option, not the task: the
    // backend fills the gaps itself, so they go behind a disclosure and
    // Continue is the whole job.
    const fields=fieldControls(item,actor);
    const optional=fields&&effectiveState(item)==="review_preferences"&&(item?.allowedActions||[]).includes("resume");
    return `<div class="fix">${head}${profileLookup(item,actor,options)}${profileCards(item,actor,options)}${optional?`<details class="optional-fields"><summary>Adjust preferences first (optional)</summary>${fields}</details>`:fields}${resumeInput(item)}${actionButtons(item,actor)}</div>`;
  }

  // What gets POSTed is scoped to the action that was clicked. The backend
  // takes each action's changes exactly: select_profile wants only
  // candidateUserId, the set_* actions want only their fields, and
  // retry/resume/confirm_absent want an empty object (anything else is a
  // REVIEW_VALUE_INVALID). This matters because a profile card auto-marks
  // itself selected whenever one candidate already has the call attached — so
  // an unscoped read would smuggle candidateUserId into a "Try again" click,
  // which is exactly the one-click recovery a system stall depends on.
  const FIELD_ACTIONS=new Set(["set_field","set_call_outcome","set_role_verdict"]);
  // One shared field block renders every field the server allowlisted, so a row
  // that allows two set_* actions at once (a call outcome AND an interview
  // result) draws two save buttons over the same controls. Each save carries
  // only its own answer: the other action's field is dropped rather than
  // forwarded upstream as a change nobody asked for.
  const ACTION_OWN_FIELD={set_call_outcome:"callOutcome",set_role_verdict:"roleVerdict"};
  function fieldValues(root){
    const scope=root||document,changes={};
    scope.querySelectorAll("[data-field]").forEach(el=>{
      let value;
      if(el.dataset.kind==="array")value=el.multiple?[...el.selectedOptions].map(option=>option.value):el.value.split(",").map(item=>item.trim()).filter(Boolean);
      else if(el.type==="number")value=el.value===""?null:Number(el.value);
      else value=el.value;
      if(value!==""&&value!==null&&(!Array.isArray(value)||value.length))changes[el.dataset.field]=value;
    });
    return changes;
  }
  function collectChanges(root,action){
    const scope=root||document;
    if(action==="select_profile"){
      const selected=scope.querySelector(".profile.selected");
      return selected?{candidateUserId:selected.dataset.profile}:{};
    }
    if(action&&!FIELD_ACTIONS.has(action))return {};
    const values=fieldValues(scope);
    if(!action)return values; // no action = a draft snapshot for a redraw, which keeps everything
    for(const owner of Object.keys(ACTION_OWN_FIELD)){
      if(owner!==action)delete values[ACTION_OWN_FIELD[owner]];
    }
    return values;
  }
  // Puts already-typed values back after a re-render (a profile search redraws
  // the whole panel), so switching to the lookup never silently discards a
  // correction typed into a different control on the same row.
  function applyChanges(root,values){
    if(!root||!values)return;
    root.querySelectorAll("[data-field]").forEach(el=>{
      const name=el.dataset.field;
      if(!Object.prototype.hasOwnProperty.call(values,name))return;
      const value=values[name];
      if(el.multiple){const wanted=new Set((Array.isArray(value)?value:[value]).map(String));[...el.options].forEach(option=>{option.selected=wanted.has(option.value)});return}
      el.value=Array.isArray(value)?value.join(", "):String(value??"");
    });
  }

  // Wires a rendered panel's controls. Selection is local to `root`, so two
  // panels could never fight over the same profile card.
  function bindPanel(root,handlers={}){
    if(!root)return;
    root.querySelectorAll(".profile").forEach(el=>{
      const choose=()=>{if(el.getAttribute("aria-disabled")==="true")return;root.querySelectorAll(".profile").forEach(other=>{other.classList.remove("selected");other.setAttribute("aria-pressed","false")});el.classList.add("selected");el.setAttribute("aria-pressed","true")};
      el.onclick=event=>{if(event.target.closest(".paraform-link"))return;choose()};
      el.onkeydown=event=>{if(event.key==="Enter"||event.key===" "){event.preventDefault();choose()}};
    });
    root.querySelectorAll("[data-action]").forEach(el=>{el.onclick=()=>handlers.onAction&&handlers.onAction(el.dataset.action)});
    // "Continue" on a preferences park sends nothing and lets the backend
    // guess; the same button becomes "Save and continue" (set_field) as soon
    // as a field differs from what it was rendered with, so a value David
    // typed can never be silently discarded by the one-click path.
    const swap=root.querySelector("[data-alt-action]");
    if(swap){
      swap.dataset.baseline=JSON.stringify(fieldValues(root));
      const sync=()=>syncPrimary(root);
      root.querySelectorAll("[data-field]").forEach(el=>{el.oninput=sync;el.onchange=sync});
      sync();
    }
    const search=root.querySelector('[data-role="profile-search-button"]'),input=root.querySelector('[data-role="profile-search"]');
    if(search)search.onclick=()=>handlers.onSearch&&handlers.onSearch();
    if(input)input.onkeydown=event=>{if(event.key==="Enter"){event.preventDefault();handlers.onSearch&&handlers.onSearch()}};
    const link=root.querySelector('[data-role="profile-link-button"]');
    if(link)link.onclick=()=>handlers.onProfileLink&&handlers.onProfileLink();
    const reload=root.querySelector('[data-role="reload-profiles"]');
    if(reload)reload.onclick=()=>handlers.onReload&&handlers.onReload();
  }

  // Called on every edit and again after a redraw restores a draft, so the one
  // button always says what it will actually do.
  function syncPrimary(root){
    const swap=root&&root.querySelector("[data-alt-action]");
    if(!swap)return;
    const now=JSON.stringify(fieldValues(root)),edited=now!==swap.dataset.baseline&&now!=="{}";
    swap.dataset.action=edited?swap.dataset.altAction:swap.dataset.baseAction;
    swap.textContent=edited?swap.dataset.altLabel:swap.dataset.baseLabel;
  }

  function setBusy(root,busy){
    if(!root)return;
    root.querySelectorAll('[data-action],[data-role="profile-search-button"],[data-role="profile-link-button"]').forEach(button=>{button.disabled=busy});
  }

  function profileIdFromLink(value){
    try{
      const url=new URL(String(value||"").trim());
      if(url.protocol!=="https:"||!["paraform.com","www.paraform.com"].includes(url.hostname.toLowerCase())||url.pathname!=="/candidates")return null;
      const id=(url.searchParams.get("candidate_profile_id")||url.searchParams.get("id")||"").trim();
      return /^[a-zA-Z0-9_-]{3,160}$/.test(id)?id:null;
    }catch{return null}
  }

  async function fetchItem(reviewId,identitySearch){
    const body=await api(`/api/post-call/review?id=${encodeURIComponent(reviewId)}${identitySearch?`&identitySearch=${encodeURIComponent(identitySearch)}`:""}`);
    return {item:body.item||null,actor:body.actor||null};
  }

  // One POST applies the change and resumes the obligation atomically; there
  // is no second "resume" call to make. `approveSend` is the only send gate in
  // the product, so it is set here and only behind an explicit confirm.
  async function runAction({item,action,changes,actor,reason}){
    if(!item)throw new Error("Nothing to act on.");
    // A save with nothing in it is rejected upstream every time
    // (REVIEW_VALUE_INVALID), and that comes back as a bare token, which
    // plainError can only render as the generic "that didn't work" — the exact
    // dead end this module exists to remove. Ordinary route in: the only
    // missing field on the row is empty by definition, or a Choose… select was
    // never touched. Say what to do instead of posting it.
    if(FIELD_ACTIONS.has(action)&&!Object.keys(changes||{}).length){
      throw new Error(action==="set_field"
        ? "Fill in at least one field above, then press Save and continue."
        : "Choose an option above first, then press Save and continue.");
    }
    const needsApproval=action==="resume"&&reasonCode(item)==="send_approval_required"&&can(actor,"approve_send");
    if(needsApproval&&!confirm("Approve and send this candidate's prepared post-call email now?"))return {ok:false,cancelled:true};
    const payload={reviewId:item.id,version:item.version,action,changes:changes||{},reason:reason||`Review action: ${label(action)}`};
    if(needsApproval)payload.approveSend=true;
    const result=await api("/api/post-call/review",{method:"POST",body:JSON.stringify(payload)});
    return {ok:true,result,approveSend:needsApproval};
  }

  function resumeMime(file){
    if(RESUME_TYPES.includes(file.type))return file.type;
    const name=String(file.name||"").toLowerCase();
    return name.endsWith(".pdf")?"application/pdf":name.endsWith(".docx")?"application/vnd.openxmlformats-officedocument.wordprocessingml.document":name.endsWith(".doc")?"application/msword":"";
  }
  function safeUploadTarget(value){
    const url=new URL(value),host=url.hostname.toLowerCase();
    const privateHost=host==="localhost"||host.endsWith(".local")||/^127\.|^10\.|^192\.168\.|^169\.254\.|^172\.(?:1[6-9]|2\d|3[01])\./.test(host);
    if(url.protocol!=="https:"||url.username||url.password||url.hash||privateHost)throw new Error("The workflow service returned an unsafe résumé upload target.");
    return url;
  }
  // Two-step upload, unchanged from the Review board: prepare_resume mints a
  // one-shot target bound to the file's hash, the bytes go straight there, and
  // attach_resume verifies the same hash before the workflow resumes.
  async function attachResume(item,file,reason){
    if(!file)throw new Error("Choose a résumé file first.");
    if(file.size>25*1024*1024)throw new Error("That résumé is larger than 25 MB.");
    const mimeType=resumeMime(file);
    if(!mimeType)throw new Error("Choose a PDF, DOC, or DOCX résumé.");
    const bytes=await file.arrayBuffer();
    const digest=await crypto.subtle.digest("SHA-256",bytes);
    const sha256=[...new Uint8Array(digest)].map(value=>value.toString(16).padStart(2,"0")).join("");
    const prepared=await api("/api/post-call/review",{method:"POST",body:JSON.stringify({action:"prepare_resume",reviewId:item.id,version:item.version,fileName:file.name,mimeType,sizeBytes:file.size,sha256})});
    const upload=prepared.upload||{},uploadUrl=safeUploadTarget(upload.url);
    if(String(upload.method||"PUT").toUpperCase()!=="PUT")throw new Error("The workflow service returned an unsafe résumé upload target.");
    const uploaded=await fetch(uploadUrl,{method:"PUT",headers:upload.headers||{"content-type":mimeType},body:bytes,credentials:"omit",redirect:"error",referrerPolicy:"no-referrer"});
    if(!uploaded.ok)throw new Error(`Résumé upload failed (${uploaded.status})`);
    const result=await api("/api/post-call/review",{method:"POST",body:JSON.stringify({reviewId:item.id,version:prepared.version??item.version,action:"attach_resume",changes:{fileToken:prepared.fileToken,sha256},reason:reason||"Review action: Attach Resume"})});
    return {ok:true,result};
  }

  window.RaydarReviewControls=Object.freeze({
    esc,label,can,canWrite,technical,blockedState,reasonCode,profiles,normalizedFields,
    obligationState,effectiveState,isRelabelled,
    isSystemIdentityStall,isProviderBusyStall,blockerCopy,isContinuing,
    plainText,plainError,
    renderPanel,bindPanel,setBusy,syncPrimary,collectChanges,applyChanges,
    runAction,attachResume,fetchItem,profileIdFromLink,
  });
})();
