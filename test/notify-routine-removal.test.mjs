// #notify consolidation, dashboard PR 1 (2026-09-25): routine Slack posts are
// DELETED, not moved. David's rule is one critical-only channel (#notify):
// agent calls failing, emails stopped, Paraform login dead, booking page down,
// or anything else a human must act on now. Successes, recoveries, digests,
// FYIs and per-item review lines post nothing.
//
// Two kinds of pin live here:
//  1. behaviour, through each module's own injection seams (no network: a
//     fetch stub fails the test if anything reaches Slack);
//  2. a source guard that the deleted message texts cannot creep back into
//     api/, so a later edit cannot quietly restore a routine post.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import {
  DEFAULT_DEBOUNCE_TICKS,
  debounceTicksFor,
  downTicksOverrides,
  holdForDebounce,
} from "../api/health/_lib/engine.mjs";
import { handleActivityDigest } from "../api/activity/digest.mjs";
import { handleCalendlyWebhook } from "../api/seq/calendly-hook.mjs";
import * as healthAlert from "../api/health/_lib/alert.mjs";

const ROOT = new URL("..", import.meta.url).pathname;

// Source guards look at code, not at the comments that explain a removal.
function code(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|\s)\/\/.*$/gm, "$1");
}
async function source(rel) {
  return code(await readFile(join(ROOT, rel), "utf8"));
}

function noSlackFetch() {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    throw new Error(`unexpected network call in a no-post test: ${url}`);
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

function response() {
  return {
    headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; },
  };
}

// ── System Health: DOWN pages only ──────────────────────────────────────────

test("health pager: repageStillDown is gone, so a standing DOWN never re-pages hourly", () => {
  assert.equal("repageStillDown" in healthAlert, false);
});

test("health pager: a tier-1 tile leaving DOWN posts no RECOVERED notice", async () => {
  const net = noSlackFetch();
  try {
    const sent = await healthAlert.alertOnTransitions([
      { id: "booking-door", name: "Agent booking door", tier: 1, from: "DOWN", to: "OK", at: "2026-09-25T00:00:00Z", sinceLast: "2026-09-24T23:50:00Z" },
      { id: "screener-uplink", name: "Audio bridge", tier: 1, from: "DOWN", to: "DEGRADED", at: "2026-09-25T00:00:00Z" },
    ], { tiles: {} });
    assert.deepEqual(sent, []);
    assert.deepEqual(net.calls, []);
  } finally {
    net.restore();
  }
});

test("health pager: tier-2 DOWN and non-DOWN transitions never page", async () => {
  const net = noSlackFetch();
  try {
    const sent = await healthAlert.alertOnTransitions([
      { id: "n8n-workflows", name: "n8n workflows", tier: 2, from: "OK", to: "DOWN", at: "2026-09-25T00:00:00Z" },
      { id: "booking-door", name: "Agent booking door", tier: 1, from: "OK", to: "DEGRADED", at: "2026-09-25T00:00:00Z" },
    ], { tiles: {} });
    assert.deepEqual(sent, []);
    assert.deepEqual(net.calls, []);
  } finally {
    net.restore();
  }
});

test("health tick no longer calls a re-page path", async () => {
  const tick = await source("api/health/tick.mjs");
  assert.doesNotMatch(tick, /repageStillDown/);
});

// ── System Health: per-tile DOWN debounce ───────────────────────────────────

test("DOWN debounce overrides: unset, empty, junk and shortening values all mean the 2-tick default", () => {
  assert.equal(DEFAULT_DEBOUNCE_TICKS, 2);
  assert.deepEqual(downTicksOverrides({}), {});
  assert.deepEqual(downTicksOverrides({ HEALTH_DOWN_TICKS_OVERRIDES: "" }), {});
  assert.deepEqual(downTicksOverrides({ HEALTH_DOWN_TICKS_OVERRIDES: "{not json" }), {});
  assert.deepEqual(downTicksOverrides({ HEALTH_DOWN_TICKS_OVERRIDES: "[8]" }), {});
  assert.deepEqual(downTicksOverrides({
    HEALTH_DOWN_TICKS_OVERRIDES: JSON.stringify({
      "booking-door": 8, "calls-api": 1, "screener-feed": 0, "x": "3", "y": 2.5, "z": 999,
    }),
  }), { "booking-door": 8, x: 3 });
});

test("DOWN debounce applies to DOWN only; UNKNOWN keeps two ticks", () => {
  const overrides = { "booking-door": 8 };
  assert.equal(debounceTicksFor("booking-door", "DOWN", overrides), 8);
  assert.equal(debounceTicksFor("booking-door", "UNKNOWN", overrides), 2);
  assert.equal(debounceTicksFor("calls-api", "DOWN", overrides), 2);
});

function simulate(observations, needTicksFor) {
  let tile = { state: "OK", since: "t0" };
  const entered = [];
  observations.forEach((state, index) => {
    const raw = { state, reason: `obs ${index}` };
    const held = holdForDebounce(tile, raw, needTicksFor(state), `t${index + 1}`);
    if (held) { tile = held; return; }
    if (tile.state !== state) entered.push({ state, tick: index + 1 });
    tile = { state, since: `t${index + 1}` };
  });
  return { tile, entered };
}

test("default debounce is unchanged: DOWN enters on the second consecutive tick", () => {
  const { entered } = simulate(["DOWN", "DOWN", "DOWN"], () => 2);
  assert.deepEqual(entered, [{ state: "DOWN", tick: 2 }]);
});

test("an 8-tick override holds DOWN for seven ticks and enters on the eighth", () => {
  const down = Array.from({ length: 9 }, () => "DOWN");
  const { entered } = simulate(down, (s) => (s === "DOWN" ? 8 : 2));
  assert.deepEqual(entered, [{ state: "DOWN", tick: 8 }]);
});

test("an 8-minute blip under the 8-tick override never pages (the 2026-09-23 booking-door case)", () => {
  // Four DOWN ticks (8 minutes at a 2-minute cron), then the door reopens.
  const { entered, tile } = simulate(["DOWN", "DOWN", "DOWN", "DOWN", "OK", "OK"], (s) => (s === "DOWN" ? 8 : 2));
  assert.deepEqual(entered, []);
  assert.equal(tile.state, "OK");
  assert.equal(tile.pending, undefined);
});

test("a pending record written before this change (no pendingCount) still enters on the next tick", () => {
  const legacy = { state: "OK", pending: "DOWN", since: "t0" };
  assert.equal(holdForDebounce(legacy, { state: "DOWN" }, 2, "t1"), null);
});

test("leaving DOWN is immediate and a first observation is never held", () => {
  assert.equal(holdForDebounce({ state: "DOWN" }, { state: "OK" }, 8, "t1"), null);
  assert.equal(holdForDebounce({}, { state: "DOWN" }, 8, "t1"), null);
  assert.equal(holdForDebounce({ state: "OK" }, { state: "DEGRADED" }, 8, "t1"), null);
});

// ── Activity digest: warms the feed, posts nothing ──────────────────────────

const feed = {
  counts: { needs_reply: 2, gone_quiet: 1 },
  queues: {
    needs_reply: [{ key: "a", waitingSinceMs: Date.now() - 86400000 }, { key: "b", waitingSinceMs: Date.now() }],
    gone_quiet: [{ key: "c" }],
  },
};

test("Activity digest warms the feed and reports counts without any Slack post", async () => {
  const net = noSlackFetch();
  const writes = [];
  try {
    const res = response();
    await handleActivityDigest({ method: "GET", headers: {} }, res, {
      cronAuthorize: () => ({ ok: true }),
      pauseState: async () => ({ paused: false }),
      cookiePresent: () => true,
      readMarker: async () => null,
      writeMarker: async (key, value) => { writes.push([key, value]); return "OK"; },
      buildFeedImpl: async () => feed,
      readTriage: async () => ({}),
    });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, { ok: true, warmed: true, open: 2, quiet: 1 });
    assert.equal(writes.length, 2, "feed cache + the once-a-day marker");
    assert.deepEqual(net.calls, []);
  } finally {
    net.restore();
  }
});

test("Activity digest reports an expired session without posting (the paraform-session tile owns it)", async () => {
  const net = noSlackFetch();
  try {
    const res = response();
    await handleActivityDigest({ method: "GET", headers: {} }, res, {
      cronAuthorize: () => ({ ok: true }),
      pauseState: async () => ({ paused: false }),
      cookiePresent: () => true,
      readMarker: async () => null,
      writeMarker: async () => "OK",
      buildFeedImpl: async () => { throw new Error("401"); },
      sessionStateImpl: async () => "expired",
    });
    assert.deepEqual(res.body, { ok: false, degraded: "paraform_auth" });
    assert.deepEqual(net.calls, []);
  } finally {
    net.restore();
  }
});

test("Activity digest has no Slack sender at all", async () => {
  const src = await source("api/activity/digest.mjs");
  assert.doesNotMatch(src, /sendSlack|notifySlack|chat\.postMessage/);
});

// ── Calendly booking-stop webhook ───────────────────────────────────────────

test("Calendly cancellation is recorded and posts nothing", async () => {
  const src = await source("api/seq/calendly-hook.mjs");
  assert.doesNotMatch(src, /Calendly booking cancelled/);
  assert.doesNotMatch(src, /hourly sweep will retry/);
  assert.match(src, /session cookie is expired/, "the cookie-expired line is critical and stays (PR 2 routes it)");
});

test("Calendly webhook pause errors do not post (the sweep retries and owns the page)", async () => {
  // A real signed invitee.created whose pause reports an error: the alert
  // seam must never be reached.
  const alerts = [];
  const { createHmac } = await import("node:crypto");
  const SECRET = "calendly-test-secret";
  const body = JSON.stringify({
    event: "invitee.created",
    payload: { uri: "https://api.calendly.com/i/9", email: "a@example.com", created_at: "2026-09-25T00:00:00Z", scheduled_event: { start_time: "2026-09-26T00:00:00Z", name: "Intro" } },
  });
  const t = Math.floor(Date.now() / 1000);
  const sig = createHmac("sha256", SECRET).update(`${t}.${body}`).digest("hex");
  const headers = new Headers({ "calendly-webhook-signature": `t=${t},v1=${sig}` });
  const request = new Request("https://monitor.raydar.xyz/api/seq/calendly-hook", { method: "POST", headers, body });
  const res = await handleCalendlyWebhook(request, {
    secret: SECRET,
    hasParaformCookie: () => true,
    pause: async () => ({ decisions: [{}], paused: 0, pauseErrors: [{ lead: "x" }] }),
    alert: async (text) => { alerts.push(text); return true; },
  });
  assert.equal(res.status, 202);
  assert.deepEqual(alerts, []);
});

// ── Source guard: deleted routine texts stay deleted ────────────────────────

const REMOVED = [
  ["api/health/_lib/alert.mjs", /RECOVERED:/],
  ["api/health/_lib/alert.mjs", /STILL DOWN/],
  ["api/seq/booking-sweep.mjs", /Booking stop paused/],
  ["api/seq/booking-membership-refresh.mjs", /did not publish a generation/],
  ["api/seq/booking-membership-refresh.mjs", /failed before publication/],
  ["api/seq/raydar-booking-hook.mjs", /Raydar booking cancelled/],
  ["api/seq/raydar-booking-hook.mjs", /native index sweep will retry/],
  ["api/paraai/worker.mjs", /Phase 3 shadow aggregate audit failed/],
  ["api/paraai/worker.mjs", /resume-wait sweep failed/],
  ["api/paraai/worker.mjs", /remainder controller requires review/],
  ["api/paraai/worker.mjs", /resume-only backfill controller requires review/],
  ["api/paraai/worker.mjs", /Phase 3 shadow release requires review/],
  ["api/paraai/worker.mjs", /recovery scan failed/],
  ["api/paraai/worker.mjs", /runCuratedFitDeadmanTick/],
  ["api/paraai/_lib/auto.mjs", /notifySlack/],
  ["api/paraai/run.mjs", /notifySlack/],
  ["api/paraai/_lib/auth-probe.mjs", /cookie healthy — resumed \(/],
  ["api/paraai/_lib/outreach.mjs", /off-market hold has lapsed/],
  ["api/paraai/_lib/outreach.mjs", /Gmail answered 429/],
  ["api/paraai/_lib/outreach.mjs", /notifySlack\(heldAlertCopy/],
  ["api/paraai/_lib/outreach.mjs", /notifySlack\(copy\.slack\)/],
  ["api/paraai/_lib/outreach.mjs", /expiryEscalationCopy\(request, code, escalation\)/],
  ["api/paraai/_lib/outreach.mjs", /notifyImpl\(expiredUnsentCopy/],
  ["api/paraai/_lib/reply.mjs", /notifySlack/],
  ["api/paraai/_lib/expired.mjs", /notifySlack/],
];

for (const [file, pattern] of REMOVED) {
  test(`removed routine post stays removed: ${file} ${pattern}`, async () => {
    assert.doesNotMatch(await source(file), pattern);
  });
}

// Every file under api/ that can still reach Slack, with its number of
// references to a Slack sender (a call, or a sender passed as a default or
// injected seam). A new sender, or a restored one, fails here and has to be
// classified on purpose. PR 2 tightens this into "every caller goes through
// pageNotify, the health pager or the test page".
const EXPECTED_SENDERS = {
  "api/health/_lib/alert.mjs": 1, // the tier-1 DOWN page
  "api/health/digest.mjs": 1, // off: posts only when HEALTH_DIGEST_SLACK_CHANNEL is set
  "api/health/test-page.mjs": 1, // the manual #notify drill
  "api/ops/n8n-watchdog.mjs": 3, // failing-repeatedly, unreadable, cron-auth
  "api/paraai/_lib/auth-probe.mjs": 4, // circuit OPEN + daily reminder, via notifyImpl seams
  "api/paraai/_lib/curated-fit-deadman.mjs": 1, // module kept; the worker no longer calls it
  "api/paraai/_lib/outreach.mjs": 2, // PR 2 narrows these to Gmail/auth codes
  "api/paraai/submission-notify.mjs": 1, // retired route; sealed by the Submissions V2 manifest
  "api/paraai/worker.mjs": 2, // outreach worker failed + the stuck-watchdog seam
  "api/seq/booking-membership-refresh.mjs": 1, // cron-auth warning
  "api/seq/booking-sweep.mjs": 13,
  "api/seq/calendly-hook.mjs": 1, // the alert seam: cookie expired only
  "api/seq/guardian.mjs": 2, // protected-recruiter stop + cron-auth
  "api/seq/raydar-booking-hook.mjs": 1, // the alert seam: cookie expired only
  "api/seq/release.mjs": 1, // cron-auth warning
};

async function walk(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await walk(full));
    else if (/\.(mjs|js)$/.test(entry.name)) out.push(full);
  }
  return out;
}

export function senderReferences(src) {
  return code(src)
    .replace(/\bimport\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?/g, "")
    .split("\n")
    .filter((line) => !/^\s*import\b/.test(line) && !/^\s*(?:export\s+)?(?:async\s+)?function\s+(?:notifySlack|sendSlack)\b/.test(line))
    .reduce((n, line) => n + (line.match(/\b(?:notifySlack|sendSlack)\b/g) || []).length, 0);
}

test("the set of Slack senders under api/ is exactly the classified list", async () => {
  const found = {};
  for (const full of await walk(join(ROOT, "api"))) {
    const rel = full.slice(ROOT.length);
    // core.mjs defines notifySlack (sealed by the Submissions V2 manifest).
    if (rel === "api/paraai/_lib/core.mjs") continue;
    const refs = senderReferences(await readFile(full, "utf8"));
    if (refs > 0) found[rel] = refs;
  }
  assert.deepEqual(found, EXPECTED_SENDERS);
});
