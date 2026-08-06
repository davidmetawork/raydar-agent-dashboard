import assert from "node:assert/strict";
import test from "node:test";

import {
  CURATED_FIT_ALERT_TTL_SECONDS,
  curatedFitDeadmanStatus,
  runCuratedFitDeadmanTick,
} from "../api/paraai/_lib/curated-fit-deadman.mjs";

const NOW = Date.parse("2026-08-06T22:30:00.000Z");

function response(body, { status = 200, contentLength = null } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => contentLength },
    text: async () => body,
  };
}

test("dead-man classifies a fresh aggregate watermark without reading candidate rows", async () => {
  const status = await curatedFitDeadmanStatus({
    now: NOW,
    fetchImpl: async () => response(JSON.stringify({
      version: 1,
      lastRun: "2026-08-06T22:00:00.000Z",
      candidates: { deliberately: "ignored" },
    })),
  });
  assert.deepEqual(status, {
    ok: true,
    code: "healthy",
    ageMs: 30 * 60_000,
    detail: null,
  });
});

test("dead-man detects a stale scheduler and malformed or unreadable state", async () => {
  const stale = await curatedFitDeadmanStatus({
    now: NOW,
    fetchImpl: async () => response(JSON.stringify({
      version: 1,
      lastRun: "2026-08-06T20:00:00.000Z",
    })),
  });
  assert.equal(stale.code, "scheduler_stale");
  assert.equal(stale.ageMs, 150 * 60_000);
  assert.equal((await curatedFitDeadmanStatus({
    now: NOW,
    fetchImpl: async () => response("not json"),
  })).code, "state_malformed");
  assert.equal((await curatedFitDeadmanStatus({
    now: NOW,
    fetchImpl: async () => response("down", { status: 503 }),
  })).code, "state_unreadable");
});

test("dead-man throttles an aggregate Slack alert and never throws on notification failure", async () => {
  const slots = [];
  const notices = [];
  const result = await runCuratedFitDeadmanTick({
    statusImpl: async () => ({ ok: false, code: "scheduler_stale", ageMs: 150 * 60_000 }),
    alertSlotImpl: async (...args) => { slots.push(args); return true; },
    notifyImpl: async (message) => { notices.push(message); throw new Error("slack down"); },
  });
  assert.equal(result.alerted, true);
  assert.deepEqual(slots, [["curated-fit-deadman:scheduler_stale", CURATED_FIT_ALERT_TTL_SECONDS]]);
  assert.equal(notices.length, 1);
  assert.match(notices[0], /150 minutes ago/);
  assert.doesNotMatch(notices[0], /candidate-user|@/);
});
