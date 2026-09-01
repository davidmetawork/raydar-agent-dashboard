import assert from "node:assert/strict";
import test from "node:test";

import handler from "../api/paraai/outreach.mjs";

function responseRecorder() {
  return {
    statusCode: null,
    body: null,
    setHeader() {},
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
    end() { return this; },
  };
}

test("Mailroom relief send requires the request-scoped confirmation phrase", async () => {
  const previous = process.env.PARAAI_AUTOMATION_RUNNER_KEY;
  process.env.PARAAI_AUTOMATION_RUNNER_KEY = "test-runner-key";
  try {
    const req = {
      method: "POST",
      headers: { authorization: "Bearer test-runner-key" },
      body: {
        action: "send-request-via-mailroom",
        requestId: "req-guarded",
        recipientEmail: "candidate@example.com",
        // The pre-override phrase is deliberately insufficient: the operator
        // must confirm both the request and the exact recipient.
        confirmation: "SEND VIA MAILROOM req-guarded",
      },
    };
    const res = responseRecorder();
    await handler(req, res);
    assert.equal(res.statusCode, 400);
    assert.deepEqual(res.body, { ok: false, error: "confirmation_required" });
  } finally {
    if (previous === undefined) delete process.env.PARAAI_AUTOMATION_RUNNER_KEY;
    else process.env.PARAAI_AUTOMATION_RUNNER_KEY = previous;
  }
});

test("Mailroom bundle send requires both request IDs and the exact recipient", async () => {
  const previous = process.env.PARAAI_AUTOMATION_RUNNER_KEY;
  process.env.PARAAI_AUTOMATION_RUNNER_KEY = "test-runner-key";
  try {
    const req = {
      method: "POST",
      headers: { authorization: "Bearer test-runner-key" },
      body: {
        action: "send-request-bundle-via-mailroom",
        requestIds: ["req-2", "req-1"],
        recipientEmail: "candidate@example.com",
        confirmation: "SEND BUNDLE VIA MAILROOM req-1,req-2 TO someone-else@example.com",
      },
    };
    const res = responseRecorder();
    await handler(req, res);
    assert.equal(res.statusCode, 400);
    assert.deepEqual(res.body, { ok: false, error: "confirmation_required" });
  } finally {
    if (previous === undefined) delete process.env.PARAAI_AUTOMATION_RUNNER_KEY;
    else process.env.PARAAI_AUTOMATION_RUNNER_KEY = previous;
  }
});

test("the temporary recovery key is bundle-only and still needs exact confirmation", async () => {
  const previousRunner = process.env.PARAAI_AUTOMATION_RUNNER_KEY;
  const previousRecovery = process.env.PARAAI_OUTREACH_BUNDLE_RECOVERY_KEY;
  const previousGoogleClient = process.env.GOOGLE_CLIENT_ID;
  delete process.env.PARAAI_AUTOMATION_RUNNER_KEY;
  process.env.PARAAI_OUTREACH_BUNDLE_RECOVERY_KEY = "bundle-recovery-key-for-test-only-123456";
  process.env.GOOGLE_CLIENT_ID = "test-google-client";
  try {
    const res = responseRecorder();
    await handler({
      method: "POST",
      headers: {
        "x-paraai-bundle-recovery-key": "bundle-recovery-key-for-test-only-123456",
      },
      body: {
        action: "send-request-bundle-via-mailroom",
        requestIds: ["req-1", "req-2"],
        recipientEmail: "candidate@example.com",
        confirmation: "not-the-exact-confirmation",
      },
    }, res);
    assert.equal(res.statusCode, 400);
    assert.deepEqual(res.body, { ok: false, error: "confirmation_required" });

    const nonBundle = responseRecorder();
    await handler({
      method: "POST",
      headers: {
        "x-paraai-bundle-recovery-key": "bundle-recovery-key-for-test-only-123456",
      },
      body: { action: "inspect-pending" },
    }, nonBundle);
    assert.equal(nonBundle.statusCode, 401);
    assert.deepEqual(nonBundle.body, { ok: false, error: "auth_required" });
  } finally {
    if (previousRunner === undefined) delete process.env.PARAAI_AUTOMATION_RUNNER_KEY;
    else process.env.PARAAI_AUTOMATION_RUNNER_KEY = previousRunner;
    if (previousRecovery === undefined) {
      delete process.env.PARAAI_OUTREACH_BUNDLE_RECOVERY_KEY;
    } else {
      process.env.PARAAI_OUTREACH_BUNDLE_RECOVERY_KEY = previousRecovery;
    }
    if (previousGoogleClient === undefined) delete process.env.GOOGLE_CLIENT_ID;
    else process.env.GOOGLE_CLIENT_ID = previousGoogleClient;
  }
});
