import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import {
  ACCOUNT_SESSION_NAMESPACE,
  DEFAULT_SESSION_NAMESPACE,
  ensureParaformSession,
  paraformCookieValue,
  paraformSessionStoreMode,
  paraformSessionStoreStatus,
  __resetParaformSessionStateForTests,
} from "../api/_lib/paraform-session-store.mjs";
import { paraformCookie, clearCookieCache } from "../api/paraai/_lib/core.mjs";

// Synthetic values only. Neon-shaped host so the HTTP endpoint derives.
const DB_URL = "postgresql://reader:synthetic@ep-test-123.us-east-2.aws.neon.tech/neondb";
const PG_SHARED = `Fe26.2${"p".repeat(70)}`;
const PG_ACCOUNT = `Fe26.2${"q".repeat(70)}`;
const N8N_ACCOUNT = `Fe26.2${"n".repeat(70)}`;
const ENV_COOKIE = `Fe26.2${"e".repeat(70)}`;
const N8N_BASE = "https://n8n.example.test";

function record(namespace, { store, cookie, generation = 7 }) {
  return {
    namespace, account_key: null, slot: null, authoritative_store: store, login_lineage: null,
    generation: String(generation), version: "3", cookie, written_by: "test", written_at: null,
    last_rotated_at: null, last_verified_at: null, last_verify_outcome: null, dead_at: null,
    refused_streak: "0", refused_since: null, last_write_error: null, last_write_error_at: null,
    last_opened_by: "{}", prev_generation: null, prev_cookie: null,
  };
}

function genRows(namespace, generation, cookie) {
  return [
    { id: `${namespace}1`, key: `${namespace}_G${generation}_1`, value: cookie },
    { id: `${namespace}p`, key: `${namespace}_G${generation}_PARTS`, value: "1" },
  ];
}

/** Routes pg (Neon HTTP) and n8n calls; records every URL it sees. */
function world({ pgRows = [], n8nRows = [], pgDown = false, n8nDown = false } = {}) {
  const seen = { pg: 0, n8n: 0, stamps: [] };
  const fetchImpl = async (url, init = {}) => {
    const target = String(url);
    if (target.startsWith("https://api.us-east-2.aws.neon.tech/sql")) {
      seen.pg += 1;
      if (pgDown) return { ok: false, status: 503, json: async () => ({}) };
      const body = JSON.parse(init.body);
      if (/UPDATE paraform_session/u.test(body.query)) {
        seen.stamps.push(body.params);
        return { ok: true, status: 200, json: async () => ({ rows: [{ namespace: "x" }], fields: [] }) };
      }
      return { ok: true, status: 200, json: async () => ({ rows: pgRows, fields: [] }) };
    }
    if (target.startsWith(`${N8N_BASE}/api/v1/variables`)) {
      seen.n8n += 1;
      if (n8nDown) return { ok: false, status: 500, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ data: n8nRows }) };
    }
    throw new Error(`unexpected fetch ${target}`);
  };
  return { fetchImpl, seen };
}

test.beforeEach(() => { __resetParaformSessionStateForTests(); });
test.afterEach(() => { __resetParaformSessionStateForTests(); });

test("mode n8n is the default and never touches Postgres", async () => {
  const w = world({ n8nRows: genRows(DEFAULT_SESSION_NAMESPACE, 4, PG_SHARED) });
  const env = { N8N_BASE_URL: N8N_BASE, N8N_API_KEY: "k", PARAFORM_SESSION_DATABASE_URL: DB_URL };
  assert.equal(paraformSessionStoreMode(env), "n8n");
  const r = await ensureParaformSession({ environment: env, fetchImpl: w.fetchImpl, now: 1 });
  assert.equal(r.value, PG_SHARED);
  assert.equal(r.slot, "shared");
  assert.equal(w.seen.pg, 0);
  assert.equal(w.seen.n8n, 1);
});

test("mode n8n keeps the static env fallback when n8n is down", async () => {
  const w = world({ n8nDown: true });
  const env = { N8N_BASE_URL: N8N_BASE, N8N_API_KEY: "k", PARAFORM_SESSION_COOKIE: ENV_COOKIE };
  const r = await ensureParaformSession({ environment: env, fetchImpl: w.fetchImpl, now: 1 });
  assert.equal(r.value, ENV_COOKIE);
  assert.equal(r.slot, "env");
  assert.equal(paraformCookieValue(env), ENV_COOKIE);
});

test("mode pg reads the pg-owned shared namespace and stamps the dashboard runtime", async () => {
  const w = world({ pgRows: [
    record(DEFAULT_SESSION_NAMESPACE, { store: "pg", cookie: PG_SHARED }),
    record(ACCOUNT_SESSION_NAMESPACE, { store: "pg", cookie: PG_ACCOUNT }),
  ] });
  const env = { PARAFORM_SESSION_STORE: "pg", PARAFORM_SESSION_DATABASE_URL: DB_URL, PARAFORM_SESSION_COOKIE: ENV_COOKIE };
  const r = await ensureParaformSession({ environment: env, fetchImpl: w.fetchImpl, now: 1 });
  assert.equal(r.value, PG_SHARED);
  assert.equal(r.slot, "shared");
  assert.equal(r.generation, 7);
  assert.equal(w.seen.n8n, 0, "everything pg-owned: n8n is not read");
  assert.ok(w.seen.stamps.some((params) => params[1] === "dashboard"), "last_opened_by is stamped");
  assert.equal(paraformSessionStoreStatus(env).lastError, null);
});

test("mode pg follows authoritative_store: an n8n-owned namespace is read from n8n", async () => {
  const w = world({
    pgRows: [
      record(DEFAULT_SESSION_NAMESPACE, { store: "pg", cookie: PG_SHARED }),
      record(ACCOUNT_SESSION_NAMESPACE, { store: "n8n", cookie: PG_ACCOUNT }),
    ],
    n8nRows: genRows(ACCOUNT_SESSION_NAMESPACE, 9, N8N_ACCOUNT),
  });
  const env = {
    PARAFORM_SESSION_STORE: "pg", PARAFORM_SESSION_DATABASE_URL: DB_URL,
    N8N_BASE_URL: N8N_BASE, N8N_API_KEY: "k", PARAFORM_SESSION_ACCOUNT: "david",
  };
  const r = await ensureParaformSession({ environment: env, fetchImpl: w.fetchImpl, now: 1 });
  assert.equal(r.slot, "account", "an explicit account puts the account slot first");
  assert.equal(r.value, N8N_ACCOUNT, "the n8n-owned namespace resolves from n8n, not the stale pg cookie");
});

test("mode pg fails closed when the store is down: no cookie, no env seal", async () => {
  const w = world({ pgDown: true });
  const env = { PARAFORM_SESSION_STORE: "pg", PARAFORM_SESSION_DATABASE_URL: DB_URL, PARAFORM_SESSION_COOKIE: ENV_COOKIE };
  const r = await ensureParaformSession({ environment: env, fetchImpl: w.fetchImpl, now: 1 });
  assert.equal(r.value, "");
  assert.equal(paraformCookieValue(env), "", "the static seal is not a fallback in pg mode");
  assert.equal(paraformSessionStoreStatus(env).lastError.code, "PARAFORM_SESSION_STORE_UNAVAILABLE");
});

test("mode pg without a database url, or an invalid mode, fails closed with a config code", async () => {
  const w = world();
  for (const env of [
    { PARAFORM_SESSION_STORE: "pg", PARAFORM_SESSION_COOKIE: ENV_COOKIE },
    { PARAFORM_SESSION_STORE: "postgres", PARAFORM_SESSION_DATABASE_URL: DB_URL, PARAFORM_SESSION_COOKIE: ENV_COOKIE },
  ]) {
    __resetParaformSessionStateForTests();
    const r = await ensureParaformSession({ environment: env, fetchImpl: w.fetchImpl, now: 1 });
    assert.equal(r.value, "");
    assert.equal(paraformSessionStoreStatus(env).lastError.code, "PARAFORM_SESSION_STORE_CONFIG");
  }
  assert.equal(w.seen.pg, 0);
});

test("the Para AI client names the store when pg mode yields no cookie", async () => {
  const saved = { ...process.env };
  Object.assign(process.env, { PARAFORM_SESSION_STORE: "pg", PARAFORM_SESSION_COOKIE: ENV_COOKIE });
  delete process.env.PARAFORM_SESSION_DATABASE_URL;
  try {
    clearCookieCache();
    await assert.rejects(paraformCookie(), /from the pg session store \(PARAFORM_SESSION_STORE_CONFIG\)/u);
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
});

test("vendored lifecycle copies match their pins (re-sync from lifecycle/_lib/, then update the pins)", async () => {
  // Byte-identical copies of Raydar lifecycle/_lib/ (the other repo has the
  // authoritative byte-identity guard). Any drift here must be a deliberate re-sync.
  const pins = {
    "neon-http.mjs": "df00242cec7523d80468f1e3131aea739fd0acf59a95f042306339225b74bc69",
    "paraform-accounts.mjs": "d82a4ca8dce7ad84c698c8e17c6133841538c90edfe1fcba8809c6a2735c1a32",
    "paraform-session.mjs": "6f231399854bb55ac5f0bfb4d6860f77b141d899945a0e3183f45bb1a68ac23c",
    "paraform-session-store.mjs": "08f2bdb74903b52bad7e987ad47832c6699bceacd9d9834f67d4fc94b2facb42",
  };
  for (const [name, expected] of Object.entries(pins)) {
    const bytes = await readFile(new URL(`../api/_lib/vendor/paraform/${name}`, import.meta.url));
    assert.equal(createHash("sha256").update(bytes).digest("hex"), expected, `${name} drifted from its pin`);
  }
});
