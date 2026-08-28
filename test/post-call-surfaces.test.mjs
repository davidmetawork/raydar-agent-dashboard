import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { operatorAccess } from "../api/_lib/operator-access.mjs";

const index = await readFile(new URL("../index.html", import.meta.url), "utf8");
const review = await readFile(new URL("../review.html", import.meta.url), "utf8");
const mailroom = await readFile(new URL("../mailroom.html", import.meta.url), "utf8");
const reviewProxy = await readFile(new URL("../api/post-call/review.mjs", import.meta.url), "utf8");
const mailroomProxy = await readFile(new URL("../api/mailroom/console.mjs", import.meta.url), "utf8");
const vercel = JSON.parse(await readFile(new URL("../vercel.json", import.meta.url), "utf8"));

test("Review and Mailroom are wired through all five dashboard registries", () => {
  const views = JSON.parse(index.match(/const VIEWS=(\[[^\]]+\]);/)[1]);
  for (const [name, group] of [["review", "People"], ["mailroom", "System"]]) {
    assert.ok(views.includes(name));
    assert.match(index, new RegExp(`id="tab-${name}"`));
    assert.match(index, new RegExp(`id="view-${name}" hidden`));
    assert.match(index, new RegExp(`\\{name:"${name}",label:"[^"]+",group:"${group}"\\}`));
    assert.ok(vercel.rewrites.some((row) => row.source === `/${name}` && row.destination === `/${name}.html`));
  }
  assert.ok(vercel.functions["api/post-call/*.mjs"]);
  assert.ok(vercel.functions["api/mailroom/*.mjs"]);
});

test("the existing Emails surface remains registered", () => {
  assert.match(index, /id="tab-emails"/);
  assert.match(index, /id="view-emails" hidden/);
  assert.match(index, /\{name:"emails",label:"Emails",group:"System"\}/);
  assert.ok(vercel.rewrites.some((row) => row.source === "/emails" && row.destination === "/emails.html"));
});

test("both new pages are Google-gated and only call same-origin proxy routes", () => {
  for (const page of [review, mailroom]) {
    assert.match(page, /RaydarAuth\.session\(\)/);
    assert.match(page, /credentials:"same-origin"/);
    assert.doesNotMatch(page, /POST_CALL_BASE|POST_CALL_MONITOR_API_KEY|MAILROOM_API_KEY/);
    assert.doesNotMatch(page, /raydar-mailroom\.vercel\.app\/api|\/api\/v1\/reviews|\/api\/v1\/review-actions/);
    assert.doesNotMatch(page, /localStorage|sessionStorage|indexedDB/);
  }
  assert.match(review, /\/api\/post-call\/review/);
  assert.match(mailroom, /\/api\/mailroom\/console/);
});

test("Review renders only server-allowlisted actions and fields", () => {
  assert.match(review, /item\.allowedActions/);
  assert.match(review, /item\.allowedFields/);
  assert.match(review, /data-action="\$\{action\}"/);
  assert.match(review, /If-Match|version:STATE\.active\.version/);
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

test("Mailroom supports versioned copy, lane controls, evidence and conflicts", () => {
  for (const action of ["save", "preview", "activate", "revert"]) assert.match(mailroom, new RegExp(`"${action}"`));
  for (const surface of ["Senders & transports", "Outbox", "Delivery", "Review", "Immutable change history"]) assert.ok(mailroom.includes(surface));
  assert.match(mailroom, /error\.status===409/);
  assert.match(mailroomProxy, /expectedRevision/);
  assert.match(mailroomProxy, /expectedLaneRevision/);
  assert.match(mailroomProxy, /schemaVersion: 2/);
  assert.match(mailroomProxy, /actor = access\.email/);
  assert.match(mailroomProxy, /action !== "preview"/);
  assert.doesNotMatch(mailroomProxy, /payload\.actor/);
  assert.match(mailroom, /not copied into Gmail Sent/);
  assert.match(mailroom, /replies still return to Gmail through Reply-To/);
});

test("RBAC defaults make Review team-operable and Mailroom editor-restricted", () => {
  const david = operatorAccess("david@raydar.xyz", {});
  assert.equal(david.role, "admin");
  assert.equal(david.capabilities.reviewWrite, true);
  assert.equal(david.capabilities.mailroomWrite, true);

  const assistant = operatorAccess("assistant@raydargroup.com", {});
  assert.equal(assistant.role, "reviewer");
  assert.equal(assistant.capabilities.reviewWrite, true);
  assert.equal(assistant.capabilities.mailroomWrite, false);

  const explicitEditor = operatorAccess("ops@raydar.xyz", { MAILROOM_EDITOR_EMAILS: "ops@raydar.xyz" });
  assert.equal(explicitEditor.capabilities.mailroomWrite, true);

  const serviceNamedAssistant = operatorAccess("helper@personal.example", { POST_CALL_REVIEW_ASSISTANT_EMAILS: "helper@personal.example" });
  assert.equal(serviceNamedAssistant.capabilities.reviewWrite, true);

  const personal = operatorAccess("david@davidphillips.world", {});
  assert.equal(personal.capabilities.reviewWrite, false);
  assert.equal(personal.capabilities.mailroomWrite, false);
});
