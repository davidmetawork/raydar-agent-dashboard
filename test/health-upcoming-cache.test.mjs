import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// C6 (2026-09-24 Paraform reduction pass): the health tick's existing
// screener-feed probe (webview's /api/status) already pays for one fetch per
// 2-min tick. This pins that its `upcoming` array is persisted to KV during
// the tick — zero new outbound calls — and that the new /api/health/upcoming
// endpoint serves exactly that cache back to an authenticated browser.
//
// api/health/_lib/kv.mjs reads KV_REST_API_URL/KV_REST_API_TOKEN as
// module-top-level constants (not per-call), so KV_REST_API_URL must be set
// BEFORE engine.mjs's module graph is first evaluated in this process —
// hence the dynamic import() after the env is set, rather than a static
// top-level import.

const KV_URL = "https://control.example.test";
const SCREENER_FEED_URL = "https://webview-lake.vercel.app/api/status";
const UPCOMING_ROWS = [
  { bot_id: "bot-1", candidate_name: "Amy Chen", join_at: "2026-09-25T18:00:00Z" },
  { bot_id: "bot-2", candidate_name: "Ravi Patel", join_at: "2026-09-25T19:00:00Z" },
];

function runCommand(store, command) {
  const [op, ...rest] = command;
  if (op === "GET") return store.has(rest[0]) ? store.get(rest[0]) : null;
  if (op === "MGET") return rest.map((key) => (store.has(key) ? store.get(key) : null));
  if (op === "SET") { store.set(rest[0], rest[1]); return "OK"; }
  if (op === "LPUSH" || op === "LTRIM" || op === "LRANGE") return [];
  return null;
}

function fakeKvFetch(store) {
  return async (url, init) => {
    const href = String(url);
    if (!href.startsWith(KV_URL)) return null;
    if (href.endsWith("/pipeline")) {
      const commands = JSON.parse(init.body);
      return { ok: true, json: async () => commands.map((c) => ({ result: runCommand(store, c) })) };
    }
    const command = JSON.parse(init.body);
    return { ok: true, json: async () => ({ result: runCommand(store, command) }) };
  };
}

process.env.KV_REST_API_URL = KV_URL;
process.env.KV_REST_API_TOKEN = "test-token";

const { runTick } = await import("../api/health/_lib/engine.mjs");
const { K } = await import("../api/health/_lib/kv.mjs");
const { default: handleUpcoming } = await import("../api/health/upcoming.mjs");

test("the tick persists the screener-feed upcoming array", async () => {
  const store = new Map();
  const kvFetch = fakeKvFetch(store);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const kvResult = await kvFetch(url, init);
    if (kvResult) return kvResult;
    const href = String(url);
    if (href.startsWith(SCREENER_FEED_URL)) {
      return { status: 200, text: async () => JSON.stringify({ ok: true, upcoming: UPCOMING_ROWS }) };
    }
    // Every other probe: a generic empty-but-parseable body. Evaluators read
    // this as UNKNOWN/degraded, never a throw — irrelevant here, which only
    // pins the screener-feed -> KV -> endpoint path.
    return { status: 200, text: async () => "{}" };
  };
  try {
    await runTick({ now: Date.parse("2026-09-24T18:00:00Z") });

    const cached = store.get(K.upcoming);
    assert.ok(cached, "the tick must have written the upcoming cache");
    const parsed = JSON.parse(cached);
    assert.deepEqual(parsed.upcoming, UPCOMING_ROWS);
    assert.equal(parsed.fetchedAt, "2026-09-24T18:00:00.000Z");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("the endpoint sits behind the same cors + requireAuth gate as every other browser health API", async () => {
  const source = await readFile(new URL("../api/health/upcoming.mjs", import.meta.url), "utf8");
  assert.match(source, /import \{ cors, requireAuth \} from "\.\.\/seq\/_lib\/core\.mjs"/);
  assert.match(source, /if \(cors\(req, res\)\) return;/);
  assert.match(source, /if \(!\(await requireAuth\(req, res\)\)\) return;/);
});

test("an authenticated request with no cache yet reads an explicit empty array, never a throw", async () => {
  let statusCode = null;
  let body = null;
  const res = {
    headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { statusCode = code; return this; },
    json(value) { body = value; return value; },
  };
  // No AUTH_SESSION_SECRET/GOOGLE_CLIENT_ID configured in this process ->
  // requireAuth's own documented fallback is open ("auth not configured yet
  // -> open"), same as every other browser health endpoint in this test
  // environment — not a gap introduced by this endpoint.
  await handleUpcoming({ method: "GET", headers: {} }, res);
  assert.equal(statusCode, 200);
  assert.deepEqual(body, { ok: true, upcoming: [], fetchedAt: null });
});

test("the endpoint never falls back to a raw upstream shape: an empty cache is an explicit empty array", async () => {
  const source = await readFile(new URL("../api/health/upcoming.mjs", import.meta.url), "utf8");
  assert.match(source, /if \(!cached \|\| !Array\.isArray\(cached\.upcoming\)\)/, "a missing/malformed cache must be guarded, not passed through");
  assert.match(source, /upcoming: \[\], fetchedAt: null/, "an empty cache must read as ok:true with an empty array, never a 500");
});
