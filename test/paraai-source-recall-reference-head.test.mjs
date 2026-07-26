import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import test from "node:test";

import {
  SOURCE_RECALL_REFERENCE_COLLECTOR_VERSION,
  SourceRecallReferenceCollectorError,
  collectRecallReferenceHeadStep,
  createRecallReferenceHeadCollector,
} from "../api/paraai/_lib/source-recall-reference-collector.mjs";
import {
  SOURCE_RECALL_REFERENCE_ATOMIC_COMMIT_BUDGET_MS,
  SOURCE_RECALL_REFERENCE_CLAIM_LEASE_MS,
  SOURCE_RECALL_REFERENCE_CLAIM_PREPARATION_MARGIN_MS,
  SOURCE_RECALL_REFERENCE_CHECKPOINT_COMMIT_MARGIN_MS,
  SOURCE_RECALL_REFERENCE_MAX_COLLECTION_AGE_MS,
  SOURCE_RECALL_REFERENCE_MAX_PAGES,
  SOURCE_RECALL_REFERENCE_MIN_PAGE_RETENTION_MS,
  SOURCE_RECALL_REFERENCE_MIN_SEALED_RETENTION_MS,
  SOURCE_RECALL_REFERENCE_PRIVATE_PAGE_TTL_MS,
  SOURCE_RECALL_REFERENCE_PROVIDER_HANDOFF_MARGIN_MS,
  SOURCE_RECALL_REFERENCE_REQUIRED_PASSES,
  SOURCE_RECALL_REFERENCE_PERSISTENCE_PROTOCOL_VERSION,
  SourceRecallReferencePersistenceProtocolError,
  createSourceRecallReferencePersistenceProtocol,
  validateRecallReferenceRun,
} from "../api/paraai/_lib/source-recall-reference-persistence-protocol.mjs";
import {
  SOURCE_RECALL_PAGE_TIMEOUT_MS,
  SOURCE_RECALL_PAGE_VERSION,
} from "../api/paraai/_lib/source-recall-page-client.mjs";

const BOUNDARY = "2026-07-26T00:00:00.000Z";
const BOUNDARY_MS = Date.parse(BOUNDARY);
const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);
const PRIVATE_MARKERS = Object.freeze([
  "synthetic.person@example.invalid",
  "Synthetic Person",
  "https://example.invalid/synthetic-person",
  "bot-synthetic",
  "/bot/?",
]);

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

function rawDigest(raw) {
  return createHash("sha256").update(raw).digest("hex");
}

function semanticDigest(namespace, value) {
  return createHash("sha256")
    .update(namespace)
    .update("\0")
    .update(canonicalJson(value))
    .digest("hex");
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

function cursor(pageNumber) {
  const query = new URLSearchParams({
    ordering: "-join_at",
    page_size: "100",
    join_at_before: BOUNDARY,
    page: String(pageNumber),
  });
  return `/bot/?${query}`;
}

function reference({
  id = "bot-synthetic-a",
  joinAt = "2026-07-25T23:00:00.000Z",
  fullName = "Synthetic Person",
  email = "synthetic.person@example.invalid",
  linkedin = "https://example.invalid/synthetic-person",
  paraformEventId = "synthetic-event-a",
  metadataSource = "paraform-auto",
} = {}) {
  return {
    id,
    joinAt,
    metadataSource,
    candidate: {
      fullName,
      email,
      linkedin,
      paraformEventId,
    },
  };
}

function page({
  nextCursor = null,
  references = [],
  scanned = references.length,
} = {}) {
  return deepFreeze({
    version: SOURCE_RECALL_PAGE_VERSION,
    boundaryAt: BOUNDARY,
    exhausted: nextCursor === null,
    nextCursor,
    scanned,
    references,
  });
}

function context() {
  return {
    runNonceDigest: DIGEST_A,
    decisionBoundaryAtMs: BOUNDARY_MS,
    contractPinsDigest: DIGEST_B,
  };
}

function memoryPersistence({
  initialNowMs = BOUNDARY_MS + 10_000,
  stampInitial = true,
} = {}) {
  let nowMs = initialNowMs;
  let conflictNext = false;
  const runs = new Map();
  const pages = new Map();
  const heads = new Map();
  const events = [];

  const persistence = {
    async ensure({ key, proposedRaw }) {
      if (runs.has(key)) {
        events.push({ kind: "ensure_existing", nowMs });
        return {
          status: "existing",
          raw: runs.get(key),
          redisNowMs: nowMs,
        };
      }
      const proposed = JSON.parse(proposedRaw);
      if (stampInitial) {
        proposed.createdAtMs = nowMs;
        proposed.updatedAtMs = nowMs;
      }
      const raw = canonicalJson(proposed);
      runs.set(key, raw);
      events.push({ kind: "ensure_created", nowMs });
      return {
        status: "created",
        raw,
        redisNowMs: nowMs,
      };
    },
    async readRun({ key }) {
      events.push({ kind: "read_run", nowMs });
      return {
        raw: runs.get(key) ?? null,
        redisNowMs: nowMs,
      };
    },
    async compareAndSet(input) {
      const {
        key,
        expectedRaw,
        nextRaw,
        pageKey,
        pageRaw,
        pageTtlMs,
        pageExpiresAtMs,
        headKey,
        headRaw,
        requiredPageSet,
        requiredPageSetDigest,
        notAfterMs,
        notBeforeMs,
      } = input;
      assert.equal(Number.isSafeInteger(notBeforeMs), true);
      assert.ok(notBeforeMs <= nowMs);
      events.push({
        kind: "cas",
        nowMs,
        nextRecord: JSON.parse(nextRaw),
        hasPage: pageRaw !== null,
        pageTtlMs,
        hasHead: headRaw !== null,
        requiredPageCount: requiredPageSet.length,
      });
      if (conflictNext) {
        conflictNext = false;
        return {
          headReceipt: null,
          pageReceipt: null,
          pageSetReceipt: null,
          status: "conflict",
          raw: runs.get(key),
          redisNowMs: nowMs,
        };
      }
      if (notAfterMs !== null && nowMs >= notAfterMs) {
        return {
          headReceipt: null,
          pageReceipt: null,
          pageSetReceipt: null,
          status: "deadline_exceeded",
          raw: runs.get(key),
          redisNowMs: nowMs,
        };
      }
      if (runs.get(key) !== expectedRaw) {
        return {
          headReceipt: null,
          pageReceipt: null,
          pageSetReceipt: null,
          status: "conflict",
          raw: runs.get(key),
          redisNowMs: nowMs,
        };
      }
      if (pageRaw === null) {
        assert.equal(pageKey, null);
        assert.equal(pageTtlMs, null);
      } else {
        assert.equal(typeof pageKey, "string");
        assert.equal(
          pageTtlMs,
          SOURCE_RECALL_REFERENCE_PRIVATE_PAGE_TTL_MS,
        );
      }
      if (headRaw === null) {
        assert.equal(headKey, null);
      } else {
        assert.equal(typeof headKey, "string");
      }
      assert.equal(
        requiredPageSetDigest,
        semanticDigest(
          "phase4-recall-reference-required-page-set-v1",
          requiredPageSet,
        ),
      );
      for (const required of requiredPageSet) {
        const candidate = required.key === pageKey
          ? {
            raw: pageRaw,
            expiresAtMs: pageExpiresAtMs,
          }
          : pages.get(required.key);
        if (
          !candidate
          || rawDigest(candidate.raw) !== required.rawDigest
          || candidate.expiresAtMs
            !== required.expectedExpiresAtMs
          || candidate.expiresAtMs - nowMs
            < required.minimumRemainingTtlMs
        ) {
          return {
            headReceipt: null,
            pageReceipt: null,
            pageSetReceipt: null,
            status: "proof_failed",
            raw: runs.get(key),
            redisNowMs: nowMs,
          };
        }
      }
      runs.set(key, nextRaw);
      if (pageRaw !== null) {
        pages.set(pageKey, {
          raw: pageRaw,
          expiresAtMs: pageExpiresAtMs,
        });
      }
      if (headRaw !== null) heads.set(headKey, headRaw);
      return {
        headReceipt: headRaw === null
          ? null
          : {
            keyDigest: semanticDigest(
              "phase4-recall-reference-persistence-key-v1",
              headKey,
            ),
            rawDigest: rawDigest(headRaw),
          },
        pageReceipt: pageRaw === null
          ? null
          : {
            expiresAtMs: pageExpiresAtMs,
            keyDigest: semanticDigest(
              "phase4-recall-reference-persistence-key-v1",
              pageKey,
            ),
            rawDigest: rawDigest(pageRaw),
            ttlMs: pageTtlMs,
          },
        pageSetReceipt: requiredPageSet.length === 0
          ? null
          : {
            count: requiredPageSet.length,
            requestDigest: requiredPageSetDigest,
            verifiedAtMs: nowMs,
          },
          status: "stored",
          raw: nextRaw,
          redisNowMs: nowMs,
      };
    },
    async readHead({ key }) {
      events.push({ kind: "read_head", nowMs });
      return {
        raw: heads.get(key) ?? null,
        redisNowMs: nowMs,
      };
    },
    async readPage({ key }) {
      events.push({ kind: "read_page", nowMs });
      const stored = pages.get(key);
      if (!stored || stored.expiresAtMs <= nowMs) {
        return {
          raw: null,
          redisNowMs: nowMs,
          remainingTtlMs: null,
        };
      }
      return {
        raw: stored.raw,
        redisNowMs: nowMs,
        remainingTtlMs: stored.expiresAtMs - nowMs,
      };
    },
    async verifyArtifactSet(input) {
      const {
        runKey,
        expectedRunRaw,
        headKey,
        expectedHeadRaw,
        requiredPageSet,
        requiredPageSetDigest,
        requestDigest,
      } = input;
      events.push({
        kind: "verify_artifact_set",
        nowMs,
        requiredPageCount: requiredPageSet.length,
      });
      assert.equal(
        requiredPageSetDigest,
        semanticDigest(
          "phase4-recall-reference-required-page-set-v1",
          requiredPageSet,
        ),
      );
      assert.equal(
        requestDigest,
        semanticDigest(
          "phase4-recall-reference-sealed-artifact-set-v1",
          {
            runKeyDigest: semanticDigest(
              "phase4-recall-reference-persistence-key-v1",
              runKey,
            ),
            runRawDigest: rawDigest(expectedRunRaw),
            headKeyDigest: semanticDigest(
              "phase4-recall-reference-persistence-key-v1",
              headKey,
            ),
            headRawDigest: rawDigest(expectedHeadRaw),
            requiredPageSetDigest,
          },
        ),
      );
      const mismatch = (
        runs.get(runKey) !== expectedRunRaw
        || heads.get(headKey) !== expectedHeadRaw
        || requiredPageSet.some((required) => {
          const candidate = pages.get(required.key);
          return (
            !candidate
            || rawDigest(candidate.raw) !== required.rawDigest
            || candidate.expiresAtMs
              !== required.expectedExpiresAtMs
            || candidate.expiresAtMs - nowMs
              < required.minimumRemainingTtlMs
          );
        })
      );
      if (mismatch) {
        return {
          artifactSetReceipt: null,
          status: "mismatch",
          redisNowMs: nowMs,
        };
      }
      return {
        artifactSetReceipt: {
          count: requiredPageSet.length,
          requestDigest,
          verifiedAtMs: nowMs,
        },
        status: "verified",
        redisNowMs: nowMs,
      };
    },
  };

  return {
    persistence,
    events,
    runs,
    pages,
    heads,
    advance(milliseconds) {
      nowMs += milliseconds;
    },
    expirePrivatePages() {
      for (const [key, value] of pages) {
        if (value.expiresAtMs <= nowMs) pages.delete(key);
      }
    },
    conflictNextCas() {
      conflictNext = true;
    },
    now() {
      return nowMs;
    },
  };
}

function collectorDependencies(store, readPage) {
  return Object.freeze({
    claimRecallReferencePageImpl:
      store.claimRecallReferencePage,
    checkpointRecallReferencePageImpl:
      store.checkpointRecallReferencePage,
    readPrivateRecallSourcePageImpl: readPage,
    recordRecallReferencePageFailureImpl:
      store.recordRecallReferencePageFailure,
  });
}

function assertPublicOnly(value) {
  const serialized = JSON.stringify(value);
  for (const marker of PRIVATE_MARKERS) {
    assert.equal(serialized.includes(marker), false);
  }
  const forbiddenKeys = new Set([
    "candidate",
    "cursor",
    "email",
    "fullName",
    "id",
    "linkedin",
    "nextCursor",
    "paraformEventId",
    "references",
    "seenCursors",
  ]);
  const inspect = (item) => {
    if (!item || typeof item !== "object") return;
    for (const [key, child] of Object.entries(item)) {
      assert.equal(forbiddenKeys.has(key), false);
      inspect(child);
    }
  };
  inspect(value);
}

function expectStoreCode(error, code) {
  assert.equal(
    error instanceof SourceRecallReferencePersistenceProtocolError,
    true,
  );
  assert.equal(error.code, code);
  assert.equal(error.message, code);
  return true;
}

function expectCollectorCode(error, code, forbidden = []) {
  assert.equal(
    error instanceof SourceRecallReferenceCollectorError,
    true,
  );
  assert.equal(error.code, code);
  assert.equal(error.message, code);
  const serialized = JSON.stringify(error, [
    "name",
    "code",
    "message",
  ]);
  for (const marker of forbidden) {
    assert.equal(serialized.includes(marker), false);
  }
  return true;
}

async function initialized(harness = memoryPersistence()) {
  const store = createSourceRecallReferencePersistenceProtocol({
    persistence: harness.persistence,
  });
  const ensured = await store.ensureRecallReferenceRun(context());
  return { harness, store, ...ensured };
}

function aggregate(overrides = {}) {
  return Object.freeze({
    status: "collecting",
    operational: false,
    serverSelected: true,
    completedPasses: 0,
    requiredPasses: 2,
    pageCount: 0,
    scannedCount: 0,
    referenceCount: 0,
    inProgress: false,
    headSealed: false,
    pointReadAvailable: false,
    sourceFactsAvailable: false,
    successClassificationAvailable: false,
    candidateIdentityResolutionAvailable: false,
    pinnable: false,
    authorityAvailable: false,
    ...overrides,
  });
}

test("two exhaustive passes seal one unpinnable digest-only head and TTL-bound every private page", async () => {
  assert.equal(
    SOURCE_RECALL_REFERENCE_COLLECTOR_VERSION,
    "recall-reference-two-pass-collector-dark-v1",
  );
  assert.equal(
    SOURCE_RECALL_REFERENCE_PERSISTENCE_PROTOCOL_VERSION,
    "recall-reference-head-dark-v1",
  );
  assert.equal(SOURCE_RECALL_REFERENCE_REQUIRED_PASSES, 2);
  assert.equal(SOURCE_RECALL_REFERENCE_CLAIM_LEASE_MS, 150_000);
  assert.equal(
    SOURCE_RECALL_REFERENCE_CLAIM_PREPARATION_MARGIN_MS,
    60_000,
  );
  assert.equal(
    SOURCE_RECALL_REFERENCE_CHECKPOINT_COMMIT_MARGIN_MS,
    60_000,
  );
  assert.equal(
    SOURCE_RECALL_REFERENCE_ATOMIC_COMMIT_BUDGET_MS,
    15_000,
  );
  assert.ok(
    SOURCE_RECALL_REFERENCE_CHECKPOINT_COMMIT_MARGIN_MS
      > SOURCE_RECALL_REFERENCE_ATOMIC_COMMIT_BUDGET_MS,
  );
  assert.ok(
    SOURCE_RECALL_REFERENCE_CLAIM_LEASE_MS
      > SOURCE_RECALL_REFERENCE_CLAIM_PREPARATION_MARGIN_MS
        + SOURCE_RECALL_PAGE_TIMEOUT_MS
        + SOURCE_RECALL_REFERENCE_PROVIDER_HANDOFF_MARGIN_MS
        + SOURCE_RECALL_REFERENCE_CHECKPOINT_COMMIT_MARGIN_MS,
  );
  assert.equal(
    SOURCE_RECALL_REFERENCE_PRIVATE_PAGE_TTL_MS,
    24 * 60 * 60 * 1_000,
  );
  assert.equal(
    SOURCE_RECALL_REFERENCE_MAX_COLLECTION_AGE_MS,
    4 * 60 * 60 * 1_000,
  );
  assert.equal(
    SOURCE_RECALL_REFERENCE_MIN_PAGE_RETENTION_MS,
    20 * 60 * 60 * 1_000,
  );

  const { harness, store, work, snapshot } = await initialized();
  assert.equal(snapshot.record.createdAtMs, harness.now());
  assert.equal(snapshot.record.updatedAtMs, harness.now());
  assert.equal(snapshot.record.revision, 0);

  const expectedRequests = [
    { cursor: null, seenCursors: [] },
    { cursor: cursor(2), seenCursors: [] },
    { cursor: null, seenCursors: [] },
    { cursor: cursor(2), seenCursors: [] },
  ];
  const pages = [
    page({
      nextCursor: cursor(2),
      references: [
        reference(),
        reference({
          id: "bot-synthetic-b",
          joinAt: "2026-07-25T22:00:00.000Z",
          email: "synthetic.second@example.invalid",
        }),
      ],
    }),
    page({
      references: [reference({
        id: "bot-synthetic-c",
        joinAt: "2026-07-25T21:00:00.000Z",
        email: "synthetic.third@example.invalid",
      })],
    }),
    page({
      nextCursor: cursor(2),
      references: [
        reference(),
        reference({
          id: "bot-synthetic-b",
          joinAt: "2026-07-25T22:00:00.000Z",
          email: "synthetic.second@example.invalid",
        }),
      ],
    }),
    page({
      references: [reference({
        id: "bot-synthetic-c",
        joinAt: "2026-07-25T21:00:00.000Z",
        email: "synthetic.third@example.invalid",
      })],
    }),
  ];
  let reads = 0;
  const dependencies = collectorDependencies(
    store,
    async (request) => {
      const expected = expectedRequests[reads];
      assert.equal(request.boundaryAt, BOUNDARY);
      assert.equal(request.cursor, expected.cursor);
      assert.deepEqual(request.seenCursors, expected.seenCursors);
      assert.equal(Object.isFrozen(request), true);
      reads += 1;
      return pages[reads - 1];
    },
  );

  const outputs = [];
  for (let index = 0; index < 4; index += 1) {
    harness.advance(1);
    outputs.push(await collectRecallReferenceHeadStep(
      work,
      dependencies,
    ));
  }
  assert.equal(reads, 4);
  assert.equal(outputs.at(-1).status, "sealed_unpinnable");
  assert.equal(outputs.at(-1).headSealed, true);
  assertPublicOnly(outputs);

  const replay = await collectRecallReferenceHeadStep(
    work,
    dependencies,
  );
  assert.equal(replay.status, "sealed_unpinnable");
  assert.equal(reads, 4);
  assertPublicOnly(replay);

  const head = await store.readRecallReferenceHead(work);
  assert.equal(head.record.passCount, 2);
  assert.equal(head.record.pageCount, 2);
  assert.equal(head.record.referenceCount, 3);
  assert.equal(head.record.pinnable, false);
  assert.equal(head.record.pointReadAvailable, false);
  assert.equal(head.record.sourceFactsAvailable, false);
  assert.equal(head.record.successClassificationAvailable, false);
  assert.equal(
    head.record.candidateIdentityResolutionAvailable,
    false,
  );
  assert.equal(head.record.authorityAvailable, false);
  assert.match(
    head.recallReferenceHeadEpochDigest,
    /^[a-f0-9]{64}$/u,
  );
  assert.match(
    head.recallReferenceHeadRevisionDigest,
    /^[a-f0-9]{64}$/u,
  );
  assert.match(
    head.recallReferenceHeadRecordDigest,
    /^[a-f0-9]{64}$/u,
  );
  assert.equal(
    Object.keys(head).some((key) => key.startsWith("sourceHead")),
    false,
  );
  assert.equal(
    head.record.sealedAtMs,
    JSON.parse([...harness.runs.values()][0]).updatedAtMs,
  );
  assertPublicOnly(head);

  const pageWrites = harness.events.filter(
    (event) => event.kind === "cas" && event.hasPage,
  );
  assert.equal(pageWrites.length, 4);
  assert.equal(pageWrites.every(
    (event) => (
      event.pageTtlMs
        === SOURCE_RECALL_REFERENCE_PRIVATE_PAGE_TTL_MS
    ),
  ), true);
  assert.equal(harness.pages.size, 4);
  assert.equal(harness.heads.size, 1);
  assert.equal(
    harness.events.filter(
      (event) => event.kind === "read_page",
    ).length,
    0,
  );
  const sealingCas = harness.events.find(
    (event) => event.kind === "cas" && event.hasHead,
  );
  assert.equal(sealingCas.requiredPageCount, 2);
  harness.advance(
    SOURCE_RECALL_REFERENCE_PRIVATE_PAGE_TTL_MS + 10,
  );
  harness.expirePrivatePages();
  assert.equal(harness.pages.size, 0);
  assert.equal(harness.heads.size, 1);
  assert.equal(
    Object.prototype.hasOwnProperty.call(
      store,
      "readRecallReferencePage",
    ),
    false,
  );

  const casEvents = harness.events.filter(
    (event) => event.kind === "cas",
  );
  for (let index = 0; index < casEvents.length; index += 1) {
    const event = casEvents[index];
    assert.equal(event.nextRecord.updatedAtMs, event.nowMs);
    assert.equal(
      event.nextRecord.createdAtMs,
      snapshot.record.createdAtMs,
    );
    assert.equal(event.nextRecord.revision, index + 1);
  }
});

test("the 200-page ceiling seals through bounded atomic receipts with zero private page rereads", async () => {
  const { harness, store, work } = await initialized();
  const pages = Array.from(
    { length: SOURCE_RECALL_REFERENCE_MAX_PAGES },
    (_, index) => {
      const pageNumber = index + 1;
      return page({
        nextCursor: pageNumber
          < SOURCE_RECALL_REFERENCE_MAX_PAGES
          ? cursor(pageNumber + 1)
          : null,
      });
    },
  );
  let last;
  for (
    let passNumber = 1;
    passNumber <= SOURCE_RECALL_REFERENCE_REQUIRED_PASSES;
    passNumber += 1
  ) {
    for (const selectedPage of pages) {
      const claim = await store.claimRecallReferencePage(work);
      last = await store.checkpointRecallReferencePage(
        claim,
        selectedPage,
      );
    }
  }
  assert.equal(last.snapshot.record.status, "sealed_unpinnable");
  assert.equal(
    last.snapshot.record.passes[1].pageCount,
    SOURCE_RECALL_REFERENCE_MAX_PAGES,
  );
  assert.equal(
    harness.events.filter(
      (event) => event.kind === "read_page",
    ).length,
    0,
  );
  const sealingCas = harness.events.find(
    (event) => event.kind === "cas" && event.hasHead,
  );
  assert.equal(
    sealingCas.requiredPageCount,
    SOURCE_RECALL_REFERENCE_MAX_PAGES,
  );
  const atomicProofs = harness.events.filter(
    (event) => event.kind === "verify_artifact_set",
  );
  assert.equal(atomicProofs.length, 1);
  assert.equal(
    atomicProofs[0].requiredPageCount,
    SOURCE_RECALL_REFERENCE_MAX_PAGES,
  );
});

test("initial durable creation must be stamped by Redis TIME", async () => {
  const harness = memoryPersistence({ stampInitial: false });
  const store = createSourceRecallReferencePersistenceProtocol({
    persistence: harness.persistence,
  });
  await assert.rejects(
    () => store.ensureRecallReferenceRun(context()),
    (error) => expectStoreCode(
      error,
      "SOURCE_RECALL_REFERENCE_DURABLE_STATE_MALFORMED",
    ),
  );
  assert.equal(
    harness.events.filter(
      (event) => event.kind === "ensure_created",
    ).length,
    1,
  );
});

test("a persisted claim makes concurrent collection a no-op", async () => {
  const { store, work } = await initialized();
  let resolvePage;
  const heldPage = new Promise((resolve) => {
    resolvePage = resolve;
  });
  let reads = 0;
  const dependencies = collectorDependencies(
    store,
    async () => {
      reads += 1;
      return heldPage;
    },
  );

  const first = collectRecallReferenceHeadStep(work, dependencies);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(reads, 1);
  const concurrent = await collectRecallReferenceHeadStep(
    work,
    dependencies,
  );
  assert.equal(concurrent.status, "collecting");
  assert.equal(concurrent.inProgress, true);
  assert.equal(reads, 1);
  resolvePage(page());
  const completed = await first;
  assert.equal(completed.status, "collecting");
  assert.equal(reads, 1);
});

test("expired and abandoned claims invalidate terminally without persisting the supplied page", async () => {
  {
    const { harness, store, work } = await initialized();
    const claim = await store.claimRecallReferencePage(work);
    harness.advance(SOURCE_RECALL_REFERENCE_CLAIM_LEASE_MS + 1);
    const checkpoint = await store.checkpointRecallReferencePage(
      claim,
      page({ references: [reference()] }),
    );
    assert.equal(checkpoint.aggregate.status, "invalidated");
    assert.equal(harness.pages.size, 0);
    await assert.rejects(
      () => store.checkpointRecallReferencePage(claim, page()),
      (error) => expectStoreCode(
        error,
        "SOURCE_RECALL_REFERENCE_CLAIM_INVALID",
      ),
    );
  }

  {
    const { harness, store, work } = await initialized();
    await store.claimRecallReferencePage(work);
    harness.advance(SOURCE_RECALL_REFERENCE_CLAIM_LEASE_MS + 1);
    let reads = 0;
    const result = await collectRecallReferenceHeadStep(
      work,
      collectorDependencies(store, async () => {
        reads += 1;
        return page();
      }),
    );
    assert.equal(result.status, "invalidated");
    assert.equal(reads, 0);
    assert.equal(harness.pages.size, 0);
  }
});

test("cross-page duplicates, ordering regressions, and pass drift invalidate without a second pass or third read", async (t) => {
  await t.test("duplicate reference", async () => {
    const { harness, store, work } = await initialized();
    const results = [
      page({
        nextCursor: cursor(2),
        references: [reference()],
      }),
      page({
        references: [reference()],
      }),
    ];
    let reads = 0;
    const dependencies = collectorDependencies(
      store,
      async () => results[reads++],
    );
    await collectRecallReferenceHeadStep(work, dependencies);
    const invalid = await collectRecallReferenceHeadStep(
      work,
      dependencies,
    );
    assert.equal(invalid.status, "invalidated");
    assert.equal(harness.pages.size, 1);
    await collectRecallReferenceHeadStep(work, dependencies);
    assert.equal(reads, 2);
    assert.equal(harness.heads.size, 0);
  });

  await t.test("ordering regression", async () => {
    const { harness, store, work } = await initialized();
    const results = [
      page({
        nextCursor: cursor(2),
        references: [reference({
          joinAt: "2026-07-25T20:00:00.000Z",
        })],
      }),
      page({
        references: [reference({
          id: "bot-synthetic-b",
          joinAt: "2026-07-25T21:00:00.000Z",
        })],
      }),
    ];
    let reads = 0;
    const dependencies = collectorDependencies(
      store,
      async () => results[reads++],
    );
    await collectRecallReferenceHeadStep(work, dependencies);
    const invalid = await collectRecallReferenceHeadStep(
      work,
      dependencies,
    );
    assert.equal(invalid.status, "invalidated");
    assert.equal(harness.pages.size, 1);
    assert.equal(harness.heads.size, 0);
  });

  await t.test("second-pass semantic drift", async () => {
    const { harness, store, work } = await initialized();
    const results = [
      page({ references: [reference()] }),
      page({ references: [reference({
        id: "bot-synthetic-b",
      })] }),
    ];
    let reads = 0;
    const dependencies = collectorDependencies(
      store,
      async () => results[reads++],
    );
    await collectRecallReferenceHeadStep(work, dependencies);
    const invalid = await collectRecallReferenceHeadStep(
      work,
      dependencies,
    );
    assert.equal(invalid.status, "invalidated");
    assert.equal(harness.pages.size, 1);
    await collectRecallReferenceHeadStep(work, dependencies);
    assert.equal(reads, 2);
    assert.equal(harness.heads.size, 0);
  });
});

test("source failure is durably terminal and response details never escape", async () => {
  const { store, work } = await initialized();
  const forbidden = [
    "private-response-body",
    "private-secret-value",
    "bot-synthetic-a",
  ];
  let reads = 0;
  const dependencies = collectorDependencies(
    store,
    async () => {
      reads += 1;
      throw new Error(forbidden.join(":"));
    },
  );
  await assert.rejects(
    () => collectRecallReferenceHeadStep(work, dependencies),
    (error) => expectCollectorCode(
      error,
      "SOURCE_RECALL_REFERENCE_PAGE_READ_FAILED",
      forbidden,
    ),
  );
  const replay = await collectRecallReferenceHeadStep(
    work,
    dependencies,
  );
  assert.equal(replay.status, "invalidated");
  assert.equal(reads, 1);
  assertPublicOnly(replay);
});

test("CAS conflict after the sole page read is safe, consumes the claim, and never retries", async () => {
  const { harness, store, work } = await initialized();
  let reads = 0;
  const dependencies = collectorDependencies(
    store,
    async () => {
      reads += 1;
      harness.conflictNextCas();
      return page();
    },
  );
  await assert.rejects(
    () => collectRecallReferenceHeadStep(work, dependencies),
    (error) => expectCollectorCode(
      error,
      "SOURCE_RECALL_REFERENCE_CHECKPOINT_FAILED",
    ),
  );
  const concurrent = await collectRecallReferenceHeadStep(
    work,
    dependencies,
  );
  assert.equal(concurrent.status, "collecting");
  assert.equal(concurrent.inProgress, true);
  assert.equal(reads, 1);
  assert.equal(harness.pages.size, 0);
});

test("head readback and durable state validation fail closed on byte or object tampering", async () => {
  const { harness, store, work } = await initialized();
  let reads = 0;
  const dependencies = collectorDependencies(
    store,
    async () => {
      reads += 1;
      return page();
    },
  );
  await collectRecallReferenceHeadStep(work, dependencies);
  await collectRecallReferenceHeadStep(work, dependencies);
  assert.equal(reads, 2);
  const [headKey, headRaw] = [...harness.heads.entries()][0];
  harness.heads.set(
    headKey,
    headRaw.replace('"version":1', '"version":2'),
  );
  await assert.rejects(
    () => store.readRecallReferenceHead(work),
    (error) => expectStoreCode(
      error,
      "SOURCE_RECALL_REFERENCE_SEALED_ARTIFACTS_INVALID",
    ),
  );
  const invalidatedReplay =
    await store.claimRecallReferencePage(work);
  assert.equal(invalidatedReplay.outcome, "invalidated");
  assert.equal(
    invalidatedReplay.aggregate.status,
    "invalidated",
  );

  const durable = JSON.parse([...harness.runs.values()][0]);
  assert.throws(
    () => validateRecallReferenceRun(
      new Proxy(durable, {}),
    ),
    (error) => expectStoreCode(
      error,
      "SOURCE_RECALL_REFERENCE_DURABLE_STATE_MALFORMED",
    ),
  );
  const sparsePasses = [...durable.passes];
  delete sparsePasses[0];
  assert.throws(
    () => validateRecallReferenceRun({
      ...durable,
      passes: sparsePasses,
    }),
    (error) => expectStoreCode(
      error,
      "SOURCE_RECALL_REFERENCE_DURABLE_STATE_MALFORMED",
    ),
  );

  for (const field of [
    "referenceManifestDigest",
    "semanticDigest",
  ]) {
    const changed = structuredClone(durable);
    changed.passes[0][field] = "f".repeat(64);
    assert.throws(
      () => validateRecallReferenceRun(changed),
      (error) => expectStoreCode(
        error,
        "SOURCE_RECALL_REFERENCE_DURABLE_STATE_MALFORMED",
      ),
    );
  }
  for (const field of ["cursorDigest", "nextCursorDigest"]) {
    const changed = structuredClone(durable);
    changed.passes[0].pageManifests[0][field] = "f".repeat(64);
    assert.throws(
      () => validateRecallReferenceRun(changed),
      (error) => expectStoreCode(
        error,
        "SOURCE_RECALL_REFERENCE_DURABLE_STATE_MALFORMED",
      ),
    );
  }
});

test("store candidate normalization exactly matches captured field boundaries", async (t) => {
  for (const [field, maximum] of [
    ["fullName", 512],
    ["email", 512],
    ["linkedin", 4_096],
    ["paraformEventId", 1_024],
  ]) {
    await t.test(`${field} accepts max and rejects max+1`, async () => {
      {
        const { store, work } = await initialized();
        for (let pass = 0; pass < 2; pass += 1) {
          const claim = await store.claimRecallReferencePage(work);
          const value = reference({
            [field]: "x".repeat(maximum),
          });
          const settled = await store.checkpointRecallReferencePage(
            claim,
            page({ references: [value] }),
          );
          assert.equal(
            settled.aggregate.status,
            pass === 0 ? "collecting" : "sealed_unpinnable",
          );
        }
      }
      {
        const { store, work } = await initialized();
        const claim = await store.claimRecallReferencePage(work);
        await assert.rejects(
          () => store.checkpointRecallReferencePage(
            claim,
            page({
              references: [reference({
                [field]: "x".repeat(maximum + 1),
              })],
            }),
          ),
          (error) => expectStoreCode(
            error,
            "SOURCE_RECALL_REFERENCE_PAGE_INVALID",
          ),
        );
      }
    });
  }
});

test("persistence envelopes reject proxy, accessor, symbol, extra-key, and invalid Redis time results", async (t) => {
  const mutations = [
    ["proxy", (result) => new Proxy(result, {})],
    ["accessor", (result) => {
      const changed = { ...result };
      Object.defineProperty(changed, "redisNowMs", {
        enumerable: true,
        get() {
          return result.redisNowMs;
        },
      });
      return changed;
    }],
    ["symbol", (result) => {
      const changed = { ...result };
      changed[Symbol("hidden")] = true;
      return changed;
    }],
    ["extra key", (result) => ({ ...result, extra: true })],
    ["zero Redis time", (result) => ({
      ...result,
      redisNowMs: 0,
    })],
    ["fractional Redis time", (result) => ({
      ...result,
      redisNowMs: result.redisNowMs + 0.5,
    })],
  ];
  for (const [name, mutate] of mutations) {
    await t.test(name, async () => {
      const harness = memoryPersistence();
      const original = harness.persistence.ensure;
      harness.persistence.ensure = async (input) =>
        mutate(await original(input));
      const store = createSourceRecallReferencePersistenceProtocol({
        persistence: harness.persistence,
      });
      await assert.rejects(
        () => store.ensureRecallReferenceRun(context()),
        (error) => expectStoreCode(
          error,
          "SOURCE_RECALL_REFERENCE_PERSISTENCE_RESULT_INVALID",
        ),
      );
    });
  }

  await t.test("stored state cannot be future of Redis TIME", async () => {
    const harness = memoryPersistence();
    const original = harness.persistence.readRun;
    harness.persistence.readRun = async (input) => {
      const result = await original(input);
      return {
        ...result,
        redisNowMs: result.redisNowMs - 1,
      };
    };
    const store = createSourceRecallReferencePersistenceProtocol({
      persistence: harness.persistence,
    });
    const ensured = await store.ensureRecallReferenceRun(context());
    await assert.rejects(
      () => store.claimRecallReferencePage(ensured.work),
      (error) => expectStoreCode(
        error,
        "SOURCE_RECALL_REFERENCE_DURABLE_STATE_MALFORMED",
      ),
    );
  });
});

test("CAS receipts, receipt-only private pages, complete page-set retention, and head clock all fail closed", async (t) => {
  await t.test("page receipt binds raw digest and exact TTL", async () => {
    const harness = memoryPersistence();
    const original = harness.persistence.compareAndSet;
    harness.persistence.compareAndSet = async (input) => {
      const result = await original(input);
      if (!result.pageReceipt) return result;
      return {
        ...result,
        pageReceipt: {
          ...result.pageReceipt,
          rawDigest: "f".repeat(64),
          ttlMs:
            SOURCE_RECALL_REFERENCE_PRIVATE_PAGE_TTL_MS - 1,
        },
      };
    };
    const { store, work } = await initialized(harness);
    const claim = await store.claimRecallReferencePage(work);
    await assert.rejects(
      () => store.checkpointRecallReferencePage(claim, page()),
      (error) => expectStoreCode(
        error,
        "SOURCE_RECALL_REFERENCE_PERSISTENCE_RESULT_INVALID",
      ),
    );
  });

  await t.test("page publication needs no private raw reread", async () => {
    const harness = memoryPersistence();
    harness.persistence.readPage = async () => {
      throw new Error("private raw reread is forbidden");
    };
    const { store, work } = await initialized(harness);
    const claim = await store.claimRecallReferencePage(work);
    const result = await store.checkpointRecallReferencePage(
      claim,
      page(),
    );
    assert.equal(result.snapshot.record.passes[0].pageCount, 1);
    assert.equal(
      harness.events.some(
        (event) => event.kind === "read_page",
      ),
      false,
    );
  });

  await t.test("seal refuses a second-pass page below minimum retention", async () => {
    const { harness, store, work } = await initialized();
    const results = [
      page({ nextCursor: cursor(2) }),
      page(),
      page({ nextCursor: cursor(2) }),
      page(),
    ];
    for (let index = 0; index < 3; index += 1) {
      const claim = await store.claimRecallReferencePage(work);
      await store.checkpointRecallReferencePage(
        claim,
        results[index],
      );
    }
    const secondPassFirst = [...harness.pages.entries()]
      .find(([key]) => key.endsWith(":2:1"));
    secondPassFirst[1].expiresAtMs =
      harness.now()
      + SOURCE_RECALL_REFERENCE_MIN_PAGE_RETENTION_MS - 1;
    const finalClaim = await store.claimRecallReferencePage(work);
    await assert.rejects(
      () => store.checkpointRecallReferencePage(
        finalClaim,
        results[3],
      ),
      (error) => expectStoreCode(
        error,
        "SOURCE_RECALL_REFERENCE_PERSISTENCE_FAILED",
      ),
    );
    assert.equal(harness.heads.size, 0);
  });

  await t.test("seal rejects a prior page TTL extension", async () => {
    const { harness, store, work } = await initialized();
    const results = [
      page({ nextCursor: cursor(2) }),
      page(),
      page({ nextCursor: cursor(2) }),
      page(),
    ];
    for (let index = 0; index < 3; index += 1) {
      const claim = await store.claimRecallReferencePage(work);
      await store.checkpointRecallReferencePage(
        claim,
        results[index],
      );
    }
    const secondPassFirst = [...harness.pages.entries()]
      .find(([key]) => key.endsWith(":2:1"));
    secondPassFirst[1].expiresAtMs +=
      SOURCE_RECALL_REFERENCE_PRIVATE_PAGE_TTL_MS;
    const finalClaim = await store.claimRecallReferencePage(work);
    await assert.rejects(
      () => store.checkpointRecallReferencePage(
        finalClaim,
        results[3],
      ),
      (error) => expectStoreCode(
        error,
        "SOURCE_RECALL_REFERENCE_PERSISTENCE_FAILED",
      ),
    );
    assert.equal(harness.heads.size, 0);
  });

  for (const [name, field] of [
    ["head receipt", "headReceipt"],
    ["page-set receipt", "pageSetReceipt"],
  ]) {
    await t.test(`${name} is exact`, async () => {
      const harness = memoryPersistence();
      const original = harness.persistence.compareAndSet;
      harness.persistence.compareAndSet = async (input) => {
        const result = await original(input);
        if (!result[field]) return result;
        return {
          ...result,
          [field]: { ...result[field], extra: true },
        };
      };
      const { store, work } = await initialized(harness);
      let claim = await store.claimRecallReferencePage(work);
      await store.checkpointRecallReferencePage(claim, page());
      claim = await store.claimRecallReferencePage(work);
      await assert.rejects(
        () => store.checkpointRecallReferencePage(claim, page()),
        (error) => expectStoreCode(
          error,
          "SOURCE_RECALL_REFERENCE_PERSISTENCE_RESULT_INVALID",
        ),
      );
      if (field === "headReceipt") {
        const recovered =
          await store.claimRecallReferencePage(work);
        assert.equal(recovered.status, "in_progress");
        assert.equal(
          recovered.aggregate.status,
          "collecting",
        );
        assert.equal(recovered.aggregate.headSealed, false);
        harness.advance(
          SOURCE_RECALL_REFERENCE_CLAIM_LEASE_MS,
        );
        const invalidated =
          await store.claimRecallReferencePage(work);
        assert.equal(invalidated.outcome, "invalidated");
      }
    });
  }

  await t.test("head readback time cannot precede final CAS time", async () => {
    const harness = memoryPersistence();
    let regress = false;
    const original = harness.persistence.readHead;
    harness.persistence.readHead = async (input) => {
      const result = await original(input);
      return regress
        ? { ...result, redisNowMs: result.redisNowMs - 1 }
        : result;
    };
    const { store, work } = await initialized(harness);
    let claim = await store.claimRecallReferencePage(work);
    await store.checkpointRecallReferencePage(claim, page());
    claim = await store.claimRecallReferencePage(work);
    regress = true;
    await assert.rejects(
      () => store.checkpointRecallReferencePage(claim, page()),
      (error) => expectStoreCode(
        error,
        "SOURCE_RECALL_REFERENCE_HEAD_READBACK_FAILED",
      ),
    );
  });
});

test("sealed replay re-proves every artifact and never trusts terminal state blindly", async (t) => {
  await t.test("head deleted after final CAS invalidates", async () => {
    const harness = memoryPersistence();
    const original = harness.persistence.compareAndSet;
    harness.persistence.compareAndSet = async (input) => {
      const result = await original(input);
      if (input.headRaw !== null) {
        harness.heads.delete(input.headKey);
      }
      return result;
    };
    const { store, work } = await initialized(harness);
    let claim = await store.claimRecallReferencePage(work);
    await store.checkpointRecallReferencePage(claim, page());
    claim = await store.claimRecallReferencePage(work);
    await assert.rejects(
      () => store.checkpointRecallReferencePage(claim, page()),
      (error) => expectStoreCode(
        error,
        "SOURCE_RECALL_REFERENCE_HEAD_READBACK_FAILED",
      ),
    );
    const replay = await store.claimRecallReferencePage(work);
    assert.equal(replay.outcome, "invalidated");
  });

  for (const mode of ["drop", "tamper"]) {
    await t.test(`second-pass page ${mode} invalidates replay`, async () => {
      const { harness, store, work } = await initialized();
      let claim = await store.claimRecallReferencePage(work);
      await store.checkpointRecallReferencePage(claim, page());
      claim = await store.claimRecallReferencePage(work);
      await store.checkpointRecallReferencePage(claim, page());
      const secondPass = [...harness.pages.entries()]
        .find(([key]) => key.endsWith(":2:1"));
      if (mode === "drop") {
        harness.pages.delete(secondPass[0]);
      } else {
        secondPass[1].raw = `${secondPass[1].raw} `;
      }
      const replay = await store.claimRecallReferencePage(work);
      assert.equal(replay.outcome, "invalidated");
      assert.equal(replay.aggregate.status, "invalidated");
    });
  }

  await t.test("atomic replay proof rejects pages that did not coexist with the minimum retention", async () => {
    const harness = memoryPersistence();
    const original = harness.persistence.verifyArtifactSet;
    let advanceBeforeAtomicProof = false;
    harness.persistence.verifyArtifactSet = async (input) => {
      if (advanceBeforeAtomicProof) {
        advanceBeforeAtomicProof = false;
        harness.advance(2);
      }
      return original(input);
    };
    const { store, work } = await initialized(harness);
    const results = [
      page({ nextCursor: cursor(2) }),
      page(),
      page({ nextCursor: cursor(2) }),
      page(),
    ];
    for (let index = 0; index < 3; index += 1) {
      const claim = await store.claimRecallReferencePage(work);
      await store.checkpointRecallReferencePage(
        claim,
        results[index],
      );
    }
    harness.advance(10_000);
    let claim = await store.claimRecallReferencePage(work);
    await store.checkpointRecallReferencePage(claim, results[3]);
    const firstRetainedPage = [...harness.pages.entries()]
      .find(([key]) => key.endsWith(":2:1"));
    harness.advance(
      firstRetainedPage[1].expiresAtMs
      - harness.now()
      - SOURCE_RECALL_REFERENCE_MIN_SEALED_RETENTION_MS
      - 1,
    );
    advanceBeforeAtomicProof = true;
    claim = await store.claimRecallReferencePage(work);
    assert.equal(claim.outcome, "invalidated");
    assert.equal(claim.aggregate.status, "invalidated");
    assert.equal(claim.aggregate.headSealed, false);
    assert.equal(
      harness.events.some(
        (event) => event.kind === "verify_artifact_set",
      ),
      true,
    );
  });

  await t.test("atomic replay proof binds the final run revision", async () => {
    const harness = memoryPersistence();
    const original = harness.persistence.verifyArtifactSet;
    let invalidateBeforeProof = false;
    harness.persistence.verifyArtifactSet = async (input) => {
      if (invalidateBeforeProof) {
        invalidateBeforeProof = false;
        const record = JSON.parse(harness.runs.get(input.runKey));
        record.status = "invalidated";
        record.activeClaim = null;
        record.headRecordDigest = null;
        record.invalidReason = "concurrent_invalidation";
        record.updatedAtMs = harness.now();
        record.revision += 1;
        harness.runs.set(input.runKey, canonicalJson(record));
      }
      return original(input);
    };
    const { store, work } = await initialized(harness);
    let claim = await store.claimRecallReferencePage(work);
    await store.checkpointRecallReferencePage(claim, page());
    claim = await store.claimRecallReferencePage(work);
    await store.checkpointRecallReferencePage(claim, page());
    invalidateBeforeProof = true;
    const replay = await store.claimRecallReferencePage(work);
    assert.equal(replay.outcome, "invalidated");
    assert.equal(replay.aggregate.headSealed, false);
  });

  await t.test("atomic verifier Redis time must preserve every page retention floor", async () => {
    const harness = memoryPersistence();
    const original = harness.persistence.verifyArtifactSet;
    let lieAfterExpiry = false;
    harness.persistence.verifyArtifactSet = async (input) => {
      if (!lieAfterExpiry) return original(input);
      lieAfterExpiry = false;
      harness.advance(
        SOURCE_RECALL_REFERENCE_MIN_SEALED_RETENTION_MS + 1,
      );
      return {
        artifactSetReceipt: {
          count: input.requiredPageSet.length,
          requestDigest: input.requestDigest,
          verifiedAtMs: harness.now(),
        },
        status: "verified",
        redisNowMs: harness.now(),
      };
    };
    const { store, work } = await initialized(harness);
    let claim = await store.claimRecallReferencePage(work);
    await store.checkpointRecallReferencePage(claim, page());
    claim = await store.claimRecallReferencePage(work);
    await store.checkpointRecallReferencePage(claim, page());
    const retainedPage = [...harness.pages.values()][1];
    harness.advance(
      retainedPage.expiresAtMs
      - harness.now()
      - SOURCE_RECALL_REFERENCE_MIN_SEALED_RETENTION_MS,
    );
    lieAfterExpiry = true;
    const replay = await store.claimRecallReferencePage(work);
    assert.equal(replay.outcome, "invalidated");
    assert.equal(replay.aggregate.headSealed, false);
  });

  await t.test("collector returns a sealed-artifact invalidation with both completed passes preserved", async () => {
    const { harness, store, work } = await initialized();
    let claim = await store.claimRecallReferencePage(work);
    await store.checkpointRecallReferencePage(claim, page());
    claim = await store.claimRecallReferencePage(work);
    await store.checkpointRecallReferencePage(claim, page());
    const retainedPage = [...harness.pages.keys()]
      .find((key) => key.endsWith(":2:1"));
    harness.pages.delete(retainedPage);
    let sourceReads = 0;
    const aggregate = await collectRecallReferenceHeadStep(
      work,
      collectorDependencies(store, async () => {
        sourceReads += 1;
        return page();
      }),
    );
    assert.equal(aggregate.status, "invalidated");
    assert.equal(aggregate.completedPasses, 2);
    assert.equal(aggregate.inProgress, false);
    assert.equal(aggregate.headSealed, false);
    assert.equal(sourceReads, 0);
  });
});

test("atomic deadlines prevent delayed claims and checkpoints from causing unsafe provider reads or writes", async (t) => {
  await t.test("a delayed claim promotion expires the claim before source I/O", async () => {
    const harness = memoryPersistence();
    const original = harness.persistence.compareAndSet;
    let delayed = false;
    harness.persistence.compareAndSet = async (input) => {
      const next = JSON.parse(input.nextRaw);
      if (!delayed && next.activeClaim !== null) {
        delayed = true;
        harness.advance(
          SOURCE_RECALL_REFERENCE_CLAIM_LEASE_MS + 1,
        );
      }
      return original(input);
    };
    const { store, work } = await initialized(harness);
    let reads = 0;
    const result = await collectRecallReferenceHeadStep(
      work,
      collectorDependencies(store, async () => {
        reads += 1;
        return page();
      }),
    );
    assert.equal(result.status, "invalidated");
    assert.equal(reads, 0);
    assert.equal(harness.pages.size, 0);
    const settled = await store.claimRecallReferencePage(work);
    assert.equal(settled.outcome, "invalidated");
  });

  await t.test("a delayed claim promotion response cannot outlive concurrent invalidation and trigger source I/O", async () => {
    const harness = memoryPersistence();
    const original = harness.persistence.compareAndSet;
    let delayResponse = true;
    let secondStore;
    let sharedWork;
    let concurrentResult;
    harness.persistence.compareAndSet = async (input) => {
      const expected = JSON.parse(input.expectedRaw);
      const next = JSON.parse(input.nextRaw);
      if (
        delayResponse
        && expected.pendingValidation !== null
        && next.pendingValidation === null
        && next.activeClaim !== null
      ) {
        delayResponse = false;
        const committed = await original(input);
        harness.advance(
          SOURCE_RECALL_REFERENCE_CLAIM_LEASE_MS + 1,
        );
        concurrentResult =
          await secondStore.claimRecallReferencePage(sharedWork);
        return committed;
      }
      return original(input);
    };
    const { store, work } = await initialized(harness);
    sharedWork = work;
    secondStore =
      createSourceRecallReferencePersistenceProtocol({
        persistence: harness.persistence,
      });
    let reads = 0;
    const result = await collectRecallReferenceHeadStep(
      work,
      collectorDependencies(store, async () => {
        reads += 1;
        return page();
      }),
    );
    assert.equal(concurrentResult.status, "complete");
    assert.equal(concurrentResult.outcome, "invalidated");
    assert.equal(result.status, "invalidated");
    assert.equal(result.inProgress, false);
    assert.equal(reads, 0);
    assert.equal(harness.pages.size, 0);
    assert.equal(harness.heads.size, 0);
  });

  await t.test("claim confirmation rejects Redis TIME regression before source I/O", async () => {
    const harness = memoryPersistence();
    const originalCas = harness.persistence.compareAndSet;
    const originalReadRun = harness.persistence.readRun;
    let regressConfirmation = false;
    let promotionRedisNowMs = null;
    harness.persistence.compareAndSet = async (input) => {
      const expected = JSON.parse(input.expectedRaw);
      const next = JSON.parse(input.nextRaw);
      if (
        expected.pendingValidation !== null
        && next.pendingValidation === null
        && next.activeClaim !== null
      ) {
        harness.advance(10);
        const committed = await originalCas(input);
        promotionRedisNowMs = committed.redisNowMs;
        harness.advance(
          SOURCE_RECALL_REFERENCE_CLAIM_LEASE_MS + 1,
        );
        regressConfirmation = true;
        return committed;
      }
      return originalCas(input);
    };
    harness.persistence.readRun = async (input) => {
      const result = await originalReadRun(input);
      if (!regressConfirmation) return result;
      regressConfirmation = false;
      return {
        ...result,
        redisNowMs: promotionRedisNowMs - 1,
      };
    };
    const { store, work } = await initialized(harness);
    let reads = 0;
    await assert.rejects(
      () => collectRecallReferenceHeadStep(
        work,
        collectorDependencies(store, async () => {
          reads += 1;
          return page();
        }),
      ),
      (error) => expectCollectorCode(
        error,
        "SOURCE_RECALL_REFERENCE_CLAIM_FAILED",
      ),
    );
    assert.equal(reads, 0);
    const settled = await store.claimRecallReferencePage(work);
    assert.equal(settled.outcome, "invalidated");
    assert.equal(settled.aggregate.headSealed, false);
  });

  await t.test("a delayed confirmation response cannot outlive its local handoff fence", async () => {
    const originalMonotonicNow = performance.now;
    let monotonicNowMs = 1_000;
    performance.now = () => monotonicNowMs;
    try {
      const harness = memoryPersistence();
      const originalCas = harness.persistence.compareAndSet;
      const originalReadRun = harness.persistence.readRun;
      let delayConfirmation = false;
      let secondStore;
      let sharedWork;
      let concurrentResult;
      harness.persistence.compareAndSet = async (input) => {
        const expected = JSON.parse(input.expectedRaw);
        const next = JSON.parse(input.nextRaw);
        if (
          expected.pendingValidation !== null
          && next.pendingValidation === null
          && next.activeClaim !== null
        ) {
          const committed = await originalCas(input);
          delayConfirmation = true;
          return committed;
        }
        return originalCas(input);
      };
      harness.persistence.readRun = async (input) => {
        const result = await originalReadRun(input);
        if (!delayConfirmation) return result;
        delayConfirmation = false;
        harness.advance(
          SOURCE_RECALL_REFERENCE_CLAIM_LEASE_MS + 1,
        );
        monotonicNowMs +=
          SOURCE_RECALL_REFERENCE_CLAIM_LEASE_MS + 1;
        concurrentResult =
          await secondStore.claimRecallReferencePage(sharedWork);
        return result;
      };
      const { store, work } = await initialized(harness);
      sharedWork = work;
      secondStore =
        createSourceRecallReferencePersistenceProtocol({
          persistence: harness.persistence,
        });
      let reads = 0;
      await assert.rejects(
        () => collectRecallReferenceHeadStep(
          work,
          collectorDependencies(store, async () => {
            reads += 1;
            return page();
          }),
        ),
        (error) => expectCollectorCode(
          error,
          "SOURCE_RECALL_REFERENCE_CLAIM_FAILED",
        ),
      );
      assert.equal(concurrentResult.status, "complete");
      assert.equal(concurrentResult.outcome, "invalidated");
      assert.equal(reads, 0);
      assert.equal(harness.pages.size, 0);
      assert.equal(harness.heads.size, 0);
    } finally {
      performance.now = originalMonotonicNow;
    }
  });

  await t.test("collector checks the local handoff fence immediately before source I/O", async () => {
    const originalMonotonicNow = performance.now;
    let monotonicNowMs = 1_000;
    performance.now = () => monotonicNowMs;
    try {
      assert.equal(
        SOURCE_RECALL_REFERENCE_PROVIDER_HANDOFF_MARGIN_MS,
        1_000,
      );
      assert.equal(
        SOURCE_RECALL_REFERENCE_CHECKPOINT_COMMIT_MARGIN_MS,
        60_000,
      );
      assert.equal(SOURCE_RECALL_PAGE_TIMEOUT_MS, 20_000);
      const { store, work } = await initialized();
      let issuedDeadline = null;
      let reads = 0;
      const dependencies = Object.freeze({
        claimRecallReferencePageImpl: async (input) => {
          const claim =
            await store.claimRecallReferencePage(input);
          issuedDeadline =
            claim.sourceReadStartDeadlineMonotonicMs;
          monotonicNowMs = issuedDeadline;
          return claim;
        },
        checkpointRecallReferencePageImpl:
          store.checkpointRecallReferencePage,
        readPrivateRecallSourcePageImpl: async () => {
          reads += 1;
          return page();
        },
        recordRecallReferencePageFailureImpl:
          store.recordRecallReferencePageFailure,
      });
      await assert.rejects(
        () => collectRecallReferenceHeadStep(
          work,
          dependencies,
        ),
        (error) => expectCollectorCode(
          error,
          "SOURCE_RECALL_REFERENCE_PAGE_READ_FAILED",
        ),
      );
      assert.equal(
        issuedDeadline,
        1_000
          + SOURCE_RECALL_REFERENCE_CLAIM_LEASE_MS
          - SOURCE_RECALL_PAGE_TIMEOUT_MS
          - SOURCE_RECALL_REFERENCE_PROVIDER_HANDOFF_MARGIN_MS
          - SOURCE_RECALL_REFERENCE_CHECKPOINT_COMMIT_MARGIN_MS,
      );
      assert.equal(reads, 0);
      const settled =
        await store.claimRecallReferencePage(work);
      assert.equal(settled.outcome, "invalidated");
      assert.equal(settled.aggregate.headSealed, false);
    } finally {
      performance.now = originalMonotonicNow;
    }
  });

  await t.test("checkpoint crossing lease writes no page or head", async () => {
    const harness = memoryPersistence();
    const original = harness.persistence.compareAndSet;
    let delayPage = false;
    harness.persistence.compareAndSet = async (input) => {
      if (delayPage && input.pageRaw !== null) {
        delayPage = false;
        harness.advance(
          SOURCE_RECALL_REFERENCE_CLAIM_LEASE_MS + 1,
        );
      }
      return original(input);
    };
    const { store, work } = await initialized(harness);
    const claim = await store.claimRecallReferencePage(work);
    delayPage = true;
    await assert.rejects(
      () => store.checkpointRecallReferencePage(claim, page()),
      (error) => expectStoreCode(
        error,
        "SOURCE_RECALL_REFERENCE_CAS_DEADLINE_EXCEEDED",
      ),
    );
    assert.equal(harness.pages.size, 0);
    assert.equal(harness.heads.size, 0);
    const settled = await store.claimRecallReferencePage(work);
    assert.equal(settled.outcome, "invalidated");
  });

  await t.test("nonconforming late stored claim is rejected and durably invalidated before source I/O", async () => {
    const harness = memoryPersistence();
    const original = harness.persistence.compareAndSet;
    let delayClaim = true;
    harness.persistence.compareAndSet = async (input) => {
      const next = JSON.parse(input.nextRaw);
      if (
        delayClaim
        && next.pendingValidation !== null
      ) {
        delayClaim = false;
        harness.advance(
          SOURCE_RECALL_REFERENCE_MAX_COLLECTION_AGE_MS + 1,
        );
        return original({ ...input, notAfterMs: null });
      }
      return original(input);
    };
    const { store, work } = await initialized(harness);
    let reads = 0;
    await assert.rejects(
      () => collectRecallReferenceHeadStep(
        work,
        collectorDependencies(store, async () => {
          reads += 1;
          return page();
        }),
      ),
      (error) => expectCollectorCode(
        error,
        "SOURCE_RECALL_REFERENCE_CLAIM_FAILED",
      ),
    );
    assert.equal(reads, 0);
    const settled = await store.claimRecallReferencePage(work);
    assert.equal(settled.outcome, "invalidated");
    assert.equal(settled.aggregate.headSealed, false);
  });

  await t.test("checkpoint completion-budget exhaustion is a controlled pre-deadline refusal", async () => {
    const harness = memoryPersistence();
    const original = harness.persistence.compareAndSet;
    let exhaustPageBudget = false;
    harness.persistence.compareAndSet = async (input) => {
      if (exhaustPageBudget && input.pageRaw !== null) {
        exhaustPageBudget = false;
        return {
          headReceipt: null,
          pageReceipt: null,
          pageSetReceipt: null,
          status: "deadline_exceeded",
          raw: input.expectedRaw,
          redisNowMs:
            input.notAfterMs
            - SOURCE_RECALL_REFERENCE_ATOMIC_COMMIT_BUDGET_MS,
        };
      }
      return original(input);
    };
    const { store, work } = await initialized(harness);
    const claim = await store.claimRecallReferencePage(work);
    exhaustPageBudget = true;
    await assert.rejects(
      () => store.checkpointRecallReferencePage(claim, page()),
      (error) => expectStoreCode(
        error,
        "SOURCE_RECALL_REFERENCE_CAS_DEADLINE_EXCEEDED",
      ),
    );
    assert.equal(harness.pages.size, 0);
    assert.equal(harness.heads.size, 0);
  });

  await t.test("nonconforming late stored checkpoint can never publish its quarantined artifacts", async () => {
    const harness = memoryPersistence();
    const original = harness.persistence.compareAndSet;
    let delayPage = false;
    harness.persistence.compareAndSet = async (input) => {
      if (delayPage && input.pageRaw !== null) {
        delayPage = false;
        harness.advance(
          SOURCE_RECALL_REFERENCE_CLAIM_LEASE_MS + 1,
        );
        return original({ ...input, notAfterMs: null });
      }
      return original(input);
    };
    const { store, work } = await initialized(harness);
    const claim = await store.claimRecallReferencePage(work);
    delayPage = true;
    await assert.rejects(
      () => store.checkpointRecallReferencePage(claim, page()),
      (error) => expectStoreCode(
        error,
        "SOURCE_RECALL_REFERENCE_CAS_DEADLINE_EXCEEDED",
      ),
    );
    assert.equal(harness.heads.size, 0);
    const settled = await store.claimRecallReferencePage(work);
    assert.equal(settled.outcome, "invalidated");
    await assert.rejects(
      () => store.readRecallReferenceHead(work),
      (error) => expectStoreCode(
        error,
        "SOURCE_RECALL_REFERENCE_HEAD_NOT_AVAILABLE",
      ),
    );
  });

  await t.test("late transition quarantine rebases across repeated CAS conflicts until terminal", async () => {
    const harness = memoryPersistence();
    const original = harness.persistence.compareAndSet;
    let delayPage = false;
    let quarantineConflicts = 2;
    let quarantineAttempts = 0;
    harness.persistence.compareAndSet = async (input) => {
      const next = JSON.parse(input.nextRaw);
      if (delayPage && input.pageRaw !== null) {
        delayPage = false;
        harness.advance(
          SOURCE_RECALL_REFERENCE_CLAIM_LEASE_MS + 1,
        );
        return original({ ...input, notAfterMs: null });
      }
      if (
        next.invalidReason === "persistence_deadline_violated"
      ) {
        quarantineAttempts += 1;
        if (quarantineConflicts > 0) {
          quarantineConflicts -= 1;
          return {
            headReceipt: null,
            pageReceipt: null,
            pageSetReceipt: null,
            status: "conflict",
            raw: harness.runs.get(input.key),
            redisNowMs: harness.now(),
          };
        }
      }
      return original(input);
    };
    const { store, work } = await initialized(harness);
    const claim = await store.claimRecallReferencePage(work);
    delayPage = true;
    await assert.rejects(
      () => store.checkpointRecallReferencePage(claim, page()),
      (error) => expectStoreCode(
        error,
        "SOURCE_RECALL_REFERENCE_CAS_DEADLINE_EXCEEDED",
      ),
    );
    assert.equal(quarantineAttempts, 3);
    const settled = await store.claimRecallReferencePage(work);
    assert.equal(settled.outcome, "invalidated");
    assert.equal(settled.aggregate.headSealed, false);
  });

  await t.test("a second protocol instance can only invalidate a late staged transition, never advance or seal it", async () => {
    const harness = memoryPersistence();
    const original = harness.persistence.compareAndSet;
    let delayPage = false;
    let raceQuarantine = true;
    let secondStore;
    let sharedWork;
    let concurrentResult;
    harness.persistence.compareAndSet = async (input) => {
      const next = JSON.parse(input.nextRaw);
      if (delayPage && input.pageRaw !== null) {
        delayPage = false;
        harness.advance(
          SOURCE_RECALL_REFERENCE_CLAIM_LEASE_MS + 1,
        );
        return original({ ...input, notAfterMs: null });
      }
      if (
        raceQuarantine
        && next.invalidReason
          === "persistence_deadline_violated"
      ) {
        raceQuarantine = false;
        concurrentResult =
          await secondStore.claimRecallReferencePage(sharedWork);
      }
      return original(input);
    };
    const { store, work } = await initialized(harness);
    sharedWork = work;
    secondStore =
      createSourceRecallReferencePersistenceProtocol({
        persistence: harness.persistence,
      });
    const claim = await store.claimRecallReferencePage(work);
    delayPage = true;
    await assert.rejects(
      () => store.checkpointRecallReferencePage(claim, page()),
      (error) => expectStoreCode(
        error,
        "SOURCE_RECALL_REFERENCE_CAS_DEADLINE_EXCEEDED",
      ),
    );
    assert.equal(concurrentResult.status, "complete");
    assert.equal(concurrentResult.outcome, "invalidated");
    assert.equal(concurrentResult.aggregate.headSealed, false);
    assert.equal(harness.heads.size, 0);
    const settled = await store.claimRecallReferencePage(work);
    assert.equal(settled.outcome, "invalidated");
  });

  await t.test("a delayed non-final promotion exposes only the exact on-time staged page and a fresh next claim", async () => {
    const harness = memoryPersistence();
    const original = harness.persistence.compareAndSet;
    let delayPromotion = false;
    harness.persistence.compareAndSet = async (input) => {
      const expected = JSON.parse(input.expectedRaw);
      const next = JSON.parse(input.nextRaw);
      if (
        delayPromotion
        && expected.pendingValidation !== null
        && next.pendingValidation === null
      ) {
        delayPromotion = false;
        harness.advance(
          SOURCE_RECALL_REFERENCE_CLAIM_LEASE_MS + 1,
        );
      }
      return original(input);
    };
    const { store, work } = await initialized(harness);
    const claim = await store.claimRecallReferencePage(work);
    delayPromotion = true;
    const checkpoint = await store.checkpointRecallReferencePage(
      claim,
      page({ nextCursor: cursor(2) }),
    );
    assert.equal(checkpoint.aggregate.status, "collecting");
    assert.equal(checkpoint.aggregate.pageCount, 1);
    const nextClaim = await store.claimRecallReferencePage(work);
    assert.equal(nextClaim.status, "page_required");
    assert.equal(nextClaim.passNumber, 1);
    assert.equal(nextClaim.pageNumber, 2);
    assert.equal(harness.heads.size, 0);
  });

  await t.test("a delayed final promotion may expose only the fully re-proved on-time staged head", async () => {
    const harness = memoryPersistence();
    const original = harness.persistence.compareAndSet;
    let delayFinalPromotion = false;
    harness.persistence.compareAndSet = async (input) => {
      const expected = JSON.parse(input.expectedRaw);
      const next = JSON.parse(input.nextRaw);
      if (
        delayFinalPromotion
        && expected.pendingValidation !== null
        && next.pendingValidation === null
        && next.status === "sealed_unpinnable"
      ) {
        delayFinalPromotion = false;
        harness.advance(
          SOURCE_RECALL_REFERENCE_CLAIM_LEASE_MS + 1,
        );
      }
      return original(input);
    };
    const { store, work } = await initialized(harness);
    let claim = await store.claimRecallReferencePage(work);
    await store.checkpointRecallReferencePage(claim, page());
    claim = await store.claimRecallReferencePage(work);
    delayFinalPromotion = true;
    const checkpoint =
      await store.checkpointRecallReferencePage(claim, page());
    assert.equal(
      checkpoint.aggregate.status,
      "sealed_unpinnable",
    );
    assert.equal(checkpoint.aggregate.headSealed, true);
    const head = await store.readRecallReferenceHead(work);
    assert.equal(head.record.kind, "recall_reference_artifact_head_dark");
    assert.equal(
      head.recallReferenceHeadRecordDigest,
      rawDigest(head.raw),
    );
  });

  await t.test("expired recovery invalidation and delayed promotion are one exact CAS race", async () => {
    const harness = memoryPersistence();
    const original = harness.persistence.compareAndSet;
    let racePromotion = false;
    let secondStore;
    let sharedWork;
    let concurrentResult;
    harness.persistence.compareAndSet = async (input) => {
      const expected = JSON.parse(input.expectedRaw);
      const next = JSON.parse(input.nextRaw);
      if (
        racePromotion
        && expected.pendingValidation !== null
        && next.pendingValidation === null
        && next.status === "collecting"
      ) {
        racePromotion = false;
        harness.advance(
          SOURCE_RECALL_REFERENCE_CLAIM_LEASE_MS + 1,
        );
        concurrentResult =
          await secondStore.claimRecallReferencePage(sharedWork);
      }
      return original(input);
    };
    const { store, work } = await initialized(harness);
    sharedWork = work;
    secondStore =
      createSourceRecallReferencePersistenceProtocol({
        persistence: harness.persistence,
      });
    const claim = await store.claimRecallReferencePage(work);
    racePromotion = true;
    await assert.rejects(
      () => store.checkpointRecallReferencePage(
        claim,
        page({ nextCursor: cursor(2) }),
      ),
      (error) => expectStoreCode(
        error,
        "SOURCE_RECALL_REFERENCE_CAS_CONFLICT",
      ),
    );
    assert.equal(concurrentResult.status, "complete");
    assert.equal(concurrentResult.outcome, "invalidated");
    assert.equal(concurrentResult.aggregate.headSealed, false);
    assert.equal(harness.heads.size, 0);
  });
});

test("collection age and aggregate settlement lattices fail closed", async (t) => {
  await t.test("collection cannot outlive the retention lattice", async () => {
    const { harness, store, work } = await initialized();
    const claim = await store.claimRecallReferencePage(work);
    harness.advance(
      SOURCE_RECALL_REFERENCE_MAX_COLLECTION_AGE_MS + 1,
    );
    const result = await store.checkpointRecallReferencePage(
      claim,
      page({ references: [reference()] }),
    );
    assert.equal(result.aggregate.status, "invalidated");
    assert.equal(harness.pages.size, 0);
    assert.equal(harness.heads.size, 0);
  });

  await t.test("checkpoint aggregate requires exact keys and relations", async () => {
    const { store, work } = await initialized();
    const dependencies = Object.freeze({
      claimRecallReferencePageImpl:
        store.claimRecallReferencePage,
      checkpointRecallReferencePageImpl: async () => ({
        snapshot: {},
        aggregate: {
          ...aggregate({
            status: "sealed_unpinnable",
            completedPasses: 1,
            headSealed: true,
          }),
          extra: true,
        },
      }),
      readPrivateRecallSourcePageImpl: async () => page(),
      recordRecallReferencePageFailureImpl:
        store.recordRecallReferencePageFailure,
    });
    await assert.rejects(
      () => collectRecallReferenceHeadStep(work, dependencies),
      (error) => expectCollectorCode(
        error,
        "SOURCE_RECALL_REFERENCE_CHECKPOINT_REJECTED",
      ),
    );
  });

  await t.test("failed source read requires exact invalidated settlement", async () => {
    const { store, work } = await initialized();
    const dependencies = Object.freeze({
      claimRecallReferencePageImpl:
        store.claimRecallReferencePage,
      checkpointRecallReferencePageImpl:
        store.checkpointRecallReferencePage,
      readPrivateRecallSourcePageImpl: async () => {
        throw new Error("private body");
      },
      recordRecallReferencePageFailureImpl: async () => ({
        snapshot: {},
        aggregate: aggregate({
          status: "collecting",
        }),
      }),
    });
    await assert.rejects(
      () => collectRecallReferenceHeadStep(work, dependencies),
      (error) => expectCollectorCode(
        error,
        "SOURCE_RECALL_REFERENCE_FAILURE_CHECKPOINT_FAILED",
        ["private body"],
      ),
    );
  });
});

test("interfaces and imports remain hard-dark with no inferred point authority or caller-selected page read", async () => {
  assert.throws(
    () => createSourceRecallReferencePersistenceProtocol(),
    (error) => expectStoreCode(
      error,
      "SOURCE_RECALL_REFERENCE_PERSISTENCE_INVALID",
    ),
  );
  assert.throws(
    () => createSourceRecallReferencePersistenceProtocol({
      persistence: {},
    }),
    (error) => expectStoreCode(
      error,
      "SOURCE_RECALL_REFERENCE_PERSISTENCE_INVALID",
    ),
  );
  assert.throws(
    () => createRecallReferenceHeadCollector(),
    (error) => expectCollectorCode(
      error,
      "SOURCE_RECALL_REFERENCE_PROTOCOL_INTERFACE_INVALID",
    ),
  );
  const { store: protocol } = await initialized();
  assert.equal(
    typeof createRecallReferenceHeadCollector({
      protocol,
    }).collectStep,
    "function",
  );
  assert.throws(
    () => createRecallReferenceHeadCollector({
      protocol: { ...protocol, extra: () => {} },
    }),
    (error) => expectCollectorCode(
      error,
      "SOURCE_RECALL_REFERENCE_PROTOCOL_INTERFACE_INVALID",
    ),
  );
  const {
    readRecallReferenceHead: _missing,
    ...missingMethod
  } = protocol;
  assert.throws(
    () => createRecallReferenceHeadCollector({
      protocol: missingMethod,
    }),
    (error) => expectCollectorCode(
      error,
      "SOURCE_RECALL_REFERENCE_PROTOCOL_INTERFACE_INVALID",
    ),
  );

  const work = Object.freeze({ workKeyDigest: DIGEST_A });
  const dependencies = Object.freeze({
    claimRecallReferencePageImpl: async () =>
      Object.freeze({
        status: "page_required",
        workKeyDigest: DIGEST_A,
        claimNonceDigest: DIGEST_B,
        cursor: null,
        pageNumber: 1,
        passNumber: 1,
        requestDigest: "c".repeat(64),
        boundaryAt: BOUNDARY,
        seenCursors: Object.freeze(new Array(1)),
      }),
    checkpointRecallReferencePageImpl: async () => ({}),
    readPrivateRecallSourcePageImpl: async () => page(),
    recordRecallReferencePageFailureImpl: async () => ({}),
  });
  await assert.rejects(
    () => collectRecallReferenceHeadStep(work, dependencies),
    (error) => expectCollectorCode(
      error,
      "SOURCE_RECALL_REFERENCE_CLAIM_INVALID",
    ),
  );

  const modulePaths = [
    "../api/paraai/_lib/source-recall-page-client.mjs",
    "../api/paraai/_lib/source-recall-reference-persistence-protocol.mjs",
    "../api/paraai/_lib/source-recall-reference-collector.mjs",
  ];
  const sources = await Promise.all(modulePaths.map(
    (path) => readFile(new URL(path, import.meta.url), "utf8"),
  ));
  const joined = sources.join("\n");
  for (const forbidden of [
    "source-capture-coordinator",
    "source-recall-point-collector",
    "recallSourcePointEvidence",
    "fetchCall",
    "curation",
    "enrollment",
  ]) {
    assert.equal(joined.includes(forbidden), false);
  }
  const storeSource = sources[1];
  assert.equal(storeSource.includes("process.env"), false);
  assert.equal(storeSource.includes("fetch("), false);
  assert.equal(
    storeSource.includes("readRecallReferencePage"),
    false,
  );
});
