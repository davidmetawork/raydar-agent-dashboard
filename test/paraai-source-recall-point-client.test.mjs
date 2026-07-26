import assert from "node:assert/strict";
import {
  createHash,
  createHmac,
} from "node:crypto";
import {
  readFile,
  readdir,
} from "node:fs/promises";
import test from "node:test";

import {
  SOURCE_RECALL_POINT_CLIENT_VERSION,
  SOURCE_RECALL_POINT_MAX_BODY_BYTES,
  SOURCE_RECALL_POINT_MAX_RESPONSE_BYTES,
  SOURCE_RECALL_POINT_ORIGIN,
  SOURCE_RECALL_POINT_PATH,
  SOURCE_RECALL_POINT_REQUEST_VERSION,
  SOURCE_RECALL_POINT_RESPONSE_VERSION,
  SOURCE_RECALL_POINT_TIMEOUT_MS,
  SOURCE_RECALL_POINT_TRANSPORT_RECEIPT_VERSION,
  SOURCE_RECALL_POINT_URL,
  SourceRecallPointClientError,
  readPrivateRecallSourcePoint,
} from "../api/paraai/_lib/source-recall-point-client.mjs";

const SECRET =
  "recall-source-point-test-secret-0123456789";
const NOW_MS = 1_785_024_000_000;
const TIMESTAMP = "1785024000";
const RESERVATION_ID = "a".repeat(64);
const CONTEXT_DIGEST = "b".repeat(64);
const BOT_ID = "bot-synthetic-point-a";
const SIGNAL = Object.freeze({ synthetic: "signal" });
const PRIVATE_MARKER = "private-point-response-marker";
const REQUEST_DIGEST_DOMAIN =
  "paraai-recall-source-point-request-bytes-v1";

function request(overrides = {}) {
  return Object.freeze({
    version: SOURCE_RECALL_POINT_REQUEST_VERSION,
    reservationId: RESERVATION_ID,
    contextDigest: CONTEXT_DIGEST,
    readNumber: 1,
    botId: BOT_ID,
    ...overrides,
  });
}

function canonicalBody(input = request()) {
  return JSON.stringify({
    version: SOURCE_RECALL_POINT_REQUEST_VERSION,
    reservationId: input.reservationId,
    contextDigest: input.contextDigest,
    readNumber: input.readNumber,
    botId: input.botId,
  });
}

function digestBody(rawBody) {
  return createHash("sha256")
    .update(REQUEST_DIGEST_DOMAIN, "utf8")
    .update("\0", "utf8")
    .update(rawBody, "utf8")
    .digest("hex");
}

function point(overrides = {}) {
  return {
    id: BOT_ID,
    bot_name: "Raydar Screener",
    metadata: {
      source: "paraform-auto",
      nested: [null, true, 7, PRIVATE_MARKER],
    },
    status_changes: [],
    recordings: [],
    ...overrides,
  };
}

function envelope(
  input = request(),
  overrides = {},
) {
  const rawBody = canonicalBody(input);
  return {
    version: SOURCE_RECALL_POINT_RESPONSE_VERSION,
    reservationId: input.reservationId,
    contextDigest: input.contextDigest,
    readNumber: input.readNumber,
    requestDigest: digestBody(rawBody),
    point: point(),
    ...overrides,
  };
}

function responseHeaders(overrides = {}) {
  return {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...overrides,
  };
}

function jsonResponse(
  value,
  {
    status = 200,
    headers = {},
  } = {},
) {
  return new Response(JSON.stringify(value), {
    status,
    headers: responseHeaders(headers),
  });
}

function dependencies(
  fetchImpl,
  overrides = {},
) {
  return {
    fetchImpl,
    nowImpl: () => NOW_MS,
    secret: SECRET,
    signalFactory: (timeoutMs) => {
      assert.equal(
        timeoutMs,
        SOURCE_RECALL_POINT_TIMEOUT_MS,
      );
      return SIGNAL;
    },
    ...overrides,
  };
}

async function expectCode(operation, code) {
  await assert.rejects(
    operation,
    (error) => (
      error instanceof SourceRecallPointClientError
      && error.name === "SourceRecallPointClientError"
      && error.code === code
      && error.message === code
    ),
  );
}

test("pins the exact canonical body, HMAC, headers, and one POST", async () => {
  const input = request();
  const rawBody = canonicalBody(input);
  const expectedDigest = digestBody(rawBody);
  const expectedSignature = `v1=${createHmac(
    "sha256",
    SECRET,
  )
    .update(
      `${TIMESTAMP}.POST.${SOURCE_RECALL_POINT_PATH}.${rawBody}`,
      "utf8",
    )
    .digest("hex")}`;
  const calls = [];

  const result = await readPrivateRecallSourcePoint(
    input,
    dependencies(async (...args) => {
      calls.push(args);
      return jsonResponse(envelope(input));
    }),
  );

  assert.equal(
    SOURCE_RECALL_POINT_CLIENT_VERSION,
    "recall-private-point-client-v1",
  );
  assert.equal(
    SOURCE_RECALL_POINT_ORIGIN,
    "https://raydar-calls.vercel.app",
  );
  assert.equal(
    SOURCE_RECALL_POINT_PATH,
    "/api/paraai-source-point",
  );
  assert.equal(
    SOURCE_RECALL_POINT_URL,
    `${SOURCE_RECALL_POINT_ORIGIN}${SOURCE_RECALL_POINT_PATH}`,
  );
  assert.equal(SOURCE_RECALL_POINT_TIMEOUT_MS, 20_000);
  assert.equal(
    SOURCE_RECALL_POINT_MAX_BODY_BYTES,
    32 * 1024,
  );
  assert.equal(
    SOURCE_RECALL_POINT_MAX_RESPONSE_BYTES,
    4_000_000,
  );
  assert.equal(
    Buffer.byteLength(rawBody, "utf8")
      <= SOURCE_RECALL_POINT_MAX_BODY_BYTES,
    true,
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], SOURCE_RECALL_POINT_URL);
  assert.deepEqual(calls[0][1], {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-raydar-timestamp": TIMESTAMP,
      "x-raydar-signature": expectedSignature,
    },
    body: rawBody,
    cache: "no-store",
    redirect: "error",
    signal: SIGNAL,
  });
  assert.deepEqual(
    Object.keys(JSON.parse(calls[0][1].body)),
    [
      "version",
      "reservationId",
      "contextDigest",
      "readNumber",
      "botId",
    ],
  );
  assert.deepEqual(result, {
    point: point(),
    transportReceipt: {
      version:
        SOURCE_RECALL_POINT_TRANSPORT_RECEIPT_VERSION,
      reservationId: RESERVATION_ID,
      contextDigest: CONTEXT_DIGEST,
      readNumber: 1,
      requestDigest: expectedDigest,
    },
  });
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.point), true);
  assert.equal(
    Object.isFrozen(result.point.metadata),
    true,
  );
  assert.equal(
    Object.isFrozen(result.point.metadata.nested),
    true,
  );
  assert.equal(
    Object.isFrozen(result.transportReceipt),
    true,
  );
});

test("canonicalizes insertion order and binds each read reservation independently", async () => {
  const reversed = Object.freeze({
    botId: BOT_ID,
    readNumber: 2,
    contextDigest: CONTEXT_DIGEST,
    reservationId: "c".repeat(64),
    version: SOURCE_RECALL_POINT_REQUEST_VERSION,
  });
  const calls = [];
  const result = await readPrivateRecallSourcePoint(
    reversed,
    dependencies(async (_url, options) => {
      calls.push(options);
      return jsonResponse(envelope(reversed));
    }),
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0].body, canonicalBody(reversed));
  assert.deepEqual(
    Object.keys(JSON.parse(calls[0].body)),
    [
      "version",
      "reservationId",
      "contextDigest",
      "readNumber",
      "botId",
    ],
  );
  assert.equal(
    result.transportReceipt.reservationId,
    reversed.reservationId,
  );
  assert.equal(result.transportReceipt.readNumber, 2);
  assert.equal(
    result.transportReceipt.requestDigest,
    digestBody(canonicalBody(reversed)),
  );
});

test("rejects every non-exact or non-frozen request before transport", async (t) => {
  const base = {
    version: SOURCE_RECALL_POINT_REQUEST_VERSION,
    reservationId: RESERVATION_ID,
    contextDigest: CONTEXT_DIGEST,
    readNumber: 1,
    botId: BOT_ID,
  };
  const accessor = {
    ...base,
  };
  Object.defineProperty(accessor, "botId", {
    enumerable: true,
    get() {
      throw new Error(PRIVATE_MARKER);
    },
  });
  Object.freeze(accessor);
  const symbol = Object.freeze({
    ...base,
    [Symbol("private")]: true,
  });
  const missing = { ...base };
  delete missing.contextDigest;
  const invalid = [
    ["unfrozen", { ...base }],
    ["null", null],
    ["array", Object.freeze([])],
    ["missing key", Object.freeze(missing)],
    ["extra key", Object.freeze({
      ...base,
      force: true,
    })],
    ["wrong version", Object.freeze({
      ...base,
      version: "paraai-recall-source-point-request-v2",
    })],
    ["short reservation", Object.freeze({
      ...base,
      reservationId: "a".repeat(63),
    })],
    ["uppercase context digest", Object.freeze({
      ...base,
      contextDigest: "B".repeat(64),
    })],
    ["read zero", Object.freeze({
      ...base,
      readNumber: 0,
    })],
    ["read three", Object.freeze({
      ...base,
      readNumber: 3,
    })],
    ["short bot id", Object.freeze({
      ...base,
      botId: "four",
    })],
    ["invalid bot id", Object.freeze({
      ...base,
      botId: "bot/invalid",
    })],
    ["long bot id", Object.freeze({
      ...base,
      botId: "x".repeat(129),
    })],
    ["proxy", Object.freeze(new Proxy({ ...base }, {}))],
    ["accessor", accessor],
    ["symbol", symbol],
  ];

  for (const [name, selected] of invalid) {
    await t.test(name, async () => {
      let fetchCount = 0;
      await expectCode(
        () => readPrivateRecallSourcePoint(
          selected,
          dependencies(async () => {
            fetchCount += 1;
            return jsonResponse(envelope());
          }),
        ),
        "SOURCE_RECALL_POINT_REQUEST_INVALID",
      );
      assert.equal(fetchCount, 0);
    });
  }
});

test("fails closed before transport for configuration, clock, and dependency defects", async (t) => {
  const cases = [
    [
      "missing secret",
      dependencies(async () => assert.fail(), {
        secret: undefined,
      }),
      "SOURCE_RECALL_POINT_CLIENT_NOT_CONFIGURED",
    ],
    [
      "short secret",
      dependencies(async () => assert.fail(), {
        secret: "x".repeat(31),
      }),
      "SOURCE_RECALL_POINT_CLIENT_NOT_CONFIGURED",
    ],
    [
      "invalid clock",
      dependencies(async () => assert.fail(), {
        nowImpl: () => Number.NaN,
      }),
      "SOURCE_RECALL_POINT_CLIENT_CLOCK_INVALID",
    ],
    [
      "nine digit timestamp",
      dependencies(async () => assert.fail(), {
        nowImpl: () => 999_999_999_000,
      }),
      "SOURCE_RECALL_POINT_CLIENT_CLOCK_INVALID",
    ],
  ];
  for (const [name, selected, code] of cases) {
    await t.test(name, async () => {
      let fetchCount = 0;
      await expectCode(
        () => readPrivateRecallSourcePoint(
          request(),
          {
            ...selected,
            fetchImpl: async () => {
              fetchCount += 1;
              return jsonResponse(envelope());
            },
          },
        ),
        code,
      );
      assert.equal(fetchCount, 0);
    });
  }

  const valid = dependencies(
    async () => jsonResponse(envelope()),
  );
  for (const selected of [
    {},
    { ...valid, alternateCredential: "not-accepted" },
    (() => {
      const copy = { ...valid };
      delete copy.signalFactory;
      return copy;
    })(),
    { ...valid, fetchImpl: null },
    new Proxy(valid, {}),
  ]) {
    await expectCode(
      () => readPrivateRecallSourcePoint(
        request(),
        selected,
      ),
      "SOURCE_RECALL_POINT_TEST_DEPENDENCIES_INVALID",
    );
  }
});

test("all transport, status, and private-header failures are generic and single-attempt", async (t) => {
  const cases = [
    [
      "network rejection",
      async () => {
        throw new Error(`${PRIVATE_MARKER} ${SECRET}`);
      },
      1,
    ],
    ["null response", async () => null, 1],
    [
      "rate limit",
      async () => jsonResponse(
        { error: PRIVATE_MARKER },
        { status: 429 },
      ),
      1,
    ],
    [
      "redirect",
      async () => jsonResponse(
        { error: PRIVATE_MARKER },
        { status: 302 },
      ),
      1,
    ],
    [
      "missing no-store",
      async () => jsonResponse(envelope(), {
        headers: { "cache-control": "" },
      }),
      1,
    ],
    [
      "missing nosniff",
      async () => jsonResponse(envelope(), {
        headers: { "x-content-type-options": "" },
      }),
      1,
    ],
    [
      "browser CORS",
      async () => jsonResponse(envelope(), {
        headers: {
          "access-control-allow-origin": "*",
        },
      }),
      1,
    ],
  ];

  for (const [name, fetchImpl, expectedCount] of cases) {
    await t.test(name, async () => {
      let fetchCount = 0;
      let observed;
      try {
        await readPrivateRecallSourcePoint(
          request(),
          dependencies(async (...args) => {
            fetchCount += 1;
            return fetchImpl(...args);
          }),
        );
      } catch (error) {
        observed = error;
      }
      assert.equal(
        observed instanceof SourceRecallPointClientError,
        true,
      );
      assert.equal(
        observed.code,
        "SOURCE_RECALL_POINT_UNAVAILABLE",
      );
      assert.equal(
        observed.message,
        "SOURCE_RECALL_POINT_UNAVAILABLE",
      );
      assert.equal(
        observed.message.includes(PRIVATE_MARKER),
        false,
      );
      assert.equal(observed.message.includes(SECRET), false);
      assert.equal(fetchCount, expectedCount);
    });
  }

  let fetchCount = 0;
  await expectCode(
    () => readPrivateRecallSourcePoint(
      request(),
      dependencies(async () => {
        fetchCount += 1;
        return jsonResponse(envelope());
      }, {
        signalFactory() {
          throw new Error(`${PRIVATE_MARKER} ${SECRET}`);
        },
      }),
    ),
    "SOURCE_RECALL_POINT_UNAVAILABLE",
  );
  assert.equal(fetchCount, 0);
});

test("rejects response framing, size, UTF-8, and JSON failures generically", async (t) => {
  const secureHeaders = new Headers(responseHeaders());
  let cancelled = 0;
  const oversizedStream = {
    status: 200,
    headers: secureHeaders,
    body: {
      async *[Symbol.asyncIterator]() {
        yield Buffer.alloc(2_000_001, 0x20);
        yield Buffer.alloc(2_000_000, 0x20);
      },
      async cancel() {
        cancelled += 1;
      },
    },
  };
  const cases = [
    [
      "missing content type",
      () => jsonResponse(envelope(), {
        headers: { "content-type": "" },
      }),
    ],
    [
      "wrong content type",
      () => jsonResponse(envelope(), {
        headers: { "content-type": "text/plain" },
      }),
    ],
    [
      "wrong charset",
      () => jsonResponse(envelope(), {
        headers: {
          "content-type":
            "application/json; charset=iso-8859-1",
        },
      }),
    ],
    [
      "declared oversized",
      () => jsonResponse(envelope(), {
        headers: {
          "content-length": String(
            SOURCE_RECALL_POINT_MAX_RESPONSE_BYTES + 1,
          ),
        },
      }),
    ],
    [
      "malformed content length",
      () => jsonResponse(envelope(), {
        headers: { "content-length": "01" },
      }),
    ],
    [
      "streamed oversized",
      () => oversizedStream,
    ],
    [
      "invalid utf8",
      () => new Response(
        Uint8Array.from([0xc3, 0x28]),
        { status: 200, headers: responseHeaders() },
      ),
    ],
    [
      "retained BOM",
      () => new Response(
        Buffer.concat([
          Buffer.from([0xef, 0xbb, 0xbf]),
          Buffer.from(JSON.stringify(envelope())),
        ]),
        { status: 200, headers: responseHeaders() },
      ),
    ],
    [
      "invalid json",
      () => new Response(
        `{${PRIVATE_MARKER}`,
        { status: 200, headers: responseHeaders() },
      ),
    ],
    [
      "empty body",
      () => ({
        status: 200,
        headers: secureHeaders,
        body: null,
      }),
    ],
    [
      "unsupported body",
      () => ({
        status: 200,
        headers: secureHeaders,
        body: {},
      }),
    ],
  ];

  for (const [name, factory] of cases) {
    await t.test(name, async () => {
      let fetchCount = 0;
      await expectCode(
        () => readPrivateRecallSourcePoint(
          request(),
          dependencies(async () => {
            fetchCount += 1;
            return factory();
          }),
        ),
        "SOURCE_RECALL_POINT_UNAVAILABLE",
      );
      assert.equal(fetchCount, 1);
    });
  }
  assert.equal(cancelled >= 1, true);
});

test("requires the exact ordered envelope and exact request echoes", async (t) => {
  const valid = envelope();
  const reordered = {
    point: valid.point,
    requestDigest: valid.requestDigest,
    readNumber: valid.readNumber,
    contextDigest: valid.contextDigest,
    reservationId: valid.reservationId,
    version: valid.version,
  };
  const missing = { ...valid };
  delete missing.contextDigest;
  const cases = [
    ["reordered envelope", reordered],
    ["missing envelope key", missing],
    ["extra envelope key", {
      ...valid,
      replay: false,
    }],
    ["wrong version", {
      ...valid,
      version: "paraai-recall-source-point-response-v2",
    }],
    ["wrong reservation", {
      ...valid,
      reservationId: "c".repeat(64),
    }],
    ["wrong context", {
      ...valid,
      contextDigest: "d".repeat(64),
    }],
    ["wrong ordinal", {
      ...valid,
      readNumber: 2,
    }],
    ["wrong request digest", {
      ...valid,
      requestDigest: "e".repeat(64),
    }],
    ["null point", { ...valid, point: null }],
    ["array point", { ...valid, point: [] }],
    ["string point", {
      ...valid,
      point: PRIVATE_MARKER,
    }],
  ];

  for (const [name, selected] of cases) {
    await t.test(name, async () => {
      await expectCode(
        () => readPrivateRecallSourcePoint(
          request(),
          dependencies(
            async () => jsonResponse(selected),
          ),
        ),
        "SOURCE_RECALL_POINT_UNAVAILABLE",
      );
    });
  }
});

test("returns only the private point and digest-only frozen transport receipt", async () => {
  const privatePoint = point({
    arbitrary_vendor_shape: {
      values: [
        { nested: PRIVATE_MARKER },
        42,
      ],
    },
  });
  const result = await readPrivateRecallSourcePoint(
    request(),
    dependencies(
      async () => jsonResponse(
        envelope(request(), { point: privatePoint }),
      ),
    ),
  );

  assert.deepEqual(Object.keys(result), [
    "point",
    "transportReceipt",
  ]);
  assert.deepEqual(
    Object.keys(result.transportReceipt),
    [
      "version",
      "reservationId",
      "contextDigest",
      "readNumber",
      "requestDigest",
    ],
  );
  assert.deepEqual(result.point, privatePoint);
  assert.equal(
    result.point.arbitrary_vendor_shape.values[0].nested,
    PRIVATE_MARKER,
  );
  assert.equal(
    Object.isFrozen(
      result.point.arbitrary_vendor_shape.values,
    ),
    true,
  );
  assert.throws(() => {
    result.point.bot_name = "Changed";
  }, TypeError);
  const receipt = JSON.stringify(result.transportReceipt);
  assert.equal(receipt.includes(BOT_ID), false);
  assert.equal(receipt.includes(PRIVATE_MARKER), false);
  assert.equal(receipt.includes(SECRET), false);
  assert.equal(receipt.includes("x-raydar-signature"), false);
  assert.equal(receipt.includes("rawBody"), false);
});

async function runtimeFiles(
  root,
  excludedDirectories = new Set(),
) {
  const entries = await readdir(root, {
    withFileTypes: true,
  });
  const files = [];
  for (const entry of entries) {
    const child = new URL(
      `${entry.name}${entry.isDirectory() ? "/" : ""}`,
      root,
    );
    if (entry.isDirectory()) {
      if (excludedDirectories.has(entry.name)) continue;
      files.push(...await runtimeFiles(
        child,
        excludedDirectories,
      ));
    } else if (/\.(?:mjs|js|ts)$/u.test(entry.name)) {
      files.push(child);
    }
  }
  return files;
}

test("the client remains a hard-dark leaf with no production importer or release integration", async () => {
  const moduleUrl = new URL(
    "../api/paraai/_lib/source-recall-point-client.mjs",
    import.meta.url,
  );
  const source = await readFile(moduleUrl, "utf8");
  const imports = [
    ...source.matchAll(/\bfrom\s+["']([^"']+)["']/gu),
  ].map((match) => match[1]).sort();
  assert.deepEqual(imports, [
    "node:crypto",
    "node:util",
  ]);
  assert.doesNotMatch(source, /\bconsole\./u);
  assert.doesNotMatch(
    source,
    /PARAAI_(?:CURATE_ENABLED|ENROLL_APPROVED|MATCH_STAGE_ENABLED)/u,
  );
  assert.doesNotMatch(
    source,
    /source-(?:capture-coordinator|watermark|authority-store)/u,
  );

  const repositoryRoot = new URL("../", import.meta.url);
  const files = await runtimeFiles(
    repositoryRoot,
    new Set([
      ".git",
      "node_modules",
      "test",
    ]),
  );
  const importers = [];
  for (const file of files) {
    if (file.href === moduleUrl.href) continue;
    const candidate = await readFile(file, "utf8");
    if (candidate.includes("source-recall-point-client")) {
      importers.push(file.pathname);
    }
  }
  assert.deepEqual(importers, []);
});
