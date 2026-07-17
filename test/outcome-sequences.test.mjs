import assert from "node:assert/strict";
import test from "node:test";

import {
  OUTCOME_SEQUENCE_RULES,
  applyOutcomeMemberships,
  buildOutcomeMembershipIndex,
  createOutcomeSequenceSnapshotLoader,
  readOutcomeSequenceSnapshot,
} from "../api/roster/_lib/outcome-sequences.mjs";

test("outcome sequence rules use the five stable Paraform IDs", () => {
  assert.deepEqual(
    OUTCOME_SEQUENCE_RULES.map((rule) => rule.id),
    [
      "vw168sypaoagu5j5g209cps3",
      "cmqk75h7x00030bj8f5s6oaw8",
      "u5zsfwujwasmmcufdmzem08f",
      "v0ua934p012p3lwpg7610wcz",
      "cmqpje4lh00040cki15nuuqc8",
    ],
  );
});

test("membership index infers the selected outcome by exact candidate ID", () => {
  const result = buildOutcomeMembershipIndex([
    { id: "agent-one", outcome: "Sent List", leads: [{ cu_id: "candidate-a" }] },
    { id: "human-many", outcome: "Sent List", leads: [{ candidate_user_id: "candidate-a" }] },
    { id: "none", outcome: "No Matches - Para AI", leads: [{ candidateUserId: "candidate-b" }] },
  ]);

  assert.equal(result.candidateCount, 2);
  assert.deepEqual(result.memberships.get("candidate-a"), {
    candidateUserId: "candidate-a",
    outcomeComplete: true,
    verifiedOutcome: "Sent List",
    outcomeConflict: false,
    outcomes: ["Sent List"],
    sequenceIds: ["agent-one", "human-many"],
  });
  assert.equal(result.memberships.get("candidate-b").verifiedOutcome, "No Matches - Para AI");
});

test("conflicting outcome memberships complete review without inventing a dropdown value", () => {
  const { memberships } = buildOutcomeMembershipIndex([
    { id: "matches", outcome: "Sent List", leads: [{ cu_id: "candidate-a" }] },
    { id: "none", outcome: "No Matches - Para AI", leads: [{ cu_id: "candidate-a" }] },
  ]);
  const [status] = applyOutcomeMemberships([
    { candidateUserId: "candidate-a", status: "not_added", added: false, ambiguous: false },
  ], memberships);

  assert.equal(status.status, "added");
  assert.equal(status.outcomeComplete, true);
  assert.equal(status.verifiedOutcome, null);
  assert.equal(status.outcomeConflict, true);
});

test("ambiguous names never receive candidate-level outcome proof", () => {
  const { memberships } = buildOutcomeMembershipIndex([
    { id: "matches", outcome: "Sent List", leads: [{ cu_id: "candidate-a" }] },
  ]);
  const [status] = applyOutcomeMemberships([
    { candidateUserId: null, candidateUserIds: ["candidate-a", "candidate-b"], ambiguous: true },
  ], memberships);

  assert.equal(status.outcomeComplete, false);
  assert.equal(status.verifiedOutcome, null);
});

test("sequence reads run for every rule and fail as one authoritative snapshot", async () => {
  const calls = [];
  const snapshot = await readOutcomeSequenceSnapshot({
    rules: [
      { id: "one", outcome: "Sent List" },
      { id: "two", outcome: "No Matches - Para AI" },
    ],
    readLeads: async (id) => {
      calls.push(id);
      return [{ cu_id: `candidate-${id}` }];
    },
  });
  assert.equal(snapshot.complete, true);
  assert.deepEqual(calls.sort(), ["one", "two"]);

  await assert.rejects(
    readOutcomeSequenceSnapshot({
      rules: [{ id: "broken", outcome: "Sent List" }],
      readLeads: async () => { throw new Error("incomplete campaign membership read"); },
    }),
    /incomplete campaign membership read/,
  );
});

test("outcome sequence snapshots are cached and refreshable", async () => {
  let scans = 0;
  let now = 1_000;
  const load = createOutcomeSequenceSnapshotLoader({
    now: () => now,
    ttlMs: 100,
    scan: async () => ({ complete: true, entries: [], scan: ++scans }),
  });

  assert.equal((await load()).scan, 1);
  assert.equal((await load()).cached, true);
  now += 101;
  assert.equal((await load()).scan, 2);
  assert.equal((await load({ refresh: true })).scan, 3);
});
