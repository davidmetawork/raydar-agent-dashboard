// #notify consolidation, dashboard PR 2 (2026-09-25): the NOTIFY_SLACK_CHANNEL
// switch. Unset, every sender behaves exactly as before. Set, the critical
// senders post once per incident to #notify through pageNotify, and the
// incidents System Health's tier-1 tiles already page are left to them.
// No network: every seam is injected, and env vars are restored per test.
import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

import {
  claimNotifySlot,
  notifyChannel,
  pageNotify,
  systemHealthOwns,
} from "../api/_lib/notify.mjs";
import { paraformSession } from "../api/health/_lib/evaluators.mjs";
import {
  DEFAULT_CRITICAL_N8N_WORKFLOWS,
  criticalN8nWorkflows,
  n8nWatchPlan,
} from "../api/ops/n8n-watchdog.mjs";
import { OUTREACH_PAGE_CODES, pageOutreachFailure } from "../api/paraai/_lib/outreach.mjs";
import { runStuckWatchdogTick, stuckAlertMessage } from "../api/paraai/_lib/stuck-watchdog.mjs";
import { handleCalendlyWebhook } from "../api/seq/calendly-hook.mjs";

function fakeKv() {
  const store = new Map();
  const kv = async (command) => {
    const [cmd, key] = command;
    if (cmd === "SET") {
      if (command.includes("NX") && store.has(key)) return null;
      store.set(key, command[2]);
      return "OK";
    }
    if (cmd === "DEL") return store.delete(key) ? 1 : 0;
    return null;
  };
  return { store, kv };
}

// ── pageNotify ──────────────────────────────────────────────────────────────

test("switch off: pageNotify is exactly today's notifySlack call, no slot, no #notify", async () => {
  const legacy = [];
  const notify = [];
  const { store, kv } = fakeKv();
  const result = await pageNotify("hello", {
    key: "k",
    env: {},
    kv,
    legacySend: async (text) => { legacy.push(text); return true; },
    notifySend: async (text) => { notify.push(text); return true; },
  });
  assert.deepEqual(result, { ok: true, via: "legacy" });
  assert.deepEqual(legacy, ["hello"]);
  assert.deepEqual(notify, []);
  assert.equal(store.size, 0);
  assert.equal(systemHealthOwns({}), false);
  assert.equal(notifyChannel({ NOTIFY_SLACK_CHANNEL: "  " }), "");
});

test("switch on: one post per key to the #notify channel; a failed post releases the slot", async () => {
  const env = { NOTIFY_SLACK_CHANNEL: "C_NOTIFY", HEALTH_ALERTS_ENABLED: "true" };
  const { store, kv } = fakeKv();
  const posts = [];
  const notifySend = async (text, options) => { posts.push({ text, options }); return true; };
  const legacySend = async () => { throw new Error("legacy path must not run once the switch is on"); };
  const first = await pageNotify("down", { key: "booking-sweep-stale", env, kv, notifySend, legacySend });
  const second = await pageNotify("down again", { key: "booking-sweep-stale", env, kv, notifySend, legacySend });
  assert.equal(first.ok, true);
  assert.equal(second.skipped, "duplicate");
  assert.deepEqual(posts, [{ text: "down", options: { channel: "C_NOTIFY", botTokenFirst: true } }]);
  assert.ok(store.has("notify:booking-sweep-stale"));
  assert.equal(systemHealthOwns(env), true);

  const failed = await pageNotify("x", { key: "cron-auth", env, kv, notifySend: async () => false, legacySend });
  assert.equal(failed.ok, false);
  assert.equal(store.has("notify:cron-auth"), false, "released so the next run retries");
});

test("switch on: KV trouble still posts (an alert that cannot dedupe is still an alert)", async () => {
  const posts = [];
  await pageNotify("x", {
    key: "k",
    env: { NOTIFY_SLACK_CHANNEL: "C_NOTIFY", HEALTH_ALERTS_ENABLED: "true" },
    kv: async () => { throw new Error("KV down"); },
    notifySend: async (text) => { posts.push(text); return true; },
  });
  assert.deepEqual(posts, ["x"]);
  assert.equal(await claimNotifySlot("k", 60, { kv: async () => { throw new Error("down"); } }), "unavailable");
});

// ── the paraform-session tile ───────────────────────────────────────────────

const paused = { paraform: "paused", paused: true, cookieSet: true, bookingStop: { sessionExpiredConfirmedAt: null } };
const pausedParaai = { paraform: "paused", paused: true };
const tile = (seq, paraai, env) => paraformSession({
  results: { "seq-guardian": { raw: seq }, "paraai-lane": { raw: paraai } },
  env,
});

test("paraform-session tile, switch off: unchanged (both paused still reads OK, as today)", () => {
  assert.equal(tile(paused, pausedParaai, {}).state, "OK");
  assert.equal(tile({ ...paused, cookieSet: false }, pausedParaai, {}).state, "OK");
  assert.equal(tile(paused, { paraform: "expired" }, {}).state, "DOWN");
});

test("paraform-session tile, switch on: DOWN on the sweep's confirmed expiry or a missing cookie", () => {
  const on = { NOTIFY_SLACK_CHANNEL: "C_NOTIFY", HEALTH_ALERTS_ENABLED: "true" };
  const witnessed = { ...paused, bookingStop: { sessionExpiredConfirmedAt: "2026-09-25T01:00:00.000Z" } };
  assert.equal(tile(witnessed, pausedParaai, on).state, "DOWN");
  assert.match(tile(witnessed, pausedParaai, on).reason, /confirmed by the booking sweep/);
  assert.equal(tile({ ...paused, cookieSet: false }, pausedParaai, on).state, "DOWN");
});

test("paraform-session tile, switch on: both sources paused and no witness is UNKNOWN, never a green lie", () => {
  const on = { NOTIFY_SLACK_CHANNEL: "C_NOTIFY", HEALTH_ALERTS_ENABLED: "true" };
  assert.equal(tile(paused, pausedParaai, on).state, "UNKNOWN");
  const live = { paraform: "live", cookieSet: true, bookingStop: {} };
  assert.equal(tile(live, { paraform: "live" }, on).state, "OK");
});

// ── the n8n watchdog ────────────────────────────────────────────────────────

test("n8n watchdog: switch off pages every worsening workflow; on, only the critical five", () => {
  const firing = [
    { workflowId: "QTkhrJajgqX5O1h6", streak: 3 },
    { workflowId: "8ymLGqNXR4Rlk3MZ", streak: 4 }, // Role Chat DM: routine
    { workflowId: "MnDm7iQjRpw6vWRc", streak: 2 },
  ];
  const critical = criticalN8nWorkflows({});
  assert.deepEqual([...critical].sort(), [...DEFAULT_CRITICAL_N8N_WORKFLOWS].sort());
  const off = n8nWatchPlan({ firing, alerted: { MnDm7iQjRpw6vWRc: 2 }, switchOn: false, critical });
  assert.deepEqual(off.page.map((s) => s.workflowId), ["QTkhrJajgqX5O1h6", "8ymLGqNXR4Rlk3MZ"]);
  const on = n8nWatchPlan({ firing, alerted: {}, switchOn: true, critical });
  assert.deepEqual(on.page.map((s) => s.workflowId), ["QTkhrJajgqX5O1h6", "MnDm7iQjRpw6vWRc"]);
  assert.deepEqual(on.silent.map((s) => s.workflowId), ["8ymLGqNXR4Rlk3MZ"]);
  assert.deepEqual([...criticalN8nWorkflows({ N8N_WATCH_CRITICAL_IDS: "a, b" })], ["a", "b"]);
});

// ── Para AI outreach and the stuck watchdog ─────────────────────────────────

test("outreach pages only Gmail auth and unknown-send, once per code", async () => {
  assert.deepEqual([...OUTREACH_PAGE_CODES].sort(), ["GMAIL_AUTH_FAILED", "GMAIL_SEND_UNKNOWN"]);
  const pages = [];
  const claims = new Set();
  const deps = {
    owns: () => false,
    claim: async (key) => { if (claims.has(key)) return false; claims.add(key); return true; },
    page: async (text, options) => { pages.push({ text, options }); return { ok: true }; },
  };
  for (const code of ["OUTREACH_NO_EMAIL", "GMAIL_REQUEST_FAILED", "OUTREACH_THREAD_NOT_FOUND"]) {
    assert.equal((await pageOutreachFailure(code, deps)).paged, false, code);
  }
  assert.equal((await pageOutreachFailure("GMAIL_AUTH_FAILED", deps)).paged, true);
  assert.equal((await pageOutreachFailure("GMAIL_AUTH_FAILED", deps)).paged, false, "deduped per code");
  assert.deepEqual(pages.map((p) => p.options.key), ["paraai-outreach:GMAIL_AUTH_FAILED"]);
});

test("stuck watchdog: no candidate names, and the bucket key reaches pageNotify", async () => {
  const now = Date.parse("2026-09-25T12:00:00Z");
  const jobs = [{ id: "j1", state: "ready_to_submit", candidate: { fullName: "Ada Wong" }, updatedAt: "2026-09-25T00:00:00Z" }];
  const sent = [];
  const result = await runStuckWatchdogTick({
    listJobsImpl: async () => jobs,
    alertSlotImpl: async () => true,
    notifyImpl: async (text, options) => { sent.push({ text, options }); return true; },
    now,
    thresholdMs: 3600_000,
  });
  assert.equal(result.alerted, true);
  assert.doesNotMatch(sent[0].text, /Ada|Wong/);
  assert.deepEqual(sent[0].options, { key: "paraai-stuck-1+" });
  assert.doesNotMatch(stuckAlertMessage([{ id: "x", name: "Ada Wong", state: "prepared", stalledMs: 7_200_000 }]), /Ada/);
});

// ── booking-stop hooks: the tile owns a dead session ────────────────────────

test("Calendly hook: an expired session posts only while the switch is off", async () => {
  const SECRET = "calendly-switch-secret";
  const body = JSON.stringify({
    event: "invitee.created",
    payload: { uri: "https://api.calendly.com/i/42", email: "a@example.com", created_at: "2026-09-25T00:00:00Z", scheduled_event: { start_time: "2026-09-26T00:00:00Z", name: "Intro" } },
  });
  const run = async (owns) => {
    const t = Math.floor(Date.now() / 1000);
    const sig = createHmac("sha256", SECRET).update(`${t}.${body}`).digest("hex");
    const alerts = [];
    const res = await handleCalendlyWebhook(new Request("https://monitor.raydar.xyz/api/seq/calendly-hook", {
      method: "POST", headers: new Headers({ "calendly-webhook-signature": `t=${t},v1=${sig}` }), body,
    }), {
      secret: SECRET,
      hasParaformCookie: () => true,
      pause: async () => { const e = new Error("AUTH_EXPIRED"); e.code = "AUTH_EXPIRED"; throw e; },
      alert: async (text) => { alerts.push(text); return true; },
      healthOwnsSession: () => owns,
    });
    assert.equal(res.status, 503);
    return alerts;
  };
  assert.deepEqual(await run(true), []);
  assert.equal((await run(false)).length, 1);
});

test("the sweep's confirmed-expiry witness has its own key and reaches seq health's staleness view", async () => {
  const { K, sweepStaleness } = await import("../api/seq/_lib/booking-stop.mjs");
  assert.equal(K.sessionExpiredWitness, "seqguard:session-expired-witness:v1");
  const at = "2026-09-25T01:00:00.000Z";
  const read = async (key) => (key === K.sessionExpiredWitness ? { at } : null);
  const stale = await sweepStaleness(Date.parse("2026-09-25T02:00:00Z"), {
    read,
    readMany: async (keys) => keys.map(() => null),
    snapshotHealthLoader: async () => ({}),
  });
  assert.equal(stale.sessionExpiredConfirmedAt, at);
  const none = await sweepStaleness(Date.parse("2026-09-25T02:00:00Z"), {
    read: async () => null,
    readMany: async (keys) => keys.map(() => null),
    snapshotHealthLoader: async () => ({}),
  });
  assert.equal(none.sessionExpiredConfirmedAt, null);
});

test("booking sweep: the witness is written on a confirmed expiry and cleared only by a good pass (a live session records a proof)", async () => {
  const { readFile } = await import("node:fs/promises");
  const src = await readFile(new URL("../api/seq/booking-sweep.mjs", import.meta.url), "utf8");
  assert.match(src, /if \(expired\) \{[\s\S]{0,200}recordSessionExpiredWitness\(\)/);
  assert.match(src, /if \(verdict === "live"\) \{[\s\S]{0,600}recordSessionLiveProof\(/);
  assert.match(src, /recordSweepAttempt\(\{ status: "success", result \}\);[\s\S]{0,300}clearSessionExpiredWitness\(\)/);
  assert.equal(src.match(/await clearSessionExpiredWitness\(\)/g)?.length, 1, "only the good pass retires the witness (PR 230 review 5)");
});
