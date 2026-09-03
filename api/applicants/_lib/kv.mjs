// Upstash REST KV, apphub:* namespace ONLY.
//
// Deliberately a separate tiny module (pattern: api/health/_lib/kv.mjs) rather
// than importing api/paraai/_lib/store.mjs: that module is paraai-scoped and
// its writers are single-purpose by contract. Applicants owns apphub:* and
// touches nothing else — paraai:*, hlth:*, seqguard:* are off-limits here.
//
// Write ownership (the contract — do not widen):
//   apphub:snapshot          — POST /api/applicants/sync only
//   apphub:acks              — POST /api/applicants/sync only
//   apphub:decisions         — TWO accepted writers, both writing the IDENTICAL
//                              record shape through the same module
//                              (_lib/decision-record.mjs):
//                              POST /api/applicants/decision is the human
//                              click, and authenticated POST /api/applicants/rules-tick is
//                              an armed rule. This is a deliberate widening
//                              (2026-08-20, Applicant Decision Rules): an
//                              manual rule decision has to be indistinguishable
//                              from a human one downstream, because that is
//                              what makes it inherit the loop's approval pull,
//                              every send-time gate, the ack, and Undo without
//                              a second code path. `by` is what tells them
//                              apart — a signed-in email, or "rule:<id>".
//                              The tick NEVER overwrites an existing field.
//   apphub:profile:<cuId>    — TWO accepted writers of one identical shape
//                              (24h TTL): POST /api/applicants/sync is the
//                              bulk writer (the loop prewarms complete profile
//                              JSONs), GET /api/applicants/profile remains the
//                              cache-miss fallback writer. profile.mjs is the
//                              source of truth for the shape; the loop mirrors
//                              it field-for-field. This is rich-provider cache
//                              only; it is never the Hub history authority.
//   apphub:source-profile:<key> — POST /api/applicants/sync only. Durable
//                              Applicant Hub source projection, keyed by the
//                              published profile key and never given a TTL.
//                              It is separate from the rich cache so a
//                              provider refresh cannot erase source history.
//   apphub:photos            — POST /api/applicants/sync only (hash: field
//                              cuId → JSON string of the photo URL)
//   apphub:cards             — POST /api/applicants/sync only (hash: field
//                              cuId → JSON compact card derived from the
//                              prewarmed profile: headline, location, top-3
//                              experience/education, so list rows render
//                              without a profile fetch each). Same lifecycle
//                              as apphub:photos — written in the same sync
//                              pass, pruned by the same full-publish prune,
//                              no TTL of its own. GET /api/applicants/cards
//                              is a reader only, never a writer.
//   apphub:profile-ready     — POST /api/applicants/sync only (hash: field
//                              cuId → {cachedAt, expiresAt}). Cards do not
//                              expire, so this companion receipt is what lets
//                              the list prove the full 24h profile cache is
//                              still present before exposing a candidate.
//   apphub:source-profile-ready — POST /api/applicants/sync only (hash: field
//                              profile key → {cachedAt, source,
//                              historyState, sourceObservationId}). Durable
//                              Hub receipt; sourceObservationId is the
//                              freshness fence for the current queue row.
//   apphub:rank:<companyId>  — GET  /api/applicants/profile only (30d TTL)
//   apphub:counts            — POST /api/applicants/sync only (tiny doc: the
//                              queue/stream sizes of the last publish plus a
//                              latched count-drop alert; feed reads it so the
//                              tab can warn when a publish collapses. Display
//                              only — it never gates a sync or a feed.)
//   apphub:refresh           — /api/applicants/refresh only, BOTH methods
//                              (tiny doc: {requestedAt, by} — the browser's
//                              standing "please republish" note, 1h TTL. The
//                              desktop refresh listener only ever READS it and
//                              keeps its own served-watermark on disk, which is
//                              what keeps the on-demand path idempotent.)

const KV_URL = String(process.env.KV_REST_API_URL || "").replace(/\/+$/, "");
const KV_TOKEN = process.env.KV_REST_API_TOKEN || "";

export const kvConfigured = () => Boolean(KV_URL && KV_TOKEN);

export async function kv(command) {
  if (!kvConfigured()) throw new Error("applicants state store not configured");
  const response = await fetch(KV_URL, {
    method: "POST",
    headers: { authorization: `Bearer ${KV_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify(command),
    signal: AbortSignal.timeout(8000),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(`kv HTTP ${response.status}: ${String(body?.error || "request rejected").replace(/\s+/g, " ").slice(0, 180)}`);
  }
  if (body?.error) throw new Error(String(body.error).slice(0, 180));
  return body?.result ?? null;
}

const parse = (raw, fallback = null) => {
  try { return raw == null ? fallback : JSON.parse(raw); } catch { return fallback; }
};

export async function getJson(key, { kvImpl = kv } = {}) {
  return parse(await kvImpl(["GET", key]));
}

export async function setJson(key, value, ttlSeconds, { kvImpl = kv } = {}) {
  return kvImpl(ttlSeconds
    ? ["SET", key, JSON.stringify(value), "EX", String(ttlSeconds)]
    : ["SET", key, JSON.stringify(value)]);
}

/** Write-once JSON used for immutable publication artifacts. */
export async function setJsonIfAbsent(key, value, ttlSeconds, { kvImpl = kv } = {}) {
  const command = ttlSeconds
    ? ["SET", key, JSON.stringify(value), "EX", String(ttlSeconds), "NX"]
    : ["SET", key, JSON.stringify(value), "NX"];
  return kvImpl(command);
}

/**
 * Compare-and-set a JSON pointer by its generation identity.  Comparing the
 * parsed identity in Redis avoids depending on object-key order in a prior
 * JSON encoding.  An empty expected generation means "only if absent".
 */
export async function compareAndSetJson(key, expected, next, { kvImpl = kv } = {}) {
  const expectedGeneration = String(expected?.generationId || "");
  const expectedDigest = String(expected?.digest || "");
  return Number(await kvImpl(["EVAL", `
    local raw=redis.call('GET',KEYS[1])
    if ARGV[1]=='' then
      if raw then return 0 end
    else
      if not raw then return 0 end
      local ok,current=pcall(cjson.decode,raw)
      if not ok or current.generationId~=ARGV[1] or current.digest~=ARGV[2] then return 0 end
    end
    redis.call('SET',KEYS[1],ARGV[3])
    return 1`, 1, key, expectedGeneration, expectedDigest, JSON.stringify(next)])) === 1;
}

// Upstash REST returns HGETALL as a flat [field, value, field, value] array.
export async function hashGetAllJson(key, { kvImpl = kv } = {}) {
  const flat = await kvImpl(["HGETALL", key]);
  const out = {};
  if (!Array.isArray(flat)) return out;
  for (let i = 0; i + 1 < flat.length; i += 2) out[flat[i]] = parse(flat[i + 1]);
  return out;
}

export async function hashSetJson(key, fields, { kvImpl = kv } = {}) {
  const entries = Object.entries(fields || {});
  if (!entries.length) return 0;
  return kvImpl(["HSET", key, ...entries.flatMap(([field, value]) => [field, JSON.stringify(value)])]);
}

export async function hashGetJson(key, field, { kvImpl = kv } = {}) {
  return parse(await kvImpl(["HGET", key, field]));
}

// Upstash REST returns HMGET as an array positionally aligned to the requested
// fields, with null in the slots that miss. Missing fields are simply absent
// from the returned object (never null entries), so callers can treat the map
// as "what the store actually had". An empty field list never issues a command
// — `HMGET key` with no fields is a protocol error, not an empty answer.
export async function hashGetMany(key, fields, { kvImpl = kv } = {}) {
  const wanted = Array.isArray(fields) ? fields : [];
  if (!wanted.length) return {};
  const values = await kvImpl(["HMGET", key, ...wanted]);
  const out = {};
  if (!Array.isArray(values)) return out;
  for (let i = 0; i < wanted.length; i += 1) {
    const value = parse(values[i]);
    if (value == null) continue;
    out[wanted[i]] = value;
  }
  return out;
}

export async function hashDel(key, field, { kvImpl = kv } = {}) {
  return kvImpl(["HDEL", key, field]);
}

export async function hashKeys(key, { kvImpl = kv } = {}) {
  const fields = await kvImpl(["HKEYS", key]);
  return Array.isArray(fields) ? fields : [];
}

export async function hashDelMany(key, fields, { kvImpl = kv } = {}) {
  if (!fields?.length) return 0;
  return kvImpl(["HDEL", key, ...fields]);
}

// `<cuId>:<roleId>` — the one field-key contract every apphub hash shares.
export const KEY_RE = /^[a-z0-9]+:[a-z0-9]+$/i;
export const validKey = (key) => typeof key === "string" && key.length <= 130 && KEY_RE.test(key);

// 24h: profiles are prewarmed daily by the desktop loop (sync POST `profiles`),
// and the LinkedIn snapshot behind them ages in days anyway — a longer TTL just
// keeps the modal instant between warms instead of forcing live refetches.
export const PROFILE_TTL_SECONDS = 24 * 60 * 60;
export const RANK_TTL_SECONDS = 30 * 24 * 60 * 60;

export const K = {
  // ── Applicant Decision Rules (2026-08-20) ────────────────────────────────
  // facts/schools/companies are derived projections: written in the same sync
  // pass as cards, pruned by the same full-publish prune, and always
  // regenerable from the prewarmed profiles. Losing them costs a tick, never
  // data. rules/rulestats/ruleruns are the real state.
  facts: "apphub:facts",         // hash: cuId → evaluation facts (see _lib/facts.mjs)
  schools: "apphub:schools",     // hash: schoolId → school name (picker directory)
  companies: "apphub:companies", // hash: companyId → company name (picker directory)
  rules: "apphub:rules",         // doc: {rules[], pausedAll, updatedAt} — writer: /api/applicants/rules only
  rulestats: "apphub:rulestats", // hash: ruleId → {fired, firedAt, ...} — writer: /api/applicants/rules-tick only
  ruleruns: "apphub:ruleruns",   // hash: `<cuId>:<roleId>` → why a rule fired — writer: rules-tick only
  ruleRun: (ruleRunId) => `apphub:rule-run:${ruleRunId}`, // immutable exact run manifest

  snapshot: "apphub:snapshot",
  queue: "apphub:queue", // review-queue rows, split out so backlog size never crowds the stream
  // Immutable generation artifacts. The active pointer is the only mutable
  // publication selector; readers must never fall back to the legacy keys when
  // it exists.
  activeGeneration: "apphub:active-generation",
  generation: (generationId, artifact) => `apphub:generation:${generationId}${artifact ? `:${artifact}` : ""}`,
  decisions: "apphub:decisions",
  acks: "apphub:acks",
  profile: (cuId) => `apphub:profile:${cuId}`,
  sourceProfile: (profileKey) => `apphub:source-profile:${profileKey}`,
  photos: "apphub:photos", // hash: field cuId → JSON string of the photo URL
  cards: "apphub:cards", // hash: field cuId → JSON compact card (see header)
  profileReady: "apphub:profile-ready", // hash: field cuId → full-profile TTL receipt
  sourceProfileReady: "apphub:source-profile-ready", // hash: field profile key → durable Hub receipt
  counts: "apphub:counts", // last publish's queue/stream sizes + latched drop alert (see header)
  // Applicant Pipeline Core's own funnel snapshot (Status v2 build plan step
  // 3, PRD-STATUS-V2-2026-09-03.md §5.2/§7): stored verbatim from an
  // optional `pipeline` field on sync's POST body, read back by feed.mjs as
  // `pipeline` (null when Core has never published one). Shape:
  // { generatedAt, window:{days,since}, captured, identified, readyToDecide,
  //   holdsTotal, holdsByReason:[{code,label,count}], passed, invited,
  //   postDecisionHolds, unaccounted, laneEnabled, stopReason }.
  pipeline: "apphub:pipeline",
  refresh: "apphub:refresh", // on-demand refresh request from the tab (see header)
  rank: (companyId) => `apphub:rank:${companyId}`,
};
