import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

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
  SourceParaformHumanIdentityCollectorBindingRuntimeError,
  runParaformHumanIdentityCollectorBindingRuntime,
} from "../api/paraai/_lib/source-paraform-human-identity-collector-binding-runtime.mjs";
import {
  SOURCE_PARAFORM_HUMAN_IDENTITY_EXHAUSTIVENESS_CONTRACT_PINS_DIGEST,
  SOURCE_PARAFORM_HUMAN_IDENTITY_EXHAUSTIVENESS_VERSION,
} from "../api/paraai/_lib/source-paraform-human-identity-exhaustiveness.mjs";
import {
  SOURCE_PARAFORM_HUMAN_IDENTITY_PROOF_STORE_POLICY_VERSION,
} from "../api/paraai/_lib/source-paraform-human-identity-proof-store.mjs";
import {
  SOURCE_PARAFORM_HUMAN_PAGE_CLIENT_VERSION,
  SOURCE_PARAFORM_HUMAN_PAGE_VERSION,
} from "../api/paraai/_lib/source-paraform-human-page-client.mjs";

const BOUNDARY = "2026-07-26T03:00:00.000Z";
const BOUNDARY_MS = Date.parse(BOUNDARY);
const RUN_NONCE_DIGEST = digest("collector-binding-run");
const POINT_PROCEDURE =
  "candidateUser.getCandidateUserById";

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

function digest(label) {
  return createHash("sha256").update(label).digest("hex");
}

function snapshot(record, nowMs = BOUNDARY_MS + 10_000) {
  const raw = JSON.stringify(record);
  return {
    record,
    raw,
    rawSha1: createHash("sha1").update(raw).digest("hex"),
    redisNowMs: nowMs,
  };
}

function workKey(runKeyDigest, workItemDigest) {
  return semanticDigest(
    "phase4-source-identity-observation-work-key-v1",
    {
      runKeyDigest,
      workItemDigest,
    },
  );
}

function fixture({ workStatuses = ["awaiting_read_1"] } = {}) {
  const contractPinsDigest =
    SOURCE_PARAFORM_HUMAN_IDENTITY_EXHAUSTIVENESS_CONTRACT_PINS_DIGEST;
  const runKeyDigest = semanticDigest(
    "phase4-source-identity-observation-run-key-v1",
    {
      runNonceDigest: RUN_NONCE_DIGEST,
      decisionBoundaryAtMs: BOUNDARY_MS,
      contractPinsDigest,
    },
  );
  const workItemDigests = workStatuses.map(
    (_status, index) => digest(`work-item-${index + 1}`),
  );
  const workKeyDigests = workItemDigests
    .map((workItemDigest) => workKey(
      runKeyDigest,
      workItemDigest,
    ))
    .sort();
  const itemByKey = new Map(
    workItemDigests.map((workItemDigest) => [
      workKey(runKeyDigest, workItemDigest),
      workItemDigest,
    ]),
  );
  const statusByKey = new Map(
    workItemDigests.map((workItemDigest, index) => [
      workKey(runKeyDigest, workItemDigest),
      workStatuses[index],
    ]),
  );
  const workManifestDigest = semanticDigest(
    "phase4-source-identity-work-manifest-v1",
    {
      runNonceDigest: RUN_NONCE_DIGEST,
      decisionBoundaryAtMs: BOUNDARY_MS,
      contractPinsDigest,
      workKeyDigests,
    },
  );
  const run = {
    version: 1,
    policyVersion:
      SOURCE_IDENTITY_ARTIFACT_STORE_POLICY_VERSION,
    kind: "identity_observation_run_dark",
    status: "work_set_complete",
    runKeyDigest,
    runNonceDigest: RUN_NONCE_DIGEST,
    decisionBoundaryAtMs: BOUNDARY_MS,
    contractPinsDigest,
    workKeyDigests,
    workManifestDigest,
    workManifestCount: workKeyDigests.length,
    createdAtMs: BOUNDARY_MS + 10,
    updatedAtMs: BOUNDARY_MS + 20,
    revision: workKeyDigests.length + 1,
    sealedArtifactDigest: null,
    sealedHeadRecordDigest: null,
  };
  const works = new Map(workKeyDigests.map((workKeyDigest, index) => {
    const status = statusByKey.get(workKeyDigest);
    return [workKeyDigest, {
      version: 1,
      policyVersion:
        SOURCE_IDENTITY_ARTIFACT_STORE_POLICY_VERSION,
      kind: "identity_observation_work_dark",
      status,
      workKeyDigest,
      runKeyDigest,
      runNonceDigest: RUN_NONCE_DIGEST,
      decisionBoundaryAtMs: BOUNDARY_MS,
      contractPinsDigest,
      workItemDigest: itemByKey.get(workKeyDigest),
      privateWorkReference: `candidate-user-${index + 1}`,
      createdAtMs: BOUNDARY_MS + 10,
      updatedAtMs: BOUNDARY_MS + 20,
      revision: status === "unresolved" ? 1 : 0,
      activeClaim: null,
      readOne: null,
      readTwo: null,
      resolutionDigest: null,
      terminalReason: status === "unresolved"
        ? "identity_point_read_failed"
        : null,
    }];
  }));
  const proofMaterial = {
    version:
      SOURCE_PARAFORM_HUMAN_IDENTITY_EXHAUSTIVENESS_VERSION,
    policyVersion:
      SOURCE_IDENTITY_ARTIFACT_STORE_POLICY_VERSION,
    privatePageClientVersion:
      SOURCE_PARAFORM_HUMAN_PAGE_CLIENT_VERSION,
    privatePageVersion: SOURCE_PARAFORM_HUMAN_PAGE_VERSION,
    identityPointReadProcedure: POINT_PROCEDURE,
    boundaryAt: BOUNDARY,
    contractPinsDigest,
    passCount: 2,
    pageCount: 1,
    scannedCount: workKeyDigests.length,
    outsideBoundaryCount: 0,
    sourceReferenceCount: workKeyDigests.length,
    humanReferenceCount: workKeyDigests.length,
    nonHumanReferenceCount: 0,
    uniqueCandidateUserCount: workKeyDigests.length,
    sourcePassDigest: digest("source-pass"),
    identityUniverseDigest: digest("identity-universe"),
    workManifestDigest,
    workManifestCount: workKeyDigests.length,
    identityWorkSetDigest: digest("identity-work-set"),
    stablePassesProven: true,
    cursorExhaustivenessProven: true,
    workIndexEqualityProven: true,
    upstreamExhaustivenessProven: true,
    operational: false,
    pinnable: false,
    identityCollectorPinned: false,
    sourceAuthorityAvailable: false,
    activationAvailable: false,
    writeAuthorityAvailable: false,
  };
  const proof = {
    ...proofMaterial,
    proofDigest: semanticDigest(
      "phase4-paraform-human-identity-exhaustiveness-proof-v1",
      proofMaterial,
    ),
  };
  const proofRecord = {
    version: 1,
    policyVersion:
      SOURCE_PARAFORM_HUMAN_IDENTITY_PROOF_STORE_POLICY_VERSION,
    kind:
      "paraform_human_identity_exhaustiveness_proof_dark",
    runKeyDigest,
    proof,
    retainedAtMs: BOUNDARY_MS + 1_000,
  };
  const proofRaw = JSON.stringify(proofRecord);
  return {
    run,
    works,
    proofRecord,
    proofRecordRevisionSha1: createHash("sha1")
      .update(proofRaw)
      .digest("hex"),
  };
}

function counts(selected) {
  const records = [...selected.works.values()];
  const count = (status) => records.filter(
    (record) => record.status === status,
  ).length;
  return {
    resolvedEntryCount: count("resolved"),
    unresolvedWorkCount: count("unresolved"),
    conflictWorkCount: count("conflict"),
  };
}

function artifact(selected) {
  return {
    sealedArtifactDigest: digest("sealed-artifact"),
    headRecordDigest: digest("sealed-head"),
    pageCount: 1,
    ...counts(selected),
    operational: false,
    pinnable: false,
    upstreamExhaustivenessProven: false,
    activationAvailable: false,
    writeAuthorityAvailable: false,
    runStatus: "sealed",
  };
}

function binding(selected) {
  const prepared = artifact(selected);
  return {
    runtimeVersion:
      SOURCE_PARAFORM_HUMAN_IDENTITY_ARTIFACT_BINDING_RUNTIME_VERSION,
    version:
      SOURCE_PARAFORM_HUMAN_IDENTITY_ARTIFACT_BINDING_VERSION,
    policyVersion:
      SOURCE_IDENTITY_ARTIFACT_STORE_POLICY_VERSION,
    boundaryAt: BOUNDARY,
    contractPinsDigest:
      SOURCE_PARAFORM_HUMAN_IDENTITY_ARTIFACT_BINDING_CONTRACT_PINS_DIGEST,
    identityRunKeyDigest: selected.run.runKeyDigest,
    exhaustivenessProofDigest:
      selected.proofRecord.proof.proofDigest,
    exhaustivenessProofRecordRevisionSha1:
      selected.proofRecordRevisionSha1,
    workManifestDigest: selected.run.workManifestDigest,
    workManifestCount: selected.run.workManifestCount,
    terminalWorkSetDigest: digest("terminal-work-set"),
    sealedArtifactDigest: prepared.sealedArtifactDigest,
    sealedHeadRecordDigest: prepared.headRecordDigest,
    pageCount: prepared.pageCount,
    resolvedEntryCount: prepared.resolvedEntryCount,
    unresolvedWorkCount: prepared.unresolvedWorkCount,
    conflictWorkCount: prepared.conflictWorkCount,
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
    bindingDigest: digest("binding"),
  };
}

function dependencies(selected, calls, collectImpl = async () => {}) {
  return {
    collectWorkImpl: async (input) => {
      calls.push(["collect", input]);
      return collectImpl(input);
    },
    prepareArtifactImpl: async (input) => {
      calls.push(["prepare", input]);
      return artifact(selected);
    },
    readBindingImpl: async (input) => {
      calls.push(["binding", input]);
      return binding(selected);
    },
    readProofImpl: async (input) => {
      calls.push(["proof", input]);
      return {
        ...selected.proofRecord,
        proofDigest:
          selected.proofRecord.proof.proofDigest,
        recordRevisionSha1:
          selected.proofRecordRevisionSha1,
        operational: false,
        pinnable: false,
        sourceAuthorityAvailable: false,
        activationAvailable: false,
        writeAuthorityAvailable: false,
      };
    },
    readRunImpl: async (input) => {
      calls.push(["run", input]);
      return snapshot(selected.run);
    },
    readWorkImpl: async (input) => {
      calls.push(["work", input]);
      return snapshot(selected.works.get(input.workKeyDigest));
    },
  };
}

function runtimeInput() {
  return {
    boundaryAt: BOUNDARY,
    runNonceDigest: RUN_NONCE_DIGEST,
  };
}

async function expectCode(operation, code) {
  await assert.rejects(
    operation,
    (error) => (
      error
        instanceof SourceParaformHumanIdentityCollectorBindingRuntimeError
      && error.name
        === "SourceParaformHumanIdentityCollectorBindingRuntimeError"
      && error.code === code
      && error.message === code
    ),
  );
}

test("checks at most one store-owned nonterminal work item and stays dark", async () => {
  const selected = fixture({
    workStatuses: ["awaiting_read_1", "unresolved"],
  });
  const calls = [];
  const result =
    await runParaformHumanIdentityCollectorBindingRuntime(
      runtimeInput(),
      dependencies(selected, calls),
    );
  const firstNonterminal = selected.run.workKeyDigests.find(
    (key) => selected.works.get(key).status
      === "awaiting_read_1",
  );
  assert.equal(
    calls.filter(([kind]) => kind === "collect").length,
    1,
  );
  assert.deepEqual(
    calls.find(([kind]) => kind === "collect"),
    ["collect", { workKeyDigest: firstNonterminal }],
  );
  assert.equal(
    calls.some(([kind]) => ["prepare", "binding"].includes(kind)),
    false,
  );
  assert.deepEqual(result, {
    coordinatorRuntimeVersion:
      SOURCE_PARAFORM_HUMAN_IDENTITY_COLLECTOR_BINDING_RUNTIME_VERSION,
    status: "identity_collection_step_checked_dark",
    boundaryAt: BOUNDARY,
    identityRunKeyDigest: selected.run.runKeyDigest,
    exhaustivenessProofDigest:
      selected.proofRecord.proof.proofDigest,
    exhaustivenessProofRecordRevisionSha1:
      selected.proofRecordRevisionSha1,
    workManifestDigest: selected.run.workManifestDigest,
    workManifestCount: 2,
    terminalWorkCount: 1,
    resolvedWorkCount: 0,
    unresolvedWorkCount: 1,
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
  });
  assert.equal(Object.isFrozen(result), true);
});

test("seals and binds only after the selected final work becomes terminal", async () => {
  const selected = fixture();
  const calls = [];
  const result =
    await runParaformHumanIdentityCollectorBindingRuntime(
      runtimeInput(),
      dependencies(selected, calls, async ({ workKeyDigest }) => {
        selected.works.set(workKeyDigest, {
          ...selected.works.get(workKeyDigest),
          status: "unresolved",
          updatedAtMs: BOUNDARY_MS + 30,
          revision: 1,
          terminalReason: "identity_point_read_failed",
        });
      }),
    );
  assert.deepEqual(
    calls.map(([kind]) => kind),
    ["run", "proof", "work", "collect", "work", "prepare", "binding"],
  );
  assert.equal(
    result.coordinatorRuntimeVersion,
    SOURCE_PARAFORM_HUMAN_IDENTITY_COLLECTOR_BINDING_RUNTIME_VERSION,
  );
  assert.equal(
    result.status,
    "terminal_identity_artifact_bound_dark",
  );
  assert.equal(result.collectorStepAttempted, true);
  assert.equal(result.terminalWorkCount, 1);
  assert.equal(result.terminalIdentityArtifactBound, true);
  assert.equal(result.upstreamExhaustivenessProven, true);
  assert.equal(result.pinnable, false);
  assert.equal(result.sourceAuthorityAvailable, false);
  assert.equal(result.activationAvailable, false);
  assert.equal(result.writeAuthorityAvailable, false);
  assert.equal(Object.isFrozen(result), true);
});

test("terminal work seals without another collector call", async () => {
  const selected = fixture({
    workStatuses: ["unresolved", "unresolved"],
  });
  const calls = [];
  const result =
    await runParaformHumanIdentityCollectorBindingRuntime(
      runtimeInput(),
      dependencies(selected, calls),
    );
  assert.equal(
    calls.some(([kind]) => kind === "collect"),
    false,
  );
  assert.equal(result.collectorStepAttempted, false);
  assert.equal(result.terminalWorkCount, 2);
  assert.equal(result.terminalIdentityArtifactBound, true);
});

test("an already sealed run is idempotently prepared and rebound without private work reads", async () => {
  const selected = fixture({ workStatuses: ["unresolved"] });
  const prepared = artifact(selected);
  selected.run = {
    ...selected.run,
    status: "sealed",
    revision: selected.run.revision + 1,
    updatedAtMs: BOUNDARY_MS + 30,
    sealedArtifactDigest: prepared.sealedArtifactDigest,
    sealedHeadRecordDigest: prepared.headRecordDigest,
  };
  const calls = [];
  const result =
    await runParaformHumanIdentityCollectorBindingRuntime(
      runtimeInput(),
      dependencies(selected, calls),
    );
  assert.deepEqual(
    calls.map(([kind]) => kind),
    ["run", "proof", "prepare", "binding"],
  );
  assert.equal(result.collectorStepAttempted, false);
  assert.equal(result.terminalIdentityArtifactBound, true);
});

test("requires the exact retained proof before any collector operation", async () => {
  const selected = fixture();
  selected.proofRecord = {
    ...selected.proofRecord,
    proof: {
      ...selected.proofRecord.proof,
      workManifestDigest: digest("wrong-manifest"),
    },
  };
  const calls = [];
  await expectCode(
    () => runParaformHumanIdentityCollectorBindingRuntime(
      runtimeInput(),
      dependencies(selected, calls),
    ),
    "SOURCE_PARAFORM_HUMAN_IDENTITY_COLLECTOR_BINDING_RUNTIME_FAILED",
  );
  assert.equal(
    calls.some(([kind]) => kind === "collect"),
    false,
  );
});

test("collector evidence can never escape through the coordinator result", async () => {
  const selected = fixture();
  const calls = [];
  await expectCode(
    () => runParaformHumanIdentityCollectorBindingRuntime(
      runtimeInput(),
      dependencies(selected, calls, async () => ({
        candidateUserId: "private-candidate-user",
      })),
    ),
    "SOURCE_PARAFORM_HUMAN_IDENTITY_COLLECTOR_BINDING_RUNTIME_FAILED",
  );
  assert.equal(
    calls.some(([kind]) => ["prepare", "binding"].includes(kind)),
    false,
  );
});

test("rejects cross-run work and binding drift generically", async () => {
  {
    const selected = fixture();
    const key = selected.run.workKeyDigests[0];
    selected.works.set(key, {
      ...selected.works.get(key),
      runNonceDigest: digest("other-run"),
    });
    await expectCode(
      () => runParaformHumanIdentityCollectorBindingRuntime(
        runtimeInput(),
        dependencies(selected, []),
      ),
      "SOURCE_PARAFORM_HUMAN_IDENTITY_COLLECTOR_BINDING_RUNTIME_FAILED",
    );
  }
  {
    const selected = fixture({ workStatuses: ["unresolved"] });
    const selectedDependencies = dependencies(selected, []);
    selectedDependencies.readBindingImpl = async () => ({
      ...binding(selected),
      pinnable: true,
    });
    await expectCode(
      () => runParaformHumanIdentityCollectorBindingRuntime(
        runtimeInput(),
        selectedDependencies,
      ),
      "SOURCE_PARAFORM_HUMAN_IDENTITY_COLLECTOR_BINDING_RUNTIME_FAILED",
    );
  }
});

test("rejects hostile input and expanded dependency shapes before reads", async () => {
  let executed = false;
  const hostile = Object.defineProperty(
    { runNonceDigest: RUN_NONCE_DIGEST },
    "boundaryAt",
    {
      enumerable: true,
      get() {
        executed = true;
        throw new Error("must not execute");
      },
    },
  );
  await expectCode(
    () => runParaformHumanIdentityCollectorBindingRuntime(
      hostile,
    ),
    "SOURCE_PARAFORM_HUMAN_IDENTITY_COLLECTOR_BINDING_RUNTIME_INPUT_INVALID",
  );
  assert.equal(executed, false);

  const selected = fixture();
  const calls = [];
  await expectCode(
    () => runParaformHumanIdentityCollectorBindingRuntime(
      runtimeInput(),
      {
        ...dependencies(selected, calls),
        force: true,
      },
    ),
    "SOURCE_PARAFORM_HUMAN_IDENTITY_COLLECTOR_BINDING_RUNTIME_DEPENDENCIES_INVALID",
  );
  assert.equal(calls.length, 0);
});
