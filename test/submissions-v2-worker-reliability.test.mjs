import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";

import {
  checkpointJob,
  claimJobs,
  completeJob,
  createDatabase,
  failJob,
  heartbeatJob,
  readRuntimeControls,
} from "../api/submissions-v2/_lib/db.mjs";
import { runMigrations } from "../scripts/migrate-submissions-v2.mjs";
import {
  runWorkerCycleWithProgress,
  workerCycle,
} from "../submissions-v2-worker/runner.mjs";
import {
  createWorkerHandlers,
  SOURCE_PAGE_LIMITS,
} from "../submissions-v2-worker/worker-handlers.mjs";
import {
  createWorkerProgressStore,
  livenessSnapshot,
} from "../submissions-v2-worker/worker-progress.mjs";

const databaseUrl = String(process.env.SUBMISSIONS_V2_WORKER_TEST_DATABASE_URL || process.env.SUBMISSIONS_V2_TEST_DATABASE_URL || "").trim();
let sql;

function fakeSql(onQuery = async () => []) {
  const tagged = async (strings, ...values) => onQuery(strings.join("?"), values);
  tagged.json = (value) => value;
  tagged.array = (value) => value;
  tagged.begin = async (callback) => callback(tagged);
  return tagged;
}

function enabledEnv() {
  return {
    SUBMISSIONS_V2_UI_ENABLED: "true",
    SUBMISSIONS_V2_INGESTION_ENABLED: "true",
    SUBMISSIONS_V2_GENERATION_ENABLED: "true",
    SUBMISSIONS_V2_MASTER_INBOX_ENABLED: "true",
    SUBMISSIONS_V2_CURATED_ENABLED: "true",
  };
}

before(async () => {
  if (!databaseUrl) return;
  await runMigrations({ databaseUrl, logger: { info() {} } });
  sql = createDatabase({ databaseUrl, max: 5 });
});

after(async () => {
  await sql?.end({ timeout: 5 });
});

test("a control failure before handler dispatch is durably observed without a provider effect", async () => {
  const calls = [];
  let providerEffects = 0;
  const progress = {
    async beginCycle({ attemptedAt }) {
      calls.push(["begin", attemptedAt]);
      return { cycleToken: "cycle-token" };
    },
    async finishCycle(result) {
      calls.push(["finish", result]);
    },
  };
  const failure = Object.assign(new Error("private database detail"), { code: "controls_read_failed" });
  await assert.rejects(
    runWorkerCycleWithProgress({
      workerId: "worker-test",
      readRuntimeControls: async () => {
        calls.push(["controls"]);
        throw failure;
      },
      claimJobs: async () => assert.fail("claim must not run"),
      handlers: {
        reconcile_master_inbox: async () => { providerEffects += 1; },
      },
      completeJob: async () => {},
      failJob: async () => {},
      checkpointJob: async () => {},
    }, {
      progress,
      now: () => new Date("2026-09-05T12:00:00.000Z"),
    }),
    failure,
  );
  assert.deepEqual(calls.map(([name]) => name), ["begin", "controls", "finish"]);
  assert.equal(calls[2][1].ok, false);
  assert.equal(calls[2][1].errorClass, "controls_read_failed");
  assert.equal(providerEffects, 0);
});

test("liveness is process-only and does not imply readiness", () => {
  const live = livenessSnapshot({
    workerId: "worker-test",
    processStartedAt: "2026-09-05T11:59:00.000Z",
    cycleRunning: true,
    now: new Date("2026-09-05T12:00:00.000Z"),
  });
  assert.equal(live.ok, true);
  assert.equal(live.status, "live");
  assert.equal(live.process_age_seconds, 60);
  assert.equal("ready" in live, false);
});

test("a crash after a bounded candidate page is applied replays the same page instead of skipping it", async () => {
  const providerCursors = [];
  const appliedCycles = [];
  const committedCheckpoints = [];
  let commitAttempt = 0;
  let releases = 0;
  const db = fakeSql(async (query) => query.includes("runtime_controls")
    ? [{ control_epoch: 7 }]
    : []);
  const repository = {
    async upsertCandidateIndex(rows, { cycleId }) {
      assert.equal(rows.length, 1);
      appliedCycles.push(cycleId);
      return { changed_count: 1 };
    },
    async recordSourceHealth() {},
  };
  const sourceLease = {
    async claimSourceCursor() {
      return {
        checkpoint: { cursor: 0, cycle_id: "durable-cycle" },
        fencing_token: 4,
      };
    },
    async commitSourceCursor(input) {
      commitAttempt += 1;
      if (commitAttempt === 1) {
        throw Object.assign(new Error("simulated crash before cursor commit"), { code: "simulated_page_commit_crash" });
      }
      committedCheckpoints.push(input.checkpoint);
      return { checkpoint: input.checkpoint };
    },
    async releaseSourceCursor() { releases += 1; },
  };
  const handlers = createWorkerHandlers({
    sql: db,
    repository,
    service: {},
    resumeStore: {},
    sourceLease,
    candidatePage: async (cursor, limit) => {
      providerCursors.push(cursor);
      assert.equal(limit, SOURCE_PAGE_LIMITS.candidate_index);
      return { rows: [{ candidate_user_id: "synthetic-candidate" }], next_cursor: 100 };
    },
  });
  const context = {
    job: { id: randomUUID(), checkpoint: {}, attempt_count: 1, max_attempts: 3 },
    workerId: "worker-page-test",
    fencingToken: 9,
    controlEpoch: 7,
    signal: new AbortController().signal,
    checkpoint: async (value) => value,
  };

  await assert.rejects(
    handlers.index_candidates(context),
    (error) => error.code === "simulated_page_commit_crash",
  );
  assert.equal(releases, 1);
  assert.deepEqual(committedCheckpoints, []);

  const resumed = await handlers.index_candidates(context);
  assert.equal(resumed.checkpoint.complete, false);
  assert.equal(resumed.checkpoint.pages, 1);
  assert.deepEqual(providerCursors, [0, 0]);
  assert.deepEqual(appliedCycles, ["durable-cycle", "durable-cycle"]);
  assert.deepEqual(committedCheckpoints, [{ cursor: 100, cycle_id: "durable-cycle" }]);
});

test("paused idle progress remains ready and exposes zero runnable work", {
  skip: !databaseUrl && "SUBMISSIONS_V2_TEST_DATABASE_URL is required",
}, async () => {
  const rollback = new Error("rollback paused worker fixture");
  await assert.rejects(sql.begin(async (tx) => {
    const workerId = `paused-worker-${randomUUID()}`;
    const workerKey = `paused-${randomUUID()}`;
    const progress = createWorkerProgressStore({ sql: tx, workerId, workerKey });
    const cycle = await progress.beginCycle();
    await progress.finishCycle({
      ...cycle,
      ok: true,
      jobCount: 0,
      controlEpoch: 0,
    });
    const readiness = await progress.readReadiness({ enabledKinds: ["purge"] });
    assert.equal(readiness.ready, true);
    assert.equal(readiness.reason, "ready");
    assert.equal(readiness.last_cycle_job_count, 0);
    assert.equal(readiness.queue.reduce((total, row) => total + row.runnable_count, 0), 0);
    throw rollback;
  }), rollback);
});

test("a pre-handler control failure is retained in the real worker progress row", {
  skip: !databaseUrl && "SUBMISSIONS_V2_TEST_DATABASE_URL is required",
}, async () => {
  const rollback = new Error("rollback failed worker fixture");
  await assert.rejects(sql.begin(async (tx) => {
    const workerId = `failed-worker-${randomUUID()}`;
    const workerKey = `failed-${randomUUID()}`;
    const progress = createWorkerProgressStore({ sql: tx, workerId, workerKey });
    await assert.rejects(
      runWorkerCycleWithProgress({
        workerId,
        readRuntimeControls: async () => {
          throw Object.assign(new Error("private control read detail"), { code: "fixture_control_read_failed" });
        },
        claimJobs: async () => assert.fail("claim must not run"),
        handlers: {},
        completeJob: async () => {},
        failJob: async () => {},
        checkpointJob: async () => {},
      }, { progress }),
      (error) => error.code === "fixture_control_read_failed",
    );
    const readiness = await progress.readReadiness({ enabledKinds: ["purge"] });
    assert.equal(readiness.ready, false);
    assert.equal(readiness.reason, "fixture_control_read_failed");
    assert.equal(readiness.last_cycle_error_class, "fixture_control_read_failed");
    assert.equal(readiness.last_cycle_job_count, 0);
    assert.ok(readiness.last_attempted_cycle_at);
    assert.equal(readiness.last_successful_cycle_at, null);
    throw rollback;
  }), rollback);
});

test("aged proof, outbox, and index classes progress ahead of repeated fresh intake", {
  skip: !databaseUrl && "SUBMISSIONS_V2_TEST_DATABASE_URL is required",
}, async () => {
  const rollback = new Error("rollback worker fairness fixture");
  await assert.rejects(sql.begin(async (tx) => {
    const controls = (await tx`
      update submissions_v2.runtime_controls
         set control_epoch=control_epoch+1,
             ui_enabled=true,
             ingestion_enabled=true,
             generation_enabled=true,
             master_inbox_enabled=true,
             curated_enabled=true,
             actor_email='worker-test@raydar.xyz',
             reason='Isolated worker fairness test',
             changed_at=clock_timestamp()
       where singleton=true
      returning *
    `)[0];
    await tx`
      update submissions_v2.worker_service_fairness
         set current_weight_score=0, last_claimed_at=null, claim_count=0
    `;

    const insertJob = async (kind, priority, ageMinutes) => {
      const id = randomUUID();
      await tx`
        insert into submissions_v2.jobs(
          id, kind, subject_type, subject_id, idempotency_key,
          required_control, priority, control_epoch, scheduled_at
        ) values (
          ${id}, ${kind}, 'fixture', ${id}, ${`fairness:${id}`},
          ${kind === "prepare_resume" ? "generation" : kind.startsWith("reconcile_") ? "master_inbox" : "ingestion"},
          ${priority}, ${controls.control_epoch},
          clock_timestamp() - make_interval(mins => ${ageMinutes})
        )
      `;
      return id;
    };

    for (let index = 0; index < 12; index += 1) {
      await insertJob("reconcile_master_inbox", 10, 0);
    }
    await insertJob("proof_reconcile", 15, 6);
    await insertJob("deliver_notification", 20, 6);
    await insertJob("index_candidates", 40, 16);

    const queueProgress = createWorkerProgressStore({
      sql: tx,
      workerId: "fairness-worker",
      workerKey: `fairness-${randomUUID()}`,
    });
    const queueCycle = await queueProgress.beginCycle();
    await queueProgress.finishCycle({ ...queueCycle, ok: true, jobCount: 0, controlEpoch: controls.control_epoch });
    const queueSnapshot = await queueProgress.readReadiness({
      enabledKinds: [
        "reconcile_master_inbox", "proof_reconcile", "deliver_notification",
        "index_candidates", "purge",
      ],
    });
    const byClass = new Map(queueSnapshot.queue.map((row) => [row.service_class, row]));
    assert.equal(byClass.get("live_intake").runnable_count, 12);
    assert.equal(byClass.get("proof").runnable_count, 1);
    assert.equal(byClass.get("outbox").runnable_count, 1);
    assert.equal(byClass.get("maintenance").runnable_count, 1);
    assert.ok(byClass.get("proof").oldest_runnable_age_seconds >= 6 * 60);
    assert.ok(byClass.get("maintenance").oldest_runnable_age_seconds >= 16 * 60);

    const invoked = [];
    let providerEffects = 0;
    const handlers = {
      proof_reconcile: async () => { invoked.push("proof_reconcile"); return { checkpoint: { stage: "proof-test" } }; },
      deliver_notification: async () => { invoked.push("deliver_notification"); return { checkpoint: { stage: "outbox-test" } }; },
      index_candidates: async () => { invoked.push("index_candidates"); return { checkpoint: { stage: "index-test" } }; },
      reconcile_master_inbox: async () => { providerEffects += 1; return { checkpoint: {} }; },
      purge: async () => ({ checkpoint: {} }),
    };
    const cycleOptions = {
      workerId: "fairness-worker",
      env: enabledEnv(),
      readRuntimeControls: () => readRuntimeControls(tx),
      claimJobs: (input) => claimJobs(input, tx),
      handlers,
      completeJob: (input) => completeJob(input, tx),
      failJob: (input) => failJob(input, tx),
      checkpointJob: (input) => checkpointJob(input, tx),
      heartbeatJob: (input) => heartbeatJob(input, tx),
      limit: 1,
    };

    for (let turn = 0; turn < 3; turn += 1) {
      const result = await workerCycle(cycleOptions);
      assert.equal(result.ok, true);
      assert.equal(result.jobs.length, 1);
    }
    assert.deepEqual(invoked, ["proof_reconcile", "deliver_notification", "index_candidates"]);
    assert.equal(providerEffects, 0);

    await tx`
      update submissions_v2.worker_service_fairness
         set current_weight_score=0, last_claimed_at=null
    `;
    const live = await workerCycle(cycleOptions);
    assert.equal(live.jobs.length, 1);
    assert.equal(providerEffects, 1);
    throw rollback;
  }), rollback);
});
