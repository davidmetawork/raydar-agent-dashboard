// Private, hard-dark composition for one Recall point observation.
//
// The only runtime input is one server-held opaque sealed-reference run
// handle. This composition always reads pass-two page one, lets the dedicated
// observation store choose the first private reference, and passes only the
// resulting opaque observation work handle to the exact two-read collector.
// It accepts no page, reference, bot, ordinal, reservation, cursor, limit,
// digest override, or force control.
//
// No production route, worker, coordinator, health surface, source tick, or
// release gate imports this module.

import { types as nodeTypes } from "node:util";

import {
  createSourceRecallReferencePersistenceAdapter,
} from "./source-recall-reference-persistence-adapter.mjs";
import {
  createSourceRecallReferencePersistenceProtocol,
} from "./source-recall-reference-persistence-protocol.mjs";
import {
  prepareRecallPointObservationWork,
} from "./source-recall-point-observation-store.mjs";
import {
  collectRecallSourcePointTwoRead,
} from "./source-recall-two-read-collector.mjs";

export const SOURCE_RECALL_POINT_OBSERVATION_RUNTIME_VERSION =
  "recall-point-observation-runtime-dark-v1";

const DIGEST = /^[a-f0-9]{64}$/u;
const REFERENCE_WORK_KEYS = Object.freeze(["workKeyDigest"]);
const PREPARED_SNAPSHOT_KEYS = Object.freeze([
  "raw",
  "rawSha1",
  "record",
  "redisNowMs",
]);
const DEPENDENCY_KEYS = Object.freeze([
  "collectRecallSourcePointTwoReadImpl",
  "prepareRecallPointObservationWorkImpl",
  "readRecallReferencePageImpl",
].sort());

export class SourceRecallPointObservationRuntimeError
  extends Error {
  constructor(code) {
    super(code);
    this.name = "SourceRecallPointObservationRuntimeError";
    this.code = code;
  }
}

function fail(code) {
  throw new SourceRecallPointObservationRuntimeError(code);
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

function referenceWork(value) {
  const code =
    "SOURCE_RECALL_POINT_OBSERVATION_RUNTIME_WORK_INVALID";
  const work = plainRecordSnapshot(value, code);
  if (
    !Object.isFrozen(value)
    || !sameKeys(
      Object.keys(work).sort(),
      REFERENCE_WORK_KEYS,
    )
    || typeof work.workKeyDigest !== "string"
    || !DIGEST.test(work.workKeyDigest)
  ) {
    fail(code);
  }
  return deepFreeze({
    workKeyDigest: work.workKeyDigest,
  });
}

async function dependencies(overrides) {
  if (overrides === undefined) {
    try {
      const persistence =
        createSourceRecallReferencePersistenceAdapter();
      const protocol =
        createSourceRecallReferencePersistenceProtocol({
          persistence,
        });
      if (
        typeof protocol.readRecallReferencePage
          !== "function"
        || typeof prepareRecallPointObservationWork
          !== "function"
        || typeof collectRecallSourcePointTwoRead
          !== "function"
      ) {
        fail(
          "SOURCE_RECALL_POINT_OBSERVATION_RUNTIME_DEFAULT_DEPENDENCIES_INVALID",
        );
      }
      return Object.freeze({
        collectRecallSourcePointTwoReadImpl:
          collectRecallSourcePointTwoRead,
        prepareRecallPointObservationWorkImpl:
          prepareRecallPointObservationWork,
        readRecallReferencePageImpl:
          protocol.readRecallReferencePage,
      });
    } catch {
      fail(
        "SOURCE_RECALL_POINT_OBSERVATION_RUNTIME_DEFAULT_DEPENDENCIES_INVALID",
      );
    }
  }
  const code =
    "SOURCE_RECALL_POINT_OBSERVATION_RUNTIME_TEST_DEPENDENCIES_INVALID";
  const selected = plainRecordSnapshot(overrides, code);
  if (
    !sameKeys(
      Object.keys(selected).sort(),
      DEPENDENCY_KEYS,
    )
  ) {
    fail(code);
  }
  for (const key of DEPENDENCY_KEYS) {
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

function preparedObservationWork(value) {
  const code =
    "SOURCE_RECALL_POINT_OBSERVATION_RUNTIME_PREPARE_RESULT_INVALID";
  const snapshot = plainRecordSnapshot(value, code);
  if (
    !sameKeys(
      Object.keys(snapshot).sort(),
      PREPARED_SNAPSHOT_KEYS,
    )
  ) {
    fail(code);
  }
  const record = plainRecordSnapshot(snapshot.record, code);
  if (
    typeof record.workKeyDigest !== "string"
    || !DIGEST.test(record.workKeyDigest)
    || record.operational !== false
    || record.globalReferenceSetCoverageAvailable !== false
    || record.sourceFactsAvailable !== false
    || record.successClassificationAvailable !== false
    || record.candidateIdentityResolutionAvailable !== false
    || record.pinnable !== false
    || record.authorityAvailable !== false
  ) {
    fail(code);
  }
  return deepFreeze({
    workKeyDigest: record.workKeyDigest,
  });
}

export async function collectFirstRecallPointObservation(
  sealedReferenceWork,
  testDependencies,
) {
  const selected = referenceWork(sealedReferenceWork);
  const {
    collectRecallSourcePointTwoReadImpl,
    prepareRecallPointObservationWorkImpl,
    readRecallReferencePageImpl,
  } = await dependencies(testDependencies);
  const verifiedPage = await sanitizedCall(
    "SOURCE_RECALL_POINT_OBSERVATION_RUNTIME_REFERENCE_READ_FAILED",
    () => readRecallReferencePageImpl(
      deepFreeze({
        workKeyDigest: selected.workKeyDigest,
        pageNumber: 1,
      }),
    ),
  );
  const prepared = await sanitizedCall(
    "SOURCE_RECALL_POINT_OBSERVATION_RUNTIME_PREPARE_FAILED",
    () => prepareRecallPointObservationWorkImpl(
      verifiedPage,
    ),
  );
  const observationWork = preparedObservationWork(prepared);
  await sanitizedCall(
    "SOURCE_RECALL_POINT_OBSERVATION_RUNTIME_COLLECTION_FAILED",
    () => collectRecallSourcePointTwoReadImpl(
      observationWork,
    ),
  );
}
