import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  getCompletePhase3ShadowSnapshot,
  getPhase3CandidateSuccessProof,
  saveJob,
  savePhase3ShadowDecision,
  transition,
  upsertPhase3CandidateSuccessProof,
} from "../api/paraai/_lib/store.mjs";

const AT = "2026-07-26T00:00:00.000Z";
const sha1 = (value) => createHash("sha1")
  .update(String(value))
  .digest("hex");

const proofRecord = JSON.stringify({
  version: 1,
  source: "candidate_success_index_v1",
  authoritative: true,
  complete: true,
  bootstrapComplete: true,
  proofVersion: 7,
  conflict: false,
  calls: [{
    endedAt: AT,
    successful: true,
    humanCall: false,
    provenanceVerified: true,
  }],
  updatedAt: AT,
});

const bootstrapRecord = JSON.stringify({
  version: 1,
  status: "complete",
  policyVersion: "phase3-shadow-policy-v1",
  snapshotComplete: true,
  snapshotFingerprint: "a".repeat(40),
  snapshotTotal: 17,
  candidateCount: 17,
  conflicts: 0,
  completedAt: AT,
});

test("candidate proof upsert keeps all three keys before ARGV and returns exact durable digests", async () => {
  const commands = [];
  const result = await upsertPhase3CandidateSuccessProof({
    candidateId: "private-candidate",
    candidateUserId: "private-user",
    endedAt: AT,
    humanCall: false,
    callType: "agent",
    callSourceVerified: true,
    successfulCallVerified: true,
    now: Date.parse(AT),
  }, {
    kvImpl: async (command) => {
      commands.push(command);
      return [
        proofRecord,
        "1785024000",
        "0",
        "1",
        bootstrapRecord,
        "0",
      ];
    },
  });

  const [command] = commands;
  assert.equal(command[0], "EVAL");
  assert.equal(command[2], 3);
  assert.match(command[3], /^paraai:phase3:candidate-success:v1:/u);
  assert.equal(
    command[4],
    "paraai:phase3:candidate-success-bootstrap:v1",
  );
  assert.match(
    command[5],
    /^paraai:phase3:candidate-success-poison:v1:/u,
  );
  assert.deepEqual(JSON.parse(command[6]), {
    endedAt: AT,
    successful: true,
    humanCall: false,
    provenanceVerified: true,
  });
  assert.equal(command[7], AT);
  assert.equal(command[8], AT);
  assert.equal(command.length, 9);
  assert.equal(
    JSON.stringify(command).includes("private-candidate"),
    false,
  );
  assert.equal(JSON.stringify(command).includes("private-user"), false);
  assert.equal(result.proofSemanticDigest, sha1(proofRecord));
  assert.equal(
    result.bootstrapGenerationDigest,
    sha1(bootstrapRecord),
  );
});

test("proof reader binds candidate identity first and fails closed on a poison marker", async () => {
  const commands = [];
  const clean = await getPhase3CandidateSuccessProof({
    candidateId: "canonical-private",
    candidateUserId: "user-one-private",
  }, {
    kvImpl: async (command) => {
      commands.push(command);
      return [proofRecord, bootstrapRecord, "", "1785024000", "0"];
    },
  });
  const poisoned = await getPhase3CandidateSuccessProof({
    candidateId: "canonical-private",
    candidateUserId: "user-two-private",
  }, {
    kvImpl: async (command) => {
      commands.push(command);
      return [
        proofRecord,
        bootstrapRecord,
        JSON.stringify({ version: 1, status: "poisoned" }),
        "1785024000",
        "0",
      ];
    },
  });

  assert.equal(commands[0][2], 3);
  assert.equal(commands[0][3], commands[1][3]);
  assert.equal(commands[0][5], commands[1][5]);
  assert.equal(clean.authoritative, true);
  assert.equal(clean.proofSemanticDigest, sha1(proofRecord));
  assert.equal(clean.bootstrapGenerationDigest, sha1(bootstrapRecord));
  assert.equal(poisoned.quarantined, true);
  assert.equal(poisoned.authoritative, false);
  assert.equal(poisoned.complete, false);
  assert.equal(poisoned.calls.length, 0);
  assert.equal(JSON.stringify(clean).includes("canonical-private"), false);
});

test("a complete global bootstrap never makes a missing candidate proof authoritative", async () => {
  const missing = await getPhase3CandidateSuccessProof({
    candidateId: "canonical-private",
    candidateUserId: "user-private",
  }, {
    kvImpl: async () => [
      "",
      bootstrapRecord,
      "",
      "1785024000",
      "0",
    ],
  });

  assert.equal(missing.bootstrapComplete, true);
  assert.equal(missing.authoritative, false);
  assert.equal(missing.complete, false);
  assert.equal(missing.proofVersion, 0);
  assert.equal(missing.proofSemanticDigest, null);
  assert.deepEqual(missing.calls, []);
});

test("identity removal atomically archives and poisons the old proof without a generic pre-read", async () => {
  const original = {
    id: "proof-job-0001",
    revision: 2,
    state: "resolving_identity",
    identity: {
      candidateId: "candidate-a-private",
      candidateUserId: "user-a-private",
    },
    journal: [],
  };
  const removed = transition(original, "resolving_identity", {
    identity: {},
  });
  assert.equal(removed.phase3CallProofMigration?.version, 1);
  assert.equal(removed.phase3CallProofMigration?.nextKey, null);

  const commands = [];
  const saved = await saveJob(removed, 2, {
    kvImpl: async (command) => {
      commands.push(command);
      return 1;
    },
  });
  assert.equal(commands.length, 1);
  assert.equal(commands[0][0], "EVAL");
  assert.equal(commands[0][2], 6);
  assert.match(commands[0][6], /^paraai:phase3:candidate-success:v1:/u);
  assert.match(
    commands[0][7],
    /^paraai:phase3:candidate-success-quarantine:v1:/u,
  );
  assert.match(
    commands[0][8],
    /^paraai:phase3:candidate-success-poison:v1:/u,
  );
  assert.match(commands[0][1], /redis\.call\('DEL'/u);
  assert.match(commands[0][1], /canonical_identity_changed/u);
  assert.equal(Object.hasOwn(saved, "phase3CallProofMigration"), false);
  assert.equal(
    Object.hasOwn(JSON.parse(commands[0][10]), "phase3CallProofMigration"),
    false,
  );

  const corrected = transition(saved, "resolving_identity", {
    identity: {
      candidateId: "candidate-b-private",
      candidateUserId: "user-b-private",
    },
  });
  assert.equal(Object.hasOwn(corrected, "phase3CallProofMigration"), false);

  const sameCandidate = transition(original, "resolving_identity", {
    identity: {
      candidateId: "candidate-a-private",
      candidateUserId: "different-user-private",
    },
  });
  assert.equal(Object.hasOwn(sameCandidate, "phase3CallProofMigration"), false);

  const movedAway = transition(original, "resolving_identity", {
    identity: {
      candidateId: "candidate-b-private",
      candidateUserId: "user-b-private",
    },
  });
  assert.equal(movedAway.phase3CallProofMigration?.version, 1);
  const movedBackBeforeSave = transition(
    movedAway,
    "resolving_identity",
    {
      identity: {
        candidateId: "candidate-a-private",
        candidateUserId: "user-a-private",
      },
    },
  );
  assert.equal(
    Object.hasOwn(movedBackBeforeSave, "phase3CallProofMigration"),
    false,
  );
  const roundTripCommands = [];
  const roundTripSaved = await saveJob(movedBackBeforeSave, 2, {
    kvImpl: async (command) => {
      roundTripCommands.push(command);
      return 1;
    },
  });
  assert.equal(roundTripCommands.length, 1);
  assert.equal(
    Object.hasOwn(roundTripSaved, "phase3CallProofMigration"),
    false,
  );
  assert.equal(
    Object.hasOwn(
      JSON.parse(roundTripCommands[0][6]),
      "phase3CallProofMigration",
    ),
    false,
  );
});

test("settled Phase 3 save CAS binds version, exact proof raw, bootstrap generation, and poison absence", async () => {
  const job = {
    id: "proof-job-0002",
    revision: 4,
    state: "awaiting_matches",
    identity: {
      candidateId: "candidate-private",
      candidateUserId: "user-private",
    },
    phase3Shadow: {
      policyVersion: "phase3-shadow-policy-v1",
      audit: {
        match: {
          settled: true,
        },
      },
    },
  };
  const proofDigest = sha1(proofRecord);
  const bootstrapDigest = sha1(bootstrapRecord);
  const commands = [];
  await savePhase3ShadowDecision(job, 4, {
    candidateId: "candidate-private",
    candidateUserId: "user-private",
    expectedProofVersion: 7,
    expectedProofSemanticDigest: proofDigest,
    expectedBootstrapGenerationDigest: bootstrapDigest,
  }, {
    kvImpl: async (command) => {
      commands.push(command);
      return 1;
    },
  });
  const [command] = commands;
  assert.equal(command[2], 7);
  assert.match(command[8], /^paraai:phase3:candidate-success-poison:v1:/u);
  assert.equal(command[9], "paraai:phase3:shadow-jobs:v1");
  assert.match(command[1], /redis\.sha1hex\(proofRaw\) ~= ARGV\[8\]/u);
  assert.match(
    command[1],
    /redis\.sha1hex\(bootstrapRaw\) ~= ARGV\[9\]/u,
  );
  assert.equal(command.at(-2), proofDigest);
  assert.equal(command.at(-1), bootstrapDigest);

  await assert.rejects(
    savePhase3ShadowDecision(job, 4, {
      candidateId: "candidate-private",
      candidateUserId: "user-private",
      expectedProofVersion: 7,
      expectedProofSemanticDigest: proofDigest,
      expectedBootstrapGenerationDigest: bootstrapDigest,
    }, {
      kvImpl: async () => -2,
    }),
    (error) => error?.code === "PHASE3_CALL_PROOF_CHANGED",
  );
});

test("dedicated Phase 3 snapshot reads every indexed job without the global 500-row cap", async () => {
  const jobs = Array.from({ length: 600 }, (_, index) => ({
    id: `phase3_job_${String(index).padStart(4, "0")}`,
    revision: index,
    phase3Shadow: {
      policyVersion: "phase3-shadow-policy-v1",
    },
  }));
  const parts = jobs.flatMap((job) => [
    job.id,
    String(job.revision),
  ]);
  const fingerprint = createHash("sha1")
    .update(parts.join("\n"))
    .digest("hex");
  let command;
  const snapshot = await getCompletePhase3ShadowSnapshot({
    kvImpl: async (value) => {
      command = value;
      return [
        String(jobs.length),
        String(jobs.length),
        "0",
        "0",
        fingerprint,
        "1785024000",
        "0",
        ...jobs.map((job) => JSON.stringify(job)),
      ];
    },
  });

  assert.equal(command[0], "EVAL");
  assert.equal(command[3], "paraai:phase3:shadow-jobs:v1");
  assert.match(command[1], /ZRANGE', KEYS\[1\], 0, -1/u);
  assert.equal(command.includes("paraai:index"), false);
  assert.equal(snapshot.snapshotComplete, true);
  assert.equal(snapshot.total, 600);
  assert.equal(snapshot.jobs.length, 600);

  const one = jobs[0];
  const partial = await getCompletePhase3ShadowSnapshot({
    kvImpl: async () => [
      "2",
      "1",
      "1",
      "0",
      createHash("sha1")
        .update(`${one.id}\n${one.revision}`)
        .digest("hex"),
      "1785024000",
      "0",
      JSON.stringify(one),
    ],
  });
  assert.equal(partial.snapshotComplete, false);
  assert.equal(partial.missing, 1);
  assert.equal(partial.jobs.length, 1);
});

test("generic Phase 3 saves atomically retain dedicated-index membership while non-Phase3 saves keep their key shape", async () => {
  const phase3Commands = [];
  await saveJob({
    id: "phase3_job_generic",
    revision: 3,
    state: "awaiting_matches",
    phase3Shadow: {
      policyVersion: "phase3-shadow-policy-v1",
    },
  }, 3, {
    kvImpl: async (command) => {
      phase3Commands.push(command);
      return 1;
    },
  });
  assert.equal(phase3Commands[0][2], 4);
  assert.equal(phase3Commands[0][6], "paraai:phase3:shadow-jobs:v1");
  assert.match(phase3Commands[0][1], /redis\.call\('ZADD', KEYS\[4\]/u);

  const ordinaryCommands = [];
  await saveJob({
    id: "ordinary_job_0001",
    revision: 3,
    state: "extracting",
  }, 3, {
    kvImpl: async (command) => {
      ordinaryCommands.push(command);
      return 1;
    },
  });
  assert.equal(ordinaryCommands[0][2], 3);
  assert.equal(
    ordinaryCommands[0].includes("paraai:phase3:shadow-jobs:v1"),
    false,
  );
});
