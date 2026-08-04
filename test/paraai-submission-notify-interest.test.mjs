import test from "node:test";
import assert from "node:assert/strict";

import {
  nameIndex,
  describeRoles,
  buildInterestEvents,
} from "../api/paraai/_lib/submission-notify-interest.mjs";
import { SIGNAL_INTERESTED, STREAM_INTEREST } from "../api/paraai/_lib/submission-notify.mjs";

test("names are indexed from the live curated-list population", () => {
  const index = nameIndex([
    { candidateUserId: "c1", name: "Ada Lovelace" },
    { candidateUserId: "c2", name: "" },
    { candidateUserId: "", name: "Nobody" },
    null,
  ]);
  assert.equal(index.get("c1"), "Ada Lovelace");
  assert.equal(index.has("c2"), false, "a blank name must not be indexed");
  assert.equal(index.size, 1);
});

test("roles are described by shape, never as raw ids", () => {
  assert.equal(describeRoles(["r1"]), "1 role");
  assert.equal(describeRoles(["r1", "r2", "r3"]), "3 roles");
  assert.equal(describeRoles([]), "");
  assert.equal(describeRoles(undefined), "");
  // The point: an opaque id must never reach Slack looking like a role name.
  assert.ok(!describeRoles(["role_abc123"]).includes("role_abc123"));
});

test("a record becomes one interested event carrying the resolved name", () => {
  const events = buildInterestEvents({
    records: [{ candidateUserId: "c1", batchId: "b1", roles: ["r1", "r2"] }],
    names: nameIndex([{ candidateUserId: "c1", name: "Ada Lovelace" }]),
  });
  assert.equal(events.length, 1);
  assert.deepEqual(events[0], {
    stream: STREAM_INTEREST,
    candidateUserId: "c1",
    candidateName: "Ada Lovelace",
    eventId: "b1",
    signal: SIGNAL_INTERESTED,
    roleName: "2 roles",
    link: "https://www.paraform.com/candidates?id=c1",
  });
});

test("interest links open the candidate by id, not a name search", () => {
  // The interest lane is PII-light, so the name can be missing — and that is
  // exactly when a name-search link would be worthless.
  const [event] = buildInterestEvents({
    records: [{ candidateUserId: "c9", batchId: "b9", roles: ["r1"] }],
    names: new Map(),
  });
  assert.equal(event.candidateName, "");
  assert.equal(event.link, "https://www.paraform.com/candidates?id=c9");
});

test("the same batch seen as both a live job and an archived handoff is ONE event", () => {
  // This is the real shape of the data: a job archives to a handoff, and a run
  // can scan both indexes and see the same batch twice.
  const events = buildInterestEvents({
    records: [
      { candidateUserId: "c1", batchId: "b1", roles: ["r1"] },
      { candidateUserId: "c1", batchId: "b1", roles: ["r1"] },
    ],
    names: new Map([["c1", "Ada"]]),
  });
  assert.equal(events.length, 1);
});

test("a genuinely new batch for the same candidate is a separate event", () => {
  const events = buildInterestEvents({
    records: [
      { candidateUserId: "c1", batchId: "b1", roles: ["r1"] },
      { candidateUserId: "c1", batchId: "b2", roles: ["r2"] },
    ],
    names: new Map([["c1", "Ada"]]),
  });
  assert.equal(events.length, 2);
  assert.deepEqual(events.map((e) => e.eventId), ["b1", "b2"]);
});

test("records without a candidate or a batch are skipped, not guessed", () => {
  const events = buildInterestEvents({
    records: [
      { candidateUserId: "", batchId: "b1" },
      { candidateUserId: "c1", batchId: "" },
      null,
      {},
    ],
  });
  assert.equal(events.length, 0);
});

test("an unresolved name still produces an event rather than dropping it", () => {
  // Losing the notification because a name lookup missed would be worse than
  // a message that says Unknown candidate.
  const events = buildInterestEvents({
    records: [{ candidateUserId: "c9", batchId: "b1", roles: ["r1"] }],
    names: new Map(),
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].candidateName, "");
});
