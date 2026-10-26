// ─────────────────────────────────────────────────────────────────────────────
// lifecycle/_lib/paraform-session.mjs — the shared Paraform session store.
//
// WHY THIS EXISTS. Paraform runs WorkOS AuthKit, which ROTATES the session on
// every response: each 200 carries a `Set-Cookie: wos-session=…` holding a
// freshly re-sealed session. Measured 2026-08-04 — three identical
// user.getCurrentUser reads two seconds apart returned three distinct seals,
// and the value we sent kept working alongside all of them. Until now nothing
// in any Raydar repo read `Set-Cookie`, so we discarded every renewal and
// pinned ourselves to the oldest seal we owned, then waited for it to die and
// hand-copied a new one into six stores. This module keeps the renewal.
//
// WHY GENERATIONS. n8n's public API can create, list and delete variables — it
// has NO update verb (confirmed against the instance's own OpenAPI spec:
// `/variables` exposes post+get, `/variables/{id}` exposes only delete). An
// in-place refresh would therefore mean deleting the live credential and
// racing to recreate it, with a window where every Paraform lane has no cookie
// and a failed recreate bricks all of them at once. So a renewal writes a NEW
// generation and prunes old ones only after the new one reads back:
//
//   PARAFORM_SESSION_COOKIE_G<gen>_PARTS   commit marker, written LAST
//   PARAFORM_SESSION_COOKIE_G<gen>_1..N    ordered chunks, <= 1000 chars each
//
// A generation is invisible until its marker exists AND every chunk is
// present, so a half-written generation can never be served. The marker is
// written last precisely so a crash mid-write leaves orphan chunks, which are
// inert, rather than a marker pointing at holes.
//
// WHY CHUNKS. n8n caps a variable value at 1,000 characters and the WorkOS
// seal is ~1,959, which is why production already stores it split. The legacy
// human-rotated layout (_PARTS/_A/_B) is still read and still authoritative
// when no generation exists — operators keep rotating exactly as they do now.
// Unlike the legacy readers, which hard-reject any part count other than 0 or
// 2, generations carry their own count, so a seal that grows past 2,000
// characters renews normally instead of bricking every lane.
// ─────────────────────────────────────────────────────────────────────────────

// n8n's per-variable ceiling. The live `_A` chunk sits at exactly 1000, which
// is how the limit was originally found.
export const CHUNK_LIMIT = 1000;

export const DEFAULT_SESSION_NAMESPACE = "PARAFORM_SESSION_COOKIE";
const SESSION_NAMESPACE = /^[A-Z][A-Z0-9_]{1,127}$/u;
export const CURRENT_GENERATION_KEY =
  `${DEFAULT_SESSION_NAMESPACE}_CURRENT_GENERATION`;

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

// Renewals are bucketed onto this grid so that many concurrent runtimes
// observing the same rotation converge on ONE generation id instead of each
// minting their own. It also bounds how often we write: at most one generation
// per bucket per store, however many lambdas are warm.
export const RENEWAL_BUCKET_MS = 15 * 60 * 1000;

// Keep the newest generation plus this many older ones. A reader that listed
// variables microseconds before a prune still finds the generation it chose.
const KEEP_GENERATIONS = 2;

// A seal is opaque, so validation is structural only: right shape, sane size,
// and nothing that could break out of a cookie header.
const MIN_COOKIE_LENGTH = 64;
const MAX_COOKIE_LENGTH = 8 * CHUNK_LIMIT;

/** Structural check for anything we are about to trust or persist. A value
 *  that fails this is never sent, never stored, and never prunes anything. */
export function isPlausibleCookie(value) {
  if (typeof value !== "string") return false;
  if (value.length < MIN_COOKIE_LENGTH || value.length > MAX_COOKIE_LENGTH) return false;
  // Whitespace, ';' and ',' would terminate or inject cookie attributes.
  if (/[\s;,]/u.test(value)) return false;
  // The two shapes Paraform has ever issued: WorkOS iron seals and NextAuth JWEs.
  return value.startsWith("Fe26.2") || value.startsWith("eyJ");
}

export function chunkCookie(value, limit = CHUNK_LIMIT) {
  const chunks = [];
  for (let i = 0; i < value.length; i += limit) chunks.push(value.slice(i, i + limit));
  return chunks;
}

function generationOf(key, keys = sessionKeys()) {
  if (!key || !key.startsWith(keys.generationPrefix)) return null;
  const rest = key.slice(keys.generationPrefix.length);
  const match = /^(\d+)_(PARTS|\d+)$/u.exec(rest);
  if (!match) return null;
  return { generation: Number(match[1]), field: match[2] };
}

/** Group raw n8n variable rows into candidate generations. Rows carry `id` so
 *  the caller can prune without a second listing. */
function collectGenerations(rows, keys = sessionKeys()) {
  const generations = new Map();
  for (const row of rows) {
    const parsed = generationOf(row?.key, keys);
    if (!parsed) continue;
    if (!generations.has(parsed.generation)) {
      generations.set(parsed.generation, { generation: parsed.generation, parts: null, chunks: new Map(), ids: [] });
    }
    const entry = generations.get(parsed.generation);
    entry.ids.push(row.id);
    if (parsed.field === "PARTS") {
      // A duplicate marker means two writers raced. Ambiguous, so unusable.
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
 *  newest, so a bad generation degrades rather than breaks. */
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

function pointerGeneration(rows = [], keys = sessionKeys()) {
  const pointers = rows.filter((row) => row?.key === keys.currentGeneration);
  if (pointers.length !== 1) return null;
  const generation = Number(pointers[0].value);
  return Number.isSafeInteger(generation) && generation >= 0
    ? generation
    : null;
}

export function legacyCookieFromRows(
  rows = [],
  { namespace = DEFAULT_SESSION_NAMESPACE } = {},
) {
  const keys = sessionKeys(namespace);
  const variables = new Map(rows.map((entry) => [entry?.key, entry?.value]));
  const parts = Number(variables.get(keys.legacyParts) || 0);
  if (parts !== 0 && parts !== 2) throw new Error("PARAFORM_SESSION_COOKIE_PARTS_INVALID");
  if (parts === 2) {
    const first = variables.get(keys.legacyA);
    const second = variables.get(keys.legacyB);
    if (!first || !second) throw new Error("PARAFORM_SESSION_COOKIE_CHUNKS_INCOMPLETE");
    return `${first}${second}`;
  }
  const legacy = variables.get(keys.legacy);
  if (!legacy) throw new Error(`${keys.legacy} not found in n8n variables`);
  return legacy;
}

/**
 * Resolve the session to use from a variables listing.
 *
 * Newest complete generation wins over the legacy layout, because a generation
 * exists only if a live 200 response produced it — it is provably no older
 * than the seed it descends from. If every generation is unusable we fall
 * through to the operator-rotated legacy keys untouched.
 */
export function resolveSession(
  rows = [],
  { namespace = DEFAULT_SESSION_NAMESPACE } = {},
) {
  const keys = sessionKeys(namespace);
  const generations = [...collectGenerations(rows, keys).values()].sort((a, b) => b.generation - a.generation);
  for (const entry of generations) {
    const value = assembleGeneration(entry);
    if (value) return { value, generation: entry.generation, source: "generation" };
  }
  // PS15 / LA5: rows synthesized from the Postgres store (`source: "pg"`) have
  // no legacy layout, ever. Falling through to it would either throw the
  // misleading "not found in n8n variables" or, worse, quietly serve a stale
  // n8n legacy value, so a pg-synthesized listing with no usable generation is
  // a loud, specific error. Real n8n rows carry no `source`, so n8n mode is
  // untouched.
  if (rows.some((row) => row?.source === "pg"
    && (row.key === keys.namespace || String(row.key ?? "").startsWith(`${keys.namespace}_`)))) {
    const error = new Error(`PARAFORM_SESSION_LEGACY_UNSUPPORTED: ${keys.namespace} has no usable pg generation`);
    error.code = "PARAFORM_SESSION_LEGACY_UNSUPPORTED";
    throw error;
  }
  return {
    value: legacyCookieFromRows(rows, { namespace }),
    generation: 0,
    source: "legacy",
  };
}

/**
 * Plan a renewal. Returns null when there is nothing to do, which is the
 * common case: the value is unchanged, implausible, or this bucket already has
 * a generation. Planning is pure so the decision is testable without a store.
 */
/** Build the create/prune plan for a brand-new generation number. Shared by
 * the bucket-throttled path and the forced path below — the only thing that
 * differs between them is which generation number they write to. */
function newGenerationPlan(generations, generation, value, keys) {
  const chunks = chunkCookie(value);
  const creates = chunks.map((chunk, index) => ({ key: `${keys.generationPrefix}${generation}_${index + 1}`, value: chunk }));
  // The marker commits the generation, so it is created last.
  creates.push({ key: `${keys.generationPrefix}${generation}_PARTS`, value: String(chunks.length) });

  // Prune only generations strictly older than the ones we are keeping, and
  // only ever generational keys — the legacy layout belongs to the operator.
  const survivors = new Set(
    [generation, ...[...generations.keys()].sort((a, b) => b - a)].slice(0, KEEP_GENERATIONS),
  );
  const deletes = [];
  for (const [gen, entry] of generations) {
    if (survivors.has(gen)) continue;
    for (const id of entry.ids) if (id) deletes.push(id);
  }
  return { generation, value, creates, deletes };
}

export function planRenewal(
  rows = [],
  value,
  {
    now = Date.now(),
    bucketMs = RENEWAL_BUCKET_MS,
    namespace = DEFAULT_SESSION_NAMESPACE,
    // A forced renewal (paraform-seat.mjs flush({force: true}), the CLI's
    // process-end flush — finding 2, r3-review.md) never accepts the
    // bucket-throttled no-op below: it writes a brand-new generation for
    // `value` whenever that value genuinely differs from the newest usable
    // one already in the store, even if this 15-minute bucket already has a
    // (now-stale) generation with a current pointer. Without this, a SECOND
    // rotation captured within the same bucket as a first one — the ordinary
    // case for two people processed a few seconds apart — is silently
    // dropped: planRenewal sees "already renewed this bucket, pointer is
    // current" and reports nothing to do, even though the cookie has moved
    // on again since that generation was written.
    force = false,
  } = {},
) {
  if (!isPlausibleCookie(value)) return null;
  const keys = sessionKeys(namespace);
  const generations = collectGenerations(rows, keys);
  const bucket = Math.floor(now / bucketMs) * bucketMs;

  const newestComplete = [...generations.values()]
    .sort((a, b) => b.generation - a.generation)
    .map((entry) => ({ entry, value: assembleGeneration(entry) }))
    .find((candidate) => candidate.value);
  const pointerIsCurrent = newestComplete
    && pointerGeneration(rows, keys) === newestComplete.entry.generation;

  if (force && newestComplete?.value !== value) {
    // One past the newest generation this listing knows about (never just
    // `bucket`, which may already be taken) — ms-resolution generation
    // numbers make a bucket-epoch collision with any future real bucket
    // impossible, so this is always a fresh, unambiguous generation.
    const generation = Math.max(bucket, (newestComplete?.entry.generation ?? -1) + 1);
    return newGenerationPlan(generations, generation, value, keys);
  }

  // Already renewed in this bucket — by us or by a sibling runtime.
  if (generations.has(bucket)) {
    if (pointerIsCurrent) return null;
    return newestComplete ? {
      generation: newestComplete.entry.generation,
      value: newestComplete.value,
      creates: [],
      deletes: [],
    } : null;
  }

  // No-op if the newest usable generation already carries this exact value.
  if (newestComplete?.value === value) {
    if (pointerIsCurrent) return null;
    return {
      generation: newestComplete.entry.generation,
      value: newestComplete.value,
      creates: [],
      deletes: [],
    };
  }

  return newGenerationPlan(generations, bucket, value, keys);
}

// ── n8n store I/O ───────────────────────────────────────────────────────────
// Everything above is pure. Only these three touch the network.

const N8N_TIMEOUT_MS = 15_000;

/** List every variable, following the cursor. The listing is paginated and
 *  generations make it grow, so a single unpaginated read would eventually
 *  start hiding the newest generation behind the page boundary. */
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

/**
 * Execute a renewal plan: create the new generation, then prune.
 *
 * Creates run in order so the PARTS marker lands last. A failed create aborts
 * BEFORE any prune, leaving orphan chunks that no reader will serve and the
 * previous generation still live — the whole point of not updating in place.
 * Prune failures are swallowed: stale generations are inert clutter, and a
 * renewal that renewed is not worth failing over a leftover row.
 */
export async function applyRenewal({
  base,
  key,
  plan,
  fetchImpl = fetch,
  namespace = DEFAULT_SESSION_NAMESPACE,
}) {
  const keys = sessionKeys(namespace);
  const root = String(base).replace(/\/+$/u, "");
  for (const create of plan.creates) {
    const response = await fetchImpl(`${root}/api/v1/variables`, {
      method: "POST",
      headers: { "X-N8N-API-KEY": key, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(create),
      signal: AbortSignal.timeout(N8N_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`n8n variable create failed: ${response.status}`);
  }

  // The stable pointer is the atomic hand-off to n8n Code nodes. It moves only
  // after every chunk and the marker read back into the exact value planned.
  // A failed or partial generation therefore stays invisible to dispatch.
  let rows = await listVariables({ base: root, key, fetchImpl });
  const target = assembleGeneration(
    collectGenerations(rows, keys).get(plan.generation),
  );
  if (!target || target !== plan.value) {
    throw new Error("n8n generation readback failed");
  }
  let pointers = rows.filter((row) => row?.key === keys.currentGeneration);
  if (pointers.length > 1) {
    throw new Error("n8n generation pointer is ambiguous");
  }
  const pointerBody = {
    key: keys.currentGeneration,
    value: String(plan.generation),
  };
  const pointerRequest = (pointer) => fetchImpl(
    pointer
      ? `${root}/api/v1/variables/${encodeURIComponent(pointer.id)}`
      : `${root}/api/v1/variables`,
    {
      method: pointer ? "PUT" : "POST",
      headers: { "X-N8N-API-KEY": key, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(pointerBody),
      signal: AbortSignal.timeout(N8N_TIMEOUT_MS),
    },
  );
  let pointerResponse = await pointerRequest(pointers[0]);
  if (!pointerResponse.ok && pointers.length === 0) {
    // A sibling may have created the singleton between our list and POST.
    rows = await listVariables({ base: root, key, fetchImpl });
    pointers = rows.filter((row) => row?.key === keys.currentGeneration);
    if (pointers.length === 1) {
      pointerResponse = await pointerRequest(pointers[0]);
    }
  }
  if (!pointerResponse.ok) {
    throw new Error(
      `n8n generation pointer write failed: ${pointerResponse.status}`,
    );
  }
  const pointerReadback = await listVariables({ base: root, key, fetchImpl });
  if (pointerGeneration(pointerReadback, keys) !== plan.generation) {
    throw new Error("n8n generation pointer readback failed");
  }

  let pruned = 0;
  for (const id of plan.deletes) {
    try {
      const response = await fetchImpl(`${root}/api/v1/variables/${encodeURIComponent(id)}`, {
        method: "DELETE",
        headers: { "X-N8N-API-KEY": key, accept: "application/json" },
        signal: AbortSignal.timeout(N8N_TIMEOUT_MS),
      });
      if (response.ok) pruned += 1;
    } catch { /* inert clutter; never fail a renewal over it */ }
  }
  return {
    generation: plan.generation,
    pointerGeneration: plan.generation,
    created: plan.creates.length,
    pruned,
  };
}

/** Extract a rotated session from a response's Set-Cookie header(s). */
export function rotatedCookieFrom(response, cookieName) {
  const headers = response?.headers;
  if (!headers) return null;
  const raw = typeof headers.getSetCookie === "function"
    ? headers.getSetCookie()
    : [headers.get?.("set-cookie")].filter(Boolean);
  for (const entry of raw || []) {
    // Only the attribute-free value, and only for the cookie we authenticate with.
    const match = new RegExp(`(?:^|;\\s*)${cookieName}=([^;]+)`, "u").exec(entry);
    if (match && isPlausibleCookie(match[1])) return match[1];
  }
  return null;
}
