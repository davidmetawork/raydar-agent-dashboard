// #notify switch, handler-level (PR 230 review fixes, 2026-09-25).
//
// Drives the real booking-sweep, n8n-watchdog and guardian handlers against an
// in-memory Upstash stand-in and a recording Slack stand-in, both served from a
// stubbed global fetch. The Paraform sweep and its expiry confirmation are
// injected, and any request to a host the stub does not know FAILS the test, so
// no Paraform, n8n or Slack call can leave this process.
//
// Env is set BEFORE the handlers are imported: the seq KV module reads its
// endpoint at import time. Values are fakes.
import test from "node:test";
import assert from "node:assert/strict";

const KV_URL = "https://kv.test.invalid";
const N8N_URL = "https://n8n.test.invalid";
Object.assign(process.env, {
  KV_REST_API_URL: KV_URL,
  KV_REST_API_TOKEN: "test-kv-token",
  PARAFORM_COOKIE: "test-cookie-value",
  CALENDLY_API_TOKEN: "test-calendly-token",
  CRON_SECRET: "test-cron-secret",
  SLACK_BOT_TOKEN: "xoxb-test",
  PARAAI_SLACK_CHANNEL: "C_LEGACY",
  N8N_BASE_URL: N8N_URL,
  N8N_API_KEY: "test-n8n-key",
});
delete process.env.SLACK_WEBHOOK_URL;
delete process.env.NOTIFY_SLACK_CHANNEL;
delete process.env.HEALTH_ALERTS_ENABLED;

const store = new Map();
const posts = [];
let n8nState = { workflows: [], executions: {} , fail: false };
let slackOk = true;
const realFetch = globalThis.fetch;

function redis(command) {
  const [cmd, key, ...rest] = command;
  switch (String(cmd).toUpperCase()) {
    case "GET": return store.has(key) ? store.get(key) : null;
    case "MGET": return [key, ...rest].map((k) => (store.has(k) ? store.get(k) : null));
    case "DEL": return store.delete(key) ? 1 : 0;
    case "SET": {
      const flags = rest.slice(1).map((v) => String(v).toUpperCase());
      if (flags.includes("NX") && store.has(key)) return null;
      if (flags.includes("XX") && !store.has(key)) return null;
      store.set(key, rest[0]);
      return "OK";
    }
    default: return null;
  }
}

globalThis.fetch = async (input, init = {}) => {
  const url = String(input?.url || input);
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  if (url === KV_URL) return json({ result: redis(JSON.parse(init.body)) });
  if (url === "https://slack.com/api/chat.postMessage") {
    const body = JSON.parse(init.body);
    if (slackOk) posts.push({ channel: body.channel, text: body.text });
    return json({ ok: slackOk });
  }
  if (url.startsWith(`${N8N_URL}/api/v1/workflows`)) {
    if (n8nState.fail) return json({ message: "down" }, 503);
    return json({ data: n8nState.workflows });
  }
  if (url.startsWith(`${N8N_URL}/api/v1/executions`)) {
    const id = new URL(url).searchParams.get("workflowId");
    return json({ data: n8nState.executions[id] || [] });
  }
  throw new Error(`unexpected network call in test: ${url}`);
};
test.after(() => { globalThis.fetch = realFetch; });

const { handleBookingSweep, staleOwnedBySessionTile } = await import("../api/seq/booking-sweep.mjs");
const { K, runBookingSweep } = await import("../api/seq/_lib/booking-stop.mjs");
const n8nWatchdog = (await import("../api/ops/n8n-watchdog.mjs")).default;
const { warnOnCronRejection } = await import("../api/seq/guardian.mjs");
const { sendSlack, alertOnTransitions } = await import("../api/health/_lib/alert.mjs");
const { paraformSession } = await import("../api/health/_lib/evaluators.mjs");
const { handleSequenceHealth, SEQ_HEALTH_LIVE_READ_BUDGET_MS } = await import("../api/seq/health.mjs");
const { SESSION_WITNESS_KEY } = await import("../api/health/_lib/engine.mjs");
const { CATALOG } = await import("../api/health/_lib/catalog.mjs");
const { readFileSync } = await import("node:fs");
const { pageNotify, systemHealthOwns } = await import("../api/_lib/notify.mjs");
const { pageOutreachFailure } = await import("../api/paraai/_lib/outreach.mjs");

function switchOn() {
  process.env.NOTIFY_SLACK_CHANNEL = "C_NOTIFY";
  process.env.HEALTH_ALERTS_ENABLED = "true";
}
function switchOff() {
  delete process.env.NOTIFY_SLACK_CHANNEL;
  delete process.env.HEALTH_ALERTS_ENABLED;
}
function reset() {
  store.clear();
  posts.length = 0;
  slackOk = true;
  switchOff();
}

function fakeRes() {
  const res = { statusCode: 200, body: null, headers: {} };
  res.setHeader = (k, v) => { res.headers[k] = v; };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  res.end = () => res;
  return res;
}
const cronReq = (path = "/api/seq/booking-sweep") => ({
  method: "GET",
  url: path,
  headers: { authorization: "Bearer test-cron-secret", "x-vercel-cron": "1" },
});
const authExpired = () => Object.assign(new Error("AUTH_EXPIRED"), { code: "AUTH_EXPIRED" });
const STALE = (extra = {}) => ({ stale: true, lastAt: "2026-09-25T00:00:00.000Z", sessionExpiredConfirmedAt: null, ...extra });
const stalePosts = () => posts.filter((p) => /has not completed a full pass/.test(p.text));

// ── the stale page is skipped only for a WITNESSED expiry ───────────────────

test("staleOwnedBySessionTile: only a standing witness, never an error label", () => {
  assert.equal(staleOwnedBySessionTile(STALE({ latestAttemptError: "CALENDLY_AUTH" }), { switchOn: true }), false);
  assert.equal(staleOwnedBySessionTile(STALE({ latestAttemptError: "AUTH_EXPIRED" }), { switchOn: true }), false);
  assert.equal(staleOwnedBySessionTile(STALE({ sessionExpiredConfirmedAt: "2026-09-25T01:00:00.000Z" }), { switchOn: true }), true);
  assert.equal(staleOwnedBySessionTile(STALE({ sessionExpiredConfirmedAt: "2026-09-25T01:00:00.000Z" }), { switchOn: false }), false);
});

for (const [label, latestAttemptError] of [["a revoked Calendly token", "CALENDLY_AUTH"], ["an unconfirmed AUTH_EXPIRED", "AUTH_EXPIRED"]]) {
  test(`switch on: a stale sweep caused by ${label} still pages #notify once`, async () => {
    reset();
    switchOn();
    const deps = {
      staleness: async () => STALE({ latestAttemptError }),
      sweep: async () => ({ ok: false, error: "membership_snapshot_unavailable", pauseErrors: [], decisions: [] }),
      confirmExpired: async () => { throw new Error("must not confirm: the sweep did not throw"); },
    };
    await handleBookingSweep(cronReq(), fakeRes(), deps);
    await handleBookingSweep(cronReq(), fakeRes(), deps);
    assert.equal(stalePosts().length, 1, "once per incident");
    assert.equal(stalePosts()[0].channel, "C_NOTIFY");
  });
}

test("switch on: a witnessed expiry leaves the stale page to the paraform-session tile", async () => {
  reset();
  switchOn();
  await handleBookingSweep(cronReq(), fakeRes(), {
    staleness: async () => STALE({ latestAttemptError: "AUTH_EXPIRED", sessionExpiredConfirmedAt: "2026-09-25T01:00:00.000Z" }),
    sweep: async () => { throw authExpired(); },
    confirmExpired: async () => true,
  });
  assert.deepEqual(posts, [], "the tile pages this one; the sweep posts nothing");
});

test("a confirmed AUTH_EXPIRED writes the witness; a live-session throttle clears it", async () => {
  reset();
  switchOn();
  const res = fakeRes();
  await handleBookingSweep(cronReq(), res, {
    staleness: async () => ({ stale: false }),
    sweep: async () => { throw authExpired(); },
    confirmExpired: async () => true,
  });
  assert.equal(res.body.error, "expired");
  assert.ok(store.has(K.sessionExpiredWitness), "witness written");
  assert.deepEqual(posts, [], "switch on: the tile owns the expiry");

  const throttled = fakeRes();
  await handleBookingSweep(cronReq(), throttled, {
    staleness: async () => ({ stale: false }),
    sweep: async () => { throw authExpired(); },
    confirmExpired: async () => false,
  });
  assert.equal(throttled.body.error, "throttled");
  assert.equal(store.has(K.sessionExpiredWitness), false, "witness cleared");
});

test("switch off: a confirmed expiry still posts the legacy line to the legacy channel", async () => {
  reset();
  await handleBookingSweep(cronReq(), fakeRes(), {
    staleness: async () => ({ stale: false }),
    sweep: async () => { throw authExpired(); },
    confirmExpired: async () => true,
  });
  assert.equal(posts.length, 1);
  assert.equal(posts[0].channel, "C_LEGACY");
  assert.match(posts[0].text, /AUTH_EXPIRED/);
});

test("runBookingSweep rethrows a scope-read AUTH_EXPIRED instead of calling it a snapshot problem", async () => {
  await assert.rejects(
    runBookingSweep({ apply: true, sequenceScopeLoader: async () => { throw authExpired(); } }),
    (e) => e.code === "AUTH_EXPIRED",
  );
  const other = await runBookingSweep({ apply: true, sequenceScopeLoader: async () => { throw new Error("upstream"); } });
  assert.equal(other.error, "membership_snapshot_unavailable");
});

test("the finding's inputs: switch on, seq health reads expired while Para AI is paused -> DOWN", () => {
  const on = { NOTIFY_SLACK_CHANNEL: "C_NOTIFY", HEALTH_ALERTS_ENABLED: "true" };
  const results = {
    "seq-guardian": { raw: { cookieSet: true, paraform: "expired", bookingStop: { sessionExpiredConfirmedAt: null } } },
    "paraai-lane": { raw: { paraform: "paused" } },
  };
  assert.equal(paraformSession({ results, env: on }).state, "DOWN");
  assert.equal(paraformSession({ results, env: {} }).state, "OK", "switch off: unchanged");
});

// ── the switch needs HEALTH_ALERTS_ENABLED too ──────────────────────────────

test("NOTIFY_SLACK_CHANNEL without HEALTH_ALERTS_ENABLED=true is still OFF", async () => {
  const half = { NOTIFY_SLACK_CHANNEL: "C_NOTIFY", HEALTH_ALERTS_ENABLED: "1" };
  assert.equal(systemHealthOwns(half), false);
  const sent = [];
  const result = await pageNotify("x", { key: "k", env: half, legacySend: async (t) => { sent.push(t); return true; }, notifySend: async () => { throw new Error("no"); } });
  assert.equal(result.via, "legacy");
  assert.deepEqual(sent, ["x"]);
  const witnessed = { "seq-guardian": { raw: { cookieSet: false, bookingStop: {} } }, "paraai-lane": { raw: { paraform: "paused" } } };
  assert.equal(paraformSession({ results: witnessed, env: half }).state, "OK", "tile unchanged while off");
});

// ── the transport: an override beats SLACK_WEBHOOK_URL when asked ────────────

test("sendSlack botTokenFirst posts by token to the named channel even with a webhook set", async () => {
  reset();
  process.env.SLACK_WEBHOOK_URL = "https://hooks.slack.test.invalid/x";
  try {
    assert.equal(await sendSlack("page", { channel: "C_NOTIFY", botTokenFirst: true }), true);
    assert.deepEqual(posts, [{ channel: "C_NOTIFY", text: "page" }]);
  } finally {
    delete process.env.SLACK_WEBHOOK_URL;
  }
});

test("alertOnTransitions routes tile pages to NOTIFY_SLACK_CHANNEL once the switch is on", async () => {
  reset();
  const calls = [];
  const send = async (text, options) => { calls.push(options); return true; };
  const t = { id: "paraform-session", name: "Paraform session", from: "OK", to: "DOWN", tier: 1, at: "2026-09-25T00:00:00Z", reason: "x" };
  // The pager reads the tile state (one page per incident, PR 229 review).
  const state = {
    tiles: {
      "paraform-session": {
        state: "DOWN", tier: 1, name: "Paraform session", reason: "x",
        since: "2026-09-25T00:00:00Z", incidentAt: "2026-09-25T00:00:00Z",
      },
    },
  };
  await alertOnTransitions([t], state, { env: {}, send });
  store.clear();
  await alertOnTransitions([t], state, { env: { NOTIFY_SLACK_CHANNEL: "C_NOTIFY", HEALTH_ALERTS_ENABLED: "true" }, send });
  assert.deepEqual(calls, [undefined, { channel: "C_NOTIFY", botTokenFirst: true }]);
});

// ── the n8n watchdog handler ────────────────────────────────────────────────

const CRITICAL = "QTkhrJajgqX5O1h6"; // wf01
const failing = (n) => Array.from({ length: n }, (_, i) => ({ status: "error", mode: "trigger", startedAt: `2026-09-25T0${9 - i}:00:00Z` }));
const n8nPosts = () => posts.filter((p) => /n8n workflow/.test(p.text));
const n8nStateKv = () => JSON.parse(store.get("seqguard:n8nwatch"));

test("n8n switch off: a held throttle slot leaves alerted[] alone, so the next tick still posts", async () => {
  reset();
  n8nState = { workflows: [{ id: CRITICAL, name: "wf01", active: true }], executions: { [CRITICAL]: failing(3) } };
  store.set(K.alert("n8n-failures"), JSON.stringify({ at: "held" }));
  await n8nWatchdog(cronReq("/api/ops/n8n-watchdog"), fakeRes());
  assert.equal(n8nPosts().length, 0);
  assert.deepEqual(n8nStateKv().alerted, {}, "not marked alerted without a post");
  store.delete(K.alert("n8n-failures"));
  await n8nWatchdog(cronReq("/api/ops/n8n-watchdog"), fakeRes());
  assert.equal(n8nPosts().length, 1);
  assert.equal(n8nStateKv().alerted[CRITICAL], 3);
});

test("n8n switch on: an outage already alerted in legacy mode reaches #notify once; recovery clears the slot", async () => {
  reset();
  n8nState = { workflows: [{ id: CRITICAL, name: "wf01", active: true }], executions: { [CRITICAL]: failing(3) } };
  store.set("seqguard:n8nwatch", JSON.stringify({ alerted: { [CRITICAL]: 3 } }));
  switchOn();
  await n8nWatchdog(cronReq("/api/ops/n8n-watchdog"), fakeRes());
  await n8nWatchdog(cronReq("/api/ops/n8n-watchdog"), fakeRes());
  assert.equal(n8nPosts().length, 1, "first switch-on tick pages, the second is deduped");
  assert.equal(n8nPosts()[0].channel, "C_NOTIFY");
  assert.ok(store.has(`notify:n8n-failing:${CRITICAL}`));

  n8nState.executions[CRITICAL] = [{ status: "success", mode: "trigger", startedAt: "2026-09-25T10:00:00Z" }];
  await n8nWatchdog(cronReq("/api/ops/n8n-watchdog"), fakeRes());
  assert.equal(store.has(`notify:n8n-failing:${CRITICAL}`), false, "cleared on recovery");
});

test("n8n switch on: 'could not read' pages once, and a good read ends that incident", async () => {
  reset();
  switchOn();
  n8nState = { workflows: [], executions: {}, fail: true };
  await n8nWatchdog(cronReq("/api/ops/n8n-watchdog"), fakeRes());
  await n8nWatchdog(cronReq("/api/ops/n8n-watchdog"), fakeRes());
  assert.equal(posts.filter((p) => /could not read/.test(p.text)).length, 1);
  n8nState.fail = false;
  await n8nWatchdog(cronReq("/api/ops/n8n-watchdog"), fakeRes());
  assert.equal(store.has("notify:n8n-unreadable"), false);
  n8nState.fail = true;
  await n8nWatchdog(cronReq("/api/ops/n8n-watchdog"), fakeRes());
  assert.equal(posts.filter((p) => /could not read/.test(p.text)).length, 2, "a second outage pages again");
});

// ── guardian and outreach ───────────────────────────────────────────────────

test("guardian warnOnCronRejection no longer throws (shouldAlert is imported) and posts once", async () => {
  reset();
  await warnOnCronRejection({ ok: false, headerPresent: true, reason: "header_without_bearer" });
  await warnOnCronRejection({ ok: false, headerPresent: true, reason: "header_without_bearer" });
  assert.equal(posts.length, 1);
  assert.equal(posts[0].channel, "C_LEGACY");
});

test("outreach switch off: a failed post releases the 6h slot so the next failure retries", async () => {
  const held = new Set();
  const deps = {
    owns: () => false,
    claim: async (key) => { if (held.has(key)) return false; held.add(key); return true; },
    release: async (key) => held.delete(key),
    page: async () => ({ ok: false }),
  };
  assert.equal((await pageOutreachFailure("GMAIL_AUTH_FAILED", deps)).paged, false);
  assert.equal(held.size, 0, "slot released");
  deps.page = async () => ({ ok: true });
  assert.equal((await pageOutreachFailure("GMAIL_AUTH_FAILED", deps)).paged, true);
});


// ── PR 230 review round 2: a dead cookie must page even when the health
//    probes that carry the witness time out ──────────────────────────────────

const ON = { NOTIFY_SLACK_CHANNEL: "C_NOTIFY", HEALTH_ALERTS_ENABLED: "true" };
const WITNESS_AT = "2026-09-25T01:00:00.000Z";
const never = () => new Promise(() => {}); // a live read stuck on the throttle ladder
const healthReq = () => ({ method: "GET", url: "/api/seq/health", headers: {} });

test("the health engine reads the sweep's witness key itself and hands it to the tile", () => {
  assert.equal(SESSION_WITNESS_KEY, K.sessionExpiredWitness);
  const engineSource = readFileSync(new URL("../api/health/_lib/engine.mjs", import.meta.url), "utf8");
  assert.match(engineSource, /hGet\(SESSION_WITNESS_KEY\)/);
  assert.match(engineSource, /gmailBackoffUntil, sessionWitness,/);
});

test("tile: both health probes timed out (raw null) + the KV witness -> DOWN once the switch is on", () => {
  const blind = { "seq-guardian": { raw: null }, "paraai-lane": { raw: null } };
  const v = paraformSession({ results: blind, sessionWitness: { at: WITNESS_AT }, env: ON });
  assert.equal(v.state, "DOWN");
  assert.match(v.reason, /confirmed by the booking sweep/);
  assert.equal(paraformSession({ results: blind, sessionWitness: { at: WITNESS_AT }, env: {} }).state, "UNKNOWN", "switch off: unchanged");
  assert.equal(paraformSession({ results: blind, sessionWitness: null, env: ON }).state, "UNKNOWN");
});

test("tile: a live seq read made AFTER the witness wins (recapture, then a non-auth sweep failure)", () => {
  const live = (checkedAt) => ({
    "seq-guardian": { raw: { cookieSet: true, paraform: "live", checkedAt, bookingStop: { sessionExpiredConfirmedAt: WITNESS_AT } } },
    "paraai-lane": { raw: { paraform: "live" } },
  });
  assert.equal(paraformSession({ results: live("2026-09-25T02:00:00.000Z"), sessionWitness: { at: WITNESS_AT }, env: ON }).state, "OK");
  assert.equal(
    paraformSession({ results: live("2026-09-25T00:59:00.000Z"), sessionWitness: { at: WITNESS_AT }, env: ON }).state,
    "DOWN",
    "a cached live read older than the witness proves nothing",
  );
});

test("seq health answers inside the probe timeout while the live read is stuck, and reports the witness", async () => {
  const seqProbe = CATALOG.find((c) => c.id === "seq-guardian").probe;
  assert.ok(SEQ_HEALTH_LIVE_READ_BUDGET_MS < seqProbe.timeoutMs - 2000, "the cap leaves room for the KV reads and the network");
  reset();
  switchOn();
  store.set(K.sessionExpiredWitness, JSON.stringify({ at: WITNESS_AT }));
  const res = fakeRes();
  const t0 = Date.now();
  await handleSequenceHealth(healthReq(), res, { healthReader: never, liveReadBudgetMs: 80 });
  assert.ok(Date.now() - t0 < 1000, `answered in ${Date.now() - t0} ms`);
  assert.equal(res.body.paraform, "expired");
  assert.equal(res.body.liveRead, "timeout");
  assert.equal(res.body.ok, false);
  assert.equal(res.body.bookingStop.sessionExpiredConfirmedAt, WITNESS_AT);
  assert.equal(paraformSession({ results: { "seq-guardian": { raw: res.body } }, env: ON }).state, "DOWN");

  switchOff();
  const off = fakeRes();
  await handleSequenceHealth(healthReq(), off, { healthReader: never, liveReadBudgetMs: 80 });
  assert.equal(off.body.paraform, "timeout", "switch off: the witness does not rewrite the answer");
  assert.equal(store.has(K.sessionExpiredWitness), true, "a timeout never clears the witness");
});

test("seq health: a live read made after the witness clears it; an older cached one does not", async () => {
  reset();
  switchOn();
  store.set(K.sessionExpiredWitness, JSON.stringify({ at: WITNESS_AT }));
  const stale = fakeRes();
  await handleSequenceHealth(healthReq(), stale, {
    healthReader: async () => ({ paraform: "live", sequenceCount: 3, checkedAt: "2026-09-25T00:59:00.000Z" }),
  });
  assert.equal(stale.body.paraform, "expired");
  assert.equal(store.has(K.sessionExpiredWitness), true);

  const fresh = fakeRes();
  await handleSequenceHealth(healthReq(), fresh, {
    healthReader: async () => ({ paraform: "live", sequenceCount: 3, checkedAt: "2026-09-25T02:00:00.000Z" }),
  });
  assert.equal(fresh.body.paraform, "live");
  assert.equal(fresh.body.ok, true);
  assert.equal(fresh.body.bookingStop.sessionExpiredConfirmedAt, null);
  assert.equal(store.has(K.sessionExpiredWitness), false, "witness cleared: the stale page is the sweep's again");
});

test("sendSlack botTokenFirst without SLACK_BOT_TOKEN fails closed: it never falls back to the webhook", async () => {
  reset();
  const savedToken = process.env.SLACK_BOT_TOKEN;
  delete process.env.SLACK_BOT_TOKEN;
  process.env.SLACK_WEBHOOK_URL = "https://hooks.slack.test.invalid/x";
  const seen = [];
  const inner = globalThis.fetch;
  globalThis.fetch = async (input, init) => { seen.push(String(input?.url || input)); return inner(input, init); };
  try {
    assert.equal(await sendSlack("page", { channel: "C_NOTIFY", botTokenFirst: true }), false);
    assert.equal(seen.some((u) => u.startsWith("https://hooks.slack")), false, "no webhook call");
    assert.deepEqual(posts, []);
    const receipt = JSON.parse(store.get("hlth:alert:lastDelivered") ?? "null");
    assert.equal(receipt?.failed, true, "the failure is recorded for the slack-transport tile");
    assert.equal(receipt?.reason, "no_bot_token");
  } finally {
    globalThis.fetch = inner;
    process.env.SLACK_BOT_TOKEN = savedToken;
    delete process.env.SLACK_WEBHOOK_URL;
  }
});
