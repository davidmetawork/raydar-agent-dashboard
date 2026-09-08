import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import productionHandler, { createRetiredSubmissionNotifyHandler } from "../api/paraai/submission-notify.mjs";
import { routeSubmissionsV2 } from "../api/submissions-v2/_lib/router.mjs";
import { notificationText } from "../api/submissions-v2/_lib/notifications.mjs";

function response() {
  return { headers: {}, statusCode: null, body: null,
    setHeader(key, value) { this.headers[key] = value; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

test("production legacy notifier cannot replay or read providers after retirement", async () => {
  const prior = process.env.PARAAI_AUTOMATION_RUNNER_KEY;
  const previousFetch = globalThis.fetch;
  process.env.PARAAI_AUTOMATION_RUNNER_KEY = "test-retired-notifier-key-0000000000";
  globalThis.fetch = async () => { throw new Error("Retired notifier attempted a network call"); };
  try {
    const res = response();
    await productionHandler({ method: "GET", headers: { authorization: `Bearer ${process.env.PARAAI_AUTOMATION_RUNNER_KEY}` }, query: { renotify: "request", since: "2020-01-01" } }, res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, { ok: true, retired: true, reason: "submissions_additions_only", posted: 0, replacement: "submissions_v2.notification_outbox" });
    const config = JSON.parse(await readFile(new URL("../vercel.json", import.meta.url), "utf8"));
    assert.equal(config.crons.some((cron) => cron.path === "/api/paraai/submission-notify"), false);
  } finally {
    globalThis.fetch = previousFetch;
    if (prior === undefined) delete process.env.PARAAI_AUTOMATION_RUNNER_KEY;
    else process.env.PARAAI_AUTOMATION_RUNNER_KEY = prior;
  }
});

test("retired endpoint preserves authentication", async () => {
  const handler = createRetiredSubmissionNotifyHandler({ corsHandler: () => false, cronAuthHandler: () => ({ ok: false }), runnerAuth: () => false, authHandler: async (_req, res) => { res.status(401).json({ ok: false }); return false; } });
  const res = response();
  await handler({}, res);
  assert.equal(res.statusCode, 401);
});

test("notification broker suppresses old workers and operational kinds before Slack", async () => {
  const prior = process.env.SUBMISSIONS_V2_NOTIFICATION_BROKER_KEY;
  const previousFetch = globalThis.fetch;
  process.env.SUBMISSIONS_V2_NOTIFICATION_BROKER_KEY = "test-notification-broker-key-000000000";
  globalThis.fetch = async () => { throw new Error("Suppressed notification reached Slack"); };
  try {
    for (const kind of [undefined, "source_delayed", "source_recovered", "not_interested", "resume_preparation_failed", "daily_digest"]) {
      const res = response();
      await routeSubmissionsV2({ method: "POST", query: { route: "internal/notification" }, headers: { authorization: `Bearer ${process.env.SUBMISSIONS_V2_NOTIFICATION_BROKER_KEY}` }, body: { destination_id: "C0BLZRNFV4N", text: "Old operational alert", kind } }, res);
      assert.equal(res.statusCode, 409);
      assert.equal(res.body.error, "notification_kind_suppressed");
      assert.equal(res.body.receipt, undefined);
    }
  } finally {
    globalThis.fetch = previousFetch;
    if (prior === undefined) delete process.env.SUBMISSIONS_V2_NOTIFICATION_BROKER_KEY;
    else process.env.SUBMISSIONS_V2_NOTIFICATION_BROKER_KEY = prior;
  }
});

test("notification broker preserves ambiguous Slack acceptance for worker reconciliation", async () => {
  const keys = ["SUBMISSIONS_V2_NOTIFICATION_BROKER_KEY", "SUBMISSIONS_V2_SLACK_BOT_TOKEN"];
  const prior = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const previousFetch = globalThis.fetch;
  process.env.SUBMISSIONS_V2_NOTIFICATION_BROKER_KEY = "test-notification-broker-key-000000000";
  process.env.SUBMISSIONS_V2_SLACK_BOT_TOKEN = "test-slack-token";
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ ok: true }) });
  try {
    const res = response();
    await routeSubmissionsV2({ method: "POST", query: { route: "internal/notification" }, headers: { authorization: `Bearer ${process.env.SUBMISSIONS_V2_NOTIFICATION_BROKER_KEY}` }, body: {
      destination_id: "C0BLZRNFV4N", kind: "submission_added",
      text: notificationText("submission_added", { candidate_name: "Example Candidate", company: "Example Company", role_title: "Engineer", signal: "Interested · Curated list", added_at: "2026-09-08T00:00:00Z" }),
    } }, res);
    assert.equal(res.statusCode, 502);
    assert.equal(res.body.error, "slack_receipt_missing");
    assert.equal(res.body.delivery_outcome, "unknown");
  } finally {
    globalThis.fetch = previousFetch;
    for (const key of keys) {
      if (prior[key] === undefined) delete process.env[key];
      else process.env[key] = prior[key];
    }
  }
});
