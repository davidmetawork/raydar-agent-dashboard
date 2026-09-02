// Health engine unit tests. No network, no KV — pure logic on the parts that
// decide whether David gets woken up.
import test from "node:test";
import assert from "node:assert/strict";

import { worst } from "../api/health/_lib/engine.mjs";
import {
  bookingDoor, beatLane, desktopRunner, vendorApi, seqHealth,
  googleWorkspace, nativeReminders, neonDb, n8nWatchdog, okTrue, paraaiLane,
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

test("n8n watchdog reads the deployed alerted-map state without a false green", () => {
  const activeFailure = n8nWatchdog({
    watchdog: {
      checkedAt: new Date().toISOString(),
      alerted: { "workflow-123": 3 },
    },
  });
  assert.equal(activeFailure.state, "DEGRADED");
  assert.equal(activeFailure.metrics.streaks, 1);
  assert.match(activeFailure.reason, /workflow-123/u);

  const recovered = n8nWatchdog({
    watchdog: { checkedAt: new Date().toISOString(), alerted: {} },
  });
  assert.equal(recovered.state, "OK");
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

test("beat lane: a fresh warning is DEGRADED but a stale warning is still DOWN", () => {
  const probe = {
    lane: "gha-paraai-curate",
    degradedAfterMin: 150,
    maxSilenceMin: 360,
  };
  const warned = beatLane({
    probe,
    beat: { at: new Date().toISOString(), status: "warn", note: "1 candidate quarantined" },
  });
  assert.equal(warned.state, "DEGRADED");
  assert.equal(warned.reason, "lane reported warning: 1 candidate quarantined");
  assert.equal(warned.metrics.status, "warn");

  const stale = beatLane({
    probe,
    beat: {
      at: new Date(Date.now() - 361 * 60000).toISOString(),
      status: "warn",
      note: "1 candidate quarantined",
    },
  });
  assert.equal(stale.state, "DOWN");
  assert.match(stale.reason, /no beat for .*max 360m/u);
});

test("scheduled heartbeat jitter degrades before sustained silence is DOWN", () => {
  const probe = {
    lane: "gha-health-backstop",
    degradedAfterMin: 150,
    maxSilenceMin: 360,
  };
  const delayed = beatLane({
    probe,
    beat: { at: new Date(Date.now() - 158 * 60000).toISOString(), status: "ok" },
  });
  assert.equal(delayed.state, "DEGRADED");
  assert.match(delayed.reason, /expected within 150m; down after 360m/u);

  const silent = beatLane({
    probe,
    beat: { at: new Date(Date.now() - 361 * 60000).toISOString(), status: "ok" },
  });
  assert.equal(silent.state, "DOWN");

  const failed = beatLane({
    probe,
    beat: { at: new Date().toISOString(), status: "fail", note: "probe failed" },
  });
  assert.equal(failed.state, "DOWN", "an observed failure is never softened by the jitter window");
});

test("Scheduler cron control failure is immediately DOWN on a paging lane", () => {
  const check = byId.get("gha-scheduler-cron-guard");
  assert.ok(check);
  assert.equal(check.tier, 1);
  const result = beatLane({
    probe: check.probe,
    beat: {
      at: new Date().toISOString(),
      status: "fail",
      note: "production Scheduler crons disabled",
    },
  });
  assert.equal(result.state, "DOWN");
  assert.match(result.reason, /production Scheduler crons disabled/u);
});

// The guard's cron is */5, but GitHub delivers scheduled events best-effort.
// Measured on 2026-08-12: every gap between scheduled runs exceeded 30 minutes
// (median 80, max 107) while every run succeeded. The lane is tier 1, so a
// window tighter than GitHub's real delivery does not just cry wolf — it takes
// the public rollup to 503 and blinds the external dead-man. Size the window
// from observed delivery, not from the cron string.
test("Scheduler cron control tolerates GitHub's real scheduled-run latency", () => {
  const check = byId.get("gha-scheduler-cron-guard");
  const beatAgedMin = (mins, status = "ok") => beatLane({
    probe: check.probe,
    beat: { at: new Date(Date.now() - mins * 60_000).toISOString(), status },
  });
  assert.equal(
    beatAgedMin(107).state,
    "OK",
    "the worst observed GitHub delivery gap must not be an alarm",
  );
  assert.ok(
    check.probe.maxSilenceMin >= 240,
    "a dead-man on a best-effort scheduler needs hours of silence, not minutes",
  );
  assert.equal(
    beatAgedMin(check.probe.maxSilenceMin + 1).state,
    "DOWN",
    "sustained silence must still be DOWN — this is a dead-man, not a mute",
  );
  assert.equal(
    beatAgedMin(1, "fail").state,
    "DOWN",
    "widening the window must never soften an observed failure",
  );
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

test("intentionally dark desktop lanes cannot trip the runner collapse", () => {
  const hmChase = byId.get("lane-hm-chase");
  const forward = byId.get("lane-resume-forward-v2");
  const cohort = byId.get("lane-cohort-booking-watch");
  assert.equal(forward.paused, true);
  assert.match(forward.note, /Resume Feed owns new-mail ingestion/u);
  assert.equal(cohort.paused, true);
  assert.match(cohort.note, /not currently scheduled/u);
  assert.equal(hmChase.paused, true);
  assert.match(hmChase.note, /restart requires explicit approval/u);
  const activeDesktop = CATALOG.filter((check) =>
    check.group === "desktop" && check.kind === "beat" && !check.paused);
  assert.ok(!activeDesktop.some((lane) => lane.id === forward.id));
  assert.ok(!activeDesktop.some((lane) => lane.id === cohort.id));
  assert.ok(!activeDesktop.some((lane) => lane.id === hmChase.id));
});

test("scheduler dependencies read the health half of the composite hold probe", () => {
  const results = {
    "booking-door": {
      raw: {
        holdStatus: 409,
        hold: { error: "slot_taken" },
        health: {
          checks: {
            database: true, gmail: true, calendars: true,
            meetAccess: true, humanStaffCalendars: true, nativeReminders: true,
          },
        },
      },
    },
  };
  assert.equal(googleWorkspace({ results }).state, "OK");
  assert.equal(neonDb({ results }).state, "OK");
  assert.equal(nativeReminders({ results }).state, "OK");

  results["booking-door"].raw.health.checks.database = false;
  assert.equal(neonDb({ results }).state, "DOWN");
  results["booking-door"].raw.health.checks.gmail = false;
  assert.equal(googleWorkspace({ results }).state, "DEGRADED");
});

test("GitHub Action lanes are heartbeat-covered, needing no API token", () => {
  // Polling the Actions API needed a PAT and only proved GitHub's API answered.
  // A beat at the end of each run needs no credential and proves the workflow
  // actually executed — the stronger signal, and one fewer secret to hold.
  const actions = CATALOG.filter((c) => c.group === "actions");
  assert.ok(actions.length >= 6);
  for (const c of actions) {
    assert.equal(c.kind, "beat", `${c.id} must be a heartbeat lane`);
    assert.ok(c.probe.lane && c.probe.maxSilenceMin, `${c.id} needs lane+window`);
    assert.ok(
      c.probe.degradedAfterMin < c.probe.maxSilenceMin,
      `${c.id} must degrade before sustained silence is down`,
    );
  }
  assert.ok(
    !JSON.stringify(CATALOG).includes("GH_HEALTH_TOKEN"),
    "no GitHub token may be required",
  );
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
    assert.ok(["candidate", "pipeline", "email", "fly", "n8n", "actions", "desktop", "deps"].includes(c.group), `${c.id} group`);
    assert.ok([1, 2, 3].includes(c.tier), `${c.id} tier`);
    assert.ok(["pull", "beat", "derived"].includes(c.kind), `${c.id} kind`);
    if (c.kind === "pull") assert.ok(c.probe.url, `${c.id} needs a url`);
    if (c.kind === "beat") assert.ok(c.probe.lane && c.probe.maxSilenceMin, `${c.id} needs lane+window`);
  }
  // Tier 1 = wakes a human. Keep that list short and candidate-facing.
  // pager-drill is a temporary synthetic check; it is removed after the drill.
  // email-inbox-david joined 2026-08-13: a corroborated david@ mailbox lockout
  // starves candidate-facing email (handoff, reminders, invites) and only
  // David can clear the third-party halves — but its DOWN needs two
  // independent 429 witnesses, so a single self-healing breaker never pages.
  const tier1 = CATALOG.filter((c) => c.tier === 1 && !c.id.startsWith("pager-drill")).map((c) => c.id);
  assert.deepEqual(tier1.sort(), [
    "booking-door", "calls-api", "email-inbox-david", "gha-scheduler-cron-guard",
    "lifecycle-connector-chase",
    "lifecycle-human-handoff", "paraform-session", "screener-feed", "screener-uplink",
  ]);
  assert.ok(byId.get("booking-door"));
  assert.ok(byId.get("gha-scheduler-cron-guard"));
  assert.ok(beatLanes.has("gha-scheduler-cron-guard"));
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

test("booking door judges the hold path, and calls out a lying health mirror", async () => {
  // 2026-08-07 18:40: the domain served a deployment with a signature-invalid
  // receipt. Health said agentAdmission:true (it skips attestation); every real
  // hold 503'd. The old tile lied green through a live outage. Ground truth is
  // what /api/hold answers.
  const { bookingDoorHold } = await import("../api/health/_lib/evaluators.mjs");
  const open = bookingDoorHold({ body: {
    hold: { error: "slot_taken" }, holdStatus: 409,
    health: { ok: true, agentAdmission: true, checks: {} },
  } });
  assert.equal(open.state, "OK");

  const lying = bookingDoorHold({ body: {
    hold: { error: "booking_temporarily_unavailable" }, holdStatus: 503,
    health: { ok: true, agentAdmission: true, checks: {} },
  } });
  assert.equal(lying.state, "DOWN");
  assert.match(lying.reason, /attestation-level closure/);

  const degraded = bookingDoorHold({ body: {
    hold: { error: "slot_taken" }, holdStatus: 409,
    health: { ok: true, agentAdmission: true, checks: { sequenceStop: false } },
  } });
  assert.equal(degraded.state, "DEGRADED");

  // 2026-08-12: Neon quota exhaustion made /api/hold 500 (unmapped SQLSTATE
  // 53000) for 7.5h; the old evaluator filed it UNKNOWN, which never pages.
  const serverError = bookingDoorHold({ body: {
    hold: { error: "internal_error" }, holdStatus: 500,
    health: { ok: false, agentAdmission: null, checks: {} },
  } });
  assert.equal(serverError.state, "DOWN");
  assert.match(serverError.reason, /HTTP 500/);
});
