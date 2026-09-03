import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { operatorAccess } from "../api/_lib/operator-access.mjs";

const index = await readFile(new URL("../index.html", import.meta.url), "utf8");
const review = await readFile(new URL("../review.html", import.meta.url), "utf8");
const reviewProxy = await readFile(new URL("../api/post-call/review.mjs", import.meta.url), "utf8");
const vercel = JSON.parse(await readFile(new URL("../vercel.json", import.meta.url), "utf8"));

test("Review is wired through all dashboard registries without Mailroom", () => {
  const views = JSON.parse(index.match(/const VIEWS=(\[[^\]]+\]);/)[1]);
  assert.ok(views.includes("review"));
  assert.match(index, /id="tab-review"/);
  assert.match(index, /id="view-review" hidden/);
  assert.match(index, /\{name:"review",label:"Review",group:"People"\}/);
  assert.ok(vercel.rewrites.some((row) => row.source === "/review" && row.destination === "/review.html"));
  assert.ok(vercel.functions["api/post-call/*.mjs"]);
  assert.doesNotMatch(index, /id="tab-mailroom"|id="view-mailroom"/);
  assert.ok(!vercel.rewrites.some((row) => row.source === "/mailroom"));
});

test("the existing Emails and Master Inbox surfaces remain registered", () => {
  for (const name of ["emails", "master-inbox"]) {
    assert.match(index, new RegExp(`id="tab-${name}"`));
    assert.match(index, new RegExp(`id="view-${name}" hidden`));
  }
});

test("Review is Google-gated and only calls its same-origin proxy", () => {
  assert.match(review, /RaydarAuth\.session\(\)/);
  assert.match(review, /credentials:"same-origin"/);
  assert.doesNotMatch(review, /POST_CALL_BASE|POST_CALL_MONITOR_API_KEY/);
  assert.doesNotMatch(review, /\/api\/v1\/reviews|\/api\/v1\/review-actions/);
  assert.doesNotMatch(review, /localStorage|sessionStorage|indexedDB/);
  assert.match(review, /\/api\/post-call\/review/);
});

test("Review renders only server-allowlisted actions and fields", () => {
  assert.match(review, /item\.allowedActions/);
  assert.match(review, /item\.allowedFields/);
  assert.match(review, /data-action="\$\{action\}"/);
  assert.match(review, /version:STATE\.active\.version/);
  assert.match(review, /crypto\.subtle\.digest\("SHA-256"/);
  assert.match(review, /application\/pdf/);
  assert.match(review, /attach_resume/);
  assert.match(review, /25 MB maximum/);
  assert.match(review, /file\.size>25\*1024\*1024/);
  assert.match(reviewProxy, /sizeBytes > 25 \* 1024 \* 1024/);
  assert.match(review, /authoritative source/);
  assert.match(review, /never kept in Monitor browser storage/);
  assert.match(review, /evidence v/);
  assert.match(review, /new URLSearchParams/);
  assert.match(review, /Search candidate, email, LinkedIn, call, or recruiter/);
  assert.match(review, /Continuing…/);
  assert.match(review, /startContinuingPoll/);
  assert.match(review, /item\.candidate\?\.displayName/);
  assert.match(review, /item\.blockers/);
  assert.match(review, /item\.sourceLinks/);
  assert.match(review, /Technical evidence/);
  assert.match(review, /metrics=1/);
  assert.match(review, /All \(90 days\)/);
});

test("Review proxy owns auth attribution and optimistic concurrency", () => {
  assert.match(reviewProxy, /POST_CALL_BASE/);
  assert.match(reviewProxy, /POST_CALL_MONITOR_API_KEY/);
  assert.match(reviewProxy, /POST_CALL_REVIEW_ASSERTION_SECRET/);
  assert.match(reviewProxy, /"x-raydar-actor-email": access\.email/);
  assert.match(reviewProxy, /"x-raydar-review-assertion": assertion/);
  assert.match(reviewProxy, /"if-match": `"\$\{version\}"`/);
  assert.match(reviewProxy, /\/api\/v2\/reviews\/\$\{encodeURIComponent\(reviewId\)\}\/resume-files/);
  assert.match(reviewProxy, /\/api\/v2\/reviews\/\$\{encodeURIComponent\(reviewId\)\}\/actions/);
  assert.match(reviewProxy, /\/api\/v2\/reviews\/metrics/);
  assert.doesNotMatch(reviewProxy, /payload\.actor/);
});

// Status v2 build plan step 2: a `?funnel=1` branch beside `?metrics=1`,
// proxying GET /api/v2/reviews/funnel with the same signing/assertion. The
// endpoint may not exist upstream yet — a 404/501 must read as "no
// publisher yet", not an error, so the Status v2 aggregator can render "—"
// honestly instead of failing the whole page.
test("Review proxy's funnel branch mirrors metrics and tolerates an unpublished upstream", () => {
  assert.match(reviewProxy, /funnelRequested/);
  assert.match(reviewProxy, /req\.query\?\.funnel.*===\s*"1"/);
  assert.match(reviewProxy, /\/api\/v2\/reviews\/funnel/);
  assert.match(reviewProxy, /response\.status === 404 \|\| response\.status === 501/);
  assert.match(reviewProxy, /"not_published"/);
  // The funnel path is chosen through the same signed `upstream()` helper as
  // metrics — no separate fetch, no separate auth path.
  assert.match(reviewProxy, /funnelRequested\s*\?\s*"\/api\/v2\/reviews\/funnel"/);
});

test("Review can be deployed read-only without changing its future role model", () => {
  const allowlist = { POST_CALL_REVIEW_ADMIN_EMAILS: "david@raydar.xyz" };
  const normal = operatorAccess("david@raydar.xyz", allowlist);
  assert.equal(normal.capabilities.reviewWrite, true);
  const preview = operatorAccess("david@raydar.xyz", { ...allowlist, POST_CALL_REVIEW_READ_ONLY: "true" });
  assert.equal(preview.capabilities.reviewRead, true);
  assert.equal(preview.capabilities.reviewWrite, false);
  assert.equal(preview.capabilities.resumeUpload, false);
});

test("Review permissions separate assistant, recruiter, and high-risk admin powers", () => {
  const env = {
    POST_CALL_REVIEW_ADMIN_EMAILS: "david@raydar.xyz",
    POST_CALL_REVIEW_ASSISTANT_EMAILS: "assistant@raydar.xyz",
    POST_CALL_REVIEW_OPERATOR_EMAILS: "ops@raydar.xyz",
    POST_CALL_REVIEW_RECRUITER_EMAILS: "recruiter@raydar.xyz",
  };
  const assistant = operatorAccess("assistant@raydar.xyz", env);
  assert.equal(assistant.role, "assistant");
  assert.equal(assistant.capabilities.reviewWrite, true);
  assert.equal(assistant.capabilities.reviewIdentityOverride, false);
  assert.equal(assistant.capabilities.reviewAssign, true);
  const recruiter = operatorAccess("recruiter@raydar.xyz", env);
  assert.equal(recruiter.role, "recruiter");
  assert.equal(recruiter.capabilities.reviewRead, true);
  assert.equal(recruiter.capabilities.reviewWrite, false);
  const admin = operatorAccess("david@raydar.xyz", env);
  assert.equal(admin.capabilities.reviewIdentityOverride, true);
  assert.equal(admin.capabilities.reviewPriority, true);
});
