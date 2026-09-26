import test from "node:test";
import assert from "node:assert/strict";

import {
  ACCOUNT_SESSION_NAMESPACE,
  DEFAULT_SESSION_NAMESPACE,
  ensureParaformSession,
  hasParaformSessionCookie,
  invalidateParaformSessionCache,
  isPlausibleCookie,
  legacyCookieFromRows,
  listVariables,
  notifyParaformSessionRejected,
  paraformCookieValue,
  PARAFORM_SESSION_CACHE_TTL_MS,
  PARAFORM_SESSION_HEALTH_TIMEOUT_MS,
  PARAFORM_SESSION_REJECTION_TTL_MS,
  paraformAccountSessionNamespace,
  resolveSession,
  sessionKeys,
  __resetParaformSessionStateForTests,
} from "../api/_lib/paraform-session-store.mjs";
import {
  ensureParaformSession as seqEnsureParaformSession,
  headers as seqHeaders,
  paraformHealth,
} from "../api/seq/_lib/core.mjs";
import {
  clearCookieCache,
  ensureParaformSession as paraaiEnsureParaformSession,
  paraformCookie,
} from "../api/paraai/_lib/core.mjs";

// ── fixtures ─────────────────────────────────────────────────────────────────

const ACCOUNT_COOKIE = `Fe26.2${"a".repeat(70)}`; // 76 chars, plausible WorkOS seal
const SHARED_GEN_COOKIE = `Fe26.2${"b".repeat(70)}`;
const SHARED_LEGACY_COOKIE = `Fe26.2${"c".repeat(70)}`;
const ENV_COOKIE = `Fe26.2${"d".repeat(70)}`;

function chunkRowsFor(namespace, generation, value, chunkSize) {
  const chunks = [];
  for (let i = 0; i < value.length; i += chunkSize) chunks.push(value.slice(i, i + chunkSize));
  const rows = chunks.map((chunk, idx) => ({
    id: `${namespace}-g${generation}-${idx + 1}`,
    key: `${namespace}_G${generation}_${idx + 1}`,
    value: chunk,
  }));
  rows.push({
    id: `${namespace}-g${generation}-parts`,
    key: `${namespace}_G${generation}_PARTS`,
    value: String(chunks.length),
  });
  return rows;
}

function legacyChunkRows(namespace, first, second) {
  return [
    { id: `${namespace}-parts`, key: `${namespace}_PARTS`, value: "2" },
    { id: `${namespace}-a`, key: `${namespace}_A`, value: first },
    { id: `${namespace}-b`, key: `${namespace}_B`, value: second },
  ];
}

function n8nListResponse(rows) {
  return { ok: true, json: async () => ({ data: rows }) };
}

/** A store whose /api/v1/variables listing serves `rows`, and whose n8n
 *  base is distinguishable from the Paraform trpc base in a combined mock. */
function fakeN8n(rows, { base = "https://n8n.example.test" } = {}) {
  let calls = 0;
  const fetchImpl = async (url) => {
    calls += 1;
    assert.match(String(url), new RegExp(`^${base}/api/v1/variables`), "n8n reads must hit the variables endpoint");
    return n8nListResponse(rows);
  };
  return { base, key: "test-n8n-key", fetchImpl, calls: () => calls };
}

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

async function withEnv(env, fn) {
  const previous = {};
  for (const key of Object.keys(env)) previous[key] = process.env[key];
  Object.assign(process.env, env);
  try {
    return await fn();
  } finally {
    for (const key of Object.keys(env)) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
}

test.beforeEach(() => {
  __resetParaformSessionStateForTests();
});
test.afterEach(() => {
  __resetParaformSessionStateForTests();
});

// ── pure resolution logic (mirrors lifecycle/_lib/paraform-session.mjs) ─────

test("isPlausibleCookie enforces shape, length, and no cookie-breaking characters", () => {
  assert.equal(isPlausibleCookie(ACCOUNT_COOKIE), true);
  assert.equal(isPlausibleCookie(`eyJ${"x".repeat(70)}`), true);
  assert.equal(isPlausibleCookie("Fe26.2too-short"), false);
  assert.equal(isPlausibleCookie(`nextauth${"x".repeat(70)}`), false, "unrecognized prefix");
  assert.equal(isPlausibleCookie(`Fe26.2${"x".repeat(60)};evil=1`), false, "semicolon breaks out of a cookie header");
  assert.equal(isPlausibleCookie(`Fe26.2${"x".repeat(30)} ${"x".repeat(30)}`), false, "whitespace breaks out");
  assert.equal(isPlausibleCookie(123), false);
  assert.equal(isPlausibleCookie(null), false);
});

test("sessionKeys rejects a malformed namespace and derives the exact key shapes", () => {
  const keys = sessionKeys("PARAFORM_DAVID_SESSION");
  assert.equal(keys.generationPrefix, "PARAFORM_DAVID_SESSION_G");
  assert.equal(keys.currentGeneration, "PARAFORM_DAVID_SESSION_CURRENT_GENERATION");
  assert.equal(keys.legacyParts, "PARAFORM_DAVID_SESSION_PARTS");
  assert.equal(keys.legacyA, "PARAFORM_DAVID_SESSION_A");
  assert.equal(keys.legacyB, "PARAFORM_DAVID_SESSION_B");
  assert.throws(() => sessionKeys("lowercase"), /PARAFORM_SESSION_NAMESPACE_INVALID/u);
  assert.throws(() => sessionKeys(""), /PARAFORM_SESSION_NAMESPACE_INVALID/u);
});

test("paraformAccountSessionNamespace mirrors lifecycle's PARAFORM_<ACCOUNT>_SESSION naming", () => {
  assert.equal(paraformAccountSessionNamespace("david"), "PARAFORM_DAVID_SESSION");
  assert.equal(paraformAccountSessionNamespace("David"), "PARAFORM_DAVID_SESSION");
  assert.equal(ACCOUNT_SESSION_NAMESPACE, "PARAFORM_DAVID_SESSION");
  assert.throws(() => paraformAccountSessionNamespace(""), /PARAFORM_SESSION_ACCOUNT_INVALID/u);
  assert.throws(() => paraformAccountSessionNamespace("has space"), /PARAFORM_SESSION_ACCOUNT_INVALID/u);
});

test("resolveSession picks the newest complete generation over an older one and over legacy", () => {
  const rows = [
    ...chunkRowsFor(DEFAULT_SESSION_NAMESPACE, 1, "old-generation-value-0000000000000000000000000000000000000000000000000", 40),
    ...chunkRowsFor(DEFAULT_SESSION_NAMESPACE, 2, SHARED_GEN_COOKIE, 40),
    ...legacyChunkRows(DEFAULT_SESSION_NAMESPACE, SHARED_LEGACY_COOKIE.slice(0, 40), SHARED_LEGACY_COOKIE.slice(40)),
  ];
  const result = resolveSession(rows, { namespace: DEFAULT_SESSION_NAMESPACE });
  assert.equal(result.value, SHARED_GEN_COOKIE);
  assert.equal(result.generation, 2);
  assert.equal(result.source, "generation");
});

test("resolveSession falls back to the legacy two-chunk layout when no generation is usable", () => {
  const rows = legacyChunkRows(DEFAULT_SESSION_NAMESPACE, SHARED_LEGACY_COOKIE.slice(0, 40), SHARED_LEGACY_COOKIE.slice(40));
  const result = resolveSession(rows, { namespace: DEFAULT_SESSION_NAMESPACE });
  assert.equal(result.value, SHARED_LEGACY_COOKIE);
  assert.equal(result.generation, 0);
  assert.equal(result.source, "legacy");
});

test("resolveSession falls back to the single legacy variable when there are no parts at all", () => {
  const rows = [{ id: "legacy", key: DEFAULT_SESSION_NAMESPACE, value: SHARED_LEGACY_COOKIE }];
  const result = resolveSession(rows, { namespace: DEFAULT_SESSION_NAMESPACE });
  assert.equal(result.value, SHARED_LEGACY_COOKIE);
  assert.equal(result.source, "legacy");
});

test("resolveSession throws when nothing usable exists in that namespace", () => {
  assert.throws(() => resolveSession([], { namespace: DEFAULT_SESSION_NAMESPACE }));
  assert.throws(
    () => resolveSession([{ id: "x", key: "PARAFORM_SESSION_COOKIE_PARTS", value: "2" }], { namespace: DEFAULT_SESSION_NAMESPACE }),
    /PARAFORM_SESSION_COOKIE_CHUNKS_INCOMPLETE/u,
  );
});

test("legacyCookieFromRows rejects a parts marker that is not 0 or 2", () => {
  assert.throws(
    () => legacyCookieFromRows([{ id: "x", key: "PARAFORM_SESSION_COOKIE_PARTS", value: "3" }], { namespace: DEFAULT_SESSION_NAMESPACE }),
    /PARAFORM_SESSION_COOKIE_PARTS_INVALID/u,
  );
});

// ── fail-closed on inconsistent chunk/pointer state ─────────────────────────

test("a generation with a missing chunk is skipped, not served partial", () => {
  const rows = chunkRowsFor(DEFAULT_SESSION_NAMESPACE, 5, SHARED_GEN_COOKIE, 40)
    .filter((row) => !row.key.endsWith("_G5_2")); // drop the second chunk
  assert.throws(() => resolveSession(rows, { namespace: DEFAULT_SESSION_NAMESPACE }));
});

test("a generation with two conflicting values for the same chunk index is poisoned, never picked", () => {
  const rows = chunkRowsFor(DEFAULT_SESSION_NAMESPACE, 6, SHARED_GEN_COOKIE, 40);
  const duplicate = { ...rows[0], id: "duplicate-conflicting", value: "totally-different-bytes" };
  const legacy = legacyChunkRows(DEFAULT_SESSION_NAMESPACE, SHARED_LEGACY_COOKIE.slice(0, 40), SHARED_LEGACY_COOKIE.slice(40));
  const result = resolveSession([...rows, duplicate, ...legacy], { namespace: DEFAULT_SESSION_NAMESPACE });
  // The poisoned generation must never win — the legacy layout does instead.
  assert.equal(result.value, SHARED_LEGACY_COOKIE);
  assert.equal(result.source, "legacy");
});

test("a duplicate PARTS marker is ambiguous and poisons the whole generation", () => {
  const rows = chunkRowsFor(DEFAULT_SESSION_NAMESPACE, 7, SHARED_GEN_COOKIE, 40);
  const dupMarker = { id: "dup-parts", key: "PARAFORM_SESSION_COOKIE_G7_PARTS", value: "1" };
  const legacy = legacyChunkRows(DEFAULT_SESSION_NAMESPACE, SHARED_LEGACY_COOKIE.slice(0, 40), SHARED_LEGACY_COOKIE.slice(40));
  const result = resolveSession([...rows, dupMarker, ...legacy], { namespace: DEFAULT_SESSION_NAMESPACE });
  assert.equal(result.value, SHARED_LEGACY_COOKIE);
  assert.equal(result.source, "legacy");
});

test("a generation whose assembled bytes are not a plausible cookie is rejected", () => {
  const rows = [
    { id: "bad-1", key: "PARAFORM_SESSION_COOKIE_G8_1", value: "not-a-real-seal" },
    { id: "bad-parts", key: "PARAFORM_SESSION_COOKIE_G8_PARTS", value: "1" },
  ];
  assert.throws(() => resolveSession(rows, { namespace: DEFAULT_SESSION_NAMESPACE }));
});

test("account and shared namespaces never see each other's rows", () => {
  const rows = [
    ...chunkRowsFor(ACCOUNT_SESSION_NAMESPACE, 1, ACCOUNT_COOKIE, 40),
    ...chunkRowsFor(DEFAULT_SESSION_NAMESPACE, 1, SHARED_GEN_COOKIE, 40),
  ];
  assert.equal(resolveSession(rows, { namespace: ACCOUNT_SESSION_NAMESPACE }).value, ACCOUNT_COOKIE);
  assert.equal(resolveSession(rows, { namespace: DEFAULT_SESSION_NAMESPACE }).value, SHARED_GEN_COOKIE);
});

// ── listVariables pagination ─────────────────────────────────────────────────

test("listVariables follows nextCursor until the listing is exhausted", async () => {
  const pageOne = [{ id: "1", key: "A", value: "1" }];
  const pageTwo = [{ id: "2", key: "B", value: "2" }];
  const seen = [];
  const fetchImpl = async (url) => {
    const parsed = new URL(String(url));
    seen.push(parsed.searchParams.get("cursor"));
    if (!parsed.searchParams.get("cursor")) {
      return { ok: true, json: async () => ({ data: pageOne, nextCursor: "page-2" }) };
    }
    return { ok: true, json: async () => ({ data: pageTwo, nextCursor: null }) };
  };
  const rows = await listVariables({ base: "https://n8n.example.test", key: "k", fetchImpl });
  assert.deepEqual(rows, [...pageOne, ...pageTwo]);
  assert.deepEqual(seen, [null, "page-2"]);
});

test("listVariables surfaces a non-OK response as an error rather than an empty list", async () => {
  const fetchImpl = async () => ({ ok: false, status: 500 });
  await assert.rejects(
    listVariables({ base: "https://n8n.example.test", key: "k", fetchImpl }),
    /n8n variables read failed: 500/u,
  );
});

// ── resolution order: shared -> account('david') -> env, by default ────────
//
// Production renewal with write-back (lifecycle/_lib/clients.mjs planRenewal)
// writes the SHARED namespace on every live 200. The account slot is renewed
// by a separate daily job and can lag (teammates' slots can be a day stale),
// so the shared namespace is NOT unconditionally subordinate to the account
// one — it goes first unless PARAFORM_SESSION_ACCOUNT explicitly reorders.

test("shared wins by default, even when the account slot is ALSO present", async () => {
  const rows = [
    ...chunkRowsFor(DEFAULT_SESSION_NAMESPACE, 1, SHARED_GEN_COOKIE, 40),
    ...chunkRowsFor(ACCOUNT_SESSION_NAMESPACE, 1, ACCOUNT_COOKIE, 40),
  ];
  const store = fakeN8n(rows);
  await withEnv({
    N8N_BASE_URL: store.base,
    N8N_API_KEY: store.key,
    PARAFORM_SESSION_COOKIE: ENV_COOKIE,
  }, async () => {
    const result = await ensureParaformSession({ fetchImpl: store.fetchImpl });
    assert.equal(result.value, SHARED_GEN_COOKIE);
    assert.equal(result.slot, "shared");
  });
});

test("the account generation wins only when the shared namespace has nothing usable", async () => {
  const rows = chunkRowsFor(ACCOUNT_SESSION_NAMESPACE, 1, ACCOUNT_COOKIE, 40);
  const store = fakeN8n(rows);
  await withEnv({
    N8N_BASE_URL: store.base,
    N8N_API_KEY: store.key,
    PARAFORM_SESSION_COOKIE: ENV_COOKIE,
  }, async () => {
    const result = await ensureParaformSession({ fetchImpl: store.fetchImpl });
    assert.equal(result.value, ACCOUNT_COOKIE);
    assert.equal(result.slot, "account");
  });
});

test("the shared legacy layout wins over env when there is no generation anywhere", async () => {
  const rows = legacyChunkRows(DEFAULT_SESSION_NAMESPACE, SHARED_LEGACY_COOKIE.slice(0, 40), SHARED_LEGACY_COOKIE.slice(40));
  const store = fakeN8n(rows);
  await withEnv({
    N8N_BASE_URL: store.base,
    N8N_API_KEY: store.key,
    PARAFORM_SESSION_COOKIE: ENV_COOKIE,
  }, async () => {
    const result = await ensureParaformSession({ fetchImpl: store.fetchImpl });
    assert.equal(result.value, SHARED_LEGACY_COOKIE);
    assert.equal(result.slot, "shared");
  });
});

test("the static env value is last, used only when the store has nothing usable", async () => {
  const store = fakeN8n([]);
  await withEnv({
    N8N_BASE_URL: store.base,
    N8N_API_KEY: store.key,
    PARAFORM_SESSION_COOKIE: ENV_COOKIE,
  }, async () => {
    const result = await ensureParaformSession({ fetchImpl: store.fetchImpl });
    assert.equal(result.value, ENV_COOKIE);
    assert.equal(result.slot, "env");
  });
});

test("an explicit PARAFORM_SESSION_ACCOUNT reorders the account slot ahead of shared", async () => {
  const rows = [
    ...chunkRowsFor(DEFAULT_SESSION_NAMESPACE, 1, SHARED_GEN_COOKIE, 40),
    ...chunkRowsFor(ACCOUNT_SESSION_NAMESPACE, 1, ACCOUNT_COOKIE, 40),
  ];
  const store = fakeN8n(rows);
  await withEnv({
    N8N_BASE_URL: store.base,
    N8N_API_KEY: store.key,
    PARAFORM_SESSION_ACCOUNT: "david", // explicit — the mere presence reorders
  }, async () => {
    const result = await ensureParaformSession({ fetchImpl: store.fetchImpl });
    assert.equal(result.value, ACCOUNT_COOKIE);
    assert.equal(result.slot, "account");
  });
});

test("PARAFORM_SESSION_ACCOUNT can also select a DIFFERENT account's namespace, still ordered first", async () => {
  const kyraNamespace = paraformAccountSessionNamespace("kyra");
  const kyraCookie = `Fe26.2${"k".repeat(70)}`;
  const rows = [
    ...chunkRowsFor(DEFAULT_SESSION_NAMESPACE, 1, SHARED_GEN_COOKIE, 40),
    ...chunkRowsFor(kyraNamespace, 1, kyraCookie, 40),
  ];
  const store = fakeN8n(rows);
  await withEnv({
    N8N_BASE_URL: store.base,
    N8N_API_KEY: store.key,
    PARAFORM_SESSION_ACCOUNT: "kyra",
  }, async () => {
    const result = await ensureParaformSession({ fetchImpl: store.fetchImpl });
    assert.equal(result.value, kyraCookie);
    assert.equal(result.slot, "account");
  });
});

test("env fallback: PARAFORM_COOKIE is used when PARAFORM_SESSION_COOKIE is absent", async () => {
  await withEnv({ PARAFORM_SESSION_COOKIE: undefined, PARAFORM_COOKIE: ENV_COOKIE }, async () => {
    delete process.env.N8N_BASE_URL;
    delete process.env.N8N_API_KEY;
    delete process.env.PARAFORM_SESSION_COOKIE;
    const result = await ensureParaformSession();
    assert.equal(result.value, ENV_COOKIE);
    assert.equal(result.slot, "env");
  });
});

test("an unreachable store degrades to env exactly like before, never throws", async () => {
  await withEnv({
    N8N_BASE_URL: "https://n8n.example.test",
    N8N_API_KEY: "k",
    PARAFORM_SESSION_COOKIE: ENV_COOKIE,
  }, async () => {
    const fetchImpl = async () => { throw new Error("network unreachable"); };
    const result = await ensureParaformSession({ fetchImpl });
    assert.equal(result.value, ENV_COOKIE);
    assert.equal(result.slot, "env");
  });
});

test("a store configured with only one half of N8N_BASE_URL/N8N_API_KEY is treated as unconfigured", async () => {
  await withEnv({
    N8N_BASE_URL: "https://n8n.example.test",
    PARAFORM_SESSION_COOKIE: ENV_COOKIE,
  }, async () => {
    delete process.env.N8N_API_KEY;
    let called = false;
    const result = await ensureParaformSession({ fetchImpl: async () => { called = true; return n8nListResponse([]); } });
    assert.equal(called, false, "must not attempt a store read with only half the config");
    assert.equal(result.value, ENV_COOKIE);
  });
});

// ── cascading rejection through the candidate order ─────────────────────────

test("a 401 on shared falls through to account, then env, on each subsequent resolution", async () => {
  const rows = [
    ...chunkRowsFor(DEFAULT_SESSION_NAMESPACE, 1, SHARED_GEN_COOKIE, 40),
    ...chunkRowsFor(ACCOUNT_SESSION_NAMESPACE, 1, ACCOUNT_COOKIE, 40),
  ];
  const store = fakeN8n(rows);
  await withEnv({
    N8N_BASE_URL: store.base,
    N8N_API_KEY: store.key,
    PARAFORM_SESSION_COOKIE: ENV_COOKIE,
  }, async () => {
    const t0 = 1_000_000;
    const first = await ensureParaformSession({ fetchImpl: store.fetchImpl, now: t0 });
    assert.equal(first.slot, "shared");

    // A live 401 using the shared-sourced cookie.
    notifyParaformSessionRejected({ now: t0 + 1 });
    const second = await ensureParaformSession({ fetchImpl: store.fetchImpl, now: t0 + 2 });
    assert.equal(second.slot, "account", "shared is in cooldown, so account is next");

    // A live 401 using the account-sourced cookie too.
    notifyParaformSessionRejected({ now: t0 + 3 });
    const third = await ensureParaformSession({ fetchImpl: store.fetchImpl, now: t0 + 4 });
    assert.equal(third.slot, "env", "both shared and account are in cooldown");
  });
});

test("rejection expires after 30 minutes and the candidate is tried again", async () => {
  const rows = chunkRowsFor(DEFAULT_SESSION_NAMESPACE, 1, SHARED_GEN_COOKIE, 40);
  const store = fakeN8n(rows);
  await withEnv({
    N8N_BASE_URL: store.base,
    N8N_API_KEY: store.key,
    PARAFORM_SESSION_COOKIE: ENV_COOKIE,
  }, async () => {
    const t0 = 1_000_000;
    const first = await ensureParaformSession({ fetchImpl: store.fetchImpl, now: t0 });
    assert.equal(first.slot, "shared");

    notifyParaformSessionRejected({ now: t0 + 1 });
    const stillCoolingDown = await ensureParaformSession({
      fetchImpl: store.fetchImpl,
      now: t0 + 1 + 29 * 60 * 1000, // 29 minutes later — still within the 30-minute cooldown
    });
    assert.equal(stillCoolingDown.slot, "env", "shared is still rejected 29 minutes in; only env is left");

    const expired = await ensureParaformSession({
      fetchImpl: store.fetchImpl,
      now: t0 + 1 + 31 * 60 * 1000, // 31 minutes later — the cooldown has expired
      force: true, // bypass the unrelated 10-minute cache TTL to force a fresh pick
    });
    assert.equal(expired.slot, "shared", "30 minutes have passed; shared is tried again");
  });
});

test("when every candidate is rejected, the highest-priority one is used anyway rather than nothing", async () => {
  // Only shared ever resolves here (no account rows, empty env) — so once
  // shared AND env have both been rejected in turn, nothing is left in the
  // first pass and the fallback must still serve shared rather than "".
  const rows = chunkRowsFor(DEFAULT_SESSION_NAMESPACE, 1, SHARED_GEN_COOKIE, 40);
  const store = fakeN8n(rows);
  await withEnv({
    N8N_BASE_URL: store.base,
    N8N_API_KEY: store.key,
    PARAFORM_SESSION_COOKIE: undefined,
    PARAFORM_COOKIE: undefined,
  }, async () => {
    delete process.env.PARAFORM_SESSION_COOKIE;
    delete process.env.PARAFORM_COOKIE;
    const t0 = 1_000_000;

    const first = await ensureParaformSession({ fetchImpl: store.fetchImpl, now: t0 });
    assert.equal(first.slot, "shared");
    notifyParaformSessionRejected({ now: t0 + 1 }); // rejects "shared"

    const second = await ensureParaformSession({ fetchImpl: store.fetchImpl, now: t0 + 2 });
    assert.equal(second.slot, "env", "account never resolves, so env is next");
    notifyParaformSessionRejected({ now: t0 + 3 }); // rejects "env" too — now everything is rejected

    const third = await ensureParaformSession({ fetchImpl: store.fetchImpl, now: t0 + 4 });
    // account still never resolves, and both shared and env are in cooldown —
    // degrade back to the highest-priority resolvable candidate (shared)
    // rather than serve an empty string.
    assert.equal(third.slot, "shared");
    assert.equal(third.value, SHARED_GEN_COOKIE);
  });
});

// ── cache TTL ────────────────────────────────────────────────────────────────

test("the resolved session is cached per process for up to the TTL", async () => {
  const rows = chunkRowsFor(DEFAULT_SESSION_NAMESPACE, 1, SHARED_GEN_COOKIE, 40);
  const store = fakeN8n(rows);
  await withEnv({ N8N_BASE_URL: store.base, N8N_API_KEY: store.key }, async () => {
    const first = await ensureParaformSession({ fetchImpl: store.fetchImpl });
    const second = await ensureParaformSession({ fetchImpl: store.fetchImpl });
    assert.equal(first.value, SHARED_GEN_COOKIE);
    assert.equal(second.cached, true);
    assert.equal(store.calls(), 1, "a second call inside the TTL must not re-read the store");
  });
});

test("force = true bypasses a fresh cache and re-reads the store", async () => {
  const rows = chunkRowsFor(DEFAULT_SESSION_NAMESPACE, 1, SHARED_GEN_COOKIE, 40);
  const store = fakeN8n(rows);
  await withEnv({ N8N_BASE_URL: store.base, N8N_API_KEY: store.key }, async () => {
    await ensureParaformSession({ fetchImpl: store.fetchImpl });
    await ensureParaformSession({ fetchImpl: store.fetchImpl, force: true });
    assert.equal(store.calls(), 2);
  });
});

test("concurrent callers within the cache miss window share one in-flight resolution", async () => {
  const rows = chunkRowsFor(DEFAULT_SESSION_NAMESPACE, 1, SHARED_GEN_COOKIE, 40);
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    await new Promise((r) => setTimeout(r, 15));
    return n8nListResponse(rows);
  };
  await withEnv({ N8N_BASE_URL: "https://n8n.example.test", N8N_API_KEY: "k" }, async () => {
    const [a, b, c] = await Promise.all([
      ensureParaformSession({ fetchImpl }),
      ensureParaformSession({ fetchImpl }),
      ensureParaformSession({ fetchImpl }),
    ]);
    assert.equal(a.value, SHARED_GEN_COOKIE);
    assert.deepEqual(b.value, a.value);
    assert.deepEqual(c.value, a.value);
    assert.equal(calls, 1, "three concurrent misses must produce exactly one store read");
  });
});

test("invalidateParaformSessionCache forces the next call to re-read regardless of TTL", async () => {
  const rows = chunkRowsFor(DEFAULT_SESSION_NAMESPACE, 1, SHARED_GEN_COOKIE, 40);
  const store = fakeN8n(rows);
  await withEnv({ N8N_BASE_URL: store.base, N8N_API_KEY: store.key }, async () => {
    await ensureParaformSession({ fetchImpl: store.fetchImpl });
    invalidateParaformSessionCache();
    await ensureParaformSession({ fetchImpl: store.fetchImpl });
    assert.equal(store.calls(), 2);
  });
});

// ── 401 invalidation ─────────────────────────────────────────────────────────

test("notifyParaformSessionRejected invalidates a store-sourced cache so the next call re-reads once", async () => {
  const rows = chunkRowsFor(DEFAULT_SESSION_NAMESPACE, 1, SHARED_GEN_COOKIE, 40);
  const store = fakeN8n(rows);
  await withEnv({ N8N_BASE_URL: store.base, N8N_API_KEY: store.key }, async () => {
    await ensureParaformSession({ fetchImpl: store.fetchImpl });
    notifyParaformSessionRejected();
    const second = await ensureParaformSession({ fetchImpl: store.fetchImpl });
    assert.equal(store.calls(), 2, "the rejected store-sourced value must trigger exactly one re-read");
    assert.equal(second.cached, false);
  });
});

test("notifyParaformSessionRejected also invalidates an env-sourced cache (every slot is treated uniformly)", async () => {
  // With no shared/account rows in the store, env is the only present
  // candidate. Rejecting it still invalidates the cache and re-reads the
  // store on the next call (so a shared/account row that appears in the
  // meantime would be picked up) — it just degrades right back to env via
  // the "everything is rejected" fallback, since nothing else resolves.
  const store = fakeN8n([]);
  await withEnv({ N8N_BASE_URL: store.base, N8N_API_KEY: store.key, PARAFORM_SESSION_COOKIE: ENV_COOKIE }, async () => {
    const first = await ensureParaformSession({ fetchImpl: store.fetchImpl });
    assert.equal(first.slot, "env");
    assert.equal(store.calls(), 1);
    notifyParaformSessionRejected();
    const second = await ensureParaformSession({ fetchImpl: store.fetchImpl });
    assert.equal(second.cached, false, "an env-sourced rejection still forces a fresh resolution");
    assert.equal(second.slot, "env");
    assert.equal(store.calls(), 2);
  });
});

test("notifyParaformSessionRejected never retries inside the same call — it only affects the NEXT resolution", async () => {
  const rows = chunkRowsFor(DEFAULT_SESSION_NAMESPACE, 1, SHARED_GEN_COOKIE, 40);
  const store = fakeN8n(rows);
  await withEnv({ N8N_BASE_URL: store.base, N8N_API_KEY: store.key }, async () => {
    await ensureParaformSession({ fetchImpl: store.fetchImpl });
    assert.equal(store.calls(), 1);
    notifyParaformSessionRejected(); // simulates a live 401 using the cached value
    assert.equal(store.calls(), 1, "invalidation itself must not perform any I/O");
  });
});

// ── synchronous accessors: cache-or-env, explicit env bypasses the cache ───

test("paraformCookieValue()/hasParaformSessionCookie() read the cache first, then env, when called with no argument", async () => {
  const rows = chunkRowsFor(DEFAULT_SESSION_NAMESPACE, 1, SHARED_GEN_COOKIE, 40);
  const store = fakeN8n(rows);
  await withEnv({ N8N_BASE_URL: store.base, N8N_API_KEY: store.key, PARAFORM_SESSION_COOKIE: ENV_COOKIE }, async () => {
    assert.equal(paraformCookieValue(), ENV_COOKIE, "before resolution, falls straight through to env");
    await ensureParaformSession({ fetchImpl: store.fetchImpl });
    assert.equal(paraformCookieValue(), SHARED_GEN_COOKIE, "after resolution, the store value wins");
    assert.equal(hasParaformSessionCookie(), true);
  });
});

test("an explicit environment object always bypasses the process cache (existing test convention)", async () => {
  const rows = chunkRowsFor(DEFAULT_SESSION_NAMESPACE, 1, SHARED_GEN_COOKIE, 40);
  const store = fakeN8n(rows);
  await withEnv({ N8N_BASE_URL: store.base, N8N_API_KEY: store.key }, async () => {
    await ensureParaformSession({ fetchImpl: store.fetchImpl });
    assert.equal(paraformCookieValue(), SHARED_GEN_COOKIE);
    // A fake env object, even one that shares no keys with the cached value,
    // must read literally from itself and never leak the process cache.
    assert.equal(paraformCookieValue({ PARAFORM_SESSION_COOKIE: "fake-env-value-only" }), "fake-env-value-only");
    assert.equal(hasParaformSessionCookie({}), false);
  });
});

// ── integration: seq's paraformHealth() and paraai's paraformCookie() use it ─

test("seq's auth probe (paraformHealth via trpcGet) sends the store-resolved cookie, not a stale env seal", async () => {
  const rows = chunkRowsFor(ACCOUNT_SESSION_NAMESPACE, 1, ACCOUNT_COOKIE, 40);
  const n8nBase = "https://n8n.example.test";
  const kvBase = "https://control.example.test";
  const kvStore = new Map();
  const paraformCookiesSeen = [];
  const fetchImpl = async (url, init) => {
    const href = String(url);
    if (href.startsWith(n8nBase)) return n8nListResponse(rows);
    if (href.startsWith(kvBase)) {
      // Minimal NX-aware KV so paraformHealth()'s own dedupe lock resolves
      // immediately instead of exercising its real-time lock-wait fallback.
      const [op, key, value, ...opts] = JSON.parse(init.body);
      if (op === "GET") return { ok: true, json: async () => ({ result: kvStore.has(key) ? kvStore.get(key) : null }) };
      if (op === "SET") {
        if (opts.includes("NX") && kvStore.has(key)) return { ok: true, json: async () => ({ result: null }) };
        kvStore.set(key, value);
        return { ok: true, json: async () => ({ result: "OK" }) };
      }
      return { ok: true, json: async () => ({ result: null }) };
    }
    if (href.startsWith("https://www.paraform.com/")) {
      paraformCookiesSeen.push(init?.headers?.cookie);
      return { status: 200, json: async () => ({ result: { data: { json: [{ id: "seq-1" }] } } }) };
    }
    throw new Error(`unexpected fetch to ${href}`);
  };
  await withEnv({
    N8N_BASE_URL: n8nBase,
    N8N_API_KEY: "k",
    KV_REST_API_URL: kvBase,
    KV_REST_API_TOKEN: "test-token",
    PARAFORM_SESSION_COOKIE: ENV_COOKIE, // present, but the store must outrank it
  }, async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchImpl;
    try {
      await seqEnsureParaformSession({ fetchImpl });
      const health = await paraformHealth({ pauseState: async () => ({ paused: false }) });
      assert.equal(health.paraform, "live");
      assert.equal(paraformCookiesSeen.length, 1);
      assert.equal(paraformCookiesSeen[0], `wos-session=${ACCOUNT_COOKIE}`);
      assert.notEqual(paraformCookiesSeen[0], `wos-session=${ENV_COOKIE}`);
      // headers() itself must agree, independent of trpcGet's own call.
      assert.equal(seqHeaders().cookie, `wos-session=${ACCOUNT_COOKIE}`);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("paraai's paraformCookie() resolves through the same shared, generation-aware store (fixes the old two-chunk-only fallback)", async () => {
  // A FOUR-chunk generation: the old paraai-local fallback
  // (paraformCookieFromVariableRows) hard-rejected any part count but 0 or 2
  // and would have thrown PARAFORM_SESSION_COOKIE_PARTS_INVALID here.
  const rows = chunkRowsFor(DEFAULT_SESSION_NAMESPACE, 9, SHARED_GEN_COOKIE, 25);
  assert.equal(rows.find((r) => r.key.endsWith("_PARTS")).value, "4");
  const n8nBase = "https://n8n.example.test";
  await withEnv({ N8N_BASE_URL: n8nBase, N8N_API_KEY: "k" }, async () => {
    clearCookieCache();
    const fetchImpl = async (url) => {
      assert.match(String(url), /^https:\/\/n8n\.example\.test/u);
      return n8nListResponse(rows);
    };
    await paraaiEnsureParaformSession({ fetchImpl });
    const value = await paraformCookie();
    assert.equal(value, SHARED_GEN_COOKIE);
    clearCookieCache();
  });
});

test("paraai's clearCookieCache() clears the SAME shared cache seq reads (one shared resolver, not two)", async () => {
  const rows = chunkRowsFor(DEFAULT_SESSION_NAMESPACE, 1, SHARED_GEN_COOKIE, 40);
  const store = fakeN8n(rows);
  await withEnv({ N8N_BASE_URL: store.base, N8N_API_KEY: store.key }, async () => {
    await paraaiEnsureParaformSession({ fetchImpl: store.fetchImpl });
    assert.equal(paraformCookieValue(), SHARED_GEN_COOKIE, "seq's sync accessor sees paraai's resolution");
    clearCookieCache();
    assert.equal(paraformCookieValue(), "", "clearing from paraai clears the store both files share");
  });
});

test("PARAFORM_SESSION_CACHE_TTL_MS is exactly ten minutes, as specified", () => {
  assert.equal(PARAFORM_SESSION_CACHE_TTL_MS, 10 * 60 * 1000);
});

test("PARAFORM_SESSION_REJECTION_TTL_MS is exactly thirty minutes, as specified", () => {
  assert.equal(PARAFORM_SESSION_REJECTION_TTL_MS, 30 * 60 * 1000);
});

// ── health-latency budget: never block past `timeoutMs` on a hung n8n read ──
//
// The Scheduler's probeSequenceStop gives api/seq/health.mjs a hard 10s
// timeout. ensureParaformSession({ timeoutMs }) must answer with the static
// env value well within that budget on a cache miss against a store that
// never responds, and the abandoned store read must keep running in the
// background rather than being wasted.

test("ensureParaformSession({ timeoutMs }) answers within budget when the n8n read hangs", async () => {
  let released;
  const hang = new Promise((resolve) => { released = resolve; });
  const fetchImpl = async () => { await hang; return n8nListResponse([]); };
  await withEnv({
    N8N_BASE_URL: "https://n8n.example.test",
    N8N_API_KEY: "k",
    PARAFORM_SESSION_COOKIE: ENV_COOKIE,
  }, async () => {
    const startedAt = Date.now();
    const result = await ensureParaformSession({ fetchImpl, timeoutMs: 50 });
    const elapsedMs = Date.now() - startedAt;
    assert.equal(result.timedOut, true);
    assert.equal(result.value, ENV_COOKIE);
    assert.equal(result.slot, "env");
    assert.ok(elapsedMs < 400, `expected to answer well under budget, took ${elapsedMs}ms`);
    released(); // let the abandoned read finish so it doesn't leak into later tests
    await sleep(5);
  });
});

test("a timed-out read still populates the cache in the background once it completes", async () => {
  let released;
  const hang = new Promise((resolve) => { released = resolve; });
  const rows = chunkRowsFor(DEFAULT_SESSION_NAMESPACE, 1, SHARED_GEN_COOKIE, 40);
  let calls = 0;
  const fetchImpl = async () => { calls += 1; await hang; return n8nListResponse(rows); };
  await withEnv({
    N8N_BASE_URL: "https://n8n.example.test",
    N8N_API_KEY: "k",
    PARAFORM_SESSION_COOKIE: ENV_COOKIE,
  }, async () => {
    const first = await ensureParaformSession({ fetchImpl, timeoutMs: 20 });
    assert.equal(first.timedOut, true);
    assert.equal(calls, 1);
    released();
    await sleep(30); // give the abandoned in-flight resolution time to land
    assert.equal(paraformCookieValue(), SHARED_GEN_COOKIE, "the background resolution populated the cache");
  });
});

test("a fresh cache hit answers instantly even with a timeoutMs budget set", async () => {
  const rows = chunkRowsFor(DEFAULT_SESSION_NAMESPACE, 1, SHARED_GEN_COOKIE, 40);
  const store = fakeN8n(rows);
  await withEnv({ N8N_BASE_URL: store.base, N8N_API_KEY: store.key }, async () => {
    await ensureParaformSession({ fetchImpl: store.fetchImpl });
    const second = await ensureParaformSession({ fetchImpl: store.fetchImpl, timeoutMs: 3000 });
    assert.equal(second.cached, true);
    assert.equal(second.value, SHARED_GEN_COOKIE);
    assert.equal(store.calls(), 1, "a cache hit must never touch the store, budget or not");
  });
});

test("api/seq/health.mjs answers within budget when n8n hangs, falling back to env for that response", async () => {
  let released;
  const hang = new Promise((resolve) => { released = resolve; });
  const n8nBase = "https://n8n.example.test";
  const kvBase = "https://control.example.test";
  const kvStore = new Map();
  const paraformCookiesSeen = [];
  const fetchImpl = async (url, init) => {
    const href = String(url);
    if (href.startsWith(n8nBase)) { await hang; return n8nListResponse([]); }
    if (href.startsWith(kvBase)) {
      const [op, key, value, ...opts] = JSON.parse(init.body);
      if (op === "GET") return { ok: true, json: async () => ({ result: kvStore.has(key) ? kvStore.get(key) : null }) };
      if (op === "SET") {
        if (opts.includes("NX") && kvStore.has(key)) return { ok: true, json: async () => ({ result: null }) };
        kvStore.set(key, value);
        return { ok: true, json: async () => ({ result: "OK" }) };
      }
      return { ok: true, json: async () => ({ result: null }) };
    }
    if (href.startsWith("https://www.paraform.com/")) {
      paraformCookiesSeen.push(init?.headers?.cookie);
      return { status: 200, json: async () => ({ result: { data: { json: [{ id: "seq-1" }] } } }) };
    }
    throw new Error(`unexpected fetch to ${href}`);
  };
  await withEnv({
    N8N_BASE_URL: n8nBase,
    N8N_API_KEY: "k",
    KV_REST_API_URL: kvBase,
    KV_REST_API_TOKEN: "test-token",
    PARAFORM_SESSION_COOKIE: ENV_COOKIE,
  }, async () => {
    const { default: handler } = await import("../api/seq/health.mjs");
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchImpl;
    const req = { method: "GET", headers: {}, url: "/api/seq/health" };
    let body = null;
    const res = {
      status() { return this; },
      json(value) { body = value; return this; },
      setHeader() {},
    };
    try {
      const startedAt = Date.now();
      await handler(req, res);
      const elapsedMs = Date.now() - startedAt;
      assert.ok(
        elapsedMs < PARAFORM_SESSION_HEALTH_TIMEOUT_MS + 1000,
        `expected the health endpoint to respect its ~3s store budget, took ${elapsedMs}ms`,
      );
      assert.equal(body.cookieSet, true);
      assert.equal(paraformCookiesSeen.length, 1);
      assert.equal(paraformCookiesSeen[0], `wos-session=${ENV_COOKIE}`, "falls back to the env value for this response");
    } finally {
      globalThis.fetch = originalFetch;
      released();
      await sleep(5);
    }
  });
});
