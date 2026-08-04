import test from "node:test";
import assert from "node:assert/strict";

import {
  SIGNAL_INTERESTED,
  SIGNAL_NOT_INTERESTED,
  SIGNAL_UNCLEAR,
  STREAM_INTEREST,
  STREAM_REQUEST,
  STREAM_SEQUENCE,
  signalFromInterestStatus,
  signalFromReplyText,
  paraformCandidateLink,
  snippet,
  buildNotification,
  notificationDedupeKey,
} from "../api/paraai/_lib/submission-notify.mjs";

/* ─────────────────────────────────────────────── stream 1: interest is a click */

test("Paraform's interest vocabulary maps straight onto ours", () => {
  assert.equal(signalFromInterestStatus("APPLIED_TO_ROLE"), SIGNAL_INTERESTED);
  assert.equal(signalFromInterestStatus("NOT_INTERESTED"), SIGNAL_NOT_INTERESTED);
});

test("an unrecognised interest status is unclear, never guessed", () => {
  for (const value of ["PENDING", "", null, undefined, "SOMETHING_NEW"]) {
    assert.equal(signalFromInterestStatus(value), SIGNAL_UNCLEAR);
  }
});

/* ──────────────────────────────────────── streams 2 and 3: replies as prose */

test("explicit declines are read as not interested", () => {
  const declines = [
    "Thanks but I'm not interested.",
    "I'm going to pass on this one.",
    "This isn't for me, sorry!",
    "Not a good fit for me right now.",
    "I just accepted another offer.",
    "Please remove me from your list.",
  ];
  for (const text of declines) {
    assert.equal(signalFromReplyText(text), SIGNAL_NOT_INTERESTED, text);
  }
});

test("explicit positives are read as interested", () => {
  const positives = [
    "Yes, I'd love to hear more!",
    "I'm interested — when can we chat?",
    "Sounds great, happy to chat.",
    "Tell me more about the role.",
  ];
  for (const text of positives) {
    assert.equal(signalFromReplyText(text), SIGNAL_INTERESTED, text);
  }
});

test("a polite decline is a decline, not interest", () => {
  // The failure that matters: enthusiasm words wrapped around a refusal.
  // Reading this as interest sends David chasing someone who already said no.
  assert.equal(
    signalFromReplyText("Thanks so much, this sounds great, but I'm not interested."),
    SIGNAL_NOT_INTERESTED,
  );
  assert.equal(
    signalFromReplyText("Yes I got your email — I'm going to pass though."),
    SIGNAL_NOT_INTERESTED,
  );
});

test("ambiguous, empty, and automatic replies stay unclear", () => {
  const ambiguous = [
    "",
    "   ",
    null,
    "Out of office until Monday.",
    "What's the salary range?",
    "Can we move this to next week?",
    "Hmm.",
  ];
  for (const text of ambiguous) {
    assert.equal(signalFromReplyText(text), SIGNAL_UNCLEAR, String(text));
  }
});

/* ────────────────────────────────────────────────────────────────── the link */

test("a known candidate id opens that candidate, and the role when we have it", () => {
  assert.equal(
    paraformCandidateLink({ candidateUserId: "cu_1", roleId: "r_1", name: "Ada Lovelace" }),
    "https://www.paraform.com/candidates?id=cu_1&r_id=r_1",
  );
  assert.equal(
    paraformCandidateLink({ candidateUserId: "cu_1" }),
    "https://www.paraform.com/candidates?id=cu_1",
  );
});

test("without an id the link falls back to the name search", () => {
  // Stream 3 has no candidate_user_id to offer, so this path must keep working.
  const link = paraformCandidateLink("Ada Lovelace");
  assert.match(link, /^https:\/\/www\.paraform\.com\/candidates\?/);
  assert.match(link, /q=Ada\+Lovelace/);
  assert.equal(link, paraformCandidateLink({ name: "Ada Lovelace" }));
});

test("a missing name still yields a usable candidates link", () => {
  assert.equal(
    paraformCandidateLink(""),
    "https://www.paraform.com/candidates?sort=added_at%3Adesc",
  );
  assert.equal(
    paraformCandidateLink({}),
    "https://www.paraform.com/candidates?sort=added_at%3Adesc",
  );
});

/* ─────────────────────────────────────────────────────────────── the snippet */

test("snippets collapse whitespace and cap length", () => {
  assert.equal(snippet("hello\n\n  world"), "hello world");
  const long = "x".repeat(500);
  const out = snippet(long);
  assert.ok(out.length <= 180, `got ${out.length}`);
  assert.ok(out.endsWith("…"));
});

/* ────────────────────────────────────────────────────────────── the message */

test("a notification carries the signal, the person, the stream and a link", () => {
  const { text, signal } = buildNotification({
    stream: STREAM_INTEREST,
    candidateName: "Ada Lovelace",
    roleName: "Founding Engineer",
    signal: SIGNAL_INTERESTED,
  });
  assert.equal(signal, SIGNAL_INTERESTED);
  assert.match(text, /Interested/);
  assert.match(text, /Ada Lovelace/);
  assert.match(text, /curated list interest/);
  assert.match(text, /Founding Engineer/);
  assert.match(text, /Open in Paraform/);
});

test("an event that carries a link uses it verbatim rather than a name search", () => {
  const { text } = buildNotification({
    stream: STREAM_REQUEST,
    candidateName: "Ada Lovelace",
    signal: SIGNAL_INTERESTED,
    link: "https://www.paraform.com/candidates?id=cu_1&r_id=r_1",
  });
  assert.match(text, /<https:\/\/www\.paraform\.com\/candidates\?id=cu_1&r_id=r_1\|Open in Paraform>/);
});

test("a nameless event shows the address rather than 'Unknown candidate'", () => {
  const { text } = buildNotification({
    stream: STREAM_REQUEST,
    candidateName: "",
    candidateEmail: "ada@example.com",
    signal: SIGNAL_UNCLEAR,
  });
  assert.match(text, /ada@example\.com/);
  assert.ok(!text.includes("Unknown candidate"), text);
});

test("with neither a name nor an address the message says so plainly", () => {
  const { text } = buildNotification({ stream: STREAM_REQUEST, signal: SIGNAL_UNCLEAR });
  assert.match(text, /Unknown candidate/);
  // And it must not name-search for the placeholder, which returns nothing.
  assert.ok(!text.includes("q=Unknown"), text);
});

test("each stream is labelled distinctly so one channel stays readable", () => {
  const labels = [STREAM_INTEREST, STREAM_REQUEST, STREAM_SEQUENCE].map((stream) =>
    buildNotification({ stream, candidateName: "A", signal: SIGNAL_UNCLEAR }).text);
  assert.equal(new Set(labels).size, 3);
});

test("an unknown or malformed signal degrades to unclear, never to interested", () => {
  for (const bad of ["yes", "INTERESTED", "", null, undefined, 42]) {
    const { signal, text } = buildNotification({
      stream: STREAM_REQUEST, candidateName: "A", signal: bad,
    });
    assert.equal(signal, SIGNAL_UNCLEAR, String(bad));
    assert.match(text, /Unclear/);
  }
});

test("reply text is quoted as a snippet when present, omitted when not", () => {
  const withText = buildNotification({
    stream: STREAM_SEQUENCE, candidateName: "A", signal: SIGNAL_INTERESTED,
    replyText: "Sounds great, happy to chat.",
  }).text;
  assert.match(withText, /^> Sounds great/m);

  // Note: the Slack link syntax <url|label> also contains ">", so assert on the
  // absence of a quote LINE rather than the character.
  const withoutText = buildNotification({
    stream: STREAM_INTEREST, candidateName: "A", signal: SIGNAL_INTERESTED,
  }).text;
  assert.ok(!/^> /m.test(withoutText), withoutText);
});

/* ───────────────────────────────────────────────────────────────── the dedupe */

test("dedupe keys separate stream, candidate and event", () => {
  const a = notificationDedupeKey({ stream: "interest", candidateUserId: "c1", eventId: "e1" });
  const b = notificationDedupeKey({ stream: "interest", candidateUserId: "c1", eventId: "e2" });
  const c = notificationDedupeKey({ stream: "request", candidateUserId: "c1", eventId: "e1" });
  assert.notEqual(a, b, "a new event from the same person must notify again");
  assert.notEqual(a, c, "the same event id in two streams must not collide");
  assert.equal(a, notificationDedupeKey({ stream: "interest", candidateUserId: "c1", eventId: "e1" }));
});

test("dedupe keys are namespaced so they cannot collide with other paraai state", () => {
  assert.match(
    notificationDedupeKey({ stream: "interest", candidateUserId: "c1", eventId: "e1" }),
    /^paraai:subnotify:sent:/,
  );
});
