// ─────────────────────────────────────────────────────────────────────────────
// api/_lib/paraform-session-store.mjs — the ONE shared Paraform session
// resolver for the dashboard. Used by BOTH api/seq/_lib/core.mjs and
// api/paraai/_lib/core.mjs so there is exactly one cache, one resolution
// order, and one fail-closed contract instead of two drifting copies.
//
// WHY THIS EXISTS (measured 2026-09-26 ~05:50Z). monitor.raydar.xyz/api/seq/
// health reported paraform "expired": both dashboard clients authenticated
// with a STATIC Vercel env value (PARAFORM_SESSION_COOKIE / PARAFORM_COOKIE),
// which WorkOS AuthKit rotates on every response and which therefore dies
// within hours. Meanwhile the shared n8n session store already held a live,
// daily-renewed session for account 'david' (see
// lifecycle/_lib/paraform-session.mjs and docs-site/src/content/docs/
// reference/paraform-session-renewal.md in the raydar repo). This module
// ports that store's read side into the dashboard so both Paraform clients
// resolve the SAME durable, self-renewing session instead of a frozen seal.
//
// This file deliberately mirrors lifecycle/_lib/paraform-session.mjs's pure
// generation/chunk logic byte-for-byte (chunk limit, key shapes, fail-closed
// assembly) rather than reinventing it — the two repos cannot share code
// directly, so "mirror exactly" is the contract that keeps them compatible
// with the same live n8n rows. This module is READ-ONLY: it never creates,
// updates, or prunes n8n variables, and it never writes a rotated
// `Set-Cookie` back to the store — renewal stays lifecycle's job.
// ─────────────────────────────────────────────────────────────────────────────

// n8n's per-variable ceiling (unchanged from lifecycle: the live `_A` chunk
// sits at exactly 1000, which is how the limit was originally found).
export const CHUNK_LIMIT = 1000;

// The pre-existing shared namespace every non-account caller has always used
// (env seed PARAFORM_SESSION_COOKIE, its generational PARAFORM_SESSION_COOKIE_G<n>_*
// keys, and the legacy PARAFORM_SESSION_COOKIE_PARTS/_A/_B chunks).
export const DEFAULT_SESSION_NAMESPACE = "PARAFORM_SESSION_COOKIE";

// David's isolated account-scoped generational namespace, named exactly the
// way lifecycle/_lib/paraform-accounts.mjs's paraformAccountSessionNamespace()
// derives it: `PARAFORM_${ACCOUNT.toUpperCase()}_SESSION`. Overridable so an
// operator can point this at a different account slot without a redeploy;
// never used to fall back onto another account silently.
export const DEFAULT_PARAFORM_SESSION_ACCOUNT = "david";
export function paraformAccountSessionNamespace(account) {
  const key = String(account ?? "").trim().toLowerCase();
  if (!/^[a-z][a-z0-9]{1,32}$/u.test(key)) {
    const error = new Error("PARAFORM_SESSION_ACCOUNT_INVALID");
    error.code = "PARAFORM_SESSION_ACCOUNT_INVALID";
    throw error;
  }
  return `PARAFORM_${key.toUpperCase()}_SESSION`;
}

// The namespace actually used when PARAFORM_SESSION_ACCOUNT is unset (the
// production default: David's seat). Exported for tests and callers that
// want to name it without recomputing it.
export const ACCOUNT_SESSION_NAMESPACE = paraformAccountSessionNamespace(
  DEFAULT_PARAFORM_SESSION_ACCOUNT,
);

const SESSION_NAMESPACE = /^[A-Z][A-Z0-9_]{1,127}$/u;

export function sessionKeys(namespace = DEFAULT_SESSION_NAMESPACE) {
  const base = String(namespace ?? "").trim();
  if (!SESSION_NAMESPACE.test(base)) {
    const error = new Error("PARAFORM_SESSION_NAMESPACE_INVALID");
    error.code = "PARAFORM_SESSION_NAMESPACE_INVALID";
    throw error;
  }
  return Object.freeze({
    namespace: base,
    generationPrefix: `${base}_G`,
    currentGeneration: `${base}_CURRENT_GENERATION`,
    legacy: base,
    legacyParts: `${base}_PARTS`,
    legacyA: `${base}_A`,
    legacyB: `${base}_B`,
  });
}

// A seal is opaque, so validation is structural only: right shape, sane size,
// and nothing that could break out of a cookie header. Mirrors
// lifecycle/_lib/paraform-session.mjs's isPlausibleCookie exactly.
const MIN_COOKIE_LENGTH = 64;
const MAX_COOKIE_LENGTH = 8 * CHUNK_LIMIT;

export function isPlausibleCookie(value) {
  if (typeof value !== "string") return false;
  if (value.length < MIN_COOKIE_LENGTH || value.length > MAX_COOKIE_LENGTH) return false;
  // Whitespace, ';' and ',' would terminate or inject cookie attributes.
  if (/[\s;,]/u.test(value)) return false;
  // The two shapes Paraform has ever issued: WorkOS iron seals and NextAuth JWEs.
  return value.startsWith("Fe26.2") || value.startsWith("eyJ");
}

function generationOf(key, keys) {
  if (!key || !key.startsWith(keys.generationPrefix)) return null;
  const rest = key.slice(keys.generationPrefix.length);
  const match = /^(\d+)_(PARTS|\d+)$/u.exec(rest);
  if (!match) return null;
  return { generation: Number(match[1]), field: match[2] };
}

/** Group raw n8n variable rows into candidate generations. Fail-closed: a
 *  duplicate marker or a conflicting duplicate chunk poisons that field
 *  rather than picking one arbitrarily. */
function collectGenerations(rows, keys) {
  const generations = new Map();
  for (const row of rows) {
    const parsed = generationOf(row?.key, keys);
    if (!parsed) continue;
    if (!generations.has(parsed.generation)) {
      generations.set(parsed.generation, { generation: parsed.generation, parts: null, chunks: new Map() });
    }
    const entry = generations.get(parsed.generation);
    if (parsed.field === "PARTS") {
      entry.parts = entry.parts === null ? Number(row.value) : NaN;
      continue;
    }
    const index = Number(parsed.field);
    if (entry.chunks.has(index) && entry.chunks.get(index) !== row.value) {
      entry.chunks.set(index, null); // conflicting duplicate — poison this index
    } else if (!entry.chunks.has(index)) {
      entry.chunks.set(index, row.value);
    }
  }
  return generations;
}

/** Assemble a generation, or null if it is incomplete, contradictory, or does
 *  not reconstruct into a plausible cookie. Callers fall back to the next
 *  newest (and eventually to legacy), so a bad generation degrades rather
 *  than breaks — this IS the "fail closed on inconsistent chunk state". */
function assembleGeneration(entry) {
  if (!entry) return null;
  const parts = entry.parts;
  if (!Number.isInteger(parts) || parts < 1) return null;
  let value = "";
  for (let index = 1; index <= parts; index += 1) {
    const chunk = entry.chunks.get(index);
    if (typeof chunk !== "string" || chunk.length === 0) return null;
    value += chunk;
  }
  return isPlausibleCookie(value) ? value : null;
}

export function legacyCookieFromRows(rows = [], { namespace = DEFAULT_SESSION_NAMESPACE } = {}) {
  const keys = sessionKeys(namespace);
  const variables = new Map(rows.map((entry) => [entry?.key, entry?.value]));
  const parts = Number(variables.get(keys.legacyParts) || 0);
  if (parts !== 0 && parts !== 2) throw new Error(`${keys.legacyParts}_INVALID`);
  if (parts === 2) {
    const first = variables.get(keys.legacyA);
    const second = variables.get(keys.legacyB);
    if (!first || !second) throw new Error(`${keys.namespace}_CHUNKS_INCOMPLETE`);
    return `${first}${second}`;
  }
  const legacy = variables.get(keys.legacy);
  if (!legacy) throw new Error(`${keys.legacy} not found in n8n variables`);
  return legacy;
}

/**
 * Resolve a session from one namespace's rows. Newest complete generation
 * wins over the legacy layout; if every generation is unusable this falls
 * through to the operator-rotated legacy keys for the SAME namespace. Throws
 * if neither is present or usable — callers decide what "next" means.
 * Mirrors lifecycle/_lib/paraform-session.mjs's resolveSession exactly.
 */
export function resolveSession(rows = [], { namespace = DEFAULT_SESSION_NAMESPACE } = {}) {
  const keys = sessionKeys(namespace);
  const generations = [...collectGenerations(rows, keys).values()]
    .sort((a, b) => b.generation - a.generation);
  for (const entry of generations) {
    const value = assembleGeneration(entry);
    if (value) return { value, generation: entry.generation, source: "generation" };
  }
  return { value: legacyCookieFromRows(rows, { namespace }), generation: 0, source: "legacy" };
}

// ── n8n store I/O (read-only) ───────────────────────────────────────────────

const N8N_TIMEOUT_MS = 15_000;

/** List every variable, following the cursor. Mirrors lifecycle's paginated
 *  reader; this module never creates, updates, or deletes a variable. */
export async function listVariables({ base, key, fetchImpl = fetch }) {
  const rows = [];
  let cursor = null;
  for (let page = 0; page < 20; page += 1) {
    const url = new URL(`${String(base).replace(/\/+$/u, "")}/api/v1/variables`);
    url.searchParams.set("limit", "250");
    if (cursor) url.searchParams.set("cursor", cursor);
    const response = await fetchImpl(url.toString(), {
      headers: { "X-N8N-API-KEY": key, accept: "application/json" },
      signal: AbortSignal.timeout(N8N_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`n8n variables read failed: ${response.status}`);
    const body = await response.json();
    rows.push(...(body?.data || []));
    cursor = body?.nextCursor || null;
    if (!cursor) break;
  }
  return rows;
}

// ── Candidate order, rejection, and process cache ───────────────────────────
//
// Production renewal (lifecycle/_lib/clients.mjs planRenewal, with write-back)
// writes the SHARED namespace on every live 200. The account slot ('david')
// is renewed by a SEPARATE daily job, and other members' account slots lag
// further still (teammates' generations can be a day old) — so either the
// shared or the account namespace can independently go stale, and neither
// outranks the other by construction. Instead of unconditionally preferring
// the account slot, this module holds an ORDERED CANDIDATE LIST, tries the
// first one that is both resolvable and not currently in cooldown, and only
// moves on when a live 401 proves that candidate bad:
//
//   default order:            [shared, account('david'), env]
//   PARAFORM_SESSION_ACCOUNT: [account(<that account>), shared, env]
//
// A failure at any store step (unreachable n8n, missing/malformed rows) is
// swallowed and that candidate is simply absent — the store being down must
// degrade to the exact old behaviour (static env), never throw.

function staticEnvCookie(environment) {
  return String(environment.PARAFORM_SESSION_COOKIE || environment.PARAFORM_COOKIE || "");
}

function tryResolve(rows, namespace) {
  try {
    return resolveSession(rows, { namespace });
  } catch {
    return null;
  }
}

const SLOTS = Object.freeze(["shared", "account", "env"]);

/** Only an explicit PARAFORM_SESSION_ACCOUNT env var may move the account
 *  slot ahead of the shared one — its mere presence reorders, regardless of
 *  which account name it names (the default account namespace is always
 *  'david' either way, per accountNamespaceFor below). */
function slotOrder(environment) {
  const explicitAccount = String(environment.PARAFORM_SESSION_ACCOUNT || "").trim();
  return explicitAccount ? ["account", "shared", "env"] : SLOTS;
}

function accountNamespaceFor(environment) {
  return paraformAccountSessionNamespace(
    environment.PARAFORM_SESSION_ACCOUNT || DEFAULT_PARAFORM_SESSION_ACCOUNT,
  );
}

/** Compute all three candidates from one n8n listing (or none, when the
 *  store is unconfigured/unreachable — `rows` is null in that case). The env
 *  candidate is always present, even if its value is an empty string, so a
 *  caller can always fall through to *something* rather than nothing. */
function candidatesFromRows(rows, environment) {
  const candidates = { shared: null, account: null, env: null };
  if (rows) {
    const shared = tryResolve(rows, DEFAULT_SESSION_NAMESPACE);
    if (shared && isPlausibleCookie(shared.value)) {
      candidates.shared = { value: shared.value, generation: shared.generation, slot: "shared" };
    }
    const account = tryResolve(rows, accountNamespaceFor(environment));
    if (account && isPlausibleCookie(account.value)) {
      candidates.account = { value: account.value, generation: account.generation, slot: "account" };
    }
  }
  candidates.env = { value: staticEnvCookie(environment), generation: null, slot: "env" };
  return candidates;
}

// ── in-process rejection (30 minutes) ───────────────────────────────────────
// No KV marker: neither api/seq/_lib/core.mjs nor api/paraai/_lib/core.mjs
// already imports a KV helper at this layer (api/health/_lib/kv.mjs is only
// ever reached from inside a handler, never from this shared module), and
// this module is loaded by every entrypoint before auth — adding a KV import
// here purely for a best-effort marker would be a genuinely NEW dependency,
// which the review explicitly said to skip in that case. In-process only.
export const PARAFORM_SESSION_REJECTION_TTL_MS = 30 * 60 * 1000;

let rejectedUntil = new Map(); // slot -> epoch ms it becomes usable again

function isRejected(slot, now) {
  const until = rejectedUntil.get(slot);
  return typeof until === "number" && until > now;
}

/** First candidate in `order` that both resolves and isn't in cooldown. If
 *  every candidate is either unusable or rejected, degrade to the
 *  highest-priority one that at least resolves (env always does) rather than
 *  serve nothing — a 30-minute cooldown is a preference, not a hard veto,
 *  once there is truly nowhere else to go. */
function pickCandidate(candidates, order, now) {
  for (const slot of order) {
    const candidate = candidates[slot];
    if (candidate && !isRejected(slot, now)) return candidate;
  }
  for (const slot of order) {
    if (candidates[slot]) return candidates[slot];
  }
  return candidates.env;
}

async function resolveParaformSession({ environment, fetchImpl, now }) {
  const base = String(environment.N8N_BASE_URL || "").replace(/\/+$/u, "");
  const key = String(environment.N8N_API_KEY || "");
  let rows = null;
  if (base && key) {
    try {
      rows = await listVariables({ base, key, fetchImpl });
    } catch {
      rows = null; // store unreachable — shared/account candidates are simply absent
    }
  }
  const candidates = candidatesFromRows(rows, environment);
  return pickCandidate(candidates, slotOrder(environment), now);
}

export const PARAFORM_SESSION_CACHE_TTL_MS = 10 * 60 * 1000;

// The health budget below is a caller-supplied `timeoutMs`, but a single
// constant keeps every Scheduler-polled health endpoint tuned identically.
export const PARAFORM_SESSION_HEALTH_TIMEOUT_MS = 3_000;

let cache = { value: null, slot: null, generation: null, resolvedAt: 0 };
let inflight = null;

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * Resolve (and cache, per process, for at most PARAFORM_SESSION_CACHE_TTL_MS)
 * the Paraform session to use. Call this at the top of every entrypoint that
 * talks to Paraform, before any synchronous paraformCookieValue()/headers()
 * read — those stay synchronous and read whatever this last resolved.
 * Concurrent callers within the same warm process share one in-flight
 * resolution rather than each issuing their own n8n read.
 *
 * `timeoutMs`: for a caller on a hard external deadline (the Scheduler's
 * probeSequenceStop gives api/seq/health.mjs 10s total), pass a budget in ms.
 * A fresh cache hit always answers instantly regardless. On a cache MISS,
 * if the store read has not finished within `timeoutMs`, this returns the
 * static env value for THIS call only (never blocks past the budget) — the
 * in-flight store read is NOT cancelled and keeps running in the background,
 * so it still populates the cache (and every candidate's rejection state)
 * for the next call once it completes.
 *
 * `now`: epoch ms to treat as "the current time" for the cache-freshness and
 * candidate-rejection checks. Defaults to a real Date.now() snapshot; tests
 * pass an explicit value to prove the 30-minute rejection cooldown and the
 * 10-minute cache TTL deterministically, without a real wait.
 */
export async function ensureParaformSession({
  force = false,
  environment = process.env,
  fetchImpl = fetch,
  timeoutMs = null,
  now = Date.now(),
} = {}) {
  if (!force && cache.value && now - cache.resolvedAt < PARAFORM_SESSION_CACHE_TTL_MS) {
    return { value: cache.value, slot: cache.slot, generation: cache.generation, cached: true };
  }
  if (!inflight) {
    inflight = resolveParaformSession({ environment, fetchImpl, now })
      .then((resolved) => {
        cache = { ...resolved, resolvedAt: now };
        return resolved;
      })
      .finally(() => { inflight = null; });
    // resolveParaformSession never actually rejects, but a caller that hits
    // the timeout below stops awaiting this promise — keep that abandonment
    // from ever surfacing as an unhandled rejection.
    inflight.catch(() => {});
  }
  if (timeoutMs != null && Number.isFinite(timeoutMs) && timeoutMs >= 0) {
    const budgetExceeded = Symbol("paraform-session-budget-exceeded");
    const winner = await Promise.race([inflight, sleep(timeoutMs).then(() => budgetExceeded)]);
    if (winner === budgetExceeded) {
      return {
        value: staticEnvCookie(environment),
        slot: "env",
        generation: null,
        cached: false,
        timedOut: true,
      };
    }
    return { ...winner, cached: false };
  }
  const resolved = await inflight;
  return { ...resolved, cached: false };
}

/**
 * Synchronous accessor. When called with the default `process.env` (i.e. no
 * explicit environment argument — every real call site), this reads the
 * process-level cache first, then falls back to a direct env read exactly
 * like the pre-existing behaviour when nothing has been resolved yet (cold
 * start before ensureParaformSession() first runs, or the store and env are
 * both empty). When called with an EXPLICIT environment object (the existing
 * test convention across this repo), it bypasses the cache entirely and
 * reads that object directly — a fake environment can never accidentally
 * observe another test's cached value.
 */
export function paraformCookieValue(environment = process.env) {
  if (environment === process.env && cache.value) return cache.value;
  return staticEnvCookie(environment);
}

export function hasParaformSessionCookie(environment = process.env) {
  return Boolean(paraformCookieValue(environment));
}

/** Unconditional cache clear. Safe to call anytime (tests use this between
 *  cases; production code can use it any time a cookie is known to be bad).
 *  Does NOT touch candidate rejection state — see notifyParaformSessionRejected. */
export function invalidateParaformSessionCache() {
  cache = { value: null, slot: null, generation: null, resolvedAt: 0 };
}

/**
 * Call this when a live Paraform request gets a 401 using the currently
 * cached value. Marks THAT candidate's slot rejected for
 * PARAFORM_SESSION_REJECTION_TTL_MS (30 minutes) so the next resolution
 * skips it in favor of the next candidate in order, and invalidates the
 * cache so the NEXT ensureParaformSession() call actually re-resolves rather
 * than serve the same now-known-bad value for the rest of the 10-minute TTL.
 * Never retries inside the current request — the caller's existing
 * throttle/backoff ladder is unchanged; this only affects what the NEXT
 * invocation resolves.
 */
export function notifyParaformSessionRejected({ now = Date.now() } = {}) {
  // cache.slot (not cache.value) is the guard: a slot resolves to "" when
  // nothing is configured for it, which is still a real resolution worth
  // marking rejected — cache.slot is only null in the pristine, nothing-has-
  // ever-been-resolved state.
  if (!cache.slot) return;
  rejectedUntil.set(cache.slot, now + PARAFORM_SESSION_REJECTION_TTL_MS);
  invalidateParaformSessionCache();
}

/** Test-only: force the module back to its just-loaded state. */
export function __resetParaformSessionStateForTests() {
  cache = { value: null, slot: null, generation: null, resolvedAt: 0 };
  inflight = null;
  rejectedUntil = new Map();
}
