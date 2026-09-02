import assert from "node:assert/strict";
import test from "node:test";

import {
  assertGenerationReady,
  normalizeSourceBundle,
  sha256,
} from "../api/submissions-v2/_lib/resume/source-bundle.mjs";
import { extractCandidateEvidenceClaims } from "../api/submissions-v2/_lib/resume/claim-extractor.mjs";
import {
  assertDraftClaimsGrounded,
  buildEvidenceLedger,
} from "../api/submissions-v2/_lib/resume/evidence-ledger.mjs";

const originalBytes = Buffer.from("%PDF-1.7\nJane Doe resume", "utf8");

function sources(overrides = {}) {
  const rows = {
    candidate_original_resume: {
      key: "candidate_original_resume",
      status: "present",
      origin: "origin_unverified",
      sourceId: "resume-1",
      locator: "paraform:resume/resume-1",
      capturedAt: "2026-08-31T18:00:00.000Z",
      content: originalBytes,
      normalizedText: "Jane Doe\nEngineer at Alpha\nBuilt a scheduling system used by 20 teams.",
      metadata: { readable: true },
    },
    candidate_call: {
      key: "candidate_call",
      status: "present",
      origin: "candidate_original",
      sourceId: "call-1",
      locator: "paraform:call/call-1#turn-8",
      capturedAt: "2026-08-31T18:00:00.000Z",
      text: "Jane: My title is Staff Engineer at Alpha. I led the scheduling migration.",
      metadata: {},
    },
    candidate_linkedin: {
      key: "candidate_linkedin",
      status: "stale",
      origin: "candidate_original",
      sourceId: "linkedin-1",
      locator: "paraform:linkedin/linkedin-1",
      capturedAt: "2026-08-31T18:00:00.000Z",
      text: "Engineer at Alpha",
      accuracyImpact: "Recent work may be absent.",
      remediation: "Refresh the cached LinkedIn profile.",
      metadata: {},
    },
    candidate_preferences: {
      key: "candidate_preferences",
      status: "missing",
      origin: "not_applicable",
      sourceId: "prefs-1",
      locator: "paraform:preferences/prefs-1",
      capturedAt: "2026-08-31T18:00:00.000Z",
      accuracyImpact: "Current preferences are unavailable.",
      remediation: "Ask the candidate if needed.",
      metadata: { readOutcome: "confirmed_empty" },
    },
    recruiter_supplements: {
      key: "recruiter_supplements",
      status: "missing",
      origin: "not_applicable",
      sourceId: "supplements-1",
      locator: "submissions-v2:pair/candidate-1/role-1/supplements",
      capturedAt: "2026-08-31T18:00:00.000Z",
      metadata: { readOutcome: "confirmed_empty" },
    },
    role_record: {
      key: "role_record",
      status: "present",
      origin: "not_applicable",
      sourceId: "role-1",
      locator: "paraform:role/role-1",
      capturedAt: "2026-08-31T18:00:00.000Z",
      text: "Product Engineer at Client Co",
      metadata: {},
    },
    role_context: {
      key: "role_context",
      status: "present",
      origin: "not_applicable",
      sourceId: "role-1",
      locator: "paraform:role/role-1/context",
      capturedAt: "2026-08-31T18:00:00.000Z",
      text: "The client wants TypeScript and healthcare experience.",
      metadata: {},
    },
    company_context: {
      key: "company_context",
      status: "present",
      origin: "not_applicable",
      sourceId: "company-1",
      locator: "paraform:company/company-1",
      capturedAt: "2026-08-31T18:00:00.000Z",
      text: "Client Co builds healthcare software.",
      metadata: {},
    },
    role_intake: {
      key: "role_intake",
      status: "partial",
      origin: "not_applicable",
      sourceId: "intake-1",
      locator: "paraform:intake/intake-1#summary",
      capturedAt: "2026-08-31T18:00:00.000Z",
      text: "Summary fallback: strong product judgment matters.",
      accuracyImpact: "Nuance may be absent because only a summary was available.",
      remediation: "Recover the full intake transcript when possible.",
      metadata: { summaryFallback: true },
    },
  };
  for (const [key, value] of Object.entries(overrides)) rows[key] = { ...rows[key], ...value };
  return Object.values(rows);
}

function bundle(overrides = {}, options = {}) {
  return normalizeSourceBundle({
    candidateUserId: "candidate-1",
    roleId: "role-1",
    sources: sources(overrides),
    capturedAt: "2026-08-31T18:00:00.000Z",
    ...options,
  });
}

test("candidate-original resume is the sole missing-source generation blocker", () => {
  const ready = bundle();
  assert.equal(ready.readiness.canGenerate, true);
  assert.deepEqual(ready.readiness.cautions.map((item) => item.sourceKey), [
    "candidate_linkedin",
    "candidate_preferences",
    "role_intake",
  ]);
  assert.equal(assertGenerationReady(ready), ready);

  const blocked = bundle({
    candidate_original_resume: {
      status: "missing",
      content: null,
      normalizedText: "",
      metadata: { readOutcome: "confirmed_empty" },
    },
  });
  assert.equal(blocked.readiness.canGenerate, false);
  assert.throws(() => assertGenerationReady(blocked), (error) => error.code === "CANDIDATE_ORIGINAL_RESUME_REQUIRED");
});

test("Raydar artifact digest can never clear original-resume provenance", () => {
  const result = bundle({}, { knownRaydarDigests: [sha256(originalBytes)] });
  const resume = result.sources.find((item) => item.key === "candidate_original_resume");
  assert.equal(resume.origin, "raydar_generated");
  assert.equal(result.readiness.canGenerate, false);
});

test("collector omissions and failed reads mislabeled missing fail closed", () => {
  const missingOne = sources().filter((item) => item.key !== "candidate_preferences");
  assert.throws(
    () => normalizeSourceBundle({ candidateUserId: "candidate-1", roleId: "role-1", sources: missingOne }),
    (error) => error.code === "SOURCE_READ_OUTCOME_MISSING",
  );
  assert.throws(
    () => bundle({ candidate_preferences: { status: "missing", error: "timeout", metadata: { readFailed: true } } }),
    (error) => error.code === "FAILED_READ_MISLABELED_MISSING",
  );
});

test("evidence ledger requires local exact quotes and bars client context from candidate claims", () => {
  const ready = bundle();
  assert.throws(
    () => buildEvidenceLedger(ready, [{
      claimType: "skill",
      subject: "TypeScript",
      value: "Uses TypeScript",
      sourceKey: "role_context",
      quote: "TypeScript",
      locator: "paraform:role/role-1/context",
    }]),
    (error) => error.code === "CLIENT_CONTEXT_CANNOT_PROVE_CLAIM",
  );
  assert.throws(
    () => buildEvidenceLedger(ready, [{
      claimType: "achievement",
      subject: "Scheduling system",
      value: "Used by 50 teams",
      sourceKey: "candidate_original_resume",
      quote: "used by 50 teams",
      locator: "paraform:resume/resume-1#page-1",
    }]),
    (error) => error.code === "EVIDENCE_QUOTE_NOT_FOUND",
  );
});

test("claim conflicts retain both facts and select the highest trusted source", () => {
  const ledger = buildEvidenceLedger(bundle(), [
    {
      claimId: "title-resume",
      claimType: "title",
      subject: "Alpha title",
      value: "Engineer",
      sourceKey: "candidate_original_resume",
      quote: "Engineer at Alpha",
      locator: "paraform:resume/resume-1#page-1",
    },
    {
      claimId: "title-call",
      claimType: "title",
      subject: "Alpha title",
      value: "Staff Engineer",
      sourceKey: "candidate_call",
      quote: "Staff Engineer at Alpha",
      locator: "paraform:call/call-1#turn-8",
    },
  ]);
  assert.equal(ledger.claims.length, 2);
  assert.equal(ledger.clusters[0].hasConflict, true);
  assert.equal(ledger.clusters[0].selectedClaimId, "title-resume");
  assert.equal(ledger.clusters[0].selectionReason, "highest_applicable_trusted_source");
});

test("every draft claim must map to exact ledger evidence", () => {
  const ledger = buildEvidenceLedger(bundle(), [{
    claimId: "achievement",
    claimType: "achievement",
    subject: "Scheduling system",
    value: "Used by 20 teams",
    sourceKey: "candidate_original_resume",
    quote: "Built a scheduling system used by 20 teams.",
    locator: "paraform:resume/resume-1#page-1",
  }]);
  const evidenceId = ledger.claims[0].evidenceId;
  assert.deepEqual(assertDraftClaimsGrounded([{ id: "bullet-1", text: "Built a scheduling system used by 20 teams.", evidenceIds: [evidenceId] }], ledger)[0].evidenceIds, [evidenceId]);
  assert.throws(
    () => assertDraftClaimsGrounded([{ id: "bullet-1", text: "Claim", evidenceIds: ["unknown"] }], ledger),
    (error) => error.code === "DRAFT_EVIDENCE_UNKNOWN",
  );
});

test("deterministic extraction creates bounded exact candidate evidence claims and excludes client context", () => {
  const ready = bundle();
  const first = extractCandidateEvidenceClaims(ready);
  const second = extractCandidateEvidenceClaims(ready);
  assert.deepEqual(first, second);
  assert.ok(first.length >= 4);
  assert.equal(first.some((claim) => claim.quote.includes("client wants TypeScript")), false);
  for (const claim of first) {
    const source = ready.sources.find((item) => item.key === claim.sourceKey);
    assert.ok(source.normalizedText.includes(claim.quote));
    assert.match(claim.locator, /#evidence-span-\d+$/u);
  }
  const ledger = buildEvidenceLedger(ready, first);
  assert.equal(ledger.claims.length, first.length);
});

test("deterministic extraction fails closed instead of silently truncating evidence", () => {
  const ready = bundle({
    candidate_call: {
      text: Array.from({ length: 120 }, (_, index) => `Candidate fact ${index}.`).join(" "),
    },
  });
  assert.throws(
    () => extractCandidateEvidenceClaims(ready, { maxTotalSpans: 100 }),
    (error) => error.code === "EVIDENCE_SPAN_LIMIT_EXCEEDED",
  );
});
