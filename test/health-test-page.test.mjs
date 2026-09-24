// api/health/test-page.mjs: a human-triggered #notify delivery test.
// Runner-key authed exactly like api/paraai/background-pause.mjs, rate-limited
// via KV, and never leaks tokens or the full channel id.
import test from "node:test";
import assert from "node:assert/strict";

import { handleTestPage } from "../api/health/test-page.mjs";

const env = {
  PARAAI_AUTOMATION_RUNNER_KEY: "runner-only-secret",
  CRON_SECRET: "cron-is-not-an-operator",
};

function response() {
  return {
    headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; },
  };
}

function request({ method = "POST", token = "runner-only-secret" } = {}) {
  return {
    method,
    headers: { authorization: `Bearer ${token}` },
  };
}

function grantingRateLimit() {
  const calls = [];
  return { calls, impl: async (...args) => { calls.push(args); return "OK"; } };
}

function blockingRateLimit() {
  const calls = [];
  return { calls, impl: async (...args) => { calls.push(args); return null; } };
}

test("rejects missing, wrong, and cron-secret tokens before any send or rate-limit check", async () => {
  for (const token of ["", "wrong-secret", env.CRON_SECRET]) {
    const rate = grantingRateLimit();
    let sendCalled = false;
    const res = response();
    await handleTestPage(request({ token }), res, {
      env,
      sendSlackImpl: async () => { sendCalled = true; return true; },
      rateLimitImpl: rate.impl,
    });
    assert.equal(res.statusCode, 401);
    assert.deepEqual(res.body, { ok: false, error: "unauthorized" });
    assert.equal(sendCalled, false);
    assert.equal(rate.calls.length, 0);
  }
});

test("GET is rejected: POST only", async () => {
  const rate = grantingRateLimit();
  const res = response();
  await handleTestPage(request({ method: "GET" }), res, {
    env,
    sendSlackImpl: async () => true,
    rateLimitImpl: rate.impl,
  });
  assert.equal(res.statusCode, 405);
  assert.deepEqual(res.body, { ok: false, error: "POST_only" });
  assert.equal(rate.calls.length, 0);
});

test("sends the labelled test message and reports alertsEnabled/channel status without leaking the token or full channel id", async () => {
  const rate = grantingRateLimit();
  let sentText = null;
  const res = response();
  await handleTestPage(request(), res, {
    env: { ...env, HEALTH_ALERTS_ENABLED: "false", SLACK_BOT_TOKEN: "xoxb-test", HEALTH_SLACK_CHANNEL: "C0123456789" },
    sendSlackImpl: async (text) => { sentText = text; return true; },
    rateLimitImpl: rate.impl,
  });
  assert.equal(res.statusCode, 200);
  assert.match(sentText, /^:white_check_mark: #notify test from Raydar System Health/);
  assert.deepEqual(res.body, {
    ok: true,
    alertsEnabled: false,
    channelConfigured: true,
    channelSuffix: "6789",
    delivered: true,
  });
  assert.equal(JSON.stringify(res.body).includes("xoxb-test"), false);
  assert.equal(JSON.stringify(res.body).includes("C0123456789"), false);
});

test("sends regardless of HEALTH_ALERTS_ENABLED but reports the flag honestly", async () => {
  const rate = grantingRateLimit();
  const res = response();
  await handleTestPage(request(), res, {
    env: { ...env, HEALTH_ALERTS_ENABLED: "true" },
    sendSlackImpl: async () => true,
    rateLimitImpl: rate.impl,
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.alertsEnabled, true);
  assert.equal(res.body.delivered, true);
});

test("a second call inside the 10-minute window is rate-limited and never re-sends", async () => {
  const rate = blockingRateLimit();
  let sendCalled = false;
  const res = response();
  await handleTestPage(request(), res, {
    env,
    sendSlackImpl: async () => { sendCalled = true; return true; },
    rateLimitImpl: rate.impl,
  });
  assert.equal(res.statusCode, 429);
  assert.equal(res.body.error, "rate_limited");
  assert.equal(res.body.delivered, false);
  assert.equal(sendCalled, false, "rate-limited calls must not send a duplicate Slack message");
  assert.equal(rate.calls[0][0], "hlth:testpage:lastSent");
  assert.equal(rate.calls[0][2], 600, "must rate-limit to once per 10 minutes (600s)");
});

test("reports delivered:false when sendSlack fails, without treating it as an error status", async () => {
  const rate = grantingRateLimit();
  const res = response();
  await handleTestPage(request(), res, {
    env,
    sendSlackImpl: async () => false,
    rateLimitImpl: rate.impl,
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.delivered, false);
});

test("channelConfigured is false and channelSuffix empty when nothing is configured", async () => {
  const rate = grantingRateLimit();
  const res = response();
  await handleTestPage(request(), res, {
    env,
    sendSlackImpl: async () => false,
    rateLimitImpl: rate.impl,
  });
  assert.equal(res.body.channelConfigured, false);
  assert.equal(res.body.channelSuffix, "");
});

test("a webhook-only configuration counts as configured even with no channel id", async () => {
  const rate = grantingRateLimit();
  const res = response();
  await handleTestPage(request(), res, {
    env: { ...env, SLACK_WEBHOOK_URL: "https://hooks.slack.example/T0/B0/xyz" },
    sendSlackImpl: async () => true,
    rateLimitImpl: rate.impl,
  });
  assert.equal(res.body.channelConfigured, true);
  assert.equal(res.body.channelSuffix, "");
});
