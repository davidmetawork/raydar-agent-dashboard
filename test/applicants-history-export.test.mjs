import assert from "node:assert/strict";
import test from "node:test";

import { createSyncHandler } from "../api/applicants/sync.mjs";
import { publishInto } from "./helpers/applicant-generation.mjs";

function response() {
  return {
    statusCode: 200,
    body: null,
    setHeader() {},
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

test("authenticated history export returns complete decisions and acks with a stable digest", async () => {
  const previous = process.env.APPHUB_SYNC_KEY;
  process.env.APPHUB_SYNC_KEY = "fixture-secret";
  const state = {};
  publishInto(state, {
    snapshot: {
      generatedAt: "2026-09-01T22:59:00.000Z",
      source: "applicant-core-production",
      stream: [{ key: "candidate-c:role" }],
    },
    queue: [{ key: "candidate-a:role" }, { key: "candidate-b:role" }],
    counts: { updatedAt: "2026-09-01T22:59:01.000Z", alert: null },
  });
  try {
    const handler = createSyncHandler({
      kvReady: () => true,
      readHash: async (key) => key === "apphub:decisions"
        ? { "candidate-b:role": { action: "pass" }, "candidate-a:role": { action: "interview" } }
        : { "candidate-a:role": { status: "invited" } },
      // The export reads the ACTIVE PUBLICATION, never the legacy split keys:
      // a history digest joined across two generations would describe a page
      // nobody ever saw.
      readJson: async (key) => state[key] || null,
      now: () => "2026-09-01T23:00:00.000Z",
    });
    const req = {
      method: "GET",
      headers: { authorization: "Bearer fixture-secret" },
      query: { history: "1" },
    };
    const first = response();
    await handler(req, first);
    const second = response();
    await handler(req, second);
    assert.equal(first.statusCode, 200);
    assert.deepEqual(first.body.history.counts, { decisions: 2, acks: 1 });
    assert.deepEqual(Object.keys(first.body.history.decisions), ["candidate-a:role", "candidate-b:role"]);
    assert.match(first.body.history.digest, /^[a-f0-9]{64}$/);
    assert.equal(first.body.history.digest, second.body.history.digest);
    assert.deepEqual(first.body.publish.counts, {
      total: 3,
      queue: 2,
      uniqueQueueKeys: 2,
      stream: 1,
      uniqueStreamKeys: 1,
      profilePreparing: 0,
    });
    assert.equal(first.body.publish.source, "applicant-core-production");
    assert.equal(first.body.publish.storedCounts.alert, false);
    assert.match(first.body.publish.digest, /^[a-f0-9]{64}$/);
    assert.equal(first.body.publish.digest, second.body.publish.digest);
  } finally {
    if (previous == null) delete process.env.APPHUB_SYNC_KEY;
    else process.env.APPHUB_SYNC_KEY = previous;
  }
});
