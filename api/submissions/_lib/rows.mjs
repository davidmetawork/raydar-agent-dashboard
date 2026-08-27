import { rowHash } from "./store.mjs";

const DAY_MS = 24 * 60 * 60 * 1000;
const text = (value) => String(value ?? "").replace(/\s+/g, " ").trim();

const CHIP_COPY = Object.freeze({
  hiring_manager_requested: "Hiring manager asked for this person",
  no_call_on_record: "No screening call on record",
  requirements_check_pending: "Checking Paraform requirements",
  submission_context_read_failed: "Paraform requirements could not be read",
  request_expired: "The hiring manager request expired",
  request_not_pending: "This request is no longer pending",
  already_submitted: "Already submitted",
  candidate_preferences_incomplete: "Candidate preferences are incomplete",
  resume_missing: "No resume is attached in Paraform",
  candidate_name_missing: "Candidate name is missing",
  candidate_email_missing: "Candidate email is missing",
  candidate_linkedin_missing: "Candidate LinkedIn is missing",
  paraform_ineligible: "Paraform says this request is not eligible",
  dismissed: "Dismissed by the team",
  reply_needs_review: "The reply still needs to be read",
  submission_context_read_failed_role: "Role details could not be read",
  submission_context_read_failed_user_role_approval: "Submission approval could not be read",
  submission_context_read_failed_role_settings: "Role settings could not be read",
  submission_context_read_failed_credit_ledger: "Submission credits could not be read",
  submission_context_read_failed_duplicates: "Duplicate status could not be read",
  submission_context_read_failed_company_duplicate: "Company submission history could not be read",
  submission_linkedin_missing: "Candidate LinkedIn is missing",
  submission_email_missing: "Candidate email is missing",
  submission_resume_missing: "Candidate resume is missing",
  submission_role_not_active: "This role is not active",
  submission_role_disabled: "This role is not accepting submissions",
  submission_screening_call_snippet_required: "This role requires a screening-call clip",
  submission_duplicate_company: "Already submitted to this company",
  submission_company_id_missing: "The role's company could not be identified",
  user_role_approval_missing: "Paraform submission approval is missing",
});

export const chipText = (code) => CHIP_COPY[code] || text(code).replace(/_/g, " ");

function newestFirst(left, right) {
  return Number(right?.createdAtMs || 0) - Number(left?.createdAtMs || 0);
}

function requestRank(request) {
  if (request.state === "PENDING") return 4;
  if (request.applicationId || request.state === "SUBMITTED" || request.status === "submitted") return 3;
  if (request.state === "EXPIRED") return 2;
  return 1;
}

export function groupSubmissionRequests(requests = []) {
  const groups = new Map();
  for (const request of requests) {
    if (!request?.candidateUserId || !request?.roleId) continue;
    const key = rowHash(request.candidateUserId, request.roleId);
    const rows = groups.get(key) || [];
    rows.push(request);
    groups.set(key, rows);
  }
  return [...groups.entries()].map(([key, rows]) => {
    rows.sort((left, right) => {
      const rank = requestRank(right) - requestRank(left);
      return rank || newestFirst(left, right);
    });
    return { key, primary: rows[0], requests: rows };
  });
}

export function contextFromQuickSubmitForm(form, {
  preferences = { ready: true, missingFields: [] },
  hasCall = false,
  paraformConfirmationExpected = null,
  checkedAt = new Date().toISOString(),
} = {}) {
  const missing = form?.missingCandidateFields || {};
  const candidate = form?.candidate || {};
  const defaults = form?.defaultValues || {};
  const eligibility = text(form?.eligibility?.status) || "unknown";
  const blockers = [];
  if (eligibility === "alreadySubmitted") blockers.push("already_submitted");
  else if (eligibility !== "eligible") blockers.push("paraform_ineligible");
  if (!text(defaults.resume_id)) blockers.push("resume_missing");
  if (missing.name && !text(candidate.name)) blockers.push("candidate_name_missing");
  if (missing.email && !text(candidate.email)) blockers.push("candidate_email_missing");
  if (missing.linkedin && !text(candidate.linkedin_user)) blockers.push("candidate_linkedin_missing");
  if (preferences?.ready === false) blockers.push("candidate_preferences_incomplete");
  return {
    status: "ready",
    checkedAt,
    blockers: [...new Set(blockers)],
    eligibility,
    hasCall: Boolean(hasCall),
    phoneScreenRequired: form?.role?.phone_screen === "REQUIRED",
    linkedinUser: text(candidate.linkedin_user) || null,
    hasResume: Boolean(text(defaults.resume_id)),
    missingPreferenceFields: Array.isArray(preferences?.missingFields)
      ? preferences.missingFields.map(text).filter(Boolean).slice(0, 20)
      : [],
    paraformConfirmationExpected:
      typeof paraformConfirmationExpected === "boolean" ? paraformConfirmationExpected : null,
  };
}

function rowState(request, ledger) {
  if (ledger?.submittedAt || request.applicationId || request.state === "SUBMITTED" || request.status === "submitted") {
    return "submitted";
  }
  if (ledger?.dismissedAt) return "dismissed";
  if (request.state === "DISMISSED" || request.status === "dismissed") return "dismissed";
  if (request.state === "PENDING") return "requested";
  return "blocked";
}

export function buildPathARows({ requests = [], ledgers = new Map(), priorRows = [], now = Date.now() } = {}) {
  const priorByKey = new Map(priorRows.map((row) => [row.key, row]));
  const dismissed = [];
  const rows = [];
  for (const group of groupSubmissionRequests(requests)) {
    const request = group.primary;
    const ledger = ledgers.get(group.key) || null;
    const prior = priorByKey.get(group.key) || null;
    const context = prior?.context || null;
    let state = rowState(request, ledger);
    if (state === "requested" && context?.blockers?.includes("already_submitted")) {
      state = "submitted";
    }
    const blockers = [];
    if (state === "blocked") {
      blockers.push(request.state === "EXPIRED" ? "request_expired" : "request_not_pending");
    }
    if (state === "requested") {
      if (context?.status === "failed") blockers.push("submission_context_read_failed");
      else if (!context) blockers.push("requirements_check_pending");
      else blockers.push(...(context.blockers || []));
    }
    const warnings = [];
    if (state === "requested" && context && context.hasCall === false) warnings.push("no_call_on_record");
    const createdAtMs = Number(request.createdAtMs || 0);
    const row = {
      key: group.key,
      path: "A",
      source: "hiring_manager_requested",
      state,
      requestId: request.id,
      requestIds: group.requests.filter((item) => item.state === "PENDING").map((item) => item.id),
      candidateUserId: request.candidateUserId,
      candidateName: request.candidateName || "Candidate",
      roleId: request.roleId,
      roleName: request.roleName || "Role",
      companyName: request.companyName || "Company",
      clientNote: request.clientNote || null,
      createdAt: request.createdAt || null,
      daysWaiting: createdAtMs ? Math.max(0, Math.floor((now - createdAtMs) / DAY_MS)) : null,
      salaryLowerBound: request.salaryLowerBound,
      salaryUpperBound: request.salaryUpperBound,
      blockers: [...new Set(blockers)].map((code) => ({ code, label: chipText(code) })),
      warnings: [...new Set(warnings)].map((code) => ({ code, label: chipText(code) })),
      context,
      ledger,
      links: {
        candidate: `https://www.paraform.com/candidates?id=${encodeURIComponent(request.candidateUserId)}&r_id=${encodeURIComponent(request.roleId)}`,
        role: `https://www.paraform.com/role/${encodeURIComponent(request.roleId)}`,
        linkedin: context?.linkedinUser
          ? `https://www.linkedin.com/in/${encodeURIComponent(context.linkedinUser)}`
          : null,
      },
    };
    if (state === "dismissed") dismissed.push(row);
    else rows.push(row);
  }
  rows.sort((left, right) => {
    const stateRank = { requested: 0, blocked: 1, submitted: 2 };
    return (stateRank[left.state] ?? 9) - (stateRank[right.state] ?? 9)
      || Number(right.daysWaiting || 0) - Number(left.daysWaiting || 0)
      || left.companyName.localeCompare(right.companyName)
      || left.roleName.localeCompare(right.roleName);
  });
  return { rows, dismissed };
}

export function snapshotSummary(rows = [], dismissed = []) {
  return {
    rows: rows.length,
    people: new Set(rows.map((row) => row.candidateUserId)).size,
    requested: rows.filter((row) => ["requested", "ready"].includes(row.state)).length,
    blocked: rows.filter((row) => row.state === "blocked").length,
    submitted: rows.filter((row) => row.state === "submitted").length,
    dismissed: dismissed.length,
    contextPending: rows.filter((row) => row.blockers.some((chip) => chip.code === "requirements_check_pending")).length,
    contextFailed: rows.filter((row) => row.blockers.some((chip) => chip.code === "submission_context_read_failed")).length,
    noLinkedIn: rows.filter((row) => !row.links.linkedin).length,
  };
}

function latestSignalAt(signals, code) {
  return Math.max(0, ...signals.filter((item) => !code || item.code === code)
    .map((item) => Date.parse(item.at || "") || 0));
}

function sourceState(pair, ledger, context) {
  if (ledger?.submittedAt) return "submitted";
  if (ledger?.dismissedAt) return "dismissed";
  if ((context?.blockers || []).some((code) => [
    "submission_duplicate_linkedin_user_role",
    "submission_duplicate_linkedin_others_role",
    "submission_duplicate_email_user_role",
    "submission_duplicate_email_others_role",
  ].includes(code))) return "submitted";
  const declinedAt = latestSignalAt(pair.signals, "not_interested");
  const positiveAt = Math.max(0, ...pair.signals
    .filter((item) => item.code !== "not_interested")
    .map((item) => Date.parse(item.at || "") || 0));
  if (declinedAt && declinedAt >= positiveAt) return "not_interested";
  if (!context || context.status !== "ready" || context.blockers?.length) return "blocked";
  if (pair.signals.some((item) => item.code === "match_watch_replied")
    && !pair.signals.some((item) => [
      "good_fit_promised", "curated_list_interested", "paraai_reply_yes", "sequence_reply_interested",
    ].includes(item.code))) return "blocked";
  return "ready";
}

export function buildCombinedRows({
  pathARows = [],
  signalPairs = [],
  ledgers = new Map(),
  priorRows = [],
  now = Date.now(),
} = {}) {
  const priorByKey = new Map(priorRows.map((row) => [row.key, row]));
  const pairByKey = new Map(signalPairs.map((pair) => [pair.key, pair]));
  const rows = [];
  const dismissed = [];

  for (const original of pathARows) {
    const pair = pairByKey.get(original.key);
    const next = {
      ...original,
      signals: pair?.signals || [{ code: "hiring_manager_requested", label: "Hiring manager asked", priority: 0 }],
      primarySignal: pair?.signals?.[0]?.code || "hiring_manager_requested",
      section: original.state === "submitted" ? "submitted"
        : original.state === "blocked" || original.blockers?.length ? "blocked" : "asked",
    };
    rows.push(next);
    pairByKey.delete(original.key);
  }

  for (const pair of pairByKey.values()) {
    const ledger = ledgers.get(pair.key) || null;
    const context = priorByKey.get(pair.key)?.context || null;
    const state = sourceState(pair, ledger, context);
    const blockers = [];
    if (!["submitted", "not_interested", "dismissed"].includes(state)) {
      if (!context) blockers.push("requirements_check_pending");
      else if (context.status === "failed") blockers.push("submission_context_read_failed");
      else blockers.push(...(context.blockers || []));
    }
    if (state === "blocked"
      && pair.signals.some((item) => item.code === "match_watch_replied")
      && !pair.signals.some((item) => [
        "good_fit_promised", "curated_list_interested", "paraai_reply_yes", "sequence_reply_interested",
      ].includes(item.code))) blockers.push("reply_needs_review");
    const warnings = context?.hasCall === false ? ["no_call_on_record"] : [];
    const createdAtMs = Math.min(...pair.signals
      .map((item) => Date.parse(item.at || ""))
      .filter(Number.isFinite));
    const primary = pair.signals.find((item) => item.code !== "not_interested") || pair.signals[0];
    const row = {
      key: pair.key,
      path: "B",
      source: primary?.code || "candidate_signal",
      primarySignal: primary?.code || "candidate_signal",
      signals: pair.signals,
      state,
      section: state === "submitted" ? "submitted"
        : state === "blocked" ? "blocked"
          : state === "not_interested" ? "notInterested"
            : primary?.code === "match_watch_replied" ? "repliedUnread" : "yes",
      requestId: null,
      candidateUserId: pair.candidateUserId,
      candidateName: pair.candidateName,
      roleId: pair.roleId,
      roleName: context?.roleName || pair.roleName,
      companyName: context?.companyName || pair.companyName,
      createdAt: Number.isFinite(createdAtMs) ? new Date(createdAtMs).toISOString() : null,
      daysWaiting: Number.isFinite(createdAtMs)
        ? Math.max(0, Math.floor((now - createdAtMs) / DAY_MS))
        : null,
      blockers: [...new Set(blockers)].map((code) => ({ code, label: chipText(code) })),
      warnings: [...new Set(warnings)].map((code) => ({ code, label: chipText(code) })),
      context,
      ledger,
      links: {
        candidate: `https://www.paraform.com/candidates?id=${encodeURIComponent(pair.candidateUserId)}&r_id=${encodeURIComponent(pair.roleId)}`,
        role: `https://www.paraform.com/role/${encodeURIComponent(pair.roleId)}`,
        linkedin: context?.linkedinUser
          ? `https://www.linkedin.com/in/${encodeURIComponent(context.linkedinUser)}`
          : null,
      },
    };
    if (state === "dismissed") dismissed.push(row);
    else rows.push(row);
  }

  rows.sort((left, right) => {
    const sectionRank = { asked: 0, yes: 1, repliedUnread: 2, blocked: 3, notInterested: 4, submitted: 5 };
    const signalRank = Number(left.signals?.[0]?.priority ?? 8) - Number(right.signals?.[0]?.priority ?? 8);
    return (sectionRank[left.section] ?? 9) - (sectionRank[right.section] ?? 9)
      || signalRank
      || Number(right.daysWaiting || 0) - Number(left.daysWaiting || 0)
      || left.companyName.localeCompare(right.companyName)
      || left.roleName.localeCompare(right.roleName);
  });
  return { rows, dismissed };
}

export { CHIP_COPY };
