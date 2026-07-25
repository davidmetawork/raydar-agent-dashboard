import test from "node:test";
import assert from "node:assert/strict";

import {
  aggregateReviewJobs,
} from "../api/paraai/queue.mjs";
import { jobReviewReasons } from "../api/paraai/_lib/review.mjs";

const completeRouting = {
  locations: { stated: [], routed: ["new_york"], rule: "select_all_unknown" },
  workplaceTypes: { stated: [], routed: ["REMOTE"], rule: "select_all_unknown" },
  idealFundingRounds: { stated: [], routed: ["SEED"], rule: "select_all_unknown" },
  salaryMin: { stated: null, routed: 120000, rule: "salary_default_120k" },
  requiresSponsorship: { stated: [], routed: ["Not available"], rule: "visa_default_us" },
};

test("review reasons normalize and stack once per candidate", () => {
  const jobs = [
    {
      id: "bot_review_01",
      state: "needs_review",
      updatedAt: "2026-07-25T00:02:00.000Z",
      identity: { candidateUserId: "candidate-user-1" },
      reviewReasons: [{
        code: "human_intro_without_transcript",
        message: "Human intro call without transcript — preferences confirmed manually",
        soft: true,
      }],
    },
    {
      id: "bot_review_02",
      state: "needs_review",
      updatedAt: "2026-07-25T00:01:00.000Z",
      identity: { candidateUserId: "candidate-user-1" },
      reviewReasons: [{
        code: "no_resume_phase1",
        message: "no resume on profile (resume-wait ships Phase 2)",
      }],
    },
  ];
  const cards = aggregateReviewJobs(jobs);
  assert.equal(cards.length, 1);
  assert.deepEqual(cards[0].relatedJobIds, ["bot_review_01", "bot_review_02"]);
  assert.deepEqual(
    cards[0].reviewReasons.map((reason) => reason.code),
    ["human_intro_without_transcript", "no_resume_phase1"],
  );
  assert.equal(cards[0].reviewAction.allowed, false);
});

test("apply-ladder action is exposed only when every reason is soft", () => {
  const [card] = aggregateReviewJobs([{
    id: "bot_review_03",
    state: "needs_review",
    callEndedAt: "2026-07-24T00:00:00.000Z",
    identity: { candidateUserId: "candidate-user-2" },
    submission: {
      name: "Candidate Example",
      email: "candidate@example.com",
      linkedinUrl: "https://www.linkedin.com/in/candidate-example",
      resumeUri: "s3://resumes/candidate-example.pdf",
    },
    reviewPreferences: {
      locations: ["new_york"],
      workplaceTypes: ["REMOTE"],
      idealFundingRounds: ["SEED"],
      salaryMin: 120_000,
      requiresSponsorship: ["Not available"],
    },
    reviewPolicy: { preferenceRouting: completeRouting },
    reviewReasons: [{
      code: "human_intro_without_transcript",
      message: "Confirm the prepared profile preferences",
    }],
  }]);
  assert.equal(card.reviewReasons[0].soft, true);
  assert.deepEqual(card.reviewAction, {
    allowed: true,
    reasons: ["human_intro_without_transcript"],
  });
});

test("apply-ladder action stays hidden before grace or without complete routing provenance", () => {
  const reason = [{
    code: "human_intro_without_transcript",
    message: "Confirm the prepared profile preferences",
  }];
  const [missingRouting] = aggregateReviewJobs([{
    id: "bot_review_04",
    state: "needs_review",
    callEndedAt: "2026-07-24T00:00:00.000Z",
    reviewReasons: reason,
  }]);
  assert.equal(missingRouting.reviewAction.allowed, false);

  const [insideGrace] = aggregateReviewJobs([{
    id: "bot_review_05",
    state: "needs_review",
    callEndedAt: new Date(Date.now() - 30 * 60_000).toISOString(),
    reviewPolicy: { preferenceRouting: completeRouting },
    reviewReasons: reason,
  }]);
  assert.equal(insideGrace.reviewAction.allowed, false);
});

test("legacy automation reasons remain visible but hard", () => {
  assert.deepEqual(jobReviewReasons({
    automation: { reasons: ["sponsorship unknown for international candidate"] },
  }), [{
    code: "sponsorship_unknown_for_international_candidate",
    message: "sponsorship unknown for international candidate",
    soft: false,
  }]);
});
