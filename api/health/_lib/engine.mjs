// THE TICK ENGINE. Runs every 2 minutes; writes hlth:* and nothing else.
//
// Spec: docs/PRD-SYSTEM-HEALTH-TAB-2026-08-07.md §7.3 (main repo).
//
// Design rules learned from the outage this exists to prevent:
//  - One slow probe must never sink the tick (allSettled + per-probe timeout).
//  - A probe we cannot run is UNKNOWN, never OK. Silence is not success.
//  - Entering UNKNOWN or DOWN needs two consecutive ticks (transient network
//    flaps are constant); leaving them is immediate.
import { CATALOG, byId } from "./catalog.mjs";
import { EVALUATORS } from "./evaluators.mjs";
import { hGet, hGetMany, hSet, K, kvConfigured } from "./kv.mjs";

const SAMPLE_CAP = 720; // 24h at 2-min ticks
const TRANS_CAP = 200;
const TRANS_TTL = 31 * 24 * 3600;
const STATE_ORDER = { OK: 0, PAUSED: 0, UNKNOWN: 1, DEGRADED: 2, DOWN: 3 };
/** States that must be seen twice in a row before they stick. */
const DEBOUNCED = new Set(["UNKNOWN", "DOWN"]);

export const worst = (states) =>
  states.reduce((acc, s) => (STATE_ORDER[s] > STATE_ORDER[acc] ? s : acc), "OK");

async function runPull(check) {
  const p = check.probe;
  const envName = p.authEnv;
  const secret = envName ? process.env[envName] || "" : null;
  if (envName && !secret) {
    return { transport: "key-missing", status: 0, body: null, keyMissing: true };
  }
  const headers = { accept: "application/json", "user-agent": "raydar-health/1" };
  if (secret) headers.authorization = `${p.authScheme || "Bearer"} ${secret}`;
  const url = typeof p.url === "function" ? p.url() : p.url;
  try {
    const res = await fetch(url, {
      method: "GET",
      headers,
      redirect: p.redirect || "follow",
      signal: AbortSignal.timeout(p.timeoutMs || 8000),
    });
    const allowed = p.okStatuses;
    // A status we did not anticipate is a transport-level unknown, not a verdict.
    if (allowed && !allowed.includes(res.status) && !(res.status >= 200 && res.status < 300)) {
      return { transport: `HTTP ${res.status}`, status: res.status, body: null };
    }
    let body = null;
    const text = await res.text().catch(() => "");
    if (text) { try { body = JSON.parse(text); } catch { body = null; } }
    return { transport: null, status: res.status, body };
  } catch (e) {
    const msg = String(e?.name === "TimeoutError" ? "timeout" : e?.message || e).slice(0, 140);
    return { transport: msg, status: 0, body: null };
  }
}

/**
 * @param {object} deps injectable for tests: fetchers and clock
 * @returns {{state: object, transitions: Array, kvOk: boolean}}
 */
export async function runTick({ now = Date.now() } = {}) {
  const nowIso = new Date(now).toISOString();
  const active = CATALOG.filter((c) => !c.paused);

  // ---- 1. KV self-test (the upstash-kv tile, and a guard on everything else)
  let kvOk = false;
  if (kvConfigured()) {
    try {
      await hSet(K.selftest, { at: nowIso }, 600);
      const readBack = await hGet(K.selftest);
      kvOk = Boolean(readBack?.at);
    } catch { kvOk = false; }
  }

  // ---- 2. Load prior state, beats, acks, and the n8n watchdog's state
  const prev = (await hGet(K.state)) || { tiles: {} };
  const beatKeys = CATALOG.filter((c) => c.kind === "beat").map((c) => K.beat(c.probe.lane));
  const ackKeys = CATALOG.map((c) => K.ack(c.id));
  const [beatVals, ackVals, watchdog, lastDelivered] = await Promise.all([
    hGetMany(beatKeys),
    hGetMany(ackKeys),
    hGet("seqguard:n8nwatch"), // READ-ONLY: owned by /api/ops/n8n-watchdog
    hGet(K.lastDelivered),
  ]);
  const beats = {};
  CATALOG.filter((c) => c.kind === "beat").forEach((c, i) => { beats[c.probe.lane] = beatVals[i]; });
  const acks = {};
  CATALOG.forEach((c, i) => {
    const a = ackVals[i];
    if (a && Date.parse(a.until) > now) acks[c.id] = a;
  });

  // ---- 3. Pull probes, all in parallel
  const pulls = active.filter((c) => c.kind === "pull");
  const pullResults = await Promise.allSettled(pulls.map((c) => runPull(c)));
  const results = {};
  pulls.forEach((check, i) => {
    const settled = pullResults[i];
    const r = settled.status === "fulfilled"
      ? settled.value
      : { transport: String(settled.reason).slice(0, 140), status: 0, body: null };
    if (r.transport && !r.keyMissing) {
      results[check.id] = { state: "UNKNOWN", reason: r.transport, raw: null };
      return;
    }
    const evaluate = EVALUATORS[check.probe.evaluate];
    if (!evaluate) {
      results[check.id] = { state: "UNKNOWN", reason: `no evaluator ${check.probe.evaluate}`, raw: null };
      return;
    }
    try {
      const v = evaluate({ ...r, probe: check.probe, check });
      results[check.id] = { ...v, raw: r.body };
    } catch (e) {
      results[check.id] = { state: "UNKNOWN", reason: `evaluator threw: ${String(e?.message || e).slice(0, 120)}`, raw: null };
    }
  });

  // ---- 4. Beat lanes
  for (const check of active.filter((c) => c.kind === "beat")) {
    try {
      results[check.id] = EVALUATORS.beatLane({
        probe: check.probe,
        beat: beats[check.probe.lane],
      });
    } catch (e) {
      results[check.id] = { state: "UNKNOWN", reason: String(e?.message || e).slice(0, 120) };
    }
  }

  // ---- 5. Desktop collapse: a closed laptop is ONE event, not sixteen
  const laneChecks = active.filter((c) => c.kind === "beat");
  const laneStates = laneChecks.map((c) => ({ id: c.id, paused: false, ...results[c.id] }));
  const runnerVerdict = EVALUATORS.desktopRunner({ laneStates });
  if (runnerVerdict.state === "DOWN") {
    for (const c of laneChecks) {
      if (results[c.id]?.state === "DOWN") {
        results[c.id] = { state: "UNKNOWN", reason: "runner-offline" };
      }
    }
  }

  // ---- 6. Derived checks (may read every prior result)
  for (const check of active.filter((c) => c.kind === "derived")) {
    const evaluate = check.id === "desktop-runner"
      ? () => runnerVerdict
      : EVALUATORS[check.probe.evaluate];
    if (!evaluate) {
      results[check.id] = { state: "UNKNOWN", reason: `no evaluator ${check.probe.evaluate}` };
      continue;
    }
    try {
      results[check.id] = evaluate({
        results, watchdog, kvOk, lastDelivered, laneStates,
        probe: check.probe, check,
      });
    } catch (e) {
      results[check.id] = { state: "UNKNOWN", reason: `evaluator threw: ${String(e?.message || e).slice(0, 120)}` };
    }
  }

  // ---- 7. Debounce, transitions, incidents
  const tiles = {};
  const transitions = [];
  for (const check of CATALOG) {
    const before = prev.tiles?.[check.id] || {};
    if (check.paused) {
      tiles[check.id] = {
        state: "PAUSED", reason: check.note || "paused", since: before.since || nowIso,
      };
      continue;
    }
    const raw = results[check.id] || { state: "UNKNOWN", reason: "not evaluated" };
    let state = raw.state;
    // Two consecutive ticks required to ENTER a debounced state.
    if (DEBOUNCED.has(state) && before.state && before.state !== state) {
      const pendingSame = before.pending === state;
      if (!pendingSame) {
        tiles[check.id] = {
          ...before,
          pending: state,
          pendingReason: raw.reason || null,
          metrics: raw.metrics || before.metrics || null,
          lastCheckedAt: nowIso,
        };
        continue;
      }
    }
    const changed = before.state !== state;
    tiles[check.id] = {
      state,
      reason: raw.reason || null,
      metrics: raw.metrics || null,
      since: changed || !before.since ? nowIso : before.since,
      lastCheckedAt: nowIso,
      ackUntil: acks[check.id]?.until || null,
      ackReason: acks[check.id]?.reason || null,
      tier: check.tier,
      group: check.group,
      name: check.name,
    };
    if (changed && before.state) {
      transitions.push({
        id: check.id, name: check.name, tier: check.tier,
        from: before.state, to: state, reason: raw.reason || null, at: nowIso,
        sinceLast: before.since || null,
      });
    }
  }

  // ---- 8. Overall verdict: acked and paused tiles never darken the banner
  const counted = CATALOG
    .filter((c) => !c.paused && !acks[c.id])
    .map((c) => tiles[c.id]?.state || "UNKNOWN");
  const overall = worst(counted);
  const counts = { OK: 0, DEGRADED: 0, DOWN: 0, UNKNOWN: 0, PAUSED: 0 };
  for (const c of CATALOG) counts[tiles[c.id]?.state || "UNKNOWN"] += 1;

  const state = { schema: "raydar-health-state-v1", checkedAt: nowIso, overall, counts, tiles };

  // ---- 9. Persist (best effort; a KV failure must not throw the tick away)
  if (kvOk) {
    const writes = [hSet(K.state, state)];
    const minute = Math.floor(now / 60000);
    for (const check of CATALOG) {
      const s = tiles[check.id]?.state;
      if (!s) continue;
      writes.push((async () => {
        const prevSamples = (await hGet(K.samples(check.id))) || [];
        prevSamples.push({ t: minute, s: s[0] });
        await hSet(K.samples(check.id), prevSamples.slice(-SAMPLE_CAP), 26 * 3600);
      })());
    }
    for (const t of transitions) {
      writes.push((async () => {
        const list = (await hGet(K.trans(t.id))) || [];
        list.unshift({ t: t.at, from: t.from, to: t.to, reason: t.reason });
        await hSet(K.trans(t.id), list.slice(0, TRANS_CAP), TRANS_TTL);
      })());
    }
    await Promise.allSettled(writes);
  }

  return { state, transitions, kvOk };
}
