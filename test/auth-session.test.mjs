import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  SESSION_COOKIE,
  SESSION_COOKIE_DOMAIN,
  SESSION_TTL_SECONDS,
  clearSessionCookie,
  createSessionToken,
  issueSession,
  sessionCookie,
  sessionFromRequest,
  verifySessionToken,
} from "../api/auth/_lib/session.mjs";
import { requireAuth } from "../api/seq/_lib/core.mjs";
import googleHandler from "../api/auth/google.mjs";
import sessionHandler from "../api/auth/session.mjs";
import logoutHandler from "../api/auth/logout.mjs";
import {
  checkLoginRateLimit,
  LOGIN_RATE_LIMIT,
  LOGIN_RATE_WINDOW_SECONDS,
  loginRateLimitInternals,
} from "../api/auth/_lib/login-rate-limit.mjs";

const SECRET = "test-secret-that-is-long-and-random-enough-for-hmac";
const NOW = Date.UTC(2026, 6, 16, 21, 0, 0);

function responseRecorder() {
  return {
    headers: {},
    statusCode: 0,
    body: null,
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

test("signed trusted-browser sessions last one year and preserve approved Raydar identities", () => {
  const token = createSessionToken({ email: "David@Raydar.xyz", domain: "raydar.xyz" }, { secret: SECRET, nowMs: NOW });
  const session = verifySessionToken(token, { secret: SECRET, nowMs: NOW, allowedDomains: ["raydar.xyz"] });
  assert.equal(session.email, "david@raydar.xyz");
  assert.equal(session.domain, "raydar.xyz");
  assert.equal(session.expiresAt - session.issuedAt, SESSION_TTL_SECONDS);

  const aliasToken = createSessionToken({ email: "david@raydargroup.com", domain: "raydar.xyz" }, { secret: SECRET, nowMs: NOW });
  const aliasSession = verifySessionToken(aliasToken, { secret: SECRET, nowMs: NOW, allowedDomains: ["raydar.xyz", "raydargroup.com"] });
  assert.equal(aliasSession.email, "david@raydargroup.com", "Workspace aliases may differ from Google's hosted-domain claim");

  const personalToken = createSessionToken({ email: "david@davidphillips.world" }, { secret: SECRET, nowMs: NOW });
  assert.equal(verifySessionToken(personalToken, {
    secret: SECRET,
    nowMs: NOW,
    allowedDomains: ["raydar.xyz", "raydargroup.com", "davidphillips.world"],
  }).domain, "davidphillips.world");
});

test("sessions reject tampering, expiry, wrong secrets, and removed domains", () => {
  const token = createSessionToken({ email: "david@raydar.xyz" }, { secret: SECRET, nowMs: NOW });
  assert.equal(verifySessionToken(token + "x", { secret: SECRET, nowMs: NOW, allowedDomains: ["raydar.xyz"] }), null);
  assert.equal(verifySessionToken(token, { secret: "different-secret", nowMs: NOW, allowedDomains: ["raydar.xyz"] }), null);
  assert.equal(verifySessionToken(token, { secret: SECRET, nowMs: NOW + (SESSION_TTL_SECONDS + 1) * 1000, allowedDomains: ["raydar.xyz"] }), null);
  assert.equal(verifySessionToken(token, { secret: SECRET, nowMs: NOW, allowedDomains: ["example.com"] }), null);
  assert.throws(() => createSessionToken({ email: "david@raydar.xyz" }, { secret: "too-short", nowMs: NOW }), /auth_session_not_configured/);
});

test("session cookies are Raydar-wide, HttpOnly, secure, same-site, and explicitly clearable", () => {
  const issued = issueSession({ email: "david@raydar.xyz", domain: "raydar.xyz" }, { secret: SECRET, nowMs: NOW });
  const cookie = sessionCookie(issued.token, { nowMs: NOW });
  assert.match(cookie, new RegExp(`^${SESSION_COOKIE}=`));
  assert.match(cookie, /Path=\//);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /SameSite=Lax/);
  assert.match(cookie, new RegExp(`Max-Age=${SESSION_TTL_SECONDS}`));
  assert.match(cookie, new RegExp(`Domain=${SESSION_COOKIE_DOMAIN}`));
  assert.match(clearSessionCookie(), /Max-Age=0/);
  assert.match(clearSessionCookie(), new RegExp(`Domain=${SESSION_COOKIE_DOMAIN}`));
});

test("protected APIs accept the shared session without another Google lookup", async () => {
  const old = {
    clientId: process.env.GOOGLE_CLIENT_ID,
    secret: process.env.AUTH_SESSION_SECRET,
    domains: process.env.ALLOWED_DOMAINS,
  };
  process.env.GOOGLE_CLIENT_ID = "google-client-id";
  process.env.AUTH_SESSION_SECRET = SECRET;
  process.env.ALLOWED_DOMAINS = "raydar.xyz";
  try {
    const token = createSessionToken({ email: "david@raydar.xyz", domain: "raydar.xyz" });
    const req = { headers: { cookie: `other=1; ${SESSION_COOKIE}=${encodeURIComponent(token)}` } };
    const res = { status() { throw new Error("valid session should not write an error response"); } };
    assert.equal(sessionFromRequest(req).email, "david@raydar.xyz");
    assert.equal(await requireAuth(req, res), true);
    assert.equal(req.authedEmail, "david@raydar.xyz");
  } finally {
    for (const [key, value] of Object.entries(old)) {
      const env = key === "clientId" ? "GOOGLE_CLIENT_ID" : key === "secret" ? "AUTH_SESSION_SECRET" : "ALLOWED_DOMAINS";
      if (value === undefined) delete process.env[env];
      else process.env[env] = value;
    }
  }
});

test("protected APIs fail closed without Google auth and preserve verified bearer fallback without durable sessions", async () => {
  const old = {
    clientId: process.env.GOOGLE_CLIENT_ID,
    secret: process.env.AUTH_SESSION_SECRET,
  };
  const oldFetch = globalThis.fetch;
  try {
    process.env.GOOGLE_CLIENT_ID = "";
    process.env.AUTH_SESSION_SECRET = SECRET;
    const missingGoogle = responseRecorder();
    assert.equal(await requireAuth({ headers: {} }, missingGoogle), false);
    assert.equal(missingGoogle.statusCode, 503);
    assert.equal(missingGoogle.body.error, "auth_not_configured");

    process.env.GOOGLE_CLIENT_ID = "google-client-id";
    process.env.AUTH_SESSION_SECRET = "";
    globalThis.fetch = async () => new Response(JSON.stringify({
      aud: "google-client-id",
      email: "david@raydargroup.com",
      email_verified: "true",
      exp: String(Math.floor(Date.now() / 1000) + 3_600),
    }), { status: 200, headers: { "content-type": "application/json" } });
    const bearer = responseRecorder();
    const request = { headers: { authorization: "Bearer verified-google-token" } };
    assert.equal(await requireAuth(request, bearer), true);
    assert.equal(request.authedEmail, "david@raydargroup.com");
  } finally {
    globalThis.fetch = oldFetch;
    if (old.clientId === undefined) delete process.env.GOOGLE_CLIENT_ID;
    else process.env.GOOGLE_CLIENT_ID = old.clientId;
    if (old.secret === undefined) delete process.env.AUTH_SESSION_SECRET;
    else process.env.AUTH_SESSION_SECRET = old.secret;
  }
});

test("Google login rate limiting uses the platform client address and a bounded fallback", async () => {
  loginRateLimitInternals.resetMemory();
  const env = { AUTH_SESSION_SECRET: SECRET, VERCEL: "1" };
  const req = {
    headers: {
      "x-vercel-forwarded-for": "2001:db8::1",
      "x-forwarded-for": "198.51.100.10",
    },
  };
  for (let attempt = 1; attempt <= LOGIN_RATE_LIMIT; attempt += 1) {
    const result = await checkLoginRateLimit(req, { env, nowMs: NOW });
    assert.equal(result.allowed, true);
    assert.equal(result.count, attempt);
  }
  const blocked = await checkLoginRateLimit(req, { env, nowMs: NOW });
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.retryAfterSeconds, 300);
  assert.equal(loginRateLimitInternals.trustedClientAddress(req, env), "2001:db8::1");
  assert.equal(loginRateLimitInternals.memorySize(), 1);
});

test("Google login rate limiting uses the shared store when available and ignores spoofable forwarding headers", async () => {
  loginRateLimitInternals.resetMemory();
  let command;
  const result = await checkLoginRateLimit({
    headers: { "x-forwarded-for": "198.51.100.10" },
    socket: { remoteAddress: "192.0.2.20" },
  }, {
    env: {
      AUTH_SESSION_SECRET: SECRET,
      KV_REST_API_URL: "https://kv.invalid",
      KV_REST_API_TOKEN: "test-token",
    },
    fetchImpl: async (_url, init) => {
      command = JSON.parse(init.body);
      return new Response(JSON.stringify({ result: [LOGIN_RATE_LIMIT + 1, 123] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  assert.equal(result.allowed, false);
  assert.equal(result.distributed, true);
  assert.equal(result.retryAfterSeconds, 123);
  assert.equal(command[0], "EVAL");
  assert.match(command[1], /if ttl == -1 then[\s\S]*EXPIRE[\s\S]*TTL/u);
  assert.equal(loginRateLimitInternals.trustedClientAddress({
    headers: { "x-forwarded-for": "198.51.100.10" },
    socket: { remoteAddress: "192.0.2.20" },
  }, {}), "192.0.2.20");

  assert.equal(loginRateLimitInternals.trustedClientAddress({
    headers: { "x-vercel-forwarded-for": "2001:db8::1" },
    socket: { remoteAddress: "192.0.2.20" },
  }, {}), "192.0.2.20");

  for (let index = 0; index < 2_100; index += 1) {
    loginRateLimitInternals.memoryLimit(`key-${index}`, NOW);
  }
  assert.equal(loginRateLimitInternals.memorySize(), 2_048);
});

test("Google login limiter accepts zero TTL and falls back on missing, malformed, or negative TTL", async () => {
  const req = { headers: {}, socket: { remoteAddress: "192.0.2.30" } };
  const env = {
    AUTH_SESSION_SECRET: SECRET,
    KV_REST_API_URL: "https://kv.invalid",
    KV_REST_API_TOKEN: "test-token",
  };
  const run = async (result) => {
    loginRateLimitInternals.resetMemory();
    return checkLoginRateLimit(req, {
      env,
      nowMs: NOW,
      fetchImpl: async () => new Response(JSON.stringify({ result }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    });
  };

  const zero = await run([1, 0]);
  assert.equal(zero.distributed, true);
  assert.equal(zero.retryAfterSeconds, 1);
  assert.equal(loginRateLimitInternals.memorySize(), 0);

  for (const result of [[1], [1, "0"], [1, -1], [1, null]]) {
    const fallback = await run(result);
    assert.equal(fallback.distributed, false, JSON.stringify(result));
    assert.equal(fallback.count, 1);
    assert.equal(loginRateLimitInternals.memorySize(), 1);
  }
});

test("Google login limiter resumes the shared budget after an outage without merging fallback attempts", async () => {
  loginRateLimitInternals.resetMemory();
  const req = { headers: {}, socket: { remoteAddress: "192.0.2.40" } };
  const env = {
    AUTH_SESSION_SECRET: SECRET,
    KV_REST_API_URL: "https://kv.invalid",
    KV_REST_API_TOKEN: "test-token",
  };
  let recovered = false;
  const fetchImpl = async () => {
    if (!recovered) throw new Error("store unavailable");
    return new Response(JSON.stringify({ result: [1, LOGIN_RATE_WINDOW_SECONDS] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  let fallback;
  for (let attempt = 1; attempt <= LOGIN_RATE_LIMIT + 1; attempt += 1) {
    fallback = await checkLoginRateLimit(req, { env, nowMs: NOW, fetchImpl });
  }
  assert.equal(fallback.allowed, false);
  assert.equal(fallback.distributed, false);
  assert.equal(fallback.count, LOGIN_RATE_LIMIT + 1);

  recovered = true;
  const shared = await checkLoginRateLimit(req, { env, nowMs: NOW, fetchImpl });
  assert.equal(shared.allowed, true);
  assert.equal(shared.distributed, true);
  assert.equal(shared.count, 1, "fallback attempts are deliberately not claimed as one distributed budget");
});

test("Google login rejects malformed or oversized request envelopes before token verification", async () => {
  const keys = [
    "GOOGLE_CLIENT_ID",
    "AUTH_SESSION_SECRET",
    "ALLOWED_DOMAINS",
    "KV_REST_API_URL",
    "KV_REST_API_TOKEN",
  ];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const previousFetch = globalThis.fetch;
  let tokeninfoCalls = 0;
  try {
    process.env.GOOGLE_CLIENT_ID = "google-client-id";
    process.env.AUTH_SESSION_SECRET = SECRET;
    process.env.ALLOWED_DOMAINS = "raydar.xyz";
    delete process.env.KV_REST_API_URL;
    delete process.env.KV_REST_API_TOKEN;
    loginRateLimitInternals.resetMemory();
    globalThis.fetch = async () => {
      tokeninfoCalls += 1;
      return new Response(JSON.stringify({
        aud: "google-client-id",
        email: "david@raydar.xyz",
        email_verified: "true",
        hd: "raydar.xyz",
        exp: String(Math.floor(Date.now() / 1000) + 3_600),
      }), { status: 200, headers: { "content-type": "application/json" } });
    };

    for (const body of [null, "null", [], "[]", "{", { credential: "x".repeat(8_193) }]) {
      const res = responseRecorder();
      await googleHandler({ method: "POST", body }, res);
      assert.equal(res.statusCode, 400, JSON.stringify(body)?.slice(0, 80));
      assert.deepEqual(res.body, { ok: false, error: "invalid_request" });
    }

    for (const body of [
      { credential: "token", extra: "x".repeat(17_000) },
      JSON.stringify({ credential: "token", extra: "x".repeat(17_000) }),
    ]) {
      const res = responseRecorder();
      await googleHandler({ method: "POST", body }, res);
      assert.equal(res.statusCode, 413);
      assert.deepEqual(res.body, { ok: false, error: "request_too_large" });
    }
    assert.equal(tokeninfoCalls, 0);

    const valid = responseRecorder();
    await googleHandler({ method: "POST", body: { credential: "google-id-token", extra: "allowed" } }, valid);
    assert.equal(valid.statusCode, 200);
    assert.equal(tokeninfoCalls, 1);
  } finally {
    globalThis.fetch = previousFetch;
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
});

test("Google exchange, restore, rolling renewal, and logout form one complete cookie flow", async () => {
  const old = {
    clientId: process.env.GOOGLE_CLIENT_ID,
    secret: process.env.AUTH_SESSION_SECRET,
    domains: process.env.ALLOWED_DOMAINS,
    fetch: globalThis.fetch,
  };
  process.env.GOOGLE_CLIENT_ID = "google-client-id";
  process.env.AUTH_SESSION_SECRET = SECRET;
  process.env.ALLOWED_DOMAINS = "raydar.xyz";
  loginRateLimitInternals.resetMemory();
  globalThis.fetch = async () => new Response(JSON.stringify({
    aud: "google-client-id",
    email: "david@raydargroup.com",
    email_verified: "true",
    hd: "raydar.xyz",
    exp: String(Math.floor(Date.now() / 1000) + 3600),
  }), { status: 200, headers: { "content-type": "application/json" } });
  try {
    const exchange = responseRecorder();
    await googleHandler({ method: "POST", body: { credential: "google-id-token" } }, exchange);
    assert.equal(exchange.statusCode, 200);
    assert.equal(exchange.body.email, "david@raydargroup.com");
    assert.equal("token" in exchange.body, false, "the signed session token must remain HttpOnly");
    assert.match(exchange.headers["set-cookie"], new RegExp(`^${SESSION_COOKIE}=`));

    const cookie = exchange.headers["set-cookie"].split(";", 1)[0];
    const restored = responseRecorder();
    sessionHandler({ method: "GET", headers: { cookie } }, restored);
    assert.equal(restored.statusCode, 200);
    assert.equal(restored.body.authenticated, true);
    assert.match(restored.headers["set-cookie"], new RegExp(`Max-Age=${SESSION_TTL_SECONDS}`));

    const logout = responseRecorder();
    logoutHandler({ method: "POST", headers: { cookie } }, logout);
    assert.equal(logout.statusCode, 200);
    assert.match(logout.headers["set-cookie"], /Max-Age=0/);
  } finally {
    globalThis.fetch = old.fetch;
    if (old.clientId === undefined) delete process.env.GOOGLE_CLIENT_ID;
    else process.env.GOOGLE_CLIENT_ID = old.clientId;
    if (old.secret === undefined) delete process.env.AUTH_SESSION_SECRET;
    else process.env.AUTH_SESSION_SECRET = old.secret;
    if (old.domains === undefined) delete process.env.ALLOWED_DOMAINS;
    else process.env.ALLOWED_DOMAINS = old.domains;
  }
});

test("every Google-gated dashboard page restores and exchanges the shared session", async () => {
  const pages = ["paraai.html", "sequences.html", "inbox.html", "enrich.html", "prep.html", "sourcing.html"];
  for (const page of pages) {
    const html = await readFile(new URL(`../${page}`, import.meta.url), "utf8");
    const source = page === "sourcing.html"
      ? html + await readFile(new URL("../sourcing-app.mjs", import.meta.url), "utf8")
      : html;
    assert.match(html, /<script src="\/auth-session\.js"><\/script>/, `${page} should load the shared auth client`);
    assert.match(source, /RaydarAuth\.session\(\)/, `${page} should restore an existing trusted-browser session`);
    assert.match(source, /RaydarAuth\.signIn\(/, `${page} should exchange Google sign-in for a durable session`);
  }
  const client = await readFile(new URL("../auth-session.js", import.meta.url), "utf8");
  assert.doesNotMatch(client, /localStorage|sessionStorage/);
  assert.match(client, /credentials: "same-origin"/);
  assert.match(client, /BroadcastChannel\("raydar-auth"\)/, "sign-in should wake already-loaded sibling tabs and iframes");
});

test("global middleware protects monitor pages but leaves login, APIs, and call links public", async () => {
  const middleware = await readFile(new URL("../middleware.ts", import.meta.url), "utf8");
  const config = await readFile(new URL("../vercel.json", import.meta.url), "utf8");
  const login = await readFile(new URL("../login.html", import.meta.url), "utf8");
  assert.match(middleware, /__Secure-raydar_session/);
  assert.match(middleware, /davidphillips\.world/);
  assert.match(middleware, /c\(\?:\/\|\$\)/, "the public /c/* capability links must bypass auth");
  assert.match(middleware, /api\(\?:\/\|\$\)/, "machine and application APIs keep their own auth contracts");
  assert.match(config, /"source": "\/login"/);
  assert.match(login, /@davidphillips\.world/);
  assert.match(login, /safeReturnTo/);
});
