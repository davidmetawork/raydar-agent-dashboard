import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { operatorAccess, reviewAccess } from "../api/_lib/operator-access.mjs";

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
  assert.match(review, /up to 25 MB/);
  assert.match(review, /file\.size>25\*1024\*1024/);
  assert.match(reviewProxy, /sizeBytes > 25 \* 1024 \* 1024/);
  assert.match(review, /authoritative source/);
  assert.match(review, /evidence v/);
  assert.match(review, /new URLSearchParams/);
  assert.match(review, /Search candidate, email, LinkedIn, call, or recruiter/);
  assert.match(review, /The workflow is continuing/);
  assert.match(review, /startContinuingPoll/);
  assert.match(review, /Approve and send/);
  assert.match(review, /approveSend:true/);
  assert.match(review, /item\.candidate\?\.displayName/);
  assert.match(review, /What needs to happen/);
  assert.match(review, /Save and continue/);
  assert.match(review, /Upload résumé and continue/);
  assert.match(review, /const c=item\.candidate\|\|\{\},call=item\.call\|\|\{\},continuing=.*help=/);
  assert.match(review, /Call transcript/);
  assert.doesNotMatch(review, /Technical evidence/);
  assert.doesNotMatch(review, /What needs attention/);
  assert.doesNotMatch(review, /Source records/);
  assert.doesNotMatch(review, /Close without sending/);
  assert.doesNotMatch(review, /You have read-only access/);
  assert.doesNotMatch(review, /metrics=1/);
  assert.doesNotMatch(review, /Short audit note/);
  assert.doesNotMatch(review, /Save assignment/);
  assert.doesNotMatch(review, /Save priority/);
  assert.doesNotMatch(review, /Review queue summary/);
  assert.match(review, /All \(90 days\)/);
  assert.match(review, /item\.identityCandidates/);
  assert.match(review, /This call is attached/);
  assert.match(review, /Call attachment not confirmed/);
  assert.match(review, /identityChoice/);
  assert.match(review, /allowed\.has\("resume"\)&&!identityChoice/);
});

test("Review proxy owns auth attribution and optimistic concurrency", () => {
  assert.match(reviewProxy, /POST_CALL_BASE/);
  assert.match(reviewProxy, /POST_CALL_MONITOR_API_KEY/);
  assert.match(reviewProxy, /POST_CALL_REVIEW_FEED_API_KEY/);
  assert.match(reviewProxy, /POST_CALL_REVIEW_ACTION_API_KEY/);
  assert.match(reviewProxy, /post_call_service_authorization_failed/);
  assert.match(reviewProxy, /res\.status\(502\)/);
  assert.match(reviewProxy, /"x-raydar-actor-email": access\.email/);
  assert.match(reviewProxy, /"if-match": `"\$\{version\}"`/);
  assert.match(reviewProxy, /\/api\/v2\/reviews\/\$\{encodeURIComponent\(reviewId\)\}\/resume-files/);
  assert.match(reviewProxy, /\/api\/v2\/reviews\/\$\{encodeURIComponent\(reviewId\)\}\/actions/);
  assert.match(reviewProxy, /\/api\/v2\/reviews\/metrics/);
  assert.match(reviewProxy, /const TIMEOUT_MS = 280_000/);
  assert.match(reviewProxy, /review_send_approval_forbidden/);
  assert.match(reviewProxy, /bodyOut\.approveSend = true/);
  assert.doesNotMatch(reviewProxy, /payload\.actor/);
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

test("everyone who can see Review can resolve and continue its workflow", () => {
  const env = {
    POST_CALL_REVIEW_ADMIN_EMAILS: "david@raydar.xyz",
    POST_CALL_REVIEW_ASSISTANT_EMAILS: "assistant@raydar.xyz",
    POST_CALL_REVIEW_OPERATOR_EMAILS: "ops@raydar.xyz",
    POST_CALL_REVIEW_RECRUITER_EMAILS: "recruiter@raydar.xyz",
  };
  const assistant = operatorAccess("assistant@raydar.xyz", env);
  assert.equal(assistant.role, "assistant");
  assert.equal(assistant.capabilities.reviewWrite, true);
  assert.equal(assistant.capabilities.reviewIdentityOverride, true);
  assert.equal(assistant.capabilities.reviewSendApproval, true);
  assert.equal(assistant.capabilities.reviewAssign, true);
  const recruiter = operatorAccess("recruiter@raydar.xyz", env);
  assert.equal(recruiter.role, "recruiter");
  assert.equal(recruiter.capabilities.reviewRead, true);
  assert.equal(recruiter.capabilities.reviewWrite, true);
  assert.equal(recruiter.capabilities.reviewIdentityOverride, true);
  const admin = operatorAccess("david@raydar.xyz", env);
  assert.equal(admin.capabilities.reviewIdentityOverride, true);
  assert.equal(admin.capabilities.reviewSendApproval, true);
  assert.equal(admin.capabilities.reviewPriority, true);
});

test("a Google-authenticated dashboard viewer is authorized only on Review", () => {
  const env = {};
  const ordinary = operatorAccess("teammate@raydar.xyz", env);
  assert.equal(ordinary.capabilities.reviewRead, false);
  assert.equal(ordinary.capabilities.mailroomRead, false);
  const review = reviewAccess("teammate@raydar.xyz", env);
  assert.equal(review.role, "reviewer");
  assert.equal(review.capabilities.reviewRead, true);
  assert.equal(review.capabilities.reviewWrite, true);
  assert.equal(review.capabilities.reviewIdentityOverride, true);
  assert.equal(review.capabilities.reviewSendApproval, true);
  assert.equal(review.capabilities.mailroomRead, false);
});
