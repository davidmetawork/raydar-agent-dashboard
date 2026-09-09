import assert from "node:assert/strict";
import { test } from "node:test";
import { createWorkerHealth } from "../submissions-v2-worker/health.mjs";

function clock() {
  let time = Date.parse("2026-09-08T00:00:00Z");
  return { now: () => time, advance: (ms) => { time += ms; } };
}

test("worker startup has a bounded grace period and cannot remain green without starting the loop", () => {
  const time = clock(); const health = createWorkerHealth({ now: time.now });
  assert.equal(health.snapshot().status, "starting");
  assert.equal(health.snapshot().last_cycle_at, null);
  time.advance(30_001);
  assert.equal(health.snapshot().ok, false);
  assert.equal(health.snapshot().status, "loop_not_started");
});

test("a legitimate twenty-minute cycle stays live but an unresponsive cycle becomes unhealthy", () => {
  const time = clock(); const health = createWorkerHealth({ now: time.now });
  health.beginCycle();
  time.advance(1_195_000);
  assert.equal(health.snapshot().ok, true);
  time.advance(65_001);
  assert.equal(health.snapshot().status, "cycle_stalled");
  assert.equal(health.snapshot().ok, false);
  health.completeCycle({ ok: true });
  assert.equal(health.snapshot().status, "healthy");
});

test("a stopped loop becomes unhealthy after its last completion and recovers on progress", () => {
  const time = clock(); const health = createWorkerHealth({ now: time.now });
  health.beginCycle(); time.advance(1_000); health.completeCycle({ ok: true });
  assert.equal(health.snapshot().last_cycle_at, "2026-09-08T00:00:00.000Z");
  assert.equal(health.snapshot().last_cycle_completed_at, "2026-09-08T00:00:01.000Z");
  time.advance(30_001);
  assert.equal(health.snapshot().status, "loop_stalled");
  health.beginCycle(); health.completeCycle({ ok: true });
  assert.equal(health.snapshot().ok, true);
});

test("database or scheduling failures do not report healthy and recover only after a completed cycle", () => {
  const time = clock(); const health = createWorkerHealth({ now: time.now });
  health.beginCycle(); health.completeCycle({ ok: true });
  const prior = health.snapshot().last_cycle_completed_at;
  time.advance(10_000); health.beginCycle(); health.failCycle();
  assert.equal(health.snapshot().status, "cycle_failed");
  assert.equal(health.snapshot().last_cycle_completed_at, prior);
  health.beginCycle();
  assert.equal(health.snapshot().ok, false);
  health.completeCycle({ ok: true });
  assert.equal(health.snapshot().ok, true);
});

test("handled source retries are visible separately from worker liveness; missing controls are not", () => {
  const time = clock(); const health = createWorkerHealth({ now: time.now });
  health.beginCycle(); health.completeCycle({ ok: false, jobs: [{ state: "retry" }] });
  assert.equal(health.snapshot().ok, true);
  assert.equal(health.snapshot().last_cycle_ok, false);
  health.beginCycle(); health.completeCycle({ ok: false, held: "controls_unavailable" });
  assert.equal(health.snapshot().ok, false);
  health.beginCycle(); health.completeCycle({ ok: true, held: "all_controls_disabled" });
  assert.equal(health.snapshot().ok, true);
});

test("shutdown remains unhealthy even if an in-flight cycle completes", () => {
  const time = clock(); const health = createWorkerHealth({ now: time.now });
  health.beginCycle(); health.stop(); health.completeCycle({ ok: true });
  assert.equal(health.snapshot().ok, false);
  assert.equal(health.snapshot().status, "stopping");
});
