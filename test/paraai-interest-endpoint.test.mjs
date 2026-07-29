import test from "node:test";
import assert from "node:assert/strict";

import handler, { humanApproverMatches } from "../api/paraai/interest.mjs";

test("human handoff access fails closed and is pinned to David's exact identity", () => {
  assert.equal(humanApproverMatches("david@raydar.xyz", {}), false);
  const env = {
    PARAAI_INTEREST_HUMAN_APPROVER_EMAIL: "david@raydar.xyz",
  };
  assert.equal(humanApproverMatches("other@raydar.xyz", env), false);
  assert.equal(humanApproverMatches(" DAVID@RAYDAR.XYZ ", env), true);
});

test("an automation bearer cannot read the human handoff feed", async () => {
  const prior = process.env.PARAAI_AUTOMATION_RUNNER_KEY;
  process.env.PARAAI_AUTOMATION_RUNNER_KEY = "runner-test-key";
  const req = {
    method: "GET",
    query: { action: "handoffs" },
    headers: { authorization: "Bearer runner-test-key" },
  };
  const res = {
    statusCode: 200,
    payload: null,
    setHeader() {},
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.payload = payload; return this; },
  };
  try {
    await handler(req, res);
    assert.equal(res.statusCode, 403);
    assert.equal(res.payload.error, "human_auth_required");
  } finally {
    if (prior === undefined) delete process.env.PARAAI_AUTOMATION_RUNNER_KEY;
    else process.env.PARAAI_AUTOMATION_RUNNER_KEY = prior;
  }
});
