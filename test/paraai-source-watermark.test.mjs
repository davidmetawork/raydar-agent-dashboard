import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  SOURCE_WATERMARK_POLICY_VERSION,
  SOURCE_WATERMARK_SOURCES,
  SourceWatermarkInvariantError,
  buildCanonicalSourceAliasMap,
  buildPhase4WriteBoundaryAttestation,
  buildSourceWatermarkCertificate,
  buildSourceWatermarkGeneration,
  q37NewestSuccessfulCallDecision,
  sourceWatermarkFactSetDigest,
  sourceWatermarkPublicStatus,
  validatePhase4WriteBoundaryAttestation,
  validateSourceWatermarkGeneration,
} from "../api/paraai/_lib/source-watermark.mjs";

const T = "2026-07-26T00:00:00.000Z";
const COMMITTED_AT = "2026-07-26T00:06:00.000Z";
const ATTESTED_AT = "2026-07-26T00:07:00.000Z";
const VALIDATED_AT = "2026-07-26T00:08:00.000Z";
const digest = (character) => character.repeat(64);

const CANDIDATE_A = digest("a");
const CANDIDATE_B = digest("b");
const CANDIDATE_C = digest("c");
const CANDIDATE_USER_A = digest("1");
const CANDIDATE_USER_B = digest("2");
const RECORD_RECALL_A = digest("3");
const RECORD_RECALL_B = digest("4");
const RECORD_HUMAN_A = digest("5");
const RECORD_HUMAN_B = digest("6");
const RECALL_EPOCH = digest("d");
const PARAFORM_EPOCH = digest("e");
const ALIAS_EPOCH = "ab".repeat(32);
const GENERATION_NONCE = digest("7");
const COMMIT_REVISION = digest("8");
const JOB_REVISION = digest("9");
const WRITE_SCOPE = digest("0");

const aliasMapFixture = (entries, overrides = {}) =>
  buildCanonicalSourceAliasMap(entries, {
    authoritative: true,
    snapshotComplete: true,
    epochAtStart: ALIAS_EPOCH,
    epochAtEnd: ALIAS_EPOCH,
    ...overrides,
  });

const recallSuccess = ({
  candidate = CANDIDATE_A,
  record = RECORD_RECALL_A,
  endedAt = "2026-07-25T20:00:00.000Z",
} = {}) => ({
  source: SOURCE_WATERMARK_SOURCES.RECALL,
  recordDigest: record,
  classification: "success",
  identityStatus: "resolved",
  identityKind: "canonical_candidate",
  identityDigest: candidate,
  endedAt,
  provenanceVerified: true,
});

const humanSuccess = ({
  candidateUser = CANDIDATE_USER_A,
  record = RECORD_HUMAN_A,
  endedAt = "2026-07-25T21:00:00.000Z",
} = {}) => ({
  source: SOURCE_WATERMARK_SOURCES.PARAFORM_HUMAN,
  recordDigest: record,
  classification: "success",
  identityStatus: "resolved",
  identityKind: "candidate_user_alias",
  identityDigest: candidateUser,
  endedAt,
  provenanceVerified: true,
});

function issueCounts(facts) {
  return {
    pendingCount: facts.filter(
      (fact) => fact.classification === "pending",
    ).length,
    conflictCount: facts.filter((fact) => (
      fact.classification === "conflict"
      || fact.identityStatus === "conflict"
    )).length,
    unresolvedCount: facts.filter((fact) => (
      fact.classification === "success"
      && fact.identityStatus === "unresolved"
    )).length,
    invalidCount: facts.filter((fact) => (
      ["success", "failure"].includes(fact.classification)
      && fact.provenanceVerified !== true
    )).length,
  };
}

function certificateFixture(
  source,
  facts,
  {
    decisionBoundaryAt = T,
    epoch = source === SOURCE_WATERMARK_SOURCES.RECALL
      ? RECALL_EPOCH
      : PARAFORM_EPOCH,
    passOne = {},
    passTwo = {},
    passes = null,
  } = {},
) {
  const semanticDigest = sourceWatermarkFactSetDigest({
    source,
    decisionBoundaryAt,
    facts,
  });
  const counts = issueCounts(facts);
  const rows = passes || [
    {
      passNumber: 1,
      startedAt: "2026-07-26T00:01:00.000Z",
      completedAt: "2026-07-26T00:02:00.000Z",
      exhaustive: true,
      cursorExhausted: true,
      pageCount: 1,
      factCount: facts.length,
      ...counts,
      semanticDigest,
      epochAtStart: epoch,
      epochAtEnd: epoch,
      ...passOne,
    },
    {
      passNumber: 2,
      startedAt: "2026-07-26T00:03:00.000Z",
      completedAt: "2026-07-26T00:04:00.000Z",
      exhaustive: true,
      cursorExhausted: true,
      pageCount: 1,
      factCount: facts.length,
      ...counts,
      semanticDigest,
      epochAtStart: epoch,
      epochAtEnd: epoch,
      ...passTwo,
    },
  ];
  return buildSourceWatermarkCertificate({
    source,
    decisionBoundaryAt,
    collectorVersion: source === SOURCE_WATERMARK_SOURCES.RECALL
      ? "recall-source-v1"
      : "paraform-human-source-v1",
    facts,
    passes: rows,
  });
}

function generationFixture({
  status = "planned",
  decisionBoundaryAt = T,
  recallFacts = [recallSuccess()],
  humanFacts = [humanSuccess()],
  recallCertificate = null,
  humanCertificate = null,
  aliasEntries = [{
    canonicalCandidateDigest: CANDIDATE_A,
    candidateUserAliasDigest: CANDIDATE_USER_A,
  }],
  aliasMap = null,
  committedAt = status === "committed" ? COMMITTED_AT : null,
  commitRevisionDigest =
    status === "committed" ? COMMIT_REVISION : null,
} = {}) {
  const recallCert = recallCertificate || certificateFixture(
    SOURCE_WATERMARK_SOURCES.RECALL,
    recallFacts,
    { decisionBoundaryAt },
  );
  const humanCert = humanCertificate || certificateFixture(
    SOURCE_WATERMARK_SOURCES.PARAFORM_HUMAN,
    humanFacts,
    { decisionBoundaryAt },
  );
  return buildSourceWatermarkGeneration({
    decisionBoundaryAt,
    generationNonceDigest: GENERATION_NONCE,
    status,
    committedAt,
    commitRevisionDigest,
    recall: {
      certificate: recallCert,
      facts: recallFacts,
    },
    paraformHuman: {
      certificate: humanCert,
      facts: humanFacts,
    },
    aliasMap: aliasMap || aliasMapFixture(
      aliasEntries,
    ),
  });
}

function currentEpochs(overrides = {}) {
  return {
    recall: RECALL_EPOCH,
    paraformHuman: PARAFORM_EPOCH,
    aliases: ALIAS_EPOCH,
    ...overrides,
  };
}

test("source certificate requires two exhaustive stable passes", () => {
  const facts = [recallSuccess()];
  const certificate = certificateFixture(
    SOURCE_WATERMARK_SOURCES.RECALL,
    facts,
  );
  assert.equal(certificate.complete, true);
  assert.equal(certificate.historyMode, "source_exhaustion");
  assert.equal(certificate.passCount, 2);
  assert.equal(certificate.factCount, 1);
  assert.equal(certificate.stablePasses, true);
  assert.equal(certificate.exhaustive, true);
  assert.equal(certificate.cursorExhausted, true);
  assert.equal(certificate.sourceEpochDigest, RECALL_EPOCH);
  assert.deepEqual(certificate.reasons, []);
  assert.equal(Object.isFrozen(certificate), true);
  assert.equal(Object.isFrozen(certificate.passes), true);
});

test("source fact digest is deterministic across input order", () => {
  const facts = [
    recallSuccess({
      candidate: CANDIDATE_B,
      record: RECORD_RECALL_B,
    }),
    recallSuccess(),
  ];
  const forward = sourceWatermarkFactSetDigest({
    source: SOURCE_WATERMARK_SOURCES.RECALL,
    decisionBoundaryAt: T,
    facts,
  });
  const reversed = sourceWatermarkFactSetDigest({
    source: SOURCE_WATERMARK_SOURCES.RECALL,
    decisionBoundaryAt: T,
    facts: [...facts].reverse(),
  });
  assert.equal(forward, reversed);
});

test("one pass, partial pagination, or a cap cannot certify a source", () => {
  const facts = [recallSuccess()];
  const onePass = certificateFixture(
    SOURCE_WATERMARK_SOURCES.RECALL,
    facts,
    {
      passes: [{
        passNumber: 1,
        startedAt: "2026-07-26T00:01:00.000Z",
        completedAt: "2026-07-26T00:02:00.000Z",
        exhaustive: true,
        cursorExhausted: true,
        pageCount: 1,
        factCount: 1,
        pendingCount: 0,
        conflictCount: 0,
        unresolvedCount: 0,
        invalidCount: 0,
        semanticDigest: sourceWatermarkFactSetDigest({
          source: SOURCE_WATERMARK_SOURCES.RECALL,
          decisionBoundaryAt: T,
          facts,
        }),
        epochAtStart: RECALL_EPOCH,
        epochAtEnd: RECALL_EPOCH,
      }],
    },
  );
  const partial = certificateFixture(
    SOURCE_WATERMARK_SOURCES.RECALL,
    facts,
    {
      passTwo: {
        exhaustive: false,
        cursorExhausted: false,
      },
    },
  );
  assert.equal(onePass.complete, false);
  assert.ok(onePass.reasons.includes("stable_passes_missing"));
  assert.equal(partial.complete, false);
  assert.ok(partial.reasons.includes("source_not_exhaustive"));
  assert.ok(partial.reasons.includes("cursor_not_exhausted"));
});

test("semantic drift or source epoch movement fails closed", () => {
  const facts = [recallSuccess()];
  const semanticDrift = certificateFixture(
    SOURCE_WATERMARK_SOURCES.RECALL,
    facts,
    { passTwo: { semanticDigest: digest("f") } },
  );
  const withinPassEpochDrift = certificateFixture(
    SOURCE_WATERMARK_SOURCES.RECALL,
    facts,
    { passTwo: { epochAtEnd: digest("f") } },
  );
  const betweenPassEpochDrift = certificateFixture(
    SOURCE_WATERMARK_SOURCES.RECALL,
    facts,
    {
      passTwo: {
        epochAtStart: digest("f"),
        epochAtEnd: digest("f"),
      },
    },
  );
  for (const certificate of [
    semanticDrift,
    withinPassEpochDrift,
    betweenPassEpochDrift,
  ]) {
    assert.equal(certificate.complete, false);
  }
  assert.ok(
    semanticDrift.reasons.includes("semantic_digest_mismatch"),
  );
  assert.ok(
    semanticDrift.reasons.includes(
      "stable_pass_digest_mismatch",
    ),
  );
  assert.ok(
    withinPassEpochDrift.reasons.includes("source_epoch_moved"),
  );
  assert.ok(
    betweenPassEpochDrift.reasons.includes("source_epoch_moved"),
  );
});

test("pass count mismatches, non-sequential scans, and pre-boundary scans fail closed", () => {
  const facts = [recallSuccess()];
  const countMismatch = certificateFixture(
    SOURCE_WATERMARK_SOURCES.RECALL,
    facts,
    { passTwo: { factCount: 0 } },
  );
  const nonSequential = certificateFixture(
    SOURCE_WATERMARK_SOURCES.RECALL,
    facts,
    {
      passTwo: {
        startedAt: "2026-07-26T00:01:30.000Z",
      },
    },
  );
  const preBoundary = certificateFixture(
    SOURCE_WATERMARK_SOURCES.RECALL,
    facts,
    {
      passOne: {
        startedAt: "2026-07-25T23:58:00.000Z",
        completedAt: "2026-07-26T00:00:30.000Z",
      },
    },
  );
  assert.ok(countMismatch.reasons.includes("fact_count_mismatch"));
  assert.ok(
    nonSequential.reasons.includes("passes_not_sequential"),
  );
  assert.ok(preBoundary.reasons.includes("pass_predates_boundary"));
  assert.equal(countMismatch.complete, false);
  assert.equal(nonSequential.complete, false);
  assert.equal(preBoundary.complete, false);
});

test("pending, conflict, unresolved success, and invalid provenance remain incomplete", () => {
  const rows = [
    {
      label: "pending_facts",
      fact: {
        source: SOURCE_WATERMARK_SOURCES.RECALL,
        recordDigest: RECORD_RECALL_A,
        classification: "pending",
        identityStatus: "unresolved",
        endedAt: null,
        provenanceVerified: false,
      },
    },
    {
      label: "source_conflicts",
      fact: {
        source: SOURCE_WATERMARK_SOURCES.RECALL,
        recordDigest: RECORD_RECALL_A,
        classification: "conflict",
        identityStatus: "conflict",
        endedAt: null,
        provenanceVerified: false,
      },
    },
    {
      label: "unresolved_success_identity",
      fact: {
        source: SOURCE_WATERMARK_SOURCES.RECALL,
        recordDigest: RECORD_RECALL_A,
        classification: "success",
        identityStatus: "unresolved",
        endedAt: "2026-07-25T20:00:00.000Z",
        provenanceVerified: true,
      },
    },
    {
      label: "invalid_provenance",
      fact: {
        ...recallSuccess(),
        provenanceVerified: false,
      },
    },
  ];
  for (const { label, fact } of rows) {
    const certificate = certificateFixture(
      SOURCE_WATERMARK_SOURCES.RECALL,
      [fact],
    );
    assert.equal(certificate.complete, false);
    assert.ok(certificate.reasons.includes(label));
  }
});

test("source facts reject duplicates, post-boundary calls, and cross-source identity kinds", () => {
  assert.throws(
    () => sourceWatermarkFactSetDigest({
      source: SOURCE_WATERMARK_SOURCES.RECALL,
      decisionBoundaryAt: T,
      facts: [recallSuccess(), recallSuccess()],
    }),
    (error) => (
      error instanceof SourceWatermarkInvariantError
      && error.code === "SOURCE_FACT_DUPLICATE"
    ),
  );
  assert.throws(
    () => sourceWatermarkFactSetDigest({
      source: SOURCE_WATERMARK_SOURCES.RECALL,
      decisionBoundaryAt: T,
      facts: [recallSuccess({
        endedAt: "2026-07-26T00:00:00.001Z",
      })],
    }),
    /after decisionBoundaryAt/,
  );
  assert.throws(
    () => sourceWatermarkFactSetDigest({
      source: SOURCE_WATERMARK_SOURCES.PARAFORM_HUMAN,
      decisionBoundaryAt: T,
      facts: [{
        ...humanSuccess(),
        identityKind: "canonical_candidate",
      }],
    }),
    /identity kind/,
  );
});

test("alias map is a deterministic one-to-one canonical binding", () => {
  const entries = [
    {
      canonicalCandidateDigest: CANDIDATE_B,
      candidateUserAliasDigest: CANDIDATE_USER_B,
    },
    {
      canonicalCandidateDigest: CANDIDATE_A,
      candidateUserAliasDigest: CANDIDATE_USER_A,
    },
  ];
  const forward = aliasMapFixture(entries);
  const reverse = aliasMapFixture(
    [...entries].reverse(),
  );
  assert.equal(forward.complete, true);
  assert.equal(forward.authoritative, true);
  assert.equal(forward.snapshotComplete, true);
  assert.equal(forward.epochStable, true);
  assert.equal(forward.aliasEpochDigest, ALIAS_EPOCH);
  assert.equal(forward.conflictCount, 0);
  assert.equal(forward.canonicalCandidateCount, 2);
  assert.equal(forward.candidateUserAliasCount, 2);
  assert.equal(forward.aliasMapDigest, reverse.aliasMapDigest);
});

test("alias map requires an authoritative complete snapshot with a stable epoch", () => {
  const entries = [{
    canonicalCandidateDigest: CANDIDATE_A,
    candidateUserAliasDigest: CANDIDATE_USER_A,
  }];
  const nonAuthoritative = aliasMapFixture(entries, {
    authoritative: false,
  });
  const incomplete = aliasMapFixture(entries, {
    snapshotComplete: false,
  });
  const moved = aliasMapFixture(entries, {
    epochAtEnd: digest("f"),
  });
  for (const aliasMap of [
    nonAuthoritative,
    incomplete,
    moved,
  ]) {
    assert.equal(aliasMap.complete, false);
  }
  assert.equal(moved.epochStable, false);
  assert.equal(moved.aliasEpochDigest, null);
});

test("alias fan-in, fan-out, and duplicate edges fail closed", () => {
  const fanOut = aliasMapFixture([
    {
      canonicalCandidateDigest: CANDIDATE_A,
      candidateUserAliasDigest: CANDIDATE_USER_A,
    },
    {
      canonicalCandidateDigest: CANDIDATE_A,
      candidateUserAliasDigest: CANDIDATE_USER_B,
    },
  ]);
  const fanIn = aliasMapFixture([
    {
      canonicalCandidateDigest: CANDIDATE_A,
      candidateUserAliasDigest: CANDIDATE_USER_A,
    },
    {
      canonicalCandidateDigest: CANDIDATE_B,
      candidateUserAliasDigest: CANDIDATE_USER_A,
    },
  ]);
  const duplicate = aliasMapFixture([
    {
      canonicalCandidateDigest: CANDIDATE_A,
      candidateUserAliasDigest: CANDIDATE_USER_A,
    },
    {
      canonicalCandidateDigest: CANDIDATE_A,
      candidateUserAliasDigest: CANDIDATE_USER_A,
    },
  ]);
  assert.equal(fanOut.complete, false);
  assert.equal(fanOut.canonicalConflictCount, 1);
  assert.equal(fanIn.complete, false);
  assert.equal(fanIn.aliasConflictCount, 1);
  assert.equal(duplicate.complete, false);
  assert.equal(duplicate.duplicateEntryCount, 1);
});

test("Q37 selects the newest successful source and ignores newer failures", () => {
  const facts = [
    recallSuccess({ endedAt: "2026-07-25T20:00:00.000Z" }),
    {
      ...recallSuccess({
        record: RECORD_RECALL_B,
        endedAt: "2026-07-25T23:00:00.000Z",
      }),
      classification: "failure",
    },
    humanSuccess({ endedAt: "2026-07-25T21:00:00.000Z" }),
  ];
  const decision = q37NewestSuccessfulCallDecision({
    decisionBoundaryAt: T,
    facts,
  });
  assert.equal(decision.decision, "selected");
  assert.equal(decision.callType, "human");
  assert.equal(decision.endedAt, "2026-07-25T21:00:00.000Z");
});

test("Q37 handles both recency directions and exact cross-type ties", () => {
  const agentNewest = q37NewestSuccessfulCallDecision({
    decisionBoundaryAt: T,
    facts: [
      humanSuccess({ endedAt: "2026-07-25T20:00:00.000Z" }),
      recallSuccess({ endedAt: "2026-07-25T21:00:00.000Z" }),
    ],
  });
  const tie = q37NewestSuccessfulCallDecision({
    decisionBoundaryAt: T,
    facts: [
      humanSuccess({ endedAt: "2026-07-25T21:00:00.000Z" }),
      recallSuccess({ endedAt: "2026-07-25T21:00:00.000Z" }),
    ],
  });
  assert.equal(agentNewest.callType, "agent");
  assert.equal(tie.decision, "review_ambiguous_tie");
  assert.equal(tie.callType, null);
});

test("Q37 accepts an exact same-type tie without inventing ambiguity", () => {
  const decision = q37NewestSuccessfulCallDecision({
    decisionBoundaryAt: T,
    facts: [
      recallSuccess({
        record: RECORD_RECALL_A,
        endedAt: "2026-07-25T21:00:00.000Z",
      }),
      recallSuccess({
        record: RECORD_RECALL_B,
        endedAt: "2026-07-25T21:00:00.000Z",
      }),
    ],
  });
  assert.equal(decision.decision, "selected");
  assert.equal(decision.callType, "agent");
});

test("Q37 cannot select from pending, conflicting, or unverified source evidence", () => {
  const pending = q37NewestSuccessfulCallDecision({
    decisionBoundaryAt: T,
    facts: [{
      source: SOURCE_WATERMARK_SOURCES.RECALL,
      recordDigest: RECORD_RECALL_A,
      classification: "pending",
      identityStatus: "unresolved",
      endedAt: null,
      provenanceVerified: false,
    }],
  });
  const unresolved = q37NewestSuccessfulCallDecision({
    decisionBoundaryAt: T,
    facts: [{
      source: SOURCE_WATERMARK_SOURCES.RECALL,
      recordDigest: RECORD_RECALL_A,
      classification: "success",
      identityStatus: "unresolved",
      endedAt: "2026-07-25T21:00:00.000Z",
      provenanceVerified: true,
    }],
  });
  assert.equal(pending.decision, "review_incomplete_source");
  assert.equal(unresolved.decision, "review_incomplete_source");
  assert.equal(pending.callType, null);
  assert.equal(unresolved.callType, null);
});

test("combined generation binds both source certificates, aliases, and Q37", () => {
  const generation = generationFixture();
  assert.equal(generation.status, "planned");
  assert.equal(generation.intrinsicSourceComplete, true);
  assert.equal(generation.intrinsicQ37Ready, true);
  assert.equal(generation.q37.humanCount, 1);
  assert.equal(generation.q37.reviewCount, 0);
  assert.match(generation.manifestDigest, /^[a-f0-9]{64}$/);
  assert.equal(
    validateSourceWatermarkGeneration(generation).recordDigest,
    generation.recordDigest,
  );
});

test("persisted certificate, alias, manifest, and record tampering are rejected", () => {
  const generation = generationFixture();
  const factTamper = structuredClone(generation);
  factTamper.sources.recall.facts[0].endedAt =
    "2026-07-25T19:00:00.000Z";
  assert.throws(
    () => validateSourceWatermarkGeneration(factTamper),
    (error) => error.code === "SOURCE_CERTIFICATE_DIGEST_MISMATCH",
  );

  const aliasTamper = structuredClone(generation);
  aliasTamper.aliasMap.entries[0].candidateUserAliasDigest =
    digest("f");
  assert.throws(
    () => validateSourceWatermarkGeneration(aliasTamper),
    (error) => error.code === "SOURCE_ALIAS_MAP_DIGEST_MISMATCH",
  );

  const manifestTamper = structuredClone(generation);
  manifestTamper.manifestDigest = digest("f");
  assert.throws(
    () => validateSourceWatermarkGeneration(manifestTamper),
    (error) => error.code === "SOURCE_WATERMARK_MANIFEST_MISMATCH",
  );

  const recordTamper = structuredClone(generation);
  recordTamper.recordDigest = digest("f");
  assert.throws(
    () => validateSourceWatermarkGeneration(recordTamper),
    (error) => error.code === "SOURCE_WATERMARK_RECORD_MISMATCH",
  );
});

test("combined manifest is deterministic across source fact order", () => {
  const recallFacts = [
    recallSuccess(),
    recallSuccess({
      candidate: CANDIDATE_B,
      record: RECORD_RECALL_B,
    }),
  ];
  const humanFacts = [
    humanSuccess(),
    humanSuccess({
      candidateUser: CANDIDATE_USER_B,
      record: RECORD_HUMAN_B,
    }),
  ];
  const aliasEntries = [
    {
      canonicalCandidateDigest: CANDIDATE_A,
      candidateUserAliasDigest: CANDIDATE_USER_A,
    },
    {
      canonicalCandidateDigest: CANDIDATE_B,
      candidateUserAliasDigest: CANDIDATE_USER_B,
    },
  ];
  const first = generationFixture({
    recallFacts,
    humanFacts,
    aliasEntries,
  });
  const second = generationFixture({
    recallFacts: [...recallFacts].reverse(),
    humanFacts: [...humanFacts].reverse(),
    aliasEntries: [...aliasEntries].reverse(),
  });
  assert.equal(first.manifestDigest, second.manifestDigest);
  assert.equal(
    first.q37.decisionSetDigest,
    second.q37.decisionSetDigest,
  );
});

test("both sources must use the exact common decision boundary", () => {
  const otherBoundary = "2026-07-25T23:59:00.000Z";
  const humanFacts = [humanSuccess({
    endedAt: "2026-07-25T21:00:00.000Z",
  })];
  const mismatchedHuman = certificateFixture(
    SOURCE_WATERMARK_SOURCES.PARAFORM_HUMAN,
    humanFacts,
    { decisionBoundaryAt: otherBoundary },
  );
  assert.throws(
    () => generationFixture({
      humanFacts,
      humanCertificate: mismatchedHuman,
    }),
    (error) => (
      error instanceof SourceWatermarkInvariantError
      && error.code === "SOURCE_BOUNDARY_MISMATCH"
    ),
  );
});

test("missing canonical alias coverage keeps a planned generation incomplete", () => {
  const generation = generationFixture({
    recallFacts: [recallSuccess({
      candidate: CANDIDATE_B,
    })],
  });
  assert.equal(generation.intrinsicSourceComplete, false);
  assert.equal(generation.intrinsicQ37Ready, false);
  assert.equal(generation.q37.identityIssueCount, 1);
});

test("an incomplete source or ambiguous Q37 generation cannot be committed", () => {
  const pending = {
    source: SOURCE_WATERMARK_SOURCES.RECALL,
    recordDigest: RECORD_RECALL_A,
    classification: "pending",
    identityStatus: "unresolved",
    endedAt: null,
    provenanceVerified: false,
  };
  assert.throws(
    () => generationFixture({
      status: "committed",
      recallFacts: [pending],
    }),
    (error) => (
      error instanceof SourceWatermarkInvariantError
      && error.code === "SOURCE_WATERMARK_COMMIT_NOT_READY"
    ),
  );
  assert.throws(
    () => generationFixture({
      status: "committed",
      recallFacts: [recallSuccess({
        endedAt: "2026-07-25T21:00:00.000Z",
      })],
      humanFacts: [humanSuccess({
        endedAt: "2026-07-25T21:00:00.000Z",
      })],
    }),
    (error) => (
      error instanceof SourceWatermarkInvariantError
      && error.code === "SOURCE_WATERMARK_COMMIT_NOT_READY"
    ),
  );
});

test("commit metadata is state-bound and cannot predate the stable capture", () => {
  assert.throws(
    () => generationFixture({
      committedAt: COMMITTED_AT,
      commitRevisionDigest: COMMIT_REVISION,
    }),
    /planned generations cannot carry commit metadata/,
  );
  assert.throws(
    () => generationFixture({
      status: "committed",
      committedAt: "2026-07-26T00:03:30.000Z",
    }),
    (error) => (
      error.code === "SOURCE_WATERMARK_COMMIT_PREDATES_CAPTURE"
    ),
  );
});

test("public readiness is false without a committed current generation", () => {
  const empty = sourceWatermarkPublicStatus();
  const planned = sourceWatermarkPublicStatus({
    generation: generationFixture(),
    currentManifestDigest: digest("f"),
    currentSourceEpochs: currentEpochs(),
  });
  assert.equal(empty.status, "not_committed");
  assert.equal(empty.sourceWatermarkComplete, false);
  assert.equal(empty.phase4Q37Ready, false);
  assert.equal(planned.status, "not_committed");
  assert.equal(planned.sourceWatermarkComplete, false);
  assert.equal(planned.phase4Q37Ready, false);
});

test("public readiness requires committed manifest and both current source epochs", () => {
  const generation = generationFixture({ status: "committed" });
  const ready = sourceWatermarkPublicStatus({
    generation,
    currentManifestDigest: generation.manifestDigest,
    currentSourceEpochs: currentEpochs(),
  });
  const staleManifest = sourceWatermarkPublicStatus({
    generation,
    currentManifestDigest: digest("f"),
    currentSourceEpochs: currentEpochs(),
  });
  const staleEpoch = sourceWatermarkPublicStatus({
    generation,
    currentManifestDigest: generation.manifestDigest,
    currentSourceEpochs: currentEpochs({
      paraformHuman: digest("f"),
    }),
  });
  assert.equal(ready.status, "ready");
  assert.equal(ready.sourceWatermarkComplete, true);
  assert.equal(ready.phase4Q37Ready, true);
  assert.equal(staleManifest.status, "stale");
  assert.equal(staleManifest.phase4Q37Ready, false);
  assert.equal(staleEpoch.status, "stale");
  assert.equal(staleEpoch.phase4Q37Ready, false);
  const malformedCurrent = sourceWatermarkPublicStatus({
    generation,
    currentManifestDigest: "not-a-digest",
    currentSourceEpochs: currentEpochs(),
  });
  assert.equal(malformedCurrent.status, "stale");
  assert.equal(malformedCurrent.phase4Q37Ready, false);
});

test("public readiness is aggregate-only and strips all source and identity digests", () => {
  const generation = generationFixture({ status: "committed" });
  const status = sourceWatermarkPublicStatus({
    generation,
    currentManifestDigest: generation.manifestDigest,
    currentSourceEpochs: currentEpochs(),
  });
  const serialized = JSON.stringify(status);
  for (const privateDigest of [
    CANDIDATE_A,
    CANDIDATE_USER_A,
    RECORD_RECALL_A,
    RECORD_HUMAN_A,
    RECALL_EPOCH,
    PARAFORM_EPOCH,
    ALIAS_EPOCH,
  ]) {
    assert.equal(serialized.includes(privateDigest), false);
  }
  assert.equal("decisions" in status.q37, false);
  assert.equal("entries" in status.aliases, false);
  assert.equal("passes" in status.sources.recall, false);
});

test("invalid persisted generation fails closed in public status", () => {
  const generation = structuredClone(
    generationFixture({ status: "committed" }),
  );
  generation.manifestDigest = digest("f");
  const status = sourceWatermarkPublicStatus({
    generation,
    currentManifestDigest: digest("f"),
    currentSourceEpochs: currentEpochs(),
  });
  assert.equal(status.status, "invalid");
  assert.equal(status.sourceWatermarkComplete, false);
  assert.equal(status.phase4Q37Ready, false);
});

test("write attestation binds manifest, alias, Q37, job revision, and write scope", () => {
  const generation = generationFixture({ status: "committed" });
  const attestation = buildPhase4WriteBoundaryAttestation({
    generation,
    canonicalCandidateDigest: CANDIDATE_A,
    candidateUserAliasDigest: CANDIDATE_USER_A,
    jobRevisionDigest: JOB_REVISION,
    writeScopeDigest: WRITE_SCOPE,
    observedAt: ATTESTED_AT,
  });
  assert.equal(attestation.manifestDigest, generation.manifestDigest);
  assert.equal(attestation.callType, "human");
  assert.equal(
    attestation.q37DecisionDigest,
    generation.q37.decisions[0].decisionDigest,
  );
  assert.equal(attestation.sourceEpochs.recall, RECALL_EPOCH);
  assert.equal(
    attestation.sourceEpochs.paraformHuman,
    PARAFORM_EPOCH,
  );
});

test("atomic write-boundary validator allows only the exact current attestation", () => {
  const generation = generationFixture({ status: "committed" });
  const attestation = buildPhase4WriteBoundaryAttestation({
    generation,
    canonicalCandidateDigest: CANDIDATE_A,
    candidateUserAliasDigest: CANDIDATE_USER_A,
    jobRevisionDigest: JOB_REVISION,
    writeScopeDigest: WRITE_SCOPE,
    observedAt: ATTESTED_AT,
  });
  const result = validatePhase4WriteBoundaryAttestation({
    generation,
    attestation,
    currentManifestDigest: generation.manifestDigest,
    currentSourceEpochs: currentEpochs(),
    expectedCanonicalCandidateDigest: CANDIDATE_A,
    expectedCandidateUserAliasDigest: CANDIDATE_USER_A,
    expectedJobRevisionDigest: JOB_REVISION,
    expectedWriteScopeDigest: WRITE_SCOPE,
    observedAt: VALIDATED_AT,
  });
  assert.equal(result.allowed, true);
  assert.equal(result.callType, "human");
  assert.equal(result.manifestDigest, generation.manifestDigest);
});

test("atomic validator rejects manifest substitution and source epoch drift", () => {
  const generation = generationFixture({ status: "committed" });
  const attestation = buildPhase4WriteBoundaryAttestation({
    generation,
    canonicalCandidateDigest: CANDIDATE_A,
    candidateUserAliasDigest: CANDIDATE_USER_A,
    jobRevisionDigest: JOB_REVISION,
    writeScopeDigest: WRITE_SCOPE,
    observedAt: ATTESTED_AT,
  });
  const base = {
    generation,
    attestation,
    currentManifestDigest: generation.manifestDigest,
    currentSourceEpochs: currentEpochs(),
    expectedCanonicalCandidateDigest: CANDIDATE_A,
    expectedCandidateUserAliasDigest: CANDIDATE_USER_A,
    expectedJobRevisionDigest: JOB_REVISION,
    expectedWriteScopeDigest: WRITE_SCOPE,
    observedAt: VALIDATED_AT,
  };
  assert.throws(
    () => validatePhase4WriteBoundaryAttestation({
      ...base,
      currentManifestDigest: digest("f"),
    }),
    (error) => error.code === "SOURCE_WRITE_GENERATION_STALE",
  );
  assert.throws(
    () => validatePhase4WriteBoundaryAttestation({
      ...base,
      currentSourceEpochs: currentEpochs({
        recall: digest("f"),
      }),
    }),
    (error) => error.code === "SOURCE_WRITE_EPOCH_STALE",
  );
  assert.throws(
    () => validatePhase4WriteBoundaryAttestation({
      ...base,
      currentSourceEpochs: currentEpochs({
        aliases: digest("f"),
      }),
    }),
    (error) => error.code === "SOURCE_WRITE_EPOCH_STALE",
  );
});

test("atomic validator rejects tampering and every expected-boundary mismatch", () => {
  const generation = generationFixture({ status: "committed" });
  const attestation = buildPhase4WriteBoundaryAttestation({
    generation,
    canonicalCandidateDigest: CANDIDATE_A,
    candidateUserAliasDigest: CANDIDATE_USER_A,
    jobRevisionDigest: JOB_REVISION,
    writeScopeDigest: WRITE_SCOPE,
    observedAt: ATTESTED_AT,
  });
  const base = {
    generation,
    attestation,
    currentManifestDigest: generation.manifestDigest,
    currentSourceEpochs: currentEpochs(),
    expectedCanonicalCandidateDigest: CANDIDATE_A,
    expectedCandidateUserAliasDigest: CANDIDATE_USER_A,
    expectedJobRevisionDigest: JOB_REVISION,
    expectedWriteScopeDigest: WRITE_SCOPE,
    observedAt: VALIDATED_AT,
  };
  const tampered = structuredClone(attestation);
  tampered.jobRevisionDigest = digest("f");
  assert.throws(
    () => validatePhase4WriteBoundaryAttestation({
      ...base,
      attestation: tampered,
    }),
    (error) => error.code === "SOURCE_WRITE_ATTESTATION_TAMPERED",
  );
  const tamperedDerivedField = structuredClone(attestation);
  tamperedDerivedField.callType = "agent";
  assert.throws(
    () => validatePhase4WriteBoundaryAttestation({
      ...base,
      attestation: tamperedDerivedField,
    }),
    (error) => error.code === "SOURCE_WRITE_ATTESTATION_TAMPERED",
  );
  for (const [field, value] of [
    ["expectedCanonicalCandidateDigest", CANDIDATE_C],
    ["expectedCandidateUserAliasDigest", digest("f")],
    ["expectedJobRevisionDigest", digest("f")],
    ["expectedWriteScopeDigest", digest("f")],
  ]) {
    assert.throws(
      () => validatePhase4WriteBoundaryAttestation({
        ...base,
        [field]: value,
      }),
      (error) => error.code === "SOURCE_WRITE_EXPECTATION_MISMATCH",
    );
  }
  assert.throws(
    () => validatePhase4WriteBoundaryAttestation({
      ...base,
      observedAt: "2026-07-26T00:06:30.000Z",
    }),
    (error) => (
      error.code === "SOURCE_WRITE_ATTESTATION_FROM_FUTURE"
    ),
  );
});

test("attestation rejects unknown aliases and candidates without a successful call", () => {
  const noSuccessGeneration = generationFixture({
    status: "committed",
    recallFacts: [{
      ...recallSuccess(),
      classification: "failure",
    }],
    humanFacts: [{
      ...humanSuccess(),
      classification: "failure",
    }],
  });
  assert.throws(
    () => buildPhase4WriteBoundaryAttestation({
      generation: noSuccessGeneration,
      canonicalCandidateDigest: CANDIDATE_A,
      candidateUserAliasDigest: CANDIDATE_USER_A,
      jobRevisionDigest: JOB_REVISION,
      writeScopeDigest: WRITE_SCOPE,
      observedAt: ATTESTED_AT,
    }),
    (error) => (
      error.code === "SOURCE_ATTESTATION_Q37_NOT_SELECTED"
    ),
  );
  const generation = generationFixture({ status: "committed" });
  assert.throws(
    () => buildPhase4WriteBoundaryAttestation({
      generation,
      canonicalCandidateDigest: CANDIDATE_A,
      candidateUserAliasDigest: digest("f"),
      jobRevisionDigest: JOB_REVISION,
      writeScopeDigest: WRITE_SCOPE,
      observedAt: ATTESTED_AT,
    }),
    (error) => error.code === "SOURCE_ATTESTATION_ALIAS_MISMATCH",
  );
});

test("dashboard health exposes only aggregate dark readiness and keeps enrollment closed", async () => {
  const source = await readFile(
    new URL("../api/paraai/health.mjs", import.meta.url),
    "utf8",
  );
  assert.match(
    source,
    /sourceWatermarkPublicStatus\(\)/,
  );
  assert.match(
    source,
    /sourceWatermarkComplete:\s*sourceWatermark\.sourceWatermarkComplete/,
  );
  assert.match(
    source,
    /phase4Q37Ready:\s*sourceWatermark\.phase4Q37Ready/,
  );
  const enrollment = source.slice(
    source.indexOf("health.enrollmentReady = Boolean("),
    source.indexOf("health.automation.ready = Boolean("),
  );
  assert.match(enrollment, /health\.phase4Q37Ready/);
});

test("policy module stays capture-independent and contains no identifier-shaped public fields", () => {
  const status = sourceWatermarkPublicStatus();
  assert.equal(
    status.policyVersion,
    SOURCE_WATERMARK_POLICY_VERSION,
  );
  assert.deepEqual(
    Object.keys(status).sort(),
    [
      "aliases",
      "committed",
      "current",
      "decisionBoundaryAt",
      "manifestDigest",
      "phase4Q37Ready",
      "policyVersion",
      "q37",
      "sourceWatermarkComplete",
      "sources",
      "status",
    ].sort(),
  );
});
