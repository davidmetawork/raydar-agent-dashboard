// Fit Follow Ups can be fixed in place.
//
// David's ask: "I prefer just the Fit Follow Ups tab, but make it so I can just
// correct whatever is there and unblock it from there." One row = one blocker =
// one control = one button, with the shared Review controls module doing the
// rendering so the Fit tab and the Review board can never drift apart.
//
// These are static assertions on the shipped browser files (the same shape the
// other surface tests use): there is no DOM here, so what is checked is that
// the wiring, the copy, and the safety rails are present in the source.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const callsToday = await readFile(new URL("../calls-today.html", import.meta.url), "utf8");
const controls = await readFile(new URL("../review-controls.js", import.meta.url), "utf8");
const review = await readFile(new URL("../review.html", import.meta.url), "utf8");
const callsSummary = await readFile(new URL("../api/post-call/calls-summary.mjs", import.meta.url), "utf8");
const reviewProxy = await readFile(new URL("../api/post-call/review.mjs", import.meta.url), "utf8");

test("Fit Follow Ups loads the shared Review controls and offers a Fix button per parked row", () => {
  assert.match(callsToday, /<script src="\/review-controls\.js"><\/script>/);
  assert.match(callsToday, /window\.RaydarReviewControls/);
  assert.match(callsToday, /data-fix="\$\{esc\(call\.reviewId\)\}"/);
  assert.match(callsToday, /button ghost small/);
  assert.match(callsToday, />\$\{open\?"Close":"Fix"\}</);
  // Only rows actually parked on a person get the button; a delivered
  // follow-up keeps its Review board link and nothing else changes.
  assert.match(callsToday, /function isFixable\(call\)/);
  assert.match(callsToday, /bucket==="in_review"/);
  assert.match(callsToday, /class="row-panel" id="row-panel"/);
  assert.match(callsToday, /Paraform call ↗/);
});

test("Fit Follow Ups drives the same-origin review proxy and never a raw upstream", () => {
  // The Fit tab never builds a review URL itself: every read and write goes
  // through the shared module, which is the one place that path is spelled.
  assert.match(callsToday, /RC=window\.RaydarReviewControls/);
  assert.match(callsToday, /RC\.fetchItem\(/);
  assert.match(callsToday, /RC\.runAction\(/);
  assert.match(callsToday, /RC\.attachResume\(/);
  assert.match(controls, /"\/api\/post-call\/review"/);
  assert.match(controls, /\/api\/post-call\/review\?id=/);
  assert.match(callsToday, /credentials:"same-origin"/);
  assert.doesNotMatch(callsToday, /POST_CALL_BASE|POST_CALL_MONITOR_API_KEY|POST_CALL_REVIEW_ASSERTION_SECRET/);
  assert.doesNotMatch(callsToday, /localStorage|sessionStorage|indexedDB/);
  assert.doesNotMatch(callsToday, /\/api\/v1\/|\/api\/v2\//);
  assert.match(controls, /credentials:"same-origin"/);
  assert.match(controls, /cache:"no-store"/);
  assert.doesNotMatch(controls, /POST_CALL_BASE|POST_CALL_MONITOR_API_KEY/);
  assert.doesNotMatch(controls, /localStorage|sessionStorage|indexedDB/);
  assert.doesNotMatch(controls, /\/api\/v1\/|\/api\/v2\//);
});

test("an open fix panel pauses the 30s refresh so typed input is never lost", () => {
  assert.match(callsToday, /STATE\.panelOpen/);
  // A watched row is paused for the same reason: its own progress must not be
  // swapped out from under it by a background list refresh.
  assert.match(callsToday, /if\(STATE\.panelOpen\|\|watching\(\)\)return;/);
  assert.match(callsToday, /refreshTimer=setInterval\(load,30000\)/);
  // Loading and rendering are separate, so the panel can be redrawn on its own
  // without replacing the rows around it.
  assert.match(callsToday, /function renderCalls\(\)/);
  assert.match(callsToday, /function renderPanelOnly\(\)/);
});

test("the fix panel reports the outcome honestly and reopens on a new blocker", () => {
  assert.match(callsToday, /Saved, the follow-up is continuing/);
  assert.match(callsToday, /Email approved, Mailroom is sending it/);
  assert.match(callsToday, /This person changed since you opened them; refreshing/);
  assert.match(callsToday, /error\.status===409/);
  assert.match(callsToday, /error\.status===401/);
  assert.match(callsToday, /next\.status==="open"/);
  assert.match(callsToday, /openPanel\(reviewId,next\)/);
});

test("the shared controls render only what the server allows, and send the version", () => {
  assert.match(controls, /item\?\.allowedActions/);
  assert.match(controls, /item\?\.allowedFields/);
  assert.match(controls, /version:item\.version/);
  assert.match(controls, /data-action="\$\{action\}"/);
  assert.match(controls, /reviewId:item\.id/);
  // The Fit tab is a correction surface, not an admin console: assignment,
  // priority and abandon stay on the Review board.
  assert.doesNotMatch(controls, /"abandon","/);
  assert.doesNotMatch(controls, /data-action="abandon"/);
  assert.doesNotMatch(controls, /set_priority/);
  assert.doesNotMatch(controls, /"assign"/);
  assert.doesNotMatch(controls, /Save assignment|Save priority/);
});

test("a system-failure identity park offers Try again instead of a dead identity picker", () => {
  // The live defect: three calls parked review_identity /
  // PROVIDER_AUTH_CIRCUIT_OPEN, an outage that had nothing to do with the
  // candidate, and the identity branch hid every working button.
  assert.match(controls, /const SYSTEM_REASON=\/\^\[A-Z\]\[A-Z0-9_\]\*\$\//);
  assert.match(controls, /function isSystemIdentityStall\(item\)/);
  assert.match(controls, /blockedState\(item\)==="review_identity"/);
  assert.match(controls, /includes\("resume"\)/);
  assert.match(controls, /The system hit a problem here/);
  assert.match(controls, /nothing about the candidate is wrong/);
  assert.match(controls, /push\("resume","Try again"\)/);
  assert.match(controls, /PROVIDER_AUTH_CIRCUIT_OPEN:"Paraform was unreachable"/);
  // A genuine identity decision must never be papered over as a system fault.
  assert.match(controls, /external_effect_outcome_unknown/);
  // The Review board gets the same branch, minimally.
  assert.match(review, /isSystemIdentityStall/);
  assert.match(review, /\["resume","Try again","primary"\]/);
  assert.match(review, /The system hit a problem here/);
});

test("the controls say so when nothing a human clicks would work", () => {
  assert.match(controls, /Nothing for you to do here yet, the system is retrying this itself/);
  assert.match(controls, /needs a system repair/);
  assert.match(controls, /if\(!allowed\.length\)/);
});

test("the send gate stays behind a confirm and the resume approval flag", () => {
  assert.match(controls, /Approve and send/);
  assert.match(controls, /send_approval_required/);
  assert.match(controls, /confirm\("Approve and send this candidate's prepared post-call email now\?"\)/);
  // approveSend is only ever set after that confirm returned true.
  const approveIndex = controls.indexOf("payload.approveSend=true");
  const confirmIndex = controls.indexOf("confirm(\"Approve and send");
  assert.ok(confirmIndex > -1 && approveIndex > confirmIndex);
  assert.doesNotMatch(controls, /approveSend:\s*true/);
});

test("résumé upload keeps the hash, size, and type rails from the Review board", () => {
  assert.match(controls, /file\.size>25\*1024\*1024/);
  assert.match(controls, /up to 25 MB/);
  assert.match(controls, /crypto\.subtle\.digest\("SHA-256"/);
  assert.match(controls, /prepare_resume/);
  assert.match(controls, /attach_resume/);
  assert.match(controls, /function safeUploadTarget\(value\)/);
  assert.match(controls, /url\.protocol!=="https:"/);
  assert.match(controls, /credentials:"omit"/);
  assert.match(controls, /application\/pdf/);
});

test("every interpolated value in the shared controls is escaped", () => {
  assert.match(controls, /const esc=\(value\)=>String\(value\?\?""\)/);
  assert.match(controls, /esc\(copy\.headline\)/);
  assert.match(controls, /esc\(text\)/);
  assert.doesNotMatch(controls, /\$\{item\.summary\}/);
  assert.doesNotMatch(controls, /\$\{profile\.name\}/);
});

test("what gets sent is scoped to the button that was clicked", () => {
  // A profile card auto-selects itself when one candidate already has the call
  // attached, so an unscoped read would smuggle candidateUserId into a
  // "Try again" (resume) click — and the backend rejects retry/resume/
  // confirm_absent unless changes is empty, which would break the exact
  // one-click recovery this change exists to add.
  assert.match(controls, /function collectChanges\(root,action\)/);
  assert.match(controls, /if\(action==="select_profile"\)/);
  assert.match(controls, /if\(action&&!FIELD_ACTIONS\.has\(action\)\)return \{\}/);
  assert.match(controls, /FIELD_ACTIONS=new Set\(\["set_field","set_call_outcome","set_role_verdict"\]\)/);
  assert.match(callsToday, /RC\.collectChanges\(root,action\)/);
  // The Review board's own copy of that logic is scoped the same way.
  assert.match(review, /function collectedChanges\(action\)/);
  assert.match(review, /overrideChanges\|\|collectedChanges\(action\)/);
  assert.doesNotMatch(review, /overrideChanges\|\|collectedChanges\(\)/);
});

test("server text is never printed to David raw", () => {
  // The backend emits machine codes (PROVIDER_AUTH_CIRCUIT_OPEN, INVALID_PATCH,
  // REVIEW_VALUE_INVALID) in detail/error, and every failure path toasts
  // error.message. Anything identifier-shaped is swapped for plain copy; the
  // raw string stays on the error object for engineering.
  assert.match(controls, /function plainError\(value\)/);
  assert.match(controls, /function plainText\(value,fallback\)/);
  assert.match(controls, /new Error\(plainError\(raw\)\)/);
  assert.match(controls, /error\.serverMessage/);
  assert.doesNotMatch(controls, /new Error\(body\.detail\|\|body\.error/);
  assert.doesNotMatch(callsToday, /new Error\(body\.detail\|\|body\.error/);
  assert.match(callsToday, /RC\.plainError\(body\.detail\|\|body\.error\)/);
  // The blocker headline, body and identity hint are backend prose too.
  assert.match(controls, /plainText\(item\?\.summary,"Review required"\)/);
  assert.match(controls, /plainText\(item\?\.nextStep,/);
  assert.match(controls, /plainText\(item\.identityCandidatesMessage,/);
});

test("locations is picked from Paraform's enum, not typed as free text", () => {
  // The backend validates locations against PARAAI_LOCATIONS
  // (api/paraai/_lib/extract.mjs); "San Francisco" or "Remote US" typed into a
  // text box is rejected upstream after David believed he had answered.
  assert.match(controls, /locations:LOCATIONS/);
  assert.match(controls, /"new_york","san_francisco","south_bay_area"/);
  assert.match(controls, /"uk","washington_dc"/);
  assert.match(review, /locations:\["new_york","san_francisco"/);
  // locations stays a multi-value field, so the picker renders as a multi-select.
  assert.match(controls, /ARRAY_FIELDS=new Set\(\["locations"/);
});

test("a profile search never discards a correction already typed", () => {
  assert.match(callsToday, /function keepDraft\(\)/);
  assert.match(callsToday, /STATE\.panelDraft/);
  assert.match(callsToday, /RC\.applyChanges\(/);
  assert.match(controls, /function applyChanges\(root,values\)/);
  // Both redraw paths snapshot first: the search button and the reload of the
  // Paraform candidate list.
  assert.match(callsToday, /keepDraft\(\);\n {2}const status/);
  assert.match(callsToday, /onReload:\(\)=>\{keepDraft\(\);/);
});

// review_routing parks allow set_field on roleTitle/company (post-call REVIEW_POLICIES);
// the proxy allowlist used to omit both, so every routing correction 400'd before
// reaching the service. Keep them allowlisted with the same 1-200 char text rule.
test("review proxy accepts the routing fields the service allows", async () => {
  const proxy = await readFile(new URL("../api/post-call/review.mjs", import.meta.url), "utf8");
  assert.match(proxy, /"roleTitle", "company"\]\.includes\(field\)/);
  assert.match(proxy, /field === "roleTitle" \|\| field === "company"/);
});

// ---- Tonight's epoch relabel, and seeing a fix through to the email --------
// David, looking at the live tab: "I can't fix this — I should be able to click
// Fix, make the update, then this email should go out."

test("a relabelled park is rendered from the state the workflow is really in", () => {
  // An epoch switch stamped reasonCode ACTIVATION_REVOKED and blockedState
  // review_profile onto 34 open reviews whose real state lived on in
  // technicalEvidence.obligationState — while allowedActions and allowedFields
  // kept matching that real state. Rendering off blockedState gave David a
  // "system repair" headline with no working control.
  assert.match(controls, /function obligationState\(item\)/);
  assert.match(controls, /technicalEvidence\?\.obligationState/);
  assert.match(controls, /function effectiveState\(item\)/);
  assert.match(controls, /real\.startsWith\("review_"\)&&real!==declared\?real:declared/);
  assert.match(controls, /ACTIVATION_REVOKED/);
  // Every rendering decision moves onto the effective state.
  assert.match(controls, /if\(effectiveState\(item\)!=="review_identity"\)return ""/);
  assert.match(controls, /effectiveState\(item\)!=="review_identity"\|\|!allowed\.has\("select_profile"\)/);
  assert.match(controls, /const identity=effectiveState\(item\)==="review_identity"/);
  // A relabelled row never keeps the copy that sent him looking for an engineer.
  assert.match(controls, /const STATE_COPY=\{/);
  assert.match(controls, /Which Paraform profile is this call attached to\?/);
  assert.match(controls, /Some candidate details are missing/);
  assert.match(controls, /Fill in what you know and continue/);
  assert.match(controls, /isRelabelled\(item\)\|\|state==="review_preferences"/);
  // A TRUE provider stall keeps Try again; a relabelled identity row must not,
  // because resuming it lands straight back on the same question.
  assert.match(controls, /!obligationState\(item\)\.startsWith\("review_"\)/);
});

test("a preferences park is one button, with the fields optional underneath", () => {
  // POST_CALL_PREFERENCE_GUESS fills the gaps itself now, so nothing has to be
  // typed: plain resume with {} is the whole answer.
  assert.match(controls, /const guessedPreferences=effectiveState\(item\)==="review_preferences"&&allowed\.has\("resume"\)/);
  assert.match(controls, /if\(guessedPreferences\)push\("resume","Continue"/);
  assert.match(controls, /Missing preferences are filled in automatically now; press Continue/);
  assert.match(controls, /Adjust preferences first \(optional\)/);
  assert.match(controls, /<details class="optional-fields">/);
  assert.match(callsToday, /\.optional-fields/);
  // Typing into one of those optional fields turns the same button into a save,
  // so an answer David does give is never dropped by the one-click path.
  assert.match(controls, /data-alt-action="set_field" data-alt-label="Save and continue"/);
  assert.match(controls, /function syncPrimary\(root\)/);
  assert.match(controls, /swap\.dataset\.action=edited\?swap\.dataset\.altAction:swap\.dataset\.baseAction/);
  assert.match(callsToday, /RC\.syncPrimary\(root\)/);
  // set_field is still what the backend is asked for when it is a save.
  assert.match(controls, /FIELD_ACTIONS=new Set\(\["set_field"/);
});

test("an identity lookup that comes back empty says so instead of pretending", () => {
  assert.match(controls, /Search is unavailable for this row; paste the Paraform profile link instead\./);
  assert.match(controls, /options\.identityQuery/);
  // The paste-link path posts the action the server actually allows.
  assert.match(callsToday, /doAction\("select_profile",\{candidateUserId\}\)/);
  assert.match(controls, /function profileIdFromLink\(value\)/);
});

test("a no-show row offers no Fix, because no email is ever sent for one", () => {
  assert.match(callsToday, /function isNoShow\(call\)/);
  assert.match(callsToday, /bucketOf\(call\)==="no_show"/);
  assert.match(callsToday, /No email for a no-show/);
  assert.match(callsToday, /!fixable&&isNoShow\(call\)/);
  // The Paraform call link stays on the row either way.
  assert.match(callsToday, /!fixable&&!isNoShow\(call\)&&call\.reviewId/);
  // bucket is what the tone cannot say: in_review and no_send are both "warn",
  // still_working and other are both "muted".
  const proxy = callsSummary;
  assert.match(proxy, /bucket,\n/);
  assert.match(proxy, /Object\.hasOwn\(BUCKET_TONES, raw\) \? raw : "other"/);
});

test("after an action the row is watched until the follow-up is actually sent", () => {
  assert.match(callsToday, /async function watchRowUntilSent\(callId,reviewId\)/);
  assert.match(callsToday, /const WATCH_EVERY_MS=10000;/);
  assert.match(callsToday, /const WATCH_LIMIT_MS=15\*60\*1000;/);
  assert.match(callsToday, /Working on it…/);
  assert.match(callsToday, /We're finishing the follow-up; this usually takes a few minutes\./);
  // Each terminal state stops the poll and says the true thing.
  assert.match(callsToday, /if\(bucket==="sent"\)return stopWatch/);
  assert.match(callsToday, /const WATCH_QUEUED="Queued, sends at 5:00 AM PT";/);
  // "Finished, waiting for the 05:00 PT window" is read from a flag the proxy
  // sets off the upstream step, never from the English sentence printed beside
  // it: a reworded sentence would otherwise leave the row spinning for the full
  // fifteen minutes on a follow-up that is already done.
  assert.match(callsToday, /result\?\.queuedForSendWindow===true/);
  assert.match(callsToday, /if\(isQueuedForSendWindow\(call\)\)return stopWatch/);
  assert.match(callsSummary, /queuedForSendWindow = bucket === "still_working" && String\(outcome\.detail\?\.step \|\| ""\) === "waiting_send_window"/);
  assert.match(callsSummary, /\.\.\.\(queuedForSendWindow \? \{ queuedForSendWindow: true \} : \{\}\)/);
  assert.doesNotMatch(callsToday, /detail==="Waiting for the send window"/);
  // The fifteen-minute stop tells David what to do, not how the poller works.
  assert.match(callsToday, /Nothing for you to do; it keeps updating on its own/);
  assert.doesNotMatch(callsToday, /the row shows its own status from here/);
  assert.match(callsToday, /if\(bucket==="in_review"\)\{stopWatch\(callId,null\);return reopenOnNewBlocker/);
  // Only the watched row is repainted; the rest of the page (and any panel open
  // on another row) is left alone.
  assert.match(callsToday, /function paintRow\(callId\)/);
  assert.match(callsToday, /what\.innerHTML=whatHtml\(call\)/);
  assert.match(callsToday, /async function fetchCall\(callId\)/);
  // "Approve and send" takes the same road: the email is not sent until the
  // Mailroom sends it, so the row keeps watching.
  assert.match(callsToday, /afterAction\(reviewId\);/);
  assert.match(callsToday, /watchRowUntilSent\(call&&call\.id,reviewId\)/);
  assert.match(callsToday, /function watching\(\)/);
});

test("no raw enum, id or state token is ever printed on a row or in a panel", () => {
  // Every state word David can see on this page comes from a written sentence,
  // not from a backend token.
  const rendered = (source) => source.split("\n").flatMap((line) => [...line.matchAll(/>([^<>]*)</g)].map((m) => m[1]));
  const shown = [...rendered(callsToday), ...rendered(controls)].join(" | ");
  for (const token of ["review_identity", "review_preferences", "review_profile", "ACTIVATION_REVOKED", "still_working", "in_review", "no_show", "obligationState", "epochId"]) {
    assert.ok(!shown.includes(token), `${token} is rendered as visible text`);
  }
  // The same dead end on the row itself, not just in the panel.
  // detail.why is freeform upstream prose with no token behind it, so the swap
  // matches the phrase rather than one exact sentence, and only on a row that
  // really does have a Fix button to open.
  assert.match(callsToday, /const RELABEL_DETAIL=\/needs a system repair\/i;/);
  assert.match(callsToday, /bucketOf\(call\)==="in_review"&&RELABEL_DETAIL\.test\(detail\)/);
  assert.match(callsToday, /Open Fix to see what this needs/);
  // "needs a system repair" survives only where it is true: an obligation that
  // failed with no allowed action. A relabelled row is answered before the
  // panel ever reaches the backend's own summary.
  assert.match(controls, /Ready to continue/);
  const failedCopy = controls.indexOf('status==="failed"');
  const relabelCopy = controls.indexOf('isRelabelled(item)||state==="review_preferences"');
  const rawSummary = controls.indexOf('plainText(item?.summary,"Review required")');
  assert.ok(failedCopy > -1 && relabelCopy > failedCopy && rawSummary > relabelCopy);
});

// ---- What a click actually posts, and what the panel says while it can't ----

test("a save with nothing filled in is stopped here instead of coming back as a token", () => {
  // fieldValues drops empty strings and an untouched "Choose…" select, so the
  // ordinary click — the one missing field is empty by definition — produced
  // changes:{}, which the proxy rejects as review_value_invalid: a bare token
  // with no whitespace, which plainError can only render as the generic "that
  // didn't work". That is the dead end this module exists to remove.
  assert.match(controls, /if\(FIELD_ACTIONS\.has\(action\)&&!Object\.keys\(changes\|\|\{\}\)\.length\)/);
  assert.match(controls, /Fill in at least one field above, then press Save and continue\./);
  assert.match(controls, /Choose an option above first, then press Save and continue\./);
  // It sits in runAction, before the POST, so every caller of the shared module
  // is covered rather than one page's click handler.
  const guard = controls.indexOf("FIELD_ACTIONS.has(action)&&!Object.keys(changes||{}).length");
  const post = controls.indexOf('await api("/api/post-call/review",{method:"POST"');
  assert.ok(guard > -1 && post > guard);
  // The proxy is the rule this guard exists to satisfy.
  assert.match(reviewProxy, /if \(!changes \|\| !Object\.keys\(changes\)\.length\) return false;/);
});

test("each save carries only its own answer, never the other action's field", () => {
  // allowedFields is a flat list rendered into one shared block, so a row that
  // allows set_call_outcome AND set_role_verdict draws two save buttons over
  // the same controls. Without scoping, either button posts both answers and
  // the proxy forwards the one nobody clicked.
  assert.match(controls, /const ACTION_OWN_FIELD=\{set_call_outcome:"callOutcome",set_role_verdict:"roleVerdict"\}/);
  assert.match(controls, /for\(const owner of Object\.keys\(ACTION_OWN_FIELD\)\)\{\s*if\(owner!==action\)delete values\[ACTION_OWN_FIELD\[owner\]\];/);
  // A draft snapshot (collectChanges with no action) still keeps every value,
  // or a redraw would throw away what was typed into the other control.
  assert.match(controls, /if\(!action\)return values;/);
});

test("a transcript longer than the service accepts is stopped in the box, not on the server", () => {
  // safeChanges slices every string to 8000 before validateChanges sees it, so
  // the length check upstream can never fail: a longer transcript is silently
  // truncated and the toast still says it saved.
  assert.match(controls, /<textarea id="fix-field-\$\{esc\(name\)\}" data-field="\$\{esc\(name\)\}" maxlength="8000"/);
  assert.match(controls, /Up to 8,000 characters/);
  assert.match(reviewProxy, /raw\.slice\(0, 8_000\)/);
});

test("a send approval says what the one button does, and why it is missing", () => {
  // Send approval renders no field and no picker, so the generic fallback
  // ("Fix what is asked below") pointed at an empty panel on the one action
  // that releases an email.
  assert.match(controls, /This candidate's email is ready to send/);
  assert.match(controls, /Nothing else needs fixing — press Approve and send to release it\./);
  assert.match(controls, /reasonCode\(item\)==="send_approval_required"&&allowed\.includes\("resume"\)/);
  // Without the capability the row is not broken, it is not yours to press.
  assert.match(controls, /Releasing it needs send approval, which this account does not have\./);
  assert.match(controls, /Nothing here sends it\. Ask for send approval, or hand this one to someone who has it on the Review board\./);
  // The hint rides alongside whatever else the row allows (a retry button is
  // not a send), and replaces the generic "nothing to press" when it is alone.
  assert.match(controls, /const approvalGap=sendApproval&&!can\(actor,"approve_send"\)/);
  assert.match(controls, /if\(!buttons\.length\)return approvalGap\|\|`<p class="hint">There is nothing to press/);
  assert.match(controls, /join\(""\)\}<\/div>\$\{approvalGap\}`/);
});

// A relabelled identity row must be HELD (no picker, no confirm_absent): until the
// service restores its real state, an action would resume past the identity
// readback. The service's own sweep restores it; the picker returns afterwards.
test("a relabelled identity row is held until the service restores it", async () => {
  const controls = await readFile(new URL("../review-controls.js", import.meta.url), "utf8");
  assert.match(controls, /isRelabelled\(item\)&&state==="review_identity"/);
  assert.match(controls, /Being restored automatically/);
  assert.match(controls, /nothing to press yet/);
});
