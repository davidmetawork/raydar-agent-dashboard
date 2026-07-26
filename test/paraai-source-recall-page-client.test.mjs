import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";

import {
  SOURCE_RECALL_PAGE_CLIENT_VERSION,
  SOURCE_RECALL_PAGE_MAX_RESPONSE_BYTES,
  SOURCE_RECALL_PAGE_PATH,
  SOURCE_RECALL_PAGE_SIZE,
  SOURCE_RECALL_PAGE_TIMEOUT_MS,
  SOURCE_RECALL_PAGE_URL,
  SOURCE_RECALL_PAGE_VERSION,
  SourceRecallPageClientError,
  readPrivateRecallSourcePage,
} from "../api/paraai/_lib/source-recall-page-client.mjs";

const BOUNDARY = "2026-07-26T03:00:00.000Z";
const JOIN_AT = "2026-07-25T02:00:00.000Z";
const NOW_MS = Date.parse("2026-07-26T03:00:01.000Z");
const TIMESTAMP = String(Math.floor(NOW_MS / 1_000));
const SECRET = "synthetic-page-secret-".padEnd(48, "s");
const SIGNAL = Object.freeze({ syntheticAbortSignal: true });
const BODY_MARKER = "synthetic-private-body-marker";

function cursor(page, boundaryAt = BOUNDARY) {
  const query = new URLSearchParams({
    ordering: "-join_at",
    page_size: String(SOURCE_RECALL_PAGE_SIZE),
    join_at_before: boundaryAt,
  });
  query.set("page", String(page));
  return `/bot/?${query}`;
}

function sourceRequest({
  boundaryAt = BOUNDARY,
  currentCursor = null,
  seenCursors = [],
} = {}) {
  return {
    boundaryAt,
    cursor: currentCursor,
    seenCursors,
  };
}

function candidate(overrides = {}) {
  return {
    fullName: "Synthetic Person",
    email: "synthetic.person@example.test",
    linkedin:
      "https://www.linkedin.com/in/synthetic-person",
    paraformEventId: "synthetic-event-0001",
    ...overrides,
  };
}

function reference(index = 1, overrides = {}) {
  return {
    id: `synthetic_bot_${String(index).padStart(5, "0")}`,
    joinAt: JOIN_AT,
    metadataSource: "paraform-auto",
    candidate: candidate(),
    ...overrides,
  };
}

function page(overrides = {}) {
  return {
    version: SOURCE_RECALL_PAGE_VERSION,
    boundaryAt: BOUNDARY,
    exhausted: true,
    nextCursor: null,
    scanned: 1,
    references: [reference()],
    ...overrides,
  };
}

function jsonResponse(payload, {
  status = 200,
  contentType = "application/json",
  headers = {},
} = {}) {
  const selectedHeaders = { ...headers };
  if (contentType !== null) {
    selectedHeaders["content-type"] = contentType;
  }
  return new Response(JSON.stringify(payload), {
    status,
    headers: selectedHeaders,
  });
}

function bytesResponse(bytes, {
  status = 200,
  contentType = "application/json",
  headers = {},
} = {}) {
  const selectedHeaders = { ...headers };
  if (contentType !== null) {
    selectedHeaders["content-type"] = contentType;
  }
  return new Response(bytes, {
    status,
    headers: selectedHeaders,
  });
}

function dependencies(fetchImpl, overrides = {}) {
  return {
    fetchImpl,
    nowImpl: () => NOW_MS,
    secret: SECRET,
    signalFactory: (timeoutMs) => {
      assert.equal(timeoutMs, SOURCE_RECALL_PAGE_TIMEOUT_MS);
      return SIGNAL;
    },
    ...overrides,
  };
}

async function expectCode(operation, code) {
  await assert.rejects(
    operation,
    (error) => (
      error instanceof SourceRecallPageClientError
      && error.name === "SourceRecallPageClientError"
      && error.code === code
      && error.message === code
    ),
  );
}

test("pins the exact private transport bytes, headers, HMAC, and single POST", async () => {
  const calls = [];
  const input = sourceRequest();
  const expectedBody = JSON.stringify(input);
  const expectedSignature = `v1=${createHmac("sha256", SECRET)
    .update(
      `${TIMESTAMP}.POST.${SOURCE_RECALL_PAGE_PATH}.${expectedBody}`,
      "utf8",
    )
    .digest("hex")}`;

  const result = await readPrivateRecallSourcePage(
    input,
    dependencies(async (...args) => {
      calls.push(args);
      return jsonResponse(page());
    }),
  );

  assert.equal(SOURCE_RECALL_PAGE_CLIENT_VERSION,
    "recall-private-page-client-v1");
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], SOURCE_RECALL_PAGE_URL);
  assert.deepEqual(calls[0][1], {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-raydar-timestamp": TIMESTAMP,
      "x-raydar-signature": expectedSignature,
    },
    body: expectedBody,
    cache: "no-store",
    redirect: "error",
    signal: SIGNAL,
  });
  assert.deepEqual(Object.keys(calls[0][1].headers).sort(), [
    "content-type",
    "x-raydar-signature",
    "x-raydar-timestamp",
  ]);
  assert.equal(
    Object.values(calls[0][1].headers)
      .some((value) => String(value).includes("Bearer")),
    false,
  );
  assert.equal(result.version, SOURCE_RECALL_PAGE_VERSION);
});

test("normalizes and signs the exact canonical multipage history", async () => {
  const page2 = cursor(2);
  const page3 = cursor(3);
  const page4 = cursor(4);
  const absolutePage4 =
    `https://us-west-2.recall.ai/api/v1${page4}`;
  const calls = [];

  const result = await readPrivateRecallSourcePage(
    sourceRequest({
      currentCursor: absolutePage4,
      seenCursors: [page2, page3],
    }),
    dependencies(async (...args) => {
      calls.push(args);
      return jsonResponse(page({
        exhausted: false,
        nextCursor: cursor(5),
      }));
    }),
  );

  assert.equal(calls.length, 1);
  const expectedBody = JSON.stringify({
    boundaryAt: BOUNDARY,
    cursor: page4,
    seenCursors: [page2, page3],
  });
  assert.equal(calls[0][1].body, expectedBody);
  assert.equal(
    calls[0][1].headers["x-raydar-signature"],
    `v1=${createHmac("sha256", SECRET)
      .update(
        `${TIMESTAMP}.POST.${SOURCE_RECALL_PAGE_PATH}.${expectedBody}`,
        "utf8",
      )
      .digest("hex")}`,
  );
  assert.equal(result.nextCursor, cursor(5));
  assert.equal(result.exhausted, false);
});

test("fails closed before transport for missing config, invalid dependencies, and invalid clocks", async (t) => {
  const cases = [
    {
      name: "missing dedicated secret",
      dependencies: dependencies(async () => {
        throw new Error("must not run");
      }, { secret: undefined }),
      code: "SOURCE_RECALL_PAGE_CLIENT_NOT_CONFIGURED",
    },
    {
      name: "short dedicated secret",
      dependencies: dependencies(async () => {
        throw new Error("must not run");
      }, { secret: "too-short" }),
      code: "SOURCE_RECALL_PAGE_CLIENT_NOT_CONFIGURED",
    },
    {
      name: "whitespace-only dedicated secret",
      dependencies: dependencies(async () => {
        throw new Error("must not run");
      }, { secret: " ".repeat(40) }),
      code: "SOURCE_RECALL_PAGE_CLIENT_NOT_CONFIGURED",
    },
    {
      name: "nine-digit timestamp",
      dependencies: dependencies(async () => {
        throw new Error("must not run");
      }, { nowImpl: () => 999_999_999_000 }),
      code: "SOURCE_RECALL_PAGE_CLIENT_CLOCK_INVALID",
    },
    {
      name: "non-finite timestamp",
      dependencies: dependencies(async () => {
        throw new Error("must not run");
      }, { nowImpl: () => Number.NaN }),
      code: "SOURCE_RECALL_PAGE_CLIENT_CLOCK_INVALID",
    },
  ];

  for (const selected of cases) {
    await t.test(selected.name, async () => {
      let fetchCount = 0;
      const selectedDependencies = {
        ...selected.dependencies,
        fetchImpl: async () => {
          fetchCount += 1;
          throw new Error("must not run");
        },
      };
      await expectCode(
        () => readPrivateRecallSourcePage(
          sourceRequest(),
          selectedDependencies,
        ),
        selected.code,
      );
      assert.equal(fetchCount, 0);
    });
  }

  const dependencyCases = [
    {
      name: "extra dependency",
      value: {
        ...dependencies(async () => jsonResponse(page())),
        alternateCredential: "synthetic-alternate",
      },
    },
    {
      name: "missing dependency",
      value: {
        fetchImpl: async () => jsonResponse(page()),
        nowImpl: () => NOW_MS,
        secret: SECRET,
      },
    },
    {
      name: "proxied dependency record",
      value: new Proxy(
        dependencies(async () => jsonResponse(page())),
        {},
      ),
    },
    {
      name: "accessor dependency",
      value: Object.defineProperty(
        {
          fetchImpl: async () => jsonResponse(page()),
          nowImpl: () => NOW_MS,
          secret: SECRET,
        },
        "signalFactory",
        {
          enumerable: true,
          get() {
            throw new Error("accessor must not execute");
          },
        },
      ),
    },
  ];
  for (const selected of dependencyCases) {
    await t.test(selected.name, async () => {
      await expectCode(
        () => readPrivateRecallSourcePage(
          sourceRequest(),
          selected.value,
        ),
        "SOURCE_RECALL_PAGE_CLIENT_DEPENDENCIES_INVALID",
      );
    });
  }
});

test("rejects hostile and non-exact request structures without making a request", async (t) => {
  const sparse = [];
  sparse.length = 1;
  const accessor = Object.defineProperty(
    {
      cursor: null,
      seenCursors: [],
    },
    "boundaryAt",
    {
      enumerable: true,
      get() {
        throw new Error("accessor must not execute");
      },
    },
  );
  const customArray = [];
  customArray.unexpected = cursor(2);
  const symbolArray = [];
  symbolArray[Symbol("unexpected")] = cursor(2);
  const inherited = Object.create({
    boundaryAt: BOUNDARY,
  });
  inherited.cursor = null;
  inherited.seenCursors = [];

  const cases = [
    ["null request", null],
    ["array request", []],
    ["proxied request", new Proxy(sourceRequest(), {})],
    ["accessor request", accessor],
    ["extra request key", {
      ...sourceRequest(),
      limit: 1,
    }],
    ["missing request key", {
      boundaryAt: BOUNDARY,
      cursor: null,
    }],
    ["custom prototype", inherited],
    ["symbol request key", {
      ...sourceRequest(),
      [Symbol("unexpected")]: true,
    }],
    ["sparse seen history", sourceRequest({
      currentCursor: cursor(3),
      seenCursors: sparse,
    })],
    ["array with extra property", sourceRequest({
      seenCursors: customArray,
    })],
    ["array with symbol property", sourceRequest({
      seenCursors: symbolArray,
    })],
    ["proxied history", sourceRequest({
      seenCursors: new Proxy([], {}),
    })],
    ["non-array history", sourceRequest({
      seenCursors: {},
    })],
  ];

  for (const [name, value] of cases) {
    await t.test(name, async () => {
      let fetchCount = 0;
      await expectCode(
        () => readPrivateRecallSourcePage(
          value,
          dependencies(async () => {
            fetchCount += 1;
            return jsonResponse(page());
          }),
        ),
        "SOURCE_RECALL_PAGE_REQUEST_INVALID",
      );
      assert.equal(fetchCount, 0);
    });
  }
});

test("requires a canonical boundary, cursor, and complete consecutive history", async (t) => {
  const malformedCursorCases = [
    null,
    cursor(1),
    cursor(2, "2026-07-26T03:00:00.001Z"),
    cursor(2).replace("page_size=100", "page_size=99"),
    cursor(2).replace("ordering=-join_at", "ordering=join_at"),
    cursor(2).replace("/bot/", "/recording/"),
    `${cursor(2)}&unexpected=true`,
    `${cursor(2)}&page=2`,
    `https://synthetic.invalid/api/v1${cursor(2)}`,
    ` ${cursor(2)}`,
    cursor(2).replace("page=2", "page=02"),
  ];
  const cases = [
    ["noncanonical boundary", sourceRequest({
      boundaryAt: "2026-07-26T03:00:00Z",
    })],
    ["impossible boundary", sourceRequest({
      boundaryAt: "2026-02-30T03:00:00.000Z",
    })],
    ["null cursor with history", sourceRequest({
      seenCursors: [cursor(2)],
    })],
    ["page two with history", sourceRequest({
      currentCursor: cursor(2),
      seenCursors: [cursor(2)],
    })],
    ["missing page from history", sourceRequest({
      currentCursor: cursor(4),
      seenCursors: [cursor(2)],
    })],
    ["out-of-order history", sourceRequest({
      currentCursor: cursor(4),
      seenCursors: [cursor(3), cursor(2)],
    })],
    ["duplicate history", sourceRequest({
      currentCursor: cursor(4),
      seenCursors: [cursor(2), cursor(2)],
    })],
    ["current cursor already seen", sourceRequest({
      currentCursor: cursor(3),
      seenCursors: [cursor(3)],
    })],
    ...malformedCursorCases
      .filter((value) => value !== null)
      .map((value, index) => [
        `malformed cursor ${index + 1}`,
        sourceRequest({ currentCursor: value }),
      ]),
  ];

  for (const [name, value] of cases) {
    await t.test(name, async () => {
      let fetchCount = 0;
      await expectCode(
        () => readPrivateRecallSourcePage(
          value,
          dependencies(async () => {
            fetchCount += 1;
            return jsonResponse(page());
          }),
        ),
        "SOURCE_RECALL_PAGE_REQUEST_INVALID",
      );
      assert.equal(fetchCount, 0);
    });
  }

  await t.test("history is capped", async () => {
    const history = Array.from(
      { length: 201 },
      (_unused, index) => cursor(index + 2),
    );
    let fetchCount = 0;
    await expectCode(
      () => readPrivateRecallSourcePage(
        sourceRequest({
          currentCursor: cursor(203),
          seenCursors: history,
        }),
        dependencies(async () => {
          fetchCount += 1;
          return jsonResponse(page());
        }),
      ),
      "SOURCE_RECALL_PAGE_REQUEST_INVALID",
    );
    assert.equal(fetchCount, 0);
  });
});

test("all transport and status failures are generic and single-attempt", async (t) => {
  const cases = [
    {
      name: "network rejection",
      fetchImpl: async () => {
        throw new Error(
          `network rejected ${BODY_MARKER} ${SECRET}`,
        );
      },
    },
    {
      name: "null response",
      fetchImpl: async () => null,
    },
    {
      name: "rate limit",
      fetchImpl: async () => jsonResponse(
        { error: `${BODY_MARKER} ${SECRET}` },
        { status: 429 },
      ),
    },
    {
      name: "server error",
      fetchImpl: async () => jsonResponse(
        { error: `${BODY_MARKER} ${SECRET}` },
        { status: 503 },
      ),
    },
    {
      name: "redirect response",
      fetchImpl: async () => jsonResponse(
        { location: `${BODY_MARKER} ${SECRET}` },
        { status: 302 },
      ),
    },
    {
      name: "signal construction rejection",
      fetchImpl: async () => jsonResponse(page()),
      signalFactory: () => {
        throw new Error(`${BODY_MARKER} ${SECRET}`);
      },
    },
  ];

  for (const selected of cases) {
    await t.test(selected.name, async () => {
      let fetchCount = 0;
      let observedError;
      const selectedDependencies = dependencies(
        async (...args) => {
          fetchCount += 1;
          return selected.fetchImpl(...args);
        },
        selected.signalFactory
          ? { signalFactory: selected.signalFactory }
          : {},
      );
      try {
        await readPrivateRecallSourcePage(
          sourceRequest(),
          selectedDependencies,
        );
      } catch (error) {
        observedError = error;
      }
      assert.ok(
        observedError instanceof SourceRecallPageClientError,
      );
      assert.equal(
        observedError.code,
        "SOURCE_RECALL_PAGE_UNAVAILABLE",
      );
      assert.equal(
        observedError.message,
        "SOURCE_RECALL_PAGE_UNAVAILABLE",
      );
      assert.equal(
        observedError.message.includes(BODY_MARKER),
        false,
      );
      assert.equal(observedError.message.includes(SECRET), false);
      assert.equal(fetchCount, selected.signalFactory ? 0 : 1);
    });
  }
});

test("rejects response framing, encoding, and size failures generically", async (t) => {
  const oversizedBody = {
    status: 200,
    headers: {
      get(name) {
        return String(name).toLowerCase() === "content-type"
          ? "application/json"
          : "";
      },
    },
    body: {
      async *[Symbol.asyncIterator]() {
        yield Buffer.alloc(
          SOURCE_RECALL_PAGE_MAX_RESPONSE_BYTES + 1,
          0x20,
        );
      },
    },
  };
  const cases = [
    [
      "missing content type",
      () => jsonResponse(page(), { contentType: null }),
    ],
    [
      "wrong content type",
      () => jsonResponse(page(), {
        contentType: "text/plain",
      }),
    ],
    [
      "wrong charset",
      () => jsonResponse(page(), {
        contentType: "application/json; charset=iso-8859-1",
      }),
    ],
    [
      "unexpected media-type parameter",
      () => jsonResponse(page(), {
        contentType: "application/json; profile=synthetic",
      }),
    ],
    [
      "declared body too large",
      () => jsonResponse(page(), {
        headers: {
          "content-length":
            String(SOURCE_RECALL_PAGE_MAX_RESPONSE_BYTES + 1),
        },
      }),
    ],
    [
      "malformed content length",
      () => jsonResponse(page(), {
        headers: { "content-length": "01" },
      }),
    ],
    [
      "invalid UTF-8",
      () => bytesResponse(Uint8Array.from([0xc3, 0x28])),
    ],
    [
      "invalid JSON",
      () => bytesResponse(
        Buffer.from(`{${BODY_MARKER}`, "utf8"),
      ),
    ],
    [
      "empty body",
      () => ({
        status: 200,
        headers: {
          get(name) {
            return String(name).toLowerCase() === "content-type"
              ? "application/json"
              : "";
          },
        },
        body: null,
      }),
    ],
    [
      "unsupported body reader",
      () => ({
        status: 200,
        headers: {
          get(name) {
            return String(name).toLowerCase() === "content-type"
              ? "application/json"
              : "";
          },
        },
        body: {},
      }),
    ],
    ["streamed body too large", () => oversizedBody],
  ];

  for (const [name, responseFactory] of cases) {
    await t.test(name, async () => {
      let fetchCount = 0;
      let observedError;
      try {
        await readPrivateRecallSourcePage(
          sourceRequest(),
          dependencies(async () => {
            fetchCount += 1;
            return responseFactory();
          }),
        );
      } catch (error) {
        observedError = error;
      }
      assert.ok(
        observedError instanceof SourceRecallPageClientError,
      );
      assert.equal(
        observedError.code,
        "SOURCE_RECALL_PAGE_UNAVAILABLE",
      );
      assert.equal(observedError.message.includes(BODY_MARKER),
        false);
      assert.equal(fetchCount, 1);
    });
  }
});

test("requires the exact page response and consecutive terminal semantics", async (t) => {
  const cases = [
    ["null response record", null],
    ["array response record", []],
    ["missing response key", (() => {
      const value = page();
      delete value.scanned;
      return value;
    })()],
    ["extra response key", {
      ...page(),
      debug: BODY_MARKER,
    }],
    ["wrong response version", page({
      version: "paraai-recall-source-page-v2",
    })],
    ["wrong response boundary", page({
      boundaryAt: "2026-07-26T03:00:00.001Z",
    })],
    ["nonboolean exhausted", page({ exhausted: 1 })],
    ["negative scanned", page({ scanned: -1 })],
    ["fractional scanned", page({ scanned: 1.5 })],
    ["scanned beyond page size", page({
      scanned: SOURCE_RECALL_PAGE_SIZE + 1,
    })],
    ["references exceed scanned", page({
      scanned: 1,
      references: [reference(1), reference(2)],
    })],
    ["terminal page exposes a cursor", page({
      exhausted: true,
      nextCursor: cursor(2),
    })],
    ["nonterminal page omits cursor", page({
      exhausted: false,
      nextCursor: null,
    })],
    ["next cursor skips a page", page({
      exhausted: false,
      nextCursor: cursor(3),
    })],
    ["next cursor has wrong boundary", page({
      exhausted: false,
      nextCursor: cursor(
        2,
        "2026-07-26T03:00:00.001Z",
      ),
    })],
    ["next cursor has extra query input", page({
      exhausted: false,
      nextCursor: `${cursor(2)}&limit=1`,
    })],
    ["reference array contains a hole after JSON parse", page({
      scanned: 1,
      references: [null],
    })],
  ];

  for (const [name, payload] of cases) {
    await t.test(name, async () => {
      let fetchCount = 0;
      await expectCode(
        () => readPrivateRecallSourcePage(
          sourceRequest(),
          dependencies(async () => {
            fetchCount += 1;
            return jsonResponse(payload);
          }),
        ),
        "SOURCE_RECALL_PAGE_UNAVAILABLE",
      );
      assert.equal(fetchCount, 1);
    });
  }

  await t.test("rejects a cycle against the current cursor", async () => {
    let fetchCount = 0;
    await expectCode(
      () => readPrivateRecallSourcePage(
        sourceRequest({
          currentCursor: cursor(3),
          seenCursors: [cursor(2)],
        }),
        dependencies(async () => {
          fetchCount += 1;
          return jsonResponse(page({
            exhausted: false,
            nextCursor: cursor(3),
          }));
        }),
      ),
      "SOURCE_RECALL_PAGE_UNAVAILABLE",
    );
    assert.equal(fetchCount, 1);
  });

  await t.test("accepts only the consecutive next cursor", async () => {
    const result = await readPrivateRecallSourcePage(
      sourceRequest({
        currentCursor: cursor(3),
        seenCursors: [cursor(2)],
      }),
      dependencies(async () => jsonResponse(page({
        exhausted: false,
        nextCursor: cursor(4),
      }))),
    );
    assert.equal(result.nextCursor, cursor(4));
  });
});

test("validates every reference, candidate field, duplicate, and join ordering", async (t) => {
  const badReferenceCases = [
    ["missing reference key", (() => {
      const value = reference();
      delete value.metadataSource;
      return value;
    })()],
    ["extra reference key", {
      ...reference(),
      responseBody: BODY_MARKER,
    }],
    ["short reference id", reference(1, { id: "abcd" })],
    ["invalid reference id", reference(1, {
      id: "synthetic.bot.00001",
    })],
    ["overlong reference id", reference(1, {
      id: "a".repeat(129),
    })],
    ["join at boundary", reference(1, {
      joinAt: BOUNDARY,
    })],
    ["join after boundary", reference(1, {
      joinAt: "2026-07-26T03:00:00.001Z",
    })],
    ["noncanonical join timestamp", reference(1, {
      joinAt: "2026-07-25T02:00:00Z",
    })],
    ["unrecognized metadata source", reference(1, {
      metadataSource: "synthetic-unknown",
    })],
    ["missing candidate key", reference(1, {
      candidate: (() => {
        const value = candidate();
        delete value.linkedin;
        return value;
      })(),
    })],
    ["extra candidate key", reference(1, {
      candidate: {
        ...candidate(),
        raw: BODY_MARKER,
      },
    })],
    ["uppercase email", reference(1, {
      candidate: candidate({
        email: "Synthetic.Person@example.test",
      }),
    })],
    ["leading candidate whitespace", reference(1, {
      candidate: candidate({
        fullName: " Synthetic Person",
      }),
    })],
    ["candidate control character", reference(1, {
      candidate: candidate({
        paraformEventId: "synthetic\u0000event",
      }),
    })],
    ["candidate non-string", reference(1, {
      candidate: candidate({ linkedin: null }),
    })],
    ["overlong candidate value", reference(1, {
      candidate: candidate({ fullName: "s".repeat(513) }),
    })],
  ];

  for (const [name, selectedReference] of badReferenceCases) {
    await t.test(name, async () => {
      await expectCode(
        () => readPrivateRecallSourcePage(
          sourceRequest(),
          dependencies(async () => jsonResponse(page({
            references: [selectedReference],
          }))),
        ),
        "SOURCE_RECALL_PAGE_UNAVAILABLE",
      );
    });
  }

  await t.test("duplicate reference IDs fail closed", async () => {
    await expectCode(
      () => readPrivateRecallSourcePage(
        sourceRequest(),
        dependencies(async () => jsonResponse(page({
          scanned: 2,
          references: [reference(1), reference(1)],
        }))),
      ),
      "SOURCE_RECALL_PAGE_UNAVAILABLE",
    );
  });

  await t.test("ascending join order fails closed", async () => {
    await expectCode(
      () => readPrivateRecallSourcePage(
        sourceRequest(),
        dependencies(async () => jsonResponse(page({
          scanned: 2,
          references: [
            reference(1, {
              joinAt: "2026-07-24T02:00:00.000Z",
            }),
            reference(2, {
              joinAt: "2026-07-25T02:00:00.000Z",
            }),
          ],
        }))),
      ),
      "SOURCE_RECALL_PAGE_UNAVAILABLE",
    );
  });

  await t.test("all captured metadata sources are recognized", async () => {
    const sources = [
      "paraform-auto",
      "paraform-auto-guardian",
      "paraform-reconciliation",
      "paraform-reconciliation-guardian",
      "fyxer-guardian-n8n",
      "fyxer-guardian-n8n-guardian",
    ];
    for (const metadataSource of sources) {
      const result = await readPrivateRecallSourcePage(
        sourceRequest(),
        dependencies(async () => jsonResponse(page({
          references: [reference(1, { metadataSource })],
        }))),
      );
      assert.equal(result.references[0].metadataSource,
        metadataSource);
    }
  });
});

test("enforces exact candidate field maxima and lower-case email", async (t) => {
  const fieldCases = [
    ["fullName", 512, "f"],
    ["email", 512, "e"],
    ["linkedin", 4_096, "l"],
    ["paraformEventId", 1_024, "p"],
  ];

  for (const [field, maximum, character] of fieldCases) {
    await t.test(`${field} accepts exactly ${maximum} characters`, async () => {
      const value = character.repeat(maximum);
      const result = await readPrivateRecallSourcePage(
        sourceRequest(),
        dependencies(async () => jsonResponse(page({
          references: [reference(1, {
            candidate: candidate({ [field]: value }),
          })],
        }))),
      );
      assert.equal(result.references[0].candidate[field], value);
    });

    await t.test(`${field} rejects ${maximum + 1} characters`, async () => {
      await expectCode(
        () => readPrivateRecallSourcePage(
          sourceRequest(),
          dependencies(async () => jsonResponse(page({
            references: [reference(1, {
              candidate: candidate({
                [field]: character.repeat(maximum + 1),
              }),
            })],
          }))),
        ),
        "SOURCE_RECALL_PAGE_UNAVAILABLE",
      );
    });
  }

  await t.test("preserves an already lower-case email", async () => {
    const email = "lower-case.synthetic@example.test";
    const result = await readPrivateRecallSourcePage(
      sourceRequest(),
      dependencies(async () => jsonResponse(page({
        references: [reference(1, {
          candidate: candidate({ email }),
        })],
      }))),
    );
    assert.equal(result.references[0].candidate.email, email);
  });
});

test("returns only the deeply frozen normalized private page and never signing internals", async () => {
  const result = await readPrivateRecallSourcePage(
    sourceRequest(),
    dependencies(async () => jsonResponse(page())),
  );

  assert.deepEqual(Object.keys(result), [
    "version",
    "boundaryAt",
    "exhausted",
    "nextCursor",
    "scanned",
    "references",
  ]);
  assert.deepEqual(Object.keys(result.references[0]), [
    "id",
    "joinAt",
    "metadataSource",
    "candidate",
  ]);
  assert.deepEqual(
    Object.keys(result.references[0].candidate),
    [
      "fullName",
      "email",
      "linkedin",
      "paraformEventId",
    ],
  );
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.references), true);
  assert.equal(Object.isFrozen(result.references[0]), true);
  assert.equal(
    Object.isFrozen(result.references[0].candidate),
    true,
  );
  assert.throws(() => {
    result.references[0].candidate.email =
      "changed@example.test";
  }, TypeError);
  assert.equal(
    result.references[0].candidate.email,
    "synthetic.person@example.test",
  );

  const serialized = JSON.stringify(result);
  for (const forbidden of [
    SECRET,
    "x-raydar-signature",
    "x-raydar-timestamp",
    "rawBody",
    SOURCE_RECALL_PAGE_URL,
    "headers",
  ]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
});
