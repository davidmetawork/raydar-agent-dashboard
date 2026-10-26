// ─────────────────────────────────────────────────────────────────────────────
// lifecycle/_lib/neon-http.mjs — Postgres over Neon's SQL-over-HTTP endpoint,
// with ZERO npm dependencies.
//
// WHY THIS EXISTS. The Paraform session store moves out of n8n Variables into
// one Postgres row per namespace (migration 086). Its consumers are not all
// able to carry `pg`: raydar-dispatch is a zero-dependency Vercel project,
// raydar-lifecycle ships no node_modules, and GitHub runners should not install
// a driver to write one cookie. Neon's own serverless driver solves this with
// an HTTP endpoint that speaks one SQL statement per request; this file is the
// 60-line subset of that wire protocol we need, so every runtime can reach the
// store with `fetch` alone. Runtimes that DO have a pool (the CRM) inject their
// own `query` instead and never load this file.
//
// WIRE FORMAT VERIFIED 2026-10-26 against the published source of
// @neondatabase/serverless@1.0.1 (cdn.jsdelivr.net/npm/@neondatabase/
// serverless@1.0.1/index.js, the bundle's `neon()` executor):
//   * endpoint: the DEFAULT `fetchEndpoint` is
//       `(host, port, opts) => "https://" + host.replace(/^[^.]+\./, opts?.jwtAuth ? "apiauth." : "api.") + "/sql"`
//     i.e. the FIRST label of the database host is replaced by `api.`, so
//     `ep-x-pooler.us-west-2.aws.neon.tech` is reached at
//     `https://api.us-west-2.aws.neon.tech/sql`. (Older 0.x drivers posted to
//     `https://<host>/sql`; the SPEC's shorthand is that older form. We follow
//     the shipped 1.x default.)
//   * method POST, body `JSON.stringify({ query, params })` for a single
//     statement (`{ queries: [...] }` is the batch form; we do not use it).
//   * headers `Neon-Connection-String: <the whole postgres:// URL>`,
//     `Neon-Raw-Text-Output: "true"`, `Neon-Array-Mode: "true"`, and
//     `Authorization: Bearer <jwt>` only when JWT auth is configured.
//     We send ONLY the connection string (plus content-type/accept). We send
//     NEITHER `Neon-Raw-Text-Output` NOR `Neon-Array-Mode`: rows come back as
//     objects keyed by column name, typed as the server types them (below).
//   * a connection string must be `postgres:`/`postgresql:` and carry a
//     username, a hostname and a database path; the driver rejects it
//     otherwise with the same three checks made below.
//   * errors: HTTP 400 returns a JSON body whose `message` is the Postgres
//     message and which carries `severity`, `code` (SQLSTATE), `detail`,
//     `hint`, `position`, `constraint`, … Any other non-2xx returns a text
//     body the driver wraps as "Server error (HTTP status N)".
//   * success: JSON with `fields: [{name, …}]` and `rows`; `rowCount` and
//     `command` are passed through when the server sends them.
// MEASURED 2026-10-26 by the lead against the real CRM Neon endpoint, over
// HTTP, with read-only literal SELECTs. These are facts about the wire, not
// reading of a driver bundle:
//   * WITH `Neon-Raw-Text-Output: true` EVERY value comes back as a string:
//     bool "t", int "42", jsonb as JSON text, text[] as "{x,y}". We do NOT use
//     it: it makes every caller re-parse every value.
//   * WITHOUT that header (what this file sends): bool -> true/false,
//     int4 -> number, int8/bigint -> string, numeric -> string
//     ("1793034729593.856000"), jsonb -> object, text[] -> JS array,
//     NULL -> null, timestamptz -> string "2026-10-26 17:12:09.593854+00"
//     (Date.parse handles it in Node), timestamp WITHOUT tz -> string with no
//     offset. node-pg differs only in handing timestamptz back as a JS Date,
//     so every reader of a timestamp must accept Date OR string OR epoch number.
//   * Parameters: a JS array sent as a JSON array param works with
//     `$n::text[]` (["p","q,r","s\"t"] round-trips exactly, length 3); a PG
//     array literal string also works; a JSON-stringified object works with
//     `$n::jsonb`. A JSON array bound to a jsonb parameter would be read as a
//     Postgres array, so a caller that wants a jsonb ARRAY stringifies it
//     itself (a string always goes through untouched).
// SECRET HYGIENE. The connection string carries a password. It is sent only in
// the request header, is never logged, and never appears in a thrown error:
// every error here carries a short code and a short literal detail.
// ─────────────────────────────────────────────────────────────────────────────

/** Default per-request budget. One statement; a slow DB is a failure, not a wait. */
export const NEON_HTTP_TIMEOUT_MS = 10_000;

/** The first dot-terminated label of the host — the same regex the driver uses. */
const FIRST_HOST_LABEL = /^[^.]+\./u;

/** Postgres error fields Neon returns on a 400, kept under `error.pg`. */
const PG_ERROR_FIELDS = Object.freeze([
  "severity", "code", "detail", "hint", "position", "internalPosition",
  "internalQuery", "where", "schema", "table", "column", "dataType",
  "constraint", "file", "line", "routine",
]);

function coded(code, detail = "") {
  const error = new Error(detail ? `${code}: ${detail}` : code);
  error.code = code;
  return error;
}

/**
 * The SQL-over-HTTP URL for a Neon connection string.
 * @throws NEON_HTTP_URL_INVALID — never with the string itself in the message.
 */
export function neonHttpEndpoint(connectionString) {
  let url;
  try {
    url = new URL(String(connectionString ?? ""));
  } catch {
    throw coded("NEON_HTTP_URL_INVALID", "not a URL");
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw coded("NEON_HTTP_URL_INVALID", "needs a postgres:// or postgresql:// url");
  }
  const database = url.pathname.replace(/^\/+/u, "");
  if (!url.username || !url.hostname || !database) {
    throw coded("NEON_HTTP_URL_INVALID", "needs user, host and database");
  }
  if (!FIRST_HOST_LABEL.test(url.hostname)) {
    throw coded("NEON_HTTP_URL_INVALID", "host has no Neon endpoint label");
  }
  return `https://${url.hostname.replace(FIRST_HOST_LABEL, "api.")}/sql`;
}

/**
 * One parameter as the Neon HTTP endpoint takes it (measured 2026-10-26, see
 * the header). Scalars go as strings and Postgres casts from text, which is why
 * every statement casts its parameters explicitly: numbers, bigints and
 * booleans as decimal/word strings, dates as ISO strings. A plain object goes
 * as JSON text (for `$n::jsonb`). A JS array goes as a JSON ARRAY (for
 * `$n::text[]`, `$n::int[]`, ...), each element converted by the same rules, so
 * commas, quotes and braces in an element survive without any hand-built array
 * literal. To bind a jsonb array, pass JSON.stringify(array): a string is never
 * touched.
 */
export function toWireParam(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "bigint" || typeof value === "boolean") {
    return String(value);
  }
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((element) => toWireParam(element));
  return JSON.stringify(value);
}

/**
 * Build a `query(sql, params) -> { rows, fields, rowCount }` function over the
 * HTTP endpoint. The returned function has the same call shape as
 * `pg.Pool#query`, so every caller in the store works with either one.
 *
 * Errors (all have `.code`):
 *   NEON_HTTP_URL_INVALID      — bad connection string (thrown here, at build time)
 *   NEON_HTTP_UNAVAILABLE      — network failure, timeout, or non-400 non-2xx
 *   NEON_HTTP_QUERY_FAILED     — Postgres refused the statement; `.sqlstate`
 *                                and `.pg` carry the server's own fields
 *   NEON_HTTP_RESPONSE_INVALID — 2xx that is not the documented JSON shape
 */
export function neonHttpQuery(connectionString, {
  fetchImpl = fetch,
  timeoutMs = NEON_HTTP_TIMEOUT_MS,
  endpoint = null,
} = {}) {
  const url = endpoint ?? neonHttpEndpoint(connectionString);
  const connection = String(connectionString ?? "");
  return async function query(sql, params = []) {
    let response;
    try {
      response = await fetchImpl(url, {
        method: "POST",
        headers: {
          "Neon-Connection-String": connection,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({
          query: String(sql ?? ""),
          params: (params ?? []).map(toWireParam),
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      // TimeoutError, network refusal, DNS: one code, no URL, no credentials.
      throw coded("NEON_HTTP_UNAVAILABLE", String(error?.name || "fetch failed").slice(0, 60));
    }
    if (response.status === 400) {
      let body = null;
      try { body = await response.json(); } catch { /* keep the status only */ }
      const error = coded(
        "NEON_HTTP_QUERY_FAILED",
        String(body?.message ?? "bad request").slice(0, 200),
      );
      error.sqlstate = body?.code ?? null;
      error.pg = Object.fromEntries(
        PG_ERROR_FIELDS
          .filter((field) => body?.[field] !== undefined)
          .map((field) => [field, body[field]]),
      );
      throw error;
    }
    if (!response.ok) {
      throw coded("NEON_HTTP_UNAVAILABLE", `HTTP ${response.status}`);
    }
    let body;
    try { body = await response.json(); } catch { throw coded("NEON_HTTP_RESPONSE_INVALID", "not json"); }
    if (!body || !Array.isArray(body.rows)) {
      throw coded("NEON_HTTP_RESPONSE_INVALID", "no rows array");
    }
    return {
      rows: body.rows,
      fields: Array.isArray(body.fields) ? body.fields : [],
      rowCount: Number.isFinite(Number(body.rowCount)) ? Number(body.rowCount) : body.rows.length,
    };
  };
}
