import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// D06 (2026-09-24, Paraform reduction pass): reply actioning, expired-match
// actioning and curated-interest detection were removed from the Fly
// worker's dispatch loop. On 2026-09-25 David turned expired-match actioning
// back on (armed) alongside candidate outreach, so it is dispatched again,
// after outreach. Reply actioning and curated-interest detection stay
// retired. The kept lanes — outreach, the human-call pipeline
// (runAutoTick/auto.mjs) and submission-notify (a separate, already-retired
// endpoint this worker never called) — are asserted here to still dispatch
// exactly as before.
const source = readFileSync(
  new URL("../api/paraai/worker.mjs", import.meta.url),
  "utf8",
);

test("reply and curated-interest stay out of the dispatch loop", () => {
  assert.doesNotMatch(source, /runReplyTick\(\)/);
  assert.doesNotMatch(source, /runInterestTick\(\)/);
  assert.doesNotMatch(source, /replyHealth\(\)/);
  assert.doesNotMatch(source, /interestStatus\(\)/);
  // Their imports are gone too — a stale unused import is exactly the kind
  // of coupling risk the retirement plan flagged (shared _lib/store.mjs and
  // request-claim.mjs helpers with lanes that ARE kept).
  assert.doesNotMatch(source, /from ".\/_lib\/reply\.mjs"/);
  assert.doesNotMatch(source, /from ".\/_lib\/interest\.mjs"/);
});

test("expired-match actioning is dispatched again, after outreach, in both worker states", () => {
  assert.match(source, /import \{ runExpiredTick \} from ".\/_lib\/expired\.mjs"/);
  // Full cycle: outreach first, so a request emailed this tick is marked
  // reached out before its expiry is judged.
  const outreach = source.indexOf("outreach = await runOutreachTick();");
  const expired = source.indexOf("await runExpiredLane();");
  assert.ok(outreach > 0 && expired > outreach, "the full cycle runs expired after outreach");
  assert.match(source, /\|\|\s*expiredError/, "expiredError must feed the degraded flag");
  assert.match(source, /\n\s+expired,\n\s+expiredError,/, "the expired result must be reported");
  // Paused worker: the request-lanes helper runs the same two lanes in the
  // same order (behaviour pinned in paraai-request-lanes.test.mjs).
  const helperOutreach = source.indexOf("outreach = await outreachImpl();");
  const helperExpired = source.indexOf("await runExpiredLane({ expiredImpl, alertImpl })");
  assert.ok(helperOutreach > 0 && helperExpired > helperOutreach);
  assert.match(
    source,
    /expired: await expiredImpl\(\)[\s\S]*?slot: "expired-worker-failed"/,
    "the expired lane's failure must alert on its own slot",
  );
});

test("the retired lanes' own handler modules are untouched (not deleted)", () => {
  // Stream 1's plan is explicit: do not delete interest.mjs/expired.mjs/
  // reply.mjs or their _lib modules in this pass — only the automatic tick
  // call from the worker loop. They remain reachable as standalone manual
  // routes.
  for (const file of ["reply.mjs", "expired.mjs", "interest.mjs"]) {
    assert.doesNotThrow(
      () => readFileSync(new URL(`../api/paraai/${file}`, import.meta.url)),
      `${file} must still exist`,
    );
  }
  for (const file of ["reply.mjs", "expired.mjs", "interest.mjs"]) {
    assert.doesNotThrow(
      () => readFileSync(new URL(`../api/paraai/_lib/${file}`, import.meta.url)),
      `_lib/${file} must still exist`,
    );
  }
});

test("the outreach lane still dispatches identically", () => {
  assert.match(source, /outreach = await runOutreachTick\(\);\s*\}\s*catch \(error\) \{/);
  assert.match(
    source,
    /outreach = await runOutreachTick\(\);\s*\}\s*catch \(error\) \{[\s\S]*?alertWorkerFailure\(error, \{[\s\S]*?slot: "outreach-worker-failed"/,
    "the outreach lane's catch must alert on its own slot",
  );
  assert.match(source, /\|\|\s*outreachError/, "outreachError must still feed the degraded flag");
  assert.match(source, /\n\s+outreach,\n\s+outreachError,/, "the tick result must still be reported");
  assert.match(source, /outreach: await outreachHealth\(\)/, "outreach health must still be exposed on status mode");
});

test("worker-lane alerts remain throttled to one per hour", () => {
  assert.match(
    source,
    /takeAlertSlot\(slot, 3600\)/,
    "alertWorkerFailure must still throttle every remaining lane's alert to one per hour",
  );
});

test("submission-notify was never part of this dispatch loop and stays that way", () => {
  assert.doesNotMatch(source, /submission-notify/);
});
