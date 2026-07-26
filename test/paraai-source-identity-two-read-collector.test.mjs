import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  SOURCE_IDENTITY_TWO_READ_COLLECTOR_VERSION,
  SourceIdentityTwoReadCollectorError,
  collectCandidateUserIdentityTwoRead,
} from "../api/paraai/_lib/source-identity-two-read-collector.mjs";
import {
  candidateUserIdentityPointEvidence,
} from "../api/paraai/_lib/source-identity-point-collector.mjs";
import {
  SOURCE_IDENTITY_POINT_READ_PROCEDURES,
} from "../api/paraai/_lib/source-watermark.mjs";

const CANDIDATE_USER_A = "candidate-user-two-read-a";
const CANDIDATE_USER_B = "candidate-user-two-read-b";
const CANDIDATE_A = "candidate-two-read-a";
const CANDIDATE_B = "candidate-two-read-b";

function rawRecord({
  candidateUserId = CANDIDATE_USER_A,
  candidateId = CANDIDATE_A,
  ...fields
} = {}) {
  return {
    id: candidateUserId,
    candidate: { id: candidateId },
    ...fields,
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function expectCode(error, code, forbidden = []) {
  assert.equal(
    error instanceof SourceIdentityTwoReadCollectorError,
    true,
  );
  assert.equal(error.code, code);
  assert.equal(error.message, code);
  const serialized = JSON.stringify({
    code: error.code,
    message: error.message,
    name: error.name,
  });
  for (const value of forbidden) {
    assert.equal(serialized.includes(value), false);
  }
  return true;
}

function harness({
  firstRaw = rawRecord(),
  secondRaw = rawRecord(),
  firstCheckpoint = null,
  firstCheckpointStatus = "awaiting_read_2",
  completeAfterFirstCheckpoint = false,
  inProgress = false,
  mutateSecondClaim = null,
  secondCheckpointStatus = "resolved",
  startReadNumber = 1,
  persistedFirstEvidence = null,
  trpcGet = null,
} = {}) {
  const work = Object.freeze({
    workKeyDigest: "a".repeat(64),
  });
  const events = [];
  const calls = [];
  const checkpoints = [];
  const unresolved = [];
  const firstClaim = Object.freeze({
    claimNonceDigest: "1".repeat(64),
    contractPinsDigest: "c".repeat(64),
    decisionBoundaryAtMs: 1_000,
    firstEvidence: null,
    privateWorkReference: CANDIDATE_USER_A,
    readNumber: 1,
    runNonceDigest: "b".repeat(64),
    status: "read_required",
    workItemDigest: "d".repeat(64),
    workKeyDigest: work.workKeyDigest,
  });
  let durableFirstEvidence = persistedFirstEvidence;
  let nextReadNumber = startReadNumber;
  let activeReadNumber = null;
  let terminalOutcome = "resolved";
  function durableRecord(status, claim) {
    return Object.freeze({
      contractPinsDigest: claim.contractPinsDigest,
      decisionBoundaryAtMs: claim.decisionBoundaryAtMs,
      privateWorkReference: claim.privateWorkReference,
      runNonceDigest: claim.runNonceDigest,
      status,
      workItemDigest: claim.workItemDigest,
      workKeyDigest: claim.workKeyDigest,
    });
  }
  const dependencies = Object.freeze({
    async claimIdentityObservationReadImpl(input) {
      assert.deepEqual(input, {
        workKeyDigest: work.workKeyDigest,
      });
      assert.equal(Object.isFrozen(input), true);
      if (inProgress) {
        events.push("claim:in_progress");
        return Object.freeze({
          status: "in_progress",
          workKeyDigest: work.workKeyDigest,
        });
      }
      if (nextReadNumber === "complete") {
        events.push("claim:complete");
        return Object.freeze({
          outcome: terminalOutcome,
          status: "complete",
          workKeyDigest: work.workKeyDigest,
        });
      }
      const readNumber = nextReadNumber;
      events.push(`claim:${readNumber}`);
      activeReadNumber = readNumber;
      if (readNumber === 1) return firstClaim;
      assert.equal(readNumber, 2);
      const base = {
        claimNonceDigest: "2".repeat(64),
        contractPinsDigest: "c".repeat(64),
        decisionBoundaryAtMs: 1_000,
        firstEvidence: durableFirstEvidence,
        privateWorkReference: CANDIDATE_USER_A,
        readNumber: 2,
        runNonceDigest: "b".repeat(64),
        status: "read_required",
        workItemDigest: "d".repeat(64),
        workKeyDigest: work.workKeyDigest,
      };
      return Object.freeze(
        mutateSecondClaim ? mutateSecondClaim(base) : base,
      );
    },
    async checkpointIdentityObservationReadImpl(
      claim,
      evidence,
    ) {
      events.push(`checkpoint:${claim.readNumber}`);
      checkpoints.push({ claim, evidence });
      if (claim.readNumber === 1) {
        if (firstCheckpoint) await firstCheckpoint();
        durableFirstEvidence = evidence;
        nextReadNumber = completeAfterFirstCheckpoint
          ? "complete"
          : 2;
        return Object.freeze({
          record: durableRecord(
            firstCheckpointStatus,
            claim,
          ),
        });
      } else {
        nextReadNumber = "complete";
        return Object.freeze({
          record: durableRecord(
            secondCheckpointStatus,
            claim,
          ),
        });
      }
    },
    async recordIdentityObservationUnresolvedImpl(
      claim,
      reasonCode,
    ) {
      events.push(`unresolved:${claim.readNumber}`);
      unresolved.push({ claim, reasonCode });
      nextReadNumber = "complete";
      terminalOutcome = "unresolved";
      return Object.freeze({
        record: durableRecord("unresolved", claim),
      });
    },
    async trpcGetImpl(procedure, input, tries) {
      const readNumber = activeReadNumber;
      events.push(`get:${readNumber}`);
      calls.push({ input, procedure, tries });
      if (trpcGet) {
        return trpcGet({
          input,
          procedure,
          readNumber,
          tries,
        });
      }
      return readNumber === 1 ? firstRaw : secondRaw;
    },
  });
  return {
    calls,
    checkpoints,
    dependencies,
    events,
    unresolved,
    work,
  };
}

test("two sequential exact reads are durably checkpointed and expose no result", async () => {
  const state = harness();
  const result = await collectCandidateUserIdentityTwoRead(
    state.work,
    state.dependencies,
  );

  assert.equal(result, undefined);
  assert.equal(
    SOURCE_IDENTITY_TWO_READ_COLLECTOR_VERSION,
    "candidate-user-identity-two-read-v1",
  );
  assert.deepEqual(state.events, [
    "claim:1",
    "get:1",
    "checkpoint:1",
    "claim:2",
    "get:2",
    "checkpoint:2",
  ]);
  assert.equal(state.calls.length, 2);
  for (const call of state.calls) {
    assert.equal(
      call.procedure,
      SOURCE_IDENTITY_POINT_READ_PROCEDURES
        .candidateUserIdentity,
    );
    assert.deepEqual(call.input, {
      candidate_user_id: CANDIDATE_USER_A,
    });
    assert.equal(Object.isFrozen(call.input), true);
    assert.equal(call.tries, 1);
  }
  assert.equal(state.checkpoints.length, 2);
  assert.deepEqual(
    state.checkpoints[0].evidence,
    state.checkpoints[1].evidence,
  );
  for (const checkpoint of state.checkpoints) {
    const serialized = JSON.stringify(checkpoint.evidence);
    assert.equal(serialized.includes(CANDIDATE_USER_A), false);
    assert.equal(serialized.includes(CANDIDATE_A), false);
    assert.deepEqual(
      Object.keys(checkpoint.evidence).sort(),
      [
        "candidateUserAliasDigest",
        "canonicalCandidateDigest",
        "identityNormalizedInputDigest",
        "identityPointReadProcedure",
        "identityPointRecordDigest",
        "identityPointRecordRevisionDigest",
      ],
    );
  }
});

test("read two cannot be claimed before read one is durably checkpointed", async () => {
  const durable = deferred();
  const state = harness({
    firstCheckpoint: () => durable.promise,
  });
  const collecting = collectCandidateUserIdentityTwoRead(
    state.work,
    state.dependencies,
  );

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(state.events, [
    "claim:1",
    "get:1",
    "checkpoint:1",
  ]);
  assert.equal(state.calls.length, 1);

  durable.resolve();
  await collecting;
  assert.deepEqual(state.events, [
    "claim:1",
    "get:1",
    "checkpoint:1",
    "claim:2",
    "get:2",
    "checkpoint:2",
  ]);
});

test("a retry after durable read one resumes at read two without a repeated provider read", async () => {
  const firstEvidence = candidateUserIdentityPointEvidence(
    rawRecord(),
    { expectedCandidateUserId: CANDIDATE_USER_A },
  );
  const state = harness({
    persistedFirstEvidence: firstEvidence,
    startReadNumber: 2,
  });
  await collectCandidateUserIdentityTwoRead(
    state.work,
    state.dependencies,
  );
  assert.deepEqual(state.events, [
    "claim:2",
    "get:2",
    "checkpoint:2",
  ]);
  assert.equal(state.calls.length, 1);
  assert.equal(state.calls[0].tries, 1);
  assert.equal(state.checkpoints.length, 1);
  assert.equal(state.checkpoints[0].claim.readNumber, 2);
});

test("a retry after durable read two is an explicit no-op with no third provider read", async () => {
  const state = harness();
  await collectCandidateUserIdentityTwoRead(
    state.work,
    state.dependencies,
  );
  assert.equal(state.calls.length, 2);

  const secondResult = await collectCandidateUserIdentityTwoRead(
    state.work,
    state.dependencies,
  );
  assert.equal(secondResult, undefined);
  assert.equal(state.calls.length, 2);
  assert.equal(state.checkpoints.length, 2);
  assert.equal(
    state.events.at(-1),
    "claim:complete",
  );
});

test("a concurrent read-two completion after local read one is an idempotent no-op", async () => {
  const state = harness({
    completeAfterFirstCheckpoint: true,
  });
  await collectCandidateUserIdentityTwoRead(
    state.work,
    state.dependencies,
  );
  assert.deepEqual(state.events, [
    "claim:1",
    "get:1",
    "checkpoint:1",
    "claim:complete",
  ]);
  assert.equal(state.calls.length, 1);
  assert.equal(state.checkpoints.length, 1);
});

test("a durably claimed ordinal is an in-progress no-op with no duplicate provider read", async () => {
  const state = harness({ inProgress: true });
  assert.equal(
    await collectCandidateUserIdentityTwoRead(
      state.work,
      state.dependencies,
    ),
    undefined,
  );
  assert.deepEqual(state.events, ["claim:in_progress"]);
  assert.equal(state.calls.length, 0);
  assert.equal(state.checkpoints.length, 0);
  assert.equal(state.unresolved.length, 0);
});

test("the first read has one attempt and failures stop before a second claim", async () => {
  const vendorSecret = "vendor-secret-first-response";
  const state = harness({
    trpcGet: ({ readNumber }) => {
      assert.equal(readNumber, 1);
      throw new Error(vendorSecret);
    },
  });
  await assert.rejects(
    collectCandidateUserIdentityTwoRead(
      state.work,
      state.dependencies,
    ),
    (error) => expectCode(
      error,
      "SOURCE_IDENTITY_TWO_READ_FIRST_READ_FAILED",
      [vendorSecret, CANDIDATE_USER_A],
    ),
  );
  assert.deepEqual(state.events, [
    "claim:1",
    "get:1",
    "unresolved:1",
  ]);
  assert.equal(state.calls.length, 1);
  assert.equal(state.calls[0].tries, 1);
  assert.equal(
    state.unresolved[0].reasonCode,
    "identity_point_read_failed",
  );
});

test("claim and unresolved-settlement failures expose stable codes only", async () => {
  const claimSecret = "claim-private-store-message";
  const claimStateHarness = harness();
  await assert.rejects(
    collectCandidateUserIdentityTwoRead(
      claimStateHarness.work,
      {
        ...claimStateHarness.dependencies,
        claimIdentityObservationReadImpl: async () => {
          throw new Error(claimSecret);
        },
      },
    ),
    (error) => expectCode(
      error,
      "SOURCE_IDENTITY_TWO_READ_CLAIM_FAILED",
      [claimSecret],
    ),
  );

  const settlementSecret = "settlement-private-store-message";
  const settlementState = harness({
    trpcGet: () => {
      throw new Error("provider-private-message");
    },
  });
  await assert.rejects(
    collectCandidateUserIdentityTwoRead(
      settlementState.work,
      {
        ...settlementState.dependencies,
        recordIdentityObservationUnresolvedImpl: async () => {
          throw new Error(settlementSecret);
        },
      },
    ),
    (error) => expectCode(
      error,
      "SOURCE_IDENTITY_TWO_READ_UNRESOLVED_CHECKPOINT_FAILED",
      [settlementSecret, CANDIDATE_USER_A],
    ),
  );
});

test("read-one durability failure prevents claim and read two", async () => {
  const storeSecret = "store-secret-checkpoint-response";
  const state = harness({
    firstCheckpoint: () => {
      throw new Error(storeSecret);
    },
  });
  await assert.rejects(
    collectCandidateUserIdentityTwoRead(
      state.work,
      state.dependencies,
    ),
    (error) => expectCode(
      error,
      "SOURCE_IDENTITY_TWO_READ_FIRST_CHECKPOINT_FAILED",
      [storeSecret, CANDIDATE_USER_A],
    ),
  );
  assert.deepEqual(state.events, [
    "claim:1",
    "get:1",
    "checkpoint:1",
  ]);
  assert.equal(state.calls.length, 1);
});

test("durable checkpoints must confirm the exact expected state", async () => {
  const firstRejected = harness({
    firstCheckpointStatus: "planned",
  });
  await assert.rejects(
    collectCandidateUserIdentityTwoRead(
      firstRejected.work,
      firstRejected.dependencies,
    ),
    (error) => expectCode(
      error,
      "SOURCE_IDENTITY_TWO_READ_FIRST_CHECKPOINT_REJECTED",
    ),
  );
  assert.equal(firstRejected.calls.length, 1);

  const secondRejected = harness({
    secondCheckpointStatus: "planned",
  });
  await assert.rejects(
    collectCandidateUserIdentityTwoRead(
      secondRejected.work,
      secondRejected.dependencies,
    ),
    (error) => expectCode(
      error,
      "SOURCE_IDENTITY_TWO_READ_SECOND_CHECKPOINT_REJECTED",
    ),
  );
  assert.equal(secondRejected.calls.length, 2);

  const terminalConflict = harness({
    secondCheckpointStatus: "conflict",
  });
  assert.equal(
    await collectCandidateUserIdentityTwoRead(
      terminalConflict.work,
      terminalConflict.dependencies,
    ),
    undefined,
  );
  assert.equal(terminalConflict.calls.length, 2);
});

test("read two must carry the store-persisted exact first evidence", async () => {
  const state = harness({
    mutateSecondClaim: (claim) => ({
      ...claim,
      firstEvidence: {
        ...claim.firstEvidence,
        canonicalCandidateDigest: "f".repeat(64),
      },
    }),
  });
  await assert.rejects(
    collectCandidateUserIdentityTwoRead(
      state.work,
      state.dependencies,
    ),
    (error) => expectCode(
      error,
      "SOURCE_IDENTITY_TWO_READ_PERSISTED_EVIDENCE_MISMATCH",
      [CANDIDATE_USER_A, CANDIDATE_A],
    ),
  );
  assert.deepEqual(state.events, [
    "claim:1",
    "get:1",
    "checkpoint:1",
    "claim:2",
  ]);
  assert.equal(state.calls.length, 1);
  assert.equal(state.checkpoints.length, 1);
});

test("the store cannot switch identities between read claims", async () => {
  const state = harness({
    mutateSecondClaim: (claim) => ({
      ...claim,
      privateWorkReference: CANDIDATE_USER_B,
    }),
  });
  await assert.rejects(
    collectCandidateUserIdentityTwoRead(
      state.work,
      state.dependencies,
    ),
    (error) => expectCode(
      error,
      "SOURCE_IDENTITY_TWO_READ_CLAIM_IDENTITY_MISMATCH",
      [CANDIDATE_USER_A, CANDIDATE_USER_B],
    ),
  );
  assert.equal(state.calls.length, 1);
  assert.equal(state.checkpoints.length, 1);
});

test("the store cannot switch run context between read claims", async () => {
  const state = harness({
    mutateSecondClaim: (claim) => ({
      ...claim,
      contractPinsDigest: "e".repeat(64),
    }),
  });
  await assert.rejects(
    collectCandidateUserIdentityTwoRead(
      state.work,
      state.dependencies,
    ),
    (error) => expectCode(
      error,
      "SOURCE_IDENTITY_TWO_READ_CLAIM_CONTEXT_MISMATCH",
    ),
  );
  assert.equal(state.calls.length, 1);
  assert.equal(state.checkpoints.length, 1);
  assert.equal(state.unresolved.length, 0);
});

test("projection and evidence must be identical across both reads", async () => {
  const state = harness({
    secondRaw: rawRecord({ candidateId: CANDIDATE_B }),
  });
  await assert.rejects(
    collectCandidateUserIdentityTwoRead(
      state.work,
      state.dependencies,
    ),
    (error) => expectCode(
      error,
      "SOURCE_IDENTITY_TWO_READ_UNSTABLE",
      [CANDIDATE_A, CANDIDATE_B],
    ),
  );
  assert.equal(state.calls.length, 2);
  assert.equal(state.checkpoints.length, 1);
  assert.equal(state.unresolved.length, 1);
  assert.equal(
    state.unresolved[0].reasonCode,
    "identity_point_unstable",
  );
  assert.deepEqual(state.events, [
    "claim:1",
    "get:1",
    "checkpoint:1",
    "claim:2",
    "get:2",
    "unresolved:2",
  ]);
});

test("unrelated response fields do not change the exact semantic projection", async () => {
  const state = harness({
    firstRaw: rawRecord({
      email: "first@example.invalid",
      updated_at: "2026-07-26T00:00:00.000Z",
    }),
    secondRaw: rawRecord({
      email: "second@example.invalid",
      updated_at: "2026-07-26T00:00:01.000Z",
    }),
  });
  await collectCandidateUserIdentityTwoRead(
    state.work,
    state.dependencies,
  );
  assert.equal(state.calls.length, 2);
  assert.equal(state.checkpoints.length, 2);
});

test("a second-read vendor failure is sanitized with no retry or third call", async () => {
  const vendorSecret = "vendor-secret-second-response";
  const state = harness({
    trpcGet: ({ readNumber }) => {
      if (readNumber === 1) return rawRecord();
      throw new Error(vendorSecret);
    },
  });
  await assert.rejects(
    collectCandidateUserIdentityTwoRead(
      state.work,
      state.dependencies,
    ),
    (error) => expectCode(
      error,
      "SOURCE_IDENTITY_TWO_READ_SECOND_READ_FAILED",
      [vendorSecret, CANDIDATE_USER_A],
    ),
  );
  assert.equal(state.calls.length, 2);
  assert.deepEqual(
    state.calls.map(({ tries }) => tries),
    [1, 1],
  );
  assert.equal(state.checkpoints.length, 1);
  assert.equal(state.unresolved.length, 1);
  assert.equal(
    state.unresolved[0].reasonCode,
    "identity_point_read_failed",
  );

  await collectCandidateUserIdentityTwoRead(
    state.work,
    state.dependencies,
  );
  assert.equal(state.calls.length, 2);
  assert.equal(state.events.at(-1), "claim:complete");
});

test("malformed point responses and claims are sanitized and fail closed", async () => {
  const invalidResponse = harness({ firstRaw: { id: "private" } });
  await assert.rejects(
    collectCandidateUserIdentityTwoRead(
      invalidResponse.work,
      invalidResponse.dependencies,
    ),
    (error) => expectCode(
      error,
      "SOURCE_IDENTITY_TWO_READ_FIRST_RESPONSE_INVALID",
      ["private", CANDIDATE_USER_A],
    ),
  );
  assert.equal(
    invalidResponse.unresolved[0].reasonCode,
    "identity_point_response_invalid",
  );

  const work = Object.freeze({
    workKeyDigest: "a".repeat(64),
  });
  const dependencies = Object.freeze({
    claimIdentityObservationReadImpl: async () => ({
      claimNonceDigest: "1".repeat(64),
      contractPinsDigest: "c".repeat(64),
      decisionBoundaryAtMs: 1_000,
      firstEvidence: null,
      privateWorkReference: CANDIDATE_USER_A,
      readNumber: 1,
      runNonceDigest: "b".repeat(64),
      status: "read_required",
      workItemDigest: "d".repeat(64),
      workKeyDigest: work.workKeyDigest,
    }),
    checkpointIdentityObservationReadImpl: async () => {},
    recordIdentityObservationUnresolvedImpl: async () => ({
      record: { status: "unresolved" },
    }),
    trpcGetImpl: async () => rawRecord(),
  });
  await assert.rejects(
    collectCandidateUserIdentityTwoRead(work, dependencies),
    (error) => expectCode(
      error,
      "SOURCE_IDENTITY_TWO_READ_CLAIM_INVALID",
      [CANDIDATE_USER_A],
    ),
  );
});

test("only the four exact private test hooks are accepted", async () => {
  const state = harness();
  for (const dependencies of [
    {},
    {
      ...state.dependencies,
      candidateUserId: CANDIDATE_USER_B,
    },
    {
      ...state.dependencies,
      procedure: "caller.selected",
    },
    {
      ...state.dependencies,
      tries: 3,
    },
    {
      ...state.dependencies,
      trpcGetImpl: null,
    },
  ]) {
    await assert.rejects(
      collectCandidateUserIdentityTwoRead(
        state.work,
        dependencies,
      ),
      (error) => expectCode(
        error,
        "SOURCE_IDENTITY_TWO_READ_TEST_DEPENDENCIES_INVALID",
        [CANDIDATE_USER_B],
      ),
    );
  }
  assert.equal(state.calls.length, 0);
});

test("opaque work accepts only the server-issued key projection", async () => {
  const state = harness();
  await assert.rejects(
    collectCandidateUserIdentityTwoRead(
      Object.freeze({
        workKeyDigest: state.work.workKeyDigest,
        candidateUserId: CANDIDATE_USER_B,
      }),
      state.dependencies,
    ),
    (error) => expectCode(
      error,
      "SOURCE_IDENTITY_TWO_READ_WORK_INVALID",
      [CANDIDATE_USER_B],
    ),
  );
  assert.equal(state.calls.length, 0);
});

test("the default private store dependency surface loads without performing I/O", async () => {
  await assert.rejects(
    collectCandidateUserIdentityTwoRead(
      Object.freeze({ workKeyDigest: "invalid" }),
    ),
    (error) => expectCode(
      error,
      "SOURCE_IDENTITY_TWO_READ_WORK_INVALID",
    ),
  );
});

test("the slice is private, silent, hard-dark, and has no release imports", async () => {
  const source = await readFile(
    new URL(
      "../api/paraai/_lib/source-identity-two-read-collector.mjs",
      import.meta.url,
    ),
    "utf8",
  );
  assert.doesNotMatch(source, /\bconsole\./u);
  assert.doesNotMatch(source, /\bfetch\s*\(/u);
  assert.doesNotMatch(source, /\bprocess\.env\b/u);
  assert.doesNotMatch(source, /from ["'][^"']*coordinator/u);
  assert.doesNotMatch(source, /from ["'][^"']*pipeline/u);
  assert.doesNotMatch(source, /from ["'][^"']*curation/u);
  assert.doesNotMatch(source, /from ["'][^"']*enrollment/u);
  assert.doesNotMatch(source, /\breturn\s+first\.evidence\b/u);
  assert.doesNotMatch(source, /\breturn\s+second\.evidence\b/u);
});
