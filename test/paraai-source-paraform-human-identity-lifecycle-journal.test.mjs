import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  ensureDarkSourceCaptureRun,
  transitionDarkSourceCaptureRecord,
  validateDarkSourceCaptureRecord,
} from "../api/paraai/_lib/source-capture-store.mjs";
import {
  SOURCE_IDENTITY_ARTIFACT_STORE_POLICY_VERSION,
} from "../api/paraai/_lib/source-identity-artifact-store.mjs";
import {
  SOURCE_PARAFORM_HUMAN_IDENTITY_ARTIFACT_BINDING_CONTRACT_PINS_DIGEST,
  SOURCE_PARAFORM_HUMAN_IDENTITY_ARTIFACT_BINDING_VERSION,
} from "../api/paraai/_lib/source-paraform-human-identity-artifact-binding.mjs";
import {
  SOURCE_PARAFORM_HUMAN_IDENTITY_ARTIFACT_BINDING_RUNTIME_VERSION,
} from "../api/paraai/_lib/source-paraform-human-identity-artifact-binding-runtime.mjs";
import {
  SOURCE_PARAFORM_HUMAN_IDENTITY_COLLECTOR_BINDING_RUNTIME_VERSION,
} from "../api/paraai/_lib/source-paraform-human-identity-collector-binding-runtime.mjs";
import {
  SOURCE_PARAFORM_HUMAN_IDENTITY_EXHAUSTIVENESS_CONTRACT_PINS_DIGEST,
} from "../api/paraai/_lib/source-paraform-human-identity-exhaustiveness.mjs";
import {
  SOURCE_PARAFORM_HUMAN_IDENTITY_LIFECYCLE_JOURNAL_VERSION,
  SOURCE_PARAFORM_HUMAN_IDENTITY_LIFECYCLE_TICK_MODE,
  SourceParaformHumanIdentityLifecycleJournalError,
  runParaformHumanIdentityLifecycleJournal,
} from "../api/paraai/_lib/source-paraform-human-identity-lifecycle-journal.mjs";
import {
  SOURCE_PARAFORM_HUMAN_IDENTITY_PROOF_RUNTIME_VERSION,
} from "../api/paraai/_lib/source-paraform-human-identity-proof-runtime.mjs";

const BOUNDARY_MS = Date.parse("2026-07-26T03:00:00.000Z");
const BOUNDARY = new Date(BOUNDARY_MS).toISOString();
const PROOF_DIGEST = digest("lifecycle-proof");
const PROOF_REVISION_SHA1 = createHash("sha1")
  .update("lifecycle-proof-record")
  .digest("hex");

process.env.PARAAI_SOURCE_AUTHORITY_KV_REST_API_URL =
  "https://lifecycle-journal-kv.test.invalid";
process.env.PARAAI_SOURCE_AUTHORITY_KV_REST_API_TOKEN =
  "lifecycle-journal-test-token";

function digest(label) {
  return createHash("sha256").update(label).digest("hex");
}

function canonicalJson(value) {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  if (typeof value === "number") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => (
    `${JSON.stringify(key)}:${canonicalJson(value[key])}`
  )).join(",")}}`;
}

function semanticDigest(namespace, value) {
  return createHash("sha256")
    .update(namespace)
    .update("\0")
    .update(canonicalJson(value))
    .digest("hex");
}

function redisParts(nowMs) {
  return [
    String(Math.floor(nowMs / 1_000)),
    String((nowMs % 1_000) * 1_000),
  ];
}

async function captureSnapshot({ paraformReady = true } = {}) {
  const saved = globalThis.fetch;
  globalThis.fetch = async (_url, options) => {
    const command = JSON.parse(options.body);
    const proposed = JSON.parse(command[5]);
    proposed.decisionBoundaryAtMs = BOUNDARY_MS;
    proposed.createdAtMs = BOUNDARY_MS;
    proposed.updatedAtMs = BOUNDARY_MS;
    proposed.priorCaptureRevisionSha1 = null;
    return {
      ok: true,
      text: async () => JSON.stringify({
        result: [
          1,
          JSON.stringify(proposed),
          ...redisParts(BOUNDARY_MS),
        ],
      }),
    };
  };
  try {
    const initial = await ensureDarkSourceCaptureRun();
    if (!paraformReady) return initial;
    let record = initial.record;
    while (
      ["recall", "paraform_human"].includes(
        record.activeStep?.source,
      )
    ) {
      const source = record.activeStep.source;
      record = transitionDarkSourceCaptureRecord(
        record,
        {
          kind: "page_checkpoint",
          claimNonceDigest: digest(`claim-${source}`),
          source,
          passNumber: record.activeStep.passNumber,
          pageNumber: record.activeStep.pageNumber,
          cursorToken: record.activeStep.cursorToken,
          nextCursorToken: null,
          pageSemanticDigest: digest(`page-${source}`),
          recordCount: 1,
          sourceHeadEpochDigest: digest(`epoch-${source}`),
          sourceHeadRevisionDigest:
            digest(`revision-${source}`),
          sourceHeadRecordDigest: digest(`head-${source}`),
        },
        record.updatedAtMs + 1,
      );
    }
    return snapshot(record);
  } finally {
    globalThis.fetch = saved;
  }
}

function snapshot(record) {
  if (record === null) {
    return {
      record: null,
      raw: null,
      rawSha1: null,
      redisNowMs: BOUNDARY_MS + 10_000,
    };
  }
  const raw = JSON.stringify(record);
  return {
    record,
    raw,
    rawSha1: createHash("sha1").update(raw).digest("hex"),
    redisNowMs: BOUNDARY_MS + 10_000,
  };
}

function runFixture(capture, status = "work_set_complete") {
  const contractPinsDigest =
    SOURCE_PARAFORM_HUMAN_IDENTITY_EXHAUSTIVENESS_CONTRACT_PINS_DIGEST;
  const runKeyDigest = semanticDigest(
    "phase4-source-identity-observation-run-key-v1",
    {
      runNonceDigest: capture.record.runNonceDigest,
      decisionBoundaryAtMs: BOUNDARY_MS,
      contractPinsDigest,
    },
  );
  const workKeyDigests = status === "collecting"
    ? []
    : [digest("lifecycle-work-key")];
  const workManifestDigest = status === "collecting"
    ? null
    : semanticDigest(
      "phase4-source-identity-work-manifest-v1",
      {
        runNonceDigest: capture.record.runNonceDigest,
        decisionBoundaryAtMs: BOUNDARY_MS,
        contractPinsDigest,
        workKeyDigests,
      },
    );
  return {
    version: 1,
    policyVersion:
      SOURCE_IDENTITY_ARTIFACT_STORE_POLICY_VERSION,
    kind: "identity_observation_run_dark",
    status,
    runKeyDigest,
    runNonceDigest: capture.record.runNonceDigest,
    decisionBoundaryAtMs: BOUNDARY_MS,
    contractPinsDigest,
    workKeyDigests,
    workManifestDigest,
    workManifestCount: status === "collecting" ? null : 1,
    createdAtMs: BOUNDARY_MS + 10,
    updatedAtMs: BOUNDARY_MS + 20,
    revision: status === "collecting" ? 0 : 2,
    sealedArtifactDigest: status === "sealed"
      ? digest("lifecycle-sealed-artifact")
      : null,
    sealedHeadRecordDigest: status === "sealed"
      ? digest("lifecycle-sealed-head")
      : null,
  };
}

function proofResult(run) {
  return {
    version:
      SOURCE_PARAFORM_HUMAN_IDENTITY_PROOF_RUNTIME_VERSION,
    boundaryAt: BOUNDARY,
    runKeyDigest: run.runKeyDigest,
    proofDigest: PROOF_DIGEST,
    recordRevisionSha1: PROOF_REVISION_SHA1,
    retainedAtMs: BOUNDARY_MS + 1_000,
    proofCreated: true,
    proofDuplicate: false,
    passCount: 2,
    pageCount: 1,
    scannedCount: 1,
    sourceReferenceCount: 1,
    humanReferenceCount: 1,
    nonHumanReferenceCount: 0,
    identityWorkCount: 1,
    identityWorkSetFinalized: true,
    durableProofAvailable: true,
    stablePassesProven: true,
    cursorExhaustivenessProven: true,
    workIndexEqualityProven: true,
    upstreamExhaustivenessProven: true,
    operational: false,
    pinnable: false,
    identityCollectorPinned: false,
    identityArtifactPinned: false,
    sourceAuthorityAvailable: false,
    activationAvailable: false,
    writeAuthorityAvailable: false,
  };
}

function pendingCollectorResult(run) {
  return {
    coordinatorRuntimeVersion:
      SOURCE_PARAFORM_HUMAN_IDENTITY_COLLECTOR_BINDING_RUNTIME_VERSION,
    status: "identity_collection_step_checked_dark",
    boundaryAt: BOUNDARY,
    identityRunKeyDigest: run.runKeyDigest,
    exhaustivenessProofDigest: PROOF_DIGEST,
    exhaustivenessProofRecordRevisionSha1:
      PROOF_REVISION_SHA1,
    workManifestDigest: run.workManifestDigest,
    workManifestCount: 1,
    terminalWorkCount: 0,
    resolvedWorkCount: 0,
    unresolvedWorkCount: 0,
    conflictWorkCount: 0,
    collectorStepAttempted: true,
    retainedExhaustivenessProofAvailable: true,
    identityWorkSetFinalized: true,
    identityWorkSetTerminal: false,
    terminalIdentityArtifactBound: false,
    upstreamExhaustivenessProven: true,
    operational: false,
    pinnable: false,
    identityCollectorPinned: false,
    identityArtifactPinned: false,
    sourceAuthorityAvailable: false,
    activationAvailable: false,
    writeAuthorityAvailable: false,
  };
}

function boundCollectorResult(run) {
  return {
    coordinatorRuntimeVersion:
      SOURCE_PARAFORM_HUMAN_IDENTITY_COLLECTOR_BINDING_RUNTIME_VERSION,
    status: "terminal_identity_artifact_bound_dark",
    collectorStepAttempted: true,
    terminalWorkCount: 1,
    runtimeVersion:
      SOURCE_PARAFORM_HUMAN_IDENTITY_ARTIFACT_BINDING_RUNTIME_VERSION,
    version:
      SOURCE_PARAFORM_HUMAN_IDENTITY_ARTIFACT_BINDING_VERSION,
    policyVersion:
      SOURCE_IDENTITY_ARTIFACT_STORE_POLICY_VERSION,
    boundaryAt: BOUNDARY,
    contractPinsDigest:
      SOURCE_PARAFORM_HUMAN_IDENTITY_ARTIFACT_BINDING_CONTRACT_PINS_DIGEST,
    identityRunKeyDigest: run.runKeyDigest,
    exhaustivenessProofDigest: PROOF_DIGEST,
    exhaustivenessProofRecordRevisionSha1:
      PROOF_REVISION_SHA1,
    workManifestDigest: run.workManifestDigest,
    workManifestCount: 1,
    terminalWorkSetDigest: digest("lifecycle-terminal-set"),
    sealedArtifactDigest: run.sealedArtifactDigest,
    sealedHeadRecordDigest: run.sealedHeadRecordDigest,
    pageCount: 1,
    resolvedEntryCount: 0,
    unresolvedWorkCount: 1,
    conflictWorkCount: 0,
    retainedExhaustivenessProofAvailable: true,
    identityWorkSetFinalized: true,
    identityWorkSetTerminal: true,
    terminalIdentityArtifactBound: true,
    upstreamExhaustivenessProven: true,
    operational: false,
    pinnable: false,
    identityCollectorPinned: false,
    identityArtifactPinned: false,
    sourceAuthorityAvailable: false,
    activationAvailable: false,
    writeAuthorityAvailable: false,
    bindingDigest: digest("lifecycle-binding"),
  };
}

function request() {
  return {
    mode:
      SOURCE_PARAFORM_HUMAN_IDENTITY_LIFECYCLE_TICK_MODE,
  };
}

function expectedOutput(capture, selected) {
  return {
    lifecycleJournalVersion:
      SOURCE_PARAFORM_HUMAN_IDENTITY_LIFECYCLE_JOURNAL_VERSION,
    journalOwnedContext: true,
    captureJournalRevisionSha1: capture.rawSha1,
    boundaryAt: BOUNDARY,
    ...selected,
    operational: false,
    pinnable: false,
    identityCollectorPinned: false,
    identityArtifactPinned: false,
    sourceAuthorityAvailable: false,
    activationAvailable: false,
    writeAuthorityAvailable: false,
  };
}

function dependencies({
  capture,
  captureReadback,
  initialRun,
  proofRun,
  collectorRun,
  proofOutput,
  collectorOutput,
  calls,
}) {
  let currentRun = initialRun;
  let journalReadCount = 0;
  return {
    ensureCaptureJournalImpl: async () => {
      calls.push(["journal"]);
      journalReadCount += 1;
      return journalReadCount === 1
        ? capture
        : captureReadback ?? capture;
    },
    readIdentityRunImpl: async (input) => {
      calls.push(["run", input]);
      return snapshot(currentRun);
    },
    runCollectorBindingImpl: async (input) => {
      calls.push(["collector", input]);
      currentRun = collectorRun ?? currentRun;
      return collectorOutput;
    },
    runProofImpl: async (input) => {
      calls.push(["proof", input]);
      currentRun = proofRun ?? currentRun;
      return proofOutput;
    },
  };
}

async function expectCode(operation, code) {
  await assert.rejects(
    operation,
    (error) => (
      error
        instanceof SourceParaformHumanIdentityLifecycleJournalError
      && error.name
        === "SourceParaformHumanIdentityLifecycleJournalError"
      && error.code === code
      && error.message === code
    ),
  );
}

test("journal-owned context selects proof creation when no identity run exists", async () => {
  const capture = await captureSnapshot();
  const after = runFixture(capture);
  const calls = [];
  const result =
    await runParaformHumanIdentityLifecycleJournal(
      request(),
      dependencies({
        capture,
        initialRun: null,
        proofRun: after,
        proofOutput: proofResult(after),
        calls,
      }),
    );
  assert.deepEqual(calls.map(([kind]) => kind), [
    "journal",
    "run",
    "proof",
    "journal",
    "run",
  ]);
  assert.deepEqual(calls[2][1], {
    boundaryAt: BOUNDARY,
    runNonceDigest: capture.record.runNonceDigest,
  });
  assert.deepEqual(result, expectedOutput(capture, {
    status: "identity_exhaustiveness_proof_retained_dark",
    identityRunKeyDigest: after.runKeyDigest,
    exhaustivenessProofDigest: PROOF_DIGEST,
    exhaustivenessProofRecordRevisionSha1:
      PROOF_REVISION_SHA1,
    workManifestDigest: after.workManifestDigest,
    workManifestCount: 1,
    terminalWorkCount: 0,
    collectorStepAttempted: false,
    retainedExhaustivenessProofAvailable: true,
    identityWorkSetFinalized: true,
    identityWorkSetTerminal: false,
    terminalIdentityArtifactBound: false,
    upstreamExhaustivenessProven: true,
  }));
  assert.equal(Object.isFrozen(result), true);
});

test("a partial collecting run resumes only the proof phase", async () => {
  const capture = await captureSnapshot();
  const initial = runFixture(capture, "collecting");
  const after = runFixture(capture);
  const calls = [];
  await runParaformHumanIdentityLifecycleJournal(
    request(),
    dependencies({
      capture,
      initialRun: initial,
      proofRun: after,
      proofOutput: proofResult(after),
      calls,
    }),
  );
  assert.equal(calls.some(([kind]) => kind === "collector"), false);
  assert.equal(calls.filter(([kind]) => kind === "proof").length, 1);
});

test("a finalized run selects exactly one collector lifecycle child", async () => {
  const capture = await captureSnapshot();
  const run = runFixture(capture);
  const calls = [];
  const result =
    await runParaformHumanIdentityLifecycleJournal(
      request(),
      dependencies({
        capture,
        initialRun: run,
        collectorRun: run,
        collectorOutput: pendingCollectorResult(run),
        calls,
      }),
    );
  assert.deepEqual(calls.map(([kind]) => kind), [
    "journal",
    "run",
    "collector",
    "journal",
    "run",
  ]);
  assert.equal(calls.some(([kind]) => kind === "proof"), false);
  assert.equal(
    result.status,
    "identity_collection_step_checked_dark",
  );
  assert.equal(result.collectorStepAttempted, true);
  assert.equal(result.terminalIdentityArtifactBound, false);
  assert.equal(result.pinnable, false);
});

test("terminal child output requires a sealed durable reread", async () => {
  const capture = await captureSnapshot();
  const before = runFixture(capture);
  const after = runFixture(capture, "sealed");
  const calls = [];
  const result =
    await runParaformHumanIdentityLifecycleJournal(
      request(),
      dependencies({
        capture,
        initialRun: before,
        collectorRun: after,
        collectorOutput: boundCollectorResult(after),
        calls,
      }),
    );
  assert.equal(
    result.status,
    "terminal_identity_artifact_bound_dark",
  );
  assert.equal(result.identityWorkSetTerminal, true);
  assert.equal(result.terminalIdentityArtifactBound, true);
  assert.equal(result.upstreamExhaustivenessProven, true);
  assert.equal(result.sourceAuthorityAvailable, false);
  assert.equal(result.activationAvailable, false);
  assert.equal(result.writeAuthorityAvailable, false);
});

test("an invalidated capture journal blocks every identity child", async () => {
  const capture = await captureSnapshot();
  const invalid = {
    ...capture.record,
    status: "invalidated",
    activeStep: null,
    updatedAtMs: capture.record.updatedAtMs + 1,
    revision: capture.record.revision + 1,
    invalidReason: "identity_lifecycle_test",
  };
  validateDarkSourceCaptureRecord(invalid);
  const invalidSnapshot = snapshot(invalid);
  const calls = [];
  await expectCode(
    () => runParaformHumanIdentityLifecycleJournal(
      request(),
      dependencies({
        capture: invalidSnapshot,
        initialRun: null,
        calls,
      }),
    ),
    "SOURCE_PARAFORM_HUMAN_IDENTITY_LIFECYCLE_JOURNAL_FAILED",
  );
  assert.deepEqual(calls, [["journal"]]);
});

test("the journal cannot select identity work before Paraform Human capture is complete", async () => {
  const capture = await captureSnapshot({
    paraformReady: false,
  });
  const calls = [];
  await expectCode(
    () => runParaformHumanIdentityLifecycleJournal(
      request(),
      dependencies({
        capture,
        initialRun: null,
        calls,
      }),
    ),
    "SOURCE_PARAFORM_HUMAN_IDENTITY_LIFECYCLE_JOURNAL_FAILED",
  );
  assert.deepEqual(calls, [["journal"]]);
});

test("child expansion or durable reread drift cannot escape", async () => {
  {
    const capture = await captureSnapshot();
    const after = runFixture(capture);
    const calls = [];
    await expectCode(
      () => runParaformHumanIdentityLifecycleJournal(
        request(),
        dependencies({
          capture,
          initialRun: null,
          proofRun: after,
          proofOutput: {
            ...proofResult(after),
            candidateUserId: "private-candidate-user",
          },
          calls,
        }),
      ),
      "SOURCE_PARAFORM_HUMAN_IDENTITY_LIFECYCLE_JOURNAL_FAILED",
    );
  }
  {
    const capture = await captureSnapshot();
    const before = runFixture(capture);
    const after = {
      ...before,
      runNonceDigest: digest("wrong-lifecycle-run"),
    };
    await expectCode(
      () => runParaformHumanIdentityLifecycleJournal(
        request(),
        dependencies({
          capture,
          initialRun: before,
          collectorRun: after,
          collectorOutput: pendingCollectorResult(before),
          calls: [],
        }),
      ),
      "SOURCE_PARAFORM_HUMAN_IDENTITY_LIFECYCLE_JOURNAL_FAILED",
    );
  }
});

test("capture-journal revision drift after a child fails before identity readback", async () => {
  const capture = await captureSnapshot();
  const after = runFixture(capture);
  const changedRecord = {
    ...capture.record,
    updatedAtMs: capture.record.updatedAtMs + 1,
    revision: capture.record.revision + 1,
  };
  const captureReadback = snapshot(changedRecord);
  const calls = [];
  await expectCode(
    () => runParaformHumanIdentityLifecycleJournal(
      request(),
      dependencies({
        capture,
        captureReadback,
        initialRun: null,
        proofRun: after,
        proofOutput: proofResult(after),
        calls,
      }),
    ),
    "SOURCE_PARAFORM_HUMAN_IDENTITY_LIFECYCLE_JOURNAL_FAILED",
  );
  assert.deepEqual(calls.map(([kind]) => kind), [
    "journal",
    "run",
    "proof",
    "journal",
  ]);
});

test("hostile or caller-selected context fails before the journal", async () => {
  const capture = await captureSnapshot();
  const run = runFixture(capture);
  const calls = [];
  await expectCode(
    () => runParaformHumanIdentityLifecycleJournal(
      {
        ...request(),
        boundaryAt: BOUNDARY,
      },
      dependencies({
        capture,
        initialRun: run,
        calls,
      }),
    ),
    "SOURCE_PARAFORM_HUMAN_IDENTITY_LIFECYCLE_JOURNAL_INPUT_INVALID",
  );
  assert.equal(calls.length, 0);

  let executed = false;
  const hostile = Object.defineProperty(
    {},
    "mode",
    {
      enumerable: true,
      get() {
        executed = true;
        throw new Error("must not execute");
      },
    },
  );
  await expectCode(
    () => runParaformHumanIdentityLifecycleJournal(hostile),
    "SOURCE_PARAFORM_HUMAN_IDENTITY_LIFECYCLE_JOURNAL_INPUT_INVALID",
  );
  assert.equal(executed, false);
});

test("expanded dependencies and malformed journal snapshots fail generically", async () => {
  const capture = await captureSnapshot();
  const run = runFixture(capture);
  const calls = [];
  await expectCode(
    () => runParaformHumanIdentityLifecycleJournal(
      request(),
      {
        ...dependencies({
          capture,
          initialRun: run,
          calls,
        }),
        force: true,
      },
    ),
    "SOURCE_PARAFORM_HUMAN_IDENTITY_LIFECYCLE_JOURNAL_DEPENDENCIES_INVALID",
  );
  assert.equal(calls.length, 0);

  const malformed = {
    ...capture,
    rawSha1: "f".repeat(40),
  };
  await expectCode(
    () => runParaformHumanIdentityLifecycleJournal(
      request(),
      dependencies({
        capture: malformed,
        initialRun: null,
        calls: [],
      }),
    ),
    "SOURCE_PARAFORM_HUMAN_IDENTITY_LIFECYCLE_JOURNAL_FAILED",
  );
});
