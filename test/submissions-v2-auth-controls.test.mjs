import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { effectiveControls, environmentControls } from "../api/submissions-v2/_lib/config.mjs";
import { requireAdmin, requireCron, requireHuman, requireIdempotency, verifyInboxMachine } from "../api/submissions-v2/_lib/http.mjs";

function response() {
  return { statusCode: 200, payload: null, headers: {}, setHeader(name, value) { this.headers[name] = value; }, status(code) { this.statusCode = code; return this; }, json(value) { this.payload = value; return this; } };
}

test("human APIs fail closed when durable auth and API bearer are absent", () => {
  const prior = { ...process.env };
  delete process.env.AUTH_SESSION_SECRET; delete process.env.SUBMISSIONS_V2_HUMAN_API_KEY;
  const res = response();
  assert.equal(requireHuman({ headers: {} }, res), null);
  assert.equal(res.statusCode, 503);
  Object.assign(process.env, prior);
});

test("scoped human bearer works without weakening missing-key behavior", () => {
  process.env.SUBMISSIONS_V2_HUMAN_API_KEY = "human-test-key".repeat(3);
  const res = response();
  const identity = requireHuman({ headers: { authorization: `Bearer ${"human-test-key".repeat(3)}` } }, res, { mutation: true });
  assert.equal(identity.email, "internal-api@raydar.xyz");
  delete process.env.SUBMISSIONS_V2_HUMAN_API_KEY;
});

test("idempotency is mandatory on mutations", () => {
  const res = response();
  assert.equal(requireIdempotency({ headers: {} }, res), null);
  assert.equal(res.statusCode, 400);
});

test("V2 scheduler accepts only its scoped credential", () => {
  process.env.CRON_SECRET = "shared-cron-secret";
  delete process.env.SUBMISSIONS_V2_SCHEDULER_KEY;
  const unavailable = response();
  assert.equal(requireCron({ headers: { authorization: "Bearer shared-cron-secret" } }, unavailable), false);
  assert.equal(unavailable.statusCode, 503);
  process.env.SUBMISSIONS_V2_SCHEDULER_KEY = "v2-scheduler-secret".repeat(2);
  const accepted = response();
  assert.equal(requireCron({ headers: { authorization: `Bearer ${"v2-scheduler-secret".repeat(2)}` } }, accepted), true);
  delete process.env.CRON_SECRET;
  delete process.env.SUBMISSIONS_V2_SCHEDULER_KEY;
});

test("Master Inbox intake rejects bearer auth and accepts a fresh body-bound HMAC", () => {
  process.env.SUBMISSIONS_V2_INGEST_KEY = "inbox-test-key".repeat(3);
  const denied = response();
  assert.equal(verifyInboxMachine({ headers: { authorization: `Bearer ${"inbox-test-key".repeat(3)}` } }, denied, "{}"), null);
  assert.equal(denied.statusCode, 401);
  const timestamp = new Date().toISOString();
  const eventId = "event-1";
  const raw = "{}";
  const signature = createHmac("sha256", "inbox-test-key".repeat(3))
    .update(`submissions.email_reply.v1\n${timestamp}\n${eventId}\n${raw}`)
    .digest("base64url");
  const accepted = response();
  assert.equal(verifyInboxMachine({ headers: {
    "x-raydar-timestamp": timestamp, "x-raydar-event-id": eventId,
    "x-raydar-signature": signature,
  } }, accepted, raw)?.authType, "hmac");
  delete process.env.SUBMISSIONS_V2_INGEST_KEY;
});

test("admin allowlist is explicit", () => {
  process.env.SUBMISSIONS_V2_HUMAN_API_KEY = "human-test-key".repeat(3);
  process.env.SUBMISSIONS_V2_ADMIN_EMAILS = "david@raydar.xyz";
  const res = response();
  assert.equal(requireAdmin({ headers: { authorization: `Bearer ${"human-test-key".repeat(3)}` } }, res), null);
  assert.equal(res.statusCode, 403);
  delete process.env.SUBMISSIONS_V2_HUMAN_API_KEY; delete process.env.SUBMISSIONS_V2_ADMIN_EMAILS;
});

test("effective controls are an environment ceiling AND durable switch", () => {
  const environment = environmentControls({ SUBMISSIONS_V2_UI_ENABLED: "true", SUBMISSIONS_V2_INGESTION_ENABLED: "true", SUBMISSIONS_V2_GENERATION_ENABLED: "false" });
  const effective = effectiveControls(environment, { control_epoch: 7, ui_enabled: true, ingestion_enabled: false, generation_enabled: true, master_inbox_enabled: true, curated_enabled: true });
  assert.equal(effective.ui, true);
  assert.equal(effective.ingestion, false);
  assert.equal(effective.generation, false);
  assert.equal(effective.control_epoch, 7);
  assert.equal(effectiveControls(environment, null).ui, false);
});
