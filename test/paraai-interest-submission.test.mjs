import test from "node:test";
import assert from "node:assert/strict";

import {
  buildSingleSubmissionPayload,
  buildSingleSubmissionPrepareInput,
  buildSubmissionSourceBundle,
  duplicateSubmissionBlockers,
  executeCapturedSingleSubmission,
  guardSubmissionDraft,
  parseSingleSubmissionPrepareResponse,
  precheckCapturedSingleSubmissionContext,
  roleQuestions,
  roleRequirements,
  singleSubmissionLedgerSnapshot,
  singleSubmissionWeekStart,
  verifySingleSubmissionReadback,
} from "../api/paraai/_lib/interest-submission.mjs";

const role = {
  company: { name: "Acme Labs" },
  title: "Product Lead",
  requirements: [
    { id: "r1", name: "B2B product leadership", importance: "REQUIRED" },
    { id: "r2", name: "Zero-to-one delivery", importance: "REQUIRED" },
    { id: "r3", name: "Healthcare domain", importance: "OPTIONAL" },
  ],
  application_questions: [
    { id: "q1", question: "Can they work from the San Francisco office?", required: true },
  ],
};

const sourceTexts = [
  "Product Lead at Northstar. Led a B2B platform from zero to one and launched it for enterprise customers.",
  "I am excited about Acme Labs and I am open to working from the San Francisco office three days each week.",
  "The role needs B2B product leadership, zero-to-one delivery, and healthcare domain experience.",
];

function validDraft(overrides = {}) {
  return {
    one_liner: "Product Lead @ Northstar | B2B",
    one_liner_evidence: ["Product Lead at Northstar", "Led a B2B platform"],
    pitch_sentences: [
      {
        text: "Their B2B product leadership at Northstar, with a platform led from zero to one and launched for enterprise customers, is a strong match for Acme Labs.",
        evidence: [
          "Product Lead at Northstar",
          "Led a B2B platform from zero to one and launched it for enterprise customers.",
        ],
      },
      {
        text: "They're excited about Acme Labs and explicitly open to working from the San Francisco office three days each week.",
        evidence: [
          "I am excited about Acme Labs",
          "I am open to working from the San Francisco office three days each week.",
        ],
      },
    ],
    attributes: [
      {
        requirement_id: "r1",
        rating: 5,
        comment: "",
        evidence: ["Led a B2B platform from zero to one"],
      },
      {
        requirement_id: "r2",
        rating: 5,
        comment: "",
        evidence: ["Led a B2B platform from zero to one"],
      },
      {
        requirement_id: "r3",
        rating: 3,
        comment: "Healthcare experience isn't explicit; enterprise platform depth is relevant.",
        evidence: [
          "Led a B2B platform from zero to one",
          "launched it for enterprise customers",
        ],
      },
    ],
    question_answers: [{
      question_id: "q1",
      answer: "Yes, they can work from the San Francisco office three days each week.",
      evidence: ["I am open to working from the San Francisco office three days each week."],
    }],
    additional_info: [{
      text: "Healthcare experience isn't explicit, but they have enterprise platform depth.",
      evidence: [
        "Led a B2B platform from zero to one",
        "launched it for enterprise customers",
      ],
    }],
    ...overrides,
  };
}

const guardContext = {
  role,
  candidateName: "Taylor Example",
  sourceTexts,
  candidateSourceTexts: sourceTexts.slice(0, 2),
  roleSourceTexts: [JSON.stringify(role), ...sourceTexts.slice(2)],
};

test("role requirements and questions preserve stable form ids", () => {
  assert.deepEqual(roleRequirements(role).map((item) => item.id), ["r1", "r2", "r3"]);
  assert.deepEqual(roleQuestions(role), [{
    id: "q1",
    text: "Can they work from the San Francisco office?",
    required: true,
    payloadField: "question_answers",
    minLength: 1,
  }]);
});

test("a complete grounded draft follows the corrected playbook", () => {
  const result = guardSubmissionDraft({
    draft: validDraft(),
    ...guardContext,
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.draft.overallRating, "GOOD_FIT");
  assert.equal(result.draft.rating, 3);
  assert.equal(result.draft.attributes[0].rating, 5);
  assert.equal(result.draft.attributes[2].rating, 3);
  assert.equal(result.draft.attributes[2].comment, "");
  assert.equal(result.signals.nonGreenMarks, 1);
});

test("fabricated biography is stripped and blocks a partial pitch", () => {
  const result = guardSubmissionDraft({
    draft: validDraft({
      pitch_sentences: [
        validDraft().pitch_sentences[0],
        {
          text: "They also co-founded TestForge AI, making them a uniquely strong fit for Acme Labs.",
          evidence: ["I am excited about Acme Labs"],
        },
      ],
    }),
    ...guardContext,
  });
  assert.equal(result.ok, false);
  assert.ok(result.blockers.includes("great_fit_reason_not_grounded"));
  assert.equal(
    result.signals.droppedPitchSentenceCount,
    1,
    JSON.stringify(result),
  );
  assert.ok(!result.draft.greatFitReason.includes("TestForge AI"));
});

test("lowercase fabricated claims cannot borrow grounding from a citation", () => {
  const result = guardSubmissionDraft({
    draft: validDraft({
      pitch_sentences: [
        validDraft().pitch_sentences[0],
        {
          text: "They grew revenue dramatically and would be a strong match for Acme Labs.",
          evidence: ["I am excited about Acme Labs"],
        },
      ],
    }),
    ...guardContext,
  });
  assert.equal(result.ok, false);
  assert.ok(result.blockers.includes("great_fit_reason_not_grounded"));
  assert.doesNotMatch(result.draft.greatFitReason, /revenue dramatically/);
});

test("role text can authorize role wording but never candidate evidence", () => {
  const draft = validDraft();
  draft.attributes[0] = {
    ...draft.attributes[0],
    evidence: ["B2B product leadership"],
  };
  const result = guardSubmissionDraft({ draft, ...guardContext });
  assert.equal(result.ok, false);
  assert.ok(result.blockers.includes("scorecard_evidence_missing"));
});

test("one-liner and pitch sentence structure are exact", () => {
  const longOneLiner = guardSubmissionDraft({
    draft: validDraft({
      one_liner: "Product Lead @ Northstar | B2B enterprise platform leadership",
    }),
    ...guardContext,
  });
  assert.ok(longOneLiner.blockers.includes("one_liner_not_grounded"));

  const extraSentence = guardSubmissionDraft({
    draft: validDraft({
      pitch_sentences: [
        {
          ...validDraft().pitch_sentences[0],
          text: `${validDraft().pitch_sentences[0].text} It launched.`,
        },
        validDraft().pitch_sentences[1],
      ],
    }),
    ...guardContext,
  });
  assert.ok(extraSentence.blockers.includes("great_fit_reason_not_grounded"));
});

test("three generated non-green marks route to review", () => {
  const attributes = validDraft().attributes.map((item) => ({ ...item, rating: 3 }));
  const result = guardSubmissionDraft({
    draft: validDraft({ attributes }),
    ...guardContext,
  });
  assert.equal(result.ok, false);
  assert.ok(result.blockers.includes("generated_three_plus_non_green"));
  assert.equal(result.signals.nonGreenMarks, 3);
});

test("every listed requirement must have exactly one generated mark", () => {
  const result = guardSubmissionDraft({
    draft: validDraft({ attributes: validDraft().attributes.slice(0, 2) }),
    ...guardContext,
  });
  assert.equal(result.ok, false);
  assert.ok(result.blockers.includes("scorecard_requirement_mismatch"));
});

test("a flat miss on a required requirement cannot be papered over", () => {
  const attributes = validDraft().attributes.map((item) => (
    item.requirement_id === "r1" ? { ...item, rating: 1 } : item
  ));
  const result = guardSubmissionDraft({
    draft: validDraft({ attributes }),
    ...guardContext,
  });
  assert.equal(result.ok, false);
  assert.ok(result.blockers.includes("required_requirement_flat_miss"));
});

test("required questions must have a grounded answer", () => {
  const result = guardSubmissionDraft({
    draft: validDraft({ question_answers: [] }),
    ...guardContext,
  });
  assert.equal(result.ok, false);
  assert.ok(result.blockers.includes("required_question_unanswered"));
});

test("candidate-only transcript enters the model source bundle", () => {
  const bundle = buildSubmissionSourceBundle({
    role,
    candidate: { name: "Taylor Example" },
    candidateProfile: { headline: "Product Lead at Northstar" },
    preferences: {},
    calibration: {},
    meetings: [{
      event_scheduled_at: "2026-07-29T00:00:00Z",
      recording_transcript: [
        { speaker: "Recruiter", text: "Taylor founded TestForge AI." },
        { speaker: "Candidate", text: "I am excited about Acme Labs." },
      ],
    }],
  });
  assert.match(bundle.modelInput.candidate_only_screening_speech, /excited about Acme Labs/);
  assert.doesNotMatch(bundle.modelInput.candidate_only_screening_speech, /TestForge AI/);
  assert.doesNotMatch(bundle.candidateSourceTexts.join("\n"), /TestForge AI/);
  assert.match(bundle.roleSourceTexts.join("\n"), /Healthcare domain/);
});

test("the model and verifier share the same bounded candidate transcript", () => {
  const repeated = "I am excited about Acme Labs. ".repeat(2_000);
  const bundle = buildSubmissionSourceBundle({
    role,
    candidate: { name: "Taylor Example" },
    candidateProfile: {},
    preferences: {},
    calibration: {},
    meetings: [{
      event_scheduled_at: "2026-07-29T00:00:00Z",
      recording_transcript: [{
        speaker: "Candidate",
        text: repeated,
      }],
    }],
  });
  const promptTranscript = bundle.modelInput.candidate_only_screening_speech;
  assert.equal(promptTranscript.length, 20_000);
  assert.ok(bundle.candidateSourceTexts.includes(promptTranscript));
  assert.ok(!bundle.candidateSourceTexts.some((text) => text.length > 20_000));
});

test("prepare input pins required fields and omits absent attribution", () => {
  assert.deepEqual(buildSingleSubmissionPrepareInput({
    roleId: "role-1",
    candidateUserId: "candidate-user-1",
    linkedinUser: "taylor-example",
    anonymizeCandidates: false,
    roleDiscoverySource: "CURATED_LIST",
  }), {
    role_id: "role-1",
    candidate_user_id: "candidate-user-1",
    linkedin_user: "taylor-example",
    anonymize_candidates: false,
    role_discovery_source: "CURATED_LIST",
  });
  assert.throws(() => buildSingleSubmissionPrepareInput({
    roleId: "role-1",
    candidateUserId: "candidate-user-1",
    linkedinUser: "taylor-example",
    roleDiscoverySource: "CURATED_LIST",
  }), /explicit boolean/);
  assert.deepEqual(buildSingleSubmissionPrepareInput({
    roleId: "role-1",
    candidateUserId: "candidate-user-1",
    linkedinUser: "taylor-example",
    anonymizeCandidates: false,
  }), {
    role_id: "role-1",
    candidate_user_id: "candidate-user-1",
    linkedin_user: "taylor-example",
    anonymize_candidates: false,
  });
});

test("prepare response accepts only captured success and candidate row id", () => {
  assert.deepEqual(parseSingleSubmissionPrepareResponse({
    success: true,
    candidate_to_approved_role_id: "candidate-role-1",
  }), {
    ok: true,
    candidateToApprovedRoleId: "candidate-role-1",
    shape: ["candidate_to_approved_role_id", "success"],
  });
  assert.equal(parseSingleSubmissionPrepareResponse({
    success: true,
    submission_request_id: "wrong-contract",
  }).ok, false);
  assert.equal(parseSingleSubmissionPrepareResponse({
    success: false,
    candidate_to_approved_role_id: "candidate-role-1",
  }).ok, false);
});

test("authoritative readback requires one credit and matching application identities", () => {
  const before = singleSubmissionLedgerSnapshot({
    recentSingleSubmissionsThisWeekCount: 2,
    previousAllowance: 10,
    latestSingleSubmissions: [{
      application_id: "application-old",
      candidate_to_approved_role_id: "candidate-role-old",
    }],
  });
  const after = singleSubmissionLedgerSnapshot({
    recentSingleSubmissionsThisWeekCount: 3,
    previousAllowance: 10,
    latestSingleSubmissions: [{
      application_id: "application-new",
      candidate_to_approved_role_id: "candidate-role-1",
      role_id: "role-1",
      candidate_user_id: "candidate-user-1",
    }],
  });
  const result = verifySingleSubmissionReadback({
    before,
    after,
    expected: {
      applicationId: "application-new",
      roleId: "role-1",
      candidateUserId: "candidate-user-1",
      candidateToApprovedRoleId: "candidate-role-1",
    },
    application: {
      id: "application-new",
      candidate_to_approved_role_id: "candidate-role-1",
      role_id: "role-1",
      candidate_user_id: "candidate-user-1",
      status: "SUBMITTED",
    },
    submittedToCompany: true,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.blockers, []);
  assert.equal(result.signals.creditDelta, 1);
});

test("recent ledger rows treat top-level id as the application id", () => {
  const snapshot = singleSubmissionLedgerSnapshot({
    latestSingleSubmissions: [{
      id: "application-current-shape",
      candidate_to_approved_role_id: "candidate-role-1",
    }],
  });
  assert.equal(snapshot.rows[0].applicationId, "application-current-shape");
});

test("readback fails closed on a 200-shaped but uncorroborated result", () => {
  const result = verifySingleSubmissionReadback({
    before: { usedThisWeek: 2, rows: [] },
    after: { usedThisWeek: 2, rows: [] },
    expected: {
      applicationId: "application-new",
      roleId: "role-1",
      candidateUserId: "candidate-user-1",
      candidateToApprovedRoleId: "candidate-role-1",
    },
    application: {
      application_id: "application-new",
      status: "SUBMITTED",
    },
    submittedToCompany: false,
  });
  assert.equal(result.ok, false);
  assert.ok(result.blockers.includes("submission_role_readback_mismatch"));
  assert.ok(result.blockers.includes("submission_prepared_row_readback_mismatch"));
});

const contractRole = {
  id: "role-1",
  status: "ACTIVE",
  companyId: "company-1",
  company: { name: "Acme Labs" },
  name: "Product Lead",
  category: "Product",
  currencyType: "USD",
  salary_expectation: true,
  salaryLowerBound: 150_000,
  salaryUpperBound: 220_000,
  visa_sponsorship: true,
  ask_relocation: true,
  requirements: [
    {
      id: "r1",
      description: "B2B product leadership",
      group: "HARD_SKILLS",
      type: "REQUIRED",
      priority: 1,
      active: true,
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-02T00:00:00Z",
      influence_score: 0.8,
    },
    {
      id: "r2",
      description: "Zero-to-one delivery",
      group: "MISC",
      type: "OPTIONAL",
      priority: 2,
      active: true,
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-02T00:00:00Z",
      influence_score: null,
    },
    {
      id: "avoid-1",
      description: "Avoid job hoppers",
      group: "TRAITS_TO_AVOID",
      type: "REQUIRED",
      active: true,
    },
  ],
  role_question: [{
    id: "q1",
    question: "Can they work from San Francisco?",
    active: true,
    optional: false,
  }],
  customQuestion1: "Why are they interested in Acme Labs?",
};

const contractCandidate = {
  candidateUserId: "candidate-user-1",
  candidateId: "candidate-1",
  name: "Taylor Example",
  email: "taylor@example.com",
  linkedinUser: "taylor-example",
};

const contractCandidateToRole = {
  id: "candidate-role-1",
  candidate_id: "candidate-1",
  candidate_user_id: "candidate-user-1",
  candidate_linkedin_user: "taylor-example",
  candidate: {
    id: "candidate-1",
    name: "Taylor Example",
    email: "taylor@example.com",
    linkedin_user: "taylor-example",
    one_liner: "Product Lead",
  },
  candidate_user: {
    id: "candidate-user-1",
    emails: ["taylor@example.com"],
    latest_application_resume_id: "resume-1",
  },
};

const contractApproval = {
  id: "approval-1",
  role_id: "role-1",
  approval_type: "SOURCE",
  prepared_linkedin_user: null,
};

const contractPreferences = {
  salary_min: 165_000,
  salary_max: 200_000,
  visa_authorization: "US citizen",
  relocation: true,
};

const contractDraft = {
  oneLiner: "Product Lead @ Northstar | B2B",
  greatFitReason: "Taylor led a B2B platform from zero to one for enterprise customers. That directly maps to Acme Labs' need for grounded product leadership and dependable delivery.",
  additionalInfo: "",
  attributes: [
    { requirementId: "r1", rating: 5, comment: "" },
    { requirementId: "r2", rating: 5, comment: "" },
  ],
  questionAnswers: [
    {
      questionId: "q1",
      answer: "Yes, they can work from San Francisco three days each week.",
    },
    {
      questionId: "__company_answer",
      answer: "They are specifically interested in Acme Labs because the role matches their B2B product leadership and zero-to-one delivery experience.",
    },
  ],
  rating: 3,
};

test("REST application payload pins current form fields and excludes UI-only consent", () => {
  const result = buildSingleSubmissionPayload({
    candidate: contractCandidate,
    candidateToApprovedRole: contractCandidateToRole,
    userRoleApproval: contractApproval,
    role: contractRole,
    preferences: contractPreferences,
    draft: contractDraft,
    sendConfirmationEmail: true,
  });
  assert.equal(result.ok, true);
  assert.equal(result.payload.role_id, "role-1");
  assert.equal(result.payload.resume_id, "resume-1");
  assert.equal(result.payload.candidate_to_approved_role_id, "candidate-role-1");
  assert.equal(result.payload.salary_expectation, "$165k - $200k");
  assert.equal(result.payload.visa_sponsorship, false);
  assert.equal(result.payload.relocation, true);
  assert.equal(result.payload.application_rating, 3);
  assert.equal(result.payload.rating, 3);
  assert.equal(result.payload.send_confirmation_email, true);
  assert.equal(result.payload.single_submission, true);
  assert.equal(result.payload.question_answers[0].question_id, "q1");
  assert.match(result.payload.company_answer, /specifically interested/);
  assert.equal(result.payload.scorecard.length, 2);
  assert.deepEqual(result.payload.requirements, result.payload.scorecard);
  assert.equal("agreedToTerms" in result.payload, false);
});

test("payload builder fails closed on required attachments and unsupported relocation", () => {
  const result = buildSingleSubmissionPayload({
    candidate: contractCandidate,
    candidateToApprovedRole: contractCandidateToRole,
    userRoleApproval: contractApproval,
    role: contractRole,
    preferences: { ...contractPreferences, relocation: undefined },
    draft: contractDraft,
    attachmentRequirement: { minimum_attachments: 1 },
  });
  assert.equal(result.ok, false);
  assert.ok(result.blockers.includes("submission_relocation_answer_missing"));
  assert.ok(result.blockers.includes("submission_attachment_required"));
});

test("explicit on-site workplace preference satisfies Paraform's on-site answer", () => {
  const result = buildSingleSubmissionPayload({
    candidate: contractCandidate,
    candidateToApprovedRole: contractCandidateToRole,
    userRoleApproval: contractApproval,
    role: contractRole,
    preferences: {
      ...contractPreferences,
      relocation: undefined,
      workplace: ["Remote", "Hybrid", "On-site"],
    },
    draft: contractDraft,
  });
  assert.equal(result.ok, true);
  assert.equal(result.payload.relocation, true);
});

test("duplicate response flags are deterministic blockers", () => {
  assert.deepEqual(duplicateSubmissionBlockers({
    linkedin_user_role: true,
    email_scam: true,
    has_conflict: { has_conflict: true },
  }), [
    "submission_duplicate_linkedin_user_role",
    "submission_duplicate_email_scam",
    "submission_duplicate_company_conflict",
  ]);
});

test("weekly credit boundary is Monday 09:00 Pacific across DST", () => {
  assert.equal(
    singleSubmissionWeekStart("2026-07-29T18:00:00Z"),
    "2026-07-27T16:00:00.000Z",
  );
  assert.equal(
    singleSubmissionWeekStart("2026-01-07T18:00:00Z"),
    "2026-01-05T17:00:00.000Z",
  );
});

test("read-only context precheck fences duplicates, role state, and credits before a claim", async () => {
  const calls = [];
  const trpcGetImpl = async (proc) => {
    calls.push(proc);
    if (proc === "role.getRoleByIdSimple") return contractRole;
    if (proc === "roleSettings.getRoleSettingsForRecruiters") {
      return {
        disable_submissions: false,
        screening_call_snippet_required: false,
        candidate_application_confirm_email: true,
      };
    }
    if (proc === "roleSlots.getMySingleSubmissionData") {
      return {
        recentSingleSubmissionsThisWeekCount: 2,
        previousAllowance: 10,
        earnedBackThisWeekCount: 0,
      };
    }
    if (proc === "candidates.hasCandidateBeenSubmittedToCompany") return false;
    throw new Error(`unexpected read ${proc}`);
  };
  const result = await precheckCapturedSingleSubmissionContext({
    candidate: contractCandidate,
    roleId: "role-1",
    trpcGetImpl,
    trpcPostImpl: async (proc) => {
      assert.equal(proc, "submission.checkDuplicates");
      return {};
    },
    restImpl: async (path) => {
      assert.match(path, /user_role_approval/);
      return contractApproval;
    },
    now: "2026-07-29T18:00:00Z",
  });
  assert.equal(result.ok, true);
  assert.equal(result.signals.paraformConfirmationExpected, true);
  assert.ok(calls.includes("candidates.hasCandidateBeenSubmittedToCompany"));

  const duplicate = await precheckCapturedSingleSubmissionContext({
    candidate: contractCandidate,
    roleId: "role-1",
    trpcGetImpl,
    trpcPostImpl: async () => ({ linkedin_user_role: true }),
    restImpl: async () => contractApproval,
    now: "2026-07-29T18:00:00Z",
  });
  assert.equal(duplicate.ok, false);
  assert.ok(duplicate.blockers.includes("submission_duplicate_linkedin_user_role"));
});

function capturedExecutorHarness({
  duplicate = {},
  preparedId = "candidate-role-1",
  postError = null,
} = {}) {
  let ledgerReads = 0;
  let companyReads = 0;
  let applicationPosts = 0;
  let postedPayload = null;
  const trpcGetImpl = async (proc) => {
    if (proc === "submission.getCandidateSubmissionInfo") {
      return {
        candidateToApprovedRole: {
          ...contractCandidateToRole,
          id: preparedId,
        },
        eligibilityResults: null,
      };
    }
    if (proc === "role.getRoleByIdSimple") return contractRole;
    if (proc === "candidateUserPreference.getCandidateUserPrefs") {
      return contractPreferences;
    }
    if (proc === "roleSettings.getRoleSettingsForRecruiters") {
      return {
        candidate_application_confirm_email: true,
        require_review_by_paraform: false,
        disable_submissions: false,
        submission_attachment_requirements: { minimum_attachments: null },
      };
    }
    if (proc === "roleSlots.getMySingleSubmissionData") {
      ledgerReads += 1;
      return {
        recentSingleSubmissionsThisWeekCount: ledgerReads === 1 ? 2 : 3,
        previousAllowance: 10,
        latestSingleSubmissions: ledgerReads === 1 ? [] : [{
          application_id: "application-1",
          candidate_to_approved_role_id: "candidate-role-1",
        }],
      };
    }
    if (proc === "candidates.hasCandidateBeenSubmittedToCompany") {
      companyReads += 1;
      return companyReads > 1;
    }
    if (proc === "application.getRecruiterApplicationData") {
      return {
        id: "application-1",
        role_id: "role-1",
        candidate_user_id: "candidate-user-1",
        candidate_to_approved_role_id: "candidate-role-1",
        status: "SUBMITTED",
        rating: 3,
        greatFitReason: postedPayload?.great_fit_reason,
        one_liner: postedPayload?.one_liner,
        confirmation_email_sent: true,
        scorecards: [{ attributes: postedPayload?.scorecard || [] }],
      };
    }
    throw new Error(`unexpected read ${proc}`);
  };
  const trpcPostImpl = async (proc, input, tries) => {
    assert.equal(proc, "submission.checkDuplicates");
    assert.equal(input.role_id, "role-1");
    assert.equal(tries, 1);
    return duplicate;
  };
  const restImpl = async (path, options = {}) => {
    if (path.includes("/user_role_approval")) return contractApproval;
    assert.equal(path, "/api/application");
    assert.equal(options.method, "POST");
    assert.equal(options.tries, 1);
    applicationPosts += 1;
    postedPayload = options.json;
    if (postError) throw postError;
    return {
      id: "application-1",
      candidate_id: "candidate-1",
      candidate_user_id: "candidate-user-1",
      candidate_to_approved_role_id: "candidate-role-1",
    };
  };
  return {
    trpcGetImpl,
    trpcPostImpl,
    restImpl,
    applicationPosts: () => applicationPosts,
    postedPayload: () => postedPayload,
  };
}

test("captured executor posts /api/application once and verifies stored payload", async () => {
  const harness = capturedExecutorHarness();
  const result = await executeCapturedSingleSubmission({
    candidate: contractCandidate,
    roleId: "role-1",
    candidateToApprovedRoleId: "candidate-role-1",
    submissionDraft: contractDraft,
    trpcGetImpl: harness.trpcGetImpl,
    trpcPostImpl: harness.trpcPostImpl,
    restImpl: harness.restImpl,
    now: "2026-07-29T18:00:00Z",
    sleepImpl: async () => {},
  });
  assert.equal(result.verified, true);
  assert.equal(result.mutationAttempted, true);
  assert.equal(result.applicationId, "application-1");
  assert.equal(result.signals.creditDelta, 1);
  assert.equal(result.signals.paraformConfirmationExpected, true);
  assert.equal(result.signals.paraformConfirmationSent, true);
  assert.equal(harness.applicationPosts(), 1);
  assert.equal(harness.postedPayload().single_submission, true);
  assert.equal(harness.postedPayload().require_review_by_paraform, false);
});

test("captured executor never blind-retries an uncertain application write", async () => {
  const harness = capturedExecutorHarness({ postError: new Error("timeout") });
  const result = await executeCapturedSingleSubmission({
    candidate: contractCandidate,
    roleId: "role-1",
    candidateToApprovedRoleId: "candidate-role-1",
    submissionDraft: contractDraft,
    trpcGetImpl: harness.trpcGetImpl,
    trpcPostImpl: harness.trpcPostImpl,
    restImpl: harness.restImpl,
    sleepImpl: async () => {},
  });
  assert.equal(result.verified, false);
  assert.equal(result.mutationAttempted, true);
  assert.deepEqual(result.blockers, ["submission_write_result_unknown"]);
  assert.equal(harness.applicationPosts(), 1);
});

test("captured executor blocks duplicates and prepared-row mismatches before POST", async () => {
  const duplicateHarness = capturedExecutorHarness({
    duplicate: { linkedin_user_role: true },
  });
  const duplicateResult = await executeCapturedSingleSubmission({
    candidate: contractCandidate,
    roleId: "role-1",
    candidateToApprovedRoleId: "candidate-role-1",
    submissionDraft: contractDraft,
    trpcGetImpl: duplicateHarness.trpcGetImpl,
    trpcPostImpl: duplicateHarness.trpcPostImpl,
    restImpl: duplicateHarness.restImpl,
    sleepImpl: async () => {},
  });
  assert.equal(duplicateResult.mutationAttempted, false);
  assert.ok(duplicateResult.blockers.includes("submission_duplicate_linkedin_user_role"));
  assert.equal(duplicateHarness.applicationPosts(), 0);

  const mismatchHarness = capturedExecutorHarness({ preparedId: "other-row" });
  const mismatchResult = await executeCapturedSingleSubmission({
    candidate: contractCandidate,
    roleId: "role-1",
    candidateToApprovedRoleId: "candidate-role-1",
    submissionDraft: contractDraft,
    trpcGetImpl: mismatchHarness.trpcGetImpl,
    trpcPostImpl: mismatchHarness.trpcPostImpl,
    restImpl: mismatchHarness.restImpl,
    sleepImpl: async () => {},
  });
  assert.equal(mismatchResult.mutationAttempted, false);
  assert.ok(mismatchResult.blockers.includes("submission_prepared_context_mismatch"));
  assert.equal(mismatchHarness.applicationPosts(), 0);
});
