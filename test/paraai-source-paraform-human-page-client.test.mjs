import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";

import {
  SOURCE_PARAFORM_HUMAN_PAGE_CLIENT_VERSION,
  SOURCE_PARAFORM_HUMAN_PAGE_MAX_RESPONSE_BYTES,
  SOURCE_PARAFORM_HUMAN_PAGE_PATH,
  SOURCE_PARAFORM_HUMAN_PAGE_SIZE,
  SOURCE_PARAFORM_HUMAN_PAGE_TIMEOUT_MS,
  SOURCE_PARAFORM_HUMAN_PAGE_URL,
  SOURCE_PARAFORM_HUMAN_PAGE_VERSION,
  SourceParaformHumanPageClientError,
  assertPrivateParaformHumanSourcePageResult,
  readPrivateParaformHumanSourcePage,
} from "../api/paraai/_lib/source-paraform-human-page-client.mjs";

const BOUNDARY = "2026-07-26T03:00:00.000Z";
const SCHEDULED_AT = "2026-07-25T02:00:00.000Z";
const CREATED_AT = "2026-07-24T02:00:00.000Z";
const NOW_MS = Date.parse("2026-07-26T03:00:01.000Z");
const TIMESTAMP = String(Math.floor(NOW_MS / 1_000));
const SECRET = "synthetic-paraform-page-secret".padEnd(48, "s");
const SIGNAL = Object.freeze({ syntheticAbortSignal: true });
const PRIVATE_MARKER = "private-candidate-marker";

function checkpoint(cursor) {
  return {
    version: SOURCE_PARAFORM_HUMAN_PAGE_VERSION,
    boundaryAt: BOUNDARY,
    cursor,
  };
}

function request(overrides = {}) {
  return {
    boundaryAt: BOUNDARY,
    checkpoint: null,
    ...overrides,
  };
}

function reference(index = 1, overrides = {}) {
  return {
    id: `meeting-private-${index}`,
    scheduledAt: SCHEDULED_AT,
    createdAt: CREATED_AT,
    title: "Private Candidate / Recruiter",
    platform: "PHONE",
    recordingProvider: "TWILIO",
    owner: "Private Recruiter",
    ownerId: "private-owner-id",
    candidateUserId: `private-candidate-user-${index}`,
    hasTranscript: true,
    humanCall: true,
    candidate: {
      name: "Private Candidate",
      linkedin: "private-candidate",
      emails: ["private.candidate@example.invalid"],
    },
    ...overrides,
  };
}

function page(overrides = {}) {
  return {
    version: SOURCE_PARAFORM_HUMAN_PAGE_VERSION,
    boundaryAt: BOUNDARY,
    exhausted: true,
    nextCheckpoint: null,
    scanned: 1,
    outsideBoundary: 0,
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

function dependencies(fetchImpl, overrides = {}) {
  return {
    fetchImpl,
    nowImpl: () => NOW_MS,
    secret: SECRET,
    signalFactory: (timeoutMs) => {
      assert.equal(
        timeoutMs,
        SOURCE_PARAFORM_HUMAN_PAGE_TIMEOUT_MS,
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
      error instanceof SourceParaformHumanPageClientError
      && error.name === "SourceParaformHumanPageClientError"
      && error.code === code
      && error.message === code
    ),
  );
}

test("pins exact bytes, webview target, HMAC, and one POST", async () => {
  const calls = [];
  const input = request();
  const rawBody = JSON.stringify(input);
  const expectedSignature = `v1=${createHmac(
    "sha256",
    SECRET,
  )
    .update(
      (
        `${TIMESTAMP}.POST.`
        + `${SOURCE_PARAFORM_HUMAN_PAGE_PATH}.${rawBody}`
      ),
      "utf8",
    )
    .digest("hex")}`;

  const result = await readPrivateParaformHumanSourcePage(
    input,
    dependencies(async (...args) => {
      calls.push(args);
      return jsonResponse(page());
    }),
  );

  assert.equal(
    SOURCE_PARAFORM_HUMAN_PAGE_CLIENT_VERSION,
    "paraform-human-private-page-client-v1",
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], SOURCE_PARAFORM_HUMAN_PAGE_URL);
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
  assert.equal(result.references.length, 1);
});

test("normalizes one exact consecutive checkpoint", async () => {
  const calls = [];
  const result = await readPrivateParaformHumanSourcePage(
    request({ checkpoint: checkpoint(50) }),
    dependencies(async (...args) => {
      calls.push(args);
      return jsonResponse(page({
        exhausted: false,
        nextCheckpoint: checkpoint(100),
        scanned: 50,
        outsideBoundary: 49,
      }));
    }),
  );
  assert.equal(
    calls[0][1].body,
    JSON.stringify(request({ checkpoint: checkpoint(50) })),
  );
  assert.deepEqual(result.nextCheckpoint, checkpoint(100));
  assert.equal(result.exhausted, false);
});

test("missing config and hostile requests fail before transport", async (t) => {
  for (const [name, secret] of [
    ["missing", undefined],
    ["short", "too-short"],
    ["blank", " ".repeat(40)],
  ]) {
    await t.test(name, async () => {
      let calls = 0;
      await expectCode(
        () => readPrivateParaformHumanSourcePage(
          request(),
          dependencies(async () => {
            calls += 1;
          }, { secret }),
        ),
        "SOURCE_PARAFORM_HUMAN_PAGE_CLIENT_NOT_CONFIGURED",
      );
      assert.equal(calls, 0);
    });
  }

  const accessor = Object.defineProperty(
    { checkpoint: null },
    "boundaryAt",
    {
      enumerable: true,
      get() {
        throw new Error("must not execute");
      },
    },
  );
  const cases = [
    null,
    [],
    new Proxy(request(), {}),
    accessor,
    { ...request(), force: true },
    { boundaryAt: BOUNDARY },
    request({ boundaryAt: "2026-07-26T03:00:00Z" }),
    request({ checkpoint: {
      ...checkpoint(50),
      cursor: 0,
    } }),
    request({ checkpoint: {
      ...checkpoint(50),
      boundaryAt: "2026-07-26T03:00:00.001Z",
    } }),
    request({ checkpoint: {
      ...checkpoint(50),
      limit: 1,
    } }),
  ];
  for (const [index, value] of cases.entries()) {
    await t.test(`hostile request ${index + 1}`, async () => {
      let calls = 0;
      await expectCode(
        () => readPrivateParaformHumanSourcePage(
          value,
          dependencies(async () => {
            calls += 1;
          }),
        ),
        "SOURCE_PARAFORM_HUMAN_PAGE_REQUEST_INVALID",
      );
      assert.equal(calls, 0);
    });
  }
});

test("transport, framing, and source failures are generic and single-attempt", async (t) => {
  const oversized = {
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
          SOURCE_PARAFORM_HUMAN_PAGE_MAX_RESPONSE_BYTES + 1,
          0x20,
        );
      },
    },
  };
  const cases = [
    ["network", async () => {
      throw new Error(`${PRIVATE_MARKER} ${SECRET}`);
    }],
    ["null", async () => null],
    ["503", async () => jsonResponse(
      { error: PRIVATE_MARKER },
      { status: 503 },
    )],
    ["wrong media", async () => jsonResponse(
      page(),
      { contentType: "text/plain" },
    )],
    ["invalid JSON", async () => new Response(
      `{${PRIVATE_MARKER}`,
      { headers: { "content-type": "application/json" } },
    )],
    ["declared overflow", async () => jsonResponse(page(), {
      headers: {
        "content-length": String(
          SOURCE_PARAFORM_HUMAN_PAGE_MAX_RESPONSE_BYTES + 1,
        ),
      },
    })],
    ["stream overflow", async () => oversized],
  ];
  for (const [name, fetchImpl] of cases) {
    await t.test(name, async () => {
      let calls = 0;
      let observed;
      try {
        await readPrivateParaformHumanSourcePage(
          request(),
          dependencies(async (...args) => {
            calls += 1;
            return fetchImpl(...args);
          }),
        );
      } catch (error) {
        observed = error;
      }
      assert.ok(
        observed instanceof SourceParaformHumanPageClientError,
      );
      assert.equal(
        observed.code,
        "SOURCE_PARAFORM_HUMAN_PAGE_UNAVAILABLE",
      );
      assert.equal(observed.message.includes(PRIVATE_MARKER), false);
      assert.equal(observed.message.includes(SECRET), false);
      assert.equal(calls, 1);
    });
  }
});

test("requires exact response counts and checkpoint semantics", async (t) => {
  const cases = [
    null,
    [],
    { ...page(), debug: PRIVATE_MARKER },
    (() => {
      const value = page();
      delete value.scanned;
      return value;
    })(),
    page({ version: "paraai-paraform-human-source-page-v1" }),
    page({ boundaryAt: "2026-07-26T03:00:00.001Z" }),
    page({ exhausted: false, nextCheckpoint: null }),
    page({ exhausted: true, nextCheckpoint: checkpoint(50) }),
    page({
      exhausted: false,
      nextCheckpoint: checkpoint(51),
      scanned: 50,
    }),
    page({
      exhausted: false,
      nextCheckpoint: checkpoint(50),
      scanned: 0,
      references: [],
    }),
    page({ scanned: SOURCE_PARAFORM_HUMAN_PAGE_SIZE + 1 }),
    page({ outsideBoundary: 2 }),
    page({
      scanned: 1,
      outsideBoundary: 1,
      references: [reference()],
    }),
  ];
  for (const [index, payload] of cases.entries()) {
    await t.test(`invalid response ${index + 1}`, async () => {
      await expectCode(
        () => readPrivateParaformHumanSourcePage(
          request(),
          dependencies(async () => jsonResponse(payload)),
        ),
        "SOURCE_PARAFORM_HUMAN_PAGE_UNAVAILABLE",
      );
    });
  }
});

test("validates private references, Human discrimination, and order", async (t) => {
  const invalid = [
    (() => {
      const value = reference();
      delete value.ownerId;
      return value;
    })(),
    { ...reference(), raw: PRIVATE_MARKER },
    reference(1, { id: "" }),
    reference(1, { scheduledAt: BOUNDARY }),
    reference(1, { createdAt: BOUNDARY }),
    reference(1, { platform: "phone" }),
    reference(1, { recordingProvider: "twilio" }),
    reference(1, { humanCall: false }),
    reference(1, { hasTranscript: "yes" }),
    reference(1, { ownerId: null }),
    reference(1, {
      candidate: {
        ...reference().candidate,
        emails: ["Private@Example.invalid"],
      },
    }),
    reference(1, {
      candidate: {
        ...reference().candidate,
        emails: ["x".repeat(513)],
      },
    }),
  ];
  for (const [index, selected] of invalid.entries()) {
    await t.test(`invalid reference ${index + 1}`, async () => {
      await expectCode(
        () => readPrivateParaformHumanSourcePage(
          request(),
          dependencies(async () => jsonResponse(page({
            references: [selected],
          }))),
        ),
        "SOURCE_PARAFORM_HUMAN_PAGE_UNAVAILABLE",
      );
    });
  }

  await t.test("duplicates fail", async () => {
    await expectCode(
      () => readPrivateParaformHumanSourcePage(
        request(),
        dependencies(async () => jsonResponse(page({
          scanned: 2,
          references: [reference(1), reference(1)],
        }))),
      ),
      "SOURCE_PARAFORM_HUMAN_PAGE_UNAVAILABLE",
    );
  });

  await t.test("ascending schedule order fails", async () => {
    await expectCode(
      () => readPrivateParaformHumanSourcePage(
        request(),
        dependencies(async () => jsonResponse(page({
          scanned: 2,
          references: [
            reference(1, {
              scheduledAt: "2026-07-24T02:00:00.000Z",
            }),
            reference(2, {
              scheduledAt: "2026-07-25T02:00:00.000Z",
            }),
          ],
        }))),
      ),
      "SOURCE_PARAFORM_HUMAN_PAGE_UNAVAILABLE",
    );
  });

  await t.test("non-Human records remain visible and exact", async () => {
    const result = await readPrivateParaformHumanSourcePage(
      request(),
      dependencies(async () => jsonResponse(page({
        references: [reference(1, {
          platform: "",
          recordingProvider: "",
          ownerId: "",
          humanCall: false,
          candidateUserId: "",
          hasTranscript: null,
        })],
      }))),
    );
    assert.equal(result.references[0].humanCall, false);
    assert.equal(result.references[0].candidateUserId, "");
  });
});

test("returns only a deeply frozen private page without signing internals", async () => {
  const result = await readPrivateParaformHumanSourcePage(
    request(),
    dependencies(async () => jsonResponse(page())),
  );
  assert.deepEqual(Object.keys(result), [
    "version",
    "boundaryAt",
    "exhausted",
    "nextCheckpoint",
    "scanned",
    "outsideBoundary",
    "references",
  ]);
  assert.deepEqual(Object.keys(result.references[0]), [
    "id",
    "scheduledAt",
    "createdAt",
    "title",
    "platform",
    "recordingProvider",
    "owner",
    "ownerId",
    "candidateUserId",
    "hasTranscript",
    "humanCall",
    "candidate",
  ]);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.references), true);
  assert.equal(Object.isFrozen(result.references[0]), true);
  assert.equal(
    Object.isFrozen(result.references[0].candidate),
    true,
  );
  assert.equal(
    Object.isFrozen(result.references[0].candidate.emails),
    true,
  );
  assert.throws(() => {
    result.references[0].candidateUserId = "changed";
  }, TypeError);
  const serialized = JSON.stringify(result);
  for (const forbidden of [
    SECRET,
    "x-raydar-signature",
    "x-raydar-timestamp",
    "rawBody",
    SOURCE_PARAFORM_HUMAN_PAGE_URL,
    "headers",
  ]) {
    assert.equal(serialized.includes(forbidden), false);
  }
});

test("process-local result provenance rejects clones and cross-request replay", async () => {
  const firstRequest = request();
  const result = await readPrivateParaformHumanSourcePage(
    firstRequest,
    dependencies(async () => jsonResponse(page())),
  );
  assert.equal(
    assertPrivateParaformHumanSourcePageResult(
      result,
      firstRequest,
    ),
    result,
  );
  assert.throws(
    () => assertPrivateParaformHumanSourcePageResult(
      structuredClone(result),
      firstRequest,
    ),
    (error) => (
      error instanceof SourceParaformHumanPageClientError
      && error.code
        === "SOURCE_PARAFORM_HUMAN_PAGE_RESULT_UNTRUSTED"
    ),
  );
  assert.throws(
    () => assertPrivateParaformHumanSourcePageResult(
      result,
      request({ checkpoint: checkpoint(50) }),
    ),
    (error) => (
      error instanceof SourceParaformHumanPageClientError
      && error.code
        === "SOURCE_PARAFORM_HUMAN_PAGE_RESULT_UNTRUSTED"
    ),
  );
});
