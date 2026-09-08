import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const js = await readFile(new URL("../submissions-v2.js", import.meta.url), "utf8");
const html = await readFile(new URL("../submissions-v2.html", import.meta.url), "utf8");
const css = await readFile(new URL("../submissions-v2.css", import.meta.url), "utf8");
const uiState = await readFile(new URL("../submissions-v2-ui-state.mjs", import.meta.url), "utf8");
const dashboard = await readFile(new URL("../index.html", import.meta.url), "utf8");

function between(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.notEqual(from, -1, `missing ${start}`);
  assert.notEqual(to, -1, `missing ${end}`);
  return source.slice(from, to);
}

test("bootstrap obtains public Google configuration before the protected V2 session", () => {
  const config = js.indexOf('publicJson("/api/auth/config")');
  const session = js.indexOf('request("/api/submissions-v2/session")');
  assert.ok(config > -1);
  assert.ok(session > config);
  assert.match(js, /STATE\.authConfig\?\.googleClientId/);
  assert.match(js, /STATE\.authConfig\.durableSessionEnabled/);
});

test("candidate-name filtering and list paging are complete server-side reads", () => {
  assert.match(js, /new URLSearchParams\(\{ page: scope\.page, limit: "100" \}\)/);
  assert.match(js, /params\.set\("q", scope\.query\)/);
  assert.match(js, /params\.set\("cursor", cursor\)/);
  assert.match(js, /\/api\/submissions-v2\/list\?\$\{params\}/);
  assert.match(js, /data\.next_cursor/);
  assert.match(js, /reconcileListPages/);
  assert.match(js, /currentRows: STATE\.rows/);
});

test("visible list totals name candidate-role pairs rather than unique people", () => {
  assert.match(html, /id="display-count">0 candidate-role pairs/);
  assert.match(js, /const noun = listEntityNoun\(STATE\.page\)/);
  assert.match(js, /listEntityNoun\(STATE\.page\).*loaded/s);
});

test("Review surfaces safe preparation failures and prominent per-source freshness", () => {
  assert.match(html, /id="source-freshness" aria-label="Per-source freshness"/);
  assert.match(js, /preparationFailurePresentation\(row\)/);
  assert.match(js, /Last attempt/);
  assert.match(uiState, /starts one new, separately budgeted attempt/);
  assert.match(js, /Retry resume preparation/);
  assert.match(js, /lastSuccessAt/);
  assert.match(js, /Last successful check/);
  assert.match(js, /!\(coverage \|\| lastSuccess\)/);
  assert.match(js, /source-freshness-card/);
});

test("polling is quiet for unchanged rows and preserves review drafts", () => {
  assert.match(html, /id="list-status" role="status" aria-live="polite"/);
  assert.doesNotMatch(html, /id="rows"[^>]+aria-live=/);
  assert.match(js, /listRenderDisposition\(\{/);
  assert.match(js, /STATE\.rowsDirty = true/);
  assert.match(js, /if \(STATE\.rowsDirty\) renderRows\(\{ force: true \}\)/);
  assert.match(js, /focusedRowDescendant\(\)/);
  assert.match(js, /restoreFocusedRowDescendant\(focus\)/);
  assert.match(js, /popoverOpen/);
  assert.match(js, /closePopover\(\{ renderDeferred: false \}\)/);
  assert.match(js, /loadRows\(\{ refresh: true, background: true \}\)/);
});

test("changed rows retain stable link focus and existing-result navigation resets tab focus", () => {
  assert.match(js, /node\.matches\("\.candidate-name"\)/);
  assert.match(js, /node\.matches\("\.identity-link\.linkedin"\)/);
  assert.match(js, /node\.matches\("\.identity-link\.raydar"\)/);
  assert.match(js, /node\.matches\("\.signal-link"\)/);
  assert.match(js, /if \(node instanceof HTMLElement && !node\.matches\(":disabled"\)\) node\.focus\(\)/);
  assert.match(js, /Object\.assign\(STATE, listPageReset\(\{ page, query \}\)\)/);
  assert.match(js, /activateListPage\(page, \{ query: candidateLabel \}\)/);
  assert.match(js, /activateListPage\(result\.state, \{ query: candidateLabel \}\)/);
});

test("tabs use roving keyboard focus and activate only on an explicit button click", () => {
  assert.match(html, /id="tab-interested"[^>]+tabindex="0"/);
  assert.match(html, /id="tab-needs-review"[^>]+tabindex="-1"/);
  assert.match(js, /tabPageFromKey\(\{ key: event\.key/);
  assert.match(js, /updatePageTabs\(\{ selected: STATE\.page, focusable: target \}\)/);
  assert.match(js, /node\.onclick = \(\) => switchPage\(node\.dataset\.page\)/);
});

test("list, count, and picker reads abort superseded work and reject stale list results", () => {
  assert.match(js, /STATE\.listRequest\?\.abort\(\)/);
  assert.match(js, /listScopeIsCurrent\(scope, STATE\)/);
  assert.match(js, /loadRows\(\{ refresh: true \}\)/);
  assert.match(js, /reconcileListPages\(\{ pages, append, currentRows: STATE\.rows \}\)/);
  assert.match(js, /STATE\.countsRequest\?\.abort\(\)/);
  assert.match(js, /STATE\.searchRequests\.get\(target\.id\)\?\.abort\(\)/);
  assert.match(js, /error\.name !== "AbortError"/);
});

test("only stale pair versions refresh current state before the recruiter retries", () => {
  assert.match(js, /commandConflictResolution\(error\)/);
  assert.match(js, /Promise\.allSettled\(\[loadCounts\(\), loadRows\(\{ refresh: true \}\)\]\)/);
  assert.match(js, /await Promise\.all\(\[loadCounts\(\), loadRows\(\{ refresh: true \}\)\]\)/);
  assert.match(js, /clearToast\(\);\n    closeDialog\(\);/);
});

test("a duplicate source disposition confirms that the existing response was retained", () => {
  assert.match(js, /commandSuccessMessage\(result\)/);
});

test("every server-provided destination is constrained to its explicit host family", () => {
  assert.match(js, /signal: \["raydar\.xyz", "paraform\.com", "mail\.google\.com"\]/);
  assert.match(js, /submit: \["paraform\.com"\]/);
  assert.match(js, /storage: \["vercel-storage\.com"\]/);
  assert.match(js, /safeUrl\(row\.signal_url, URL_HOSTS\.signal\)/);
  assert.match(js, /safeUrl\(source\.url, URL_HOSTS\.signal\)/);
  assert.match(js, /safeUrl\(data\.redirect_url, URL_HOSTS\.submit\)/);
  assert.match(js, /safeUrl\(data\.url, URL_HOSTS\.storage\)/);
  assert.match(js, /url\.protocol !== "https:"/);
  assert.match(js, /url\.hostname\.endsWith\(`\.\$\{host\}`\)/);
});

test("resume download uses a top-level native save picker before fetching the private PDF", () => {
  const picker = js.indexOf('pickerHost.showSaveFilePicker({');
  const ticket = js.indexOf("resume/download-ticket", picker);
  const pdfFetch = js.indexOf("fetch(downloadUrl", ticket);
  const write = js.indexOf("writable.write(bytes)", pdfFetch);
  assert.ok(picker > -1);
  assert.ok(ticket > picker);
  assert.ok(pdfFetch > ticket);
  assert.ok(write > pdfFetch);
  assert.match(js.slice(picker, write), /startIn: "downloads"/u);
  assert.match(js.slice(pdfFetch, write), /contentType\.startsWith\("application\/pdf"\)/u);
  assert.match(js.slice(pdfFetch, write), /!== "%PDF-"/u);
});

test("resume download falls back to a top-level PDF viewer when the native picker is unavailable", () => {
  const preopen = js.indexOf('window.open("about:blank", "_blank")');
  const ticket = js.indexOf("resume/download-ticket", preopen);
  const navigate = js.indexOf("viewer.location.replace(downloadUrl)", ticket);
  assert.ok(preopen > -1);
  assert.ok(ticket > preopen);
  assert.ok(navigate > ticket);
  assert.doesNotMatch(js.slice(preopen, navigate), /anchor\.download/u);
});

test("Submit opens a blank popup during the click and only then requests its destination", () => {
  const submit = js.indexOf("async function openSubmit");
  const popup = js.indexOf('const popup = window.open("about:blank", "_blank")', submit);
  const request = js.indexOf("submit-open", submit);
  assert.ok(popup > submit);
  assert.ok(request > popup);
  assert.match(js.slice(submit, request + 500), /navigateSubmitPopup\(popup, url\)/);
  assert.match(js.slice(submit, request + 500), /popup\.close\(\)/);
});

test("generation progress survives rendering and remains reduced-motion safe", () => {
  assert.match(js, /ACTIVE_GENERATION_STATES/);
  for (const state of ["queued", "collecting", "extracting", "strategizing", "validating", "rendering", "archiving"]) {
    assert.match(js, new RegExp(`"${state}"`));
  }
  assert.match(js, /STATE\.generating\.has\(id\)/);
  assert.match(js, /aria-label="\$\{generating \? "Generating resume" : "Regenerate resume"\}"/);
  assert.match(js, /aria-busy="\$\{generating\}"/);
  assert.match(js, /STATE\.generating\.add\(key\)/);
  assert.match(js, /STATE\.generating\.delete\(key\)/);
  assert.match(js, /Regeneration started; the finished resume will save to Downloads automatically\./);
  assert.match(js, /The new resume is ready to download\./);
  assert.match(js, /class="rerun-icon"/);
  assert.match(css, /\.icon-button\.regenerate\{border-radius:50%\}/);
  assert.match(css, /\.rerun-icon\{[^}]*stroke:currentColor/);
  assert.match(css, /@media\(prefers-reduced-motion:reduce\)/);
});

test("the embedded Review dialog measures the outer visible iframe slice", () => {
  assert.match(js, /window\.frameElement/);
  assert.match(js, /window\.addEventListener\("resize", update\)/);
  assert.match(js, /embeddedModalViewportCleanup\(\)/);
  assert.match(js, /embeddedModalViewport\(\{/);
  assert.match(js, /embed-viewport-bound/);
  assert.match(css, /body\.embed \.modal\.embed-viewport-bound/);
  assert.match(dashboard, /raydar-submissions-v2-height/);
  assert.match(dashboard, /event\.source!==frame\.contentWindow/);
  assert.match(dashboard, /submissions-frame.*min-height:900px/);
});

test("a requested regeneration survives reload and downloads the validated replacement automatically", () => {
  assert.match(js, /AUTO_DOWNLOAD_STORAGE_KEY/);
  assert.match(js, /sessionStorage\.setItem\(AUTO_DOWNLOAD_STORAGE_KEY/);
  assert.match(js, /STATE\.pendingDownloads\.set\(key, String\(row\.current_artifact_id \|\| ""\)\)/);
  assert.match(js, /row\.current_artifact_id !== priorArtifactId/);
  assert.match(js, /autoDownloadResume\(row\)/);
  assert.match(js, /URL\.createObjectURL\(new Blob\(\[bytes\], \{ type: "application\/pdf" \}\)\)/);
  assert.match(js, /anchor\.download = data\.filename \|\| suggestedResumeFilename\(row\)/);
  assert.match(js, /Saved \$\{anchor\.download\} to Downloads\./);
  assert.match(js, /Resume generation is already running; the finished resume will save to Downloads automatically\./);
});

test("warning details work on hover, focus, and click without opening regeneration", () => {
  assert.match(js, /node\.onpointerenter/);
  assert.match(js, /node\.onfocus/);
  assert.match(js, /node\.onclick/);
  assert.match(js, /aria-haspopup/);
  assert.match(js, /Resume note/);
  assert.match(js, /Resume notes \(\$\{cautions\.length\}\)/);
  assert.doesNotMatch(js, /Resume source caution">!<\/button>/);
  assert.doesNotMatch(js, />Add context<\/button>/);
  assert.doesNotMatch(js, /openRegenerate\(id\)/);
});

test("rows show a verified admission label and link without fabricating candidate or provider URLs", () => {
  assert.match(js, /admissionSourcePresentation\(row\.admission_source\)/);
  assert.match(js, /admission-source/);
  assert.match(js, /Source link/);
  assert.doesNotMatch(js, /candidate_id.*paraform.*candidate/i);
  assert.match(css, /\.admission-source\{/);
  assert.match(css, /\.caution-control\{/);
});

test("Needs Review exposes reason-specific candidate, role, retry, and Signal resolution paths", () => {
  assert.match(js, /title: "Match the signal"/);
  assert.match(js, /const offeredRoles = Array\.isArray\(row\.offered_roles\)/);
  assert.match(js, /bindMultiSearchSelection\(\$\("role-results"\), "role_ids"\)/);
  assert.match(js, /review-role-query/u);
  assert.match(js, /searchIndex\("roles", roleQuery\.value/u);
  assert.match(js, /command\(action, input\)/);
  assert.match(js, /runReviewAction\("recheck"/);
  assert.match(js, /runReviewAction\("recheck_role"/);
  assert.match(js, /data-label="Recheck role"/);
  assert.match(js, /runReviewAction\("retry_classification"/);
  assert.match(js, /runReviewAction\("retry_preparation"/);
  assert.match(js, /reviewProgressPresentation\(row\)/);
  assert.match(js, /View progress/);
  assert.match(js, /Retry is unavailable while this job is active/);
  assert.match(uiState, /generation_updated_at/);
  assert.match(uiState, /generation_deadline_at/);
  assert.match(js, /runReviewAction\("recheck_role"/);
  assert.match(js, /dismiss_review/);
  assert.match(js, /not_candidate_response/);
  assert.match(js, /irrelevant_notification/);
  assert.match(js, /already_handled/);
  assert.match(js, /Already handled<\/option>/);
  assert.doesNotMatch(js, /Already handled on a verified submission/);
  assert.match(js, /title: "Review the candidate signal"/);
  assert.match(js, /Open Signal/);
  assert.match(js, /Original offer/);
  assert.match(js, /Offered roles/);
  assert.match(js, /review-context\?\$\{params\}/);
  assert.match(js, /reviewContextCanRender\(\{ request: controller/);
  assert.match(js, /Choose a decision/);
  assert.match(js, /reviewSummaryHtml\(row\)/);
  assert.match(css, /\.review-evidence\{/);
  assert.match(js, /const source = evidence\.sourceLabel \|\| "Verified source details unavailable"/);
  assert.match(js, /Candidate added; resume preparation has started\./);
  assert.match(js, /reviewRowPresentation\(row\)/);
  assert.doesNotMatch(js, /review-triangle/);
  assert.match(js, /Next step:/);
  assert.match(css, /container-type:inline-size/);
  assert.match(css, /@container \(max-width:1040px\)/);
  assert.match(js, /const noun = listEntityNoun\(STATE\.page\)/);
});

test("a proven submission remains explicit while a resume issue stays actionable", () => {
  assert.match(js, /const submitted = row\.submission_status === "proven" \|\| row\.submitted_manually/);
  assert.match(js, /The submission is recorded; download unlocks when the resume is ready\./);
  assert.match(js, /runReviewAction\("retry_preparation"/);
});

test("David can mark a candidate submitted himself and undo it, ahead of Paraform proof", () => {
  assert.match(js, /manualMarkPresentation, preparationFailurePresentation/);
  assert.match(js, /submissionGroup, tabPageFromKey/);
  assert.match(js, /class="button secondary mark-submitted" data-id="\$\{esc\(id\)\}" type="button" \$\{!canMark \|\| marking \? "disabled" : ""\}/);
  assert.match(js, /marking \? "Marking…" : "Mark submitted"/);
  assert.match(js, /class="button text unmark-submitted" data-id="\$\{esc\(id\)\}" type="button" \$\{!canUnmark \|\| marking \? "disabled" : ""\}>Undo</);
  assert.match(js, /class="submitted-state"><span class="submitted-label">\$\{esc\(manual\?\.label \|\| "SUBMITTED"\)\}<\/span>/);
  assert.match(js, /class="submitted-detail">\$\{esc\(manual\.detail\)\}<\/small>/);
  assert.match(js, /rowCapability\(row, "can_mark_submitted", false\)/);
  assert.match(js, /rowCapability\(row, "can_unmark_submitted", false\)/);
  assert.match(js, /submissionGroup\(row\) === "submitted"/);
  assert.match(js, /document\.querySelectorAll\("\.mark-submitted"\)\.forEach\(\(node\) => \{ node\.onclick = \(\) => markSubmitted\(node\.dataset\.id\); \}\)/);
  assert.match(js, /document\.querySelectorAll\("\.unmark-submitted"\)\.forEach\(\(node\) => \{ node\.onclick = \(\) => unmarkSubmitted\(node\.dataset\.id\); \}\)/);
  const markFn = between(js, "async function markSubmitted(id)", "async function unmarkSubmitted(id)");
  assert.match(markFn, /withRowAction\(id, "mark", async \(\) => \{/);
  assert.match(markFn, /command\("mark_submitted", \{ case_id: id, expected_version: row\.state_version \}\)/);
  assert.match(markFn, /Marked as submitted\. Paraform will confirm it in the background\./);
  const unmarkFn = between(js, "async function unmarkSubmitted(id)", "async function command(");
  assert.match(unmarkFn, /withRowAction\(id, "mark", async \(\) => \{/);
  assert.match(unmarkFn, /command\("unmark_submitted", \{ case_id: id, expected_version: row\.state_version \}\)/);
  assert.match(unmarkFn, /Submission mark removed\./);
  assert.match(css, /\.submitted-detail\{/);
  assert.match(css, /\.submitted-state\{display:flex;flex-direction:column;align-items:flex-end;gap:2px\}/);
});

test("a proven submission with no resume and can_prepare_resume offers Generate resume before Duplicate", () => {
  assert.match(js, /const canPrepareResume = rowCapability\(row, "can_prepare_resume", false\)/);
  assert.match(js, /const preparingResume = rowActionPending\(id, "prepare-resume"\)/);
  const submittedNoArtifactBranch = between(js, "if (submitted && !resume.hasArtifact) {", "return `${historyLabel}${unmark}${generateResume}");
  assert.match(submittedNoArtifactBranch, /resume\.preparing \|\| resume\.generating/);
  assert.match(js, /class="button primary prepare-resume" data-id="\$\{esc\(id\)\}" type="button" \$\{preparingResume \? "disabled" : ""\}>\$\{preparingResume \? "Starting…" : "Generate resume"\}<\/button>/);
  assert.match(js, /\$\{historyLabel\}\$\{unmark\}\$\{generateResume\}<button class="button secondary duplicate"/);
});

test("Generate resume is withheld while can_prepare_resume is false or a generation is already active", () => {
  const generateResumeAssignment = between(js, "const canPrepareResume = rowCapability", "return `${historyLabel}${unmark}${generateResume}");
  assert.match(generateResumeAssignment, /\(resume\.preparing \|\| resume\.generating\)\s*\n\s*\? ""\s*\n\s*: canPrepareResume/);
});

test("prepareResume commands prepare_resume with the row's expected version and refreshes on success", () => {
  assert.match(js, /document\.querySelectorAll\("\.prepare-resume"\)\.forEach\(\(node\) => \{ node\.onclick = \(\) => prepareResume\(node\.dataset\.id\); \}\)/);
  assert.match(js, /"mark-submitted", "unmark-submitted", "prepare-resume", "review-action", "caution"/);
  const prepareFn = between(js, "async function prepareResume(id)", "async function command(");
  assert.match(prepareFn, /rowCapability\(row, "can_prepare_resume", false\)/);
  assert.match(prepareFn, /withRowAction\(id, "prepare-resume", async \(\) => \{/);
  assert.match(prepareFn, /command\("prepare_resume", \{ case_id: id, expected_version: row\.state_version \}\)/);
  assert.match(prepareFn, /toast\("Resume preparation has started\."\)/);
  assert.match(prepareFn, /Promise\.all\(\[loadCounts\(\), loadRows\(\{ refresh: true \}\)\]\)/);
});

test("confirmAdd's existing-pair toast distinguishes rearm outcomes and maps preparing_resume to Interested", () => {
  assert.match(js, /const STATE_PAGE_ALIASES = Object\.freeze\(\{ preparing_resume: "interested" \}\)/);
  assert.match(js, /function pageForState\(state\) \{ return STATE_PAGE_ALIASES\[state\] \|\| state; \}/);
  const confirmAddFn = between(js, "async function confirmAdd()", "function openDuplicate(id)");
  assert.match(confirmAddFn, /const page = pageForState\(result\.state\)/);
  assert.match(confirmAddFn, /if \(result\.existing && PAGE_LABELS\[page\]\)/);
  assert.match(confirmAddFn, /if \(result\.resume_queued\) toast\(`Already in \$\{label\}; resume preparation has started\.`\)/);
  assert.match(confirmAddFn, /else if \(result\.resume_ready\) toast\(`Already in \$\{label\}; the resume is ready\.`\)/);
  assert.match(confirmAddFn, /else if \(result\.preparing\) toast\(`Already in \$\{label\}; the resume is still being prepared\.`\)/);
  assert.match(confirmAddFn, /else if \(result\.rearm === "not_interested"\) toast\("Already in Not Interested; use Correct to move it\."\)/);
  assert.match(confirmAddFn, /else toast\(`Already in \$\{label\}; showing it now\.`\)/);
});

test("source health distinguishes reported delays from committed Gmail and Sequence checkpoints", () => {
  assert.match(js, /"Source status"/);
  assert.match(js, /healthCoverageDetails\(health\.sources\)/);
  assert.match(js, /Live committed through/);
  assert.match(js, /History committed through/);
  assert.match(js, /Cache confirmed through/);
  assert.match(js, /source\.safeErrorDetail/);
  assert.match(css, /\.source-health-details\{/);
});
