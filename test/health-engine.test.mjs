// Health engine unit tests. No network, no KV — pure logic on the parts that
// decide whether David gets woken up.
import test from "node:test";
import assert from "node:assert/strict";

import { worst } from "../api/health/_lib/engine.mjs";
import {
  bookingDoor, beatLane, desktopRunner, ghWorkflow, vendorApi, seqHealth,
  okTrue, paraaiLane,
} from "../api/health/_lib/evaluators.mjs";
import { CATALOG, byId, beatLanes } from "../api/health/_lib/catalog.mjs";
import { uptimeFromTransitions } from "../api/health/tile.mjs";

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

// ── Regressions found by Drill 1 on 2026-08-07 ────────────────────────────
// Vercel answers an unknown /api/* path with a JSON error envelope when the
// caller sends `accept: application/json`. That envelope parses cleanly, says
// nothing bad, and used to score OK — a deleted endpoint reading as a healthy
// one. These tests exist so that can never come back.

test("a Vercel 404 envelope is never a healthy seq-health payload", () => {
  const envelope = { error: { code: "404", message: "The page could not be found" } };
  assert.equal(seqHealth({ body: envelope }).state, "UNKNOWN");
  assert.match(seqHealth({ body: envelope }).reason, /not a seq-health payload/);
  // The real payload still evaluates normally.
  assert.equal(seqHealth({ body: { paraform: "live", bookingStop: { stale: false } } }).state, "OK");
});

test("a 404 envelope is never a healthy paraai payload", () => {
  const envelope = { error: { code: "404" } };
  assert.equal(paraaiLane({ body: envelope }).state, "UNKNOWN");
  assert.equal(paraaiLane({ body: { ok: true, automation: { ready: true, queue: {} } } }).state, "OK");
});

test("a health endpoint that never says ok is UNKNOWN, not OK", () => {
  assert.equal(okTrue({ body: { service: "x" }, status: 200 }).state, "UNKNOWN");
  assert.equal(okTrue({ body: { ok: true }, status: 200 }).state, "OK");
  assert.equal(okTrue({ body: { ok: false, error: "boom" }, status: 200 }).state, "DOWN");
});

// ── Uptime is reconstructed from transitions (31d), not the 24h sample ring ──

test("uptime counts only DOWN time, and clips the window to known history", () => {
  const now = Date.parse("2026-08-07T12:00:00Z");
  const at = (h) => new Date(now - h * 3600_000).toISOString();
  // Newest first: recovered 2h ago, went DOWN 6h ago. So 4h DOWN in a 24h day.
  const transitions = [
    { t: at(2), from: "DOWN", to: "OK" },
    { t: at(6), from: "OK", to: "DOWN" },
  ];
  const tile = { state: "OK", since: at(2) };
  const day = uptimeFromTransitions(transitions, tile, 1440, now);
  // History starts 6h ago, so the window is clipped to 6h; 4h of it was DOWN.
  assert.equal(day.clipped, true);
  assert.equal(day.observedMin, 360);
  assert.equal(day.pct, 33.33);

  // DEGRADED and UNKNOWN are "working" — the number answers "was it up".
  const degraded = uptimeFromTransitions(
    [{ t: at(3), from: "OK", to: "DEGRADED" }],
    { state: "DEGRADED", since: at(3) }, 1440, now,
  );
  assert.equal(degraded.pct, 100);

  // A tile with no transitions at all reports from `since`.
  const fresh = uptimeFromTransitions([], { state: "OK", since: at(10) }, 1440, now);
  assert.equal(fresh.pct, 100);
  assert.equal(fresh.observedMin, 600);

  // Nothing observed yet => null, never a confident 100%.
  assert.equal(uptimeFromTransitions([], { state: "OK", since: null }, 1440, now), null);
});

test("the external pager fires on tier-1 only, not on a single desktop hiccup", () => {
  // Found live on day one: booking-resume-sync had one transient failing run,
  // which made `overall` DOWN, which 503'd the public rollup, which would have
  // emailed David via the hourly backstop. One flaky tier-2 lane must not train
  // him to ignore the dead-man.
  const tier1 = CATALOG.filter((c) => c.tier === 1 && !c.paused);
  const tier2 = CATALOG.filter((c) => c.tier !== 1 && !c.paused);
  assert.ok(tier1.length && tier2.length);

  const criticalDown = (tiles, acks = {}) => CATALOG.filter((c) =>
    !c.paused && !acks[c.id] && c.tier === 1 && tiles[c.id]?.state === "DOWN").length;

  assert.equal(criticalDown({ [tier2[0].id]: { state: "DOWN" } }), 0, "tier-2 down does not page");
  assert.equal(criticalDown({ [tier1[0].id]: { state: "DOWN" } }), 1, "tier-1 down pages");
  assert.equal(
    criticalDown({ [tier1[0].id]: { state: "DOWN" } }, { [tier1[0].id]: { until: "x" } }),
    0,
    "an acknowledged tier-1 does not page",
  );
});
