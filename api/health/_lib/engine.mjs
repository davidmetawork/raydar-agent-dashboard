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
const INCIDENT_CAP = 300;
const TRANS_TTL = 31 * 24 * 3600;
const STATE_ORDER = { OK: 0, PAUSED: 0, UNKNOWN: 1, DEGRADED: 2, DOWN: 3 };
/** States that must be seen twice in a row before they stick. */
const DEBOUNCED = new Set(["UNKNOWN", "DOWN"]);

export const worst = (states) =>
  states.reduce((acc, s) => (STATE_ORDER[s] > STATE_ORDER[acc] ? s : acc), "OK");

/**
 * The booking-door ground-truth probe. POSTs /api/hold with a far-future
 * timestamp deliberately offset off the slot grid plus a fresh browserKey:
 * admission is asserted before slot matching, so the probe can never create a
 * hold. 409 slot_taken proves the door is OPEN; 503 proves it is CLOSED. The
 * paired health GET is fetched only as context for the tile's metrics.
 */
async function runHoldProbe(check) {
  const p = check.probe;
  const body = {
    hostSlug: "raydar",
    eventSlug: "agent",
    // 4 days out, +37s off any slot boundary — never a real slot.
    startMs: (Math.floor(Date.now() / 1000) + 4 * 86400) * 1000 + 37000,
    browserKey: globalThis.crypto.randomUUID(),
  };
  try {
    const [holdRes, healthRes] = await Promise.all([
      fetch(p.url, {
        method: "POST",
        headers: { "content-type": "application/json", "user-agent": "raydar-health/1" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(p.timeoutMs || 12000),
      }),
      fetch(p.healthUrl, {
        headers: { accept: "application/json", "user-agent": "raydar-health/1" },
        signal: AbortSignal.timeout(p.timeoutMs || 12000),
      }).catch(() => null),
    ]);
    const holdBody = await holdRes.text().then((t) => { try { return JSON.parse(t); } catch { return null; } });
    const healthBody = healthRes
      ? await healthRes.text().then((t) => { try { return JSON.parse(t); } catch { return null; } })
      : null;
    return { transport: null, status: holdRes.status, body: { hold: holdBody, holdStatus: holdRes.status, health: healthBody } };
  } catch (e) {
    const msg = String(e?.name === "TimeoutError" ? "timeout" : e?.message || e).slice(0, 140);
    return { transport: msg, status: 0, body: null };
  }
}

async function runPull(check) {
  const p = check.probe;
  if (p.kind === "holdProbe") return runHoldProbe(check);
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
    // A status we did not anticipate is a transport-level unknown, not a
    // verdict (PRD §6: "non-2xx-where-2xx-expected returns UNKNOWN
    // automatically in the tick engine"). Unless a check explicitly lists the
    // statuses it can read, only 2xx is a body worth evaluating.
    //
    // This is load-bearing: Vercel answers an unknown /api/* path with a
    // *JSON* envelope when asked for JSON, so a 404 used to sail into an
    // evaluator, present as a well-formed object with no bad news in it, and
    // score OK. A missing endpoint must never read as a healthy one.
    const allowed = p.okStatuses;
    const acceptable = allowed
      ? allowed.includes(res.status)
      : res.status >= 200 && res.status < 300;
    if (!acceptable) {
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
  // Desktop lanes only: the runner-offline collapse models ONE machine going
  // quiet. GitHub Actions lanes are also beats but run on GitHub's infra —
  // counting them here made the runner tile claim overdue lanes that were
  // actually a failed Action, and a laptop shutdown would have needed more
  // silent lanes to trip the collapse.
  const laneChecks = active.filter((c) => c.kind === "beat" && c.group === "desktop");
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
  const incidentOps = [];
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
    // An incident spans one continuous departure from OK: it opens on the
    // transition that leaves OK, tracks the worst state reached, and closes
    // when the tile comes back. The pointer rides on the tile so no KV scan
    // is ever needed to find the open one.
    let incidentAt = before.incidentAt || null;
    let incidentWorst = before.incidentWorst || null;
    if (changed && before.state) {
      if (state === "OK") {
        if (incidentAt) {
          incidentOps.push({
            key: K.incident(check.id, incidentAt),
            record: {
              id: check.id, name: check.name, tier: check.tier,
              openedAt: incidentAt, closedAt: nowIso,
              worst: incidentWorst || before.state, reason: before.reason || null,
            },
          });
          incidentAt = null;
          incidentWorst = null;
        }
      } else if (!incidentAt) {
        incidentAt = nowIso;
        incidentWorst = state;
        incidentOps.push({
          key: K.incident(check.id, incidentAt),
          index: { id: check.id, openedAt: incidentAt },
          record: {
            id: check.id, name: check.name, tier: check.tier,
            openedAt: incidentAt, closedAt: null,
            worst: state, reason: raw.reason || null,
          },
        });
      } else if (STATE_ORDER[state] > STATE_ORDER[incidentWorst || "OK"]) {
        incidentWorst = state;
        incidentOps.push({
          key: K.incident(check.id, incidentAt),
          record: {
            id: check.id, name: check.name, tier: check.tier,
            openedAt: incidentAt, closedAt: null,
            worst: state, reason: raw.reason || null,
          },
        });
      }
    }
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
      ...(incidentAt ? { incidentAt, incidentWorst } : {}),
    };
    // A first observation counts as a transition. Without this, a check whose
    // very first result is DOWN records nothing, never fires the initial page,
    // and is only caught later by the re-page path — which is what happened in
    // the 2026-08-07 pager drill: the DM read "STILL DOWN (0m)" instead of
    // "DOWN". A newly added check that is born broken must page like one.
    if (changed) {
      transitions.push({
        id: check.id, name: check.name, tier: check.tier,
        from: before.state || "NEW", to: state, reason: raw.reason || null, at: nowIso,
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
  // `overall` is the banner: worst of everything, so the page tells the whole
  // truth. `criticalDown` is the PAGING verdict: only tier-1, the same set
  // that wakes a human. The public rollup keys its 200/503 off this, so the
  // external dead-man fires for the things that matter and stays quiet when a
  // single tier-2 desktop lane has one bad run — otherwise the backstop
  // becomes noise and gets ignored, which is the disease, not the cure.
  const criticalDown = CATALOG.filter((c) =>
    !c.paused && !acks[c.id] && c.tier === 1 && tiles[c.id]?.state === "DOWN").length;

  const state = {
    schema: "raydar-health-state-v1", checkedAt: nowIso, overall, criticalDown, counts, tiles,
  };

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
    for (const op of incidentOps) {
      writes.push(hSet(op.key, op.record, TRANS_TTL));
    }
    // One index list so the digest can read incidents without a KV scan.
    const opened = incidentOps.filter((op) => op.index).map((op) => op.index);
    if (opened.length) {
      writes.push((async () => {
        const list = (await hGet(K.incidentIndex)) || [];
        list.unshift(...opened);
        await hSet(K.incidentIndex, list.slice(0, INCIDENT_CAP), TRANS_TTL);
      })());
    }
    await Promise.allSettled(writes);
  }

  return { state, transitions, incidents: incidentOps.map((o) => o.record), kvOk };
}
