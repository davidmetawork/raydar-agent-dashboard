import test from "node:test";
import assert from "node:assert/strict";
import {
  STALE_ACTIVE_JOB_MS,
  isRunnablePrepJob,
  jobLastActivityAt,
} from "../api/prepdoc/_lib/core.mjs";

const now = Date.parse("2026-07-16T21:30:00.000Z");
const isoBefore = (milliseconds) => new Date(now - milliseconds).toISOString();

test("queued prep jobs are always runnable", () => {
  assert.equal(isRunnablePrepJob({ status: "queued" }, now), true);
});

test("active prep jobs become runnable only after 15 minutes without progress", () => {
  const fresh = {
    status: "generating",
    created_at: isoBefore(STALE_ACTIVE_JOB_MS - 1),
  };
  const stale = {
    status: "generating",
    created_at: isoBefore(STALE_ACTIVE_JOB_MS),
  };

  assert.equal(isRunnablePrepJob(fresh, now), false);
  assert.equal(isRunnablePrepJob(stale, now), true);
});

test("the latest valid history timestamp determines active job staleness", () => {
  const job = {
    status: "drafting",
    created_at: isoBefore(STALE_ACTIVE_JOB_MS * 2),
    history: [
      { at: isoBefore(STALE_ACTIVE_JOB_MS * 2), status: "queued" },
      { at: "not-a-date", status: "generating" },
      { at: isoBefore(60_000), status: "drafting" },
    ],
  };

  assert.equal(jobLastActivityAt(job), now - 60_000);
  assert.equal(isRunnablePrepJob(job, now), false);
});

test("terminal prep jobs are never reclaimed", () => {
  for (const status of ["done", "failed"]) {
    assert.equal(isRunnablePrepJob({ status, created_at: isoBefore(STALE_ACTIVE_JOB_MS * 2) }, now), false);
  }
});

test("active jobs with missing timestamps fail toward recovery", () => {
  assert.equal(isRunnablePrepJob({ status: "claimed" }, now), true);
});
