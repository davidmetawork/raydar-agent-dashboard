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
//     We send the connection string and raw-text output, and we do NOT send
//     array mode, so rows come back as objects keyed by column name.
//   * a connection string must be `postgres:`/`postgresql:` and carry a
//     username, a hostname and a database path; the driver rejects it
//     otherwise with the same three checks made below.
//   * errors: HTTP 400 returns a JSON body whose `message` is the Postgres
//     message and which carries `severity`, `code` (SQLSTATE), `detail`,
//     `hint`, `position`, `constraint`, … Any other non-2xx returns a text
//     body the driver wraps as "Server error (HTTP status N)".
//   * success: JSON with `fields: [{name, …}]` and `rows`; `rowCount` and
//     `command` are passed through when the server sends them.
// NOT verifiable without a live Neon endpoint ([V] for the lead): that
// `Neon-Raw-Text-Output: true` returns every value as a string in OBJECT mode
// as well as in array mode. The store never relies on it — it casts bigints
// and timestamps to text in SQL and coerces defensively in JS — so either
// typing works.
//
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
 * Neon's HTTP endpoint takes parameters as JSON. Postgres then casts from text,
 * which is why every statement in the store casts its parameters explicitly.
 * Dates go as ISO strings, bigints and numbers as decimal strings, objects as
 * JSON; arrays are NOT supported on purpose — the store passes comma strings
 * and lets `string_to_array` do the work, so no driver-specific array literal
 * encoding can drift between the HTTP path and an injected `pg` pool.
 */
export function toWireParam(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "bigint" || typeof value === "boolean") {
    return String(value);
  }
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) throw coded("NEON_HTTP_PARAM_UNSUPPORTED", "array");
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
          "Neon-Raw-Text-Output": "true",
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
