import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  SOURCE_PARAFORM_HUMAN_POINT_COLLECTOR_VERSION,
  SourceParaformHumanPointCollectorError,
  normalizeParaformHumanSourcePointRecord,
  paraformHumanSourcePointEvidence,
  paraformHumanSourcePointReadRequest,
} from "../api/paraai/_lib/source-paraform-human-point-collector.mjs";
import {
  SOURCE_IDENTITY_POINT_READ_PROCEDURES,
} from "../api/paraai/_lib/source-watermark.mjs";

const BOUNDARY = "2026-07-26T00:00:00.000Z";
const CALL_A = "call-synthetic-a";
const CALL_B = "call-synthetic-b";

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

function reference({
  id = CALL_A,
  scheduledAt = "2026-07-25T20:00:00.000Z",
  createdAt = "2026-07-24T20:00:00.000Z",
  title = "Synthetic Fixture / Recruiter",
  platform = "PHONE",
  recordingProvider = "TWILIO",
  owner = "Synthetic Recruiter",
  ownerId = "recruiter-user-synthetic",
  candidateUserId = "candidate-user-synthetic",
  hasTranscript = true,
  humanCall = true,
  name = "Synthetic Candidate",
  linkedin = "synthetic-candidate",
  emails = ["synthetic.candidate@example.invalid"],
} = {}) {
  return {
    id,
    scheduledAt,
    createdAt,
    title,
    platform,
    recordingProvider,
    owner,
    ownerId,
    candidateUserId,
    hasTranscript,
    humanCall,
    candidate: {
      name,
      linkedin,
      emails,
    },
  };
}

function transcript({
  secondSpeakerChars = 0,
  maximumEndSeconds = 60,
} = {}) {
  const rows = [{
    speaker: "Recruiter",
    speaker_id: "speaker-recruiter",
    words: [{
      text: "R".repeat(500),
      start_timestamp: 0,
      end_timestamp: Math.max(1, maximumEndSeconds - 1),
    }],
  }];
  if (secondSpeakerChars > 0) {
    rows.push({
      speaker: "Candidate",
      speaker_id: "speaker-candidate",
      words: [{
        text: "C".repeat(secondSpeakerChars),
        start_timestamp: 1,
        end_timestamp: maximumEndSeconds,
      }],
    });
  }
  return rows;
}

function point(overrides = {}) {
  return {
    attendee_emails: [
      "synthetic.candidate@example.invalid",
    ],
    candidate_user: {
      candidate: {
        image_src: "https://example.invalid/candidate.png",
        name: "Synthetic Candidate",
      },
    },
    candidate_user_id: "candidate-user-synthetic",
    event_scheduled_at:
      "2026-07-25T20:00:00.000Z",
    event_title: "Synthetic Fixture / Recruiter",
    google_calendar_event: null,
    granola_note_id: null,
    id: CALL_A,
    is_public: false,
    meeting_link: null,
    meeting_platform: "PHONE",
    recording_provider: "TWILIO",
    recording_summary: null,
    recording_transcript: transcript(),
    recording_url:
      "https://example.invalid/private-recording",
    user_id: "recruiter-user-synthetic",
    ...overrides,
  };
}

function pointForReference(
  expectedReference,
  overrides = {},
) {
  const linked = Boolean(
    expectedReference.candidateUserId,
  );
  return point({
    attendee_emails:
      expectedReference.candidate.emails,
    candidate_user: linked
      ? {
        candidate: {
          image_src:
            "https://example.invalid/candidate.png",
          name: expectedReference.candidate.name,
        },
      }
      : null,
    candidate_user_id: linked
      ? expectedReference.candidateUserId
      : null,
    event_scheduled_at:
      expectedReference.scheduledAt,
    event_title: expectedReference.title || null,
    id: expectedReference.id,
    meeting_platform: expectedReference.platform,
    recording_provider:
      expectedReference.recordingProvider,
    user_id: expectedReference.ownerId,
    ...overrides,
  });
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
      error instanceof SourceParaformHumanPointCollectorError
      && error.code === code
      && error.message === code
    ),
  );
}

test("captured phone point request and v2 projection are frozen and hard-dark", () => {
  assert.equal(
    SOURCE_PARAFORM_HUMAN_POINT_COLLECTOR_VERSION,
    "paraform-human-source-point-v2",
  );
  const request =
    paraformHumanSourcePointReadRequest(CALL_A);
  assert.deepEqual(request, {
    method: "GET",
    procedure:
      "candidateUserMeeting.getCallById",
    input: {
      json: {
        id: CALL_A,
      },
    },
  });
  assert.equal(Object.isFrozen(request), true);
  assert.equal(Object.isFrozen(request.input), true);
  assert.equal(Object.isFrozen(request.input.json), true);

  const projection =
    normalizeParaformHumanSourcePointRecord(
      point(),
      options(),
    );
  assert.equal(projection.source, "paraform_human");
  assert.equal(projection.callId, CALL_A);
  assert.equal(projection.platform, "PHONE");
  assert.equal(projection.recordingProvider, "TWILIO");
  assert.equal(projection.ownerId, "recruiter-user-synthetic");
  assert.equal(projection.pointResponseContractVerified, true);
  assert.equal(projection.recordContinuityVerified, true);
  assert.equal(projection.sourceRecordRevisionAvailable, true);
  assert.equal(projection.humanCallDiscriminatorAvailable, true);
  assert.equal(projection.humanCallVerified, true);
  assert.equal(projection.successClassificationAvailable, true);
  assert.equal(projection.classification, "pending");
  assert.equal(projection.successVerified, false);
  assert.equal(
    projection.candidateIdentityResolutionAvailable,
    false,
  );
  assert.equal(
    projection.completeReferenceContinuityAvailable,
    false,
  );
  assert.equal(projection.pinnable, false);
  assert.equal(Object.isFrozen(projection), true);
  assert.equal(Object.isFrozen(projection.pageReference), true);
  assert.equal(
    Object.keys(projection).includes("transcript"),
    false,
  );
});

test("stable PHONE plus TWILIO discriminator rejects every other lane", () => {
  for (const [override, code] of [
    [
      { meeting_platform: "GOOGLE_MEET" },
      "SOURCE_PARAFORM_HUMAN_POINT_NOT_HUMAN",
    ],
    [
      { recording_provider: "RECALL" },
      "SOURCE_PARAFORM_HUMAN_POINT_NOT_HUMAN",
    ],
    [
      { meeting_platform: null },
      "SOURCE_PARAFORM_HUMAN_POINT_PLATFORM_INVALID",
    ],
    [
      { recording_provider: null },
      "SOURCE_PARAFORM_HUMAN_POINT_RECORDING_PROVIDER_INVALID",
    ],
  ]) {
    expectCode(
      () => normalizeParaformHumanSourcePointRecord(
        point(override),
        options(),
      ),
      code,
    );
  }
});

test("the captured 16-field phone response contract is exact", () => {
  const extra = point({ new_vendor_field: true });
  expectCode(
    () => normalizeParaformHumanSourcePointRecord(
      extra,
      options(),
    ),
    "SOURCE_PARAFORM_HUMAN_POINT_CONTRACT_INVALID",
  );

  const missing = point();
  delete missing.recording_summary;
  expectCode(
    () => normalizeParaformHumanSourcePointRecord(
      missing,
      options(),
    ),
    "SOURCE_PARAFORM_HUMAN_POINT_CONTRACT_INVALID",
  );

  for (const override of [
    { google_calendar_event: {} },
    { granola_note_id: "unexpected" },
    { is_public: "false" },
  ]) {
    expectCode(
      () => normalizeParaformHumanSourcePointRecord(
        point(override),
        options(),
      ),
      "SOURCE_PARAFORM_HUMAN_POINT_PHONE_CONTRACT_INVALID",
    );
  }
});

test("linked and unlinked captured phone variants normalize without inventing identity", () => {
  const unlinkedReference = reference({
    title: "",
    candidateUserId: "",
    name: "",
    linkedin: "",
    emails: [],
  });
  const unlinked =
    normalizeParaformHumanSourcePointRecord(
      pointForReference(unlinkedReference),
      options({
        expectedReference: unlinkedReference,
      }),
    );
  assert.equal(unlinked.candidateUserId, "");
  assert.deepEqual(unlinked.candidate, {
    name: "",
    emails: [],
  });
  assert.equal(
    unlinked.candidateIdentityResolutionAvailable,
    false,
  );

  expectCode(
    () => normalizeParaformHumanSourcePointRecord(
      point({ candidate_user: null }),
      options(),
    ),
    "SOURCE_PARAFORM_HUMAN_POINT_CANDIDATE_LINKAGE_INVALID",
  );
  expectCode(
    () => normalizeParaformHumanSourcePointRecord(
      point({ candidate_user_id: null }),
      options(),
    ),
    "SOURCE_PARAFORM_HUMAN_POINT_CANDIDATE_LINKAGE_INVALID",
  );
});

test("complete captured overlap and owner-id continuity are exact", () => {
  for (const override of [
    { id: CALL_B },
    {
      event_scheduled_at:
        "2026-07-25T20:00:00.001Z",
    },
    { event_title: "Changed title" },
    { user_id: "changed-owner" },
    { candidate_user_id: "changed-candidate-user" },
    {
      candidate_user: {
        candidate: {
          image_src: null,
          name: "Changed Candidate",
        },
      },
    },
    {
      attendee_emails: [
        "changed@example.invalid",
      ],
    },
  ]) {
    const expectedCode = override.id
      ? "SOURCE_PARAFORM_HUMAN_POINT_EXPECTED_ID_MISMATCH"
      : "SOURCE_PARAFORM_HUMAN_POINT_REFERENCE_MISMATCH";
    expectCode(
      () => normalizeParaformHumanSourcePointRecord(
        point(override),
        options(),
      ),
      expectedCode,
    );
  }
});

test("page reference v2 is exact, bounded, and Human-only", () => {
  for (const expectedReference of [
    { ...reference(), unexpected: true },
    {
      ...reference(),
      candidate: {
        ...reference().candidate,
        unexpected: true,
      },
    },
    reference({ platform: "GOOGLE_MEET" }),
    reference({ recordingProvider: "RECALL" }),
    reference({ humanCall: false }),
    reference({ ownerId: "" }),
    reference({ emails: ["UPPER@example.invalid"] }),
    reference({ emails: [""] }),
    reference({
      emails: Array.from(
        { length: 513 },
        (_, index) => `${index}@example.invalid`,
      ),
    }),
  ]) {
    const expectedCode = (
      expectedReference.platform !== "PHONE"
      || expectedReference.recordingProvider !== "TWILIO"
      || expectedReference.humanCall !== true
    )
      ? "SOURCE_PARAFORM_HUMAN_POINT_REFERENCE_NOT_HUMAN"
      : "SOURCE_PARAFORM_HUMAN_POINT_REFERENCE_INVALID";
    expectCode(
      () => normalizeParaformHumanSourcePointRecord(
        point(),
        options({ expectedReference }),
      ),
      expectedCode,
    );
  }
});

test("page and point clocks are canonical and strictly before the boundary", () => {
  for (const expectedReference of [
    reference({ scheduledAt: BOUNDARY }),
    reference({ createdAt: BOUNDARY }),
  ]) {
    expectCode(
      () => normalizeParaformHumanSourcePointRecord(
        point(),
        options({ expectedReference }),
      ),
      "SOURCE_PARAFORM_HUMAN_POINT_REFERENCE_OUTSIDE_BOUNDARY",
    );
  }
  for (const expectedReference of [
    reference({
      scheduledAt: "2026-07-25T19:00:00.000-05:00",
    }),
    reference({
      createdAt: "2026-02-30T00:00:00.000Z",
    }),
  ]) {
    expectCode(
      () => normalizeParaformHumanSourcePointRecord(
        point(),
        options({ expectedReference }),
      ),
      "SOURCE_PARAFORM_HUMAN_POINT_REFERENCE_INVALID",
    );
  }
  expectCode(
    () => normalizeParaformHumanSourcePointRecord(
      point(),
      {
        ...options(),
        decisionBoundaryAt: "2026-07-26T00:00:00Z",
      },
    ),
    "SOURCE_PARAFORM_HUMAN_POINT_BOUNDARY_INVALID",
  );
});

test("vendor offsets and nanoseconds retain the page millisecond identity", () => {
  const expectedReference = reference({
    scheduledAt: "2026-07-25T23:59:59.999Z",
  });
  const offset = paraformHumanSourcePointEvidence(
    pointForReference(expectedReference, {
      event_scheduled_at:
        "2026-07-26T08:59:59.999999+09:00",
    }),
    options({ expectedReference }),
  );
  const utc = paraformHumanSourcePointEvidence(
    pointForReference(expectedReference, {
      event_scheduled_at:
        "2026-07-25T23:59:59.999999Z",
    }),
    options({ expectedReference }),
  );
  assert.deepEqual(offset, utc);

  for (const eventScheduledAt of [
    BOUNDARY,
    "2026-07-26T00:00:00.000001Z",
  ]) {
    expectCode(
      () => normalizeParaformHumanSourcePointRecord(
        pointForReference(expectedReference, {
          event_scheduled_at: eventScheduledAt,
        }),
        options({ expectedReference }),
      ),
      "SOURCE_PARAFORM_HUMAN_POINT_SCHEDULED_AT_OUTSIDE_BOUNDARY",
    );
  }
});

test("transcript presence is recomputed and checked when the page asserts it", () => {
  const absentReference = reference({
    hasTranscript: false,
  });
  const absent = normalizeParaformHumanSourcePointRecord(
    pointForReference(absentReference, {
      recording_transcript: [],
    }),
    options({ expectedReference: absentReference }),
  );
  assert.equal(absent.transcriptPresent, false);
  assert.equal(absent.pageTranscriptContinuityVerified, true);

  expectCode(
    () => normalizeParaformHumanSourcePointRecord(
      point({ recording_transcript: [] }),
      options(),
    ),
    "SOURCE_PARAFORM_HUMAN_POINT_TRANSCRIPT_CONTINUITY_MISMATCH",
  );

  const unassertedReference = reference({
    hasTranscript: null,
  });
  const unasserted =
    normalizeParaformHumanSourcePointRecord(
      pointForReference(unassertedReference),
      options({
        expectedReference: unassertedReference,
      }),
    );
  assert.equal(
    unasserted.pageTranscriptContinuityVerified,
    null,
  );
});

test("substantive two-speaker transcript produces a boundary-complete success", () => {
  const successful =
    normalizeParaformHumanSourcePointRecord(
      point({
        recording_transcript: transcript({
          secondSpeakerChars: 400,
          maximumEndSeconds: 120.125,
        }),
      }),
      options(),
    );
  assert.equal(successful.transcriptSpeakerCount, 2);
  assert.equal(successful.secondSpeakerChars, 400);
  assert.equal(successful.observedEndedAt,
    "2026-07-25T20:02:00.125Z");
  assert.equal(successful.classification, "success");
  assert.equal(successful.successVerified, true);

  const evidence = paraformHumanSourcePointEvidence(
    point({
      recording_transcript: transcript({
        secondSpeakerChars: 400,
        maximumEndSeconds: 120.125,
      }),
    }),
    options(),
  );
  assert.equal(evidence.classification, "success");
  assert.equal(evidence.successVerified, true);
});

test("voicemail, quiet second speaker, and post-boundary speech remain pending", () => {
  for (const raw of [
    point(),
    point({
      recording_transcript: transcript({
        secondSpeakerChars: 399,
      }),
    }),
  ]) {
    const projection =
      normalizeParaformHumanSourcePointRecord(
        raw,
        options(),
      );
    assert.equal(projection.classification, "pending");
    assert.equal(projection.successVerified, false);
  }

  const nearBoundaryReference = reference({
    scheduledAt: "2026-07-25T23:59:30.000Z",
  });
  const postBoundary =
    normalizeParaformHumanSourcePointRecord(
      pointForReference(nearBoundaryReference, {
        recording_transcript: transcript({
          secondSpeakerChars: 400,
          maximumEndSeconds: 60,
        }),
      }),
      options({
        expectedReference: nearBoundaryReference,
      }),
    );
  assert.equal(postBoundary.observedEndedAt,
    "2026-07-26T00:00:30.000Z");
  assert.equal(postBoundary.classification, "pending");
  assert.equal(postBoundary.successVerified, false);
});

test("sub-millisecond transcript endings use exact point time at the boundary", () => {
  const expectedReference = reference({
    scheduledAt: "2026-07-25T23:59:59.999Z",
  });
  const exactTranscript = (candidateEnd) => [{
    speaker: "Recruiter",
    speaker_id: "speaker-recruiter",
    words: [{
      text: "R".repeat(500),
      start_timestamp: 0,
      end_timestamp: 0.0000003,
    }],
  }, {
    speaker: "Candidate",
    speaker_id: "speaker-candidate",
    words: [{
      text: "C".repeat(400),
      start_timestamp: 0,
      end_timestamp: candidateEnd,
    }],
  }];
  const before = normalizeParaformHumanSourcePointRecord(
    pointForReference(expectedReference, {
      event_scheduled_at:
        "2026-07-25T23:59:59.999999500Z",
      recording_transcript:
        exactTranscript(0.0000004),
    }),
    options({ expectedReference }),
  );
  assert.equal(before.observedEndedAt, BOUNDARY);
  assert.equal(before.successVerified, true);

  const after = normalizeParaformHumanSourcePointRecord(
    pointForReference(expectedReference, {
      event_scheduled_at:
        "2026-07-25T23:59:59.999999500Z",
      recording_transcript:
        exactTranscript(0.0000006),
    }),
    options({ expectedReference }),
  );
  assert.equal(after.observedEndedAt,
    "2026-07-26T00:00:00.001Z");
  assert.equal(after.successVerified, false);
  assert.equal(after.classification, "pending");
});

test("transcript shape, timestamps, and total size fail closed", () => {
  const invalidTurns = [
    [{
      speaker: "Recruiter",
      speaker_id: "speaker",
      words: [{
        text: "hello",
        start_timestamp: 2,
        end_timestamp: 1,
      }],
    }],
    [{
      speaker: "Recruiter",
      speaker_id: 1,
      words: [],
    }],
    [{
      speaker: "Recruiter",
      speaker_id: "speaker",
      words: [{
        text: "hello",
        start_timestamp: 0,
        end_timestamp: 86_401,
      }],
    }],
    [{
      speaker: "Recruiter",
      speaker_id: "speaker",
      words: [{
        text: "x".repeat(4_097),
        start_timestamp: 0,
        end_timestamp: 1,
      }],
    }],
  ];
  for (const recordingTranscript of invalidTurns) {
    assert.throws(
      () => normalizeParaformHumanSourcePointRecord(
        point({
          recording_transcript: recordingTranscript,
        }),
        options(),
      ),
      SourceParaformHumanPointCollectorError,
    );
  }

  const hostileSparse = [];
  hostileSparse.length = 4_294_967_295;
  expectCode(
    () => normalizeParaformHumanSourcePointRecord(
      point({ recording_transcript: hostileSparse }),
      options(),
    ),
    "SOURCE_PARAFORM_HUMAN_POINT_TRANSCRIPT_INVALID",
  );
});

test("semantic revision binds all decision-bearing phone point material", () => {
  const base = paraformHumanSourcePointEvidence(
    point(),
    options(),
  );
  const variants = [
    point({ is_public: true }),
    point({
      recording_url:
        "https://example.invalid/changed-recording",
    }),
    point({
      recording_transcript: [{
        speaker: "Recruiter",
        speaker_id: "speaker-recruiter",
        words: [{
          text: "changed private transcript",
          start_timestamp: 0,
          end_timestamp: 1,
        }],
      }],
    }),
    point({
      candidate_user: {
        candidate: {
          image_src:
            "https://example.invalid/changed-image",
          name: "Synthetic Candidate",
        },
      },
    }),
  ];
  for (const raw of variants) {
    const changed = paraformHumanSourcePointEvidence(
      raw,
      options(),
    );
    assert.equal(
      changed.sourceRecordDigest,
      base.sourceRecordDigest,
    );
    assert.notEqual(
      changed.sourcePointDigest,
      base.sourcePointDigest,
    );
    assert.notEqual(
      changed.sourceRecordRevisionDigest,
      base.sourceRecordRevisionDigest,
    );
  }
});

test("page-only owner and LinkedIn remain bound without inventing canonical identity", () => {
  const base = paraformHumanSourcePointEvidence(
    point(),
    options(),
  );
  for (const expectedReference of [
    reference({ owner: "Changed Recruiter Display" }),
    reference({ linkedin: "changed-linkedin-hint" }),
    reference({
      createdAt: "2026-07-24T20:00:00.001Z",
    }),
  ]) {
    const changed = paraformHumanSourcePointEvidence(
      point(),
      options({ expectedReference }),
    );
    assert.notEqual(
      changed.sourceReferenceDigest,
      base.sourceReferenceDigest,
    );
    assert.notEqual(
      changed.sourceRecordRevisionDigest,
      base.sourceRecordRevisionDigest,
    );
    assert.equal(
      changed.candidateIdentityResolutionAvailable,
      false,
    );
    assert.equal(changed.pinnable, false);
  }
});

test("digest-only evidence excludes raw ids, PII, transcript, and URLs", () => {
  const raw = point();
  const expectedReference = reference();
  const evidence = paraformHumanSourcePointEvidence(
    raw,
    options({ expectedReference }),
  );
  assert.deepEqual(Object.keys(evidence).sort(), [
    "candidateIdentityResolutionAvailable",
    "classification",
    "completeReferenceContinuityAvailable",
    "decisionBoundaryDigest",
    "humanCallDiscriminatorAvailable",
    "humanCallDiscriminatorDigest",
    "humanCallVerified",
    "pageTranscriptContinuityVerified",
    "pinnable",
    "pointRecordIdVerified",
    "pointResponseContractVerified",
    "recordContinuityVerified",
    "source",
    "sourceNormalizedInputDigest",
    "sourcePointDigest",
    "sourcePointReadProcedure",
    "sourceRecordDigest",
    "sourceRecordRevisionAvailable",
    "sourceRecordRevisionDigest",
    "sourceReferenceDigest",
    "sourceStatusAtBoundaryDigest",
    "successClassificationAvailable",
    "successVerified",
  ]);
  assert.equal(
    evidence.sourcePointReadProcedure,
    SOURCE_IDENTITY_POINT_READ_PROCEDURES
      .paraformHumanSource,
  );
  for (const key of [
    "sourceNormalizedInputDigest",
    "sourcePointDigest",
    "sourceRecordDigest",
    "sourceRecordRevisionDigest",
    "sourceReferenceDigest",
    "sourceStatusAtBoundaryDigest",
    "humanCallDiscriminatorDigest",
    "decisionBoundaryDigest",
  ]) {
    assert.match(evidence[key], /^[a-f0-9]{64}$/u);
  }
  const serialized = JSON.stringify(evidence);
  for (const forbidden of [
    CALL_A,
    raw.event_scheduled_at,
    raw.user_id,
    expectedReference.title,
    expectedReference.owner,
    expectedReference.candidateUserId,
    expectedReference.candidate.name,
    expectedReference.candidate.linkedin,
    expectedReference.candidate.emails[0],
    raw.recording_transcript[0].words[0].text,
    raw.recording_url,
  ]) {
    assert.equal(serialized.includes(forbidden), false);
  }
});

test("request, record, discriminator, and boundary digest namespaces are exact", () => {
  const evidence = paraformHumanSourcePointEvidence(
    point(),
    options(),
  );
  const request = {
    method: "GET",
    procedure:
      "candidateUserMeeting.getCallById",
    input: {
      json: {
        id: CALL_A,
      },
    },
  };
  assert.equal(
    evidence.sourceNormalizedInputDigest,
    semanticDigest(
      "phase4-paraform-human-source-point-request-v2",
      request,
    ),
  );
  assert.equal(
    evidence.sourceRecordDigest,
    semanticDigest(
      "phase4-paraform-human-source-record-v1",
      CALL_A,
    ),
  );
  assert.equal(
    evidence.humanCallDiscriminatorDigest,
    semanticDigest(
      "phase4-paraform-human-discriminator-v1",
      {
        platform: "PHONE",
        recordingProvider: "TWILIO",
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

test("prototype pollution, accessors, proxies, symbols, and expanded options fail closed", () => {
  const accessor = point();
  Object.defineProperty(accessor, "id", {
    enumerable: true,
    get: () => CALL_A,
  });
  expectCode(
    () => normalizeParaformHumanSourcePointRecord(
      accessor,
      options(),
    ),
    "SOURCE_PARAFORM_HUMAN_POINT_ACCESSOR_INVALID",
  );

  const symbol = point();
  symbol[Symbol("hidden")] = CALL_B;
  expectCode(
    () => normalizeParaformHumanSourcePointRecord(
      symbol,
      options(),
    ),
    "SOURCE_PARAFORM_HUMAN_POINT_SYMBOL_INVALID",
  );

  assert.throws(
    () => normalizeParaformHumanSourcePointRecord(
      new Proxy(point(), {}),
      options(),
    ),
    SourceParaformHumanPointCollectorError,
  );

  const inheritedCandidate = Object.create({
    image_src: null,
    name: "Synthetic Candidate",
  });
  expectCode(
    () => normalizeParaformHumanSourcePointRecord(
      point({
        candidate_user: {
          candidate: inheritedCandidate,
        },
      }),
      options(),
    ),
    "SOURCE_PARAFORM_HUMAN_POINT_CANDIDATE_INVALID",
  );

  expectCode(
    () => normalizeParaformHumanSourcePointRecord(
      point(),
      {
        ...options(),
        force: true,
      },
    ),
    "SOURCE_PARAFORM_HUMAN_POINT_OPTIONS_INVALID",
  );
});

test("the Human point v2 projector has no I/O, store, signer, or authority surface", async () => {
  const source = await readFile(
    new URL(
      "../api/paraai/_lib/source-paraform-human-point-collector.mjs",
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
    /\bhumanCallReadiness\b/u,
    /\bsource-capture-coordinator\b/u,
  ]) {
    assert.doesNotMatch(source, forbidden);
  }
});

test("coordinator integration and Human/Q37 release pins remain unchanged", async () => {
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
    /paraformHumanPageClient:\s*null,/u,
  );
  assert.doesNotMatch(
    coordinator,
    /source-paraform-human-point-collector/u,
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
