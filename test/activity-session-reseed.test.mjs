// The Activity tab's Paraform credential: a cached session that has died must
// yield to the operator's refreshed env seed.
//
// Regression cover for the 2026-09-05 freeze: the stored KV value won
// unconditionally over env, so once the rotation chain died there was no way
// to hand the deployed lane a working cookie — the feed sat frozen for three
// days while /api/activity/health reported "expired" and the tab showed
// AUTH_EXPIRED on every thread.

import test from "node:test";
import assert from "node:assert/strict";

// kv.mjs freezes these at module load, and it is imported once for the whole
// file; every case below therefore runs with the store "configured".
process.env.KV_REST_API_URL = "https://kv.test.invalid";
process.env.KV_REST_API_TOKEN = "kv-token";

const DEAD = `Fe26.2**dead${"d".repeat(64)}`;
const FRESH = `Fe26.2**fresh${"f".repeat(64)}`;
const ALIVE_STORED = `Fe26.2**stored${"s".repeat(64)}`;

let instance = 0;
/** Fresh module state per case: the transport caches the session in module scope. */
const loadTransport = () => import(`../api/activity/_lib/paraform.mjs?case=${++instance}`);

/**
 * @param {object} o
 * @param {string|null} o.stored  value returned by KV for activity:v1:session
 * @param {string[]}    o.accept  cookie values Paraform answers 200 for
 */
function harness({ stored, accept }) {
  const kvWrites = [];
  const cookiesTried = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const href = String(url);
    if (href.startsWith("https://kv.test.invalid")) {
      const cmd = JSON.parse(init.body);
      if (cmd[0] === "GET") {
        return new Response(JSON.stringify({ result: stored ? JSON.stringify({ value: stored, at: "2026-09-01T00:00:00.000Z" }) : null }), { status: 200 });
      }
      if (cmd[0] === "SET") { kvWrites.push(JSON.parse(cmd[2])); return new Response(JSON.stringify({ result: "OK" }), { status: 200 }); }
      return new Response(JSON.stringify({ result: null }), { status: 200 });
    }
    const cookie = String(init.headers?.cookie || "");
    const value = cookie.slice(cookie.indexOf("=") + 1);
    cookiesTried.push(value);
    if (!accept.includes(value)) return new Response("", { status: 401 });
    return new Response(JSON.stringify({ result: { data: { json: { id: "user_live" } } } }), { status: 200 });
  };
  return { kvWrites, cookiesTried, restore: () => { globalThis.fetch = realFetch; } };
}

test("a dead cached session yields to the refreshed env seed, and the seed is cached", async () => {
  process.env.PARAFORM_SESSION_COOKIE = FRESH;
  const h = harness({ stored: DEAD, accept: [FRESH] });
  try {
    const { whoAmI, transportStats } = await loadTransport();
    const me = await whoAmI();

    assert.equal(me?.id, "user_live", "the refreshed seed must be able to rescue a dead cached session");
    assert.equal(h.cookiesTried[0], DEAD, "the cached value is still tried first — it is usually the freshest");
    assert.ok(h.cookiesTried.includes(FRESH), "the env seed must actually be tried after the cached value fails auth");
    assert.equal(transportStats().seedFallbacks, 1);
    assert.deepEqual(h.kvWrites.map((w) => w.value), [FRESH],
      "the proven seed is written back so the next invocation starts healed");
  } finally { h.restore(); }
});

test("a live cached session is never displaced by a different env seed", async () => {
  process.env.PARAFORM_SESSION_COOKIE = FRESH;
  const h = harness({ stored: ALIVE_STORED, accept: [ALIVE_STORED, FRESH] });
  try {
    const { whoAmI, transportStats } = await loadTransport();
    assert.equal((await whoAmI())?.id, "user_live");
    assert.deepEqual(h.cookiesTried, [ALIVE_STORED], "a working rotation chain must not be thrown away for an older seed");
    assert.equal(transportStats().seedFallbacks, 0);
    assert.deepEqual(h.kvWrites, []);
  } finally { h.restore(); }
});

test("both credentials dead still reports AUTH_EXPIRED, and the swap happens once", async () => {
  process.env.PARAFORM_SESSION_COOKIE = FRESH;
  const h = harness({ stored: DEAD, accept: [] });
  try {
    const { trpcGet, transportStats } = await loadTransport();
    await assert.rejects(() => trpcGet("user.getCurrentUser", {}, { tries: 1 }), /AUTH_EXPIRED/,
      "a genuinely dead pair must still surface as expired");
    assert.deepEqual(h.cookiesTried, [DEAD, FRESH], "one bonus attempt on the seed, then give up");
    assert.equal(transportStats().seedFallbacks, 1, "the fallback must fire once, never loop between two dead values");
    assert.deepEqual(h.kvWrites, [], "an unproven seed must never overwrite the store");
  } finally { h.restore(); }
});

test("with no store value the env seed is used directly and nothing falls back", async () => {
  process.env.PARAFORM_SESSION_COOKIE = FRESH;
  const h = harness({ stored: null, accept: [FRESH] });
  try {
    const { whoAmI, transportStats } = await loadTransport();
    assert.equal((await whoAmI())?.id, "user_live");
    assert.deepEqual(h.cookiesTried, [FRESH]);
    assert.equal(transportStats().seedFallbacks, 0);
  } finally { h.restore(); }
});

test("a dead cached session with an identical env seed does not retry the same value", async () => {
  process.env.PARAFORM_SESSION_COOKIE = DEAD;
  const h = harness({ stored: DEAD, accept: [] });
  try {
    const { trpcGet, transportStats } = await loadTransport();
    await assert.rejects(() => trpcGet("user.getCurrentUser", {}, { tries: 1 }), /AUTH_EXPIRED/);
    assert.deepEqual(h.cookiesTried, [DEAD], "no bonus attempt is spent re-sending a value we just saw fail");
    assert.equal(transportStats().seedFallbacks, 0, "swapping a value for itself is not a fallback");
  } finally { h.restore(); }
});
