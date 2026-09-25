// THE TICK ENGINE. Runs every 2 minutes; writes hlth:* and nothing else.
//
// Spec: docs/PRD-SYSTEM-HEALTH-TAB-2026-08-07.md §7.3 (main repo).
//
// Design rules learned from the outage this exists to prevent:
//  - One slow probe must never sink the tick (allSettled + per-probe timeout).
//  - A probe we cannot run is UNKNOWN, never OK. Silence is not success.
//  - Entering UNKNOWN or DOWN needs two consecutive ticks (transient network
//    flaps are constant); leaving them is immediate. HEALTH_DOWN_TICKS_OVERRIDES
//    can lengthen the DOWN debounce for named tiles (see downTicksOverrides).
import { CATALOG, byId } from "./catalog.mjs";
import { EVALUATORS } from "./evaluators.mjs";
import { hGet, hGetChecked, hGetMany, hSet, K, kvConfigured } from "./kv.mjs";

const SAMPLE_CAP = 720; // 24h at 2-min ticks
const TRANS_CAP = 200;
const INCIDENT_CAP = 300;
const TRANS_TTL = 31 * 24 * 3600;
const STATE_ORDER = { OK: 0, PAUSED: 0, UNKNOWN: 1, DEGRADED: 2, DOWN: 3 };
/** States that must be seen twice in a row before they stick. */
const DEBOUNCED = new Set(["UNKNOWN", "DOWN"]);
/** Ticks a debounced state must be seen in a row, unless overridden below. */
export const DEFAULT_DEBOUNCE_TICKS = 2;
const MAX_DOWN_TICKS = 60; // two hours at 2-minute ticks

/**
 * Per-tile DOWN debounce, read from HEALTH_DOWN_TICKS_OVERRIDES (JSON, e.g.
 * {"booking-door":8}). Unset, empty or unparseable means every tile keeps the
 * two-tick default, exactly as before. An override can only LENGTHEN the
 * debounce (2..60 ticks), never shorten it, and it applies to entering DOWN
 * only: UNKNOWN keeps two ticks. Entries that are not accepted (an unknown
 * tile id, a value outside 2..60) are listed by name in the tick response's
 * `downTicks.rejected` and logged, so a typo cannot pass for a setting.
 *
 * Why it exists: on 2026-09-23 the booking-door tile paged five times for
 * eight-minute admission closures that fixed themselves. Eight ticks means the
 * door must read closed for about fifteen minutes before it pages #notify.
 */
export function readDownTicksOverrides(env = process.env, knownIds = null) {
  const report = { effective: {}, rejected: [] };
  const raw = String(env?.HEALTH_DOWN_TICKS_OVERRIDES || "").trim();
  if (!raw) return report;
  let parsed;
  try { parsed = JSON.parse(raw); } catch { parsed = null; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    report.rejected.push({ key: null, reason: "not a JSON object of tile id to ticks" });
    return report;
  }
  for (const [id, value] of Object.entries(parsed)) {
    const ticks = Number(value);
    if (knownIds && !knownIds.has(id)) {
      report.rejected.push({ key: id, reason: "no health tile has this id" });
    } else if (typeof value !== "number" && typeof value !== "string") {
      report.rejected.push({ key: id, reason: "ticks must be a whole number" });
    } else if (Number.isInteger(ticks) && ticks >= DEFAULT_DEBOUNCE_TICKS && ticks <= MAX_DOWN_TICKS) {
      report.effective[id] = ticks;
    } else {
      report.rejected.push({
        key: id,
        reason: `ticks must be a whole number from ${DEFAULT_DEBOUNCE_TICKS} to ${MAX_DOWN_TICKS}`,
      });
    }
  }
  return report;
}

/** The accepted overrides only (see readDownTicksOverrides for the report). */
export function downTicksOverrides(env = process.env) {
  return readDownTicksOverrides(env).effective;
}

/** How many consecutive ticks `state` needs before tile `id` enters it. */
export function debounceTicksFor(id, state, overrides = {}) {
  if (state === "DOWN" && overrides[id]) return overrides[id];
  return DEFAULT_DEBOUNCE_TICKS;
}

/**
 * The debounce step for one tile. Returns the HELD tile record (the tile keeps
 * its previous state and counts the pending one) or null when the raw state
 * should be applied now. A first observation, a repeat of the current state
 * and a non-debounced state (OK, DEGRADED) are always applied immediately;
 * leaving DOWN or UNKNOWN is immediate.
 */
export function holdForDebounce(before, raw, needTicks, nowIso) {
  const state = raw?.state;
  if (!DEBOUNCED.has(state) || !before?.state || before.state === state) return null;
  const pendingCount = before.pending === state
    ? Math.max(1, Number(before.pendingCount) || 1) + 1
    : 1;
  if (pendingCount >= needTicks) return null;
  return {
    ...before,
    pending: state,
    pendingCount,
    pendingReason: raw.reason || null,
    metrics: raw.metrics || before.metrics || null,
    lastCheckedAt: nowIso,
  };
}

/**
 * How long a tile may stay out of DOWN (in DEGRADED or UNKNOWN) and still
 * rejoin the same DOWN episode when it goes red again. Equal to the pager's
 * one-hour flap slot (RE_PAGE_SECONDS in alert.mjs).
 */
export const DOWN_EPISODE_REJOIN_MS = 60 * 60 * 1000;

/**
 * The DOWN-episode fields for a tile's next record. The tier-1 pager posts once
 * per episode (alert.mjs pageIncidentKey), so the episode must be narrower
 * than the incident: `incidentAt` survives DEGRADED and UNKNOWN until the tile
 * reads OK, which would let one page cover a DOWN, then hours of DEGRADED,
 * then a new DOWN with a different reason. (PR 229 review, round 2.)
 *
 *  - Entering DOWN starts a new episode (`downEpisodeAt` = now), unless the
 *    tile left DOWN less than DOWN_EPISODE_REJOIN_MS ago: a short
 *    DOWN/DEGRADED flap stays one episode, so it pages once.
 *  - Staying DOWN keeps the episode. A tile already DOWN when this shipped has
 *    no `downEpisodeAt`; its `since` (the time it entered DOWN) stands in.
 *  - Leaving DOWN for DEGRADED or UNKNOWN stamps `downLeftAt` and keeps the
 *    episode, so a quick return can rejoin it.
 *  - OK (or PAUSED) ends the episode, exactly as it closes the incident.
 */
export function nextDownEpisode(before, state, nowIso) {
  if (state !== "DOWN" && state !== "DEGRADED" && state !== "UNKNOWN") return {};
  const wasDown = before?.state === "DOWN";
  const carried = before?.downEpisodeAt || (wasDown ? before?.since : null) || null;
  if (state === "DOWN") {
    if (wasDown) return { downEpisodeAt: carried || nowIso };
    const leftMs = Date.parse(before?.downLeftAt || "");
    const rejoin = Boolean(carried) && Number.isFinite(leftMs)
      && Date.parse(nowIso) - leftMs < DOWN_EPISODE_REJOIN_MS;
    return { downEpisodeAt: rejoin ? carried : nowIso };
  }
  if (wasDown) return { downEpisodeAt: carried || nowIso, downLeftAt: nowIso };
  if (carried && before?.downLeftAt) return { downEpisodeAt: carried, downLeftAt: before.downLeftAt };
  return {};
}

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
  // A probe whose URL needs an env value (e.g. the lifecycle gist id) is a
  // key-missing UNKNOWN until that value is provisioned — same contract as a
  // missing auth secret, and never a broken fetch against "undefined".
  if (p.urlEnv && !process.env[p.urlEnv]) {
    return { transport: "key-missing", status: 0, body: null, keyMissing: true };
  }
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
 * @returns {{state: object, transitions: Array, kvOk: boolean, stateLoaded: boolean}}
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
  // A FAILED read of hlth:state is not an empty state. Treating it as one
  // would make every tile a first observation (fresh `since`, no incident or
  // DOWN-episode pointer), and persisting that would hand the pager a new key
  // for an ongoing outage: a duplicate #notify page. So a failed read skips
  // persistence and alerting for this tick (stateLoaded=false); the next tick
  // picks up from the last good state. A genuinely missing key (first tick
  // ever) reads as ok with no value and proceeds normally.
  const prevRead = await hGetChecked(K.state);
  const stateLoaded = prevRead.ok;
  if (!stateLoaded) console.warn("health_state_unreadable", { kvOk });
  const prev = (prevRead.ok && prevRead.value && typeof prevRead.value === "object")
    ? prevRead.value
    : { tiles: {} };
  const beatKeys = CATALOG.filter((c) => c.kind === "beat").map((c) => K.beat(c.probe.lane));
  const ackKeys = CATALOG.map((c) => K.ack(c.id));
  const [beatVals, ackVals, watchdog, lastDelivered, gmailBackoffUntil] = await Promise.all([
    hGetMany(beatKeys),
    hGetMany(ackKeys),
    hGet("seqguard:n8nwatch"), // READ-ONLY: owned by /api/ops/n8n-watchdog
    hGet(K.lastDelivered),
    // READ-ONLY: owned by api/paraai/_lib/outreach-store.mjs. Present only
    // while the fleet Gmail breaker is armed — i.e. an outreach pass actually
    // observed a 429 on david@raydar.xyz within the last ~20 minutes.
    hGet("paraai:outreach:gmail-backoff"),
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

  // C6 (2026-09-24 Paraform reduction pass): the screener-feed probe already
  // pays for one webview /api/status read per tick. Persist its
  // upcoming-calls array here so calls-today.html's Upcoming panel can read
  // this cache instead of every open tab polling webview directly every
  // 30s — zero new outbound calls, this is the health tick's own existing
  // fetch, just kept a moment longer.
  const screenerFeedUpcoming = results["screener-feed"]?.raw?.upcoming;
  if (Array.isArray(screenerFeedUpcoming)) {
    try {
      await hSet(K.upcoming, { fetchedAt: nowIso, upcoming: screenerFeedUpcoming }, 600);
    } catch { /* the next tick retries; a stale cache beats a missing one */ }
  }

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
  // Desktop-RUNNER lanes only: the runner-offline collapse models ONE machine
  // going quiet. GitHub Actions lanes are also beats but run on GitHub's
  // infra — counting them here made the runner tile claim overdue lanes that
  // were actually a failed Action. The filter keys on `runner`, not group:
  // email-touching desktop lanes render in the email group but still ride the
  // same laptop, so they belong in this denominator wherever they display.
  const laneChecks = active.filter((c) => c.kind === "beat" && c.runner === "desktop");
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
        results, watchdog, kvOk, lastDelivered, laneStates, beats, gmailBackoffUntil,
        probe: check.probe, check,
      });
    } catch (e) {
      results[check.id] = { state: "UNKNOWN", reason: `evaluator threw: ${String(e?.message || e).slice(0, 120)}` };
    }
  }

  // ---- 7. Debounce, transitions, incidents
  // Echoed in the tick response (downTicks) so step 9 of the #notify plan can
  // read back what actually took effect; a typo'd id or bad value is rejected
  // there by name and warned here, never silently dropped.
  const downTicks = readDownTicksOverrides(process.env, new Set(CATALOG.map((c) => c.id)));
  if (downTicks.rejected.length) {
    console.warn("health_down_ticks_overrides_rejected", { rejected: downTicks.rejected });
  }
  const downOverrides = downTicks.effective;
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
    // Consecutive ticks required to ENTER a debounced state: two by default,
    // more for a tile named in HEALTH_DOWN_TICKS_OVERRIDES (DOWN only).
    const held = holdForDebounce(
      before, raw, debounceTicksFor(check.id, state, downOverrides), nowIso,
    );
    if (held) {
      tiles[check.id] = held;
      continue;
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
      // The pager's key: one page per DOWN episode (see nextDownEpisode).
      ...nextDownEpisode(before, state, nowIso),
    };
    // A first observation counts as a transition, so a check whose very first
    // result is DOWN is recorded like any other (the 2026-08-07 pager drill
    // read "STILL DOWN (0m)" because it was not). The pager itself works from
    // the tile state, not this list (api/health/_lib/alert.mjs), so a newly
    // added check that is born broken pages once like any other incident.
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

  // ---- 9. Persist (best effort; a KV failure must not throw the tick away).
  // Never persist a tick computed from an unreadable prior state (step 2).
  if (kvOk && stateLoaded) {
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

  return {
    state, transitions, incidents: incidentOps.map((o) => o.record), kvOk, stateLoaded, downTicks,
  };
}
