import assert from "node:assert/strict";
import {
  createHash,
} from "node:crypto";
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
  proveParaformHumanIdentityExhaustiveness,
} from "../api/paraai/_lib/source-paraform-human-identity-exhaustiveness.mjs";
import {
  SOURCE_PARAFORM_HUMAN_IDENTITY_PROOF_STORE_POLICY_VERSION,
  SourceParaformHumanIdentityProofStoreError,
  createSourceParaformHumanIdentityProofStore,
} from "../api/paraai/_lib/source-paraform-human-identity-proof-store.mjs";

const BOUNDARY = "2026-07-26T03:00:00.000Z";
const BOUNDARY_MS = Date.parse(BOUNDARY);
const SECRET =
  "synthetic-proof-store-page-secret".padEnd(48, "s");
const CANDIDATE_USER_ID = "private-candidate-user-proof";
const RUN_NONCE_DIGEST = createHash("sha256")
  .update("synthetic-proof-store-run")
  .digest("hex");

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

function reference(title) {
  return {
    id: "private-proof-call",
    scheduledAt: "2026-07-25T02:00:00.000Z",
    createdAt: "2026-07-24T02:00:00.000Z",
    title,
    platform: "PHONE",
    recordingProvider: "TWILIO",
    owner: "Private Recruiter",
    ownerId: "private-owner",
    candidateUserId: CANDIDATE_USER_ID,
    hasTranscript: true,
    humanCall: true,
    candidate: {
      name: "Private Candidate",
      linkedin: "private-candidate",
      emails: ["private.candidate@example.invalid"],
    },
  };
}

function page(title) {
  return {
    version: SOURCE_PARAFORM_HUMAN_PAGE_VERSION,
    boundaryAt: BOUNDARY,
    exhausted: true,
    nextCheckpoint: null,
    scanned: 1,
    outsideBoundary: 0,
    references: [reference(title)],
  };
}

async function issuedPage(title) {
  return readPrivateParaformHumanSourcePage(
    {
      boundaryAt: BOUNDARY,
      checkpoint: null,
    },
    {
      fetchImpl: async () => new Response(
        JSON.stringify(page(title)),
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
}

function identityRecords() {
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
  const item = paraformHumanIdentityWorkItem(
    CANDIDATE_USER_ID,
  );
  const workKeyDigest = semanticDigest(
    "phase4-source-identity-observation-work-key-v1",
    {
      runKeyDigest,
      workItemDigest: item.workItemDigest,
    },
  );
  const workKeyDigests = [workKeyDigest];
  const workManifestDigest = semanticDigest(
    "phase4-source-identity-work-manifest-v1",
    {
      runNonceDigest: RUN_NONCE_DIGEST,
      decisionBoundaryAtMs: BOUNDARY_MS,
      contractPinsDigest,
      workKeyDigests,
    },
  );
  return {
    run: {
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
      workManifestCount: 1,
      createdAtMs: BOUNDARY_MS + 10,
      updatedAtMs: BOUNDARY_MS + 20,
      revision: 1,
      sealedArtifactDigest: null,
      sealedHeadRecordDigest: null,
    },
    works: [{
      version: 1,
      policyVersion:
        SOURCE_IDENTITY_ARTIFACT_STORE_POLICY_VERSION,
      kind: "identity_observation_work_dark",
      status: "awaiting_read_1",
      workKeyDigest,
      runKeyDigest,
      runNonceDigest: RUN_NONCE_DIGEST,
      decisionBoundaryAtMs: BOUNDARY_MS,
      contractPinsDigest,
      workItemDigest: item.workItemDigest,
      privateWorkReference: item.privateWorkReference,
      createdAtMs: BOUNDARY_MS + 10,
      updatedAtMs: BOUNDARY_MS + 10,
      revision: 0,
      activeClaim: null,
      readOne: null,
      readTwo: null,
      resolutionDigest: null,
      terminalReason: null,
    }],
  };
}

async function issuedProof(
  title = "Private Candidate / Recruiter",
) {
  const first = await issuedPage(title);
  const second = await issuedPage(title);
  const request = {
    boundaryAt: BOUNDARY,
    checkpoint: null,
  };
  return proveParaformHumanIdentityExhaustiveness({
    passes: [
      {
        passNumber: 1,
        reads: [{ request, page: first }],
      },
      {
        passNumber: 2,
        reads: [{ request, page: second }],
      },
    ],
    ...identityRecords(),
  });
}

function memoryKv() {
  const records = new Map();
  const commands = [];
  const kvImpl = async (command) => {
    commands.push(command);
    if (command[0] === "GET") {
      return records.get(command[1]) ?? null;
    }
    assert.equal(command[0], "EVAL");
    const key = command[3];
    const existing = records.get(key);
    if (existing) {
      return [
        2,
        existing,
        createHash("sha1").update(existing).digest("hex"),
      ];
    }
    const proposed = JSON.parse(command[4]);
    proposed.retainedAtMs = BOUNDARY_MS + 2_000;
    const raw = JSON.stringify(proposed);
    records.set(key, raw);
    return [
      1,
      raw,
      createHash("sha1").update(raw).digest("hex"),
    ];
  };
  return { records, commands, kvImpl };
}

function expectCode(operation, code) {
  return assert.rejects(
    operation,
    (error) => (
      error instanceof SourceParaformHumanIdentityProofStoreError
      && error.name
        === "SourceParaformHumanIdentityProofStoreError"
      && error.code === code
      && error.message === code
    ),
  );
}

test("retains one issued digest-only proof and exact replay is local", async () => {
  const proof = await issuedProof();
  const memory = memoryKv();
  const store = createSourceParaformHumanIdentityProofStore({
    configured: () => true,
    kvImpl: memory.kvImpl,
  });
  const { run } = identityRecords();

  const created = await store.retain({
    runKeyDigest: run.runKeyDigest,
    proof,
  });
  const duplicate = await store.retain({
    runKeyDigest: run.runKeyDigest,
    proof,
  });
  const readback = await store.read({
    runKeyDigest: run.runKeyDigest,
  });

  assert.equal(
    SOURCE_PARAFORM_HUMAN_IDENTITY_PROOF_STORE_POLICY_VERSION,
    "phase4-paraform-human-identity-proof-store-v1",
  );
  assert.equal(created.created, true);
  assert.equal(created.duplicate, false);
  assert.equal(duplicate.created, false);
  assert.equal(duplicate.duplicate, true);
  assert.equal(created.proofDigest, proof.proofDigest);
  assert.equal(duplicate.recordRevisionSha1,
    created.recordRevisionSha1);
  assert.equal(readback.proofDigest, proof.proofDigest);
  assert.equal(readback.runKeyDigest, run.runKeyDigest);
  assert.equal(readback.retainedAtMs, BOUNDARY_MS + 2_000);
  assert.equal(memory.records.size, 1);
  assert.equal(memory.commands.length, 3);
  for (const result of [created, duplicate, readback]) {
    assert.equal(result.operational, false);
    assert.equal(result.pinnable, false);
    assert.equal(result.sourceAuthorityAvailable, false);
    assert.equal(result.activationAvailable, false);
    assert.equal(result.writeAuthorityAvailable, false);
    assert.equal(Object.isFrozen(result), true);
    const serialized = JSON.stringify(result);
    for (const marker of [
      CANDIDATE_USER_ID,
      "Private Candidate",
      "private-proof-call",
      SECRET,
    ]) {
      assert.equal(serialized.includes(marker), false);
    }
  }
});

test("first proof wins and a different issued proof conflicts", async () => {
  const first = await issuedProof("First private title");
  const second = await issuedProof("Second private title");
  const memory = memoryKv();
  const store = createSourceParaformHumanIdentityProofStore({
    configured: () => true,
    kvImpl: memory.kvImpl,
  });
  const { run } = identityRecords();
  await store.retain({
    runKeyDigest: run.runKeyDigest,
    proof: first,
  });
  await expectCode(
    () => store.retain({
      runKeyDigest: run.runKeyDigest,
      proof: second,
    }),
    "SOURCE_PARAFORM_HUMAN_IDENTITY_PROOF_STORE_CONFLICT",
  );
  assert.equal(memory.records.size, 1);
});

test("cloned or malformed proof input fails before storage", async () => {
  const proof = await issuedProof();
  const memory = memoryKv();
  const store = createSourceParaformHumanIdentityProofStore({
    configured: () => true,
    kvImpl: memory.kvImpl,
  });
  const { run } = identityRecords();
  for (const input of [
    {
      runKeyDigest: run.runKeyDigest,
      proof: structuredClone(proof),
    },
    {
      runKeyDigest: "x",
      proof,
    },
    {
      runKeyDigest: "f".repeat(64),
      proof,
    },
    {
      runKeyDigest: run.runKeyDigest,
      proof,
      force: true,
    },
  ]) {
    await expectCode(
      () => store.retain(input),
      "SOURCE_PARAFORM_HUMAN_IDENTITY_PROOF_STORE_INPUT_INVALID",
    );
  }
  assert.equal(memory.commands.length, 0);
});

test("configuration, transport, and readback failures stay generic", async () => {
  const proof = await issuedProof();
  const { run } = identityRecords();
  const unavailable = createSourceParaformHumanIdentityProofStore({
    configured: () => false,
    kvImpl: async () => {
      throw new Error("must not execute");
    },
  });
  await expectCode(
    () => unavailable.retain({
      runKeyDigest: run.runKeyDigest,
      proof,
    }),
    "SOURCE_PARAFORM_HUMAN_IDENTITY_PROOF_STORE_UNAVAILABLE",
  );

  const failed = createSourceParaformHumanIdentityProofStore({
    configured: () => true,
    kvImpl: async () => {
      throw new Error(`${CANDIDATE_USER_ID} ${SECRET}`);
    },
  });
  await expectCode(
    () => failed.retain({
      runKeyDigest: run.runKeyDigest,
      proof,
    }),
    "SOURCE_PARAFORM_HUMAN_IDENTITY_PROOF_STORE_UNAVAILABLE",
  );

  const malformed = createSourceParaformHumanIdentityProofStore({
    configured: () => true,
    kvImpl: async () => [1, "{}", "x"],
  });
  await expectCode(
    () => malformed.retain({
      runKeyDigest: run.runKeyDigest,
      proof,
    }),
    "SOURCE_PARAFORM_HUMAN_IDENTITY_PROOF_STORE_READBACK_INVALID",
  );
});
