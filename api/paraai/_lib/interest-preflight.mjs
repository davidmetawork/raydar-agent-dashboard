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

function transcriptRowText(row) {
  if (typeof row === "string") return clean(row);
  if (typeof row?.text === "string") return clean(row.text);
  if (Array.isArray(row?.words)) {
    return row.words.map((word) => clean(word?.text ?? word)).filter(Boolean).join(" ");
  }
  return "";
}

function transcriptSpeaker(row) {
  if (!row || typeof row !== "object") return "";
  return clean(
    row.speaker
    ?? row.speaker_name
    ?? row.speakerName
    ?? row.participant
    ?? row.participant_name,
  );
}

function transcriptRole(row) {
  if (!row || typeof row !== "object") return "";
  return clean(
    row.speaker_role
    ?? row.speakerRole
    ?? row.participant_role
    ?? row.participantRole
    ?? row.role,
  );
}

function candidateNameTokens(candidateName) {
  return clean(candidateName)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 3);
}

/**
 * Return candidate speech only.
 *
 * Paraform transcripts can label speakers as "Candidate", a person name, or
 * an opaque numeric speaker id. Numeric ids are accepted only when a row from
 * that speaker explicitly self-identifies as the candidate. If attribution is
 * ambiguous, this fails closed instead of treating recruiter speech as proof.
 */
export function candidateTranscriptText(recordingTranscript, candidateName = "") {
  const nameTokens = candidateNameTokens(candidateName);
  if (typeof recordingTranscript === "string") {
    const candidateLines = recordingTranscript
      .split(/\r?\n/)
      .map((line) => {
        const match = line.match(/^\s*([^:]{1,80}):\s*(.+)$/);
        if (!match) return "";
        const label = clean(match[1]).toLowerCase();
        return label === "candidate"
          || label === "interviewee"
          || nameTokens.some((token) => label.includes(token))
          ? clean(match[2])
          : "";
      })
      .filter(Boolean);
    return candidateLines.join("\n");
  }
  if (!Array.isArray(recordingTranscript)) return "";

  const rows = recordingTranscript
    .map((row) => ({
      role: transcriptRole(row).toLowerCase(),
      speaker: transcriptSpeaker(row),
      text: transcriptRowText(row),
    }))
    .filter((row) => row.text);
  if (!rows.length) return "";

  const candidateSpeakers = new Set();
  for (const row of rows) {
    const speaker = row.speaker.toLowerCase();
    if (
      /\b(?:candidate|interviewee|applicant|talent)\b/.test(row.role)
      || /\b(?:candidate|interviewee|applicant|talent)\b/.test(speaker)
      || nameTokens.some((token) => speaker.includes(token))
    ) {
      candidateSpeakers.add(row.speaker);
      continue;
    }
    if (row.speaker && nameTokens.some((token) => {
      const escaped = escapeRegExp(token);
      return new RegExp(`\\b(?:this is|i(?:'m| am)|my name is)\\s+${escaped}\\b`, "i").test(row.text);
    })) {
      candidateSpeakers.add(row.speaker);
    }
  }

  const distinctSpeakers = new Set(rows.map((row) => row.speaker).filter(Boolean));
  if (!candidateSpeakers.size && distinctSpeakers.size === 1) {
    candidateSpeakers.add([...distinctSpeakers][0]);
  }

  return rows
    .filter((row) => (
      candidateSpeakers.has(row.speaker)
      || (!row.speaker && /\b(?:candidate|interviewee|applicant|talent)\b/.test(row.role))
    ))
    .map((row) => row.text)
    .join("\n");
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

function tenureMonths(value) {
  if (Number.isFinite(Number(value))) return Math.max(0, Math.round(Number(value)));
  if (!value || typeof value !== "object") return null;
  const months = Number(value.months);
  const years = Number(value.years);
  if (Number.isFinite(months) || Number.isFinite(years)) {
    return Math.max(
      0,
      Math.round(
        (Number.isFinite(years) ? years * 12 : 0)
        + (Number.isFinite(months) ? months : 0),
      ),
    );
  }
  return null;
}

function experienceTenureSignals(experience) {
  const averageTenureMonths = tenureMonths(
    experience?.average_tenure
    ?? experience?.averageTenure
    ?? experience?.average_tenure_months
    ?? experience?.averageTenureMonths,
  );
  const currentTenureMonths = tenureMonths(
    experience?.current_tenure
    ?? experience?.currentTenure
    ?? experience?.current_tenure_months
    ?? experience?.currentTenureMonths,
  );
  const roleCountValue = experience?.role_count
    ?? experience?.roleCount
    ?? experience?.position_count
    ?? experience?.positionCount
    ?? experience?.experience_count
    ?? experience?.experienceCount;
  const roleCount = Number.isFinite(Number(roleCountValue))
    ? Math.max(0, Math.round(Number(roleCountValue)))
    : null;
  const shortTenurePattern = experience?.jobHopper === true
    || (
      averageTenureMonths != null
      && averageTenureMonths < 18
      && (roleCount == null || roleCount >= 2)
    );
  return { averageTenureMonths, currentTenureMonths, roleCount, shortTenurePattern };
}

function currentEmployerStageSignal(experience) {
  const stage = clean(
    experience?.current_employer_stage
    ?? experience?.currentEmployerStage
    ?? experience?.current_company_stage
    ?? experience?.currentCompanyStage
    ?? experience?.current_employer?.stage
    ?? experience?.currentEmployer?.stage
    ?? experience?.current_employer?.funding_round
    ?? experience?.currentEmployer?.fundingRound,
  );
  return stage || null;
}

function roleConflictsWithCurrentEmployerStage(roleProfile, currentEmployerStage) {
  if (!currentEmployerStage) return false;
  const stage = currentEmployerStage.toLowerCase().replace(/[_-]+/g, " ");
  const profile = roleProfile.toLowerCase();
  const currentIsLarge = /\b(?:public|enterprise|large|big tech|fortune)\b/.test(stage);
  const excludesLarge = /\b(?:avoid|exclude|reject|no|not from)\b.{0,50}\b(?:public|enterprise|large compan|big tech|fortune)\b/.test(profile)
    || /\b(?:must|required|needs?)\b.{0,35}\bstartup experience\b/.test(profile);
  if (currentIsLarge && excludesLarge) return true;

  const escapedStage = escapeRegExp(stage).replace(/\s+/g, "\\s+");
  return new RegExp(
    `\\b(?:avoid|exclude|reject|no|not from)\\b.{0,50}\\b${escapedStage}\\b`,
    "i",
  ).test(profile);
}

function roleHasCurrentEmployerStageRestriction(roleProfile) {
  return /\b(?:avoid|exclude|reject|no|not from)\b.{0,50}\b(?:public|enterprise|large compan|big tech|fortune|series [a-f]|seed|late stage)\b/i
    .test(roleProfile)
    || /\b(?:must|required|needs?)\b.{0,35}\bstartup experience\b/i.test(roleProfile);
}

function sponsorshipRequirement(preferences) {
  const nativeAuthorization = clean(
    preferences?.visa_authorization ?? preferences?.visaAuthorization,
  ).toUpperCase();
  if (nativeAuthorization === "NO_VISA_AUTHORIZATION_NEEDED") return false;
  const values = [
    ...list(preferences?.visa),
    ...list(preferences?.requiresSponsorship),
    preferences?.visa_authorization,
    preferences?.visaAuthorization,
  ].map(clean).filter(Boolean);
  if (!values.length) return null;
  const body = values.join(" ");
  if (
    /\b(?:not available|no visa required|citizen|green card|permanent resident|does not require|no sponsorship)\b/i
      .test(body)
  ) return false;
  if (
    /\b(?:requires? sponsorship|sponsorship required|visa transfer|h-?1b|opt|visa|available)\b/i
      .test(body)
  ) return true;
  return null;
}

function roleDisallowsSponsorship(role) {
  const body = [
    role?.visa_text,
    role?.visaText,
    role?.visa_sponsorship,
    role?.visaSponsorship,
    role?.sponsorship,
    roleText(role),
  ].map(clean).filter(Boolean).join(" ");
  return /\b(?:no|cannot|can['’]?t|unable to|does not|doesn['’]?t|will not|won['’]?t|not able to)\b.{0,35}\bsponsor\w*\b|\b(?:sponsorship|visa sponsorship)\b.{0,25}\b(?:not available|unavailable|not offered)\b|\b(?:must|need to)\b.{0,35}\b(?:authorized to work|citizen|permanent resident)\b/i
    .test(body);
}

function roleWorkplaceRequirement(role) {
  const workplace = [
    role?.workplace_type,
    role?.workplaceType,
    role?.workplace,
    role?.work_place_text,
    role?.workPlaceText,
    role?.workplaceText,
    role?.remote_policy,
    role?.remotePolicy,
  ].map(clean).filter(Boolean).join(" ");
  const contextual = workplace || roleText(role);
  if (
    /\b(?:on[\s_-]*site|in[\s_-]*office|office[-_ ]based|[3-7]\s+days?.{0,18}(?:office|on[\s_-]*site))\b/i
      .test(contextual)
  ) return "ON_SITE";
  if (/\bhybrid\b/i.test(contextual)) return "HYBRID";
  return null;
}

export function classifyWorkplaceCommitment(transcript) {
  const body = clean(transcript);
  if (!body) return { confirmed: false, contradicted: false };
  const contradicted = /\b(?:remote[\s-]*only|only remote|fully remote)\b|\b(?:won['’]?t|wouldn['’]?t|will not|cannot|can['’]?t|not willing|not open)\b.{0,55}\b(?:office|on[\s-]*site|hybrid|commut\w*)\b|\b(?:no office|office is off the table)\b/i
    .test(body);
  const confirmed = !contradicted && (
    /\b(?:open|willing|comfortable|fine|okay|ok|able|happy)\b.{0,55}\b(?:office|on[\s-]*site|hybrid|commut\w*)\b/i.test(body)
    || /\b(?:office|on[\s-]*site|hybrid|commut\w*)\b.{0,45}\b(?:works? for me|is fine|is okay|is ok|no problem)\b/i.test(body)
  );
  return { confirmed, contradicted };
}

function preferenceWorkplaceCommitment(preferences, requirement) {
  if (!requirement) return false;
  const values = [
    ...list(preferences?.workplace),
    ...list(preferences?.workplace_type),
    ...list(preferences?.workplaceType),
    ...list(preferences?.workplace_preferences),
  ]
    .map((value) => clean(value).toUpperCase().replace(/[\s-]+/g, "_"))
    .filter(Boolean);
  if (requirement === "ON_SITE") {
    return values.some((value) => value === "ON_SITE" || value === "ONSITE");
  }
  return values.some((value) => (
    value === "HYBRID"
    || value === "ON_SITE"
    || value === "ONSITE"
  ));
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
  preferences,
  candidateName = "",
  directInterestConfirmed = false,
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
  const tenure = experienceTenureSignals(experience);
  const roleRejectsJobHopping = /\b(?:job hop|job-hop|short tenure|frequent job change|inconsistent career)\w*/i
    .test(roleProfile);
  if (jobHopper && roleRejectsJobHopping) blockers.push("job_hopper_role_conflict");
  else if (tenure.shortTenurePattern && roleRejectsJobHopping) blockers.push("short_tenure_role_conflict");
  else if (jobHopper) risks.push("job_hopper");
  else if (tenure.shortTenurePattern) risks.push("short_tenure_pattern");

  const currentEmployerStage = currentEmployerStageSignal(experience);
  const currentEmployerStageRestricted = roleHasCurrentEmployerStageRestriction(roleProfile);
  const currentEmployerStageConflict = roleConflictsWithCurrentEmployerStage(
    roleProfile,
    currentEmployerStage,
  );
  if (currentEmployerStageConflict) blockers.push("current_employer_stage_role_conflict");
  else if (currentEmployerStageRestricted && !currentEmployerStage) {
    risks.push("current_employer_stage_unavailable");
  }

  const needsSponsorship = sponsorshipRequirement(preferences);
  const sponsorshipDisallowed = roleDisallowsSponsorship(role);
  if (sponsorshipDisallowed && needsSponsorship === true) {
    blockers.push("visa_sponsorship_role_conflict");
  } else if (sponsorshipDisallowed && needsSponsorship == null) {
    blockers.push("visa_status_unconfirmed_for_restricted_role");
  }

  const aiNegativeMarks = countAiNegativeMarks(calibration);
  if (aiNegativeMarks >= 3) blockers.push("ai_calibration_three_plus_negative");
  if (!calibration) risks.push("ai_calibration_unavailable");

  const hasCompetingProcess = competingProcessSignal(insights);
  if (hasCompetingProcess) blockers.push("competing_process_requires_review");

  const transcriptMeetings = list(meetings)
    .map((meeting) => ({
      at: meetingTimestamp(meeting),
      text: candidateTranscriptText(
        meeting?.recording_transcript ?? meeting?.transcript,
        candidateName,
      ),
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
  const companyName = clean(
    role?.company?.name ?? role?.company_name ?? role?.companyName,
  );
  const companyInterest = classifyCompanyInterest(recentTranscripts, companyName);
  if (companyInterest.contradicted) blockers.push("company_interest_contradicted");
  else if (!directInterestConfirmed && !companyInterest.confirmed) {
    blockers.push("company_interest_unconfirmed");
  }

  const workplaceRequirement = roleWorkplaceRequirement(role);
  const workplaceCommitment = classifyWorkplaceCommitment(recentTranscripts);
  const workplacePreferenceConfirmed = preferenceWorkplaceCommitment(
    preferences,
    workplaceRequirement,
  );
  if (workplaceRequirement && workplaceCommitment.contradicted) {
    blockers.push("onsite_commitment_contradicted");
  } else if (
    workplaceRequirement
    && !workplaceCommitment.confirmed
    && !workplacePreferenceConfirmed
  ) {
    blockers.push("onsite_commitment_unconfirmed");
  }

  return {
    ok: [...new Set(blockers)].length === 0,
    blockers: [...new Set(blockers)],
    signals: {
      aiCalibrationAvailable: Boolean(calibration),
      aiNegativeMarks,
      companyInterestConfirmed: companyInterest.confirmed,
      companyInterestContradicted: companyInterest.contradicted,
      companyInterestSatisfied: companyInterest.confirmed || Boolean(directInterestConfirmed),
      companyMentioned: companyInterest.mentioned,
      competingProcess: hasCompetingProcess,
      currentEmployerStageAvailable: Boolean(currentEmployerStage),
      currentEmployerStageConflict,
      currentEmployerStageRestricted,
      jobHopper,
      roleRejectsJobHopping,
      shortTenurePattern: tenure.shortTenurePattern,
      averageTenureMonths: tenure.averageTenureMonths,
      currentTenureMonths: tenure.currentTenureMonths,
      roleCount: tenure.roleCount,
      needsSponsorship,
      sponsorshipDisallowed,
      transcriptAgeDays,
      transcriptAvailable: Boolean(latest),
      directInterestConfirmed: Boolean(directInterestConfirmed),
      workplaceCommitmentConfirmed: workplaceCommitment.confirmed || workplacePreferenceConfirmed,
      workplaceCommitmentContradicted: workplaceCommitment.contradicted,
      workplacePreferenceConfirmed,
      workplaceRequirement,
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
    preferences: ["candidateUserPreference.getCandidateUserPrefs", {
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
  directInterestConfirmed = false,
  maxTranscriptAgeDays = DEFAULT_MAX_TRANSCRIPT_AGE_DAYS,
} = {}) {
  const evidence = await collectSubmissionEvidence({ candidate, roleId, trpcGetImpl });
  return evaluateSubmissionEvidence({
    ...evidence,
    candidateName: candidate?.name,
    directInterestConfirmed,
    now,
    maxTranscriptAgeDays,
  });
}
