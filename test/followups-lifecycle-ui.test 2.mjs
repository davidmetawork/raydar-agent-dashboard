import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";

const html = await readFile(new URL("../index.html", import.meta.url), "utf8");

function between(start, end) {
  const from = html.indexOf(start);
  const to = html.indexOf(end, from);
  assert.notEqual(from, -1, `missing start marker: ${start}`);
  assert.notEqual(to, -1, `missing end marker: ${end}`);
  return html.slice(from, to);
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

test("persistent backlog keeps exact call aliases and end time when live data wins", () => {
  const ctx = context({
    historyDays: [{
      calls: [{
        id: "row-1",
        callId: "call-history",
        b: "bot-history",
        e: "2026-07-17T15:05:00.000Z",
        t: "2026-07-17T15:00:00.000Z",
        c: "Ada Example",
        v: "no_show",
      }],
    }],
    lastData: {
      calls: [{
        id: "row-1",
        callId: "call-live",
        rowId: "row-live",
        botId: "bot-live",
        startedAt: "2026-07-17T15:00:00.000Z",
        endedAt: "2026-07-17T15:06:00.000Z",
        candidate: "Ada Example",
        verdict: "no_show",
      }],
      upcoming: [],
    },
    actionsMap: {},
    humanResched: new Set(),
    ACTIONABLE: new Set(["no_show"]),
    FU_SEVERITY: { no_show: 3 },
    fuNorm: (value) => String(value || "").trim().toLowerCase().replace(/\s+/g, " "),
  });
  vm.runInContext(`${between("function buildBacklog(){", "function renderFollowups(d){")}
globalThis.result = buildBacklog();`, ctx);

  assert.equal(ctx.result.open.length, 1);
  assert.equal(ctx.result.open[0].id, "row-1");
  assert.equal(ctx.result.open[0].rowId, "row-live");
  assert.equal(ctx.result.open[0].callId, "call-live");
  assert.equal(ctx.result.open[0].botId, "bot-live");
  assert.equal(ctx.result.open[0].endedAt, "2026-07-17T15:06:00.000Z");
});

function lifecycleContext() {
  const ctx = context({
    lastData: null,
    renderFollowups() {},
    fetch: async () => {
      throw new Error("not used");
    },
    LIFECYCLE_API: "https://example.test",
    FU_SEQ_TARGET: { no_show: "No Show - Agent Call" },
    fuSeqShort: (value) => value,
    fuNorm: (value) => String(value || "").trim().toLowerCase().replace(/\s+/g, " "),
    actionsMap: {},
    esc: String,
    cdEsc: String,
    paraformQ: () => "https://example.test/profile",
  });
  vm.runInContext(`${between("const FU_PENDING_MS", "function fuAddClick(id){")}
globalThis.setLedger = (value) => { fuLedger = value; };
globalThis.reason = fuReason;
globalThis.addControl = fuAddControl;
globalThis.entry = fuLedgerEntry;
globalThis.pending = fuIsAutomationPending;`, ctx);
  return ctx;
}

test("ledger joins prefer exact byCall/byKey aliases before legacy name fallback", () => {
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
    byName: { "same name": { stage: "enrolled" } },
  });
  assert.equal(ctx.reason(row).label, "needs email");

  ctx.setLedger({
    byCall: {},
    byKey: { "row-1": { stage: "failed_error" } },
    byName: { "same name": { stage: "enrolled" } },
  });
  assert.equal(ctx.reason(row).label, "recovery failed");

  ctx.setLedger({
    byCall: {},
    byKey: {},
    byName: { "same name": { stage: "enrolled", sequenceName: "Legacy" } },
  });
  assert.equal(ctx.reason(row).label, "✓ in sequence");
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
    failed_error: "recovery failed",
    enrolled_unverified: "verifying enrollment",
    enrolling: "verifying enrollment",
    expired_window: "recovery required",
  };

  for (const [stage, expected] of Object.entries(labels)) {
    ctx.setLedger({ byCall: { "call-1": { stage } }, byKey: {}, byName: {} });
    assert.equal(ctx.reason(row).label, expected, stage);
  }
});

test("recent unledgered calls stay pending without a premature Add button", () => {
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
  assert.equal(ctx.addControl(recent), "");
  assert.match(ctx.addControl(old), /Add to sequence/);

  for (const stage of ["failed_identity", "failed_ambiguous_identity", "failed_no_email", "failed_error", "expired_window"]) {
    ctx.setLedger({ byCall: { old: { stage } }, byKey: {}, byName: {} });
    assert.match(ctx.addControl(old), /Add to sequence/, stage);
  }

  for (const stage of ["observed", "enrolling", "enrolled_unverified", "enrolled_missing_email", "enrolled"]) {
    ctx.setLedger({ byCall: { old: { stage } }, byKey: {}, byName: {} });
    assert.equal(ctx.addControl(old), "", stage);
  }
});

async function enrollmentContext(response) {
  const actions = [];
  const requests = [];
  const ctx = context({
    LIFECYCLE_API: "https://example.test",
    FU_SEQ_TARGET: { no_show: "No Show - Agent Call" },
    fuAddInfo: {
      "call-1": {
        candidate: "Ada Example",
        verdict: "no_show",
        botId: "bot-1",
        rowId: "row-1",
      },
    },
    fuAddState: {},
    fuLedger: { byCall: {}, byKey: {}, byName: {} },
    fuNorm: (value) => String(value || "").trim().toLowerCase(),
    lastData: null,
    renderFollowups() {},
    setAction(id, status) {
      actions.push({ id, status });
    },
    clearTimeout() {},
    fetch: async (url, init) => {
      requests.push({ url, body: JSON.parse(init.body) });
      return {
        ok: response.httpOk,
        status: response.status,
        json: async () => response.body,
      };
    },
  });
  vm.runInContext(`${between("function fuEvidence(j){", "let paraaiLoaded=")}
globalThis.confirmAdd = fuAddConfirm;
globalThis.mapError = fuEnrollError;`, ctx);
  await ctx.confirmAdd("call-1");
  return { ctx, actions, requests };
}

test("manual enrollment marks Sequence sent only after explicit delivery readback", async () => {
  const uncertain = await enrollmentContext({
    httpOk: true,
    status: 200,
    body: {
      ok: true,
      deliveryReady: false,
      error: "lead_email_unverified",
      detail: "Membership exists, but the email did not read back.",
    },
  });
  assert.deepEqual(uncertain.actions, []);
  assert.equal(uncertain.ctx.fuAddState["call-1"].step, "reconciling");
  assert.equal(uncertain.requests[0].body.rowId, "row-1");
  assert.equal(uncertain.requests[0].body.botId, "bot-1");

  const verified = await enrollmentContext({
    httpOk: true,
    status: 200,
    body: {
      ok: true,
      deliveryReady: true,
      sequenceName: "No Show - Agent Call",
    },
  });
  assert.deepEqual(verified.actions, [{ id: "call-1", status: "sequence_sent" }]);
  assert.equal(verified.ctx.fuAddState["call-1"].step, "added");
  assert.equal(verified.ctx.fuLedger.byCall["bot-1"].deliveryReady, true);
  assert.equal(verified.ctx.fuLedger.byCall["row-1"].deliveryReady, true);
});

test("strict identity and email API failures remain specific in the UI", async () => {
  const identity = await enrollmentContext({
    httpOk: false,
    status: 422,
    body: { ok: false, error: "exact_identity_not_found" },
  });
  assert.equal(identity.ctx.fuAddState["call-1"].step, "identity");
  assert.match(identity.ctx.fuAddState["call-1"].detail, /Exact Paraform identity/);

  const email = await enrollmentContext({
    httpOk: false,
    status: 422,
    body: { ok: false, error: "missing_email" },
  });
  assert.equal(email.ctx.fuAddState["call-1"].step, "needs_email");
  assert.match(email.ctx.fuAddState["call-1"].detail, /no verified email/);

  const unavailable = await enrollmentContext({
    httpOk: false,
    status: 409,
    body: {
      ok: false,
      error: "target_sequence_unavailable",
      detail: "The target sequence is disabled.",
    },
  });
  assert.equal(unavailable.ctx.fuAddState["call-1"].step, "failed");
  assert.match(unavailable.ctx.fuAddState["call-1"].detail, /disabled/);

  const oracle = await enrollmentContext({
    httpOk: false,
    status: 409,
    body: {
      ok: false,
      error: "oracle_block",
      evidence: "Candidate already rebooked.",
    },
  });
  assert.equal(oracle.ctx.fuAddState["call-1"].step, "blocked");
  assert.match(oracle.ctx.fuAddState["call-1"].evidence, /rebooked/);
});
