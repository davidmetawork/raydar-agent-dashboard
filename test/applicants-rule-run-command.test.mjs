import test from "node:test";
import assert from "node:assert/strict";

import { createSyncHandler } from "../api/applicants/sync.mjs";
import { K } from "../api/applicants/_lib/kv.mjs";

const SECRET = "rule-run-command-test";
const RUN_ID = "11111111-1111-4111-8111-111111111111";

function response() {
  return { statusCode: null, body: null, headers: {}, setHeader(key, value) { this.headers[key] = value; },
    status(code) { this.statusCode = code; return this; }, json(value) { this.body = value; return this; } };
}

function fixture() {
  const command = { runId: RUN_ID, createdAt: "2026-09-07T10:00:00.000Z",
    commandDigest: "a".repeat(64), manifestDigest: "b".repeat(64),
    manifest: { previewDigest: "c".repeat(64) } };
  const state = { [K.ruleRunCommands]: { [RUN_ID]: command }, [K.ruleRunAcks]: {} };
  return { state, command, handler: createSyncHandler({
    kvReady: () => true,
    readHash: async (key) => ({ ...(state[key] || {}) }),
    writeHash: async (key, fields) => { state[key] = { ...(state[key] || {}), ...fields }; },
    now: () => "2026-09-07T10:01:00.000Z",
  }) };
}

const req = (method, extra = {}) => ({ method, query: {}, body: null,
  headers: { authorization: `Bearer ${SECRET}` }, ...extra });

test("Core reads only unacknowledged manual rule commands and acks the exact seal", async () => {
  const previous = process.env.APPHUB_SYNC_KEY;
  process.env.APPHUB_SYNC_KEY = SECRET;
  try {
    const f = fixture();
    const first = response();
    await f.handler(req("GET", { query: { ruleRuns: "1" } }), first);
    assert.deepEqual(first.body.ruleRunCommands, [f.command]);
    const ack = { status: "sealed", runId: RUN_ID, commandDigest: f.command.commandDigest,
      manifestDigest: f.command.manifestDigest, previewDigest: f.command.manifest.previewDigest };
    const saved = response();
    await f.handler(req("POST", { body: { ruleRunAcks: { [RUN_ID]: ack } } }), saved);
    assert.equal(saved.statusCode, 200);
    assert.equal(saved.body.acks[RUN_ID].commandDigest, f.command.commandDigest);
    const second = response();
    await f.handler(req("GET", { query: { ruleRuns: "1" } }), second);
    assert.deepEqual(second.body.ruleRunCommands, []);
  } finally {
    if (previous == null) delete process.env.APPHUB_SYNC_KEY;
    else process.env.APPHUB_SYNC_KEY = previous;
  }
});

test("a Core ack cannot seal a different pending command", async () => {
  const previous = process.env.APPHUB_SYNC_KEY;
  process.env.APPHUB_SYNC_KEY = SECRET;
  try {
    const f = fixture();
    const res = response();
    await f.handler(req("POST", { body: { ruleRunAcks: { [RUN_ID]: { status: "sealed", runId: RUN_ID,
      commandDigest: "d".repeat(64), manifestDigest: f.command.manifestDigest,
      previewDigest: f.command.manifest.previewDigest } } } }), res);
    assert.equal(res.statusCode, 409);
    assert.deepEqual(f.state[K.ruleRunAcks], {});
  } finally {
    if (previous == null) delete process.env.APPHUB_SYNC_KEY;
    else process.env.APPHUB_SYNC_KEY = previous;
  }
});
