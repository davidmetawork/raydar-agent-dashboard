// Everything the Status tab renders, in one call — David's page.
//
// Spec: docs/PRD-STATUS-TAB-2026-08-21.md §4.2 (main repo). Modeled on
// api/emails/state.mjs: a static catalog joined with observed state at request
// time. THE HARD CONSTRAINT (PRD §2): this plane makes ZERO Gmail calls and
// ZERO Paraform calls. It reads KV, api.github.com (cached 10 min), and two
// static JSON files on clients.raydar.xyz (cached 5 min) — nothing else. On a
// warm cache a page view costs 0 external fetches.
//
// Honesty rules baked in (PRD §7):
//   - a system with no health signal renders "no-signal", never green;
//   - catalog state "paused" overrides whatever the tiles say;
//   - a lane's own published feed OUTRANKS GitHub's run conclusion, with the
//     discrepancy annotated (a failed workflow whose tick worked must not
//     read as a failed tick — the 2026-08-21 false-FAILED lesson);
//   - numbers that do not exist are not shown as numbers.
import { cors, requireAuth } from "../seq/_lib/core.mjs";
import { hGet, hGetMany, lRangeMany, K as HK } from "../health/_lib/kv.mjs";
import { byId as healthById } from "../health/_lib/catalog.mjs";
import { lockoutFromSamples, numberOrNull, pacificDay, summarize as summarizeQuota } from "../health/gmail-quota.mjs";
import { LANES } from "../emails/_lib/lanes.mjs";
import { sGet, sSet, K as SK } from "./_lib/kv.mjs";
import {
  SYSTEMS, GROUPS, TOP_READERS, FOOTER_NOTES, INVENTORY_DATE, HISTORY_START,
} from "./_lib/systems.mjs";

export const config = { maxDuration: 30 };

const GITHUB_API = "https://api.github.com";
const REPO = "davidmetawork/raydar";
const GHA_FRESH_MS = 10 * 60 * 1000;
const GHA_PER_PAGE = 8;
const FEEDS_FRESH_MS = 5 * 60 * 1000;
const CACHE_TTL_S = 7 * 24 * 3600; // long TTL: stale beats absent when GitHub is down
const ACTIVITY_CAP = 10;

const FEED_URLS = {
  "match-watch-status": "https://clients.raydar.xyz/match-watch-status.json",
  "paraai-curated-fit-heartbeat": "https://clients.raydar.xyz/paraai-curated-fit-heartbeat.json",
};

// Per-feed annotation for a GitHub FAILED conclusion the lane's own feed
// contradicts. match-watch's cause is known (the heartbeat 404 before its
// catalog rows landed); for other feeds the wording stays generic.
const FEED_OVERRIDE_NOTES = {
  "match-watch-status": "GitHub shows FAILED — heartbeat 404, tick itself succeeded",
  "paraai-curated-fit-heartbeat": "GitHub shows FAILED — the lane's own heartbeat confirms the tick ran",
};

const utcDay = (value) => {
  const t = Date.parse(String(value || ""));
  return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : null;
};

// ── per-system status (PRD §4.2, David's mapping) ───────────────────────────
// OK → healthy · DEGRADED/UNKNOWN → degraded · DOWN → down. Catalog "paused"
// wins over tiles; no healthIds (or none observed) is "no-signal", never
// green. A system with several tiles takes the worst non-paused one.
const TILE_RANK = { DOWN: 0, DEGRADED: 1, UNKNOWN: 2, OK: 3 };

export function systemStatus(row, tiles) {
  if (row.state === "paused") {
    return { status: "paused", statusReason: row.stateNote || "paused" };
  }
  const ids = Array.isArray(row.healthIds) ? row.healthIds : [];
  if (!ids.length) {
    return { status: "no-signal", statusReason: row.gap || "no health signal yet" };
  }
  const observed = ids
    .map((id) => ({ id, tile: tiles?.[id] }))
    .filter((entry) => entry.tile && entry.tile.state);
  if (!observed.length) {
    return { status: "no-signal", statusReason: "no health signal yet" };
  }
  const active = observed.filter((entry) => entry.tile.state !== "PAUSED");
  if (!active.length) {
    return { status: "paused", statusReason: "all its health rows are paused" };
  }
  let worst = active[0];
  for (const entry of active) {
    if ((TILE_RANK[entry.tile.state] ?? 2) < (TILE_RANK[worst.tile.state] ?? 2)) worst = entry;
  }
  const state = worst.tile.state;
  const status = state === "OK" ? "healthy" : state === "DOWN" ? "down" : "degraded";
  return {
    status,
    statusReason: status === "healthy" ? "" : String(worst.tile.reason || state.toLowerCase()),
    worstTileId: worst.id,
  };
}

// ── activity (PRD §4.2) — newest first, ≤10, stamped success/partial/fail ──
const GHA_STAMP = (conclusion) => (
  conclusion === "success" ? "success" : conclusion == null ? null : "fail"
);
const BEAT_STAMP = { ok: "success", warn: "partial", fail: "fail" };

/** The lesson of 2026-08-21, as code: where the lane's own feed proves the
 *  tick ran on a given day, a FAILED GitHub conclusion for that day is
 *  restamped with the feed's verdict and the discrepancy is annotated. */
export function mergeActivity({ row, ghaRuns, feedStamp, beats, transitions }) {
  const entries = [];
  const runs = Array.isArray(ghaRuns) ? ghaRuns : [];
  let feedCovered = false;
  for (const run of runs) {
    const stamp = GHA_STAMP(run.conclusion);
    if (!stamp) continue; // still in progress — nothing to stamp yet
    const day = utcDay(run.at);
    if (feedStamp && day && day === feedStamp.day) {
      feedCovered = true;
      if (stamp === "fail") {
        entries.push({ at: run.at, stamp: feedStamp.stamp, note: feedStamp.overrideNote, source: "run" });
        continue;
      }
    }
    entries.push({ at: run.at, stamp, note: stamp === "fail" ? "run failed on GitHub" : "", source: "run" });
  }
  if (feedStamp && !feedCovered) {
    entries.push({ at: feedStamp.at, stamp: feedStamp.stamp, note: feedStamp.note || "", source: "feed" });
  }
  for (const beat of Array.isArray(beats) ? beats : []) {
    const stamp = BEAT_STAMP[String(beat?.status)] || null;
    if (!stamp || !beat?.at) continue;
    entries.push({ at: beat.at, stamp, note: String(beat.note || ""), source: "beat" });
  }
  for (const t of Array.isArray(transitions) ? transitions : []) {
    if (!t?.t) continue;
    entries.push({
      at: t.t,
      stamp: t.to === "OK" ? "success" : "fail",
      note: `${t.from} → ${t.to}${t.reason ? " — " + t.reason : ""}`,
      source: "transition",
    });
  }
  entries.sort((a, b) => (Date.parse(b.at) || 0) - (Date.parse(a.at) || 0));
  return entries.slice(0, ACTIVITY_CAP);
}

// ── feed projections ────────────────────────────────────────────────────────
export function feedStampFor(row, feeds) {
  const feed = feeds?.[row.feed];
  if (!feed || feed.missing || !feed.data) return null;
  const data = feed.data;
  if (row.feed === "match-watch-status") {
    const at = data.lastRun || data.generatedAt;
    if (!at) return null;
    const run = data.latestRun || {};
    const alerts = Number(run.alerts) || 0;
    const stamp = alerts > 0 ? "partial" : "success";
    const bits = [];
    if (Number.isFinite(Number(run.checked))) bits.push(`checked ${run.checked}`);
    if (Number.isFinite(Number(run.sends))) bits.push(`sent ${run.sends}`);
    if (Number.isFinite(Number(run.curatedAdds))) bits.push(`${run.curatedAdds} curated adds`);
    if (alerts > 0) bits.push(`${alerts} alert${alerts === 1 ? "" : "s"}`);
    return {
      at, day: utcDay(at), stamp,
      note: bits.join(", "),
      overrideNote: FEED_OVERRIDE_NOTES[row.feed],
    };
  }
  // paraai-curated-fit-heartbeat — v1 is {version,lastRun}; v2 adds counts.
  const at = data.lastRun || data.generatedAt;
  if (!at) return null;
  return {
    at, day: utcDay(at), stamp: "success",
    note: "the lane's own heartbeat confirms the tick ran",
    overrideNote: FEED_OVERRIDE_NOTES[row.feed],
  };
}

export function backlogFor(row, feeds) {
  if (row.id === "match-watch") {
    const data = feeds?.["match-watch-status"]?.data;
    const owed = data?.owed;
    if (!owed || !Number.isFinite(Number(owed.candidates))) return null;
    const candidates = Number(owed.candidates);
    const roles = Number(owed.roles);
    return {
      label: "owed",
      count: candidates,
      detail: `${candidates} candidate${candidates === 1 ? "" : "s"}${Number.isFinite(roles) ? ` / ${roles} role entries` : ""} owed an email`,
      ...(data.skipHistogram && typeof data.skipHistogram === "object"
        ? { skipHistogram: data.skipHistogram }
        : {}),
    };
  }
  if (row.id === "paraform-sequence-email") {
    const data = feeds?.["paraai-curated-fit-heartbeat"]?.data;
    if (!data || Number(data.version) < 2) return null; // v1 carries no counts
    // v2 shape is tolerated loosely — first numeric found wins, no guessing.
    const pending = [
      data?.counts?.pending_tn, data?.records?.pending_tn,
      data?.states?.pending_tn, data?.pending_tn, data?.tnParked,
    ].map(Number).find(Number.isFinite);
    if (!Number.isFinite(pending)) return null;
    return {
      label: "awaiting Talent Network",
      count: pending,
      detail: `${pending} candidates parked awaiting the Talent Network`,
    };
  }
  if (row.id === "curated-interest-confirm") {
    // Static estimate from the lane inventory, until the lane publishes a feed.
    const lane = LANES.find((l) => l.id === "curated-interest");
    const m = String(lane?.volume || "").match(/([\d,]+) of ([\d,]+) candidates eligible/);
    if (!m) return null;
    const count = Number(m[1].replace(/,/g, ""));
    return {
      label: "eligible",
      count,
      detail: `${m[1]} of ${m[2]} candidates eligible — static estimate from the lane inventory`,
    };
  }
  return null;
}

// ── the David-only to-do strip (PRD §4.5) ───────────────────────────────────
// An item renders only while its signal is live AND it is genuinely
// David-only. A red lane is NOT a to-do — that is what the dots are for.
export function deriveTodos({ tiles, feeds, nowMs = Date.now() }) {
  const todos = [];
  if (tiles?.["paraform-session"]?.state === "DOWN") {
    todos.push({
      id: "paraform-cookie",
      label: "Log into Paraform in Chrome so the session can be recaptured",
      detail: String(tiles["paraform-session"].reason || "the Paraform session is down"),
    });
  }
  const appsScriptRow = healthById.get("lane-apps-script-auto-reply");
  if (appsScriptRow?.paused || tiles?.["lane-apps-script-auto-reply"]?.state === "PAUSED") {
    todos.push({
      id: "apps-script-ping",
      label: "Add the health ping to the Apps Script auto-reply (runs in your Google account)",
      detail: "Until the ping exists, the auto-reply has no heartbeat and its health row stays paused.",
    });
  }
  for (const row of SYSTEMS) {
    if (row.davidAction?.when === "while-not-yet" && row.state === "not-yet") {
      todos.push({ id: row.davidAction.id, label: row.davidAction.label, detail: row.stateNote || "" });
    }
  }
  const breakerUntil = feeds?.["match-watch-status"]?.data?.gmail?.breakerUntil;
  const breakerMs = Date.parse(String(breakerUntil || ""));
  if (Number.isFinite(breakerMs) && breakerMs > nowMs) {
    const whenPt = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Los_Angeles", hour: "numeric", minute: "2-digit",
    }).format(new Date(breakerMs));
    todos.push({
      id: "gmail-breaker",
      label: `Gmail sends are rate-limited; nothing to click — match emails are held until ~${whenPt} PT`,
      detail: String(feeds["match-watch-status"].data.gmail.breakerReason || "gmail_429"),
      informational: true,
    });
  }
  return todos;
}

// ── external caches (GitHub runs + clients.raydar.xyz feeds) ───────────────
async function refreshGha({ workflows, fetchImpl, token }) {
  if (!token) throw new Error("dispatch_token_missing");
  const byWorkflow = {};
  await Promise.all(workflows.map(async (wf) => {
    const res = await fetchImpl(
      `${GITHUB_API}/repos/${REPO}/actions/workflows/${wf}/runs?per_page=${GHA_PER_PAGE}`,
      {
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${token}`,
          "user-agent": "raydar-status-tab",
          "x-github-api-version": "2022-11-28",
        },
        signal: AbortSignal.timeout(9000),
      },
    );
    if (!res.ok) throw new Error(`github ${res.status}`);
    const body = await res.json();
    byWorkflow[wf] = (body?.workflow_runs || []).map((run) => ({
      at: run.run_started_at || run.created_at || null,
      conclusion: run.conclusion ?? null,
      status: run.status || null,
    }));
  }));
  return byWorkflow;
}

async function fetchFeed(url, fetchImpl) {
  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(8000) });
    if (res.status === 404) return { missing: true }; // first publish pending
    if (!res.ok) return { missing: true, error: `http ${res.status}` };
    const data = await res.json().catch(() => null);
    if (!data || typeof data !== "object") return { missing: true, error: "parse" };
    return { missing: false, data };
  } catch (e) {
    return { missing: true, error: String(e?.message || e).slice(0, 80) };
  }
}

// ── the aggregator ─────────────────────────────────────────────────────────
export async function buildState({
  nowMs = Date.now(),
  fetchImpl = fetch,
  env = process.env,
  kvHealth = { hGet, hGetMany, lRangeMany },
  kvStat = { sGet, sSet },
  systems = SYSTEMS,
} = {}) {
  // 1. One read each: the health board, the quota records, the two caches.
  const days = [];
  for (let back = 0; back < 7; back += 1) {
    days.push(pacificDay(nowMs - back * 24 * 3600 * 1000));
  }
  const [board, quotaReads, ghaCache, feedsCache] = await Promise.all([
    kvHealth.hGet(HK.state),
    kvHealth.hGetMany([
      "hlth:samples:email-inbox-david",
      ...days.map((d) => `hlth:gmailquota:${d}`),
    ]),
    kvStat.sGet(SK.ghaCache),
    kvStat.sGet(SK.feedsCache),
  ]);
  const tiles = board?.tiles || {};
  const healthCheckedAt = board?.checkedAt || null;

  // 2. GitHub run conclusions — 10-min cache; on ANY error the stale cache is
  //    served with its age rather than blanking the activity column.
  const workflows = [...new Set(systems.map((s) => s.workflow).filter(Boolean))];
  let gha = ghaCache && typeof ghaCache === "object" ? ghaCache : null;
  let ghaError = null;
  if (!gha || !gha.at || nowMs - Date.parse(gha.at) > GHA_FRESH_MS) {
    try {
      const byWorkflow = await refreshGha({
        workflows, fetchImpl, token: env.GH_ACTIONS_DISPATCH_TOKEN || "",
      });
      gha = { at: new Date(nowMs).toISOString(), byWorkflow };
      await kvStat.sSet(SK.ghaCache, gha, CACHE_TTL_S);
    } catch (e) {
      ghaError = String(e?.message || e).slice(0, 120);
      // keep whatever cache we had — possibly null
    }
  }

  // 3. The two public feeds — 5-min cache, 404 tolerated as "first publish
  //    pending", stale served on error.
  let feeds = feedsCache && typeof feedsCache === "object" ? feedsCache : null;
  if (!feeds || !feeds.at || nowMs - Date.parse(feeds.at) > FEEDS_FRESH_MS) {
    const [matchWatch, curate] = await Promise.all([
      fetchFeed(FEED_URLS["match-watch-status"], fetchImpl),
      fetchFeed(FEED_URLS["paraai-curated-fit-heartbeat"], fetchImpl),
    ]);
    const fresh = {
      at: new Date(nowMs).toISOString(),
      "match-watch-status": matchWatch,
      "paraai-curated-fit-heartbeat": curate,
    };
    // A transient error must not wipe a previously-good feed projection.
    if (feeds) {
      for (const key of Object.keys(FEED_URLS)) {
        if (fresh[key].missing && fresh[key].error && feeds[key] && !feeds[key].missing) {
          fresh[key] = feeds[key];
        }
      }
    }
    feeds = fresh;
    await kvStat.sSet(SK.feedsCache, feeds, CACHE_TTL_S);
  }

  // 4. Beat activity rings — every beat lane any system claims, one round trip.
  const laneBySystem = new Map();
  const allLanes = [];
  for (const row of systems) {
    const lanes = (row.healthIds || [])
      .map((id) => healthById.get(id))
      .filter((c) => c?.kind === "beat")
      .map((c) => c.probe.lane);
    laneBySystem.set(row.id, lanes);
    allLanes.push(...lanes);
  }
  const uniqueLanes = [...new Set(allLanes)];
  const rings = await kvHealth.lRangeMany(uniqueLanes.map((lane) => HK.beatlog(lane)), 49);
  const ringByLane = new Map(uniqueLanes.map((lane, i) => [lane, rings[i] || []]));

  // 5. Status per system, then transitions for the red ones only.
  const statusBySystem = new Map(systems.map((row) => [row.id, systemStatus(row, tiles)]));
  const redRows = systems.filter((row) => {
    const s = statusBySystem.get(row.id);
    return s.status === "down" || s.status === "degraded";
  });
  const transKeys = redRows.map((row) => HK.trans(statusBySystem.get(row.id).worstTileId || (row.healthIds || [])[0]));
  const transLists = transKeys.length ? await kvHealth.hGetMany(transKeys) : [];
  const transBySystem = new Map(redRows.map((row, i) => [row.id, (transLists[i] || []).slice(0, 3)]));

  // 6. Assemble each system row.
  const decorate = (row) => {
    const s = statusBySystem.get(row.id);
    const lanes = laneBySystem.get(row.id) || [];
    const beats = lanes.flatMap((lane) => ringByLane.get(lane) || []);
    const feedStamp = row.feed ? feedStampFor(row, feeds) : null;
    const activity = mergeActivity({
      row,
      ghaRuns: row.workflow ? gha?.byWorkflow?.[row.workflow] : null,
      feedStamp,
      beats,
      transitions: transBySystem.get(row.id),
    });
    const backlog = backlogFor(row, feeds);
    const feedPending = Boolean(row.feed && feeds?.[row.feed]?.missing);
    return {
      ...row,
      status: s.status,
      statusReason: s.statusReason,
      activity,
      backlog,
      ...(feedPending ? { feedPending: true } : {}),
      // Beat-lane systems whose ring is still empty: honest label, no backfill.
      ...(lanes.length && !beats.length ? { historyStart: HISTORY_START } : {}),
    };
  };
  const groups = GROUPS.map((g) => ({
    ...g,
    systems: systems.filter((row) => row.group === g.id).map(decorate),
  }));

  // 7. The impact band — real Gmail numbers, measured-or-say-so Paraform.
  const samples = quotaReads[0];
  const records = quotaReads.slice(1);
  const quota = summarizeQuota(
    records[0] || { day: days[0], sends: null, four29: 0 },
    lockoutFromSamples(samples, { now: nowMs }),
  );
  const mwData = feeds?.["match-watch-status"]?.data;
  const budgetUsed = Number(mwData?.latestRun?.budgetUsed);
  const impact = {
    gmail: {
      day: quota.day,
      sends: quota.sends,
      cap: quota.cap,
      pct: quota.pct,
      exact: quota.exact,
      four29: quota.four29Today,
      lockoutMinutes: quota.lockedMinutesToday,
      blindMinutes: quota.blindMinutesToday,
      suppressed: quota.suppressed,
      history7d: days.map((d, i) => ({ day: d, sends: numberOrNull(records[i]?.sends) })).reverse(),
      topReaders: TOP_READERS,
    },
    paraform: {
      measured: Number.isFinite(budgetUsed)
        ? [{
            id: "match-watch",
            callsLastRun: budgetUsed,
            budget: numberOrNull(mwData?.latestRun?.budgetLimit),
          }]
        : [],
      note: "Other lanes' Paraform call volume is not measured — estimates only.",
    },
  };

  // 8. Freshness, per source and headline-oldest — never one fake clock.
  const dataAsOf = {
    health: healthCheckedAt,
    gmailQuota: quota.checkedAt,
    actionsRuns: gha?.at || null,
    matchWatch: mwData?.generatedAt || mwData?.lastRun || null,
    curate: feeds?.["paraai-curated-fit-heartbeat"]?.data?.lastRun || null,
  };
  let oldest = null;
  for (const [source, at] of Object.entries(dataAsOf)) {
    const t = Date.parse(String(at || ""));
    if (!Number.isFinite(t)) continue;
    if (!oldest || t < oldest.t) oldest = { source, at, t };
  }

  return {
    ok: true,
    generatedAt: new Date(nowMs).toISOString(),
    dataAsOf,
    oldest: oldest ? { source: oldest.source, at: oldest.at } : null,
    ...(ghaError ? { actionsRunsStale: { error: ghaError, cachedAt: gha?.at || null } } : {}),
    todos: deriveTodos({ tiles, feeds, nowMs }),
    groups,
    impact,
    footer: {
      coverage: `${systems.length} systems tracked — the complete inventory as of ${INVENTORY_DATE}`,
      notes: FOOTER_NOTES,
    },
  };
}

export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (!(await requireAuth(req, res))) return;
  res.setHeader("cache-control", "no-store");
  try {
    return res.status(200).json(await buildState());
  } catch (e) {
    // The page renders an honest error state rather than a blank screen.
    return res.status(500).json({ ok: false, error: String(e?.message || e).slice(0, 160) });
  }
}
