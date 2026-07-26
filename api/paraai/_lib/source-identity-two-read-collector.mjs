// Private, hard-dark candidate-user identity two-read collector.
//
// The caller supplies only opaque work created by the private durable store.
// The store selects the candidate-user identifier independently for each
// read. Read one must be durably checkpointed before read two can be claimed.
// This module neither exposes the projection nor returns observation evidence.

import { types as nodeTypes } from "node:util";

import { trpcGet } from "./core.mjs";
import {
  candidateUserIdentityPointEvidence,
  candidateUserIdentityPointReadInput,
  normalizeCandidateUserIdentityPointRecord,
} from "./source-identity-point-collector.mjs";
import {
  SOURCE_IDENTITY_POINT_READ_PROCEDURES,
} from "./source-watermark.mjs";

export const SOURCE_IDENTITY_TWO_READ_COLLECTOR_VERSION =
  "candidate-user-identity-two-read-v1";

const DIGEST = /^[a-f0-9]{64}$/u;
const COMPLETE_CLAIM_KEYS = Object.freeze([
  "outcome",
  "status",
  "workKeyDigest",
]);
const COMPLETE_OUTCOMES = new Set([
  "conflict",
  "resolved",
  "unresolved",
]);
const EVIDENCE_KEYS = Object.freeze([
  "candidateUserAliasDigest",
  "canonicalCandidateDigest",
  "identityNormalizedInputDigest",
  "identityPointReadProcedure",
  "identityPointRecordDigest",
  "identityPointRecordRevisionDigest",
]);
const IN_PROGRESS_CLAIM_KEYS = Object.freeze([
  "status",
  "workKeyDigest",
]);
const READ_REQUIRED_CLAIM_KEYS = Object.freeze([
  "claimNonceDigest",
  "contractPinsDigest",
  "decisionBoundaryAtMs",
  "firstEvidence",
  "privateWorkReference",
  "readNumber",
  "runNonceDigest",
  "status",
  "workItemDigest",
  "workKeyDigest",
]);
const TEST_DEPENDENCY_KEYS = Object.freeze([
  "checkpointIdentityObservationReadImpl",
  "claimIdentityObservationReadImpl",
  "recordIdentityObservationUnresolvedImpl",
  "trpcGetImpl",
].sort());
const WORK_KEYS = Object.freeze(["workKeyDigest"]);

export class SourceIdentityTwoReadCollectorError extends Error {
  constructor(code) {
    super(code);
    this.name = "SourceIdentityTwoReadCollectorError";
    this.code = code;
  }
}

function fail(code) {
  throw new SourceIdentityTwoReadCollectorError(code);
}

function plainRecordSnapshot(value, code) {
  if (
    value === null
    || typeof value !== "object"
    || Array.isArray(value)
    || nodeTypes.isProxy(value)
  ) {
    fail(code);
  }
  const prototype = Object.getPrototypeOf(value);
  if (
    prototype !== Object.prototype
    && prototype !== null
  ) {
    fail(code);
  }
  if (Object.getOwnPropertySymbols(value).length !== 0) {
    fail(code);
  }
  const snapshot = Object.create(null);
  for (const [key, descriptor] of Object.entries(
    Object.getOwnPropertyDescriptors(value),
  )) {
    if (
      !Object.prototype.hasOwnProperty.call(descriptor, "value")
      || descriptor.enumerable !== true
    ) {
      fail(code);
    }
    snapshot[key] = descriptor.value;
  }
  return Object.freeze(snapshot);
}

function exactIdentifier(value, code) {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > 512
    || value.trim() !== value
    || /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    fail(code);
  }
  return value;
}

function sameKeys(actual, expected) {
  if (actual.length !== expected.length) return false;
  return actual.every((key, index) => key === expected[index]);
}

function normalizedEvidence(value, code) {
  const evidence = plainRecordSnapshot(value, code);
  const keys = Object.keys(evidence).sort();
  if (!sameKeys(keys, EVIDENCE_KEYS)) fail(code);
  if (
    evidence.identityPointReadProcedure
      !== SOURCE_IDENTITY_POINT_READ_PROCEDURES
        .candidateUserIdentity
  ) {
    fail(code);
  }
  for (const key of EVIDENCE_KEYS) {
    if (key === "identityPointReadProcedure") continue;
    if (
      typeof evidence[key] !== "string"
      || !DIGEST.test(evidence[key])
    ) {
      fail(code);
    }
  }
  return evidence;
}

function evidenceEqual(leftValue, rightValue, code) {
  const left = normalizedEvidence(leftValue, code);
  const right = normalizedEvidence(rightValue, code);
  return EVIDENCE_KEYS.every(
    (key) => left[key] === right[key],
  );
}

function projectionEqual(left, right) {
  return (
    left.candidateUserId === right.candidateUserId
    && left.globalCandidateId === right.globalCandidateId
  );
}

function claimContextEqual(left, right) {
  return (
    left.workKeyDigest === right.workKeyDigest
    && left.runNonceDigest === right.runNonceDigest
    && left.decisionBoundaryAtMs === right.decisionBoundaryAtMs
    && left.contractPinsDigest === right.contractPinsDigest
    && left.workItemDigest === right.workItemDigest
  );
}

function claimState(claim, expectedWorkKeyDigest) {
  const code = "SOURCE_IDENTITY_TWO_READ_CLAIM_INVALID";
  const snapshot = plainRecordSnapshot(claim, code);
  if (!Object.isFrozen(claim)) fail(code);
  if (snapshot.status === "complete") {
    if (
      !sameKeys(
        Object.keys(snapshot).sort(),
        COMPLETE_CLAIM_KEYS,
      )
      || snapshot.workKeyDigest !== expectedWorkKeyDigest
      || !COMPLETE_OUTCOMES.has(snapshot.outcome)
    ) {
      fail(code);
    }
    return Object.freeze({
      outcome: snapshot.outcome,
      status: "complete",
    });
  }
  if (snapshot.status === "in_progress") {
    if (
      !sameKeys(
        Object.keys(snapshot).sort(),
        IN_PROGRESS_CLAIM_KEYS,
      )
      || snapshot.workKeyDigest !== expectedWorkKeyDigest
    ) {
      fail(code);
    }
    return Object.freeze({ status: "in_progress" });
  }
  if (
    snapshot.status !== "read_required"
    || ![1, 2].includes(snapshot.readNumber)
    || !sameKeys(
      Object.keys(snapshot).sort(),
      READ_REQUIRED_CLAIM_KEYS,
    )
    || snapshot.workKeyDigest !== expectedWorkKeyDigest
    || typeof snapshot.runNonceDigest !== "string"
    || !DIGEST.test(snapshot.runNonceDigest)
    || typeof snapshot.contractPinsDigest !== "string"
    || !DIGEST.test(snapshot.contractPinsDigest)
    || typeof snapshot.workItemDigest !== "string"
    || !DIGEST.test(snapshot.workItemDigest)
    || typeof snapshot.claimNonceDigest !== "string"
    || !DIGEST.test(snapshot.claimNonceDigest)
    || !Number.isSafeInteger(snapshot.decisionBoundaryAtMs)
    || snapshot.decisionBoundaryAtMs < 0
  ) {
    fail(code);
  }
  if (
    !Object.prototype.hasOwnProperty.call(
      snapshot,
      "privateWorkReference",
    )
  ) {
    fail(code);
  }
  return Object.freeze({
    status: "read_required",
    readNumber: snapshot.readNumber,
    workKeyDigest: snapshot.workKeyDigest,
    runNonceDigest: snapshot.runNonceDigest,
    decisionBoundaryAtMs: snapshot.decisionBoundaryAtMs,
    contractPinsDigest: snapshot.contractPinsDigest,
    workItemDigest: snapshot.workItemDigest,
    candidateUserId: exactIdentifier(
      snapshot.privateWorkReference,
      code,
    ),
    firstEvidence: snapshot.readNumber === 1
      ? snapshot.firstEvidence
      : normalizedEvidence(snapshot.firstEvidence, code),
  });
}

function claimedWorkInput(work) {
  const snapshot = plainRecordSnapshot(
    work,
    "SOURCE_IDENTITY_TWO_READ_WORK_INVALID",
  );
  if (
    !Object.isFrozen(work)
    || !sameKeys(Object.keys(snapshot).sort(), WORK_KEYS)
    || typeof snapshot.workKeyDigest !== "string"
    || !DIGEST.test(snapshot.workKeyDigest)
  ) {
    fail("SOURCE_IDENTITY_TWO_READ_WORK_INVALID");
  }
  return Object.freeze({
    workKeyDigest: snapshot.workKeyDigest,
  });
}

async function dependencies(overrides) {
  if (overrides === undefined) {
    try {
      const {
        claimIdentityObservationRead,
        checkpointIdentityObservationRead,
        recordIdentityObservationUnresolved,
      } = await import("./source-identity-artifact-store.mjs");
      if (
        typeof claimIdentityObservationRead !== "function"
        || typeof checkpointIdentityObservationRead
          !== "function"
        || typeof recordIdentityObservationUnresolved
          !== "function"
        || typeof trpcGet !== "function"
      ) {
        fail(
          "SOURCE_IDENTITY_TWO_READ_DEFAULT_DEPENDENCIES_INVALID",
        );
      }
      return Object.freeze({
        claimIdentityObservationReadImpl:
          claimIdentityObservationRead,
        checkpointIdentityObservationReadImpl:
          checkpointIdentityObservationRead,
        recordIdentityObservationUnresolvedImpl:
          recordIdentityObservationUnresolved,
        trpcGetImpl: trpcGet,
      });
    } catch {
      fail(
        "SOURCE_IDENTITY_TWO_READ_DEFAULT_DEPENDENCIES_INVALID",
      );
    }
  }
  const snapshot = plainRecordSnapshot(
    overrides,
    "SOURCE_IDENTITY_TWO_READ_TEST_DEPENDENCIES_INVALID",
  );
  if (
    !sameKeys(
      Object.keys(snapshot).sort(),
      TEST_DEPENDENCY_KEYS,
    )
  ) {
    fail(
      "SOURCE_IDENTITY_TWO_READ_TEST_DEPENDENCIES_INVALID",
    );
  }
  for (const key of TEST_DEPENDENCY_KEYS) {
    if (typeof snapshot[key] !== "function") {
      fail(
        "SOURCE_IDENTITY_TWO_READ_TEST_DEPENDENCIES_INVALID",
      );
    }
  }
  return snapshot;
}

async function sanitizedCall(code, callback) {
  try {
    return await callback();
  } catch {
    fail(code);
  }
}

function durableRecordMatchesClaim(record, claim) {
  return (
    record.workKeyDigest === claim.workKeyDigest
    && record.runNonceDigest === claim.runNonceDigest
    && record.decisionBoundaryAtMs === claim.decisionBoundaryAtMs
    && record.contractPinsDigest === claim.contractPinsDigest
    && record.workItemDigest === claim.workItemDigest
    && record.privateWorkReference
      === claim.privateWorkReference
  );
}

function validateCheckpoint(snapshotValue, readNumber, claim) {
  const code = readNumber === 1
    ? "SOURCE_IDENTITY_TWO_READ_FIRST_CHECKPOINT_REJECTED"
    : "SOURCE_IDENTITY_TWO_READ_SECOND_CHECKPOINT_REJECTED";
  const snapshot = plainRecordSnapshot(snapshotValue, code);
  if (
    !Object.prototype.hasOwnProperty.call(snapshot, "record")
  ) {
    fail(code);
  }
  const record = plainRecordSnapshot(snapshot.record, code);
  if (!durableRecordMatchesClaim(record, claim)) fail(code);
  if (readNumber === 1) {
    if (record.status !== "awaiting_read_2") fail(code);
    return;
  }
  if (!["conflict", "resolved"].includes(record.status)) {
    fail(code);
  }
}

async function recordUnresolvedAndFail(
  claim,
  reasonCode,
  failureCode,
  recordIdentityObservationUnresolvedImpl,
) {
  const snapshot = await sanitizedCall(
    "SOURCE_IDENTITY_TWO_READ_UNRESOLVED_CHECKPOINT_FAILED",
    () => recordIdentityObservationUnresolvedImpl(
      claim,
      reasonCode,
    ),
  );
  const outer = plainRecordSnapshot(
    snapshot,
    "SOURCE_IDENTITY_TWO_READ_UNRESOLVED_CHECKPOINT_REJECTED",
  );
  const record = plainRecordSnapshot(
    outer.record,
    "SOURCE_IDENTITY_TWO_READ_UNRESOLVED_CHECKPOINT_REJECTED",
  );
  if (
    record.status !== "unresolved"
    || !durableRecordMatchesClaim(record, claim)
  ) {
    fail(
      "SOURCE_IDENTITY_TWO_READ_UNRESOLVED_CHECKPOINT_REJECTED",
    );
  }
  fail(failureCode);
}

function projectAndEvidence(raw, candidateUserId, code) {
  try {
    const options = Object.freeze({
      expectedCandidateUserId: candidateUserId,
    });
    const projection =
      normalizeCandidateUserIdentityPointRecord(raw, options);
    const evidence =
      candidateUserIdentityPointEvidence(raw, options);
    normalizedEvidence(evidence, code);
    return Object.freeze({
      projection,
      evidence,
    });
  } catch {
    fail(code);
  }
}

export async function collectCandidateUserIdentityTwoRead(
  work,
  testDependencies,
) {
  const {
    claimIdentityObservationReadImpl,
    checkpointIdentityObservationReadImpl,
    recordIdentityObservationUnresolvedImpl,
    trpcGetImpl,
  } = await dependencies(testDependencies);
  const workInput = claimedWorkInput(work);

  let first = null;
  for (let claimOrdinal = 0; claimOrdinal < 2; claimOrdinal += 1) {
    const claimed = await sanitizedCall(
      first
        ? "SOURCE_IDENTITY_TWO_READ_SECOND_CLAIM_FAILED"
        : "SOURCE_IDENTITY_TWO_READ_CLAIM_FAILED",
      () => claimIdentityObservationReadImpl(
        workInput,
      ),
    );
    const identity = claimState(
      claimed,
      workInput.workKeyDigest,
    );
    if (identity.status === "complete") {
      return;
    }
    if (identity.status === "in_progress") {
      return;
    }
    if (
      (first && identity.readNumber !== 2)
      || (!first && claimOrdinal > 0)
    ) {
      fail("SOURCE_IDENTITY_TWO_READ_READ_SEQUENCE_INVALID");
    }
    if (
      identity.readNumber === 1
      && identity.firstEvidence !== null
    ) {
      fail("SOURCE_IDENTITY_TWO_READ_CLAIM_INVALID");
    }
    if (
      first
      && !claimContextEqual(
        first.claimContext,
        identity,
      )
    ) {
      fail(
        "SOURCE_IDENTITY_TWO_READ_CLAIM_CONTEXT_MISMATCH",
      );
    }
    if (
      first
      && identity.candidateUserId
        !== first.projection.candidateUserId
    ) {
      fail(
        "SOURCE_IDENTITY_TWO_READ_CLAIM_IDENTITY_MISMATCH",
      );
    }
    if (
      first
      && !evidenceEqual(
        first.evidence,
        identity.firstEvidence,
        "SOURCE_IDENTITY_TWO_READ_PERSISTED_EVIDENCE_MISMATCH",
      )
    ) {
      fail(
        "SOURCE_IDENTITY_TWO_READ_PERSISTED_EVIDENCE_MISMATCH",
      );
    }

    const input = candidateUserIdentityPointReadInput(
      identity.candidateUserId,
    );
    const isFirstRead = identity.readNumber === 1;
    let raw;
    try {
      raw = await trpcGetImpl(
        SOURCE_IDENTITY_POINT_READ_PROCEDURES
          .candidateUserIdentity,
        input,
        1,
      );
    } catch {
      await recordUnresolvedAndFail(
        claimed,
        "identity_point_read_failed",
        isFirstRead
          ? "SOURCE_IDENTITY_TWO_READ_FIRST_READ_FAILED"
          : "SOURCE_IDENTITY_TWO_READ_SECOND_READ_FAILED",
        recordIdentityObservationUnresolvedImpl,
      );
    }
    let observation;
    try {
      observation = projectAndEvidence(
        raw,
        identity.candidateUserId,
        isFirstRead
          ? "SOURCE_IDENTITY_TWO_READ_FIRST_RESPONSE_INVALID"
          : "SOURCE_IDENTITY_TWO_READ_SECOND_RESPONSE_INVALID",
      );
    } catch {
      await recordUnresolvedAndFail(
        claimed,
        "identity_point_response_invalid",
        isFirstRead
        ? "SOURCE_IDENTITY_TWO_READ_FIRST_RESPONSE_INVALID"
        : "SOURCE_IDENTITY_TWO_READ_SECOND_RESPONSE_INVALID",
        recordIdentityObservationUnresolvedImpl,
      );
    }

    if (isFirstRead) {
      const checkpoint = await sanitizedCall(
        "SOURCE_IDENTITY_TWO_READ_FIRST_CHECKPOINT_FAILED",
        () => checkpointIdentityObservationReadImpl(
          claimed,
          observation.evidence,
        ),
      );
      validateCheckpoint(checkpoint, 1, claimed);
      first = Object.freeze({
        ...observation,
        claimContext: identity,
      });
      continue;
    }

    if (
      !evidenceEqual(
        identity.firstEvidence,
        observation.evidence,
        "SOURCE_IDENTITY_TWO_READ_UNSTABLE",
      )
      || (
        first
        && !projectionEqual(
          first.projection,
          observation.projection,
        )
      )
    ) {
      await recordUnresolvedAndFail(
        claimed,
        "identity_point_unstable",
        "SOURCE_IDENTITY_TWO_READ_UNSTABLE",
        recordIdentityObservationUnresolvedImpl,
      );
    }
    const checkpoint = await sanitizedCall(
      "SOURCE_IDENTITY_TWO_READ_SECOND_CHECKPOINT_FAILED",
      () => checkpointIdentityObservationReadImpl(
        claimed,
        observation.evidence,
      ),
    );
    validateCheckpoint(checkpoint, 2, claimed);
    return;
  }
  fail("SOURCE_IDENTITY_TWO_READ_READ_SEQUENCE_INVALID");
}
