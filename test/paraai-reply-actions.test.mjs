import test from "node:test";
import assert from "node:assert/strict";

import { clearCookieCache } from "../api/paraai/_lib/core.mjs";
import {
  confirmInterest,
  expiresAtMs,
  PASS_REASONS,
  passReasonText,
  pendingRequestsFor,
  performOffMarket,
  performPass,
  performQuickSubmit,
  quickSubmitBlockingReasons,
  readSubmissionRequests,
  verifyRequestOutcome,
} from "../api/paraai/_lib/reply-actions.mjs";

// The tRPC layer is reached through global fetch, so a fake transport is the
// injection point. Every handler is keyed by procedure name, and an unexpected
// procedure fails the test rather than escaping to the network.
function withParaform(handlers, run) {
  const seen = [];
  const realFetch = globalThis.fetch;
  const realCookie = process.env.PARAFORM_SESSION_COOKIE;
  process.env.PARAFORM_SESSION_COOKIE = "Fe26.2-test-only";
  clearCookieCache();
  globalThis.fetch = async (url, options = {}) => {
    const target = String(url);
    assert.ok(target.includes("/trpc/"), `unexpected non-tRPC request: ${target}`);
    const proc = target.split("/trpc/")[1].split("?")[0];
    const input = options.method === "POST"
      ? JSON.parse(options.body).json
      : JSON.parse(decodeURIComponent(target.split("input=")[1])).json;
    seen.push({ proc, input });
    const handler = handlers[proc];
    assert.ok(handler, `unexpected procedure: ${proc}`);
    return new Response(JSON.stringify({ result: { data: { json: handler(input) } } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return (async () => {
    try {
      return await run(seen);
    } finally {
      globalThis.fetch = realFetch;
      if (realCookie == null) delete process.env.PARAFORM_SESSION_COOKIE;
      else process.env.PARAFORM_SESSION_COOKIE = realCookie;
      clearCookieCache();
    }
  })();
}

const requestRow = (over = {}) => ({
  id: "req-1",
  state: "PENDING",
  created_at: "2026-07-20T12:00:00.000Z",
  candidate: { id: "cand-1", candidate_user_id: "cu-1", name: "Amy Chen" },
  role: {
    id: "role-1",
    name: "Backend Engineer",
    company: { name: "Pallet" },
    salaryLowerBound: 180_000,
    salaryUpperBound: 220_000,
  },
  ...over,
});

const form = ({ role = {}, ...over } = {}) => ({
  paraAiOpenEnded: false,
  missingCandidateFields: {},
  role: {
    name: "Backend Engineer",
    company: { name: "Pallet" },
    role_question: [],
    phone_screen: "OPTIONAL",
    salaryLowerBound: 180_000,
    salaryUpperBound: 220_000,
    ...role,
  },
  ...over,
});

const GREAT_FIT = "Amy has spent four years building payment services at Example Co and led the ledger migration this role is hiring for.";

const payload = (over = {}) => ({
  agreedToTerms: true,
  resume_id: "resume-1",
  great_fit_reason: GREAT_FIT,
  question_answers: [],
  phone_screened: true,
  ...over,
});

test("a great fit reason under fifty characters blocks the submit", () => {
  const reasons = quickSubmitBlockingReasons(form(), payload({ great_fit_reason: "Strong engineer." }));
  assert.deepEqual(reasons, ["Great fit reason must be at least 50 characters"]);
});

test("an unanswered required role question blocks the submit", () => {
  const roleQuestions = form({
    role: {
      role_question: [
        { id: "q1", question: "<p>What is their experience with Go?</p>", optional: false },
        { id: "q2", question: "Are they open to hybrid?", optional: true },
      ],
    },
  });
  const reasons = quickSubmitBlockingReasons(roleQuestions, payload());
  assert.deepEqual(reasons, ["Unanswered required question: What is their experience with Go?"]);

  const answered = quickSubmitBlockingReasons(roleQuestions, payload({
    question_answers: [{ question_id: "q1", answer: "Four years of Go on the payments team." }],
  }));
  assert.deepEqual(answered, []);
});

test("an open ended submission under three hundred characters blocks the submit", () => {
  const openEnded = form({ paraAiOpenEnded: true });
  const short = quickSubmitBlockingReasons(openEnded, payload({
    great_fit_reason: "",
    open_ended_submission: "Amy led the ledger migration and would be a strong fit here.",
  }));
  assert.deepEqual(short, ["Open-ended submission must be at least 300 characters"]);

  const long = quickSubmitBlockingReasons(openEnded, payload({
    great_fit_reason: "",
    open_ended_submission: `${GREAT_FIT} ${GREAT_FIT} ${GREAT_FIT}`,
  }));
  assert.deepEqual(long, []);
});

test("a role that requires a phone screen blocks a submit that does not assert one", () => {
  const required = form({ role: { phone_screen: "REQUIRED" } });
  assert.deepEqual(
    quickSubmitBlockingReasons(required, payload({ phone_screened: false })),
    ["This role requires that the candidate has been phone screened"],
  );
  assert.deepEqual(quickSubmitBlockingReasons(required, payload({ phone_screened: true })), []);
});

test("a salary expectation spread wider than the cap blocks the submit", () => {
  const reasons = quickSubmitBlockingReasons(form(), payload({
    salary_expectation: { lower: "180000", upper: "260000" },
  }));
  assert.deepEqual(reasons, ["Salary expectation range is too wide"]);
});

test("a salary expectation outside the role band needs an explanation", () => {
  const unexplained = quickSubmitBlockingReasons(form(), payload({
    salary_expectation: { lower: "240000", upper: "260000" },
  }));
  assert.deepEqual(unexplained, ["Salary expectation range is outside the role's range and needs an explanation"]);

  const explained = quickSubmitBlockingReasons(form(), payload({
    salary_expectation: { lower: "240000", upper: "260000" },
    salary_explanation: "Amy is at 235k today and told us on the call she has some flexibility for the right team.",
  }));
  assert.deepEqual(explained, []);
});

test("a fully valid payload has no blocking reasons", () => {
  const reasons = quickSubmitBlockingReasons(
    form({
      role: {
        phone_screen: "REQUIRED",
        role_question: [{ id: "q1", question: "What is their experience with Go?", optional: false }],
      },
    }),
    payload({
      question_answers: [{ question_id: "q1", answer: "Four years of Go on the payments team." }],
      salary_expectation: { lower: "200000", upper: "215000" },
    }),
  );
  assert.deepEqual(reasons, []);
});

test("an unknown pass reason key falls back to not interested", () => {
  assert.equal(passReasonText("no_such_reason"), PASS_REASONS.not_interested);
  assert.equal(passReasonText(undefined), PASS_REASONS.not_interested);
  assert.equal(passReasonText("off_market"), "Candidate is no longer looking for a new role.");
});

// Seven days, not ten: SUBMISSION_REQUEST_CONFIG.EXPIRATION_DAYS was read out
// of the Paraform client bundle on 2026-07-28. The old figure was inferred from
// a single "3 days left" sighting and ran three days long.
test("only this candidate's pending rows are actionable and they expire seven days after creation", async () => {
  const requests = await withParaform({
    "submissionRequest.getRecruiterSubmissionRequestHistory": () => [
      requestRow(),
      requestRow({ id: "req-2", state: "DISMISSED" }),
      requestRow({ id: "req-3", candidate: { id: "cand-2", candidate_user_id: "cu-2", name: "Sam Ito" } }),
    ],
  }, () => readSubmissionRequests());

  const pending = pendingRequestsFor("cu-1", requests);
  assert.deepEqual(pending.map((request) => request.id), ["req-1"]);
  assert.equal(
    new Date(expiresAtMs(pending[0])).toISOString(),
    "2026-07-27T12:00:00.000Z",
  );
});

// A 200 is never success. Truth is the re-read row.
test("a request row that is still pending never counts as submitted or dismissed", async () => {
  await withParaform({
    "submissionRequest.getRecruiterSubmissionRequestHistory": () => [requestRow()],
  }, async () => {
    const submitted = await verifyRequestOutcome("req-1", "submitted");
    assert.equal(submitted.verified, false);
    assert.equal(submitted.reason, "state_is_PENDING");

    const dismissed = await verifyRequestOutcome("req-1", "dismissed");
    assert.equal(dismissed.verified, false);
    assert.equal(dismissed.reason, "state_is_PENDING");

    const missing = await verifyRequestOutcome("req-404", "submitted");
    assert.deepEqual(missing, { verified: false, row: null, reason: "request_row_missing" });
  });
});

test("a dismissal that leaves the row pending throws REPLY_PASS_UNVERIFIED", async () => {
  await withParaform({
    "submissionRequest.dismissSubmissionRequest": () => ({ ok: true }),
    "submissionRequest.getRecruiterSubmissionRequestHistory": () => [requestRow()],
  }, async (seen) => {
    await assert.rejects(
      performPass({ id: "req-1" }, "not_interested", { claim: false }),
      (error) => error?.code === "REPLY_PASS_UNVERIFIED",
    );
    assert.deepEqual(seen.map((call) => call.proc), [
      "submissionRequest.dismissSubmissionRequest",
      "submissionRequest.getRecruiterSubmissionRequestHistory",
    ]);
  });
});

test("a dismissal is only reported once the row reads back as dismissed", async () => {
  await withParaform({
    "submissionRequest.dismissSubmissionRequest": () => ({ ok: true }),
    "submissionRequest.getRecruiterSubmissionRequestHistory": () => [requestRow({ state: "DISMISSED" })],
  }, async (seen) => {
    const outcome = await performPass({ id: "req-1" }, "compensation", { claim: false });
    assert.equal(outcome.verified, true);
    assert.equal(outcome.row.id, "req-1");
    assert.deepEqual(seen[0].input, {
      id: "req-1",
      dismissReason: PASS_REASONS.compensation,
    });
  });
});

test("a quick submit that leaves the row pending throws REPLY_SUBMIT_UNVERIFIED", async () => {
  await withParaform({
    "application.createRecruiterQuickSubmission": () => ({ id: "app-1" }),
    "submissionRequest.getRecruiterSubmissionRequestHistory": () => [requestRow()],
  }, async (seen) => {
    await assert.rejects(
      performQuickSubmit({ id: "req-1" }, payload(), { claim: false }),
      (error) => error?.code === "REPLY_SUBMIT_UNVERIFIED",
    );
    // Exactly one mutation attempt, ever.
    assert.equal(seen.filter((call) => call.proc === "application.createRecruiterQuickSubmission").length, 1);
    assert.equal(seen[0].input.submission_request_id, "req-1");
  });
});

test("a quick submit is only reported once the row carries an application", async () => {
  await withParaform({
    "application.createRecruiterQuickSubmission": () => ({ id: "app-1" }),
    "submissionRequest.getRecruiterSubmissionRequestHistory": () => [
      requestRow({ state: "PENDING", application_id: "app-1" }),
    ],
  }, async () => {
    const outcome = await performQuickSubmit({ id: "req-1" }, payload(), { claim: false });
    assert.equal(outcome.verified, true);
    assert.equal(outcome.row.applicationId, "app-1");
  });
});

test("confirm interest always sends VERY_INTERESTED and only answers a client note when there is one", async () => {
  await withParaform({
    "submissionRequest.updateConsentLevel": () => ({ ok: true }),
  }, async (seen) => {
    await confirmInterest("req-1", { hasClientNote: false });
    await confirmInterest("req-2", { hasClientNote: true, recruiterResponse: "Amy is available next week." });
    assert.deepEqual(seen[0].input, { id: "req-1", consentLevel: "VERY_INTERESTED" });
    assert.deepEqual(seen[1].input, {
      id: "req-2",
      consentLevel: "VERY_INTERESTED",
      recruiterResponse: "Amy is available next week.",
    });
  });
});

test("the off market write is proved against the off market candidate list", async () => {
  await withParaform({
    "agency.setTalentNetworkCandidateOffMarket": () => ({ ok: true }),
    "agency.listOffMarketCandidates": () => [{ candidate_user_id: "cu-1" }],
  }, async (seen) => {
    const outcome = await performOffMarket("cu-1");
    assert.equal(outcome.verified, true);
    assert.deepEqual(seen.map((call) => call.proc), [
      "agency.setTalentNetworkCandidateOffMarket",
      "agency.listOffMarketCandidates",
    ]);
  });

  await withParaform({
    "agency.setTalentNetworkCandidateOffMarket": () => ({ ok: true }),
    "agency.listOffMarketCandidates": () => [{ candidate_user_id: "cu-9" }],
  }, async () => {
    const outcome = await performOffMarket("cu-1");
    assert.equal(outcome.verified, false);
  });
});
