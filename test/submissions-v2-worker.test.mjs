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

test("workerCycle reserves one resume build per cycle when the general claim picked a source job", async () => {
  const claims = [];
  const env = { SUBMISSIONS_V2_INGESTION_ENABLED: "true", SUBMISSIONS_V2_GENERATION_ENABLED: "true", SUBMISSIONS_V2_MASTER_INBOX_ENABLED: "true" };
  const controls = { control_epoch: 1, ui_enabled: true, ingestion_enabled: true, generation_enabled: true, master_inbox_enabled: true, curated_enabled: false };
  const handlers = { source_health: async () => ({ ok: true }), prepare_resume: async () => ({ ok: true }) };
  const base = { workerId: "worker", env, readRuntimeControls: async () => controls, handlers, completeJob: async () => {}, failJob: async () => {}, checkpointJob: async () => {}, limit: 1 };
  const result = await workerCycle({ ...base, claimJobs: async (input) => { claims.push(input.kinds); return claims.length === 1
    ? [{ id: "j1", kind: "source_health", subject_type: "source", subject_id: "all", attempt_count: 0, max_attempts: 3, checkpoint: {}, control_epoch: 1 }]
    : [{ id: "j2", kind: "prepare_resume", subject_type: "pair", subject_id: "p1", attempt_count: 0, max_attempts: 3, checkpoint: {}, control_epoch: 1 }]; } });
  assert.equal(claims.length, 2);
  assert.deepEqual(claims[1], ["prepare_resume"]);
  assert.equal(result.jobs.length, 2, "both the source job and the reserved build ran this cycle");

  claims.length = 0;
  await workerCycle({ ...base, claimJobs: async (input) => { claims.push(input.kinds); return [{ id: "j3", kind: "prepare_resume", subject_type: "pair", subject_id: "p2", attempt_count: 0, max_attempts: 3, checkpoint: {}, control_epoch: 1 }]; } });
  assert.equal(claims.length, 1, "a build already claimed needs no reserved slot");

  claims.length = 0;
  await workerCycle({ ...base, env: { ...env, SUBMISSIONS_V2_GENERATION_ENABLED: "false" }, claimJobs: async (input) => { claims.push(input.kinds); return []; } });
  assert.equal(claims.length, 1, "generation off means no reserved build claim");
  assert.ok(!claims[0].includes("prepare_resume"));
});
