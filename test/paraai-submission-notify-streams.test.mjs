import test from "node:test";
import assert from "node:assert/strict";

import {
  pendingOutreachReplies,
  buildRequestEvents,
  latestOutreachMatch,
  replyIdentity,
} from "../api/paraai/_lib/submission-notify-request.mjs";
import { buildSequenceEvents } from "../api/paraai/_lib/submission-notify-sequence.mjs";
import {
  SIGNAL_INTERESTED,
  SIGNAL_NOT_INTERESTED,
  SIGNAL_UNCLEAR,
  STREAM_REQUEST,
  STREAM_SEQUENCE,
} from "../api/paraai/_lib/submission-notify.mjs";

/* ══════════════════════════════ stream 2: Para AI Request replies ══════════ */

test("only candidates who actually replied are pending", () => {
  const pending = pendingOutreachReplies([
    { candidateUserId: "c1", repliedAt: "2026-07-30T10:00:00Z", intentCheckedThrough: 1000 },
    { candidateUserId: "c2" },
    { candidateUserId: "c3", outbox: {} },
  ]);
  assert.deepEqual(pending.map((p) => p.candidateUserId), ["c1"]);
});

test("a legacy state with only stoppedReason still notifies", () => {
  // States written before repliedAt existed must not be silently skipped.
  const pending = pendingOutreachReplies([
    { candidateUserId: "c1", stoppedReason: "candidate_replied", intentCheckedThrough: 900 },
  ]);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].eventId, "900");
});

test("the event id comes from the candidate's newest message, not our poll time", () => {
  const [p] = pendingOutreachReplies([
    { candidateUserId: "c1", repliedAt: "2026-07-30T10:00:00Z", intentCheckedThrough: 1700000 },
  ]);
  assert.equal(p.eventId, "1700000");
});

test("a new reply advances the event id; re-reading the same one does not", () => {
  const before = pendingOutreachReplies([
    { candidateUserId: "c1", repliedAt: "x", intentCheckedThrough: 1000 },
  ])[0];
  const same = pendingOutreachReplies([
    { candidateUserId: "c1", repliedAt: "x", intentCheckedThrough: 1000 },
  ])[0];
  const newer = pendingOutreachReplies([
    { candidateUserId: "c1", repliedAt: "x", intentCheckedThrough: 2000 },
  ])[0];
  assert.equal(before.eventId, same.eventId, "same reply must dedupe");
  assert.notEqual(before.eventId, newer.eventId, "a second reply must notify again");
});

test("without intentCheckedThrough it falls back to repliedAt so it still fires once", () => {
  const [p] = pendingOutreachReplies([{ candidateUserId: "c1", repliedAt: "2026-07-30T10:00:00Z" }]);
  assert.equal(p.eventId, "2026-07-30T10:00:00Z");
});

test("request events classify the reply TEXT, not the market verdict", () => {
  // The trap: OFF_MARKET/OPEN is about the market, not this role. A candidate
  // can be OPEN to the market while declining this role.
  const pending = pendingOutreachReplies([
    { candidateUserId: "c1", repliedAt: "x", intentCheckedThrough: 1, intentVerdict: "OPEN" },
  ]);
  const [event] = buildRequestEvents({
    pending,
    detailsById: new Map([["c1", { name: "Ada", text: "Thanks, but I'm not interested." }]]),
  });
  assert.equal(event.stream, STREAM_REQUEST);
  assert.equal(event.signal, SIGNAL_NOT_INTERESTED, "OPEN must not become interested");
  assert.equal(event.candidateName, "Ada");
});

test("a positive request reply reads as interested", () => {
  const [event] = buildRequestEvents({
    pending: [{ candidateUserId: "c1", eventId: "1" }],
    detailsById: new Map([["c1", { name: "Ada", text: "Yes, I'd love to hear more!" }]]),
  });
  assert.equal(event.signal, SIGNAL_INTERESTED);
});

test("an unreadable thread still notifies, as unclear rather than dropped", () => {
  const [event] = buildRequestEvents({
    pending: [{ candidateUserId: "c1", eventId: "1" }],
    detailsById: new Map(),
  });
  assert.equal(event.signal, SIGNAL_UNCLEAR);
  assert.equal(event.replyText, "");
});

/* ─────────────────── stream 2: who replied, and about what (2026-08-04) ───── */

const repliedState = (over = {}) => ({
  candidateUserId: "c1",
  repliedAt: "2026-08-04T10:00:00Z",
  intentCheckedThrough: 1000,
  candidateName: "Ada Lovelace",
  candidateEmail: "ada@example.com",
  threadId: "t1",
  ...over,
});

test("the state's own identity reaches the notification — this is the whole bug", () => {
  // Every field below was already in KV on 2026-08-04; the collector simply did
  // not read it, so the channel said "Unknown candidate" for weeks.
  const pending = pendingOutreachReplies([repliedState({
    latestMatchId: "m1",
    matches: {
      m1: { roleId: "r1", roleName: "Account Executive", companyName: "Acme", sentAt: "2026-08-01T00:00:00Z" },
    },
  })]);
  const [event] = buildRequestEvents({ pending, detailsById: new Map() });
  assert.equal(event.candidateName, "Ada Lovelace");
  assert.equal(event.candidateEmail, "ada@example.com");
  assert.equal(event.roleName, "Account Executive @ Acme");
  assert.equal(event.link, "https://www.paraform.com/candidates?id=c1&r_id=r1");
});

test("the role shown is the newest send, and a second role is stated not hidden", () => {
  const both = {
    m1: { roleId: "r1", roleName: "SDR", companyName: "Acme", sentAt: "2026-07-01T00:00:00Z" },
    m2: { roleId: "r2", roleName: "AE", companyName: "Beta", sentAt: "2026-08-01T00:00:00Z" },
  };
  assert.equal(
    latestOutreachMatch({ latestMatchId: "m2", matches: both }).roleName,
    "AE @ Beta · latest of 2 roles",
  );
  // A state written before latestMatchId existed resolves by send time instead.
  assert.equal(latestOutreachMatch({ matches: both }).roleId, "r2");
});

test("no match on the state degrades to a plain candidate link, never a broken one", () => {
  const [event] = buildRequestEvents({
    pending: pendingOutreachReplies([repliedState()]),
    detailsById: new Map(),
  });
  assert.equal(event.roleName, "");
  assert.equal(event.link, "https://www.paraform.com/candidates?id=c1");
});

test("a state with no stored name falls back to the address on the reply itself", () => {
  const [event] = buildRequestEvents({
    pending: pendingOutreachReplies([repliedState({ candidateName: "", candidateEmail: "" })]),
    detailsById: new Map([["c1", { text: "Hi David", name: "Ada L", email: "ada@example.com" }]]),
  });
  assert.equal(event.candidateName, "Ada L");
  assert.equal(event.candidateEmail, "ada@example.com");
});

test("From headers yield a person, and never a mojibake one", () => {
  assert.deepEqual(replyIdentity("Ada Lovelace <ada@example.com>"), {
    name: "Ada Lovelace", email: "ada@example.com",
  });
  assert.deepEqual(replyIdentity('"Lovelace, Ada" <Ada@Example.com>'), {
    name: "Lovelace, Ada", email: "ada@example.com",
  });
  // A bare address is not a name, and an RFC 2047 encoded word is not one either.
  assert.deepEqual(replyIdentity("ada@example.com"), { name: "", email: "ada@example.com" });
  assert.equal(replyIdentity("=?UTF-8?B?QWRh?= <ada@example.com>").name, "");
  assert.deepEqual(replyIdentity(""), { name: "", email: "" });
});

/* ══════════════════════════ stream 3: curated-list sequence replies ════════ */

const row = (over = {}) => ({
  sequence_id: "seq1",
  sequence_name: "Post-call curated list",
  candidate_name: "Ada Lovelace",
  ccu_id: "ccu1",
  gmail_id: "g1",
  snippet: "Sounds great, happy to chat.",
  is_archived: false,
  ...over,
});

test("only the curated-list sequences are included, matched by id", () => {
  const events = buildSequenceEvents({
    rows: [row(), row({ sequence_id: "other", gmail_id: "g2" })],
    sequenceIds: ["seq1"],
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].eventId, "g1");
});

test("a renamed sequence still matches, because matching is id-first", () => {
  const events = buildSequenceEvents({
    rows: [row({ sequence_name: "Totally different name" })],
    sequenceIds: ["seq1"],
  });
  assert.equal(events.length, 1);
});

test("an empty allow-list emits nothing rather than every sequence's replies", () => {
  const events = buildSequenceEvents({ rows: [row()], sequenceIds: [] });
  assert.equal(events.length, 0);
});

test("archived replies are excluded by default but can be opted in", () => {
  const rows = [row({ is_archived: true })];
  assert.equal(buildSequenceEvents({ rows, sequenceIds: ["seq1"] }).length, 0);
  assert.equal(
    buildSequenceEvents({ rows, sequenceIds: ["seq1"], includeArchived: true }).length, 1,
  );
});

test("each message is its own event, so a follow-up reply is not silenced", () => {
  // Keying on thread would collapse these into one and lose the second reply.
  const events = buildSequenceEvents({
    rows: [row({ gmail_id: "g1" }), row({ gmail_id: "g2", snippet: "Actually, I'll pass." })],
    sequenceIds: ["seq1"],
  });
  assert.equal(events.length, 2);
  assert.equal(events[0].signal, SIGNAL_INTERESTED);
  assert.equal(events[1].signal, SIGNAL_NOT_INTERESTED);
});

test("the same message seen twice in one feed yields one event", () => {
  const events = buildSequenceEvents({ rows: [row(), row()], sequenceIds: ["seq1"] });
  assert.equal(events.length, 1);
});

test("a sequence event carries the name, snippet and sequence for context", () => {
  const [event] = buildSequenceEvents({ rows: [row()], sequenceIds: ["seq1"] });
  assert.equal(event.stream, STREAM_SEQUENCE);
  assert.equal(event.candidateName, "Ada Lovelace");
  assert.equal(event.candidateUserId, "ccu1");
  assert.equal(event.roleName, "Post-call curated list");
  assert.match(event.replyText, /happy to chat/);
});

test("rows without a message id are skipped rather than guessed", () => {
  const events = buildSequenceEvents({
    rows: [row({ gmail_id: "" }), null], sequenceIds: ["seq1"],
  });
  assert.equal(events.length, 0);
});
