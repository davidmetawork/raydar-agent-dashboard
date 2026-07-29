import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import test from "node:test";

import {
  HUMAN_INTRO_PARSER_VERSION,
  HUMAN_INTRO_SOURCE,
  RAYDAR_HUMAN_INTRO_PARSER_VERSION,
  RAYDAR_HUMAN_INTRO_SOURCE,
  humanIntroCallRecord,
  humanIntroEventId,
  humanIntroJobId,
  humanIntroPayloadDigest,
  persistedHumanIntroMetadata,
} from "../api/paraai/_lib/human-intro.mjs";
import * as collectorModule from
  "../api/paraai/_lib/source-human-intro-point-collector.mjs";
import {
  SOURCE_HUMAN_INTRO_POINT_COLLECTOR_VERSION,
  SourceHumanIntroPointCollectorError,
  humanIntroSourcePointEvidence,
  normalizeHumanIntroSourcePointJob,
} from
  "../api/paraai/_lib/source-human-intro-point-collector.mjs";
import {
  SOURCE_HUMAN_INTRO_ARTIFACT_DIGEST,
} from "../api/paraai/_lib/source-watermark.mjs";

const SOURCE_ID = "a".repeat(64);
const ARTIFACT_SHA256 = "b".repeat(64);
const BOUNDARY = "2026-07-25T12:00:00.000Z";

function payload(overrides = {}) {
  return {
    source: HUMAN_INTRO_SOURCE,
    parserVersion: HUMAN_INTRO_PARSER_VERSION,
    sourceId: SOURCE_ID,
    eventId: humanIntroEventId(SOURCE_ID),
    bookingCreatedAt: "2026-07-20T08:00:00.000Z",
    candidateName: "Synthetic Candidate",
    inviteeEmail: "synthetic.candidate@example.test",
    linkedinUrl:
      "https://www.linkedin.com/in/synthetic-candidate",
    resumeLinkDisposition: "received",
    resumeReceipt: {
      source: "calendar_resume_link",
      status: "received",
      artifactSha256: ARTIFACT_SHA256,
      mimeType: "application/pdf",
    },
    scheduledStart: "2026-07-25T10:00:00.000Z",
    scheduledEnd: "2026-07-25T10:30:00.000Z",
    ...overrides,
  };
}

function durableJobFromPayload(
  selectedPayload,
  overrides = {},
) {
  const call = humanIntroCallRecord(selectedPayload);
  const base = {
    id: humanIntroJobId(selectedPayload.sourceId),
    revision: 17,
    state: "needs_review",
    humanCall: true,
    humanIntro: true,
    callType: "human",
    callTypeAt: call.endedAt,
    callStartedAt: call.joinAt,
    callEndedAt: call.endedAt,
    bookingSourceId: selectedPayload.sourceId,
    resumeLinkDisposition: call.resumeLinkDisposition,
    resumeReceipt: call.resumeReceipt,
    candidate: call.candidate,
    humanCallMeta: persistedHumanIntroMetadata(call),
    successfulCallVerified: true,
    journal: [],
  };
  return {
    ...base,
    ...overrides,
    candidate: {
      ...base.candidate,
      ...(overrides.candidate || {}),
    },
    humanCallMeta: {
      ...base.humanCallMeta,
      ...(overrides.humanCallMeta || {}),
    },
  };
}

function durableJob(overrides = {}) {
  return durableJobFromPayload(payload(), overrides);
}

function options(overrides = {}) {
  return {
    decisionBoundaryAt: BOUNDARY,
    ...overrides,
  };
}

function expectCode(operation, code) {
  assert.throws(
    operation,
    (error) => (
      error instanceof SourceHumanIntroPointCollectorError
      && error.code === code
    ),
  );
}

function canonicalJson(value) {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => (
    `${JSON.stringify(key)}:${canonicalJson(value[key])}`
  )).join(",")}}`;
}

function semanticDigest(namespace, value) {
  return createHash("sha256")
    .update(namespace)
    .update("\0")
    .update(canonicalJson(value))
    .digest("hex");
}

test("exact durable hi- intake projects frozen private facts and only dark capabilities", () => {
  const projection = normalizeHumanIntroSourcePointJob(
    durableJob(),
    options(),
  );
  assert.deepEqual(Object.keys(projection), [
    "version",
    "source",
    "intakeSource",
    "parserVersion",
    "jobId",
    "sourceId",
    "intakeEventId",
    "payloadDigest",
    "bookingCreatedAt",
    "scheduledStart",
    "scheduledEnd",
    "candidate",
    "resumeLinkDisposition",
    "resumeReceipt",
    "decisionBoundaryAt",
    "durableIntakeAvailable",
    "durableSignedReceiptAvailable",
    "sourceRecordRevisionAvailable",
    "sourceHeadAvailable",
    "sourceExhaustivenessAvailable",
    "cancellationTombstoneAvailable",
    "occurredEvidenceAvailable",
    "outcomeEvidenceAvailable",
    "successClassificationAvailable",
    "candidateIdentityResolutionAvailable",
    "pinnable",
  ]);
  assert.equal(
    projection.version,
    SOURCE_HUMAN_INTRO_POINT_COLLECTOR_VERSION,
  );
  assert.equal(projection.source, "human_intro");
  assert.equal(projection.intakeSource, HUMAN_INTRO_SOURCE);
  assert.equal(projection.jobId, `hi-${SOURCE_ID}`);
  assert.equal(projection.sourceId, SOURCE_ID);
  assert.equal(
    projection.intakeEventId,
    humanIntroEventId(SOURCE_ID),
  );
  assert.equal(projection.durableIntakeAvailable, true);
  for (const field of [
    "durableSignedReceiptAvailable",
    "sourceRecordRevisionAvailable",
    "sourceHeadAvailable",
    "sourceExhaustivenessAvailable",
    "cancellationTombstoneAvailable",
    "occurredEvidenceAvailable",
    "outcomeEvidenceAvailable",
    "successClassificationAvailable",
    "candidateIdentityResolutionAvailable",
    "pinnable",
  ]) {
    assert.equal(projection[field], false, field);
  }
  assert.equal(Object.isFrozen(projection), true);
  assert.equal(Object.isFrozen(projection.candidate), true);
  assert.equal(Object.isFrozen(projection.resumeReceipt), true);
});

test("the isolated projector stays in parity with the Human Intro intake helpers", () => {
  const payloads = [
    payload(),
    payload({
      linkedinUrl: null,
      resumeLinkDisposition: "none",
      resumeReceipt: null,
    }),
    payload({
      resumeLinkDisposition: "ambiguous",
      resumeReceipt: null,
    }),
    payload({
      resumeLinkDisposition: "received_review",
      resumeReceipt: {
        source: "calendar_resume_link",
        status: "received_review",
        artifactSha256: "c".repeat(64),
        mimeType: "application/rtf",
      },
    }),
    payload({
      linkedinUrl:
        "https://www.linkedin.com/in/synthetic+!$&(),;=:@candidate",
    }),
    payload({
      linkedinUrl:
        `https://www.linkedin.com/in/${"a".repeat(600)}`,
    }),
  ];
  for (const selectedPayload of payloads) {
    const projection = normalizeHumanIntroSourcePointJob(
      durableJobFromPayload(selectedPayload),
      options(),
    );
    assert.equal(projection.intakeSource, HUMAN_INTRO_SOURCE);
    assert.equal(
      projection.parserVersion,
      HUMAN_INTRO_PARSER_VERSION,
    );
    assert.equal(
      projection.intakeEventId,
      humanIntroEventId(selectedPayload.sourceId),
    );
    assert.equal(
      projection.payloadDigest,
      humanIntroPayloadDigest(selectedPayload),
    );
  }
});

test("native scheduler Human intake projects the exact phone and upload provenance", () => {
  const selectedPayload = payload({
    source: RAYDAR_HUMAN_INTRO_SOURCE,
    parserVersion: RAYDAR_HUMAN_INTRO_PARSER_VERSION,
    resumeReceipt: {
      source: "raydar_scheduler_upload",
      status: "received",
      artifactSha256: ARTIFACT_SHA256,
      mimeType: "application/pdf",
    },
  });
  const projection = normalizeHumanIntroSourcePointJob(
    durableJobFromPayload(selectedPayload),
    options(),
  );
  assert.equal(
    projection.intakeSource,
    RAYDAR_HUMAN_INTRO_SOURCE,
  );
  assert.equal(
    projection.parserVersion,
    RAYDAR_HUMAN_INTRO_PARSER_VERSION,
  );
  assert.equal(
    projection.resumeReceipt.source,
    "raydar_scheduler_upload",
  );
  assert.equal(
    projection.payloadDigest,
    humanIntroPayloadDigest(selectedPayload),
  );
});

test("job, source, event, payload, and candidate bindings fail closed", () => {
  expectCode(
    () => normalizeHumanIntroSourcePointJob(
      durableJob({ id: `hc-${SOURCE_ID}` }),
      options(),
    ),
    "SOURCE_HUMAN_INTRO_POINT_JOB_ID_INVALID",
  );
  expectCode(
    () => normalizeHumanIntroSourcePointJob(
      durableJob({ humanIntro: false }),
      options(),
    ),
    "SOURCE_HUMAN_INTRO_POINT_MARKERS_INVALID",
  );
  expectCode(
    () => normalizeHumanIntroSourcePointJob(
      durableJob({
        id: `hi-${"c".repeat(64)}`,
      }),
      options(),
    ),
    "SOURCE_HUMAN_INTRO_POINT_SOURCE_ID_MISMATCH",
  );
  expectCode(
    () => normalizeHumanIntroSourcePointJob(
      durableJob({
        humanCallMeta: {
          intakeEventId: "c".repeat(64),
        },
      }),
      options(),
    ),
    "SOURCE_HUMAN_INTRO_POINT_EVENT_ID_MISMATCH",
  );
  expectCode(
    () => normalizeHumanIntroSourcePointJob(
      durableJob({
        humanCallMeta: {
          payloadDigest: "c".repeat(64),
        },
      }),
      options(),
    ),
    "SOURCE_HUMAN_INTRO_POINT_PAYLOAD_DIGEST_MISMATCH",
  );
  for (const candidate of [
    {
      fullName: "Different Candidate",
      firstName: "Different",
    },
    { email: "different@example.test" },
    {
      linkedin:
        "https://www.linkedin.com/in/different-candidate",
    },
  ]) {
    expectCode(
      () => normalizeHumanIntroSourcePointJob(
        durableJob({ candidate }),
        options(),
      ),
      "SOURCE_HUMAN_INTRO_POINT_PAYLOAD_DIGEST_MISMATCH",
    );
  }
  expectCode(
    () => normalizeHumanIntroSourcePointJob(
      durableJob({
        candidate: {
          scheduledStart: "2026-07-25T10:01:00.000Z",
        },
      }),
      options(),
    ),
    "SOURCE_HUMAN_INTRO_POINT_SCHEDULE_MISMATCH",
  );
  expectCode(
    () => normalizeHumanIntroSourcePointJob(
      durableJob({
        humanCallMeta: {
          payloadConflict: {
            incomingDigest: "c".repeat(64),
          },
        },
      }),
      options(),
    ),
    "SOURCE_HUMAN_INTRO_POINT_METADATA_INVALID",
  );
});

test("the server-selected boundary is exact, strict, and the only option", () => {
  for (const decisionBoundaryAt of [
    "2026-07-25T10:30:00.000Z",
    "2026-07-25T10:29:59.999Z",
  ]) {
    expectCode(
      () => normalizeHumanIntroSourcePointJob(
        durableJob(),
        { decisionBoundaryAt },
      ),
      "SOURCE_HUMAN_INTRO_POINT_OUTSIDE_BOUNDARY",
    );
  }
  for (const decisionBoundaryAt of [
    "2026-07-25T12:00:00Z",
    "2026-07-25T12:00:00.000+00:00",
    "not-a-time",
  ]) {
    expectCode(
      () => normalizeHumanIntroSourcePointJob(
        durableJob(),
        { decisionBoundaryAt },
      ),
      "SOURCE_HUMAN_INTRO_POINT_BOUNDARY_INVALID",
    );
  }
  for (const extra of [
    { force: true },
    { status: "success" },
    { classification: "success" },
    { outcome: "occurred_success" },
    { sourceId: SOURCE_ID },
  ]) {
    expectCode(
      () => normalizeHumanIntroSourcePointJob(
        durableJob(),
        options(extra),
      ),
      "SOURCE_HUMAN_INTRO_POINT_OPTIONS_INVALID",
    );
  }
});

test("downstream status, success, cancellation, and delivery fields cannot become source evidence", () => {
  const baselineProjection =
    normalizeHumanIntroSourcePointJob(
      durableJob(),
      options(),
    );
  const baselineEvidence = humanIntroSourcePointEvidence(
    durableJob(),
    options(),
  );
  const downstream = durableJob({
    state: "enrolled",
    successfulCallVerified: true,
    status: "Success",
    outcome: "occurred_success",
    classification: "success",
    deliveryReady: true,
    deliveryVerifiedAt: "2026-07-25T11:00:00.000Z",
    calendarCancelled: true,
    cancelledAt: "2026-07-25T09:00:00.000Z",
    calendarEventId: "raw_calendar_event_must_stay_private",
    reviewAction: {
      appliedAt: "2026-07-25T11:00:00.000Z",
      reasons: ["human_intro_without_transcript"],
    },
  });
  assert.deepEqual(
    normalizeHumanIntroSourcePointJob(
      downstream,
      options(),
    ),
    baselineProjection,
  );
  assert.deepEqual(
    humanIntroSourcePointEvidence(
      downstream,
      options(),
    ),
    baselineEvidence,
  );
  assert.equal(
    baselineEvidence.cancellationTombstoneAvailable,
    false,
  );
  assert.equal(baselineEvidence.occurredEvidenceAvailable, false);
  assert.equal(baselineEvidence.outcomeEvidenceAvailable, false);
  assert.equal(
    baselineEvidence.successClassificationAvailable,
    false,
  );

  const { proxy: revoked, revoke } = Proxy.revocable(
    { occurred: true },
    {},
  );
  revoke();
  const ignoredSparse = [];
  ignoredSparse.length = 0xffff_ffff;
  const successVariants = [
    false,
    null,
    revoked,
    ignoredSparse,
  ];
  for (const successfulCallVerified of successVariants) {
    const job = durableJob({ successfulCallVerified });
    assert.deepEqual(
      normalizeHumanIntroSourcePointJob(job, options()),
      baselineProjection,
    );
    assert.deepEqual(
      humanIntroSourcePointEvidence(job, options()),
      baselineEvidence,
    );
  }
  const absent = durableJob();
  delete absent.successfulCallVerified;
  assert.deepEqual(
    normalizeHumanIntroSourcePointJob(absent, options()),
    baselineProjection,
  );
  assert.deepEqual(
    humanIntroSourcePointEvidence(absent, options()),
    baselineEvidence,
  );
});

test("hostile records fail without invoking accessors or traversing ignored sparse arrays", () => {
  expectCode(
    () => normalizeHumanIntroSourcePointJob(
      new Proxy(durableJob(), {}),
      options(),
    ),
    "SOURCE_HUMAN_INTRO_POINT_JOB_INVALID",
  );
  const revokedRoot = Proxy.revocable(durableJob(), {});
  revokedRoot.revoke();
  expectCode(
    () => normalizeHumanIntroSourcePointJob(
      revokedRoot.proxy,
      options(),
    ),
    "SOURCE_HUMAN_INTRO_POINT_JOB_INVALID",
  );
  const revokedOptions = Proxy.revocable(options(), {});
  revokedOptions.revoke();
  expectCode(
    () => normalizeHumanIntroSourcePointJob(
      durableJob(),
      revokedOptions.proxy,
    ),
    "SOURCE_HUMAN_INTRO_POINT_OPTIONS_INVALID",
  );
  const revokedCandidate = Proxy.revocable(
    durableJob().candidate,
    {},
  );
  revokedCandidate.revoke();
  const revokedCandidateJob = durableJob();
  revokedCandidateJob.candidate = revokedCandidate.proxy;
  expectCode(
    () => normalizeHumanIntroSourcePointJob(
      revokedCandidateJob,
      options(),
    ),
    "SOURCE_HUMAN_INTRO_POINT_CANDIDATE_INVALID",
  );

  let getterCalls = 0;
  const accessorJob = durableJob();
  Object.defineProperty(accessorJob, "outcome", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return "success";
    },
  });
  expectCode(
    () => normalizeHumanIntroSourcePointJob(
      accessorJob,
      options(),
    ),
    "SOURCE_HUMAN_INTRO_POINT_JOB_INVALID",
  );
  assert.equal(getterCalls, 0);

  const accessorCandidate = durableJob();
  Object.defineProperty(accessorCandidate.candidate, "fullName", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return "Synthetic Candidate";
    },
  });
  expectCode(
    () => normalizeHumanIntroSourcePointJob(
      accessorCandidate,
      options(),
    ),
    "SOURCE_HUMAN_INTRO_POINT_CANDIDATE_INVALID",
  );
  assert.equal(getterCalls, 0);

  const symbolMetadata = durableJob();
  symbolMetadata.humanCallMeta[
    Symbol("classification")
  ] = "success";
  expectCode(
    () => normalizeHumanIntroSourcePointJob(
      symbolMetadata,
      options(),
    ),
    "SOURCE_HUMAN_INTRO_POINT_METADATA_INVALID",
  );

  const customCandidate = durableJob();
  Object.setPrototypeOf(
    customCandidate.candidate,
    { outcome: "success" },
  );
  expectCode(
    () => normalizeHumanIntroSourcePointJob(
      customCandidate,
      options(),
    ),
    "SOURCE_HUMAN_INTRO_POINT_CANDIDATE_INVALID",
  );

  const sparse = [];
  sparse.length = 0xffff_ffff;
  expectCode(
    () => normalizeHumanIntroSourcePointJob(
      sparse,
      options(),
    ),
    "SOURCE_HUMAN_INTRO_POINT_JOB_INVALID",
  );
  const sparseCandidate = durableJob();
  sparseCandidate.candidate = sparse;
  expectCode(
    () => normalizeHumanIntroSourcePointJob(
      sparseCandidate,
      options(),
    ),
    "SOURCE_HUMAN_INTRO_POINT_CANDIDATE_INVALID",
  );
  const sparseSubstance = durableJob();
  sparseSubstance.humanCallMeta.substance = sparse;
  expectCode(
    () => normalizeHumanIntroSourcePointJob(
      sparseSubstance,
      options(),
    ),
    "SOURCE_HUMAN_INTRO_POINT_METADATA_INVALID",
  );

  const ignoredSparse = durableJob();
  ignoredSparse.journal = sparse;
  assert.deepEqual(
    humanIntroSourcePointEvidence(
      ignoredSparse,
      options(),
    ),
    humanIntroSourcePointEvidence(
      durableJob(),
      options(),
    ),
  );

  const overwideJob = durableJob();
  for (let index = 0; index < 129; index += 1) {
    overwideJob[`ignored${index}`] = index;
  }
  expectCode(
    () => normalizeHumanIntroSourcePointJob(
      overwideJob,
      options(),
    ),
    "SOURCE_HUMAN_INTRO_POINT_JOB_INVALID",
  );
});

test("evidence is digest-only and excludes source ids, PII, links, times, and resume artifacts", () => {
  const job = durableJob();
  const evidence = humanIntroSourcePointEvidence(
    job,
    options(),
  );
  assert.deepEqual(Object.keys(evidence), [
    "version",
    "source",
    "sourceRecordDigest",
    "durableIntakeDigest",
    "privateProjectionDigest",
    "decisionBoundaryDigest",
    "durableIntakeAvailable",
    "durableSignedReceiptAvailable",
    "sourceRecordRevisionAvailable",
    "sourceHeadAvailable",
    "sourceExhaustivenessAvailable",
    "cancellationTombstoneAvailable",
    "occurredEvidenceAvailable",
    "outcomeEvidenceAvailable",
    "successClassificationAvailable",
    "candidateIdentityResolutionAvailable",
    "pinnable",
  ]);
  for (const key of [
    "sourceRecordDigest",
    "durableIntakeDigest",
    "privateProjectionDigest",
    "decisionBoundaryDigest",
  ]) {
    assert.match(evidence[key], /^[a-f0-9]{64}$/u);
  }
  const serialized = JSON.stringify(evidence);
  for (const forbidden of [
    job.id,
    SOURCE_ID,
    job.humanCallMeta.intakeEventId,
    job.humanCallMeta.payloadDigest,
    job.candidate.fullName,
    job.candidate.email,
    job.candidate.linkedin,
    job.callStartedAt,
    job.callEndedAt,
    job.humanCallMeta.bookingCreatedAt,
    ARTIFACT_SHA256,
    BOUNDARY,
  ]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
});

test("record, intake, private projection, and boundary digest namespaces are exact", () => {
  const projection = normalizeHumanIntroSourcePointJob(
    durableJob(),
    options(),
  );
  const evidence = humanIntroSourcePointEvidence(
    durableJob(),
    options(),
  );
  const sourceRecordDigest = semanticDigest(
    "phase4-human-intro-source-record-v1",
    {
      source: projection.source,
      jobId: projection.jobId,
      sourceId: projection.sourceId,
      intakeEventId: projection.intakeEventId,
    },
  );
  assert.equal(evidence.sourceRecordDigest, sourceRecordDigest);
  assert.equal(
    evidence.durableIntakeDigest,
    semanticDigest(
      "phase4-human-intro-durable-intake-v1",
      {
        sourceRecordDigest,
        intakeSource: projection.intakeSource,
        parserVersion: projection.parserVersion,
        payloadDigest: projection.payloadDigest,
        bookingCreatedAt: projection.bookingCreatedAt,
        scheduledStart: projection.scheduledStart,
        scheduledEnd: projection.scheduledEnd,
        candidate: projection.candidate,
        resumeLinkDisposition:
          projection.resumeLinkDisposition,
        resumeReceipt: projection.resumeReceipt,
      },
    ),
  );
  assert.equal(
    evidence.privateProjectionDigest,
    semanticDigest(
      "phase4-human-intro-private-projection-v1",
      projection,
    ),
  );
  assert.equal(
    evidence.decisionBoundaryDigest,
    semanticDigest(
      "phase4-source-decision-boundary-v1",
      BOUNDARY,
    ),
  );
});

test("the Human Intro intake scaffold exports no I/O, store, coordinator, or activation surface", async () => {
  assert.deepEqual(Object.keys(collectorModule).sort(), [
    "SOURCE_HUMAN_INTRO_POINT_COLLECTOR_VERSION",
    "SourceHumanIntroPointCollectorError",
    "humanIntroSourcePointEvidence",
    "normalizeHumanIntroSourcePointJob",
  ]);
  const source = await readFile(
    new URL(
      "../api/paraai/_lib/source-human-intro-point-collector.mjs",
      import.meta.url,
    ),
    "utf8",
  );
  const imports = [
    ...source.matchAll(/\bfrom\s+["']([^"']+)["']/gu),
  ].map((match) => match[1]).sort();
  assert.deepEqual(imports, [
    "node:crypto",
    "node:util",
  ]);
  const commentFreeSource = source
    .replace(/\/\*[\s\S]*?\*\//gu, "")
    .replace(/^\s*\/\/.*$/gmu, "");
  assert.equal(
    commentFreeSource.match(/\bimport\b/gu)?.length,
    2,
  );
  assert.doesNotMatch(
    source,
    /^\s*import\s+["']/mu,
  );
  assert.doesNotMatch(source, /\bimport\s*\(/u);
  assert.doesNotMatch(source, /human-intro\.mjs/u);
  for (const forbidden of [
    /\bfetch\s*\(/u,
    /\bcreateHmac\b/u,
    /\bprocess\.env\b/u,
    /\bKV_REST\b/u,
    /\bredis\b/iu,
    /\bgetJob\b/u,
    /\bsaveJob\b/u,
    /\btransition\s*\(/u,
    /\bcheckpointTrustedSourceCaptureEvent\b/u,
    /\bbuildSourceWatermarkCertificate\b/u,
    /source-capture-coordinator/u,
    /source-watermark/u,
  ]) {
    assert.doesNotMatch(source, forbidden);
  }
});

test("Human Intro release pin and coordinator client remain hard-dark", async () => {
  assert.equal(SOURCE_HUMAN_INTRO_ARTIFACT_DIGEST, null);
  const [coordinator, watermark] = await Promise.all([
    readFile(new URL(
      "../api/paraai/_lib/source-capture-coordinator.mjs",
      import.meta.url,
    ), "utf8"),
    readFile(new URL(
      "../api/paraai/_lib/source-watermark.mjs",
      import.meta.url,
    ), "utf8"),
  ]);
  assert.match(
    coordinator,
    /humanIntroPageClient:\s*null,/u,
  );
  assert.doesNotMatch(
    coordinator,
    /source-human-intro-point-collector/u,
  );
  assert.match(
    watermark,
    /SOURCE_HUMAN_INTRO_ARTIFACT_DIGEST\s*=\s*null;/u,
  );
});
