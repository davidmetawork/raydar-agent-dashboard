import test from "node:test";
import assert from "node:assert/strict";

import {
  buildSubmissionSourceBundle,
  guardSubmissionDraft,
  roleQuestions,
  roleRequirements,
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
        text: "Their B2B product leadership at Northstar, including leading a platform from zero to one for enterprise customers, maps directly to Acme Labs' Product Lead mandate.",
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
        comment: "Relevant platform depth; healthcare isn't explicit.",
        evidence: ["launched it for enterprise customers"],
      },
    ],
    question_answers: [{
      question_id: "q1",
      answer: "Yes, they can work from the San Francisco office three days each week.",
      evidence: ["I am open to working from the San Francisco office three days each week."],
    }],
    additional_info: [{
      text: "Healthcare experience isn't explicit, but they have enterprise platform depth.",
      evidence: ["launched it for enterprise customers"],
    }],
    ...overrides,
  };
}

test("role requirements and questions preserve stable form ids", () => {
  assert.deepEqual(roleRequirements(role).map((item) => item.id), ["r1", "r2", "r3"]);
  assert.deepEqual(roleQuestions(role), [{
    id: "q1",
    text: "Can they work from the San Francisco office?",
    required: true,
  }]);
});

test("a complete grounded draft follows the corrected playbook", () => {
  const result = guardSubmissionDraft({
    draft: validDraft(),
    role,
    candidateName: "Taylor Example",
    sourceTexts,
  });
  assert.equal(result.ok, true);
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
    role,
    candidateName: "Taylor Example",
    sourceTexts,
  });
  assert.equal(result.ok, false);
  assert.ok(result.blockers.includes("great_fit_reason_not_grounded"));
  assert.equal(result.signals.droppedPitchSentenceCount, 1);
  assert.ok(!result.draft.greatFitReason.includes("TestForge AI"));
});

test("three generated non-green marks route to review", () => {
  const attributes = validDraft().attributes.map((item) => ({ ...item, rating: 3 }));
  const result = guardSubmissionDraft({
    draft: validDraft({ attributes }),
    role,
    candidateName: "Taylor Example",
    sourceTexts,
  });
  assert.equal(result.ok, false);
  assert.ok(result.blockers.includes("generated_three_plus_non_green"));
  assert.equal(result.signals.nonGreenMarks, 3);
});

test("every listed requirement must have exactly one generated mark", () => {
  const result = guardSubmissionDraft({
    draft: validDraft({ attributes: validDraft().attributes.slice(0, 2) }),
    role,
    candidateName: "Taylor Example",
    sourceTexts,
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
    role,
    candidateName: "Taylor Example",
    sourceTexts,
  });
  assert.equal(result.ok, false);
  assert.ok(result.blockers.includes("required_requirement_flat_miss"));
});

test("required questions must have a grounded answer", () => {
  const result = guardSubmissionDraft({
    draft: validDraft({ question_answers: [] }),
    role,
    candidateName: "Taylor Example",
    sourceTexts,
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
});
