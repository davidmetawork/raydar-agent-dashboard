import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  SOURCE_IDENTITY_ALIAS_ADAPTER_PAGE_SIZE,
  SOURCE_IDENTITY_ALIAS_ADAPTER_VERSION,
  SourceIdentityAliasAdapterError,
  createSourceIdentityAliasAdapter,
} from "../api/paraai/_lib/source-identity-alias-adapter.mjs";

const RUN = "1".repeat(64);
const PINS = "2".repeat(64);
const CLAIM = "3".repeat(64);
const BOUNDARY = Date.parse("2026-07-26T04:00:00.000Z");
const REDIS_NOW = BOUNDARY + 1_000;

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
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

function aliasEntry(index) {
  return {
    candidateUserAliasDigest:
      index.toString(16).padStart(64, "0"),
    canonicalCandidateDigest:
      (index + 1_000).toString(16).padStart(64, "0"),
    identityPointReadProcedure:
      "candidateUser.getCandidateUserById",
    identityNormalizedInputDigest:
      sha256(`input-${index}`),
    identityPointRecordDigest:
      sha256(`record-${index}`),
    identityPointRecordRevisionDigest:
      sha256(`revision-${index}`),
    workItemDigest: sha256(`work-${index}`),
    resolutionDigest: sha256(`resolution-${index}`),
  };
}

function opaqueCursor({
  runNonceDigest,
  decisionBoundaryAtMs,
  contractPinsDigest,
  pageNumber,
}) {
  return sha256(JSON.stringify({
    version: 1,
    runNonceDigest,
    decisionBoundaryAtMs,
    contractPinsDigest,
    pageNumber,
  }));
}

function captureClaim({
  passNumber = 1,
  pageNumber = 1,
  cursorToken = null,
  status = "capturing",
  headVerificationIndex = 3,
  extra,
} = {}) {
  const record = {
    runNonceDigest: RUN,
    decisionBoundaryAtMs: BOUNDARY,
    contractPinsDigest: PINS,
    status,
    activeStep: status === "capturing"
      ? {
        source: "aliases",
        passNumber,
        pageNumber,
        cursorToken,
      }
      : null,
    headVerificationIndex,
    sources: [
      { source: "recall" },
      { source: "paraform_human" },
      { source: "human_intro" },
      { source: "aliases" },
    ],
  };
  return {
    record,
    raw: JSON.stringify(record),
    claimNonceDigest: CLAIM,
    ...(extra ? { [extra]: null } : {}),
  };
}

function makeArtifactStore({
  pages = [
    Array.from(
      { length: SOURCE_IDENTITY_ALIAS_ADAPTER_PAGE_SIZE },
      (_unused, index) => aliasEntry(index),
    ),
    [aliasEntry(SOURCE_IDENTITY_ALIAS_ADAPTER_PAGE_SIZE)],
  ],
  mutatePageAfterRead = false,
  prepareError = null,
  headError = null,
  pageError = null,
  pageRecordCount = null,
  policyVersion =
    "phase4-source-identity-artifact-store-v1",
  workManifestCount = null,
  sealedArtifactDigestOverride = null,
  pageSemanticDigestOverride = null,
} = {}) {
  const calls = [];
  const cursors = pages.slice(1).map((_unused, index) => (
    opaqueCursor({
      runNonceDigest: RUN,
      decisionBoundaryAtMs: BOUNDARY,
      contractPinsDigest: PINS,
      pageNumber: index + 2,
    })
  ));
  const pageRaws = pages.map((entries, index) => JSON.stringify({
    version: 1,
    policyVersion,
    kind: "identity_alias_artifact_page_dark",
    runNonceDigest: RUN,
    decisionBoundaryAtMs: BOUNDARY,
    contractPinsDigest: PINS,
    pageNumber: index + 1,
    pageSize: SOURCE_IDENTITY_ALIAS_ADAPTER_PAGE_SIZE,
    cursorToken: index === 0 ? null : cursors[index - 1],
    nextCursorToken: index + 1 < pages.length
      ? cursors[index]
      : null,
    entryCount: entries.length,
    entries,
  }));
  const pageDigests = pageRaws.map(sha256);
  const pageSemanticDigests = pages.map((entries, index) => (
    index === 0 && pageSemanticDigestOverride
      ? pageSemanticDigestOverride
      : semanticDigest(
      "phase4-source-identity-alias-page-semantic-v1",
      entries,
    )
  ));
  const pageManifest = pages.map((entries, index) => ({
    pageNumber: index + 1,
    cursorToken: index === 0 ? null : cursors[index - 1],
    nextCursorToken: index + 1 < pages.length
      ? cursors[index]
      : null,
    entryCount: entries.length,
    pageRecordDigest: pageDigests[index],
    pageSemanticDigest: pageSemanticDigests[index],
  }));
  const headMaterial = {
    version: 1,
    policyVersion,
    kind: "identity_alias_artifact_head_dark",
    runNonceDigest: RUN,
    decisionBoundaryAtMs: BOUNDARY,
    contractPinsDigest: PINS,
    workManifestDigest: "c".repeat(64),
    workManifestCount: workManifestCount ?? pages.reduce(
      (total, entries) => total + entries.length,
      0,
    ),
    terminalWorkSetDigest: "d".repeat(64),
    pageSize: SOURCE_IDENTITY_ALIAS_ADAPTER_PAGE_SIZE,
    pageCount: pages.length,
    resolvedEntryCount: pages.reduce(
      (total, entries) => total + entries.length,
      0,
    ),
    unresolvedWorkCount: 0,
    conflictWorkCount: 0,
    pages: pageManifest,
  };
  const sealedArtifactDigest =
    sealedArtifactDigestOverride ?? semanticDigest(
      "phase4-source-identity-alias-artifact-v1",
      headMaterial,
    );
  const headRecord = {
    version: 1,
    policyVersion,
    kind: "identity_alias_artifact_head_dark",
    runNonceDigest: RUN,
    decisionBoundaryAtMs: BOUNDARY,
    contractPinsDigest: PINS,
    sealedArtifactDigest,
    workManifestDigest: headMaterial.workManifestDigest,
    workManifestCount: headMaterial.workManifestCount,
    terminalWorkSetDigest:
      headMaterial.terminalWorkSetDigest,
    pageSize: SOURCE_IDENTITY_ALIAS_ADAPTER_PAGE_SIZE,
    pageCount: pages.length,
    resolvedEntryCount: headMaterial.resolvedEntryCount,
    unresolvedWorkCount: 0,
    conflictWorkCount: 0,
    pages: pageManifest,
  };
  const headRaw = JSON.stringify(headRecord);
  const headRecordDigest = sha256(headRaw);
  const reads = new Map();
  const store = {
    async prepareIdentityAliasArtifact(input) {
      calls.push({ method: "prepare", input });
      if (prepareError) throw prepareError;
      return {
        sealedArtifactDigest,
        headRecordDigest,
        completedPairs: 2,
      };
    },
    async readIdentityAliasArtifactHead(input) {
      calls.push({ method: "readHead", input });
      if (headError) throw headError;
      return {
        raw: headRaw,
        headRecordDigest,
        record: JSON.parse(headRaw),
        redisNowMs: REDIS_NOW,
      };
    },
    async readIdentityAliasArtifactPage(input) {
      calls.push({ method: "readPage", input });
      if (pageError) throw pageError;
      const index = input.cursorToken === null
        ? 0
        : cursors.indexOf(input.cursorToken) + 1;
      if (
        index < 0
        || index >= pages.length
        || (
          index > 0
          && cursors[index - 1] !== input.cursorToken
        )
      ) {
        throw new Error(
          "sensitive candidate payload must never escape",
        );
      }
      const priorReads = reads.get(index) || 0;
      reads.set(index, priorReads + 1);
      const raw = (
        mutatePageAfterRead && priorReads > 0
          ? JSON.stringify({
            version: 1,
            policyVersion,
            kind: "identity_alias_artifact_page_dark",
            runNonceDigest: RUN,
            decisionBoundaryAtMs: BOUNDARY,
            contractPinsDigest: PINS,
            pageNumber: index + 1,
            pageSize:
              SOURCE_IDENTITY_ALIAS_ADAPTER_PAGE_SIZE,
            cursorToken: input.cursorToken,
            nextCursorToken: index + 1 < pages.length
              ? cursors[index]
              : null,
            entryCount: pages[index].length,
            entries: pages[index].map((entry, entryIndex) => (
              entryIndex === 0
                ? {
                  ...entry,
                  resolutionDigest: "f".repeat(64),
                }
                : entry
            )),
          })
          : pageRaws[index]
      );
      const nextCursorToken = index + 1 < pages.length
        ? cursors[index]
        : null;
      return {
        raw,
        pageRecordDigest: sha256(raw),
        pageSemanticDigest: pageSemanticDigests[index],
        recordCount: pageRecordCount
          ?? pages[index].length,
        cursorToken: input.cursorToken,
        nextCursorToken,
        record: JSON.parse(raw),
        redisNowMs: REDIS_NOW,
      };
    },
  };
  return {
    store,
    calls,
    headRaw,
    headRecordDigest,
    pageRaws,
    pageDigests,
    pageSemanticDigests,
    cursors,
  };
}

function expectCode(operation, code) {
  return assert.rejects(
    operation,
    (error) => (
      error instanceof SourceIdentityAliasAdapterError
      && error.code === code
      && error.message === code
      && error.cause === undefined
    ),
  );
}

test("adapter is hard-dark and exposes only its private interface", async () => {
  const source = await readFile(
    new URL(
      "../api/paraai/_lib/source-identity-alias-adapter.mjs",
      import.meta.url,
    ),
    "utf8",
  );
  assert.equal(
    SOURCE_IDENTITY_ALIAS_ADAPTER_VERSION,
    "candidate-user-alias-sealed-adapter-v1",
  );
  assert.equal(SOURCE_IDENTITY_ALIAS_ADAPTER_PAGE_SIZE, 100);
  assert.doesNotMatch(
    source,
    /from\s+["'][^"']*(?:core|pipeline|curation|enroll|authority|worker|watermark)/u,
  );
  assert.doesNotMatch(
    source,
    /(?:createHmac|createSign|fetch\s*\(|trpc|export\s+default)/u,
  );

  const fixture = makeArtifactStore();
  const adapter = createSourceIdentityAliasAdapter({
    artifactStore: fixture.store,
  });
  assert.deepEqual(Object.keys(adapter).sort(), [
    "prepare",
    "readHead",
    "readPage",
  ]);
  assert.equal(Object.isFrozen(adapter), true);
});

test("prepare binds the exact sealed raw head and computes commitments from its bytes", async () => {
  const fixture = makeArtifactStore();
  const adapter = createSourceIdentityAliasAdapter({
    artifactStore: fixture.store,
  });
  const prepared = await adapter.prepare(captureClaim());

  assert.equal(prepared.status, "sealed");
  assert.equal(prepared.source, "aliases");
  assert.equal(prepared.pageSize, 100);
  assert.equal(prepared.rawSourceHead, fixture.headRaw);
  assert.equal(
    prepared.sourceHeadRecordDigest,
    sha256(fixture.headRaw),
  );
  assert.equal(
    prepared.sourceHeadEpochDigest,
    createHash("sha256")
      .update("phase4-source-identity-alias-head-epoch-v1")
      .update("\0")
      .update(fixture.headRaw, "utf8")
      .digest("hex"),
  );
  assert.equal(
    prepared.sourceHeadRevisionDigest,
    createHash("sha256")
      .update("phase4-source-identity-alias-head-revision-v1")
      .update("\0")
      .update(fixture.headRaw, "utf8")
      .digest("hex"),
  );
  assert.equal(Object.isFrozen(prepared), true);
  assert.deepEqual(fixture.calls.map(({ method }) => method), [
    "prepare",
    "readHead",
  ]);
  assert.deepEqual(
    Object.keys(fixture.calls[0].input).sort(),
    [
      "contractPinsDigest",
      "decisionBoundaryAtMs",
      "runNonceDigest",
    ],
  );
  assert.deepEqual(
    Object.keys(fixture.calls[1].input).sort(),
    [
      "contractPinsDigest",
      "decisionBoundaryAtMs",
      "runNonceDigest",
      "sealedArtifactDigest",
    ],
  );
});

test("fixed pages use only the journal cursor and replay identical bytes across both passes", async () => {
  const fixture = makeArtifactStore();
  const adapter = createSourceIdentityAliasAdapter({
    artifactStore: fixture.store,
  });
  const passOneFirst = await adapter.readPage(captureClaim());
  const next = passOneFirst.checkpointEvent.nextCursorToken;
  const passOneSecond = await adapter.readPage(captureClaim({
    pageNumber: 2,
    cursorToken: next,
  }));
  const passTwoFirst = await adapter.readPage(captureClaim({
    passNumber: 2,
  }));
  const passTwoSecond = await adapter.readPage(captureClaim({
    passNumber: 2,
    pageNumber: 2,
    cursorToken: next,
  }));

  assert.match(next, /^[a-f0-9]{64}$/u);
  assert.equal(
    passOneFirst.checkpointEvent.pageSemanticDigest,
    fixture.pageSemanticDigests[0],
  );
  assert.equal(
    passOneSecond.checkpointEvent.pageSemanticDigest,
    fixture.pageSemanticDigests[1],
  );
  assert.equal(
    passOneSecond.checkpointEvent.nextCursorToken,
    null,
  );
  assert.deepEqual(
    {
      ...passOneFirst.checkpointEvent,
      passNumber: 2,
    },
    passTwoFirst.checkpointEvent,
  );
  assert.deepEqual(
    {
      ...passOneSecond.checkpointEvent,
      passNumber: 2,
    },
    passTwoSecond.checkpointEvent,
  );
  assert.equal(passOneFirst.rawSourceHead, fixture.headRaw);
  assert.equal(passTwoSecond.rawSourceHead, fixture.headRaw);

  for (const call of fixture.calls.filter(
    ({ method }) => method === "readPage",
  )) {
    assert.deepEqual(Object.keys(call.input).sort(), [
      "contractPinsDigest",
      "cursorToken",
      "decisionBoundaryAtMs",
      "runNonceDigest",
      "sealedArtifactDigest",
    ]);
    assert.equal("limit" in call.input, false);
    assert.equal("offset" in call.input, false);
    assert.equal("passNumber" in call.input, false);
    assert.equal("pageNumber" in call.input, false);
  }
});

test("head verification returns the exact journal event and raw durable head", async () => {
  const fixture = makeArtifactStore();
  const adapter = createSourceIdentityAliasAdapter({
    artifactStore: fixture.store,
  });
  const result = await adapter.readHead(captureClaim({
    status: "verifying_heads",
  }));

  assert.equal(result.rawSourceHead, fixture.headRaw);
  assert.deepEqual(result.checkpointEvent, {
    kind: "head_checkpoint",
    claimNonceDigest: CLAIM,
    source: "aliases",
    sourceHeadEpochDigest:
      createHash("sha256")
        .update(
          "phase4-source-identity-alias-head-epoch-v1",
        )
        .update("\0")
        .update(fixture.headRaw, "utf8")
        .digest("hex"),
    sourceHeadRevisionDigest:
      createHash("sha256")
        .update(
          "phase4-source-identity-alias-head-revision-v1",
        )
        .update("\0")
        .update(fixture.headRaw, "utf8")
        .digest("hex"),
    sourceHeadRecordDigest: fixture.headRecordDigest,
  });
  assert.equal(Object.isFrozen(result.checkpointEvent), true);
});

test("caller selectors and malformed or cross-source claims fail before the store", async () => {
  const fixture = makeArtifactStore();
  const adapter = createSourceIdentityAliasAdapter({
    artifactStore: fixture.store,
  });

  for (const extra of [
    "candidateIds",
    "limit",
    "cursor",
    "digest",
    "force",
  ]) {
    await expectCode(
      () => adapter.readPage(captureClaim({ extra })),
      "SOURCE_IDENTITY_ALIAS_CLAIM_INVALID",
    );
  }
  const wrongSource = captureClaim();
  wrongSource.record.activeStep.source = "recall";
  await expectCode(
    () => adapter.readPage(wrongSource),
    "SOURCE_IDENTITY_ALIAS_PAGE_NOT_EXPECTED",
  );
  await expectCode(
    () => adapter.readPage(captureClaim({
      pageNumber: 2,
      cursorToken: null,
    })),
    "SOURCE_IDENTITY_ALIAS_CURSOR_INVALID",
  );
  assert.equal(fixture.calls.length, 0);
});

test("store failures are sanitized and never expose response content", async () => {
  const sensitive = new Error(
    "candidate identity and upstream response body",
  );
  for (const [options, operation, code] of [
    [
      { prepareError: sensitive },
      "prepare",
      "SOURCE_IDENTITY_ALIAS_PREPARE_FAILED",
    ],
    [
      { headError: sensitive },
      "prepare",
      "SOURCE_IDENTITY_ALIAS_HEAD_READ_FAILED",
    ],
    [
      { pageError: sensitive },
      "readPage",
      "SOURCE_IDENTITY_ALIAS_PAGE_READ_FAILED",
    ],
  ]) {
    const fixture = makeArtifactStore(options);
    const adapter = createSourceIdentityAliasAdapter({
      artifactStore: fixture.store,
    });
    await expectCode(
      () => adapter[operation](captureClaim()),
      code,
    );
  }
});

test("exact byte digests, fixed page size, and immutable seals fail closed", async () => {
  {
    const fixture = makeArtifactStore();
    fixture.store.readIdentityAliasArtifactHead =
      async (input) => {
        const result = await makeArtifactStore().store
          .readIdentityAliasArtifactHead(input);
        return {
          ...result,
          headRecordDigest: "f".repeat(64),
        };
      };
    const adapter = createSourceIdentityAliasAdapter({
      artifactStore: fixture.store,
    });
    await expectCode(
      () => adapter.prepare(captureClaim()),
      "SOURCE_IDENTITY_ALIAS_HEAD_DIGEST_MISMATCH",
    );
  }
  {
    const fixture = makeArtifactStore({
      policyVersion: "unreviewed-identity-artifact-v2",
    });
    const adapter = createSourceIdentityAliasAdapter({
      artifactStore: fixture.store,
    });
    await expectCode(
      () => adapter.prepare(captureClaim()),
      "SOURCE_IDENTITY_ALIAS_HEAD_INVALID",
    );
  }
  {
    const fixture = makeArtifactStore({
      workManifestCount: 102,
    });
    const adapter = createSourceIdentityAliasAdapter({
      artifactStore: fixture.store,
    });
    await expectCode(
      () => adapter.prepare(captureClaim()),
      "SOURCE_IDENTITY_ALIAS_HEAD_INVALID",
    );
  }
  {
    const fixture = makeArtifactStore({
      sealedArtifactDigestOverride: "f".repeat(64),
    });
    const adapter = createSourceIdentityAliasAdapter({
      artifactStore: fixture.store,
    });
    await expectCode(
      () => adapter.prepare(captureClaim()),
      "SOURCE_IDENTITY_ALIAS_ARTIFACT_DIGEST_MISMATCH",
    );
  }
  {
    const fixture = makeArtifactStore({
      pageSemanticDigestOverride: "e".repeat(64),
    });
    const adapter = createSourceIdentityAliasAdapter({
      artifactStore: fixture.store,
    });
    await expectCode(
      () => adapter.readPage(captureClaim()),
      "SOURCE_IDENTITY_ALIAS_PAGE_SEAL_MISMATCH",
    );
  }
  {
    const fixture = makeArtifactStore({
      pageRecordCount:
        SOURCE_IDENTITY_ALIAS_ADAPTER_PAGE_SIZE + 1,
    });
    const adapter = createSourceIdentityAliasAdapter({
      artifactStore: fixture.store,
    });
    await expectCode(
      () => adapter.readPage(captureClaim()),
      "SOURCE_IDENTITY_ALIAS_PAGE_SIZE_INVALID",
    );
  }
  {
    const fixture = makeArtifactStore({
      mutatePageAfterRead: true,
    });
    const adapter = createSourceIdentityAliasAdapter({
      artifactStore: fixture.store,
    });
    await adapter.readPage(captureClaim());
    await expectCode(
      () => adapter.readPage(captureClaim({
        passNumber: 2,
      })),
      "SOURCE_IDENTITY_ALIAS_PAGE_SEAL_MISMATCH",
    );
  }
});
