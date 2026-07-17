import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";

const dashboardUrl = new URL("../index.html", import.meta.url);
const html = await readFile(dashboardUrl, "utf8");

function between(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  assert.notEqual(from, -1, `missing start marker: ${start}`);
  assert.notEqual(to, -1, `missing end marker: ${end}`);
  return source.slice(from + start.length, to);
}

function context(values = {}) {
  return vm.createContext({
    console,
    Date,
    JSON,
    Number,
    String,
    Object,
    Array,
    Map,
    Set,
    ...values,
  });
}

function backlogContext({
  historyDays = [],
  calls = [],
  upcoming = [],
  actionsMap = {},
  candidateRefs = {},
} = {}) {
  return context({
    historyDays,
    lastData: { calls, upcoming },
    actionsMap,
    humanResched: new Set(),
    ACTIONABLE: new Set(["no_show", "audio_fail", "error", "joined_silent", "incomplete"]),
    FU_SEVERITY: { error: 0, audio_fail: 1, joined_silent: 2, no_show: 3, incomplete: 4 },
    fuNorm: (value) => String(value || "").trim().toLowerCase().replace(/\s+/g, " "),
    fuAction: (row) => (
      actionsMap[row?.id]
      || actionsMap[row?.rowId]
      || actionsMap[row?.callId]
      || actionsMap[row?.botId]
      || null
    ),
    fuLedgerEntry: (row) => {
      for (const alias of [row?.id, row?.rowId, row?.callId, row?.botId]) {
        if (candidateRefs[alias]) return { candidateRef: candidateRefs[alias] };
      }
      return null;
    },
  });
}

function runBacklog(ctx) {
  vm.runInContext(`function buildBacklog(){${between(html, "    function buildBacklog(){", "    function renderFollowups(d){")}
globalThis.result = buildBacklog();`, ctx);
  return ctx.result;
}

test("persistent backlog merges history/live copies only through durable call aliases", () => {
  const ctx = backlogContext({
    historyDays: [{
      calls: [{
        id: "row-1",
        callId: "call-history",
        b: "bot-shared",
        e: "2026-07-17T15:05:00.000Z",
        t: "2026-07-17T15:00:00.000Z",
        c: "Ada Example",
        v: "no_show",
      }],
    }],
    calls: [{
      id: "call-live",
      callId: "call-live",
      rowId: "row-live",
      botId: "bot-shared",
      startedAt: "2026-07-17T15:00:00.000Z",
      endedAt: "2026-07-17T15:06:00.000Z",
      candidate: "Ada Example",
      verdict: "no_show",
    }],
  });

  const result = runBacklog(ctx);
  assert.equal(result.open.length, 1);
  assert.equal(result.open[0].id, "call-live");
  assert.equal(result.open[0].rowId, "row-live");
  assert.equal(result.open[0].callId, "call-live");
  assert.equal(result.open[0].botId, "bot-shared");
  assert.equal(result.open[0].endedAt, "2026-07-17T15:06:00.000Z");
});

test("repeat calls collapse to the latest candidate outcome and clear on rebooking", () => {
  const ctx = backlogContext({
    historyDays: [{
      calls: [
        { id: "row-a", b: "bot-a", t: "2026-07-17T15:00:00.000Z", c: "Same Name", v: "no_show" },
        { id: "row-b", b: "bot-b", t: "2026-07-17T16:00:00.000Z", c: "Same Name", v: "no_show" },
      ],
    }],
    upcoming: [{ candidate: "Same Name" }],
  });

  const result = runBacklog(ctx);
  assert.equal(result.open.length, 0);
  assert.equal(result.autoDone.length, 1);
  assert.equal(result.autoDone[0].id, "row-b");
});

test("a newer successful call clears an older no-show for the same exact candidate", () => {
  const result = runBacklog(backlogContext({
    historyDays: [{
      calls: [
        { id: "old", b: "bot-old", t: "2026-07-17T15:00:00.000Z", c: "Ada Example", v: "no_show" },
        { id: "new", b: "bot-new", t: "2026-07-17T16:00:00.000Z", c: "Ada Example", v: "success" },
      ],
    }],
    candidateRefs: { "bot-old": "person-ada", "bot-new": "person-ada" },
  }));
  assert.equal(result.open.length, 0);
  assert.equal(result.manualDone.length, 0);
  assert.equal(result.autoDone.length, 0);
});

test("exact candidate refs preserve true homonyms and reject name-only rebooking", () => {
  const result = runBacklog(backlogContext({
    historyDays: [{
      calls: [
        { id: "row-a", b: "bot-a", t: "2026-07-17T15:00:00.000Z", c: "Same Name", v: "no_show" },
        { id: "row-b", b: "bot-b", t: "2026-07-17T16:00:00.000Z", c: "Same Name", v: "no_show" },
      ],
    }],
    upcoming: [{ candidate: "Same Name" }],
    candidateRefs: { "bot-a": "person-one", "bot-b": "person-two" },
  }));
  assert.deepEqual(
    Array.from(result.open, (row) => row.id).sort(),
    ["row-a", "row-b"],
  );
  assert.equal(result.autoDone.length, 0);
});

test("manual actions follow durable aliases after history/live id changes", () => {
  const result = runBacklog(backlogContext({
    historyDays: [{
      calls: [{
        id: "row-old",
        b: "bot-one",
        t: "2026-07-17T15:00:00.000Z",
        c: "Ada Example",
        v: "no_show",
      }],
    }],
    calls: [{
      id: "row-new",
      rowId: "row-new",
      botId: "bot-one",
      startedAt: "2026-07-17T15:00:00.000Z",
      candidate: "Ada Example",
      verdict: "no_show",
    }],
    actionsMap: { "bot-one": { status: "resolved" } },
  }));
  assert.equal(result.open.length, 0);
  assert.equal(result.manualDone.length, 1);
});

function lifecycleContext({ fetchImpl } = {}) {
  const ctx = context({
    lastData: null,
    renderFollowups() {},
    fetch: fetchImpl || (async () => {
      throw new Error("not used");
    }),
    fuNorm: (value) => String(value || "").trim().toLowerCase().replace(/\s+/g, " "),
    esc: String,
    cdEsc: String,
  });
  vm.runInContext(`${between(
    html,
    "    /* BEGIN:LIFECYCLE-FOLLOWUP-STATE */",
    "    /* END:LIFECYCLE-FOLLOWUP-STATE */",
  )}
globalThis.setLedger = (value, ageMs=0) => {
  fuLedger = value;
  fuLedgerFetchedAt = value ? Date.now()-ageMs : 0;
};
globalThis.refreshLedger = ensureLedger;
globalThis.staleMs = FU_LEDGER_STALE_MS;
globalThis.reason = fuReason;
globalThis.entry = fuLedgerEntry;
globalThis.pending = fuIsAutomationPending;`, ctx);
  return ctx;
}

test("ledger joins exact aliases and uses byName only for a legacy name-only payload", () => {
  const ctx = lifecycleContext();
  const row = {
    id: "call-1",
    rowId: "row-1",
    botId: "bot-1",
    candidate: "Same Name",
    verdict: "no_show",
    endedAt: new Date(Date.now() - 3 * 60 * 60_000).toISOString(),
  };

  ctx.setLedger({
    byCall: { "bot-1": { stage: "failed_no_email" } },
    byKey: { "row-1": { stage: "failed_error" } },
    byName: { "same name": { stage: "enrolled", deliveryReady: true } },
  });
  assert.equal(ctx.reason(row).label, "needs email");

  ctx.setLedger({
    byCall: {},
    byKey: { "row-1": { stage: "failed_error" } },
    byName: { "same name": { stage: "enrolled", deliveryReady: true } },
  });
  assert.equal(ctx.reason(row).label, "recovery failed");

  ctx.setLedger({
    byCall: {},
    byKey: {},
    byName: { "same name": { stage: "enrolled", deliveryReady: true } },
  });
  assert.equal(ctx.entry(row), null, "same-name fallback must not run when exact maps exist");
  assert.equal(ctx.reason(row).label, "not auto-evaluated");

  ctx.setLedger({
    byName: {
      "same name": {
        stage: "enrolled",
        sequenceName: "Legacy",
        deliveryReady: true,
      },
    },
  });
  assert.equal(ctx.reason(row).label, "verification pending", "name-only legacy joins can never render green");
});

test("only delivery-ready enrolled states render green", () => {
  const ctx = lifecycleContext();
  const row = {
    id: "call-1",
    candidate: "Ada Example",
    verdict: "no_show",
    endedAt: new Date(Date.now() - 3 * 60 * 60_000).toISOString(),
  };

  for (const stage of ["enrolled", "manual_enrolled"]) {
    ctx.setLedger({ byCall: { "call-1": { stage, deliveryReady: false } }, byKey: {} });
    assert.equal(ctx.reason(row).label, "verification pending", stage);

    ctx.setLedger({ byCall: { "call-1": { stage, deliveryReady: true } }, byKey: {} });
    assert.equal(ctx.reason(row).label, "✓ in sequence", stage);
  }
});

test("visible-tab refresh can move pending to green, then fail closed on lost delivery or reply", async () => {
  const payloads = [
    { ok: true, byCall: { "call-1": { stage: "observed" } }, byKey: {} },
    { ok: true, byCall: { "call-1": { stage: "enrolled", deliveryReady: true } }, byKey: {} },
    { ok: true, byCall: { "call-1": { stage: "delivery_lost" } }, byKey: {} },
    { ok: true, byCall: { "call-1": { stage: "stopped_replied" } }, byKey: {} },
  ];
  let reads = 0;
  const ctx = lifecycleContext({
    fetchImpl: async () => ({ json: async () => payloads[reads++] }),
  });
  const row = {
    id: "call-1",
    candidate: "Ada Example",
    verdict: "no_show",
    endedAt: new Date(Date.now() - 3 * 60 * 60_000).toISOString(),
  };

  await ctx.refreshLedger(true);
  assert.equal(ctx.reason(row).label, "automation pending");
  await ctx.refreshLedger(true);
  assert.equal(ctx.reason(row).label, "✓ in sequence");
  await ctx.refreshLedger(true);
  assert.equal(ctx.reason(row).label, "delivery lost");
  await ctx.refreshLedger(true);
  assert.equal(ctx.reason(row).label, "stopped: replied");
  assert.equal(reads, 4);
});

test("stale lifecycle data expires instead of leaving a last-good row green", () => {
  const ctx = lifecycleContext();
  const row = {
    id: "call-1",
    candidate: "Ada Example",
    verdict: "no_show",
    endedAt: new Date(Date.now() - 3 * 60 * 60_000).toISOString(),
  };
  ctx.setLedger({
    byCall: { "call-1": { stage: "enrolled", deliveryReady: true } },
    byKey: {},
  }, ctx.staleMs + 1);
  assert.equal(ctx.reason(row).label, "status refresh delayed");
});

test("follow-up stages explain pending, identity, email, verification, and expired states", () => {
  const ctx = lifecycleContext();
  const row = {
    id: "call-1",
    candidate: "Ada Example",
    verdict: "no_show",
    endedAt: new Date(Date.now() - 3 * 60 * 60_000).toISOString(),
  };
  const labels = {
    observed: "automation pending",
    failed_identity: "needs recovery: identity",
    failed_ambiguous_identity: "needs recovery: identity",
    failed_no_email: "needs email",
    enrolled_missing_email: "needs email",
    failed_booking_evidence: "booking check retrying",
    failed_error: "recovery failed",
    enrolled_unverified: "verification pending",
    enrolling: "verification pending",
    expired_window: "recovery required",
    paused_oracle_block: "pulled from sequence",
    stopped_replied: "stopped: replied",
    delivery_lost: "delivery lost",
    skipped_cooldown: "blocked: cooldown",
    skipped_internal: "blocked: internal",
    skipped_cancelled: "blocked: cancelled",
  };

  for (const [stage, expected] of Object.entries(labels)) {
    ctx.setLedger({ byCall: { "call-1": { stage } }, byKey: {} });
    assert.equal(ctx.reason(row).label, expected, stage);
  }
});

test("recent exact calls without a ledger decision remain automation pending", () => {
  const ctx = lifecycleContext();
  ctx.setLedger({ byCall: {}, byKey: {}, byName: {} });
  const recent = {
    id: "recent",
    candidate: "Recent Example",
    verdict: "no_show",
    endedAt: new Date(Date.now() - 60 * 60_000).toISOString(),
  };
  const old = {
    ...recent,
    id: "old",
    endedAt: new Date(Date.now() - 3 * 60 * 60_000).toISOString(),
  };

  assert.equal(ctx.reason(recent).label, "automation pending");
  assert.equal(ctx.reason(old).label, "not auto-evaluated");
});

test("dashboard exposes no lifecycle enrollment or force control", () => {
  for (const forbidden of [
    "/api/enroll",
    "Add to sequence",
    "Add anyway",
    "fuAddConfirm",
    "fuAddControl",
    "fu-anyway",
    "body.force",
  ]) {
    assert.equal(html.includes(forbidden), false, forbidden);
  }
  assert.match(html, /Automatic recovery owns sequence enrollment/);
});

test("canonical and deployed-shell lifecycle state blocks are identical", async (t) => {
  const candidates = [
    process.env.RAYDAR_CANONICAL_DASHBOARD,
    new URL("../../Raydar-no-show-recovery/webview/dashboard.html", import.meta.url),
    new URL("../../Raydar/webview/dashboard.html", import.meta.url),
  ].filter(Boolean);

  let canonical;
  for (const candidate of candidates) {
    try {
      canonical = await readFile(candidate, "utf8");
      break;
    } catch {
      // Try the next local checkout. CI for the standalone shell may not have one.
    }
  }
  if (!canonical) {
    t.skip("canonical Raydar checkout is not available");
    return;
  }

  const start = "    /* BEGIN:LIFECYCLE-FOLLOWUP-STATE */";
  const end = "    /* END:LIFECYCLE-FOLLOWUP-STATE */";
  assert.equal(between(html, start, end), between(canonical, start, end));
});
