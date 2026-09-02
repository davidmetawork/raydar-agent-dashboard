import test from "node:test";
import assert from "node:assert/strict";
import { runClaimedJob, workerCycle } from "../submissions-v2-worker/runner.mjs";

const job = { id: "job", kind: "prepare_resume", fencing_token: 4, attempt_count: 1, max_attempts: 3, checkpoint: {} };

test("successful worker completion carries the claim fence and control epoch", async () => {
  let complete;
  const result = await runClaimedJob(job, { workerId: "worker", controlEpoch: 7, handlers: { prepare_resume: async () => ({ checkpoint: { stage: "done" } }) }, completeJob: async (value) => { complete = value; }, failJob: async () => assert.fail("unexpected failure"), checkpointJob: async () => {} });
  assert.equal(result.state, "succeeded");
  assert.equal(complete.fencingToken, 4);
  assert.equal(complete.controlEpoch, 7);
});

test("a failed handler is retried with the same fence and safe error only", async () => {
  let failed;
  const result = await runClaimedJob(job, { workerId: "worker", controlEpoch: 7, handlers: { prepare_resume: async () => { throw Object.assign(new Error("provider unavailable"), { code: "provider_unavailable" }); } }, completeJob: async () => assert.fail("unexpected completion"), failJob: async (value) => { failed = value; }, checkpointJob: async () => {} });
  assert.equal(result.state, "retry");
  assert.equal(failed.fencingToken, 4);
  assert.equal(failed.errorCode, "provider_unavailable");
});

test("environment and durable controls jointly limit claimed job kinds", async () => {
  let claim;
  let scheduled = 0;
  const result = await workerCycle({ workerId: "worker", env: { SUBMISSIONS_V2_INGESTION_ENABLED: "true", SUBMISSIONS_V2_GENERATION_ENABLED: "false", SUBMISSIONS_V2_MASTER_INBOX_ENABLED: "true" }, readRuntimeControls: async () => ({ control_epoch: 3, ui_enabled: false, ingestion_enabled: true, generation_enabled: true, master_inbox_enabled: true, curated_enabled: false }), scheduleJobs: async () => { scheduled += 1; }, claimJobs: async (input) => { claim = input; return []; }, handlers: {}, completeJob: async () => {}, failJob: async () => {}, checkpointJob: async () => {} });
  assert.equal(result.control_epoch, 3);
  assert.equal(scheduled, 1);
  assert.ok(claim.kinds.includes("classify_email_reply"));
  assert.ok(!claim.kinds.includes("prepare_resume"));
  assert.ok(claim.kinds.includes("purge"));
});

test("unreadable durable controls fail closed without claiming", async () => {
  await assert.rejects(() => workerCycle({ workerId: "worker", readRuntimeControls: async () => { throw new Error("db down"); }, claimJobs: async () => assert.fail("must not claim"), handlers: {}, completeJob: async () => {}, failJob: async () => {}, checkpointJob: async () => {} }));
});
