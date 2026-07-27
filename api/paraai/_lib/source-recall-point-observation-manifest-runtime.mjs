// Private, hard-dark composition for one full-manifest Recall observation
// step.
//
// The only runtime input is one frozen server-held sealed-reference work
// handle. The runtime re-proves the exact sealed head, then permits the
// manifest store to choose either the next page to index or the next indexed
// point work to observe. It accepts no page, ordinal, reference, bot, cursor,
// limit, digest replacement, batch size, reservation, or force control.
//
// No production route, worker, coordinator, health surface, source tick, or
// release gate imports this module.

import {
  types as nodeTypes,
} from "node:util";

import {
  createSourceRecallReferencePersistenceAdapter,
} from "./source-recall-reference-persistence-adapter.mjs";
import {
  createSourceRecallReferencePersistenceProtocol,
} from "./source-recall-reference-persistence-protocol.mjs";
import {
  checkpointRecallPointObservationManifestPage,
  checkpointRecallPointObservationManifestWork,
  claimRecallPointObservationManifestStep,
  ensureRecallPointObservationManifest,
  prepareRecallPointObservationManifestSelection,
} from "./source-recall-point-observation-manifest-store.mjs";
import {
  collectRecallSourcePointTwoRead,
} from "./source-recall-two-read-collector.mjs";

export const SOURCE_RECALL_POINT_OBSERVATION_MANIFEST_RUNTIME_VERSION =
  "recall-point-observation-manifest-runtime-dark-v1";

const DIGEST = /^[a-f0-9]{64}$/u;
const SEALED_WORK_KEYS = Object.freeze(["workKeyDigest"]);
const MANIFEST_SNAPSHOT_KEYS = Object.freeze([
  "raw",
  "rawSha1",
  "record",
  "redisNowMs",
]);
const AGGREGATE_KEYS = Object.freeze([
  "authorityAvailable",
  "candidateIdentityResolutionAvailable",
  "globalReferenceSetCoverageAvailable",
  "inProgress",
  "operational",
  "pageCount",
  "pagesIndexed",
  "pinnable",
  "referenceCount",
  "referenceManifestCoverageComplete",
  "referencesConflict",
  "referencesIndexed",
  "referencesSettled",
  "referencesStable",
  "referencesUnresolved",
  "settledReadsCompleted",
  "sourceFactsAvailable",
  "status",
  "successClassificationAvailable",
]);
const TERMINAL_CLAIM_KEYS = Object.freeze([
  "aggregate",
  "status",
]);
const STEP_CLAIM_KEYS = Object.freeze([
  "pageNumber",
  "referenceOrdinal",
  "status",
  "workKeyDigest",
]);
const DEPENDENCY_KEYS = Object.freeze([
  "checkpointManifestPageImpl",
  "checkpointManifestWorkImpl",
  "claimManifestStepImpl",
  "collectPointTwoReadImpl",
  "ensureManifestImpl",
  "prepareManifestSelectionImpl",
  "readRecallReferenceHeadImpl",
  "readRecallReferencePageImpl",
].sort());

export class SourceRecallPointObservationManifestRuntimeError
  extends Error {
  constructor(code) {
    super(code);
    this.name =
      "SourceRecallPointObservationManifestRuntimeError";
    this.code = code;
  }
}

function fail(code) {
  throw new SourceRecallPointObservationManifestRuntimeError(code);
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

function exactRecord(value, keys, code) {
  const record = plainRecordSnapshot(value, code);
  if (
    !sameKeys(
      Object.keys(record).sort(),
      [...keys].sort(),
    )
  ) {
    fail(code);
  }
  return record;
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

function safeInteger(value, code) {
  if (!Number.isSafeInteger(value) || value < 0) fail(code);
  return value;
}

function sealedWork(value) {
  const code =
    "SOURCE_RECALL_POINT_OBSERVATION_MANIFEST_RUNTIME_WORK_INVALID";
  const work = exactRecord(value, SEALED_WORK_KEYS, code);
  if (!Object.isFrozen(value)) fail(code);
  return deepFreeze({
    workKeyDigest: exactDigest(work.workKeyDigest, code),
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
      const selected = {
        checkpointManifestPageImpl:
          checkpointRecallPointObservationManifestPage,
        checkpointManifestWorkImpl:
          checkpointRecallPointObservationManifestWork,
        claimManifestStepImpl:
          claimRecallPointObservationManifestStep,
        collectPointTwoReadImpl:
          collectRecallSourcePointTwoRead,
        ensureManifestImpl:
          ensureRecallPointObservationManifest,
        prepareManifestSelectionImpl:
          prepareRecallPointObservationManifestSelection,
        readRecallReferenceHeadImpl:
          protocol.readRecallReferenceHead,
        readRecallReferencePageImpl:
          protocol.readRecallReferencePage,
      };
      for (const key of DEPENDENCY_KEYS) {
        if (typeof selected[key] !== "function") {
          fail(
            "SOURCE_RECALL_POINT_OBSERVATION_MANIFEST_RUNTIME_DEFAULT_DEPENDENCIES_INVALID",
          );
        }
      }
      return Object.freeze(selected);
    } catch {
      fail(
        "SOURCE_RECALL_POINT_OBSERVATION_MANIFEST_RUNTIME_DEFAULT_DEPENDENCIES_INVALID",
      );
    }
  }
  const code =
    "SOURCE_RECALL_POINT_OBSERVATION_MANIFEST_RUNTIME_TEST_DEPENDENCIES_INVALID";
  const selected = exactRecord(
    overrides,
    DEPENDENCY_KEYS,
    code,
  );
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

function manifestWork(value) {
  const code =
    "SOURCE_RECALL_POINT_OBSERVATION_MANIFEST_RUNTIME_ENSURE_RESULT_INVALID";
  const snapshot = exactRecord(
    value,
    MANIFEST_SNAPSHOT_KEYS,
    code,
  );
  const record = plainRecordSnapshot(snapshot.record, code);
  if (
    typeof record.manifestKeyDigest !== "string"
    || !DIGEST.test(record.manifestKeyDigest)
    || record.operational !== false
    || record.sourceFactsAvailable !== false
    || record.successClassificationAvailable !== false
    || record.candidateIdentityResolutionAvailable !== false
    || record.pinnable !== false
    || record.authorityAvailable !== false
  ) {
    fail(code);
  }
  return deepFreeze({
    manifestKeyDigest: record.manifestKeyDigest,
  });
}

function aggregate(value) {
  const code =
    "SOURCE_RECALL_POINT_OBSERVATION_MANIFEST_RUNTIME_AGGREGATE_INVALID";
  const raw = exactRecord(value, AGGREGATE_KEYS, code);
  for (const key of [
    "pageCount",
    "pagesIndexed",
    "referenceCount",
    "referencesConflict",
    "referencesIndexed",
    "referencesSettled",
    "referencesStable",
    "referencesUnresolved",
    "settledReadsCompleted",
  ]) {
    safeInteger(raw[key], code);
  }
  if (
    ![
      "indexing_pages",
      "observing",
      "verifying_complete",
      "observed_complete_dark",
    ].includes(raw.status)
    || typeof raw.inProgress !== "boolean"
    || typeof raw.referenceManifestCoverageComplete
      !== "boolean"
    || typeof raw.globalReferenceSetCoverageAvailable
      !== "boolean"
    || raw.operational !== false
    || raw.sourceFactsAvailable !== false
    || raw.successClassificationAvailable !== false
    || raw.candidateIdentityResolutionAvailable !== false
    || raw.pinnable !== false
    || raw.authorityAvailable !== false
    || raw.pagesIndexed > raw.pageCount
    || raw.referencesIndexed > raw.referenceCount
    || raw.referencesSettled > raw.referencesIndexed
    || raw.referencesStable
      + raw.referencesConflict
      + raw.referencesUnresolved
      !== raw.referencesSettled
    || raw.globalReferenceSetCoverageAvailable
      && (
        !raw.referenceManifestCoverageComplete
        || raw.referencesStable !== raw.referenceCount
        || raw.referencesConflict !== 0
        || raw.referencesUnresolved !== 0
      )
  ) {
    fail(code);
  }
  return deepFreeze({ ...raw });
}

function claim(value) {
  const code =
    "SOURCE_RECALL_POINT_OBSERVATION_MANIFEST_RUNTIME_CLAIM_INVALID";
  const raw = plainRecordSnapshot(value, code);
  if (!Object.isFrozen(value)) fail(code);
  if (
    ["complete", "in_progress"].includes(raw.status)
  ) {
    if (
      !sameKeys(
        Object.keys(raw).sort(),
        [...TERMINAL_CLAIM_KEYS].sort(),
      )
    ) {
      fail(code);
    }
    return deepFreeze({
      aggregate: aggregate(raw.aggregate),
      privateClaim: value,
      status: raw.status,
    });
  }
  if (
    !sameKeys(
      Object.keys(raw).sort(),
      [...STEP_CLAIM_KEYS].sort(),
    )
    || ![
      "page_required",
      "observation_required",
    ].includes(raw.status)
    || !Number.isSafeInteger(raw.pageNumber)
    || raw.pageNumber < 1
    || raw.pageNumber > 200
  ) {
    fail(code);
  }
  if (
    raw.status === "page_required"
    && (
      raw.referenceOrdinal !== null
      || raw.workKeyDigest !== null
    )
  ) {
    fail(code);
  }
  if (
    raw.status === "observation_required"
    && (
      !Number.isSafeInteger(raw.referenceOrdinal)
      || raw.referenceOrdinal < 0
      || raw.referenceOrdinal >= 100
      || typeof raw.workKeyDigest !== "string"
      || !DIGEST.test(raw.workKeyDigest)
    )
  ) {
    fail(code);
  }
  return deepFreeze({
    pageNumber: raw.pageNumber,
    privateClaim: value,
    referenceOrdinal: raw.referenceOrdinal,
    status: raw.status,
    workKeyDigest: raw.workKeyDigest,
  });
}

function pointWork(value) {
  const code =
    "SOURCE_RECALL_POINT_OBSERVATION_MANIFEST_RUNTIME_POINT_WORK_INVALID";
  const raw = exactRecord(value, SEALED_WORK_KEYS, code);
  if (!Object.isFrozen(value)) fail(code);
  return deepFreeze({
    workKeyDigest: exactDigest(raw.workKeyDigest, code),
  });
}

export async function collectRecallPointObservationManifestStep(
  sealedReferenceWork,
  testDependencies,
) {
  const selected = sealedWork(sealedReferenceWork);
  const {
    checkpointManifestPageImpl,
    checkpointManifestWorkImpl,
    claimManifestStepImpl,
    collectPointTwoReadImpl,
    ensureManifestImpl,
    prepareManifestSelectionImpl,
    readRecallReferenceHeadImpl,
    readRecallReferencePageImpl,
  } = await dependencies(testDependencies);
  const verifiedHead = await sanitizedCall(
    "SOURCE_RECALL_POINT_OBSERVATION_MANIFEST_RUNTIME_HEAD_READ_FAILED",
    () => readRecallReferenceHeadImpl(selected),
  );
  const manifestSnapshot = await sanitizedCall(
    "SOURCE_RECALL_POINT_OBSERVATION_MANIFEST_RUNTIME_ENSURE_FAILED",
    () => ensureManifestImpl(verifiedHead),
  );
  const selectedManifestWork = manifestWork(
    manifestSnapshot,
  );
  const selectedClaim = claim(await sanitizedCall(
    "SOURCE_RECALL_POINT_OBSERVATION_MANIFEST_RUNTIME_CLAIM_FAILED",
    () => claimManifestStepImpl(selectedManifestWork),
  ));
  if (
    selectedClaim.status === "complete"
    || selectedClaim.status === "in_progress"
  ) {
    return selectedClaim.aggregate;
  }
  const verifiedPage = await sanitizedCall(
    "SOURCE_RECALL_POINT_OBSERVATION_MANIFEST_RUNTIME_PAGE_READ_FAILED",
    () => readRecallReferencePageImpl(deepFreeze({
      pageNumber: selectedClaim.pageNumber,
      workKeyDigest: selected.workKeyDigest,
    })),
  );
  if (selectedClaim.status === "page_required") {
    return aggregate(await sanitizedCall(
      "SOURCE_RECALL_POINT_OBSERVATION_MANIFEST_RUNTIME_PAGE_CHECKPOINT_FAILED",
      () => checkpointManifestPageImpl(
        selectedClaim.privateClaim,
        verifiedPage,
      ),
    ));
  }
  const selectedPointWork = pointWork(
    await sanitizedCall(
      "SOURCE_RECALL_POINT_OBSERVATION_MANIFEST_RUNTIME_POINT_PREPARE_FAILED",
      () => prepareManifestSelectionImpl(
        selectedClaim.privateClaim,
        verifiedPage,
      ),
    ),
  );
  let collectionFailed = false;
  try {
    await collectPointTwoReadImpl(selectedPointWork);
  } catch {
    collectionFailed = true;
  }
  try {
    return aggregate(
      await checkpointManifestWorkImpl(
        selectedClaim.privateClaim,
      ),
    );
  } catch {
    fail(
      collectionFailed
        ? "SOURCE_RECALL_POINT_OBSERVATION_MANIFEST_RUNTIME_COLLECTION_FAILED"
        : "SOURCE_RECALL_POINT_OBSERVATION_MANIFEST_RUNTIME_WORK_CHECKPOINT_FAILED",
    );
  }
}
