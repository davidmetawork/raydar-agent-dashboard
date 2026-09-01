import assert from "node:assert/strict";
import test from "node:test";

import { createSyncHandler } from "../api/applicants/sync.mjs";

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
  try {
    const handler = createSyncHandler({
      kvReady: () => true,
      readHash: async (key) => key === "apphub:decisions"
        ? { "candidate-b:role": { action: "pass" }, "candidate-a:role": { action: "interview" } }
        : { "candidate-a:role": { status: "invited" } },
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
  } finally {
    if (previous == null) delete process.env.APPHUB_SYNC_KEY;
    else process.env.APPHUB_SYNC_KEY = previous;
  }
});
