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
  title = "Synthetic Fixture / Recruiter",
  platform = "PHONE",
  owner = "Synthetic Recruiter",
  candidateUserId = "candidate-user-synthetic",
  hasTranscript = true,
  name = "Synthetic Candidate",
  linkedin = "synthetic-candidate",
  emails = ["synthetic.candidate@example.invalid"],
} = {}) {
  return {
    id,
    scheduledAt,
    title,
    platform,
    owner,
    candidateUserId,
    hasTranscript,
    candidate: {
      name,
      linkedin,
      emails,
    },
  };
}

function point(overrides = {}) {
  return {
    id: CALL_A,
    event_scheduled_at:
      "2026-07-25T20:00:00.000Z",
    event_title: "Synthetic Fixture / Recruiter",
    meeting_platform: "PHONE",
    candidate_user_id: "candidate-user-synthetic",
    candidate_user: {
      candidate: {
        name: "Synthetic Candidate",
      },
    },
    attendee_emails: [
      "synthetic.candidate@example.invalid",
    ],
    recording_transcript: [{
      speaker_id: "synthetic-speaker",
      words: [{
        text: "synthetic private transcript body",
      }],
    }],
    ...overrides,
  };
}

function pointForReference(
  expectedReference,
  overrides = {},
) {
  return point({
    id: expectedReference.id,
    event_scheduled_at: expectedReference.scheduledAt,
    event_title: expectedReference.title,
    meeting_platform: expectedReference.platform,
    candidate_user_id: expectedReference.candidateUserId,
    candidate_user: {
      candidate: {
        name: expectedReference.candidate.name,
      },
    },
    attendee_emails: expectedReference.candidate.emails,
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

test("exact point request and private scaffold are frozen and unpinnable", () => {
  assert.equal(
    SOURCE_PARAFORM_HUMAN_POINT_COLLECTOR_VERSION,
    "paraform-human-source-point-scaffold-v1",
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
  assert.deepEqual(projection, {
    source: "paraform_human",
    callId: CALL_A,
    scheduledAt:
      "2026-07-25T20:00:00.000000000Z",
    enumeratedScheduledAt:
      "2026-07-25T20:00:00.000Z",
    title: "Synthetic Fixture / Recruiter",
    platform: "PHONE",
    candidateUserId: "candidate-user-synthetic",
    candidate: {
      name: "Synthetic Candidate",
      emails: [
        "synthetic.candidate@example.invalid",
      ],
    },
    decisionBoundaryAt: BOUNDARY,
    pageReference: reference(),
    pointRecordIdVerified: true,
    partialReferenceContinuityVerified: true,
    completePointResponseContractAvailable: false,
    completeReferenceContinuityAvailable: false,
    sourceRecordRevisionAvailable: false,
    humanCallDiscriminatorAvailable: false,
    successClassificationAvailable: false,
    candidateIdentityResolutionAvailable: false,
    pinnable: false,
  });
  assert.equal(Object.isFrozen(projection), true);
  assert.equal(
    Object.isFrozen(projection.candidate),
    true,
  );
  assert.equal(
    Object.isFrozen(projection.candidate.emails),
    true,
  );
  assert.equal(
    Object.isFrozen(projection.pageReference),
    true,
  );
  assert.equal(
    Object.isFrozen(projection.pageReference.candidate),
    true,
  );
  assert.equal(
    Object.isFrozen(
      projection.pageReference.candidate.emails,
    ),
    true,
  );
  assert.equal(
    Object.keys(projection).includes("transcript"),
    false,
  );
});

test("point input and returned root id are exact", () => {
  expectCode(
    () => normalizeParaformHumanSourcePointRecord(
      point({ id: CALL_B }),
      options(),
    ),
    "SOURCE_PARAFORM_HUMAN_POINT_EXPECTED_ID_MISMATCH",
  );
  for (const id of [
    "",
    " leading-space",
    "trailing-space ",
    "line\nbreak",
    "x".repeat(257),
    42,
  ]) {
    expectCode(
      () => paraformHumanSourcePointReadRequest(id),
      "SOURCE_PARAFORM_HUMAN_POINT_INPUT_INVALID",
    );
  }
  expectCode(
    () => normalizeParaformHumanSourcePointRecord(
      {},
      options(),
    ),
    "SOURCE_PARAFORM_HUMAN_POINT_RECORD_ID_INVALID",
  );
});

test("page reference is exact, complete, and uses page email semantics", () => {
  const hostileSparseEmails = [];
  hostileSparseEmails.length = 4_294_967_295;
  const expectedReference = reference({
    emails: [
      "first@example.invalid",
      "second@example.invalid",
    ],
  });
  const projection =
    normalizeParaformHumanSourcePointRecord(
      pointForReference(expectedReference),
      options({
        expectedReference,
      }),
    );
  assert.deepEqual(
    projection.pageReference.candidate.emails,
    [
      "first@example.invalid",
      "second@example.invalid",
    ],
  );

  for (const expectedReference of [
    {
      ...reference(),
      unexpected: true,
    },
    {
      ...reference(),
      candidate: {
        ...reference().candidate,
        unexpected: true,
      },
    },
    {
      ...reference(),
      hasTranscript: "true",
    },
    reference({
      title: " padded",
    }),
    reference({
      emails: ["UPPER@example.invalid"],
    }),
    reference({
      emails: ["two  spaces@example.invalid"],
    }),
    reference({
      emails: [""],
    }),
    reference({
      emails: Array.from(
        { length: 513 },
        (_, index) => `${index}@example.invalid`,
      ),
    }),
    reference({
      emails: hostileSparseEmails,
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
});

test("page scheduled time is canonical and strictly before the boundary", () => {
  for (const scheduledAt of [
    BOUNDARY,
    "2026-07-26T00:00:00.001Z",
  ]) {
    expectCode(
      () => normalizeParaformHumanSourcePointRecord(
        point(),
        options({
          expectedReference: reference({
            scheduledAt,
          }),
        }),
      ),
      "SOURCE_PARAFORM_HUMAN_POINT_SCHEDULED_AT_OUTSIDE_BOUNDARY",
    );
  }
  for (const scheduledAt of [
    "2026-07-26T00:00:00.000001Z",
    "2026-07-25T19:00:00.000-05:00",
    "2026-02-30T00:00:00.000Z",
  ]) {
    expectCode(
      () => normalizeParaformHumanSourcePointRecord(
        point(),
        options({
          expectedReference: reference({
            scheduledAt,
          }),
        }),
      ),
      "SOURCE_PARAFORM_HUMAN_POINT_REFERENCE_INVALID",
    );
  }
  expectCode(
    () => normalizeParaformHumanSourcePointRecord(
      point(),
      options({
        decisionBoundaryAt:
          "2026-07-26T00:00:00Z",
      }),
    ),
    "SOURCE_PARAFORM_HUMAN_POINT_BOUNDARY_INVALID",
  );
});

test("point scheduled time preserves sub-millisecond evidence and enforces the exact boundary", () => {
  const expectedReference = reference({
    scheduledAt: "2026-07-25T23:59:59.999Z",
  });
  const exact = normalizeParaformHumanSourcePointRecord(
    pointForReference(expectedReference, {
      event_scheduled_at:
        "2026-07-25T23:59:59.999999Z",
    }),
    options({ expectedReference }),
  );
  assert.equal(
    exact.scheduledAt,
    "2026-07-25T23:59:59.999999000Z",
  );
  assert.equal(
    exact.enumeratedScheduledAt,
    expectedReference.scheduledAt,
  );

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
    "2026-07-26T09:00:00.000001+09:00",
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

test("point overlap uses the exhaustive page normalization semantics", () => {
  const expectedReference = reference({
    emails: [
      "first@example.invalid",
      "second @example.invalid",
    ],
  });
  const projection =
    normalizeParaformHumanSourcePointRecord(
      pointForReference(expectedReference, {
        event_title:
          "  Synthetic Fixture / Recruiter  ",
        meeting_platform: " PHONE ",
        candidate_user_id:
          " candidate-user-synthetic ",
        candidate_user: {
          candidate: {
            name: " Synthetic Candidate ",
          },
        },
        attendee_emails: [
          " FIRST@EXAMPLE.INVALID ",
          "",
          " SECOND  @EXAMPLE.INVALID ",
        ],
      }),
      options({ expectedReference }),
    );
  assert.equal(
    projection.title,
    expectedReference.title,
  );
  assert.equal(
    projection.platform,
    expectedReference.platform,
  );
  assert.equal(
    projection.candidateUserId,
    expectedReference.candidateUserId,
  );
  assert.deepEqual(
    projection.candidate,
    {
      name: expectedReference.candidate.name,
      emails: expectedReference.candidate.emails,
    },
  );
});

test("malformed captured point fields fail closed", () => {
  const hostileSparseEmails = [];
  hostileSparseEmails.length = 4_294_967_295;
  const cases = [
    [
      { event_scheduled_at: null },
      "SOURCE_PARAFORM_HUMAN_POINT_SCHEDULED_AT_INVALID",
    ],
    [
      { event_title: null },
      "SOURCE_PARAFORM_HUMAN_POINT_TITLE_INVALID",
    ],
    [
      { meeting_platform: [] },
      "SOURCE_PARAFORM_HUMAN_POINT_PLATFORM_INVALID",
    ],
    [
      { candidate_user_id: 42 },
      "SOURCE_PARAFORM_HUMAN_POINT_CANDIDATE_USER_ID_INVALID",
    ],
    [
      { candidate_user: null },
      "SOURCE_PARAFORM_HUMAN_POINT_CANDIDATE_USER_INVALID",
    ],
    [
      { candidate_user: { candidate: null } },
      "SOURCE_PARAFORM_HUMAN_POINT_CANDIDATE_INVALID",
    ],
    [
      {
        candidate_user: {
          candidate: {
            name: false,
          },
        },
      },
      "SOURCE_PARAFORM_HUMAN_POINT_CANDIDATE_NAME_INVALID",
    ],
    [
      { attendee_emails: null },
      "SOURCE_PARAFORM_HUMAN_POINT_ATTENDEE_EMAILS_INVALID",
    ],
    [
      { attendee_emails: [42] },
      "SOURCE_PARAFORM_HUMAN_POINT_ATTENDEE_EMAILS_INVALID",
    ],
    [
      { attendee_emails: hostileSparseEmails },
      "SOURCE_PARAFORM_HUMAN_POINT_ATTENDEE_EMAILS_INVALID",
    ],
  ];
  for (const [override, code] of cases) {
    expectCode(
      () => normalizeParaformHumanSourcePointRecord(
        point(override),
        options(),
      ),
      code,
    );
  }
});

test("captured overlap is exact and both partial and page evidence bind it", () => {
  const base = paraformHumanSourcePointEvidence(
    point(),
    options(),
  );
  const verifiedVariants = [
    reference({
      scheduledAt: "2026-07-25T20:00:00.001Z",
    }),
    reference({ title: "Changed title" }),
    reference({ platform: "GOOGLE_MEET" }),
    reference({
      candidateUserId: "candidate-user-changed",
    }),
    reference({ name: "Changed Candidate" }),
    reference({
      emails: ["changed@example.invalid"],
    }),
    reference({
      emails: [
        "second@example.invalid",
        "first@example.invalid",
      ],
    }),
  ];
  for (const expectedReference of verifiedVariants) {
    const changed = paraformHumanSourcePointEvidence(
      pointForReference(expectedReference),
      options({ expectedReference }),
    );
    assert.equal(
      changed.sourceRecordDigest,
      base.sourceRecordDigest,
    );
    assert.equal(
      changed.sourceNormalizedInputDigest,
      base.sourceNormalizedInputDigest,
    );
    assert.notEqual(
      changed.sourceReferenceDigest,
      base.sourceReferenceDigest,
    );
    assert.notEqual(
      changed.sourcePartialPointDigest,
      base.sourcePartialPointDigest,
    );
  }

  const unverifiedVariants = [
    reference({ owner: "Changed Recruiter" }),
    reference({ hasTranscript: false }),
    reference({ hasTranscript: null }),
    reference({ linkedin: "changed-candidate" }),
  ];
  for (const expectedReference of unverifiedVariants) {
    const changed = paraformHumanSourcePointEvidence(
      point(),
      options({ expectedReference }),
    );
    assert.notEqual(
      changed.sourceReferenceDigest,
      base.sourceReferenceDigest,
    );
    assert.equal(
      changed.sourcePartialPointDigest,
      base.sourcePartialPointDigest,
    );
    assert.equal(
      changed.completeReferenceContinuityAvailable,
      false,
    );
  }
});

test("same-id overlap drift fails rather than blessing an unrelated page reference", () => {
  const variants = [
    {
      event_scheduled_at:
        "2026-07-25T20:00:00.001Z",
    },
    { event_title: "Changed title" },
    { meeting_platform: "GOOGLE_MEET" },
    { candidate_user_id: "candidate-user-changed" },
    {
      candidate_user: {
        candidate: {
          name: "Changed Candidate",
        },
      },
    },
    {
      attendee_emails: [
        "changed@example.invalid",
      ],
    },
  ];
  for (const variant of variants) {
    expectCode(
      () => paraformHumanSourcePointEvidence(
        point(variant),
        options(),
      ),
      "SOURCE_PARAFORM_HUMAN_POINT_REFERENCE_MISMATCH",
    );
  }
});

test("uncaptured response and post-boundary vendor drift cannot create evidence", () => {
  const base = paraformHumanSourcePointEvidence(
    point(),
    options(),
  );
  const changed = paraformHumanSourcePointEvidence(
    point({
      recording_transcript: [{
        speaker_id: "changed-speaker",
        words: [{
          text: "materially different private content",
        }],
      }],
      has_transcript: false,
      user: {
        name: "Drifted Private Owner",
      },
      candidate_user: {
        candidate: {
          name: "Synthetic Candidate",
          linkedin_user: "drifted-private-linkedin",
        },
      },
      updated_at: "2026-07-27T00:00:00.000Z",
      new_vendor_field: {
        arbitrary: true,
      },
    }),
    options(),
  );
  assert.deepEqual(changed, base);
  assert.equal(
    changed.completePointResponseContractAvailable,
    false,
  );
  assert.equal(
    changed.completeReferenceContinuityAvailable,
    false,
  );
  assert.equal(
    changed.sourceRecordRevisionAvailable,
    false,
  );
});

test("prototype pollution, accessors, proxies, symbols, and expanded options fail closed", () => {
  const inheritedOnly = JSON.parse(JSON.stringify({
    __proto__: null,
    ["__proto__"]: {
      id: CALL_A,
    },
    recording_transcript: [],
  }));
  assert.equal(
    Object.prototype.hasOwnProperty.call(
      inheritedOnly,
      "id",
    ),
    false,
  );
  expectCode(
    () => normalizeParaformHumanSourcePointRecord(
      inheritedOnly,
      options(),
    ),
    "SOURCE_PARAFORM_HUMAN_POINT_RECORD_ID_INVALID",
  );

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

  const accessorEmails = [
    "synthetic.candidate@example.invalid",
  ];
  Object.defineProperty(accessorEmails, "0", {
    enumerable: true,
    get: () => "synthetic.candidate@example.invalid",
  });
  expectCode(
    () => normalizeParaformHumanSourcePointRecord(
      point({
        attendee_emails: accessorEmails,
      }),
      options(),
    ),
    "SOURCE_PARAFORM_HUMAN_POINT_ATTENDEE_EMAILS_INVALID",
  );

  const cyclicReference = reference();
  cyclicReference.candidate.cycle =
    cyclicReference.candidate;
  assert.throws(
    () => normalizeParaformHumanSourcePointRecord(
      point(),
      options({
        expectedReference: cyclicReference,
      }),
    ),
    SourceParaformHumanPointCollectorError,
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

test("digest-only evidence excludes raw ids, PII, transcript, and response body", () => {
  const raw = point();
  const expectedReference = reference();
  const evidence = paraformHumanSourcePointEvidence(
    raw,
    options({ expectedReference }),
  );
  assert.deepEqual(Object.keys(evidence).sort(), [
    "candidateIdentityResolutionAvailable",
    "completePointResponseContractAvailable",
    "completeReferenceContinuityAvailable",
    "decisionBoundaryDigest",
    "humanCallDiscriminatorAvailable",
    "partialReferenceContinuityVerified",
    "pinnable",
    "pointRecordIdVerified",
    "source",
    "sourceNormalizedInputDigest",
    "sourcePartialPointDigest",
    "sourcePointReadProcedure",
    "sourceRecordDigest",
    "sourceRecordRevisionAvailable",
    "sourceReferenceDigest",
    "successClassificationAvailable",
  ]);
  assert.equal(
    evidence.sourcePointReadProcedure,
    SOURCE_IDENTITY_POINT_READ_PROCEDURES
      .paraformHumanSource,
  );
  assert.equal(evidence.pinnable, false);
  assert.equal(
    evidence.partialReferenceContinuityVerified,
    true,
  );
  assert.equal(
    evidence.successClassificationAvailable,
    false,
  );
  assert.equal(
    evidence.humanCallDiscriminatorAvailable,
    false,
  );
  for (const key of [
    "sourceNormalizedInputDigest",
    "sourcePartialPointDigest",
    "sourceRecordDigest",
    "sourceReferenceDigest",
    "decisionBoundaryDigest",
  ]) {
    assert.match(evidence[key], /^[a-f0-9]{64}$/u);
  }
  const serialized = JSON.stringify(evidence);
  for (const forbidden of [
    CALL_A,
    raw.event_scheduled_at,
    raw.meeting_platform,
    expectedReference.title,
    expectedReference.owner,
    expectedReference.candidateUserId,
    expectedReference.candidate.name,
    expectedReference.candidate.linkedin,
    expectedReference.candidate.emails[0],
    raw.recording_transcript[0].words[0].text,
  ]) {
    assert.equal(serialized.includes(forbidden), false);
  }
});

test("request, record, reference, and boundary digest namespaces are exact", () => {
  const expectedReference = reference();
  const evidence = paraformHumanSourcePointEvidence(
    point(),
    options({ expectedReference }),
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
  const sourceRecordDigest = semanticDigest(
    "phase4-paraform-human-source-record-v1",
    CALL_A,
  );
  assert.equal(
    evidence.sourceNormalizedInputDigest,
    semanticDigest(
      "phase4-paraform-human-source-point-request-v1",
      request,
    ),
  );
  assert.equal(
    evidence.sourceRecordDigest,
    sourceRecordDigest,
  );
  assert.equal(
    evidence.sourcePartialPointDigest,
    semanticDigest(
      "phase4-paraform-human-source-partial-point-v1",
      {
        sourceRecordDigest,
        scheduledAt:
          "2026-07-25T20:00:00.000000000Z",
        enumeratedScheduledAt:
          expectedReference.scheduledAt,
        title: expectedReference.title,
        platform: expectedReference.platform,
        candidateUserId:
          expectedReference.candidateUserId,
        candidate: {
          name: expectedReference.candidate.name,
          emails: expectedReference.candidate.emails,
        },
      },
    ),
  );
  assert.equal(
    evidence.sourceReferenceDigest,
    semanticDigest(
      "phase4-paraform-human-source-reference-v1",
      {
        sourceRecordDigest,
        scheduledAt: expectedReference.scheduledAt,
        title: expectedReference.title,
        platform: expectedReference.platform,
        owner: expectedReference.owner,
        candidateUserId:
          expectedReference.candidateUserId,
        hasTranscript:
          expectedReference.hasTranscript,
        candidate: expectedReference.candidate,
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

test("the Human point scaffold has no I/O, transport, store, or authority surface", async () => {
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
    /\btranscriptSubstance\b/u,
    /\bhumanCallReadiness\b/u,
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
