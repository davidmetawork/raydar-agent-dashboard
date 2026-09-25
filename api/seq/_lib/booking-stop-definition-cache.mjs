// ─────────────────────────────────────────────────────────────────────────────
// BOOKING-STOP DEFINITION CACHE — pure helpers for discoverBookingStopSequences.
//
// WHY: every refresh and every sweep used to re-read all ~271 non-cold
// sequence definitions (campaigns.getCampaign), 144 times a day each: about
// 95-98% of Raydar's Paraform reads (measured 2026-09-25). A definition feeds
// exactly one decision, "does it carry a candidate scheduling link", and that
// answer rarely changes. The catalog has no updated_at / version / step count,
// so nothing proves a definition is unchanged; the cache therefore trusts an
// answer only for a bounded time, and bounds it hardest where a stale answer
// could shrink protection.
//
// SAFETY ARGUMENT (fail toward protection):
//   A row is selected when it is not cold-excluded AND (its name matches a
//   nudge key OR it is enabled and link-bearing). So a stale cached value can
//   shrink scope in exactly one case: a cached "no link" on an enabled,
//   name-unmatched, not-excluded row (the "danger class"). The class is
//   recomputed at USE time from the live catalog row and the current keys and
//   policy, never stored. Danger-class answers are trusted only after a settle
//   confirmation and only for NO_LINK_MAX_AGE; all others for MAX_AGE.
//   - n (name hash) and e (enabled) must equal the live catalog row, so a new
//     id, a rename or an enable flip in either direction forces a read.
//   - The document is keyed to the running deployment, so any code change
//     (matcher, keys logic, this file) forces fresh reads.
//   - r (read time) only ever comes from a real read. Merging, racing writers
//     and carry-over can cost re-reads but can never lengthen a trust window.
//   - Anything malformed, future-dated, foreign or oversized is a miss.
// Entries hold no step text, no PII and no secrets: {n, e, l, r, f} per id.
// ─────────────────────────────────────────────────────────────────────────────

import { createHash } from "node:crypto";
import {
  BOOKING_STOP_DEFINITION_CACHE_MAX_BYTES,
  BOOKING_STOP_DEFINITION_CACHE_MAX_ENTRIES,
  BOOKING_STOP_DEFINITION_CACHE_SCHEMA,
  BOOKING_STOP_DEFINITION_MAX_AGE_MS,
  BOOKING_STOP_DEFINITION_NO_LINK_MAX_AGE_MS,
  BOOKING_STOP_DEFINITION_ROTOR_HORIZON_MS,
  BOOKING_STOP_DEFINITION_ROTOR_MAX_READS,
  BOOKING_STOP_DEFINITION_SETTLE_MS,
} from "./booking-stop-contract.mjs";

const NAME_HASH = /^[a-f0-9]{64}$/u;

/**
 * The cache never outlives a deployment: a cached answer is only as safe as
 * the code that computed it. With no deployment identity (local runs, tests,
 * CLI deploys without a sha) or with BOOKING_STOP_DEFINITION_CACHE=off the
 * cache is disabled and every load reads every definition, exactly as before.
 */
export function bookingStopDefinitionCacheRevision(env = process.env) {
  if (
    String(env?.BOOKING_STOP_DEFINITION_CACHE || "").trim().toLowerCase()
      === "off"
  ) {
    return null;
  }
  const revision = String(
    env?.VERCEL_DEPLOYMENT_ID || env?.VERCEL_GIT_COMMIT_SHA || "",
  ).trim();
  return revision && revision.length <= 128 ? revision : null;
}

/** Structural validity of one stored entry at `nowMs`. */
export function definitionCacheEntryWellFormed(entry, nowMs) {
  return Boolean(
    entry
    && typeof entry === "object"
    && !Array.isArray(entry)
    && typeof entry.n === "string"
    && NAME_HASH.test(entry.n)
    && typeof entry.e === "boolean"
    && typeof entry.l === "boolean"
    && Number.isFinite(entry.r)
    && Number.isFinite(entry.f)
    && entry.f <= entry.r
    && Number.isFinite(nowMs)
    && entry.r <= nowMs
  );
}

function plainEntry(entry) {
  return { n: entry.n, e: entry.e, l: entry.l, r: entry.r, f: entry.f };
}

/**
 * Parse a stored document. Returns `{ state, entries }` where `entries` is a
 * Map of well-formed entries and `state` is one of: missing, invalid,
 * foreign_revision, oversize, warm. Only `warm` yields entries.
 */
export function readDefinitionCacheDocument(doc, { revision, nowMs }) {
  const empty = (state) => ({ state, entries: new Map() });
  if (doc == null) return empty("missing");
  if (
    typeof doc !== "object"
    || Array.isArray(doc)
    || doc.schema !== BOOKING_STOP_DEFINITION_CACHE_SCHEMA
    || !doc.entries
    || typeof doc.entries !== "object"
    || Array.isArray(doc.entries)
  ) {
    return empty("invalid");
  }
  if (typeof revision !== "string" || !revision || doc.revision !== revision) {
    return empty("foreign_revision");
  }
  let bytes = Infinity;
  try {
    bytes = Buffer.byteLength(JSON.stringify(doc), "utf8");
  } catch {
    return empty("invalid");
  }
  const ids = Object.keys(doc.entries);
  if (
    ids.length > BOOKING_STOP_DEFINITION_CACHE_MAX_ENTRIES
    || bytes > BOOKING_STOP_DEFINITION_CACHE_MAX_BYTES
  ) {
    return empty("oversize");
  }
  const entries = new Map();
  for (const id of ids) {
    const entry = doc.entries[id];
    if (id && definitionCacheEntryWellFormed(entry, nowMs)) {
      entries.set(id, plainEntry(entry));
    }
  }
  return { state: "warm", entries };
}

// Newer real read wins. On an exact tie prefer "has link" (only widens scope),
// then the later first-seen time (less settled, so re-read sooner).
function newerEntry(left, right) {
  if (!left) return right;
  if (!right) return left;
  if (left.r !== right.r) return left.r > right.r ? left : right;
  if (left.l !== right.l) return left.l ? left : right;
  return left.f >= right.f ? left : right;
}

/** Per-id merge of entry Maps keeping, for each id, the newer real read. */
export function mergeDefinitionEntries(...sources) {
  const merged = new Map();
  for (const source of sources) {
    if (!(source instanceof Map)) continue;
    for (const [id, entry] of source) {
      merged.set(id, newerEntry(merged.get(id), entry));
    }
  }
  return merged;
}

/**
 * Decide whether a cached entry may stand in for a read of this row now.
 * `nudge` is whether the live row's name matches a current selection key;
 * the caller only asks for rows that are not cold-excluded.
 */
export function definitionCacheDecision(entry, {
  nameSha256,
  enabled,
  nudge,
  nowMs,
}) {
  if (!definitionCacheEntryWellFormed(entry, nowMs)) {
    return { use: false, reason: entry == null ? "missing" : "invalid" };
  }
  if (entry.n !== nameSha256 || entry.e !== Boolean(enabled)) {
    return { use: false, reason: "changed" };
  }
  const dangerClass = !entry.l && Boolean(enabled) && !nudge;
  if (dangerClass && entry.r - entry.f < BOOKING_STOP_DEFINITION_SETTLE_MS) {
    return { use: false, reason: "unsettled", dangerClass };
  }
  const maxAgeMs = dangerClass
    ? BOOKING_STOP_DEFINITION_NO_LINK_MAX_AGE_MS
    : BOOKING_STOP_DEFINITION_MAX_AGE_MS;
  const ageMs = nowMs - entry.r;
  if (ageMs >= maxAgeMs) {
    return { use: false, reason: "expired", dangerClass, ageMs };
  }
  return { use: true, reason: "hit", dangerClass, ageMs };
}

/**
 * The entry a real read produces. An unchanged (n, e, l) keeps its first-seen
 * time; any change starts a new state at this read.
 */
export function nextDefinitionEntry(prior, {
  nameSha256,
  enabled,
  linkBearing,
  readAtMs,
}) {
  const e = Boolean(enabled);
  const l = Boolean(linkBearing);
  const unchanged = Boolean(
    prior
    && prior.n === nameSha256
    && prior.e === e
    && prior.l === l
    && Number.isFinite(prior.f)
    && prior.f <= readAtMs
  );
  return {
    n: nameSha256,
    e,
    l,
    r: readAtMs,
    f: unchanged ? prior.f : readAtMs,
  };
}

function stableIdHash(id) {
  return createHash("sha256").update(String(id)).digest("hex");
}

export function definitionRotorQuota(classCount, maxAgeMs) {
  if (!Number.isInteger(classCount) || classCount <= 0) return 0;
  return Math.ceil(
    (classCount * BOOKING_STOP_DEFINITION_ROTOR_HORIZON_MS)
      / (maxAgeMs - BOOKING_STOP_DEFINITION_ROTOR_HORIZON_MS),
  );
}

/**
 * Choose this run's proactive re-reads: the oldest-verified cached entries of
 * each class, at least one rotor horizon old, oldest first (stable id hash
 * breaks ties), danger class first, capped in total. Only ever makes a read
 * happen EARLIER than its bound would force it.
 */
export function selectDefinitionRotorReads(candidates, {
  nowMs,
  dangerClassCount,
  otherCount,
  maxReads = BOOKING_STOP_DEFINITION_ROTOR_MAX_READS,
}) {
  const order = (left, right) =>
    left.r - right.r
    || (stableIdHash(left.id) < stableIdHash(right.id) ? -1 : 1);
  const eligible = (candidates || []).filter(({ r }) =>
    Number.isFinite(r)
    && nowMs - r >= BOOKING_STOP_DEFINITION_ROTOR_HORIZON_MS);
  const danger = eligible.filter(({ dangerClass }) => dangerClass).sort(order)
    .slice(0, definitionRotorQuota(
      dangerClassCount,
      BOOKING_STOP_DEFINITION_NO_LINK_MAX_AGE_MS,
    ));
  const other = eligible.filter(({ dangerClass }) => !dangerClass).sort(order)
    .slice(0, definitionRotorQuota(
      otherCount,
      BOOKING_STOP_DEFINITION_MAX_AGE_MS,
    ));
  return [...danger, ...other].slice(0, Math.max(0, maxReads))
    .map(({ id }) => id);
}

/** Build a storable document, or null when it would break a size cap. */
export function buildDefinitionCacheDocument({ revision, nowMs, entries }) {
  if (entries.size > BOOKING_STOP_DEFINITION_CACHE_MAX_ENTRIES) return null;
  const doc = {
    schema: BOOKING_STOP_DEFINITION_CACHE_SCHEMA,
    revision,
    at: new Date(nowMs).toISOString(),
    entries: Object.fromEntries(
      [...entries].map(([id, entry]) => [id, plainEntry(entry)]),
    ),
  };
  return Buffer.byteLength(JSON.stringify(doc), "utf8")
    > BOOKING_STOP_DEFINITION_CACHE_MAX_BYTES
    ? null
    : doc;
}

const TELEMETRY_COUNTS = [
  "freshReads",
  "requiredReads",
  "rotorReads",
  "rotorPlanned",
  "rotorFailures",
  "cacheHits",
  "staleFalseCorrections",
];
const TELEMETRY_AGES = [
  "oldestDangerClassAgeMs",
  "oldestOtherAgeMs",
  "staleFalseCorrectionMaxAgeMs",
];
const TELEMETRY_STATES = new Set([
  "disabled", "missing", "invalid", "foreign_revision", "oversize", "warm",
  "read_error",
]);
const TELEMETRY_WRITES = new Set([
  "disabled", "not_needed", "written", "failed", "oversize",
]);

/**
 * Counts-only projection of one scope load's cache telemetry, safe to store
 * in KV and return from an endpoint. Unknown or malformed input yields null.
 */
export function definitionCacheTelemetry(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const out = {
    state: TELEMETRY_STATES.has(value.state) ? value.state : null,
    write: TELEMETRY_WRITES.has(value.write) ? value.write : null,
  };
  for (const key of TELEMETRY_COUNTS) {
    out[key] = Number.isInteger(value[key]) && value[key] >= 0
      ? value[key]
      : 0;
  }
  for (const key of TELEMETRY_AGES) {
    out[key] = Number.isFinite(value[key]) && value[key] >= 0
      ? Math.round(value[key])
      : null;
  }
  return out;
}

/** Sum several loads' telemetry (a publishing refresh does two loads). */
export function summarizeDefinitionCacheTelemetry(loads) {
  const valid = (loads || []).map(definitionCacheTelemetry).filter(Boolean);
  if (!valid.length) return null;
  const out = {
    loads: valid.length,
    states: valid.map(({ state }) => state),
    writes: valid.map(({ write }) => write),
  };
  for (const key of TELEMETRY_COUNTS) {
    out[key] = valid.reduce((sum, load) => sum + load[key], 0);
  }
  for (const key of TELEMETRY_AGES) {
    const ages = valid.map((load) => load[key]).filter((age) => age != null);
    out[key] = ages.length ? Math.max(...ages) : null;
  }
  return out;
}

/**
 * The one alert this cache raises, or null. A stale-false correction is the
 * measured protection gap actually being hit: a fresh read found a scheduling
 * link on a selection-deciding row the cache had answered "no link" for.
 */
export function definitionCacheAlert(telemetry) {
  // Accepts one load's telemetry or a summarizeDefinitionCacheTelemetry sum.
  const t = telemetry && typeof telemetry === "object" ? telemetry : null;
  if (!t) return null;
  const corrections = Number.isInteger(t.staleFalseCorrections)
    ? t.staleFalseCorrections
    : 0;
  const oversize = [t.state, t.write, ...(t.states || []), ...(t.writes || [])]
    .includes("oversize");
  if (corrections > 0) {
    const minutes = Number.isFinite(t.staleFalseCorrectionMaxAgeMs)
      ? Math.round(t.staleFalseCorrectionMaxAgeMs / 60000)
      : "?";
    return {
      key: "definition-cache-stale-false",
      message: `:warning: Booking protection: a sequence gained a scheduling link that the definition cache had answered "no link" for (${corrections} sequence(s), cached answer up to ${minutes} min old; the limit is ${Math.round(BOOKING_STOP_DEFINITION_NO_LINK_MAX_AGE_MS / 60000)} min). It is protected from this run on. If this repeats, set BOOKING_STOP_DEFINITION_CACHE=off to read every definition on every run.`,
    };
  }
  if (oversize) {
    return {
      key: "definition-cache-oversize",
      message: ":warning: Booking protection definition cache exceeded its size cap, so it is not being used and every run reads every sequence definition (safe, but no Paraform read saving). The sequence catalog has grown past the cache's design limit.",
    };
  }
  return null;
}
