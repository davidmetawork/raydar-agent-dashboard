import { trpcGet, trpcPost, normalizeEmail, paraformRest } from "./core.mjs";
import {
  buildMime,
  deliverMessage,
  deterministicMessageId,
  gmailConfigured,
  outreachMailbox,
} from "./outreach-gmail.mjs";
import {
  OUTCOME_SEQUENCE_RULES,
} from "../../roster/_lib/outcome-sequences.mjs";
import { buildInterestConfirmation, firstNameFor, COPY_VARIANT } from "./interest-copy.mjs";
import { runSubmissionEvidencePreflight } from "./interest-preflight.mjs";
import {
  buildSingleSubmissionPrepareInput,
  executeCapturedSingleSubmission,
  generateGroundedSubmissionDraft,
  parseSingleSubmissionPrepareResponse,
  precheckCapturedSingleSubmissionContext,
  singleSubmissionWeekStart,
} from "./interest-submission.mjs";
import {
  storeConfigured,
  getSnapshot,
  putSnapshot,
  diffInterest,
  getJob,
  saveJob,
  createJob,
  listPendingJobs,
  claimSubmission,
  claimSubmissionAttempt,
  startSubmissionAttempt,
  recordSubmissionPrepared,
  recordSubmissionOutcome,
  getSubmissionClaim,
  claimEmail,
  confirmEmail,
  getEmailClaim,
  acquireLock,
  releaseLock,
  recordReview,
  recordSweep,
  getSweepState,
  appendJournal,
} from "./interest-store.mjs";

// Curated-list interest to submission.
//
// Contract: docs/PARAAI-CAPTURE-CURATED-INTEREST-2026-07-28.md
// Plan:     docs/PLAN-CURATED-INTEREST-TO-SUBMISSION-2026-07-28.md
//
// SAFETY. Every write is gated and every gate defaults closed. Ordering is
// code-enforced (email needs stop; submit needs both) so we can never promise a
// candidate something the lane is not actually armed to do.

export const INTEREST_STATUS = Object.freeze({
  PENDING: "PENDING",
  APPLIED: "APPLIED_TO_ROLE",
  NOT_INTERESTED: "NOT_INTERESTED",
});

// Current submit-form bundle constant. Passing [] makes
// hasUserInputPreferences trivially succeed even when the profile is empty.
export const REQUIRED_CANDIDATE_PREFERENCE_FIELDS = Object.freeze([
  "locations",
  "salary_min",
  "workplace",
  "last_funding_round",
  "visa",
]);

const TRUE = new Set(["1", "true", "yes", "on"]);
const flag = (name, env = process.env) => TRUE.has(String(env[name] ?? "").trim().toLowerCase());
const uniqueReasonCodes = (...values) => [...new Set(
  values.flat().filter((value) => typeof value === "string" && value.trim()),
)];

export function interestConfig(env = process.env) {
  const enabled = flag("PARAAI_INTEREST_ENABLED", env);
  // Dry run defaults TRUE. Only an explicit falsey value turns it off.
  const raw = String(env.PARAAI_INTEREST_DRY_RUN ?? "").trim().toLowerCase();
  const dryRun = raw === "" ? true : !["0", "false", "no", "off"].includes(raw);
  const notBeforeRaw = String(env.PARAAI_INTEREST_NOT_BEFORE || "").trim();
  const notBefore = notBeforeRaw ? Date.parse(notBeforeRaw) : NaN;

  const stopArmed = flag("PARAAI_INTEREST_STOP_APPROVED", env);
  const emailArmedRaw = flag("PARAAI_INTEREST_EMAIL_APPROVED", env);
  const submitArmedRaw = flag("PARAAI_INTEREST_SUBMIT_APPROVED", env);
  const emailCanaryTo = normalizeEmail(env.PARAAI_INTEREST_EMAIL_CANARY_TO || "");

  // Code-enforced gate ordering.
  const emailArmed = emailArmedRaw && stopArmed;
  const submitArmed = submitArmedRaw && stopArmed && emailArmedRaw;

  return {
    enabled,
    dryRun,
    notBefore: Number.isFinite(notBefore) ? notBefore : null,
    notBeforeConfigured: Boolean(notBeforeRaw) && Number.isFinite(notBefore),
    stopArmed,
    emailArmed,
    submitArmed,
    emailCanaryTo: emailCanaryTo || null,
    gateOrderViolations: [
      emailArmedRaw && !stopArmed ? "EMAIL_APPROVED requires STOP_APPROVED" : null,
      submitArmedRaw && !(stopArmed && emailArmedRaw) ? "SUBMIT_APPROVED requires STOP_APPROVED and EMAIL_APPROVED" : null,
    ].filter(Boolean),
    writesEnabled: enabled && !dryRun,
    sweepConcurrency: Math.max(1, Math.min(6, Number(env.PARAAI_INTEREST_CONCURRENCY || 4))),
    sweepBatchSize: Math.max(
      1,
      Math.min(120, Number(env.PARAAI_INTEREST_SWEEP_BATCH || 100)),
    ),
    sweepIntervalMs: Math.max(
      60_000,
      Number(env.PARAAI_INTEREST_SWEEP_INTERVAL_MS || 15 * 60 * 1000),
    ),
    batchWindowMs: Math.max(0, Number(env.PARAAI_INTEREST_BATCH_WINDOW_MS ?? 30 * 60 * 1000)),
  };
}

export function interestEmailPlan({
  config,
  paraformOwnsConfirmation = false,
} = {}) {
  if (paraformOwnsConfirmation) {
    return {
      send: false,
      skipped: "paraform_confirmation_owns_candidate_email",
      apply: false,
      canaryTo: null,
    };
  }
  const canaryPhase = config?.emailArmed === true && config?.submitArmed !== true;
  if (canaryPhase && !config?.emailCanaryTo) {
    return {
      send: false,
      skipped: "canary_recipient_required",
      apply: false,
      canaryTo: null,
    };
  }
  return {
    send: true,
    skipped: null,
    apply: config?.writesEnabled === true && config?.emailArmed === true,
    canaryTo: canaryPhase ? config.emailCanaryTo : null,
  };
}

/* ------------------------------------------------------------------- reads */

/** The eligible population: candidates who were actually sent a curated list. */
export async function listCuratedListCandidates() {
  const rows = (await trpcGet("curatedRoleList.getCandidates", {})) || [];
  return rows
    .filter((r) => Array.isArray(r?.recruiter_role_list_ids) && r.recruiter_role_list_ids.length > 0)
    .map((r) => ({
      candidateUserId: r.id,
      candidateId: r.candidate_id,
      name: r.name || null,
      email: r.email || null,
      listIds: r.recruiter_role_list_ids,
    }));
}

/** Per-candidate role interest. Returns a {role_id: status} map. */
export async function readInterestStatuses(candidateUserId) {
  const rows = (await trpcGet("applicantInterest.getCuratedListRoleStatuses", {
    candidate_user_id: candidateUserId,
  })) || [];
  const map = {};
  for (const row of rows) {
    if (row?.role_id) map[row.role_id] = String(row.status || "").toUpperCase();
  }
  return map;
}

export async function readInterestCounts(candidateUserId) {
  return (await trpcGet("applicantInterest.getCuratedListInterestCounts", {
    candidate_user_id: candidateUserId,
  })) || null;
}

/** Weekly single-submission credit position. */
export async function readSubmissionCredits(now = new Date()) {
  const weekStart = singleSubmissionWeekStart(now);
  const data = await trpcGet("roleSlots.getMySingleSubmissionData", { weekStart });
  if (!data) return null;
  const usedThisWeek = Number(data.recentSingleSubmissionsThisWeekCount || 0);
  const allowance = Number(data.previousAllowance || 0);
  const earnedBack = Number(data.earnedBackThisWeekCount || 0);
  return {
    weekStart,
    usedThisWeek,
    allowance,
    earnedBack,
    available: Math.max(0, allowance + earnedBack - usedThisWeek),
    interviewed: Number(data.interviewedCount || 0),
    total: Number(data.totalSingleSubmissions || 0),
  };
}

/* --------------------------------------------------------------- detection */

async function mapWithConcurrency(items, limit, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      try { out[i] = await fn(items[i], i); }
      catch (error) { out[i] = { __error: String(error?.message || error).slice(0, 200) }; }
    }
  });
  await Promise.all(workers);
  return out;
}

export function interestSweepComplete({
  populationSize,
  candidatesRead,
  readErrors,
}) {
  const population = Number(populationSize);
  const read = Number(candidatesRead);
  return Number.isSafeInteger(population)
    && population > 0
    && Number.isSafeInteger(read)
    && read === population
    && Number(readErrors) === 0;
}

export function interestSweepWindow({
  populationSize,
  batchSize,
  priorSweep,
}) {
  const population = Math.max(0, Number(populationSize) || 0);
  const size = Math.max(1, Math.min(120, Number(batchSize) || 100));
  const continuing = priorSweep?.cycleComplete === false
    && Number(priorSweep?.populationSize) === population
    && Number.isSafeInteger(Number(priorSweep?.nextCursor))
    && Number(priorSweep.nextCursor) >= 0
    && Number(priorSweep.nextCursor) < population;
  const start = continuing ? Number(priorSweep.nextCursor) : 0;
  return {
    continuing,
    start,
    end: Math.min(population, start + size),
  };
}

/**
 * One sweep. Reads every curated-list candidate's interest statuses, diffs
 * against the stored snapshot, and returns the candidates with NEW interest.
 *
 * First sight of a candidate seeds their snapshot and never acts, which is what
 * makes arming forward-only: the ~27 rows already sitting at APPLIED_TO_ROLE do
 * not fire on the first run.
 */
export async function sweepInterest({ config = interestConfig(), now = Date.now() } = {}) {
  const started = Date.now();
  const result = {
    ok: false,
    populationSize: 0,
    candidatesRead: 0,
    readErrors: 0,
    seeded: 0,
    detected: [],
    declined: 0,
    skippedBeforeCutoff: 0,
    durationMs: 0,
  };

  const priorSweep = await getSweepState().catch(() => null);
  const population = (await listCuratedListCandidates())
    .sort((left, right) => String(left.candidateUserId || "")
      .localeCompare(String(right.candidateUserId || "")));
  result.populationSize = population.length;
  const window = interestSweepWindow({
    populationSize: population.length,
    batchSize: config.sweepBatchSize,
    priorSweep,
  });
  const batch = population.slice(window.start, window.end);
  result.cursorStart = window.start;
  result.cursorEnd = window.end;
  result.cycleStartedAt = window.continuing
    ? priorSweep.cycleStartedAt
    : new Date(now).toISOString();
  Object.defineProperty(result, "candidateByUserId", {
    value: new Map(population.map((candidate) => [candidate.candidateUserId, candidate])),
    enumerable: false,
  });
  const reads = await mapWithConcurrency(batch, config.sweepConcurrency, async (c) => {
    const statuses = await readInterestStatuses(c.candidateUserId);
    return { candidate: c, statuses };
  });

  for (const read of reads) {
    if (!read || read.__error) { result.readErrors++; continue; }
    result.candidatesRead++;
    const { candidate, statuses } = read;
    const prior = await getSnapshot(candidate.candidateUserId);
    const diff = diffInterest(prior, statuses);

    if (diff.firstSight) {
      await putSnapshot(candidate.candidateUserId, statuses, { seeded: true });
      result.seeded++;
      continue;
    }

    result.declined += diff.declined.length;

    if (diff.newlyInterested.length) {
      // Forward-only: nothing before the pinned cutoff is ever acted on.
      if (config.notBefore && now < config.notBefore) {
        result.skippedBeforeCutoff += diff.newlyInterested.length;
      } else {
        const existing = await getJob(candidate.candidateUserId);
        if (existing && existing.stage !== "done") {
          const added = diff.newlyInterested.filter(
            (roleId) => !(Array.isArray(existing.roles) ? existing.roles : []).includes(roleId),
          );
          await saveJob(appendJournal({
            ...existing,
            candidateId: existing.candidateId || candidate.candidateId,
            roles: [...new Set([...(existing.roles || []), ...diff.newlyInterested])],
          }, "more_interest", { added: added.length }));
        } else {
          await createJob(candidate.candidateUserId, {
            candidateId: candidate.candidateId,
            roles: diff.newlyInterested,
          });
        }
        result.detected.push({ candidate, roleIds: diff.newlyInterested, statuses });
      }
    }
    await putSnapshot(candidate.candidateUserId, statuses);
  }

  // A batch advances only if every row read successfully. Successfully read
  // rows still seed/update independently, but a partial batch is retried from
  // the same stable cursor. This keeps Paraform below its observed request
  // ceiling without ever calling a partial population scan healthy.
  const batchComplete = interestSweepComplete({
    populationSize: batch.length,
    candidatesRead: result.candidatesRead,
    readErrors: result.readErrors,
  });
  const priorAdvanced = window.continuing
    ? Math.max(0, Number(priorSweep?.cycleCandidatesRead) || 0)
    : 0;
  const priorSeeded = window.continuing
    ? Math.max(0, Number(priorSweep?.cycleSeeded) || 0)
    : 0;
  const priorDetected = window.continuing
    ? Math.max(0, Number(priorSweep?.cycleDetected) || 0)
    : 0;
  const priorAttemptErrors = window.continuing
    ? Math.max(0, Number(priorSweep?.cycleAttemptReadErrors) || 0)
    : 0;
  result.cycleCandidatesRead = priorAdvanced + (batchComplete ? batch.length : 0);
  result.cycleSeeded = priorSeeded + result.seeded;
  result.cycleDetected = priorDetected + result.detected.length;
  result.cycleAttemptReadErrors = priorAttemptErrors + result.readErrors;
  result.cycleComplete = batchComplete
    && window.end === population.length;
  result.nextCursor = result.cycleComplete
    ? 0
    : batchComplete
      ? window.end
      : window.start;
  result.ok = result.cycleComplete
    && interestSweepComplete({
      populationSize: population.length,
      candidatesRead: result.cycleCandidatesRead,
      readErrors: 0,
    });
  result.durationMs = Date.now() - started;
  await recordSweep({
    ok: result.ok,
    populationSize: result.populationSize,
    cursorStart: result.cursorStart,
    cursorEnd: result.cursorEnd,
    nextCursor: result.nextCursor,
    cycleStartedAt: result.cycleStartedAt,
    cycleComplete: result.cycleComplete,
    cycleCandidatesRead: result.cycleCandidatesRead,
    cycleSeeded: result.cycleSeeded,
    cycleDetected: result.cycleDetected,
    cycleAttemptReadErrors: result.cycleAttemptReadErrors,
    candidatesRead: result.candidatesRead,
    readErrors: result.readErrors,
    seeded: result.seeded,
    detected: result.detected.length,
    durationMs: result.durationMs,
  });
  return result;
}

/* -------------------------------------------------------------------- stop */

export function curatedListSequenceIds() {
  return OUTCOME_SEQUENCE_RULES.map((r) => r.id);
}

function leadEmail(lead) {
  return normalizeEmail(
    lead?.to_use_email
    || lead?.candidate_email
    || lead?.email
    || "",
  );
}

async function exactSequenceLead({
  sequenceId,
  candidateUserId,
  email,
  trpcGetImpl,
}) {
  const searches = [...new Set([candidateUserId, email].filter(Boolean))];
  for (const search of searches) {
    const response = await trpcGetImpl(
      "campaigns.getCampaignLeads",
      { campaign_id: sequenceId, search },
      1,
    );
    const leads = Array.isArray(response?.leads) ? response.leads : [];
    const byId = leads.find(
      (lead) => String(lead?.cu_id || lead?.candidate_user_id || "") ===
        String(candidateUserId || ""),
    );
    if (byId) return byId;
    const byEmail = leads.find(
      (lead) => email && leadEmail(lead) === email,
    );
    if (byEmail) return byEmail;
  }
  return null;
}

/**
 * Pause every active lead for this candidate across the curated-list sequence
 * family. Pause only, never remove, never unpause: a false positive costs one
 * reversible pause, a false negative keeps nudging someone who just said yes.
 */
export async function stopFollowUps({
  candidate,
  apply,
  sequenceIds = curatedListSequenceIds(),
  trpcGetImpl = trpcGet,
  trpcPostImpl = trpcPost,
}) {
  const email = normalizeEmail(candidate.email || "");
  const out = { attempted: 0, paused: 0, alreadyPaused: 0, notFound: 0, errors: [], verified: [] };
  if (!candidate?.candidateUserId) {
    out.errors.push("stop_candidate_identity_missing");
    return out;
  }
  if (!email) { out.errors.push("stop_deliverable_email_missing"); return out; }

  for (const sequenceId of sequenceIds) {
    let lead = null;
    try {
      lead = await exactSequenceLead({
        sequenceId,
        candidateUserId: candidate.candidateUserId,
        email,
        trpcGetImpl,
      });
    } catch {
      out.errors.push(`${sequenceId}:stop_read_failed`);
      continue;
    }
    if (!lead) { out.notFound++; continue; }
    if (lead.is_paused) { out.alreadyPaused++; continue; }
    if (lead.is_archived) continue;
    if (!lead.ccu_id) {
      out.errors.push(`${sequenceId}:stop_lead_identity_missing`);
      continue;
    }

    out.attempted++;
    if (!apply) continue;

    try {
      await trpcPostImpl("campaigns.updateCandidatePauseStatus", {
        campaign_to_candidate_user_id: lead.ccu_id,
        is_paused: true,
      }, 1);
    } catch {
      out.errors.push(`${sequenceId}:stop_pause_failed`);
      continue;
    }

    // A 200 is not success. Re-read the row.
    try {
      const after = await exactSequenceLead({
        sequenceId,
        candidateUserId: candidate.candidateUserId,
        email,
        trpcGetImpl,
      });
      if (
        after?.ccu_id === lead.ccu_id
        && after?.is_paused === true
      ) {
        out.paused++;
        out.verified.push(sequenceId);
      } else {
        out.errors.push(`${sequenceId}:stop_readback_unverified`);
      }
    } catch {
      out.errors.push(`${sequenceId}:stop_readback_failed`);
    }
  }
  return out;
}

/* ------------------------------------------------------------------- email */

/**
 * The real Gmail mailer, sending as David through the delegated service
 * account. Kept as a factory so tests and dry runs pass their own.
 *
 * The Message-ID is deterministic per (candidate, batch): a rebuilt job that
 * replays this send reconciles against the already-delivered message instead of
 * sending a second copy.
 */
export function gmailMailer({ mailbox = outreachMailbox() } = {}) {
  return async ({ to, subject, text, html, candidate }) => {
    const actionKey = `interest:${candidate.candidateUserId}:${candidate.batchId || subject}`;
    const messageId = deterministicMessageId(actionKey);
    const mime = buildMime({
      from: `David Phillips <${mailbox}>`,
      to,
      subject,
      messageId,
      bodyText: text,
      bodyHtml: html,
    });
    const delivered = await deliverMessage({ mailbox, message: { ...mime, messageId } });
    return { messageId, delivery: delivered?.delivery || null, id: delivered?.id || null };
  };
}

/**
 * Confirmation email as David. Claim-before-send: the outbox claim is taken
 * before Gmail is called, so a crash mid-send can never produce a second copy.
 *
 * Ordering (plan §6): this runs after the stop lands and after the submission is
 * claimed and pre-flighted, never after the submit round trip.
 */
export async function sendConfirmation({
  candidate,
  roleCount,
  batchId,
  apply,
  mailer = null,
  canaryTo = null,
  emailStore = { getEmailClaim, claimEmail, confirmEmail },
}) {
  const out = { sent: false, skipped: null, messageId: null };
  const firstName = firstNameFor(candidate.name);
  if (!firstName) { out.skipped = "unusable_first_name"; return out; }
  const canaryEmail = normalizeEmail(canaryTo || "");
  const email = canaryEmail || normalizeEmail(candidate.email || "");
  if (!email) { out.skipped = "no_deliverable_email"; return out; }
  const canary = Boolean(canaryEmail);
  const claimCandidateUserId = canary
    ? "__curated_interest_email_canary__"
    : candidate.candidateUserId;
  const claimBatchId = canary ? COPY_VARIANT : batchId;

  const existing = await emailStore.getEmailClaim(claimCandidateUserId, claimBatchId);
  if (existing?.deliveredAt) { out.skipped = "already_delivered"; return out; }

  const message = buildInterestConfirmation({ firstName, roleCount });
  if (!apply) { out.skipped = "dry_run"; out.preview = message; return out; }

  const won = await emailStore.claimEmail(claimCandidateUserId, claimBatchId, {
    variant: COPY_VARIANT,
    recipient: canary ? "canary" : "candidate",
  });
  if (!won) {
    out.skipped = existing ? "delivery_unknown" : "claim_lost";
    return out;
  }

  if (!mailer) { out.skipped = "mailer_unavailable"; return out; }
  const delivered = await mailer({
    to: email,
    ...message,
    candidate: {
      ...candidate,
      candidateUserId: claimCandidateUserId,
      batchId: claimBatchId,
    },
  });
  await emailStore.confirmEmail(claimCandidateUserId, claimBatchId, {
    messageId: delivered?.messageId || null,
  });
  out.sent = true;
  out.canary = canary;
  out.messageId = delivered?.messageId || null;
  return out;
}

/* ------------------------------------------------------------------ submit */

/**
 * Pre-flight. Everything that would make Paraform reject the submit, checked
 * before we spend the single attempt (and the credit).
 *
 * "Err looser" governs scorecard marking, not whether to submit. Step 0
 * therefore combines structural blockers with evidence-backed hold signals
 * before a credit or permanent claim is spent.
 */
export async function preflightSubmission({
  candidate,
  roleId,
  credits,
  trpcGetImpl = trpcGet,
  now = Date.now(),
  directInterestConfirmed = true,
}) {
  const blockers = [];
  if (!candidate.candidateUserId) blockers.push("missing_candidate_user_id");
  if (!candidate.candidateId) blockers.push("missing_candidate_id");
  if (!normalizeEmail(candidate.email || "")) blockers.push("no_deliverable_email");
  if (!firstNameFor(candidate.name)) blockers.push("unusable_name");
  if (!credits) blockers.push("credits_unavailable");
  const creditCapacity = credits
    ? Number(credits.allowance || 0) + Number(credits.earnedBack || 0)
    : 0;
  if (credits && (
    ("available" in credits && Number(credits.available) <= 0)
    || (!("available" in credits) && (
      creditCapacity <= 0
      || Number(credits.usedThisWeek || 0) >= creditCapacity
    ))
  )) {
    blockers.push("credits_exhausted");
  }
  let prefs = null;
  try {
    prefs = await trpcGetImpl("candidateUserPreference.hasUserInputPreferences", {
      candidate_user_id: candidate.candidateUserId,
      required_fields: [...REQUIRED_CANDIDATE_PREFERENCE_FIELDS],
    });
    if (!prefs || prefs.hasAllRequired !== true) blockers.push("preferences_incomplete");
  } catch {
    blockers.push("preferences_read_failed");
  }

  let evidence = {
    ok: false,
    blockers: ["evidence_preflight_unavailable"],
    signals: {},
    risks: [],
  };
  if (candidate.candidateUserId && candidate.candidateId && roleId) {
    evidence = await runSubmissionEvidencePreflight({
      candidate,
      roleId,
      trpcGetImpl,
      now,
      directInterestConfirmed,
    });
    blockers.push(...evidence.blockers);
  }
  const uniqueBlockers = [...new Set(blockers)];
  return {
    ok: uniqueBlockers.length === 0,
    blockers: uniqueBlockers,
    prefs,
    signals: evidence.signals,
    risks: evidence.risks,
  };
}

async function hydrateSubmissionCandidate(candidate, trpcGetImpl) {
  if (
    candidate?.linkedinUser
    && candidate?.candidateId
    && candidate?.candidateUserId
    && candidate?.name
    && normalizeEmail(candidate?.email || "")
  ) return candidate;
  try {
    const candidateUser = await trpcGetImpl("candidateUser.getCandidateUserById", {
      candidate_user_id: candidate?.candidateUserId,
    });
    const profile = candidateUser?.candidate || {};
    const email = [
      candidate?.email,
      ...(Array.isArray(candidateUser?.emails) ? candidateUser.emails : []),
      profile?.email,
    ].map((value) => normalizeEmail(
      typeof value === "object" ? value?.email ?? value?.value ?? "" : value,
    )).find(Boolean);
    return {
      ...candidate,
      candidateId: candidate?.candidateId || profile?.id || null,
      name: candidate?.name || profile?.name || null,
      email: email || candidate?.email || null,
      linkedinUser: (
        candidate?.linkedinUser
        || candidate?.linkedin_user
        || profile?.linkedin_user
        || null
      ),
    };
  } catch {
    return candidate;
  }
}

/**
 * Submit one candidate to one role.
 *
 * Both writes use current, bundle-derived contracts. The application mutation
 * is invoked exactly once and success is recognized only after the stored
 * application is read back with matching identities, prose, rating, and
 * scorecard. Any transport or readback uncertainty permanently enters
 * read-only recovery.
 */
export async function submitToRole({
  candidate,
  roleId,
  apply,
  credits = null,
  trpcGetImpl = trpcGet,
  trpcPostImpl = trpcPost,
  restImpl = paraformRest,
  submissionDraftBuilder = generateGroundedSubmissionDraft,
  prepareContext = null,
  contextPrecheckImpl = precheckCapturedSingleSubmissionContext,
  finalSubmitImpl = executeCapturedSingleSubmission,
  submissionStore = {
    claimSubmission,
    claimSubmissionAttempt,
    startSubmissionAttempt,
    recordSubmissionPrepared,
    recordSubmissionOutcome,
    getSubmissionClaim,
  },
  fetchImpl = fetch,
  env = process.env,
  now = Date.now(),
}) {
  const outcome = {
    roleId,
    stage: "claimed",
    submitted: false,
    verified: false,
    blockers: [],
    prepareShape: null,
    error: null,
  };
  candidate = await hydrateSubmissionCandidate(candidate, trpcGetImpl);

  const pre = await preflightSubmission({
    candidate,
    roleId,
    credits,
    trpcGetImpl,
    now,
  });
  outcome.preflight = {
    signals: pre.signals || {},
    risks: pre.risks || [],
  };
  if (!pre.ok) {
    outcome.stage = "blocked";
    outcome.blockers = pre.blockers;
    return outcome;
  }

  let generated = null;
  try {
    generated = await submissionDraftBuilder({
      candidate,
      roleId,
      trpcGetImpl,
      fetchImpl,
      env,
    });
  } catch {
    generated = {
      ok: false,
      blockers: ["submission_draft_generation_failed"],
      signals: {},
    };
  }
  outcome.draftSignals = generated?.signals || {};
  if (!generated?.ok || !generated?.draft) {
    outcome.stage = "blocked";
    outcome.blockers = uniqueReasonCodes(generated?.blockers);
    if (!outcome.blockers.length) outcome.blockers = ["submission_draft_unavailable"];
    return outcome;
  }

  // Kept local and out of durable outcome/journal records because it contains
  // candidate prose. The captured submit adapter consumes it once the final
  // Paraform mutation contract is known.
  const submissionDraft = generated.draft;

  if (!apply) {
    outcome.stage = "would_submit";
    return outcome;
  }

  let prepareInput = null;
  try {
    prepareInput = buildSingleSubmissionPrepareInput({
      roleId,
      candidateUserId: candidate.candidateUserId,
      linkedinUser: candidate.linkedinUser || candidate.linkedin_user,
      anonymizeCandidates: prepareContext?.anonymizeCandidates ?? true,
      roleDiscoverySource: prepareContext?.roleDiscoverySource,
      fromRoleRecommendation: prepareContext?.fromRoleRecommendation,
    });
  } catch {
    outcome.stage = "blocked";
    outcome.blockers = ["submit_prepare_context_unconfirmed"];
    return outcome;
  }
  let contextPrecheck = null;
  try {
    contextPrecheck = await contextPrecheckImpl({
      candidate,
      roleId,
      trpcGetImpl,
      trpcPostImpl,
      restImpl,
      now: new Date(now),
    });
  } catch {
    contextPrecheck = {
      ok: false,
      blockers: ["submission_context_precheck_failed"],
      signals: {},
    };
  }
  outcome.contextSignals = contextPrecheck?.signals || {};
  if (!contextPrecheck?.ok) {
    outcome.stage = "blocked";
    outcome.blockers = uniqueReasonCodes(contextPrecheck?.blockers);
    if (!outcome.blockers.length) {
      outcome.blockers = ["submission_context_precheck_failed"];
    }
    return outcome;
  }
  const claimResult = typeof submissionStore.claimSubmissionAttempt === "function"
    ? await submissionStore.claimSubmissionAttempt(
      candidate.candidateUserId,
      roleId,
      { roleId },
    )
    : await submissionStore.claimSubmission(
      candidate.candidateUserId,
      roleId,
      { roleId },
    );
  const claimStartedAtomically = claimResult.status === "started";
  if (!claimStartedAtomically && claimResult.status !== "claimed") {
    const prior = claimResult.claim
      || await submissionStore.getSubmissionClaim(candidate.candidateUserId, roleId);
    outcome.stage = "already_claimed";
    outcome.priorOutcome = prior?.outcome || null;
    return outcome;
  }
  const attemptId = claimResult.claim.attemptId;
  if (!claimStartedAtomically) {
    const started = await submissionStore.startSubmissionAttempt(
      candidate.candidateUserId,
      roleId,
      attemptId,
    );
    if (started.status !== "started") {
      outcome.stage = "submission_unknown";
      outcome.error = "submission_attempt_already_started";
      return outcome;
    }
  }

  let prepared = null;
  try {
    prepared = await trpcPostImpl(
      "roleSlots.prepareForSingleSubmission",
      prepareInput,
      1,
    );
  } catch {
    outcome.stage = "submission_unknown";
    outcome.error = "submission_prepare_result_unknown";
    await submissionStore.recordSubmissionOutcome(
      candidate.candidateUserId,
      roleId,
      outcome.stage,
      { attemptId, detail: "prepare mutation transport result unknown" },
    );
    return outcome;
  }

  const parsedPrepare = parseSingleSubmissionPrepareResponse(prepared);
  outcome.prepareShape = parsedPrepare.shape;
  if (!parsedPrepare.ok) {
    outcome.stage = "contract_unconfirmed";
    await submissionStore.recordSubmissionOutcome(
      candidate.candidateUserId,
      roleId,
      outcome.stage,
      { attemptId, detail: "prepare response failed captured contract" },
    );
    return outcome;
  }
  await submissionStore.recordSubmissionPrepared(
    candidate.candidateUserId,
    roleId,
    attemptId,
    parsedPrepare.candidateToApprovedRoleId,
  );
  outcome.stage = "prepared";
  outcome.candidateToApprovedRoleId = parsedPrepare.candidateToApprovedRoleId;

  let finalResult = null;
  try {
    finalResult = await finalSubmitImpl({
      candidate,
      roleId,
      candidateToApprovedRoleId: parsedPrepare.candidateToApprovedRoleId,
      submissionDraft,
      preflightSignals: pre.signals || {},
      trpcGetImpl,
      trpcPostImpl,
      restImpl,
      now: new Date(now),
    });
  } catch {
    outcome.stage = "submission_unknown";
    outcome.error = "submission_final_result_unknown";
    await submissionStore.recordSubmissionOutcome(
      candidate.candidateUserId,
      roleId,
      outcome.stage,
      { attemptId, detail: "final mutation or readback result unknown" },
    );
    return outcome;
  }
  outcome.readbackSignals = finalResult?.signals || {};
  outcome.applicationId = finalResult?.applicationId || null;
  outcome.paraformConfirmationExpected =
    finalResult?.signals?.paraformConfirmationExpected === true;
  outcome.paraformConfirmationSent =
    finalResult?.signals?.paraformConfirmationSent === true;
  if (finalResult?.verified !== true) {
    outcome.stage = finalResult?.mutationAttempted === false
      ? "contract_unconfirmed"
      : "submission_unknown";
    outcome.blockers = uniqueReasonCodes(finalResult?.blockers);
    await submissionStore.recordSubmissionOutcome(
      candidate.candidateUserId,
      roleId,
      outcome.stage,
      {
        attemptId,
        detail: finalResult?.mutationAttempted === false
          ? "captured submit preconditions not satisfied"
          : "final mutation not authoritatively verified",
      },
    );
    return outcome;
  }
  await submissionStore.recordSubmissionOutcome(
    candidate.candidateUserId,
    roleId,
    "accepted",
    { attemptId, detail: "final mutation returned" },
  );
  await submissionStore.recordSubmissionOutcome(
    candidate.candidateUserId,
    roleId,
    "verified",
    { attemptId, detail: "authoritative Paraform readback verified" },
  );
  outcome.stage = "verified";
  outcome.submitted = true;
  outcome.verified = true;
  return outcome;
}

/* ------------------------------------------------------------------ status */

export async function interestStatus() {
  const config = interestConfig();
  const sweep = await getSweepState().catch(() => null);
  const staleMs = sweep?.at ? Date.now() - Date.parse(sweep.at) : null;
  return {
    configured: storeConfigured(),
    config: {
      enabled: config.enabled,
      dryRun: config.dryRun,
      notBeforeConfigured: config.notBeforeConfigured,
      stopArmed: config.stopArmed,
      emailArmed: config.emailArmed,
      submitArmed: config.submitArmed,
      emailCanaryConfigured: Boolean(config.emailCanaryTo),
      gateOrderViolations: config.gateOrderViolations,
    },
    lastSweep: sweep,
    staleMs,
    stale: sweep?.ok !== true
      || sweep?.cycleComplete !== true
      || staleMs === null
      || staleMs > 90 * 60 * 1000,
  };
}

/* -------------------------------------------------------------------- tick */

export async function runInterestTick({ config = interestConfig(), mailer = undefined, now = Date.now() } = {}) {
  // Default to the real sender when Gmail is configured; callers (tests, dry
  // runs) can inject their own or pass null to force a no-send.
  const send = mailer === undefined ? (gmailConfigured() ? gmailMailer() : null) : mailer;
  const result = {
    ran: false,
    reason: null,
    sweep: null,
    processed: [],
    reviews: 0,
  };

  if (!config.enabled) { result.reason = "disabled"; return result; }
  if (!storeConfigured()) { result.reason = "store_not_configured"; return result; }
  if (!config.notBeforeConfigured) { result.reason = "not_before_required"; return result; }
  if (config.gateOrderViolations.length) {
    result.reason = `gate_order:${config.gateOrderViolations[0]}`;
    return result;
  }

  result.ran = true;
  let sweep = null;
  const sweepIntervalMs = Math.max(
    60_000,
    Number(config.sweepIntervalMs) || 15 * 60 * 1000,
  );
  const priorSweep = await getSweepState().catch(() => null);
  const priorSweepAt = Date.parse(String(priorSweep?.at || ""));
  const retryIntervalMs = priorSweep?.cycleComplete !== true
    ? Math.min(sweepIntervalMs, 60_000)
    : sweepIntervalMs;
  const sweepDue = !Number.isFinite(priorSweepAt)
    || Number(now) - priorSweepAt >= retryIntervalMs;
  if (sweepDue) {
    const sweepToken = await acquireLock("__curated_interest_sweep__", {
      ttlSeconds: Math.max(600, Math.ceil(sweepIntervalMs / 1000)),
    });
    if (sweepToken) {
      try {
        const currentSweep = await getSweepState().catch(() => null);
        const currentSweepAt = Date.parse(String(currentSweep?.at || ""));
        const currentRetryIntervalMs = currentSweep?.cycleComplete !== true
          ? Math.min(sweepIntervalMs, 60_000)
          : sweepIntervalMs;
        if (
          !Number.isFinite(currentSweepAt)
          || Number(now) - currentSweepAt >= currentRetryIntervalMs
        ) {
          sweep = await sweepInterest({ config, now });
          result.sweep = {
            ok: sweep.ok,
            populationSize: sweep.populationSize,
            cursorStart: sweep.cursorStart,
            cursorEnd: sweep.cursorEnd,
            nextCursor: sweep.nextCursor,
            cycleComplete: sweep.cycleComplete,
            cycleCandidatesRead: sweep.cycleCandidatesRead,
            candidatesRead: sweep.candidatesRead,
            seeded: sweep.seeded,
            detected: sweep.detected.length,
            readErrors: sweep.readErrors,
          };
        } else {
          result.sweep = { skipped: "not_due" };
        }
      } finally {
        await releaseLock("__curated_interest_sweep__", sweepToken);
      }
    } else {
      result.sweep = { skipped: "locked" };
    }
  } else {
    result.sweep = { skipped: "not_due" };
  }

  const candidateByUserId = sweep?.candidateByUserId || new Map();
  const pendingJobs = await listPendingJobs(50);
  if (!pendingJobs.length && result.sweep?.skipped) {
    result.reason = result.sweep.skipped;
  }

  for (const pendingJob of pendingJobs) {
    const candidate = await hydrateSubmissionCandidate(
      candidateByUserId.get(pendingJob.candidateUserId) || {
        candidateUserId: pendingJob.candidateUserId,
        candidateId: pendingJob.candidateId || null,
      },
      trpcGet,
    );
    const token = await acquireLock(pendingJob.candidateUserId);
    if (!token) continue;
    try {
      let job = await getJob(pendingJob.candidateUserId);
      if (!job || job.stage === "done") continue;
      if (!candidate?.candidateUserId || !candidate?.candidateId) {
        const reviewReasons = ["candidate_identity_unavailable"];
        await recordReview(pendingJob.candidateUserId, reviewReasons, {
          roles: job.roles,
          batchId: job.batchId,
        });
        await saveJob(appendJournal({
          ...job,
          stage: "done",
        }, "identity_unavailable"));
        result.reviews++;
        result.processed.push({
          candidateHashOnly: true,
          roles: Array.isArray(job.roles) ? job.roles.length : 0,
          paused: 0,
          emailed: false,
          submitStages: [],
          reviewReasons,
        });
        continue;
      }

      // 1. STOP — enforcing first, so we never email while a nudge is queued.
      const stop = await stopFollowUps({
        candidate,
        apply: config.writesEnabled && config.stopArmed,
      });
      job = await saveJob(appendJournal({ ...job, stopped: stop, stage: "stopped" }, "stopped", {
        paused: stop.paused, attempted: stop.attempted,
      }));
      if (stop.errors.length) {
        const reviewReasons = ["stop_errors"];
        await recordReview(candidate.candidateUserId, reviewReasons, {
          roles: job.roles,
          batchId: job.batchId,
        });
        await saveJob(appendJournal({
          ...job,
          stage: "stop_blocked",
        }, "stop_blocked", {
          errors: stop.errors.length,
        }));
        result.reviews++;
        result.processed.push({
          candidateHashOnly: true,
          roles: job.roles.length,
          paused: stop.paused,
          emailed: false,
          submitStages: [],
          reviewReasons,
        });
        continue;
      }

      // 2. SUBMIT claims + pre-flight (before the email, so the promise is bankable).
      const submissions = [];
      for (const roleId of job.roles) {
        const credits = await readSubmissionCredits(new Date(now)).catch(() => null);
        submissions.push(await submitToRole({
          candidate,
          roleId,
          apply: config.writesEnabled && config.submitArmed,
          credits,
        }));
      }
      job = await saveJob(appendJournal({ ...job, submissions, stage: "submitted" }, "submitted", {
        roles: submissions.length,
      }));

      const bankable = submissions.filter((s) => (
        ["would_submit", "verified"].includes(s.stage)
      ));
      const blockers = [...new Set(submissions.flatMap((s) => s.blockers || []))];

      // 3. EMAIL — only when at least one role is actually bankable. Paraform
      // normally sends its own confirmation from /api/application; when it
      // does, suppress our Gmail copy so the candidate receives one message.
      let email = { sent: false, skipped: "no_bankable_role" };
      if (bankable.length) {
        const paraformOwnsConfirmation = bankable.some(
          (submission) => submission.paraformConfirmationExpected === true,
        );
        const emailPlan = interestEmailPlan({
          config,
          paraformOwnsConfirmation,
        });
        if (!emailPlan.send) {
          email = { sent: false, skipped: emailPlan.skipped };
        } else {
          email = await sendConfirmation({
            candidate,
            roleCount: bankable.length,
            batchId: job.batchId,
            apply: emailPlan.apply,
            mailer: send,
            canaryTo: emailPlan.canaryTo,
          });
        }
      }
      job = await saveJob(appendJournal({ ...job, emailed: email, stage: "done" }, "emailed", {
        sent: email.sent, skipped: email.skipped || null,
      }));

      const reviewReasons = [
        ...blockers,
        ...(email.skipped && ![
          "dry_run",
          "already_delivered",
          "paraform_confirmation_owns_candidate_email",
        ].includes(email.skipped) ? [email.skipped] : []),
        ...submissions.filter((s) => s.stage === "contract_unconfirmed").map(() => "submit_contract_unconfirmed"),
        ...(stop.errors.length ? ["stop_errors"] : []),
      ];
      if (reviewReasons.length) {
        await recordReview(candidate.candidateUserId, reviewReasons, {
          roles: job.roles,
          batchId: job.batchId,
        });
        result.reviews++;
      }

      result.processed.push({
        candidateHashOnly: true,
        roles: job.roles.length,
        paused: stop.paused,
        emailed: email.sent,
        submitStages: submissions.map((s) => s.stage),
        reviewReasons,
      });
    } finally {
      await releaseLock(candidate.candidateUserId, token);
    }
  }

  return result;
}
