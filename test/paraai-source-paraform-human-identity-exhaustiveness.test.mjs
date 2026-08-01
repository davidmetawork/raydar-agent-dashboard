import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  SOURCE_PARAFORM_HUMAN_PAGE_TIMEOUT_MS,
  SOURCE_PARAFORM_HUMAN_PAGE_VERSION,
  readPrivateParaformHumanSourcePage,
} from "../api/paraai/_lib/source-paraform-human-page-client.mjs";
import {
  SOURCE_IDENTITY_ARTIFACT_STORE_POLICY_VERSION,
} from "../api/paraai/_lib/source-identity-artifact-store.mjs";
import {
  SOURCE_PARAFORM_HUMAN_IDENTITY_EXHAUSTIVENESS_CONTRACT_PINS_DIGEST,
  SOURCE_PARAFORM_HUMAN_IDENTITY_EXHAUSTIVENESS_VERSION,
  SourceParaformHumanIdentityExhaustivenessError,
  assertParaformHumanIdentityExhaustivenessProofResult,
  paraformHumanIdentityWorkItem,
  proveParaformHumanIdentityExhaustiveness,
  validateParaformHumanIdentityExhaustivenessProof,
} from "../api/paraai/_lib/source-paraform-human-identity-exhaustiveness.mjs";

const BOUNDARY = "2026-07-26T03:00:00.000Z";
const BOUNDARY_MS = Date.parse(BOUNDARY);
const NOW_MS = BOUNDARY_MS + 1_000;
const SECRET =
  "synthetic-exhaustiveness-page-secret".padEnd(48, "s");
const PRIVATE_MARKERS = Object.freeze([
  "private-call-1",
  "private-call-2",
  "private-call-3",
  "private-call-4",
  "private-candidate-user-1",
  "private-candidate-user-2",
  "Private Candidate",
  "private.candidate@example.invalid",
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

function request(checkpointValue = null) {
  return {
    boundaryAt: BOUNDARY,
    checkpoint: checkpointValue,
  };
}

function reference(index, overrides = {}) {
  const scheduled = [
    "2026-07-25T02:00:00.000Z",
    "2026-07-24T03:00:00.000Z",
    "2026-07-24T02:00:00.000Z",
    "2026-07-23T02:00:00.000Z",
  ][index - 1];
  return {
    id: `private-call-${index}`,
    scheduledAt: scheduled,
    createdAt: "2026-07-20T02:00:00.000Z",
    title: "Private Candidate / Recruiter",
    platform: "PHONE",
    recordingProvider: "TWILIO",
    owner: "Private Recruiter",
    ownerId: "private-owner-id",
    candidateUserId: `private-candidate-user-${index}`,
    hasTranscript: true,
    humanCall: true,
    candidate: {
      name: "Private Candidate",
      linkedin: "private-candidate",
      emails: ["private.candidate@example.invalid"],
    },
    ...overrides,
  };
}

function pageOne(overrides = {}) {
  return {
    version: SOURCE_PARAFORM_HUMAN_PAGE_VERSION,
    boundaryAt: BOUNDARY,
    exhausted: false,
    nextCheckpoint: checkpoint(2),
    scanned: 2,
    outsideBoundary: 0,
    references: [
      reference(1, {
        candidateUserId: "private-candidate-user-1",
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

function pageTwo(overrides = {}) {
  return {
    version: SOURCE_PARAFORM_HUMAN_PAGE_VERSION,
    boundaryAt: BOUNDARY,
    exhausted: true,
    nextCheckpoint: null,
    scanned: 2,
    outsideBoundary: 0,
    references: [
      reference(3, {
        candidateUserId: "private-candidate-user-1",
      }),
      reference(4, {
        candidateUserId: "private-candidate-user-2",
      }),
    ],
    ...overrides,
  };
}

function jsonResponse(value) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: {
      "content-type": "application/json",
    },
  });
}

async function issue(requestValue, payload) {
  return readPrivateParaformHumanSourcePage(
    requestValue,
    {
      fetchImpl: async () => jsonResponse(payload),
      nowImpl: () => NOW_MS,
      secret: SECRET,
      signalFactory: (timeoutMs) => {
        assert.equal(
          timeoutMs,
          SOURCE_PARAFORM_HUMAN_PAGE_TIMEOUT_MS,
        );
        return Object.freeze({ syntheticSignal: true });
      },
    },
  );
}

async function issuedPass(
  passNumber,
  {
    firstRequest = request(),
    firstPage = pageOne(),
    secondRequest = request(checkpoint(2)),
    secondPage = pageTwo(),
    includeSecondRead = true,
  } = {},
) {
  const reads = [{
    request: firstRequest,
    page: await issue(firstRequest, firstPage),
  }];
  if (includeSecondRead) {
    reads.push({
      request: secondRequest,
      page: await issue(secondRequest, secondPage),
    });
  }
  return {
    passNumber,
    reads,
  };
}

function records(
  candidateUserIds = [
    "private-candidate-user-1",
    "private-candidate-user-2",
  ],
  overrides = {},
) {
  const {
    decisionBoundaryAtMs = BOUNDARY_MS,
    contractPinsDigest =
      SOURCE_PARAFORM_HUMAN_IDENTITY_EXHAUSTIVENESS_CONTRACT_PINS_DIGEST,
    status = "work_set_complete",
    ...runOverrides
  } = overrides;
  const runNonceDigest = semanticDigest(
    "test-paraform-human-run-nonce-v1",
    { nonce: "synthetic" },
  );
  const runKeyDigest = semanticDigest(
    "phase4-source-identity-observation-run-key-v1",
    {
      runNonceDigest,
      decisionBoundaryAtMs,
      contractPinsDigest,
    },
  );
  const works = candidateUserIds.map((candidateUserId) => {
    const item = paraformHumanIdentityWorkItem(
      candidateUserId,
    );
    const workKeyDigest = semanticDigest(
      "phase4-source-identity-observation-work-key-v1",
      {
        runKeyDigest,
        workItemDigest: item.workItemDigest,
      },
    );
    return {
      version: 1,
      policyVersion:
        SOURCE_IDENTITY_ARTIFACT_STORE_POLICY_VERSION,
      kind: "identity_observation_work_dark",
      status: "awaiting_read_1",
      workKeyDigest,
      runKeyDigest,
      runNonceDigest,
      decisionBoundaryAtMs,
      contractPinsDigest,
      workItemDigest: item.workItemDigest,
      privateWorkReference: item.privateWorkReference,
      createdAtMs: decisionBoundaryAtMs + 10,
      updatedAtMs: decisionBoundaryAtMs + 10,
      revision: 0,
      activeClaim: null,
      readOne: null,
      readTwo: null,
      resolutionDigest: null,
      terminalReason: null,
    };
  });
  const workKeyDigests = works
    .map((work) => work.workKeyDigest)
    .sort();
  const workManifestDigest = semanticDigest(
    "phase4-source-identity-work-manifest-v1",
    {
      runNonceDigest,
      decisionBoundaryAtMs,
      contractPinsDigest,
      workKeyDigests,
    },
  );
  const run = {
    version: 1,
    policyVersion:
      SOURCE_IDENTITY_ARTIFACT_STORE_POLICY_VERSION,
    kind: "identity_observation_run_dark",
    status,
    runKeyDigest,
    runNonceDigest,
    decisionBoundaryAtMs,
    contractPinsDigest,
    workKeyDigests,
    workManifestDigest: status === "collecting"
      ? null
      : workManifestDigest,
    workManifestCount: status === "collecting"
      ? null
      : workKeyDigests.length,
    createdAtMs: decisionBoundaryAtMs + 10,
    updatedAtMs: decisionBoundaryAtMs + 20,
    revision: 1,
    sealedArtifactDigest: null,
    sealedHeadRecordDigest: null,
    ...runOverrides,
  };
  return { run, works };
}

async function validInput(options = {}) {
  const passes = [
    await issuedPass(1, options.firstPass),
    await issuedPass(2, options.secondPass),
  ];
  return {
    passes,
    ...records(options.candidateUserIds, options.runOverrides),
  };
}

function expectInvalid(operation) {
  assert.throws(
    operation,
    (error) => (
      error
        instanceof SourceParaformHumanIdentityExhaustivenessError
      && error.name
        === "SourceParaformHumanIdentityExhaustivenessError"
      && error.code
        === "SOURCE_PARAFORM_HUMAN_IDENTITY_EXHAUSTIVENESS_INVALID"
      && error.message === error.code
    ),
  );
}

test("proves two stable passes equal one work per unique Human", async () => {
  const input = await validInput();
  const proof = proveParaformHumanIdentityExhaustiveness(
    input,
  );

  assert.equal(
    SOURCE_PARAFORM_HUMAN_IDENTITY_EXHAUSTIVENESS_VERSION,
    "paraform-human-identity-exhaustiveness-v1",
  );
  assert.deepEqual(proof, {
    version:
      SOURCE_PARAFORM_HUMAN_IDENTITY_EXHAUSTIVENESS_VERSION,
    policyVersion:
      SOURCE_IDENTITY_ARTIFACT_STORE_POLICY_VERSION,
    privatePageClientVersion:
      "paraform-human-private-page-client-v1",
    privatePageVersion:
      SOURCE_PARAFORM_HUMAN_PAGE_VERSION,
    identityPointReadProcedure:
      "candidateUser.getCandidateUserById",
    boundaryAt: BOUNDARY,
    contractPinsDigest:
      SOURCE_PARAFORM_HUMAN_IDENTITY_EXHAUSTIVENESS_CONTRACT_PINS_DIGEST,
    passCount: 2,
    pageCount: 2,
    scannedCount: 4,
    outsideBoundaryCount: 0,
    sourceReferenceCount: 4,
    humanReferenceCount: 3,
    nonHumanReferenceCount: 1,
    uniqueCandidateUserCount: 2,
    sourcePassDigest: proof.sourcePassDigest,
    identityUniverseDigest: proof.identityUniverseDigest,
    workManifestDigest: input.run.workManifestDigest,
    workManifestCount: 2,
    identityWorkSetDigest: proof.identityWorkSetDigest,
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
    proofDigest: proof.proofDigest,
  });
  for (const digest of [
    proof.contractPinsDigest,
    proof.sourcePassDigest,
    proof.identityUniverseDigest,
    proof.workManifestDigest,
    proof.identityWorkSetDigest,
    proof.proofDigest,
  ]) {
    assert.match(digest, /^[a-f0-9]{64}$/u);
  }
  assert.equal(Object.isFrozen(proof), true);
  const serialized = JSON.stringify(proof);
  for (const marker of PRIVATE_MARKERS) {
    assert.equal(serialized.includes(marker), false);
  }
});

test("work-item derivation is exact, bounded, and domain separated", () => {
  const item = paraformHumanIdentityWorkItem(
    "private-candidate-user-1",
  );
  assert.deepEqual(item, {
    privateWorkReference: "private-candidate-user-1",
    workItemDigest: semanticDigest(
      "phase4-paraform-human-identity-work-item-v1",
      { candidateUserId: "private-candidate-user-1" },
    ),
  });
  assert.equal(Object.isFrozen(item), true);
  for (const invalid of [
    "",
    " private",
    "private ",
    "private\ncandidate",
    "x".repeat(257),
    null,
  ]) {
    assert.throws(
      () => paraformHumanIdentityWorkItem(invalid),
      (error) => (
        error
          instanceof SourceParaformHumanIdentityExhaustivenessError
        && error.code
          === "SOURCE_PARAFORM_HUMAN_IDENTITY_WORK_ITEM_INVALID"
      ),
    );
  }
});

test("proof readback validates independently while issuance provenance rejects clones", async () => {
  const input = await validInput();
  const proof = proveParaformHumanIdentityExhaustiveness(
    input,
  );
  assert.equal(
    assertParaformHumanIdentityExhaustivenessProofResult(
      proof,
      input.run.runKeyDigest,
    ),
    proof,
  );
  const readback = validateParaformHumanIdentityExhaustivenessProof(
    structuredClone(proof),
  );
  assert.deepEqual(readback, proof);
  assert.equal(Object.isFrozen(readback), true);
  assert.throws(
    () => assertParaformHumanIdentityExhaustivenessProofResult(
      structuredClone(proof),
    ),
    (error) => (
      error
        instanceof SourceParaformHumanIdentityExhaustivenessError
      && error.code
        === "SOURCE_PARAFORM_HUMAN_IDENTITY_EXHAUSTIVENESS_INVALID"
    ),
  );
  assert.throws(
    () => assertParaformHumanIdentityExhaustivenessProofResult(
      proof,
      "f".repeat(64),
    ),
    (error) => (
      error
        instanceof SourceParaformHumanIdentityExhaustivenessError
      && error.code
        === "SOURCE_PARAFORM_HUMAN_IDENTITY_EXHAUSTIVENESS_INVALID"
    ),
  );
  for (const mutation of [
    { proofDigest: "f".repeat(64) },
    { workManifestCount: proof.workManifestCount + 1 },
    { operational: true },
    { debug: true },
  ]) {
    assert.throws(
      () => validateParaformHumanIdentityExhaustivenessProof({
        ...proof,
        ...mutation,
      }),
      (error) => (
        error
          instanceof SourceParaformHumanIdentityExhaustivenessError
        && error.code
          === "SOURCE_PARAFORM_HUMAN_IDENTITY_EXHAUSTIVENESS_INVALID"
      ),
    );
  }
});

test("rejects cloned, fabricated, and reused source pages", async (t) => {
  await t.test("clone", async () => {
    const input = await validInput();
    input.passes[0].reads[0] = {
      ...input.passes[0].reads[0],
      page: structuredClone(input.passes[0].reads[0].page),
    };
    expectInvalid(
      () => proveParaformHumanIdentityExhaustiveness(input),
    );
  });

  await t.test("fabricated", async () => {
    const input = await validInput();
    input.passes[0].reads[0] = {
      ...input.passes[0].reads[0],
      page: pageOne(),
    };
    expectInvalid(
      () => proveParaformHumanIdentityExhaustiveness(input),
    );
  });

  await t.test("cross-pass reuse", async () => {
    const input = await validInput();
    input.passes[1].reads[0] = {
      ...input.passes[1].reads[0],
      page: input.passes[0].reads[0].page,
    };
    expectInvalid(
      () => proveParaformHumanIdentityExhaustiveness(input),
    );
  });
});

test("rejects incomplete cursors and duplicate source records", async (t) => {
  await t.test("incomplete terminal coverage", async () => {
    const input = await validInput();
    input.passes[0] = await issuedPass(1, {
      includeSecondRead: false,
    });
    expectInvalid(
      () => proveParaformHumanIdentityExhaustiveness(input),
    );
  });

  await t.test("broken checkpoint continuity", async () => {
    const input = await validInput();
    input.passes[0] = await issuedPass(1, {
      secondRequest: request(checkpoint(3)),
    });
    expectInvalid(
      () => proveParaformHumanIdentityExhaustiveness(input),
    );
  });

  await t.test("duplicate record across pages", async () => {
    const input = await validInput();
    input.passes[0] = await issuedPass(1, {
      secondPage: pageTwo({
        references: [
          reference(3, {
            id: "private-call-1",
            candidateUserId: "private-candidate-user-1",
          }),
          reference(4, {
            candidateUserId: "private-candidate-user-2",
          }),
        ],
      }),
    });
    expectInvalid(
      () => proveParaformHumanIdentityExhaustiveness(input),
    );
  });

  await t.test("Human without candidate user identity", async () => {
    const input = await validInput();
    input.passes[0] = await issuedPass(1, {
      secondPage: pageTwo({
        references: [
          reference(3, { candidateUserId: "" }),
          reference(4, {
            candidateUserId: "private-candidate-user-2",
          }),
        ],
      }),
    });
    expectInvalid(
      () => proveParaformHumanIdentityExhaustiveness(input),
    );
  });
});

test("rejects any full-source drift between the two passes", async (t) => {
  for (const [name, secondPass] of [
    [
      "Human metadata",
      {
        secondPage: pageTwo({
          references: [
            reference(3, {
              candidateUserId: "private-candidate-user-1",
              title: "Changed private title",
            }),
            reference(4, {
              candidateUserId: "private-candidate-user-2",
            }),
          ],
        }),
      },
    ],
    [
      "non-Human metadata",
      {
        firstPage: pageOne({
          references: [
            reference(1, {
              candidateUserId: "private-candidate-user-1",
            }),
            reference(2, {
              title: "Changed non-Human private title",
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
      },
    ],
  ]) {
    await t.test(name, async () => {
      const input = await validInput({
        secondPass,
      });
      expectInvalid(
        () => proveParaformHumanIdentityExhaustiveness(input),
      );
    });
  }
});

test("rejects unfinalized, wrong-boundary, or wrong-contract runs", async (t) => {
  for (const [name, recordOverrides] of [
    ["unfinalized", { status: "collecting" }],
    [
      "wrong boundary",
      { decisionBoundaryAtMs: BOUNDARY_MS + 1 },
    ],
    [
      "wrong contract",
      { contractPinsDigest: "f".repeat(64) },
    ],
  ]) {
    await t.test(name, async () => {
      const input = await validInput();
      Object.assign(
        input,
        records(undefined, recordOverrides),
      );
      expectInvalid(
        () => proveParaformHumanIdentityExhaustiveness(input),
      );
    });
  }
});

test("rejects missing, extra, or inconsistent identity work", async (t) => {
  await t.test("missing", async () => {
    const input = await validInput();
    input.works = input.works.slice(0, 1);
    expectInvalid(
      () => proveParaformHumanIdentityExhaustiveness(input),
    );
  });

  await t.test("extra", async () => {
    const input = await validInput();
    input.works = [...input.works, input.works[0]];
    expectInvalid(
      () => proveParaformHumanIdentityExhaustiveness(input),
    );
  });

  await t.test("wrong private work universe", async () => {
    const input = await validInput();
    Object.assign(
      input,
      records([
        "private-candidate-user-1",
        "private-candidate-user-extra",
      ]),
    );
    expectInvalid(
      () => proveParaformHumanIdentityExhaustiveness(input),
    );
  });
});

test("rejects hostile shapes without executing accessors", async () => {
  const input = await validInput();
  let executed = false;
  const hostile = Object.defineProperty(
    {
      passes: input.passes,
      works: input.works,
    },
    "run",
    {
      enumerable: true,
      get() {
        executed = true;
        throw new Error("must not execute");
      },
    },
  );
  expectInvalid(
    () => proveParaformHumanIdentityExhaustiveness(hostile),
  );
  assert.equal(executed, false);
});
