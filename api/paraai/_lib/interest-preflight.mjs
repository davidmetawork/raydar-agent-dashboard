// Evidence-backed Step 0 for curated-list interest submissions.
//
// This module deliberately separates read collection from evaluation:
// - collectSubmissionEvidence() owns the headless Paraform reads.
// - evaluateSubmissionEvidence() is pure, deterministic, and unit-testable.
//
// No transcript text, candidate insight text, or other candidate PII is
// returned. The caller gets only durable reason codes and coarse signals.

export const DEFAULT_MAX_TRANSCRIPT_AGE_DAYS = 180;

const DAY_MS = 24 * 60 * 60 * 1000;
const AI_NEGATIVE = new Set(["BAD_FIT", "NO"]);

const clean = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
const list = (value) => Array.isArray(value) ? value : value == null ? [] : [value];

function transcriptText(recordingTranscript) {
  if (typeof recordingTranscript === "string") return clean(recordingTranscript);
  if (!Array.isArray(recordingTranscript)) return "";
  return recordingTranscript.map((row) => {
    if (typeof row === "string") return row;
    if (typeof row?.text === "string") return row.text;
    if (Array.isArray(row?.words)) {
      return row.words.map((word) => clean(word?.text ?? word)).filter(Boolean).join(" ");
    }
    return "";
  }).filter(Boolean).join("\n");
}

function meetingTimestamp(meeting) {
  for (const value of [
    meeting?.event_scheduled_at,
    meeting?.scheduled_at,
    meeting?.started_at,
    meeting?.created_at,
    meeting?.createdAt,
  ]) {
    const parsed = Date.parse(String(value || ""));
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Require explicit, recent, company-specific candidate interest.
 *
 * This intentionally favors review over guessing. Merely mentioning a company
 * is not confirmation, while a nearby explicit objection always wins over a
 * positive phrase elsewhere in the same window.
 */
export function classifyCompanyInterest(transcript, companyName) {
  const body = clean(transcript);
  const company = clean(companyName);
  if (!body || company.length < 2) {
    return { mentioned: false, confirmed: false, contradicted: false };
  }

  const matcher = new RegExp(`\\b${escapeRegExp(company).replace(/\\s+/g, "\\s+")}\\b`, "gi");
  const windows = [];
  for (const match of body.matchAll(matcher)) {
    const start = Math.max(0, match.index - 180);
    const end = Math.min(body.length, match.index + match[0].length + 180);
    windows.push(body.slice(start, end).toLowerCase());
  }
  if (!windows.length) {
    return { mentioned: false, confirmed: false, contradicted: false };
  }

  const negative = /\b(?:not|never)\s+(?:really\s+)?(?:interested|excited|keen|a fan)\b|\b(?:don['’]t|do not|wouldn['’]t|would not)\s+(?:like|pursue|choose|consider)\b|\b(?:rank(?:ed)?|put)\b.{0,45}\b(?:last|lowest|bottom)\b|\b(?:last|lowest|bottom)\b.{0,45}\b(?:choice|pick|preference|rank)\b|\b(?:pass|avoid|low priority|not for me)\b/i;
  const positive = /\b(?:interested|excited|keen|enthusiastic|appealing|top choice|first choice|strong preference|would pursue|want to pursue|sounds good|sounds great)\b/i;
  const contradicted = windows.some((window) => negative.test(window));
  const confirmed = !contradicted && windows.some((window) => positive.test(window));
  return { mentioned: true, confirmed, contradicted };
}

export function countAiNegativeMarks(calibration) {
  return list(calibration?.requirement_items)
    .filter((item) => AI_NEGATIVE.has(clean(item?.evaluation || item?.verdict || item?.status).toUpperCase()))
    .length;
}

function roleText(role) {
  return [
    ...list(role?.rejection_categories),
    ...list(role?.requirements).map((requirement) => requirement?.description),
    role?.ideal_company_desc,
    role?.description,
  ].map(clean).filter(Boolean).join(" ");
}

function roleIsExplicitlyClosed(role) {
  return /\b(?:closed|filled|paused|inactive|archived)\b/i.test(
    [role?.status, role?.active_status].map(clean).filter(Boolean).join(" "),
  );
}

function competingProcessSignal(insights) {
  const types = list(insights?.insight_type).map((value) => clean(value).toUpperCase());
  const text = list(insights?.insight_text).map(clean).join(" ");
  return types.some((value) => /COMPET|PROCESS|OFFER/.test(value))
    || /\b(?:competing process|other process|late[- ]stage|final round|offer deadline|other offer)\b/i.test(text);
}

/**
 * Pure Step 0 decision. All blockers route to review; none auto-rejects a
 * candidate or mutates Paraform.
 */
export function evaluateSubmissionEvidence({
  role,
  experience,
  insights,
  calibration,
  meetings,
  readErrors = [],
  now = Date.now(),
  maxTranscriptAgeDays = DEFAULT_MAX_TRANSCRIPT_AGE_DAYS,
} = {}) {
  const blockers = [...new Set(list(readErrors).map(clean).filter(Boolean))];
  const risks = [];

  if (!role) blockers.push("role_unavailable");
  else if (roleIsExplicitlyClosed(role)) blockers.push("role_not_open");

  const roleProfile = roleText(role);
  const jobHopper = experience?.jobHopper === true;
  const roleRejectsJobHopping = /\b(?:job hop|job-hop|short tenure|frequent job change|inconsistent career)\w*/i
    .test(roleProfile);
  if (jobHopper && roleRejectsJobHopping) blockers.push("job_hopper_role_conflict");
  else if (jobHopper) risks.push("job_hopper");

  const aiNegativeMarks = countAiNegativeMarks(calibration);
  if (aiNegativeMarks >= 3) blockers.push("ai_calibration_three_plus_negative");
  if (!calibration) risks.push("ai_calibration_unavailable");

  const hasCompetingProcess = competingProcessSignal(insights);
  if (hasCompetingProcess) blockers.push("competing_process_requires_review");

  const transcriptMeetings = list(meetings)
    .map((meeting) => ({
      at: meetingTimestamp(meeting),
      text: transcriptText(meeting?.recording_transcript ?? meeting?.transcript),
    }))
    .filter((meeting) => meeting.text)
    .sort((a, b) => (b.at ?? -Infinity) - (a.at ?? -Infinity));

  const latest = transcriptMeetings[0] || null;
  const maxAgeMs = Math.max(1, Number(maxTranscriptAgeDays) || DEFAULT_MAX_TRANSCRIPT_AGE_DAYS) * DAY_MS;
  const transcriptAgeDays = latest?.at == null ? null : Math.max(0, Math.floor((Number(now) - latest.at) / DAY_MS));

  if (!latest) blockers.push("screen_transcript_missing");
  else if (latest.at == null) blockers.push("screen_transcript_timestamp_missing");
  else if (Number(now) - latest.at > maxAgeMs) blockers.push("screen_transcript_stale");

  const recentTranscripts = transcriptMeetings
    .filter((meeting) => meeting.at != null && Number(now) - meeting.at <= maxAgeMs)
    .map((meeting) => meeting.text)
    .join("\n");
  const companyName = clean(role?.company?.name);
  const companyInterest = classifyCompanyInterest(recentTranscripts, companyName);
  if (companyInterest.contradicted) blockers.push("company_interest_contradicted");
  else if (!companyInterest.confirmed) blockers.push("company_interest_unconfirmed");

  return {
    ok: [...new Set(blockers)].length === 0,
    blockers: [...new Set(blockers)],
    signals: {
      aiCalibrationAvailable: Boolean(calibration),
      aiNegativeMarks,
      companyInterestConfirmed: companyInterest.confirmed,
      companyInterestContradicted: companyInterest.contradicted,
      companyMentioned: companyInterest.mentioned,
      competingProcess: hasCompetingProcess,
      jobHopper,
      roleRejectsJobHopping,
      transcriptAgeDays,
      transcriptAvailable: Boolean(latest),
    },
    risks: [...new Set(risks)],
  };
}

export async function collectSubmissionEvidence({
  candidate,
  roleId,
  trpcGetImpl,
} = {}) {
  if (typeof trpcGetImpl !== "function") throw new TypeError("trpcGetImpl required");

  const reads = {
    role: ["role.getRoleByIdSimple", { role_id: roleId, id: roleId }],
    experience: ["candidates.getCandidateExperienceStats", { candidate_id: candidate?.candidateId }],
    insights: ["candidates.getCandidateInsights", {
      candidate_id: candidate?.candidateId,
      role_id: roleId,
    }],
    calibration: ["aiCalibrations.getAiCalibration", {
      role_id: roleId,
      candidate_id: candidate?.candidateId,
    }],
    meetings: ["candidateUserMeeting.getSelectableMeetingsForCandidateUserId", {
      candidate_user_id: candidate?.candidateUserId,
    }],
  };

  const entries = await Promise.all(Object.entries(reads).map(async ([key, [proc, input]]) => {
    try {
      return [key, await trpcGetImpl(proc, input), null];
    } catch {
      return [key, null, `preflight_read_failed_${key}`];
    }
  }));

  const evidence = {};
  const readErrors = [];
  for (const [key, value, error] of entries) {
    evidence[key] = value;
    if (error) readErrors.push(error);
  }
  return { ...evidence, readErrors };
}

export async function runSubmissionEvidencePreflight({
  candidate,
  roleId,
  trpcGetImpl,
  now = Date.now(),
  maxTranscriptAgeDays = DEFAULT_MAX_TRANSCRIPT_AGE_DAYS,
} = {}) {
  const evidence = await collectSubmissionEvidence({ candidate, roleId, trpcGetImpl });
  return evaluateSubmissionEvidence({ ...evidence, now, maxTranscriptAgeDays });
}
