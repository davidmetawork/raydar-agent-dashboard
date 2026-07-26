import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  SOURCE_RECALL_POINT_OBSERVATION_RUNTIME_VERSION,
  SourceRecallPointObservationRuntimeError,
  collectFirstRecallPointObservation,
} from "../api/paraai/_lib/source-recall-point-observation-runtime.mjs";

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

function dependencies(events) {
  const verifiedPage = deepFreeze({ private: "verified" });
  const prepared = deepFreeze({
    raw: "private",
    rawSha1: "a".repeat(40),
    redisNowMs: 1,
    record: {
      workKeyDigest: digest("b"),
      operational: false,
      globalReferenceSetCoverageAvailable: false,
      sourceFactsAvailable: false,
      successClassificationAvailable: false,
      candidateIdentityResolutionAvailable: false,
      pinnable: false,
      authorityAvailable: false,
    },
  });
  return Object.freeze({
    async readRecallReferencePageImpl(input) {
      events.push({ step: "reference", input });
      assert.deepEqual(input, {
        workKeyDigest: digest("c"),
        pageNumber: 1,
      });
      assert.equal(Object.isFrozen(input), true);
      return verifiedPage;
    },
    async prepareRecallPointObservationWorkImpl(input) {
      events.push({ step: "prepare", input });
      assert.equal(input, verifiedPage);
      return prepared;
    },
    async collectRecallSourcePointTwoReadImpl(input) {
      events.push({ step: "collect", input });
      assert.deepEqual(input, {
        workKeyDigest: digest("b"),
      });
      assert.equal(Object.isFrozen(input), true);
    },
  });
}

function expectCode(code) {
  return (error) => {
    assert.equal(
      error instanceof SourceRecallPointObservationRuntimeError,
      true,
    );
    assert.equal(error.code, code);
    assert.equal(error.message, code);
    return true;
  };
}

test("the runtime selects page one, delegates reference selection, and exposes nothing", async () => {
  const events = [];
  const result = await collectFirstRecallPointObservation(
    Object.freeze({ workKeyDigest: digest("c") }),
    dependencies(events),
  );
  assert.equal(result, undefined);
  assert.equal(
    SOURCE_RECALL_POINT_OBSERVATION_RUNTIME_VERSION,
    "recall-point-observation-runtime-dark-v1",
  );
  assert.deepEqual(
    events.map(({ step }) => step),
    ["reference", "prepare", "collect"],
  );
});

test("caller page, reference, bot, ordinal, and force controls fail before dependencies", async () => {
  for (const input of [
    { workKeyDigest: digest("c") },
    Object.freeze({
      workKeyDigest: digest("c"),
      pageNumber: 1,
    }),
    Object.freeze({
      workKeyDigest: digest("c"),
      referenceIndex: 0,
    }),
    Object.freeze({
      workKeyDigest: digest("c"),
      botId: "private",
    }),
    Object.freeze({
      workKeyDigest: digest("c"),
      readNumber: 1,
    }),
    Object.freeze({
      workKeyDigest: digest("c"),
      force: true,
    }),
  ]) {
    const events = [];
    await assert.rejects(
      collectFirstRecallPointObservation(
        input,
        dependencies(events),
      ),
      expectCode(
        "SOURCE_RECALL_POINT_OBSERVATION_RUNTIME_WORK_INVALID",
      ),
    );
    assert.equal(events.length, 0);
  }
});

test("private failures collapse to stable runtime codes", async () => {
  const events = [];
  const base = dependencies(events);
  await assert.rejects(
    collectFirstRecallPointObservation(
      Object.freeze({ workKeyDigest: digest("c") }),
      Object.freeze({
        ...base,
        readRecallReferencePageImpl: async () => {
          throw new Error("private page body");
        },
      }),
    ),
    expectCode(
      "SOURCE_RECALL_POINT_OBSERVATION_RUNTIME_REFERENCE_READ_FAILED",
    ),
  );
});

test("the composition is absent from production routes, workers, gates, and health", async () => {
  const [source, worker, coordinator, health] =
    await Promise.all([
      readFile(
        new URL(
          "../api/paraai/_lib/source-recall-point-observation-runtime.mjs",
          import.meta.url,
        ),
        "utf8",
      ),
      readFile(
        new URL(
          "../api/paraai/worker.mjs",
          import.meta.url,
        ),
        "utf8",
      ),
      readFile(
        new URL(
          "../api/paraai/_lib/source-capture-coordinator.mjs",
          import.meta.url,
        ),
        "utf8",
      ),
      readFile(
        new URL(
          "../api/paraai/health.mjs",
          import.meta.url,
        ),
        "utf8",
      ),
    ]);
  assert.doesNotMatch(source, /\bconsole\./u);
  assert.doesNotMatch(source, /source-authority-store/u);
  assert.doesNotMatch(source, /phase4-curation/u);
  for (const importer of [worker, coordinator, health]) {
    assert.doesNotMatch(
      importer,
      /source-recall-point-observation-runtime/u,
    );
  }
});
