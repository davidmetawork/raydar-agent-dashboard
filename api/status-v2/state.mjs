// Everything Status v2 renders, in one call — the two rebuilt systems.
//
// Spec: PRD-STATUS-V2-2026-09-03 §4.5 (freshness and the not-running states),
// §5 (the numbers and where they come from), §6 (the rules the tests enforce).
//
// THE HARD CONSTRAINT (PRD §5): this plane makes ZERO Gmail calls and ZERO
// Paraform calls, and nothing here ever polls the applicant pipeline's own
// loopback API. It reads exactly three things:
//   1. https://raydar-post-call.vercel.app/api/health — public, GET, 6s cap;
//   2. the post-call review feed through THIS repo's existing signed proxy
//      helper (api/post-call/review.mjs `upstream`), for ?metrics and ?funnel;
//   3. our own KV — the applicants tab's apphub:* counts, the applicant
//      pipeline publisher's apphub:pipeline doc, and statv2:* memos.
// Every network read is memoised in KV, so a warm page view costs 0 fetches.
//
// Honesty rules baked in (PRD §6):
//   - the page NEVER derives a count; a publisher publishes it or it is "—";
//   - a failed or unparseable read renders "Cannot tell", never "down" and
//     never green — and a "down" claim needs a second witness (R17);
//   - a stale applicant publish with no stop reason is "Cannot tell", not
//     "Not running": today nothing records the difference between a planned
//     stop and a crash, so the page says so and asks (R6, R17);
//   - every number and every state word carries its source and its age (R12);
//   - applicant bucket labels come only from the payload (R14).
import { cors, requireAuth } from "../seq/_lib/core.mjs";
import { byId as healthById } from "../health/_lib/catalog.mjs";
import { hGet as healthKvGet, K as HEALTH_K } from "../health/_lib/kv.mjs";
import { getJson as apphubGetJson, K as APPHUB } from "../applicants/_lib/kv.mjs";
import { upstream as postCallUpstream, config as postCallConfig } from "../post-call/review.mjs";
import { vGet, vSet, K, MEMO_TTL_S, RING_TTL_S } from "./_lib/kv.mjs";
import {
  SYSTEMS, STATE_WORDS, STATE_TONE, STATE_RANK, worstState,
  reviewStateCopy, SOURCES, TODO_RULES, FOOTER, SYSTEM_IDS,
} from "./_lib/systems.mjs";

export const config = { maxDuration: 30 };

// The one public host this plane may touch. The signed proxy's own upstream is
// the post-call service configured in POST_CALL_BASE (allowlisted by
// api/_lib/safe-upstream.mjs), and KV is the Upstash REST endpoint.
export const HEALTH_URL = "https://raydar-post-call.vercel.app/api/health";
export const HEALTH_TIMEOUT_MS = 6_000;

const HEALTH_FRESH_MS = 30_000;
const FEED_FRESH_MS = 60_000;
// Twice the post-call minute tick: a green pulse only while the tick is warm.
const TICK_PULSE_MS = 2 * 60_000;
// Twice the applicant pipeline's 180 s interval (PRD §4.5).
const APPLICANT_STALE_MS = 6 * 60_000;
// The Applicants-tab feed has no cadence this page can claim, so this is a
// stated threshold, not an inferred one: past it, the strip stops presenting
// its stored numbers as current. Without this the strip prints yesterday's
// "203 Waiting on you" at the very moment the Applicants tab beside it is
// showing em dashes, and two Raydar surfaces disagree about the same feed.
export const APPLICANT_FEED_STALE_MS = 60 * 60_000;
const POOL_TILE_CAP = 6;
const EVENT_CAP = 25;

// The applicant pipeline publisher's KV doc. Written by api/applicants/sync
// from the `pipeline` field of the Core publish; absent until that publisher
// ships, which the page renders as "no publisher yet" rather than as zeroes.
export const PIPELINE_KEY = "apphub:pipeline";
// The beat lane the post-call watchdog POSTs to every 10 minutes. Whether it
// is in the beat catalog decides whether its check-in is accepted at all, so
// the page reports three different things and never guesses between them:
// unregistered (the sink 404s it), registered but never heard from, or the
// age of the beat this dashboard actually holds (PRD §5.1).
export const WATCHDOG_LANE_ID = "gha-post-call-watchdog";

/** The last beat this dashboard holds for a lane, from our own KV. Never
 *  throws and never fetches when KV is unconfigured. */
export async function readBeat(lane) {
  try { return await healthKvGet(HEALTH_K.beat(lane)); } catch { return null; }
}

// ── small shared helpers (ported from api/status/state.mjs) ─────────────────
// Only a number, or a string that is one, is a published number. Everything
// else — null, a boolean, an object, an array, "" — is NOT a value (R5).
// Booleans matter here: Number(false) is 0 and Number(true) is 1, so a
// wrong-typed `confirmed: false` would otherwise paint a real "0" in a box,
// which is the exact fake zero this page exists to forbid.
const finiteOrNull = (value) => {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
};

/** Walk a dotted path; return a finite number (sign and all) or null. */
function rawNumberAt(obj, path) {
  let cur = obj;
  for (const part of String(path || "").split(".")) {
    if (cur == null || typeof cur !== "object") return null;
    cur = cur[part];
  }
  return finiteOrNull(cur);
}

/** Walk a dotted path; return a publishable count or null. Never throws.
 *  A negative count is not a number of people, so it is UNUSABLE: it renders
 *  "—" and says so in the evidence drawer, rather than printing "-3 people"
 *  on the drawing (R1, R5). */
export function resolvePath(obj, path) {
  const n = rawNumberAt(obj, path);
  return n != null && n < 0 ? null : n;
}

/** The same rule for a value already in hand (a tile count, a strip field). */
export const countOrNull = (value) => {
  const n = finiteOrNull(value);
  return n != null && n < 0 ? null : n;
};

export const UNUSABLE_NEGATIVE = "the publisher sent a negative number, which cannot be a number of people";

/** Walk a dotted path; return the object there, or null. Never throws. */
function objectAt(obj, path) {
  let cur = obj;
  for (const part of String(path || "").split(".").filter(Boolean)) {
    if (cur == null || typeof cur !== "object") return null;
    cur = cur[part];
  }
  return cur && typeof cur === "object" ? cur : null;
}

/** Measured unless the PUBLISHER says otherwise (R12). A publisher declares a
 *  field it worked out rather than counted by putting the field's name in its
 *  own `basis` map — `funnel.basis.callsSeen: "inferred"`. The page never
 *  decides this for itself, and defaults to "measured" only when the payload
 *  says nothing, so the first genuinely inferred number declares itself
 *  instead of arriving silently dressed as a measurement. */
export const BASIS = { measured: "measured", inferred: "inferred" };
export function basisOf(container, field) {
  return objectAt(container, "basis")?.[field] === "inferred" ? BASIS.inferred : BASIS.measured;
}
function basisForPath(ctx, path) {
  const parts = String(path || "").split(".").filter(Boolean);
  if (!parts.length) return BASIS.measured;
  const field = parts.pop();
  return basisOf(parts.length ? objectAt(ctx, parts.join(".")) : ctx, field);
}

/** Walk a dotted path; return an array, or null. Never throws. */
export function resolveList(obj, path) {
  let cur = obj;
  for (const part of String(path || "").split(".")) {
    if (cur == null || typeof cur !== "object") return null;
    cur = cur[part];
  }
  return Array.isArray(cur) ? cur : null;
}

const isoOrNull = (value) => {
  const t = Date.parse(String(value || ""));
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};
const msSince = (value, nowMs) => {
  const t = Date.parse(String(value || ""));
  return Number.isFinite(t) ? nowMs - t : null;
};

/** "4h 12m", "3s", "2m" — an age, never a bare clock (PRD §4.2). */
export function humanAge(ms) {
  if (ms == null || !Number.isFinite(ms)) return null;
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return h > 0 && m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d}d ${h % 24}h` : `${d}d`;
}

/** "11:23 am PT" — one Pacific clock, never a bare UTC stamp (PRD §4.2). */
export function pacificClock(iso) {
  const t = Date.parse(String(iso || ""));
  if (!Number.isFinite(t)) return null;
  return `${new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles", hour: "numeric", minute: "2-digit",
  }).format(new Date(t)).toLowerCase()} PT`;
}

/** "4h 12m ago (11:23 am PT)" — the only way a time renders on the surface. */
export function whenSentence(iso, nowMs) {
  const age = humanAge(msSince(iso, nowMs));
  const clock = pacificClock(iso);
  if (!age) return null;
  return clock ? `${age} ago (${clock})` : `${age} ago`;
}

/** Latency as a sentence, never a bracketed aside (R3). */
export function clearingSentence(medianSeconds, p95Seconds) {
  const median = finiteOrNull(medianSeconds);
  const p95 = finiteOrNull(p95Seconds);
  if (median == null && p95 == null) return null;
  const say = (s) => humanAge(s * 1000);
  if (median != null && p95 != null) {
    return `half are cleared within ${say(median)}, the slowest 1 in 20 takes ${say(p95)}`;
  }
  if (median != null) return `half are cleared within ${say(median)}`;
  return `the slowest 1 in 20 takes ${say(p95)}`;
}

// ── source reads ────────────────────────────────────────────────────────────
/** The public post-call health endpoint. Memoised with the last two read
 *  outcomes, so "two consecutive failures" is knowable (PRD §4.5). */
export async function readHealth({ nowMs, fetchImpl, kv, memo }) {
  const fresh = memo && msSince(memo.at, nowMs) != null && msSince(memo.at, nowMs) < HEALTH_FRESH_MS;
  if (fresh) return { memo, fetched: false };
  const at = new Date(nowMs).toISOString();
  let outcome = { at, ok: false, status: null, error: "" };
  let data = memo?.data ?? null;
  let dataAt = memo?.dataAt ?? null;
  try {
    const res = await fetchImpl(HEALTH_URL, {
      headers: { accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    });
    const body = await res.json().catch(() => null);
    if (res.ok && body && typeof body === "object") {
      outcome = { at, ok: true, status: res.status, error: "" };
      data = body;
      dataAt = at;
    } else {
      outcome = { at, ok: false, status: res.status, error: res.ok ? "unparseable" : `http ${res.status}` };
    }
  } catch (e) {
    outcome = { at, ok: false, status: null, error: String(e?.message || e).slice(0, 120) };
  }
  const reads = [...(Array.isArray(memo?.reads) ? memo.reads : []), outcome].slice(-2);
  const next = { at, outcome, reads, data, dataAt };
  await kv.vSet(K.health, next, MEMO_TTL_S);
  return { memo: next, fetched: true };
}

/** One signed read of the post-call review feed, through the existing proxy
 *  helper. `kind` is "metrics" or "funnel"; a 404/501 on the funnel is not an
 *  error, it is "no publisher yet". */
export async function readReviewFeed({
  kind, nowMs, kv, memo, actorEmail, upstreamImpl, fetchImpl, cacheKey, configured,
}) {
  const fresh = memo && msSince(memo.at, nowMs) != null && msSince(memo.at, nowMs) < FEED_FRESH_MS;
  if (fresh) return { memo, fetched: false };
  const at = new Date(nowMs).toISOString();
  if (!configured || !actorEmail) {
    return {
      memo: { at, ok: false, state: "unconfigured", data: memo?.data ?? null, dataAt: memo?.dataAt ?? null },
      fetched: false,
    };
  }
  const path = kind === "funnel" ? "/api/v2/reviews/funnel" : "/api/v2/reviews/metrics";
  let next;
  try {
    const { response, body } = await upstreamImpl(path, { email: actorEmail }, {}, {}, { fetchImpl });
    if (response.status === 404 || response.status === 501) {
      next = { at, ok: false, state: "no-publisher", status: response.status, data: null, dataAt: null };
    } else if (response.ok && body && typeof body === "object" && body.ok !== false) {
      const payload = body[kind] && typeof body[kind] === "object" ? body[kind] : body;
      next = { at, ok: true, state: "answered", status: response.status, data: payload, dataAt: at };
    } else {
      next = {
        at, ok: false, state: "error", status: response.status,
        data: memo?.data ?? null, dataAt: memo?.dataAt ?? null,
      };
    }
  } catch (e) {
    next = {
      at, ok: false, state: "error", status: null, error: String(e?.message || e).slice(0, 120),
      data: memo?.data ?? null, dataAt: memo?.dataAt ?? null,
    };
  }
  await kv.vSet(cacheKey, next, MEMO_TTL_S);
  return { memo: next, fetched: true };
}

// ── state words (PRD §4.5 — the table the tests check) ──────────────────────
/** The post-call card's state, always naming the signal it came from. */
export function postCallStateFrom({ health, nowMs }) {
  const outcome = health?.outcome || null;
  const reads = Array.isArray(health?.reads) ? health.reads : [];
  const twoFailures = reads.length >= 2 && reads.slice(-2).every((r) => r && r.ok === false);
  if (!outcome) {
    return {
      stateId: "cannot-tell", reason: "never-read",
      caption: "the live check has not answered yet",
      pulse: false, warn: null, incident: null, lastGood: null,
    };
  }
  if (!outcome.ok) {
    const when = whenSentence(outcome.at, nowMs) || "just now";
    const lastGoodMode = String(health?.data?.mode || "");
    return {
      stateId: "cannot-tell",
      reason: "read-failed",
      caption: `the live check did not answer ${when}. This is not a claim that it is down.`,
      pulse: false,
      warn: null,
      incident: twoFailures
        ? "The live check has now failed twice in a row. Nothing else confirms whether the service is up."
        : null,
      lastGood: health?.dataAt
        ? {
          stateId: lastGoodMode === "live" ? "sending" : "not-sending-yet",
          word: STATE_WORDS[lastGoodMode === "live" ? "sending" : "not-sending-yet"],
          at: health.dataAt,
          age: humanAge(msSince(health.dataAt, nowMs)),
        }
        : null,
    };
  }
  const data = health.data || {};
  const readAge = humanAge(msSince(outcome.at, nowMs)) || "just now";
  // The service's OWN self-report. A 200 whose body says ok:false (or
  // database:false, or carries blockers) is the service telling us it is not
  // well; rendering green over that would be a louder lie than any missing
  // number on the page. It never becomes a state word of its own — the words
  // stay five — it downgrades a live claim to Cannot tell and rides along as
  // a warn chip everywhere else (PRD §4.5).
  const blockers = Array.isArray(data.blockers)
    ? data.blockers.map((b) => String(b || "").trim()).filter(Boolean) : [];
  const selfReport = data.ok === false
    ? "the service reports it is not ok"
    : data.database === false
      ? "the service reports its database is unreachable"
      : blockers.length
        ? `the service reports ${blockers.length === 1 ? "a blocker" : `${blockers.length} blockers`}`
        : null;
  const selfWarn = selfReport ? `${selfReport} (self-reported)` : null;
  if (String(data.mode || "") !== "live") {
    return {
      stateId: "not-sending-yet", reason: "mode",
      caption: `from the live check, ${readAge} ago`,
      pulse: false, warn: selfWarn, incident: null, lastGood: null,
    };
  }
  if (selfReport) {
    return {
      stateId: "cannot-tell", reason: "self-report",
      caption: `the live check answered ${readAge} ago, but ${selfReport}. This is not a claim that it is down.`,
      pulse: false, warn: selfWarn, incident: null, lastGood: null,
    };
  }
  const tick = data?.autonomy?.tick || {};
  const tickAgeMs = msSince(tick.lastFinishedAt, nowMs);
  // A stamp in the FUTURE is never fresh. A wrong publisher clock (or one that
  // stamps its intended next run) would otherwise animate the loudest green
  // pulse on the page, and humanAge would clamp the skew out of sight.
  const skewed = tickAgeMs != null && tickAgeMs < 0;
  const warm = tickAgeMs != null && tickAgeMs >= 0 && tickAgeMs < TICK_PULSE_MS;
  const tickAge = skewed ? null : humanAge(tickAgeMs);
  const tickLine = skewed
    ? ` · its last minute tick is stamped ${humanAge(-tickAgeMs)} in the future, which is a clock somewhere disagreeing with this one`
    : (warm || !tickAge ? "" : ` · its last minute tick finished ${tickAge} ago`);
  return {
    stateId: "sending",
    reason: "live",
    caption: `from the live check, ${readAge} ago${tickLine}`,
    pulse: warm,
    // A fault the system reports about ITSELF never recolours the state word
    // (PRD §4.2): green dot, warning chip beside it.
    warn: String(tick.outcome || "") === "source_degraded"
      ? "the system reports: one source degraded (self-reported)"
      : null,
    incident: null,
    lastGood: null,
  };
}

/** The applicant card's state. "Not running" needs a second witness (R17). */
export function applicantStateFrom({ pipeline, counts, nowMs }) {
  // ONE clock (R2): this card states the applicant PIPELINE publisher's
  // condition, so it may only ever read that publisher's stamp. The Applicants
  // tab's own feed is a different system on a different clock; borrowing its
  // updatedAt made the card say "Sending" for a publisher that has never run,
  // and made it quote a 3-minute cadence on the strength of someone else's
  // timestamp. The tab feed's age belongs to the Applicants-tab strip alone.
  const publishAt = isoOrNull(pipeline?.generatedAt);
  const publishSource = "the pipeline's publish";
  const laneEnabled = typeof pipeline?.laneEnabled === "boolean" ? pipeline.laneEnabled : null;
  const stopReason = typeof pipeline?.stopReason === "string" && pipeline.stopReason.trim()
    ? pipeline.stopReason.trim() : null;
  // The second witness the page needs before it may say "Not running": the
  // desktop health reporter publishing whether the job is loaded (step 3).
  const jobLoaded = typeof pipeline?.jobLoaded === "boolean" ? pipeline.jobLoaded : null;
  const base = { laneEnabled, stopReason, publishAt, publishSource };

  if (!publishAt) {
    return {
      ...base, stateId: "cannot-tell", reason: "never-published",
      caption: "the applicant pipeline has never published here (its publisher arrives in step 3), so I cannot tell whether it is on",
    };
  }
  const ageMs = msSince(publishAt, nowMs);
  const clock = pacificClock(publishAt);
  // A future-dated publish is not a fresh one. `ageMs < STALE` passes for any
  // negative age, so a publisher with a wrong clock would render green.
  if (ageMs != null && ageMs < 0) {
    return {
      ...base, stateId: "cannot-tell", reason: "clock-skew",
      caption: `the last publish is stamped ${humanAge(-ageMs)} in the future${clock ? ` (${clock})` : ""}, so I cannot tell how old it really is`,
    };
  }
  const fresh = ageMs != null && ageMs >= 0 && ageMs < APPLICANT_STALE_MS;
  if (fresh) {
    if (laneEnabled === false) {
      return {
        ...base, stateId: "not-sending-yet", reason: "lane-off",
        caption: `from ${publishSource}, ${humanAge(ageMs)} ago`,
      };
    }
    if (laneEnabled === true) {
      return {
        ...base, stateId: "sending", reason: "publishing",
        caption: `from ${publishSource}, ${humanAge(ageMs)} ago`,
      };
    }
    return {
      ...base, stateId: "cannot-tell", reason: "lane-unknown",
      caption: `${publishSource} is ${humanAge(ageMs)} old, but nothing says whether the invite emails are switched on`,
    };
  }
  if (stopReason) {
    return {
      ...base, stateId: "paused", reason: "stopped-on-purpose",
      caption: `Paused on purpose · ${stopReason} · since ${clock || "the last publish"}`,
    };
  }
  if (jobLoaded === false) {
    return {
      ...base, stateId: "not-running", reason: "second-witness",
      caption: `nothing published since ${clock || "the last publish"} and the job is not loaded on your Mac · no reason recorded`,
    };
  }
  return {
    ...base, stateId: "cannot-tell", reason: "stale-publish",
    caption: `nothing published for ${humanAge(ageMs) || "a while"}${clock ? ` (since ${clock})` : ""}; it publishes every 3 minutes when it is up. I cannot tell whether you paused it or it stopped.`,
  };
}

// ── the drawn flows ─────────────────────────────────────────────────────────
/** Resolve a catalog row's declared flow against the published payloads.
 *  Never invents a number: an unresolvable path is null and draws "—" (R5).
 *  Never derives one either: every count comes from one published field (R1). */
export function flowFor(row, ctx, { nowMs = Date.now(), sourceAges = {} } = {}) {
  const declared = row?.flow;
  const poolLink = typeof row?.poolLink === "string" && row.poolLink ? row.poolLink : null;
  if (!declared || !Array.isArray(declared.stages)) return null;
  const evidence = [];
  const pending = [];
  const unusable = [];
  const stages = [];
  for (const st of declared.stages) {
    const raw = st.countKey ? rawNumberAt(ctx, st.countKey) : null;
    const negative = raw != null && raw < 0;
    const count = negative ? null : raw;
    if (st.onlyWhenPositive && !(count > 0)) continue;
    const stageBasis = st.countKey ? basisForPath(ctx, st.countKey) : BASIS.measured;
    // Every box carries where it came from and how old it is, so the answer
    // is one hover away and not only inside the evidence drawer (PRD §4.6).
    const src = sourceAges[st.step] || null;
    const srcAge = src?.at ? humanAge(msSince(src.at, nowMs)) : null;
    const out = {
      id: st.id,
      label: st.label,
      count,
      basis: stageBasis,
      source: src?.endpoint
        ? { endpoint: src.endpoint, age: srcAge, when: src.at ? whenSentence(src.at, nowMs) : null }
        : null,
      ...(st.accent ? { accent: st.accent } : {}),
      // A box counts people unless it SAYS otherwise (R3).
      ...(st.unit ? { unit: st.unit } : {}),
    };
    if (st.poolKey) {
      out.kind = "pool";
      // Clicking a bucket opens the tab that holds those people (PRD §4.6).
      if (poolLink) out.link = poolLink;
      const list = resolveList(ctx, st.poolKey);
      if (list) {
        const all = list
          .map((entry) => ({
            code: String(entry?.code ?? ""),
            label: typeof entry?.label === "string" && entry.label.trim() ? entry.label.trim() : null,
            count: finiteOrNull(entry?.count),
            basis: entry?.basis === "inferred" ? BASIS.inferred : BASIS.measured,
          }))
          .filter((entry) => entry.count != null)
          .sort((a, b) => b.count - a.count);
        // A negative bucket cannot be a number of people either: it never
        // becomes a tile, and the evidence drawer names it as unusable.
        const entries = all.filter((entry) => entry.count >= 0);
        for (const bad of all.filter((entry) => entry.count < 0)) {
          unusable.push({ id: `${st.id}:${bad.code || "unknown"}`, label: bad.label || st.label });
        }
        const tiles = entries.slice(0, POOL_TILE_CAP).map((entry) => {
          // Post-call copy is fixed in this repo because those states are code;
          // applicant copy comes ONLY from the payload (R14). Either way an
          // unknown code names itself rather than borrowing someone's words.
          const copy = st.poolCopy === "review-state" ? reviewStateCopy(entry.code) : null;
          const label = copy ? copy.tile : (entry.label || reviewStateCopy(entry.code).tile);
          return {
            id: entry.code || "unknown",
            label,
            count: entry.count,
            basis: entry.basis,
            ...(poolLink ? { link: poolLink } : {}),
            ...(st.tileAccent ? { accent: st.tileAccent } : {}),
          };
        });
        const rest = entries.slice(POOL_TILE_CAP);
        if (rest.length) {
          tiles.push({
            id: "overflow",
            label: `Other (${rest.length})`,
            count: rest.reduce((a, e) => a + e.count, 0),
            ...(st.tileAccent ? { accent: st.tileAccent } : {}),
          });
        }
        out.tiles = tiles;
        for (const entry of all) {
          const copy = st.poolCopy === "review-state" ? reviewStateCopy(entry.code) : null;
          evidence.push({
            label: copy ? copy.tile : (entry.label || reviewStateCopy(entry.code).tile),
            value: entry.count < 0 ? null : entry.count,
            field: `${st.poolKey}[${entry.code}]`,
            endpoint: sourceAges[st.step]?.endpoint || null,
            at: sourceAges[st.step]?.at || null,
            basis: entry.basis,
            sentence: copy ? copy.sentence : null,
            code: entry.code || null,
            ...(entry.count < 0 ? { step: UNUSABLE_NEGATIVE } : {}),
          });
        }
      } else {
        out.tiles = [];
      }
      if (st.tileAccent && !out.accent) out.accent = st.tileAccent;
    }
    // A plain caption under the label (never a number): "no-show, broke,
    // too short". drawFlow renders it as a small grey line.
    if (st.note) out.note = st.note;
    stages.push(out);
    if (negative) {
      unusable.push({ id: st.id, label: st.label });
    } else if (count == null) {
      pending.push({ id: st.id, label: st.label, step: st.step || null, note: st.stepNote || null });
    }
    evidence.push({
      label: st.label,
      value: count,
      field: st.countKey || null,
      endpoint: sourceAges[st.step]?.endpoint || null,
      at: sourceAges[st.step]?.at || null,
      basis: stageBasis,
      sentence: null,
      code: null,
      step: negative ? UNUSABLE_NEGATIVE : (count == null ? (st.step || null) : null),
    });
  }
  const present = new Set(stages.map((s) => s.id));
  const edges = (declared.edges || []).filter((e) => Array.isArray(e) && present.has(e[0]) && present.has(e[1]));
  return { flow: { counted: true, stages, edges }, pending, unusable, evidence, note: declared.note || null };
}

// ── "since you last looked" (PRD §4.7) ──────────────────────────────────────
const TRACKED = {
  "post-call": [
    { key: "funnel.accepted", label: "sent" },
    { key: "funnel.delivered", label: "delivered" },
    { key: "funnel.openToday", label: "waiting on a person" },
    { key: "metrics.open", label: "waiting on a person, all time" },
  ],
  applicant: [
    { key: "pipeline.captured", label: "captured" },
    { key: "pipeline.holdsTotal", label: "waiting on you" },
    { key: "pipeline.invited", label: "with an invite created" },
    { key: "counts.queue", label: "waiting on you on the Applicants tab" },
  ],
};

export function snapshotFor(systemId, { stateId, ctx }) {
  const counts = {};
  for (const t of TRACKED[systemId] || []) {
    const v = resolvePath(ctx, t.key);
    if (v != null) counts[t.key] = v;
  }
  return { stateId, counts };
}

/** What changed between two snapshots, in David's words. Never a fake event:
 *  a count that was not published before produces nothing. */
export function diffEvents(systemId, prev, next, atIso) {
  if (!prev || typeof prev !== "object") return [];
  const events = [];
  if (prev.stateId && next.stateId && prev.stateId !== next.stateId) {
    events.push({
      at: atIso,
      text: `went from ${STATE_WORDS[prev.stateId] || prev.stateId} to ${STATE_WORDS[next.stateId] || next.stateId}`,
    });
  }
  for (const t of TRACKED[systemId] || []) {
    const before = prev.counts?.[t.key];
    const after = next.counts?.[t.key];
    if (typeof before !== "number" || typeof after !== "number" || before === after) continue;
    const delta = after - before;
    events.push({
      at: atIso,
      text: delta > 0 ? `${delta} more ${t.label}` : `${-delta} fewer ${t.label}`,
    });
  }
  return events;
}

// ── the aggregator ──────────────────────────────────────────────────────────
async function safeApphubGet(key) {
  try { return await apphubGetJson(key); } catch { return null; }
}

/** A KV read that is out must not blank the page: it renders as "no signal"
 *  on that source, which is the honest answer (R6). */
async function tolerant(promise) {
  try { return await promise; } catch { return null; }
}

export async function buildState({
  nowMs = Date.now(),
  fetchImpl = fetch,
  actorEmail = "",
  kv = { vGet, vSet },
  apphub = { getJson: safeApphubGet },
  upstreamImpl = postCallUpstream,
  postCallReady = null,
  healthCatalog = healthById,
  beatRead = readBeat,
  systems = SYSTEMS,
} = {}) {
  const configured = postCallReady == null
    ? (() => { const c = postCallConfig(); return Boolean(c.base && c.key); })()
    : Boolean(postCallReady);

  // 1. One read each: three memos and two KV docs, in parallel.
  const [healthMemo, metricsMemo, funnelMemo, countsDoc, pipelineDoc] = await Promise.all([
    tolerant(kv.vGet(K.health)),
    tolerant(kv.vGet(K.metrics)),
    tolerant(kv.vGet(K.funnel)),
    tolerant(apphub.getJson(APPHUB.counts)),
    tolerant(apphub.getJson(PIPELINE_KEY)),
  ]);
  const watchdogBeat = await tolerant(Promise.resolve().then(() => beatRead(WATCHDOG_LANE_ID)));

  // 2. Refresh whatever is stale. A warm page view fetches nothing at all.
  const [health, metrics, funnel] = await Promise.all([
    readHealth({ nowMs, fetchImpl, kv, memo: healthMemo }),
    readReviewFeed({
      kind: "metrics", nowMs, kv, memo: metricsMemo, actorEmail,
      upstreamImpl, fetchImpl, cacheKey: K.metrics, configured,
    }),
    readReviewFeed({
      kind: "funnel", nowMs, kv, memo: funnelMemo, actorEmail,
      upstreamImpl, fetchImpl, cacheKey: K.funnel, configured,
    }),
  ]);

  const metricsData = metrics.memo?.ok ? metrics.memo.data : null;
  const funnelData = funnel.memo?.ok ? funnel.memo.data : null;
  const counts = countsDoc && typeof countsDoc === "object" ? countsDoc : null;
  const pipeline = pipelineDoc && typeof pipelineDoc === "object" && !Array.isArray(pipelineDoc)
    ? pipelineDoc : null;

  // 3. The sources register — including the ones that have never answered.
  const watchdogRegistered = Boolean(healthCatalog?.get?.(WATCHDOG_LANE_ID));
  const sourceState = {
    "live-check": health.memo?.outcome?.ok
      ? { state: "answered", at: health.memo.outcome.at, endpoint: "the post-call health check" }
      : {
        state: "no-signal",
        at: health.memo?.dataAt || null,
        endpoint: "the post-call health check",
        detail: health.memo?.outcome
          ? `the last read did not answer (${health.memo.outcome.error || "no answer"})`
          : "not read yet",
      },
    "review-data": metricsData
      ? { state: "answered", at: metrics.memo.dataAt, endpoint: "the signed Review feed" }
      : {
        state: "no-signal", at: metrics.memo?.dataAt || null, endpoint: "the signed Review feed",
        detail: metrics.memo?.state === "unconfigured"
          ? "this dashboard has no connection to the post-call service"
          : "the last read did not answer",
      },
    "post-call-funnel": funnelData
      ? { state: "answered", at: funnel.memo.dataAt, endpoint: "the signed Review feed" }
      : funnel.memo?.state === "unconfigured"
        ? {
          state: "no-signal", at: null, endpoint: "the signed Review feed",
          detail: "this dashboard has no connection to the post-call service",
        }
        : {
          state: funnel.memo?.state === "no-publisher" ? "never-registered" : "no-signal",
          at: null,
          endpoint: "the signed Review feed",
          detail: "no publisher yet — it arrives in step 2",
        },
    "applicants-feed": counts?.updatedAt
      ? { state: "answered", at: isoOrNull(counts.updatedAt), endpoint: "the Applicants tab's own counts" }
      : { state: "never-registered", at: null, endpoint: "the Applicants tab's own counts", detail: "nothing has published counts yet" },
    "applicant-pipeline": pipeline?.generatedAt
      ? { state: "answered", at: isoOrNull(pipeline.generatedAt), endpoint: "the applicant pipeline publish" }
      : { state: "never-registered", at: null, endpoint: "the applicant pipeline publish", detail: "no publisher yet — it arrives in step 3" },
    "watchdog-beat": watchdogRegistered
      ? (isoOrNull(watchdogBeat?.at)
        ? {
          state: "answered",
          at: isoOrNull(watchdogBeat.at),
          endpoint: "the Monitor's beat sink",
          detail: watchdogBeat.status && watchdogBeat.status !== "ok"
            ? `its last check-in reported: ${String(watchdogBeat.status)}`
            : "it checks in every 10 minutes",
        }
        : {
          state: "no-signal", at: null, endpoint: "the Monitor's beat sink",
          detail: "the lane is registered, but this dashboard holds no check-in from it",
        })
      : { state: "never-registered", at: null, endpoint: "the Monitor's beat sink", detail: "the watchdog's check-in is rejected because this lane is not in the beat catalog — step 2" },
  };
  const sources = SOURCES.map((s) => {
    const observed = sourceState[s.id] || { state: "no-signal", at: null };
    return {
      id: s.id,
      name: s.name,
      detail: observed.detail || s.detail,
      endpoint: observed.endpoint || null,
      at: observed.at || null,
      age: observed.at ? humanAge(msSince(observed.at, nowMs)) : null,
      when: observed.at ? whenSentence(observed.at, nowMs) : null,
      state: observed.state,
    };
  });
  // The headline stamp takes the OLDEST source that actually answered, and
  // names it (R10). A source that never answered cannot set the headline; it
  // is listed in the expander instead, which is the honest place for it.
  let oldest = null;
  for (const s of sources) {
    const t = Date.parse(String(s.at || ""));
    if (!Number.isFinite(t)) continue;
    if (!oldest || t < oldest.t) oldest = { id: s.id, name: s.name, at: s.at, t };
  }

  // 4. Per-system resolution.
  const stepSources = {
    "step 2": { endpoint: "the signed Review feed (funnel)", at: funnel.memo?.dataAt || null },
    "step 3": { endpoint: "the applicant pipeline publish", at: isoOrNull(pipeline?.generatedAt) },
    "step 3b": { endpoint: "the applicant invite lane", at: null },
  };
  const contexts = {
    "post-call": { funnel: funnelData || null, metrics: metricsData || null },
    applicant: { pipeline, counts },
  };
  const postCallState = postCallStateFrom({ health: health.memo, nowMs });
  const applicantState = applicantStateFrom({ pipeline, counts, nowMs });
  const stateById = { "post-call": postCallState, applicant: applicantState };

  const out = [];
  for (const row of systems) {
    const ctx = contexts[row.id] || {};
    const state = stateById[row.id] || {
      stateId: "cannot-tell", caption: "no signal for this system", pulse: false,
    };
    const resolved = flowFor(row, ctx, { nowMs, sourceAges: stepSources }) || {
      flow: null, pending: [], unusable: [], evidence: [], note: null,
    };
    const chips = [];
    if (row.id === "applicant" && applicantState.laneEnabled === false) {
      chips.push({
        stateId: "not-sending-yet",
        word: STATE_WORDS["not-sending-yet"],
        text: "the invite email lane is switched off (your call)",
      });
    }
    const strips = row.id === "post-call"
      ? [allTimeStrip({ metrics: metricsData, memo: metrics.memo, nowMs })]
      : [applicantsTabStrip({ counts, nowMs })];
    const spine = worstState([state.stateId, ...chips.map((c) => c.stateId)]);
    const ages = sourcesForSystem(row.id, sources);
    out.push({
      id: row.id,
      name: row.name,
      summary: row.summary,
      clockLabel: row.clockLabel,
      clockNote: row.clockNote,
      state: {
        id: state.stateId,
        word: STATE_WORDS[state.stateId],
        tone: STATE_TONE[state.stateId],
        caption: state.caption,
        pulse: Boolean(state.pulse),
        lastGood: state.lastGood || null,
      },
      warn: state.warn || null,
      incident: state.incident || null,
      chips,
      spineTone: STATE_TONE[spine],
      flow: resolved.flow,
      flowNote: resolved.note,
      pending: resolved.pending,
      unusable: resolved.unusable,
      strips,
      links: row.links,
      poolLink: row.poolLink,
      ages,
      evidence: resolved.evidence.concat(stripEvidence(strips)),
      events: [],
    });
  }

  // 5. The change ring, per system (PRD §4.7). Written only when something
  //    actually moved, so a quiet page costs one KV read per system.
  const atIso = new Date(nowMs).toISOString();
  await Promise.all(out.map(async (system) => {
    const snapshot = snapshotFor(system.id, {
      stateId: system.state.id, ctx: contexts[system.id] || {},
    });
    const [prev, ring] = await Promise.all([
      tolerant(kv.vGet(K.last(system.id))),
      tolerant(kv.vGet(K.events(system.id))),
    ]);
    const existing = Array.isArray(ring) ? ring : [];
    const fresh = diffEvents(system.id, prev, snapshot, atIso);
    const next = fresh.length ? [...existing, ...fresh].slice(-EVENT_CAP) : existing;
    system.events = next;
    if (fresh.length || !prev) {
      await Promise.all([
        tolerant(kv.vSet(K.last(system.id), snapshot, RING_TTL_S)),
        ...(fresh.length ? [tolerant(kv.vSet(K.events(system.id), next, RING_TTL_S))] : []),
      ]);
    }
  }));

  // 6. The to-do strip — only things exclusively David can do (R9).
  const todoCtx = { "post-call": postCallState, applicant: applicantState };
  const todos = TODO_RULES.filter((rule) => {
    try { return rule.onlyDavid && rule.when(todoCtx); } catch { return false; }
  }).map((rule) => ({
    id: rule.id, label: rule.label, detail: rule.detail, command: rule.command || null,
  }));

  return {
    ok: true,
    generatedAt: atIso,
    asOf: oldest
      ? { at: oldest.at, sourceId: oldest.id, sourceName: oldest.name, when: whenSentence(oldest.at, nowMs) }
      : null,
    sources,
    todos,
    systems: out,
    footer: FOOTER,
  };
}

function sourcesForSystem(systemId, sources) {
  const wanted = systemId === "post-call"
    ? ["live-check", "review-data", "post-call-funnel", "watchdog-beat"]
    : ["applicants-feed", "applicant-pipeline"];
  return sources.filter((s) => wanted.includes(s.id))
    .map((s) => ({ id: s.id, name: s.name, age: s.age, state: s.state }));
}

/** The all-time Review strip — its own clock, and it says so (R2). */
export function allTimeStrip({ metrics, memo, nowMs }) {
  const at = memo?.dataAt || null;
  if (!metrics) {
    return {
      id: "post-call-all-time",
      label: "All time",
      clock: "from the Review data",
      cannotTell: memo?.state === "unconfigured"
        ? "Cannot tell: this dashboard has no connection to the post-call service."
        : "Cannot tell: the Review data did not answer.",
      items: [], buckets: [], sentence: null, at: null, when: null,
      link: { label: "open Review", href: "/#review" },
    };
  }
  const num = (key) => countOrNull(metrics[key]);
  return {
    id: "post-call-all-time",
    label: "All time",
    clock: "from the Review data",
    cannotTell: null,
    items: [
      { key: "open", label: "Waiting on a person", value: num("open"), basis: basisOf(metrics, "open") },
      { key: "overdue", label: "overdue", value: num("overdue"), basis: basisOf(metrics, "overdue") },
      { key: "failed", label: "terminal failures", value: num("failed"), basis: basisOf(metrics, "failed") },
    ],
    buckets: [
      { key: "identityProfile", label: "Identity or profile", value: num("identityProfile") },
      { key: "missingInformation", label: "Missing information", value: num("missingInformation") },
      { key: "matchingCalibration", label: "Matching or calibrating", value: num("matchingCalibration") },
      { key: "delivery", label: "Delivery unproven", value: num("delivery") },
    ],
    sentence: clearingSentence(metrics.medianResolutionSeconds, metrics.p95ResolutionSeconds),
    incidents: Array.isArray(metrics.incidents) ? metrics.incidents.length : null,
    at,
    when: at ? whenSentence(at, nowMs) : null,
    link: { label: "open Review", href: "/#review" },
  };
}

/** The Applicants-tab strip — the counts the tab itself reads, its own clock. */
export function applicantsTabStrip({ counts, nowMs }) {
  const at = isoOrNull(counts?.updatedAt);
  // The feed's own account of a failed generation, when it latches one. Its
  // sentence, verbatim, and no numbers beside it — the tab is showing the same
  // sentence, and the two surfaces must not disagree (PRD §4.5).
  const verification = typeof counts?.verification === "string" && counts.verification.trim()
    ? counts.verification.trim() : null;
  if (verification) {
    return {
      id: "applicants-tab",
      label: "Applicants tab",
      clock: "from the tab's own feed",
      cannotTell: `${STATE_WORDS["cannot-tell"]}: ${verification}`,
      items: [], buckets: [], sentence: null, at, when: at ? whenSentence(at, nowMs) : null,
      link: { label: "open Applicants", href: "/#applicants" },
    };
  }
  if (!counts) {
    return {
      id: "applicants-tab",
      label: "Applicants tab",
      clock: "from the tab's own feed",
      cannotTell: "Cannot tell: the tab's own feed has not published any counts.",
      items: [], buckets: [], sentence: null, at: null, when: null,
      link: { label: "open Applicants", href: "/#applicants" },
    };
  }
  const num = (key) => countOrNull(counts[key]);
  const ageMs = msSince(at, nowMs);
  const stale = ageMs != null && ageMs >= APPLICANT_FEED_STALE_MS;
  return {
    id: "applicants-tab",
    label: "Applicants tab",
    clock: "from the tab's own feed",
    cannotTell: null,
    stale,
    staleNote: stale
      ? `the tab's own feed has not published since ${whenSentence(at, nowMs)}, so these are the last numbers it stored, not current ones`
      : null,
    items: [
      { key: "queue", label: "Waiting on you", value: num("queue"), basis: basisOf(counts, "queue") },
      { key: "stream", label: "In the invite stream", value: num("stream"), basis: basisOf(counts, "stream") },
      { key: "profilePreparing", label: "Profiles preparing", value: num("profilePreparing"), basis: basisOf(counts, "profilePreparing"), step: "step 3" },
      { key: "total", label: "In total", value: num("total"), basis: basisOf(counts, "total"), step: "step 3" },
    ],
    buckets: [],
    sentence: null,
    // The tab's own count-drop tripwire. Display-only, and the page says whose
    // warning it is rather than turning it into a state word.
    alert: counts.alert
      ? "The tab's own count warning is on: a publish came back much smaller than the one before it."
      : null,
    at,
    when: at ? whenSentence(at, nowMs) : null,
    link: { label: "open Applicants", href: "/#applicants" },
  };
}

function stripEvidence(strips) {
  const rows = [];
  for (const strip of strips || []) {
    for (const item of [...(strip.items || []), ...(strip.buckets || [])]) {
      rows.push({
        label: `${item.label} (${strip.label})`,
        value: item.value ?? null,
        field: item.key,
        endpoint: strip.id === "applicants-tab" ? "the Applicants tab's own counts" : "the signed Review feed",
        at: strip.at || null,
        basis: item.basis || "measured",
        sentence: null,
        code: null,
        step: item.value == null ? (item.step || null) : null,
      });
    }
  }
  return rows;
}

export default async function handler(req, res) {
  if (cors(req, res)) return;
  // This page reads and never writes (R20).
  if (String(req.method || "GET").toUpperCase() !== "GET") {
    res.setHeader("cache-control", "no-store");
    return res.status(405).json({ ok: false, error: "GET only" });
  }
  if (!(await requireAuth(req, res))) return;
  res.setHeader("cache-control", "no-store");
  try {
    return res.status(200).json(await buildState({ actorEmail: req.authedEmail || "" }));
  } catch (e) {
    // An honest error state rather than a blank page.
    return res.status(500).json({ ok: false, error: String(e?.message || e).slice(0, 160) });
  }
}

export { STATE_WORDS, SYSTEM_IDS, STATE_RANK };
