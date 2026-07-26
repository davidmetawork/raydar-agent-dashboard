// Private, hard-dark Recall point two-read collector.
//
// The caller supplies only one opaque work digest selected by the dedicated
// observation store. The store durably chooses both read ordinals,
// reservations, and the exact private page reference. Read one must be
// checkpointed before read two can be claimed. Terminal work is a no-op, so a
// replay, concurrent invocation, abandoned claim, or lost response can never
// authorize a third Recall point read.
//
// This collector proves only stable point semantics against one already
// verified pass-two reference. It does not classify call success, resolve a
// canonical candidate, prove reference-set coverage, mint a source fact, or
// expose evidence.

import { types as nodeTypes } from "node:util";

import {
  SOURCE_RECALL_POINT_REQUEST_VERSION,
  SOURCE_RECALL_POINT_TRANSPORT_RECEIPT_VERSION,
  readPrivateRecallSourcePoint,
} from "./source-recall-point-client.mjs";
import {
  recallSourcePointEvidence,
} from "./source-recall-point-collector.mjs";
import {
  SOURCE_IDENTITY_POINT_READ_PROCEDURES,
} from "./source-watermark.mjs";

export const SOURCE_RECALL_TWO_READ_COLLECTOR_VERSION =
  "recall-source-point-two-read-v1";

const DIGEST = /^[a-f0-9]{64}$/u;
const BOT_ID = /^[A-Za-z0-9_-]{5,128}$/u;
const COMPLETE_CLAIM_KEYS = Object.freeze([
  "outcome",
  "status",
  "workKeyDigest",
]);
const COMPLETE_OUTCOMES = new Set([
  "conflict",
  "stable",
  "unresolved",
]);
const IN_PROGRESS_CLAIM_KEYS = Object.freeze([
  "status",
  "workKeyDigest",
]);
const READ_REQUIRED_CLAIM_KEYS = Object.freeze([
  "claimNonceDigest",
  "contextDigest",
  "contractPinsDigest",
  "decisionBoundaryAtMs",
  "expectedReference",
  "firstEvidence",
  "readNumber",
  "reservationId",
  "runNonceDigest",
  "status",
  "workItemDigest",
  "workKeyDigest",
]);
const EVIDENCE_KEYS = Object.freeze([
  "candidateIdentityResolutionAvailable",
  "decisionBoundaryDigest",
  "pinnable",
  "source",
  "sourceNormalizedInputDigest",
  "sourcePointReadProcedure",
  "sourceProvenanceDigest",
  "sourceRecordDigest",
  "sourceRecordRevisionDigest",
  "sourceReferenceDigest",
  "sourceStatusAtBoundaryDigest",
  "successClassificationAvailable",
]);
const RECEIPT_KEYS = Object.freeze([
  "contextDigest",
  "readNumber",
  "requestDigest",
  "reservationId",
  "version",
]);
const CLIENT_RESULT_KEYS = Object.freeze([
  "point",
  "transportReceipt",
]);
const CHECKPOINT_INPUT_KEYS = Object.freeze([
  "evidence",
  "transportReceipt",
]);
const WORK_KEYS = Object.freeze(["workKeyDigest"]);
const REFERENCE_KEYS = Object.freeze([
  "candidate",
  "id",
  "joinAt",
  "metadataSource",
]);
const CANDIDATE_KEYS = Object.freeze([
  "email",
  "fullName",
  "linkedin",
  "paraformEventId",
]);
const TEST_DEPENDENCY_KEYS = Object.freeze([
  "checkpointRecallPointObservationReadImpl",
  "claimRecallPointObservationReadImpl",
  "readPrivateRecallSourcePointImpl",
  "recordRecallPointObservationUnresolvedImpl",
].sort());

export class SourceRecallTwoReadCollectorError extends Error {
  constructor(code) {
    super(code);
    this.name = "SourceRecallTwoReadCollectorError";
    this.code = code;
  }
}

function fail(code) {
  throw new SourceRecallTwoReadCollectorError(code);
}

function sameKeys(actual, expected) {
  if (actual.length !== expected.length) return false;
  return actual.every((key, index) => key === expected[index]);
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
  return snapshot;
}

function deepFreeze(value) {
  if (
    value
    && typeof value === "object"
    && !Object.isFrozen(value)
  ) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function exactDigest(value, code) {
  if (typeof value !== "string" || !DIGEST.test(value)) {
    fail(code);
  }
  return value;
}

function canonicalBoundaryFromMs(value, code) {
  if (!Number.isSafeInteger(value) || value < 0) fail(code);
  const boundary = new Date(value).toISOString();
  if (Date.parse(boundary) !== value) fail(code);
  return boundary;
}

function boundedText(
  value,
  {
    code,
    maximum,
    lowercase = false,
  },
) {
  if (
    typeof value !== "string"
    || value.length > maximum
    || value.trim() !== value
    || /[\u0000-\u001f\u007f]/u.test(value)
    || (lowercase && value.toLowerCase() !== value)
  ) {
    fail(code);
  }
  return value;
}

function canonicalReference(value, decisionBoundaryAtMs, code) {
  const reference = plainRecordSnapshot(value, code);
  if (
    !Object.isFrozen(value)
    || !sameKeys(
      Object.keys(reference).sort(),
      [...REFERENCE_KEYS].sort(),
    )
    || typeof reference.id !== "string"
    || !BOT_ID.test(reference.id)
  ) {
    fail(code);
  }
  const candidate = plainRecordSnapshot(reference.candidate, code);
  if (
    !Object.isFrozen(reference.candidate)
    || !sameKeys(
      Object.keys(candidate).sort(),
      [...CANDIDATE_KEYS].sort(),
    )
  ) {
    fail(code);
  }
  const joinAtMs = Date.parse(reference.joinAt);
  if (
    typeof reference.joinAt !== "string"
    || !Number.isFinite(joinAtMs)
    || new Date(joinAtMs).toISOString() !== reference.joinAt
    || joinAtMs >= decisionBoundaryAtMs
  ) {
    fail(code);
  }
  boundedText(reference.metadataSource, {
    code,
    maximum: 128,
  });
  return deepFreeze({
    id: reference.id,
    joinAt: reference.joinAt,
    metadataSource: reference.metadataSource,
    candidate: {
      fullName: boundedText(candidate.fullName, {
        code,
        maximum: 512,
      }),
      email: boundedText(candidate.email, {
        code,
        maximum: 512,
        lowercase: true,
      }),
      linkedin: boundedText(candidate.linkedin, {
        code,
        maximum: 4_096,
      }),
      paraformEventId: boundedText(candidate.paraformEventId, {
        code,
        maximum: 1_024,
      }),
    },
  });
}

function canonicalJson(value) {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      fail("SOURCE_RECALL_TWO_READ_CANONICAL_VALUE_INVALID");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => (
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    )).join(",")}}`;
  }
  fail("SOURCE_RECALL_TWO_READ_CANONICAL_VALUE_INVALID");
}

function normalizedEvidence(value, code) {
  const evidence = plainRecordSnapshot(value, code);
  if (
    !Object.isFrozen(value)
    || !sameKeys(
      Object.keys(evidence).sort(),
      [...EVIDENCE_KEYS].sort(),
    )
    || evidence.source !== "recall"
    || evidence.sourcePointReadProcedure
      !== SOURCE_IDENTITY_POINT_READ_PROCEDURES.recallSource
    || evidence.successClassificationAvailable !== false
    || evidence.candidateIdentityResolutionAvailable !== false
    || evidence.pinnable !== false
  ) {
    fail(code);
  }
  for (const key of EVIDENCE_KEYS) {
    if (
      [
        "candidateIdentityResolutionAvailable",
        "pinnable",
        "source",
        "sourcePointReadProcedure",
        "successClassificationAvailable",
      ].includes(key)
    ) {
      continue;
    }
    exactDigest(evidence[key], code);
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

function canonicalReceipt(value, claim, code) {
  const receipt = plainRecordSnapshot(value, code);
  if (
    !Object.isFrozen(value)
    || !sameKeys(
      Object.keys(receipt).sort(),
      [...RECEIPT_KEYS].sort(),
    )
    || receipt.version
      !== SOURCE_RECALL_POINT_TRANSPORT_RECEIPT_VERSION
    || receipt.reservationId !== claim.reservationId
    || receipt.contextDigest !== claim.contextDigest
    || receipt.readNumber !== claim.readNumber
  ) {
    fail(code);
  }
  exactDigest(receipt.requestDigest, code);
  return receipt;
}

function claimedWorkInput(work) {
  const code = "SOURCE_RECALL_TWO_READ_WORK_INVALID";
  const snapshot = plainRecordSnapshot(work, code);
  if (
    !Object.isFrozen(work)
    || !sameKeys(Object.keys(snapshot).sort(), WORK_KEYS)
  ) {
    fail(code);
  }
  return deepFreeze({
    workKeyDigest: exactDigest(snapshot.workKeyDigest, code),
  });
}

function claimState(claim, expectedWorkKeyDigest) {
  const code = "SOURCE_RECALL_TWO_READ_CLAIM_INVALID";
  const snapshot = plainRecordSnapshot(claim, code);
  if (!Object.isFrozen(claim)) fail(code);
  if (snapshot.status === "complete") {
    if (
      !sameKeys(
        Object.keys(snapshot).sort(),
        [...COMPLETE_CLAIM_KEYS].sort(),
      )
      || snapshot.workKeyDigest !== expectedWorkKeyDigest
      || !COMPLETE_OUTCOMES.has(snapshot.outcome)
    ) {
      fail(code);
    }
    return deepFreeze({
      status: "complete",
      outcome: snapshot.outcome,
    });
  }
  if (snapshot.status === "in_progress") {
    if (
      !sameKeys(
        Object.keys(snapshot).sort(),
        [...IN_PROGRESS_CLAIM_KEYS].sort(),
      )
      || snapshot.workKeyDigest !== expectedWorkKeyDigest
    ) {
      fail(code);
    }
    return deepFreeze({ status: "in_progress" });
  }
  if (
    snapshot.status !== "read_required"
    || !sameKeys(
      Object.keys(snapshot).sort(),
      [...READ_REQUIRED_CLAIM_KEYS].sort(),
    )
    || snapshot.workKeyDigest !== expectedWorkKeyDigest
    || ![1, 2].includes(snapshot.readNumber)
  ) {
    fail(code);
  }
  const decisionBoundaryAt = canonicalBoundaryFromMs(
    snapshot.decisionBoundaryAtMs,
    code,
  );
  const expectedReference = canonicalReference(
    snapshot.expectedReference,
    snapshot.decisionBoundaryAtMs,
    code,
  );
  for (const key of [
    "claimNonceDigest",
    "contextDigest",
    "contractPinsDigest",
    "reservationId",
    "runNonceDigest",
    "workItemDigest",
    "workKeyDigest",
  ]) {
    exactDigest(snapshot[key], code);
  }
  if (
    (snapshot.readNumber === 1
      && snapshot.firstEvidence !== null)
    || (
      snapshot.readNumber === 2
      && snapshot.firstEvidence === null
    )
  ) {
    fail(code);
  }
  const firstEvidence = snapshot.readNumber === 2
    ? normalizedEvidence(snapshot.firstEvidence, code)
    : null;
  return deepFreeze({
    status: "read_required",
    workKeyDigest: snapshot.workKeyDigest,
    runNonceDigest: snapshot.runNonceDigest,
    decisionBoundaryAtMs: snapshot.decisionBoundaryAtMs,
    decisionBoundaryAt,
    contractPinsDigest: snapshot.contractPinsDigest,
    workItemDigest: snapshot.workItemDigest,
    claimNonceDigest: snapshot.claimNonceDigest,
    readNumber: snapshot.readNumber,
    reservationId: snapshot.reservationId,
    contextDigest: snapshot.contextDigest,
    expectedReference,
    firstEvidence,
  });
}

function claimContextEqual(left, right) {
  return (
    left.workKeyDigest === right.workKeyDigest
    && left.runNonceDigest === right.runNonceDigest
    && left.decisionBoundaryAtMs === right.decisionBoundaryAtMs
    && left.contractPinsDigest === right.contractPinsDigest
    && left.workItemDigest === right.workItemDigest
    && left.contextDigest === right.contextDigest
    && canonicalJson(left.expectedReference)
      === canonicalJson(right.expectedReference)
  );
}

async function dependencies(overrides) {
  if (overrides === undefined) {
    try {
      const {
        claimRecallPointObservationRead,
        checkpointRecallPointObservationRead,
        recordRecallPointObservationUnresolved,
      } = await import(
        "./source-recall-point-observation-store.mjs"
      );
      if (
        typeof claimRecallPointObservationRead !== "function"
        || typeof checkpointRecallPointObservationRead !== "function"
        || typeof recordRecallPointObservationUnresolved !== "function"
        || typeof readPrivateRecallSourcePoint !== "function"
      ) {
        fail(
          "SOURCE_RECALL_TWO_READ_DEFAULT_DEPENDENCIES_INVALID",
        );
      }
      return Object.freeze({
        claimRecallPointObservationReadImpl:
          claimRecallPointObservationRead,
        checkpointRecallPointObservationReadImpl:
          checkpointRecallPointObservationRead,
        readPrivateRecallSourcePointImpl:
          readPrivateRecallSourcePoint,
        recordRecallPointObservationUnresolvedImpl:
          recordRecallPointObservationUnresolved,
      });
    } catch {
      fail(
        "SOURCE_RECALL_TWO_READ_DEFAULT_DEPENDENCIES_INVALID",
      );
    }
  }
  const code =
    "SOURCE_RECALL_TWO_READ_TEST_DEPENDENCIES_INVALID";
  const selected = plainRecordSnapshot(overrides, code);
  if (
    !sameKeys(
      Object.keys(selected).sort(),
      TEST_DEPENDENCY_KEYS,
    )
  ) {
    fail(code);
  }
  for (const key of TEST_DEPENDENCY_KEYS) {
    if (typeof selected[key] !== "function") fail(code);
  }
  return Object.freeze(selected);
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
    && record.contextDigest === claim.contextDigest
  );
}

function checkpointRecord(snapshotValue, claim, allowedStatuses, code) {
  const snapshot = plainRecordSnapshot(snapshotValue, code);
  if (!Object.prototype.hasOwnProperty.call(snapshot, "record")) {
    fail(code);
  }
  const record = plainRecordSnapshot(snapshot.record, code);
  if (
    !allowedStatuses.has(record.status)
    || !durableRecordMatchesClaim(record, claim)
  ) {
    fail(code);
  }
  return record;
}

async function recordUnresolvedAndFail(
  claim,
  reason,
  failureCode,
  recordRecallPointObservationUnresolvedImpl,
) {
  const snapshot = await sanitizedCall(
    "SOURCE_RECALL_TWO_READ_UNRESOLVED_CHECKPOINT_FAILED",
    () => recordRecallPointObservationUnresolvedImpl(
      claim,
      reason,
    ),
  );
  checkpointRecord(
    snapshot,
    claim,
    new Set(["unresolved"]),
    "SOURCE_RECALL_TWO_READ_UNRESOLVED_CHECKPOINT_REJECTED",
  );
  fail(failureCode);
}

function pointObservation(clientResult, claim, code) {
  const result = plainRecordSnapshot(clientResult, code);
  if (
    !Object.isFrozen(clientResult)
    || !sameKeys(
      Object.keys(result).sort(),
      [...CLIENT_RESULT_KEYS].sort(),
    )
  ) {
    fail(code);
  }
  let evidence;
  try {
    evidence = recallSourcePointEvidence(
      result.point,
      Object.freeze({
        decisionBoundaryAt: claim.decisionBoundaryAt,
        expectedReference: claim.expectedReference,
      }),
    );
    normalizedEvidence(evidence, code);
    canonicalReceipt(result.transportReceipt, claim, code);
  } catch {
    fail(code);
  }
  return deepFreeze({
    evidence,
    transportReceipt: result.transportReceipt,
  });
}

function checkpointInput(observation) {
  const input = {
    evidence: observation.evidence,
    transportReceipt: observation.transportReceipt,
  };
  if (
    !sameKeys(
      Object.keys(input).sort(),
      [...CHECKPOINT_INPUT_KEYS].sort(),
    )
  ) {
    fail("SOURCE_RECALL_TWO_READ_CHECKPOINT_INPUT_INVALID");
  }
  return deepFreeze(input);
}

export async function collectRecallSourcePointTwoRead(
  work,
  testDependencies,
) {
  const workInput = claimedWorkInput(work);
  const {
    checkpointRecallPointObservationReadImpl,
    claimRecallPointObservationReadImpl,
    readPrivateRecallSourcePointImpl,
    recordRecallPointObservationUnresolvedImpl,
  } = await dependencies(testDependencies);

  let first = null;
  for (let claimOrdinal = 0; claimOrdinal < 2; claimOrdinal += 1) {
    const rawClaim = await sanitizedCall(
      first
        ? "SOURCE_RECALL_TWO_READ_SECOND_CLAIM_FAILED"
        : "SOURCE_RECALL_TWO_READ_CLAIM_FAILED",
      () => claimRecallPointObservationReadImpl(workInput),
    );
    const claim = claimState(
      rawClaim,
      workInput.workKeyDigest,
    );
    if (
      claim.status === "complete"
      || claim.status === "in_progress"
    ) {
      return;
    }
    if (
      (first && claim.readNumber !== 2)
      || (!first && claimOrdinal > 0)
    ) {
      fail("SOURCE_RECALL_TWO_READ_SEQUENCE_INVALID");
    }
    if (
      first
      && (
        !claimContextEqual(first.claim, claim)
        || claim.reservationId === first.claim.reservationId
      )
    ) {
      fail("SOURCE_RECALL_TWO_READ_CLAIM_CONTEXT_MISMATCH");
    }
    if (
      first
      && !evidenceEqual(
        first.observation.evidence,
        claim.firstEvidence,
        "SOURCE_RECALL_TWO_READ_PERSISTED_EVIDENCE_MISMATCH",
      )
    ) {
      fail(
        "SOURCE_RECALL_TWO_READ_PERSISTED_EVIDENCE_MISMATCH",
      );
    }

    const request = deepFreeze({
      version: SOURCE_RECALL_POINT_REQUEST_VERSION,
      reservationId: claim.reservationId,
      contextDigest: claim.contextDigest,
      readNumber: claim.readNumber,
      botId: claim.expectedReference.id,
    });
    const isFirstRead = claim.readNumber === 1;
    let clientResult;
    try {
      clientResult = await readPrivateRecallSourcePointImpl(
        request,
      );
    } catch {
      await recordUnresolvedAndFail(
        rawClaim,
        "point_read_failed",
        isFirstRead
          ? "SOURCE_RECALL_TWO_READ_FIRST_READ_FAILED"
          : "SOURCE_RECALL_TWO_READ_SECOND_READ_FAILED",
        recordRecallPointObservationUnresolvedImpl,
      );
    }
    let observation;
    try {
      observation = pointObservation(
        clientResult,
        claim,
        isFirstRead
          ? "SOURCE_RECALL_TWO_READ_FIRST_RESPONSE_INVALID"
          : "SOURCE_RECALL_TWO_READ_SECOND_RESPONSE_INVALID",
      );
    } catch {
      await recordUnresolvedAndFail(
        rawClaim,
        "point_response_invalid",
        isFirstRead
          ? "SOURCE_RECALL_TWO_READ_FIRST_RESPONSE_INVALID"
          : "SOURCE_RECALL_TWO_READ_SECOND_RESPONSE_INVALID",
        recordRecallPointObservationUnresolvedImpl,
      );
    }

    if (isFirstRead) {
      const snapshot = await sanitizedCall(
        "SOURCE_RECALL_TWO_READ_FIRST_CHECKPOINT_FAILED",
        () => checkpointRecallPointObservationReadImpl(
          rawClaim,
          checkpointInput(observation),
        ),
      );
      checkpointRecord(
        snapshot,
        claim,
        new Set(["awaiting_read_2"]),
        "SOURCE_RECALL_TWO_READ_FIRST_CHECKPOINT_REJECTED",
      );
      first = Object.freeze({ claim, observation });
      continue;
    }

    const stable = evidenceEqual(
      claim.firstEvidence,
      observation.evidence,
      "SOURCE_RECALL_TWO_READ_SECOND_RESPONSE_INVALID",
    );
    const snapshot = await sanitizedCall(
      "SOURCE_RECALL_TWO_READ_SECOND_CHECKPOINT_FAILED",
      () => checkpointRecallPointObservationReadImpl(
        rawClaim,
        checkpointInput(observation),
      ),
    );
    checkpointRecord(
      snapshot,
      claim,
      new Set([stable ? "stable" : "conflict"]),
      "SOURCE_RECALL_TWO_READ_SECOND_CHECKPOINT_REJECTED",
    );
    if (!stable) fail("SOURCE_RECALL_TWO_READ_UNSTABLE");
    return;
  }
  fail("SOURCE_RECALL_TWO_READ_SEQUENCE_INVALID");
}
