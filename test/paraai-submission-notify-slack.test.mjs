import test from "node:test";
import assert from "node:assert/strict";

import {
  submissionChannelId,
  submissionNotifyConfigured,
  postSubmissionNotification,
} from "../api/paraai/_lib/submission-notify-slack.mjs";

const ENV = { SLACK_BOT_TOKEN: "xoxb-test", PARAFORM_SUBMISSION_SLACK_CHANNEL: "C123" };
const ok = async () => ({ json: async () => ({ ok: true }) });

test("configuration requires both a token and a channel", () => {
  assert.equal(submissionNotifyConfigured(ENV), true);
  assert.equal(submissionNotifyConfigured({ SLACK_BOT_TOKEN: "x" }), false);
  assert.equal(submissionNotifyConfigured({ PARAFORM_SUBMISSION_SLACK_CHANNEL: "C1" }), false);
  assert.equal(submissionNotifyConfigured({}), false);
});

test("the channel is read from its own var, not the shared alerts channel", () => {
  // Guards against this stream ever landing in #alerts.
  assert.equal(submissionChannelId({ PARAFORM_SUBMISSION_SLACK_CHANNEL: "C123" }), "C123");
  assert.equal(submissionChannelId({ SLACK_CHANNEL_ID_ALERTS: "CALERTS" }), "");
});

test("a confirmed post returns true and targets the configured channel", async () => {
  let seen = null;
  const result = await postSubmissionNotification("hello", {
    env: ENV,
    fetchImpl: async (url, init) => { seen = { url, body: JSON.parse(init.body) }; return ok(); },
  });
  assert.equal(result, true);
  assert.match(seen.url, /chat\.postMessage$/);
  assert.equal(seen.body.channel, "C123");
  assert.equal(seen.body.text, "hello");
});

test("link unfurling is disabled so candidate previews are not pasted into the channel", async () => {
  let body = null;
  await postSubmissionNotification("hi", {
    env: ENV,
    fetchImpl: async (_u, init) => { body = JSON.parse(init.body); return ok(); },
  });
  assert.equal(body.unfurl_links, false);
  assert.equal(body.unfurl_media, false);
});

test("missing configuration fails closed without throwing or calling Slack", async () => {
  let called = false;
  const fetchImpl = async () => { called = true; return ok(); };
  assert.equal(await postSubmissionNotification("hi", { env: {}, fetchImpl }), false);
  assert.equal(await postSubmissionNotification("hi", { env: { SLACK_BOT_TOKEN: "x" }, fetchImpl }), false);
  assert.equal(called, false, "no channel means no call at all");
});

test("empty text is never posted", async () => {
  let called = false;
  const result = await postSubmissionNotification("   ", {
    env: ENV, fetchImpl: async () => { called = true; return ok(); },
  });
  assert.equal(result, false);
  assert.equal(called, false);
});

test("a Slack-level failure returns false so the event stays unmarked", async () => {
  const result = await postSubmissionNotification("hi", {
    env: ENV,
    fetchImpl: async () => ({ json: async () => ({ ok: false, error: "channel_not_found" }) }),
  });
  assert.equal(result, false);
});

test("a transport failure returns false rather than throwing", async () => {
  const result = await postSubmissionNotification("hi", {
    env: ENV, fetchImpl: async () => { throw new Error("network down"); },
  });
  assert.equal(result, false);
});

test("an unparseable Slack response is treated as a failure, not a success", async () => {
  const result = await postSubmissionNotification("hi", {
    env: ENV, fetchImpl: async () => ({ json: async () => { throw new Error("bad json"); } }),
  });
  assert.equal(result, false);
});
