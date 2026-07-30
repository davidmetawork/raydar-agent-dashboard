// Pure, hard-dark Human Intro authoritative-evidence verifier.
//
// A Calendar booking whose scheduled end has passed does not prove that a
// phone conversation occurred. This module keeps those facts separate:
//
// - an HMAC-authenticated Calendar observation can verify the exact event
//   revision and a cancellation tombstone;
// - a confirmed event remains pending unless a separate HMAC-authenticated
//   human outcome attestation says `completed` or `no_show`;
// - downstream job state, review approval, and successfulCallVerified are
//   never inputs.
//
// The module accepts already supplied records and verification keys. It reads
// no environment, performs no I/O, owns no store/head/coordinator path, and
// emits only digest/bounded-enum public evidence. It deliberately cannot prove
// receipt durability or that either verification key is an approved production
// key; those require a separate retained producer/key pin. Identity resolution,
// exhaustiveness, source authority, and pinnability remain unavailable.

import {
  createHash,
  createHmac,
  timingSafeEqual,
} from "node:crypto";
import { types as nodeTypes } from "node:util";

import {
  normalizeHumanIntroSourcePointJob,
} from "./source-human-intro-point-collector.mjs";

export const SOURCE_HUMAN_INTRO_AUTHORITATIVE_EVIDENCE_VERSION =
  "human-intro-authoritative-evidence-v1";

const SOURCE = "human_intro";
const CALENDAR_RECEIPT_VERSION =
  "human-intro-calendar-observation-v1";
const CALENDAR_RECEIPT_SOURCE = "google_calendar";
const OUTCOME_RECEIPT_VERSION =
  "human-intro-outcome-attestation-v1";
const OUTCOME_RECEIPT_SOURCE =
  "raydar_human_outcome_attestation";
const DIGEST = /^[a-f0-9]{64}$/u;
const KEY_ID = /^[a-z0-9][a-z0-9._:-]{0,79}$/u;
const CANONICAL_INSTANT =
  /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/u;
const MAX_RECORD_KEYS = 64;
const MAX_ATTESTED_OVERRUN_MS = 4 * 60 * 60_000;

const RECEIPTS_KEYS = Object.freeze([
  "calendarObservation",
  "outcomeAttestation",
].sort());
const OPTIONS_KEYS = Object.freeze([
  "calendarReceiptKey",
  "calendarReceiptKeyId",
  "decisionBoundaryAt",
  "outcomeReceiptKey",
  "outcomeReceiptKeyId",
].sort());
const CALENDAR_RECEIPT_KEYS = Object.freeze([
  "createdAt",
  "eventRevision",
  "intakeEventId",
  "keyId",
  "observedAt",
  "payloadDigest",
  "scheduledEnd",
  "scheduledStart",
  "signature",
  "source",
  "sourceId",
  "status",
  "updatedAt",
  "version",
].sort());
const OUTCOME_RECEIPT_KEYS = Object.freeze([
  "attestedAt",
  "calendarEventRevision",
  "intakeEventId",
  "keyId",
  "occurredAt",
  "outcome",
  "payloadDigest",
  "signature",
  "source",
  "sourceId",
  "version",
].sort());

export class SourceHumanIntroAuthoritativeEvidenceError
  extends Error {
  constructor(code) {
    super(code);
    this.name =
      "SourceHumanIntroAuthoritativeEvidenceError";
    this.code = code;
  }
}

function fail(code) {
  throw new SourceHumanIntroAuthoritativeEvidenceError(code);
}

function plainRecordSnapshot(value, code) {
  if (
    value === null
    || typeof value !== "object"
    || Array.isArray(value)
    || nodeTypes.isProxy(value)
  ) {
    fail(code);
  }
  const prototype = Object.getPrototypeOf(value);
  if (
    prototype !== Object.prototype
    && prototype !== null
  ) {
    fail(code);
  }
  const keys = Reflect.ownKeys(value);
  if (
    keys.length > MAX_RECORD_KEYS
    || keys.some((key) => typeof key !== "string")
  ) {
    fail(code);
  }
  const snapshot = Object.create(null);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(
      value,
      key,
    );
    if (
      !descriptor
      || !Object.prototype.hasOwnProperty.call(
        descriptor,
        "value",
      )
      || descriptor.enumerable !== true
    ) {
      fail(code);
    }
    snapshot[key] = descriptor.value;
  }
  return snapshot;
}

function exactKeys(record, expected, code) {
  const actual = Object.keys(record).sort();
  const required = [...expected].sort();
  if (
    actual.length !== required.length
    || actual.some((key, index) => key !== required[index])
  ) {
    fail(code);
  }
}

function exactText(
  value,
  code,
  {
    maximum = 4_096,
    allowEmpty = false,
  } = {},
) {
  if (
    typeof value !== "string"
    || value.length > maximum
    || (!allowEmpty && value.length === 0)
    || /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    fail(code);
  }
  return value;
}

function canonicalInstant(value, code) {
  const selected = exactText(value, code, {
    maximum: 40,
  });
  const milliseconds = Date.parse(selected);
  if (
    !CANONICAL_INSTANT.test(selected)
    || !Number.isFinite(milliseconds)
    || new Date(milliseconds).toISOString() !== selected
  ) {
    fail(code);
  }
  return selected;
}

function digest(value, code) {
  const selected = exactText(value, code, {
    maximum: 64,
  });
  if (!DIGEST.test(selected)) fail(code);
  return selected;
}

function keyId(value, code) {
  const selected = exactText(value, code, {
    maximum: 80,
  });
  if (!KEY_ID.test(selected)) fail(code);
  return selected;
}

function verificationKey(value, code) {
  const selected = exactText(value, code, {
    maximum: 4_096,
  });
  if (selected.length < 32) fail(code);
  return selected;
}

function canonicalJson(value) {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError(
        "canonical digest values must be finite",
      );
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => (
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    )).join(",")}}`;
  }
  throw new TypeError(
    "canonical digest values must be JSON-safe",
  );
}

function semanticDigest(namespace, value) {
  return createHash("sha256")
    .update(namespace)
    .update("\0")
    .update(canonicalJson(value))
    .digest("hex");
}

function receiptSignature(namespace, body, key) {
  return createHmac("sha256", key)
    .update(namespace)
    .update("\0")
    .update(canonicalJson(body))
    .digest("hex");
}

function verifyReceiptSignature({
  namespace,
  body,
  signature,
  key,
  code,
}) {
  const supplied = digest(signature, code);
  const expected = receiptSignature(namespace, body, key);
  const left = Buffer.from(supplied, "hex");
  const right = Buffer.from(expected, "hex");
  if (
    left.length !== right.length
    || !timingSafeEqual(left, right)
  ) {
    fail(code);
  }
}

function deepFreeze(value) {
  if (
    value
    && typeof value === "object"
    && !Object.isFrozen(value)
  ) {
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

function normalizedReceipts(value) {
  const receipts = plainRecordSnapshot(
    value,
    "SOURCE_HUMAN_INTRO_AUTH_RECEIPTS_INVALID",
  );
  exactKeys(
    receipts,
    RECEIPTS_KEYS,
    "SOURCE_HUMAN_INTRO_AUTH_RECEIPTS_INVALID",
  );
  if (
    receipts.calendarObservation !== null
    && (
      typeof receipts.calendarObservation !== "object"
      || Array.isArray(receipts.calendarObservation)
    )
  ) {
    fail("SOURCE_HUMAN_INTRO_AUTH_CALENDAR_RECEIPT_INVALID");
  }
  if (
    receipts.outcomeAttestation !== null
    && (
      typeof receipts.outcomeAttestation !== "object"
      || Array.isArray(receipts.outcomeAttestation)
    )
  ) {
    fail("SOURCE_HUMAN_INTRO_AUTH_OUTCOME_RECEIPT_INVALID");
  }
  return receipts;
}

function normalizedOptions(value) {
  const options = plainRecordSnapshot(
    value,
    "SOURCE_HUMAN_INTRO_AUTH_OPTIONS_INVALID",
  );
  exactKeys(
    options,
    OPTIONS_KEYS,
    "SOURCE_HUMAN_INTRO_AUTH_OPTIONS_INVALID",
  );
  const decisionBoundaryAt = canonicalInstant(
    options.decisionBoundaryAt,
    "SOURCE_HUMAN_INTRO_AUTH_BOUNDARY_INVALID",
  );
  const normalized = {
    decisionBoundaryAt,
    calendarReceiptKey:
      options.calendarReceiptKey === null
        ? null
        : verificationKey(
          options.calendarReceiptKey,
          "SOURCE_HUMAN_INTRO_AUTH_CALENDAR_KEY_INVALID",
        ),
    calendarReceiptKeyId:
      options.calendarReceiptKeyId === null
        ? null
        : keyId(
          options.calendarReceiptKeyId,
          "SOURCE_HUMAN_INTRO_AUTH_CALENDAR_KEY_INVALID",
        ),
    outcomeReceiptKey:
      options.outcomeReceiptKey === null
        ? null
        : verificationKey(
          options.outcomeReceiptKey,
          "SOURCE_HUMAN_INTRO_AUTH_OUTCOME_KEY_INVALID",
        ),
    outcomeReceiptKeyId:
      options.outcomeReceiptKeyId === null
        ? null
        : keyId(
          options.outcomeReceiptKeyId,
          "SOURCE_HUMAN_INTRO_AUTH_OUTCOME_KEY_INVALID",
        ),
  };
  if (
    (normalized.calendarReceiptKey === null)
      !== (normalized.calendarReceiptKeyId === null)
    || (normalized.outcomeReceiptKey === null)
      !== (normalized.outcomeReceiptKeyId === null)
  ) {
    fail("SOURCE_HUMAN_INTRO_AUTH_OPTIONS_INVALID");
  }
  return normalized;
}

function normalizeCalendarObservation(
  rawReceipt,
  intake,
  options,
) {
  if (rawReceipt === null) {
    if (
      options.calendarReceiptKey !== null
      || options.calendarReceiptKeyId !== null
    ) {
      fail(
        "SOURCE_HUMAN_INTRO_AUTH_CALENDAR_RECEIPT_REQUIRED",
      );
    }
    return null;
  }
  if (
    options.calendarReceiptKey === null
    || options.calendarReceiptKeyId === null
  ) {
    fail("SOURCE_HUMAN_INTRO_AUTH_CALENDAR_KEY_REQUIRED");
  }
  const receipt = plainRecordSnapshot(
    rawReceipt,
    "SOURCE_HUMAN_INTRO_AUTH_CALENDAR_RECEIPT_INVALID",
  );
  exactKeys(
    receipt,
    CALENDAR_RECEIPT_KEYS,
    "SOURCE_HUMAN_INTRO_AUTH_CALENDAR_RECEIPT_INVALID",
  );
  const normalized = {
    version: exactText(
      receipt.version,
      "SOURCE_HUMAN_INTRO_AUTH_CALENDAR_RECEIPT_INVALID",
      { maximum: 80 },
    ),
    source: exactText(
      receipt.source,
      "SOURCE_HUMAN_INTRO_AUTH_CALENDAR_RECEIPT_INVALID",
      { maximum: 80 },
    ),
    keyId: keyId(
      receipt.keyId,
      "SOURCE_HUMAN_INTRO_AUTH_CALENDAR_RECEIPT_INVALID",
    ),
    sourceId: digest(
      receipt.sourceId,
      "SOURCE_HUMAN_INTRO_AUTH_CALENDAR_RECEIPT_INVALID",
    ),
    intakeEventId: digest(
      receipt.intakeEventId,
      "SOURCE_HUMAN_INTRO_AUTH_CALENDAR_RECEIPT_INVALID",
    ),
    payloadDigest: digest(
      receipt.payloadDigest,
      "SOURCE_HUMAN_INTRO_AUTH_CALENDAR_RECEIPT_INVALID",
    ),
    status: exactText(
      receipt.status,
      "SOURCE_HUMAN_INTRO_AUTH_CALENDAR_RECEIPT_INVALID",
      { maximum: 20 },
    ),
    createdAt: canonicalInstant(
      receipt.createdAt,
      "SOURCE_HUMAN_INTRO_AUTH_CALENDAR_TIME_INVALID",
    ),
    updatedAt: canonicalInstant(
      receipt.updatedAt,
      "SOURCE_HUMAN_INTRO_AUTH_CALENDAR_TIME_INVALID",
    ),
    scheduledStart: canonicalInstant(
      receipt.scheduledStart,
      "SOURCE_HUMAN_INTRO_AUTH_CALENDAR_TIME_INVALID",
    ),
    scheduledEnd: canonicalInstant(
      receipt.scheduledEnd,
      "SOURCE_HUMAN_INTRO_AUTH_CALENDAR_TIME_INVALID",
    ),
    observedAt: canonicalInstant(
      receipt.observedAt,
      "SOURCE_HUMAN_INTRO_AUTH_CALENDAR_TIME_INVALID",
    ),
    eventRevision: digest(
      receipt.eventRevision,
      "SOURCE_HUMAN_INTRO_AUTH_CALENDAR_REVISION_INVALID",
    ),
  };
  if (
    normalized.version !== CALENDAR_RECEIPT_VERSION
    || normalized.source !== CALENDAR_RECEIPT_SOURCE
    || normalized.keyId !== options.calendarReceiptKeyId
    || !["confirmed", "cancelled"].includes(normalized.status)
    || normalized.sourceId !== intake.sourceId
    || normalized.intakeEventId !== intake.intakeEventId
    || normalized.payloadDigest !== intake.payloadDigest
    || normalized.createdAt !== intake.bookingCreatedAt
    || normalized.scheduledStart !== intake.scheduledStart
    || normalized.scheduledEnd !== intake.scheduledEnd
  ) {
    fail(
      "SOURCE_HUMAN_INTRO_AUTH_CALENDAR_CONTINUITY_INVALID",
    );
  }
  if (
    Date.parse(normalized.updatedAt)
      < Date.parse(normalized.createdAt)
    || Date.parse(normalized.observedAt)
      < Date.parse(normalized.updatedAt)
    || Date.parse(normalized.observedAt)
      < Date.parse(options.decisionBoundaryAt)
  ) {
    fail("SOURCE_HUMAN_INTRO_AUTH_CALENDAR_TIME_INVALID");
  }
  const eventRevision = semanticDigest(
    "phase4-human-intro-calendar-event-revision-v1",
    {
      sourceId: normalized.sourceId,
      intakeEventId: normalized.intakeEventId,
      payloadDigest: normalized.payloadDigest,
      status: normalized.status,
      createdAt: normalized.createdAt,
      updatedAt: normalized.updatedAt,
      scheduledStart: normalized.scheduledStart,
      scheduledEnd: normalized.scheduledEnd,
    },
  );
  if (normalized.eventRevision !== eventRevision) {
    fail(
      "SOURCE_HUMAN_INTRO_AUTH_CALENDAR_REVISION_INVALID",
    );
  }
  const body = {
    ...normalized,
    eventRevision,
  };
  verifyReceiptSignature({
    namespace: "phase4-human-intro-calendar-receipt-v1",
    body,
    signature: receipt.signature,
    key: options.calendarReceiptKey,
    code:
      "SOURCE_HUMAN_INTRO_AUTH_CALENDAR_SIGNATURE_INVALID",
  });
  return {
    ...body,
    verificationKeyCommitmentDigest: semanticDigest(
      "phase4-human-intro-calendar-verification-key-v1",
      options.calendarReceiptKey,
    ),
    receiptDigest: semanticDigest(
      "phase4-human-intro-calendar-receipt-digest-v1",
      {
        ...body,
        signature: receipt.signature,
      },
    ),
  };
}

function normalizeOutcomeAttestation(
  rawReceipt,
  intake,
  calendar,
  options,
) {
  if (rawReceipt === null) {
    if (
      options.outcomeReceiptKey !== null
      || options.outcomeReceiptKeyId !== null
    ) {
      fail(
        "SOURCE_HUMAN_INTRO_AUTH_OUTCOME_RECEIPT_REQUIRED",
      );
    }
    return null;
  }
  if (!calendar) {
    fail(
      "SOURCE_HUMAN_INTRO_AUTH_CALENDAR_RECEIPT_REQUIRED",
    );
  }
  if (
    options.outcomeReceiptKey === null
    || options.outcomeReceiptKeyId === null
  ) {
    fail("SOURCE_HUMAN_INTRO_AUTH_OUTCOME_KEY_REQUIRED");
  }
  const receipt = plainRecordSnapshot(
    rawReceipt,
    "SOURCE_HUMAN_INTRO_AUTH_OUTCOME_RECEIPT_INVALID",
  );
  exactKeys(
    receipt,
    OUTCOME_RECEIPT_KEYS,
    "SOURCE_HUMAN_INTRO_AUTH_OUTCOME_RECEIPT_INVALID",
  );
  const occurredAt = receipt.occurredAt === null
    ? null
    : canonicalInstant(
      receipt.occurredAt,
      "SOURCE_HUMAN_INTRO_AUTH_OUTCOME_TIME_INVALID",
    );
  const normalized = {
    version: exactText(
      receipt.version,
      "SOURCE_HUMAN_INTRO_AUTH_OUTCOME_RECEIPT_INVALID",
      { maximum: 80 },
    ),
    source: exactText(
      receipt.source,
      "SOURCE_HUMAN_INTRO_AUTH_OUTCOME_RECEIPT_INVALID",
      { maximum: 80 },
    ),
    keyId: keyId(
      receipt.keyId,
      "SOURCE_HUMAN_INTRO_AUTH_OUTCOME_RECEIPT_INVALID",
    ),
    sourceId: digest(
      receipt.sourceId,
      "SOURCE_HUMAN_INTRO_AUTH_OUTCOME_RECEIPT_INVALID",
    ),
    intakeEventId: digest(
      receipt.intakeEventId,
      "SOURCE_HUMAN_INTRO_AUTH_OUTCOME_RECEIPT_INVALID",
    ),
    payloadDigest: digest(
      receipt.payloadDigest,
      "SOURCE_HUMAN_INTRO_AUTH_OUTCOME_RECEIPT_INVALID",
    ),
    calendarEventRevision: digest(
      receipt.calendarEventRevision,
      "SOURCE_HUMAN_INTRO_AUTH_OUTCOME_RECEIPT_INVALID",
    ),
    outcome: exactText(
      receipt.outcome,
      "SOURCE_HUMAN_INTRO_AUTH_OUTCOME_RECEIPT_INVALID",
      { maximum: 20 },
    ),
    occurredAt,
    attestedAt: canonicalInstant(
      receipt.attestedAt,
      "SOURCE_HUMAN_INTRO_AUTH_OUTCOME_TIME_INVALID",
    ),
  };
  if (
    normalized.version !== OUTCOME_RECEIPT_VERSION
    || normalized.source !== OUTCOME_RECEIPT_SOURCE
    || normalized.keyId !== options.outcomeReceiptKeyId
    || !["completed", "no_show"].includes(normalized.outcome)
    || normalized.sourceId !== intake.sourceId
    || normalized.intakeEventId !== intake.intakeEventId
    || normalized.payloadDigest !== intake.payloadDigest
    || normalized.calendarEventRevision
      !== calendar.eventRevision
  ) {
    fail(
      "SOURCE_HUMAN_INTRO_AUTH_OUTCOME_CONTINUITY_INVALID",
    );
  }
  const completed = normalized.outcome === "completed";
  if (
    completed !== (normalized.occurredAt !== null)
    || Date.parse(normalized.attestedAt)
      < Date.parse(intake.scheduledEnd)
    || Date.parse(normalized.attestedAt)
      < Date.parse(calendar.updatedAt)
    || Date.parse(normalized.attestedAt)
      > Date.parse(options.decisionBoundaryAt)
    || (
      completed
      && (
        Date.parse(normalized.occurredAt)
          < Date.parse(intake.scheduledStart)
        || Date.parse(normalized.occurredAt)
          > Date.parse(intake.scheduledEnd)
            + MAX_ATTESTED_OVERRUN_MS
        || Date.parse(normalized.occurredAt)
          > Date.parse(normalized.attestedAt)
      )
    )
  ) {
    fail("SOURCE_HUMAN_INTRO_AUTH_OUTCOME_TIME_INVALID");
  }
  const cancelledBeforeBoundary = (
    calendar.status === "cancelled"
    && Date.parse(calendar.updatedAt)
      < Date.parse(options.decisionBoundaryAt)
  );
  if (cancelledBeforeBoundary) {
    fail("SOURCE_HUMAN_INTRO_AUTH_OUTCOME_CANCEL_CONFLICT");
  }
  const body = { ...normalized };
  verifyReceiptSignature({
    namespace: "phase4-human-intro-outcome-receipt-v1",
    body,
    signature: receipt.signature,
    key: options.outcomeReceiptKey,
    code:
      "SOURCE_HUMAN_INTRO_AUTH_OUTCOME_SIGNATURE_INVALID",
  });
  return {
    ...body,
    verificationKeyCommitmentDigest: semanticDigest(
      "phase4-human-intro-outcome-verification-key-v1",
      options.outcomeReceiptKey,
    ),
    receiptDigest: semanticDigest(
      "phase4-human-intro-outcome-receipt-digest-v1",
      {
        ...body,
        signature: receipt.signature,
      },
    ),
  };
}

export function normalizeHumanIntroAuthoritativeEvidence(
  rawJob,
  rawReceipts,
  rawOptions,
) {
  const receipts = normalizedReceipts(rawReceipts);
  const options = normalizedOptions(rawOptions);
  const intake = normalizeHumanIntroSourcePointJob(
    rawJob,
    {
      decisionBoundaryAt: options.decisionBoundaryAt,
    },
  );
  const calendarObservation =
    normalizeCalendarObservation(
      receipts.calendarObservation,
      intake,
      options,
    );
  const outcomeAttestation =
    normalizeOutcomeAttestation(
      receipts.outcomeAttestation,
      intake,
      calendarObservation,
      options,
    );
  const cancellationTombstoneAvailable = Boolean(
    calendarObservation?.status === "cancelled"
    && Date.parse(calendarObservation.updatedAt)
      < Date.parse(options.decisionBoundaryAt),
  );
  const classification = cancellationTombstoneAvailable
    ? "failure"
    : outcomeAttestation?.outcome === "completed"
      ? "success"
      : outcomeAttestation?.outcome === "no_show"
        ? "failure"
        : "pending";
  return deepFreeze({
    version:
      SOURCE_HUMAN_INTRO_AUTHORITATIVE_EVIDENCE_VERSION,
    source: SOURCE,
    intake,
    calendarObservation,
    outcomeAttestation,
    classification,
    durableIntakeAvailable: true,
    signedCalendarObservationVerified:
      calendarObservation !== null,
    signedOutcomeAttestationVerified:
      outcomeAttestation !== null,
    approvedReceiptKeyAvailable: false,
    receiptProducerAvailable: false,
    durableSignedReceiptAvailable: false,
    sourceRecordRevisionAvailable:
      calendarObservation !== null,
    sourceHeadAvailable: false,
    sourceExhaustivenessAvailable: false,
    cancellationTombstoneAvailable,
    occurredEvidenceAvailable:
      outcomeAttestation?.outcome === "completed",
    outcomeEvidenceAvailable:
      classification !== "pending",
    successClassificationAvailable:
      classification !== "pending",
    candidateIdentityResolutionAvailable: false,
    sourceAuthorityAvailable: false,
    pinnable: false,
  });
}

export function humanIntroAuthoritativeSourceEvidence(
  rawJob,
  rawReceipts,
  rawOptions,
) {
  const projection =
    normalizeHumanIntroAuthoritativeEvidence(
      rawJob,
      rawReceipts,
      rawOptions,
    );
  const calendarObservationDigest =
    projection.calendarObservation === null
      ? null
      : semanticDigest(
        "phase4-human-intro-calendar-observation-v1",
        projection.calendarObservation,
      );
  const outcomeAttestationDigest =
    projection.outcomeAttestation === null
      ? null
      : semanticDigest(
        "phase4-human-intro-outcome-attestation-v1",
        projection.outcomeAttestation,
      );
  const sourceRecordRevisionDigest =
    projection.calendarObservation === null
      ? null
      : semanticDigest(
        "phase4-human-intro-source-record-revision-v1",
        {
          durableIntakeDigest: semanticDigest(
            "phase4-human-intro-durable-intake-projection-v1",
            projection.intake,
          ),
          calendarObservationDigest,
          outcomeAttestationDigest,
          classification: projection.classification,
        },
      );
  return deepFreeze({
    version:
      SOURCE_HUMAN_INTRO_AUTHORITATIVE_EVIDENCE_VERSION,
    source: SOURCE,
    privateProjectionDigest: semanticDigest(
      "phase4-human-intro-authoritative-private-v1",
      projection,
    ),
    calendarObservationDigest,
    outcomeAttestationDigest,
    sourceRecordRevisionDigest,
    decisionBoundaryDigest: semanticDigest(
      "phase4-source-decision-boundary-v1",
      projection.intake.decisionBoundaryAt,
    ),
    classification: projection.classification,
    durableIntakeAvailable: true,
    signedCalendarObservationVerified:
      projection.signedCalendarObservationVerified,
    signedOutcomeAttestationVerified:
      projection.signedOutcomeAttestationVerified,
    approvedReceiptKeyAvailable: false,
    receiptProducerAvailable: false,
    durableSignedReceiptAvailable: false,
    sourceRecordRevisionAvailable:
      projection.sourceRecordRevisionAvailable,
    sourceHeadAvailable: false,
    sourceExhaustivenessAvailable: false,
    cancellationTombstoneAvailable:
      projection.cancellationTombstoneAvailable,
    occurredEvidenceAvailable:
      projection.occurredEvidenceAvailable,
    outcomeEvidenceAvailable:
      projection.outcomeEvidenceAvailable,
    successClassificationAvailable:
      projection.successClassificationAvailable,
    candidateIdentityResolutionAvailable: false,
    sourceAuthorityAvailable: false,
    pinnable: false,
  });
}
