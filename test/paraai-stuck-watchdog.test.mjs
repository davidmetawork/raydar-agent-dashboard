import test from "node:test";
import assert from "node:assert/strict";

import {
  findStuckJobs,
  runStuckWatchdogTick,
  stuckAlertMessage,
  stuckAlertSlotKey,
  stuckThresholdMs,
} from "../api/paraai/_lib/stuck-watchdog.mjs";
import {
  domainCandidateId,
  normalizeCandidateRow,
  scoreIdentity,
} from "../api/paraai/_lib/core.mjs";

const NOW = Date.parse("2026-08-04T04:00:00Z");
const ago = (ms) => new Date(NOW - ms).toISOString();

test("the watchdog reports jobs that stopped moving, whatever the cause", () => {
  // The 2026-08-03 shape: a killed function writes no error and no journal, so
  // the only observable is an updatedAt that stopped advancing.
  const stuck = findStuckJobs([
    { id: "a", state: "resolving_identity", candidate: { fullName: "Yang An" }, updatedAt: ago(14 * 3600_000) },
    { id: "b", state: "ready_to_submit", candidate: { fullName: "Collin Socha" }, updatedAt: ago(2 * 3600_000) },
    { id: "c", state: "extracting", candidate: { fullName: "Leo Ng" }, updatedAt: ago(60_000) },
  ], { now: NOW });
  assert.deepEqual(stuck.map((row) => row.name), ["Yang An", "Collin Socha"]);
  assert.equal(stuck[0].state, "resolving_identity");
});

test("resting states are not stalls", () => {
  // needs_review is a decision awaiting a human and awaiting_matches is a
  // vendor wait. Alerting on those would train the channel to be ignored.
  assert.deepEqual(findStuckJobs([
    { id: "a", state: "needs_review", updatedAt: ago(48 * 3600_000) },
    { id: "b", state: "needs_identity_review", updatedAt: ago(48 * 3600_000) },
    { id: "c", state: "awaiting_matches", updatedAt: ago(48 * 3600_000) },
    { id: "d", state: "error", updatedAt: ago(48 * 3600_000) },
  ], { now: NOW }), []);
});

test("a job with no timestamp at all is not silently dropped from the count", () => {
  // Missing timestamps must not read as healthy; they fall back to createdAt.
  const stuck = findStuckJobs([
    { id: "a", state: "detected", candidate: { fullName: "No Update" }, createdAt: ago(6 * 3600_000) },
  ], { now: NOW });
  assert.equal(stuck.length, 1);
  assert.equal(stuck[0].name, "No Update");
});

test("the alert names the impact, not just a count", () => {
  const message = stuckAlertMessage(findStuckJobs([
    { id: "a", state: "resolving_identity", candidate: { fullName: "Yang An" }, updatedAt: ago(14 * 3600_000) },
    { id: "b", state: "resolving_identity", candidate: { fullName: "Collin Socha" }, updatedAt: ago(13 * 3600_000) },
  ], { now: NOW }));
  assert.match(message, /2 job\(s\) stuck before submission/u);
  assert.match(message, /Yang An/u);
  assert.match(message, /No new candidate is reaching the Talent Network/u);
  assert.equal(stuckAlertMessage([]), null);
});

test("a growing backlog re-alerts while a steady one stays quiet", () => {
  // Same slot key for a stable backlog means the throttle holds; crossing a
  // bucket is a new key, so a failure that keeps swallowing candidates cannot
  // be throttled into looking resolved.
  const rows = (count) => Array.from({ length: count }, (_, index) => ({
    id: String(index), state: "ready_to_submit", updatedAt: ago(3 * 3600_000),
  }));
  const key = (count) => stuckAlertSlotKey(findStuckJobs(rows(count), { now: NOW }));
  assert.equal(key(2), key(3));
  assert.notEqual(key(3), key(7));
  assert.notEqual(key(7), key(12));
  assert.notEqual(key(12), key(25));
});

test("the watchdog alerts once per slot and survives a store failure", async () => {
  const sent = [];
  const jobs = [{ id: "a", state: "resolving_identity", candidate: { fullName: "Yang An" }, updatedAt: ago(9 * 3600_000) }];
  let slotTaken = false;
  const tick = (overrides = {}) => runStuckWatchdogTick({
    listJobsImpl: async () => jobs,
    alertSlotImpl: async () => (slotTaken ? false : (slotTaken = true)),
    notifyImpl: async (message) => sent.push(message),
    now: NOW,
    ...overrides,
  });
  assert.equal((await tick()).alerted, true);
  assert.equal((await tick()).alerted, false);
  assert.equal(sent.length, 1);

  const broken = await tick({ listJobsImpl: async () => { throw new Error("kv down"); } });
  assert.equal(broken.ok, false);
  assert.equal(sent.length, 1);
});

test("the stuck threshold is configurable but never absurdly short", () => {
  assert.equal(stuckThresholdMs("90"), 90 * 60_000);
  assert.equal(stuckThresholdMs("1"), 45 * 60_000);
  assert.equal(stuckThresholdMs(undefined), 45 * 60_000);
});

test("a point-lookup row becomes scoreable instead of silently unmatchable", () => {
  // Verified live 2026-08-03: getCandidateUserById returns name, linkedin_user
  // and candidate_id all undefined at the top level, so scoring one could
  // return at most zero signals and could never pass a two-signal bar.
  const raw = {
    id: "candidate-user-42",
    phone_number: null,
    candidate: {
      id: "person-99",
      name: "Yang An",
      linkedin_user: "https://www.linkedin.com/in/yang-an-1305",
    },
  };
  assert.deepEqual(scoreIdentity({ fullName: "Yang An", linkedin: "https://www.linkedin.com/in/yang-an-1305" }, raw), {
    signals: [],
    ok: false,
  });

  const row = normalizeCandidateRow(raw);
  const scored = scoreIdentity(
    { fullName: "Yang An", linkedin: "https://www.linkedin.com/in/yang-an-1305" },
    row,
  );
  assert.deepEqual(scored.signals.sort(), ["linkedin", "name"]);
  assert.equal(scored.ok, true);
  assert.equal(row.candidate_id, "person-99");
  // The candidate-USER id every downstream write is keyed on is preserved.
  assert.equal(row.id, "candidate-user-42");
  assert.equal(row.candidate.id, "person-99");
});

test("normalization leaves a real CRM page row untouched", () => {
  const page = {
    id: "candidate-user-7",
    name: "Page Row",
    linkedin_user: "https://www.linkedin.com/in/page-row",
    phone_number: "+1 5550001111",
    candidate_id: "person-7",
  };
  const row = normalizeCandidateRow(page);
  assert.equal(row.name, "Page Row");
  assert.equal(row.linkedin_user, "https://www.linkedin.com/in/page-row");
  assert.equal(row.phone_number, "+1 5550001111");
  assert.equal(row.candidate_id, "person-7");
});

test("the domain candidate id is found in either row shape", () => {
  assert.equal(domainCandidateId({ candidate_id: "flat" }), "flat");
  assert.equal(domainCandidateId({ candidate: { id: "nested" } }), "nested");
  assert.equal(domainCandidateId({ candidate_user: { candidate: { id: "deep" } } }), "deep");
  assert.equal(domainCandidateId({}), null);
  assert.equal(domainCandidateId(null), null);
});

test("a stalled job with no queue entry is re-queued, not just reported", async () => {
  // Only the screener recovery feed enqueues work, so a human call or a job
  // re-prepared out of band sits at ready_to_submit forever with no error:
  // it is not failing, nobody is asking. That is self-healing, so it is silent.
  const enqueued = [];
  const result = await runStuckWatchdogTick({
    listJobsImpl: async () => ([
      { id: "human-1", state: "ready_to_submit", candidate: { fullName: "Steve K" }, updatedAt: ago(5 * 3600_000) },
      { id: "human-2", state: "ready_to_submit", candidate: { fullName: "Sriram K" }, updatedAt: ago(4 * 3600_000) },
    ]),
    alertSlotImpl: async () => true,
    notifyImpl: async () => {},
    enqueueImpl: async (id, opts) => { enqueued.push([id, opts.source]); return { enqueued: true }; },
    now: NOW,
  });
  assert.deepEqual(enqueued, [["human-1", "stuck_watchdog"], ["human-2", "stuck_watchdog"]]);
  assert.equal(result.requeued, 2);
});

test("a failing re-queue never suppresses the alert", async () => {
  const sent = [];
  const result = await runStuckWatchdogTick({
    listJobsImpl: async () => ([
      { id: "a", state: "resolving_identity", candidate: { fullName: "Yang An" }, updatedAt: ago(9 * 3600_000) },
    ]),
    alertSlotImpl: async () => true,
    notifyImpl: async (message) => sent.push(message),
    enqueueImpl: async () => { throw new Error("kv down"); },
    now: NOW,
  });
  assert.equal(result.alerted, true);
  assert.equal(result.requeued, 0);
  assert.equal(sent.length, 1);
});
