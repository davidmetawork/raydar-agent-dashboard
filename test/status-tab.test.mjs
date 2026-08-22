// The Status tab's three contracts:
//
//  1. THE CATALOG IS COMPLETE AND HONEST. 47 rows, every lane and beat in the
//     other inventories claimed by exactly one row — so a lane added to
//     lanes.mjs or the health catalog without a Status owner fails the suite
//     (drift is loud at test time, not silent on David's page). Rows with no
//     health signal must say so; nothing renders false green.
//  2. THE AGGREGATOR NEVER LIES OR THROWS. Worst-of status, paused override,
//     no-signal never healthy, the lane's own feed outranking GitHub's FAILED
//     conclusion (the 2026-08-21 lesson), 404 feeds tolerated as "first
//     publish pending", and zero external fetches on a warm cache.
//  3. THE BEAT RING CANNOT HURT THE BEAT. Losing a history entry is fine;
//     rejecting a heartbeat fakes a dead lane.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { CATALOG, byId as healthById } from "../api/health/_lib/catalog.mjs";
import { LANES, READERS } from "../api/emails/_lib/lanes.mjs";
import { appendBeatLog, BEATLOG_KEEP } from "../api/health/beat.mjs";
import {
  SYSTEMS, GROUPS, STATES, GMAIL_CLASSES, PARAFORM_CLASSES,
} from "../api/status/_lib/systems.mjs";
import {
  buildState, systemStatus, mergeActivity, deriveTodos, backlogFor, feedStampFor,
} from "../api/status/state.mjs";

// ── 1. catalog invariants ───────────────────────────────────────────────────

test("47 systems, unique ids, in the four fixed groups", () => {
  assert.equal(SYSTEMS.length, 47);
  assert.equal(new Set(SYSTEMS.map((s) => s.id)).size, 47, "duplicate system id");
  const counts = {};
  for (const s of SYSTEMS) counts[s.group] = (counts[s.group] || 0) + 1;
  assert.deepEqual(counts, {
    "candidate-emails": 17,
    "paraform-writes": 10,
    "background-readers": 8,
    "infrastructure": 12,
  });
  assert.deepEqual(GROUPS.map((g) => g.id),
    ["candidate-emails", "paraform-writes", "background-readers", "infrastructure"]);
});

test("every row is complete: summary sentence, valid enums, a cadence", () => {
  for (const s of SYSTEMS) {
    assert.ok(typeof s.summary === "string" && s.summary.trim().endsWith("."),
      `${s.id}: summary must be a sentence ending in a period`);
    assert.ok(GROUPS.some((g) => g.id === s.group), `${s.id}: bad group "${s.group}"`);
    assert.ok(STATES.includes(s.state), `${s.id}: bad state "${s.state}"`);
    assert.ok(typeof s.cadence === "string" && s.cadence.trim(), `${s.id}: missing cadence`);
    assert.ok(GMAIL_CLASSES.includes(s.gmail?.class), `${s.id}: bad gmail class`);
    assert.ok(PARAFORM_CLASSES.includes(s.paraform?.class), `${s.id}: bad paraform class`);
  }
});

test("healthIds all resolve, and a row with none says why (gap) — no false green", () => {
  for (const s of SYSTEMS) {
    for (const id of s.healthIds || []) {
      assert.ok(healthById.has(id), `${s.id}: healthId "${id}" is not in the health catalog`);
    }
    if (!(s.healthIds || []).length) {
      assert.ok(typeof s.gap === "string" && s.gap.trim(),
        `${s.id}: no healthIds and no gap — it would render false green`);
    }
  }
});

// A row claims an alias by being it (id) or owning it (dupes). Exactly one
// owner each — zero means the board lost a system, two means double counting.
const claimants = (aliasId) =>
  SYSTEMS.filter((s) => s.id === aliasId || (s.dupes || []).includes(aliasId));

test("COMPLETENESS: every lanes.mjs lane/reader with a healthId has exactly one owner", () => {
  for (const entry of [...LANES, ...READERS]) {
    if (!entry.healthId) continue;
    const owners = claimants(entry.id);
    assert.equal(owners.length, 1,
      `lanes.mjs "${entry.id}" is claimed by ${owners.length} system rows (${owners.map((o) => o.id).join(", ") || "none"})`);
  }
});

test("COMPLETENESS: every health-catalog beat row has exactly one owner", () => {
  for (const check of CATALOG.filter((c) => c.kind === "beat")) {
    const owners = SYSTEMS.filter((s) =>
      (s.healthIds || []).includes(check.id) || (s.dupes || []).includes(check.id));
    assert.equal(owners.length, 1,
      `health beat row "${check.id}" is claimed by ${owners.length} system rows (${owners.map((o) => o.id).join(", ") || "none"})`);
  }
});

test("the standing false-FAILED incident is fixed: match-watch beat rows exist", () => {
  for (const lane of ["gha-match-watch", "gha-match-watch-deadman"]) {
    const row = healthById.get(lane);
    assert.ok(row, `catalog row ${lane} missing`);
    assert.equal(row.kind, "beat");
    assert.equal(row.probe.lane, lane);
    // Daily lanes on GitHub's best-effort scheduler: trademark-watch windows.
    assert.equal(row.probe.degradedAfterMin, 3000);
    assert.equal(row.probe.maxSilenceMin, 4320);
  }
});

// ── 2. aggregator ───────────────────────────────────────────────────────────

test("status mapping: worst-of tiles, paused override, no-signal never healthy", () => {
  const row = { id: "x", state: "sending", healthIds: ["a", "b"] };
  assert.equal(systemStatus(row, { a: { state: "OK" }, b: { state: "DOWN", reason: "dead" } }).status, "down");
  assert.equal(systemStatus(row, { a: { state: "OK" }, b: { state: "DEGRADED", reason: "slow" } }).status, "degraded");
  assert.equal(systemStatus(row, { a: { state: "OK" }, b: { state: "UNKNOWN" } }).status, "degraded");
  assert.equal(systemStatus(row, { a: { state: "OK" }, b: { state: "OK" } }).status, "healthy");
  // paused catalog state wins over green tiles
  assert.equal(systemStatus({ ...row, state: "paused" }, { a: { state: "OK" }, b: { state: "OK" } }).status, "paused");
  // paused tiles are ignored while a live sibling exists; all-paused = paused
  assert.equal(systemStatus(row, { a: { state: "PAUSED" }, b: { state: "OK" } }).status, "healthy");
  assert.equal(systemStatus(row, { a: { state: "PAUSED" }, b: { state: "PAUSED" } }).status, "paused");
  // no signal is hollow, never green
  assert.equal(systemStatus({ id: "y", state: "sending", healthIds: [], gap: "why" }, {}).status, "no-signal");
  assert.equal(systemStatus(row, {}).status, "no-signal");
});

test("beat stamps map ok/warn/fail to success/partial/fail, capped at 10", () => {
  const beats = [
    { at: "2026-08-22T01:00:00Z", status: "ok", note: "ran" },
    { at: "2026-08-22T02:00:00Z", status: "warn", note: "quarantined one" },
    { at: "2026-08-22T03:00:00Z", status: "fail", note: "broke" },
    ...Array.from({ length: 12 }, (_, i) => ({ at: `2026-08-21T0${i % 10}:00:00Z`, status: "ok", note: "" })),
  ];
  const entries = mergeActivity({ row: {}, ghaRuns: null, feedStamp: null, beats, transitions: null });
  assert.equal(entries.length, 10);
  assert.deepEqual(entries.slice(0, 3).map((e) => e.stamp), ["fail", "partial", "success"]);
});

test("the lane's own feed outranks a FAILED GitHub conclusion, annotated", () => {
  const day = "2026-08-21";
  const feedStamp = {
    at: `${day}T11:33:00Z`, day, stamp: "success", note: "checked 3477, sent 32",
    overrideNote: "GitHub shows FAILED — heartbeat 404, tick itself succeeded",
  };
  const entries = mergeActivity({
    row: {},
    ghaRuns: [
      { at: `${day}T11:30:00Z`, conclusion: "failure", status: "completed" },
      { at: "2026-08-20T11:30:00Z", conclusion: "failure", status: "completed" },
    ],
    feedStamp, beats: null, transitions: null,
  });
  assert.equal(entries[0].stamp, "success");
  assert.match(entries[0].note, /GitHub shows FAILED/);
  // the earlier day has no feed cover — it stays honestly failed
  assert.equal(entries[1].stamp, "fail");
});

test("todo gating: items appear only while their signal is live", () => {
  const withCookie = deriveTodos({ tiles: { "paraform-session": { state: "DOWN", reason: "401s" } }, feeds: {} });
  assert.ok(withCookie.some((t) => t.id === "paraform-cookie"));
  const withoutCookie = deriveTodos({ tiles: { "paraform-session": { state: "OK" } }, feeds: {} });
  assert.ok(!withoutCookie.some((t) => t.id === "paraform-cookie"));
  // static arming decisions render while their rows are not-yet
  assert.ok(withoutCookie.some((t) => t.id === "arm-curated-interest"));
  assert.ok(withoutCookie.some((t) => t.id === "arm-boost-rotation"));
  // the apps-script ping renders while its health row is paused (it is today)
  assert.ok(withoutCookie.some((t) => t.id === "apps-script-ping"));
  // the Gmail breaker todo is informational and only while it is in the future
  const now = Date.now();
  const feeds = { "match-watch-status": { data: { gmail: { breakerUntil: new Date(now + 3600e3).toISOString(), breakerReason: "gmail_429" } } } };
  const withBreaker = deriveTodos({ tiles: {}, feeds, nowMs: now });
  const breaker = withBreaker.find((t) => t.id === "gmail-breaker");
  assert.ok(breaker && breaker.informational);
  const expired = deriveTodos({ tiles: {}, feeds: { "match-watch-status": { data: { gmail: { breakerUntil: new Date(now - 1e3).toISOString() } } } }, nowMs: now });
  assert.ok(!expired.some((t) => t.id === "gmail-breaker"));
});

test("backlogs: match-watch owed + skips, curate v1 stays silent, static eligible parses", () => {
  const feeds = {
    "match-watch-status": { data: { owed: { candidates: 52, roles: 122 }, skipHistogram: { not_in_talent_network: 1285 } } },
    "paraai-curated-fit-heartbeat": { data: { version: 1, lastRun: "2026-08-21T23:54:58Z" } },
  };
  const mw = backlogFor(SYSTEMS.find((s) => s.id === "match-watch"), feeds);
  assert.equal(mw.count, 52);
  assert.equal(mw.skipHistogram.not_in_talent_network, 1285);
  // v1 heartbeat has no counts — no invented backlog
  assert.equal(backlogFor(SYSTEMS.find((s) => s.id === "paraform-sequence-email"), feeds), null);
  // v2, when it arrives, is picked up without a code change
  feeds["paraai-curated-fit-heartbeat"].data = { version: 2, lastRun: "x", counts: { pending_tn: 28 } };
  assert.equal(backlogFor(SYSTEMS.find((s) => s.id === "paraform-sequence-email"), feeds).count, 28);
  // curated-interest: static estimate parsed from the lane inventory
  const ci = backlogFor(SYSTEMS.find((s) => s.id === "curated-interest-confirm"), {});
  assert.ok(ci && ci.count === 712, "expected the 712-eligible static estimate from lanes.mjs");
});

// full-pipeline fakes ---------------------------------------------------------

function fakeDeps({ board, ghaByUrl = {}, feedByUrl = {}, statCache = {}, calls } = {}) {
  const kvHealth = {
    hGet: async (key) => (key === "hlth:state" ? board : null),
    hGetMany: async (keys) => keys.map(() => null),
    lRangeMany: async (keys) => keys.map(() => []),
  };
  const kvStat = {
    sGet: async (key) => statCache[key] ?? null,
    sSet: async (key, value) => { statCache[key] = value; return true; },
  };
  const fetchImpl = async (url) => {
    if (calls) calls.push(String(url));
    for (const [needle, response] of Object.entries({ ...ghaByUrl, ...feedByUrl })) {
      if (String(url).includes(needle)) {
        if (response instanceof Error) throw response;
        return {
          ok: response.status ? response.status < 400 : true,
          status: response.status || 200,
          json: async () => response.body,
        };
      }
    }
    return { ok: false, status: 404, json: async () => null };
  };
  return { kvHealth, kvStat, fetchImpl, statCache };
}

test("buildState: feed present → annotated activity, backlog, measured Paraform, breaker todo", async () => {
  const now = Date.parse("2026-08-21T18:00:00Z");
  const today = "2026-08-21";
  const deps = fakeDeps({
    board: {
      checkedAt: new Date(now - 60e3).toISOString(),
      tiles: {
        "gha-match-watch": { state: "DOWN", reason: "no beat yet" },
        "paraform-session": { state: "DOWN", reason: "401s from Paraform" },
      },
    },
    ghaByUrl: {
      "workflows/match-watch.yml/runs": {
        body: { workflow_runs: [{ created_at: `${today}T11:30:00Z`, conclusion: "failure", status: "completed" }] },
      },
      "workflows/": { body: { workflow_runs: [] } }, // every other workflow
    },
    feedByUrl: {
      "match-watch-status.json": {
        body: {
          version: 1, generatedAt: `${today}T11:34:00Z`, lastRun: `${today}T11:33:41Z`,
          latestRun: { cohort: 3477, checked: 3477, sends: 32, curatedAdds: 341, alerts: 5, budgetUsed: 14383, budgetLimit: 20000 },
          owed: { candidates: 52, roles: 122 }, sentTotal: 32,
          gmail: { breakerUntil: new Date(now + 3600e3).toISOString(), breakerReason: "gmail_429" },
          skipHistogram: { not_in_talent_network: 1285, matches_not_generated_today: 715 },
        },
      },
      "paraai-curated-fit-heartbeat.json": { status: 404, body: null },
    },
  });
  const state = await buildState({ nowMs: now, env: { GH_ACTIONS_DISPATCH_TOKEN: "t" }, ...deps });
  assert.equal(state.ok, true);

  const flat = state.groups.flatMap((g) => g.systems);
  const mw = flat.find((s) => s.id === "match-watch");
  assert.equal(mw.status, "down"); // worst of its tiles — honest even while the feed is fine
  assert.equal(mw.activity[0].stamp, "partial"); // 5 alerts → partial, not FAILED
  assert.match(mw.activity[0].note, /GitHub shows FAILED/);
  assert.equal(mw.backlog.count, 52);
  assert.equal(mw.backlog.skipHistogram.not_in_talent_network, 1285);

  // curate feed 404 → tolerated as "first publish pending", nothing thrown
  const seq = flat.find((s) => s.id === "paraform-sequence-email");
  assert.equal(seq.feedPending, true);
  assert.equal(seq.backlog, null);

  // no-signal rows never render healthy
  for (const id of ["tn-coverage", "fyxer", "claude-scheduled-tasks"]) {
    assert.equal(flat.find((s) => s.id === id).status, "no-signal", id);
  }
  // paused rows render paused
  assert.equal(flat.find((s) => s.id === "hm-chase").status, "paused");

  // the David-only strip
  const ids = state.todos.map((t) => t.id);
  assert.ok(ids.includes("paraform-cookie"));
  assert.ok(ids.includes("gmail-breaker"));

  // Paraform impact: measured for match-watch, "not measured" for the rest
  assert.deepEqual(state.impact.paraform.measured, [{ id: "match-watch", callsLastRun: 14383, budget: 20000 }]);
  assert.match(state.impact.paraform.note, /not measured/);

  // per-source freshness with an oldest headline
  assert.equal(state.dataAsOf.matchWatch, `${today}T11:34:00Z`);
  assert.ok(state.oldest && state.oldest.at);
});

test("buildState: warm caches → ZERO external fetches; GitHub errors serve stale", async () => {
  const now = Date.now();
  const calls = [];
  const warm = fakeDeps({
    board: { checkedAt: new Date(now).toISOString(), tiles: {} },
    calls,
    statCache: {
      "stat:cache:gha": { at: new Date(now - 60e3).toISOString(), byWorkflow: {} },
      "stat:cache:feeds": {
        at: new Date(now - 60e3).toISOString(),
        "match-watch-status": { missing: true },
        "paraai-curated-fit-heartbeat": { missing: false, data: { version: 1, lastRun: new Date(now - 3600e3).toISOString() } },
      },
    },
  });
  const state = await buildState({ nowMs: now, env: { GH_ACTIONS_DISPATCH_TOKEN: "t" }, ...warm });
  assert.equal(state.ok, true);
  assert.equal(calls.length, 0, `warm cache still fetched: ${calls.join(", ")}`);

  // cold cache + GitHub down → the stale cache is served with its age, no throw
  const stale = fakeDeps({
    board: null,
    ghaByUrl: { "workflows/": new Error("github down") },
    feedByUrl: {
      "match-watch-status.json": { status: 404, body: null },
      "paraai-curated-fit-heartbeat.json": { status: 404, body: null },
    },
    statCache: { "stat:cache:gha": { at: new Date(now - 3600e3).toISOString(), byWorkflow: {} } },
  });
  const state2 = await buildState({ nowMs: now, env: { GH_ACTIONS_DISPATCH_TOKEN: "t" }, ...stale });
  assert.equal(state2.ok, true);
  assert.ok(state2.actionsRunsStale, "a GitHub failure must be reported, not hidden");
  assert.equal(state2.dataAsOf.actionsRuns, stale.statCache["stat:cache:gha"].at);
});

// ── 3. the beat ring ────────────────────────────────────────────────────────

test("appendBeatLog: LPUSH + keep 50, and a ring failure never escapes", async () => {
  const pushes = [];
  const ok = await appendBeatLog("tn-reenable",
    { at: "2026-08-22T00:00:00Z", status: "ok", note: "" },
    { push: async (key, value, keep) => pushes.push({ key, value, keep }) });
  assert.equal(ok, true);
  assert.deepEqual(pushes, [{
    key: "hlth:beatlog:tn-reenable",
    value: { at: "2026-08-22T00:00:00Z", status: "ok", note: "" },
    keep: BEATLOG_KEEP,
  }]);
  assert.equal(BEATLOG_KEEP, 50);

  const failed = await appendBeatLog("tn-reenable", { at: "x", status: "ok" },
    { push: async () => { throw new Error("kv down"); } });
  assert.equal(failed, false); // swallowed — losing the beat would fake a dead lane
});

test("the beat handler appends to the ring only AFTER the beat itself landed", async () => {
  const source = await readFile(new URL("../api/health/beat.mjs", import.meta.url), "utf8");
  const beatWrite = source.indexOf("await hSet(K.beat(lane), record)");
  const ringWrite = source.indexOf("await appendBeatLog(lane, record)");
  assert.ok(beatWrite > -1 && ringWrite > beatWrite,
    "the ring append must come after the beat write, so a ring bug cannot precede the beat");
});

// ── page wiring odds and ends ───────────────────────────────────────────────

test("status.html honours the embed contract and never invents jargon states", async () => {
  const html = await readFile(new URL("../status.html", import.meta.url), "utf8");
  assert.match(html, /params\.has\("embed"\)/);
  assert.match(html, /RaydarAuth\.session\(\)/);
  assert.match(html, /body\.embed header \.brand h1/);
  // David's words, spelled exactly
  for (const word of ["Sending", "Paused", "Not sending yet", "Read-only", "Manual", "Frozen"]) {
    assert.ok(html.includes(`"${word}"`), `missing plain state word ${word}`);
  }
  for (const banned of [/\barmed\b/i, /\bdark\b/i]) {
    assert.doesNotMatch(html, banned, "jargon leaked onto David's page");
  }
});

test("/status is routed and the status functions have a maxDuration", async () => {
  const vercel = JSON.parse(await readFile(new URL("../vercel.json", import.meta.url), "utf8"));
  assert.ok(vercel.rewrites.some((r) => r.source === "/status" && r.destination === "/status.html"));
  assert.equal(vercel.functions["api/status/*.mjs"].maxDuration, 30);
  // read-only surface: no new cron may ever ride this namespace
  assert.ok(!vercel.crons.some((c) => c.path.startsWith("/api/status")), "the Status plane needs no cron");
});
