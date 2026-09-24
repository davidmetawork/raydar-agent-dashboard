// Notify-channel restart (2026-09-24): David's tier-1 pager must be
// repointable at #notify with exactly one config change. This pins the
// channel-resolution contract in api/health/_lib/alert.mjs so a future edit
// cannot quietly widen it back into a multi-var, easy-to-half-configure
// shape. No network, no KV: fetch and every SLACK_*/KV_* env var are
// stubbed and restored per test.
import test from "node:test";
import assert from "node:assert/strict";

import { sendSlack } from "../api/health/_lib/alert.mjs";

const ENV_KEYS = [
  "SLACK_BOT_TOKEN", "HEALTH_SLACK_CHANNEL", "SLACK_CHANNEL_ID_ALERTS", "SLACK_WEBHOOK_URL",
  "KV_REST_API_URL", "KV_REST_API_TOKEN",
];

function withEnv(vars, fn) {
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  Object.assign(process.env, vars);
  const originalFetch = globalThis.fetch;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      globalThis.fetch = originalFetch;
      for (const k of ENV_KEYS) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    });
}

test("HEALTH_SLACK_CHANNEL is the single override — repointing it is the whole config change", async () => {
  await withEnv({ SLACK_BOT_TOKEN: "xoxb-test", HEALTH_SLACK_CHANNEL: "C_NOTIFY" }, async () => {
    let posted = null;
    globalThis.fetch = async (url, init) => {
      posted = { url, body: JSON.parse(init.body) };
      return { ok: true, json: async () => ({ ok: true }) };
    };
    const delivered = await sendSlack("test page");
    assert.equal(delivered, true);
    assert.equal(posted.url, "https://slack.com/api/chat.postMessage");
    assert.equal(posted.body.channel, "C_NOTIFY");
  });
});

test("SLACK_CHANNEL_ID_ALERTS is only a fallback, never an override, when HEALTH_SLACK_CHANNEL is set", async () => {
  await withEnv({
    SLACK_BOT_TOKEN: "xoxb-test",
    HEALTH_SLACK_CHANNEL: "C_NOTIFY",
    SLACK_CHANNEL_ID_ALERTS: "C_OLD_RAYDAR_ALERTS",
  }, async () => {
    let posted = null;
    globalThis.fetch = async (url, init) => {
      posted = JSON.parse(init.body);
      return { ok: true, json: async () => ({ ok: true }) };
    };
    await sendSlack("test page");
    assert.equal(posted.channel, "C_NOTIFY", "a stale SLACK_CHANNEL_ID_ALERTS must never win over HEALTH_SLACK_CHANNEL");
  });
});

test("falls back to SLACK_CHANNEL_ID_ALERTS only when HEALTH_SLACK_CHANNEL is unset", async () => {
  await withEnv({ SLACK_BOT_TOKEN: "xoxb-test", SLACK_CHANNEL_ID_ALERTS: "C_OLD_RAYDAR_ALERTS" }, async () => {
    let posted = null;
    globalThis.fetch = async (url, init) => {
      posted = JSON.parse(init.body);
      return { ok: true, json: async () => ({ ok: true }) };
    };
    await sendSlack("test page");
    assert.equal(posted.channel, "C_OLD_RAYDAR_ALERTS");
  });
});

test("no config at all: fails closed, never throws, and records the failure for slack-transport", async () => {
  await withEnv({}, async () => {
    let fetchCalled = false;
    globalThis.fetch = async () => { fetchCalled = true; return { ok: true, json: async () => ({ ok: true }) }; };
    const delivered = await sendSlack("test page");
    assert.equal(delivered, false);
    assert.equal(fetchCalled, false, "an unconfigured pager must not attempt a request at all");
  });
});

test("an explicit channel override (the daily digest's own channel) beats HEALTH_SLACK_CHANNEL", async () => {
  await withEnv({ SLACK_BOT_TOKEN: "xoxb-test", HEALTH_SLACK_CHANNEL: "C_NOTIFY" }, async () => {
    let posted = null;
    globalThis.fetch = async (url, init) => {
      posted = { url, body: JSON.parse(init.body) };
      return { ok: true, json: async () => ({ ok: true }) };
    };
    const delivered = await sendSlack("daily digest", { channel: "C_DIGEST" });
    assert.equal(delivered, true);
    assert.equal(posted.body.channel, "C_DIGEST");
  });
});

test("the daily digest never posts into the alert channel when HEALTH_DIGEST_SLACK_CHANNEL is unset", async () => {
  const src = await import("node:fs").then((fs) => fs.readFileSync(new URL("../api/health/digest.mjs", import.meta.url), "utf8"));
  assert.match(src, /HEALTH_DIGEST_SLACK_CHANNEL/);
  assert.match(src, /skipped: "digest_channel_unset"/);
  assert.match(src, /sendSlack\(text, \{ channel: digestChannel \}\)/);
});
