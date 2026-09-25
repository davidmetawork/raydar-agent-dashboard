// ─────────────────────────────────────────────────────────────────────────────
// BOOKING-STOP DEFINITION CACHE — pure helpers for discoverBookingStopSequences.
//
// WHY: every refresh and every sweep used to re-read all ~271 non-cold
// sequence definitions (campaigns.getCampaign), 144 times a day each: about
// 95-98% of Raydar's Paraform reads (measured 2026-09-25). A definition feeds
// exactly one decision, "does it carry a candidate scheduling link", and that
// answer rarely changes.
//
// SAFETY ARGUMENT (a stale answer can never shrink protection):
//   A row is selected when it is not cold-excluded AND (its name matches a
//   nudge key OR it is enabled and link-bearing). A cached answer can
//   therefore shrink scope in exactly one case: a cached "no link" on an
//   enabled, name-unmatched, not-excluded row ("selection-deciding"). The
//   catalog has no updated_at, version or step count, so nothing proves such
//   an answer is still true. So the cache NEVER serves it: those rows are read
//   live on every load, exactly as before. The class is recomputed at USE
//   time from the live catalog row and the current keys and policy.
//   Every answer the cache does serve either keeps a row in scope (a cached
//   "has link" on an enabled, unmatched row) or cannot change selection (a
//   disabled row, a name-matched row). Its only cost when stale is a wider
//   scope, and it is still bounded by MAX_AGE.
//   - n (name hash) and e (enabled) must equal the live catalog row, so a new
//     id, a rename or an enable flip in either direction forces a read.
//   - The document is keyed to the link matcher (version + source
//     fingerprint), so a matcher change forces fresh reads.
//   - r (read time) only ever comes from a real read. Merging and racing
//     writers can cost re-reads but can never lengthen a trust window.
//   - Anything malformed, future-dated, foreign or oversized is a miss. A
//     catalog too big for the caps switches the cache off for that load
//     (serve nothing, write nothing), so an older under-cap document is
//     never served past the point it can be rewritten.
//
// TWO DOCUMENTS, two readers:
//   - The mutable cache document is the REFRESH's working memory between
//     runs (merge-on-write, best effort). Nothing binds to it; losing it or a
//     racing writer only costs re-reads.
//   - The published answers document is write-once per scope digest and
//     holds exactly the answers that produced that digest. The refresh
//     writes it and reads it back (a transport failure or an absent readback
//     is NOT durable) before its scope can be published, and the SWEEP
//     serves only from the document of the digest the current pointer
//     names. Any document under key D carries D's link answers, so a served
//     answer can never disagree with the published binding, and no other
//     writer (a slow sweep, a second refresh) can change what the sweep sees.
// Entries hold no step text, no PII and no secrets: {n, e, l, r} per id.
// ─────────────────────────────────────────────────────────────────────────────

import { createHash } from "node:crypto";
import {
  BOOKING_STOP_DEFINITION_ANSWERS_SCHEMA,
  BOOKING_STOP_DEFINITION_CACHE_MAX_BYTES,
  BOOKING_STOP_DEFINITION_CACHE_MAX_ENTRIES,
  BOOKING_STOP_DEFINITION_CACHE_SCHEMA,
  BOOKING_STOP_DEFINITION_MATCHER_VERSION,
  BOOKING_STOP_DEFINITION_MAX_AGE_MS,
  BOOKING_STOP_DEFINITION_ROTOR_HORIZON_MS,
  BOOKING_STOP_DEFINITION_ROTOR_MAX_READS,
} from "./booking-stop-contract.mjs";

const NAME_HASH = /^[a-f0-9]{64}$/u;
const FINGERPRINT = /^[a-f0-9]{16,64}$/u;
const SCOPE_DIGEST = /^[a-f0-9]{64}$/u;

/** True for a string shaped like a booking-stop scope digest. */
export function definitionAnswersDigestValid(digest) {
  return typeof digest === "string" && SCOPE_DIGEST.test(digest);
}

/** sha256 of the given functions' source text: the matcher fingerprint. */
export function definitionMatcherFingerprint(functions) {
  const hash = createHash("sha256");
  for (const fn of functions || []) hash.update(`${String(fn)}\n`);
  return hash.digest("hex");
}

/**
 * The cache revision: the matcher version plus a fingerprint of the matcher's
 * source. A cached answer is only as safe as the matcher that computed it, so
 * a matcher change empties the cache; a deploy that leaves the matcher alone
 * keeps it (a per-deployment key cost ~300 reads per deploy). The cache runs
 * only on Vercel; local runs, scripts and tests have it off unless they pass a
 * revision. BOOKING_STOP_DEFINITION_CACHE=off disables it everywhere: every
 * load then reads every definition, exactly as before.
 */
export function bookingStopDefinitionCacheRevision(
  env = process.env,
  { matcherFingerprint = null } = {},
) {
  if (
    String(env?.BOOKING_STOP_DEFINITION_CACHE || "").trim().toLowerCase()
      === "off"
  ) {
    return null;
  }
  const onVercel = Boolean(
    String(env?.VERCEL || "").trim()
    || String(env?.VERCEL_ENV || "").trim()
    || String(env?.VERCEL_DEPLOYMENT_ID || "").trim(),
  );
  if (!onVercel) return null;
  const fingerprint = String(matcherFingerprint || "");
  if (!FINGERPRINT.test(fingerprint)) return null;
  return `matcher-v${BOOKING_STOP_DEFINITION_MATCHER_VERSION}-${fingerprint.slice(0, 32)}`;
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
    && Number.isFinite(nowMs)
    && entry.r <= nowMs
  );
}

function plainEntry(entry) {
  return { n: entry.n, e: entry.e, l: entry.l, r: entry.r };
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

// Newer real read wins. On an exact tie prefer "has link" (only widens scope).
function newerEntry(left, right) {
  if (!left) return right;
  if (!right) return left;
  if (left.r !== right.r) return left.r > right.r ? left : right;
  return left.l ? left : right;
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
 * True when a "no link" answer on this live row decides selection: the row is
 * enabled and its name matches no selection key (the caller only asks for
 * rows that are not cold-excluded). Such an answer is never served from cache.
 */
export function definitionAnswerDecidesSelection({ enabled, nudge, linkBearing }) {
  return !linkBearing && Boolean(enabled) && !nudge;
}

/**
 * Decide whether a cached entry may stand in for a read of this row now.
 * `nudge` is whether the live row's name matches a current selection key.
 */
export function definitionCacheDecision(entry, {
  nameSha256,
  enabled,
  nudge,
  nowMs,
  maxAgeMs = BOOKING_STOP_DEFINITION_MAX_AGE_MS,
}) {
  if (!definitionCacheEntryWellFormed(entry, nowMs)) {
    return { use: false, reason: entry == null ? "missing" : "invalid" };
  }
  if (entry.n !== nameSha256 || entry.e !== Boolean(enabled)) {
    return { use: false, reason: "changed" };
  }
  if (definitionAnswerDecidesSelection({
    enabled,
    nudge,
    linkBearing: entry.l,
  })) {
    return { use: false, reason: "selection_deciding" };
  }
  const ageMs = nowMs - entry.r;
  if (!(ageMs < maxAgeMs)) {
    return { use: false, reason: "expired", ageMs };
  }
  return { use: true, reason: "hit", ageMs };
}

/** The entry a real read produces. */
export function nextDefinitionEntry({
  nameSha256,
  enabled,
  linkBearing,
  readAtMs,
}) {
  return {
    n: nameSha256,
    e: Boolean(enabled),
    l: Boolean(linkBearing),
    r: readAtMs,
  };
}

function stableIdHash(id) {
  return createHash("sha256").update(String(id)).digest("hex");
}

export function definitionRotorQuota(count, maxAgeMs = BOOKING_STOP_DEFINITION_MAX_AGE_MS) {
  if (!Number.isInteger(count) || count <= 0) return 0;
  return Math.ceil(
    (count * BOOKING_STOP_DEFINITION_ROTOR_HORIZON_MS)
      / (maxAgeMs - BOOKING_STOP_DEFINITION_ROTOR_HORIZON_MS),
  );
}

/**
 * Choose this run's proactive re-reads among cache hits: the
 * oldest-verified, at least one rotor horizon old, oldest first (stable id
 * hash breaks ties), ceil(count/35) of them, capped. Only ever makes a read
 * happen EARLIER than its bound would force it.
 */
export function selectDefinitionRotorReads(candidates, {
  nowMs,
  count,
  maxReads = BOOKING_STOP_DEFINITION_ROTOR_MAX_READS,
}) {
  const order = (left, right) =>
    left.r - right.r
    || (stableIdHash(left.id) < stableIdHash(right.id) ? -1 : 1);
  return (candidates || [])
    .filter(({ r }) =>
      Number.isFinite(r)
      && nowMs - r >= BOOKING_STOP_DEFINITION_ROTOR_HORIZON_MS)
    .sort(order)
    .slice(0, Math.min(definitionRotorQuota(count), Math.max(0, maxReads)))
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

/**
 * Whether a document holding one entry for every id in `ids` could ever break
 * a size cap (worst-case entry and digest sizes). When it could, the cache is
 * off for that load: nothing is served (so an older, smaller document is
 * never trusted) and nothing is written.
 */
export function definitionCacheFits({ revision, ids, nowMs }) {
  const list = [...(ids || [])];
  if (list.length > BOOKING_STOP_DEFINITION_CACHE_MAX_ENTRIES) return false;
  const worst = {
    n: "f".repeat(64),
    e: false,
    l: false,
    r: Math.max(Number(nowMs) || 0, 9_999_999_999_999),
  };
  return buildDefinitionAnswersDocument({
    revision: String(revision || ""),
    digest: "f".repeat(64),
    nowMs: Number.isFinite(nowMs) ? nowMs : 0,
    entries: new Map(list.map((id) => [id, worst])),
  }) != null;
}

/** Build the write-once answers document for one scope digest, or null. */
export function buildDefinitionAnswersDocument({
  revision,
  digest,
  nowMs,
  entries,
}) {
  if (entries.size > BOOKING_STOP_DEFINITION_CACHE_MAX_ENTRIES) return null;
  const doc = {
    schema: BOOKING_STOP_DEFINITION_ANSWERS_SCHEMA,
    revision,
    digest,
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

/**
 * Parse a published answers document for `digest`. Same result shape and
 * states as readDefinitionCacheDocument; a document for another digest is
 * "foreign_revision".
 */
export function readDefinitionAnswersDocument(doc, { revision, digest, nowMs }) {
  const empty = (state) => ({ state, entries: new Map() });
  if (doc == null) return empty("missing");
  if (
    typeof doc !== "object"
    || Array.isArray(doc)
    || doc.schema !== BOOKING_STOP_DEFINITION_ANSWERS_SCHEMA
    || !doc.entries
    || typeof doc.entries !== "object"
    || Array.isArray(doc.entries)
  ) {
    return empty("invalid");
  }
  if (
    typeof revision !== "string"
    || !revision
    || doc.revision !== revision
    || !definitionAnswersDigestValid(digest)
    || doc.digest !== digest
  ) {
    return empty("foreign_revision");
  }
  return readDefinitionCacheDocument(
    {
      schema: BOOKING_STOP_DEFINITION_CACHE_SCHEMA,
      revision,
      entries: doc.entries,
    },
    { revision, nowMs },
  );
}

/**
 * True only when the read-back answers document is warm and holds, for every
 * answer this load used, the identical {n, e, l, r}. An absent, foreign,
 * malformed or partial read-back is NOT durable.
 */
export function definitionAnswersDurable(answers, parsed) {
  if (!parsed || parsed.state !== "warm") return false;
  for (const [id, answer] of answers) {
    const entry = parsed.entries.get(id);
    if (
      !entry
      || entry.n !== answer.n
      || entry.e !== answer.e
      || entry.l !== answer.l
      || entry.r !== answer.r
    ) {
      return false;
    }
  }
  return true;
}

const TELEMETRY_COUNTS = [
  "freshReads",
  "requiredReads",
  "rotorReads",
  "rotorPlanned",
  "rotorFailures",
  "cacheHits",
  "writeAttempts",
];
const TELEMETRY_AGES = [
  "oldestHitAgeMs",
];
const TELEMETRY_STATES = new Set([
  "disabled", "missing", "invalid", "foreign_revision", "oversize", "warm",
  "read_error",
]);
const TELEMETRY_WRITES = new Set([
  "disabled", "not_needed", "written", "verified", "failed", "oversize",
  "not_durable",
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
    // Refresh only: true when the published answers document for this
    // load's scope digest was read back holding every answer the load used;
    // false when it could not be made durable and the load served a cached
    // answer (the load then failed); null when not checked or not required.
    durable: typeof value.durable === "boolean" ? value.durable : null,
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
  const durables = valid.map(({ durable }) => durable);
  const out = {
    loads: valid.length,
    states: valid.map(({ state }) => state),
    writes: valid.map(({ write }) => write),
    durable: durables.includes(false)
      ? false
      : durables.includes(true) ? true : null,
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
 * The one alert this cache raises, or null: the catalog outgrew the cache's
 * size cap, so the cache is switched off (nothing served, nothing written;
 * safe, but no saving).
 */
export function definitionCacheAlert(telemetry) {
  // Accepts one load's telemetry or a summarizeDefinitionCacheTelemetry sum.
  const t = telemetry && typeof telemetry === "object" ? telemetry : null;
  if (!t) return null;
  const oversize = [t.state, t.write, ...(t.states || []), ...(t.writes || [])]
    .includes("oversize");
  if (oversize) {
    return {
      key: "definition-cache-oversize",
      message: ":warning: The sequence catalog has grown past the booking protection definition cache's size cap, so the cache is switched off: no cached answer is served or written and every run reads every sequence definition (safe, the same as before the cache, but no Paraform read saving).",
    };
  }
  return null;
}
