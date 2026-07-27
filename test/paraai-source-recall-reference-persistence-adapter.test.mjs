import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  readdir,
  readFile,
} from "node:fs/promises";
import test from "node:test";

import {
  SOURCE_RECALL_REFERENCE_ATOMIC_PROOF_MAX_BYTES,
  SOURCE_RECALL_REFERENCE_ATOMIC_SCRIPT_BUDGET_MS,
  SOURCE_RECALL_REFERENCE_PERSISTENCE_ADAPTER_VERSION,
  SOURCE_RECALL_REFERENCE_REQUEST_MAX_BYTES,
  SourceRecallReferencePersistenceAdapterError,
  createSourceRecallReferencePersistenceAdapter,
  sourceRecallReferencePersistenceAdapterConfigured,
} from "../api/paraai/_lib/source-recall-reference-persistence-adapter.mjs";

const REDIS_NOW_MS = Date.parse("2026-07-27T00:00:00.000Z");
const PRIVATE_PAGE_TTL_MS = 24 * 60 * 60 * 1_000;
const RUN_NONCE_DIGEST = "1".repeat(64);
const CONTRACT_PINS_DIGEST = "2".repeat(64);
const DECISION_BOUNDARY_AT_MS =
  Date.parse("2026-07-26T00:00:00.000Z");
const WORK_DIGEST = semanticDigest(
  "phase4-recall-reference-run-key-v1",
  {
    contractPinsDigest: CONTRACT_PINS_DIGEST,
    decisionBoundaryAtMs: DECISION_BOUNDARY_AT_MS,
    policyVersion: "recall-reference-head-dark-v1",
    runNonceDigest: RUN_NONCE_DIGEST,
  },
);
const RUN_KEY =
  `paraai:phase4:recall-reference:run:v1:${WORK_DIGEST}`;
const PAGE_KEY =
  `paraai:phase4:recall-reference:page:v1:${WORK_DIGEST}:2:1`;
const OTHER_PAGE_KEY =
  `paraai:phase4:recall-reference:page:v1:${WORK_DIGEST}:2:2`;
const HEAD_KEY =
  `paraai:phase4:recall-reference:head:v1:${WORK_DIGEST}`;

const MARKERS = Object.freeze({
  beginStage: "recall_reference_begin_stage_v2",
  ensure: "recall_reference_ensure_v1",
  readStage: "recall_reference_read_stage_v2",
  readOne: "recall_reference_read_one_v1",
  readPage: "recall_reference_read_page_v1",
  cas: "recall_reference_final_cas_v2",
  verify: "recall_reference_verify_metadata_set_v2",
  writeStage: "recall_reference_write_stage_v2",
});

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

function sha256(value) {
  return createHash("sha256")
    .update(value, "utf8")
    .digest("hex");
}

function sha1(value) {
  return createHash("sha1")
    .update(value, "utf8")
    .digest("hex");
}

function pageEnvelope(raw) {
  return (
    `RRPG1|${sha256(raw)}|`
    + `${Buffer.byteLength(raw, "utf8")
      .toString(16).padStart(8, "0")}|${raw}`
  );
}

function semanticDigest(namespace, value) {
  return createHash("sha256")
    .update(namespace)
    .update("\0")
    .update(canonicalJson(value))
    .digest("hex");
}

function keyDigest(key) {
  return semanticDigest(
    "phase4-recall-reference-persistence-key-v1",
    key,
  );
}

function pageSetDigest(requiredPageSet) {
  return semanticDigest(
    "phase4-recall-reference-required-page-set-v1",
    requiredPageSet,
  );
}

function artifactRequestDigest({
  expectedHeadRaw,
  expectedRunRaw,
  requiredPageSetDigest,
}) {
  return semanticDigest(
    "phase4-recall-reference-sealed-artifact-set-v1",
    {
      headKeyDigest: keyDigest(HEAD_KEY),
      headRawDigest: sha256(expectedHeadRaw),
      requiredPageSetDigest,
      runKeyDigest: keyDigest(RUN_KEY),
      runRawDigest: sha256(expectedRunRaw),
    },
  );
}

function emptyPass(passNumber) {
  return {
    completedAtMs: null,
    lastJoinAt: null,
    nextCursor: null,
    nextPageNumber: 1,
    pageCount: 0,
    pageManifests: [],
    passNumber,
    referenceCount: 0,
    referenceManifestDigest: null,
    scannedCount: 0,
    seenCursors: [],
    semanticDigest: null,
    startedAtMs: null,
    status: "pending",
  };
}

function runRaw({
  createdAtMs = REDIS_NOW_MS,
  revision = 0,
  updatedAtMs = REDIS_NOW_MS,
} = {}) {
  return canonicalJson({
    activeClaim: null,
    clientVersion: "recall-private-page-client-v1",
    contractPinsDigest: CONTRACT_PINS_DIGEST,
    createdAtMs,
    decisionBoundaryAtMs: DECISION_BOUNDARY_AT_MS,
    headRecordDigest: null,
    invalidReason: null,
    kind: "recall_reference_collection_dark",
    passes: [emptyPass(1), emptyPass(2)],
    pendingValidation: null,
    policyVersion: "recall-reference-head-dark-v1",
    revision,
    runNonceDigest: RUN_NONCE_DIGEST,
    source: "recall",
    status: "collecting",
    updatedAtMs,
    version: 1,
    workKeyDigest: WORK_DIGEST,
  });
}

function redisParts(nowMs) {
  return [
    String(Math.floor(nowMs / 1_000)),
    String((nowMs % 1_000) * 1_000),
  ];
}

function response(result, {
  ok = true,
  status = ok ? 200 : 503,
  body = JSON.stringify({ result }),
} = {}) {
  return new Response(body, {
    status,
    headers: {
      "content-length": String(
        Buffer.byteLength(body, "utf8"),
      ),
      "content-type": "application/json",
    },
  });
}

function fakeUpstash(initialNowMs = REDIS_NOW_MS) {
  const commands = [];
  const records = new Map();
  const handlers = new Map();
  const clock = { nowMs: initialNowMs };

  function current(key) {
    const stored = records.get(key);
    if (
      stored?.expiresAtMs !== null
      && stored?.expiresAtMs <= clock.nowMs
    ) {
      records.delete(key);
      return null;
    }
    return stored ?? null;
  }

  async function fetchImpl(url, options) {
    const command = JSON.parse(options.body);
    commands.push({ command, options, url });
    assert.equal(command[0], "EVAL");
    assert.equal(options.method, "POST");
    assert.equal(
      options.headers.authorization,
      "Bearer unit-test-token",
    );
    const script = command[1];
    const marker = Object.values(MARKERS).find(
      (candidate) => script.includes(candidate),
    );
    assert.ok(marker, "EVAL must contain a stable operation marker");
    const keyCount = Number(command[2]);
    const keys = command.slice(3, 3 + keyCount);
    const args = command.slice(3 + keyCount);
    const override = handlers.get(marker);
    if (override) {
      const overridden = await override({
        args,
        command,
        keys,
        marker,
        nowMs: clock.nowMs,
        records,
        script,
      });
      if (marker === MARKERS.cas) {
        if (
          Array.isArray(overridden)
          && overridden[0] === 1
        ) {
          const staged = records.get(keys[2])?.raw;
          const nextRaw = typeof staged === "string"
            ? staged.slice(args[3].length)
            : null;
          assert.equal(typeof nextRaw, "string");
          records.set(keys[0], {
            expiresAtMs: null,
            raw: nextRaw,
          });
        }
        records.delete(keys[1]);
        records.delete(keys[2]);
        records.delete(keys[3]);
      }
      return overridden?.ok === undefined
        ? response(overridden)
        : overridden;
    }
    const time = redisParts(clock.nowMs);

    if (marker === MARKERS.ensure) {
      const existing = current(keys[0]);
      if (existing) return response([0, existing.raw, ...time]);
      const proposed = JSON.parse(args[0]);
      proposed.createdAtMs = clock.nowMs;
      proposed.updatedAtMs = clock.nowMs;
      const raw = canonicalJson(proposed);
      records.set(keys[0], { raw, expiresAtMs: null });
      return response([1, raw, ...time]);
    }

    if (marker === MARKERS.readOne) {
      return response([
        current(keys[0])?.raw ?? "",
        ...time,
      ]);
    }

    if (marker === MARKERS.readPage) {
      const stored = current(keys[0]);
      if (
        !stored
        || stored.expiresAtMs === null
        || stored.expiresAtMs <= clock.nowMs
      ) {
        records.delete(keys[0]);
        return response(["", "", ...time]);
      }
      return response([
        stored.raw,
        String(stored.expiresAtMs),
        ...time,
      ]);
    }

    if (marker === MARKERS.beginStage) {
      if (current(keys[0])) {
        return response([0, "", "", "", ...time]);
      }
      const notAfterMs = args[2] === ""
        ? null
        : Number(args[2]);
      if (
        notAfterMs !== null
        && clock.nowMs >= notAfterMs
      ) {
        return response([-2, "", "", "", ...time]);
      }
      const fence = Number(current(keys[1])?.raw ?? "0") + 1;
      records.set(keys[1], {
        expiresAtMs: null,
        raw: String(fence),
      });
      const expiresAtMs = Math.min(
        clock.nowMs + Number(args[4]),
        notAfterMs ?? Number.MAX_SAFE_INTEGER,
      );
      const writerRaw = (
        `${args[0]}|${fence}|${args[1]}|${expiresAtMs}`
      );
      records.set(keys[0], { expiresAtMs, raw: writerRaw });
      records.set(keys[2], { expiresAtMs, raw: args[3] });
      return response([
        1,
        String(fence),
        String(expiresAtMs),
        writerRaw,
        ...time,
      ]);
    }

    if (marker === MARKERS.writeStage) {
      const writer = current(keys[0]);
      const expiresAtMs = Number(args[1]);
      if (
        !writer
        || writer.raw !== args[0]
        || writer.expiresAtMs !== expiresAtMs
      ) {
        return response([-2, ...time]);
      }
      const existing = current(keys[1]);
      if (
        existing
        && (
          existing.raw !== args[2]
          || existing.expiresAtMs !== expiresAtMs
        )
      ) {
        return response([-9, ...time]);
      }
      records.set(keys[1], {
        expiresAtMs,
        raw: args[2],
      });
      return response([existing ? 0 : 1, ...time]);
    }

    if (marker === MARKERS.readStage) {
      const writer = current(keys[0]);
      const stage = current(keys[1]);
      const expiresAtMs = Number(args[1]);
      if (
        !writer
        || writer.raw !== args[0]
        || writer.expiresAtMs !== expiresAtMs
        || !stage
        || stage.expiresAtMs !== expiresAtMs
      ) {
        return response(["", ...time]);
      }
      return response([stage.raw, ...time]);
    }

    throw new Error(`missing fake handler for ${marker}`);
  }

  return {
    clock,
    commands,
    fetchImpl,
    handlers,
    records,
  };
}

function adapterFor(harness) {
  return createSourceRecallReferencePersistenceAdapter({
    fetchImpl: harness.fetchImpl,
    token: "unit-test-token",
    url: "https://private-kv.invalid///",
  });
}

async function expectCode(operation, code) {
  await assert.rejects(
    operation,
    (error) => (
      error
        instanceof SourceRecallReferencePersistenceAdapterError
      && error.name
        === "SourceRecallReferencePersistenceAdapterError"
      && error.code === code
      && error.message === code
      && error.cause === undefined
    ),
  );
}

async function expectSafeAdapterError(operation) {
  await assert.rejects(operation, (error) => {
    assert.equal(
      error
        instanceof SourceRecallReferencePersistenceAdapterError,
      true,
    );
    assert.match(
      error.code,
      /^SOURCE_RECALL_REFERENCE_PERSISTENCE_ADAPTER_/u,
    );
    assert.equal(error.message, error.code);
    assert.equal(error.cause, undefined);
    assert.doesNotMatch(
      error.message,
      /candidate|response body|unit-test-token|private-kv/u,
    );
    return true;
  });
}

function emptyCasInput({
  expectedRaw = runRaw(),
  nextRaw = runRaw({ revision: 1 }),
  notAfterMs = null,
} = {}) {
  return {
    expectedRaw,
    headKey: null,
    headRaw: null,
    key: RUN_KEY,
    nextRaw,
    notAfterMs,
    notBeforeMs: REDIS_NOW_MS,
    pageExpiresAtMs: null,
    pageKey: null,
    pageRaw: null,
    pageTtlMs: null,
    requiredPageSet: [],
    requiredPageSetDigest: pageSetDigest([]),
  };
}

function requiredPage({
  key = PAGE_KEY,
  raw,
  expiresAtMs = REDIS_NOW_MS + PRIVATE_PAGE_TTL_MS,
  minimumRemainingTtlMs = 20 * 60 * 60 * 1_000,
}) {
  return {
    expectedExpiresAtMs: expiresAtMs,
    key,
    minimumRemainingTtlMs,
    nativeByteProofDigest: sha1(raw),
    rawDigest: sha256(raw),
  };
}

function maximumShapeWireBytes() {
  const commitment = Object.freeze({
    referenceDigest: "d".repeat(64),
    referenceIdDigest: "e".repeat(64),
  });
  const pageManifests = Array.from(
    { length: 200 },
    (_, index) => ({
      cursorDigest: "1".repeat(64),
      firstJoinAt: "2026-07-26T00:00:00.000Z",
      lastJoinAt: "2026-07-26T00:00:00.000Z",
      nextCursorDigest: "2".repeat(64),
      pageExpiresAtMs: Number.MAX_SAFE_INTEGER,
      pageNativeByteProofDigest: "5".repeat(40),
      pageNumber: index + 1,
      pageRecordDigest: "3".repeat(64),
      pageSemanticDigest: "4".repeat(64),
      referenceCommitments: Array(100).fill(commitment),
      referenceCount: 100,
      scannedCount: 100,
    }),
  );
  const completedPass = (passNumber) => ({
    completedAtMs: Number.MAX_SAFE_INTEGER,
    lastJoinAt: "2026-07-26T00:00:00.000Z",
    nextCursor: null,
    nextPageNumber: 201,
    pageCount: 200,
    pageManifests,
    passNumber,
    referenceCount: 20_000,
    referenceManifestDigest: "5".repeat(64),
    scannedCount: 20_000,
    seenCursors: Array.from(
      { length: 199 },
      (_, index) => (
        `/bot/?ordering=-join_at&page_size=100`
        + `&join_at_before=2026-07-26T00%3A00%3A00.000Z`
        + `&page=${index + 2}`
      ),
    ),
    semanticDigest: "6".repeat(64),
    startedAtMs: REDIS_NOW_MS,
    status: "complete",
  });
  const maximumRun = {
    ...JSON.parse(runRaw()),
    passes: [completedPass(1), completedPass(2)],
    revision: Number.MAX_SAFE_INTEGER,
    status: "sealed_unpinnable",
  };
  const run = canonicalJson(maximumRun);
  const privatePage = canonicalJson({
    clientVersion: "recall-private-page-client-v1",
    contractPinsDigest: CONTRACT_PINS_DIGEST,
    cursor: "c".repeat(4_096),
    decisionBoundaryAtMs: DECISION_BOUNDARY_AT_MS,
    kind: "recall_private_reference_page_dark",
    nextCursor: null,
    pageExpiresAtMs: Number.MAX_SAFE_INTEGER,
    pageNumber: 200,
    pageSemanticDigest: "7".repeat(64),
    passNumber: 2,
    policyVersion: "recall-reference-head-dark-v1",
    referenceCount: 100,
    references: Array.from(
      { length: 100 },
      (_, index) => ({
        candidate: {
          email: "e".repeat(512),
          fullName: "n".repeat(512),
          linkedin: "l".repeat(4_096),
          paraformEventId: "p".repeat(1_024),
        },
        id: `${String(index).padStart(3, "0")}${"i".repeat(125)}`,
        joinAt: "2026-07-25T23:59:59.999Z",
        metadataSource: "paraform-reconciliation-guardian",
      }),
    ),
    runNonceDigest: RUN_NONCE_DIGEST,
    scannedCount: 100,
    source: "recall",
    version: 1,
    workKeyDigest: WORK_DIGEST,
  });
  assert.ok(
    Buffer.byteLength(privatePage, "utf8")
      < SOURCE_RECALL_REFERENCE_ATOMIC_PROOF_MAX_BYTES,
  );
  const required = pageManifests.map((manifest) => [
    String(
      manifest.pageNumber === 1
        ? 5
        : manifest.pageNumber + 5,
    ),
    `RRPG1|${manifest.pageRecordDigest}|`,
    manifest.pageNativeByteProofDigest,
    String(manifest.pageExpiresAtMs),
    String(20 * 60 * 60 * 1_000),
  ]).flat();
  const owner = "a".repeat(64);
  const fenceDigest = "b".repeat(64);
  const runStageEnvelope = (
    `RRRS1|${fenceDigest}|${sha256(run)}|`
    + `${Buffer.byteLength(run, "utf8")
      .toString(16).padStart(8, "0")}|${run}`
  );
  const pageStageEnvelope = pageEnvelope(privatePage);
  const runStageCommand = [
    "EVAL",
    "x".repeat(128 * 1024),
    3,
    `paraai:phase4:recall-reference:writer:v1:${WORK_DIGEST}`,
    `paraai:phase4:recall-reference:fence:v1:${WORK_DIGEST}`,
    `paraai:phase4:recall-reference:stage:v1:${WORK_DIGEST}:${owner}:run`,
    owner,
    fenceDigest,
    "",
    runStageEnvelope,
    "60000",
  ];
  const pageStageCommand = [
    "EVAL",
    "x".repeat(128 * 1024),
    2,
    `paraai:phase4:recall-reference:writer:v1:${WORK_DIGEST}`,
    `paraai:phase4:recall-reference:stage:v1:${WORK_DIGEST}:${owner}:page`,
    `${owner}|1|${fenceDigest}|${Number.MAX_SAFE_INTEGER}`,
    String(Number.MAX_SAFE_INTEGER),
    pageStageEnvelope,
  ];
  const finalCommand = [
    "EVAL",
    "x".repeat(128 * 1024),
    205,
    RUN_KEY,
    `paraai:phase4:recall-reference:writer:v1:${WORK_DIGEST}`,
    `paraai:phase4:recall-reference:stage:v1:${WORK_DIGEST}:${owner}:run`,
    `paraai:phase4:recall-reference:stage:v1:${WORK_DIGEST}:${owner}:page`,
    PAGE_KEY,
    HEAD_KEY,
    ...pageManifests.slice(1).map((manifest) => (
      `paraai:phase4:recall-reference:page:v1:`
      + `${WORK_DIGEST}:2:${manifest.pageNumber}`
    )),
    run,
    `${owner}|1|${fenceDigest}|${Number.MAX_SAFE_INTEGER}`,
    String(Number.MAX_SAFE_INTEGER),
    runStageEnvelope.slice(
      0,
      runStageEnvelope.length - run.length,
    ),
    String(Buffer.byteLength(runStageEnvelope, "utf8")),
    pageStageEnvelope.slice(
      0,
      pageStageEnvelope.length - privatePage.length,
    ),
    String(Buffer.byteLength(pageStageEnvelope, "utf8")),
    String(Number.MAX_SAFE_INTEGER),
    String(Number.MAX_SAFE_INTEGER),
    String(PRIVATE_PAGE_TTL_MS),
    "5",
    "6",
    "h".repeat(512 * 1024),
    "200",
    sha1(runStageEnvelope),
    sha1(pageStageEnvelope),
    sha256(run),
    sha1(privatePage),
    String(REDIS_NOW_MS),
    ...required,
  ];
  const headRaw = "h".repeat(512 * 1024);
  const verifyCommand = [
    "EVAL",
    "x".repeat(128 * 1024),
    202,
    RUN_KEY,
    HEAD_KEY,
    ...pageManifests.map((manifest) => (
      `paraai:phase4:recall-reference:page:v1:`
      + `${WORK_DIGEST}:2:${manifest.pageNumber}`
    )),
    run,
    headRaw,
    "200",
    ...pageManifests.map((manifest) => [
      `RRPG1|${manifest.pageRecordDigest}|`,
      manifest.pageNativeByteProofDigest,
      String(manifest.pageExpiresAtMs),
      String(20 * 60 * 60 * 1_000),
    ]).flat(),
  ];
  const requestBytes = Math.max(
    ...[
      runStageCommand,
      pageStageCommand,
      finalCommand,
      verifyCommand,
    ].map((command) => (
      Buffer.byteLength(JSON.stringify(command), "utf8")
    )),
  );
  const responseBytes = Math.max(
    ...[
      [runStageEnvelope, "1", "0"],
      [pageStageEnvelope, "1", "0"],
      [run, "1", "0"],
      [headRaw, "1", "0"],
      [pageStageEnvelope, String(Number.MAX_SAFE_INTEGER), "1", "0"],
    ].map((result) => (
      Buffer.byteLength(
        JSON.stringify({ result }),
        "utf8",
      )
    )),
  );
  return Object.freeze({ requestBytes, responseBytes });
}

test("dedicated configuration never falls back and the factory exposes only six frozen methods", async () => {
  const names = [
    "PARAAI_SOURCE_RECALL_REFERENCE_KV_REST_API_URL",
    "PARAAI_SOURCE_RECALL_REFERENCE_KV_REST_API_TOKEN",
    "KV_REST_API_URL",
    "KV_REST_API_TOKEN",
  ];
  const saved = Object.fromEntries(
    names.map((name) => [name, process.env[name]]),
  );
  try {
    delete process.env
      .PARAAI_SOURCE_RECALL_REFERENCE_KV_REST_API_URL;
    delete process.env
      .PARAAI_SOURCE_RECALL_REFERENCE_KV_REST_API_TOKEN;
    process.env.KV_REST_API_URL =
      "https://generic-kv-must-not-be-used.invalid";
    process.env.KV_REST_API_TOKEN = "generic-token";
    assert.equal(
      sourceRecallReferencePersistenceAdapterConfigured(),
      false,
    );
    assert.throws(
      () => createSourceRecallReferencePersistenceAdapter(),
      (error) => (
        error
          instanceof SourceRecallReferencePersistenceAdapterError
        && error.code
          === "SOURCE_RECALL_REFERENCE_PERSISTENCE_ADAPTER_UNAVAILABLE"
      ),
    );

    process.env
      .PARAAI_SOURCE_RECALL_REFERENCE_KV_REST_API_URL =
      "https://private-kv.invalid";
    assert.equal(
      sourceRecallReferencePersistenceAdapterConfigured(),
      false,
    );
    assert.throws(
      () => createSourceRecallReferencePersistenceAdapter(),
      (error) => (
        error
          instanceof SourceRecallReferencePersistenceAdapterError
        && error.code
          === "SOURCE_RECALL_REFERENCE_PERSISTENCE_ADAPTER_CONFIGURATION_INVALID"
      ),
    );
    process.env
      .PARAAI_SOURCE_RECALL_REFERENCE_KV_REST_API_TOKEN =
      "dedicated-token";
    assert.equal(
      sourceRecallReferencePersistenceAdapterConfigured(),
      true,
    );
  } finally {
    for (const name of names) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  }

  assert.match(
    SOURCE_RECALL_REFERENCE_PERSISTENCE_ADAPTER_VERSION,
    /v1$/u,
  );
  assert.equal(
    Number.isSafeInteger(
      SOURCE_RECALL_REFERENCE_ATOMIC_PROOF_MAX_BYTES,
    ),
    true,
  );
  assert.ok(
    SOURCE_RECALL_REFERENCE_ATOMIC_PROOF_MAX_BYTES
      >= 1_048_576,
  );
  const maximumWire = maximumShapeWireBytes();
  assert.ok(maximumWire.requestBytes > 7_000_000);
  assert.ok(maximumWire.responseBytes > 7_000_000);
  assert.equal(
    SOURCE_RECALL_REFERENCE_ATOMIC_SCRIPT_BUDGET_MS,
    15_000,
  );
  assert.ok(
    SOURCE_RECALL_REFERENCE_REQUEST_MAX_BYTES
      < 10 * 1024 * 1024,
  );
  assert.ok(
    maximumWire.requestBytes
      < SOURCE_RECALL_REFERENCE_REQUEST_MAX_BYTES,
  );
  assert.ok(
    maximumWire.responseBytes
      < SOURCE_RECALL_REFERENCE_REQUEST_MAX_BYTES,
  );
  const harness = fakeUpstash();
  const adapter = adapterFor(harness);
  assert.deepEqual(Object.keys(adapter).sort(), [
    "compareAndSet",
    "ensure",
    "readHead",
    "readPage",
    "readRun",
    "verifyArtifactSet",
  ]);
  assert.equal(Object.isFrozen(adapter), true);
  assert.throws(
    () => createSourceRecallReferencePersistenceAdapter({
      fetchImpl: harness.fetchImpl,
      token: "unit-test-token",
      unexpected: true,
      url: "https://private-kv.invalid",
    }),
    (error) => (
      error
        instanceof SourceRecallReferencePersistenceAdapterError
      && error.code
        === "SOURCE_RECALL_REFERENCE_PERSISTENCE_ADAPTER_CONFIGURATION_INVALID"
    ),
  );
});

test("ensure stamps canonical initial bytes with Redis TIME and exact reads preserve them", async () => {
  const harness = fakeUpstash();
  const adapter = adapterFor(harness);
  const proposedRaw = runRaw({
    createdAtMs: 0,
    updatedAtMs: 0,
  });
  const created = await adapter.ensure({
    key: RUN_KEY,
    proposedRaw,
  });
  const expectedRaw = runRaw();
  assert.deepEqual(created, {
    raw: expectedRaw,
    redisNowMs: REDIS_NOW_MS,
    status: "created",
  });
  assert.deepEqual(await adapter.ensure({
    key: RUN_KEY,
    proposedRaw,
  }), {
    raw: expectedRaw,
    redisNowMs: REDIS_NOW_MS,
    status: "existing",
  });
  assert.deepEqual(await adapter.readRun({ key: RUN_KEY }), {
    raw: expectedRaw,
    redisNowMs: REDIS_NOW_MS,
  });
  harness.records.set(HEAD_KEY, {
    expiresAtMs: null,
    raw: "{\"head\":true}",
  });
  assert.deepEqual(await adapter.readHead({ key: HEAD_KEY }), {
    raw: "{\"head\":true}",
    redisNowMs: REDIS_NOW_MS,
  });
  assert.deepEqual(
    harness.commands.map(({ command }) => (
      Object.values(MARKERS).find(
        (marker) => command[1].includes(marker),
      )
    )),
    [
      MARKERS.ensure,
      MARKERS.ensure,
      MARKERS.readOne,
      MARKERS.readOne,
    ],
  );
  assert.equal(harness.commands[0].url, "https://private-kv.invalid");
});

test("page reads report absolute-expiry TTL without renewing it", async () => {
  const harness = fakeUpstash();
  const adapter = adapterFor(harness);
  const expiresAtMs = REDIS_NOW_MS + PRIVATE_PAGE_TTL_MS;
  harness.records.set(PAGE_KEY, {
    expiresAtMs,
    raw: pageEnvelope("{\"page\":1}"),
  });

  assert.deepEqual(await adapter.readPage({ key: PAGE_KEY }), {
    raw: "{\"page\":1}",
    redisNowMs: REDIS_NOW_MS,
    remainingTtlMs: PRIVATE_PAGE_TTL_MS,
  });
  harness.clock.nowMs += 12_345;
  assert.deepEqual(await adapter.readPage({ key: PAGE_KEY }), {
    raw: "{\"page\":1}",
    redisNowMs: REDIS_NOW_MS + 12_345,
    remainingTtlMs: PRIVATE_PAGE_TTL_MS - 12_345,
  });
  assert.equal(
    harness.records.get(PAGE_KEY).expiresAtMs,
    expiresAtMs,
  );
  for (const { command } of harness.commands) {
    assert.match(command[1], /PEXPIRETIME/u);
    assert.doesNotMatch(command[1], /redis\.call\(['"]SET['"]/u);
    assert.equal(command.includes(String(PRIVATE_PAGE_TTL_MS)), false);
  }
});

test("CAS returns exact atomic receipts and distinguishes conflicts and deadlines", async () => {
  const harness = fakeUpstash();
  const adapter = adapterFor(harness);
  const expectedRaw = runRaw();
  const nextRaw = runRaw({ revision: 1 });
  const pageRaw = "{\"private\":\"page\"}";
  const headRaw = "{\"sealed\":\"head\"}";
  const expiresAtMs = REDIS_NOW_MS + PRIVATE_PAGE_TTL_MS;
  const page = requiredPage({
    raw: pageRaw,
    expiresAtMs,
  });
  const requiredPageSet = [page];
  const requiredPageSetDigest = pageSetDigest(requiredPageSet);
  harness.handlers.set(MARKERS.cas, ({ command, script }) => {
    assert.match(script, /PXAT/u);
    assert.match(script, /PEXPIRETIME/u);
    assert.equal(command.includes(nextRaw), false);
    assert.equal(command.includes(pageRaw), false);
    assert.equal(command.includes(headRaw), true);
    return [1, sha256(nextRaw), ...redisParts(REDIS_NOW_MS)];
  });
  const stored = await adapter.compareAndSet({
    expectedRaw,
    headKey: HEAD_KEY,
    headRaw,
    key: RUN_KEY,
    nextRaw,
    notAfterMs: null,
    notBeforeMs: REDIS_NOW_MS,
    pageExpiresAtMs: expiresAtMs,
    pageKey: PAGE_KEY,
    pageRaw,
    pageTtlMs: PRIVATE_PAGE_TTL_MS,
    requiredPageSet,
    requiredPageSetDigest,
  });
  assert.deepEqual(stored, {
    headReceipt: {
      keyDigest: keyDigest(HEAD_KEY),
      rawDigest: sha256(headRaw),
    },
    pageReceipt: {
      expiresAtMs,
      keyDigest: keyDigest(PAGE_KEY),
      rawDigest: sha256(pageRaw),
      ttlMs: PRIVATE_PAGE_TTL_MS,
    },
    pageSetReceipt: {
      count: 1,
      requestDigest: requiredPageSetDigest,
      verifiedAtMs: REDIS_NOW_MS,
    },
    raw: nextRaw,
    redisNowMs: REDIS_NOW_MS,
    status: "stored",
  });

  harness.handlers.set(MARKERS.cas, () => [
    -1,
    "",
    ...redisParts(REDIS_NOW_MS),
  ]);
  assert.deepEqual(
    await adapter.compareAndSet(emptyCasInput({
      expectedRaw,
      nextRaw: runRaw({ revision: 2 }),
    })),
    {
      headReceipt: null,
      pageReceipt: null,
      pageSetReceipt: null,
      raw: nextRaw,
      redisNowMs: REDIS_NOW_MS,
      status: "conflict",
    },
  );

  harness.handlers.set(MARKERS.cas, () => [
    -2,
    "",
    ...redisParts(REDIS_NOW_MS),
  ]);
  assert.deepEqual(
    await adapter.compareAndSet(emptyCasInput({
      expectedRaw: nextRaw,
      nextRaw: runRaw({ revision: 2 }),
      notAfterMs: REDIS_NOW_MS,
    })),
    {
      headReceipt: null,
      pageReceipt: null,
      pageSetReceipt: null,
      raw: nextRaw,
      redisNowMs: REDIS_NOW_MS,
      status: "deadline_exceeded",
    },
  );
});

test("immutable page-envelope metadata supplies bounded atomic proofs without retaining private bytes", async () => {
  const harness = fakeUpstash();
  const adapter = adapterFor(harness);
  const pageRaw = "{\"cached\":\"exact-private-page\"}";
  const expiresAtMs = REDIS_NOW_MS + PRIVATE_PAGE_TTL_MS;
  const firstNextRaw = runRaw({ revision: 1 });
  harness.handlers.set(MARKERS.cas, () => [
    1,
    sha256(firstNextRaw),
    ...redisParts(REDIS_NOW_MS),
  ]);
  await adapter.compareAndSet({
    ...emptyCasInput({ nextRaw: firstNextRaw }),
    pageExpiresAtMs: expiresAtMs,
    pageKey: PAGE_KEY,
    pageRaw,
    pageTtlMs: PRIVATE_PAGE_TTL_MS,
  });
  const page = requiredPage({ raw: pageRaw, expiresAtMs });
  const requiredPageSet = [page];
  let verifiedCommand = null;
  harness.handlers.set(MARKERS.verify, ({ command }) => {
    verifiedCommand = command;
    return [1, ...redisParts(REDIS_NOW_MS)];
  });
  const expectedHeadRaw = "{\"head\":true}";
  const requiredPageSetDigest = pageSetDigest(requiredPageSet);
  const requestDigest = artifactRequestDigest({
    expectedHeadRaw,
    expectedRunRaw: firstNextRaw,
    requiredPageSetDigest,
  });
  assert.deepEqual(await adapter.verifyArtifactSet({
    expectedHeadRaw,
    expectedRunRaw: firstNextRaw,
    headKey: HEAD_KEY,
    requestDigest,
    requiredPageSet,
    requiredPageSetDigest,
    runKey: RUN_KEY,
  }), {
    artifactSetReceipt: {
      count: 1,
      requestDigest,
      verifiedAtMs: REDIS_NOW_MS,
    },
    redisNowMs: REDIS_NOW_MS,
    status: "verified",
  });
  assert.equal(
    verifiedCommand.some((item) => (
      typeof item === "string"
      && item.includes(page.rawDigest)
    )),
    true,
  );
  assert.equal(verifiedCommand.includes(pageRaw), false);
  assert.match(verifiedCommand[1], /GETRANGE/u);
  assert.match(verifiedCommand[1], /STRLEN/u);
  assert.doesNotMatch(verifiedCommand[1], /sha256Hex/u);

  const freshHarness = fakeUpstash();
  const fresh = adapterFor(freshHarness);
  freshHarness.handlers.set(MARKERS.verify, () => [
    1,
    ...redisParts(REDIS_NOW_MS),
  ]);
  assert.deepEqual(
    await fresh.verifyArtifactSet({
      expectedHeadRaw,
      expectedRunRaw: firstNextRaw,
      headKey: HEAD_KEY,
      requestDigest,
      requiredPageSet,
      requiredPageSetDigest,
      runKey: RUN_KEY,
    }),
    {
      artifactSetReceipt: {
        count: 1,
        requestDigest,
        verifiedAtMs: REDIS_NOW_MS,
      },
      redisNowMs: REDIS_NOW_MS,
      status: "verified",
    },
  );
  assert.equal(freshHarness.commands.length, 1);

  await expectCode(
    () => fresh.compareAndSet({
      ...emptyCasInput(),
      pageExpiresAtMs: expiresAtMs,
      pageKey: OTHER_PAGE_KEY,
      pageRaw: "x".repeat(
        SOURCE_RECALL_REFERENCE_ATOMIC_PROOF_MAX_BYTES + 1,
      ),
      pageTtlMs: PRIVATE_PAGE_TTL_MS,
    }),
    "SOURCE_RECALL_REFERENCE_PERSISTENCE_ADAPTER_ATOMIC_PROOF_CAP_EXCEEDED",
  );
  assert.equal(freshHarness.commands.length, 1);
});

test("artifact-set verification returns exact verified and mismatch envelopes", async () => {
  const harness = fakeUpstash();
  const adapter = adapterFor(harness);
  const expectedHeadRaw = "{\"head\":true}";
  const expectedRunRaw = runRaw();
  const requiredPageSetDigest = pageSetDigest([]);
  const requestDigest = artifactRequestDigest({
    expectedHeadRaw,
    expectedRunRaw,
    requiredPageSetDigest,
  });
  const input = {
    expectedHeadRaw,
    expectedRunRaw,
    headKey: HEAD_KEY,
    requestDigest,
    requiredPageSet: [],
    requiredPageSetDigest,
    runKey: RUN_KEY,
  };
  harness.handlers.set(MARKERS.verify, () => [
    1,
    ...redisParts(REDIS_NOW_MS),
  ]);
  assert.deepEqual(await adapter.verifyArtifactSet(input), {
    artifactSetReceipt: {
      count: 0,
      requestDigest,
      verifiedAtMs: REDIS_NOW_MS,
    },
    redisNowMs: REDIS_NOW_MS,
    status: "verified",
  });
  harness.handlers.set(MARKERS.verify, () => [
    0,
    ...redisParts(REDIS_NOW_MS),
  ]);
  assert.deepEqual(await adapter.verifyArtifactSet(input), {
    artifactSetReceipt: null,
    redisNowMs: REDIS_NOW_MS,
    status: "mismatch",
  });
});

test("network, non-2xx, Redis error, malformed, and unknown Lua results stay redacted", async () => {
  const cases = [
    async () => {
      throw new Error(
        "candidate and response body must never escape",
      );
    },
    async () => response(null, {
      body: "candidate and response body must never escape",
      ok: false,
      status: 503,
    }),
    async () => response(null, {
      body: "candidate and response body must never escape",
      status: 201,
    }),
    async () => response(null, {
      body: JSON.stringify({
        error: "candidate and response body must never escape",
      }),
    }),
    async () => response(["raw", "not-time", "0"]),
    async () => response({ unexpected: true }),
    async () => response([
      true,
      "{\"run\":true}",
      ...redisParts(REDIS_NOW_MS),
    ]),
    async () => ({
      headers: { get: () => null },
      ok: true,
      text: async () => (
        "candidate and response body must never be allocated"
      ),
    }),
  ];
  for (const fetchImpl of cases) {
    const adapter =
      createSourceRecallReferencePersistenceAdapter({
        fetchImpl,
        token: "unit-test-token",
        url: "https://private-kv.invalid",
      });
    await expectSafeAdapterError(
      () => adapter.readRun({ key: RUN_KEY }),
    );
  }

  const harness = fakeUpstash();
  harness.handlers.set(MARKERS.cas, () => [
    -9,
    "",
    ...redisParts(REDIS_NOW_MS),
  ]);
  await expectCode(
    () => adapterFor(harness).compareAndSet(emptyCasInput()),
    "SOURCE_RECALL_REFERENCE_PERSISTENCE_ADAPTER_ATOMIC_PROOF_FAILED",
  );
  harness.handlers.set(MARKERS.cas, () => [
    true,
    runRaw({ revision: 1 }),
    ...redisParts(REDIS_NOW_MS),
  ]);
  await expectCode(
    () => adapterFor(harness).compareAndSet(emptyCasInput()),
    "SOURCE_RECALL_REFERENCE_PERSISTENCE_ADAPTER_RESPONSE_INVALID",
  );
});

test("every rejected or incomplete HTTP body is cancelled before the stable error escapes", async () => {
  const cases = [
    {
      expectedCode:
        "SOURCE_RECALL_REFERENCE_PERSISTENCE_ADAPTER_REQUEST_FAILED",
      response(cancelled) {
        return {
          body: {
            async cancel() {
              cancelled.count += 1;
            },
          },
          ok: false,
          status: 503,
        };
      },
    },
    {
      expectedCode:
        "SOURCE_RECALL_REFERENCE_PERSISTENCE_ADAPTER_REQUEST_FAILED",
      response(cancelled) {
        return {
          body: {
            async cancel() {
              cancelled.count += 1;
            },
          },
          ok: true,
          status: 201,
        };
      },
    },
    {
      expectedCode:
        "SOURCE_RECALL_REFERENCE_PERSISTENCE_ADAPTER_RESPONSE_INVALID",
      response(cancelled) {
        return {
          body: {
            async cancel() {
              cancelled.count += 1;
            },
          },
          headers: {
            get() {
              return String(
                SOURCE_RECALL_REFERENCE_REQUEST_MAX_BYTES + 1,
              );
            },
          },
          ok: true,
          status: 200,
        };
      },
    },
    {
      expectedCode:
        "SOURCE_RECALL_REFERENCE_PERSISTENCE_ADAPTER_RESPONSE_INVALID",
      response(cancelled) {
        let reads = 0;
        return {
          body: {
            getReader() {
              return {
                async cancel() {
                  cancelled.count += 1;
                },
                async read() {
                  reads += 1;
                  return {
                    done: false,
                    value: new Uint8Array(
                      reads === 1
                        ? SOURCE_RECALL_REFERENCE_REQUEST_MAX_BYTES
                        : 1,
                    ),
                  };
                },
                releaseLock() {},
              };
            },
          },
          headers: { get: () => null },
          ok: true,
          status: 200,
        };
      },
    },
    {
      expectedCode:
        "SOURCE_RECALL_REFERENCE_PERSISTENCE_ADAPTER_RESPONSE_INVALID",
      response(cancelled) {
        return {
          body: {
            getReader() {
              return {
                async cancel() {
                  cancelled.count += 1;
                },
                async read() {
                  throw new Error(
                    "private response detail must remain redacted",
                  );
                },
                releaseLock() {},
              };
            },
          },
          headers: { get: () => null },
          ok: true,
          status: 200,
        };
      },
    },
    {
      expectedCode:
        "SOURCE_RECALL_REFERENCE_PERSISTENCE_ADAPTER_RESPONSE_INVALID",
      response(cancelled) {
        const body = new ReadableStream({
          cancel() {
            cancelled.count += 1;
          },
          start(controller) {
            controller.enqueue(Uint8Array.from([0xff]));
          },
        });
        return {
          body,
          headers: { get: () => null },
          ok: true,
          status: 200,
        };
      },
    },
  ];
  for (const selected of cases) {
    const cancelled = { count: 0 };
    const adapter = createSourceRecallReferencePersistenceAdapter({
      fetchImpl: async () => selected.response(cancelled),
      token: "unit-test-token",
      url: "https://private-kv.invalid",
    });
    await expectCode(
      () => adapter.readRun({ key: RUN_KEY }),
      selected.expectedCode,
    );
    assert.equal(cancelled.count, 1);
  }
});

test("the adapter has only the exact hard-dark runtime importer and remains absent from every route, worker, coordinator, and gate", async () => {
  const root = new URL("../api/paraai/", import.meta.url);
  const adapterName =
    "source-recall-reference-persistence-adapter.mjs";
  const dedicatedNames = [
    "PARAAI_SOURCE_RECALL_REFERENCE_KV_REST_API_URL",
    "PARAAI_SOURCE_RECALL_REFERENCE_KV_REST_API_TOKEN",
  ];

  async function filesAt(directory) {
    const entries = await readdir(directory, {
      withFileTypes: true,
    });
    const files = [];
    for (const entry of entries) {
      const selected = new URL(entry.name, directory);
      if (entry.isDirectory()) {
        files.push(...await filesAt(new URL(
          `${entry.name}/`,
          directory,
        )));
      } else if (entry.name.endsWith(".mjs")) {
        files.push(selected);
      }
    }
    return files;
  }

  const files = await filesAt(root);
  const adapterUrl = files.find(
    (url) => url.pathname.endsWith(`/${adapterName}`),
  );
  assert.ok(adapterUrl);
  const adapterImporters = [];
  const credentialReaders = [];
  for (const file of files) {
    if (file.href === adapterUrl.href) continue;
    const source = await readFile(file, "utf8");
    if (source.includes(adapterName)) {
      adapterImporters.push(
        file.pathname.slice(
          file.pathname.lastIndexOf("/") + 1,
        ),
      );
    }
    for (const name of dedicatedNames) {
      if (source.includes(name)) {
        credentialReaders.push(
          file.pathname.slice(
            file.pathname.lastIndexOf("/") + 1,
          ),
        );
        break;
      }
    }
  }
  assert.deepEqual(adapterImporters.sort(), [
    "source-recall-point-observation-manifest-runtime.mjs",
    "source-recall-point-observation-runtime.mjs",
  ]);
  assert.deepEqual(credentialReaders.sort(), [
    "source-recall-point-observation-store.mjs",
  ]);

  const adapterSource = await readFile(adapterUrl, "utf8");
  for (const forbiddenImport of [
    "source-authority-store",
    "source-capture-coordinator",
    "source-watermark",
    "../../health",
    "../../run",
    "../../worker",
  ]) {
    assert.equal(
      adapterSource.includes(`from "${forbiddenImport}`),
      false,
    );
  }
});
