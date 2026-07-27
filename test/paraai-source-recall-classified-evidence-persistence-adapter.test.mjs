import assert from "node:assert/strict";
import {
  readFile,
  readdir,
} from "node:fs/promises";
import test from "node:test";

import {
  SOURCE_RECALL_CLASSIFIED_EVIDENCE_KV_REST_API_TOKEN_ENV,
  SOURCE_RECALL_CLASSIFIED_EVIDENCE_KV_REST_API_URL_ENV,
  SOURCE_RECALL_CLASSIFIED_EVIDENCE_PERSISTENCE_ADAPTER_VERSION,
  SourceRecallClassifiedEvidencePersistenceError,
  createSourceRecallClassifiedEvidencePersistenceAdapter,
  sourceRecallClassifiedEvidencePersistenceConfigured,
} from "../api/paraai/_lib/source-recall-classified-evidence-persistence-adapter.mjs";
import {
  SOURCE_RECALL_CLASSIFIED_EVIDENCE_SEAL_ENV,
  sourceRecallClassifiedEvidenceStoreConfigured,
} from "../api/paraai/_lib/source-recall-classified-evidence-store.mjs";

const KEY =
  "paraai:phase4:recall-classified-evidence:v1:work:"
  + "a".repeat(64);
const NOW_MS = Date.parse("2026-07-27T00:00:00.000Z");
const ISSUED_AT_MS = NOW_MS - 1_000;
const NOT_AFTER_MS = NOW_MS + 60_000;
const EXPIRES_AT_MS = NOW_MS + 120_000;
const ADAPTER_URL =
  "https://classified-kv.example.invalid";
const TOKEN =
  "classified-adapter-test-token-that-is-not-production";

function expectCode(code) {
  return (error) => {
    assert.equal(
      error instanceof
        SourceRecallClassifiedEvidencePersistenceError,
      true,
    );
    assert.equal(error.code, code);
    assert.equal(error.message, code);
    return true;
  };
}

function redisTime(value = NOW_MS) {
  return [
    String(Math.floor(value / 1_000)),
    String((value % 1_000) * 1_000),
  ];
}

function response(result, options = {}) {
  const body = options.body
    ?? JSON.stringify({ result });
  return new Response(body, {
    status: options.status ?? 200,
    headers: {
      "content-type":
        options.contentType
        ?? "application/json; charset=utf-8",
      ...(options.headers ?? {}),
    },
  });
}

function adapterFor(result, observations = {}) {
  return createSourceRecallClassifiedEvidencePersistenceAdapter({
    url: ADAPTER_URL,
    token: TOKEN,
    signalFactory(timeoutMs) {
      observations.timeoutMs = timeoutMs;
      return undefined;
    },
    async fetchImpl(url, request) {
      observations.url = url;
      observations.request = request;
      return typeof result === "function"
        ? result(url, request)
        : response(result);
    },
  });
}

function input(overrides = {}) {
  return {
    key: KEY,
    proposedRaw: "{}",
    issuedAtMs: ISSUED_AT_MS,
    notAfterMs: NOT_AFTER_MS,
    expiresAtMs: EXPIRES_AT_MS,
    ...overrides,
  };
}

test("the adapter issues one exact Redis-TIME SET-NX-PXAT transition in its dedicated namespace", async () => {
  const observations = {};
  const [seconds, microseconds] = redisTime();
  const adapter = adapterFor(
    [1, "{}", seconds, microseconds, EXPIRES_AT_MS],
    observations,
  );
  const result = await adapter.retain(input());
  assert.deepEqual(result, {
    status: "created",
    raw: "{}",
    redisNowMs: NOW_MS,
    expiresAtMs: EXPIRES_AT_MS,
  });
  assert.equal(
    SOURCE_RECALL_CLASSIFIED_EVIDENCE_PERSISTENCE_ADAPTER_VERSION,
    "recall-classified-evidence-persistence-adapter-dark-v1",
  );
  assert.equal(observations.url, ADAPTER_URL);
  assert.equal(observations.request.method, "POST");
  assert.equal(observations.request.cache, "no-store");
  assert.equal(observations.request.redirect, "error");
  assert.equal(observations.timeoutMs, 8_000);
  assert.equal(
    observations.request.headers.authorization,
    `Bearer ${TOKEN}`,
  );
  assert.equal(
    observations.request.headers["content-type"],
    "application/json",
  );
  const command = JSON.parse(observations.request.body);
  assert.equal(command[0], "EVAL");
  assert.equal(command[2], 1);
  assert.equal(command[3], KEY);
  assert.equal(command[4], "{}");
  assert.equal(command[5], String(ISSUED_AT_MS));
  assert.equal(command[6], String(NOT_AFTER_MS));
  assert.equal(command[7], String(EXPIRES_AT_MS));
  assert.match(command[1], /redis\.call\('TIME'\)/u);
  assert.match(command[1], /nowMs < issuedAtMs/u);
  assert.match(command[1], /nowMs >= notAfterMs/u);
  assert.match(command[1], /notAfterMs > expiresAtMs/u);
  assert.match(
    command[1],
    /'SET',[\s\S]*'NX',[\s\S]*'PXAT'/u,
  );
  assert.match(command[1], /redis\.call\('PEXPIRETIME'/u);
  assert.doesNotMatch(command[1], /\bPEXPIRE\b/u);
  assert.doesNotMatch(command[1], /\bDEL\b/u);
});

test("created, existing, and exact expiry outcomes retain the Redis linearization time", async (t) => {
  const [seconds, microseconds] = redisTime();
  for (const [name, raw, expected] of [
    [
      "created",
      [1, "{}", seconds, microseconds, EXPIRES_AT_MS],
      {
        status: "created",
        raw: "{}",
        redisNowMs: NOW_MS,
        expiresAtMs: EXPIRES_AT_MS,
      },
    ],
    [
      "existing",
      [0, "{\"retained\":true}", seconds, microseconds, EXPIRES_AT_MS],
      {
        status: "existing",
        raw: "{\"retained\":true}",
        redisNowMs: NOW_MS,
        expiresAtMs: EXPIRES_AT_MS,
      },
    ],
    [
      "expired",
      [2, null, seconds, microseconds, -2],
      {
        status: "expired",
        raw: null,
        redisNowMs: NOW_MS,
        expiresAtMs: -2,
      },
    ],
  ]) {
    await t.test(name, async () => {
      assert.deepEqual(
        await adapterFor(raw).retain(input()),
        expected,
      );
    });
  }
});

test("caller keys, clocks, payloads, shapes, and proxies fail before transport", async (t) => {
  let calls = 0;
  const adapter =
    createSourceRecallClassifiedEvidencePersistenceAdapter({
      url: ADAPTER_URL,
      token: TOKEN,
      signalFactory: () => undefined,
      async fetchImpl() {
        calls += 1;
        throw new Error("transport must remain unused");
      },
    });
  const cases = [
    ["wrong namespace", { key: `other:${"a".repeat(64)}` }],
    ["short digest", { key: KEY.slice(0, -1) }],
    ["clock zero", { issuedAtMs: 0 }],
    ["clock fraction", { issuedAtMs: 1.5 }],
    ["clock reversal", {
      issuedAtMs: NOT_AFTER_MS,
    }],
    ["deadline equality", {
      issuedAtMs: NOT_AFTER_MS,
      notAfterMs: NOT_AFTER_MS,
    }],
    ["expiry before transition deadline", {
      expiresAtMs: NOT_AFTER_MS - 1,
    }],
    ["empty raw", { proposedRaw: "" }],
    ["oversize raw", {
      proposedRaw: "x".repeat(256 * 1_024 + 1),
    }],
    ["extra selector", { force: true }],
  ];
  for (const [name, changes] of cases) {
    await t.test(name, async () => {
      await assert.rejects(
        adapter.retain(input(changes)),
        expectCode(
          "SOURCE_RECALL_CLASSIFIED_EVIDENCE_PERSISTENCE_INPUT_INVALID",
        ),
      );
    });
  }
  for (const value of [
    null,
    Object.freeze({}),
    new Proxy(input(), {}),
  ]) {
    await assert.rejects(
      adapter.retain(value),
      expectCode(
        "SOURCE_RECALL_CLASSIFIED_EVIDENCE_PERSISTENCE_INPUT_INVALID",
      ),
    );
  }
  assert.equal(calls, 0);
});

test("configuration is dedicated, paired, HTTPS-only, and unavailable when absent", () => {
  const savedUrl =
    process.env[
      SOURCE_RECALL_CLASSIFIED_EVIDENCE_KV_REST_API_URL_ENV
    ];
  const savedToken =
    process.env[
      SOURCE_RECALL_CLASSIFIED_EVIDENCE_KV_REST_API_TOKEN_ENV
    ];
  const savedSeal =
    process.env[
      SOURCE_RECALL_CLASSIFIED_EVIDENCE_SEAL_ENV
    ];
  try {
    delete process.env[
      SOURCE_RECALL_CLASSIFIED_EVIDENCE_KV_REST_API_URL_ENV
    ];
    delete process.env[
      SOURCE_RECALL_CLASSIFIED_EVIDENCE_KV_REST_API_TOKEN_ENV
    ];
    assert.equal(
      sourceRecallClassifiedEvidencePersistenceConfigured(),
      false,
    );
    assert.equal(
      sourceRecallClassifiedEvidenceStoreConfigured(),
      false,
    );
    assert.throws(
      () =>
        createSourceRecallClassifiedEvidencePersistenceAdapter(),
      expectCode(
        "SOURCE_RECALL_CLASSIFIED_EVIDENCE_UNAVAILABLE",
      ),
    );
    for (const value of [
      { url: ADAPTER_URL },
      { token: TOKEN },
      { url: "http://classified.invalid", token: TOKEN },
      {
        url: "https://user:pass@classified.invalid",
        token: TOKEN,
      },
      {
        url: "https://classified.invalid?query=1",
        token: TOKEN,
      },
      {
        url: ADAPTER_URL,
        token: TOKEN,
        force: true,
      },
    ]) {
      assert.throws(
        () =>
          createSourceRecallClassifiedEvidencePersistenceAdapter(
            value,
          ),
        expectCode(
          "SOURCE_RECALL_CLASSIFIED_EVIDENCE_CONFIGURATION_INVALID",
        ),
      );
    }
    process.env[
      SOURCE_RECALL_CLASSIFIED_EVIDENCE_KV_REST_API_URL_ENV
    ] = ADAPTER_URL;
    process.env[
      SOURCE_RECALL_CLASSIFIED_EVIDENCE_KV_REST_API_TOKEN_ENV
    ] = TOKEN;
    assert.equal(
      sourceRecallClassifiedEvidencePersistenceConfigured(),
      true,
    );
    assert.equal(
      sourceRecallClassifiedEvidenceStoreConfigured(),
      false,
    );
    process.env[
      SOURCE_RECALL_CLASSIFIED_EVIDENCE_SEAL_ENV
    ] = "classified-evidence-seal-secret-at-least-32-bytes";
    assert.equal(
      sourceRecallClassifiedEvidenceStoreConfigured(),
      true,
    );
  } finally {
    if (savedUrl === undefined) {
      delete process.env[
        SOURCE_RECALL_CLASSIFIED_EVIDENCE_KV_REST_API_URL_ENV
      ];
    } else {
      process.env[
        SOURCE_RECALL_CLASSIFIED_EVIDENCE_KV_REST_API_URL_ENV
      ] = savedUrl;
    }
    if (savedToken === undefined) {
      delete process.env[
        SOURCE_RECALL_CLASSIFIED_EVIDENCE_KV_REST_API_TOKEN_ENV
      ];
    } else {
      process.env[
        SOURCE_RECALL_CLASSIFIED_EVIDENCE_KV_REST_API_TOKEN_ENV
      ] = savedToken;
    }
    if (savedSeal === undefined) {
      delete process.env[
        SOURCE_RECALL_CLASSIFIED_EVIDENCE_SEAL_ENV
      ];
    } else {
      process.env[
        SOURCE_RECALL_CLASSIFIED_EVIDENCE_SEAL_ENV
      ] = savedSeal;
    }
  }
});

test("transport and response contract failures collapse to stable private errors", async (t) => {
  const [seconds, microseconds] = redisTime();
  const cases = [
    ["throw", async () => {
      throw new Error("private transport detail");
    }],
    ["status", () => response([], { status: 500 })],
    [
      "content type",
      () => response([], { contentType: "text/plain" }),
    ],
    [
      "invalid json",
      () => response([], { body: "not-json" }),
    ],
    [
      "wrong envelope",
      () => response([], { body: "{\"other\":[]}" }),
    ],
    [
      "oversize declaration",
      () => response([], {
        headers: {
          "content-length": String(384 * 1_024 + 1),
        },
      }),
    ],
    [
      "wrong status code",
      () => response([
        3,
        "{}",
        seconds,
        microseconds,
        NOT_AFTER_MS,
      ]),
    ],
    [
      "missing expiry",
      () => response([
        1,
        "{}",
        seconds,
        microseconds,
        -2,
      ]),
    ],
  ];
  for (const [name, fetchImpl] of cases) {
    await t.test(name, async () => {
      const adapter =
        createSourceRecallClassifiedEvidencePersistenceAdapter({
          url: ADAPTER_URL,
          token: TOKEN,
          signalFactory: () => undefined,
          fetchImpl,
        });
      await assert.rejects(
        adapter.retain(input()),
        (error) => {
          assert.equal(
            error instanceof
              SourceRecallClassifiedEvidencePersistenceError,
            true,
          );
          assert.equal(
            [
              "SOURCE_RECALL_CLASSIFIED_EVIDENCE_PERSISTENCE_FAILED",
              "SOURCE_RECALL_CLASSIFIED_EVIDENCE_PERSISTENCE_RESULT_INVALID",
            ].includes(error.code),
            true,
          );
          assert.doesNotMatch(
            error.message,
            /transport detail|not-json/u,
          );
          return true;
        },
      );
    });
  }
});

async function productionFiles(directory) {
  const entries = await readdir(directory, {
    withFileTypes: true,
  });
  const files = [];
  for (const entry of entries) {
    const child = new URL(
      `${entry.name}${entry.isDirectory() ? "/" : ""}`,
      directory,
    );
    if (entry.isDirectory()) {
      files.push(...await productionFiles(child));
    } else if (/\.(?:mjs|js|ts)$/u.test(entry.name)) {
      files.push(child);
    }
  }
  return files;
}

test("the classified adapter/store closure has one private importer and no route, worker, gate, or authority integration", async () => {
  const root = new URL(
    "../api/paraai/_lib/",
    import.meta.url,
  );
  const adapterUrl = new URL(
    "source-recall-classified-evidence-persistence-adapter.mjs",
    root,
  );
  const storeUrl = new URL(
    "source-recall-classified-evidence-store.mjs",
    root,
  );
  const [adapterSource, storeSource] = await Promise.all([
    readFile(adapterUrl, "utf8"),
    readFile(storeUrl, "utf8"),
  ]);
  for (const source of [adapterSource, storeSource]) {
    assert.doesNotMatch(source, /\bconsole\./u);
    assert.doesNotMatch(
      source,
      /PARAAI_(?:CURATE_ENABLED|ENROLL_APPROVED|MATCH_STAGE_ENABLED)/u,
    );
    assert.doesNotMatch(
      source,
      /source-(?:capture-coordinator|authority-store|watermark)/u,
    );
    assert.doesNotMatch(source, /phase4-curation/u);
  }
  assert.deepEqual(
    [...adapterSource.matchAll(
      /\bfrom\s+["']([^"']+)["']/gu,
    )].map((match) => match[1]).sort(),
    ["node:util"],
  );
  assert.deepEqual(
    [...storeSource.matchAll(
      /\bfrom\s+["']([^"']+)["']/gu,
    )].map((match) => match[1]).sort(),
    [
      "./source-recall-classified-evidence-persistence-adapter.mjs",
      "./source-recall-classifier-capsule-protocol.mjs",
      "./source-recall-point-observation-manifest-store.mjs",
      "./source-recall-success-evidence-projector.mjs",
      "node:crypto",
      "node:util",
    ],
  );
  const files = await productionFiles(
    new URL("../api/paraai/", import.meta.url),
  );
  const adapterImporters = [];
  const storeImporters = [];
  for (const file of files) {
    const source = await readFile(file, "utf8");
    if (
      file.href !== adapterUrl.href
      && source.includes(
        "source-recall-classified-evidence-persistence-adapter",
      )
    ) {
      adapterImporters.push(file.pathname);
    }
    if (
      file.href !== storeUrl.href
      && source.includes(
        "source-recall-classified-evidence-store",
      )
    ) {
      storeImporters.push(file.pathname);
    }
  }
  assert.deepEqual(adapterImporters, [
    storeUrl.pathname,
  ]);
  assert.deepEqual(storeImporters, []);
});
