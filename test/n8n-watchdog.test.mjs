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
