import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  SOURCE_IDENTITY_POINT_COLLECTOR_VERSION,
  SourceIdentityPointCollectorError,
  candidateUserIdentityPointEvidence,
  candidateUserIdentityPointReadInput,
  normalizeCandidateUserIdentityPointRecord,
} from "../api/paraai/_lib/source-identity-point-collector.mjs";
import {
  SOURCE_IDENTITY_POINT_READ_PROCEDURES,
} from "../api/paraai/_lib/source-watermark.mjs";

const CANDIDATE_USER_A = "candidate-user-test-a";
const CANDIDATE_USER_B = "candidate-user-test-b";
const CANDIDATE_A = "candidate-test-a";
const CANDIDATE_B = "candidate-test-b";

function canonicalJson(value) {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
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

function record({
  candidateUserId = CANDIDATE_USER_A,
  candidateId = CANDIDATE_A,
  ...fields
} = {}) {
  return {
    id: candidateUserId,
    candidate: { id: candidateId },
    ...fields,
  };
}

function expectCode(fn, code) {
  assert.throws(
    fn,
    (error) => (
      error instanceof SourceIdentityPointCollectorError
      && error.code === code
      && error.message === code
    ),
  );
}

test("identity point input and root projection are exact and frozen", () => {
  const input = candidateUserIdentityPointReadInput(
    CANDIDATE_USER_A,
  );
  assert.deepEqual(input, {
    candidate_user_id: CANDIDATE_USER_A,
  });
  assert.equal(Object.isFrozen(input), true);
  assert.equal(
    SOURCE_IDENTITY_POINT_COLLECTOR_VERSION,
    "candidate-user-identity-point-v1",
  );

  const projection =
    normalizeCandidateUserIdentityPointRecord(record(), {
      expectedCandidateUserId: CANDIDATE_USER_A,
    });
  assert.deepEqual(projection, {
    candidateUserId: CANDIDATE_USER_A,
    globalCandidateId: CANDIDATE_A,
  });
  assert.equal(Object.isFrozen(projection), true);
});

test("one exact known wrapper is supported", () => {
  for (const wrapper of [
    "candidate_user",
    "candidateUser",
    "item",
  ]) {
    assert.deepEqual(
      normalizeCandidateUserIdentityPointRecord(
        { [wrapper]: record() },
        { expectedCandidateUserId: CANDIDATE_USER_A },
      ),
      {
        candidateUserId: CANDIDATE_USER_A,
        globalCandidateId: CANDIDATE_A,
      },
    );
  }
});

test("all candidate-user aliases must agree", () => {
  assert.deepEqual(
    normalizeCandidateUserIdentityPointRecord({
      id: CANDIDATE_USER_A,
      candidate_user_id: CANDIDATE_USER_A,
      candidateUserId: CANDIDATE_USER_A,
      candidate: { id: CANDIDATE_A },
    }, {
      expectedCandidateUserId: CANDIDATE_USER_A,
    }),
    {
      candidateUserId: CANDIDATE_USER_A,
      globalCandidateId: CANDIDATE_A,
    },
  );
  expectCode(
    () => normalizeCandidateUserIdentityPointRecord({
      id: CANDIDATE_USER_A,
      candidate_user_id: CANDIDATE_USER_B,
      candidate: { id: CANDIDATE_A },
    }, {
      expectedCandidateUserId: CANDIDATE_USER_A,
    }),
    "SOURCE_IDENTITY_POINT_ALIAS_CONFLICT",
  );
});

test("the returned alias must equal the requested candidate-user", () => {
  expectCode(
    () => normalizeCandidateUserIdentityPointRecord(record(), {
      expectedCandidateUserId: CANDIDATE_USER_B,
    }),
    "SOURCE_IDENTITY_POINT_EXPECTED_ID_MISMATCH",
  );
});

test("nested candidate.id is mandatory and never inferred", () => {
  for (const candidate of [
    undefined,
    null,
    {},
    { candidate_id: CANDIDATE_A },
    { id: "" },
    { id: ` ${CANDIDATE_A}` },
  ]) {
    const raw = {
      id: CANDIDATE_USER_A,
      ...(candidate === undefined ? {} : { candidate }),
      email: "synthetic@example.invalid",
      linkedin_url: "https://example.invalid/synthetic",
    };
    assert.throws(
      () => normalizeCandidateUserIdentityPointRecord(raw, {
        expectedCandidateUserId: CANDIDATE_USER_A,
      }),
      SourceIdentityPointCollectorError,
    );
  }
});

test("ambiguous wrappers, accessors, and non-plain values fail closed", () => {
  expectCode(
    () => normalizeCandidateUserIdentityPointRecord({
      candidate_user: record(),
      item: record(),
    }, {
      expectedCandidateUserId: CANDIDATE_USER_A,
    }),
    "SOURCE_IDENTITY_POINT_WRAPPER_AMBIGUOUS",
  );
  expectCode(
    () => normalizeCandidateUserIdentityPointRecord({
      item: record(),
      id: CANDIDATE_USER_A,
    }, {
      expectedCandidateUserId: CANDIDATE_USER_A,
    }),
    "SOURCE_IDENTITY_POINT_WRAPPER_AMBIGUOUS",
  );
  assert.throws(
    () => normalizeCandidateUserIdentityPointRecord([], {
      expectedCandidateUserId: CANDIDATE_USER_A,
    }),
    SourceIdentityPointCollectorError,
  );
  const accessor = {};
  Object.defineProperty(accessor, "id", {
    enumerable: true,
    get: () => CANDIDATE_USER_A,
  });
  accessor.candidate = { id: CANDIDATE_A };
  expectCode(
    () => normalizeCandidateUserIdentityPointRecord(accessor, {
      expectedCandidateUserId: CANDIDATE_USER_A,
    }),
    "SOURCE_IDENTITY_POINT_ACCESSOR_INVALID",
  );
  assert.throws(
    () => normalizeCandidateUserIdentityPointRecord(
      new (class CandidateRecord {})(),
      { expectedCandidateUserId: CANDIDATE_USER_A },
    ),
    SourceIdentityPointCollectorError,
  );
  assert.throws(
    () => normalizeCandidateUserIdentityPointRecord(
      new Proxy(record(), {}),
      { expectedCandidateUserId: CANDIDATE_USER_A },
    ),
    SourceIdentityPointCollectorError,
  );
  const nestedAccessor = record();
  Object.defineProperty(nestedAccessor.candidate, "name", {
    enumerable: true,
    get: () => "Synthetic",
  });
  expectCode(
    () => normalizeCandidateUserIdentityPointRecord(
      nestedAccessor,
      { expectedCandidateUserId: CANDIDATE_USER_A },
    ),
    "SOURCE_IDENTITY_POINT_ACCESSOR_INVALID",
  );
  const symbolRecord = record();
  symbolRecord[Symbol("hidden")] = CANDIDATE_USER_B;
  expectCode(
    () => normalizeCandidateUserIdentityPointRecord(
      symbolRecord,
      { expectedCandidateUserId: CANDIDATE_USER_A },
    ),
    "SOURCE_IDENTITY_POINT_SYMBOL_INVALID",
  );
  const optionAccessor = {};
  Object.defineProperty(optionAccessor, "expectedCandidateUserId", {
    enumerable: true,
    get: () => CANDIDATE_USER_A,
  });
  expectCode(
    () => normalizeCandidateUserIdentityPointRecord(
      record(),
      optionAccessor,
    ),
    "SOURCE_IDENTITY_POINT_ACCESSOR_INVALID",
  );
  expectCode(
    () => normalizeCandidateUserIdentityPointRecord(record(), {
      expectedCandidateUserId: CANDIDATE_USER_A,
      unexpected: true,
    }),
    "SOURCE_IDENTITY_POINT_OPTIONS_INVALID",
  );
});

test("evidence contains only domain-separated digests and the pinned procedure", () => {
  const raw = record({
    name: "Synthetic Person",
    email: "synthetic@example.invalid",
    linkedin_url: "https://example.invalid/synthetic",
  });
  const evidence = candidateUserIdentityPointEvidence(raw, {
    expectedCandidateUserId: CANDIDATE_USER_A,
  });
  assert.deepEqual(Object.keys(evidence).sort(), [
    "candidateUserAliasDigest",
    "canonicalCandidateDigest",
    "identityNormalizedInputDigest",
    "identityPointReadProcedure",
    "identityPointRecordDigest",
    "identityPointRecordRevisionDigest",
  ]);
  assert.equal(
    evidence.identityPointReadProcedure,
    SOURCE_IDENTITY_POINT_READ_PROCEDURES
      .candidateUserIdentity,
  );
  for (const [key, value] of Object.entries(evidence)) {
    if (key === "identityPointReadProcedure") continue;
    assert.match(value, /^[a-f0-9]{64}$/u);
  }
  assert.notEqual(
    evidence.candidateUserAliasDigest,
    evidence.canonicalCandidateDigest,
  );
  assert.notEqual(
    evidence.identityPointRecordDigest,
    evidence.identityPointRecordRevisionDigest,
  );
  assert.equal(Object.isFrozen(evidence), true);
  const serialized = JSON.stringify(evidence);
  for (const forbidden of [
    CANDIDATE_USER_A,
    CANDIDATE_A,
    raw.name,
    raw.email,
    raw.linkedin_url,
  ]) {
    assert.equal(serialized.includes(forbidden), false);
  }
});

test("evidence is deterministic and ignores unrelated fields and timestamps", () => {
  const base = candidateUserIdentityPointEvidence(record(), {
    expectedCandidateUserId: CANDIDATE_USER_A,
  });
  const noisy = candidateUserIdentityPointEvidence(record({
    updated_at: "2099-01-01T00:00:00.000Z",
    email: "changed@example.invalid",
    candidate: {
      id: CANDIDATE_A,
      name: "Changed Synthetic Name",
    },
  }), {
    expectedCandidateUserId: CANDIDATE_USER_A,
  });
  assert.deepEqual(noisy, base);

  const aliasChanged = candidateUserIdentityPointEvidence(
    record({ candidateUserId: CANDIDATE_USER_B }),
    { expectedCandidateUserId: CANDIDATE_USER_B },
  );
  const candidateChanged = candidateUserIdentityPointEvidence(
    record({ candidateId: CANDIDATE_B }),
    { expectedCandidateUserId: CANDIDATE_USER_A },
  );
  assert.notEqual(
    aliasChanged.identityPointRecordRevisionDigest,
    base.identityPointRecordRevisionDigest,
  );
  assert.notEqual(
    candidateChanged.identityPointRecordRevisionDigest,
    base.identityPointRecordRevisionDigest,
  );
});

test("input and record digest namespaces are exact", () => {
  const evidence = candidateUserIdentityPointEvidence(record(), {
    expectedCandidateUserId: CANDIDATE_USER_A,
  });
  const candidateUserAliasDigest = semanticDigest(
    "phase4-candidate-user-alias-v1",
    CANDIDATE_USER_A,
  );
  const canonicalCandidateDigest = semanticDigest(
    "phase4-canonical-candidate-v1",
    CANDIDATE_A,
  );
  assert.equal(
    evidence.identityNormalizedInputDigest,
    semanticDigest(
      "phase4-candidate-user-identity-point-input-v1",
      { candidate_user_id: CANDIDATE_USER_A },
    ),
  );
  assert.equal(
    evidence.identityPointRecordDigest,
    semanticDigest(
      "phase4-candidate-user-identity-point-record-v1",
      {
        candidateUserAliasDigest,
        canonicalCandidateDigest,
      },
    ),
  );
  assert.equal(
    evidence.identityPointRecordRevisionDigest,
    semanticDigest(
      "phase4-candidate-user-identity-point-semantic-revision-v1",
      {
        candidateUserAliasDigest,
        canonicalCandidateDigest,
      },
    ),
  );
});

test("the identity point slice has no I/O or authority surface", async () => {
  const source = await readFile(
    new URL(
      "../api/paraai/_lib/source-identity-point-collector.mjs",
      import.meta.url,
    ),
    "utf8",
  );
  for (const forbidden of [
    /\bfetch\s*\(/u,
    /\btrpcGet\b/u,
    /\bcreateHmac\b/u,
    /\bprocess\.env\b/u,
    /\bKV_REST\b/u,
    /\bredis\b/iu,
  ]) {
    assert.doesNotMatch(source, forbidden);
  }
});

test("all coordinator and release authority pins remain hard-dark", async () => {
  const [coordinator, authority, watermark] = await Promise.all([
    readFile(new URL(
      "../api/paraai/_lib/source-capture-coordinator.mjs",
      import.meta.url,
    ), "utf8"),
    readFile(new URL(
      "../api/paraai/_lib/source-authority-store.mjs",
      import.meta.url,
    ), "utf8"),
    readFile(new URL(
      "../api/paraai/_lib/source-watermark.mjs",
      import.meta.url,
    ), "utf8"),
  ]);
  assert.match(
    coordinator,
    /identityAliasClient,\s*\n\s*sourceHeadClient:\s*null/u,
  );
  assert.match(
    coordinator,
    /createSourceIdentityAliasAdapter\(\{\s*\n\s*artifactStore:\s*trustedIdentityArtifactStore,/u,
  );
  assert.match(
    authority,
    /const SOURCE_CAPTURE_COORDINATOR_AVAILABLE = false;/u,
  );
  assert.match(
    watermark,
    /SOURCE_IDENTITY_BINDING_IDENTITY_ARTIFACT_DIGEST\s*=\s*\n\s*null;/u,
  );
  assert.match(
    watermark,
    /collectorCodeCommitmentDigest:\s*null,\s*\n\s*artifact:\s*null,/u,
  );
});
