// The three Para AI Match History write paths, driven headlessly from the
// contract captured on 2026-07-28 (docs/PARAAI-CAPTURE-2026-07-28.md in the
// main Raydar repo).
//
// Discipline, unchanged from the Talent Network submit path: claim before the
// write, exactly one attempt, then prove the outcome by re-reading the request
// row. A 200 is never treated as success.
import { trpcGet, trpcPost } from "./core.mjs";
import { claimRequestAction, readRequestClaim } from "./reply-store.mjs";

export const MAX_SALARY_BAND_SPREAD = Number(process.env.PARAAI_REPLY_MAX_SALARY_SPREAD || 50_000);

// SUBMISSION_REQUEST_CONFIG.EXPIRATION_DAYS, read out of the Paraform client
// bundle on 2026-07-28: exactly 7. The previous value of 10 was inferred from a
// single "3 days left" sighting and was three days long.
//
// Nothing here gates a write on this number — Paraform flips a row's state to
// EXPIRED server-side and pendingRequestsFor keys off that — so it is used for
// forecasting and pacing only.
export const EXPIRY_DAYS = Number(
  process.env.PARAAI_EXPIRY_DAYS || process.env.PARAAI_REPLY_EXPIRY_DAYS || 7,
);

const text = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
const stripHtml = (value) => text(String(value ?? "").replace(/<[^>]*>/g, " "));

function codedError(code, message = code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export function normalizeRequestRow(row) {
  return {
    id: text(row?.id),
    state: String(row?.state || "").toUpperCase(),
    status: String(row?.status || "").toLowerCase(),
    createdAt: text(row?.created_at),
    createdAtMs: Date.parse(row?.created_at || "") || null,
    applicationId: text(row?.application_id) || null,
    clientNote: text(row?.client_note) || null,
    recruiterResponse: text(row?.recruiter_response) || null,
    candidateId: text(row?.candidate?.id),
    candidateUserId: text(row?.candidate?.candidate_user_id),
    candidateName: text(row?.candidate?.name),
    roleId: text(row?.role?.id),
    roleName: text(row?.role?.name),
    companyName: text(row?.role?.company?.name),
    salaryLowerBound: Number(row?.role?.salaryLowerBound) || null,
    salaryUpperBound: Number(row?.role?.salaryUpperBound) || null,
  };
}

export async function readSubmissionRequests() {
  const result = await trpcGet("submissionRequest.getRecruiterSubmissionRequestHistory", {
    agencyView: false,
    recruiterFilter: [],
  });
  const rows = Array.isArray(result) ? result : (result?.requests || []);
  return rows.map(normalizeRequestRow).filter((row) => row.id && row.candidateUserId);
}

export function pendingRequestsFor(candidateUserId, requests) {
  return requests.filter(
    (request) => request.candidateUserId === candidateUserId && request.state === "PENDING",
  );
}

export function expiresAtMs(request) {
  if (!request?.createdAtMs) return null;
  return request.createdAtMs + EXPIRY_DAYS * 24 * 60 * 60 * 1000;
}

// ---------------------------------------------------------------- YES path

export async function readQuickSubmitForm(requestId) {
  const form = await trpcGet("application.getQuickSubmitFormData", { submission_request_id: requestId });
  if (!form) throw codedError("REPLY_FORM_UNAVAILABLE", "quick submit form data unavailable");
  return form;
}

export async function candidatePreferencesReady(candidateUserId, requiredFields = []) {
  const result = await trpcGet("candidateUserPreference.hasUserInputPreferences", {
    candidate_user_id: candidateUserId,
    required_fields: requiredFields,
  });
  return {
    ready: result?.hasAllRequired === true,
    missingFields: Array.isArray(result?.missingFields) ? result.missingFields : [],
  };
}

const money = (value) => {
  const raw = text(value).replace(/[^0-9.kKmM]/g, "");
  if (!raw) return null;
  const multiplier = /[kK]$/.test(raw) ? 1_000 : /[mM]$/.test(raw) ? 1_000_000 : 1;
  const numeric = Number.parseFloat(raw.replace(/[kKmM]$/, ""));
  return Number.isFinite(numeric) ? Math.round(numeric * multiplier) : null;
};

// Mirrors getQuickSubmitBlockingReasons from the captured bundle. Run BEFORE
// the write: the submit is a single attempt, so a preventable rejection burns
// the only shot at that request.
export function quickSubmitBlockingReasons(form, payload) {
  const reasons = [];
  const role = form?.role || {};
  const openEnded = form?.paraAiOpenEnded === true;
  const questions = Array.isArray(role.role_question) ? role.role_question : [];
  const answers = new Map(
    (payload.question_answers || []).map((row) => [row.question_id, stripHtml(row.answer)]),
  );

  if (openEnded) {
    const content = stripHtml(payload.open_ended_submission);
    if (!content) reasons.push("Please include an open-ended submission");
    else if (content.length < 300) reasons.push("Open-ended submission must be at least 300 characters");
    for (const question of questions) {
      if (question.role_question_focus_priority === "HIGH" && !answers.get(question.id)) {
        reasons.push(`Unanswered high-priority question: ${stripHtml(question.question).slice(0, 80)}`);
      }
    }
  } else {
    const fit = stripHtml(payload.great_fit_reason);
    if (!fit) reasons.push("Why you think they'd be a great fit");
    else if (fit.length < 50) reasons.push("Great fit reason must be at least 50 characters");
    for (const question of questions) {
      if (!question.optional && !answers.get(question.id)) {
        reasons.push(`Unanswered required question: ${stripHtml(question.question).slice(0, 80)}`);
      }
    }
  }

  if (role.phone_screen === "REQUIRED" && payload.phone_screened !== true) {
    reasons.push("This role requires that the candidate has been phone screened");
  }

  const missing = form?.missingCandidateFields || {};
  if (missing.name && !text(payload.candidate_name)) reasons.push("Enter the candidate's full name");
  if (missing.email && !text(payload.candidate_email)) reasons.push("Enter the candidate's email");
  if (missing.linkedin && !String(payload.candidate_linkedin || "").includes("linkedin.com/in/")) {
    reasons.push("Candidate LinkedIn must be a valid LinkedIn profile");
  }

  const lower = money(payload.salary_expectation?.lower);
  const upper = money(payload.salary_expectation?.upper);
  const explained = Boolean(text(payload.salary_explanation));
  if (lower && upper) {
    if (upper - lower > MAX_SALARY_BAND_SPREAD) reasons.push("Salary expectation range is too wide");
    else if (lower > upper) reasons.push("Your salary expectation range is invalid.");
    else if (role.salaryLowerBound && role.salaryUpperBound
      && ((upper > role.salaryUpperBound && lower > role.salaryUpperBound)
        || (lower < role.salaryLowerBound && upper < role.salaryLowerBound))
      && !explained) {
      reasons.push("Salary expectation range is outside the role's range and needs an explanation");
    }
  } else if (role.salary_expectation && !explained && !lower && !upper) {
    reasons.push("Salary expectation details are required for this role");
  }

  if (stripHtml(payload.additional_notes).length > 300) {
    reasons.push("Additional notes must be less than 300 characters");
  }
  if (payload.agreedToTerms !== true) reasons.push("agreedToTerms must be true");
  if (!text(payload.resume_id)) reasons.push("Please upload your resume");
  return reasons;
}

// Step 1 of the UI flow: confirm interest, and answer the hiring manager's note
// when there is one. Only ever VERY_INTERESTED — the automation acts on a
// definitive yes, and "UNCERTAIN" carries account restrictions.
export async function confirmInterest(requestId, { recruiterResponse = null, hasClientNote = false } = {}) {
  const input = { id: requestId, consentLevel: "VERY_INTERESTED" };
  if (hasClientNote) input.recruiterResponse = text(recruiterResponse) || null;
  return trpcPost("submissionRequest.updateConsentLevel", input, 1);
}

export async function submitQuickSubmission(payload) {
  return trpcPost("application.createRecruiterQuickSubmission", payload, 1);
}

// Truth is the re-read row, never the mutation response.
export async function verifyRequestOutcome(requestId, expected) {
  const requests = await readSubmissionRequests();
  const row = requests.find((request) => request.id === requestId) || null;
  if (!row) return { verified: false, row: null, reason: "request_row_missing" };
  if (expected === "submitted") {
    const verified = row.status === "submitted" || row.state === "SUBMITTED" || Boolean(row.applicationId);
    return { verified, row, reason: verified ? null : `state_is_${row.status || row.state}` };
  }
  if (expected === "dismissed") {
    const verified = row.status === "dismissed" || row.state === "DISMISSED";
    return { verified, row, reason: verified ? null : `state_is_${row.status || row.state}` };
  }
  return { verified: false, row, reason: "unknown_expectation" };
}

export async function performQuickSubmit(request, payload, { claim = true } = {}) {
  if (claim && !(await claimRequestAction(request.id, "submit"))) {
    const existing = await readRequestClaim(request.id);
    throw codedError("REPLY_ALREADY_CLAIMED", `request already actioned as ${existing?.action || "unknown"}`);
  }
  let submitError = null;
  try {
    await submitQuickSubmission({ ...payload, submission_request_id: request.id });
  } catch (error) {
    if (error?.code === "AUTH_EXPIRED") throw error;
    submitError = error;
  }
  const outcome = await verifyRequestOutcome(request.id, "submitted");
  if (outcome.verified) return { ok: true, verified: true, row: outcome.row };
  if (submitError) throw submitError;
  // Wrote without a verifiable state change: never retried, always surfaced.
  throw codedError("REPLY_SUBMIT_UNVERIFIED", `submission not verified by read-back (${outcome.reason})`);
}

// ----------------------------------------------------------------- NO path

// Pass reasons come from a fixed vocabulary. The text is shown to the hiring
// manager, so it stays short, neutral, and never quotes the candidate or
// explains anything they did not authorise us to share.
export const PASS_REASONS = Object.freeze({
  not_interested: "Candidate is not interested in this role.",
  off_market: "Candidate is no longer looking for a new role.",
  compensation: "Candidate's compensation expectations are not aligned with this role.",
  location: "Candidate is not able to work from this role's location.",
  other_process: "Candidate is progressing with another opportunity.",
});

export function passReasonText(key) {
  return PASS_REASONS[key] || PASS_REASONS.not_interested;
}

export async function performPass(request, reasonKey, { claim = true } = {}) {
  if (claim && !(await claimRequestAction(request.id, "pass"))) {
    const existing = await readRequestClaim(request.id);
    throw codedError("REPLY_ALREADY_CLAIMED", `request already actioned as ${existing?.action || "unknown"}`);
  }
  let dismissError = null;
  try {
    await trpcPost("submissionRequest.dismissSubmissionRequest", {
      id: request.id,
      dismissReason: passReasonText(reasonKey),
    }, 1);
  } catch (error) {
    if (error?.code === "AUTH_EXPIRED") throw error;
    dismissError = error;
  }
  const outcome = await verifyRequestOutcome(request.id, "dismissed");
  if (outcome.verified) return { ok: true, verified: true, row: outcome.row };
  if (dismissError) throw dismissError;
  throw codedError("REPLY_PASS_UNVERIFIED", `dismissal not verified by read-back (${outcome.reason})`);
}

// ------------------------------------------------------------- OFF-MARKET

// Candidate-level and network-wide (confirmed in the 07-28 capture), which is
// why it fires only on an explicit "I have stopped looking" and is always
// paired with passing each individual request. Reversible via
// agency.reEnableTalentNetworkCandidate — see the capture doc's rollback note.
export async function performOffMarket(candidateUserId) {
  await trpcPost("agency.setTalentNetworkCandidateOffMarket", { candidateUserId }, 1);
  const rows = await trpcGet("agency.listOffMarketCandidates", {}).catch(() => null);
  const verified = Array.isArray(rows)
    ? rows.some((row) => text(row?.candidate_user_id || row?.candidateUserId || row?.id) === candidateUserId)
    : null;
  return { ok: true, verified };
}

export async function reEnableCandidate(candidateUserId) {
  return trpcPost("agency.reEnableTalentNetworkCandidate", { candidateUserId }, 1);
}
