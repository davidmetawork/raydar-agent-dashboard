import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// runAutomationCycle is a hand-ordered inline sequence with no tick registry, so
// the ordering that arbitrates the day-6-reply / day-7-expiry race is only a
// convention until something asserts it. A refactor that moves the expired tick
// above the reply tick would silently flip who takes the shared claim first,
// and the hiring manager would get "Candidate didn't get back" about a
// candidate who did.
const source = readFileSync(
  new URL("../api/paraai/worker.mjs", import.meta.url),
  "utf8",
);

test("the expired tick runs after the reply tick", () => {
  const reply = source.indexOf("await runReplyTick()");
  const expired = source.indexOf("await runExpiredTick()");
  const interest = source.indexOf("await runInterestTick()");
  assert.ok(reply > 0, "expected the reply tick in the worker cycle");
  assert.ok(expired > 0, "expected the expired tick in the worker cycle");
  assert.ok(interest > 0, "expected the curated-interest tick in the worker cycle");
  assert.ok(reply < expired, "the reply lane must classify before the expired lane can claim");
  assert.ok(expired < interest, "curated-interest actioning must follow the established reply/expired order");
});

test("the ordering carries its rationale in the code", () => {
  assert.match(source, /ORDER IS A CONTRACT/);
});

// Every lane routes its caught failure through the shared alertWorkerFailure
// helper (PR #132, which moved the per-lane takeAlertSlot calls into one place
// so an AUTH_EXPIRED failure reports to the auth probe instead of flapping
// Slack). The throttle window therefore lives in the helper, and each lane owns
// only its slot key — so the per-lane tests below assert the slot they pass,
// and this one pins the window they all share.
test("worker-lane alerts are throttled to one per hour", () => {
  assert.match(
    source,
    /takeAlertSlot\(slot, 3600\)/,
    "alertWorkerFailure must throttle every lane's alert to one per hour",
  );
});

test("an expired-tick failure cannot stop the other lanes", () => {
  // Same isolation shape as outreach and reply: caught, throttled-alerted,
  // surfaced as degraded, never rethrown into the cycle.
  assert.match(source, /expired = await runExpiredTick\(\);\s*\}\s*catch \(error\) \{/);
  assert.match(
    source,
    /expired = await runExpiredTick\(\);\s*\}\s*catch \(error\) \{[\s\S]*?alertWorkerFailure\(error, \{[\s\S]*?slot: "expired-worker-failed"/,
    "the expired lane's catch must alert on its own slot",
  );
  assert.match(source, /\|\|\s*expiredError/, "expiredError must feed the degraded flag");
  assert.match(source, /\n\s+expired,\n\s+expiredError,/, "the tick result must be reported");
});

test("the lane's health is exposed on the status mode", () => {
  assert.match(source, /expired: await expiredHealth\(\)/);
});

test("an interest-tick failure cannot stop the other lanes", () => {
  assert.match(source, /interest = await runInterestTick\(\);\s*\}\s*catch \(error\) \{/);
  assert.match(
    source,
    /interest = await runInterestTick\(\);\s*\}\s*catch \(error\) \{[\s\S]*?alertWorkerFailure\(error, \{[\s\S]*?slot: "interest-worker-failed"/,
    "the curated-interest lane's catch must alert on its own slot",
  );
  assert.match(source, /\|\|\s*interestError/, "interestError must feed the degraded flag");
  assert.match(source, /\n\s+interest,\n\s+interestError,/, "the tick result must be reported");
});

test("curated-interest health is exposed on the status mode", () => {
  assert.match(source, /interest: await interestStatus\(\)/);
});
