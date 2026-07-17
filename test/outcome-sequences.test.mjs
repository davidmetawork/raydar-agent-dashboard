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
      attempts: 1,
      readLeads: async () => { throw new Error("incomplete campaign membership read"); },
    }),
    /incomplete campaign membership read/,
  );
});

test("sequence reads retry transient failures without parallel vendor fanout", async () => {
  const calls = [];
  const snapshot = await readOutcomeSequenceSnapshot({
    rules: [
      { id: "one", outcome: "Sent List" },
      { id: "two", outcome: "No Matches - Para AI" },
    ],
    waitImpl: async () => {},
    readLeads: async (id) => {
      calls.push(id);
      if (id === "one" && calls.filter((value) => value === id).length === 1) {
        throw new Error("temporary");
      }
      return [{ cu_id: `candidate-${id}` }];
    },
  });

  assert.equal(snapshot.complete, true);
  assert.deepEqual(calls, ["one", "one", "two"]);
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

test("a recent last-good outcome snapshot survives a transient refresh failure", async () => {
  let scans = 0;
  let now = 1_000;
  const load = createOutcomeSequenceSnapshotLoader({
    now: () => now,
    ttlMs: 100,
    staleMaxAgeMs: 500,
    scan: async () => {
      scans++;
      if (scans > 1) throw new Error("temporary vendor failure");
      return { complete: true, entries: [], scan: scans };
    },
  });

  const fresh = await load();
  now += 101;
  const stale = await load();
  assert.equal(fresh.stale, undefined);
  assert.equal(stale.complete, true);
  assert.equal(stale.cached, true);
  assert.equal(stale.stale, true);

  now += 500;
  await assert.rejects(load(), /temporary vendor failure/);
});
