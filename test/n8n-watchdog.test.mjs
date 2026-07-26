import test from "node:test";
import assert from "node:assert/strict";
import { failureStreaks } from "../api/ops/n8n-watchdog.mjs";

// The exact shape of the incident: nine consecutive scheduled failures with a
// last success well before them. This must be detectable from execution history
// alone, because no workflow on the instance has an errorWorkflow set.
test("a nine-day dead workflow is detected from execution history alone", () => {
  const runs = [];
  for (let d = 25; d >= 17; d--) runs.push({ workflowId: "W", mode: "trigger", status: "error", startedAt: `2026-07-${d}T21:00:52Z` });
  runs.push({ workflowId: "W", mode: "trigger", status: "success", startedAt: "2026-07-16T21:00:52Z" });
  const [s] = failureStreaks(runs);
  assert.equal(s.workflowId, "W");
  assert.equal(s.streak, 9);
  assert.equal(s.lastSuccessAt, "2026-07-16T21:00:52Z");
});

test("a workflow that recovered has no streak", () => {
  assert.deepEqual(failureStreaks([
    { workflowId: "W", mode: "trigger", status: "success", startedAt: "2026-07-26T21:00:00Z" },
    { workflowId: "W", mode: "trigger", status: "error", startedAt: "2026-07-25T21:00:00Z" },
  ]), []);
});

test("manual runs are ignored — a human poking at it is not an outage", () => {
  assert.deepEqual(failureStreaks([
    { workflowId: "W", mode: "manual", status: "error", startedAt: "2026-07-26T10:00:00Z" },
    { workflowId: "W", mode: "trigger", status: "success", startedAt: "2026-07-26T09:00:00Z" },
  ]), []);
});

test("out-of-order history is sorted before the streak is counted", () => {
  const [s] = failureStreaks([
    { workflowId: "W", mode: "trigger", status: "error", startedAt: "2026-07-24T21:00:00Z" },
    { workflowId: "W", mode: "trigger", status: "error", startedAt: "2026-07-26T21:00:00Z" },
    { workflowId: "W", mode: "trigger", status: "success", startedAt: "2026-07-23T21:00:00Z" },
    { workflowId: "W", mode: "trigger", status: "error", startedAt: "2026-07-25T21:00:00Z" },
  ]);
  assert.equal(s.streak, 3);
});

test("crashed counts as failed, and workflows are tracked independently", () => {
  const out = failureStreaks([
    { workflowId: "A", mode: "trigger", status: "crashed", startedAt: "2026-07-26T21:00:00Z" },
    { workflowId: "B", mode: "trigger", status: "success", startedAt: "2026-07-26T21:00:00Z" },
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].workflowId, "A");
});

// The first version of this watchdog scanned ONE global execution list capped at
// 250. With a 5-minute workflow in the mix that window is a few hours, so the
// once-daily job that actually died never appeared in it and the watchdog
// reported all-clear. Coverage must be per workflow.
test("a once-daily failure is not drowned out by a five-minute workflow", () => {
  const runs = [];
  // 250 recent successes from a busy workflow...
  for (let i = 0; i < 250; i++) runs.push({ workflowId: "BUSY", mode: "trigger", status: "success", startedAt: `2026-07-26T${String(Math.floor(i / 12)).padStart(2, "0")}:${String((i % 12) * 5).padStart(2, "0")}:00Z` });
  // ...and the daily one that has been dead for nine days, all older.
  for (let d = 25; d >= 17; d--) runs.push({ workflowId: "DAILY", mode: "trigger", status: "error", startedAt: `2026-07-${d}T21:00:52Z` });
  const daily = failureStreaks(runs).find((s) => s.workflowId === "DAILY");
  assert.ok(daily, "the daily workflow's failures must be visible");
  assert.equal(daily.streak, 9);
});
