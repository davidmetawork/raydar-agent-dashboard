// Health engine unit tests. No network, no KV — pure logic on the parts that
// decide whether David gets woken up.
import test from "node:test";
import assert from "node:assert/strict";

import { worst } from "../api/health/_lib/engine.mjs";
import {
  bookingDoor, beatLane, desktopRunner, ghWorkflow, vendorApi, seqHealth,
} from "../api/health/_lib/evaluators.mjs";
import { CATALOG, byId, beatLanes } from "../api/health/_lib/catalog.mjs";

test("worst() ranks DOWN above everything and OK below everything", () => {
  assert.equal(worst(["OK", "OK"]), "OK");
  assert.equal(worst(["OK", "UNKNOWN"]), "UNKNOWN");
  assert.equal(worst(["UNKNOWN", "DEGRADED"]), "DEGRADED");
  assert.equal(worst(["DEGRADED", "DOWN", "OK"]), "DOWN");
  assert.equal(worst([]), "OK");
});

test("booking door: the exact 2026-08-06/07 outage shape reads DOWN", () => {
  // What the endpoint served during the outage: ok:true, everything looks
  // fine, and yet every candidate got a 503. agentAdmission is the tell.
  const outage = bookingDoor({
    status: 200,
    body: { ok: true, ready: false, agentAdmission: false, checks: {} },
  });
  assert.equal(outage.state, "DOWN");
  assert.match(outage.reason, /admission closed/);

  const healthy = bookingDoor({
    status: 200,
    body: { ok: true, ready: false, agentAdmission: true, checks: { agentCoverage: false } },
  });
  assert.equal(healthy.state, "DEGRADED", "door open but coverage red = degraded, not down");

  const clean = bookingDoor({
    status: 200,
    body: { ok: true, ready: true, agentAdmission: true, checks: {} },
  });
  assert.equal(clean.state, "OK");
});

test("booking door: a pre-fix release cannot be reported as healthy", () => {
  // Without agentAdmission we genuinely cannot see the door. Saying OK here
  // is what made the outage invisible for ten hours.
  const old = bookingDoor({ status: 200, body: { ok: true, ready: true, checks: {} } });
  assert.equal(old.state, "UNKNOWN");
});

test("beat lane: silence past the window is DOWN, a self-reported fail is immediate", () => {
  const probe = { lane: "hm-chase", maxSilenceMin: 75 };
  const fresh = beatLane({ probe, beat: { at: new Date().toISOString(), status: "ok" } });
  assert.equal(fresh.state, "OK");

  const old = beatLane({
    probe,
    beat: { at: new Date(Date.now() - 120 * 60000).toISOString(), status: "ok" },
  });
  assert.equal(old.state, "DOWN");

  const failed = beatLane({
    probe,
    beat: { at: new Date().toISOString(), status: "fail", note: "gmail 429" },
  });
  assert.equal(failed.state, "DOWN", "a lane that knows it failed must not wait to be missed");

  assert.equal(beatLane({ probe, beat: null }).state, "UNKNOWN");
});

test("desktop collapse: a closed laptop is one event, not sixteen", () => {
  const many = Array.from({ length: 10 }, (_, i) => ({ id: `l${i}`, state: "DOWN" }));
  assert.equal(desktopRunner({ laneStates: many }).state, "DOWN");

  const one = [
    { id: "a", state: "DOWN" },
    ...Array.from({ length: 9 }, (_, i) => ({ id: `b${i}`, state: "OK" })),
  ];
  const partial = desktopRunner({ laneStates: one });
  assert.equal(partial.state, "DEGRADED", "one dead lane is a lane problem, not a runner problem");

  assert.equal(
    desktopRunner({ laneStates: [{ id: "a", state: "UNKNOWN", reason: "no beats yet" }] }).state,
    "UNKNOWN",
  );
});

test("GitHub workflow: two consecutive failures are DOWN, one is DEGRADED", () => {
  const mk = (concl, minsAgo) => ({
    path: ".github/workflows/paraai-curate.yml",
    event: "schedule",
    status: "completed",
    conclusion: concl,
    created_at: new Date(Date.now() - minsAgo * 60000).toISOString(),
  });
  const probe = { workflowFile: "paraai-curate.yml", cadenceMin: 60 };
  const feed = (runs) => ({ "gh-actions-api": { state: "OK", raw: { workflow_runs: runs } } });

  assert.equal(ghWorkflow({ probe, results: feed([mk("success", 10)]) }).state, "OK");
  assert.equal(ghWorkflow({ probe, results: feed([mk("failure", 10), mk("success", 70)]) }).state, "DEGRADED");
  assert.equal(ghWorkflow({ probe, results: feed([mk("failure", 10), mk("failure", 70)]) }).state, "DOWN");
  // Nothing has run in 3x cadence -> the schedule itself is dead.
  assert.equal(ghWorkflow({ probe, results: feed([mk("success", 400)]) }).state, "DOWN");
});

test("vendor API: revoked credentials are DOWN, throttling is only DEGRADED", () => {
  const probe = { authEnv: "RECALL_AI_API_KEY" };
  assert.equal(vendorApi({ status: 200, probe }).state, "OK");
  assert.equal(vendorApi({ status: 429, probe }).state, "DEGRADED");
  assert.equal(vendorApi({ status: 401, probe }).state, "DOWN");
  assert.equal(vendorApi({ status: 0, keyMissing: true, probe }).state, "UNKNOWN");
});

test("seq health: the live PARAFORM_THROTTLED shape is DEGRADED, not a false green", () => {
  const v = seqHealth({
    body: { ok: true, sequenceCount: 40, bookingStop: { stale: true, latestAttemptError: "PARAFORM_THROTTLED" } },
  });
  assert.equal(v.state, "DEGRADED");
  assert.match(v.reason, /PARAFORM_THROTTLED/);
});

test("catalog is internally consistent", () => {
  assert.equal(new Set(CATALOG.map((c) => c.id)).size, CATALOG.length, "ids unique");
  for (const c of CATALOG) {
    assert.ok(["candidate", "pipeline", "fly", "n8n", "actions", "desktop", "deps"].includes(c.group), `${c.id} group`);
    assert.ok([1, 2, 3].includes(c.tier), `${c.id} tier`);
    assert.ok(["pull", "beat", "derived"].includes(c.kind), `${c.id} kind`);
    if (c.kind === "pull") assert.ok(c.probe.url, `${c.id} needs a url`);
    if (c.kind === "beat") assert.ok(c.probe.lane && c.probe.maxSilenceMin, `${c.id} needs lane+window`);
  }
  // Tier 1 = wakes a human. Keep that list short and candidate-facing.
  const tier1 = CATALOG.filter((c) => c.tier === 1).map((c) => c.id);
  assert.deepEqual(tier1.sort(), [
    "booking-door", "calls-api", "paraform-session", "screener-feed", "screener-uplink",
  ]);
  assert.ok(byId.get("booking-door"));
  assert.ok(beatLanes.has("hm-chase"));
});
