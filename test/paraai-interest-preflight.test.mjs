import test from "node:test";
import assert from "node:assert/strict";

import {
  classifyCompanyInterest,
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
    throw new Error(`unexpected ${proc}`);
  };

  const result = await runSubmissionEvidencePreflight({
    candidate: { candidateId: "candidate-1", candidateUserId: "candidate-user-1" },
    roleId: "role-1",
    trpcGetImpl,
    now: NOW,
  });

  assert.equal(calls.length, 5);
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

test("shadow submit records would-submit without taking a permanent claim", async () => {
  const result = await submitToRole({
    candidate,
    roleId: "role-1",
    apply: false,
    credits: { allowance: 10, earnedBack: 0, usedThisWeek: 2, available: 8 },
    trpcGetImpl: passingTrpcRead,
    now: NOW,
  });
  assert.equal(result.stage, "would_submit");
  assert.equal(result.preflight.signals.companyInterestConfirmed, true);
});
