import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const ENV_NAMES = [
  "GOOGLE_CLIENT_ID",
  "AUTH_SESSION_SECRET",
  "ALLOWED_DOMAINS",
  "POST_CALL_BASE",
  "POST_CALL_MONITOR_API_KEY",
  "POST_CALL_REVIEW_FEED_API_KEY",
  "POST_CALL_REVIEW_ACTION_API_KEY",
  "POST_CALL_REVIEW_ASSERTION_SECRET",
];
const SAVED_ENV = Object.fromEntries(ENV_NAMES.map((name) => [name, process.env[name]]));
const SAVED_FETCH = globalThis.fetch;

Object.assign(process.env, {
  GOOGLE_CLIENT_ID: "test-client-id",
  AUTH_SESSION_SECRET: "a".repeat(32),
  ALLOWED_DOMAINS: "raydar.xyz",
  POST_CALL_BASE: "https://raydar-post-call.vercel.app",
  POST_CALL_MONITOR_API_KEY: "legacy-key",
  POST_CALL_REVIEW_FEED_API_KEY: "feed-key",
  POST_CALL_REVIEW_ACTION_API_KEY: "action-key",
  POST_CALL_REVIEW_ASSERTION_SECRET: "shared-secret",
});

const { default: handler } = await import("../api/post-call/calls-summary.mjs");
const { createSessionToken, SESSION_COOKIE } = await import("../api/auth/_lib/session.mjs");

test.after(() => {
  globalThis.fetch = SAVED_FETCH;
  for (const [name, value] of Object.entries(SAVED_ENV)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

function authedRequest({ method = "GET", query = {}, origin } = {}) {
  const token = createSessionToken({ email: "david@raydar.xyz", domain: "raydar.xyz" });
  return {
    method,
    query,
    headers: {
      cookie: `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
      ...(origin ? { origin } : {}),
    },
  };
}

function response() {
  return {
    statusCode: null,
    body: null,
    headers: {},
    setHeader(name, value) { this.headers[String(name).toLowerCase()] = value; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    end() { this.ended = true; },
  };
}

test("calls-summary requires authentication (fails closed, not open)", async () => {
  const req = { method: "GET", query: {}, headers: {} };
  const res = response();
  await handler(req, res);
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.ok, false);
});

test("calls-summary ignores Origin on a GET (same-origin check is write-only, matching review.mjs)", async () => {
  globalThis.fetch = async (url) => new Response(JSON.stringify({ ok: true, calls: [], generatedAt: "2026-09-07T00:00:00.000Z" }), { status: 200 });
  const req = authedRequest({ origin: "https://not-a-real-origin.example" });
  const res = response();
  await handler(req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
});

test("calls-summary rejects a non-GET without a valid same-origin header (fails closed like review.mjs)", async () => {
  const req = authedRequest({ method: "POST" });
  const res = response();
  await handler(req, res);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.error, "same_origin_required");
});

test("calls-summary rejects non-GET even from a trusted origin (this route serves reads only)", async () => {
  const req = authedRequest({ method: "POST", origin: "https://monitor.raydar.xyz" });
  req.headers["x-forwarded-host"] = "monitor.raydar.xyz";
  req.headers["x-forwarded-proto"] = "https";
  const res = response();
  await handler(req, res);
  assert.equal(res.statusCode, 405);
});

test("calls-summary reports unconfigured calmly when the upstream base/key is missing", async () => {
  const previous = process.env.POST_CALL_BASE;
  delete process.env.POST_CALL_BASE;
  try {
    const req = authedRequest();
    const res = response();
    await handler(req, res);
    assert.equal(res.statusCode, 503);
    assert.equal(res.body.configured, false);
  } finally {
    process.env.POST_CALL_BASE = previous;
  }
});

test("calls-summary passes from/to/limit/cursor through to the signed upstream call", async () => {
  let captured;
  globalThis.fetch = async (url, init) => {
    captured = { url, init };
    return new Response(JSON.stringify({ ok: true, calls: [], generatedAt: "2026-09-07T00:00:00.000Z" }), { status: 200 });
  };
  const req = authedRequest({ query: { from: "2026-09-04T00:00:00.000Z", to: "2026-09-07T00:00:00.000Z", limit: "25", cursor: "abc123" } });
  const res = response();
  await handler(req, res);
  assert.equal(res.statusCode, 200);
  assert.match(captured.url, /^https:\/\/raydar-post-call\.vercel\.app\/api\/v1\/monitor-calls\?/);
  const query = new URL(captured.url).searchParams;
  assert.equal(query.get("from"), "2026-09-04T00:00:00.000Z");
  assert.equal(query.get("to"), "2026-09-07T00:00:00.000Z");
  assert.equal(query.get("limit"), "25");
  assert.equal(query.get("cursor"), "abc123");
  // The monitor-scoped upstream route requires POST_CALL_MONITOR_API_KEY
  // specifically (requireMonitorActor does a strict safeEqual, no
  // feed-key fallback) — this must never drift to the review feed key.
  assert.equal(captured.init.headers.authorization, "Bearer legacy-key");
  assert.equal(captured.init.headers["x-raydar-actor-email"], "david@raydar.xyz");
});

test("calls-summary clamps an out-of-range limit instead of forwarding it raw", async () => {
  let captured;
  globalThis.fetch = async (url) => {
    captured = url;
    return new Response(JSON.stringify({ ok: true, calls: [], generatedAt: "2026-09-07T00:00:00.000Z" }), { status: 200 });
  };
  const req = authedRequest({ query: { limit: "999999" } });
  const res = response();
  await handler(req, res);
  assert.equal(new URL(captured).searchParams.get("limit"), "200");
});

test("calls-summary whitelists call fields and drops anything unexpected from the upstream", async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({
    ok: true,
    generatedAt: "2026-09-07T12:00:00.000Z",
    calls: [{
      callId: "call-1",
      obligationId: "obl-1",
      meetingId: "meet-1",
      callMode: "agent",
      callPurpose: "general",
      roleTitle: "Founding Engineer",
      company: "Example Co",
      scheduledStartAt: "2026-09-07T09:55:00.000Z",
      startedAt: "2026-09-07T10:00:00.000Z",
      endedAt: "2026-09-07T10:20:00.000Z",
      normalizedOutcome: "completed",
      candidate: { displayName: "Ada Example", linkedinUrl: "https://linkedin.com/in/ada-example" },
      ranBy: "Raydar agent",
      outcome: { bucket: "sent", label: "Sent", detail: { rolesInEmail: 2, routeKey: "role-route" } },
      reviewId: "review-1",
      paraformCallUrl: "https://www.paraform.com/calls?detail=meet-1",
      resumeUrl: "https://blob.example/secret-resume.pdf",
      rawEvidence: { transcript: "sensitive candidate transcript text" },
      cookie: "should-never-appear",
    }],
  }), { status: 200 });
  const req = authedRequest();
  const res = response();
  await handler(req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.calls.length, 1);
  const call = res.body.calls[0];
  assert.deepEqual(Object.keys(call).sort(), ["assignedRecruiter", "callMode", "callPurpose", "callTimeIso", "candidateName", "id", "meetingId", "result", "reviewId"].sort());
  assert.equal(call.id, "call-1");
  assert.equal(call.candidateName, "Ada Example");
  assert.equal(call.assignedRecruiter, "Raydar agent");
  assert.equal(call.callTimeIso, "2026-09-07T10:20:00.000Z");
  assert.equal(call.resumeUrl, undefined);
  assert.equal(call.rawEvidence, undefined);
  assert.equal(call.cookie, undefined);
  assert.deepEqual(Object.keys(call.result).sort(), ["detail", "label", "tone"]);
  assert.equal(call.result.tone, "good");
  assert.equal(call.result.detail, "2 roles in email");
});

test("calls-summary fails loudly (not an empty success) when every row fails to sanitize", async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({
    ok: true,
    generatedAt: "2026-09-07T12:00:00.000Z",
    calls: [{ id: "legacy-shape-row", candidateName: "Ada Example" }],
  }), { status: 200 });
  const req = authedRequest();
  const res = response();
  await handler(req, res);
  assert.equal(res.statusCode, 502);
  assert.equal(res.body.ok, false);
  assert.equal(res.body.error, "post_call_calls_summary_unrecognized_shape");
});

test("calls-summary treats an unpublished upstream route (404/501) as a calm envelope, not an error", async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({}), { status: 404 });
  const req = authedRequest();
  const res = response();
  await handler(req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, false);
  assert.equal(res.body.reason, "not_published");
  assert.deepEqual(res.body.calls, []);
});

test("calls-summary maps an upstream 401/403 to a generic authorization failure with no upstream detail", async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({ ok: false, error: "invalid_bearer_for_candidate_x@example.com" }), { status: 403 });
  const req = authedRequest();
  const res = response();
  await handler(req, res);
  assert.equal(res.statusCode, 502);
  assert.equal(res.body.error, "post_call_service_authorization_failed");
  assert.doesNotMatch(JSON.stringify(res.body), /candidate_x@example\.com/);
});

test("calls-summary never echoes a raw fetch failure (no PII/URLs in the error body)", async () => {
  globalThis.fetch = async () => { throw new Error("connect ECONNREFUSED to https://raydar-post-call.vercel.app/secret-path?token=abc123&email=leak@example.com"); };
  const req = authedRequest();
  const res = response();
  await handler(req, res);
  assert.equal(res.statusCode, 502);
  const serialized = JSON.stringify(res.body);
  assert.doesNotMatch(serialized, /leak@example\.com/);
  assert.doesNotMatch(serialized, /token=abc123/);
  assert.doesNotMatch(serialized, /ECONNREFUSED/);
  assert.deepEqual(Object.keys(res.body).sort(), ["configured", "error", "ok"]);
});

test("calls-summary surfaces a plain upstream failure without echoing its body", async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({ ok: false, error: "internal_detail_with_row_id_9182" }), { status: 500 });
  const req = authedRequest();
  const res = response();
  await handler(req, res);
  assert.equal(res.statusCode, 500);
  assert.equal(res.body.ok, false);
  assert.doesNotMatch(JSON.stringify(res.body), /row_id_9182/);
});

// ---- Static wiring checks: page, nav, and vercel config ----

const index = await readFile(new URL("../index.html", import.meta.url), "utf8");
const callsToday = await readFile(new URL("../calls-today.html", import.meta.url), "utf8");
const proxySource = await readFile(new URL("../api/post-call/calls-summary.mjs", import.meta.url), "utf8");
const vercel = JSON.parse(await readFile(new URL("../vercel.json", import.meta.url), "utf8"));

test("Calls Today is wired through the dashboard shell", () => {
  const views = JSON.parse(index.match(/const VIEWS=(\[[^\]]+\]);/)[1]);
  assert.ok(views.includes("calls-today"));
  assert.match(index, /id="tab-calls-today"/);
  assert.match(index, /id="view-calls-today" hidden/);
  assert.match(index, /\{name:"calls-today",label:"Calls Today",group:"Live"\}/);
  assert.match(index, /raydar-calls-today-height/);
  assert.ok(vercel.rewrites.some((row) => row.source === "/calls-today" && row.destination === "/calls-today.html"));
  assert.ok(vercel.functions["api/post-call/*.mjs"]);
});

test("Calls Today is Google-gated, same-origin only, and escapes every rendered string", () => {
  assert.match(callsToday, /RaydarAuth\.session\(\)/);
  assert.match(callsToday, /credentials:"same-origin"/);
  assert.match(callsToday, /\/api\/post-call\/calls-summary/);
  assert.doesNotMatch(callsToday, /POST_CALL_BASE|POST_CALL_MONITOR_API_KEY|POST_CALL_REVIEW_ASSERTION_SECRET/);
  assert.doesNotMatch(callsToday, /localStorage|sessionStorage|indexedDB/);
  // Every place a candidate-controlled field is interpolated into markup goes
  // through esc() first — never a raw ${call.xxx} or ${item.xxx} in a template.
  assert.doesNotMatch(callsToday, /\$\{call\.candidateName\}/);
  assert.doesNotMatch(callsToday, /\$\{item\.candidate\}/);
  assert.match(callsToday, /esc\(name\)/);
  assert.match(callsToday, /esc\(call\.assignedRecruiter\)/);
  assert.match(callsToday, /America\/Los_Angeles/);
});

test("Calls Today proxy stays read-only and reuses review.mjs's signed upstream helper", () => {
  assert.match(proxySource, /from "\.\/review\.mjs"/);
  assert.match(proxySource, /requireReviewOperator\(req, res, "reviewRead"\)/);
  assert.match(proxySource, /req\.method !== "GET"/);
  assert.doesNotMatch(proxySource, /ACTIONS\s*=/);
  assert.match(proxySource, /"not_published"/);
});
