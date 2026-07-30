import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  SOURCE_IDENTITY_ALIAS_PAGE_SIZE,
  SOURCE_IDENTITY_ARTIFACT_STORE_POLICY_VERSION,
} from "../api/paraai/_lib/source-identity-artifact-store.mjs";
import {
  SOURCE_PARAFORM_HUMAN_IDENTITY_ARTIFACT_BINDING_CONTRACT_PINS_DIGEST,
  SOURCE_PARAFORM_HUMAN_IDENTITY_ARTIFACT_BINDING_VERSION,
  SourceParaformHumanIdentityArtifactBindingError,
  bindParaformHumanIdentityArtifact,
} from "../api/paraai/_lib/source-paraform-human-identity-artifact-binding.mjs";
import {
  SOURCE_PARAFORM_HUMAN_IDENTITY_ARTIFACT_BINDING_RUNTIME_VERSION,
  SourceParaformHumanIdentityArtifactBindingRuntimeError,
  readParaformHumanIdentityArtifactBinding,
} from "../api/paraai/_lib/source-paraform-human-identity-artifact-binding-runtime.mjs";
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
const RUN_NONCE_DIGEST = createHash("sha256")
  .update("synthetic-artifact-binding-run")
  .digest("hex");
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

function fixture() {
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
  const workKeyDigests = [digest("binding-work-key")];
  const workManifestDigest = semanticDigest(
    "phase4-source-identity-work-manifest-v1",
    {
      runNonceDigest: RUN_NONCE_DIGEST,
      decisionBoundaryAtMs: BOUNDARY_MS,
      contractPinsDigest,
      workKeyDigests,
    },
  );
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
    scannedCount: 1,
    outsideBoundaryCount: 0,
    sourceReferenceCount: 1,
    humanReferenceCount: 1,
    nonHumanReferenceCount: 0,
    uniqueCandidateUserCount: 1,
    sourcePassDigest: digest("source-pass"),
    identityUniverseDigest: digest("identity-universe"),
    workManifestDigest,
    workManifestCount: 1,
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
  const pages = [{
    pageNumber: 1,
    cursorToken: null,
    nextCursorToken: null,
    entryCount: 0,
    pageRecordDigest: digest("empty-alias-page-record"),
    pageSemanticDigest: semanticDigest(
      "phase4-source-identity-alias-page-semantic-v1",
      [],
    ),
  }];
  const headMaterial = {
    version: 1,
    policyVersion:
      SOURCE_IDENTITY_ARTIFACT_STORE_POLICY_VERSION,
    kind: "identity_alias_artifact_head_dark",
    runNonceDigest: RUN_NONCE_DIGEST,
    decisionBoundaryAtMs: BOUNDARY_MS,
    contractPinsDigest,
    workManifestDigest,
    workManifestCount: 1,
    terminalWorkSetDigest: digest("terminal-work-set"),
    pageSize: SOURCE_IDENTITY_ALIAS_PAGE_SIZE,
    pageCount: 1,
    resolvedEntryCount: 0,
    unresolvedWorkCount: 1,
    conflictWorkCount: 0,
    pages,
  };
  const sealedArtifactDigest = semanticDigest(
    "phase4-source-identity-alias-artifact-v1",
    headMaterial,
  );
  const headRecord = {
    version: headMaterial.version,
    policyVersion: headMaterial.policyVersion,
    kind: headMaterial.kind,
    runNonceDigest: headMaterial.runNonceDigest,
    decisionBoundaryAtMs: headMaterial.decisionBoundaryAtMs,
    contractPinsDigest: headMaterial.contractPinsDigest,
    sealedArtifactDigest,
    workManifestDigest: headMaterial.workManifestDigest,
    workManifestCount: headMaterial.workManifestCount,
    terminalWorkSetDigest:
      headMaterial.terminalWorkSetDigest,
    pageSize: headMaterial.pageSize,
    pageCount: headMaterial.pageCount,
    resolvedEntryCount: headMaterial.resolvedEntryCount,
    unresolvedWorkCount: headMaterial.unresolvedWorkCount,
    conflictWorkCount: headMaterial.conflictWorkCount,
    pages: headMaterial.pages,
  };
  const headRaw = JSON.stringify(headRecord);
  const headRecordDigest = createHash("sha256")
    .update(headRaw)
    .digest("hex");
  const run = {
    version: 1,
    policyVersion:
      SOURCE_IDENTITY_ARTIFACT_STORE_POLICY_VERSION,
    kind: "identity_observation_run_dark",
    status: "sealed",
    runKeyDigest,
    runNonceDigest: RUN_NONCE_DIGEST,
    decisionBoundaryAtMs: BOUNDARY_MS,
    contractPinsDigest,
    workKeyDigests,
    workManifestDigest,
    workManifestCount: 1,
    createdAtMs: BOUNDARY_MS + 10,
    updatedAtMs: BOUNDARY_MS + 2_000,
    revision: 3,
    sealedArtifactDigest,
    sealedHeadRecordDigest: headRecordDigest,
  };
  const proofRaw = JSON.stringify(proofRecord);
  const proofRecordRevisionSha1 = createHash("sha1")
    .update(proofRaw)
    .digest("hex");
  return {
    proofRecord,
    proofRecordRevisionSha1,
    run,
    headRecord,
    headRecordDigest,
    headRaw,
  };
}

function bindingInput(selected = fixture()) {
  return {
    proofRecord: selected.proofRecord,
    proofRecordRevisionSha1:
      selected.proofRecordRevisionSha1,
    run: selected.run,
    headRecord: selected.headRecord,
    headRecordDigest: selected.headRecordDigest,
  };
}

function expectBindingInvalid(operation) {
  assert.throws(
    operation,
    (error) => (
      error
        instanceof SourceParaformHumanIdentityArtifactBindingError
      && error.name
        === "SourceParaformHumanIdentityArtifactBindingError"
      && error.code
        === "SOURCE_PARAFORM_HUMAN_IDENTITY_ARTIFACT_BINDING_INVALID"
      && error.message === error.code
    ),
  );
}

test("binds one retained exhaustive manifest to one terminal sealed artifact", () => {
  const selected = fixture();
  const binding = bindParaformHumanIdentityArtifact(
    bindingInput(selected),
  );
  assert.equal(
    SOURCE_PARAFORM_HUMAN_IDENTITY_ARTIFACT_BINDING_VERSION,
    "paraform-human-identity-artifact-binding-v1",
  );
  assert.deepEqual(binding, {
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
    workManifestDigest:
      selected.run.workManifestDigest,
    workManifestCount: 1,
    terminalWorkSetDigest:
      selected.headRecord.terminalWorkSetDigest,
    sealedArtifactDigest:
      selected.run.sealedArtifactDigest,
    sealedHeadRecordDigest: selected.headRecordDigest,
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
    bindingDigest: binding.bindingDigest,
  });
  for (const value of [
    binding.contractPinsDigest,
    binding.identityRunKeyDigest,
    binding.exhaustivenessProofDigest,
    binding.workManifestDigest,
    binding.terminalWorkSetDigest,
    binding.sealedArtifactDigest,
    binding.sealedHeadRecordDigest,
    binding.bindingDigest,
  ]) {
    assert.match(value, /^[a-f0-9]{64}$/u);
  }
  assert.equal(Object.isFrozen(binding), true);
});

test("rejects cross-run, manifest, boundary, and head drift", () => {
  const selected = fixture();
  const cases = [
    {
      ...bindingInput(selected),
      proofRecord: {
        ...selected.proofRecord,
        runKeyDigest: "f".repeat(64),
      },
    },
    {
      ...bindingInput(selected),
      headRecord: {
        ...selected.headRecord,
        workManifestDigest: "f".repeat(64),
      },
    },
    {
      ...bindingInput(selected),
      proofRecord: {
        ...selected.proofRecord,
        retainedAtMs: BOUNDARY_MS - 1,
      },
    },
    {
      ...bindingInput(selected),
      headRecordDigest: "f".repeat(64),
    },
    {
      ...bindingInput(selected),
      run: {
        ...selected.run,
        status: "work_set_complete",
        sealedArtifactDigest: null,
        sealedHeadRecordDigest: null,
      },
    },
  ];
  for (const value of cases) {
    expectBindingInvalid(
      () => bindParaformHumanIdentityArtifact(value),
    );
  }
});

test("rejects expanded shapes and accessors without executing them", () => {
  const selected = fixture();
  expectBindingInvalid(
    () => bindParaformHumanIdentityArtifact({
      ...bindingInput(selected),
      force: true,
    }),
  );
  let executed = false;
  const hostile = Object.defineProperty(
    {
      proofRecord: selected.proofRecord,
      proofRecordRevisionSha1:
        selected.proofRecordRevisionSha1,
      run: selected.run,
      headRecord: selected.headRecord,
    },
    "headRecordDigest",
    {
      enumerable: true,
      get() {
        executed = true;
        throw new Error("must not execute");
      },
    },
  );
  expectBindingInvalid(
    () => bindParaformHumanIdentityArtifact(hostile),
  );
  assert.equal(executed, false);
});

function runtimeDependencies(selected, calls) {
  return {
    readHeadImpl: async (input) => {
      calls.push(["head", input]);
      return {
        raw: selected.headRaw,
        headRecordDigest: selected.headRecordDigest,
        record: selected.headRecord,
        redisNowMs: BOUNDARY_MS + 3_000,
      };
    },
    readProofImpl: async (input) => {
      calls.push(["proof", input]);
      return {
        ...selected.proofRecord,
        proofDigest: selected.proofRecord.proof.proofDigest,
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
      const raw = JSON.stringify(selected.run);
      return {
        record: selected.run,
        raw,
        rawSha1: createHash("sha1")
          .update(raw)
          .digest("hex"),
        redisNowMs: BOUNDARY_MS + 3_000,
      };
    },
  };
}

async function expectRuntimeCode(operation, code) {
  await assert.rejects(
    operation,
    (error) => (
      error
        instanceof SourceParaformHumanIdentityArtifactBindingRuntimeError
      && error.name
        === "SourceParaformHumanIdentityArtifactBindingRuntimeError"
      && error.code === code
      && error.message === code
    ),
  );
}

test("read-only runtime selects the sealed run, proof, and head", async () => {
  const selected = fixture();
  const calls = [];
  const result = await readParaformHumanIdentityArtifactBinding(
    {
      boundaryAt: BOUNDARY,
      runNonceDigest: RUN_NONCE_DIGEST,
    },
    runtimeDependencies(selected, calls),
  );
  assert.equal(
    result.runtimeVersion,
    SOURCE_PARAFORM_HUMAN_IDENTITY_ARTIFACT_BINDING_RUNTIME_VERSION,
  );
  assert.equal(
    result.bindingDigest,
    bindParaformHumanIdentityArtifact(
      bindingInput(selected),
    ).bindingDigest,
  );
  assert.deepEqual(calls, [
    [
      "run",
      {
        runNonceDigest: RUN_NONCE_DIGEST,
        decisionBoundaryAtMs: BOUNDARY_MS,
        contractPinsDigest:
          SOURCE_PARAFORM_HUMAN_IDENTITY_EXHAUSTIVENESS_CONTRACT_PINS_DIGEST,
      },
    ],
    ["proof", { runKeyDigest: selected.run.runKeyDigest }],
    [
      "head",
      {
        sealedArtifactDigest:
          selected.run.sealedArtifactDigest,
        runNonceDigest: RUN_NONCE_DIGEST,
        decisionBoundaryAtMs: BOUNDARY_MS,
        contractPinsDigest:
          SOURCE_PARAFORM_HUMAN_IDENTITY_EXHAUSTIVENESS_CONTRACT_PINS_DIGEST,
      },
    ],
  ]);
  assert.equal(result.pinnable, false);
  assert.equal(result.sourceAuthorityAvailable, false);
  assert.equal(result.activationAvailable, false);
  assert.equal(result.writeAuthorityAvailable, false);
  assert.equal(Object.isFrozen(result), true);
});

test("runtime rejects missing or inconsistent durable state generically", async () => {
  const selected = fixture();
  const cases = [
    {
      ...runtimeDependencies(selected, []),
      readProofImpl: async () => null,
    },
    {
      ...runtimeDependencies(selected, []),
      readHeadImpl: async () => ({
        raw: selected.headRaw,
        headRecordDigest: "f".repeat(64),
        record: selected.headRecord,
        redisNowMs: BOUNDARY_MS + 3_000,
      }),
    },
    {
      ...runtimeDependencies(selected, []),
      readRunImpl: async () => {
        throw new Error("private durable failure");
      },
    },
  ];
  for (const dependencies of cases) {
    await expectRuntimeCode(
      () => readParaformHumanIdentityArtifactBinding(
        {
          boundaryAt: BOUNDARY,
          runNonceDigest: RUN_NONCE_DIGEST,
        },
        dependencies,
      ),
      "SOURCE_PARAFORM_HUMAN_IDENTITY_ARTIFACT_BINDING_RUNTIME_FAILED",
    );
  }
});

test("runtime rejects hostile context and expanded dependencies before reads", async () => {
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
  await expectRuntimeCode(
    () => readParaformHumanIdentityArtifactBinding(hostile),
    "SOURCE_PARAFORM_HUMAN_IDENTITY_ARTIFACT_BINDING_RUNTIME_INPUT_INVALID",
  );
  assert.equal(executed, false);

  const calls = [];
  await expectRuntimeCode(
    () => readParaformHumanIdentityArtifactBinding(
      {
        boundaryAt: BOUNDARY,
        runNonceDigest: RUN_NONCE_DIGEST,
      },
      {
        ...runtimeDependencies(fixture(), calls),
        force: true,
      },
    ),
    "SOURCE_PARAFORM_HUMAN_IDENTITY_ARTIFACT_BINDING_RUNTIME_DEPENDENCIES_INVALID",
  );
  assert.equal(calls.length, 0);
});
