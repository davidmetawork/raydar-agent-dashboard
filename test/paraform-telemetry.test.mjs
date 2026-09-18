import assert from "node:assert/strict";
import test from "node:test";

import {
  createTelemetryFetch,
  flushTelemetry,
  heartbeatTelemetry,
} from "../api/_lib/paraform-telemetry.mjs";

const ENV = Object.freeze({
  PARAFORM_TELEMETRY_URL: "https://raydar-paraform-traffic.david183940.chatgpt.site/api/ingest",
  PARAFORM_TELEMETRY_TOKEN: "source-secret",
  PARAFORM_TELEMETRY_DISPATCH_TOKEN: "dispatch-secret",
});

function uuidSequence() {
  let value = 0;
  return () => `00000000-0000-4000-8000-${String(++value).padStart(12, "0")}`;
}

function collector() {
  const calls = [];
  return {
    calls,
    fetch: async (url, init) => {
      calls.push({ url: String(url), init, body: JSON.parse(init.body) });
      return new Response(null, { status: 204 });
    },
  };
}

function finished(calls) {
  return calls.flatMap((call) => call.body.events).find((event) => event.phase === "finished");
}

test("disabled telemetry is an exact one-call pass-through", async () => {
  const expected = new Response("ok", { status: 200 });
  let calls = 0;
  const wrapped = createTelemetryFetch({
    fetchImpl: async () => { calls += 1; return expected; },
    env: {},
    telemetryFetchImpl: async () => { throw new Error("must not run"); },
  });
  const actual = await wrapped("https://www.paraform.com/api/user");
  assert.equal(actual, expected);
  assert.equal(calls, 1);
  assert.equal(wrapped.snapshot().enabled, false);
});

test("collector credentials are disabled for any noncanonical ingest URL", () => {
  for (const url of [
    "https://example.com/api/ingest",
    `${ENV.PARAFORM_TELEMETRY_URL}?redirect=1`,
    "http://raydar-paraform-traffic.david183940.chatgpt.site/api/ingest",
  ]) {
    const wrapped = createTelemetryFetch({
      fetchImpl: async () => new Response("ok"),
      sourceId: "unit-source",
      env: { ...ENV, PARAFORM_TELEMETRY_URL: url },
      uuidImpl: uuidSequence(),
    });
    assert.equal(wrapped.snapshot().enabled, false);
  }
});

test("non-Paraform requests pass through without telemetry", async () => {
  const sink = collector();
  let calls = 0;
  const wrapped = createTelemetryFetch({
    fetchImpl: async () => { calls += 1; return new Response("ok"); },
    sourceId: "unit-source",
    env: ENV,
    telemetryFetchImpl: sink.fetch,
    uuidImpl: uuidSequence(),
  });
  await wrapped("https://storage.googleapis.com/paraform-resumes-new/object");
  await flushTelemetry(wrapped);
  assert.equal(calls, 1);
  assert.equal(sink.calls.length, 1);
  assert.deepEqual(sink.calls[0].body.events, []);
});

test("successful tRPC response is observed without consuming or replacing its body", async () => {
  const sink = collector();
  const expected = new Response(JSON.stringify({ result: { data: { json: { id: "private" } } } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
  const wrapped = createTelemetryFetch({
    fetchImpl: async () => expected,
    sourceId: "match-watch-v3",
    env: ENV,
    telemetryFetchImpl: sink.fetch,
    uuidImpl: uuidSequence(),
  });
  const actual = await wrapped(
    "https://www.paraform.com/api/trpc/candidateUser.getCandidateProfileInfo?input=SECRET-CANDIDATE",
    { headers: { cookie: "wos-session=SECRET-COOKIE" } },
  );
  assert.equal(actual, expected);
  assert.deepEqual(await actual.json(), { result: { data: { json: { id: "private" } } } });
  await wrapped.flush();

  assert.equal(sink.calls.length, 1);
  assert.equal(sink.calls[0].init.headers.authorization, "Bearer source-secret");
  assert.equal(sink.calls[0].init.headers["OAI-Sites-Authorization"], "Bearer dispatch-secret");
  assert.equal(sink.calls[0].body.sourceId, "match-watch-v3");
  assert.equal(sink.calls[0].body.events.length, 2);
  assert.equal(sink.calls[0].body.events[0].id, sink.calls[0].body.events[1].id);
  assert.deepEqual(
    finished(sink.calls),
    {
      id: "00000000-0000-4000-8000-000000000002",
      phase: "finished",
      startedAt: sink.calls[0].body.events[0].startedAt,
      completedAt: finished(sink.calls).completedAt,
      method: "GET",
      endpoint: "candidateUser.getCandidateProfileInfo",
      outcome: "successful",
      httpStatus: 200,
      errorClass: "none",
      retryAfterSeconds: null,
    },
  );
  const serialized = sink.calls[0].init.body;
  assert.doesNotMatch(serialized, /SECRET-CANDIDATE|SECRET-COOKIE|private/u);
});

test("HTTP 200 tRPC rate-limit errors override HTTP success", async () => {
  const sink = collector();
  const wrapped = createTelemetryFetch({
    fetchImpl: async () => new Response(JSON.stringify({
      error: { json: { message: "Too many requests", data: { code: "TOO_MANY_REQUESTS", retryAfter: 13 } } },
    }), { status: 200 }),
    sourceId: "lifecycle",
    env: ENV,
    telemetryFetchImpl: sink.fetch,
    uuidImpl: uuidSequence(),
  });
  await wrapped("https://www.paraform.com/api/trpc/user.getCurrentUser");
  await wrapped.flush();
  assert.equal(finished(sink.calls).outcome, "rate_limited");
  assert.equal(finished(sink.calls).errorClass, "rate_limit");
  assert.equal(finished(sink.calls).httpStatus, 200);
  assert.equal(finished(sink.calls).retryAfterSeconds, 13);
});

test("HTTP 200 tRPC auth errors remain distinct from generic tRPC failures", async () => {
  const sink = collector();
  const wrapped = createTelemetryFetch({
    fetchImpl: async () => new Response(JSON.stringify({
      error: { json: { message: "Unauthorized", data: { code: "UNAUTHORIZED", httpStatus: 401 } } },
    }), { status: 200 }),
    sourceId: "applicant-core",
    env: ENV,
    telemetryFetchImpl: sink.fetch,
    uuidImpl: uuidSequence(),
  });
  await wrapped("https://www.paraform.com/api/trpc/user.getCurrentUser");
  await wrapped.flush();
  assert.equal(finished(sink.calls).outcome, "other_failure");
  assert.equal(finished(sink.calls).errorClass, "auth_access");
  assert.equal(finished(sink.calls).httpStatus, 200);
});

test("known REST JSON is successful while unknown REST remains unverified", async () => {
  for (const [path, expectedOutcome] of [
    ["/api/user", "successful"],
    ["/api/future/opaque-route?candidate=SECRET", "unverified"],
  ]) {
    const sink = collector();
    const wrapped = createTelemetryFetch({
      fetchImpl: async () => new Response(JSON.stringify({ ok: true, candidate: "private" })),
      sourceId: "manual-tools",
      env: ENV,
      telemetryFetchImpl: sink.fetch,
      uuidImpl: uuidSequence(),
    });
    await wrapped(`https://www.paraform.com${path}`);
    await wrapped.flush();
    assert.equal(finished(sink.calls).outcome, expectedOutcome);
    assert.equal(finished(sink.calls).endpoint, path === "/api/user" ? "rest.user" : "rest.unknown");
    assert.doesNotMatch(sink.calls[0].init.body, /SECRET|private/u);
  }
});

test("all exact Paraform hosts are observed and long procedures use a fixed alias", async () => {
  const sink = collector();
  const wrapped = createTelemetryFetch({
    fetchImpl: async () => new Response(JSON.stringify({ result: { data: { json: true } } })),
    sourceId: "code-default",
    env: { ...ENV, PARAFORM_TELEMETRY_SOURCE: "runtime-owner" },
    telemetryFetchImpl: sink.fetch,
    uuidImpl: uuidSequence(),
  });
  for (const host of ["www.paraform.com", "paraform.com", "api.paraform.com"]) {
    await wrapped(`https://${host}/api/trpc/router.${"x".repeat(130)}`);
  }
  await wrapped.flush();
  assert.equal(sink.calls[0].body.sourceId, "runtime-owner");
  const finishedEvents = sink.calls.flatMap((call) => call.body.events)
    .filter((event) => event.phase === "finished");
  assert.deepEqual(finishedEvents.map((event) => event.endpoint), [
    "trpc.unknown",
    "trpc.unknown",
    "trpc.unknown",
  ]);
});

test("HTTP 429 is rate limited with numeric Retry-After only", async () => {
  const sink = collector();
  const wrapped = createTelemetryFetch({
    fetchImpl: async () => new Response("arbitrary private body", {
      status: 429,
      headers: { "retry-after": "7", "x-private-debug": "SECRET" },
    }),
    sourceId: "scheduler",
    env: ENV,
    telemetryFetchImpl: sink.fetch,
    uuidImpl: uuidSequence(),
  });
  await wrapped("https://www.paraform.com/api/trpc/user.getCurrentUser");
  await wrapped.flush();
  assert.equal(finished(sink.calls).outcome, "rate_limited");
  assert.equal(finished(sink.calls).retryAfterSeconds, 7);
  assert.doesNotMatch(sink.calls[0].init.body, /SECRET|arbitrary private body/u);
});

test("Retry-After beyond the collector's seven-day cap is omitted", async () => {
  const sink = collector();
  const wrapped = createTelemetryFetch({
    fetchImpl: async () => new Response("rate limited", {
      status: 429,
      headers: { "retry-after": "604801" },
    }),
    sourceId: "scheduler",
    env: ENV,
    telemetryFetchImpl: sink.fetch,
    uuidImpl: uuidSequence(),
  });
  await wrapped("https://www.paraform.com/api/trpc/user.getCurrentUser");
  await wrapped.flush();
  assert.equal(finished(sink.calls).retryAfterSeconds, null);
});

test("transport errors are classified and rethrown by identity", async () => {
  const sink = collector();
  const original = Object.assign(new Error("private network detail"), { code: "ECONNRESET" });
  const wrapped = createTelemetryFetch({
    fetchImpl: async () => { throw original; },
    sourceId: "applicant-hub",
    env: ENV,
    telemetryFetchImpl: sink.fetch,
    uuidImpl: uuidSequence(),
  });
  await assert.rejects(
    wrapped("https://www.paraform.com/api/trpc/user.getCurrentUser"),
    (error) => error === original,
  );
  await wrapped.flush();
  assert.equal(finished(sink.calls).outcome, "other_failure");
  assert.equal(finished(sink.calls).errorClass, "network");
  assert.equal(finished(sink.calls).httpStatus, null);
  assert.doesNotMatch(sink.calls[0].init.body, /private network detail|ECONNRESET/u);
});

test("timeout errors are classified without changing the thrown object", async () => {
  const sink = collector();
  const original = new DOMException("timed out", "TimeoutError");
  const wrapped = createTelemetryFetch({
    fetchImpl: async () => { throw original; },
    sourceId: "webview",
    env: ENV,
    telemetryFetchImpl: sink.fetch,
    uuidImpl: uuidSequence(),
  });
  await assert.rejects(
    wrapped("https://www.paraform.com/api/trpc/user.getCurrentUser"),
    (error) => error === original,
  );
  await wrapped.flush();
  assert.equal(finished(sink.calls).errorClass, "timeout");
});

test("malformed and over-limit tRPC bodies are not reported as successful", async () => {
  for (const [body, expectedOutcome, expectedClass] of [
    ["not json", "other_failure", "parse"],
    ["x".repeat(70 * 1024), "unverified", "unverified"],
  ]) {
    const sink = collector();
    const wrapped = createTelemetryFetch({
      fetchImpl: async () => new Response(body, { status: 200 }),
      sourceId: "bounded-body",
      env: ENV,
      telemetryFetchImpl: sink.fetch,
      uuidImpl: uuidSequence(),
    });
    const response = await wrapped("https://www.paraform.com/api/trpc/user.getCurrentUser");
    assert.equal((await response.text()).length, body.length);
    await wrapped.flush();
    assert.equal(finished(sink.calls).outcome, expectedOutcome);
    assert.equal(finished(sink.calls).errorClass, expectedClass);
  }
});

test("collector failure is swallowed and counted as telemetry loss", async () => {
  const providerResponse = new Response(JSON.stringify({ result: { data: { json: true } } }));
  const wrapped = createTelemetryFetch({
    fetchImpl: async () => providerResponse,
    sourceId: "fail-open",
    env: ENV,
    telemetryFetchImpl: async () => { throw new Error("collector unavailable"); },
    uuidImpl: uuidSequence(),
  });
  assert.equal(
    await wrapped("https://www.paraform.com/api/trpc/user.getCurrentUser"),
    providerResponse,
  );
  const state = await wrapped.flush();
  assert.equal(state.collectorFailures, 1);
  assert.equal(state.dropped, 2);
  assert.equal(state.queued, 0);
});

test("each invocation gets a new attempt id and collector batches stay at 32", async () => {
  const sink = collector();
  const wrapped = createTelemetryFetch({
    fetchImpl: async () => new Response(JSON.stringify({ result: { data: { json: true } } })),
    sourceId: "bounded-batches",
    env: ENV,
    telemetryFetchImpl: sink.fetch,
    uuidImpl: uuidSequence(),
  });
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await wrapped("https://www.paraform.com/api/trpc/user.getCurrentUser");
  }
  await wrapped.flush();
  assert.deepEqual(sink.calls.map((call) => call.body.events.length), [32, 8]);
  const events = sink.calls.flatMap((call) => call.body.events);
  const ids = new Set(events.map((event) => event.id));
  assert.equal(ids.size, 20);
  for (const id of ids) assert.equal(events.filter((event) => event.id === id).length, 2);
});

test("explicit flush drains events queued during an active collector post", async () => {
  let releaseFirst;
  let collectorCalls = 0;
  const payloads = [];
  const firstPending = new Promise((resolve) => { releaseFirst = resolve; });
  const wrapped = createTelemetryFetch({
    fetchImpl: async () => new Response(JSON.stringify({ result: { data: { json: true } } })),
    sourceId: "flush-race",
    env: ENV,
    telemetryFetchImpl: async (_url, init) => {
      collectorCalls += 1;
      payloads.push(JSON.parse(init.body));
      if (collectorCalls === 1) await firstPending;
      return new Response(null, { status: 204 });
    },
    uuidImpl: uuidSequence(),
  });
  await wrapped("https://www.paraform.com/api/trpc/user.getCurrentUser");
  const flushing = wrapped.flush();
  await new Promise((resolve) => setImmediate(resolve));
  await wrapped("https://www.paraform.com/api/trpc/user.getCurrentUser");
  releaseFirst();
  const state = await flushing;
  assert.equal(state.queued, 0);
  assert.deepEqual(payloads.map((payload) => payload.events.length), [2, 2]);
});

test("stalled clone inspection reaches a real deadline and reports unverified", async () => {
  const sink = collector();
  const stalled = new ReadableStream({
    pull() { return new Promise(() => {}); },
    cancel() { return new Promise(() => {}); },
  });
  const wrapped = createTelemetryFetch({
    fetchImpl: async () => new Response(stalled, { status: 200 }),
    sourceId: "stalled-inspection",
    env: ENV,
    telemetryFetchImpl: sink.fetch,
    uuidImpl: uuidSequence(),
  });
  const before = Date.now();
  await wrapped("https://www.paraform.com/api/trpc/user.getCurrentUser");
  assert.ok(Date.now() - before < 500);
  await wrapped.flush();
  assert.equal(finished(sink.calls).outcome, "unverified");
  assert.equal(finished(sink.calls).errorClass, "unverified");
});

test("heartbeats and convenience helpers use the exact wire state", async () => {
  const sink = collector();
  const wrapped = createTelemetryFetch({
    fetchImpl: async () => new Response("unused"),
    sourceId: "heartbeat-source",
    env: ENV,
    telemetryFetchImpl: sink.fetch,
    uuidImpl: uuidSequence(),
  });
  const state = await heartbeatTelemetry(wrapped, "idle");
  assert.equal(state.heartbeatState, "idle");
  assert.deepEqual(sink.calls[0].body.events, []);
  assert.deepEqual(sink.calls[0].body.heartbeat, { state: "idle", dropped: 0 });
  assert.equal((await flushTelemetry(null)).enabled, false);
});
