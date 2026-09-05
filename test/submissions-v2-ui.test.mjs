import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const js = await readFile(new URL("../submissions-v2.js", import.meta.url), "utf8");
const css = await readFile(new URL("../submissions-v2.css", import.meta.url), "utf8");
const uiState = await readFile(new URL("../submissions-v2-ui-state.mjs", import.meta.url), "utf8");

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
  assert.match(js, /const noun = STATE\.page === "needs_review" \? "review item" : "candidate"/);
});

test("a proven submission remains explicit while a resume issue stays actionable", () => {
  assert.match(js, /row\.submission_status === "proven" \? '<span class="submitted-label">SUBMITTED<\/span>' : ""/);
  assert.match(js, /The submission is recorded; download unlocks when the resume is ready\./);
  assert.match(js, /runReviewAction\("retry_preparation"/);
});

test("source health distinguishes reported delays from committed Gmail and Sequence checkpoints", () => {
  assert.match(js, /"No reported delays"/);
  assert.match(js, /healthCoverageDetails\(health\.sources\)/);
  assert.match(js, /Live committed through/);
  assert.match(js, /History committed through/);
  assert.match(js, /Cache confirmed through/);
  assert.match(js, /source\.safeErrorDetail/);
  assert.match(css, /\.source-health-details\{/);
});
