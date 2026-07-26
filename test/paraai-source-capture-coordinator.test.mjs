import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  PHASE4_SOURCE_CAPTURE_TICK_MODE,
  SourceCaptureCoordinatorError,
  phase4SourceCaptureDarkStatus,
  runPhase4SourceCaptureTick,
} from "../api/paraai/_lib/source-capture-coordinator.mjs";
import {
  SOURCE_CAPTURE_FRESHNESS_LEASE_MS,
  SOURCE_CAPTURE_HEAD_VERIFICATION_MAX_SPAN_MS,
  claimDarkSourceCaptureStep,
  checkpointTrustedSourceCaptureEvent,
  ensureDarkSourceCaptureRun,
  sourceCaptureAggregateStatus,
  transitionDarkSourceCaptureRecord,
  validateDarkSourceCaptureRecord,
} from "../api/paraai/_lib/source-capture-store.mjs";

const TEST_REDIS_MS = Date.parse("2026-07-26T03:00:00.000Z");
const digest = (character) => character.repeat(64);

process.env.PARAAI_SOURCE_AUTHORITY_KV_REST_API_URL =
  "https://source-capture-kv.test.invalid";
process.env.PARAAI_SOURCE_AUTHORITY_KV_REST_API_TOKEN =
  "source-capture-test-token";
process.env.KV_REST_API_URL =
  "https://source-capture-kv.test.invalid";
process.env.KV_REST_API_TOKEN =
  "source-capture-test-token";
process.env.PARAAI_AUTOMATION_RUNNER_KEY =
  "source-capture-runner-test-key";

function redisParts(nowMs) {
  return [
    String(Math.floor(nowMs / 1_000)),
    String((nowMs % 1_000) * 1_000),
  ];
}

function response(result) {
  return {
    ok: true,
    text: async () => JSON.stringify({ result }),
  };
}

async function withFetch(fake, operation) {
  const saved = globalThis.fetch;
  globalThis.fetch = fake;
  try {
    return await operation();
  } finally {
    globalThis.fetch = saved;
  }
}

async function initialSnapshot(nowMs = TEST_REDIS_MS) {
  return withFetch(async (_url, options) => {
    const command = JSON.parse(options.body);
    assert.equal(command[0], "EVAL");
    assert.match(command[1], /redis\.call\('TIME'\)/u);
    const proposed = JSON.parse(command[5]);
    proposed.decisionBoundaryAtMs = nowMs;
    proposed.createdAtMs = nowMs;
    proposed.updatedAtMs = nowMs;
    proposed.priorCaptureRevisionSha1 = null;
    return response([
      1,
      JSON.stringify(proposed),
      ...redisParts(nowMs),
    ]);
  }, () => ensureDarkSourceCaptureRun());
}

function pageEvent(
  record,
  {
    nextCursorToken = null,
    pageSemanticDigest = digest("a"),
    recordCount = 1,
    sourceHeadEpochDigest = digest("b"),
    sourceHeadRevisionDigest = digest("c"),
    sourceHeadRecordDigest = digest("d"),
    claimNonceDigest = digest("e"),
  } = {},
) {
  return {
    kind: "page_checkpoint",
    claimNonceDigest,
    source: record.activeStep.source,
    passNumber: record.activeStep.passNumber,
    pageNumber: record.activeStep.pageNumber,
    cursorToken: record.activeStep.cursorToken,
    nextCursorToken,
    pageSemanticDigest,
    recordCount,
    sourceHeadEpochDigest,
    sourceHeadRevisionDigest,
    sourceHeadRecordDigest,
  };
}

function headEvent(record, sourceHeadEpochDigest) {
  const source = record.sources[
    record.headVerificationIndex
  ];
  return {
    kind: "head_checkpoint",
    claimNonceDigest: digest("e"),
    source: source.source,
    sourceHeadEpochDigest,
    sourceHeadRevisionDigest:
      source.passes[0].sourceHeadRevisionDigest,
    sourceHeadRecordDigest:
      source.passes[0].sourceHeadRecordDigest,
  };
}

function step(record, event, increment = 1) {
  return transitionDarkSourceCaptureRecord(
    record,
    event,
    record.updatedAtMs + increment,
  );
}

function completeCurrentSource(
  initial,
  {
    pageSemanticDigest,
    sourceHeadEpochDigest,
    recordCount = 1,
  },
) {
  let record = initial;
  record = step(record, pageEvent(record, {
    pageSemanticDigest,
    sourceHeadEpochDigest,
    recordCount,
  }));
  record = step(record, pageEvent(record, {
    pageSemanticDigest,
    sourceHeadEpochDigest,
    recordCount,
  }));
  return record;
}

function completeAllSources(initial) {
  const evidence = [
    {
      pageSemanticDigest: digest("1"),
      sourceHeadEpochDigest: digest("4"),
    },
    {
      pageSemanticDigest: digest("2"),
      sourceHeadEpochDigest: digest("5"),
    },
    {
      pageSemanticDigest: digest("3"),
      sourceHeadEpochDigest: digest("6"),
    },
    {
      pageSemanticDigest: digest("7"),
      sourceHeadEpochDigest: digest("8"),
    },
  ];
  let record = initial;
  for (const sourceEvidence of evidence) {
    record = completeCurrentSource(record, sourceEvidence);
  }
  return { record, evidence };
}

function completeDarkLease(initial) {
  const completed = completeAllSources(initial);
  let record = completed.record;
  for (let round = 0; round < 2; round += 1) {
    for (const item of completed.evidence) {
      record = step(
        record,
        headEvent(record, item.sourceHeadEpochDigest),
      );
    }
  }
  return record;
}

test("runner request is mode-only and rejects every caller selector", async () => {
  let fetchCalled = false;
  const saved = globalThis.fetch;
  globalThis.fetch = async () => {
    fetchCalled = true;
    throw new Error("request validation must run before the store");
  };
  try {
    for (const extra of [
      "candidateIds",
      "sourceIds",
      "boundary",
      "cursor",
      "limit",
      "digest",
      "force",
      "batchSize",
    ]) {
      await assert.rejects(
        runPhase4SourceCaptureTick({
          mode: PHASE4_SOURCE_CAPTURE_TICK_MODE,
          [extra]: null,
        }),
        (error) => (
          error instanceof SourceCaptureCoordinatorError
          && error.code
            === "SOURCE_CAPTURE_CALLER_PARAMETERS_FORBIDDEN"
        ),
      );
    }
    await assert.rejects(
      runPhase4SourceCaptureTick({ mode: "tick" }),
      (error) => (
        error.code
          === "SOURCE_CAPTURE_CALLER_PARAMETERS_FORBIDDEN"
      ),
    );
  } finally {
    globalThis.fetch = saved;
  }
  assert.equal(fetchCalled, false);
});

test("Redis TIME owns one common boundary and server-selected first step", async () => {
  const commands = [];
  const snapshot = await withFetch(async (_url, options) => {
    const command = JSON.parse(options.body);
    commands.push(command);
    const proposed = JSON.parse(command[5]);
    proposed.decisionBoundaryAtMs = TEST_REDIS_MS;
    proposed.createdAtMs = TEST_REDIS_MS;
    proposed.updatedAtMs = TEST_REDIS_MS;
    proposed.priorCaptureRevisionSha1 = null;
    return response([
      1,
      JSON.stringify(proposed),
      ...redisParts(TEST_REDIS_MS),
    ]);
  }, () => ensureDarkSourceCaptureRun());

  assert.equal(commands.length, 1);
  assert.equal(commands[0][0], "EVAL");
  assert.equal(commands[0][2], 2);
  assert.match(commands[0][1], /redis\.call\('TIME'\)/u);
  assert.match(
    commands[0][1],
    /proposed\.decisionBoundaryAtMs = nowMs/u,
  );
  assert.match(
    commands[0][1],
    /proposed\.priorCaptureRevisionSha1[\s\S]*redis\.sha1hex/u,
  );
  assert.match(
    commands[0][1],
    /current\.contractPinsDigest[\s\S]*proposed\.contractPinsDigest/u,
  );
  assert.match(
    commands[0][1],
    /current\.policyVersion ~= proposed\.policyVersion/u,
  );
  assert.equal(snapshot.record.decisionBoundaryAtMs, TEST_REDIS_MS);
  assert.deepEqual(snapshot.record.activeStep, {
    source: "recall",
    passNumber: 1,
    pageNumber: 1,
    cursorToken: null,
  });
  assert.equal(snapshot.record.sources.length, 4);
  assert.equal(
    snapshot.record.sources.every(
      (source) => source.passes.length === 2,
    ),
    true,
  );
});

test("page checkpoint survives serialization and resumes exact cursor", async () => {
  const initial = (await initialSnapshot()).record;
  const afterPageOne = step(
    initial,
    pageEvent(initial, {
      nextCursorToken: "private-resume-cursor",
      pageSemanticDigest: digest("1"),
      sourceHeadEpochDigest: digest("4"),
      recordCount: 2,
    }),
  );
  const resumed = validateDarkSourceCaptureRecord(
    JSON.parse(JSON.stringify(afterPageOne)),
  );
  assert.deepEqual(resumed.activeStep, {
    source: "recall",
    passNumber: 1,
    pageNumber: 2,
    cursorToken: "private-resume-cursor",
  });
  assert.throws(
    () => step(resumed, {
      ...pageEvent(resumed, {
        pageSemanticDigest: digest("2"),
        sourceHeadEpochDigest: digest("4"),
      }),
      cursorToken: "caller-replaced-cursor",
    }),
    (error) => (
      error.code === "SOURCE_CAPTURE_SERVER_SELECTION_MISMATCH"
    ),
  );
  const completed = step(
    resumed,
    pageEvent(resumed, {
      pageSemanticDigest: digest("2"),
      sourceHeadEpochDigest: digest("4"),
    }),
  );
  assert.deepEqual(completed.activeStep, {
    source: "recall",
    passNumber: 2,
    pageNumber: 1,
    cursorToken: null,
  });
  assert.equal(
    completed.sources[0].passes[0].terminalCursorObserved,
    true,
  );
});

test("second pass cannot start early and exact digest drift invalidates", async () => {
  const initial = (await initialSnapshot()).record;
  assert.throws(
    () => step(initial, {
      ...pageEvent(initial),
      passNumber: 2,
    }),
    (error) => (
      error.code === "SOURCE_CAPTURE_SERVER_SELECTION_MISMATCH"
    ),
  );
  let record = step(initial, pageEvent(initial, {
    pageSemanticDigest: digest("1"),
    sourceHeadEpochDigest: digest("4"),
  }));
  assert.equal(record.activeStep.passNumber, 2);
  record = step(record, pageEvent(record, {
    pageSemanticDigest: digest("2"),
    sourceHeadEpochDigest: digest("4"),
  }));
  assert.equal(record.status, "invalidated");
  assert.equal(
    record.invalidReason,
    "sequential_pass_digest_mismatch",
  );
  assert.equal(record.activeStep, null);
});

test("completed pass digest is rebound to every page checkpoint", async () => {
  const initial = (await initialSnapshot()).record;
  const completedPass = step(initial, pageEvent(initial, {
    pageSemanticDigest: digest("1"),
    sourceHeadEpochDigest: digest("4"),
  }));
  const tampered = JSON.parse(JSON.stringify(completedPass));
  tampered.sources[0].passes[0]
    .pageSemanticDigests[0] = digest("2");
  assert.throws(
    () => validateDarkSourceCaptureRecord(tampered),
    (error) => error.code === "SOURCE_CAPTURE_PASS_DIGEST_INVALID",
  );
});

test("pass stability binds semantic epoch, head revision, and exact raw SHA", async () => {
  const initial = (await initialSnapshot()).record;
  const afterPassOne = step(initial, pageEvent(initial, {
    pageSemanticDigest: digest("1"),
    sourceHeadEpochDigest: digest("4"),
    sourceHeadRevisionDigest: digest("5"),
    sourceHeadRecordDigest: digest("6"),
  }));
  const changedRevision = step(
    afterPassOne,
    pageEvent(afterPassOne, {
      pageSemanticDigest: digest("1"),
      sourceHeadEpochDigest: digest("4"),
      sourceHeadRevisionDigest: digest("7"),
      sourceHeadRecordDigest: digest("6"),
    }),
  );
  assert.equal(changedRevision.status, "invalidated");
  assert.equal(
    changedRevision.invalidReason,
    "source_head_changed_between_passes",
  );
});

test("two sequential exhaustive passes advance sources in fixed order", async () => {
  const initial = (await initialSnapshot()).record;
  const { record } = completeAllSources(initial);
  assert.equal(record.status, "verifying_heads");
  assert.equal(record.activeStep, null);
  assert.equal(record.headVerificationIndex, 0);
  assert.deepEqual(
    record.sources.map((source) => source.source),
    [
      "recall",
      "paraform_human",
      "human_intro",
      "aliases",
    ],
  );
  assert.equal(
    record.sources.every((source) => (
      source.status === "captured"
      && source.passes.every(
        (pass) => (
          pass.status === "complete"
          && pass.terminalCursorObserved === true
        ),
      )
      && source.passes[0].semanticDigest
        === source.passes[1].semanticDigest
    )),
    true,
  );
});

test("exact head verification creates only a short dark lease", async () => {
  const initial = (await initialSnapshot()).record;
  const record = completeDarkLease(initial);
  assert.equal(record.status, "leased_dark");
  assert.equal(
    record.freshnessLease.validUntilMs
      - record.freshnessLease.evidenceFreshSinceMs,
    SOURCE_CAPTURE_FRESHNESS_LEASE_MS,
  );
  assert.equal(
    record.freshnessLease.issuedAtMs,
    record.freshnessLease.headVerifiedThroughMs,
  );
  for (const source of record.sources) {
    assert.equal(
      source.passes[0].sourceHeadRevisionDigest,
      source.passes[1].sourceHeadRevisionDigest,
    );
    assert.equal(
      source.passes[0].sourceHeadRecordDigest,
      source.passes[1].sourceHeadRecordDigest,
    );
    assert.equal(
      source.headChecks.every((check) => (
        check.sourceHeadEpochDigest
          === source.verifiedHeadEpochDigest
        && check.sourceHeadRevisionDigest
          === source.verifiedHeadRevisionDigest
        && check.sourceHeadRecordDigest
          === source.verifiedHeadRecordDigest
      )),
      true,
    );
    assert.equal(
      record.freshnessLease.sourceHeadRevisionDigests[
        source.source
      ],
      source.verifiedHeadRevisionDigest,
    );
    assert.equal(
      record.freshnessLease.sourceHeadRecordDigests[
        source.source
      ],
      source.verifiedHeadRecordDigest,
    );
  }
  const aggregate = sourceCaptureAggregateStatus({
    record,
    redisNowMs: record.freshnessLease.issuedAtMs,
  });
  assert.equal(aggregate.freshnessLeaseCurrent, true);
  assert.equal(aggregate.operational, false);
  assert.equal(aggregate.activationAvailable, false);
  assert.equal(aggregate.writeAuthorityAvailable, false);

  const expired = sourceCaptureAggregateStatus({
    record,
    redisNowMs: record.freshnessLease.validUntilMs + 1,
  });
  assert.equal(expired.status, "freshness_expired");
  assert.equal(expired.freshnessLeaseCurrent, false);
  assert.equal(expired.operational, false);

  const beforeIssue = sourceCaptureAggregateStatus({
    record,
    redisNowMs: record.freshnessLease.issuedAtMs - 1,
  });
  assert.equal(beforeIssue.freshnessLeaseCurrent, false);
  assert.notEqual(beforeIssue.status, "leased_dark");
});

test("post-capture source head movement is durably invalid", async () => {
  const initial = (await initialSnapshot()).record;
  let { record } = completeAllSources(initial);
  record = step(
    record,
    headEvent(record, digest("f")),
  );
  assert.equal(record.status, "invalidated");
  assert.equal(
    record.invalidReason,
    "source_head_changed_after_capture",
  );
});

test("head verification is double-read and bounded as one lattice", async () => {
  const initial = (await initialSnapshot()).record;
  const completed = completeAllSources(initial);
  let record = completed.record;
  for (let index = 0; index < 7; index += 1) {
    const evidence =
      completed.evidence[index % completed.evidence.length];
    record = step(
      record,
      headEvent(record, evidence.sourceHeadEpochDigest),
    );
  }
  assert.equal(record.headVerificationRound, 2);
  assert.equal(record.headVerificationIndex, 3);
  const firstObservedAtMs =
    record.sources[0].headChecks[0].observedAtMs;
  const lastEvidence = completed.evidence[3];
  record = transitionDarkSourceCaptureRecord(
    record,
    headEvent(record, lastEvidence.sourceHeadEpochDigest),
    firstObservedAtMs
      + SOURCE_CAPTURE_HEAD_VERIFICATION_MAX_SPAN_MS
      + 1,
  );
  assert.equal(record.status, "invalidated");
  assert.equal(
    record.invalidReason,
    "head_verification_window_exceeded",
  );
  assert.equal(record.freshnessLease, null);
});

test("one-shot exact-raw claims reject cross-run stale events", async () => {
  const first = await initialSnapshot(TEST_REDIS_MS);
  const firstRaw = JSON.stringify(first.record);
  const claim = await withFetch(
    async () => response([
      firstRaw,
      ...redisParts(TEST_REDIS_MS + 100),
    ]),
    () => claimDarkSourceCaptureStep(),
  );
  const replacement = await initialSnapshot(
    TEST_REDIS_MS + 1_000,
  );
  const replacementRaw = JSON.stringify(replacement.record);
  let fetchCount = 0;
  await assert.rejects(
    withFetch(async () => {
      fetchCount += 1;
      return response([
        replacementRaw,
        ...redisParts(TEST_REDIS_MS + 1_100),
      ]);
    }, () => checkpointTrustedSourceCaptureEvent(
      claim,
      {
        ...pageEvent(first.record, {
        pageSemanticDigest: digest("1"),
        sourceHeadEpochDigest: digest("4"),
        }),
        claimNonceDigest: claim.claimNonceDigest,
      },
    )),
    (error) => (
      error.code === "SOURCE_CAPTURE_CHECKPOINT_CONFLICT"
    ),
  );
  assert.equal(fetchCount, 1);
  await assert.rejects(
    checkpointTrustedSourceCaptureEvent(
      claim,
      {
        ...pageEvent(first.record),
        claimNonceDigest: claim.claimNonceDigest,
      },
    ),
    (error) => error.code === "SOURCE_CAPTURE_CLAIM_INVALID",
  );
});

test("trusted checkpoint CAS binds the server-read raw revision", async () => {
  const snapshot = await initialSnapshot();
  const initialRaw = JSON.stringify(snapshot.record);
  const commands = [];
  const claim = await withFetch(
    async () => response([
      initialRaw,
      ...redisParts(TEST_REDIS_MS + 500),
    ]),
    () => claimDarkSourceCaptureStep(),
  );
  const checkpointed = await withFetch(
    async (_url, options) => {
      const command = JSON.parse(options.body);
      commands.push(command);
      if (commands.length === 1) {
        return response([
          initialRaw,
          ...redisParts(TEST_REDIS_MS + 1_000),
        ]);
      }
      const nextRaw = command[6];
      return response([
        1,
        nextRaw,
        ...redisParts(TEST_REDIS_MS + 1_000),
      ]);
    },
    () => checkpointTrustedSourceCaptureEvent(
      claim,
      {
        ...pageEvent(snapshot.record, {
          pageSemanticDigest: digest("1"),
          sourceHeadEpochDigest: digest("4"),
        }),
        claimNonceDigest: claim.claimNonceDigest,
      },
    ),
  );
  assert.equal(commands.length, 2);
  assert.equal(commands[0][0], "EVAL");
  assert.equal(commands[1][0], "EVAL");
  assert.equal(commands[1][5], initialRaw);
  assert.match(
    commands[1][1],
    /currentRaw ~= ARGV\[1\]/u,
  );
  assert.match(
    commands[1][1],
    /next\.decisionBoundaryAtMs ~= tonumber\(ARGV\[4\]\)/u,
  );
  assert.equal(checkpointed.record.revision, 1);
  assert.equal(
    checkpointed.record.activeStep.passNumber,
    2,
  );
});

test("runner tick remains dark and returns aggregate-only state", async () => {
  const result = await withFetch(async (_url, options) => {
    const command = JSON.parse(options.body);
    const proposed = JSON.parse(command[5]);
    proposed.decisionBoundaryAtMs = TEST_REDIS_MS;
    proposed.createdAtMs = TEST_REDIS_MS;
    proposed.updatedAtMs = TEST_REDIS_MS;
    proposed.priorCaptureRevisionSha1 = null;
    return response([
      1,
      JSON.stringify(proposed),
      ...redisParts(TEST_REDIS_MS),
    ]);
  }, () => runPhase4SourceCaptureTick({
    mode: PHASE4_SOURCE_CAPTURE_TICK_MODE,
  }));

  assert.equal(result.ok, true);
  assert.equal(result.status, "capture_interfaces_unavailable");
  assert.equal(result.operational, false);
  assert.equal(result.curationAvailable, false);
  assert.equal(result.enrollmentAvailable, false);
  assert.equal(result.activationAvailable, false);
  assert.equal(result.writeAuthorityAvailable, false);
  assert.equal(result.missingPrivateInterfaces, 5);
  assert.equal(result.missingReleasePins, 3);
  const allKeys = JSON.stringify(Object.keys(result));
  assert.doesNotMatch(
    allKeys,
    /(candidate|email|name|link|cursor|digest|boundaryAt|runId)/iu,
  );
});

test("malformed durable state returns one aggregate dark failure", async () => {
  const result = await withFetch(
    async () => response([
      0,
      JSON.stringify({ version: 1 }),
      ...redisParts(TEST_REDIS_MS),
    ]),
    () => runPhase4SourceCaptureTick({
      mode: PHASE4_SOURCE_CAPTURE_TICK_MODE,
    }),
  );
  assert.deepEqual(
    {
      ok: result.ok,
      status: result.status,
      operational: result.operational,
      activationAvailable: result.activationAvailable,
      writeAuthorityAvailable: result.writeAuthorityAvailable,
    },
    {
      ok: false,
      status: "capture_store_invalid",
      operational: false,
      activationAvailable: false,
      writeAuthorityAvailable: false,
    },
  );
});

test("dark status cannot become operational from local capture evidence", () => {
  const status = phase4SourceCaptureDarkStatus();
  assert.equal(status.status, "capture_interfaces_unavailable");
  assert.equal(status.operational, false);
  assert.equal(status.curationAvailable, false);
  assert.equal(status.enrollmentAvailable, false);
  assert.equal(status.missingReleasePins, 3);
});

test("worker route is runner-only, POST-only, and accepts mode only", async () => {
  const worker = await readFile(
    new URL("../api/paraai/worker.mjs", import.meta.url),
    "utf8",
  );
  assert.match(worker, /"phase4-source-capture-tick"/u);
  assert.match(worker, /phase4SourceModes\.has\(mode\)/u);
  assert.match(
    worker,
    /\[\s*"phase4-source-capture-tick",\s*new Set\(\["mode"\]\),?\s*\]/u,
  );
  assert.match(worker, /runner_key_required/u);
  assert.match(worker, /phase4_source_capture_POST_only/u);
  assert.doesNotMatch(worker, /String\(body\.mode/u);
  assert.match(
    worker,
    /typeof requestedMode === "string"/u,
  );
  assert.match(
    worker,
    /runPhase4SourceCaptureTick\(\{ mode \}\)/u,
  );
});

test("worker rejects an array lookalike for the runner mode", async () => {
  const { default: handler } = await import(
    "../api/paraai/worker.mjs"
  );
  let statusCode = null;
  let payload = null;
  const responseObject = {
    setHeader: () => {},
    status(value) {
      statusCode = value;
      return this;
    },
    json(value) {
      payload = value;
      return value;
    },
  };
  let fetchCalled = false;
  const saved = globalThis.fetch;
  globalThis.fetch = async () => {
    fetchCalled = true;
    throw new Error("lookalike mode must not reach a store");
  };
  try {
    await handler(
      {
        method: "POST",
        headers: {
          authorization:
            `Bearer ${process.env.PARAAI_AUTOMATION_RUNNER_KEY}`,
        },
        body: {
          mode: [PHASE4_SOURCE_CAPTURE_TICK_MODE],
        },
      },
      responseObject,
    );
  } finally {
    globalThis.fetch = saved;
  }
  assert.equal(statusCode, 400);
  assert.deepEqual(payload, {
    ok: false,
    error: "unsupported_mode",
  });
  assert.equal(fetchCalled, false);
});

test("capture journal has no authority activation or write integration", async () => {
  const [store, coordinator, authority] = await Promise.all([
    import("../api/paraai/_lib/source-capture-store.mjs"),
    import("../api/paraai/_lib/source-capture-coordinator.mjs"),
    readFile(
      new URL(
        "../api/paraai/_lib/source-authority-store.mjs",
        import.meta.url,
      ),
      "utf8",
    ),
  ]);
  for (const name of [
    ...Object.keys(store),
    ...Object.keys(coordinator),
  ]) {
    assert.doesNotMatch(
      name,
      /(activate|reserve|curate|enroll|writeAuthority)/iu,
    );
  }
  assert.match(
    authority,
    /const SOURCE_CAPTURE_COORDINATOR_AVAILABLE = false;/u,
  );
  assert.doesNotMatch(
    authority,
    /source-capture-coordinator\.mjs/u,
  );
});
