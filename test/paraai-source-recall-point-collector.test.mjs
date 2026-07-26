import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  SOURCE_RECALL_POINT_COLLECTOR_VERSION,
  SourceRecallPointCollectorError,
  normalizeRecallSourcePointRecord,
  recallSourcePointEvidence,
  recallSourcePointReadRequest,
} from "../api/paraai/_lib/source-recall-point-collector.mjs";
import {
  SOURCE_IDENTITY_POINT_READ_PROCEDURES,
} from "../api/paraai/_lib/source-watermark.mjs";

const BOUNDARY = "2026-07-26T00:00:00.000Z";
const BOT_A = "bot-synthetic-a";
const BOT_B = "bot-synthetic-b";

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

function bot({
  id = BOT_A,
  joinAt = "2026-07-25T20:00:00.000Z",
  botName = "Raydar Screener",
  source = "paraform-auto",
  statusChanges = [
    {
      code: "ready",
      sub_code: null,
      created_at: "2026-07-25T19:59:00.000000Z",
    },
    {
      code: "call_ended",
      sub_code: "everyone_left",
      created_at: "2026-07-25T20:45:00.000000Z",
    },
  ],
  recordings = [{
    id: "recording-synthetic-a",
    media_shortcuts: {
      transcript: {
        status: { code: "done" },
        data: {
          download_url:
            "https://media.invalid/rotating-transcript-a",
        },
      },
      participant_events: {
        status: { code: "done" },
        data: {
          participants_download_url:
            "https://media.invalid/rotating-presence-a",
        },
      },
    },
  }],
  metadata = {},
  ...fields
} = {}) {
  return {
    id,
    bot_name: botName,
    join_at: joinAt,
    metadata: {
      source,
      candidate_full_name: "Synthetic Person",
      candidate_email: "synthetic.person@example.invalid",
      candidate_linkedin:
        "https://example.invalid/synthetic-person",
      paraform_event_id: "synthetic-event-a",
      ...metadata,
    },
    status_changes: statusChanges,
    recordings,
    meeting_url: {
      meeting_id: "synthetic-meeting-a",
    },
    ...fields,
  };
}

function reference({
  id = BOT_A,
  joinAt = "2026-07-25T20:00:00.000Z",
  source = "paraform-auto",
  fullName = "Synthetic Person",
  email = "synthetic.person@example.invalid",
  linkedin = "https://example.invalid/synthetic-person",
  paraformEventId = "synthetic-event-a",
} = {}) {
  return {
    id,
    joinAt,
    metadataSource: source,
    candidate: {
      fullName,
      email,
      linkedin,
      paraformEventId,
    },
  };
}

function options(overrides = {}) {
  return {
    decisionBoundaryAt: BOUNDARY,
    expectedReference: reference(),
    ...overrides,
  };
}

function expectCode(fn, code) {
  assert.throws(
    fn,
    (error) => (
      error instanceof SourceRecallPointCollectorError
      && error.code === code
      && error.message === code
    ),
  );
}

test("Recall point request and private projection are exact and frozen", () => {
  assert.equal(
    SOURCE_RECALL_POINT_COLLECTOR_VERSION,
    "recall-source-point-projection-v1",
  );
  const request = recallSourcePointReadRequest(BOT_A);
  assert.deepEqual(request, {
    method: "GET",
    path: `/api/v1/bot/${BOT_A}/`,
  });
  assert.equal(Object.isFrozen(request), true);

  const projection = normalizeRecallSourcePointRecord(
    bot(),
    options(),
  );
  assert.deepEqual(projection, {
    source: "recall",
    botId: BOT_A,
    botName: "Raydar Screener",
    joinAt: "2026-07-25T20:00:00.000000000Z",
    enumeratedJoinAt: "2026-07-25T20:00:00.000Z",
    metadataSource: "paraform-auto",
    candidate: {
      fullName: "Synthetic Person",
      email: "synthetic.person@example.invalid",
      linkedin: "https://example.invalid/synthetic-person",
      paraformEventId: "synthetic-event-a",
    },
    statusChangesAtBoundary: [
      {
        code: "ready",
        subCode: null,
        observedAt: "2026-07-25T19:59:00.000000000Z",
      },
      {
        code: "call_ended",
        subCode: "everyone_left",
        observedAt: "2026-07-25T20:45:00.000000000Z",
      },
    ],
  });
  assert.equal(Object.isFrozen(projection), true);
  assert.equal(Object.isFrozen(projection.candidate), true);
  assert.equal(
    Object.isFrozen(projection.statusChangesAtBoundary),
    true,
  );
});

test("point response must match the exact expected Recall id", () => {
  expectCode(
    () => normalizeRecallSourcePointRecord(
      bot({ id: BOT_B }),
      options(),
    ),
    "SOURCE_RECALL_POINT_EXPECTED_ID_MISMATCH",
  );
  for (const invalid of [
    "",
    " four",
    "bad/id",
    "x".repeat(129),
  ]) {
    assert.throws(
      () => recallSourcePointReadRequest(invalid),
      SourceRecallPointCollectorError,
    );
  }
});

test("point response must match the complete private page reference", () => {
  const sameIdDrift = [
    bot({ joinAt: "2026-07-25T20:00:00.001Z" }),
    bot({ source: "paraform-reconciliation" }),
    bot({
      metadata: {
        candidate_full_name: "Changed Person",
      },
    }),
    bot({
      metadata: {
        candidate_email: "changed@example.invalid",
      },
    }),
    bot({
      metadata: {
        candidate_linkedin:
          "https://example.invalid/changed-person",
      },
    }),
    bot({
      metadata: {
        paraform_event_id: "synthetic-event-b",
      },
    }),
  ];
  for (const raw of sameIdDrift) {
    expectCode(
      () => normalizeRecallSourcePointRecord(
        raw,
        options(),
      ),
      "SOURCE_RECALL_POINT_REFERENCE_MISMATCH",
    );
  }

  const mixedCaseRawEmail =
    "Synthetic.Person@example.invalid";
  const projection = normalizeRecallSourcePointRecord(
    bot({
      metadata: {
        candidate_email: mixedCaseRawEmail,
      },
    }),
    options(),
  );
  assert.equal(
    projection.candidate.email,
    mixedCaseRawEmail.toLowerCase(),
  );
  expectCode(
    () => normalizeRecallSourcePointRecord(
      bot({
        metadata: {
          candidate_email: mixedCaseRawEmail,
        },
      }),
      options({
        expectedReference: reference({
          email: mixedCaseRawEmail,
        }),
      }),
    ),
    "SOURCE_RECALL_POINT_REFERENCE_INVALID",
  );
});

test("candidate-name hints mirror the exhaustive page fallback without inference", () => {
  const projection = normalizeRecallSourcePointRecord(bot({
    metadata: {
      candidate_full_name: "",
      candidate_first_name: "Synthetic",
    },
  }), options({
    expectedReference: reference({
      fullName: "Synthetic",
    }),
  }));
  assert.equal(projection.candidate.fullName, "Synthetic");

  assert.equal(
    normalizeRecallSourcePointRecord(
      bot({
        metadata: {
          candidate_full_name: " ",
          candidate_first_name: "Synthetic",
        },
      }),
      options({
        expectedReference: reference({
          fullName: "",
        }),
      }),
    ).candidate.fullName,
    "",
  );

  const missing = bot();
  delete missing.metadata.candidate_full_name;
  delete missing.metadata.candidate_first_name;
  assert.equal(
    normalizeRecallSourcePointRecord(
      missing,
      options({
        expectedReference: reference({
          fullName: "",
        }),
      }),
    ).candidate.fullName,
    "",
  );
});

test("join time must be strictly before the common decision boundary", () => {
  for (const joinAt of [
    BOUNDARY,
    "2026-07-26T00:00:00.000001Z",
    "2026-07-26T00:00:00.001Z",
    "2026-07-26T01:00:00.000+00:00",
  ]) {
    expectCode(
      () => normalizeRecallSourcePointRecord(
        bot({ joinAt }),
        options(),
      ),
      "SOURCE_RECALL_POINT_JOIN_AT_OUTSIDE_BOUNDARY",
    );
  }
  expectCode(
    () => normalizeRecallSourcePointRecord(bot(), options({
      decisionBoundaryAt: "2026-07-26T00:00:00Z",
    })),
    "SOURCE_RECALL_POINT_BOUNDARY_INVALID",
  );
});

test("only the exact screener and recognized workflow provenance pass", () => {
  for (const source of [
    "paraform-auto",
    "paraform-auto-guardian",
    "paraform-reconciliation",
    "paraform-reconciliation-guardian",
    "fyxer-guardian-n8n",
    "fyxer-guardian-n8n-guardian",
  ]) {
    assert.equal(
      normalizeRecallSourcePointRecord(
        bot({ source }),
        options({
          expectedReference: reference({ source }),
        }),
      ).metadataSource,
      source,
    );
  }
  for (const source of [
    "paraform-auto-guardian-guardian",
    "Paraform-auto",
    "paraform-auto ",
    "manual",
    "",
  ]) {
    expectCode(
      () => normalizeRecallSourcePointRecord(
        bot({ source }),
        options(),
      ),
      "SOURCE_RECALL_POINT_PROVENANCE_INVALID",
    );
  }
  expectCode(
    () => normalizeRecallSourcePointRecord(
      bot({ botName: "Raydar Screener Copy" }),
      options(),
    ),
    "SOURCE_RECALL_POINT_BOT_NAME_INVALID",
  );
});

test("status changes are canonical, ordered, and observed at the boundary", () => {
  const projection = normalizeRecallSourcePointRecord(bot({
    statusChanges: [
      {
        code: "ready",
        sub_code: null,
        updated_at: "2026-07-25T23:59:59.123456Z",
      },
      {
        code: "done",
        sub_code: null,
        created_at: "2026-07-26T00:00:00.000Z",
      },
      {
        code: "artifact_one_microsecond_later",
        sub_code: null,
        created_at: "2026-07-26T00:00:00.000001Z",
      },
      {
        code: "artifact_later",
        sub_code: null,
        created_at: "2026-07-26T00:00:00.001Z",
      },
      {
        code: 42,
        sub_code: "\nfuture shape is ignored",
        created_at: "2026-07-26T00:00:00.0000005Z",
      },
    ],
  }), options());
  assert.deepEqual(projection.statusChangesAtBoundary, [
    {
      code: "ready",
      subCode: null,
      observedAt: "2026-07-25T23:59:59.123456000Z",
    },
    {
      code: "done",
      subCode: null,
      observedAt: "2026-07-26T00:00:00.000000000Z",
    },
  ]);

  for (const statusChanges of [
    null,
    [{ code: 42, sub_code: null, created_at: BOUNDARY }],
    [{ code: "done", sub_code: null }],
    [{
      code: "done",
      sub_code: null,
      created_at: BOUNDARY,
      updated_at: BOUNDARY,
    }],
    [{
      code: "done",
      sub_code: "\nunsafe",
      created_at: BOUNDARY,
    }],
    [
      {
        code: "done",
        sub_code: null,
        created_at: BOUNDARY,
      },
      {
        code: "ready",
        sub_code: null,
        created_at: "2026-07-25T23:59:00.000Z",
      },
    ],
    [
      {
        code: "later",
        sub_code: null,
        created_at: "2026-07-25T23:59:59.000900Z",
      },
      {
        code: "earlier",
        sub_code: null,
        created_at: "2026-07-25T23:59:59.000100Z",
      },
    ],
    [
      {
        code: 42,
        sub_code: null,
        created_at: "2026-07-26T00:00:00.001Z",
      },
      {
        code: "reentered_boundary",
        sub_code: null,
        created_at: BOUNDARY,
      },
    ],
  ]) {
    assert.throws(
      () => normalizeRecallSourcePointRecord(
        bot({ statusChanges }),
        options(),
      ),
      SourceRecallPointCollectorError,
    );
  }
});

test("equivalent timestamp offsets canonicalize without losing source precision", () => {
  const expectedReference = reference({
    joinAt: "2026-07-25T20:00:00.123Z",
  });
  const offset = normalizeRecallSourcePointRecord(
    bot({
      joinAt: "2026-07-25T15:00:00.123456-05:00",
    }),
    options({ expectedReference }),
  );
  const utc = normalizeRecallSourcePointRecord(
    bot({
      joinAt: "2026-07-25T20:00:00.123456Z",
    }),
    options({ expectedReference }),
  );
  assert.equal(
    offset.joinAt,
    "2026-07-25T20:00:00.123456000Z",
  );
  assert.equal(
    offset.enumeratedJoinAt,
    "2026-07-25T20:00:00.123Z",
  );
  assert.deepEqual(offset, utc);
  assert.deepEqual(
    recallSourcePointEvidence(
      bot({
        joinAt:
          "2026-07-25T15:00:00.123456-05:00",
      }),
      options({ expectedReference }),
    ),
    recallSourcePointEvidence(
      bot({
        joinAt:
          "2026-07-25T20:00:00.123456Z",
      }),
      options({ expectedReference }),
    ),
  );
});

test("synthetic transcript, presence, Vapi, or verdict fields cannot smuggle classification", () => {
  for (const field of [
    "classification",
    "presence",
    "provenanceVerified",
    "transcript",
    "vapi",
    "verdict",
  ]) {
    expectCode(
      () => normalizeRecallSourcePointRecord(
        bot({ [field]: { success: true } }),
        options(),
      ),
      "SOURCE_RECALL_POINT_DERIVED_EVIDENCE_FORBIDDEN",
    );
  }
});

test("ignored recording shortcut drift cannot rewrite point evidence", () => {
  for (const recordings of [
    null,
    {},
  ]) {
    expectCode(
      () => normalizeRecallSourcePointRecord(
        bot({ recordings }),
        options(),
      ),
      "SOURCE_RECALL_POINT_RECORDINGS_INVALID",
    );
  }

  const base = recallSourcePointEvidence(
    bot(),
    options(),
  );
  for (const recordings of [
    [{
      media_shortcuts: {
        transcript: {},
      },
    }],
    [{
      media_shortcuts: {
        transcript: { status: null },
      },
    }],
    [{
      media_shortcuts: {
        participant_events: {
          status: { code: 42 },
        },
      },
    }],
    [{
      media_shortcuts: [],
    }],
    [null, 42, "new vendor recording shape"],
  ]) {
    assert.deepEqual(
      recallSourcePointEvidence(
        bot({ recordings }),
        options(),
      ),
      base,
    );
  }
});

test("accessors, proxies, symbols, cycles, and expanded options fail closed", () => {
  const inheritedOnly = JSON.parse(JSON.stringify({
    __proto__: null,
    ["__proto__"]: {
      id: BOT_A,
      bot_name: "Raydar Screener",
      join_at: "2026-07-25T20:00:00.000Z",
      metadata: {
        source: "paraform-auto",
      },
    },
    status_changes: [],
    recordings: [],
  }));
  assert.equal(
    Object.prototype.hasOwnProperty.call(inheritedOnly, "id"),
    false,
  );
  expectCode(
    () => normalizeRecallSourcePointRecord(
      inheritedOnly,
      options(),
    ),
    "SOURCE_RECALL_POINT_RECORD_ID_INVALID",
  );

  const accessor = bot();
  Object.defineProperty(accessor, "id", {
    enumerable: true,
    get: () => BOT_A,
  });
  expectCode(
    () => normalizeRecallSourcePointRecord(
      accessor,
      options(),
    ),
    "SOURCE_RECALL_POINT_ACCESSOR_INVALID",
  );

  const symbol = bot();
  symbol[Symbol("hidden")] = BOT_B;
  expectCode(
    () => normalizeRecallSourcePointRecord(
      symbol,
      options(),
    ),
    "SOURCE_RECALL_POINT_SYMBOL_INVALID",
  );

  const cyclic = bot();
  cyclic.cycle = cyclic;
  assert.throws(
    () => normalizeRecallSourcePointRecord(
      cyclic,
      options(),
    ),
    SourceRecallPointCollectorError,
  );
  assert.throws(
    () => normalizeRecallSourcePointRecord(
      new Proxy(bot(), {}),
      options(),
    ),
    SourceRecallPointCollectorError,
  );
  expectCode(
    () => normalizeRecallSourcePointRecord(bot(), {
      ...options(),
      force: true,
    }),
    "SOURCE_RECALL_POINT_OPTIONS_INVALID",
  );
  expectCode(
    () => normalizeRecallSourcePointRecord(
      bot(),
      options({
        expectedReference: {
          ...reference(),
          unexpected: true,
        },
      }),
    ),
    "SOURCE_RECALL_POINT_REFERENCE_INVALID",
  );
  expectCode(
    () => normalizeRecallSourcePointRecord(
      bot(),
      options({
        expectedReference: {
          ...reference(),
          candidate: {
            ...reference().candidate,
            unexpected: true,
          },
        },
      }),
    ),
    "SOURCE_RECALL_POINT_REFERENCE_INVALID",
  );
});

test("digest-only evidence excludes raw ids, PII, links, and response bodies", () => {
  const raw = bot();
  const evidence = recallSourcePointEvidence(
    raw,
    options(),
  );
  assert.deepEqual(Object.keys(evidence).sort(), [
    "candidateIdentityResolutionAvailable",
    "decisionBoundaryDigest",
    "pinnable",
    "source",
    "sourceNormalizedInputDigest",
    "sourcePointReadProcedure",
    "sourceProvenanceDigest",
    "sourceRecordDigest",
    "sourceRecordRevisionDigest",
    "sourceReferenceDigest",
    "sourceStatusAtBoundaryDigest",
    "successClassificationAvailable",
  ]);
  assert.equal(evidence.source, "recall");
  assert.equal(
    evidence.sourcePointReadProcedure,
    SOURCE_IDENTITY_POINT_READ_PROCEDURES.recallSource,
  );
  assert.equal(evidence.successClassificationAvailable, false);
  assert.equal(
    evidence.candidateIdentityResolutionAvailable,
    false,
  );
  assert.equal(evidence.pinnable, false);
  for (const [key, value] of Object.entries(evidence)) {
    if (
      [
        "source",
        "sourcePointReadProcedure",
        "successClassificationAvailable",
        "candidateIdentityResolutionAvailable",
        "pinnable",
      ].includes(key)
    ) {
      continue;
    }
    assert.match(value, /^[a-f0-9]{64}$/u);
  }
  assert.equal(Object.isFrozen(evidence), true);
  const serialized = JSON.stringify(evidence);
  for (const forbidden of [
    BOT_A,
    raw.metadata.candidate_full_name,
    raw.metadata.candidate_email,
    raw.metadata.candidate_linkedin,
    raw.metadata.paraform_event_id,
    raw.meeting_url.meeting_id,
    raw.recordings[0].id,
    raw.recordings[0].media_shortcuts.transcript
      .data.download_url,
  ]) {
    assert.equal(serialized.includes(forbidden), false);
  }
});

test("semantic evidence ignores rotating payload fields and post-boundary drift", () => {
  const base = recallSourcePointEvidence(
    bot(),
    options(),
  );
  const noisy = recallSourcePointEvidence(bot({
    arbitrary_vendor_field: {
      rotates: "every read",
    },
    statusChanges: [
      ...bot().status_changes.map((status) => ({
        ...status,
        message: "ignored vendor diagnostic",
      })),
      {
        code: "post_boundary_change",
        sub_code: null,
        created_at: "2026-07-26T00:00:00.001Z",
      },
    ],
    recordings: [{
      id: "recording-synthetic-a",
      media_shortcuts: {
        transcript: {
          status: { code: "processing" },
          data: {
            download_url:
              "https://media.invalid/rotating-transcript-b",
          },
        },
        participant_events: {
          status: { code: "processing" },
          data: {
            participants_download_url:
              "https://media.invalid/rotating-presence-b",
          },
        },
      },
    }],
  }), options());
  assert.deepEqual(noisy, base);
});

test("contract-field tampering changes the appropriate semantic evidence", () => {
  const base = recallSourcePointEvidence(
    bot(),
    options(),
  );
  const hintChanged = recallSourcePointEvidence(bot({
    metadata: {
      candidate_email: "changed@example.invalid",
    },
  }), options({
    expectedReference: reference({
      email: "changed@example.invalid",
    }),
  }));
  assert.notEqual(
    hintChanged.sourceReferenceDigest,
    base.sourceReferenceDigest,
  );
  assert.notEqual(
    hintChanged.sourceRecordRevisionDigest,
    base.sourceRecordRevisionDigest,
  );
  assert.equal(
    hintChanged.sourceStatusAtBoundaryDigest,
    base.sourceStatusAtBoundaryDigest,
  );

  const statusChanged = recallSourcePointEvidence(bot({
    statusChanges: [
      bot().status_changes[0],
      {
        ...bot().status_changes[1],
        sub_code: "bot_kicked_from_call",
      },
    ],
  }), options());
  assert.equal(
    statusChanged.sourceReferenceDigest,
    base.sourceReferenceDigest,
  );
  assert.notEqual(
    statusChanged.sourceStatusAtBoundaryDigest,
    base.sourceStatusAtBoundaryDigest,
  );
  assert.notEqual(
    statusChanged.sourceRecordRevisionDigest,
    base.sourceRecordRevisionDigest,
  );

  const joinChanged = recallSourcePointEvidence(bot({
    joinAt: "2026-07-25T20:00:01.000Z",
  }), options({
    expectedReference: reference({
      joinAt: "2026-07-25T20:00:01.000Z",
    }),
  }));
  assert.notEqual(
    joinChanged.sourceReferenceDigest,
    base.sourceReferenceDigest,
  );
  assert.notEqual(
    joinChanged.sourceRecordRevisionDigest,
    base.sourceRecordRevisionDigest,
  );

  const submillisecondA = recallSourcePointEvidence(bot({
    joinAt: "2026-07-25T20:00:00.000001Z",
  }), options());
  const submillisecondB = recallSourcePointEvidence(bot({
    joinAt: "2026-07-25T20:00:00.000002Z",
  }), options());
  assert.equal(
    submillisecondA.sourceReferenceDigest,
    submillisecondB.sourceReferenceDigest,
  );
  assert.notEqual(
    submillisecondA.sourceRecordRevisionDigest,
    submillisecondB.sourceRecordRevisionDigest,
  );
});

test("input, record, reference, and boundary digest namespaces are exact", () => {
  const evidence = recallSourcePointEvidence(
    bot(),
    options(),
  );
  assert.equal(
    evidence.sourceNormalizedInputDigest,
    semanticDigest(
      "phase4-recall-source-point-input-v1",
      {
        method: "GET",
        path: `/api/v1/bot/${BOT_A}/`,
      },
    ),
  );
  assert.equal(
    evidence.sourceRecordDigest,
    semanticDigest(
      "phase4-recall-source-record-v1",
      BOT_A,
    ),
  );
  assert.equal(
    evidence.sourceReferenceDigest,
    semanticDigest(
      "phase4-recall-source-reference-v1",
      {
        sourceRecordDigest: evidence.sourceRecordDigest,
        joinAt: reference().joinAt,
        metadataSource: reference().metadataSource,
        candidate: reference().candidate,
      },
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

test("the Recall point slice has no I/O, transport, store, or authority surface", async () => {
  const source = await readFile(
    new URL(
      "../api/paraai/_lib/source-recall-point-collector.mjs",
      import.meta.url,
    ),
    "utf8",
  );
  for (const forbidden of [
    /\bfetch\s*\(/u,
    /\bcreateHmac\b/u,
    /\bprocess\.env\b/u,
    /\bKV_REST\b/u,
    /\bredis\b/iu,
    /\bcheckpointTrustedSourceCaptureEvent\b/u,
    /\bbuildSourceWatermarkCertificate\b/u,
  ]) {
    assert.doesNotMatch(source, forbidden);
  }
});

test("coordinator integration and every null release pin remain unchanged", async () => {
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
    /recallPageClient:\s*null,/u,
  );
  assert.doesNotMatch(
    coordinator,
    /source-recall-point-collector/u,
  );
  assert.match(
    watermark,
    /SOURCE_IDENTITY_BINDING_IDENTITY_ARTIFACT_DIGEST\s*=\s*\n\s*null;/u,
  );
  assert.match(
    watermark,
    /SOURCE_Q37_DISCRIMINATOR_ARTIFACT_DIGEST\s*=\s*null;/u,
  );
  assert.match(
    watermark,
    /SOURCE_HUMAN_INTRO_ARTIFACT_DIGEST\s*=\s*null;/u,
  );
});
