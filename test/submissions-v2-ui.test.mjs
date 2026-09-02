import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const js = await readFile(new URL("../submissions-v2.js", import.meta.url), "utf8");
const css = await readFile(new URL("../submissions-v2.css", import.meta.url), "utf8");

test("bootstrap obtains public Google configuration before the protected V2 session", () => {
  const config = js.indexOf('publicJson("/api/auth/config")');
  const session = js.indexOf('request("/api/submissions-v2/session")');
  assert.ok(config > -1);
  assert.ok(session > config);
  assert.match(js, /STATE\.authConfig\?\.googleClientId/);
  assert.match(js, /STATE\.authConfig\.durableSessionEnabled/);
});

test("candidate-name filtering and list paging are complete server-side reads", () => {
  assert.match(js, /new URLSearchParams\(\{ page, limit: "100" \}\)/);
  assert.match(js, /params\.set\("q", query\)/);
  assert.match(js, /params\.set\("cursor", cursor\)/);
  assert.match(js, /\/api\/submissions-v2\/list\?\$\{params\}/);
  assert.match(js, /data\.next_cursor/);
  assert.match(js, /data\.total_count \?\? data\.total \?\? data\.count/);
  assert.match(js, /append \? \[\.\.\.STATE\.rows/);
});

test("list, count, and picker reads abort superseded work and reject stale list results", () => {
  assert.match(js, /STATE\.listRequest\?\.abort\(\)/);
  assert.match(js, /sequence !== STATE\.listSequence \|\| page !== STATE\.page \|\| query !== STATE\.query/);
  assert.match(js, /STATE\.countsRequest\?\.abort\(\)/);
  assert.match(js, /STATE\.searchRequests\.get\(target\.id\)\?\.abort\(\)/);
  assert.match(js, /error\.name !== "AbortError"/);
});

test("a version conflict refreshes current state before the recruiter retries", () => {
  assert.match(js, /error\.status === 409/);
  assert.match(js, /Promise\.allSettled\(\[loadCounts\(\), loadRows\(\)\]\)/);
  assert.match(js, /state_conflict_refreshed/);
  assert.match(js, /latest version was refreshed/);
});

test("every server-provided destination is constrained to its explicit host family", () => {
  assert.match(js, /signal: \["raydar\.xyz", "paraform\.com"\]/);
  assert.match(js, /submit: \["paraform\.com"\]/);
  assert.match(js, /storage: \["vercel-storage\.com"\]/);
  assert.match(js, /safeUrl\(row\.signal_url, URL_HOSTS\.signal\)/);
  assert.match(js, /safeUrl\(data\.redirect_url, URL_HOSTS\.submit\)/);
  assert.match(js, /safeUrl\(data\.url, URL_HOSTS\.storage\)/);
  assert.match(js, /url\.protocol !== "https:"/);
  assert.match(js, /url\.hostname\.endsWith\(`\.\$\{host\}`\)/);
});

test("resume download opens a top-level PDF viewer before its asynchronous ticket request", () => {
  const preopen = js.indexOf('window.open("about:blank", "_blank")');
  const ticket = js.indexOf("resume/download-ticket", preopen);
  const navigate = js.indexOf("viewer.location.replace(downloadUrl)", ticket);
  assert.ok(preopen > -1);
  assert.ok(ticket > preopen);
  assert.ok(navigate > ticket);
  assert.doesNotMatch(js.slice(preopen, navigate), /anchor\.download/u);
});

test("generation progress survives rendering and remains reduced-motion safe", () => {
  assert.match(js, /ACTIVE_GENERATION_STATES/);
  assert.match(js, /STATE\.generating\.has\(id\)/);
  assert.match(js, /aria-label="\$\{generating \? "Generating resume" : "Regenerate resume"\}"/);
  assert.match(js, /aria-busy="\$\{generating\}"/);
  assert.match(js, /STATE\.generating\.add\(String\(id\)\)/);
  assert.match(js, /STATE\.generating\.delete\(String\(id\)\)/);
  assert.match(css, /@media\(prefers-reduced-motion:reduce\)/);
});

test("warning details work on hover, focus, and click and can open Add context", () => {
  assert.match(js, /node\.onpointerenter/);
  assert.match(js, /node\.onfocus/);
  assert.match(js, /node\.onclick/);
  assert.match(js, /aria-haspopup/);
  assert.match(js, />Add context<\/button>/);
  assert.match(js, /openRegenerate\(id\)/);
});

test("Needs Review exposes reason-specific candidate, role, retry, and Signal resolution paths", () => {
  assert.match(js, /title: "Match the signal"/);
  assert.match(js, /const offeredRoles = Array\.isArray\(row\.offered_roles\)/);
  assert.match(js, /bindMultiSearchSelection\(\$\("role-results"\), "role_ids"\)/);
  assert.match(js, /review-role-query/u);
  assert.match(js, /searchIndex\("roles", roleQuery\.value/u);
  assert.match(js, /command\(action, input\)/);
  assert.match(js, /runReviewAction\("recheck"/);
  assert.match(js, /runReviewAction\("retry_classification"/);
  assert.match(js, /runReviewAction\("retry_preparation"/);
  assert.match(js, /title: "Review the candidate signal"/);
  assert.match(js, /Open Signal/);
});
