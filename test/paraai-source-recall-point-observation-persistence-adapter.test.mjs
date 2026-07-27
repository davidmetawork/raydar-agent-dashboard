import assert from "node:assert/strict";
import test from "node:test";

import {
  SourceRecallPointObservationStoreError,
  createSourceRecallPointObservationPersistenceAdapter,
} from "../api/paraai/_lib/source-recall-point-observation-store.mjs";

const NOW_MS = Date.parse("2026-07-27T00:00:00.000Z");
const EXPIRES_AT_MS = NOW_MS + 60 * 60 * 1_000;
const KEY =
  `paraai:phase4:recall-point-observation:v2:work:${
    "a".repeat(64)
  }`;
const MANIFEST_RUN_KEY =
  `paraai:phase4:recall-point-observation-manifest:v1:run:${
    "b".repeat(64)
  }`;
const MANIFEST_PAGE_KEY =
  `paraai:phase4:recall-point-observation-manifest:v1:page:${
    "b".repeat(64)
  }:200`;
const URL = "https://unit-test.invalid";
const TOKEN = "unit-test-token";

function redisParts(nowMs = NOW_MS) {
  return [
    String(Math.floor(nowMs / 1_000)),
    String((nowMs % 1_000) * 1_000),
  ];
}

function response(result, {
  body = JSON.stringify({ result }),
  status = 200,
  contentType = "application/json",
  contentLength = String(Buffer.byteLength(body, "utf8")),
} = {}) {
  return new Response(body, {
    status,
    headers: {
      "content-length": contentLength,
      "content-type": contentType,
    },
  });
}

function expectCode(code) {
  return (error) => {
    assert.equal(
      error instanceof SourceRecallPointObservationStoreError,
      true,
    );
    assert.equal(error.code, code);
    assert.equal(error.message, code);
    return true;
  };
}

function adapterFor(fetchImpl, signalFactory = () => (
  Object.freeze({ unit: "signal" })
)) {
  return createSourceRecallPointObservationPersistenceAdapter({
    url: `${URL}/`,
    token: TOKEN,
    fetchImpl,
    signalFactory,
  });
}

test("the adapter sends exact single EVAL requests for all four persistence operations", async () => {
  const commands = [];
  const signals = [];
  const results = [
    redisParts(),
    [1, "{}", ...redisParts(), EXPIRES_AT_MS],
    ["{}", ...redisParts(), EXPIRES_AT_MS],
    [1, "{\"next\":true}", ...redisParts(), EXPIRES_AT_MS],
  ];
  const adapter = adapterFor(
    async (url, options) => {
      commands.push(JSON.parse(options.body));
      assert.equal(url, URL);
      assert.equal(options.method, "POST");
      assert.deepEqual(options.headers, {
        authorization: `Bearer ${TOKEN}`,
        "content-type": "application/json",
      });
      assert.equal(options.cache, "no-store");
      assert.equal(options.redirect, "error");
      assert.deepEqual(options.signal, { unit: "signal" });
      return response(results.shift());
    },
    (timeoutMs) => {
      signals.push(timeoutMs);
      return Object.freeze({ unit: "signal" });
    },
  );

  assert.deepEqual(
    Object.keys(adapter).sort(),
    ["compareAndSet", "ensure", "read", "time"],
  );
  assert.equal(Object.isFrozen(adapter), true);
  assert.deepEqual(await adapter.time(), {
    redisNowMs: NOW_MS,
  });
  assert.deepEqual(
    await adapter.ensure({
      key: KEY,
      proposedRaw: "{}",
      expiresAtMs: EXPIRES_AT_MS,
    }),
    {
      status: "created",
      raw: "{}",
      redisNowMs: NOW_MS,
      expiresAtMs: EXPIRES_AT_MS,
    },
  );
  assert.deepEqual(await adapter.read({ key: KEY }), {
    raw: "{}",
    redisNowMs: NOW_MS,
    expiresAtMs: EXPIRES_AT_MS,
  });
  assert.deepEqual(
    await adapter.compareAndSet({
      key: KEY,
      expectedRaw: "{}",
      nextRaw: "{\"next\":true}",
      expiresAtMs: EXPIRES_AT_MS,
      notAfterMs: NOW_MS + 30_000,
    }),
    {
      status: "stored",
      raw: "{\"next\":true}",
      redisNowMs: NOW_MS,
      expiresAtMs: EXPIRES_AT_MS,
    },
  );

  assert.deepEqual(signals, [8_000, 8_000, 8_000, 8_000]);
  assert.equal(commands.length, 4);
  for (const command of commands) {
    assert.equal(command[0], "EVAL");
  }
  assert.match(commands[0][1], /recall_point_observation_time_v1/u);
  assert.deepEqual(commands[0].slice(2), [0]);
  assert.match(commands[1][1], /recall_point_observation_ensure_v1/u);
  assert.deepEqual(
    commands[1].slice(2),
    [1, KEY, "{}", String(EXPIRES_AT_MS)],
  );
  assert.match(commands[2][1], /recall_point_observation_read_v1/u);
  assert.deepEqual(commands[2].slice(2), [1, KEY]);
  assert.match(commands[3][1], /recall_point_observation_cas_v1/u);
  assert.deepEqual(
    commands[3].slice(2),
    [
      1,
      KEY,
      "{}",
      "{\"next\":true}",
      String(EXPIRES_AT_MS),
      String(NOW_MS + 30_000),
    ],
  );
});

test("result arrays are exact, typed, and preserve Redis expiry semantics", async (t) => {
  const cases = [
    {
      name: "time has an extra field",
      result: [...redisParts(), "extra"],
      invoke: (adapter) => adapter.time(),
    },
    {
      name: "ensure status is not numeric",
      result: ["1", "{}", ...redisParts(), EXPIRES_AT_MS],
      invoke: (adapter) => adapter.ensure({
        key: KEY,
        proposedRaw: "{}",
        expiresAtMs: EXPIRES_AT_MS,
      }),
    },
    {
      name: "expired ensure retains impossible raw",
      result: [2, "{}", ...redisParts(), -2],
      invoke: (adapter) => adapter.ensure({
        key: KEY,
        proposedRaw: "{}",
        expiresAtMs: EXPIRES_AT_MS,
      }),
    },
    {
      name: "missing read reports a live expiry",
      result: [null, ...redisParts(), EXPIRES_AT_MS],
      invoke: (adapter) => adapter.read({ key: KEY }),
    },
    {
      name: "CAS has an extra field",
      result: [
        1,
        "{\"next\":true}",
        ...redisParts(),
        EXPIRES_AT_MS,
        "extra",
      ],
      invoke: (adapter) => adapter.compareAndSet({
        key: KEY,
        expectedRaw: "{}",
        nextRaw: "{\"next\":true}",
        expiresAtMs: EXPIRES_AT_MS,
        notAfterMs: NOW_MS + 30_000,
      }),
    },
    {
      name: "stored CAS reports a missing record",
      result: [1, null, ...redisParts(), EXPIRES_AT_MS],
      invoke: (adapter) => adapter.compareAndSet({
        key: KEY,
        expectedRaw: "{}",
        nextRaw: "{\"next\":true}",
        expiresAtMs: EXPIRES_AT_MS,
        notAfterMs: NOW_MS + 30_000,
      }),
    },
  ];
  for (const selected of cases) {
    await t.test(selected.name, async () => {
      let calls = 0;
      const adapter = adapterFor(async () => {
        calls += 1;
        return response(selected.result);
      });
      await assert.rejects(
        selected.invoke(adapter),
        expectCode(
          "SOURCE_RECALL_POINT_OBSERVATION_PERSISTENCE_RESULT_INVALID",
        ),
      );
      assert.equal(calls, 1);
    });
  }
});

test("transport, status, framing, and stream failures are redacted and never retried", async (t) => {
  const cases = [
    {
      name: "network rejection",
      makeResponse: async () => {
        throw new Error("private network detail");
      },
      expectedCancels: 0,
    },
    {
      name: "non-2xx",
      makeResponse(cancelled) {
        return {
          status: 503,
          headers: {
            get: () => "application/json",
          },
          body: {
            async cancel() {
              cancelled.count += 1;
            },
          },
        };
      },
      expectedCancels: 1,
    },
    {
      name: "non-exact successful status",
      makeResponse(cancelled) {
        const body = JSON.stringify({
          result: redisParts(),
        });
        return {
          status: 201,
          headers: {
            get(name) {
              return name === "content-type"
                ? "application/json"
                : String(Buffer.byteLength(body, "utf8"));
            },
          },
          body: {
            async cancel() {
              cancelled.count += 1;
            },
          },
        };
      },
      expectedCancels: 1,
    },
    {
      name: "declared oversize",
      makeResponse(cancelled) {
        return {
          status: 200,
          headers: {
            get(name) {
              return name === "content-type"
                ? "application/json"
                : String(256 * 1_024 + 1);
            },
          },
          body: {
            async cancel() {
              cancelled.count += 1;
            },
          },
        };
      },
      expectedCancels: 1,
    },
    {
      name: "streamed oversize",
      makeResponse(cancelled) {
        return {
          status: 200,
          headers: {
            get(name) {
              return name === "content-type"
                ? "application/json"
                : "";
            },
          },
          body: {
            async *[Symbol.asyncIterator]() {
              yield Buffer.alloc(256 * 1_024 + 1);
            },
            async cancel() {
              cancelled.count += 1;
            },
          },
        };
      },
      expectedCancels: 1,
    },
    {
      name: "stream rejection",
      makeResponse(cancelled) {
        return {
          status: 200,
          headers: {
            get(name) {
              return name === "content-type"
                ? "application/json"
                : "";
            },
          },
          body: {
            async *[Symbol.asyncIterator]() {
              yield Buffer.from("{", "utf8");
              throw new Error("private stream detail");
            },
            async cancel() {
              cancelled.count += 1;
            },
          },
        };
      },
      expectedCancels: 1,
    },
  ];
  for (const selected of cases) {
    await t.test(selected.name, async () => {
      const cancelled = { count: 0 };
      let calls = 0;
      const adapter = adapterFor(async () => {
        calls += 1;
        return selected.makeResponse(cancelled);
      });
      await assert.rejects(
        adapter.time(),
        expectCode(
          "SOURCE_RECALL_POINT_OBSERVATION_PERSISTENCE_FAILED",
        ),
      );
      assert.equal(calls, 1);
      assert.equal(cancelled.count, selected.expectedCancels);
    });
  }
});

test("configuration and persistence inputs fail before transport", async () => {
  assert.throws(
    () => createSourceRecallPointObservationPersistenceAdapter({
      url: URL,
    }),
    expectCode(
      "SOURCE_RECALL_POINT_OBSERVATION_CONFIGURATION_INVALID",
    ),
  );
  assert.throws(
    () => createSourceRecallPointObservationPersistenceAdapter({
      url: "http://unit-test.invalid",
      token: TOKEN,
    }),
    expectCode(
      "SOURCE_RECALL_POINT_OBSERVATION_CONFIGURATION_INVALID",
    ),
  );
  let calls = 0;
  const adapter = adapterFor(async () => {
    calls += 1;
    return response(redisParts());
  });
  await assert.rejects(
    adapter.read({
      key: KEY,
      force: true,
    }),
    expectCode(
      "SOURCE_RECALL_POINT_OBSERVATION_PERSISTENCE_INPUT_INVALID",
    ),
  );
  await assert.rejects(
    adapter.ensure({
      key: "caller-key",
      proposedRaw: "{}",
      expiresAtMs: EXPIRES_AT_MS,
    }),
    expectCode(
      "SOURCE_RECALL_POINT_OBSERVATION_PERSISTENCE_INPUT_INVALID",
    ),
  );
  await assert.rejects(
    adapter.ensure({
      key: KEY,
      proposedRaw: "x".repeat(256 * 1_024 + 1),
      expiresAtMs: EXPIRES_AT_MS,
    }),
    expectCode(
      "SOURCE_RECALL_POINT_OBSERVATION_PERSISTENCE_INPUT_INVALID",
    ),
  );
  assert.equal(calls, 0);
});

test("the shared adapter admits only exact bounded manifest namespaces", async () => {
  const commands = [];
  const adapter = adapterFor(async (url, options) => {
    commands.push(JSON.parse(options.body));
    return response([
      null,
      ...redisParts(),
      -2,
    ]);
  });
  for (const key of [MANIFEST_RUN_KEY, MANIFEST_PAGE_KEY]) {
    assert.deepEqual(await adapter.read({ key }), {
      raw: null,
      redisNowMs: NOW_MS,
      expiresAtMs: -2,
    });
  }
  assert.deepEqual(
    commands.map((command) => command[3]),
    [MANIFEST_RUN_KEY, MANIFEST_PAGE_KEY],
  );
  for (const key of [
    MANIFEST_PAGE_KEY.replace(/:200$/u, ":201"),
    MANIFEST_PAGE_KEY.replace(/:200$/u, ":0"),
    MANIFEST_PAGE_KEY.replace(/:200$/u, ":01"),
    MANIFEST_RUN_KEY.replace(/:run:/u, ":head:"),
  ]) {
    await assert.rejects(
      adapter.read({ key }),
      expectCode(
        "SOURCE_RECALL_POINT_OBSERVATION_PERSISTENCE_INPUT_INVALID",
      ),
    );
  }
  assert.equal(commands.length, 2);
});
