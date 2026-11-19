import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  PENDING_OWN_KEY,
  PENDING_TEAMMATES_KEY,
  isPendingRequest,
  pendingRow,
  readPendingSnapshot,
  recordPendingSnapshot,
} from "../api/paraai/_lib/pending-snapshot.mjs";
import { normalizeSubmissionRequest } from "../api/paraai/_lib/outreach.mjs";
import { createPendingRequestsHandler } from "../api/paraai/pending-requests.mjs";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-11-19T18:00:00.000Z");
const KEY = "pending-read-key-for-tests-0123456789";

// A row as Paraform's request history returns it (made-up people).
const raw = (over = {}) => ({
  id: "req_1",
  status: "pending",
  state: "PENDING",
  created_at: new Date(NOW - 2 * DAY).toISOString(),
  candidate: { id: "cand_1", candidate_user_id: "cu_1", name: "Jordan  Example" },
  role: { id: "role_1", name: "Staff Engineer", company: { name: "Acme Test Co" } },
  ...over,
});
const own = (over) => normalizeSubmissionRequest(raw(over));
const teammate = (over) => normalizeSubmissionRequest(raw(over), { own: false, key: "vanessa", covered: true });

function fakeKv() {
  const store = new Map();
  const calls = [];
  const kv = async (args) => {
    calls.push(args);
    if (args[0] === "SET") { store.set(args[1], args[2]); return "OK"; }
    if (args[0] === "GET") return store.get(args[1]) ?? null;
    throw new Error(`unexpected ${args[0]}`);
  };
  return { kv, store, calls };
}

function stubs({ method = "GET", authorization } = {}) {
  const res = {
    statusCode: null, payload: null, headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.payload = payload; return this; },
  };
  return { req: { method, headers: authorization ? { authorization } : {}, query: {} }, res };
}

test("only Paraform's own pending rows are kept, with the 7 day forecast", () => {
  assert.equal(isPendingRequest(own()), true);
  assert.equal(isPendingRequest(own({ status: "expired", state: "EXPIRED" })), false);
  assert.equal(isPendingRequest(own({ status: "pending", state: "EXPIRED" })), false);
  assert.equal(isPendingRequest(own({ status: "submitted", state: "SUBMITTED" })), false);
  assert.equal(isPendingRequest(own({ status: "dismissed", state: "DISMISSED" })), false);
  assert.deepEqual(pendingRow(own()), {
    request_id: "req_1",
    candidate_name: "Jordan Example",
    candidate_user_id: "cu_1",
    role_id: "role_1",
    role_title: "Staff Engineer",
    company_name: "Acme Test Co",
    created_at: new Date(NOW - 2 * DAY).toISOString(),
    expires_at: new Date(NOW + 5 * DAY).toISOString(),
    recruiter: "david",
    reached_out: false,
  });
  assert.equal(pendingRow(teammate()).recruiter, "vanessa");
  assert.equal(pendingRow(own({ created_at: "" })), null, "no created time, no row");
  assert.equal(pendingRow(own({ candidate: { candidate_user_id: "cu_1" } })), null, "no name, no row");
});

test("a tick that did not read teammates leaves their part as it was", async () => {
  const { kv, store } = fakeKv();
  const first = await recordPendingSnapshot(
    [own(), own({ id: "req_closed", status: "dismissed", state: "DISMISSED" }), teammate({ id: "req_t1" })],
    { teammatesRead: true, now: NOW - 10 * 60_000, kvImpl: kv },
  );
  assert.deepEqual(first, { own: true, teammates: true });
  // Ten minutes on: David's own read only, with a new request.
  const second = await recordPendingSnapshot([own(), own({ id: "req_2" })], { teammatesRead: false, now: NOW, kvImpl: kv });
  assert.deepEqual(second, { own: true, teammates: null });
  assert.deepEqual(JSON.parse(store.get(PENDING_OWN_KEY)).rows.map((row) => row.request_id), ["req_1", "req_2"]);
  assert.deepEqual(JSON.parse(store.get(PENDING_TEAMMATES_KEY)).rows.map((row) => row.request_id), ["req_t1"]);

  const read = await readPendingSnapshot({ now: NOW, kvImpl: kv });
  assert.equal(read.as_of, new Date(NOW).toISOString());
  assert.equal(read.teammates_as_of, new Date(NOW - 10 * 60_000).toISOString());
  assert.equal(read.expiry_days, 7);
  assert.equal(read.count, 3);
  assert.deepEqual(read.requests.map((row) => row.request_id).sort(), ["req_1", "req_2", "req_t1"]);
});

test("the read sorts soonest to expire first and leaves out rows whose forecast has passed", async () => {
  const { kv } = fakeKv();
  await recordPendingSnapshot([
    own({ id: "req_new", created_at: new Date(NOW - 1 * DAY).toISOString() }),
    own({ id: "req_hot", created_at: new Date(NOW - 6.5 * DAY).toISOString() }),
    own({ id: "req_gone", created_at: new Date(NOW - 8 * DAY).toISOString() }),
  ], { now: NOW, kvImpl: kv });
  const read = await readPendingSnapshot({ now: NOW, kvImpl: kv });
  assert.deepEqual(read.requests.map((row) => row.request_id), ["req_hot", "req_new"]);
});

test("no copy, a broken copy or a failing store read as 'no copy', never as an error", async () => {
  const none = await readPendingSnapshot({ now: NOW, kvImpl: fakeKv().kv });
  assert.deepEqual([none.as_of, none.count, none.requests], [null, 0, []]);
  const broken = fakeKv();
  broken.store.set(PENDING_OWN_KEY, "{not json");
  assert.equal((await readPendingSnapshot({ now: NOW, kvImpl: broken.kv })).as_of, null);
  const down = async () => { throw new Error("kv down"); };
  assert.equal((await readPendingSnapshot({ now: NOW, kvImpl: down })).as_of, null);
  assert.deepEqual(await recordPendingSnapshot([own()], { teammatesRead: true, now: NOW, kvImpl: down }), { own: false, teammates: false });
});

test("a store that hangs holds the tick no longer than the budget", async () => {
  const hang = () => new Promise(() => {});
  const started = Date.now();
  const result = await recordPendingSnapshot([own(), teammate({ id: "req_t1" })], { teammatesRead: true, now: NOW, kvImpl: hang, budgetMs: 40 });
  assert.deepEqual(result, { own: false, teammates: false });
  assert.ok(Date.now() - started < 1000);
});

test("the route is shut without the secret, refuses a wrong one, and answers the copy for the right one", async () => {
  let reads = 0;
  const readImpl = async ({ now }) => { reads += 1; return { as_of: new Date(now).toISOString(), teammates_as_of: null, expiry_days: 7, count: 0, requests: [] }; };
  const make = (env) => createPendingRequestsHandler({ env, readImpl, clock: () => NOW });

  for (const env of [{}, { PARAAI_PENDING_READ_KEY: "short" }]) {
    const { req, res } = stubs({ authorization: `Bearer ${env.PARAAI_PENDING_READ_KEY ?? ""}` });
    await make(env)(req, res);
    assert.equal(res.statusCode, 503);
    assert.equal(res.payload.error, "pending_read_not_configured");
  }
  const env = { PARAAI_PENDING_READ_KEY: KEY, PARAAI_AUTOMATION_RUNNER_KEY: "runner-key-for-tests-0123456789", CRON_SECRET: "cron-secret-for-tests-0123456789" };
  for (const authorization of [undefined, "Bearer wrong", KEY, `Bearer ${env.PARAAI_AUTOMATION_RUNNER_KEY}`, `Bearer ${env.CRON_SECRET}`, `Bearer ${KEY}x`]) {
    const { req, res } = stubs({ authorization });
    await make(env)(req, res);
    assert.equal(res.statusCode, 401, String(authorization));
  }
  const post = stubs({ method: "POST", authorization: `Bearer ${KEY}` });
  await make(env)(post.req, post.res);
  assert.equal(post.res.statusCode, 405);
  assert.equal(reads, 0, "nothing is read before the secret matches");

  const { req, res } = stubs({ authorization: `Bearer ${KEY}` });
  await make(env)(req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["Cache-Control"], "no-store");
  assert.deepEqual(res.payload, { ok: true, as_of: new Date(NOW).toISOString(), teammates_as_of: null, expiry_days: 7, count: 0, requests: [] });
});

test("the copy and its route never call Paraform; the tick saves the copy from the read it already made", async () => {
  for (const file of ["../api/paraai/_lib/pending-snapshot.mjs", "../api/paraai/pending-requests.mjs"]) {
    const source = (await readFile(new URL(file, import.meta.url), "utf8")).replace(/^\s*\/\/.*$/gm, "");
    assert.doesNotMatch(source, /trpc|ensureParaformSession|paraform\.com|core\.mjs|request-lane-throttle/i, file);
  }
  const tick = await readFile(new URL("../api/paraai/_lib/outreach.mjs", import.meta.url), "utf8");
  assert.match(tick, /recordPendingImpl = recordPendingSnapshot/);
  assert.match(tick, /recordPendingImpl\(\s*Array\.isArray\(historyRead\) \? historyRead : historyRead\.requests,\s*\{ teammatesRead: scope\?\.teammatesRead === true, now \},/);
});
