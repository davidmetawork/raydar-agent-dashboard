// Process liveness is separate from source coverage. A handled provider retry
// proves the loop is working; a rejected or stuck cycle must not report green.
export function createWorkerHealth({
  now = Date.now,
  startupGraceMs = 30_000,
  maxCycleMs = 360_000,
  maxIdleMs = 30_000,
} = {}) {
  const startedAt = now();
  let cycleStartedAt = null;
  let cycleCompletedAt = null;
  let cycleRunning = false;
  let lastCycleOk = null;
  let cycleFailed = false;
  let stopping = false;
  const instant = (value) => value == null ? null : new Date(value).toISOString();

  return {
    beginCycle() {
      cycleStartedAt = now();
      cycleRunning = true;
    },
    completeCycle(result) {
      cycleCompletedAt = now();
      cycleRunning = false;
      lastCycleOk = result?.ok === true;
      cycleFailed = result?.held === "controls_unavailable";
    },
    failCycle() {
      cycleRunning = false;
      lastCycleOk = false;
      cycleFailed = true;
    },
    stop() { stopping = true; },
    snapshot() {
      const time = now();
      let status = "healthy";
      if (stopping) status = "stopping";
      else if (cycleRunning && time - cycleStartedAt > maxCycleMs) status = "cycle_stalled";
      else if (cycleFailed) status = "cycle_failed";
      else if (!cycleRunning && cycleCompletedAt != null && time - cycleCompletedAt > maxIdleMs) status = "loop_stalled";
      else if (!cycleRunning && cycleCompletedAt == null) status = time - startedAt <= startupGraceMs ? "starting" : "loop_not_started";
      return {
        ok: status === "healthy" || status === "starting",
        status,
        cycle_running: cycleRunning,
        last_cycle_at: instant(cycleStartedAt),
        last_cycle_completed_at: instant(cycleCompletedAt),
        last_cycle_ok: lastCycleOk,
      };
    },
  };
}
