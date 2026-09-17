import test from "node:test";
import assert from "node:assert/strict";

import {
  SUBMISSIONS_V2_BACKGROUND_PAUSE_SCOPE,
  createSubmissionsV2BackgroundPauseControl,
  handleSubmissionsV2BackgroundPause,
} from "../api/submissions-v2/_lib/background-pause.mjs";

function response() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    setHeader(name, value) { this.headers[String(name).toLowerCase()] = value; },
    status(value) { this.statusCode = value; return this; },
    json(value) { this.body = value; return this; },
  };
}

function fakeDatabase(initial = {}) {
  const state = {
    controls: {
      singleton: true,
      control_epoch: 7,
      ui_enabled: true,
      ingestion_enabled: true,
      generation_enabled: true,
      master_inbox_enabled: true,
      curated_enabled: false,
      actor_email: "david@raydar.xyz",
      reason: "normal operation",
      ...initial,
    },
    commands: new Map(),
    writes: [],
  };
  let nextCommand = 1;

  const tx = async (strings, ...values) => {
    const query = strings.join("?").replace(/\s+/gu, " ").trim();
    if (query.includes("select * from submissions_v2.lock_runtime_controls()")) {
      return [{ ...state.controls }];
    }
    if (query.includes("insert into submissions_v2.api_commands")) {
      const [actor_email, action, idempotency_key, request_digest, expected_version, pair_id] = values;
      const key = `${actor_email}\0${idempotency_key}`;
      if (state.commands.has(key)) return [];
      const row = {
        id: `command-${nextCommand++}`,
        actor_email, action, idempotency_key, request_digest, expected_version, pair_id,
        status: "started", result: null,
      };
      state.commands.set(key, row);
      return [{ ...row }];
    }
    if (query.includes("select * from submissions_v2.api_commands") && query.includes("idempotency_key=")) {
      const [actor, idempotencyKey] = values;
      const row = state.commands.get(`${actor}\0${idempotencyKey}`);
      return row ? [{ ...row }] : [];
    }
    if (query.includes("update submissions_v2.api_commands") && query.includes("status='succeeded'")) {
      const [result, , commandId] = values;
      const row = [...state.commands.values()].find((candidate) => candidate.id === commandId && candidate.status === "started");
      if (!row) return [];
      row.status = "succeeded";
      row.result = result;
      return [{ ...row }];
    }
    if (query.includes("select result") && query.includes("paused_control_epoch")) {
      const [actor, action, scope, epoch, reason] = values;
      const matches = [...state.commands.values()].filter((row) => row.actor_email === actor
        && row.action === action && row.status === "succeeded" && row.result?.scope === scope
        && String(row.result?.paused_control_epoch) === epoch && row.result?.paused_reason === reason);
      return matches.length ? [{ result: matches.at(-1).result }] : [];
    }
    if (query.includes("select result") && query.includes("idempotency_key=") && query.includes("status='succeeded'")) {
      const [actor, action, idempotencyKey] = values;
      const row = state.commands.get(`${actor}\0${idempotencyKey}`);
      return row?.action === action && row.status === "succeeded" ? [{ result: row.result }] : [];
    }
    if (query.includes("select * from submissions_v2.set_runtime_controls(")) {
      const [actor, reason, ui, ingestion, generation, masterInbox, curated] = values;
      state.controls = {
        ...state.controls,
        control_epoch: Number(state.controls.control_epoch) + 1,
        ui_enabled: ui,
        ingestion_enabled: ingestion,
        generation_enabled: generation,
        master_inbox_enabled: masterInbox,
        curated_enabled: curated,
        actor_email: actor,
        reason,
      };
      state.writes.push({ ...state.controls });
      return [{ ...state.controls }];
    }
    throw new Error(`Unexpected query: ${query}`);
  };
  tx.json = (value) => value;
  const sql = Object.assign(tx, { begin: async (callback) => callback(tx) });
  return { sql, state };
}

const runnerEnv = { PARAAI_AUTOMATION_RUNNER_KEY: "runner-key-that-is-long-and-dedicated" };

test("V2 background pause authenticates and validates scope before any control I/O", async () => {
  let calls = 0;
  const control = {
    status: async () => { calls += 1; return {}; },
    apply: async () => { calls += 1; return {}; },
  };

  const unauthorized = response();
  await handleSubmissionsV2BackgroundPause({ method: "GET", headers: {}, query: {} }, unauthorized, { env: runnerEnv, control });
  assert.equal(unauthorized.statusCode, 401);
  assert.equal(calls, 0);

  const cronOnly = response();
  await handleSubmissionsV2BackgroundPause({
    method: "POST",
    headers: { authorization: "Bearer cron-secret" },
    body: { scope: SUBMISSIONS_V2_BACKGROUND_PAUSE_SCOPE, action: "pause", pauseId: "pause-1" },
  }, cronOnly, { env: { ...runnerEnv, CRON_SECRET: "cron-secret" }, control });
  assert.equal(cronOnly.statusCode, 401);
  assert.equal(calls, 0);

  const invalidScope = response();
  await handleSubmissionsV2BackgroundPause({
    method: "POST",
    headers: { authorization: `Bearer ${runnerEnv.PARAAI_AUTOMATION_RUNNER_KEY}` },
    body: { scope: "paraaiWorker", action: "pause", pauseId: "pause-1" },
  }, invalidScope, { env: runnerEnv, control });
  assert.equal(invalidScope.statusCode, 400);
  assert.equal(invalidScope.body.error, "invalid_scope");
  assert.equal(calls, 0);
});

test("V2 pause captures all five flags, disables them atomically, and is exact-idempotent", async () => {
  const { sql, state } = fakeDatabase();
  const control = createSubmissionsV2BackgroundPauseControl({ sql });
  const first = await control.apply({ action: "pause", pauseId: "owned-pause-1" });
  assert.deepEqual(first, {
    paused: true,
    controlState: "paused",
    pauseId: "owned-pause-1",
    controlEpoch: 8,
    restore: {
      scope: SUBMISSIONS_V2_BACKGROUND_PAUSE_SCOPE,
      pauseId: "owned-pause-1",
      before: {
        ui: true,
        ingestion: true,
        generation: true,
        masterInbox: true,
        curated: false,
      },
      pausedControlEpoch: 8,
      pausedReason: "paraform_background_pause:submissionsV2Worker:owned-pause-1",
    },
    action: "pause",
    alreadyPaused: false,
  });
  assert.deepEqual(state.writes.map((row) => [
    row.ui_enabled, row.ingestion_enabled, row.generation_enabled,
    row.master_inbox_enabled, row.curated_enabled,
  ]), [[true, false, false, true, false]]);
  const pauseCommand = [...state.commands.values()].find((row) => row.action === "submissions_v2_background_pause");
  assert.deepEqual(pauseCommand.result.before, {
    ui: true,
    ingestion: true,
    generation: true,
    masterInbox: true,
    curated: false,
  });
  assert.deepEqual(pauseCommand.result.paused, {
    ui: true, ingestion: false, generation: false, masterInbox: true, curated: false,
  });

  const replay = await control.apply({ action: "pause", pauseId: "owned-pause-1" });
  assert.equal(replay.alreadyPaused, true);
  assert.equal(state.writes.length, 1);
  await assert.rejects(
    control.apply({ action: "pause", pauseId: "different-owner" }),
    (error) => error.code === "pause_state_conflict" && error.status === 409,
  );
  assert.equal(state.writes.length, 1);
  const status = await control.status();
  assert.equal(status.paused, true);
  assert.equal(status.pauseId, "owned-pause-1");
  assert.deepEqual(status.restore.before, pauseCommand.result.before);
});

test("V2 resume restores exactly the five captured flags and replays without a second write", async () => {
  const { sql, state } = fakeDatabase();
  const control = createSubmissionsV2BackgroundPauseControl({ sql });
  await control.apply({ action: "pause", pauseId: "owned-pause-2" });
  const resumed = await control.apply({ action: "resume", pauseId: "owned-pause-2" });
  assert.deepEqual(resumed, {
    paused: false,
    controlState: "absent",
    pauseId: null,
    restoredControlEpoch: 9,
    action: "resume",
    alreadyResumed: false,
  });
  assert.deepEqual([
    state.controls.ui_enabled,
    state.controls.ingestion_enabled,
    state.controls.generation_enabled,
    state.controls.master_inbox_enabled,
    state.controls.curated_enabled,
  ], [true, true, true, true, false]);
  assert.deepEqual(await control.status(), { paused: false, controlState: "absent", pauseId: null });

  const replay = await control.apply({ action: "resume", pauseId: "owned-pause-2" });
  assert.equal(replay.alreadyResumed, true);
  assert.equal(state.writes.length, 2);
  await assert.rejects(
    control.apply({ action: "pause", pauseId: "owned-pause-2" }),
    (error) => error.code === "pause_state_conflict" && error.status === 409,
  );
});

test("V2 pause preserves originally false UI and subcontrols and restores the same mixed prestate", async () => {
  const { sql, state } = fakeDatabase({
    ui_enabled: false,
    ingestion_enabled: false,
    generation_enabled: true,
    master_inbox_enabled: false,
    curated_enabled: true,
  });
  const control = createSubmissionsV2BackgroundPauseControl({ sql });
  const paused = await control.apply({ action: "pause", pauseId: "mixed-prestate" });
  assert.deepEqual(paused.restore.before, {
    ui: false, ingestion: false, generation: true, masterInbox: false, curated: true,
  });
  assert.deepEqual([
    state.controls.ui_enabled,
    state.controls.ingestion_enabled,
    state.controls.generation_enabled,
    state.controls.master_inbox_enabled,
    state.controls.curated_enabled,
  ], [false, false, false, false, true]);
  await control.apply({ action: "resume", pauseId: "mixed-prestate" });
  assert.deepEqual([
    state.controls.ui_enabled,
    state.controls.ingestion_enabled,
    state.controls.generation_enabled,
    state.controls.master_inbox_enabled,
    state.controls.curated_enabled,
  ], [false, false, true, false, true]);
});

test("V2 resume refuses epoch, reason, actor, or flag drift instead of restoring stale state", async () => {
  for (const mutate of [
    (row) => { row.control_epoch += 1; },
    (row) => { row.reason = "manual change"; },
    (row) => { row.actor_email = "david@raydar.xyz"; },
    (row) => { row.curated_enabled = true; },
  ]) {
    const { sql, state } = fakeDatabase();
    const control = createSubmissionsV2BackgroundPauseControl({ sql });
    await control.apply({ action: "pause", pauseId: `drift-${state.controls.control_epoch}` });
    mutate(state.controls);
    await assert.rejects(
      control.apply({ action: "resume", pauseId: `drift-7` }),
      (error) => error.code === "pause_state_conflict" && error.status === 409,
    );
    assert.equal(state.writes.length, 1);
  }
});

test("an invalid owned pause state remains visibly fail-closed and cannot be overwritten", async () => {
  const { sql, state } = fakeDatabase({
    actor_email: "paraform-background-pause@raydar.xyz",
    reason: "paraform_background_pause:submissionsV2Worker:missing-record",
    ui_enabled: false,
    ingestion_enabled: false,
    generation_enabled: false,
    master_inbox_enabled: false,
    curated_enabled: false,
  });
  const control = createSubmissionsV2BackgroundPauseControl({ sql });
  assert.deepEqual(await control.status(), {
    paused: true, controlState: "invalid", pauseId: null, controlEpoch: 7,
  });
  await assert.rejects(
    control.apply({ action: "pause", pauseId: "replacement" }),
    (error) => error.code === "pause_state_conflict" && error.status === 409,
  );
  assert.equal(state.writes.length, 0);
});
