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
import {
  humanIntroCalendarReceiptKeyCommitment,
} from
  "../api/paraai/_lib/human-intro-calendar-receipt-key.mjs";
import {
  HUMAN_INTRO_OUTCOME_RECEIPT_APPROVED_KEY_COMMITMENT,
  HUMAN_INTRO_OUTCOME_RECEIPT_APPROVED_KEY_ID,
  HUMAN_INTRO_OUTCOME_RECEIPT_KEY_ENV,
  HumanIntroOutcomeReceiptKeyError,
  humanIntroOutcomeReceiptKeyCommitment,
  humanIntroOutcomeReceiptKeyConfigured,
  verifyHumanIntroOutcomeReceiptKey,
} from
  "../api/paraai/_lib/human-intro-outcome-receipt-key.mjs";
import {
  HUMAN_INTRO_OUTCOME_RECEIPT_RETENTION_VERSION,
  HumanIntroOutcomeReceiptStoreError,
  createHumanIntroOutcomeReceiptStore,
} from
  "../api/paraai/_lib/human-intro-outcome-receipt-store.mjs";
import {
  HUMAN_INTRO_OUTCOME_RECEIPT_INGEST_ENV,
  handleHumanIntroOutcomeReceipt,
  humanIntroOutcomeReceiptIngestEnabled,
} from "../api/paraai/human-intro-outcome-receipt.mjs";

const SOURCE_ID = "a".repeat(64);
const ARTIFACT_SHA256 = "b".repeat(64);
const CALENDAR_KEY =
  Buffer.alloc(32, 7).toString("base64url");
const CALENDAR_KEY_ID = "calendar-test-2026-07";
const CALENDAR_KEY_COMMITMENT =
  humanIntroCalendarReceiptKeyCommitment(CALENDAR_KEY);
const OUTCOME_KEY =
  Buffer.alloc(32, 9).toString("base64url");
const OUTCOME_KEY_ID = "outcome-test-2026-07";
const OUTCOME_KEY_COMMITMENT =
  humanIntroOutcomeReceiptKeyCommitment(OUTCOME_KEY);
const SECRET = "outcome-receipt-transport-test-secret";
const NOW = Date.parse("2026-07-25T12:02:00.000Z");
const RETAINED_AT_MS =
  Date.parse("2026-07-25T12:02:00.100Z");
const CALENDAR_RECORD_SHA1 = "c".repeat(40);

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

function payload() {
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
  };
}

function durableJob() {
  const selected = payload();
  const call = humanIntroCallRecord(selected);
  return {
    id: humanIntroJobId(SOURCE_ID),
    revision: 17,
    state: "needs_review",
    humanCall: true,
    humanIntro: true,
    callType: "human",
    callTypeAt: call.endedAt,
    callStartedAt: call.joinAt,
    callEndedAt: call.endedAt,
    bookingSourceId: SOURCE_ID,
    resumeLinkDisposition: call.resumeLinkDisposition,
    resumeReceipt: call.resumeReceipt,
    candidate: call.candidate,
    humanCallMeta: persistedHumanIntroMetadata(call),
    successfulCallVerified: true,
    journal: [],
  };
}

function calendarReceipt(overrides = {}) {
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
  return {
    ...body,
    signature: sign(
      "phase4-human-intro-calendar-receipt-v1",
      body,
      CALENDAR_KEY,
    ),
  };
}

function outcomeAttestation(
  selectedCalendar = calendarReceipt(),
  overrides = {},
) {
  const body = {
    version: "human-intro-outcome-attestation-v1",
    source: "raydar_human_outcome_attestation",
    keyId: OUTCOME_KEY_ID,
    sourceId: SOURCE_ID,
    intakeEventId: humanIntroEventId(SOURCE_ID),
    payloadDigest: durableJob().humanCallMeta.payloadDigest,
    calendarEventRevision: selectedCalendar.eventRevision,
    outcome: "completed",
    occurredAt: "2026-07-25T10:05:00.000Z",
    attestedAt: "2026-07-25T11:00:00.000Z",
    ...overrides,
  };
  return {
    ...body,
    signature: sign(
      "phase4-human-intro-outcome-receipt-v1",
      body,
      OUTCOME_KEY,
    ),
  };
}

function calendarRetention(
  selectedCalendar = calendarReceipt(),
) {
  return {
    sourceId: SOURCE_ID,
    eventRevision: selectedCalendar.eventRevision,
    receiptDigest: semanticDigest(
      "phase4-human-intro-calendar-receipt-digest-v1",
      selectedCalendar,
    ),
    approvedKeyCommitmentDigest:
      CALENDAR_KEY_COMMITMENT,
    recordRevisionSha1: CALENDAR_RECORD_SHA1,
    receipt: selectedCalendar,
  };
}

function retentionInput(
  selectedOutcome = outcomeAttestation(),
  selectedCalendar = calendarReceipt(),
) {
  const calendar = calendarRetention(selectedCalendar);
  return {
    approvedCalendarKeyCommitmentDigest:
      CALENDAR_KEY_COMMITMENT,
    approvedOutcomeKeyCommitmentDigest:
      OUTCOME_KEY_COMMITMENT,
    calendarEventRevision:
      selectedOutcome.calendarEventRevision,
    calendarReceiptDigest: calendar.receiptDigest,
    calendarRetentionRevisionSha1:
      calendar.recordRevisionSha1,
    jobId: humanIntroJobId(SOURCE_ID),
    outcomeAttestation: selectedOutcome,
    outcomeReceiptDigest: semanticDigest(
      "phase4-human-intro-outcome-receipt-digest-v1",
      selectedOutcome,
    ),
    sourceId: SOURCE_ID,
  };
}

function fakeRedis() {
  const records = new Map();
  const commands = [];
  return {
    commands,
    records,
    async kv(command) {
      commands.push(command);
      if (command[0] === "GET") {
        return records.get(command[1]) ?? null;
      }
      assert.equal(command[0], "EVAL");
      const key = command[3];
      const existing = records.get(key);
      if (existing) {
        return [
          2,
          existing,
          createHash("sha1").update(existing).digest("hex"),
        ];
      }
      const record = {
        ...JSON.parse(command[4]),
        retainedAtMs: RETAINED_AT_MS,
      };
      const raw = JSON.stringify(record);
      records.set(key, raw);
      return [
        1,
        raw,
        createHash("sha1").update(raw).digest("hex"),
      ];
    },
  };
}

function signedRequest(
  selectedOutcome = outcomeAttestation(),
  { secret = SECRET } = {},
) {
  const rawBody = JSON.stringify(selectedOutcome);
  const timestamp = Math.floor(NOW / 1_000);
  const pathname =
    "/api/paraai/human-intro-outcome-receipt";
  const signature = createHmac("sha256", secret)
    .update(`${timestamp}.POST.${pathname}.${rawBody}`)
    .digest("hex");
  return new Request(
    `https://monitor.raydar.xyz${pathname}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-raydar-timestamp": String(timestamp),
        "x-raydar-signature": `v1=${signature}`,
      },
      body: rawBody,
    },
  );
}

function approvedCalendarKey() {
  return {
    key: CALENDAR_KEY,
    keyId: CALENDAR_KEY_ID,
    keyCommitment: CALENDAR_KEY_COMMITMENT,
  };
}

function approvedOutcomeKey() {
  return {
    key: OUTCOME_KEY,
    keyId: OUTCOME_KEY_ID,
    keyCommitment: OUTCOME_KEY_COMMITMENT,
  };
}

test("the outcome key loader enforces the independent code-owned production pin", () => {
  assert.equal(
    HUMAN_INTRO_OUTCOME_RECEIPT_KEY_ENV,
    "PARAAI_HUMAN_INTRO_OUTCOME_RECEIPT_KEY",
  );
  assert.equal(
    HUMAN_INTRO_OUTCOME_RECEIPT_APPROVED_KEY_ID,
    "human-intro-outcome-2026-07-v1",
  );
  assert.equal(
    HUMAN_INTRO_OUTCOME_RECEIPT_APPROVED_KEY_COMMITMENT,
    "5fa149a97bd22518d9d71312dd818924640d814c664ad92fa09640af2458dc57",
  );
  assert.deepEqual(
    verifyHumanIntroOutcomeReceiptKey({
      key: OUTCOME_KEY,
      approvedKeyId: OUTCOME_KEY_ID,
      approvedKeyCommitment: OUTCOME_KEY_COMMITMENT,
    }),
    approvedOutcomeKey(),
  );
  assert.notEqual(
    OUTCOME_KEY_COMMITMENT,
    CALENDAR_KEY_COMMITMENT,
  );
  assert.equal(humanIntroOutcomeReceiptKeyConfigured({}), false);
  assert.throws(
    () => verifyHumanIntroOutcomeReceiptKey({
      key: OUTCOME_KEY,
      approvedKeyId: OUTCOME_KEY_ID,
      approvedKeyCommitment: "f".repeat(64),
    }),
    (error) => (
      error instanceof HumanIntroOutcomeReceiptKeyError
      && error.code
        === "HUMAN_INTRO_OUTCOME_RECEIPT_KEY_COMMITMENT_MISMATCH"
    ),
  );
});

test("the outcome store atomically retains one Redis-TIME attestation and exact replay is stable", async () => {
  const redis = fakeRedis();
  const store = createHumanIntroOutcomeReceiptStore({
    configured: () => true,
    kvImpl: redis.kv,
  });
  const selected = retentionInput();
  const [first, replay] = await Promise.all([
    store.retain(selected),
    store.retain(selected),
  ]);
  assert.deepEqual(
    [first.created, replay.created].sort(),
    [false, true],
  );
  assert.deepEqual(
    [first.duplicate, replay.duplicate].sort(),
    [false, true],
  );
  assert.equal(
    first.outcomeReceiptDigest,
    replay.outcomeReceiptDigest,
  );
  assert.equal(
    first.recordRevisionSha1,
    replay.recordRevisionSha1,
  );
  assert.equal(first.retainedAtMs, RETAINED_AT_MS);
  assert.equal(redis.records.size, 1);
  const command = redis.commands[0];
  assert.match(command[1], /redis\.call\('TIME'\)/u);
  assert.match(
    command[1],
    /redis\.call\('SET', KEYS\[1\], encoded, 'NX'\)/u,
  );
  assert.match(
    command[3],
    new RegExp(
      `^paraai:human-intro-outcome-receipt:v1:${SOURCE_ID}:`,
      "u",
    ),
  );
  const readback = await store.read({
    sourceId: SOURCE_ID,
    calendarEventRevision: selected.calendarEventRevision,
  });
  assert.equal(
    readback.version,
    HUMAN_INTRO_OUTCOME_RECEIPT_RETENTION_VERSION,
  );
  assert.equal(
    readback.outcomeReceiptDigest,
    selected.outcomeReceiptDigest,
  );
});

test("first attestation wins and completed/no-show can never overwrite each other", async () => {
  const redis = fakeRedis();
  const store = createHumanIntroOutcomeReceiptStore({
    configured: () => true,
    kvImpl: redis.kv,
  });
  const calendar = calendarReceipt();
  const completed = outcomeAttestation(calendar);
  const noShow = outcomeAttestation(calendar, {
    outcome: "no_show",
    occurredAt: null,
    attestedAt: "2026-07-25T11:05:00.000Z",
  });
  await store.retain(retentionInput(completed, calendar));
  await assert.rejects(
    () => store.retain(retentionInput(noShow, calendar)),
    (error) => (
      error instanceof HumanIntroOutcomeReceiptStoreError
      && error.code
        === "HUMAN_INTRO_OUTCOME_RECEIPT_STORE_CONFLICT"
    ),
  );
  assert.equal(redis.records.size, 1);
});

test("outcome ingest is exact-default-off and authenticates before either key or store read", async () => {
  assert.equal(humanIntroOutcomeReceiptIngestEnabled({}), false);
  assert.equal(humanIntroOutcomeReceiptIngestEnabled({
    [HUMAN_INTRO_OUTCOME_RECEIPT_INGEST_ENV]: "true",
  }), false);
  assert.equal(humanIntroOutcomeReceiptIngestEnabled({
    [HUMAN_INTRO_OUTCOME_RECEIPT_INGEST_ENV]: "1",
  }), true);
  let keyReads = 0;
  let storeReads = 0;
  const unsigned = new Request(
    "https://monitor.raydar.xyz/api/paraai/human-intro-outcome-receipt",
    {
      method: "POST",
      body: JSON.stringify(outcomeAttestation()),
    },
  );
  const unauthorized =
    await handleHumanIntroOutcomeReceipt(unsigned, {
      enabled: false,
      loadApprovedCalendarKey() {
        keyReads += 1;
      },
      loadApprovedOutcomeKey() {
        keyReads += 1;
      },
      hasCalendarReceiptStore() {
        storeReads += 1;
        return true;
      },
      now: () => NOW,
    });
  assert.equal(unauthorized.status, 401);
  assert.equal(keyReads, 0);
  assert.equal(storeReads, 0);

  const disabled =
    await handleHumanIntroOutcomeReceipt(signedRequest(), {
      secret: SECRET,
      enabled: false,
      loadApprovedCalendarKey() {
        keyReads += 1;
      },
      loadApprovedOutcomeKey() {
        keyReads += 1;
      },
      hasCalendarReceiptStore() {
        storeReads += 1;
        return true;
      },
      now: () => NOW,
    });
  assert.equal(disabled.status, 503);
  assert.equal(
    (await disabled.json()).error,
    "human_intro_outcome_receipt_disabled",
  );
  assert.equal(keyReads, 0);
  assert.equal(storeReads, 0);
});

function routeDependencies({
  selectedCalendar = calendarReceipt(),
  retain,
} = {}) {
  return {
    secret: SECRET,
    enabled: true,
    loadApprovedCalendarKey: approvedCalendarKey,
    loadApprovedOutcomeKey: approvedOutcomeKey,
    hasCalendarReceiptStore: () => true,
    hasOutcomeReceiptStore: () => true,
    loadJob: async () => durableJob(),
    readCalendar: async () =>
      calendarRetention(selectedCalendar),
    retain,
    now: () => NOW,
  };
}

test("an approved completed outcome gets a durable ack but no head, identity, authority, or pin", async () => {
  const redis = fakeRedis();
  const store = createHumanIntroOutcomeReceiptStore({
    configured: () => true,
    kvImpl: redis.kv,
  });
  const selectedCalendar = calendarReceipt();
  const selectedOutcome =
    outcomeAttestation(selectedCalendar);
  const dependencies = routeDependencies({
    selectedCalendar,
    retain: store.retain,
  });
  const first = await handleHumanIntroOutcomeReceipt(
    signedRequest(selectedOutcome),
    dependencies,
  );
  assert.equal(first.status, 202);
  const firstBody = await first.json();
  assert.equal(firstBody.ok, true);
  assert.equal(firstBody.created, true);
  assert.equal(firstBody.duplicate, false);
  assert.equal(firstBody.classification, "success");
  assert.equal(
    firstBody.evidence.signedCalendarObservationVerified,
    true,
  );
  assert.equal(
    firstBody.evidence.signedOutcomeAttestationVerified,
    true,
  );
  assert.equal(
    firstBody.evidence.approvedCalendarReceiptKeyAvailable,
    true,
  );
  assert.equal(
    firstBody.evidence.approvedOutcomeReceiptKeyAvailable,
    true,
  );
  assert.equal(
    firstBody.evidence.durableSignedReceiptAvailable,
    true,
  );
  assert.equal(
    firstBody.evidence.occurredEvidenceAvailable,
    true,
  );
  for (const field of [
    "sourceHeadAvailable",
    "sourceExhaustivenessAvailable",
    "candidateIdentityResolutionAvailable",
    "sourceAuthorityAvailable",
    "pinnable",
  ]) {
    assert.equal(firstBody.evidence[field], false, field);
  }
  const serialized = JSON.stringify(firstBody);
  for (const forbidden of [
    CALENDAR_KEY,
    OUTCOME_KEY,
    durableJob().candidate.fullName,
    durableJob().candidate.email,
    durableJob().candidate.linkedin,
    selectedCalendar.signature,
    selectedOutcome.signature,
  ]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }

  const replay = await handleHumanIntroOutcomeReceipt(
    signedRequest(selectedOutcome),
    dependencies,
  );
  assert.equal(replay.status, 200);
  const replayBody = await replay.json();
  assert.equal(replayBody.created, false);
  assert.equal(replayBody.duplicate, true);
  assert.equal(
    replayBody.evidence.outcomeRetentionRevisionDigest,
    firstBody.evidence.outcomeRetentionRevisionDigest,
  );
  assert.equal(redis.records.size, 1);
});

test("a no-show remains explicit failure evidence, not inferred occurrence", async () => {
  const redis = fakeRedis();
  const store = createHumanIntroOutcomeReceiptStore({
    configured: () => true,
    kvImpl: redis.kv,
  });
  const calendar = calendarReceipt();
  const noShow = outcomeAttestation(calendar, {
    outcome: "no_show",
    occurredAt: null,
  });
  const response = await handleHumanIntroOutcomeReceipt(
    signedRequest(noShow),
    routeDependencies({
      selectedCalendar: calendar,
      retain: store.retain,
    }),
  );
  assert.equal(response.status, 202);
  const body = await response.json();
  assert.equal(body.classification, "failure");
  assert.equal(body.evidence.outcomeEvidenceAvailable, true);
  assert.equal(
    body.evidence.successClassificationAvailable,
    true,
  );
  assert.equal(body.evidence.occurredEvidenceAvailable, false);
  assert.equal(body.evidence.sourceAuthorityAvailable, false);
  assert.equal(body.evidence.pinnable, false);
});

test("missing Calendar retention, bad signatures, key failures, and store conflicts fail closed", async () => {
  const calendar = calendarReceipt();
  const selectedOutcome = outcomeAttestation(calendar);
  const base = routeDependencies({
    selectedCalendar: calendar,
    retain: async () => {
      throw new HumanIntroOutcomeReceiptStoreError(
        "HUMAN_INTRO_OUTCOME_RECEIPT_STORE_CONFLICT",
      );
    },
  });
  const missingCalendar = await handleHumanIntroOutcomeReceipt(
    signedRequest(selectedOutcome),
    {
      ...base,
      readCalendar: async () => null,
    },
  );
  assert.equal(missingCalendar.status, 409);
  assert.equal(
    (await missingCalendar.json()).error,
    "calendar_receipt_not_retained",
  );

  const badSignature = {
    ...selectedOutcome,
    signature: "0".repeat(64),
  };
  const invalid = await handleHumanIntroOutcomeReceipt(
    signedRequest(badSignature),
    base,
  );
  assert.equal(invalid.status, 409);
  assert.equal(
    (await invalid.json()).error,
    "outcome_receipt_invalid",
  );

  const keyUnavailable =
    await handleHumanIntroOutcomeReceipt(
      signedRequest(selectedOutcome),
      {
        ...base,
        loadApprovedOutcomeKey() {
          throw new Error("missing");
        },
      },
    );
  assert.equal(keyUnavailable.status, 503);
  assert.equal(
    (await keyUnavailable.json()).error,
    "outcome_receipt_key_unavailable",
  );

  const conflict = await handleHumanIntroOutcomeReceipt(
    signedRequest(selectedOutcome),
    base,
  );
  assert.equal(conflict.status, 409);
  assert.equal(
    (await conflict.json()).error,
    "outcome_receipt_conflict",
  );
});

test("the endpoint and store expose no mutation, enumeration, head, identity, authority, or activation surface", async () => {
  const endpoint = await readFile(
    new URL(
      "../api/paraai/human-intro-outcome-receipt.mjs",
      import.meta.url,
    ),
    "utf8",
  );
  const store = await readFile(
    new URL(
      "../api/paraai/_lib/human-intro-outcome-receipt-store.mjs",
      import.meta.url,
    ),
    "utf8",
  );
  for (const forbidden of [
    /\bsaveJob\b/u,
    /\btransition\s*\(/u,
    /\benqueueAutoJob\b/u,
    /\bprepareJob\b/u,
    /\bcheckpointTrustedSourceCaptureEvent\b/u,
    /\bbuildSourceWatermarkCertificate\b/u,
    /\bsource-capture-coordinator\b/u,
  ]) {
    assert.doesNotMatch(endpoint, forbidden);
    assert.doesNotMatch(store, forbidden);
  }
  assert.doesNotMatch(store, /\bSADD\b/u);
  assert.doesNotMatch(store, /\bSCAN\b/u);
  assert.doesNotMatch(store, /\bZRANGE\b/u);
  assert.doesNotMatch(store, /\bactive\b/iu);
  assert.match(endpoint, /sourceAuthorityAvailable/u);
  assert.match(endpoint, /pinnable/u);
});
