// One refusal used to fail that day's live-set refresh (2026-09-28 gap): the
// pause between sequence walks rethrew PARAFORM_PACED_BACKOFF, so a backoff
// another invocation wrote (the worker's tick, or the pacer holding others
// off while it confirms a 401) failed the whole run, and so did a single
// throttle refusal of the catalog read. The refresh now waits a backoff out
// when it ends before the run's deadline, and gives the catalog read one
// more attempt after a transient refusal. These tests drive the real pacer
// with a fake clock and a fake Paraform.
process.env.PARAFORM_COOKIE ||= "Fe26.2**test-cookie";

import test from "node:test";
import assert from "node:assert/strict";

import {
  createPacer,
  isTransientRefusal,
  pacedWithinDeadline,
  PACE_DEFAULT_BACKOFF_MS,
  PACE_MIN_INTERVAL_MS,
} from "../api/seq/_lib/booking-protection-pace.mjs";
import {
  refreshPacedCalls,
  LIVESET_REFRESH_BUDGET_MS,
  LIVESET_CATALOG_BUDGET_MS,
  config as refreshConfig,
} from "../api/seq/booking-liveset-refresh.mjs";
import { buildLiveSet, liveSetUsable } from "../api/seq/_lib/booking-protection-liveset.mjs";

const START = Date.parse("2026-09-29T05:26:00.000Z");
const CATALOG = "campaigns.getListOfCampaignsOptimized";
const ok = (json) => Response.json({ result: { data: { json } } });

// A pacer on in-memory state and a fake clock that sleeping advances, the
// way separate invocations share it through KV in production.
function harness({ answer = () => ok([]), kvDown = false } = {}) {
  let clockMs = START;
  let state = null;
  const sent = [];
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    const proc = String(url).split("/trpc/")[1]?.split("?")[0] || String(url);
    sent.push({ proc, at: clockMs });
    return answer(proc, sent.length);
  };
  const clock = () => clockMs;
  const sleep = async (ms) => { clockMs += ms; };
  const pace = createPacer({
    // kvDown: the store answers nothing and keeps nothing, as kvGet/kvSet
    // do when KV cannot be reached.
    loadState: async () => (kvDown ? null : state),
    saveState: async (value) => { if (!kvDown) state = value; },
    incrementCount: async () => {},
    now: clock,
    sleep,
    heldSession: () => ({ value: process.env.PARAFORM_COOKIE, slot: "env" }),
    nextSession: async () => null,
    log: () => {},
  });
  return {
    pace,
    sent,
    clock,
    sleep,
    advance: (ms) => { clockMs += ms; },
    state: () => state,
    // What another invocation's refusal leaves behind in the shared state.
    setBackoff: (untilMs) => { state = { ...(state || {}), backoffUntil: untilMs }; },
    restore: () => { global.fetch = originalFetch; },
  };
}

function calls(h, {
  deadlineAt = START + LIVESET_REFRESH_BUDGET_MS,
  catalogDeadlineAt = START + LIVESET_CATALOG_BUDGET_MS,
  stats = {},
  sleep = h.sleep,
} = {}) {
  return refreshPacedCalls({
    pace: h.pace,
    deadlineAt,
    catalogDeadlineAt,
    stats,
    now: h.clock,
    sleep,
    log: () => {},
  });
}

test("a backoff another invocation wrote between walks is waited out, not a failed refresh", async () => {
  const h = harness();
  try {
    const stats = {};
    const { sleepBetweenSequences } = calls(h, { stats });
    h.setBackoff(START + 60_000);
    await sleepBetweenSequences();
    assert.ok(h.clock() >= START + 60_000, "it waited until the backoff ended");
    assert.equal(stats.backoffWaits, 1);
    assert.equal(stats.backoffWaitMs, 60_000);
    assert.equal(h.sent.length, 0, "the pause between walks sends nothing");
  } finally {
    h.restore();
  }
});

test("a backoff that outlasts the deadline still fails loudly as PARAFORM_PACED_BACKOFF", async () => {
  const h = harness();
  try {
    const { sleepBetweenSequences } = calls(h, { deadlineAt: START + 30_000 });
    h.setBackoff(START + 60_000);
    await assert.rejects(sleepBetweenSequences(), { code: "PARAFORM_PACED_BACKOFF" });
    assert.equal(h.clock(), START, "no time is spent waiting for a backoff it cannot outlast");
  } finally {
    h.restore();
  }
});

test("a throttled catalog read is tried once more after the pacer's backoff", async () => {
  const h = harness({
    answer: (proc, n) => (n === 1 ? new Response(null, { status: 429 }) : ok([{ id: "seq_1" }])),
  });
  try {
    const stats = {};
    const { listSequences } = calls(h, { stats });
    const catalog = await listSequences();
    assert.deepEqual(catalog, [{ id: "seq_1" }]);
    assert.deepEqual(h.sent.map((call) => call.proc), [CATALOG, CATALOG]);
    assert.ok(
      h.sent[1].at - h.sent[0].at >= PACE_DEFAULT_BACKOFF_MS,
      "the second attempt waits max(Retry-After, 60 s), it is not retried hard",
    );
    assert.equal(stats.catalogRetries, 1);
    assert.equal(stats.backoffWaits, 1);
  } finally {
    h.restore();
  }
});

test("a catalog read refused twice fails after two requests, never a third", async () => {
  const h = harness({ answer: () => new Response(null, { status: 429 }) });
  try {
    const { listSequences } = calls(h);
    await assert.rejects(listSequences(), { code: "PARAFORM_REFUSED", status: 429 });
    assert.equal(h.sent.length, 2);
  } finally {
    h.restore();
  }
});

test("a catalog read honours a Retry-After longer than 60 s", async () => {
  const h = harness({
    answer: (proc, n) => (n === 1
      ? new Response(null, { status: 429, headers: { "retry-after": "90" } })
      : ok([])),
  });
  try {
    const { listSequences } = calls(h);
    await listSequences();
    assert.ok(h.sent[1].at - h.sent[0].at >= 90_000);
  } finally {
    h.restore();
  }
});

test("a request the pacer cannot fix is not retried: a dead session, a bad request", async () => {
  for (const status of [400, 404]) {
    const h = harness({ answer: () => new Response(null, { status }) });
    try {
      const { listSequences } = calls(h);
      await assert.rejects(listSequences(), { code: "PARAFORM_REFUSED", status });
      assert.equal(h.sent.length, 1, `HTTP ${status}`);
    } finally {
      h.restore();
    }
  }
  const dead = Object.assign(new Error("PARAFORM_SESSION_DEAD"), { code: "PARAFORM_SESSION_DEAD", status: 401 });
  let attempts = 0;
  await assert.rejects(
    pacedWithinDeadline(async () => { attempts++; throw dead; }, {
      deadlineAt: Date.now() + 600_000,
      retryTransientRefusals: 3,
      log: () => {},
    }),
    { code: "PARAFORM_SESSION_DEAD" },
  );
  assert.equal(attempts, 1);
  assert.equal(isTransientRefusal(dead), false);
});

test("the refresh walk publishes through a backoff written mid-walk by a worker tick", async () => {
  const h = harness({ answer: () => ok([]) });
  try {
    const catalog = ["seq_a", "seq_b", "seq_c"].map((id) => ({
      id,
      name: "No Show - Agent Call",
      enabled: true,
    }));
    const { sleepBetweenSequences } = calls(h);
    const walked = [];
    const liveSet = await buildLiveSet({
      now: START,
      listSequences: async () => catalog,
      membershipLoader: async (id) => {
        walked.push(id);
        // A worker tick is refused while the walk is on its first sequence.
        if (id === "seq_a") h.setBackoff(h.clock() + 60_000);
        return {
          complete: true,
          leads: [{
            ccu_id: `ccu_${id}`,
            cu_id: `cu_${id}`,
            to_use_email: `${id}@example.com`,
            created_at: "2026-09-01T00:00:00.000Z",
          }],
        };
      },
      sleepBetweenSequences,
      deadlineAt: START + LIVESET_REFRESH_BUDGET_MS,
      clock: h.clock,
    });
    assert.deepEqual(walked, ["seq_a", "seq_b", "seq_c"]);
    assert.equal(liveSet.indexedEmails, 3);
    assert.equal(liveSet.incomplete, false);
    assert.ok(liveSetUsable(liveSet, START + 1));
  } finally {
    h.restore();
  }
});

test("waiting never pushes a walk start past the refresh deadline", async () => {
  const h = harness();
  try {
    const deadlineAt = START + 100_000;
    const { sleepBetweenSequences } = calls(h, { deadlineAt });
    h.advance(50_000);
    h.setBackoff(START + 99_000);
    await sleepBetweenSequences();
    assert.ok(h.clock() < deadlineAt);
    assert.ok(h.clock() >= START + 99_000);
    // The pacer's own spacing after the backoff is still respected.
    h.setBackoff(null);
    const before = h.clock();
    await sleepBetweenSequences();
    assert.ok(h.clock() - before <= PACE_MIN_INTERVAL_MS);
  } finally {
    h.restore();
  }
});

test("the catalog read's retry waits its own 60 s even when the pacer's KV state is unreachable", async () => {
  // Review finding: the wait lived only in the pacer's KV state, so during a
  // KV blip the retry went out at once.
  const h = harness({
    kvDown: true,
    answer: (proc, n) => (n === 1 ? new Response(null, { status: 429 }) : ok([])),
  });
  try {
    const { listSequences } = calls(h);
    await listSequences();
    assert.equal(h.sent.length, 2);
    assert.ok(h.sent[1].at - h.sent[0].at >= PACE_DEFAULT_BACKOFF_MS);
  } finally {
    h.restore();
  }
});

test("the catalog read is not retried past its own deadline, and the refusal is what fails the run", async () => {
  const h = harness({ answer: () => new Response(null, { status: 429 }) });
  try {
    h.advance(LIVESET_CATALOG_BUDGET_MS - 30_000);
    const { listSequences } = calls(h);
    await assert.rejects(listSequences(), { code: "PARAFORM_REFUSED", status: 429 });
    assert.equal(h.sent.length, 1, "a retry 60 s later would start past the catalog deadline");
  } finally {
    h.restore();
  }
});

test("when the retry meets a backoff that outlasts the deadline, the original refusal is reported", async () => {
  const h = harness({ answer: () => new Response(null, { status: 429 }) });
  try {
    const { listSequences } = calls(h, {
      // While the catalog read waits, another invocation is refused and
      // backs everyone off past the deadline.
      sleep: async (ms) => { h.advance(ms); h.setBackoff(START + LIVESET_REFRESH_BUDGET_MS + 60_000); },
    });
    await assert.rejects(listSequences(), { code: "PARAFORM_REFUSED", status: 429 });
    assert.equal(h.sent.length, 1);
  } finally {
    h.restore();
  }
});

test("a dead session with nowhere to move fails the walk at once instead of a backoff between every sequence", async () => {
  const dead = () => Object.assign(new Error("PARAFORM_SESSION_DEAD"), { code: "PARAFORM_SESSION_DEAD", status: 401 });
  const { sleepBetweenSequences } = refreshPacedCalls({
    pace: async () => { throw dead(); },
    deadlineAt: Date.now() + 600_000,
    log: () => {},
  });
  await assert.rejects(sleepBetweenSequences(), { code: "PARAFORM_SESSION_DEAD" });
});

test("the catalog read's deadline leaves room for a confirmed 401 inside the refresh's maxDuration", () => {
  // ESTIMATED worst case for a catalog read started at its deadline: 6.5 s of
  // spacing, a 20 s request, about 70 s of the pacer's paced probes, then one
  // 26.5 s attempt on the next session.
  const worstCatalogMs = PACE_MIN_INTERVAL_MS + 20_000 + 70_000 + PACE_MIN_INTERVAL_MS + 20_000;
  assert.ok(LIVESET_CATALOG_BUDGET_MS < LIVESET_REFRESH_BUDGET_MS);
  assert.ok(LIVESET_CATALOG_BUDGET_MS + worstCatalogMs < refreshConfig.maxDuration * 1000);
});
