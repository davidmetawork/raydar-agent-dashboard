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
  HUMAN_INTRO_CALENDAR_RECEIPT_APPROVED_KEY_COMMITMENT,
  HUMAN_INTRO_CALENDAR_RECEIPT_APPROVED_KEY_ID,
  HUMAN_INTRO_CALENDAR_RECEIPT_KEY_ENV,
  HumanIntroCalendarReceiptKeyError,
  humanIntroCalendarReceiptKeyCommitment,
  humanIntroCalendarReceiptKeyConfigured,
  verifyHumanIntroCalendarReceiptKey,
} from
  "../api/paraai/_lib/human-intro-calendar-receipt-key.mjs";
import {
  HUMAN_INTRO_CALENDAR_RECEIPT_RETENTION_VERSION,
  HumanIntroCalendarReceiptStoreError,
  createHumanIntroCalendarReceiptStore,
} from
  "../api/paraai/_lib/human-intro-calendar-receipt-store.mjs";
import {
  HUMAN_INTRO_CALENDAR_RECEIPT_INGEST_ENV,
  handleHumanIntroCalendarReceipt,
  humanIntroCalendarReceiptIngestEnabled,
} from "../api/paraai/human-intro-calendar-receipt.mjs";

const SOURCE_ID = "a".repeat(64);
const ARTIFACT_SHA256 = "b".repeat(64);
const KEY = Buffer.alloc(32, 7).toString("base64url");
const KEY_ID = "calendar-test-2026-07";
const KEY_COMMITMENT =
  humanIntroCalendarReceiptKeyCommitment(KEY);
const SECRET = "calendar-receipt-transport-test-secret";
const NOW = Date.parse("2026-07-25T12:02:00.000Z");
const RETAINED_AT_MS =
  Date.parse("2026-07-25T12:02:00.100Z");

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

function receipt(overrides = {}) {
  const body = {
    version: "human-intro-calendar-observation-v1",
    source: "google_calendar",
    keyId: KEY_ID,
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
    signature: createHmac("sha256", KEY)
      .update("phase4-human-intro-calendar-receipt-v1")
      .update("\0")
      .update(canonicalJson(body))
      .digest("hex"),
  };
}

function retentionInput(selectedReceipt = receipt()) {
  return {
    approvedKeyCommitmentDigest: KEY_COMMITMENT,
    eventRevision: selectedReceipt.eventRevision,
    jobId: humanIntroJobId(SOURCE_ID),
    receipt: selectedReceipt,
    receiptDigest: semanticDigest(
      "phase4-human-intro-calendar-receipt-digest-v1",
      selectedReceipt,
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

function signedRequest(selectedReceipt = receipt(), {
  secret = SECRET,
} = {}) {
  const rawBody = JSON.stringify(selectedReceipt);
  const timestamp = Math.floor(NOW / 1_000);
  const pathname =
    "/api/paraai/human-intro-calendar-receipt";
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

function approvedKey() {
  return {
    key: KEY,
    keyId: KEY_ID,
    keyCommitment: KEY_COMMITMENT,
  };
}

test("the deployment key loader enforces a code-owned canonical 256-bit pin", () => {
  assert.equal(
    HUMAN_INTRO_CALENDAR_RECEIPT_KEY_ENV,
    "PARAAI_HUMAN_INTRO_CALENDAR_RECEIPT_KEY",
  );
  assert.equal(
    HUMAN_INTRO_CALENDAR_RECEIPT_APPROVED_KEY_ID,
    "human-intro-calendar-2026-07-v1",
  );
  assert.equal(
    HUMAN_INTRO_CALENDAR_RECEIPT_APPROVED_KEY_COMMITMENT,
    "035621c0b7f655c314ca7501c0bcf68a4587c2808c23b3816448512439e947c2",
  );
  assert.deepEqual(
    verifyHumanIntroCalendarReceiptKey({
      key: KEY,
      approvedKeyId: KEY_ID,
      approvedKeyCommitment: KEY_COMMITMENT,
    }),
    approvedKey(),
  );
  assert.equal(humanIntroCalendarReceiptKeyConfigured({}), false);
  assert.throws(
    () => verifyHumanIntroCalendarReceiptKey({
      key: KEY,
      approvedKeyId: KEY_ID,
      approvedKeyCommitment: "f".repeat(64),
    }),
    (error) => (
      error instanceof HumanIntroCalendarReceiptKeyError
      && error.code
        === "HUMAN_INTRO_CALENDAR_RECEIPT_KEY_COMMITMENT_MISMATCH"
    ),
  );
  for (const invalid of [
    "short",
    `${KEY}=`,
    Buffer.alloc(31, 7).toString("base64url"),
  ]) {
    assert.throws(
      () => humanIntroCalendarReceiptKeyCommitment(invalid),
      HumanIntroCalendarReceiptKeyError,
    );
  }
});

test("the receipt store atomically retains one Redis-TIME revision and exact replay is stable", async () => {
  const redis = fakeRedis();
  const store = createHumanIntroCalendarReceiptStore({
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
  assert.equal(first.eventRevision, replay.eventRevision);
  assert.equal(first.receiptDigest, replay.receiptDigest);
  assert.equal(
    first.recordRevisionSha1,
    replay.recordRevisionSha1,
  );
  assert.equal(first.retainedAtMs, RETAINED_AT_MS);
  assert.equal(redis.records.size, 1);
  const command = redis.commands[0];
  assert.match(
    command[1],
    /redis\.call\('TIME'\)/u,
  );
  assert.match(
    command[1],
    /redis\.call\('SET', KEYS\[1\], encoded, 'NX'\)/u,
  );
  assert.match(
    command[3],
    new RegExp(
      `^paraai:human-intro-calendar-receipt:v1:${SOURCE_ID}:`,
      "u",
    ),
  );
  const readback = await store.read({
    sourceId: SOURCE_ID,
    eventRevision: selected.eventRevision,
  });
  assert.equal(
    readback.version,
    HUMAN_INTRO_CALENDAR_RECEIPT_RETENTION_VERSION,
  );
  assert.equal(readback.receiptDigest, selected.receiptDigest);
  assert.equal(readback.retainedAtMs, RETAINED_AT_MS);
});

test("the same semantic revision can never be overwritten by another observation", async () => {
  const redis = fakeRedis();
  const store = createHumanIntroCalendarReceiptStore({
    configured: () => true,
    kvImpl: redis.kv,
  });
  const first = receipt();
  const later = receipt({
    observedAt: "2026-07-25T12:01:30.000Z",
  });
  assert.equal(first.eventRevision, later.eventRevision);
  await store.retain(retentionInput(first));
  await assert.rejects(
    () => store.retain(retentionInput(later)),
    (error) => (
      error instanceof HumanIntroCalendarReceiptStoreError
      && error.code
        === "HUMAN_INTRO_CALENDAR_RECEIPT_STORE_CONFLICT"
    ),
  );
  assert.equal(redis.records.size, 1);
});

test("receipt ingest is exact-default-off and authenticates before any key or store read", async () => {
  assert.equal(humanIntroCalendarReceiptIngestEnabled({}), false);
  assert.equal(humanIntroCalendarReceiptIngestEnabled({
    [HUMAN_INTRO_CALENDAR_RECEIPT_INGEST_ENV]: "true",
  }), false);
  assert.equal(humanIntroCalendarReceiptIngestEnabled({
    [HUMAN_INTRO_CALENDAR_RECEIPT_INGEST_ENV]: "1",
  }), true);
  let keyReads = 0;
  let storeReads = 0;
  const unsigned = new Request(
    "https://monitor.raydar.xyz/api/paraai/human-intro-calendar-receipt",
    {
      method: "POST",
      body: JSON.stringify(receipt()),
    },
  );
  const unauthorized =
    await handleHumanIntroCalendarReceipt(unsigned, {
      enabled: false,
      loadApprovedKey() {
        keyReads += 1;
      },
      hasReceiptStore() {
        storeReads += 1;
        return true;
      },
      now: () => NOW,
    });
  assert.equal(unauthorized.status, 401);
  assert.equal(keyReads, 0);
  assert.equal(storeReads, 0);

  const disabled =
    await handleHumanIntroCalendarReceipt(signedRequest(), {
      secret: SECRET,
      enabled: false,
      loadApprovedKey() {
        keyReads += 1;
      },
      hasReceiptStore() {
        storeReads += 1;
        return true;
      },
      now: () => NOW,
    });
  assert.equal(disabled.status, 503);
  assert.equal(
    (await disabled.json()).error,
    "human_intro_calendar_receipt_disabled",
  );
  assert.equal(keyReads, 0);
  assert.equal(storeReads, 0);
});

test("an approved confirmed receipt gets a durable ack but remains pending and powerless", async () => {
  const redis = fakeRedis();
  const store = createHumanIntroCalendarReceiptStore({
    configured: () => true,
    kvImpl: redis.kv,
  });
  const dependencies = {
    secret: SECRET,
    enabled: true,
    loadApprovedKey: approvedKey,
    hasReceiptStore: () => true,
    loadJob: async () => durableJob(),
    retain: store.retain,
    now: () => NOW,
  };
  const first = await handleHumanIntroCalendarReceipt(
    signedRequest(),
    dependencies,
  );
  assert.equal(first.status, 202);
  const firstBody = await first.json();
  assert.equal(firstBody.ok, true);
  assert.equal(firstBody.created, true);
  assert.equal(firstBody.duplicate, false);
  assert.equal(firstBody.jobId, humanIntroJobId(SOURCE_ID));
  assert.equal(firstBody.evidence.classification, "pending");
  assert.equal(
    firstBody.evidence.approvedReceiptKeyAvailable,
    true,
  );
  assert.equal(
    firstBody.evidence.receiptProducerAvailable,
    true,
  );
  assert.equal(
    firstBody.evidence.durableSignedReceiptAvailable,
    true,
  );
  for (const field of [
    "signedOutcomeAttestationVerified",
    "sourceHeadAvailable",
    "sourceExhaustivenessAvailable",
    "occurredEvidenceAvailable",
    "outcomeEvidenceAvailable",
    "successClassificationAvailable",
    "candidateIdentityResolutionAvailable",
    "sourceAuthorityAvailable",
    "pinnable",
  ]) {
    assert.equal(firstBody.evidence[field], false, field);
  }
  const serialized = JSON.stringify(firstBody);
  for (const forbidden of [
    KEY,
    durableJob().candidate.fullName,
    durableJob().candidate.email,
    durableJob().candidate.linkedin,
    receipt().signature,
  ]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }

  const replay = await handleHumanIntroCalendarReceipt(
    signedRequest(),
    dependencies,
  );
  assert.equal(replay.status, 200);
  const replayBody = await replay.json();
  assert.equal(replayBody.created, false);
  assert.equal(replayBody.duplicate, true);
  assert.equal(
    replayBody.receiptDigest,
    firstBody.receiptDigest,
  );
  assert.equal(
    replayBody.evidence.retentionRevisionDigest,
    firstBody.evidence.retentionRevisionDigest,
  );
  assert.equal(redis.records.size, 1);
});

test("a retained cancellation is a tombstone, never attendance or source authority", async () => {
  const cancelled = receipt({
    status: "cancelled",
    updatedAt: "2026-07-25T09:30:00.000Z",
  });
  const redis = fakeRedis();
  const store = createHumanIntroCalendarReceiptStore({
    configured: () => true,
    kvImpl: redis.kv,
  });
  const response = await handleHumanIntroCalendarReceipt(
    signedRequest(cancelled),
    {
      secret: SECRET,
      enabled: true,
      loadApprovedKey: approvedKey,
      hasReceiptStore: () => true,
      loadJob: async () => durableJob(),
      retain: store.retain,
      now: () => NOW,
    },
  );
  assert.equal(response.status, 202);
  const body = await response.json();
  assert.equal(body.evidence.classification, "failure");
  assert.equal(
    body.evidence.cancellationTombstoneAvailable,
    true,
  );
  assert.equal(body.evidence.occurredEvidenceAvailable, false);
  assert.equal(
    body.evidence.signedOutcomeAttestationVerified,
    false,
  );
  assert.equal(body.evidence.sourceAuthorityAvailable, false);
  assert.equal(body.evidence.pinnable, false);
});

test("missing intake, invalid signatures, unavailable keys, and store conflicts fail closed", async () => {
  const base = {
    secret: SECRET,
    enabled: true,
    loadApprovedKey: approvedKey,
    hasReceiptStore: () => true,
    loadJob: async () => durableJob(),
    retain: async () => {
      throw new HumanIntroCalendarReceiptStoreError(
        "HUMAN_INTRO_CALENDAR_RECEIPT_STORE_CONFLICT",
      );
    },
    now: () => NOW,
  };
  const missing = await handleHumanIntroCalendarReceipt(
    signedRequest(),
    {
      ...base,
      loadJob: async () => null,
    },
  );
  assert.equal(missing.status, 404);

  const badSignature = receipt();
  badSignature.signature = "0".repeat(64);
  const invalid = await handleHumanIntroCalendarReceipt(
    signedRequest(badSignature),
    base,
  );
  assert.equal(invalid.status, 409);
  assert.equal(
    (await invalid.json()).error,
    "calendar_receipt_invalid",
  );

  const keyUnavailable =
    await handleHumanIntroCalendarReceipt(signedRequest(), {
      ...base,
      loadApprovedKey() {
        throw new Error("missing");
      },
    });
  assert.equal(keyUnavailable.status, 503);
  assert.equal(
    (await keyUnavailable.json()).error,
    "calendar_receipt_key_unavailable",
  );

  const conflict =
    await handleHumanIntroCalendarReceipt(
      signedRequest(),
      base,
    );
  assert.equal(conflict.status, 409);
  assert.equal(
    (await conflict.json()).error,
    "calendar_receipt_conflict",
  );
});

test("the endpoint and store expose no mutation, enumeration, head, outcome, or authority surface", async () => {
  const endpoint = await readFile(
    new URL(
      "../api/paraai/human-intro-calendar-receipt.mjs",
      import.meta.url,
    ),
    "utf8",
  );
  const store = await readFile(
    new URL(
      "../api/paraai/_lib/human-intro-calendar-receipt-store.mjs",
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
  assert.doesNotMatch(
    store,
    /\b(outcomeAttestation|outcomeReceipt)\b/iu,
  );
  assert.match(endpoint, /sourceAuthorityAvailable/u);
  assert.match(endpoint, /pinnable/u);
});
