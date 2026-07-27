import assert from "node:assert/strict";
import {
  readdir,
  readFile,
} from "node:fs/promises";
import test from "node:test";

import {
  SOURCE_RECALL_POINT_OBSERVATION_MANIFEST_RUNTIME_VERSION,
  SourceRecallPointObservationManifestRuntimeError,
  collectRecallPointObservationManifestStep,
} from "../api/paraai/_lib/source-recall-point-observation-manifest-runtime.mjs";

function digest(character) {
  return character.repeat(64);
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

function aggregate(overrides = {}) {
  return deepFreeze({
    status: "indexing_pages",
    pageCount: 2,
    pagesIndexed: 1,
    referenceCount: 3,
    referencesIndexed: 2,
    referencesSettled: 0,
    referencesStable: 0,
    referencesConflict: 0,
    referencesUnresolved: 0,
    settledReadsCompleted: 0,
    inProgress: false,
    referenceManifestCoverageComplete: false,
    operational: false,
    globalReferenceSetCoverageAvailable: false,
    sourceFactsAvailable: false,
    successClassificationAvailable: false,
    candidateIdentityResolutionAvailable: false,
    pinnable: false,
    authorityAvailable: false,
    ...overrides,
  });
}

function manifestSnapshot() {
  return deepFreeze({
    raw: "private",
    rawSha1: "a".repeat(40),
    record: {
      manifestKeyDigest: digest("b"),
      operational: false,
      sourceFactsAvailable: false,
      successClassificationAvailable: false,
      candidateIdentityResolutionAvailable: false,
      pinnable: false,
      authorityAvailable: false,
    },
    redisNowMs: 1,
  });
}

function baseDependencies(events, claimValue) {
  const head = deepFreeze({ private: "head" });
  const page = deepFreeze({ private: "page" });
  return Object.freeze({
    async readRecallReferenceHeadImpl(work) {
      events.push({ step: "head", value: work });
      assert.deepEqual(work, {
        workKeyDigest: digest("c"),
      });
      return head;
    },
    async ensureManifestImpl(value) {
      events.push({ step: "ensure", value });
      assert.equal(value, head);
      return manifestSnapshot();
    },
    async claimManifestStepImpl(work) {
      events.push({ step: "claim", value: work });
      assert.deepEqual(work, {
        manifestKeyDigest: digest("b"),
      });
      return claimValue;
    },
    async readRecallReferencePageImpl(input) {
      events.push({ step: "page", value: input });
      return page;
    },
    async checkpointManifestPageImpl(claim, value) {
      events.push({ step: "page_checkpoint", claim, value });
      assert.equal(claim, claimValue);
      assert.equal(value, page);
      return aggregate();
    },
    async prepareManifestSelectionImpl(claim, value) {
      events.push({ step: "prepare", claim, value });
      assert.equal(claim, claimValue);
      assert.equal(value, page);
      return deepFreeze({ workKeyDigest: digest("d") });
    },
    async collectPointTwoReadImpl(work) {
      events.push({ step: "collect", value: work });
    },
    async checkpointManifestWorkImpl(claim) {
      events.push({ step: "work_checkpoint", claim });
      assert.equal(arguments.length, 1);
      assert.equal(claim, claimValue);
      return aggregate({
        status: "observed_complete_dark",
        pagesIndexed: 2,
        referencesIndexed: 3,
        referencesSettled: 3,
        referencesStable: 3,
        settledReadsCompleted: 6,
        referenceManifestCoverageComplete: true,
        globalReferenceSetCoverageAvailable: true,
      });
    },
  });
}

function expectCode(code) {
  return (error) => {
    assert.equal(
      error
        instanceof SourceRecallPointObservationManifestRuntimeError,
      true,
    );
    assert.equal(error.code, code);
    assert.equal(error.message, code);
    return true;
  };
}

test("one runtime step indexes only the store-selected page", async () => {
  const events = [];
  const privateClaim = deepFreeze({
    status: "page_required",
    pageNumber: 2,
    referenceOrdinal: null,
    workKeyDigest: null,
  });
  const result = await collectRecallPointObservationManifestStep(
    deepFreeze({ workKeyDigest: digest("c") }),
    baseDependencies(events, privateClaim),
  );
  assert.equal(
    SOURCE_RECALL_POINT_OBSERVATION_MANIFEST_RUNTIME_VERSION,
    "recall-point-observation-manifest-runtime-dark-v1",
  );
  assert.deepEqual(
    events.map(({ step }) => step),
    [
      "head",
      "ensure",
      "claim",
      "page",
      "page_checkpoint",
    ],
  );
  assert.deepEqual(
    events.find(({ step }) => step === "page").value,
    {
      pageNumber: 2,
      workKeyDigest: digest("c"),
    },
  );
  assert.deepEqual(result, aggregate());
});

test("one runtime step observes only one selected work and checkpoints terminal failure", async () => {
  const events = [];
  const privateClaim = deepFreeze({
    status: "observation_required",
    pageNumber: 1,
    referenceOrdinal: 1,
    workKeyDigest: digest("d"),
  });
  const base = baseDependencies(events, privateClaim);
  const dependencies = Object.freeze({
    ...base,
    async collectPointTwoReadImpl(work) {
      events.push({ step: "collect", value: work });
      throw new Error("redacted terminal conflict");
    },
  });
  const result = await collectRecallPointObservationManifestStep(
    deepFreeze({ workKeyDigest: digest("c") }),
    dependencies,
  );
  assert.deepEqual(
    events.map(({ step }) => step),
    [
      "head",
      "ensure",
      "claim",
      "page",
      "prepare",
      "collect",
      "work_checkpoint",
    ],
  );
  assert.equal(result.status, "observed_complete_dark");
  assert.equal(
    result.globalReferenceSetCoverageAvailable,
    true,
  );
  assert.doesNotMatch(
    JSON.stringify(result),
    /private|terminal conflict|[a-f0-9]{64}/u,
  );
});

test("complete and in-progress claims perform no private page or point work", async () => {
  for (const status of ["complete", "in_progress"]) {
    const events = [];
    const expected = aggregate({
      inProgress: status === "in_progress",
    });
    const claimValue = deepFreeze({
      aggregate: expected,
      status,
    });
    const result =
      await collectRecallPointObservationManifestStep(
        deepFreeze({ workKeyDigest: digest("c") }),
        baseDependencies(events, claimValue),
      );
    assert.deepEqual(result, expected);
    assert.deepEqual(
      events.map(({ step }) => step),
      ["head", "ensure", "claim"],
    );
  }
});

test("the runtime dependency surface rejects the removed point-work reader", async () => {
  const events = [];
  const privateClaim = deepFreeze({
    status: "observation_required",
    pageNumber: 1,
    referenceOrdinal: 0,
    workKeyDigest: digest("d"),
  });
  const legacyDependencies = Object.freeze({
    ...baseDependencies(events, privateClaim),
    async readPointWorkImpl() {},
  });
  await assert.rejects(
    collectRecallPointObservationManifestStep(
      deepFreeze({ workKeyDigest: digest("c") }),
      legacyDependencies,
    ),
    expectCode(
      "SOURCE_RECALL_POINT_OBSERVATION_MANIFEST_RUNTIME_TEST_DEPENDENCIES_INVALID",
    ),
  );
  assert.deepEqual(events, []);
});

test("caller selectors fail before dependencies", async () => {
  for (const input of [
    { workKeyDigest: digest("c") },
    deepFreeze({
      workKeyDigest: digest("c"),
      pageNumber: 1,
    }),
    deepFreeze({
      workKeyDigest: digest("c"),
      referenceOrdinal: 0,
    }),
    deepFreeze({
      workKeyDigest: digest("c"),
      cursor: "private",
    }),
    deepFreeze({
      workKeyDigest: digest("c"),
      limit: 10,
    }),
    deepFreeze({
      workKeyDigest: digest("c"),
      force: true,
    }),
  ]) {
    const events = [];
    const privateClaim = deepFreeze({
      status: "page_required",
      pageNumber: 1,
      referenceOrdinal: null,
      workKeyDigest: null,
    });
    await assert.rejects(
      collectRecallPointObservationManifestStep(
        input,
        baseDependencies(events, privateClaim),
      ),
      expectCode(
        "SOURCE_RECALL_POINT_OBSERVATION_MANIFEST_RUNTIME_WORK_INVALID",
      ),
    );
    assert.deepEqual(events, []);
  }
});

test("the full-manifest composition has zero production importers", async () => {
  const libraryUrl = new URL(
    "../api/paraai/_lib/",
    import.meta.url,
  );
  const files = await readdir(libraryUrl);
  const productionFiles = [
    new URL("../api/paraai/worker.mjs", import.meta.url),
    new URL(
      "../api/paraai/health.mjs",
      import.meta.url,
    ),
    new URL(
      "../api/paraai/_lib/source-capture-coordinator.mjs",
      import.meta.url,
    ),
    ...files
      .filter(
        (file) => (
          file.endsWith(".mjs")
          && ![
            "source-recall-point-observation-manifest-runtime.mjs",
            "source-recall-point-observation-manifest-store.mjs",
          ].includes(file)
        ),
      )
      .map((file) => new URL(file, libraryUrl)),
  ];
  for (const url of productionFiles) {
    const source = await readFile(url, "utf8");
    assert.doesNotMatch(
      source,
      /source-recall-point-observation-manifest-runtime/u,
    );
  }
  const runtimeSource = await readFile(
    new URL(
      "../api/paraai/_lib/source-recall-point-observation-manifest-runtime.mjs",
      import.meta.url,
    ),
    "utf8",
  );
  for (const forbidden of [
    "source-authority-store",
    "source-watermark",
    "phase4-curation",
    "enrollment",
  ]) {
    assert.doesNotMatch(runtimeSource, new RegExp(forbidden, "u"));
  }
  assert.doesNotMatch(runtimeSource, /\bconsole\./u);
});
