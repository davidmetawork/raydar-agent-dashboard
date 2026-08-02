import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import test from "node:test";

import { rearmRaydarPauseCanary } from "../api/seq/_lib/pause-canary-rearm.mjs";
import { handlePauseCanaryRearmRequest } from "../api/seq/rearm-pause-canary.mjs";

const EMAIL = "canary@example.invalid";
const SECRET = "s".repeat(32);
const REARM_KEY = "r".repeat(32);
const CRON_SECRET = "c".repeat(32);
const identitySha256 = createHash("sha256").update(EMAIL).digest("hex");
const fingerprint = createHmac("sha256", SECRET)
  .update(`raydar-booking-pause-canary-v1\0${EMAIL}`)
  .digest("hex");
const env = {
  RAYDAR_SCHEDULER_WEBHOOK_SECRET: SECRET,
  RAYDAR_BOOKING_PAUSE_CANARY_FINGERPRINT: fingerprint,
  RAYDAR_PAUSE_CANARY_REARM_KEY: REARM_KEY,
  CRON_SECRET,
};

function snapshot(entries = [
  {
    seq: { id: "sequence-1" },
    leads: [{
      ccu_id: "lead-1",
      to_use_email: EMAIL,
      user_emails: [],
      is_paused: true,
      is_archived: false,
    }],
  },
]) {
  return { ok: true, complete: true, perSequence: entries };
}

test("rearms exactly one fingerprint-bound paused canary and reads it back", async () => {
  let paused = true;
  const writes = [];
  const result = await rearmRaydarPauseCanary({
    identitySha256,
    env,
    loadSnapshotImpl: async () => snapshot(),
    searchImpl: async (_sequence, _email, options) => ({
      ccu_id: options.expectedCcuId,
      is_paused: paused,
      is_archived: false,
    }),
    updateImpl: async (ccuId) => {
      writes.push(ccuId);
      paused = false;
    },
    refreshImpl: async () => { paused = true; },
  });

  assert.deepEqual(result, {
    ok: true,
    rearmed: 1,
    alreadyRearmed: false,
    refreshed: 1,
    leadsVerified: 1,
  });
  assert.deepEqual(writes, ["lead-1"]);
});

test("the configured fingerprint can resolve the canary without exposing its identity", async () => {
  let paused = true;
  const result = await rearmRaydarPauseCanary({
    env,
    loadSnapshotImpl: async () => snapshot(),
    searchImpl: async (_sequence, _email, options) => ({
      ccu_id: options.expectedCcuId,
      is_paused: paused,
      is_archived: false,
    }),
    updateImpl: async () => { paused = false; },
    refreshImpl: async () => { paused = true; },
  });
  assert.equal(result.rearmed, 1);
  assert.equal(Object.hasOwn(result, "identitySha256"), false);
});

test("fails closed for the wrong identity, ambiguous leads, and failed readback", async () => {
  const base = {
    identitySha256,
    env,
    loadSnapshotImpl: async () => snapshot(),
  };
  await assert.rejects(
    rearmRaydarPauseCanary({ ...base, identitySha256: "0".repeat(64) }),
    { code: "PAUSE_CANARY_REARM_IDENTITY_MISMATCH" },
  );
  await assert.rejects(
    rearmRaydarPauseCanary({
      ...base,
      loadSnapshotImpl: async () => snapshot([
        {
          seq: { id: "sequence-1" },
          leads: [{
            ccu_id: "lead-1",
            to_use_email: EMAIL,
            user_emails: [],
            is_paused: true,
            is_archived: false,
          }],
        },
        {
          seq: { id: "sequence-2" },
          leads: [{
            ccu_id: "lead-2",
            to_use_email: EMAIL,
            user_emails: [],
            is_paused: true,
            is_archived: false,
          }],
        },
      ]),
      searchImpl: async (_s, _e, options) => ({
        ccu_id: options.expectedCcuId,
        is_paused: true,
        is_archived: false,
      }),
    }),
    { code: "PAUSE_CANARY_REARM_LEAD_AMBIGUOUS" },
  );
  await assert.rejects(
    rearmRaydarPauseCanary({
      ...base,
      searchImpl: async (_s, _e, options) => ({
        ccu_id: options.expectedCcuId,
        is_paused: true,
        is_archived: false,
      }),
      updateImpl: async () => {},
      refreshImpl: async () => {},
    }),
    { code: "PAUSE_CANARY_REARM_READBACK_FAILED" },
  );
  let paused = true;
  await assert.rejects(
    rearmRaydarPauseCanary({
      ...base,
      searchImpl: async (_s, _e, options) => ({
        ccu_id: options.expectedCcuId,
        is_paused: paused,
        is_archived: false,
      }),
      updateImpl: async () => { paused = false; },
      refreshImpl: async () => {},
    }),
    { code: "PAUSE_CANARY_REARM_FINAL_READBACK_FAILED" },
  );
});

test("private rearm route requires the exact bearer and a bounded body", async () => {
  const denied = await handlePauseCanaryRearmRequest(new Request(
    "https://monitor.raydar.xyz/api/seq/rearm-pause-canary",
    { method: "POST", body: JSON.stringify({ identitySha256 }) },
  ), { env });
  assert.equal(denied.status, 401);

  let received = null;
  const accepted = await handlePauseCanaryRearmRequest(new Request(
    "https://monitor.raydar.xyz/api/seq/rearm-pause-canary",
    {
      method: "POST",
      headers: { authorization: `Bearer ${REARM_KEY}` },
      body: JSON.stringify({ identitySha256 }),
    },
  ), {
    env,
    rearmImpl: async (input) => {
      received = input.identitySha256;
      return { ok: true, rearmed: 1, alreadyRearmed: false, leadsVerified: 1 };
    },
  });
  assert.equal(accepted.status, 200);
  assert.equal(received, identitySha256);
  assert.deepEqual(await accepted.json(), {
    ok: true,
    rearmed: 1,
    alreadyRearmed: false,
    leadsVerified: 1,
  });

  const fingerprintOnly = await handlePauseCanaryRearmRequest(new Request(
    "https://monitor.raydar.xyz/api/seq/rearm-pause-canary",
    {
      method: "POST",
      headers: { authorization: `Bearer ${REARM_KEY}` },
      body: "{}",
    },
  ), {
    env,
    rearmImpl: async (input) => ({
      ok: input.identitySha256 == null,
      rearmed: 1,
      alreadyRearmed: false,
      leadsVerified: 1,
    }),
  });
  assert.equal(fingerprintOnly.status, 200);
  assert.equal((await fingerprintOnly.json()).ok, true);
});

test("scheduled rearm accepts only the exact cron bearer and needs no identity body", async () => {
  for (const headers of [
    {},
    { "x-vercel-cron": "1" },
    { authorization: `Bearer ${REARM_KEY}` },
  ]) {
    const denied = await handlePauseCanaryRearmRequest(new Request(
      "https://monitor.raydar.xyz/api/seq/rearm-pause-canary",
      { method: "GET", headers },
    ), { env });
    assert.equal(denied.status, 401);
  }

  let received = "not-called";
  const accepted = await handlePauseCanaryRearmRequest(new Request(
    "https://monitor.raydar.xyz/api/seq/rearm-pause-canary",
    {
      method: "GET",
      headers: { authorization: `Bearer ${CRON_SECRET}` },
    },
  ), {
    env,
    rearmImpl: async ({ identitySha256: identity }) => {
      received = identity;
      return { ok: true, rearmed: 1, refreshed: 1, leadsVerified: 1 };
    },
  });
  assert.equal(accepted.status, 200);
  assert.equal(received, null);
  assert.deepEqual(await accepted.json(), {
    ok: true,
    rearmed: 1,
    refreshed: 1,
    leadsVerified: 1,
  });
});
