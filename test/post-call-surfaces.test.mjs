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
  assert.match(review, /authoritative source/);
  assert.match(review, /never kept in Monitor browser storage/);
  assert.match(review, /evidence v/);
  assert.match(review, /limit=50&cursor=/);
});

test("Review proxy owns auth attribution and optimistic concurrency", () => {
  assert.match(reviewProxy, /POST_CALL_BASE/);
  assert.match(reviewProxy, /POST_CALL_MONITOR_API_KEY/);
  assert.match(reviewProxy, /"x-raydar-actor-email": access\.email/);
  assert.match(reviewProxy, /"if-match": `"\$\{version\}"`/);
  assert.match(reviewProxy, /\/api\/v1\/review-files/);
  assert.match(reviewProxy, /\/api\/v1\/review-actions/);
  assert.doesNotMatch(reviewProxy, /payload\.actor/);
});

test("Review can be deployed read-only without changing its future role model", () => {
  const normal = operatorAccess("david@raydar.xyz", {});
  assert.equal(normal.capabilities.reviewWrite, true);
  const preview = operatorAccess("david@raydar.xyz", { POST_CALL_REVIEW_READ_ONLY: "true" });
  assert.equal(preview.capabilities.reviewRead, true);
  assert.equal(preview.capabilities.reviewWrite, false);
  assert.equal(preview.capabilities.resumeUpload, false);
});
