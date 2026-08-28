import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { operatorAccess, requireSameOrigin } from "../api/_lib/operator-access.mjs";
import { safeUpstreamBase } from "../api/_lib/safe-upstream.mjs";
import { createSessionToken, SESSION_COOKIE } from "../api/auth/_lib/session.mjs";
import mailroomHandler from "../api/mailroom/console.mjs";
import reviewHandler from "../api/post-call/review.mjs";

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
  assert.match(review, /changes\.candidateUserId=selected\.dataset\.profile/);
  assert.doesNotMatch(review, /changes\.candidateProfileId/);
  assert.match(review, /workplaces:\["REMOTE","HYBRID","ON_SITE"\]/);
  assert.match(review, /fundingRounds:/);
  assert.match(review, /SERIES_D_PLUS/);
  assert.match(review, /NEEDS_NEW_VISA_AUTHORIZATION/);
  assert.match(review, /25 MB maximum/);
  assert.match(review, /credentials:"omit"/);
});

test("Review proxy owns auth attribution and optimistic concurrency", () => {
  assert.match(reviewProxy, /POST_CALL_BASE/);
  assert.match(reviewProxy, /POST_CALL_MONITOR_API_KEY/);
  assert.match(reviewProxy, /"x-raydar-actor-email": access\.email/);
  assert.match(reviewProxy, /"if-match": `"\$\{version\}"`/);
  assert.match(reviewProxy, /\/api\/v1\/review-files/);
  assert.match(reviewProxy, /\/api\/v1\/review-actions/);
  assert.match(reviewProxy, /candidate_user_id_required/);
  assert.match(reviewProxy, /requireSameOrigin/);
  assert.doesNotMatch(reviewProxy, /payload\.actor/);
});

test("Mailroom supports versioned copy, lane controls, evidence and conflicts", () => {
  for (const action of ["save", "preview", "publish", "revert"]) assert.match(mailroom, new RegExp(`"${action}"`));
  for (const surface of ["Senders & transports", "Outbox", "Delivery", "Review", "Immutable change history"]) assert.ok(mailroom.includes(surface));
  assert.match(mailroom, /error\.status===409/);
  assert.match(mailroomProxy, /expectedRevision/);
  assert.doesNotMatch(mailroomProxy, /body\.expectedLaneRevision/);
  assert.match(mailroomProxy, /schemaVersion: 2/);
  assert.match(mailroomProxy, /actor = access\.email/);
  assert.match(mailroomProxy, /action !== "preview"/);
  assert.doesNotMatch(mailroomProxy, /payload\.actor/);
  assert.match(mailroom, /not copied into Gmail Sent/);
  assert.match(mailroom, /replies still return to Gmail through Reply-To/);
  assert.match(mailroom, /SendGrid delivery is recorded in Mailroom's provider and outbox evidence only/);
  assert.match(mailroom, /postCallLane&&sender\.transport!=="sendgrid"\?"disabled"/);
  assert.match(mailroom, /SendGrid required/);
  assert.match(mailroom, /result\.preview\|\|result/);
  assert.match(mailroom, /routeKind==="role_specific"\?"reply":"new"/);
  assert.match(mailroom, /Signature assets/);
  assert.match(mailroomProxy, /\/api\/signatures/);
  assert.match(mailroomProxy, /\/api\/signature/);
  assert.match(mailroomProxy, /\/api\/post-call-preview/);
  assert.match(mailroomProxy, /set-sender-status/);
  assert.doesNotMatch(mailroomProxy, /gmail.*journal/i);
});

test("RBAC is exact-email allowlisted and Mailroom editing remains narrower", () => {
  const env = {
    POST_CALL_REVIEW_ADMIN_EMAILS: "david@raydar.xyz",
    POST_CALL_REVIEW_ASSISTANT_EMAILS: "assistant@raydargroup.com",
    MAILROOM_EDITOR_EMAILS: "ops@raydar.xyz",
    MAILROOM_VIEWER_EMAILS: "observer@raydar.xyz",
  };
  const david = operatorAccess("david@raydar.xyz", env);
  assert.equal(david.role, "admin");
  assert.equal(david.capabilities.reviewWrite, true);
  assert.equal(david.capabilities.mailroomWrite, true);

  const assistant = operatorAccess("assistant@raydargroup.com", env);
  assert.equal(assistant.role, "reviewer");
  assert.equal(assistant.capabilities.reviewWrite, true);
  assert.equal(assistant.capabilities.mailroomWrite, false);

  const explicitEditor = operatorAccess("ops@raydar.xyz", env);
  assert.equal(explicitEditor.capabilities.mailroomWrite, true);
  assert.equal(explicitEditor.capabilities.reviewRead, false);

  const observer = operatorAccess("observer@raydar.xyz", env);
  assert.equal(observer.capabilities.mailroomRead, true);
  assert.equal(observer.capabilities.mailroomWrite, false);

  const unlistedTeamMember = operatorAccess("someone@raydar.xyz", env);
  assert.equal(unlistedTeamMember.capabilities.reviewRead, false);
  assert.equal(unlistedTeamMember.capabilities.reviewWrite, false);
  assert.equal(unlistedTeamMember.capabilities.mailroomRead, false);
});

test("state-changing proxy requests require the exact dashboard origin", () => {
  const response = () => ({ statusCode: 0, body: null, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } });
  const good = response();
  assert.equal(requireSameOrigin({ method: "POST", headers: { origin: "https://monitor.raydar.xyz", host: "monitor.raydar.xyz" } }, good), true);
  const bad = response();
  assert.equal(requireSameOrigin({ method: "POST", headers: { origin: "https://evil.example", host: "monitor.raydar.xyz" } }, bad), false);
  assert.equal(bad.statusCode, 403);
  assert.equal(bad.body.error, "same_origin_required");
  const spoofedHost = response();
  assert.equal(requireSameOrigin({ method: "POST", headers: { origin: "https://evil.example", host: "evil.example" } }, spoofedHost), false);
});

test("upstream service bases cannot target local networks or smuggle URL components", () => {
  assert.equal(safeUpstreamBase("https://post-call.raydar.xyz", { service: "post_call" }), "https://post-call.raydar.xyz");
  assert.throws(() => safeUpstreamBase("http://127.0.0.1:3000", { service: "post_call" }), /unsafe/);
  assert.throws(() => safeUpstreamBase("https://[::ffff:127.0.0.1]", { service: "post_call" }), /unsafe/);
  assert.throws(() => safeUpstreamBase("https://user:pass@example.com", { service: "post_call" }), /unsafe/);
  assert.throws(() => safeUpstreamBase("https://example.com/internal", { service: "post_call" }), /must_be_origin/);
  assert.throws(() => safeUpstreamBase("https://wrong.example", { service: "post_call", allowedOrigins: "https://right.example" }), /not_allowed/);
});

function proxyResponse() {
  return {
    headers: {},
    statusCode: 200,
    body: null,
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    end() { return this; },
  };
}

function authenticatedHeaders(email) {
  const token = createSessionToken({ email, domain: email.split("@")[1] });
  return {
    origin: "https://monitor.raydar.xyz",
    host: "monitor.raydar.xyz",
    cookie: `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    "content-type": "application/json",
  };
}

test("Review proxy sends the owning service's exact action contract", async () => {
  const priorFetch = globalThis.fetch;
  const prior = { ...process.env };
  process.env.AUTH_SESSION_SECRET = "review-proxy-test-secret-that-is-at-least-32-bytes";
  process.env.GOOGLE_CLIENT_ID = "review-proxy-test-client";
  process.env.ALLOWED_DOMAINS = "raydar.xyz";
  process.env.POST_CALL_REVIEW_ASSISTANT_EMAILS = "assistant@raydar.xyz";
  process.env.POST_CALL_BASE = "https://post-call.raydar.xyz";
  process.env.POST_CALL_ALLOWED_ORIGINS = "https://post-call.raydar.xyz";
  process.env.POST_CALL_MONITOR_API_KEY = "monitor-key";
  let captured;
  globalThis.fetch = async (url, init) => {
    captured = { url: String(url), init, body: JSON.parse(init.body) };
    return new Response(JSON.stringify({ ok: true, version: 8 }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const res = proxyResponse();
    await reviewHandler({ method: "POST", headers: authenticatedHeaders("assistant@raydar.xyz"), body: {
      action: "select_profile", reviewId: "review-1", version: 7,
      changes: { candidateUserId: "candidate-1" }, reason: "Verified exact LinkedIn profile.",
    } }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(captured.url, "https://post-call.raydar.xyz/api/v1/review-actions");
    assert.equal(captured.init.headers["if-match"], '"7"');
    assert.deepEqual(captured.body.changes, { candidateUserId: "candidate-1" });
    assert.equal(captured.body.schemaVersion, 1);
    assert.equal(captured.init.headers["x-raydar-actor-email"], "assistant@raydar.xyz");

    captured = null;
    const invalid = proxyResponse();
    await reviewHandler({ method: "POST", headers: authenticatedHeaders("assistant@raydar.xyz"), body: {
      action: "set_field", reviewId: "review-1", version: 7,
      changes: { fundingRounds: ["SERIES_C_PLUS"] }, reason: "Correct company stage.",
    } }, invalid);
    assert.equal(invalid.statusCode, 400);
    assert.equal(invalid.body.error, "review_value_invalid");
    assert.equal(captured, null);

    const atLimit = proxyResponse();
    await reviewHandler({ method: "POST", headers: authenticatedHeaders("assistant@raydar.xyz"), body: {
      action: "prepare_resume", reviewId: "review-1", version: 7,
      fileName: "resume.pdf", mimeType: "application/pdf", sizeBytes: 25 * 1024 * 1024,
      sha256: "a".repeat(64),
    } }, atLimit);
    assert.equal(atLimit.statusCode, 200);
    assert.equal(captured.body.sizeBytes, 25 * 1024 * 1024);

    captured = null;
    const overLimit = proxyResponse();
    await reviewHandler({ method: "POST", headers: authenticatedHeaders("assistant@raydar.xyz"), body: {
      action: "prepare_resume", reviewId: "review-1", version: 7,
      fileName: "resume.pdf", mimeType: "application/pdf", sizeBytes: 25 * 1024 * 1024 + 1,
      sha256: "a".repeat(64),
    } }, overLimit);
    assert.equal(overLimit.statusCode, 400);
    assert.equal(overLimit.body.error, "resume_metadata_invalid");
    assert.equal(captured, null);
  } finally {
    globalThis.fetch = priorFetch;
    for (const key of Object.keys(process.env)) if (!(key in prior)) delete process.env[key];
    Object.assign(process.env, prior);
  }
});

test("Mailroom proxy translates dashboard revisions and preserves signature bindings", async () => {
  const priorFetch = globalThis.fetch;
  const prior = { ...process.env };
  process.env.AUTH_SESSION_SECRET = "mailroom-proxy-test-secret-that-is-at-least-32-bytes";
  process.env.GOOGLE_CLIENT_ID = "mailroom-proxy-test-client";
  process.env.ALLOWED_DOMAINS = "raydar.xyz";
  process.env.POST_CALL_REVIEW_ADMIN_EMAILS = "david@raydar.xyz";
  process.env.MAILROOM_BASE = "https://raydar-mailroom.vercel.app";
  process.env.MAILROOM_ALLOWED_ORIGINS = "https://raydar-mailroom.vercel.app";
  process.env.MAILROOM_API_KEY = "mailroom-key";
  let captured;
  globalThis.fetch = async (url, init) => {
    captured = { url: String(url), init, body: JSON.parse(init.body) };
    return new Response(JSON.stringify({ ok: true, saved: true, version: 3, revision: 12 }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const res = proxyResponse();
    await mailroomHandler({ method: "POST", headers: authenticatedHeaders("david@raydar.xyz"), body: {
      action: "save", lane: "postcall-general-none", expectedRevision: 11,
      subject: "Raydar - Screening Call", bodyText: "Hey {{firstName}}", note: "Copy audit",
      signatureAssetId: "david-full", signatureAssetVersion: 2,
    } }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(captured.url, "https://raydar-mailroom.vercel.app/api/template");
    assert.equal(captured.body.expectedRevision, 11);
    assert.equal("expectedLaneRevision" in captured.body, false);
    assert.equal(captured.body.signatureAssetId, "david-full");
    assert.equal(captured.body.signatureAssetVersion, 2);
    assert.equal(captured.body.actor, "david@raydar.xyz");
  } finally {
    globalThis.fetch = priorFetch;
    for (const key of Object.keys(process.env)) if (!(key in prior)) delete process.env[key];
    Object.assign(process.env, prior);
  }
});

test("Mailroom active preview is read-only and sender controls use the v2 contract", async () => {
  const priorFetch = globalThis.fetch;
  const prior = { ...process.env };
  process.env.AUTH_SESSION_SECRET = "mailroom-controls-test-secret-that-is-at-least-32-bytes";
  process.env.GOOGLE_CLIENT_ID = "mailroom-controls-test-client";
  process.env.ALLOWED_DOMAINS = "raydar.xyz";
  process.env.POST_CALL_REVIEW_ADMIN_EMAILS = "david@raydar.xyz";
  process.env.MAILROOM_VIEWER_EMAILS = "observer@raydar.xyz";
  process.env.MAILROOM_BASE = "https://raydar-mailroom.vercel.app";
  process.env.MAILROOM_ALLOWED_ORIGINS = "https://raydar-mailroom.vercel.app";
  process.env.MAILROOM_API_KEY = "mailroom-key";
  const captured = [];
  globalThis.fetch = async (url, init) => {
    captured.push({ url: String(url), body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ ok: true, rendered: { subject: "Preview", text: "Hello" } }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const previewRes = proxyResponse();
    await mailroomHandler({ method: "POST", headers: authenticatedHeaders("observer@raydar.xyz"), body: {
      action: "preview_active", lane: "postcall-role-good-none", threadMode: "reply",
      callMode: "human", vars: { firstName: "Sample", threadSubject: "Role" },
    } }, previewRes);
    assert.equal(previewRes.statusCode, 200);
    assert.equal(captured[0].url, "https://raydar-mailroom.vercel.app/api/post-call-preview");
    assert.equal(captured[0].body.templateVariables.callMode, "human");
    assert.equal("actor" in captured[0].body, false);

    const senderRes = proxyResponse();
    await mailroomHandler({ method: "POST", headers: authenticatedHeaders("david@raydar.xyz"), body: {
      action: "set-sender-status", sender: "david-sendgrid", status: "active", expectedRevision: 4,
    } }, senderRes);
    assert.equal(senderRes.statusCode, 200);
    assert.equal(captured[1].url, "https://raydar-mailroom.vercel.app/api/control");
    assert.deepEqual(captured[1].body, {
      schemaVersion: 2, action: "set-sender-status", actor: "david@raydar.xyz",
      sender: "david-sendgrid", status: "active", expectedRevision: 4,
    });
  } finally {
    globalThis.fetch = priorFetch;
    for (const key of Object.keys(process.env)) if (!(key in prior)) delete process.env[key];
    Object.assign(process.env, prior);
  }
});
