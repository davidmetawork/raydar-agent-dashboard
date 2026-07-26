// Hard-dark Recall reference collector.
//
// One invocation advances at most one protocol-selected page claim. An
// injected, separately reviewed persistence implementation must prove that
// claim before this module performs the single private Calls POST. No such
// production adapter is supplied here. Only an aggregate result leaves the
// collector, which is not imported by a coordinator or HTTP route.

import {
  performance,
} from "node:perf_hooks";
import {
  types as nodeTypes,
} from "node:util";

import {
  readPrivateRecallSourcePage,
} from "./source-recall-page-client.mjs";

export const SOURCE_RECALL_REFERENCE_COLLECTOR_VERSION =
  "recall-reference-two-pass-collector-dark-v1";

const DIGEST = /^[a-f0-9]{64}$/u;
const WORK_KEYS = Object.freeze(["workKeyDigest"]);
const FACTORY_KEYS = Object.freeze(["protocol"]);
const PROTOCOL_KEYS = Object.freeze([
  "claimRecallReferencePage",
  "checkpointRecallReferencePage",
  "ensureRecallReferenceRun",
  "readRecallReferenceHead",
  "recallReferenceAggregateStatus",
  "recordRecallReferencePageFailure",
]);
const DEPENDENCY_KEYS = Object.freeze([
  "claimRecallReferencePageImpl",
  "checkpointRecallReferencePageImpl",
  "readPrivateRecallSourcePageImpl",
  "recordRecallReferencePageFailureImpl",
]);
const REQUIRED_CLAIM_KEYS = Object.freeze([
  "boundaryAt",
  "claimNonceDigest",
  "cursor",
  "pageNumber",
  "passNumber",
  "requestDigest",
  "seenCursors",
  "sourceReadStartDeadlineMonotonicMs",
  "status",
  "workKeyDigest",
]);
const COMPLETE_CLAIM_KEYS = Object.freeze([
  "aggregate",
  "outcome",
  "status",
]);
const IN_PROGRESS_CLAIM_KEYS = Object.freeze([
  "aggregate",
  "status",
]);
const CHECKPOINT_RESULT_KEYS = Object.freeze([
  "aggregate",
  "snapshot",
]);
const AGGREGATE_KEYS = Object.freeze([
  "authorityAvailable",
  "candidateIdentityResolutionAvailable",
  "completedPasses",
  "headSealed",
  "inProgress",
  "operational",
  "pageCount",
  "pinnable",
  "pointReadAvailable",
  "referenceCount",
  "requiredPasses",
  "scannedCount",
  "serverSelected",
  "sourceFactsAvailable",
  "status",
  "successClassificationAvailable",
]);
const TERMINAL_OUTCOMES = new Set([
  "invalidated",
  "sealed_unpinnable",
]);

export class SourceRecallReferenceCollectorError extends Error {
  constructor(code) {
    super(code);
    this.name = "SourceRecallReferenceCollectorError";
    this.code = code;
  }
}

function fail(code) {
  throw new SourceRecallReferenceCollectorError(code);
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
  if (Object.getOwnPropertySymbols(value).length !== 0) fail(code);
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
  if (!sameKeys(Object.keys(record).sort(), [...keys].sort())) {
    fail(code);
  }
  return record;
}

function workInput(value) {
  const code = "SOURCE_RECALL_REFERENCE_WORK_INVALID";
  const work = exactRecord(value, WORK_KEYS, code);
  if (
    !Object.isFrozen(value)
    || typeof work.workKeyDigest !== "string"
    || !DIGEST.test(work.workKeyDigest)
  ) {
    fail(code);
  }
  return Object.freeze({
    workKeyDigest: work.workKeyDigest,
  });
}

function dependencies(value) {
  const code = "SOURCE_RECALL_REFERENCE_DEPENDENCIES_INVALID";
  if (value === undefined) fail(code);
  const selected = exactRecord(value, DEPENDENCY_KEYS, code);
  if (
    DEPENDENCY_KEYS.some(
      (key) => typeof selected[key] !== "function",
    )
  ) {
    fail(code);
  }
  return selected;
}

function aggregateState(value, code) {
  const aggregate = exactRecord(value, AGGREGATE_KEYS, code);
  const safe = {
    status: aggregate.status,
    operational: aggregate.operational,
    serverSelected: aggregate.serverSelected,
    completedPasses: aggregate.completedPasses,
    requiredPasses: aggregate.requiredPasses,
    pageCount: aggregate.pageCount,
    scannedCount: aggregate.scannedCount,
    referenceCount: aggregate.referenceCount,
    inProgress: aggregate.inProgress,
    headSealed: aggregate.headSealed,
    pointReadAvailable: aggregate.pointReadAvailable,
    sourceFactsAvailable: aggregate.sourceFactsAvailable,
    successClassificationAvailable:
      aggregate.successClassificationAvailable,
    candidateIdentityResolutionAvailable:
      aggregate.candidateIdentityResolutionAvailable,
    pinnable: aggregate.pinnable,
    authorityAvailable: aggregate.authorityAvailable,
  };
  if (
    !["collecting", "invalidated", "sealed_unpinnable"]
      .includes(safe.status)
    || !Number.isSafeInteger(safe.completedPasses)
    || safe.completedPasses < 0
    || safe.completedPasses > 2
    || safe.requiredPasses !== 2
    || !Number.isSafeInteger(safe.pageCount)
    || safe.pageCount < 0
    || !Number.isSafeInteger(safe.scannedCount)
    || safe.scannedCount < 0
    || !Number.isSafeInteger(safe.referenceCount)
    || safe.referenceCount < 0
    || typeof safe.inProgress !== "boolean"
    || typeof safe.headSealed !== "boolean"
    || safe.referenceCount > safe.scannedCount
    || safe.operational !== false
    || safe.serverSelected !== true
    || safe.pointReadAvailable !== false
    || safe.sourceFactsAvailable !== false
    || safe.successClassificationAvailable !== false
    || safe.candidateIdentityResolutionAvailable !== false
    || safe.pinnable !== false
    || safe.authorityAvailable !== false
    || (
      safe.status === "collecting"
      && (
        safe.completedPasses > 1
        || safe.headSealed
      )
    )
    || (
      safe.status === "invalidated"
      && (
        safe.inProgress
        || safe.headSealed
      )
    )
    || (
      safe.status === "sealed_unpinnable"
      && (
        safe.completedPasses !== 2
        || safe.inProgress
        || !safe.headSealed
        || safe.pageCount < 1
      )
    )
  ) {
    fail(code);
  }
  return Object.freeze(safe);
}

function claimState(value, expectedWorkKeyDigest) {
  const code = "SOURCE_RECALL_REFERENCE_CLAIM_INVALID";
  const claim = plainRecordSnapshot(value, code);
  if (!Object.isFrozen(value)) fail(code);
  if (claim.status === "in_progress") {
    if (
      !sameKeys(
        Object.keys(claim).sort(),
        IN_PROGRESS_CLAIM_KEYS,
      )
    ) {
      fail(code);
    }
    const aggregate = aggregateState(claim.aggregate, code);
    if (
      aggregate.status !== "collecting"
      || !aggregate.inProgress
    ) {
      fail(code);
    }
    return Object.freeze({ status: "in_progress", aggregate });
  }
  if (claim.status === "complete") {
    if (
      !sameKeys(
        Object.keys(claim).sort(),
        COMPLETE_CLAIM_KEYS,
      )
      || !TERMINAL_OUTCOMES.has(claim.outcome)
    ) {
      fail(code);
    }
    const aggregate = aggregateState(claim.aggregate, code);
    if (
      aggregate.status !== claim.outcome
      || aggregate.inProgress
    ) {
      fail(code);
    }
    return Object.freeze({
      status: "complete",
      outcome: claim.outcome,
      aggregate,
    });
  }
  if (
    !sameKeys(
      Object.keys(claim).sort(),
      REQUIRED_CLAIM_KEYS,
    )
    || claim.status !== "page_required"
    || claim.workKeyDigest !== expectedWorkKeyDigest
    || typeof claim.claimNonceDigest !== "string"
    || !DIGEST.test(claim.claimNonceDigest)
    || typeof claim.requestDigest !== "string"
    || !DIGEST.test(claim.requestDigest)
    || ![1, 2].includes(claim.passNumber)
    || !Number.isSafeInteger(claim.pageNumber)
    || claim.pageNumber < 1
    || typeof claim.boundaryAt !== "string"
    || !Object.isFrozen(claim.seenCursors)
    || !Number.isFinite(
      claim.sourceReadStartDeadlineMonotonicMs,
    )
    || claim.sourceReadStartDeadlineMonotonicMs <= 0
    || !(
      claim.cursor === null
      || typeof claim.cursor === "string"
    )
  ) {
    fail(code);
  }
  if (
    nodeTypes.isProxy(claim.seenCursors)
    || Object.getOwnPropertySymbols(claim.seenCursors).length !== 0
  ) {
    fail(code);
  }
  const descriptors = Object.getOwnPropertyDescriptors(
    claim.seenCursors,
  );
  if (
    !descriptors.length
    || descriptors.length.value !== claim.seenCursors.length
    || Object.keys(descriptors).some((key) => (
      key !== "length"
      && (
        !/^(?:0|[1-9][0-9]*)$/u.test(key)
        || Number(key) >= claim.seenCursors.length
      )
    ))
  ) {
    fail(code);
  }
  for (let index = 0; index < claim.seenCursors.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (
      !descriptor
      || !Object.prototype.hasOwnProperty.call(descriptor, "value")
      || descriptor.enumerable !== true
      || typeof descriptor.value !== "string"
    ) {
      fail(code);
    }
  }
  return claim;
}

function aggregateResult(value, code) {
  const result = exactRecord(
    value,
    CHECKPOINT_RESULT_KEYS,
    code,
  );
  return aggregateState(result.aggregate, code);
}

async function sanitizedCall(code, callback) {
  try {
    return await callback();
  } catch {
    fail(code);
  }
}

export async function collectRecallReferenceHeadStep(
  workValue,
  testDependencies,
) {
  const work = workInput(workValue);
  const {
    claimRecallReferencePageImpl,
    checkpointRecallReferencePageImpl,
    readPrivateRecallSourcePageImpl,
    recordRecallReferencePageFailureImpl,
  } = dependencies(testDependencies);
  const claimed = await sanitizedCall(
    "SOURCE_RECALL_REFERENCE_CLAIM_FAILED",
    () => claimRecallReferencePageImpl(work),
  );
  const claim = claimState(claimed, work.workKeyDigest);
  if (claim.status === "in_progress") {
    return claim.aggregate;
  }
  if (claim.status === "complete") {
    return claim.aggregate;
  }

  let page;
  let failureReason = "source_page_read_failed";
  try {
    const sourceReadStartedAtMonotonicMs = performance.now();
    if (
      !Number.isFinite(sourceReadStartedAtMonotonicMs)
      || sourceReadStartedAtMonotonicMs < 0
      || sourceReadStartedAtMonotonicMs
        >= claim.sourceReadStartDeadlineMonotonicMs
    ) {
      failureReason = "source_read_budget_exhausted";
      throw new Error(
        "SOURCE_RECALL_REFERENCE_SOURCE_READ_BUDGET_EXHAUSTED",
      );
    }
    page = await readPrivateRecallSourcePageImpl(
      Object.freeze({
        boundaryAt: claim.boundaryAt,
        cursor: claim.cursor,
        seenCursors: Object.freeze([...claim.seenCursors]),
      }),
    );
  } catch {
    const settled = await sanitizedCall(
      "SOURCE_RECALL_REFERENCE_FAILURE_CHECKPOINT_FAILED",
      () => recordRecallReferencePageFailureImpl(
        claimed,
        failureReason,
      ),
    );
    const aggregate = aggregateResult(
      settled,
      "SOURCE_RECALL_REFERENCE_FAILURE_CHECKPOINT_FAILED",
    );
    if (
      aggregate.status !== "invalidated"
      || aggregate.inProgress
      || aggregate.headSealed
    ) {
      fail("SOURCE_RECALL_REFERENCE_FAILURE_CHECKPOINT_FAILED");
    }
    fail("SOURCE_RECALL_REFERENCE_PAGE_READ_FAILED");
  }

  const checkpointed = await sanitizedCall(
    "SOURCE_RECALL_REFERENCE_CHECKPOINT_FAILED",
    () => checkpointRecallReferencePageImpl(claimed, page),
  );
  return aggregateResult(
    checkpointed,
    "SOURCE_RECALL_REFERENCE_CHECKPOINT_REJECTED",
  );
}

// Construction is explicit because no durable Recall adapter/topology is
// captured or installed. The protocol surface must be exact; no default or
// generic-KV fallback exists.
export function createRecallReferenceHeadCollector(options) {
  const code = "SOURCE_RECALL_REFERENCE_PROTOCOL_INTERFACE_INVALID";
  const { protocol } = exactRecord(options, FACTORY_KEYS, code);
  const selectedProtocol = exactRecord(
    protocol,
    PROTOCOL_KEYS,
    code,
  );
  for (const method of PROTOCOL_KEYS) {
    if (typeof selectedProtocol[method] !== "function") fail(code);
  }
  const selectedDependencies = Object.freeze({
    claimRecallReferencePageImpl:
      selectedProtocol.claimRecallReferencePage,
    checkpointRecallReferencePageImpl:
      selectedProtocol.checkpointRecallReferencePage,
    readPrivateRecallSourcePageImpl:
      readPrivateRecallSourcePage,
    recordRecallReferencePageFailureImpl:
      selectedProtocol.recordRecallReferencePageFailure,
  });
  return Object.freeze({
    collectStep(work) {
      return collectRecallReferenceHeadStep(
        work,
        selectedDependencies,
      );
    },
  });
}
