import test from "node:test";
import assert from "node:assert/strict";
import {
  assembleInboxSnapshotFeed,
  buildInboxRefresh,
  emptyInboxSnapshotState,
  INBOX_RECENT_TIMEOUT_MS,
  INBOX_SCHEDULED_STALE_MS,
  INBOX_SETTLE_MS,
  INBOX_UNMETERED_READ_AFTER_MS,
  INBOX_VENDOR_TIMEOUT_MS,
  mergeInboxRefreshState,
  readInboxReplyMetrics,
  selectChangedInboxCampaigns,
} from "../api/inbox/_lib/core.mjs";
import { createInboxSyncHandler } from "../api/inbox/sync.mjs";

const HOUR = 60 * 60 * 1_000;
const NOW = Date.parse("2026-09-28T19:00:00.000Z");
const iso = (ms) => new Date(ms).toISOString();

function snapshot(id, {
  refreshedMs = NOW - 5 * HOUR,
  metrics = { replies_count: 2, interested_replies: 1 },
  replies = [{ gmail_id: `${id}-g1`, date: iso(NOW - 3 * 24 * HOUR) }],
} = {}) {
  return {
    version: 3,
    submissions_projection_version: 1,
    sequence_id: id,
    sequence_name: id,
    email_replies: null,
    refreshed_at: iso(refreshedMs),
    reply_metrics: metrics,
    replies,
    submissions_replies: [],
    lead_categories: {},
  };
}

function stateWith(snapshots, meta = {}) {
  const state = emptyInboxSnapshotState();
  state.snapshots = new Map(snapshots.map((item) => [item.sequence_id, item]));
  state.meta = { version: 3, sequence_attempts: {}, failures: [], verified_at: iso(NOW - 5 * HOUR), ...meta };
  return state;
}

const campaign = (id) => ({ id, project_id: `project-${id}`, name: id });
const metricsFor = (entries) => new Map(Object.entries(entries));

test("unchanged counts and no new recent email read nothing but the rotation", () => {
  const campaigns = ["a", "b", "c", "d", "e"].map(campaign);
  const previous = stateWith(campaigns.map((item) => snapshot(item.id)));
  const metrics = metricsFor(Object.fromEntries(campaigns.map((item) => [
    item.id, { replies_count: 2, interested_replies: 1 },
  ])));
  const result = selectChangedInboxCampaigns(campaigns, previous, [], metrics, {
    nowMs: NOW, rotation: 2,
  });
  assert.equal(result.selected.length, 2);
  assert.deepEqual(result.reasons, { rotation: 2 });
  assert.equal(result.window_saturated, false);
  assert.deepEqual(result.deferred_sequence_ids, []);
  assert.deepEqual(result.unmetered_sequence_ids, []);
});

test("each kind of change evidence selects its sequence, most urgent first", () => {
  const campaigns = ["missing", "people", "interest", "baseline", "followup", "settle", "quiet"].map(campaign);
  const previous = stateWith([
    snapshot("people"),
    snapshot("interest"),
    snapshot("baseline", { metrics: null }),
    snapshot("followup", { refreshedMs: NOW - 6 * HOUR }),
    // Read 30 minutes after its newest reply, over two hours ago: settle once.
    snapshot("settle", {
      refreshedMs: NOW - 3 * HOUR,
      replies: [{ gmail_id: "settle-g1", date: iso(NOW - 3.5 * HOUR) }],
    }),
    snapshot("quiet"),
  ]);
  const metrics = metricsFor({
    missing: { replies_count: 1, interested_replies: 0 },
    people: { replies_count: 3, interested_replies: 1 },
    interest: { replies_count: 2, interested_replies: 2 },
    baseline: { replies_count: 2, interested_replies: 1 },
    followup: { replies_count: 2, interested_replies: 1 },
    settle: { replies_count: 2, interested_replies: 1 },
    quiet: { replies_count: 2, interested_replies: 1 },
  });
  const recent = [
    // A follow-up from someone who already replied: counts do not move.
    { sequence_id: "followup", gmail_id: "followup-new", email_date: iso(NOW - 1 * HOUR) },
    // Already in the snapshot: no read.
    { sequence_id: "quiet", gmail_id: "quiet-g1", email_date: iso(NOW - 3 * 24 * HOUR) },
  ];
  const result = selectChangedInboxCampaigns(campaigns, previous, recent, metrics, {
    nowMs: NOW, rotation: 0,
  });
  // Same reason and read time: ordered by id.
  assert.deepEqual(result.selected.map((item) => item.id), [
    "missing", "interest", "people", "baseline", "followup", "settle",
  ]);
  assert.deepEqual(result.reasons, {
    missing: 1, counts_changed: 2, no_baseline: 1, recent_email: 1, settle: 1,
  });
});

test("a recent email older than the snapshot is not a reason to re-read", () => {
  const campaigns = [campaign("a")];
  const previous = stateWith([snapshot("a", { refreshedMs: NOW - HOUR })]);
  const recent = [{ sequence_id: "a", gmail_id: "excluded-bounce", email_date: iso(NOW - 2 * HOUR) }];
  const result = selectChangedInboxCampaigns(campaigns, previous, recent,
    metricsFor({ a: { replies_count: 2, interested_replies: 1 } }), { nowMs: NOW, rotation: 0 });
  assert.deepEqual(result.selected, []);
});

test("a full recent window older than the last verified run falls back to hot sequences", () => {
  const campaigns = [campaign("hot"), campaign("cold")];
  const previous = stateWith([
    snapshot("hot", { replies: [{ gmail_id: "hot-g1", date: iso(NOW - 2 * 24 * HOUR) }] }),
    snapshot("cold", { replies: [{ gmail_id: "cold-g1", date: iso(NOW - 30 * 24 * HOUR) }] }),
  ], { verified_at: iso(NOW - 14 * HOUR) });
  const metrics = metricsFor({
    hot: { replies_count: 2, interested_replies: 1 },
    cold: { replies_count: 2, interested_replies: 1 },
  });
  const fullWindow = Array.from({ length: 20 }, (_, index) => ({
    sequence_id: "elsewhere", gmail_id: `w${index}`, email_date: iso(NOW - (index + 1) * 10 * 60 * 1_000),
  }));
  const saturated = selectChangedInboxCampaigns(campaigns, previous, fullWindow, metrics, {
    nowMs: NOW, rotation: 0,
  });
  assert.equal(saturated.window_saturated, true);
  assert.deepEqual(saturated.selected.map((item) => item.id), ["hot"]);

  const calm = selectChangedInboxCampaigns(campaigns, previous, fullWindow.slice(0, 5), metrics, {
    nowMs: NOW, rotation: 0,
  });
  assert.equal(calm.window_saturated, false);
  assert.deepEqual(calm.selected, []);

  const recentDown = selectChangedInboxCampaigns(campaigns, previous, [], metrics, {
    nowMs: NOW, rotation: 0, recentAvailable: false,
  });
  assert.deepEqual(recentDown.selected.map((item) => item.id), ["hot"]);
});

test("missing counts are unmetered: re-read only once the snapshot is old", () => {
  const campaigns = [campaign("fresh"), campaign("old")];
  const previous = stateWith([
    snapshot("fresh", { refreshedMs: NOW - HOUR }),
    snapshot("old", { refreshedMs: NOW - INBOX_UNMETERED_READ_AFTER_MS - HOUR }),
  ]);
  const result = selectChangedInboxCampaigns(campaigns, previous, [], new Map(), {
    nowMs: NOW, rotation: 0,
  });
  assert.deepEqual(result.selected.map((item) => item.id), ["old"]);
  assert.deepEqual(result.unmetered_sequence_ids.sort(), ["fresh", "old"]);
});

test("changes beyond the batch are deferred, never dropped", () => {
  const campaigns = ["a", "b", "c"].map(campaign);
  const result = selectChangedInboxCampaigns(campaigns, stateWith([]), [], new Map(), {
    nowMs: NOW, batchSize: 2, rotation: 3,
  });
  assert.equal(result.selected.length, 2);
  assert.deepEqual(result.deferred_sequence_ids, ["c"]);
});

test("reply counts are read ten ids per call, grouped by audience, failures isolated", async () => {
  const targets = [
    ...Array.from({ length: 23 }, (_, index) => campaign(`c${index}`)),
    { ...campaign("company-1"), kind: "COMPANY" },
  ];
  const calls = [];
  const call = async (procedure, input) => {
    calls.push({ procedure, size: input.campaign_ids.length, audience: input.audience || null });
    if (input.campaign_ids.includes("c20")) throw Object.assign(new Error("x"), { code: "PARAFORM_THROTTLED" });
    return Object.fromEntries(input.campaign_ids.map((id) => [
      id, { replies_count: 1, interested_replies: 0, opens_count: 9 },
    ]));
  };
  const result = await readInboxReplyMetrics(targets, call, { concurrency: 2 });
  assert.equal(result.batches, 4);
  assert.equal(result.failed_batches, 1);
  assert.ok(calls.every((item) => item.procedure === "campaigns.getMetricsForSequences"));
  assert.deepEqual(calls.map((item) => item.size).sort((a, b) => a - b), [1, 3, 10, 10]);
  assert.equal(calls.filter((item) => item.audience === "company").length, 1);
  assert.equal(result.metrics.size, 21);
  assert.deepEqual(result.metrics.get("c0"), { replies_count: 1, interested_replies: 0 });
  assert.equal(result.metrics.has("c21"), false);
});

test("the recent window gets its own longer timeout in every mode", async () => {
  for (const mode of ["stale", "changed"]) {
    const timeouts = {};
    await buildInboxRefresh({
      mode,
      budgetMs: 60_000,
      previousState: stateWith([]),
      get: async (procedure, input, tries, timeoutMs) => {
        timeouts[procedure] = timeoutMs;
        if (procedure === "campaigns.getListOfCampaignsOptimized") return [];
        if (procedure === "campaigns.getRecentReplies") return [];
        return {};
      },
    });
    assert.equal(timeouts["campaigns.getRecentReplies"], INBOX_RECENT_TIMEOUT_MS);
    assert.equal(timeouts["campaigns.getListOfCampaignsOptimized"], INBOX_VENDOR_TIMEOUT_MS);
  }
});

test("a changed-mode refresh reads only changed sequences and vouches for the rest", async () => {
  const campaigns = ["same", "grew", "broken"].map(campaign);
  const previous = stateWith(campaigns.map((item) => snapshot(item.id)));
  const reads = [];
  const refresh = await buildInboxRefresh({
    mode: "changed",
    budgetMs: 60_000,
    batchSize: 150,
    previousState: previous,
    now: () => new Date(NOW),
    get: async (procedure, input) => {
      if (procedure === "campaigns.getListOfCampaignsOptimized") return campaigns;
      if (procedure === "campaigns.getRecentReplies") return [];
      if (procedure === "campaigns.getMetricsForSequences") {
        return {
          same: { replies_count: 2, interested_replies: 1 },
          grew: { replies_count: 3, interested_replies: 2 },
          broken: { replies_count: 4, interested_replies: 1 },
        };
      }
      if (procedure === "campaigns.getCampaignInboxData") {
        reads.push(input.campaign_id);
        if (input.campaign_id === "broken") throw Object.assign(new Error("x"), { code: "PARAFORM_UPSTREAM" });
        return { campaign_emails: [], campaign_to_candidate_users: [] };
      }
      throw new Error(`unexpected ${procedure}`);
    },
  });
  // Rotation adds the longest-unread verified snapshot ("same").
  assert.deepEqual(reads.sort(), ["broken", "grew", "same"]);
  assert.equal(refresh.scan.mode, "changed");
  assert.deepEqual(refresh.scan.selection_reasons, { counts_changed: 2, rotation: 1 });
  const grew = refresh.snapshots.find((item) => item.sequence_id === "grew");
  assert.deepEqual(grew.reply_metrics, { replies_count: 3, interested_replies: 2 });
  assert.equal(refresh.verification.at, iso(NOW));
  assert.deepEqual(refresh.verification.unverified_sequence_ids, ["broken"]);

  const merged = mergeInboxRefreshState(previous, refresh);
  assert.equal(merged.meta.verified_at, iso(NOW));
  assert.deepEqual(merged.meta.unverified_sequence_ids, ["broken"]);
  assert.equal(merged.meta.last_run.mode, "changed");
  assert.equal(merged.meta.last_run.sequences_read, 3);
});

test("a stale-mode refresh keeps the last verdict and clears what it read", () => {
  const previous = stateWith(["a", "b"].map((id) => snapshot(id)), {
    verified_at: iso(NOW - 2 * HOUR),
    unverified_sequence_ids: ["a", "b"],
  });
  const merged = mergeInboxRefreshState(previous, {
    generated_at: iso(NOW),
    target_sequence_ids: ["a", "b"],
    selected_sequence_ids: ["a"],
    catalog: { version: 3, refreshed_at: iso(NOW), campaigns_total: 2, targets: ["a", "b"].map(campaign) },
    snapshots: [snapshot("a", { refreshedMs: NOW })],
    recent: null,
    scan: { failures: [] },
  });
  assert.equal(merged.meta.verified_at, iso(NOW - 2 * HOUR));
  assert.deepEqual(merged.meta.unverified_sequence_ids, ["b"]);
});

test("the Inbox counts a sequence stale only past the scheduled window", () => {
  const state = stateWith([
    snapshot("verified", { refreshedMs: NOW - 3 * 24 * HOUR }),
    snapshot("unverified", { refreshedMs: NOW - INBOX_SCHEDULED_STALE_MS - HOUR }),
    snapshot("recent-read", { refreshedMs: NOW - HOUR }),
  ], { verified_at: iso(NOW - 5 * HOUR), unverified_sequence_ids: ["unverified"] });
  state.catalog = {
    version: 3,
    refreshed_at: iso(NOW - 5 * HOUR),
    campaigns_total: 3,
    targets: ["verified", "unverified", "recent-read"].map((id) => ({ ...campaign(id), ui_admitted: true })),
  };
  const feed = assembleInboxSnapshotFeed(state, { now: () => new Date(NOW) });
  assert.equal(feed.freshness.campaigns_stale, 1);
  assert.equal(feed.freshness.campaigns_unverified, 1);
  assert.equal(feed.freshness.state, "degraded");

  const later = assembleInboxSnapshotFeed(state, {
    now: () => new Date(NOW - 5 * HOUR + INBOX_SCHEDULED_STALE_MS + HOUR),
  });
  assert.equal(later.freshness.campaigns_stale, 2);
  assert.ok(INBOX_SETTLE_MS < INBOX_SCHEDULED_STALE_MS);
});

function mockResponse() {
  return {
    body: null,
    headers: {},
    statusCode: 200,
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

function scheduledHandler(overrides = {}) {
  const calls = { builds: [], alerts: [], locks: 0, sleeps: 0 };
  const handler = createInboxSyncHandler({
    corsHandler: () => false,
    authHandler: async () => { throw new Error("a cron run must not need a Google session"); },
    cronCheck: () => ({ ok: true }),
    pauseState: async () => ({ paused: false, state: "absent" }),
    ensureSession: async () => {},
    acquireLock: async () => { calls.locks += 1; return { status: "acquired", token: "t" }; },
    readState: async () => ({ status: "ready", value: stateWith([]) }),
    buildRefresh: async (options) => { calls.builds.push(options); return { generated_at: iso(NOW), scan: {} }; },
    writeState: async () => ({}),
    assembleFeed: () => ({ freshness: { state: "ready", campaigns_stale: 0 } }),
    releaseLock: async () => true,
    alert: async (detail) => { calls.alerts.push(detail); return true; },
    sleepImpl: async () => { calls.sleeps += 1; },
    now: () => NOW,
    ...overrides,
  });
  return { handler, calls };
}

test("the cron GET needs the cron secret and runs the change-driven refresh", async () => {
  const denied = scheduledHandler({ cronCheck: () => ({ ok: false }) });
  const refused = mockResponse();
  await denied.handler({ method: "GET", headers: {} }, refused);
  assert.equal(refused.statusCode, 401);
  assert.equal(denied.calls.builds.length, 0);

  const { handler, calls } = scheduledHandler();
  const response = mockResponse();
  await handler({ method: "GET", headers: {} }, response);
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.trigger, "schedule");
  assert.equal(calls.builds[0].mode, "changed");
  assert.equal(calls.builds[0].batchSize, 150);
  assert.deepEqual(calls.alerts, []);
});

test("Refresh now (signed-in POST) runs the same change-driven refresh", async () => {
  const { handler, calls } = scheduledHandler({
    authHandler: async () => true,
    cronCheck: () => { throw new Error("a POST is never a cron run"); },
  });
  const response = mockResponse();
  await handler({ method: "POST", headers: { "content-type": "application/json" }, body: {} }, response);
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.trigger, "manual");
  assert.equal(calls.builds[0].mode, "changed");
});

test("a scheduled run waits for a busy lock instead of skipping its slot", async () => {
  const statuses = ["busy", "busy", "acquired"];
  const { handler, calls } = scheduledHandler({
    acquireLock: async () => ({ status: statuses.shift(), token: "t" }),
  });
  const response = mockResponse();
  await handler({ method: "GET", headers: {} }, response);
  assert.equal(response.statusCode, 200);
  assert.equal(calls.sleeps, 2);
  assert.equal(calls.builds.length, 1);
});

test("Slack is told only when a person must act", async () => {
  // One failed run shortly after a verified one: silent.
  const recentOk = scheduledHandler({
    readState: async () => ({ status: "ready", value: stateWith([], { verified_at: iso(NOW - 5 * HOUR) }) }),
    buildRefresh: async () => { throw Object.assign(new Error("x"), { code: "PARAFORM_THROTTLED" }); },
  });
  await recentOk.handler({ method: "GET", headers: {} }, mockResponse());
  assert.deepEqual(recentOk.calls.alerts, []);

  // Failing and unverified for 20+ hours: alert.
  const longFailing = scheduledHandler({
    readState: async () => ({ status: "ready", value: stateWith([], { verified_at: iso(NOW - 21 * HOUR) }) }),
    buildRefresh: async () => { throw Object.assign(new Error("x"), { code: "PARAFORM_THROTTLED" }); },
  });
  const failed = mockResponse();
  await longFailing.handler({ method: "GET", headers: {} }, failed);
  assert.equal(failed.statusCode, 502);
  assert.equal(longFailing.calls.alerts.length, 1);
  assert.match(longFailing.calls.alerts[0], /PARAFORM_THROTTLED/);

  // A successful run that still leaves sequences past the stale window: alert.
  const stuck = scheduledHandler({
    assembleFeed: () => ({ freshness: { state: "degraded", campaigns_stale: 4 } }),
  });
  await stuck.handler({ method: "GET", headers: {} }, mockResponse());
  assert.equal(stuck.calls.alerts.length, 1);

  // Refresh now never alerts, even when it fails.
  const manual = scheduledHandler({
    authHandler: async () => true,
    readState: async () => ({ status: "ready", value: stateWith([], { verified_at: iso(NOW - 40 * HOUR) }) }),
    buildRefresh: async () => { throw new Error("boom"); },
  });
  await manual.handler({ method: "POST", headers: { "content-type": "application/json" }, body: {} }, mockResponse());
  assert.deepEqual(manual.calls.alerts, []);
});
