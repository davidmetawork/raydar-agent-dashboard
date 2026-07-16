import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  SESSION_COOKIE,
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

test("signed trusted-browser sessions last one year and preserve the Raydar identity", () => {
  const token = createSessionToken({ email: "David@Raydar.xyz", domain: "raydar.xyz" }, { secret: SECRET, nowMs: NOW });
  const session = verifySessionToken(token, { secret: SECRET, nowMs: NOW, allowedDomains: ["raydar.xyz"] });
  assert.equal(session.email, "david@raydar.xyz");
  assert.equal(session.domain, "raydar.xyz");
  assert.equal(session.expiresAt - session.issuedAt, SESSION_TTL_SECONDS);

  const aliasToken = createSessionToken({ email: "david@raydargroup.com", domain: "raydar.xyz" }, { secret: SECRET, nowMs: NOW });
  const aliasSession = verifySessionToken(aliasToken, { secret: SECRET, nowMs: NOW, allowedDomains: ["raydar.xyz", "raydargroup.com"] });
  assert.equal(aliasSession.email, "david@raydargroup.com", "Workspace aliases may differ from Google's hosted-domain claim");
});

test("sessions reject tampering, expiry, wrong secrets, and removed domains", () => {
  const token = createSessionToken({ email: "david@raydar.xyz" }, { secret: SECRET, nowMs: NOW });
  assert.equal(verifySessionToken(token + "x", { secret: SECRET, nowMs: NOW, allowedDomains: ["raydar.xyz"] }), null);
  assert.equal(verifySessionToken(token, { secret: "different-secret", nowMs: NOW, allowedDomains: ["raydar.xyz"] }), null);
  assert.equal(verifySessionToken(token, { secret: SECRET, nowMs: NOW + (SESSION_TTL_SECONDS + 1) * 1000, allowedDomains: ["raydar.xyz"] }), null);
  assert.equal(verifySessionToken(token, { secret: SECRET, nowMs: NOW, allowedDomains: ["example.com"] }), null);
  assert.throws(() => createSessionToken({ email: "david@raydar.xyz" }, { secret: "too-short", nowMs: NOW }), /auth_session_not_configured/);
});

test("session cookies are host-wide, HttpOnly, secure, same-site, and explicitly clearable", () => {
  const issued = issueSession({ email: "david@raydar.xyz", domain: "raydar.xyz" }, { secret: SECRET, nowMs: NOW });
  const cookie = sessionCookie(issued.token, { nowMs: NOW });
  assert.match(cookie, new RegExp(`^${SESSION_COOKIE}=`));
  assert.match(cookie, /Path=\//);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /SameSite=Lax/);
  assert.match(cookie, new RegExp(`Max-Age=${SESSION_TTL_SECONDS}`));
  assert.doesNotMatch(cookie, /Domain=/);
  assert.match(clearSessionCookie(), /Max-Age=0/);
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
  const pages = ["paraai.html", "sequences.html", "enrich.html", "prep.html", "sourcing.html"];
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
