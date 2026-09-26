// The daily live-set index — the replacement for the 10-minute
// booking-membership-refresh walk (docs/research/booking-protection-minimum-
// 2026-09-26.md items 1/2/4).
process.env.PARAFORM_COOKIE ||= "Fe26.2**test-cookie";

import test from "node:test";
import assert from "node:assert/strict";

import {
  buildLiveSet,
  liveSetUsable,
  matchBookingAgainstLiveSet,
  LIVESET_SCHEMA,
  LIVESET_MAX_AGE_MS,
} from "../api/seq/_lib/booking-protection-liveset.mjs";

const CATALOG = [
  { id: "seq_interview", name: "No Scheduled Call - Raydar - 1st Round Interview - Backend Engineer", enabled: true },
  { id: "seq_no_show", name: "No Show - Agent Call", enabled: true },
  { id: "seq_disabled_named", name: "Reschedule Human Call", enabled: false }, // named but OFF -> excluded
  { id: "seq_unrelated", name: "Cold Outreach - Some Role", enabled: true }, // not a named family -> excluded
];

function lead(overrides = {}) {
  return {
    ccu_id: "ccu_1",
    cu_id: "cu_1",
    name: "Test Candidate",
    to_use_email: "candidate@example.com",
    created_at: "2026-09-01T00:00:00.000Z",
    is_paused: false,
    is_archived: false,
    ...overrides,
  };
}

test("buildLiveSet keeps only ENABLED, name-matched sequences with at least one active lead", async () => {
  const membershipBySeq = {
    seq_interview: { leads: [lead({ ccu_id: "ccu_a" })], complete: true },
    seq_no_show: { leads: [], complete: true }, // no active leads -> excluded from the index
  };
  const walked = [];
  const liveSet = await buildLiveSet({
    now: Date.parse("2026-09-26T12:00:00.000Z"),
    listSequences: async () => CATALOG,
    membershipLoader: async (id) => { walked.push(id); return membershipBySeq[id]; },
  });

  assert.equal(liveSet.schema, LIVESET_SCHEMA);
  assert.equal(liveSet.catalogSequences, 4);
  assert.equal(liveSet.candidateSequences, 2, "only the two enabled, named sequences are walked");
  assert.deepEqual(walked.sort(), ["seq_interview", "seq_no_show"]);
  assert.equal(liveSet.sequencesWithActiveLeads, 1, "the no-active-lead sequence contributes nothing");
  assert.equal(liveSet.indexedEmails, 1);
  assert.ok(liveSet.byEmail["candidate@example.com"]);
  assert.equal(liveSet.byEmail["candidate@example.com"][0].s, "seq_interview");
  assert.equal(liveSet.incomplete, false);
});

test("buildLiveSet excludes paused/archived leads and records per-sequence read errors without failing the whole build", async () => {
  const liveSet = await buildLiveSet({
    now: Date.now(),
    listSequences: async () => CATALOG,
    membershipLoader: async (id) => {
      if (id === "seq_interview") throw Object.assign(new Error("nope"), { code: "PARAFORM_REFUSED" });
      return {
        leads: [
          lead({ ccu_id: "ccu_active" }),
          lead({ ccu_id: "ccu_paused", is_paused: true, to_use_email: "paused@example.com" }),
          lead({ ccu_id: "ccu_archived", is_archived: true, to_use_email: "archived@example.com" }),
        ],
      };
    },
  });
  assert.equal(liveSet.incomplete, true);
  assert.equal(liveSet.errors.length, 1);
  assert.equal(liveSet.errors[0].sequenceId, "seq_interview");
  assert.equal(liveSet.indexedEmails, 1, "only the one active lead is indexed");
  assert.ok(liveSet.byEmail["candidate@example.com"]);
  assert.equal(liveSet.byEmail["paused@example.com"], undefined);
  assert.equal(liveSet.byEmail["archived@example.com"], undefined);
});

test("buildLiveSet paces between sequences but not before the first one", async () => {
  let sleeps = 0;
  await buildLiveSet({
    listSequences: async () => CATALOG,
    membershipLoader: async () => ({ leads: [lead()] }),
    sleepBetweenSequences: async () => { sleeps++; },
  });
  assert.equal(sleeps, 1, "two candidate sequences -> one gap between them");
});

test("liveSetUsable enforces schema, shape, and the max-age ceiling", () => {
  const now = Date.parse("2026-09-26T12:00:00.000Z");
  const fresh = { schema: LIVESET_SCHEMA, byEmail: {}, builtAt: new Date(now - 1000).toISOString() };
  assert.equal(liveSetUsable(fresh, now), true);

  const stale = { schema: LIVESET_SCHEMA, byEmail: {}, builtAt: new Date(now - LIVESET_MAX_AGE_MS - 1000).toISOString() };
  assert.equal(liveSetUsable(stale, now), false);

  assert.equal(liveSetUsable(null, now), false);
  assert.equal(liveSetUsable({ schema: "wrong", byEmail: {}, builtAt: new Date(now).toISOString() }, now), false);
  assert.equal(liveSetUsable({ schema: LIVESET_SCHEMA, builtAt: new Date(now).toISOString() }, now), false, "missing byEmail");
});

function liveSetWith(entries) {
  return {
    schema: LIVESET_SCHEMA,
    builtAt: new Date().toISOString(),
    byEmail: entries,
  };
}

test("matchBookingAgainstLiveSet reuses today's rule: booking after enrollment pauses, before does not", () => {
  const enrolledAt = Date.parse("2026-09-01T00:00:00.000Z");
  const liveSet = liveSetWith({
    "candidate@example.com": [{ ccu: "ccu_1", cu: "cu_1", n: "Cand", s: "seq_1", sn: "No Show - Agent Call", t: new Date(enrolledAt).toISOString() }],
  });

  const after = matchBookingAgainstLiveSet({
    liveSet,
    email: "candidate@example.com",
    bookedAtMs: enrolledAt + 86_400_000,
    source: "raydar_scheduler",
  });
  assert.equal(after.length, 1);
  assert.equal(after[0].ccuId, "ccu_1");

  const before = matchBookingAgainstLiveSet({
    liveSet,
    email: "candidate@example.com",
    bookedAtMs: enrolledAt - 86_400_000,
    source: "raydar_scheduler",
  });
  assert.equal(before.length, 0);
});

test("the interview-chase pre-join rule only fires for that family, and only when the flag is on", () => {
  const enrolledAt = Date.parse("2026-09-01T00:00:00.000Z");
  const bookedBefore = enrolledAt - 86_400_000;

  const chaseSet = liveSetWith({
    "candidate@example.com": [{
      ccu: "ccu_1", cu: "cu_1", n: "Cand", s: "seq_1",
      sn: "No Scheduled Call - Raydar - 1st Round Interview - Backend Engineer",
      t: new Date(enrolledAt).toISOString(),
    }],
  });
  assert.equal(matchBookingAgainstLiveSet({
    liveSet: chaseSet, email: "candidate@example.com", bookedAtMs: bookedBefore, source: "raydar_scheduler",
  }).length, 0, "flag off by default");
  const withFlag = matchBookingAgainstLiveSet({
    liveSet: chaseSet, email: "candidate@example.com", bookedAtMs: bookedBefore, source: "raydar_scheduler",
    alsoPauseBeforeJoiningInterviewChase: true,
  });
  assert.equal(withFlag.length, 1);
  assert.match(withFlag[0].evidence, /pre-join rule/);

  const noShowSet = liveSetWith({
    "candidate@example.com": [{ ccu: "ccu_2", cu: "cu_2", n: "Cand", s: "seq_2", sn: "No Show - Agent Call", t: new Date(enrolledAt).toISOString() }],
  });
  assert.equal(matchBookingAgainstLiveSet({
    liveSet: noShowSet, email: "candidate@example.com", bookedAtMs: bookedBefore, source: "raydar_scheduler",
    alsoPauseBeforeJoiningInterviewChase: true,
  }).length, 0, "the widened rule never applies outside the interview chase, even with the flag on");
});

test("matchBookingAgainstLiveSet is a pure lookup against unknown emails/entries — never throws, never falls back to a scan", () => {
  const liveSet = liveSetWith({});
  assert.deepEqual(matchBookingAgainstLiveSet({ liveSet, email: "nobody@example.com", bookedAtMs: Date.now(), source: "calendly" }), []);
  assert.deepEqual(matchBookingAgainstLiveSet({ liveSet: null, email: "nobody@example.com", bookedAtMs: Date.now(), source: "calendly" }), []);
});
