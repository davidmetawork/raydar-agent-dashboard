import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  SOURCE_PARAFORM_HUMAN_CAPTURE_ADAPTER_VERSION,
  SOURCE_PARAFORM_HUMAN_INDEPENDENT_HEAD_VERSION,
  SourceParaformHumanCaptureAdapterError,
  createSourceParaformHumanCaptureAdapter,
} from "../api/paraai/_lib/source-paraform-human-capture-adapter.mjs";
import {
  assertPrivateParaformHumanSourcePageResult,
  readPrivateParaformHumanSourcePage,
} from "../api/paraai/_lib/source-paraform-human-page-client.mjs";

const BOUNDARY = "2026-07-26T03:00:00.000Z";
const BOUNDARY_MS = Date.parse(BOUNDARY);
const CLAIM = "1".repeat(64);
const PAGE_SECRET =
  "synthetic-capture-adapter-page-secret".padEnd(48, "s");
const HEAD = Object.freeze({
  version: SOURCE_PARAFORM_HUMAN_INDEPENDENT_HEAD_VERSION,
  source: "paraform_human",
  boundaryAt: BOUNDARY,
  sourceHeadEpochDigest: "2".repeat(64),
  sourceHeadRevisionDigest: "3".repeat(64),
  sourceHeadRecordDigest: "4".repeat(64),
});
const PRIVATE_MARKER = "private-candidate-marker";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
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

function reference(index = 1) {
  return {
    id: `private-call-${index}`,
    scheduledAt: "2026-07-25T02:00:00.000Z",
    createdAt: "2026-07-24T02:00:00.000Z",
    title: PRIVATE_MARKER,
    platform: "PHONE",
    recordingProvider: "TWILIO",
    owner: "Private Recruiter",
    ownerId: "private-owner",
    candidateUserId: `private-candidate-user-${index}`,
    hasTranscript: true,
    humanCall: true,
    candidate: {
      name: "Private Candidate",
      linkedin: "private-candidate",
      emails: ["private.candidate@example.invalid"],
    },
  };
}

function page({
  cursor = 0,
  scanned = 2,
  exhausted = false,
  references = [reference(1), reference(2)],
} = {}) {
  return Object.freeze({
    version: "paraai-paraform-human-source-page-v2",
    boundaryAt: BOUNDARY,
    exhausted,
    nextCheckpoint: exhausted
      ? null
      : Object.freeze({
          version: "paraai-paraform-human-source-page-v2",
          boundaryAt: BOUNDARY,
          cursor: cursor + scanned,
        }),
    scanned,
    outsideBoundary: scanned - references.length,
    references: Object.freeze(references),
  });
}

function claim({
  status = "capturing",
  passNumber = 1,
  pageNumber = 1,
  cursorToken = null,
  headVerificationIndex = 1,
  source = "paraform_human",
  extra,
} = {}) {
  const record = {
    decisionBoundaryAtMs: BOUNDARY_MS,
    status,
    activeStep: status === "capturing"
      ? {
          source,
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
    claimNonceDigest: CLAIM,
    raw: JSON.stringify(record),
    record,
    ...(extra ? { [extra]: null } : {}),
  };
}

function clients({
  pages = [page()],
  heads = [HEAD, HEAD],
  pageError = null,
  headError = null,
  trustPages = true,
  trustHeads = true,
} = {}) {
  const calls = [];
  const issuedPages = new WeakSet();
  const issuedHeads = new WeakSet();
  let pageIndex = 0;
  let headIndex = 0;
  return {
    calls,
    pageClient: {
      async readPage(input) {
        calls.push({ method: "page", input });
        if (pageError) throw pageError;
        const selected = pages[
          Math.min(pageIndex, pages.length - 1)
        ];
        pageIndex += 1;
        issuedPages.add(selected);
        return selected;
      },
      assertPageResult(value, input) {
        calls.push({ method: "assertPage", value, input });
        if (!trustPages || !issuedPages.has(value)) {
          throw new Error(`${PRIVATE_MARKER} page`);
        }
        return value;
      },
    },
    sourceHeadClient: {
      async readHead(input) {
        calls.push({ method: "head", input });
        if (headError) throw headError;
        const selected = heads[
          Math.min(headIndex, heads.length - 1)
        ];
        headIndex += 1;
        issuedHeads.add(selected);
        return selected;
      },
      assertHeadResult(value, input) {
        calls.push({ method: "assertHead", value, input });
        if (!trustHeads || !issuedHeads.has(value)) {
          throw new Error(`${PRIVATE_MARKER} head`);
        }
        return value;
      },
    },
  };
}

function adapter(options = {}) {
  const selected = clients(options);
  return {
    ...selected,
    value: createSourceParaformHumanCaptureAdapter({
      pageClient: selected.pageClient,
      sourceHeadClient: selected.sourceHeadClient,
    }),
  };
}

async function expectCode(operation, code) {
  await assert.rejects(
    operation,
    (error) => (
      error instanceof SourceParaformHumanCaptureAdapterError
      && error.name
        === "SourceParaformHumanCaptureAdapterError"
      && error.code === code
      && error.message === code
      && !error.message.includes(PRIVATE_MARKER)
    ),
  );
}

test("sandwiches one exact process-issued page with an independent head", async () => {
  const fixture = adapter();
  const result = await fixture.value.readPage(claim());
  assert.equal(
    SOURCE_PARAFORM_HUMAN_CAPTURE_ADAPTER_VERSION,
    "paraform-human-capture-adapter-v1",
  );
  assert.deepEqual(
    fixture.calls.map((entry) => entry.method),
    ["head", "assertHead", "page", "assertPage", "head", "assertHead"],
  );
  assert.deepEqual(fixture.calls[0].input, {
    boundaryAt: BOUNDARY,
  });
  assert.deepEqual(fixture.calls[2].input, {
    boundaryAt: BOUNDARY,
    checkpoint: null,
  });
  assert.deepEqual(result, {
    checkpointEvent: {
      kind: "page_checkpoint",
      claimNonceDigest: CLAIM,
      source: "paraform_human",
      passNumber: 1,
      pageNumber: 1,
      cursorToken: null,
      nextCursorToken: "2",
      pageSemanticDigest: semanticDigest(
        "phase4-source-paraform-human-page-semantic-v1",
        page(),
      ),
      recordCount: 2,
      sourceHeadEpochDigest: HEAD.sourceHeadEpochDigest,
      sourceHeadRevisionDigest:
        HEAD.sourceHeadRevisionDigest,
      sourceHeadRecordDigest:
        HEAD.sourceHeadRecordDigest,
    },
  });
  assert.equal(
    JSON.stringify(result).includes(PRIVATE_MARKER),
    false,
  );
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.checkpointEvent), true);
});

test("composes with the reviewed private page-client provenance boundary", async () => {
  const sourceHeads = clients();
  const value = createSourceParaformHumanCaptureAdapter({
    pageClient: {
      async readPage(input) {
        return readPrivateParaformHumanSourcePage(input, {
          fetchImpl: async () => new Response(
            JSON.stringify(page()),
            {
              status: 200,
              headers: {
                "content-type": "application/json",
              },
            },
          ),
          nowImpl: () => BOUNDARY_MS + 1_000,
          secret: PAGE_SECRET,
          signalFactory: () =>
            Object.freeze({ syntheticSignal: true }),
        });
      },
      assertPageResult:
        assertPrivateParaformHumanSourcePageResult,
    },
    sourceHeadClient: sourceHeads.sourceHeadClient,
  });
  const result = await value.readPage(claim());
  assert.equal(result.checkpointEvent.recordCount, 2);
  assert.equal(
    result.checkpointEvent.sourceHeadRecordDigest,
    HEAD.sourceHeadRecordDigest,
  );
});

test("translates only the server-owned decimal cursor", async () => {
  const finalPage = page({
    cursor: 50,
    scanned: 1,
    exhausted: true,
    references: [reference(3)],
  });
  const fixture = adapter({ pages: [finalPage] });
  const result = await fixture.value.readPage(claim({
    passNumber: 2,
    pageNumber: 2,
    cursorToken: "50",
  }));
  assert.deepEqual(fixture.calls[2].input, {
    boundaryAt: BOUNDARY,
    checkpoint: {
      version: "paraai-paraform-human-source-page-v2",
      boundaryAt: BOUNDARY,
      cursor: 50,
    },
  });
  assert.equal(
    result.checkpointEvent.nextCursorToken,
    null,
  );
  assert.equal(result.checkpointEvent.recordCount, 1);
});

test("rejects a head change across the page read", async () => {
  const changed = Object.freeze({
    ...HEAD,
    sourceHeadRevisionDigest: "5".repeat(64),
  });
  const fixture = adapter({ heads: [HEAD, changed] });
  await expectCode(
    () => fixture.value.readPage(claim()),
    "SOURCE_PARAFORM_HUMAN_CAPTURE_HEAD_CHANGED_DURING_PAGE",
  );
  assert.equal(
    fixture.calls.filter((entry) => entry.method === "page").length,
    1,
  );
});

test("requires process-local page and head provenance", async (t) => {
  await t.test("page", async () => {
    const fixture = adapter({ trustPages: false });
    await expectCode(
      () => fixture.value.readPage(claim()),
      "SOURCE_PARAFORM_HUMAN_CAPTURE_PAGE_UNTRUSTED",
    );
  });
  await t.test("head", async () => {
    const fixture = adapter({ trustHeads: false });
    await expectCode(
      () => fixture.value.readPage(claim()),
      "SOURCE_PARAFORM_HUMAN_CAPTURE_HEAD_UNTRUSTED",
    );
    assert.equal(
      fixture.calls.some((entry) => entry.method === "page"),
      false,
    );
  });
});

test("emits a head checkpoint only for the selected verification source", async () => {
  const fixture = adapter();
  const result = await fixture.value.readHead(claim({
    status: "verifying_heads",
  }));
  assert.deepEqual(
    fixture.calls.map((entry) => entry.method),
    ["head", "assertHead"],
  );
  assert.deepEqual(result, {
    checkpointEvent: {
      kind: "head_checkpoint",
      claimNonceDigest: CLAIM,
      source: "paraform_human",
      sourceHeadEpochDigest: HEAD.sourceHeadEpochDigest,
      sourceHeadRevisionDigest:
        HEAD.sourceHeadRevisionDigest,
      sourceHeadRecordDigest:
        HEAD.sourceHeadRecordDigest,
    },
  });

  const wrong = adapter();
  await expectCode(
    () => wrong.value.readHead(claim({
      status: "verifying_heads",
      headVerificationIndex: 2,
    })),
    "SOURCE_PARAFORM_HUMAN_CAPTURE_HEAD_NOT_EXPECTED",
  );
  assert.equal(wrong.calls.length, 0);
});

test("hostile claims and cursor substitution fail before source reads", async (t) => {
  const cases = [
    [null, "SOURCE_PARAFORM_HUMAN_CAPTURE_CLAIM_INVALID"],
    [new Proxy(claim(), {}), "SOURCE_PARAFORM_HUMAN_CAPTURE_CLAIM_INVALID"],
    [claim({ extra: "force" }), "SOURCE_PARAFORM_HUMAN_CAPTURE_CLAIM_INVALID"],
    [claim({ source: "recall" }), "SOURCE_PARAFORM_HUMAN_CAPTURE_PAGE_NOT_EXPECTED"],
    [claim({ passNumber: 3 }), "SOURCE_PARAFORM_HUMAN_CAPTURE_PAGE_NOT_EXPECTED"],
    [claim({ pageNumber: 1, cursorToken: "50" }), "SOURCE_PARAFORM_HUMAN_CAPTURE_CURSOR_INVALID"],
    [claim({ pageNumber: 2, cursorToken: null }), "SOURCE_PARAFORM_HUMAN_CAPTURE_CURSOR_INVALID"],
    [claim({ pageNumber: 2, cursorToken: "050" }), "SOURCE_PARAFORM_HUMAN_CAPTURE_CURSOR_INVALID"],
    [claim({ pageNumber: 2, cursorToken: sha256("opaque") }), "SOURCE_PARAFORM_HUMAN_CAPTURE_CURSOR_INVALID"],
  ];
  for (const [index, [input, code]] of cases.entries()) {
    await t.test(`case ${index + 1}`, async () => {
      const fixture = adapter();
      await expectCode(() => fixture.value.readPage(input), code);
      assert.equal(fixture.calls.length, 0);
    });
  }
});

test("malformed or substituted source output fails closed", async (t) => {
  const badPages = [
    Object.freeze({ ...page(), debug: true }),
    Object.freeze({ ...page(), boundaryAt:
      "2026-07-26T03:00:00.001Z" }),
    Object.freeze({
      ...page(),
      nextCheckpoint: Object.freeze({
        version: "paraai-paraform-human-source-page-v2",
        boundaryAt: BOUNDARY,
        cursor: 3,
      }),
    }),
  ];
  for (const [index, value] of badPages.entries()) {
    await t.test(`page ${index + 1}`, async () => {
      const fixture = adapter({ pages: [value] });
      await expectCode(
        () => fixture.value.readPage(claim()),
        "SOURCE_PARAFORM_HUMAN_CAPTURE_PAGE_INVALID",
      );
    });
  }

  const badHeads = [
    Object.freeze({ ...HEAD, debug: true }),
    Object.freeze({ ...HEAD, source: "recall" }),
    Object.freeze({
      ...HEAD,
      sourceHeadRecordDigest: "invalid",
    }),
  ];
  for (const [index, value] of badHeads.entries()) {
    await t.test(`head ${index + 1}`, async () => {
      const fixture = adapter({ heads: [value] });
      await expectCode(
        () => fixture.value.readPage(claim()),
        "SOURCE_PARAFORM_HUMAN_CAPTURE_HEAD_INVALID",
      );
      assert.equal(
        fixture.calls.some((entry) => entry.method === "page"),
        false,
      );
    });
  }
});

test("client failures collapse without leaking source detail", async (t) => {
  await t.test("page read", async () => {
    const fixture = adapter({
      pageError: new Error(`${PRIVATE_MARKER} page transport`),
    });
    await expectCode(
      () => fixture.value.readPage(claim()),
      "SOURCE_PARAFORM_HUMAN_CAPTURE_PAGE_READ_FAILED",
    );
  });
  await t.test("head read", async () => {
    const fixture = adapter({
      headError: new Error(`${PRIVATE_MARKER} head transport`),
    });
    await expectCode(
      () => fixture.value.readPage(claim()),
      "SOURCE_PARAFORM_HUMAN_CAPTURE_HEAD_READ_FAILED",
    );
  });
});

test("module remains hard-dark with the independent head client absent", async () => {
  const runtimePath = new URL(
    "../api/paraai/_lib/source-paraform-human-capture-adapter.mjs",
    import.meta.url,
  );
  const workerPath = new URL(
    "../api/paraai/worker.mjs",
    import.meta.url,
  );
  const coordinatorPath = new URL(
    "../api/paraai/_lib/source-capture-coordinator.mjs",
    import.meta.url,
  );
  const [runtime, worker, coordinator] = await Promise.all([
    readFile(runtimePath, "utf8"),
    readFile(workerPath, "utf8"),
    readFile(coordinatorPath, "utf8"),
  ]);
  const filename =
    "source-paraform-human-capture-adapter.mjs";
  for (const forbidden of [
    "process.env",
    "fetch(",
    "source-watermark",
    "source-capture-store",
    "source-paraform-human-page-client",
    "writeAuthorityAvailable: true",
    "pinnable: true",
  ]) {
    assert.equal(runtime.includes(forbidden), false);
  }
  assert.equal(worker.includes(filename), false);
  assert.equal(coordinator.includes(filename), false);
  assert.equal(
    coordinator.includes("paraformHumanPageClient: null"),
    true,
  );
  assert.equal(
    coordinator.includes("sourceHeadClient: null"),
    true,
  );
});
