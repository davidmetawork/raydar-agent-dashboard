// Status v2's contracts — one test row per honesty rule in the PRD's §6 table
// (R1-R20). These are David's rulings turned into assertions:
//
//   the page never derives a number, never fakes a zero, never shows green on
//   no signal, never claims "down" on one witness, never hard-codes an
//   applicant label, and never puts a raw id on the surface.
//
// Run with `node --test test/*.test.mjs` (the glob — a bare directory path
// fakes a MODULE_NOT_FOUND that reads as a broken suite).
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  SYSTEMS, STATE_WORDS, STATE_TONE, STATE_RANK, worstState, reviewStateCopy,
  REVIEW_STATE_SENTENCES, SOURCES, TODO_RULES, FOOTER,
} from "../api/status-v2/_lib/systems.mjs";
import handler, {
  buildState, flowFor, resolvePath, resolveList, postCallStateFrom, applicantStateFrom,
  allTimeStrip, applicantsTabStrip, diffEvents, snapshotFor, clearingSentence,
  humanAge, pacificClock, whenSentence, HEALTH_URL, PIPELINE_KEY, WATCHDOG_LANE_ID,
  config as routeConfig,
} from "../api/status-v2/state.mjs";

const page = await readFile(new URL("../status-v2.html", import.meta.url), "utf8");
const catalogSrc = await readFile(new URL("../api/status-v2/_lib/systems.mjs", import.meta.url), "utf8");
const stateSrc = await readFile(new URL("../api/status-v2/state.mjs", import.meta.url), "utf8");
const indexHtml = await readFile(new URL("../index.html", import.meta.url), "utf8");
const vercel = JSON.parse(await readFile(new URL("../vercel.json", import.meta.url), "utf8"));

const NOW = Date.parse("2026-09-03T19:36:00.000Z");
const iso = (msAgo) => new Date(NOW - msAgo).toISOString();

// ── fixtures ────────────────────────────────────────────────────────────────
const healthLive = () => ({
  ok: true,
  service: "post-call",
  mode: "live",
  database: true,
  autonomy: {
    activeEpoch: { id: "187295b8-63cd-416d-98a3-ec6e686b51cb", boundaryAt: iso(45 * 60e3), state: "active" },
    tick: { lastStartedAt: iso(40e3), lastFinishedAt: iso(38e3), outcome: "ok" },
    overdueCount: 0,
    incompleteSourceRuns: 0,
    sourceCoverage: { ready: true, missing: [], sources: [] },
  },
  transport: { requestedWidth: 1, processWidth: 1 },
  activationReady: true,
});
const healthDegraded = () => {
  const h = healthLive();
  h.autonomy.tick.outcome = "source_degraded";
  return h;
};

// The wireframe example from PRD §4.1, which reconciles on purpose.
const funnelWireframe = () => ({
  generatedAt: iso(20e3),
  window: { since: iso(9 * 3600e3), timezone: "America/Los_Angeles" },
  callsSeen: 14,
  noEmailOwed: 3,
  confirmed: 11,
  personConfirmed: 9,
  rolesMatched: 9,
  waitingToSend: 1,
  accepted: 8,
  delivered: 7,
  openToday: 2,
  byState: [
    { code: "review_identity", label: "which person is this", count: 1 },
    { code: "review_profile", label: "profile missing", count: 1 },
  ],
  unaccounted: 0,
});

const metricsFixture = () => ({
  open: 12, overdue: 2, identityProfile: 5, missingInformation: 3,
  matchingCalibration: 2, delivery: 2, continuing: 1, failed: 0, resolvedToday: 4,
  medianResolutionSeconds: 2460, p90ResolutionSeconds: 20000, p95ResolutionSeconds: 39600,
  incidents: [],
});

// The v3 vocabulary the Applicants tab is moving to. The page must render it
// unchanged, and must not contain any of these words in its own source.
const TARGET_HOLDS = [
  { code: "identity_review", label: "Identity review", count: 41 },
  { code: "recipient_review", label: "Recipient review", count: 12 },
  { code: "delivery_review", label: "Delivery review", count: 106 },
];
const pipelineFixture = (over = {}) => ({
  generatedAt: iso(90e3),
  window: { days: 7, since: iso(7 * 24 * 3600e3) },
  captured: 120, identified: 96, readyToDecide: 40, holdsTotal: 159,
  holdsByReason: TARGET_HOLDS,
  passed: 18, invited: 7, postDecisionHolds: 3, unaccounted: 0,
  laneEnabled: false, stopReason: null,
  ...over,
});

const countsDoc = (over = {}) => ({ updatedAt: iso(120e3), queue: 203, stream: 88, alert: null, ...over });

function fakeKv(initial = {}) {
  const store = new Map(Object.entries(initial));
  const writes = [];
  return {
    store, writes,
    vGet: async (key) => (store.has(key) ? store.get(key) : null),
    vSet: async (key, value) => { store.set(key, value); writes.push(key); return true; },
  };
}
const fakeApphub = ({ counts = null, pipeline = null } = {}) => ({
  getJson: async (key) => (key === "apphub:counts" ? counts : key === PIPELINE_KEY ? pipeline : null),
});
function fakeFetch(handlerFn) {
  const calls = [];
  const fn = async (url, init) => { calls.push(String(url)); return handlerFn(String(url), init); };
  fn.calls = calls;
  return fn;
}
const jsonRes = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
function fakeUpstream(byPath) {
  const calls = [];
  const fn = async (path, access, binding, init, opts) => {
    calls.push({ path, actor: access?.email, fetchImpl: opts?.fetchImpl });
    const entry = byPath[path];
    if (!entry) return { response: { ok: false, status: 404 }, body: {} };
    if (entry instanceof Error) throw entry;
    return { response: { ok: entry.status < 400, status: entry.status }, body: entry.body };
  };
  fn.calls = calls;
  return fn;
}
async function build(over = {}) {
  return buildState({
    nowMs: NOW,
    actorEmail: "david@raydar.xyz",
    postCallReady: true,
    fetchImpl: fakeFetch(() => jsonRes(200, healthLive())),
    kv: fakeKv(),
    apphub: fakeApphub(),
    upstreamImpl: fakeUpstream({
      "/api/v2/reviews/metrics": { status: 200, body: { ok: true, metrics: metricsFixture() } },
      "/api/v2/reviews/funnel": { status: 404, body: {} },
    }),
    healthCatalog: new Map(),
    ...over,
  });
}
const systemOf = (state, id) => state.systems.find((s) => s.id === id);
const nodeOf = (system, nodeId) => system.flow.stages.find((s) => s.id === nodeId);

// ── the catalog itself ──────────────────────────────────────────────────────

test("catalog: two systems, five state words, one drawable flow each", () => {
  assert.equal(SYSTEMS.length, 2);
  assert.deepEqual(SYSTEMS.map((s) => s.id), ["post-call", "applicant"]);
  assert.equal(new Set(SYSTEMS.map((s) => s.id)).size, 2);
  assert.deepEqual(Object.values(STATE_WORDS),
    ["Sending", "Paused", "Not sending yet", "Not running", "Cannot tell"]);
  for (const row of SYSTEMS) {
    const ids = row.flow.stages.map((s) => s.id);
    assert.equal(new Set(ids).size, ids.length, `${row.id}: duplicate stage id`);
    for (const [a, b] of row.flow.edges) {
      assert.ok(ids.includes(a) && ids.includes(b), `${row.id}: edge ${a}->${b} has no such stage`);
    }
  }
});

// ── R1: never subtract two differently-scoped populations ───────────────────

test("R1 the page never derives a count: every drawn number is one published field", () => {
  for (const row of SYSTEMS) {
    for (const st of row.flow.stages) {
      const keys = Object.keys(st).filter((k) => k.endsWith("Key"));
      for (const key of keys) {
        assert.equal(typeof st[key], "string", `${row.id}.${st.id}: ${key} must be one dotted path`);
        assert.ok(!/[-+*/]/.test(st[key]), `${row.id}.${st.id}: ${key} looks like arithmetic`);
      }
    }
  }
  // and no subtraction of two resolved paths anywhere in the aggregator
  assert.doesNotMatch(stateSrc, /resolvePath\([^)]*\)\s*-\s*resolvePath\(/);
});

test("R1 a negative published count is unusable: it draws a dash, never negative people", () => {
  const negative = flowFor(SYSTEMS[0], {
    funnel: {
      ...funnelWireframe(),
      callsSeen: -3, delivered: -1, openToday: -2,
      byState: [{ code: "review_identity", label: "which person is this", count: -4 }],
    },
  }, { nowMs: NOW });
  for (const stage of negative.flow.stages) {
    assert.ok(stage.count == null || stage.count >= 0, `${stage.id} rendered a negative count`);
    for (const tile of stage.tiles || []) assert.ok(tile.count >= 0, `${stage.id} tiled a negative count`);
  }
  assert.equal(nodeOf({ flow: negative.flow }, "calls").count, null);
  assert.equal(nodeOf({ flow: negative.flow }, "waiting-person").tiles.length, 0);
  const ids = negative.unusable.map((u) => u.id);
  assert.ok(ids.includes("calls") && ids.includes("delivered") && ids.includes("waiting-person"));
  assert.ok(ids.includes("waiting-person:review_identity"));
  // nothing unusable is quietly filed as "no publisher yet" instead
  assert.ok(!negative.pending.some((p) => p.id === "calls"));
  // and the evidence drawer says why the dash is there
  const row = negative.evidence.find((e) => e.field === "funnel.callsSeen");
  assert.equal(row.value, null);
  assert.match(row.step, /negative number/);
  const bucket = negative.evidence.find((e) => e.field === "funnel.byState[review_identity]");
  assert.equal(bucket.value, null);
  assert.match(bucket.step, /negative number/);
  // the strips apply the same rule to their own fields
  assert.equal(allTimeStrip({ metrics: { ...metricsFixture(), open: -5 }, memo: { dataAt: iso(8e3) }, nowMs: NOW }).items[0].value, null);
  assert.equal(applicantsTabStrip({ counts: countsDoc({ queue: -5 }), nowMs: NOW }).items[0].value, null);
  // and the page explains the dash rather than leaving it bare
  assert.match(page, /negative number, which cannot be a number of people/);
});

test("R1 the wireframe example and the live render both reconcile, with no negative box", () => {
  const f = funnelWireframe();
  assert.equal(f.callsSeen, f.noEmailOwed + f.confirmed);
  assert.equal(f.confirmed, f.openToday + f.personConfirmed);
  assert.equal(f.rolesMatched, f.waitingToSend + f.accepted);
  assert.ok(f.accepted >= f.delivered, "sent can never be fewer than delivered");
  assert.equal(f.openToday, f.byState.reduce((a, e) => a + e.count, 0));
  const resolved = flowFor(SYSTEMS[0], { funnel: f, metrics: metricsFixture() }, { nowMs: NOW });
  for (const stage of resolved.flow.stages) {
    assert.ok(stage.count == null || stage.count >= 0, `${stage.id} rendered a negative count`);
    for (const tile of stage.tiles || []) assert.ok(tile.count >= 0);
  }
  assert.equal(nodeOf({ flow: resolved.flow }, "calls").count, 14);
  assert.equal(nodeOf({ flow: resolved.flow }, "waiting-person").count, 2);
});

// ── R2: one clock per row ───────────────────────────────────────────────────

test("R2 one clock per row: drawn nodes read only their own window, strips are labelled", () => {
  const prefix = { "post-call": "funnel.", applicant: "pipeline." };
  for (const row of SYSTEMS) {
    for (const st of row.flow.stages) {
      for (const key of ["countKey", "poolKey"]) {
        if (!st[key]) continue;
        assert.ok(st[key].startsWith(prefix[row.id]),
          `${row.id}.${st.id}: ${key} "${st[key]}" reads another clock`);
      }
    }
    assert.ok(row.clockLabel && row.clockLabel.trim(), `${row.id}: no clock label`);
  }
  const strip = allTimeStrip({ metrics: metricsFixture(), memo: { dataAt: iso(8e3) }, nowMs: NOW });
  assert.match(strip.label, /All time/);
  assert.match(strip.clock, /from the Review data/);
  const tab = applicantsTabStrip({ counts: countsDoc(), nowMs: NOW });
  assert.match(tab.clock, /from the tab's own feed/);
});

// ── R3: people units, and time as a sentence ────────────────────────────────

test("R3 every box counts people unless it declares a unit; time renders as a sentence", () => {
  for (const row of SYSTEMS) {
    for (const st of row.flow.stages) {
      if (st.unit) assert.notEqual(st.unit, "people");
      else assert.ok(!/second|minute|hour|day/i.test(st.label), `${row.id}.${st.id} looks like time`);
    }
  }
  const sentence = clearingSentence(2460, 39600);
  assert.equal(sentence, "half are cleared within 41m, the slowest 1 in 20 takes 11h");
  assert.doesNotMatch(sentence, /[[\]]/);
  assert.equal(clearingSentence(null, null), null);
});

// ── R4: one bucket per real reason, capped at six plus Other ────────────────

test("R4 pool tiles come only from {code,label,count}, cap six plus Other, no vague pool", () => {
  const many = Array.from({ length: 9 }, (_, i) => ({ code: `code_${i}`, label: `Reason ${i}`, count: 10 - i }));
  const resolved = flowFor(SYSTEMS[1], { pipeline: pipelineFixture({ holdsByReason: many, holdsTotal: 54 }) }, { nowMs: NOW });
  const pool = resolved.flow.stages.find((s) => s.id === "waiting-you");
  assert.equal(pool.tiles.length, 7);
  assert.equal(pool.tiles[6].label, "Other (3)");
  assert.equal(pool.tiles[6].count, 4 + 3 + 2);
  assert.deepEqual(pool.tiles.slice(0, 6).map((t) => t.label),
    ["Reason 0", "Reason 1", "Reason 2", "Reason 3", "Reason 4", "Reason 5"]);
  for (const row of SYSTEMS) {
    for (const st of row.flow.stages) {
      assert.doesNotMatch(st.label, /in review|in progress|other stuff/i, `${row.id}.${st.id}: vague pool`);
    }
  }
});

// ── R5: never a fake zero ───────────────────────────────────────────────────

test("R5 null, empty and wrong-typed payloads resolve to null and never throw", () => {
  const shapes = [
    {}, null, undefined, { funnel: null }, { funnel: [] }, { funnel: "nope" },
    { funnel: { callsSeen: "abc", byState: {} } },
    { funnel: { callsSeen: [], byState: [{ code: 1, label: 2, count: "x" }] } },
    // booleans are not numbers: Number(false) is 0, and a "0" in a box that
    // nobody published is the fake zero R5 exists to forbid.
    { funnel: { callsSeen: false, confirmed: true, byState: [{ code: "x", count: true }] } },
    { pipeline: { captured: false, identified: true, holdsTotal: false } },
    { pipeline: { holdsByReason: "not-a-list", captured: {} } },
    { pipeline: [] },
  ];
  for (const row of SYSTEMS) {
    for (const ctx of shapes) {
      const resolved = flowFor(row, ctx, { nowMs: NOW });
      for (const stage of resolved.flow.stages) {
        assert.ok(stage.count == null || Number.isFinite(stage.count));
        assert.notEqual(stage.count, 0, `${row.id}.${stage.id}: missing data became a zero`);
      }
    }
  }
  assert.equal(resolvePath(null, "a.b"), null);
  assert.equal(resolvePath({ a: { b: false } }, "a.b"), null, "false is not a published zero");
  assert.equal(resolvePath({ a: { b: true } }, "a.b"), null, "true is not a published one");
  assert.equal(resolvePath({ a: { b: 0 } }, "a.b"), 0, "a real zero survives");
  assert.equal(resolvePath({ a: { b: "12" } }, "a.b"), 12);
  const booleanPool = flowFor(SYSTEMS[0], {
    funnel: { callsSeen: false, confirmed: true, byState: [{ code: "review_identity", count: false }] },
  }, { nowMs: NOW });
  const boolPool = booleanPool.flow.stages.find((s) => s.id === "waiting-person");
  assert.deepEqual(boolPool.tiles, [], "a boolean bucket count became a tile");
  assert.equal(resolvePath({ a: { b: "" } }, "a.b"), null);
  assert.equal(resolveList({ a: { b: {} } }, "a.b"), null);
});

test("R5 a resolved zero is still a zero: an honest zero is not a dash", () => {
  const resolved = flowFor(SYSTEMS[0], { funnel: { ...funnelWireframe(), noEmailOwed: 0 } }, { nowMs: NOW });
  assert.equal(resolved.flow.stages.find((s) => s.id === "no-email").count, 0);
});

// ── R6: never false green ───────────────────────────────────────────────────

test("R6 a 500 from the live check renders Cannot tell, never green, never 'down'", async () => {
  const state = await build({
    fetchImpl: fakeFetch(() => jsonRes(500, { error: "boom" })),
  });
  const postCall = systemOf(state, "post-call");
  assert.equal(postCall.state.word, STATE_WORDS["cannot-tell"]);
  assert.equal(postCall.state.tone, "violet");
  assert.match(postCall.state.caption, /did not answer/);
  assert.match(postCall.state.caption, /not a claim that it is down/);
  assert.equal(postCall.incident, null, "one failed read is not yet an incident");
});

test("R6 a stale applicant publish never renders green", () => {
  const stale = applicantStateFrom({
    pipeline: pipelineFixture({ generatedAt: iso(4 * 3600e3 + 12 * 60e3), laneEnabled: true }),
    counts: countsDoc(), nowMs: NOW,
  });
  assert.notEqual(stale.stateId, "sending");
  assert.equal(stale.stateId, "cannot-tell");
});

test("R6 a future-dated publish is never fresh, on either clock", () => {
  const ahead = applicantStateFrom({
    pipeline: pipelineFixture({ generatedAt: iso(-3 * 3600e3), laneEnabled: true }),
    counts: countsDoc(), nowMs: NOW,
  });
  assert.notEqual(ahead.stateId, "sending");
  assert.equal(ahead.stateId, "cannot-tell");
  assert.equal(ahead.reason, "clock-skew");
  assert.match(ahead.caption, /3h in the future/);
  assert.doesNotMatch(ahead.caption, /0s/);

  const health = healthLive();
  health.autonomy.tick.lastFinishedAt = iso(-30 * 60e3);
  const tick = postCallStateFrom({
    health: { outcome: { at: iso(3e3), ok: true, status: 200 }, reads: [{ ok: true }], data: health, dataAt: iso(3e3) },
    nowMs: NOW,
  });
  assert.equal(tick.pulse, false, "a future tick pulsed green");
  assert.match(tick.caption, /stamped 30m in the future/);
});

// ── R7: plain words only, from one constant ─────────────────────────────────

test("R7 the five words are the only state vocabulary, and nothing borrows jargon", () => {
  assert.equal(Object.keys(STATE_WORDS).length, 5);
  for (const id of Object.keys(STATE_WORDS)) {
    assert.ok(STATE_TONE[id], `${id}: no tone`);
    assert.ok(Number.isInteger(STATE_RANK[id]), `${id}: no worst-of rank`);
    assert.doesNotMatch(STATE_WORDS[id], /\band\b|\/|,/, `${id}: compound state word`);
  }
  for (const src of [page, catalogSrc, stateSrc]) {
    assert.doesNotMatch(src, /\barmed\b/i);
    assert.doesNotMatch(src, /\bdark\b/i);
    assert.doesNotMatch(src, /\bqueued\b/i);
    assert.doesNotMatch(src, /\bRead-only\b/);
    assert.doesNotMatch(src, /"Running"|'Running'|>Running</);
  }
  // the page renders the word it is handed; it never hard-codes one
  for (const word of Object.values(STATE_WORDS)) {
    assert.ok(!page.includes(`"${word}"`) && !page.includes(`>${word}<`),
      `the page hard-codes the state word "${word}"`);
  }
});

test("R7 an unrecognised reason code names itself instead of borrowing copy", () => {
  const copy = reviewStateCopy("review_something_new");
  assert.equal(copy.known, false);
  assert.equal(copy.tile, "Unrecognised reason (review_something_new)");
  assert.notEqual(copy.sentence, REVIEW_STATE_SENTENCES.review_profile.sentence);
  assert.equal(Object.keys(REVIEW_STATE_SENTENCES).length, 12);
});

// ── R8: a plain sentence per system ─────────────────────────────────────────

test("R8 both rows carry a plain-English summary sentence, always visible", () => {
  for (const row of SYSTEMS) {
    assert.ok(typeof row.summary === "string" && row.summary.trim().endsWith("."));
    assert.ok(row.summary.split(/\s+/).length >= 12, `${row.id}: summary is too thin to explain itself`);
  }
  assert.match(page, /class="csum"/);
});

// ── R9: the to-do strip holds only David-only actions ───────────────────────

test("R9 every to-do rule is David-only, and the strip hides when nothing fires", async () => {
  for (const rule of TODO_RULES) {
    assert.equal(rule.onlyDavid, true, `${rule.id}: not a David-only rule`);
    assert.equal(typeof rule.when, "function");
    assert.ok(rule.label.trim().length > 10);
  }
  const quiet = await build({
    apphub: fakeApphub({ counts: countsDoc(), pipeline: pipelineFixture({ laneEnabled: true }) }),
  });
  assert.deepEqual(quiet.todos, []);
  assert.match(page, /style\.display=\(todos&&todos\.length\)\?"flex":"none"/);

  const loud = await build({
    apphub: fakeApphub({
      counts: countsDoc({ updatedAt: iso(5 * 3600e3) }),
      pipeline: pipelineFixture({ generatedAt: iso(5 * 3600e3), laneEnabled: false }),
    }),
  });
  assert.deepEqual(loud.todos.map((t) => t.id), ["applicant-job-unclear", "applicant-invite-lane"]);
  assert.ok(loud.todos[0].command, "the job to-do carries a command to copy");
  assert.match(page, /navigator\.clipboard\.writeText/);
});

// ── R10: per-source "as of", oldest wins the headline ───────────────────────

test("R10 the headline stamp is the oldest source that answered, and names it", async () => {
  const state = await build({
    apphub: fakeApphub({ counts: countsDoc({ updatedAt: iso(4 * 3600e3) }), pipeline: pipelineFixture() }),
  });
  assert.equal(state.asOf.sourceId, "applicants-feed");
  assert.match(state.asOf.sourceName, /Applicants tab/);
  assert.match(state.asOf.when, /^4h ago \(\d+:\d\d [ap]m PT\)$/);
  const ids = state.sources.map((s) => s.id);
  assert.deepEqual(ids, SOURCES.map((s) => s.id));
  const watchdog = state.sources.find((s) => s.id === "watchdog-beat");
  assert.equal(watchdog.state, "never-registered");
  const funnel = state.sources.find((s) => s.id === "post-call-funnel");
  assert.equal(funnel.state, "never-registered");
  // a source that has never answered cannot set the headline
  assert.ok(state.sources.some((s) => s.state === "never-registered" && !s.at));
});

// ── R11: zero Gmail, zero Paraform, warm cache costs nothing ────────────────

test("R11 a warm cache makes zero external fetches", async () => {
  const fetchImpl = fakeFetch(() => { throw new Error("must not fetch"); });
  const upstreamImpl = fakeUpstream({});
  const kv = fakeKv({
    "statv2:memo:health": { at: iso(5e3), outcome: { at: iso(5e3), ok: true, status: 200 }, reads: [], data: healthLive(), dataAt: iso(5e3) },
    "statv2:memo:metrics": { at: iso(5e3), ok: true, state: "answered", data: metricsFixture(), dataAt: iso(5e3) },
    "statv2:memo:funnel": { at: iso(5e3), ok: true, state: "answered", data: funnelWireframe(), dataAt: iso(5e3) },
  });
  const state = await build({ fetchImpl, upstreamImpl, kv, apphub: fakeApphub({ counts: countsDoc() }) });
  assert.equal(state.ok, true);
  assert.equal(fetchImpl.calls.length, 0, `warm cache still fetched: ${fetchImpl.calls.join(", ")}`);
  assert.equal(upstreamImpl.calls.length, 0);
});

test("R11 the only host this plane may name is the public post-call service", async () => {
  const hosts = [...stateSrc.matchAll(/https:\/\/([a-z0-9.-]+)/gi)].map((m) => m[1]);
  assert.deepEqual([...new Set(hosts)], ["raydar-post-call.vercel.app"]);
  assert.equal(HEALTH_URL, "https://raydar-post-call.vercel.app/api/health");
  for (const src of [stateSrc, catalogSrc, page]) {
    assert.doesNotMatch(src, /googleapis|gmail\.com|paraform\.com/i);
  }
  const fetchImpl = fakeFetch(() => jsonRes(200, healthLive()));
  await build({ fetchImpl });
  for (const url of fetchImpl.calls) {
    assert.equal(new URL(url).host, "raydar-post-call.vercel.app");
  }
});

test("R11 nothing here polls the applicant pipeline's loopback API", () => {
  assert.doesNotMatch(stateSrc, /localhost|127\.0\.0\.1/);
});

// ── R12: measured vs inferred, on every number and every state word ─────────

test("R12 every number carries a basis and every state pill carries its signal", async () => {
  const state = await build({
    apphub: fakeApphub({ counts: countsDoc(), pipeline: pipelineFixture() }),
    upstreamImpl: fakeUpstream({
      "/api/v2/reviews/metrics": { status: 200, body: { ok: true, metrics: metricsFixture() } },
      "/api/v2/reviews/funnel": { status: 200, body: { ok: true, funnel: funnelWireframe() } },
    }),
  });
  for (const system of state.systems) {
    assert.ok(system.state.caption && system.state.caption.trim(), `${system.id}: state word with no signal caption`);
    assert.ok(system.evidence.length > 0);
    for (const row of system.evidence) {
      assert.ok(["measured", "inferred"].includes(row.basis), `${system.id}: bad basis ${row.basis}`);
    }
  }
  // day one: nothing on the page is inferred
  assert.ok(state.systems.every((s) => s.evidence.every((r) => r.basis === "measured")));
});

// ── R13: the person and the decision, never implementation ids ──────────────

test("R13 no uuid, epoch, deploy or lane id reaches the rendered surface", async () => {
  const state = await build({
    apphub: fakeApphub({ counts: countsDoc(), pipeline: pipelineFixture() }),
  });
  const rendered = JSON.stringify(state);
  assert.doesNotMatch(rendered, /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
    "an id leaked out of the health payload");
  assert.doesNotMatch(rendered, /activeEpoch|epochId/);
  // raw reason codes are allowed, but only inside the evidence drawer
  const postCall = systemOf(state, "post-call");
  for (const stage of postCall.flow.stages) {
    for (const tile of stage.tiles || []) assert.doesNotMatch(tile.label, /^review_/);
  }
});

// ── R14: applicant labels are never hard-coded ──────────────────────────────

test("R14 no applicant bucket label literal exists in the page or the catalog", () => {
  const banned = ["Needs setup", "Identity review", "Recipient review", "Delivery review", "Cannot contact"];
  for (const src of [page, catalogSrc]) {
    for (const literal of banned) {
      assert.ok(!src.includes(literal), `banned applicant label literal in source: ${literal}`);
    }
  }
});

test("R14 a payload carrying the target vocabulary renders it unchanged", () => {
  const resolved = flowFor(SYSTEMS[1], { pipeline: pipelineFixture() }, { nowMs: NOW });
  const pool = resolved.flow.stages.find((s) => s.id === "waiting-you");
  const byCount = [...TARGET_HOLDS].sort((a, b) => b.count - a.count);
  assert.deepEqual(pool.tiles.map((t) => t.label), byCount.map((h) => h.label));
  assert.deepEqual(pool.tiles.map((t) => t.count), byCount.map((h) => h.count));
  // and today's vocabulary renders just as unchanged
  const today = flowFor(SYSTEMS[1], {
    pipeline: pipelineFixture({ holdsByReason: [{ code: "needs_setup", label: "Needs setup", count: 996 }] }),
  }, { nowMs: NOW });
  assert.equal(today.flow.stages.find((s) => s.id === "waiting-you").tiles[0].label, "Needs setup");
  // a bucket with no label at all names its code rather than borrowing copy
  const bare = flowFor(SYSTEMS[1], {
    pipeline: pipelineFixture({ holdsByReason: [{ code: "brand_new", count: 4 }] }),
  }, { nowMs: NOW });
  assert.equal(bare.flow.stages.find((s) => s.id === "waiting-you").tiles[0].label,
    "Unrecognised reason (brand_new)");
});

// ── R15: a drawn pipeline per system, always open ───────────────────────────

test("R15 both systems draw at least five stages, with nothing behind a click", async () => {
  const state = await build({ apphub: fakeApphub({ counts: countsDoc(), pipeline: pipelineFixture() }) });
  for (const system of state.systems) {
    assert.ok(system.flow.stages.length >= 5, `${system.id}: only ${system.flow.stages.length} stages`);
    assert.equal(system.flow.counted, true);
  }
  assert.equal(systemOf(state, "post-call").flow.stages.length >= 8, true);
  // the drawing is rendered unconditionally, not behind an expander
  assert.match(page, /\$\{system\.flow\?drawFlow\(system\.flow\):""\}/);
  assert.doesNotMatch(page, /togglePanel|expand-flow/);
});

test("R15 a node with no publisher draws a dash and names the step that brings it", async () => {
  const state = await build();
  const postCall = systemOf(state, "post-call");
  assert.equal(nodeOf(postCall, "calls").count, null);
  assert.ok(postCall.pending.length >= 6);
  assert.ok(postCall.pending.every((p) => p.step));
  const applicant = systemOf(state, "applicant");
  assert.ok(applicant.pending.some((p) => p.id === "emailed" && p.step === "step 3b"));
});

// ── R16: a send is a send ───────────────────────────────────────────────────

test("R16 'Email sent' reads acceptance, 'Delivered' reads delivery, previews feed nothing", () => {
  const postCall = SYSTEMS[0];
  assert.equal(postCall.flow.stages.find((s) => s.id === "sent").countKey, "funnel.accepted");
  assert.equal(postCall.flow.stages.find((s) => s.id === "delivered").countKey, "funnel.delivered");
  const applicant = SYSTEMS[1];
  assert.equal(applicant.flow.stages.find((s) => s.id === "emailed").countKey, undefined);
  for (const src of [catalogSrc, stateSrc]) assert.doesNotMatch(src, /email_previews|emailPreviews/);
});

// ── R17: worst-of wins, and a "down" claim needs two witnesses ──────────────

test("R17 worst-of sets the card, and a lane chip can be the worst thing on it", async () => {
  assert.equal(worstState(["sending", "not-sending-yet"]), "not-sending-yet");
  assert.equal(worstState(["cannot-tell", "paused"]), "cannot-tell");
  assert.equal(worstState(["not-running", "cannot-tell"]), "not-running");
  assert.equal(worstState([]), "cannot-tell");
  const state = await build({
    apphub: fakeApphub({ counts: countsDoc(), pipeline: pipelineFixture({ laneEnabled: false }) }),
  });
  const applicant = systemOf(state, "applicant");
  assert.equal(applicant.state.word, STATE_WORDS["not-sending-yet"]);
  assert.equal(applicant.spineTone, "warn");
  assert.equal(applicant.chips[0].word, STATE_WORDS["not-sending-yet"]);
});

test("R17 stale with no stop reason is Cannot tell; Not running needs a second witness", () => {
  const stale = { generatedAt: iso(4 * 3600e3 + 12 * 60e3), laneEnabled: true };
  const unknown = applicantStateFrom({ pipeline: pipelineFixture(stale), counts: null, nowMs: NOW });
  assert.equal(unknown.stateId, "cannot-tell");
  assert.equal(unknown.reason, "stale-publish");
  assert.match(unknown.caption, /I cannot tell whether you paused it or it stopped/);

  const paused = applicantStateFrom({
    pipeline: pipelineFixture({ ...stale, stopReason: "profile-copy repair" }), counts: null, nowMs: NOW,
  });
  assert.equal(paused.stateId, "paused");
  assert.match(paused.caption, /Paused on purpose · profile-copy repair · since/);

  const witnessed = applicantStateFrom({
    pipeline: pipelineFixture({ ...stale, jobLoaded: false }), counts: null, nowMs: NOW,
  });
  assert.equal(witnessed.stateId, "not-running");
  assert.match(witnessed.caption, /no reason recorded/);
});

test("R17 two consecutive failed reads raise one incident line, and never 'Not running'", () => {
  const once = postCallStateFrom({
    health: { outcome: { at: iso(12e3), ok: false, status: 500, error: "http 500" }, reads: [{ ok: true }, { ok: false }], data: healthLive(), dataAt: iso(3 * 60e3) },
    nowMs: NOW,
  });
  assert.equal(once.stateId, "cannot-tell");
  assert.equal(once.incident, null);
  assert.equal(once.lastGood.word, STATE_WORDS.sending);

  const twice = postCallStateFrom({
    health: { outcome: { at: iso(12e3), ok: false, status: 500, error: "http 500" }, reads: [{ ok: false }, { ok: false }], data: null, dataAt: null },
    nowMs: NOW,
  });
  assert.equal(twice.stateId, "cannot-tell");
  assert.match(twice.incident, /failed twice in a row/);
  assert.notEqual(twice.stateId, "not-running");
});

test("R17 a degraded self-report keeps the green word and adds a warning chip", () => {
  const live = postCallStateFrom({
    health: { outcome: { at: iso(3e3), ok: true, status: 200 }, reads: [{ ok: true }], data: healthDegraded(), dataAt: iso(3e3) },
    nowMs: NOW,
  });
  assert.equal(live.stateId, "sending");
  assert.equal(live.pulse, true);
  assert.match(live.caption, /from the live check, \d+s ago/);
  assert.match(live.warn, /one source degraded \(self-reported\)/);
});

test("R17 a health payload that is not live renders Not sending yet", () => {
  const notLive = postCallStateFrom({
    health: { outcome: { at: iso(3e3), ok: true, status: 200 }, reads: [], data: { ...healthLive(), mode: "shadow" }, dataAt: iso(3e3) },
    nowMs: NOW,
  });
  assert.equal(notLive.stateId, "not-sending-yet");
  assert.match(notLive.caption, /from the live check/);
});

// ── R18: say what is not covered ────────────────────────────────────────────

test("R18 the footer says what this page does not cover and links the old Status", async () => {
  const state = await build();
  assert.equal(state.footer.link.href, "/#status");
  assert.match(state.footer.title, /does not cover/i);
  assert.match(state.footer.body, /screener/);
  assert.match(state.footer.body, /Nothing here reads Gmail or Paraform\./);
  assert.match(page, /class="foot" id="foot"/);
});

// ── R19: the explicit NOs stay out ──────────────────────────────────────────

test("R19 no trend line, no verdict banner, no money, no needs-you list", () => {
  for (const src of [page, catalogSrc, stateSrc]) {
    assert.doesNotMatch(src, /trend|sparkline|chart\b/i);
    assert.doesNotMatch(src, /\$[0-9]/);
    assert.doesNotMatch(src, /placement fee|fee funnel/i);
  }
  // Money is named once, in the footer, only to say it is NOT here.
  assert.equal((page.match(/revenue/gi) || []).length, 0);
  assert.equal((catalogSrc.match(/revenue/gi) || []).length, 1);
  assert.match(FOOTER.body, /Money is not on this page/);
  // no roll-up verdict banner: with two systems that would be the easiest
  // place on the page to tell a lie (PRD §4).
  assert.doesNotMatch(page, /verdict|class="banner"/i);
  assert.doesNotMatch(page, /needs you|attention/i);
});

// ── R20: this page reads and never writes ───────────────────────────────────

test("R20 the route is GET only and never caches", async () => {
  const headers = {};
  const res = {
    statusCode: null, payload: null,
    setHeader: (k, v) => { headers[k] = v; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.payload = body; return this; },
    end() { return this; },
  };
  await handler({ method: "POST", headers: {}, query: {} }, res);
  assert.equal(res.statusCode, 405);
  assert.equal(headers["cache-control"], "no-store");
  assert.equal(routeConfig.maxDuration, 30);
  assert.doesNotMatch(stateSrc, /vSet\(K\.(health|metrics|funnel)[^)]*\)\s*;?\s*\/\/ write to a lane/);
});

// ── the Applicants-tab strip, the all-time strip, the change ring ───────────

test("the Applicants-tab strip shows the tab's own four fields, dashing the unpublished ones", () => {
  const strip = applicantsTabStrip({ counts: countsDoc(), nowMs: NOW });
  assert.deepEqual(strip.items.map((i) => [i.label, i.value]), [
    ["Waiting on you", 203],
    ["In the invite stream", 88],
    ["Profiles preparing", null],
    ["In total", null],
  ]);
  assert.equal(strip.items[2].step, "step 3");
  assert.equal(strip.cannotTell, null);
  const missing = applicantsTabStrip({ counts: null, nowMs: NOW });
  assert.match(missing.cannotTell, /^Cannot tell/);
  assert.deepEqual(missing.items, []);
  const alerted = applicantsTabStrip({ counts: countsDoc({ alert: { queue: { baseline: 2479, seen: 22 } } }), nowMs: NOW });
  assert.match(alerted.alert, /count warning is on/);
});

test("the all-time strip is real on day one, and says Cannot tell when the feed is out", () => {
  const strip = allTimeStrip({ metrics: metricsFixture(), memo: { dataAt: iso(8e3) }, nowMs: NOW });
  assert.equal(strip.items[0].value, 12);
  assert.equal(strip.buckets.length, 4);
  assert.match(strip.sentence, /half are cleared within/);
  const out = allTimeStrip({ metrics: null, memo: { state: "error" }, nowMs: NOW });
  assert.match(out.cannotTell, /^Cannot tell/);
  assert.deepEqual(out.items, []);
});

test("since you last looked: a change ring that never invents an event", () => {
  const before = snapshotFor("post-call", { stateId: "sending", ctx: { funnel: { accepted: 5, delivered: 4 } } });
  const after = snapshotFor("post-call", { stateId: "cannot-tell", ctx: { funnel: { accepted: 8, delivered: 4 } } });
  const events = diffEvents("post-call", before, after, iso(0));
  assert.deepEqual(events.map((e) => e.text), ["went from Sending to Cannot tell", "3 more sent"]);
  // a first sighting produces nothing, and a count that was never published stays quiet
  assert.deepEqual(diffEvents("post-call", null, after, iso(0)), []);
  const partial = snapshotFor("applicant", { stateId: "paused", ctx: { pipeline: { captured: 3 } } });
  assert.deepEqual(diffEvents("applicant", { stateId: "paused", counts: {} }, partial, iso(0)), []);
  assert.match(page, /First visit on this browser/);
  assert.match(page, /nothing moved/);
});

test("the aggregator survives every source being out, and still renders both cards", async () => {
  const state = await build({
    fetchImpl: fakeFetch(() => { throw new Error("network gone"); }),
    upstreamImpl: fakeUpstream({ "/api/v2/reviews/metrics": new Error("upstream gone") }),
    apphub: { getJson: async () => { throw new Error("kv gone"); } },
  });
  assert.equal(state.ok, true);
  assert.equal(state.systems.length, 2);
  for (const system of state.systems) {
    assert.equal(system.state.word, STATE_WORDS["cannot-tell"]);
    assert.ok(system.flow.stages.length >= 5);
  }
  assert.equal(state.asOf, null);
});

// ── page and route wiring ───────────────────────────────────────────────────

test("the page is Google-gated, embed-aware, and talks only to its own aggregator", () => {
  assert.match(page, /^<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8" \/>/);
  assert.match(page, /RaydarAuth\.session\(\)/);
  assert.match(page, /accounts\.google\.com\/gsi\/client/);
  assert.match(page, /\/fonts\/pp-grafier\.css/);
  assert.match(page, /params\.has\("embed"\)/);
  assert.match(page, /body\.embed header \.brand h1/);
  assert.match(page, /\/api\/status-v2\/state/);
  assert.match(page, /credentials:"same-origin"/);
  assert.match(page, /\.floww svg\{width:100%;height:auto\}/);
  const fetches = [...page.matchAll(/fetch\("([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(fetches)], ["/api/auth/config"]);
});

test("Status v2 is wired into every dashboard registry, and touches no other tab", () => {
  const views = JSON.parse(indexHtml.match(/const VIEWS=(\[[^\]]+\]);/)[1]);
  assert.ok(views.includes("status-v2"));
  assert.ok(views.includes("status"), "the old Status tab stays");
  assert.match(indexHtml, /id="tab-status-v2"/);
  assert.match(indexHtml, /id="view-status-v2" hidden/);
  assert.match(indexHtml, /statusV2Loaded/);
  assert.match(indexHtml, /frameSrc\("\/status-v2","status-v2"\)/);
  assert.match(indexHtml, /\{name:"status-v2",label:"Status v2",group:"Live"\}/);
  assert.ok(vercel.rewrites.some((r) => r.source === "/status-v2" && r.destination === "/status-v2.html"));
  assert.ok(vercel.rewrites.some((r) => r.source === "/status" && r.destination === "/status.html"));
  assert.equal(vercel.functions["api/status-v2/*.mjs"].maxDuration, 30);
});

test("the watchdog beat lane is still unregistered, which is why the page names it", async () => {
  const { byId } = await import("../api/health/_lib/catalog.mjs");
  assert.equal(byId.get(WATCHDOG_LANE_ID), undefined,
    "the beat catalog now has this lane — update the source's copy and this test together");
});

test("times on the surface are an age plus one Pacific clock, never a bare stamp", () => {
  assert.equal(humanAge(3_000), "3s");
  assert.equal(humanAge(90_000), "1m");
  assert.equal(humanAge(4 * 3600e3 + 12 * 60e3), "4h 12m");
  assert.equal(humanAge(null), null);
  assert.match(pacificClock("2026-09-03T18:23:00.000Z"), /^\d+:\d\d [ap]m PT$/);
  assert.match(whenSentence(iso(4 * 3600e3 + 12 * 60e3), NOW), /^4h 12m ago \(\d+:\d\d [ap]m PT\)$/);
  assert.equal(whenSentence("not-a-date", NOW), null);
});
