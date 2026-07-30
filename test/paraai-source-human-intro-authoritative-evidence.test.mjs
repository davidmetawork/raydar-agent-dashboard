import {
  createHash,
  createHmac,
} from "node:crypto";
import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import test from "node:test";

import {
  HUMAN_INTRO_PARSER_VERSION,
  HUMAN_INTRO_SOURCE,
  humanIntroCallRecord,
  humanIntroEventId,
  humanIntroJobId,
  persistedHumanIntroMetadata,
} from "../api/paraai/_lib/human-intro.mjs";
import * as authoritativeModule from
  "../api/paraai/_lib/source-human-intro-authoritative-evidence.mjs";
import {
  SOURCE_HUMAN_INTRO_AUTHORITATIVE_EVIDENCE_VERSION,
  SourceHumanIntroAuthoritativeEvidenceError,
  humanIntroAuthoritativeSourceEvidence,
  normalizeHumanIntroAuthoritativeEvidence,
} from
  "../api/paraai/_lib/source-human-intro-authoritative-evidence.mjs";
import {
  SOURCE_HUMAN_INTRO_ARTIFACT_DIGEST,
} from "../api/paraai/_lib/source-watermark.mjs";

const SOURCE_ID = "a".repeat(64);
const ARTIFACT_SHA256 = "b".repeat(64);
const CALENDAR_KEY = `calendar-${"c".repeat(64)}`;
const OUTCOME_KEY = `outcome-${"d".repeat(64)}`;
const CALENDAR_KEY_ID = "calendar-source-2026-07";
const OUTCOME_KEY_ID = "human-outcome-2026-07";
const BOUNDARY = "2026-07-25T12:00:00.000Z";

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

function sign(namespace, body, key) {
  return createHmac("sha256", key)
    .update(namespace)
    .update("\0")
    .update(canonicalJson(body))
    .digest("hex");
}

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

function durableJob(overrides = {}) {
  const selectedPayload = payload();
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

function options({
  calendar = false,
  outcome = false,
  ...overrides
} = {}) {
  return {
    decisionBoundaryAt: BOUNDARY,
    calendarReceiptKey: calendar ? CALENDAR_KEY : null,
    calendarReceiptKeyId:
      calendar ? CALENDAR_KEY_ID : null,
    outcomeReceiptKey: outcome ? OUTCOME_KEY : null,
    outcomeReceiptKeyId:
      outcome ? OUTCOME_KEY_ID : null,
    ...overrides,
  };
}

function unsignedCalendarReceipt(overrides = {}) {
  const body = {
    version: "human-intro-calendar-observation-v1",
    source: "google_calendar",
    keyId: CALENDAR_KEY_ID,
    sourceId: SOURCE_ID,
    intakeEventId: humanIntroEventId(SOURCE_ID),
    payloadDigest: durableJob().humanCallMeta.payloadDigest,
    status: "confirmed",
    createdAt: "2026-07-20T08:00:00.000Z",
    updatedAt: "2026-07-24T09:00:00.000Z",
    scheduledStart: "2026-07-25T10:00:00.000Z",
    scheduledEnd: "2026-07-25T10:30:00.000Z",
    observedAt: "2026-07-25T12:01:00.000Z",
    ...overrides,
  };
  body.eventRevision = semanticDigest(
    "phase4-human-intro-calendar-event-revision-v1",
    {
      sourceId: body.sourceId,
      intakeEventId: body.intakeEventId,
      payloadDigest: body.payloadDigest,
      status: body.status,
      createdAt: body.createdAt,
      updatedAt: body.updatedAt,
      scheduledStart: body.scheduledStart,
      scheduledEnd: body.scheduledEnd,
    },
  );
  return body;
}

function calendarReceipt(overrides = {}, key = CALENDAR_KEY) {
  const body = unsignedCalendarReceipt(overrides);
  return {
    ...body,
    signature: sign(
      "phase4-human-intro-calendar-receipt-v1",
      body,
      key,
    ),
  };
}

function unsignedOutcomeReceipt(
  calendar,
  overrides = {},
) {
  return {
    version: "human-intro-outcome-attestation-v1",
    source: "raydar_human_outcome_attestation",
    keyId: OUTCOME_KEY_ID,
    sourceId: SOURCE_ID,
    intakeEventId: humanIntroEventId(SOURCE_ID),
    payloadDigest: durableJob().humanCallMeta.payloadDigest,
    calendarEventRevision: calendar.eventRevision,
    outcome: "completed",
    occurredAt: "2026-07-25T10:05:00.000Z",
    attestedAt: "2026-07-25T11:00:00.000Z",
    ...overrides,
  };
}

function outcomeReceipt(
  calendar,
  overrides = {},
  key = OUTCOME_KEY,
) {
  const body = unsignedOutcomeReceipt(calendar, overrides);
  return {
    ...body,
    signature: sign(
      "phase4-human-intro-outcome-receipt-v1",
      body,
      key,
    ),
  };
}

function receipts(
  calendarObservation = null,
  outcomeAttestation = null,
) {
  return {
    calendarObservation,
    outcomeAttestation,
  };
}

function expectCode(operation, code) {
  assert.throws(
    operation,
    (error) => (
      error
        instanceof SourceHumanIntroAuthoritativeEvidenceError
      && error.code === code
    ),
  );
}

test("an ended confirmed booking without signed source evidence remains pending", () => {
  const projection =
    normalizeHumanIntroAuthoritativeEvidence(
      durableJob({
        state: "enrolled",
        successfulCallVerified: true,
        outcome: "occurred_success",
        calendarCancelled: false,
      }),
      receipts(),
      options(),
    );
  assert.equal(
    projection.version,
    SOURCE_HUMAN_INTRO_AUTHORITATIVE_EVIDENCE_VERSION,
  );
  assert.equal(projection.source, "human_intro");
  assert.equal(projection.classification, "pending");
  assert.equal(projection.durableIntakeAvailable, true);
  for (const field of [
    "durableSignedReceiptAvailable",
    "signedCalendarObservationVerified",
    "signedOutcomeAttestationVerified",
    "approvedReceiptKeyAvailable",
    "receiptProducerAvailable",
    "sourceRecordRevisionAvailable",
    "sourceHeadAvailable",
    "sourceExhaustivenessAvailable",
    "cancellationTombstoneAvailable",
    "occurredEvidenceAvailable",
    "outcomeEvidenceAvailable",
    "successClassificationAvailable",
    "candidateIdentityResolutionAvailable",
    "sourceAuthorityAvailable",
    "pinnable",
  ]) {
    assert.equal(projection[field], false, field);
  }
  assert.equal(projection.calendarObservation, null);
  assert.equal(projection.outcomeAttestation, null);
  assert.equal(Object.isFrozen(projection), true);
  assert.equal(Object.isFrozen(projection.intake), true);
});

test("a signed confirmed Calendar revision proves revision but not occurrence or outcome", () => {
  const calendar = calendarReceipt();
  const projection =
    normalizeHumanIntroAuthoritativeEvidence(
      durableJob(),
      receipts(calendar),
      options({ calendar: true }),
    );
  assert.equal(projection.classification, "pending");
  assert.equal(
    projection.signedCalendarObservationVerified,
    true,
  );
  assert.equal(
    projection.signedOutcomeAttestationVerified,
    false,
  );
  assert.equal(projection.approvedReceiptKeyAvailable, false);
  assert.equal(projection.receiptProducerAvailable, false);
  assert.equal(projection.durableSignedReceiptAvailable, false);
  assert.equal(projection.sourceRecordRevisionAvailable, true);
  assert.equal(
    projection.cancellationTombstoneAvailable,
    false,
  );
  assert.equal(projection.occurredEvidenceAvailable, false);
  assert.equal(projection.outcomeEvidenceAvailable, false);
  assert.equal(
    projection.successClassificationAvailable,
    false,
  );
  assert.equal(
    Object.hasOwn(
      projection.calendarObservation,
      "signature",
    ),
    false,
  );
});

test("a separate signed completed attestation proves occurrence and success", () => {
  const calendar = calendarReceipt();
  const outcome = outcomeReceipt(calendar);
  const projection =
    normalizeHumanIntroAuthoritativeEvidence(
      durableJob(),
      receipts(calendar, outcome),
      options({ calendar: true, outcome: true }),
    );
  assert.equal(projection.classification, "success");
  assert.equal(
    projection.signedCalendarObservationVerified,
    true,
  );
  assert.equal(
    projection.signedOutcomeAttestationVerified,
    true,
  );
  assert.equal(projection.durableSignedReceiptAvailable, false);
  assert.equal(projection.occurredEvidenceAvailable, true);
  assert.equal(projection.outcomeEvidenceAvailable, true);
  assert.equal(
    projection.successClassificationAvailable,
    true,
  );
  assert.equal(projection.candidateIdentityResolutionAvailable, false);
  assert.equal(projection.sourceAuthorityAvailable, false);
  assert.equal(projection.pinnable, false);
  assert.equal(
    Object.hasOwn(projection.outcomeAttestation, "signature"),
    false,
  );
});

test("a signed no-show is terminal failure without inventing occurrence", () => {
  const calendar = calendarReceipt();
  const outcome = outcomeReceipt(calendar, {
    outcome: "no_show",
    occurredAt: null,
  });
  const projection =
    normalizeHumanIntroAuthoritativeEvidence(
      durableJob(),
      receipts(calendar, outcome),
      options({ calendar: true, outcome: true }),
    );
  assert.equal(projection.classification, "failure");
  assert.equal(projection.occurredEvidenceAvailable, false);
  assert.equal(projection.outcomeEvidenceAvailable, true);
  assert.equal(
    projection.successClassificationAvailable,
    true,
  );
  assert.equal(
    projection.cancellationTombstoneAvailable,
    false,
  );
});

test("a signed pre-boundary Calendar cancellation is a terminal tombstone", () => {
  const calendar = calendarReceipt({
    status: "cancelled",
    updatedAt: "2026-07-25T09:30:00.000Z",
  });
  const projection =
    normalizeHumanIntroAuthoritativeEvidence(
      durableJob(),
      receipts(calendar),
      options({ calendar: true }),
    );
  assert.equal(projection.classification, "failure");
  assert.equal(
    projection.cancellationTombstoneAvailable,
    true,
  );
  assert.equal(projection.occurredEvidenceAvailable, false);
  assert.equal(projection.outcomeEvidenceAvailable, true);
  assert.equal(
    projection.successClassificationAvailable,
    true,
  );
});

test("an attestation cannot bind a Calendar revision that did not exist yet", () => {
  const calendar = calendarReceipt({
    status: "cancelled",
    updatedAt: "2026-07-25T12:30:00.000Z",
    observedAt: "2026-07-25T12:31:00.000Z",
  });
  const outcome = outcomeReceipt(calendar);
  expectCode(
    () => normalizeHumanIntroAuthoritativeEvidence(
      durableJob(),
      receipts(calendar, outcome),
      options({ calendar: true, outcome: true }),
    ),
    "SOURCE_HUMAN_INTRO_AUTH_OUTCOME_TIME_INVALID",
  );
});

test("signatures, revisions, key ids, and intake continuity fail closed", () => {
  const calendar = calendarReceipt();
  for (const [changed, code] of [
    [
      { ...calendar, signature: "0".repeat(64) },
      "SOURCE_HUMAN_INTRO_AUTH_CALENDAR_SIGNATURE_INVALID",
    ],
    [
      { ...calendar, sourceId: "f".repeat(64) },
      "SOURCE_HUMAN_INTRO_AUTH_CALENDAR_CONTINUITY_INVALID",
    ],
    [
      { ...calendar, keyId: "wrong-key" },
      "SOURCE_HUMAN_INTRO_AUTH_CALENDAR_CONTINUITY_INVALID",
    ],
    [
      { ...calendar, eventRevision: "f".repeat(64) },
      "SOURCE_HUMAN_INTRO_AUTH_CALENDAR_REVISION_INVALID",
    ],
  ]) {
    expectCode(
      () => normalizeHumanIntroAuthoritativeEvidence(
        durableJob(),
        receipts(changed),
        options({ calendar: true }),
      ),
      code,
    );
  }

  const outcome = outcomeReceipt(calendar);
  for (const [changed, code] of [
    [
      { ...outcome, signature: "0".repeat(64) },
      "SOURCE_HUMAN_INTRO_AUTH_OUTCOME_SIGNATURE_INVALID",
    ],
    [
      {
        ...outcome,
        calendarEventRevision: "f".repeat(64),
      },
      "SOURCE_HUMAN_INTRO_AUTH_OUTCOME_CONTINUITY_INVALID",
    ],
    [
      { ...outcome, keyId: "wrong-key" },
      "SOURCE_HUMAN_INTRO_AUTH_OUTCOME_CONTINUITY_INVALID",
    ],
  ]) {
    expectCode(
      () => normalizeHumanIntroAuthoritativeEvidence(
        durableJob(),
        receipts(calendar, changed),
        options({ calendar: true, outcome: true }),
      ),
      code,
    );
  }
});

test("pre-boundary cancellation conflicts with any human outcome attestation", () => {
  const calendar = calendarReceipt({
    status: "cancelled",
    updatedAt: "2026-07-25T09:30:00.000Z",
  });
  const outcome = outcomeReceipt(calendar);
  expectCode(
    () => normalizeHumanIntroAuthoritativeEvidence(
      durableJob(),
      receipts(calendar, outcome),
      options({ calendar: true, outcome: true }),
    ),
    "SOURCE_HUMAN_INTRO_AUTH_OUTCOME_CANCEL_CONFLICT",
  );
});

test("receipt time ordering and the decision boundary are exact", () => {
  const beforeBoundaryObservation = calendarReceipt({
    observedAt: "2026-07-25T11:59:59.999Z",
  });
  expectCode(
    () => normalizeHumanIntroAuthoritativeEvidence(
      durableJob(),
      receipts(beforeBoundaryObservation),
      options({ calendar: true }),
    ),
    "SOURCE_HUMAN_INTRO_AUTH_CALENDAR_TIME_INVALID",
  );

  const calendar = calendarReceipt();
  for (const overrides of [
    { attestedAt: "2026-07-25T12:00:00.001Z" },
    { attestedAt: "2026-07-25T10:29:59.999Z" },
    { occurredAt: "2026-07-25T09:59:59.999Z" },
    { occurredAt: "2026-07-25T14:30:00.001Z" },
    { outcome: "no_show", occurredAt: "2026-07-25T10:05:00.000Z" },
    { outcome: "completed", occurredAt: null },
  ]) {
    const outcome = outcomeReceipt(calendar, overrides);
    expectCode(
      () => normalizeHumanIntroAuthoritativeEvidence(
        durableJob(),
        receipts(calendar, outcome),
        options({ calendar: true, outcome: true }),
      ),
      "SOURCE_HUMAN_INTRO_AUTH_OUTCOME_TIME_INVALID",
    );
  }
});

test("receipt and verification-key presence is symmetric and exact", () => {
  const calendar = calendarReceipt();
  const outcome = outcomeReceipt(calendar);
  expectCode(
    () => normalizeHumanIntroAuthoritativeEvidence(
      durableJob(),
      receipts(calendar),
      options(),
    ),
    "SOURCE_HUMAN_INTRO_AUTH_CALENDAR_KEY_REQUIRED",
  );
  expectCode(
    () => normalizeHumanIntroAuthoritativeEvidence(
      durableJob(),
      receipts(),
      options({ calendar: true }),
    ),
    "SOURCE_HUMAN_INTRO_AUTH_CALENDAR_RECEIPT_REQUIRED",
  );
  expectCode(
    () => normalizeHumanIntroAuthoritativeEvidence(
      durableJob(),
      receipts(null, outcome),
      options({ outcome: true }),
    ),
    "SOURCE_HUMAN_INTRO_AUTH_CALENDAR_RECEIPT_REQUIRED",
  );
  expectCode(
    () => normalizeHumanIntroAuthoritativeEvidence(
      durableJob(),
      receipts(calendar, outcome),
      options({ calendar: true }),
    ),
    "SOURCE_HUMAN_INTRO_AUTH_OUTCOME_KEY_REQUIRED",
  );
  expectCode(
    () => normalizeHumanIntroAuthoritativeEvidence(
      durableJob(),
      receipts(calendar),
      options({
        calendar: true,
        force: true,
      }),
    ),
    "SOURCE_HUMAN_INTRO_AUTH_OPTIONS_INVALID",
  );
});

test("downstream job state can neither mint nor alter authoritative evidence", () => {
  const calendar = calendarReceipt();
  const outcome = outcomeReceipt(calendar);
  const baseline = humanIntroAuthoritativeSourceEvidence(
    durableJob(),
    receipts(calendar, outcome),
    options({ calendar: true, outcome: true }),
  );
  const downstream = durableJob({
    state: "enrolled",
    successfulCallVerified: false,
    outcome: "cancelled",
    calendarCancelled: true,
    cancelledAt: "2026-07-25T09:00:00.000Z",
    reviewAction: {
      appliedAt: "2026-07-25T11:00:00.000Z",
      reasons: ["human_intro_without_transcript"],
    },
  });
  assert.deepEqual(
    humanIntroAuthoritativeSourceEvidence(
      downstream,
      receipts(calendar, outcome),
      options({ calendar: true, outcome: true }),
    ),
    baseline,
  );
});

test("public evidence is digest-only and excludes ids, PII, times, signatures, and keys", () => {
  const calendar = calendarReceipt();
  const outcome = outcomeReceipt(calendar);
  const evidence = humanIntroAuthoritativeSourceEvidence(
    durableJob(),
    receipts(calendar, outcome),
    options({ calendar: true, outcome: true }),
  );
  assert.deepEqual(Object.keys(evidence), [
    "version",
    "source",
    "privateProjectionDigest",
    "calendarObservationDigest",
    "outcomeAttestationDigest",
    "sourceRecordRevisionDigest",
    "decisionBoundaryDigest",
    "classification",
    "durableIntakeAvailable",
    "signedCalendarObservationVerified",
    "signedOutcomeAttestationVerified",
    "approvedReceiptKeyAvailable",
    "receiptProducerAvailable",
    "durableSignedReceiptAvailable",
    "sourceRecordRevisionAvailable",
    "sourceHeadAvailable",
    "sourceExhaustivenessAvailable",
    "cancellationTombstoneAvailable",
    "occurredEvidenceAvailable",
    "outcomeEvidenceAvailable",
    "successClassificationAvailable",
    "candidateIdentityResolutionAvailable",
    "sourceAuthorityAvailable",
    "pinnable",
  ]);
  for (const key of [
    "privateProjectionDigest",
    "calendarObservationDigest",
    "outcomeAttestationDigest",
    "sourceRecordRevisionDigest",
    "decisionBoundaryDigest",
  ]) {
    assert.match(evidence[key], /^[a-f0-9]{64}$/u);
  }
  assert.equal(evidence.classification, "success");
  const serialized = JSON.stringify(evidence);
  for (const forbidden of [
    SOURCE_ID,
    humanIntroEventId(SOURCE_ID),
    durableJob().humanCallMeta.payloadDigest,
    durableJob().candidate.fullName,
    durableJob().candidate.email,
    durableJob().candidate.linkedin,
    durableJob().callStartedAt,
    durableJob().callEndedAt,
    calendar.signature,
    outcome.signature,
    CALENDAR_KEY,
    OUTCOME_KEY,
    CALENDAR_KEY_ID,
    OUTCOME_KEY_ID,
    BOUNDARY,
  ]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
});

test("hostile receipt and option records fail without invoking accessors", () => {
  expectCode(
    () => normalizeHumanIntroAuthoritativeEvidence(
      durableJob(),
      new Proxy(receipts(), {}),
      options(),
    ),
    "SOURCE_HUMAN_INTRO_AUTH_RECEIPTS_INVALID",
  );
  expectCode(
    () => normalizeHumanIntroAuthoritativeEvidence(
      durableJob(),
      receipts(),
      new Proxy(options(), {}),
    ),
    "SOURCE_HUMAN_INTRO_AUTH_OPTIONS_INVALID",
  );
  let getterCalls = 0;
  const hostileCalendar = calendarReceipt();
  Object.defineProperty(hostileCalendar, "status", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return "confirmed";
    },
  });
  expectCode(
    () => normalizeHumanIntroAuthoritativeEvidence(
      durableJob(),
      receipts(hostileCalendar),
      options({ calendar: true }),
    ),
    "SOURCE_HUMAN_INTRO_AUTH_CALENDAR_RECEIPT_INVALID",
  );
  assert.equal(getterCalls, 0);

  const symbolic = calendarReceipt();
  symbolic[Symbol("success")] = true;
  expectCode(
    () => normalizeHumanIntroAuthoritativeEvidence(
      durableJob(),
      receipts(symbolic),
      options({ calendar: true }),
    ),
    "SOURCE_HUMAN_INTRO_AUTH_CALENDAR_RECEIPT_INVALID",
  );
});

test("the authoritative verifier exports no I/O, store, head, coordinator, or activation surface", async () => {
  assert.deepEqual(Object.keys(authoritativeModule).sort(), [
    "SOURCE_HUMAN_INTRO_AUTHORITATIVE_EVIDENCE_VERSION",
    "SourceHumanIntroAuthoritativeEvidenceError",
    "humanIntroAuthoritativeSourceEvidence",
    "normalizeHumanIntroAuthoritativeEvidence",
  ]);
  const source = await readFile(
    new URL(
      "../api/paraai/_lib/source-human-intro-authoritative-evidence.mjs",
      import.meta.url,
    ),
    "utf8",
  );
  const imports = [
    ...source.matchAll(/\bfrom\s+["']([^"']+)["']/gu),
  ].map((match) => match[1]).sort();
  assert.deepEqual(imports, [
    "./source-human-intro-point-collector.mjs",
    "node:crypto",
    "node:util",
  ]);
  for (const forbidden of [
    /\bfetch\s*\(/u,
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

test("Human Intro release pin and coordinator importer remain null", async () => {
  assert.equal(SOURCE_HUMAN_INTRO_ARTIFACT_DIGEST, null);
  const coordinator = await readFile(
    new URL(
      "../api/paraai/_lib/source-capture-coordinator.mjs",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(
    coordinator,
    /humanIntroPageClient:\s*null,/u,
  );
  assert.doesNotMatch(
    coordinator,
    /source-human-intro-authoritative-evidence/u,
  );
});
