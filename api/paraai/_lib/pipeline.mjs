// Human-confirm Para AI state machine. Every external write is claimed in KV
// before it runs, performed once, and read back before the job advances.

import {
  INTERNAL_NAMES,
  RECRUITER_ID,
  SEQUENCE_NAMES,
  candidateAlreadySubmitted,
  candidateDetails,
  fetchCall,
  findCrmCandidate,
  findIdentity,
  findLead,
  findResumeUri,
  firstEmail,
  getResume,
  hasFutureScheduledStep,
  hasEmail,
  isSuccessfulCall,
  listSequences,
  normLinkedin,
  normName,
  normalizeEmail,
  paraAIConfig,
  registerLifecycleEnrollment,
  resumeContact,
  scanCrm,
  scoreIdentity,
  targetMembership,
  trpcGet,
  trpcPost,
  uploadResume,
} from "./core.mjs";
import { extraNote, extractPreferences, normalizeExtraction } from "./extract.mjs";
import { createJob, getJob, saveJob, transition } from "./store.mjs";

export const STATES = new Set([
  "detected", "resolving_identity", "needs_identity_review", "extracting",
  "ready_to_submit", "submitting", "awaiting_matches", "ready_to_enroll",
  "needs_review", "ensuring_email", "enrolling", "verifying", "enrolled",
  "no_email", "error",
]);

const ZERO_SETTLE_SECONDS = Number(process.env.PARAAI_MATCH_ZERO_SETTLE_SECONDS || 120);
const MATCH_TIMEOUT_SECONDS = Number(process.env.PARAAI_MATCH_TIMEOUT_SECONDS || 300);
const BOT_ID = /^[A-Za-z0-9_-]{8,100}$/;

function stateError(message, code, job = null) {
  const error = new Error(message);
  error.code = code;
  if (job) error.job = job;
  return error;
}

async function fail(job, code, detail, extra = {}) {
  const saved = await saveJob(transition(job, "error", {
    error: { code, detail: String(detail || code).slice(0, 300), at: new Date().toISOString() },
    ...extra,
    journalDetail: code,
  }), job.revision);
  throw stateError(detail || code, code, saved);
}

export function targetSequenceName(matchCount) {
  return Number(matchCount) === 1 ? SEQUENCE_NAMES.one : SEQUENCE_NAMES.multiple;
}

export function buildPreferences(extracted) {
  const normalized = normalizeExtraction(extracted);
  const locations = [...normalized.locations];
  if (normalized.relocation.open === true && normalized.relocation.scope) {
    locations.push(`Open to relocate: ${normalized.relocation.scope}`);
  } else if (normalized.relocation.open === false) {
    locations.push("Not open to relocation");
  }
  const preferences = {
    locations: [...new Set(locations)],
    workplaceTypes: normalized.workplaceTypes,
    idealFundingRounds: normalized.companyStages,
    requiresSponsorship: normalized.sponsorship.statuses,
  };
  if (normalized.compensation.baseMin != null) preferences.salaryMin = normalized.compensation.baseMin;
  if (normalized.compensation.ote != null) preferences.ote = normalized.compensation.ote;
  return preferences;
}

export function matchCountFromResponse(value) {
  if (Array.isArray(value)) return { count: value.length, settled: true };
  if (!value || typeof value !== "object") return { count: null, settled: false };
  const status = String(value.status || value.state || value.generation_status || value.matching_status || "").toUpperCase();
  if (["PENDING", "PROCESSING", "GENERATING", "QUEUED", "RUNNING"].includes(status)) return { count: null, settled: false };
  for (const key of ["matchCount", "match_count", "match_potential_role_count", "totalCount", "total_count"]) {
    if (Number.isFinite(Number(value[key]))) return { count: Math.max(0, Number(value[key])), settled: true };
  }
  for (const key of ["paraai_matches", "matches", "roles", "rankedRoles", "ranked_roles", "items", "results"]) {
    if (Array.isArray(value[key])) return { count: value[key].length, settled: true };
  }
  for (const key of ["data", "candidate", "matching", "result"]) {
    if (value[key] && typeof value[key] === "object") {
      const nested = matchCountFromResponse(value[key]);
      if (nested.count != null || nested.settled) return nested;
    }
  }
  return { count: null, settled: ["COMPLETE", "COMPLETED", "READY", "SETTLED", "SUCCESS"].includes(status) };
}

function candidateFromCall(call) {
  const source = call?.candidate || {};
  return {
    fullName: String(source.fullName || source.name || "").trim(),
    firstName: String(source.firstName || "").trim(),
    linkedin: normLinkedin(source.linkedin),
    phone: String(source.phone || "").trim(),
    scheduledStart: source.scheduledStart || null,
    paraformEventId: source.paraformEventId || null,
  };
}

export function scoreSelectedIdentity(candidate, crmItem) {
  const score = scoreIdentity(candidate, crmItem);
  const exactName = normName(candidate?.fullName) && normName(candidate?.fullName) === normName(crmItem?.name);
  const strong = score.signals.some((signal) => ["linkedin", "phone", "scheduled_time"].includes(signal));
  return {
    signals: ["human_selected_id", ...score.signals],
    ok: Boolean(exactName || strong),
  };
}

function callLink(botId) {
  return `${String(process.env.MONITOR_URL || "https://monitor.raydar.xyz").replace(/\/+$/, "")}/c/${botId}`;
}

function newJournal(state, detail = null) {
  const at = new Date().toISOString();
  return [{ state, at, ...(detail ? { detail } : {}) }];
}

export async function prepareJob({ botId, candidateUserId = "", force = false } = {}) {
  const id = String(botId || "").trim();
  if (!BOT_ID.test(id)) throw stateError("valid Recall bot id required", "INVALID_BOT_ID");
  const existing = await getJob(id);
  if (existing && !force && !["error", "needs_identity_review"].includes(existing.state)) return existing;

  const call = await fetchCall(id);
  const candidate = candidateFromCall(call);
  if (!candidate.fullName || !isSuccessfulCall(call)) {
    const base = existing || {
      id, state: "detected", createdAt: new Date().toISOString(), revision: 0,
      journal: newJournal("detected"), candidate, callLink: callLink(id),
    };
    if (!existing) await createJob(base);
    const current = existing || await getJob(id);
    return fail(current, "NOT_SUCCESSFUL_SCREEN", "Only successful screening calls can enter Para AI");
  }

  let job;
  if (existing) {
    job = await saveJob(transition(existing, "resolving_identity", {
      candidate, callLink: callLink(id), error: null, journalDetail: "manual re-prepare",
    }), existing.revision);
  } else {
    job = await createJob({
      id,
      state: "resolving_identity",
      candidate,
      callLink: callLink(id),
      createdAt: new Date().toISOString(),
      journal: [...newJournal("detected"), ...newJournal("resolving_identity")],
    });
  }

  try {
    let crmItem = candidateUserId ? await findCrmCandidate(candidateUserId) : null;
    let identityScore = candidateUserId && crmItem ? scoreSelectedIdentity(candidate, crmItem) : null;
    let ambiguous = false;
    if (candidateUserId && !crmItem) {
      return saveJob(transition(job, "needs_identity_review", {
        identity: { candidateUserId: null, signals: [], ambiguous: false, reason: "selected candidate user ID was not found" },
        journalDetail: "selected identity not found",
      }), job.revision);
    }
    if (candidateUserId && crmItem && !identityScore.ok) {
      return saveJob(transition(job, "needs_identity_review", {
        identity: { candidateUserId: null, signals: identityScore.signals, ambiguous: false, reason: "selected Paraform candidate does not match this call" },
        journalDetail: "selected identity mismatched call",
      }), job.revision);
    }
    if (!crmItem) {
      const rows = await scanCrm();
      const resolved = findIdentity(candidate, rows);
      crmItem = resolved.match;
      identityScore = resolved.score;
      ambiguous = resolved.ambiguous;
    }
    if (!crmItem) {
      return saveJob(transition(job, "needs_identity_review", {
        identity: { candidateUserId: null, signals: [], ambiguous, reason: ambiguous ? "multiple strong CRM identities" : "no multi-signal CRM identity" },
        journalDetail: ambiguous ? "ambiguous identity" : "identity not found",
      }), job.revision);
    }

    job = await saveJob(transition(job, "extracting", {
      identity: {
        candidateUserId: crmItem.id,
        candidateId: crmItem.candidate_id || null,
        signals: identityScore?.signals || [],
        ambiguous: false,
      },
    }), job.revision);

    const extraction = await extractPreferences(call.transcript || []);
    const [resume, details] = await Promise.all([
      getResume(crmItem.id).catch(() => null),
      candidateDetails(crmItem.id).catch(() => ({ byId: null, profile: null })),
    ]);
    const resumeUri = findResumeUri(resume);
    const contact = resumeUri ? await resumeContact(resumeUri).catch(() => null) : null;
    const email = firstEmail(crmItem) || firstEmail(details) || firstEmail(contact);
    const linkedin = candidate.linkedin || normLinkedin(contact?.linkedinUrl || crmItem?.linkedin_user);
    const extracted = extraction.extracted;
    return saveJob(transition(job, "ready_to_submit", {
      candidate: { ...candidate, fullName: candidate.fullName || contact?.name || crmItem.name },
      identity: { ...job.identity, candidateUserId: crmItem.id, candidateId: crmItem.candidate_id || job.identity?.candidateId || null },
      submission: {
        name: candidate.fullName || contact?.name || crmItem.name || "",
        email,
        linkedinUrl: linkedin,
        resumeUri,
        resumeStatus: resumeUri ? "on_file" : "missing",
        screeningCallLink: callLink(id),
      },
      extracted,
      extraNote: extraNote(extracted),
      extraction: { model: extraction.model, usage: extraction.usage, at: new Date().toISOString() },
      error: null,
    }), job.revision);
  } catch (error) {
    if (error?.job) throw error;
    return fail(job, "PREPARE_FAILED", String(error?.message || error));
  }
}

function mergeEdits(job, body = {}) {
  const extracted = normalizeExtraction(body.extracted || job.extracted || {});
  return {
    ...job,
    extracted,
    extraNote: extraNote(extracted),
    submission: {
      ...(job.submission || {}),
      ...(body.name != null ? { name: String(body.name).trim() } : {}),
      ...(body.email != null ? { email: normalizeEmail(body.email) } : {}),
      ...(body.linkedinUrl != null ? { linkedinUrl: normLinkedin(body.linkedinUrl) } : {}),
      ...(body.resumeUri != null ? { resumeUri: String(body.resumeUri).trim() } : {}),
    },
  };
}

async function applyResumeUpload(job, body) {
  if (!body?.resumeBase64) return job;
  const encoded = String(body.resumeBase64).replace(/^data:application\/pdf;base64,/, "");
  const bytes = Buffer.from(encoded, "base64");
  if (!bytes.length || bytes.length > 4 * 1024 * 1024) throw stateError("Resume PDF must be between 1 byte and 4 MB", "INVALID_RESUME");
  const fileName = String(body.resumeFileName || `${job.id}.pdf`).replace(/[^A-Za-z0-9._-]/g, "_");
  const uploaded = await uploadResume({ bytes, fileName });
  return {
    ...job,
    submission: {
      ...job.submission,
      resumeUri: uploaded.resumeUri,
      resumeStatus: "uploaded",
      email: job.submission?.email || firstEmail(uploaded.contact),
      linkedinUrl: job.submission?.linkedinUrl || normLinkedin(uploaded.contact?.linkedinUrl),
      name: job.submission?.name || String(uploaded.contact?.name || "").trim(),
    },
  };
}

async function submitReadback(candidateUserId, mutationResponse) {
  if (candidateAlreadySubmitted(mutationResponse)) return true;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await new Promise((resolve) => setTimeout(resolve, 2_000));
    const details = await candidateDetails(candidateUserId);
    if (candidateAlreadySubmitted(details)) return true;
  }
  const crm = await findCrmCandidate(candidateUserId);
  return candidateAlreadySubmitted(crm);
}

export async function submitJob(job, body = {}) {
  if (job?.state !== "ready_to_submit") throw stateError("job is not ready to submit", "INVALID_STATE", job);
  if (String(body.confirmation || "") !== `SUBMIT ${job.id}`) throw stateError("submit confirmation mismatch", "CONFIRMATION_MISMATCH", job);
  const config = paraAIConfig();
  if (!config.submitApproved) throw stateError("PARAAI_SUBMIT_APPROVED is false", "SUBMIT_APPROVAL_REQUIRED", job);
  if (config.dryRun) throw stateError("PARAAI_DRY_RUN must be explicitly false", "DRY_RUN", job);
  if (!config.submissionOriginPinned) throw stateError("Phase 0 must pin PARAAI_SUBMISSION_ORIGIN", "PHASE0_ORIGIN_REQUIRED", job);
  if (INTERNAL_NAMES.has(normName(job.candidate?.fullName))) throw stateError("internal-name skip list", "INTERNAL_CANDIDATE", job);

  let edited = await applyResumeUpload(mergeEdits(job, body), body);
  const submission = edited.submission || {};
  if (!submission.name || !normalizeEmail(submission.email) || !normLinkedin(submission.linkedinUrl) || !submission.resumeUri) {
    throw stateError("name, non-Paraform email, LinkedIn, and resume are required", "SUBMISSION_FIELDS_REQUIRED", job);
  }
  const candidateUserId = edited.identity?.candidateUserId;
  const freshCrm = await findCrmCandidate(candidateUserId);
  const details = await candidateDetails(candidateUserId);
  if (!freshCrm) throw stateError("candidate identity no longer resolves in CRM", "IDENTITY_STALE", job);
  if (candidateAlreadySubmitted(freshCrm) || candidateAlreadySubmitted(details)) {
    return fail(job, "ALREADY_SUBMITTED", "Candidate is already in the Para AI talent network");
  }
  if (hasFutureScheduledStep(details)) return fail(job, "FUTURE_NEXT_STEP", "Candidate has a future scheduled next step");
  const membership = await targetMembership(candidateUserId);
  if (membership.memberships.some(({ lead }) => lead?.has_replied)) return fail(job, "HAS_REPLIED", "Candidate has replied in a target sequence");
  if (membership.memberships.length) return fail(job, "ALREADY_ENROLLED", `Candidate already belongs to ${membership.memberships[0].sequence.name}`);

  edited = await saveJob(transition(edited, "submitting", {
    submission: { ...submission, email: normalizeEmail(submission.email), linkedinUrl: normLinkedin(submission.linkedinUrl) },
    submitClaimedAt: new Date().toISOString(),
  }), job.revision);
  let response;
  try {
    const payload = {
      name: edited.submission.name,
      email: edited.submission.email,
      linkedinUrl: edited.submission.linkedinUrl,
      screeningCallLink: edited.submission.screeningCallLink,
      resumeUri: edited.submission.resumeUri,
      preferences: buildPreferences(edited.extracted),
      recruiterId: RECRUITER_ID,
      submissionOrigin: config.submissionOrigin,
    };
    response = await trpcPost("agency.submitTalentNetworkCandidate", payload, 1);
  } catch (error) {
    return fail(edited, "SUBMIT_WRITE_FAILED", String(error?.message || error), { externalWriteMayHaveLanded: true });
  }
  const verified = await submitReadback(candidateUserId, response).catch(() => false);
  if (!verified) return fail(edited, "SUBMIT_NOT_VISIBLE", "Submit returned but talent-network status is not visible on read-back", { externalWriteMayHaveLanded: true });
  return saveJob(transition(edited, "awaiting_matches", {
    submittedAt: new Date().toISOString(),
    submitReadbackVerified: true,
    externalWriteMayHaveLanded: false,
    matchCount: null,
    error: null,
  }), edited.revision);
}

function matchReadInput(job) {
  return {
    candidate_id: job.identity?.candidateId || job.identity?.candidateUserId,
    recruiter_user_id: RECRUITER_ID,
  };
}

export async function refreshMatches(job) {
  if (!["awaiting_matches", "needs_review"].includes(job?.state)) throw stateError("job is not awaiting matches", "INVALID_STATE", job);
  const config = paraAIConfig();
  if (!config.matchReadPinned) throw stateError("Phase 0 must pin PARAAI_MATCH_READ_PROC", "PHASE0_MATCH_READ_REQUIRED", job);
  const response = await trpcGet(config.matchReadProc, matchReadInput(job));
  const result = matchCountFromResponse(response);
  const elapsed = Math.max(0, (Date.now() - Date.parse(job.submittedAt || job.updatedAt || "")) / 1000);
  if (result.count != null && result.count >= 1) {
    return saveJob(transition(job, "ready_to_enroll", {
      matchCount: result.count,
      matchCheckedAt: new Date().toISOString(),
      targetSequenceName: targetSequenceName(result.count),
      error: null,
    }), job.revision);
  }
  if (result.settled && result.count === 0 && elapsed >= ZERO_SETTLE_SECONDS) {
    return saveJob(transition(job, "needs_review", {
      matchCount: 0,
      matchCheckedAt: new Date().toISOString(),
      reviewReason: "zero_matches",
      targetSequenceName: null,
    }), job.revision);
  }
  if (result.count == null && elapsed >= MATCH_TIMEOUT_SECONDS) {
    return saveJob(transition(job, "needs_review", {
      matchCount: null,
      matchCheckedAt: new Date().toISOString(),
      reviewReason: "matches_pending_timeout",
      targetSequenceName: null,
      journalDetail: "match generation timed out",
    }), job.revision);
  }
  return saveJob(transition(job, "awaiting_matches", {
    matchCount: result.count,
    matchCheckedAt: new Date().toISOString(),
    reviewReason: null,
  }), job.revision);
}

async function verifyCandidateEmail(candidateUserId, email) {
  const details = await candidateDetails(candidateUserId);
  return hasEmail(details, email);
}

async function saveEnrollmentError(job, code, detail, extra = {}) {
  const saved = await saveJob(transition(job, "error", {
    error: { code, detail: String(detail).slice(0, 300), at: new Date().toISOString() },
    ...extra,
    journalDetail: code,
  }), job.revision);
  throw stateError(detail, code, saved);
}

export async function enrollJob(job, body = {}, { noMatch = false } = {}) {
  const allowed = noMatch ? job?.state === "needs_review" : ["ready_to_enroll", "needs_review"].includes(job?.state);
  if (!allowed) throw stateError("job is not ready to enroll", "INVALID_STATE", job);
  const expected = noMatch ? `NO MATCHES ${job.id}` : `ENROLL ${job.id}`;
  if (String(body.confirmation || "") !== expected) throw stateError("enroll confirmation mismatch", "CONFIRMATION_MISMATCH", job);
  const config = paraAIConfig();
  if (!config.enrollApproved) throw stateError("PARAAI_ENROLL_APPROVED is false", "ENROLL_APPROVAL_REQUIRED", job);
  if (config.dryRun) throw stateError("PARAAI_DRY_RUN must be explicitly false", "DRY_RUN", job);
  if (!config.lifecycleRegistrationConfigured) throw stateError("lifecycle registration is not configured", "LIFECYCLE_REGISTRATION_REQUIRED", job);

  const email = normalizeEmail(body.email || job.submission?.email);
  if (!email) {
    const saved = await saveJob(transition(job, "no_email", { error: { code: "NO_EMAIL", detail: "A deliverable non-Paraform email is required", at: new Date().toISOString() } }), job.revision);
    throw stateError("A deliverable non-Paraform email is required", "NO_EMAIL", saved);
  }
  const candidateUserId = job.identity?.candidateUserId;
  if (!candidateUserId) throw stateError("candidate identity is missing", "IDENTITY_REQUIRED", job);
  let sequenceName;
  if (noMatch) sequenceName = SEQUENCE_NAMES.none;
  else if (job.state === "ready_to_enroll") sequenceName = targetSequenceName(job.matchCount);
  else sequenceName = String(body.sequenceName || "");
  if (!Object.values(SEQUENCE_NAMES).includes(sequenceName) || (!noMatch && sequenceName === SEQUENCE_NAMES.none)) {
    throw stateError("explicit one-role or multiple-role sequence required", "SEQUENCE_REQUIRED", job);
  }

  const details = await candidateDetails(candidateUserId);
  if (hasFutureScheduledStep(details)) return saveEnrollmentError(job, "FUTURE_NEXT_STEP", "Candidate has a future scheduled next step");
  const sequences = await listSequences();
  const sequence = sequences.find((row) => row?.name === sequenceName);
  if (!sequence?.id) return saveEnrollmentError(job, "SEQUENCE_MISSING", `Target sequence missing: ${sequenceName}`);
  if (!sequence.enabled) return saveEnrollmentError(job, "SEQUENCE_DISABLED", `Target sequence is disabled: ${sequenceName}`);

  const allTargetIds = new Set(sequences.filter((row) => Object.values(SEQUENCE_NAMES).includes(row?.name)).map((row) => row.id));
  let existingTarget = null;
  for (const targetId of allTargetIds) {
    const lead = await findLead(targetId, candidateUserId);
    if (!lead) continue;
    const target = sequences.find((row) => row.id === targetId);
    if (lead.has_replied) return saveEnrollmentError(job, "HAS_REPLIED", `Candidate has replied in ${target?.name || targetId}`);
    if (targetId !== sequence.id) return saveEnrollmentError(job, "ALREADY_ENROLLED", `Candidate already belongs to ${target?.name || targetId}`);
    existingTarget = lead;
  }

  let current = await saveJob(transition(job, "ensuring_email", {
    submission: { ...(job.submission || {}), email },
    targetSequenceName: sequenceName,
    targetSequenceId: sequence.id,
  }), job.revision);
  try {
    await trpcPost("candidateUser.updateCandidateUserEmailForUser", { candidate_user_id: candidateUserId, email });
    if (!(await verifyCandidateEmail(candidateUserId, email))) {
      return saveEnrollmentError(current, "GLOBAL_EMAIL_NOT_VISIBLE", "Candidate email did not stick on read-back");
    }
  } catch (error) {
    if (error?.job) throw error;
    return saveEnrollmentError(current, "GLOBAL_EMAIL_WRITE_FAILED", String(error?.message || error));
  }

  let lead = existingTarget;
  if (!lead) {
    current = await saveJob(transition(current, "enrolling", { enrollClaimedAt: new Date().toISOString() }), current.revision);
    try {
      await trpcPost("campaigns.addToCampaigns", { campaign_ids: [sequence.id], candidate_user_ids: [candidateUserId] }, 1);
    } catch (error) {
      return saveEnrollmentError(current, "ENROLL_WRITE_FAILED", String(error?.message || error), { externalWriteMayHaveLanded: true });
    }
    lead = await findLead(sequence.id, candidateUserId);
    if (!lead) return saveEnrollmentError(current, "ENROLL_NOT_VISIBLE", "Enrollment returned but lead is not visible on read-back", { externalWriteMayHaveLanded: true });
  }

  current = await saveJob(transition(current, "verifying", { ccuId: lead.ccu_id }), current.revision);
  try {
    await trpcPost("campaigns.updateSequenceCandidateEmail", { campaign_to_candidate_user_id: lead.ccu_id, candidate_email: email });
    const check = await findLead(sequence.id, candidateUserId);
    if (normalizeEmail(check?.to_use_email) !== email) {
      return saveEnrollmentError(current, "LEAD_EMAIL_NOT_VISIBLE", "Lead email did not stick on read-back", { ccuId: lead.ccu_id });
    }
  } catch (error) {
    if (error?.job) throw error;
    return saveEnrollmentError(current, "LEAD_EMAIL_WRITE_FAILED", String(error?.message || error), { ccuId: lead.ccu_id });
  }

  const enrolledAt = new Date().toISOString();
  let ledgerRegistered = false;
  let registrationError = null;
  try {
    await registerLifecycleEnrollment({
      botId: job.id,
      candidate: job.candidate?.fullName,
      candidateUserId,
      ccuId: lead.ccu_id,
      email,
      sequenceId: sequence.id,
      sequenceName,
      enrolledAt,
    });
    ledgerRegistered = true;
  } catch (error) {
    registrationError = String(error?.message || error).slice(0, 240);
  }

  const saved = await saveJob(transition(current, "enrolled", {
    enrolledAt,
    ccuId: lead.ccu_id,
    targetSequenceName: sequenceName,
    targetSequenceId: sequence.id,
    ledgerRegistered,
    registrationError,
    error: registrationError ? { code: "LIFECYCLE_REGISTRATION_FAILED", detail: registrationError, at: enrolledAt } : null,
    externalWriteMayHaveLanded: false,
  }), current.revision);
  if (registrationError) throw stateError(`Enrollment succeeded, but lifecycle registration failed: ${registrationError}`, "LIFECYCLE_REGISTRATION_FAILED", saved);
  return saved;
}

export async function loadJob(id) {
  const job = await getJob(id);
  if (!job) throw stateError("job not found", "JOB_NOT_FOUND");
  return job;
}
