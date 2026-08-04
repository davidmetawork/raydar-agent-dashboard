import test from "node:test";
import assert from "node:assert/strict";

import {
  dailySubmitBudget,
  recordSubmitAttempt,
  submitBudgetGate,
  submitBudgetState,
} from "../api/paraai/_lib/submit-budget.mjs";

const NOW = Date.parse("2026-08-04T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

// Minimal in-memory stand-in for the ZSET commands the budget uses.
function fakeKv(initial = []) {
  let rows = [...initial];
  const impl = async (args) => {
    const [command, , ...rest] = args;
    if (command === "ZADD") return (rows.push({ score: Number(rest[0]), member: rest[1] }), 1);
    if (command === "ZREMRANGEBYSCORE") {
      const max = Number(rest[1]);
      const before = rows.length;
      rows = rows.filter((row) => row.score > max);
      return before - rows.length;
    }
    if (command === "ZCOUNT") {
      const min = Number(rest[0]);
      return rows.filter((row) => row.score >= min).length;
    }
    if (command === "ZRANGE") {
      const sorted = [...rows].sort((a, b) => a.score - b.score);
      return sorted.length ? [sorted[0].member, String(sorted[0].score)] : [];
    }
    if (command === "EXPIRE") return 1;
    throw new Error(`unexpected command ${command}`);
  };
  impl.rows = () => rows;
  return impl;
}

const fill = (count, at = NOW) =>
  Array.from({ length: count }, (_, i) => ({ score: at - i * 1000, member: `${at - i * 1000}:job-${i}` }));

test("the budget defaults to 79, one short of the observed cliff", () => {
  assert.equal(dailySubmitBudget(undefined), 79);
  assert.equal(dailySubmitBudget(""), 79);
  assert.equal(dailySubmitBudget("abc"), 79);
  assert.equal(dailySubmitBudget("-5"), 79);
  assert.equal(dailySubmitBudget("50"), 50);
  // 0 is a legitimate kill switch, not a fallback to the default.
  assert.equal(dailySubmitBudget("0"), 0);
});

test("a write is allowed while the window has room", async () => {
  const kvImpl = fakeKv(fill(78));
  assert.equal(await submitBudgetGate({ now: NOW, kvImpl }), null);
  const state = await submitBudgetState({ now: NOW, kvImpl });
  assert.equal(state.used, 78);
  assert.equal(state.remaining, 1);
});

test("the 79th write closes the gate instead of burning into the void", async () => {
  const kvImpl = fakeKv(fill(79));
  const blocked = await submitBudgetGate({ now: NOW, kvImpl });
  assert.equal(blocked.action, "reschedule");
  assert.match(blocked.detail, /budget spent \(79\/79 in the last 24h\)/u);
  assert.equal(blocked.budget.remaining, 0);
});

test("deferral is a reschedule, never an error or a review state", async () => {
  // The job is good; it is only waiting for a slot. Failing it would put a
  // perfectly submittable candidate in front of a human for no reason.
  const blocked = await submitBudgetGate({ now: NOW, kvImpl: fakeKv(fill(79)) });
  assert.equal(blocked.action, "reschedule");
  assert.ok(!("error" in blocked));
  assert.ok(blocked.delayMs > 0);
});

test("the window rolls, so the backlog drains as old writes age out", async () => {
  // 79 writes made 23h ago: still spent now, free in an hour.
  const kvImpl = fakeKv(fill(79, NOW - 23 * 60 * 60 * 1000));
  const blocked = await submitBudgetGate({ now: NOW, kvImpl });
  assert.equal(blocked.action, "reschedule");
  // The oldest write frees its slot at exactly 24h after it was made.
  const expected = (NOW - 23 * 60 * 60 * 1000 - 78 * 1000) + DAY;
  assert.equal(blocked.budget.nextFreeAt, expected);

  // One day later the whole window has aged out.
  assert.equal(await submitBudgetGate({ now: NOW + DAY, kvImpl }), null);
});

test("a rolling window cannot overshoot across an unknown reset boundary", async () => {
  // A calendar-day budget would hand out a fresh 79 at midnight even if
  // Paraform's own counter resets at some other hour. The rolling window never
  // does: 79 writes spread over the previous 23 hours still block right now.
  const kvImpl = fakeKv(fill(79, NOW - 23 * 60 * 60 * 1000));
  for (const offset of [0, 2 * 60 * 60_000, 12 * 60 * 60_000]) {
    const gate = await submitBudgetGate({ now: NOW + offset, kvImpl });
    if (offset < 60 * 60_000) assert.ok(gate, `expected block at +${offset}`);
  }
});

test("recording an attempt counts it and prunes the window", async () => {
  const kvImpl = fakeKv([{ score: NOW - DAY - 5000, member: "ancient:job-x" }]);
  await recordSubmitAttempt("job-1", { now: NOW, kvImpl });
  const state = await submitBudgetState({ now: NOW, kvImpl });
  assert.equal(state.used, 1);
  assert.ok(!kvImpl.rows().some((row) => row.member.startsWith("ancient")));
});

test("attempts are counted, not confirmations", async () => {
  // We are budgeting against a counter we cannot read. A write that failed for
  // our own reasons may still have consumed one of Paraform's slots, so the
  // only conservative reading is to count the attempt.
  const kvImpl = fakeKv();
  await recordSubmitAttempt("job-a", { now: NOW, kvImpl });
  await recordSubmitAttempt("job-b", { now: NOW + 1, kvImpl });
  assert.equal((await submitBudgetState({ now: NOW + 2, kvImpl })).used, 2);
});

test("a zero budget halts automatic submission without touching any gate", async () => {
  const blocked = await submitBudgetGate({ now: NOW, limit: 0, kvImpl: fakeKv() });
  assert.equal(blocked.action, "reschedule");
  assert.equal(blocked.budget.used, 0);
  assert.equal(blocked.budget.limit, 0);
});
