// Human-confirm Para AI state machine. Every external write is claimed in KV
// before it runs and performed once. Paraform accepts direct submissions
// asynchronously, so approval is reconciled read-only before match processing.

import {
  INTERNAL_NAMES,
  RECRUITER_ID,
  SEQUENCE_NAMES,
  candidateAlreadySubmitted,
  candidateDetails,
  candidateProfileInfo,
  candidatePreferences,
  directSubmitQuota,
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
  isArchiveImportCandidate,
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
import { FUNDING_ROUNDS, PARAAI_LOCATIONS, WORKPLACE_TYPES, extraNote, extractPreferences, normalizeExtraction } from "./extract.mjs";
import {
  claimSubmissionIntent,
  createJob,
  finishSubmissionAttempt,
  getJob,
  getSubmissionIntent,
  hashSubmissionPayload,
  saveJob,
  startSubmissionAttempt,
  transition,
} from "./store.mjs";

export const STATES = new Set([
  "detected", "resolving_identity", "needs_identity_review", "extracting",
  "ready_to_submit", "submit_intent", "submitting", "submission_unknown",
  "awaiting_approval", "awaiting_matches", "ready_to_enroll",
  "needs_review", "ensuring_email", "enrolling", "verifying", "enrolled",
  "no_email", "error",
]);

const ZERO_SETTLE_SECONDS = Number(process.env.PARAAI_MATCH_ZERO_SETTLE_SECONDS || 120);
const MATCH_TIMEOUT_SECONDS = Number(process.env.PARAAI_MATCH_TIMEOUT_SECONDS || 300);
const BOT_ID = /^[A-Za-z0-9_-]{8,100}$/;
export const PARAAI_SALARY_CAP = 200_000;
export const PARAAI_SALARY_ROUTING_BUFFER = 10_000;
export const VISA_SPONSORSHIP = new Set(["Available", "Not available"]);

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

const array = (value) => Array.isArray(value) ? value : [];
const uniqueAllowed = (value, allowed, transform = (item) => item) => [...new Set(array(value).map(transform).filter((item) => allowed.has(item)))];
const locationAliases = new Map([
  ["new york", "new_york"], ["new york city", "new_york"], ["nyc", "new_york"], ["new jersey", "new_york"], ["nj", "new_york"],
  ["san francisco", "san_francisco"], ["sf", "san_francisco"], ["south bay area", "south_bay_area"],
  ["los angeles", "los_angeles"], ["la", "los_angeles"], ["washington dc", "washington_dc"], ["washington d.c.", "washington_dc"],
  ...[...PARAAI_LOCATIONS].map((value) => [value.replaceAll("_", " "), value]),
]);

function legacyLocations(value) {
  return [...new Set(array(value).map((item) => locationAliases.get(String(item || "").trim().toLowerCase())).filter(Boolean))];
}

function visaFromExtraction(sponsorship = {}) {
  const statuses = array(sponsorship.statuses).map((item) => String(item).toUpperCase());
  if (sponsorship.required === true || statuses.includes("VISA")) return ["Available"];
  if (sponsorship.required === false || statuses.some((item) => ["CITIZEN", "GREEN_CARD"].includes(item))) return ["Not available"];
  return [];
}

function hasUnmappedRelocationRestriction(scope, excludedLocations) {
  const value = String(scope || "");
  if (/\b(only|would not relocate|wouldn't relocate|cannot relocate|can't relocate|not willing to relocate|not open to relocat)\b/i.test(value)) {
    return true;
  }
  return /\b(except|excluding|exclude)\b/i.test(value) && excludedLocations.size === 0;
}

function isHardSalaryFloor(compensation = {}) {
  if (compensation.baseMinIsHardFloor === true) return true;
  if (compensation.baseMinIsHardFloor === false) return false;
  const evidence = `${compensation.baseMinEvidence || ""} ${compensation.notes || ""}`;
  if (/\b(not (?:a )?hard minimum|not (?:my )?minimum|flexible|target|ideally|around|roughly|approximately)\b/i.test(evidence)) {
    return false;
  }
  return /\b(hard minimum|no lower than|won't go below|wont go below|will not go below|minimum(?: base| salary| compensation)? is|salary floor|base floor)\b/i
    .test(evidence);
}

function hasLegacyStartupOpenness(extracted = {}) {
  const interested = array(extracted.industries?.interested);
  const rejected = array(extracted.industries?.notInterested).join(" ");
  const activity = String(extracted.searchActivity || "");
  const negative = /\b(not|dont|do not|wont|wouldnt|never|avoid|exclude|rule out|no)\b[^.]{0,60}\b(startup|start-up|startups)\b/i;
  const negativeReverse = /\b(startup|start-up|startups)\b[^.]{0,45}\b(not|no|never|avoid|exclude|rule out|not for me|are not)\b/i;
  if (/\b(startup|start-up|startups)\b/i.test(rejected) || negative.test(activity) || negativeReverse.test(activity)) {
    return false;
  }
  if (interested.some((value) => /^\s*(?:open to |interested in )?start-?ups?\s*$/i.test(String(value)))) {
    return true;
  }
  return /\b(open to|would consider|will consider|interested in|okay with|fine with)\b[^.]{0,60}\b(startup|start-up|startups)\b/i
    .test(activity);
}

export function normalizeParaAIPreferences(value = {}) {
  const salary = Number(value.salaryMin);
  const ote = Number(value.ote);
  const preferences = {
    locations: uniqueAllowed(value.locations, PARAAI_LOCATIONS, (item) => String(item || "").toLowerCase()),
    workplaceTypes: uniqueAllowed(value.workplaceTypes, WORKPLACE_TYPES, (item) => String(item || "").toUpperCase()),
    idealFundingRounds: uniqueAllowed(value.idealFundingRounds, FUNDING_ROUNDS, (item) => String(item || "").toUpperCase()),
    requiresSponsorship: uniqueAllowed(value.requiresSponsorship, VISA_SPONSORSHIP, (item) => String(item || "")),
  };
  if (Number.isFinite(salary) && salary >= 0) preferences.salaryMin = Math.min(salary, PARAAI_SALARY_CAP);
  if (value.ote != null && value.ote !== "" && Number.isFinite(ote) && ote >= 0) preferences.ote = ote;
  return preferences;
}

export function buildPreferenceRouting(extracted, native = null) {
  const normalized = normalizeExtraction(extracted);
  const nativeLocations = uniqueAllowed(native?.locations, PARAAI_LOCATIONS, (item) => String(item || "").toLowerCase());
  const structuredLocations = uniqueAllowed(normalized.paraformLocations, PARAAI_LOCATIONS, (item) => String(item || "").toLowerCase());
  const legacyMappedLocations = legacyLocations(normalized.locations);
  const relocationScope = String(normalized.relocation?.scope || "").trim();
  const relocationEvidence = String(normalized.relocation?.evidence || "").trim();
  const excludedLocations = new Set(normalized.excludedParaformLocations || []);
  const expandsLocations = (
    normalized.relocation?.open === true &&
    !hasUnmappedRelocationRestriction(`${relocationScope} ${relocationEvidence}`, excludedLocations)
  );
  const allowedLocations = (value) => value.filter((location) => !excludedLocations.has(location));
  const locations = expandsLocations
    ? allowedLocations([...PARAAI_LOCATIONS])
    : structuredLocations.length
      ? allowedLocations(structuredLocations)
      : nativeLocations.length
        ? allowedLocations(nativeLocations)
        : allowedLocations(legacyMappedLocations);

  const statedBaseMin = normalized.compensation.baseMin;
  const nativeBaseMin = native?.salary_min != null && native?.salary_min !== "" && Number.isFinite(Number(native.salary_min))
    ? Number(native.salary_min)
    : null;
  const salaryWasWidened = statedBaseMin != null && isHardSalaryFloor(normalized.compensation);
  const unboundedSalaryMin = statedBaseMin != null
    ? Math.max(0, statedBaseMin - (salaryWasWidened ? PARAAI_SALARY_ROUTING_BUFFER : 0))
    : nativeBaseMin;
  const salaryMin = unboundedSalaryMin == null ? null : Math.min(unboundedSalaryMin, PARAAI_SALARY_CAP);

  const nativeOte = native?.ote != null && native?.ote !== "" && Number.isFinite(Number(native.ote))
    ? Number(native.ote)
    : null;
  const ote = normalized.compensation.ote ?? nativeOte;

  const explicitStages = uniqueAllowed(normalized.companyStages, FUNDING_ROUNDS, (item) => String(item || "").toUpperCase());
  const excludedStages = new Set(normalized.excludedCompanyStages || []);
  const nativeStages = uniqueAllowed(native?.last_funding_round, FUNDING_ROUNDS, (item) => String(item || "").toUpperCase());
  const allowedStages = (value) => value.filter((stage) => !excludedStages.has(stage));
  const startupOpen = normalized.openToStartups === true || (
    normalized.openToStartups == null &&
    hasLegacyStartupOpenness(normalized)
  );
  const expandsCompanyStages = startupOpen;
  const companyStages = expandsCompanyStages
    ? allowedStages([...FUNDING_ROUNDS])
    : explicitStages.length
      ? allowedStages(explicitStages)
      : allowedStages(nativeStages);

  const preferences = normalizeParaAIPreferences({
    locations,
    workplaceTypes: normalized.workplaceTypes.length ? normalized.workplaceTypes : native?.workplace,
    idealFundingRounds: companyStages,
    requiresSponsorship: visaFromExtraction(normalized.sponsorship).length ? visaFromExtraction(normalized.sponsorship) : native?.visa,
    salaryMin,
    ...(ote != null ? { ote } : {}),
  });
  return {
    preferences,
    policy: {
      locationSource: expandsLocations
        ? "relocation_expansion"
        : structuredLocations.length
          ? "screening_call"
          : nativeLocations.length
            ? "paraform_profile"
            : "legacy_mapping",
      locationsExpanded: expandsLocations,
      companyStageSource: expandsCompanyStages
        ? "startup_expansion"
        : explicitStages.length
          ? "screening_call"
          : "paraform_profile",
      companyStagesExpanded: expandsCompanyStages,
      candidateStatedBaseMin: statedBaseMin,
      routedSalaryMin: preferences.salaryMin ?? null,
      salaryRoutingBuffer: salaryWasWidened ? PARAAI_SALARY_ROUTING_BUFFER : 0,
      salaryWasWidened,
      salaryWasCapped: unboundedSalaryMin != null && unboundedSalaryMin > PARAAI_SALARY_CAP,
    },
  };
}

export function buildPreferences(extracted, native = null) {
  return buildPreferenceRouting(extracted, native).preferences;
}

export function missingRequiredPreferences(preferences = {}) {
  const normalized = normalizeParaAIPreferences(preferences);
  const missing = [];
  if (!normalized.locations.length) missing.push("locations");
  if (!normalized.workplaceTypes.length) missing.push("workplace types");
  if (!normalized.idealFundingRounds.length) missing.push("company stages");
  if (!Number.isFinite(Number(normalized.salaryMin))) missing.push("minimum base salary");
  if (!normalized.requiresSponsorship.length) missing.push("visa sponsorship");
  if (normalized.ote != null && normalized.ote < normalized.salaryMin) missing.push("OTE (must be at least minimum base salary)");
  return missing;
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

export async function prepareJob({ botId, candidateUserId = "", force = false, strictReads = false } = {}) {
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
      callStartedAt: call.joinAt || null,
      callSourceVerified: call?.source?.isScreener === true,
    };
    if (!existing) await createJob(base);
    const current = existing || await getJob(id);
    return fail(current, "NOT_SUCCESSFUL_SCREEN", "Only successful screening calls can enter Para AI");
  }

  let job;
  if (existing) {
    job = await saveJob(transition(existing, "resolving_identity", {
      candidate, callLink: callLink(id), error: null, journalDetail: "manual re-prepare",
      callStartedAt: call.joinAt || existing.callStartedAt || null,
      callSourceVerified: call?.source?.isScreener === true,
    }), existing.revision);
  } else {
    job = await createJob({
      id,
      state: "resolving_identity",
      candidate,
      callLink: callLink(id),
      callStartedAt: call.joinAt || null,
      callSourceVerified: call?.source?.isScreener === true,
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
    const reads = [
      getResume(crmItem.id),
      candidateDetails(crmItem.id, { strict: strictReads }),
      candidatePreferences(crmItem.id, { strict: strictReads }),
      candidateProfileInfo(crmItem.id),
    ];
    const [resume, details, nativePreferences, profileInfo] = await Promise.all(strictReads
      ? reads
      : [
          reads[0].catch(() => null),
          reads[1].catch(() => ({ byId: null, profile: null })),
          reads[2].catch(() => null),
          reads[3].catch(() => null),
        ]);
    if (isArchiveImportCandidate(crmItem, details, profileInfo)) {
      return fail(
        job,
        "ARCHIVE_IMPORT_EXCLUDED",
        "Historical archive imports are excluded from Para AI automation",
      );
    }
    const resumeUri = findResumeUri(resume);
    const contact = resumeUri ? await resumeContact(resumeUri).catch(() => null) : null;
    const email = firstEmail(crmItem) || firstEmail(details) || firstEmail(contact);
    const linkedin = candidate.linkedin || normLinkedin(contact?.linkedinUrl || crmItem?.linkedin_user);
    const extracted = extraction.extracted;
    const routing = buildPreferenceRouting(extracted, nativePreferences);
    const reviewPreferences = routing.preferences;
    const statedBaseMin = extracted.compensation?.baseMin ?? null;
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
      reviewPreferences,
      reviewPolicy: {
        salaryCap: PARAAI_SALARY_CAP,
        candidateStatedBaseMin: statedBaseMin,
        candidateStatedBaseMax: extracted.compensation?.baseMax ?? null,
        ...routing.policy,
      },
      extraNote: extraNote(extracted),
      extraction: { provider: extraction.provider, model: extraction.model, usage: extraction.usage, at: new Date().toISOString() },
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
    reviewPreferences: normalizeParaAIPreferences(body.preferences || job.reviewPreferences || buildPreferences(extracted)),
    extraNote: extraNote(extracted),
    submission: {
      ...(job.submission || {}),
      ...(body.name != null ? { name: String(body.name).trim() } : {}),
      ...(body.email != null ? { email: normalizeEmail(body.email) } : {}),
      ...(body.linkedinUrl != null ? { linkedinUrl: normLinkedin(body.linkedinUrl) } : {}),
      ...(body.resumeUri != null ? { resumeUri: String(body.resumeUri).trim() } : {}),
      ...(body.screeningCallLink != null ? { screeningCallLink: String(body.screeningCallLink).trim() } : {}),
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

async function submissionIsVisible(candidateUserId) {
  const [details, crm] = await Promise.all([
    candidateDetails(candidateUserId, { strict: true }),
    findCrmCandidate(candidateUserId),
  ]);
  return candidateAlreadySubmitted(details) || candidateAlreadySubmitted(crm);
}

export function buildSubmissionPayload(job, config = paraAIConfig()) {
  return {
    name: String(job?.submission?.name || "").trim(),
    email: normalizeEmail(job?.submission?.email),
    linkedinUrl: normLinkedin(job?.submission?.linkedinUrl),
    screeningCallLink: String(job?.submission?.screeningCallLink || "").trim(),
    resumeUri: String(job?.submission?.resumeUri || "").trim(),
    preferences: normalizeParaAIPreferences(job?.reviewPreferences || {}),
    recruiterId: RECRUITER_ID,
    submissionOrigin: config.submissionOrigin,
  };
}

export async function submitJob(job, body = {}) {
  if (!["ready_to_submit", "submit_intent", "submitting"].includes(job?.state)) throw stateError("job is not ready to submit", "INVALID_STATE", job);
  if (String(body.confirmation || "") !== `SUBMIT ${job.id}`) throw stateError("submit confirmation mismatch", "CONFIRMATION_MISMATCH", job);
  if (body.marketConfirmed !== true) throw stateError("Confirm that you screened this candidate and they are actively on the market", "MARKET_CONFIRMATION_REQUIRED", job);
  const config = paraAIConfig();
  if (!config.submitApproved) throw stateError("PARAAI_SUBMIT_APPROVED is false", "SUBMIT_APPROVAL_REQUIRED", job);
  if (config.dryRun) throw stateError("PARAAI_DRY_RUN must be explicitly false", "DRY_RUN", job);
  if (!config.submissionOriginPinned) throw stateError("Phase 0 must pin PARAAI_SUBMISSION_ORIGIN", "PHASE0_ORIGIN_REQUIRED", job);
  if (INTERNAL_NAMES.has(normName(job.candidate?.fullName))) throw stateError("internal-name skip list", "INTERNAL_CANDIDATE", job);

  let edited = mergeEdits(job, body);
  const preferences = edited.reviewPreferences;
  const missingPreferences = missingRequiredPreferences(preferences);
  if (missingPreferences.length) {
    throw stateError(
      `The screening call did not provide every preference Para AI requires. Add: ${missingPreferences.join(", ")}.`,
      "PREFERENCES_REQUIRED",
      edited,
    );
  }
  edited = await applyResumeUpload(edited, body);
  const submission = edited.submission || {};
  if (!submission.name || !normalizeEmail(submission.email) || !normLinkedin(submission.linkedinUrl) || !submission.resumeUri) {
    throw stateError("name, non-Paraform email, LinkedIn, and resume are required", "SUBMISSION_FIELDS_REQUIRED", edited);
  }
  if (submission.screeningCallLink) {
    try {
      const url = new URL(submission.screeningCallLink);
      if (!new Set(["http:", "https:"]).has(url.protocol)) throw new Error("invalid protocol");
    } catch {
      throw stateError("screening call link must be a valid http(s) URL", "INVALID_CALL_LINK", edited);
    }
  }
  const candidateUserId = edited.identity?.candidateUserId;
  const freshCrm = await findCrmCandidate(candidateUserId);
  const [details, profileInfo] = await Promise.all([
    candidateDetails(candidateUserId, { strict: true }),
    candidateProfileInfo(candidateUserId),
  ]);
  if (!freshCrm) throw stateError("candidate identity no longer resolves in CRM", "IDENTITY_STALE", job);
  if (isArchiveImportCandidate(freshCrm, details, profileInfo)) {
    return fail(
      job,
      "ARCHIVE_IMPORT_EXCLUDED",
      "Historical archive imports are excluded from Para AI automation",
    );
  }
  if (candidateAlreadySubmitted(freshCrm) || candidateAlreadySubmitted(details)) {
    return fail(job, "ALREADY_SUBMITTED", "Candidate is already in the Para AI talent network");
  }
  if (hasFutureScheduledStep(details)) return fail(job, "FUTURE_NEXT_STEP", "Candidate has a future scheduled next step");
  const membership = await targetMembership(candidateUserId);
  if (membership.memberships.some(({ lead }) => lead?.has_replied)) return fail(job, "HAS_REPLIED", "Candidate has replied in a target sequence");
  if (membership.memberships.length) return fail(job, "ALREADY_ENROLLED", `Candidate already belongs to ${membership.memberships[0].sequence.name}`);
  const quota = await directSubmitQuota(RECRUITER_ID);
  if (quota?.isAtLimit === true) {
    throw stateError(`Paraform direct-submit quota reached (${quota.used}/${quota.limit}). ${quota.resetLabel || ""}`.trim(), "DIRECT_SUBMIT_QUOTA_REACHED", edited);
  }

  const payload = buildSubmissionPayload({
    ...edited,
    submission: { ...submission, email: normalizeEmail(submission.email), linkedinUrl: normLinkedin(submission.linkedinUrl) },
  }, config);
  const payloadHash = hashSubmissionPayload(payload);
  const intentResult = await claimSubmissionIntent({
    candidateUserId,
    jobId: job.id,
    payloadHash,
  });
  let intent = intentResult.intent;
  if (intent.attemptStartedAt) {
    throw stateError(
      "A submission attempt already started for this candidate. Reconcile read-only; never retry the write.",
      "SUBMISSION_ATTEMPT_ALREADY_STARTED",
      job,
    );
  }
  if (job.state === "ready_to_submit") {
    edited = await saveJob(transition(edited, "submit_intent", {
      submission: { ...submission, email: payload.email, linkedinUrl: payload.linkedinUrl },
      submitClaimedAt: intent.claimedAt,
      submitAttemptId: intent.attemptId,
      submitPayloadHash: payloadHash,
      submitApprovalSource: String(body.approvalSource || "human_review").slice(0, 80),
      journalDetail: "durable candidate submission intent claimed",
    }), job.revision);
  } else {
    if (job.submitPayloadHash && job.submitPayloadHash !== payloadHash) {
      throw stateError("submission payload changed after intent was claimed", "SUBMISSION_PAYLOAD_CHANGED", job);
    }
    edited = job;
  }
  edited = await saveJob(transition(edited, "submitting", {
    journalDetail: "single external submit attempt reserved",
  }), edited.revision);
  const started = await startSubmissionAttempt({
    candidateUserId,
    jobId: job.id,
    attemptId: intent.attemptId,
  });
  if (started.status !== "started") {
    throw stateError(
      "A submission attempt already started for this candidate. Reconcile read-only; never retry the write.",
      "SUBMISSION_ATTEMPT_ALREADY_STARTED",
      edited,
    );
  }
  intent = started.intent;
  let response;
  try {
    response = await trpcPost("agency.submitTalentNetworkCandidate", payload, 1);
  } catch (error) {
    await finishSubmissionAttempt({
      candidateUserId,
      jobId: job.id,
      attemptId: intent.attemptId,
      outcome: "unknown",
      detail: String(error?.code || error?.message || "submit transport failed"),
    }).catch(() => {});
    const saved = await saveJob(transition(edited, "submission_unknown", {
      error: {
        code: "SUBMIT_WRITE_UNKNOWN",
        detail: "Paraform submission result is unknown; reads only until reconciled",
        at: new Date().toISOString(),
      },
      externalWriteMayHaveLanded: true,
      submitAttemptStartedAt: intent.attemptStartedAt,
      journalDetail: "external submit result unknown; mutation retry prohibited",
    }), edited.revision);
    throw stateError("Submission result is unknown. Reconcile read-only; do not retry.", "SUBMIT_WRITE_UNKNOWN", saved);
  }
  await finishSubmissionAttempt({
    candidateUserId,
    jobId: job.id,
    attemptId: intent.attemptId,
    outcome: "accepted",
    detail: "Paraform mutation returned successfully",
  });
  return saveJob(transition(edited, "awaiting_approval", {
    submittedAt: new Date().toISOString(),
    submitAcceptedAt: new Date().toISOString(),
    submitAttemptStartedAt: intent.attemptStartedAt,
    submitReadbackVerified: candidateAlreadySubmitted(response),
    externalWriteMayHaveLanded: false,
    matchCount: null,
    error: null,
    journalDetail: "Paraform accepted submission; approval pending",
  }), edited.revision);
}

export async function reconcileSubmittedJob(job) {
  const legacyAccepted = job?.state === "error" && job?.error?.code === "SUBMIT_NOT_VISIBLE";
  const uncertainWrite =
    job?.state === "submission_unknown" ||
    job?.state === "submitting" ||
    (job?.state === "error" && ["SUBMIT_WRITE_FAILED", "SUBMIT_WRITE_UNKNOWN"].includes(job?.error?.code));
  if (job?.state !== "awaiting_approval" && !legacyAccepted && !uncertainWrite) {
    throw stateError("job is not awaiting submission reconciliation", "INVALID_STATE", job);
  }
  const candidateUserId = job.identity?.candidateUserId;
  if (!candidateUserId) throw stateError("candidate identity is missing", "IDENTITY_REQUIRED", job);
  const checkedAt = new Date().toISOString();
  const visible = await submissionIsVisible(candidateUserId);
  if (visible) {
    const intent = await getSubmissionIntent(candidateUserId).catch(() => null);
    if (intent?.attemptId && intent?.jobId === job.id) {
      await finishSubmissionAttempt({
        candidateUserId,
        jobId: job.id,
        attemptId: intent.attemptId,
        outcome: "confirmed",
        detail: "Talent Network state visible on read-back",
      }).catch(() => {});
    }
    return saveJob(transition(job, "awaiting_matches", {
      submittedAt: job.submittedAt || job.submitClaimedAt || checkedAt,
      submitAcceptedAt: job.submitAcceptedAt || job.submitClaimedAt || checkedAt,
      submissionApprovalCheckedAt: checkedAt,
      submitReadbackVerified: true,
      externalWriteMayHaveLanded: false,
      matchCount: null,
      error: null,
      journalDetail: "Paraform submission verified",
    }), job.revision);
  }
  if (uncertainWrite) {
    return saveJob(transition(job, "submission_unknown", {
      submissionApprovalCheckedAt: checkedAt,
      submitReadbackVerified: false,
      externalWriteMayHaveLanded: true,
      error: {
        code: "SUBMIT_STILL_UNCONFIRMED",
        detail: "Submission is not visible yet; reads only and no mutation retry",
        at: checkedAt,
      },
      journalDetail: "uncertain submit remains unconfirmed; read-only retry scheduled",
    }), job.revision);
  }
  return saveJob(transition(job, "awaiting_approval", {
    submittedAt: job.submittedAt || job.submitClaimedAt || checkedAt,
    submitAcceptedAt: job.submitAcceptedAt || job.submitClaimedAt || checkedAt,
    submissionApprovalCheckedAt: checkedAt,
    submitReadbackVerified: false,
    externalWriteMayHaveLanded: false,
    error: null,
    journalDetail: "Paraform approval still pending",
  }), job.revision);
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
