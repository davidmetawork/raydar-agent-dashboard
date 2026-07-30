import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  SOURCE_PARAFORM_HUMAN_PAGE_VERSION,
  readPrivateParaformHumanSourcePage,
} from "../api/paraai/_lib/source-paraform-human-page-client.mjs";
import {
  SOURCE_IDENTITY_ARTIFACT_STORE_POLICY_VERSION,
} from "../api/paraai/_lib/source-identity-artifact-store.mjs";
import {
  SOURCE_PARAFORM_HUMAN_IDENTITY_EXHAUSTIVENESS_CONTRACT_PINS_DIGEST,
  paraformHumanIdentityWorkItem,
} from "../api/paraai/_lib/source-paraform-human-identity-exhaustiveness.mjs";
import {
  createSourceParaformHumanIdentityProofStore,
} from "../api/paraai/_lib/source-paraform-human-identity-proof-store.mjs";
import {
  SOURCE_PARAFORM_HUMAN_IDENTITY_PROOF_RUNTIME_VERSION,
  SourceParaformHumanIdentityProofRuntimeError,
  runParaformHumanIdentityProofRuntime,
} from "../api/paraai/_lib/source-paraform-human-identity-proof-runtime.mjs";

const BOUNDARY = "2026-07-26T03:00:00.000Z";
const BOUNDARY_MS = Date.parse(BOUNDARY);
const SECRET =
  "synthetic-proof-runtime-page-secret".padEnd(48, "s");
const RUN_NONCE_DIGEST = createHash("sha256")
  .update("synthetic-proof-runtime-run")
  .digest("hex");
const PRIVATE_MARKERS = Object.freeze([
  "private-runtime-call-1",
  "private-runtime-call-2",
  "private-runtime-call-3",
  "private-runtime-call-4",
  "private-runtime-candidate-1",
  "private-runtime-candidate-2",
  "Private Runtime Candidate",
  "private.runtime@example.invalid",
  SECRET,
]);

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

function checkpoint(cursor) {
  return {
    version: SOURCE_PARAFORM_HUMAN_PAGE_VERSION,
    boundaryAt: BOUNDARY,
    cursor,
  };
}

function reference(index, overrides = {}) {
  const scheduledAt = [
    "2026-07-25T02:00:00.000Z",
    "2026-07-24T03:00:00.000Z",
    "2026-07-24T02:00:00.000Z",
    "2026-07-23T02:00:00.000Z",
  ][index - 1];
  return {
    id: `private-runtime-call-${index}`,
    scheduledAt,
    createdAt: "2026-07-20T02:00:00.000Z",
    title: "Private Runtime Candidate / Recruiter",
    platform: "PHONE",
    recordingProvider: "TWILIO",
    owner: "Private Runtime Recruiter",
    ownerId: "private-runtime-owner",
    candidateUserId: `private-runtime-candidate-${index}`,
    hasTranscript: true,
    humanCall: true,
    candidate: {
      name: "Private Runtime Candidate",
      linkedin: "private-runtime-candidate",
      emails: ["private.runtime@example.invalid"],
    },
    ...overrides,
  };
}

function firstPage(overrides = {}) {
  return {
    version: SOURCE_PARAFORM_HUMAN_PAGE_VERSION,
    boundaryAt: BOUNDARY,
    exhausted: false,
    nextCheckpoint: checkpoint(2),
    scanned: 2,
    outsideBoundary: 0,
    references: [
      reference(1, {
        candidateUserId: "private-runtime-candidate-1",
      }),
      reference(2, {
        platform: "",
        recordingProvider: "",
        owner: "",
        ownerId: "",
        candidateUserId: "",
        hasTranscript: null,
        humanCall: false,
      }),
    ],
    ...overrides,
  };
}

function secondPage(overrides = {}) {
  return {
    version: SOURCE_PARAFORM_HUMAN_PAGE_VERSION,
    boundaryAt: BOUNDARY,
    exhausted: true,
    nextCheckpoint: null,
    scanned: 2,
    outsideBoundary: 0,
    references: [
      reference(3, {
        candidateUserId: "private-runtime-candidate-1",
      }),
      reference(4, {
        candidateUserId: "private-runtime-candidate-2",
      }),
    ],
    ...overrides,
  };
}

function pageReader(payloads) {
  let index = 0;
  const requests = [];
  const read = async (request) => {
    requests.push(structuredClone(request));
    const payload = payloads[index];
    index += 1;
    if (!payload) throw new Error("unexpected page read");
    return readPrivateParaformHumanSourcePage(
      request,
      {
        fetchImpl: async () => new Response(
          JSON.stringify(payload),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
            },
          },
        ),
        nowImpl: () => BOUNDARY_MS + 1_000,
        secret: SECRET,
        signalFactory: () => (
          Object.freeze({ syntheticSignal: true })
        ),
      },
    );
  };
  return {
    read,
    requests,
    get readCount() {
      return index;
    },
  };
}

function snapshot(record) {
  const raw = JSON.stringify(record);
  return Object.freeze({
    record,
    raw,
    rawSha1: createHash("sha1").update(raw).digest("hex"),
    redisNowMs: BOUNDARY_MS + 100,
  });
}

function identityMemory() {
  const state = {
    run: null,
    works: new Map(),
    ensureCalls: 0,
    createCalls: [],
    finalizeCalls: 0,
    readCalls: [],
  };
  const runKey = (context) => semanticDigest(
    "phase4-source-identity-observation-run-key-v1",
    context,
  );
  const ensure = async (context) => {
    state.ensureCalls += 1;
    if (!state.run) {
      state.run = {
        version: 1,
        policyVersion:
          SOURCE_IDENTITY_ARTIFACT_STORE_POLICY_VERSION,
        kind: "identity_observation_run_dark",
        status: "collecting",
        runKeyDigest: runKey(context),
        ...context,
        workKeyDigests: [],
        workManifestDigest: null,
        workManifestCount: null,
        createdAtMs: BOUNDARY_MS + 10,
        updatedAtMs: BOUNDARY_MS + 10,
        revision: 0,
        sealedArtifactDigest: null,
        sealedHeadRecordDigest: null,
      };
    }
    return snapshot(structuredClone(state.run));
  };
  const create = async (input) => {
    state.createCalls.push(input.privateWorkReference);
    await ensure({
      runNonceDigest: input.runNonceDigest,
      decisionBoundaryAtMs: input.decisionBoundaryAtMs,
      contractPinsDigest: input.contractPinsDigest,
    });
    assert.equal(state.run.status, "collecting");
    const workKeyDigest = semanticDigest(
      "phase4-source-identity-observation-work-key-v1",
      {
        runKeyDigest: state.run.runKeyDigest,
        workItemDigest: input.workItemDigest,
      },
    );
    if (!state.works.has(workKeyDigest)) {
      state.works.set(workKeyDigest, {
        version: 1,
        policyVersion:
          SOURCE_IDENTITY_ARTIFACT_STORE_POLICY_VERSION,
        kind: "identity_observation_work_dark",
        status: "awaiting_read_1",
        workKeyDigest,
        runKeyDigest: state.run.runKeyDigest,
        runNonceDigest: input.runNonceDigest,
        decisionBoundaryAtMs: input.decisionBoundaryAtMs,
        contractPinsDigest: input.contractPinsDigest,
        workItemDigest: input.workItemDigest,
        privateWorkReference: input.privateWorkReference,
        createdAtMs: BOUNDARY_MS + 20,
        updatedAtMs: BOUNDARY_MS + 20,
        revision: 0,
        activeClaim: null,
        readOne: null,
        readTwo: null,
        resolutionDigest: null,
        terminalReason: null,
      });
      state.run.workKeyDigests = [
        ...state.works.keys(),
      ].sort();
      state.run.updatedAtMs += 1;
      state.run.revision += 1;
    }
    return snapshot(
      structuredClone(state.works.get(workKeyDigest)),
    );
  };
  const finalize = async (context) => {
    state.finalizeCalls += 1;
    await ensure(context);
    if (state.run.status === "collecting") {
      state.run.status = "work_set_complete";
      state.run.workManifestDigest = semanticDigest(
        "phase4-source-identity-work-manifest-v1",
        {
          runNonceDigest: state.run.runNonceDigest,
          decisionBoundaryAtMs:
            state.run.decisionBoundaryAtMs,
          contractPinsDigest:
            state.run.contractPinsDigest,
          workKeyDigests: state.run.workKeyDigests,
        },
      );
      state.run.workManifestCount =
        state.run.workKeyDigests.length;
      state.run.updatedAtMs += 1;
      state.run.revision += 1;
    }
    return snapshot(structuredClone(state.run));
  };
  const read = async ({ workKeyDigest }) => {
    state.readCalls.push(workKeyDigest);
    const work = state.works.get(workKeyDigest);
    if (!work) throw new Error("missing work");
    return snapshot(structuredClone(work));
  };
  return {
    state,
    ensure,
    create,
    finalize,
    read,
  };
}

function proofMemory() {
  const records = new Map();
  let retainCalls = 0;
  const store = createSourceParaformHumanIdentityProofStore({
    configured: () => true,
    kvImpl: async (command) => {
      assert.equal(command[0], "EVAL");
      retainCalls += 1;
      const key = command[3];
      const existing = records.get(key);
      if (existing) {
        return [
          2,
          existing,
          createHash("sha1").update(existing).digest("hex"),
        ];
      }
      const record = JSON.parse(command[4]);
      record.retainedAtMs = BOUNDARY_MS + 2_000;
      const raw = JSON.stringify(record);
      records.set(key, raw);
      return [
        1,
        raw,
        createHash("sha1").update(raw).digest("hex"),
      ];
    },
  });
  return {
    records,
    store,
    get retainCalls() {
      return retainCalls;
    },
  };
}

function runtimeDependencies(reader, identity, proof) {
  return {
    createIdentityObservationWorkImpl: identity.create,
    ensureIdentityObservationRunImpl: identity.ensure,
    finalizeIdentityObservationWorkSetImpl: identity.finalize,
    readIdentityObservationWorkImpl: identity.read,
    readPrivateParaformHumanSourcePageImpl: reader.read,
    retainProofImpl: proof.store.retain,
  };
}

function input() {
  return {
    boundaryAt: BOUNDARY,
    runNonceDigest: RUN_NONCE_DIGEST,
  };
}

async function expectCode(operation, code) {
  await assert.rejects(
    operation,
    (error) => (
      error instanceof SourceParaformHumanIdentityProofRuntimeError
      && error.name
        === "SourceParaformHumanIdentityProofRuntimeError"
      && error.code === code
      && error.message === code
      && PRIVATE_MARKERS.every(
        (marker) => !error.message.includes(marker),
      )
    ),
  );
}

test("derives, finalizes, re-proves, and durably retains one exact universe", async () => {
  const reader = pageReader([
    firstPage(),
    secondPage(),
    firstPage(),
    secondPage(),
  ]);
  const identity = identityMemory();
  const proof = proofMemory();
  const result = await runParaformHumanIdentityProofRuntime(
    input(),
    runtimeDependencies(reader, identity, proof),
  );

  assert.equal(
    SOURCE_PARAFORM_HUMAN_IDENTITY_PROOF_RUNTIME_VERSION,
    "paraform-human-identity-proof-runtime-v1",
  );
  assert.equal(reader.readCount, 4);
  assert.deepEqual(reader.requests, [
    { boundaryAt: BOUNDARY, checkpoint: null },
    { boundaryAt: BOUNDARY, checkpoint: checkpoint(2) },
    { boundaryAt: BOUNDARY, checkpoint: null },
    { boundaryAt: BOUNDARY, checkpoint: checkpoint(2) },
  ]);
  assert.deepEqual(
    identity.state.createCalls,
    [
      "private-runtime-candidate-1",
      "private-runtime-candidate-2",
    ],
  );
  assert.equal(identity.state.finalizeCalls, 1);
  assert.equal(identity.state.readCalls.length, 2);
  assert.equal(proof.retainCalls, 1);
  assert.equal(proof.records.size, 1);
  assert.deepEqual(result, {
    version:
      SOURCE_PARAFORM_HUMAN_IDENTITY_PROOF_RUNTIME_VERSION,
    boundaryAt: BOUNDARY,
    runKeyDigest: result.runKeyDigest,
    proofDigest: result.proofDigest,
    recordRevisionSha1: result.recordRevisionSha1,
    retainedAtMs: BOUNDARY_MS + 2_000,
    proofCreated: true,
    proofDuplicate: false,
    passCount: 2,
    pageCount: 2,
    scannedCount: 4,
    sourceReferenceCount: 4,
    humanReferenceCount: 3,
    nonHumanReferenceCount: 1,
    identityWorkCount: 2,
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
  });
  for (const digest of [
    result.runKeyDigest,
    result.proofDigest,
  ]) {
    assert.match(digest, /^[a-f0-9]{64}$/u);
  }
  assert.match(
    result.recordRevisionSha1,
    /^[a-f0-9]{40}$/u,
  );
  assert.equal(Object.isFrozen(result), true);
  const serialized = JSON.stringify(result);
  for (const marker of PRIVATE_MARKERS) {
    assert.equal(serialized.includes(marker), false);
  }
});

test("same server-owned context resumes without adding work and replays proof", async () => {
  const identity = identityMemory();
  const proof = proofMemory();
  const firstReader = pageReader([
    firstPage(),
    secondPage(),
    firstPage(),
    secondPage(),
  ]);
  const first = await runParaformHumanIdentityProofRuntime(
    input(),
    runtimeDependencies(firstReader, identity, proof),
  );
  const secondReader = pageReader([
    firstPage(),
    secondPage(),
    firstPage(),
    secondPage(),
  ]);
  const second = await runParaformHumanIdentityProofRuntime(
    input(),
    runtimeDependencies(secondReader, identity, proof),
  );

  assert.equal(first.proofCreated, true);
  assert.equal(second.proofCreated, false);
  assert.equal(second.proofDuplicate, true);
  assert.equal(second.proofDigest, first.proofDigest);
  assert.equal(
    second.recordRevisionSha1,
    first.recordRevisionSha1,
  );
  assert.equal(identity.state.createCalls.length, 2);
  assert.equal(identity.state.works.size, 2);
  assert.equal(proof.records.size, 1);
});

test("second-pass drift cannot retain a proof or expose private state", async () => {
  const reader = pageReader([
    firstPage(),
    secondPage(),
    firstPage({
      references: [
        reference(1, {
          title: "Drifted private title",
          candidateUserId: "private-runtime-candidate-1",
        }),
        reference(2, {
          platform: "",
          recordingProvider: "",
          owner: "",
          ownerId: "",
          candidateUserId: "",
          hasTranscript: null,
          humanCall: false,
        }),
      ],
    }),
    secondPage(),
  ]);
  const identity = identityMemory();
  const proof = proofMemory();
  await expectCode(
    () => runParaformHumanIdentityProofRuntime(
      input(),
      runtimeDependencies(reader, identity, proof),
    ),
    "SOURCE_PARAFORM_HUMAN_IDENTITY_PROOF_RUNTIME_FAILED",
  );
  assert.equal(identity.state.run.status, "work_set_complete");
  assert.equal(proof.retainCalls, 0);
  assert.equal(proof.records.size, 0);
});

test("an existing finalized wrong work index cannot retain a proof", async () => {
  const identity = identityMemory();
  const storeContext = {
    runNonceDigest: RUN_NONCE_DIGEST,
    decisionBoundaryAtMs: BOUNDARY_MS,
    contractPinsDigest:
      SOURCE_PARAFORM_HUMAN_IDENTITY_EXHAUSTIVENESS_CONTRACT_PINS_DIGEST,
  };
  const wrong = paraformHumanIdentityWorkItem(
    "private-runtime-candidate-extra",
  );
  await identity.ensure(storeContext);
  await identity.create({
    ...storeContext,
    ...wrong,
  });
  await identity.finalize(storeContext);
  const reader = pageReader([
    firstPage(),
    secondPage(),
    firstPage(),
    secondPage(),
  ]);
  const proof = proofMemory();
  await expectCode(
    () => runParaformHumanIdentityProofRuntime(
      input(),
      runtimeDependencies(reader, identity, proof),
    ),
    "SOURCE_PARAFORM_HUMAN_IDENTITY_PROOF_RUNTIME_FAILED",
  );
  assert.equal(identity.state.createCalls.length, 1);
  assert.equal(identity.state.works.size, 1);
  assert.equal(proof.retainCalls, 0);
});

test("unissued pages and incomplete Human identity fail before durable work", async () => {
  for (const [name, read] of [
    [
      "unissued",
      async () => firstPage({
        exhausted: true,
        nextCheckpoint: null,
      }),
    ],
    [
      "missing identity",
      pageReader([
        {
          ...secondPage(),
          scanned: 1,
          references: [
            reference(4, { candidateUserId: "" }),
          ],
        },
      ]).read,
    ],
  ]) {
    const identity = identityMemory();
    const proof = proofMemory();
    await expectCode(
      () => runParaformHumanIdentityProofRuntime(
        input(),
        runtimeDependencies(
          { read },
          identity,
          proof,
        ),
      ),
      "SOURCE_PARAFORM_HUMAN_IDENTITY_PROOF_RUNTIME_FAILED",
    );
    assert.equal(
      identity.state.ensureCalls,
      0,
      name,
    );
    assert.equal(proof.retainCalls, 0, name);
  }
});

test("retention failure cannot become a durable or authoritative result", async () => {
  const reader = pageReader([
    firstPage(),
    secondPage(),
    firstPage(),
    secondPage(),
  ]);
  const identity = identityMemory();
  const proof = proofMemory();
  const dependencies = runtimeDependencies(
    reader,
    identity,
    proof,
  );
  dependencies.retainProofImpl = async () => {
    throw new Error(
      `${PRIVATE_MARKERS[0]} ${SECRET}`,
    );
  };
  await expectCode(
    () => runParaformHumanIdentityProofRuntime(
      input(),
      dependencies,
    ),
    "SOURCE_PARAFORM_HUMAN_IDENTITY_PROOF_RUNTIME_FAILED",
  );
  assert.equal(proof.records.size, 0);
});

test("hostile input and expanded dependencies fail before any I/O", async () => {
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
    () => runParaformHumanIdentityProofRuntime(hostile),
    "SOURCE_PARAFORM_HUMAN_IDENTITY_PROOF_RUNTIME_INPUT_INVALID",
  );
  assert.equal(executed, false);

  const reader = pageReader([]);
  const identity = identityMemory();
  const proof = proofMemory();
  await expectCode(
    () => runParaformHumanIdentityProofRuntime(
      input(),
      {
        ...runtimeDependencies(reader, identity, proof),
        force: true,
      },
    ),
    "SOURCE_PARAFORM_HUMAN_IDENTITY_PROOF_RUNTIME_DEPENDENCIES_INVALID",
  );
  assert.equal(reader.readCount, 0);
  assert.equal(identity.state.ensureCalls, 0);
  assert.equal(proof.retainCalls, 0);
});
