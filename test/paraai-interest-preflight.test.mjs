import test from "node:test";
import assert from "node:assert/strict";

import {
  candidateTranscriptText,
  classifyCompanyInterest,
  classifyWorkplaceCommitment,
  countAiNegativeMarks,
  evaluateSubmissionEvidence,
  runSubmissionEvidencePreflight,
} from "../api/paraai/_lib/interest-preflight.mjs";
import {
  preflightSubmission,
  submitToRole,
} from "../api/paraai/_lib/interest.mjs";

const NOW = Date.parse("2026-07-29T16:00:00Z");

function meeting({ at = "2026-07-20T16:00:00Z", words = [] } = {}) {
  return {
    event_scheduled_at: at,
    recording_transcript: [{
      speaker: "Candidate",
      words: words.map((text) => ({ text })),
    }],
  };
}

function greenEvidence(overrides = {}) {
  return {
    role: {
      status: "ACTIVE",
      active_status: "Go live",
      company: { name: "Acme Labs" },
      requirements: [],
      rejection_categories: [],
    },
    experience: { jobHopper: false, average_tenure: { months: 36 } },
    insights: null,
    calibration: {
      requirement_items: [
        { evaluation: "GOOD_FIT" },
        { evaluation: "MAYBE" },
      ],
    },
    preferences: { visa: ["Not available"] },
    meetings: [meeting({ words: ["I'm", "excited", "about", "Acme", "Labs"] })],
    now: NOW,
    ...overrides,
  };
}

test("company interest requires an explicit positive signal near the company", () => {
  assert.deepEqual(
    classifyCompanyInterest("Acme Labs came up on the call.", "Acme Labs"),
    { mentioned: true, confirmed: false, contradicted: false },
  );
  assert.equal(
    classifyCompanyInterest("I'm excited about Acme Labs.", "Acme Labs").confirmed,
    true,
  );
});

test("a company-specific objection overrides positive language", () => {
  const result = classifyCompanyInterest(
    "Acme Labs sounds interesting, but I ranked Acme Labs last because I'm not a fan.",
    "Acme Labs",
  );
  assert.equal(result.contradicted, true);
  assert.equal(result.confirmed, false);
});

test("the APPLIED_TO_ROLE trigger confirms intent but never overrides contradiction", () => {
  const direct = evaluateSubmissionEvidence(greenEvidence({
    directInterestConfirmed: true,
    meetings: [meeting({ words: ["The", "screen", "was", "helpful"] })],
  }));
  assert.equal(direct.ok, true);
  assert.equal(direct.signals.companyInterestSatisfied, true);
  assert.equal(direct.signals.directInterestConfirmed, true);

  const withoutDirect = evaluateSubmissionEvidence(greenEvidence({
    directInterestConfirmed: false,
    meetings: [meeting({ words: ["The", "screen", "was", "helpful"] })],
  }));
  assert.ok(withoutDirect.blockers.includes("company_interest_unconfirmed"));

  const contradicted = evaluateSubmissionEvidence(greenEvidence({
    directInterestConfirmed: true,
    meetings: [meeting({
      words: ["I", "ranked", "Acme", "Labs", "last", "because", "I'm", "not", "a", "fan"],
    })],
  }));
  assert.ok(contradicted.blockers.includes("company_interest_contradicted"));
});

test("recruiter speech cannot confirm candidate company interest", () => {
  const transcript = [
    {
      speaker: "Recruiter",
      words: [{ text: "I'm excited about Acme Labs and think it sounds great." }],
    },
    {
      speaker: "Candidate",
      words: [{ text: "Thanks for walking me through the role." }],
    },
  ];
  const candidateOnly = candidateTranscriptText(transcript, "Taylor Example");
  assert.equal(candidateOnly, "Thanks for walking me through the role.");

  const result = evaluateSubmissionEvidence(greenEvidence({
    meetings: [{
      event_scheduled_at: "2026-07-20T16:00:00Z",
      recording_transcript: transcript,
    }],
  }));
  assert.equal(result.ok, false);
  assert.ok(result.blockers.includes("company_interest_unconfirmed"));
});

test("opaque speakers require candidate self-identification", () => {
  const transcript = [
    { speaker: "1", text: "I'm excited about Acme Labs." },
    { speaker: "2", text: "Hi, this is Taylor. Acme Labs sounds great." },
  ];
  assert.equal(
    candidateTranscriptText(transcript, "Taylor Example"),
    "Hi, this is Taylor. Acme Labs sounds great.",
  );
  assert.equal(candidateTranscriptText(transcript), "");
});

test("explicit workplace commitment is distinct from recruiter description", () => {
  assert.deepEqual(
    classifyWorkplaceCommitment("I'm open to a hybrid schedule and commuting to the office."),
    { confirmed: true, contradicted: false },
  );
  assert.deepEqual(
    classifyWorkplaceCommitment("I am only considering fully remote roles."),
    { confirmed: false, contradicted: true },
  );

  const unconfirmed = evaluateSubmissionEvidence(greenEvidence({
    role: {
      status: "ACTIVE",
      active_status: "Go live",
      company: { name: "Acme Labs" },
      workplaceType: "HYBRID",
      requirements: [],
      rejection_categories: [],
    },
  }));
  assert.ok(unconfirmed.blockers.includes("onsite_commitment_unconfirmed"));
});

test("stored workplace preference satisfies logistics unless the transcript contradicts it", () => {
  const roleWithOffice = {
    status: "ACTIVE",
    active_status: "Go live",
    company: { name: "Acme Labs" },
    workplaceType: "ON_SITE",
    requirements: [],
    rejection_categories: [],
  };
  const confirmed = evaluateSubmissionEvidence(greenEvidence({
    role: roleWithOffice,
    preferences: { visa: ["Not available"], workplace: ["ON_SITE"] },
    meetings: [meeting({ words: ["I'm", "excited", "about", "Acme", "Labs"] })],
  }));
  assert.equal(confirmed.ok, true);
  assert.equal(confirmed.signals.workplacePreferenceConfirmed, true);

  const contradicted = evaluateSubmissionEvidence(greenEvidence({
    role: roleWithOffice,
    preferences: { visa: ["Not available"], workplace: ["ON_SITE"] },
    meetings: [meeting({
      words: ["I'm", "excited", "about", "Acme", "Labs", "but", "I", "am", "only", "considering", "fully", "remote", "roles"],
    })],
  }));
  assert.ok(contradicted.blockers.includes("onsite_commitment_contradicted"));
});

test("AI BAD_FIT is the negative mark counted by the playbook correction", () => {
  assert.equal(countAiNegativeMarks({
    requirement_items: [
      { evaluation: "GOOD_FIT" },
      { evaluation: "BAD_FIT" },
      { evaluation: "MAYBE" },
      { evaluation: "BAD_FIT" },
      { evaluation: "NO" },
    ],
  }), 3);
});

test("clean recent evidence passes Step 0", () => {
  const result = evaluateSubmissionEvidence(greenEvidence());
  assert.equal(result.ok, true);
  assert.deepEqual(result.blockers, []);
  assert.equal(result.signals.companyInterestConfirmed, true);
});

test("known high-risk pattern is held before a credit is spent", () => {
  const result = evaluateSubmissionEvidence(greenEvidence({
    role: {
      status: "ACTIVE",
      active_status: "Go live",
      company: { name: "Acme Labs" },
      rejection_categories: ["Job hopping or inconsistent career history."],
      requirements: [],
    },
    experience: { jobHopper: true, average_tenure: { months: 19 } },
    calibration: {
      requirement_items: Array.from({ length: 4 }, () => ({ evaluation: "BAD_FIT" })),
    },
    meetings: [meeting({
      at: "2025-09-03T18:00:00Z",
      words: ["I", "ranked", "Acme", "Labs", "last", "and", "I'm", "not", "a", "fan"],
    })],
  }));

  assert.equal(result.ok, false);
  assert.ok(result.blockers.includes("job_hopper_role_conflict"));
  assert.ok(result.blockers.includes("ai_calibration_three_plus_negative"));
  assert.ok(result.blockers.includes("screen_transcript_stale"));
  assert.ok(result.blockers.includes("company_interest_unconfirmed"));
});

test("tenure and current-employer stage are evaluated against role avoid rules", () => {
  const result = evaluateSubmissionEvidence(greenEvidence({
    role: {
      status: "ACTIVE",
      active_status: "Go live",
      company: { name: "Acme Labs" },
      rejection_categories: [
        "Short tenure is a rejection reason.",
        "Must have startup experience; avoid public companies.",
      ],
      requirements: [],
    },
    experience: {
      jobHopper: false,
      average_tenure: { months: 14 },
      role_count: 4,
      current_employer_stage: "PUBLIC",
    },
  }));
  assert.ok(result.blockers.includes("short_tenure_role_conflict"));
  assert.ok(result.blockers.includes("current_employer_stage_role_conflict"));
  assert.equal(result.signals.averageTenureMonths, 14);
  assert.equal(result.signals.roleCount, 4);
  assert.equal(result.signals.currentEmployerStageAvailable, true);
});

test("composite tenure objects add years and months", () => {
  const result = evaluateSubmissionEvidence(greenEvidence({
    experience: {
      jobHopper: false,
      average_tenure: { years: 2, months: 5 },
      current_tenure: { years: 1, months: 3 },
    },
  }));
  assert.equal(result.signals.averageTenureMonths, 29);
  assert.equal(result.signals.currentTenureMonths, 15);
});

test("visa status is checked against the role's actual sponsorship text", () => {
  const conflict = evaluateSubmissionEvidence(greenEvidence({
    role: {
      status: "ACTIVE",
      active_status: "Go live",
      company: { name: "Acme Labs" },
      visa_text: "We cannot sponsor visas for this role.",
      requirements: [],
      rejection_categories: [],
    },
    preferences: { visa: ["Requires visa transfer"] },
  }));
  assert.ok(conflict.blockers.includes("visa_sponsorship_role_conflict"));
  assert.equal(conflict.signals.needsSponsorship, true);

  const unknown = evaluateSubmissionEvidence(greenEvidence({
    role: {
      status: "ACTIVE",
      active_status: "Go live",
      company: { name: "Acme Labs" },
      visa_text: "Sponsorship is not available.",
      requirements: [],
      rejection_categories: [],
    },
    preferences: { visa: [] },
  }));
  assert.ok(unknown.blockers.includes("visa_status_unconfirmed_for_restricted_role"));
});

test("native no-visa authorization is never misclassified by the word visa", () => {
  const result = evaluateSubmissionEvidence(greenEvidence({
    role: {
      status: "ACTIVE",
      company_name: "Acme Labs",
      visa_text: "Sponsorship is not available.",
      requirements: [],
      rejection_categories: [],
    },
    preferences: {
      visa: [],
      visa_authorization: "NO_VISA_AUTHORIZATION_NEEDED",
    },
  }));
  assert.equal(result.signals.needsSponsorship, false);
  assert.ok(!result.blockers.includes("visa_sponsorship_role_conflict"));
  assert.ok(!result.blockers.includes("visa_status_unconfirmed_for_restricted_role"));
  assert.equal(result.signals.companyInterestConfirmed, true);
});

test("competing process and closed-role signals fail closed", () => {
  const result = evaluateSubmissionEvidence(greenEvidence({
    role: {
      status: "CLOSED",
      company: { name: "Acme Labs" },
      requirements: [],
      rejection_categories: [],
    },
    insights: {
      insight_type: ["COMPETING_PROCESS"],
      insight_text: ["Candidate is in a late-stage process."],
    },
  }));
  assert.equal(result.ok, false);
  assert.ok(result.blockers.includes("role_not_open"));
  assert.ok(result.blockers.includes("competing_process_requires_review"));
});

test("read failures become durable reason codes without leaking provider text", async () => {
  const calls = [];
  const trpcGetImpl = async (proc) => {
    calls.push(proc);
    if (proc === "role.getRoleByIdSimple") throw new Error("candidate-specific provider detail");
    if (proc === "candidates.getCandidateExperienceStats") return { jobHopper: false };
    if (proc === "candidates.getCandidateInsights") return null;
    if (proc === "aiCalibrations.getAiCalibration") return null;
    if (proc === "candidateUserMeeting.getSelectableMeetingsForCandidateUserId") return [];
    if (proc === "candidateUserPreference.getCandidateUserPrefs") return { visa: [] };
    throw new Error(`unexpected ${proc}`);
  };

  const result = await runSubmissionEvidencePreflight({
    candidate: { candidateId: "candidate-1", candidateUserId: "candidate-user-1" },
    roleId: "role-1",
    trpcGetImpl,
    now: NOW,
  });

  assert.equal(calls.length, 6);
  assert.ok(result.blockers.includes("preflight_read_failed_role"));
  assert.ok(!JSON.stringify(result).includes("candidate-specific provider detail"));
});

function passingTrpcRead(proc) {
  if (proc === "candidateUserPreference.hasUserInputPreferences") {
    return { hasAllRequired: true };
  }
  if (proc === "role.getRoleByIdSimple") {
    return {
      status: "ACTIVE",
      active_status: "Go live",
      company: { name: "Acme Labs" },
      requirements: [],
      rejection_categories: [],
    };
  }
  if (proc === "candidates.getCandidateExperienceStats") return { jobHopper: false };
  if (proc === "candidates.getCandidateInsights") return null;
  if (proc === "aiCalibrations.getAiCalibration") {
    return { requirement_items: [{ evaluation: "GOOD_FIT" }] };
  }
  if (proc === "candidateUserMeeting.getSelectableMeetingsForCandidateUserId") {
    return [meeting({ words: ["I'm", "excited", "about", "Acme", "Labs"] })];
  }
  if (proc === "candidateUserPreference.getCandidateUserPrefs") {
    return { visa: ["Not available"] };
  }
  throw new Error(`unexpected read ${proc}`);
}

const candidate = {
  candidateUserId: "candidate-user-1",
  candidateId: "candidate-1",
  name: "Taylor Example",
  email: "taylor@example.com",
};

test("the integrated preflight requires readable credits and evidence", async () => {
  const withoutCredits = await preflightSubmission({
    candidate,
    roleId: "role-1",
    credits: null,
    trpcGetImpl: passingTrpcRead,
    now: NOW,
  });
  assert.equal(withoutCredits.ok, false);
  assert.ok(withoutCredits.blockers.includes("credits_unavailable"));

  const withCredits = await preflightSubmission({
    candidate,
    roleId: "role-1",
    credits: { allowance: 10, earnedBack: 0, usedThisWeek: 2, available: 8 },
    trpcGetImpl: passingTrpcRead,
    now: NOW,
  });
  assert.equal(withCredits.ok, true);
  assert.deepEqual(withCredits.blockers, []);
});

test("integrated preflight cannot pass an empty preference profile", async () => {
  let requiredFields = null;
  const trpcGetImpl = async (proc, input) => {
    if (proc === "candidateUserPreference.hasUserInputPreferences") {
      requiredFields = input.required_fields;
      return {
        hasAllRequired: false,
        missingFields: [...input.required_fields],
      };
    }
    return passingTrpcRead(proc, input);
  };
  const result = await preflightSubmission({
    candidate,
    roleId: "role-1",
    credits: { allowance: 10, earnedBack: 0, usedThisWeek: 2, available: 8 },
    trpcGetImpl,
    now: NOW,
  });
  assert.equal(result.ok, false);
  assert.ok(result.blockers.includes("preferences_incomplete"));
  assert.deepEqual(requiredFields, [
    "locations",
    "salary_min",
    "workplace",
    "last_funding_round",
    "visa",
  ]);
});

test("integrated preflight fails closed when preference read returns null", async () => {
  const trpcGetImpl = async (proc, input) => {
    if (proc === "candidateUserPreference.hasUserInputPreferences") return null;
    return passingTrpcRead(proc, input);
  };
  const result = await preflightSubmission({
    candidate,
    roleId: "role-1",
    credits: { allowance: 10, earnedBack: 0, usedThisWeek: 2, available: 8 },
    trpcGetImpl,
    now: NOW,
  });
  assert.equal(result.ok, false);
  assert.ok(result.blockers.includes("preferences_incomplete"));
});

test("shadow submit records would-submit without taking a permanent claim", async () => {
  const result = await submitToRole({
    candidate,
    roleId: "role-1",
    apply: false,
    credits: { allowance: 10, earnedBack: 0, usedThisWeek: 2, available: 8 },
    trpcGetImpl: passingTrpcRead,
    submissionDraftBuilder: async () => ({
      ok: true,
      blockers: [],
      draft: { greatFitReason: "grounded draft" },
      signals: { nonGreenMarks: 0 },
    }),
    now: NOW,
  });
  assert.equal(result.stage, "would_submit");
  assert.equal(result.preflight.signals.companyInterestConfirmed, true);
  assert.equal(result.draftSignals.nonGreenMarks, 0);
});

test("lane-generated three-plus non-green marks block before a claim", async () => {
  const result = await submitToRole({
    candidate,
    roleId: "role-1",
    apply: false,
    credits: { allowance: 10, earnedBack: 0, usedThisWeek: 2, available: 8 },
    trpcGetImpl: passingTrpcRead,
    submissionDraftBuilder: async () => ({
      ok: false,
      blockers: ["generated_three_plus_non_green"],
      draft: { greatFitReason: "never consumed" },
      signals: { nonGreenMarks: 3 },
    }),
    now: NOW,
  });
  assert.equal(result.stage, "blocked");
  assert.ok(result.blockers.includes("generated_three_plus_non_green"));
  assert.equal(result.draftSignals.nonGreenMarks, 3);
});

test("apply mode fails closed before a claim when prepare routing is invalid", async () => {
  let postCalls = 0;
  let claimCalls = 0;
  const result = await submitToRole({
    candidate: { ...candidate, linkedinUser: "taylor-example" },
    roleId: "role-1",
    apply: true,
    credits: { allowance: 10, earnedBack: 0, usedThisWeek: 2, available: 8 },
    trpcGetImpl: passingTrpcRead,
    trpcPostImpl: async () => { postCalls += 1; },
    submissionDraftBuilder: async () => ({
      ok: true,
      blockers: [],
      draft: { greatFitReason: "grounded draft" },
      signals: { nonGreenMarks: 0 },
    }),
    prepareContext: {
      anonymizeCandidates: "not-a-boolean",
    },
    submissionStore: {
      claimSubmission: async () => {
        claimCalls += 1;
        throw new Error("must not claim");
      },
    },
    now: NOW,
  });
  assert.equal(result.stage, "blocked");
  assert.deepEqual(result.blockers, ["submit_prepare_context_unconfirmed"]);
  assert.equal(postCalls, 0);
  assert.equal(claimCalls, 0);
});

test("captured adapter gets one fenced attempt and only verified readback succeeds", async () => {
  const calls = [];
  const submissionStore = {
    claimSubmission: async () => ({
      status: "claimed",
      claim: { attemptId: "attempt-1" },
    }),
    getSubmissionClaim: async () => null,
    startSubmissionAttempt: async (...args) => {
      calls.push(["start", ...args]);
      return { status: "started", claim: { attemptId: "attempt-1" } };
    },
    recordSubmissionPrepared: async (...args) => {
      calls.push(["prepared", ...args]);
      return { status: "prepared" };
    },
    recordSubmissionOutcome: async (...args) => {
      calls.push(["outcome", ...args]);
      return { status: "recorded" };
    },
  };
  let prepareCalls = 0;
  let finalCalls = 0;
  const result = await submitToRole({
    candidate: { ...candidate, linkedinUser: "taylor-example" },
    roleId: "role-1",
    apply: true,
    credits: { allowance: 10, earnedBack: 0, usedThisWeek: 2, available: 8 },
    trpcGetImpl: passingTrpcRead,
    contextPrecheckImpl: async () => ({ ok: true, blockers: [], signals: {} }),
    trpcPostImpl: async (proc, input) => {
      prepareCalls += 1;
      assert.equal(proc, "roleSlots.prepareForSingleSubmission");
      assert.equal(input.role_discovery_source, "CURATED_LIST");
      return {
        success: true,
        candidate_to_approved_role_id: "candidate-role-1",
      };
    },
    submissionDraftBuilder: async () => ({
      ok: true,
      blockers: [],
      draft: { greatFitReason: "grounded draft" },
      signals: { nonGreenMarks: 0 },
    }),
    prepareContext: {
      anonymizeCandidates: false,
      roleDiscoverySource: "CURATED_LIST",
    },
    contextPrecheckImpl: async () => ({ ok: true, blockers: [], signals: {} }),
    finalSubmitImpl: async ({ candidateToApprovedRoleId, submissionDraft }) => {
      finalCalls += 1;
      assert.equal(candidateToApprovedRoleId, "candidate-role-1");
      assert.equal(submissionDraft.greatFitReason, "grounded draft");
      return { verified: true, signals: { creditDelta: 1 } };
    },
    submissionStore,
    now: NOW,
  });
  assert.equal(prepareCalls, 1);
  assert.equal(finalCalls, 1);
  assert.equal(result.stage, "verified");
  assert.equal(result.submitted, true);
  assert.equal(result.verified, true);
  assert.ok(calls.some((call) => call[0] === "prepared"));
  assert.deepEqual(
    calls.filter((call) => call[0] === "outcome").map((call) => call[3]),
    ["accepted", "verified"],
  );
});

test("the production submit path pins curated-list prepare routing by default", async () => {
  const result = await submitToRole({
    candidate: { ...candidate, linkedinUser: "taylor-example" },
    roleId: "role-1",
    apply: true,
    credits: { allowance: 10, earnedBack: 0, usedThisWeek: 2, available: 8 },
    trpcGetImpl: passingTrpcRead,
    trpcPostImpl: async (proc, input) => {
      assert.equal(proc, "roleSlots.prepareForSingleSubmission");
      assert.equal(input.anonymize_candidates, false);
      assert.equal(input.role_discovery_source, "CURATED_LIST");
      return {
        success: true,
        candidate_to_approved_role_id: "candidate-role-1",
      };
    },
    submissionDraftBuilder: async () => ({
      ok: true,
      blockers: [],
      draft: { greatFitReason: "grounded draft" },
      signals: { nonGreenMarks: 0 },
    }),
    contextPrecheckImpl: async () => ({ ok: true, blockers: [], signals: {} }),
    finalSubmitImpl: async () => ({ verified: true, signals: {} }),
    submissionStore: {
      claimSubmission: async () => ({
        status: "claimed",
        claim: { attemptId: "attempt-1" },
      }),
      getSubmissionClaim: async () => null,
      startSubmissionAttempt: async () => ({ status: "started" }),
      recordSubmissionPrepared: async () => ({ status: "prepared" }),
      recordSubmissionOutcome: async () => ({ status: "recorded" }),
    },
    now: NOW,
  });
  assert.equal(result.stage, "verified");
});

test("an uncertain final mutation is permanently reads-only and never retried", async () => {
  let finalCalls = 0;
  const outcomes = [];
  const result = await submitToRole({
    candidate: { ...candidate, linkedinUser: "taylor-example" },
    roleId: "role-1",
    apply: true,
    credits: { allowance: 10, earnedBack: 0, usedThisWeek: 2, available: 8 },
    trpcGetImpl: passingTrpcRead,
    contextPrecheckImpl: async () => ({ ok: true, blockers: [], signals: {} }),
    trpcPostImpl: async () => ({
      success: true,
      candidate_to_approved_role_id: "candidate-role-1",
    }),
    submissionDraftBuilder: async () => ({
      ok: true,
      blockers: [],
      draft: { greatFitReason: "grounded draft" },
      signals: { nonGreenMarks: 0 },
    }),
    prepareContext: {
      anonymizeCandidates: false,
      roleDiscoverySource: "CURATED_LIST",
    },
    contextPrecheckImpl: async () => ({ ok: true, blockers: [], signals: {} }),
    finalSubmitImpl: async () => {
      finalCalls += 1;
      throw new Error("transport timeout");
    },
    submissionStore: {
      claimSubmission: async () => ({
        status: "claimed",
        claim: { attemptId: "attempt-1" },
      }),
      getSubmissionClaim: async () => null,
      startSubmissionAttempt: async () => ({ status: "started" }),
      recordSubmissionPrepared: async () => ({ status: "prepared" }),
      recordSubmissionOutcome: async (_candidateUserId, _roleId, outcome) => {
        outcomes.push(outcome);
        return { status: "recorded" };
      },
    },
    now: NOW,
  });
  assert.equal(finalCalls, 1);
  assert.equal(result.stage, "submission_unknown");
  assert.deepEqual(outcomes, ["submission_unknown"]);
});
