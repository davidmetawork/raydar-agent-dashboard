// ─────────────────────────────────────────────────────────────────────────────
// lifecycle/_lib/paraform-session-store.mjs — the Paraform session store, in
// either of its two homes.
//
// WHY THIS EXISTS. Until now the only durable home for Paraform's rotating
// WorkOS seal was n8n Variables (see paraform-session.mjs for the generation
// protocol). n8n Cloud is being cancelled, and n8n has no compare-and-swap, no
// transaction and no update verb for a group of variables — the pointer flip is
// "last PUT wins". This file moves the store into one Postgres row per
// namespace with a real CAS, and keeps every existing caller working by
// SYNTHESIZING the n8n row shape out of that row, so `resolveSession`,
// `resolveParaformAccountSession`, `planRenewal` and the seat code run
// unchanged.
//
// THE MIGRATION UNIT IS THE NAMESPACE, NOT THE RUNTIME. Each row carries
// `authoritative_store` (`n8n` | `pg`). Every store-aware writer reads it and
// writes ONLY to the authoritative side, so one DB update moves a whole cookie
// chain at once, whatever has or has not been released. The per-runtime env
// `PARAFORM_SESSION_STORE` says only that the runtime is CAPABLE of pg (and is
// the per-lane kill switch). A runtime in pg mode whose row still says `n8n`
// behaves exactly as it does today.
//
// FAIL LOUD, FAIL CLOSED. An invalid mode or a missing DB url in pg mode throws
// PARAFORM_SESSION_STORE_CONFIG at open. A store READ failure at runtime throws
// PARAFORM_SESSION_STORE_UNAVAILABLE — there is no static-seed fallback and no
// legacy fallback in pg mode, because serving a stale env seed is how a dead
// chain stays invisible. A write to the non-authoritative side is refused with
// PARAFORM_SESSION_STORE_NOT_AUTHORITATIVE and the rotation stays pending.
//
// WHAT THE CAS MAY AND MAY NOT TOUCH. The CAS write moves `cookie`,
// `generation`, `version`, `written_by`, `written_at`, `last_rotated_at` and
// (first writer only) `login_lineage`. It NEVER touches `dead_at`,
// `last_verify_outcome` or `last_verified_at`: only `markVerified`, which is
// called with a real answer from Paraform, may set or clear those. Otherwise a
// mirror pass — which never talks to Paraform — could silence a dead-session
// page.
//
// NO PII, NO VALUES IN LOGS. Cookie values never leave this module except to
// the caller that asked for them. Every error carries a code and a short
// literal detail; lengths and generation numbers are safe, values are not.
// ─────────────────────────────────────────────────────────────────────────────

import { neonHttpQuery } from "./neon-http.mjs";
import {
  CHUNK_LIMIT,
  DEFAULT_SESSION_NAMESPACE,
  applyRenewal as n8nApplyRenewal,
  chunkCookie,
  isPlausibleCookie,
  listVariables,
  resolveSession,
  sessionKeys,
} from "./paraform-session.mjs";

/** The two stores a namespace can live in. `n8n` is the default everywhere. */
export const STORE_MODES = Object.freeze(["n8n", "pg"]);

/** Env keys. Desktop lanes pass their own lane-scoped `storeEnvKey` so one
 *  shared `.env` edit cannot flip every script at once. */
export const STORE_ENV_KEY = "PARAFORM_SESSION_STORE";
export const DATABASE_URL_ENV_KEY = "PARAFORM_SESSION_DATABASE_URL";

/**
 * What the mirror writes to the n8n side of a namespace that has moved to pg
 * and has no n8n reader left. Every Raydar reader rejects it: it fails
 * `isPlausibleCookie` (no `Fe26.2`/`eyJ` prefix), so `resolveSession` discards
 * that generation, and the wf01/02/04 Code nodes throw on their own plausibility
 * check. The point is that a stale checkout or a forgotten consumer fails
 * LOUDLY instead of quietly rotating a forked chain.
 */
export const SENTINEL_N8N_VALUE = "PARAFORM_SESSION_MOVED_TO_PG_DO_NOT_USE";

/** Mirror directions, as stored in `dispatch_control.session_mirror`. */
export const MIRROR_DIRECTIONS = Object.freeze(["off", "to_pg", "to_n8n", "auto"]);

/** Outcomes `markVerified` accepts (the 086 CHECK). */
export const VERIFY_OUTCOMES = Object.freeze(["ok", "refused", "mismatch", "error"]);

/** The dead ladder: 3 consecutive refusals spanning at least 20 minutes. */
export const DEAD_AFTER_REFUSALS = 3;
export const DEAD_SPAN_MS = 20 * 60 * 1000;

/** Every error code this module throws or returns. */
export const STORE_CODES = Object.freeze({
  CONFIG: "PARAFORM_SESSION_STORE_CONFIG",
  UNAVAILABLE: "PARAFORM_SESSION_STORE_UNAVAILABLE",
  NOT_AUTHORITATIVE: "PARAFORM_SESSION_STORE_NOT_AUTHORITATIVE",
  MOVED: "PARAFORM_SESSION_STORE_MOVED",
  ABSENT: "PARAFORM_SESSION_ABSENT",
  LEGACY_UNSUPPORTED: "PARAFORM_SESSION_LEGACY_UNSUPPORTED",
  LINEAGE_CONFLICT: "PARAFORM_SESSION_LINEAGE_CONFLICT",
  MIRROR_CONFLICT: "PARAFORM_SESSION_MIRROR_CONFLICT",
});

export function storeError(code, detail = "", extra = {}) {
  const error = new Error(detail ? `${code}: ${detail}` : code);
  error.code = code;
  return Object.assign(error, extra);
}

// ── small coercions ─────────────────────────────────────────────────────────
// A row can arrive from the HTTP endpoint (every value a string) or from an
// injected `pg` pool (numbers, Dates, booleans). Nothing below cares which.

function asBigIntString(value) {
  if (value === null || value === undefined) return null;
  const text = String(typeof value === "number" ? Math.trunc(value) : value).trim();
  return /^-?\d+$/u.test(text) ? text : null;
}

function asNumber(value) {
  const text = asBigIntString(value);
  return text === null ? null : Number(text);
}

function asIsoString(value) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function asJsonObject(value) {
  if (!value) return {};
  if (typeof value === "object") return value;
  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch { return {}; }
}

/** Namespaces are `^[A-Z][A-Z0-9_]{1,127}$`, so a comma list is unambiguous and
 *  needs no array-literal encoding on either query path. */
function namespaceList(namespaces) {
  if (!namespaces) return null;
  const list = (Array.isArray(namespaces) ? namespaces : String(namespaces).split(","))
    .map((entry) => String(entry ?? "").trim())
    .filter(Boolean);
  for (const namespace of list) sessionKeys(namespace); // validates or throws
  return list.length ? list.join(",") : null;
}

/** Wrap every store read so a DB failure fails CLOSED with one code. */
async function read(query, sql, params) {
  try {
    return await query(sql, params);
  } catch (error) {
    throw storeError(
      STORE_CODES.UNAVAILABLE,
      String(error?.code || error?.name || "query failed").slice(0, 80),
      { cause: error },
    );
  }
}

// ── the row ─────────────────────────────────────────────────────────────────

/** Bigints and timestamps are cast to text so the shape is identical whether
 *  the row came from the HTTP endpoint or an injected `pg` pool. */
function rowColumns(alias = "") {
  const a = alias ? `${alias}.` : "";
  return `${a}namespace, ${a}account_key, ${a}slot, ${a}authoritative_store, ${a}login_lineage,
         ${a}generation::text AS generation, ${a}version::text AS version, ${a}cookie, ${a}written_by,
         ${a}written_at::text AS written_at, ${a}last_rotated_at::text AS last_rotated_at,
         ${a}last_verified_at::text AS last_verified_at, ${a}last_verify_outcome,
         ${a}dead_at::text AS dead_at, ${a}refused_streak::text AS refused_streak,
         ${a}refused_since::text AS refused_since,
         ${a}last_write_error, ${a}last_write_error_at::text AS last_write_error_at,
         ${a}last_opened_by`;
}

const ROW_COLUMNS = rowColumns();

function shapeRow(raw) {
  if (!raw) return null;
  return {
    namespace: String(raw.namespace),
    accountKey: raw.account_key ?? null,
    slot: raw.slot ?? null,
    authoritativeStore: String(raw.authoritative_store ?? "n8n"),
    loginLineage: raw.login_lineage ?? null,
    generation: asNumber(raw.generation) ?? 0,
    version: asNumber(raw.version) ?? 0,
    cookie: raw.cookie ?? null,
    writtenBy: raw.written_by ?? null,
    writtenAt: asIsoString(raw.written_at),
    lastRotatedAt: asIsoString(raw.last_rotated_at),
    lastVerifiedAt: asIsoString(raw.last_verified_at),
    lastVerifyOutcome: raw.last_verify_outcome ?? null,
    deadAt: asIsoString(raw.dead_at),
    refusedStreak: asNumber(raw.refused_streak) ?? 0,
    refusedSince: asIsoString(raw.refused_since),
    lastWriteError: raw.last_write_error ?? null,
    lastWriteErrorAt: asIsoString(raw.last_write_error_at),
    lastOpenedBy: asJsonObject(raw.last_opened_by),
    // `authoritative_store` is the only field a caller must obey.
    get isPg() { return this.authoritativeStore === "pg"; },
  };
}

/**
 * Read one namespace's row, optionally stamping `last_opened_by[runtimeId]` in
 * the same statement (PS7: the stage proofs are "every known reader/writer
 * appears in last_opened_by", which only works if opening stamps).
 * -> the shaped row, or null when the namespace has no row yet.
 */
export async function pgReadNamespace(query, { namespace, runtimeId = null } = {}) {
  sessionKeys(namespace);
  const sql = runtimeId
    ? `UPDATE paraform_session
          SET last_opened_by = COALESCE(last_opened_by,'{}'::jsonb)
                               || jsonb_build_object($2::text, to_jsonb(clock_timestamp()))
        WHERE namespace = $1::text
        RETURNING ${ROW_COLUMNS}`
    : `SELECT ${ROW_COLUMNS} FROM paraform_session WHERE namespace = $1::text`;
  const { rows } = await read(query, sql, runtimeId ? [namespace, runtimeId] : [namespace]);
  return shapeRow(rows[0]);
}

/**
 * Stamp `last_opened_by[runtimeId]` for several namespaces at once.
 *
 * This is how a migration stage proves itself (PS7): the gate for flipping a
 * namespace is "every known reader and writer of THAT namespace appears in
 * last_opened_by". Most of today's callers only ever LIST rows, so listing has
 * to stamp too — otherwise the proof would only ever show the writers.
 */
export async function pgStampOpened(query, { namespaces, runtimeId } = {}) {
  const filter = namespaceList(namespaces);
  if (!filter || !runtimeId) return { stamped: 0 };
  const { rows } = await read(
    query,
    `UPDATE paraform_session
        SET last_opened_by = COALESCE(last_opened_by,'{}'::jsonb)
                             || jsonb_build_object($2::text, to_jsonb(clock_timestamp()))
      WHERE namespace = ANY(string_to_array($1::text, ','))
      RETURNING namespace`,
    [filter, runtimeId],
  );
  return { stamped: rows.length };
}

/** Every row (optionally filtered), newest history generation attached. */
export async function pgListNamespaces(query, { namespaces = null } = {}) {
  const filter = namespaceList(namespaces);
  const { rows } = await read(
    query,
    `SELECT ${rowColumns("s")},
            h.generation::text AS prev_generation, h.cookie AS prev_cookie
       FROM paraform_session s
       LEFT JOIN LATERAL (
         SELECT generation, cookie FROM paraform_session_history
          WHERE namespace = s.namespace AND generation < s.generation
          ORDER BY generation DESC LIMIT 1
       ) h ON true
      WHERE ($1::text IS NULL OR s.namespace = ANY(string_to_array($1::text, ',')))
      ORDER BY s.namespace`,
    [filter],
  );
  return rows.map((raw) => Object.assign(shapeRow(raw), {
    prevGeneration: asNumber(raw.prev_generation),
    prevCookie: raw.prev_cookie ?? null,
  }));
}

// ── the CAS write (SPEC 2.4, PS14, SS19) ────────────────────────────────────
//
// ONE statement. The UPDATE is guarded by namespace + version + a strictly
// newer generation + `authoritative_store='pg'`; the history insert rides the
// same statement as a data-modifying CTE (Postgres always executes those, even
// unreferenced); and when the UPDATE matched nothing the second UNION branch
// reads the pre-statement snapshot to say WHY. Zero rows at all = the namespace
// has no row (`absent`).

const CAS_SQL = `
WITH upd AS (
  UPDATE paraform_session SET cookie=$3::text, generation=$4::bigint, version=version+1, written_by=$5::text,
         written_at=clock_timestamp(), last_rotated_at=clock_timestamp(),
         login_lineage=COALESCE($6::text, login_lineage)
   WHERE namespace=$1::text AND version=$2::bigint AND generation < $4::bigint AND authoritative_store='pg'
  RETURNING namespace, generation, cookie, written_by, written_at, version),
hist AS (
  INSERT INTO paraform_session_history SELECT namespace, generation, cookie, written_by, written_at FROM upd
  ON CONFLICT (namespace, generation) DO NOTHING)
SELECT u.version::text AS version, NULL::text AS reason FROM upd u
UNION ALL
SELECT s.version::text AS version, CASE WHEN s.authoritative_store <> 'pg' THEN 'not_authoritative'
                       WHEN s.version <> $2::bigint THEN 'version_conflict'
                       ELSE 'generation_stale' END
  FROM paraform_session s WHERE s.namespace=$1::text AND NOT EXISTS (SELECT 1 FROM upd)`;

const REASON_CODES = Object.freeze({
  not_authoritative: STORE_CODES.NOT_AUTHORITATIVE,
  version_conflict: STORE_CODES.MOVED,
  generation_stale: STORE_CODES.MOVED,
  absent: STORE_CODES.ABSENT,
});

/**
 * Compare-and-swap one namespace's cookie.
 * -> { ok: true, version } | { ok: false, code, reason, version }
 * reason: `not_authoritative` | `version_conflict` | `generation_stale` | `absent`.
 */
export async function pgCasWrite(query, {
  namespace, expectVersion, generation, cookie, lineage = null, writtenBy,
} = {}) {
  sessionKeys(namespace);
  if (!isPlausibleCookie(cookie)) throw storeError(STORE_CODES.CONFIG, "implausible cookie");
  const gen = asBigIntString(generation);
  const version = asBigIntString(expectVersion);
  if (gen === null || version === null) throw storeError(STORE_CODES.CONFIG, "generation and version must be integers");
  if (!String(writtenBy || "").trim()) throw storeError(STORE_CODES.CONFIG, "writtenBy required");

  let result;
  try {
    result = await query(CAS_SQL, [namespace, version, cookie, gen, String(writtenBy), lineage]);
  } catch (error) {
    // 23505 on paraform_session_lineage_uniq: another LIVE namespace already
    // holds this login lineage (PS2). That is a seeding mistake, not a blip.
    if (error?.sqlstate === "23505" || error?.code === "23505") {
      throw storeError(STORE_CODES.LINEAGE_CONFLICT, "lineage already held by a live namespace", { cause: error });
    }
    throw storeError(
      STORE_CODES.UNAVAILABLE,
      String(error?.code || error?.name || "cas failed").slice(0, 80),
      { cause: error },
    );
  }
  const row = result.rows[0];
  if (!row) return { ok: false, code: STORE_CODES.ABSENT, reason: "absent", version: null };
  // The statement always selects a `reason` column; a row without one is not an
  // answer to this question, and must never be read as success.
  if (!("reason" in row)) throw storeError(STORE_CODES.UNAVAILABLE, "cas returned an unexpected row shape");
  if (row.reason === null) return { ok: true, version: asNumber(row.version) };
  return {
    ok: false,
    code: REASON_CODES[row.reason] ?? STORE_CODES.MOVED,
    reason: String(row.reason),
    version: asNumber(row.version),
  };
}

/**
 * Create a namespace row if it is missing. Never overwrites: the mirror's first
 * pass and the seeder both use it, and both must be safe to run twice.
 * -> { inserted: boolean }
 */
export async function pgInsertIfAbsent(query, {
  namespace, generation, cookie, writtenBy, accountKey = null, slot = null,
  authoritativeStore = "n8n", lineage = null,
} = {}) {
  sessionKeys(namespace);
  if (!isPlausibleCookie(cookie)) throw storeError(STORE_CODES.CONFIG, "implausible cookie");
  if (!STORE_MODES.includes(authoritativeStore)) throw storeError(STORE_CODES.CONFIG, "authoritative_store");
  const gen = asBigIntString(generation);
  if (gen === null) throw storeError(STORE_CODES.CONFIG, "generation must be an integer");
  let result;
  try {
    result = await query(
      `INSERT INTO paraform_session
         (namespace, account_key, slot, authoritative_store, login_lineage, generation, version,
          cookie, written_by, written_at, last_rotated_at)
       VALUES ($1::text, $2::text, $3::text, $4::text, $5::text, $6::bigint, 1, $7::text, $8::text,
               clock_timestamp(), clock_timestamp())
       ON CONFLICT (namespace) DO NOTHING
       RETURNING namespace`,
      [namespace, accountKey, slot, authoritativeStore, lineage, gen, cookie, String(writtenBy || "seed")],
    );
  } catch (error) {
    if (error?.sqlstate === "23505" || error?.code === "23505") {
      throw storeError(STORE_CODES.LINEAGE_CONFLICT, "lineage already held by a live namespace", { cause: error });
    }
    throw storeError(STORE_CODES.UNAVAILABLE, String(error?.code || "insert failed").slice(0, 80), { cause: error });
  }
  const inserted = result.rows.length > 0;
  if (inserted) {
    // Keep the invariant the CAS write relies on: EVERY generation that has
    // been current appears in the history table, so the newest history row
    // older than the current one is always the previous generation (which is
    // what pgListRows synthesizes and what a rollback reads).
    await read(
      query,
      `INSERT INTO paraform_session_history (namespace, generation, cookie, written_by, written_at)
       VALUES ($1::text, $2::bigint, $3::text, $4::text, clock_timestamp())
       ON CONFLICT (namespace, generation) DO NOTHING`,
      [namespace, gen, cookie, String(writtenBy || "seed")],
    );
  }
  return { inserted };
}

// The mirror's own write. It is the ONE writer allowed into the side that is
// NOT authoritative — that is its entire job — so it drops the
// `authoritative_store='pg'` guard the lane CAS carries, and keeps everything
// else: the version check, the strictly-newer generation, the history insert,
// and the rule that dead_at and the verify outcome are never touched.
const MIRROR_CAS_SQL = `
WITH upd AS (
  UPDATE paraform_session SET cookie=$3::text, generation=$4::bigint, version=version+1, written_by=$5::text,
         written_at=clock_timestamp(), last_rotated_at=clock_timestamp()
   WHERE namespace=$1::text AND version=$2::bigint AND generation < $4::bigint
  RETURNING namespace, generation, cookie, written_by, written_at, version),
hist AS (
  INSERT INTO paraform_session_history SELECT namespace, generation, cookie, written_by, written_at FROM upd
  ON CONFLICT (namespace, generation) DO NOTHING)
SELECT u.version::text AS version, NULL::text AS reason FROM upd u
UNION ALL
SELECT s.version::text AS version,
       CASE WHEN s.version <> $2::bigint THEN 'version_conflict' ELSE 'generation_stale' END
  FROM paraform_session s WHERE s.namespace=$1::text AND NOT EXISTS (SELECT 1 FROM upd)`;

/** @see MIRROR_CAS_SQL — only mirrorOnce should call this. */
export async function pgMirrorWrite(query, { namespace, expectVersion, generation, cookie, writtenBy } = {}) {
  sessionKeys(namespace);
  if (!isPlausibleCookie(cookie)) throw storeError(STORE_CODES.CONFIG, "implausible cookie");
  const gen = asBigIntString(generation);
  const version = asBigIntString(expectVersion);
  if (gen === null || version === null) throw storeError(STORE_CODES.CONFIG, "generation and version must be integers");
  const { rows } = await read(query, MIRROR_CAS_SQL, [namespace, version, cookie, gen, String(writtenBy || "mirror")]);
  const row = rows[0];
  if (!row) return { ok: false, code: STORE_CODES.ABSENT, reason: "absent", version: null };
  if (!("reason" in row)) throw storeError(STORE_CODES.UNAVAILABLE, "mirror cas returned an unexpected row shape");
  if (row.reason === null) return { ok: true, version: asNumber(row.version) };
  return {
    ok: false,
    code: STORE_CODES.MOVED,
    reason: String(row.reason),
    version: asNumber(row.version),
  };
}

/**
 * Record a real Paraform answer about a namespace. The ONLY writer of
 * `dead_at`, `last_verify_outcome` and `last_verified_at`.
 *
 * The dead ladder lives here, in one statement: `refused` increments the
 * streak and starts the clock; `ok` clears the streak, the clock, the write
 * error AND `dead_at`; `mismatch`/`error` record the outcome and leave the
 * ladder alone (a wrong identity is not a refusal, and must not resurrect a
 * dead row either). `dead_at` is set only at >= 3 consecutive refusals spanning
 * at least 20 minutes, and once set is never moved by a later refusal.
 */
export async function pgMarkVerified(query, {
  namespace, outcome, deadAfter = DEAD_AFTER_REFUSALS, deadSpanMs = DEAD_SPAN_MS,
} = {}) {
  sessionKeys(namespace);
  if (!VERIFY_OUTCOMES.includes(outcome)) throw storeError(STORE_CODES.CONFIG, "verify outcome");
  const { rows } = await read(
    query,
    `UPDATE paraform_session SET
        last_verified_at = clock_timestamp(),
        last_verify_outcome = $2::text,
        refused_streak = CASE WHEN $2::text = 'refused' THEN refused_streak + 1
                              WHEN $2::text = 'ok' THEN 0 ELSE refused_streak END,
        refused_since  = CASE WHEN $2::text = 'refused' THEN COALESCE(refused_since, clock_timestamp())
                              WHEN $2::text = 'ok' THEN NULL ELSE refused_since END,
        last_write_error = CASE WHEN $2::text = 'ok' THEN NULL ELSE last_write_error END,
        last_write_error_at = CASE WHEN $2::text = 'ok' THEN NULL ELSE last_write_error_at END,
        dead_at = CASE
          WHEN $2::text = 'ok' THEN NULL
          WHEN $2::text = 'refused'
               AND refused_streak + 1 >= $3::int
               AND COALESCE(refused_since, clock_timestamp())
                   <= clock_timestamp() - make_interval(secs => $4::numeric / 1000.0)
            THEN COALESCE(dead_at, clock_timestamp())
          ELSE dead_at END
      WHERE namespace = $1::text
      RETURNING namespace, last_verify_outcome, refused_streak::text AS refused_streak,
                refused_since::text AS refused_since, dead_at::text AS dead_at`,
    [namespace, outcome, String(deadAfter), String(deadSpanMs)],
  );
  const row = rows[0];
  if (!row) return { ok: false, reason: "absent" };
  return {
    ok: true,
    outcome: row.last_verify_outcome,
    refusedStreak: asNumber(row.refused_streak) ?? 0,
    refusedSince: asIsoString(row.refused_since),
    deadAt: asIsoString(row.dead_at),
    dead: Boolean(row.dead_at),
  };
}

/**
 * Stamp a failed write-back on the row (PS17). A swallowed write failure is how
 * a chain quietly stops being renewed; this is what the `session_write` page
 * and the lane health beat read.
 */
export async function pgRecordWriteError(query, { namespace, code } = {}) {
  sessionKeys(namespace);
  const { rows } = await read(
    query,
    `UPDATE paraform_session
        SET last_write_error = $2::text, last_write_error_at = clock_timestamp()
      WHERE namespace = $1::text
      RETURNING namespace, last_write_error, last_write_error_at::text AS last_write_error_at`,
    [namespace, String(code || "unknown").slice(0, 200)],
  );
  const row = rows[0];
  return row
    ? { ok: true, code: row.last_write_error, at: asIsoString(row.last_write_error_at) }
    : { ok: false, reason: "absent" };
}

// ── synthesizing the n8n row shape (so every caller runs unchanged) ─────────

/** One generation's worth of n8n-shaped rows. ids are opaque `pg:` strings:
 *  nothing in pg is deleted by id, and `applyRenewal`'s prune list is ignored. */
function generationRows(namespace, generation, cookie) {
  const keys = sessionKeys(namespace);
  const chunks = chunkCookie(String(cookie), CHUNK_LIMIT);
  const rows = chunks.map((chunk, index) => ({
    id: `pg:${namespace}:${generation}:${index + 1}`,
    key: `${keys.generationPrefix}${generation}_${index + 1}`,
    value: chunk,
    source: "pg",
  }));
  rows.push({
    id: `pg:${namespace}:${generation}:PARTS`,
    key: `${keys.generationPrefix}${generation}_PARTS`,
    value: String(chunks.length),
    source: "pg",
  });
  return rows;
}

/**
 * Synthesize the n8n variable listing for pg-held namespaces: the current
 * generation's chunks + `_PARTS`, the newest history generation (so
 * `planRenewal` sees the same "one older generation" it sees in n8n and never
 * re-uses its number), and the `_CURRENT_GENERATION` pointer.
 *
 * There is deliberately NO legacy layout (`<NS>`, `_PARTS`, `_A`, `_B`): the pg
 * store never had one, and a caller that falls through to it is a legacy reader
 * that must be found and fixed, not quietly served (PS15). `resolveStoreSession`
 * turns that fall-through into PARAFORM_SESSION_LEGACY_UNSUPPORTED.
 */
export async function pgListRows(query, { namespaces = null, rows: given = null } = {}) {
  const records = given ?? await pgListNamespaces(query, { namespaces });
  const out = [];
  for (const record of records) {
    if (record.prevGeneration && record.prevCookie && record.prevGeneration !== record.generation) {
      out.push(...generationRows(record.namespace, record.prevGeneration, record.prevCookie));
    }
    if (record.cookie) out.push(...generationRows(record.namespace, record.generation, record.cookie));
    out.push({
      id: `pg:${record.namespace}:pointer`,
      key: sessionKeys(record.namespace).currentGeneration,
      value: String(record.generation),
      source: "pg",
    });
  }
  return out;
}

/** True when these rows came out of pgListRows. */
function isSynthesized(rows, namespace) {
  const keys = sessionKeys(namespace);
  return rows.some((row) => row?.source === "pg"
    && (row.key === keys.namespace || String(row.key ?? "").startsWith(`${keys.namespace}_`)));
}

/**
 * `resolveSession` with the legacy fall-through closed for pg rows.
 *
 * A caller in pg mode must use this (or `store.resolve()`): the pure
 * `resolveSession` in paraform-session.mjs ends at `legacyCookieFromRows`,
 * whose error message ("… not found in n8n variables") is a lie once the store
 * is Postgres.
 */
export function resolveStoreSession(rows = [], { namespace = DEFAULT_SESSION_NAMESPACE } = {}) {
  const synthesized = isSynthesized(rows, namespace);
  let resolved;
  try {
    resolved = resolveSession(rows, { namespace });
  } catch (error) {
    if (synthesized) {
      throw storeError(STORE_CODES.LEGACY_UNSUPPORTED, `${namespace} has no usable pg generation`, { cause: error });
    }
    throw error;
  }
  if (synthesized && resolved.source === "legacy") {
    throw storeError(STORE_CODES.LEGACY_UNSUPPORTED, `${namespace} resolved through the legacy layout`);
  }
  return resolved;
}

// ── applying a renewal plan against pg ──────────────────────────────────────

/** Rebuild the cookie a plan would have written to n8n. */
export function valueFromPlan(plan, namespace) {
  if (!plan) return null;
  if (typeof plan.value === "string" && isPlausibleCookie(plan.value)) return plan.value;
  const keys = sessionKeys(namespace);
  const prefix = `${keys.generationPrefix}${plan.generation}_`;
  const parts = plan.creates?.find((create) => create.key === `${prefix}PARTS`);
  const count = Number(parts?.value);
  if (!Number.isInteger(count) || count < 1) return null;
  let value = "";
  for (let index = 1; index <= count; index += 1) {
    const chunk = plan.creates.find((create) => create.key === `${prefix}${index}`);
    if (typeof chunk?.value !== "string" || !chunk.value.length) return null;
    value += chunk.value;
  }
  return isPlausibleCookie(value) ? value : null;
}

function namespaceFromPlan(plan) {
  const key = plan?.creates?.[0]?.key;
  const match = /^([A-Z][A-Z0-9_]{1,127})_G\d+_(?:PARTS|\d+)$/u.exec(String(key ?? ""));
  return match ? match[1] : null;
}

/**
 * Apply a `planRenewal` plan to the pg store under CAS.
 *
 * Returns the same shape `applyRenewal` returns today
 * (`{ generation, pointerGeneration, created, pruned }`) so the seat code and
 * lifecycle keep working; `pruned` is always 0 (history keeps itself) and
 * `written` says whether a row actually moved.
 *
 * Throws PARAFORM_SESSION_STORE_MOVED (with `.reason = "store_moved"`) when the
 * row moved under us — one re-read and retry for `version_conflict`, none for
 * `generation_stale` — and PARAFORM_SESSION_STORE_NOT_AUTHORITATIVE when the
 * namespace still belongs to n8n.
 */
export async function pgApplyRenewal(query, {
  plan, writtenBy, namespace = null, lineage = null, runtimeId = null,
} = {}) {
  const ns = namespace ?? namespaceFromPlan(plan);
  if (!ns) throw storeError(STORE_CODES.CONFIG, "namespace required");
  sessionKeys(ns);
  if (!plan) throw storeError(STORE_CODES.CONFIG, "plan required");
  if (!plan.creates?.length) {
    // The "pointer is stale, nothing to create" plan n8n needs. pg has no
    // separate pointer, so there is nothing to do and nothing to fail.
    return { generation: plan.generation, pointerGeneration: plan.generation, created: 0, pruned: 0, written: false };
  }
  const value = valueFromPlan(plan, ns);
  if (!value) throw storeError(STORE_CODES.CONFIG, "plan does not reassemble");

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const row = await pgReadNamespace(query, { namespace: ns, runtimeId });
    if (!row) throw storeError(STORE_CODES.ABSENT, ns);
    if (!row.isPg) {
      throw storeError(STORE_CODES.NOT_AUTHORITATIVE, ns, { reason: "not_authoritative", namespace: ns });
    }
    if (row.cookie === value && row.generation >= plan.generation) {
      return { generation: row.generation, pointerGeneration: row.generation, created: 0, pruned: 0, written: false };
    }
    const result = await pgCasWrite(query, {
      namespace: ns,
      expectVersion: row.version,
      generation: plan.generation,
      cookie: value,
      lineage,
      writtenBy,
    });
    if (result.ok) {
      return {
        generation: plan.generation,
        pointerGeneration: plan.generation,
        created: plan.creates.length,
        pruned: 0,
        written: true,
        version: result.version,
      };
    }
    if (result.reason === "version_conflict" && attempt === 0) continue; // re-read once
    if (result.reason === "not_authoritative") {
      throw storeError(STORE_CODES.NOT_AUTHORITATIVE, ns, { reason: "not_authoritative", namespace: ns });
    }
    throw storeError(STORE_CODES.MOVED, `${ns}:${result.reason}`, { reason: "store_moved", namespace: ns });
  }
  throw storeError(STORE_CODES.MOVED, `${ns}:version_conflict`, { reason: "store_moved", namespace: ns });
}

// ── the env-driven store every consumer opens ───────────────────────────────

/** Is this runtime configured to reach the store at all, in its own mode? */
export function paraformStoreConfigured(env = process.env, {
  storeEnvKey = STORE_ENV_KEY, databaseUrlEnvKey = DATABASE_URL_ENV_KEY, query = null,
} = {}) {
  const mode = String(env?.[storeEnvKey] ?? "n8n").trim().toLowerCase() || "n8n";
  if (!STORE_MODES.includes(mode)) return false;
  if (mode === "pg") return Boolean(query) || Boolean(String(env?.[databaseUrlEnvKey] ?? "").trim());
  return Boolean(String(env?.N8N_BASE_URL ?? "").trim()) && Boolean(String(env?.N8N_API_KEY ?? "").trim());
}

/**
 * Open the store this runtime is configured for.
 *
 * `query` is injected by runtimes that already have a pool (the CRM); every
 * other runtime gets the zero-dependency Neon HTTP path built from
 * `PARAFORM_SESSION_DATABASE_URL` (a least-privilege login role — never a
 * generic `DATABASE_URL`, which would hand a cookie-only consumer the whole
 * candidate database).
 */
export function sessionStoreFromEnv(env = process.env, {
  fetchImpl = fetch,
  query = null,
  databaseUrl = null,
  writtenBy = "unknown",
  runtimeId = null,
  storeEnvKey = STORE_ENV_KEY,
  databaseUrlEnvKey = DATABASE_URL_ENV_KEY,
  n8nBase = null,
  n8nKey = null,
  timeoutMs = undefined,
} = {}) {
  const mode = String(env?.[storeEnvKey] ?? "n8n").trim().toLowerCase() || "n8n";
  if (!STORE_MODES.includes(mode)) {
    throw storeError(STORE_CODES.CONFIG, `${storeEnvKey} must be n8n or pg`);
  }
  const base = n8nBase ?? env?.N8N_BASE_URL ?? null;
  const key = n8nKey ?? env?.N8N_API_KEY ?? null;
  const n8nReady = Boolean(String(base ?? "").trim()) && Boolean(String(key ?? "").trim());

  let q = null;
  if (mode === "pg") {
    // PS16: the renewal kill switch in pg mode is only honest if the runtime
    // also declares itself read-only; otherwise a lane silently stops renewing.
    if (String(env?.PARAFORM_SESSION_RENEWAL_DISABLED ?? "") === "1"
      && String(env?.PARAFORM_SESSION_READ_ONLY ?? "") !== "1") {
      throw storeError(STORE_CODES.CONFIG, "PARAFORM_SESSION_RENEWAL_DISABLED needs PARAFORM_SESSION_READ_ONLY=1 in pg mode");
    }
    const url = databaseUrl ?? env?.[databaseUrlEnvKey] ?? null;
    if (query) q = query;
    else if (String(url ?? "").trim()) q = neonHttpQuery(url, { fetchImpl, timeoutMs });
    else throw storeError(STORE_CODES.CONFIG, `${databaseUrlEnvKey} required in pg mode`);
  } else if (!n8nReady) {
    throw storeError(STORE_CODES.CONFIG, "N8N_BASE_URL and N8N_API_KEY required in n8n mode");
  }

  const stamped = new Set();
  const n8nCreds = () => {
    if (!n8nReady) throw storeError(STORE_CODES.CONFIG, "N8N_BASE_URL and N8N_API_KEY required for an n8n-authoritative namespace");
    return { base, key, fetchImpl };
  };
  const stampFor = (namespace) => {
    if (!runtimeId || stamped.has(namespace)) return null;
    stamped.add(namespace);
    return runtimeId;
  };

  /** The row for a namespace, or null. Null outside pg mode. */
  async function readNamespace(namespace) {
    if (mode !== "pg") return null;
    return pgReadNamespace(q, { namespace, runtimeId: stampFor(namespace) });
  }

  /** Which store owns this namespace right now. Absent row = n8n (the default). */
  async function authoritativeStoreOf(namespace) {
    const row = await readNamespace(namespace);
    return { store: row?.isPg ? "pg" : "n8n", row };
  }

  /**
   * The variable listing every existing caller expects. In pg mode it is the
   * UNION of the real n8n rows (for namespaces n8n still owns) and the
   * synthesized rows (for namespaces pg owns) — so one listing serves a process
   * whose namespaces are mid-migration, and a pg-owned namespace's n8n rows
   * (which by then hold the sentinel) can never be read by accident.
   */
  async function listRows({ namespaces = null } = {}) {
    if (mode !== "pg") {
      try {
        return await listVariables(n8nCreds());
      } catch (error) {
        if (error?.code === STORE_CODES.CONFIG) throw error;
        throw storeError(STORE_CODES.UNAVAILABLE, "n8n variables read failed", { cause: error });
      }
    }
    const records = await pgListNamespaces(q, { namespaces });
    const toStamp = records.map((record) => record.namespace).filter((name) => stampFor(name));
    if (toStamp.length) await pgStampOpened(q, { namespaces: toStamp, runtimeId });
    const pgOwned = records.filter((record) => record.isPg);
    const synthesized = await pgListRows(q, { rows: pgOwned });
    const needsN8n = records.length === 0 || records.some((record) => !record.isPg);
    if (!needsN8n && namespaces) return synthesized;
    let n8nRows = [];
    try {
      n8nRows = await listVariables(n8nCreds());
    } catch (error) {
      if (pgOwned.length && !needsN8n) return synthesized; // nothing n8n-owned to lose
      if (error?.code === STORE_CODES.CONFIG) throw error;
      throw storeError(STORE_CODES.UNAVAILABLE, "n8n variables read failed", { cause: error });
    }
    const owned = pgOwned.map((record) => record.namespace);
    const hidden = (rowKey) => owned.some((namespace) => rowKey === namespace || rowKey.startsWith(`${namespace}_`));
    return [...n8nRows.filter((row) => !hidden(String(row?.key ?? ""))), ...synthesized];
  }

  /** Resolve one namespace's live cookie, obeying `authoritative_store`. */
  async function resolve(namespace = DEFAULT_SESSION_NAMESPACE) {
    if (mode !== "pg") {
      return resolveSession(await listRows(), { namespace });
    }
    const { store, row } = await authoritativeStoreOf(namespace);
    if (store === "pg") {
      if (!row?.cookie || !isPlausibleCookie(row.cookie)) {
        throw storeError(STORE_CODES.LEGACY_UNSUPPORTED, `${namespace} has no usable pg generation`);
      }
      return { value: row.cookie, generation: row.generation, source: "pg", version: row.version };
    }
    let rows;
    try {
      rows = await listVariables(n8nCreds());
    } catch (error) {
      if (error?.code === STORE_CODES.CONFIG) throw error;
      throw storeError(STORE_CODES.UNAVAILABLE, "n8n variables read failed", { cause: error });
    }
    return resolveSession(rows, { namespace });
  }

  /** Apply a renewal plan to whichever store owns the namespace. */
  async function applyRenewal({ plan, namespace = null, lineage = null } = {}) {
    const ns = namespace ?? namespaceFromPlan(plan) ?? DEFAULT_SESSION_NAMESPACE;
    if (mode !== "pg") {
      return n8nApplyRenewal({ ...n8nCreds(), plan, namespace: ns });
    }
    const { store } = await authoritativeStoreOf(ns);
    if (store === "n8n") return n8nApplyRenewal({ ...n8nCreds(), plan, namespace: ns });
    return pgApplyRenewal(q, { plan, namespace: ns, writtenBy, lineage, runtimeId: null });
  }

  return {
    mode,
    writtenBy,
    runtimeId,
    get query() { return q; },
    listRows,
    listNamespaces: (options = {}) => (mode === "pg"
      ? pgListNamespaces(q, options)
      : Promise.resolve([])),
    readNamespace,
    authoritativeStoreOf,
    resolve,
    resolveRows: (rows, options) => resolveStoreSession(rows, options),
    applyRenewal,
    casWrite: ({ namespace, expectVersion, generation, cookie, lineage = null } = {}) => {
      if (mode !== "pg") throw storeError(STORE_CODES.CONFIG, "casWrite needs pg mode");
      return pgCasWrite(q, { namespace, expectVersion, generation, cookie, lineage, writtenBy });
    },
    insertIfAbsent: (options = {}) => {
      if (mode !== "pg") throw storeError(STORE_CODES.CONFIG, "insertIfAbsent needs pg mode");
      return pgInsertIfAbsent(q, { writtenBy, ...options });
    },
    // markVerified/recordWriteError write OBSERVABILITY, not authority: they run
    // whenever a DB handle exists, even while n8n is still authoritative (M1/M2),
    // and no-op without one.
    markVerified: (namespace, outcome, options = {}) => (q
      ? pgMarkVerified(q, { namespace, outcome, ...options })
      : Promise.resolve({ ok: false, reason: "no_store" })),
    recordWriteError: (namespace, code) => (q
      ? pgRecordWriteError(q, { namespace, code })
      : Promise.resolve({ ok: false, reason: "no_store" })),
  };
}

// ── the mirror (transition only) ────────────────────────────────────────────

/** Newest generation present in an n8n listing for a namespace, and whether its
 *  first chunk is already the sentinel. Deliberately small: enough to decide a
 *  copy, without reimplementing the assembly in paraform-session.mjs. */
export function n8nGenerationState(rows = [], namespace = DEFAULT_SESSION_NAMESPACE) {
  const keys = sessionKeys(namespace);
  const pattern = new RegExp(`^${keys.generationPrefix}(\\d+)_(PARTS|\\d+)$`, "u");
  let newest = null;
  const firstChunks = new Map();
  for (const row of rows) {
    const match = pattern.exec(String(row?.key ?? ""));
    if (!match) continue;
    const generation = Number(match[1]);
    if (newest === null || generation > newest) newest = generation;
    if (match[2] === "1") firstChunks.set(generation, row.value);
  }
  const pointer = rows.filter((row) => row?.key === keys.currentGeneration);
  return {
    newestGeneration: newest,
    pointerGeneration: pointer.length === 1 ? Number(pointer[0].value) : null,
    pointerAmbiguous: pointer.length > 1,
    pointerRow: pointer.length === 1 ? pointer[0] : null,
    sentinel: newest !== null && firstChunks.get(newest) === SENTINEL_N8N_VALUE,
  };
}

const N8N_TIMEOUT_MS = 15_000;

async function n8nPost({ base, key, fetchImpl }, path, body, method = "POST") {
  const root = String(base).replace(/\/+$/u, "");
  const response = await fetchImpl(`${root}${path}`, {
    method,
    headers: { "X-N8N-API-KEY": key, "content-type": "application/json", accept: "application/json" },
    ...(body === null || body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(N8N_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`n8n write failed: ${response.status}`);
  return response;
}

/**
 * Write the sentinel generation to the n8n side of a namespace pg now owns,
 * and REMOVE every older generation of that namespace.
 *
 * Two reasons it is not `applyRenewal`:
 *   * that readback asserts the generation reassembles into a PLAUSIBLE
 *     cookie, and the point of the sentinel is that it is not one;
 *   * leaving the older real generations in place would defeat it entirely —
 *     `resolveSession` skips an unusable newest generation and happily serves
 *     the one below it, so a stale checkout would keep working off a forked
 *     chain instead of failing. The n8n Code nodes read the pointer and throw
 *     either way; JS readers only fail once the older generations are gone.
 *
 * The LEGACY rows (`<NS>`, `_PARTS`, `_A`, `_B`) are deliberately left alone:
 * they belong to the operator, only the shared namespace has them, and the
 * shared namespace keeps its real value until C3 (they are retired in M4).
 */
export async function n8nWriteSentinel({ base, key, fetchImpl = fetch }, { namespace, generation }) {
  const keys = sessionKeys(namespace);
  const creds = { base, key, fetchImpl };
  const prefix = `${keys.generationPrefix}${generation}_`;
  await n8nPost(creds, "/api/v1/variables", { key: `${prefix}1`, value: SENTINEL_N8N_VALUE });
  await n8nPost(creds, "/api/v1/variables", { key: `${prefix}PARTS`, value: "1" });
  const rows = await listVariables(creds);
  const state = n8nGenerationState(rows, namespace);
  const pointerBody = { key: keys.currentGeneration, value: String(generation) };
  if (state.pointerAmbiguous) throw new Error("n8n generation pointer is ambiguous");
  await n8nPost(
    creds,
    state.pointerRow
      ? `/api/v1/variables/${encodeURIComponent(state.pointerRow.id)}`
      : "/api/v1/variables",
    pointerBody,
    state.pointerRow ? "PUT" : "POST",
  );
  // Prune every other generation of this namespace, newest-first readback after.
  const generationKey = new RegExp(`^${keys.generationPrefix}(\\d+)_(?:PARTS|\\d+)$`, "u");
  for (const row of rows) {
    const match = generationKey.exec(String(row?.key ?? ""));
    if (!match || Number(match[1]) === Number(generation) || !row.id) continue;
    await n8nPost(creds, `/api/v1/variables/${encodeURIComponent(row.id)}`, null, "DELETE");
  }
  const afterRows = await listVariables(creds);
  const after = n8nGenerationState(afterRows, namespace);
  if (!after.sentinel || after.pointerGeneration !== Number(generation)) {
    throw new Error("n8n sentinel readback failed");
  }
  if (afterRows.some((row) => {
    const match = generationKey.exec(String(row?.key ?? ""));
    return match && Number(match[1]) !== Number(generation);
  })) {
    throw new Error("n8n sentinel left an older generation readable");
  }
  return { generation: Number(generation), sentinel: true };
}

function mirrorDirectionFor(control) {
  const raw = typeof control === "string" ? control : control?.session_mirror ?? control?.sessionMirror ?? "off";
  const direction = String(raw ?? "off").trim().toLowerCase();
  return MIRROR_DIRECTIONS.includes(direction) ? direction : "off";
}

/**
 * One mirror pass: copy the AUTHORITATIVE side of each namespace to the other
 * side so no lane ever loses its login mid-migration.
 *
 * Rules (SPEC 3.1, PS6, PS12, PS14):
 *   * direction comes from `dispatch_control.session_mirror`; `auto` means
 *     authoritative -> other. `off` copies nothing.
 *   * a copy happens ONLY when the source generation is strictly newer, so a
 *     generation number means the same thing in both stores.
 *   * equal generation + different value is a CONFLICT: nothing is copied, the
 *     pass reports it, `dispatch_control.stage_blocked` is set, and a human runs
 *     ops/paraform-session/resolve-conflict.mjs. Never auto-resolved: probing
 *     both candidates can rotate both and log the seat out.
 *   * a pg-authoritative namespace's n8n side gets the SENTINEL, except for
 *     namespaces in `sentinelExempt` (the shared namespace, until wf01/02/04 are
 *     deactivated at C3), which get the real value because n8n still reads it.
 *   * namespaces that are pg-native (slot `DISP`) are skipped entirely.
 *   * this function NEVER calls Paraform, and never touches `dead_at` or
 *     `last_verify_outcome`.
 *
 * -> { direction, dryRun, checked, copied, conflicts, skipped, entries, stageBlocked }
 */
export async function mirrorOnce({
  n8n: n8nIn = null,
  query,
  control = "off",
  namespaces = null,
  dryRun = false,
  writtenBy = "mirror",
  sentinelExempt = [DEFAULT_SESSION_NAMESPACE],
  setStageBlocked = null,
  recordTick = null,
} = {}) {
  const direction = mirrorDirectionFor(control);
  const startedAt = new Date().toISOString();
  const result = {
    direction, dryRun, checked: 0, copied: 0, conflicts: 0, skipped: 0,
    entries: [], stageBlocked: null, startedAt,
  };
  const finish = async (outcome) => {
    result.outcome = outcome;
    if (recordTick) {
      try { await recordTick({ kind: "session-mirror", startedAt, ...result }); }
      catch { result.tickRecorded = false; }
    }
    return result;
  };
  if (direction === "off") {
    result.outcome = "mirror_off";
    return result;
  }

  const records = await pgListNamespaces(query, { namespaces });
  const exempt = new Set((sentinelExempt ?? []).map((entry) => String(entry)));
  // A namespace the operator NAMED but that has no row yet is seeded from the
  // n8n side on this pass (M1's "one-shot seed = first pass"). An unnamed pass
  // never invents rows: a seed is a decision, and it is made with a list.
  const toSeed = (namespaceList(namespaces) ?? "").split(",").filter(Boolean)
    .filter((namespace) => !records.some((record) => record.namespace === namespace));
  const creds = n8nIn
    ? { base: n8nIn.base, key: n8nIn.key, fetchImpl: n8nIn.fetchImpl ?? fetch }
    : null;
  if (!creds?.base || !creds?.key) throw storeError(STORE_CODES.CONFIG, "mirror needs n8n credentials");

  let n8nRows;
  try {
    n8nRows = await listVariables(creds);
  } catch (error) {
    throw storeError(STORE_CODES.UNAVAILABLE, "n8n variables read failed", { cause: error });
  }

  for (const record of records) {
    const namespace = record.namespace;
    if (namespaces === null && record.slot === "DISP") {
      result.skipped += 1;
      result.entries.push({ namespace, action: "skipped", reason: "pg_native" });
      continue;
    }
    result.checked += 1;
    const state = n8nGenerationState(n8nRows, namespace);
    let n8nValue = null;
    if (state.newestGeneration !== null && !state.sentinel) {
      try { n8nValue = resolveSession(n8nRows, { namespace }).value; } catch { n8nValue = null; }
    }
    const from = direction === "auto"
      ? (record.isPg ? "pg" : "n8n")
      : (direction === "to_pg" ? "n8n" : "pg");

    if (from === "n8n") {
      // n8n -> pg. The authoritative side is n8n (or an operator forced it).
      if (state.sentinel) {
        result.skipped += 1;
        result.entries.push({ namespace, action: "skipped", reason: "n8n_holds_sentinel" });
        continue;
      }
      if (!n8nValue || state.newestGeneration === null) {
        result.skipped += 1;
        result.entries.push({ namespace, action: "skipped", reason: "n8n_has_no_generation" });
        continue;
      }
      if (state.newestGeneration === record.generation) {
        if (n8nValue !== record.cookie) {
          result.conflicts += 1;
          result.entries.push({
            namespace, action: "conflict", reason: "same_generation_different_value",
            generation: state.newestGeneration,
          });
          continue;
        }
        result.skipped += 1;
        result.entries.push({ namespace, action: "skipped", reason: "equal" });
        continue;
      }
      if (state.newestGeneration < record.generation) {
        result.skipped += 1;
        result.entries.push({
          namespace, action: "skipped", reason: "target_is_newer",
          generation: record.generation,
        });
        continue;
      }
      if (dryRun) {
        result.entries.push({ namespace, action: "would_copy", to: "pg", generation: state.newestGeneration });
        continue;
      }
      const applied = await pgMirrorWrite(query, {
        namespace,
        expectVersion: record.version,
        generation: state.newestGeneration,
        cookie: n8nValue,
        writtenBy: `${writtenBy}:n8n`,
      });
      if (applied.ok) {
        result.copied += 1;
        result.entries.push({ namespace, action: "copied", to: "pg", generation: state.newestGeneration });
      } else {
        result.skipped += 1;
        result.entries.push({ namespace, action: "skipped", reason: applied.reason });
      }
      continue;
    }

    // pg -> n8n. Either a pg-authoritative namespace keeping n8n honest (the
    // sentinel), the shared namespace n8n still reads (the real value), or a
    // `to_n8n` rollback pass.
    if (!record.cookie) {
      result.skipped += 1;
      result.entries.push({ namespace, action: "skipped", reason: "pg_has_no_cookie" });
      continue;
    }
    const wantsSentinel = record.isPg && !exempt.has(namespace);
    if (wantsSentinel && state.sentinel) {
      result.skipped += 1;
      result.entries.push({ namespace, action: "skipped", reason: "sentinel_present" });
      continue;
    }
    if (!wantsSentinel && !state.sentinel) {
      // Real value against a real value: the ordinary generation comparison.
      if (state.newestGeneration === record.generation) {
        if (n8nValue !== null && n8nValue !== record.cookie) {
          result.conflicts += 1;
          result.entries.push({
            namespace, action: "conflict", reason: "same_generation_different_value",
            generation: record.generation,
          });
          continue;
        }
        result.skipped += 1;
        result.entries.push({ namespace, action: "skipped", reason: "equal" });
        continue;
      }
      if (state.newestGeneration !== null && state.newestGeneration > record.generation) {
        result.skipped += 1;
        result.entries.push({ namespace, action: "skipped", reason: "target_is_newer", generation: state.newestGeneration });
        continue;
      }
    }
    // Writing the sentinel, or restoring the real value over one (the rollback
    // pass): both must land ABOVE whatever generation n8n currently holds.
    const generation = (wantsSentinel || state.sentinel)
      ? Math.max(record.generation, (state.newestGeneration ?? -1) + 1)
      : record.generation;
    if (dryRun) {
      result.entries.push({
        namespace, action: "would_copy", to: "n8n", generation,
        value: wantsSentinel ? "sentinel" : "real",
      });
      continue;
    }
    if (wantsSentinel) {
      await n8nWriteSentinel(creds, { namespace, generation });
    } else {
      const keys = sessionKeys(namespace);
      const chunks = chunkCookie(record.cookie, CHUNK_LIMIT);
      const plan = {
        generation,
        value: record.cookie,
        creates: [
          ...chunks.map((chunk, index) => ({ key: `${keys.generationPrefix}${generation}_${index + 1}`, value: chunk })),
          { key: `${keys.generationPrefix}${generation}_PARTS`, value: String(chunks.length) },
        ],
        deletes: [],
      };
      await n8nApplyRenewal({ ...creds, plan, namespace });
    }
    result.copied += 1;
    result.entries.push({
      namespace, action: "copied", to: "n8n", generation,
      value: wantsSentinel ? "sentinel" : "real",
    });
  }

  for (const namespace of toSeed) {
    const state = n8nGenerationState(n8nRows, namespace);
    if (state.newestGeneration === null || state.sentinel) {
      result.skipped += 1;
      result.entries.push({ namespace, action: "skipped", reason: "nothing_to_seed" });
      continue;
    }
    let value = null;
    try { value = resolveSession(n8nRows, { namespace }).value; } catch { value = null; }
    if (!value) {
      result.skipped += 1;
      result.entries.push({ namespace, action: "skipped", reason: "n8n_has_no_generation" });
      continue;
    }
    result.checked += 1;
    if (dryRun) {
      result.entries.push({ namespace, action: "would_seed", to: "pg", generation: state.newestGeneration });
      continue;
    }
    const { inserted } = await pgInsertIfAbsent(query, {
      namespace,
      generation: state.newestGeneration,
      cookie: value,
      writtenBy: `${writtenBy}:n8n`,
      authoritativeStore: "n8n",   // a seed never moves authority
    });
    result.copied += inserted ? 1 : 0;
    result.entries.push({
      namespace,
      action: inserted ? "seeded" : "skipped",
      reason: inserted ? undefined : "already_present",
      to: "pg",
      generation: state.newestGeneration,
    });
  }

  if (result.conflicts > 0) {
    const names = result.entries.filter((entry) => entry.action === "conflict").map((entry) => entry.namespace);
    const detail = `mirror_conflict:${names.join(",")}`.slice(0, 200);
    result.stageBlocked = detail;
    if (!dryRun) {
      try {
        if (setStageBlocked) await setStageBlocked(detail);
        else {
          await query(
            `UPDATE dispatch_control SET stage_blocked = $1::text, updated_by = $2::text,
                    updated_at = clock_timestamp() WHERE id = 1`,
            [detail, String(writtenBy)],
          );
        }
        result.stageBlockedWritten = true;
      } catch {
        // 087 may not be applied yet, or the role may not reach it. The pass
        // still REPORTS the conflict, and the caller pages on it.
        result.stageBlockedWritten = false;
      }
    }
    return finish("conflict");
  }
  return finish("ok");
}
