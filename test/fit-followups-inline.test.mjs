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

test("Fit Follow Ups loads the shared Review controls and offers a Fix button per parked row", () => {
  assert.match(callsToday, /<script src="\/review-controls\.js"><\/script>/);
  assert.match(callsToday, /window\.RaydarReviewControls/);
  assert.match(callsToday, /data-fix="\$\{esc\(call\.reviewId\)\}"/);
  assert.match(callsToday, /button ghost small/);
  assert.match(callsToday, />\$\{open\?"Close":"Fix"\}</);
  // Only rows actually parked in review get the button; a delivered follow-up
  // keeps its Review board link and nothing else changes.
  assert.match(callsToday, /function isFixable\(call\)/);
  assert.match(callsToday, /call\.result\?\.tone!=="good"/);
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
  assert.match(callsToday, /if\(STATE\.panelOpen\)return;/);
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
