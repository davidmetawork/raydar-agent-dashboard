import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  createSessionToken,
  sessionConfig,
  verifySessionToken,
} from "../api/auth/_lib/session.mjs";

const SECRET = "test-secret-that-is-long-and-random-enough-for-hmac";
const NOW = Date.UTC(2026, 8, 24, 12, 0, 0);

test("session.mjs default allowed domains include meta.work alongside the existing three", () => {
  const previous = process.env.ALLOWED_DOMAINS;
  delete process.env.ALLOWED_DOMAINS;
  try {
    const config = sessionConfig();
    assert.deepEqual(config.allowedDomains, [
      "raydar.xyz",
      "raydargroup.com",
      "davidphillips.world",
      "meta.work",
    ]);

    const token = createSessionToken({ email: "person@meta.work" }, { secret: SECRET, nowMs: NOW });
    const session = verifySessionToken(token, { secret: SECRET, nowMs: NOW });
    assert.equal(session.email, "person@meta.work");
    assert.equal(session.domain, "meta.work");

    // The three original domains keep working, unchanged.
    for (const domain of ["raydar.xyz", "raydargroup.com", "davidphillips.world"]) {
      const t = createSessionToken({ email: `person@${domain}` }, { secret: SECRET, nowMs: NOW });
      const s = verifySessionToken(t, { secret: SECRET, nowMs: NOW });
      assert.equal(s.domain, domain);
    }
  } finally {
    if (previous === undefined) delete process.env.ALLOWED_DOMAINS;
    else process.env.ALLOWED_DOMAINS = previous;
  }
});

test("an explicit ALLOWED_DOMAINS env value still overrides the code default (unchanged behavior)", () => {
  const previous = process.env.ALLOWED_DOMAINS;
  process.env.ALLOWED_DOMAINS = "raydar.xyz";
  try {
    const config = sessionConfig();
    assert.deepEqual(config.allowedDomains, ["raydar.xyz"]);

    const token = createSessionToken({ email: "person@meta.work" }, { secret: SECRET, nowMs: NOW });
    const session = verifySessionToken(token, { secret: SECRET, nowMs: NOW });
    assert.equal(session, null, "meta.work must stay refused when the env var does not list it");
  } finally {
    if (previous === undefined) delete process.env.ALLOWED_DOMAINS;
    else process.env.ALLOWED_DOMAINS = previous;
  }
});

test("middleware.ts's own default domain list matches session.mjs's (both gates move together)", async () => {
  const source = await readFile(new URL("../middleware.ts", import.meta.url), "utf8");
  assert.match(
    source,
    /process\.env\.ALLOWED_DOMAINS \|\| 'raydar\.xyz,raydargroup\.com,davidphillips\.world,meta\.work'/,
    "middleware.ts must default to the same four domains as api/auth/_lib/session.mjs",
  );
});

test("login.html names meta.work in both the allowed-domains hint and the error message", async () => {
  const html = await readFile(new URL("../login.html", import.meta.url), "utf8");
  assert.match(html, /Allowed: @raydar\.xyz · @raydargroup\.com · @davidphillips\.world · @meta\.work/);
  assert.match(
    html,
    /Use a @raydar\.xyz, @raydargroup\.com, @davidphillips\.world, or @meta\.work Google account\./,
  );
});

test(".env.submissions-v2.example documents the four-domain default", async () => {
  const env = await readFile(new URL("../.env.submissions-v2.example", import.meta.url), "utf8");
  assert.match(env, /^ALLOWED_DOMAINS=raydar\.xyz,raydargroup\.com,davidphillips\.world,meta\.work$/m);
});
