import { trpcGet, trpcPost, normalizeEmail } from "./core.mjs";
import {
  OUTCOME_SEQUENCE_RULES,
} from "../../roster/_lib/outcome-sequences.mjs";
import { buildInterestConfirmation, firstNameFor, COPY_VARIANT } from "./interest-copy.mjs";
import {
  storeConfigured,
  getSnapshot,
  putSnapshot,
  diffInterest,
  getJob,
  saveJob,
  createJob,
  claimSubmission,
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

const TRUE = new Set(["1", "true", "yes", "on"]);
const flag = (name, env = process.env) => TRUE.has(String(env[name] ?? "").trim().toLowerCase());

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
    gateOrderViolations: [
      emailArmedRaw && !stopArmed ? "EMAIL_APPROVED requires STOP_APPROVED" : null,
      submitArmedRaw && !(stopArmed && emailArmedRaw) ? "SUBMIT_APPROVED requires STOP_APPROVED and EMAIL_APPROVED" : null,
    ].filter(Boolean),
    writesEnabled: enabled && !dryRun,
    sweepConcurrency: Math.max(1, Math.min(6, Number(env.PARAAI_INTEREST_CONCURRENCY || 4))),
    batchWindowMs: Math.max(0, Number(env.PARAAI_INTEREST_BATCH_WINDOW_MS ?? 30 * 60 * 1000)),
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
  const d = new Date(now);
  // Monday 09:00 PT, expressed in UTC (16:00 UTC standard time).
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  d.setUTCHours(16, 0, 0, 0);
  const data = await trpcGet("roleSlots.getMySingleSubmissionData", { weekStart: d.toISOString() });
  if (!data) return null;
  return {
    weekStart: d.toISOString(),
    usedThisWeek: Number(data.recentSingleSubmissionsThisWeekCount || 0),
    allowance: Number(data.previousAllowance || 0),
    earnedBack: Number(data.earnedBackThisWeekCount || 0),
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
    candidatesRead: 0,
    readErrors: 0,
    seeded: 0,
    detected: [],
    declined: 0,
    skippedBeforeCutoff: 0,
    durationMs: 0,
  };

  const population = await listCuratedListCandidates();
  const reads = await mapWithConcurrency(population, config.sweepConcurrency, async (c) => {
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
        result.detected.push({ candidate, roleIds: diff.newlyInterested, statuses });
      }
    }
    await putSnapshot(candidate.candidateUserId, statuses);
  }

  // A pass that read nothing is a failure, not a clean run.
  result.ok = result.candidatesRead > 0;
  result.durationMs = Date.now() - started;
  await recordSweep({
    ok: result.ok,
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

/**
 * Pause every active lead for this candidate across the curated-list sequence
 * family. Pause only, never remove, never unpause: a false positive costs one
 * reversible pause, a false negative keeps nudging someone who just said yes.
 */
export async function stopFollowUps({ candidate, apply, sequenceIds = curatedListSequenceIds() }) {
  const email = normalizeEmail(candidate.email || "");
  const out = { attempted: 0, paused: 0, alreadyPaused: 0, notFound: 0, errors: [], verified: [] };
  if (!email) { out.errors.push("no deliverable email"); return out; }

  for (const sequenceId of sequenceIds) {
    let lead = null;
    try {
      const r = await trpcGet("campaigns.getCampaignLeads", { campaign_id: sequenceId, search: email }, 1);
      lead = (r?.leads || [])[0] || null;
    } catch (error) {
      out.errors.push(`${sequenceId}: read failed ${String(error?.message || error).slice(0, 120)}`);
      continue;
    }
    if (!lead) { out.notFound++; continue; }
    if (lead.is_paused) { out.alreadyPaused++; continue; }
    if (lead.is_archived) continue;

    out.attempted++;
    if (!apply) continue;

    try {
      await trpcPost("campaigns.updateCandidatePauseStatus", {
        campaign_to_candidate_user_id: lead.ccu_id,
        is_paused: true,
      }, 1);
    } catch (error) {
      out.errors.push(`${sequenceId}: pause failed ${String(error?.message || error).slice(0, 120)}`);
      continue;
    }

    // A 200 is not success. Re-read the row.
    try {
      const check = await trpcGet("campaigns.getCampaignLeads", { campaign_id: sequenceId, search: email }, 1);
      const after = (check?.leads || [])[0] || null;
      if (after?.is_paused) { out.paused++; out.verified.push(sequenceId); }
      else out.errors.push(`${sequenceId}: pause did not read back`);
    } catch (error) {
      out.errors.push(`${sequenceId}: readback failed ${String(error?.message || error).slice(0, 120)}`);
    }
  }
  return out;
}

/* ------------------------------------------------------------------- email */

/**
 * Confirmation email as David. Claim-before-send: the outbox claim is taken
 * before Gmail is called, so a crash mid-send can never produce a second copy.
 *
 * Ordering (plan §6): this runs after the stop lands and after the submission is
 * claimed and pre-flighted, never after the submit round trip.
 */
export async function sendConfirmation({ candidate, roleCount, batchId, apply, mailer = null }) {
  const out = { sent: false, skipped: null, messageId: null };
  const firstName = firstNameFor(candidate.name);
  if (!firstName) { out.skipped = "unusable_first_name"; return out; }
  const email = normalizeEmail(candidate.email || "");
  if (!email) { out.skipped = "no_deliverable_email"; return out; }

  const existing = await getEmailClaim(candidate.candidateUserId, batchId);
  if (existing?.deliveredAt) { out.skipped = "already_delivered"; return out; }

  const message = buildInterestConfirmation({ firstName, roleCount });
  if (!apply) { out.skipped = "dry_run"; out.preview = message; return out; }

  const won = await claimEmail(candidate.candidateUserId, batchId, { variant: COPY_VARIANT, to: "redacted" });
  if (!won && !existing) { out.skipped = "claim_lost"; return out; }

  if (!mailer) { out.skipped = "mailer_unavailable"; return out; }
  const delivered = await mailer({ to: email, ...message, candidate });
  await confirmEmail(candidate.candidateUserId, batchId, { messageId: delivered?.messageId || null });
  out.sent = true;
  out.messageId = delivered?.messageId || null;
  return out;
}

/* ------------------------------------------------------------------ submit */

/**
 * Pre-flight. Everything that would make Paraform reject the submit, checked
 * before we spend the single attempt (and the credit).
 *
 * Per David's 2026-07-28 decision there is NO fit gate here: interest alone
 * qualifies. These checks are structural blockers only.
 */
export async function preflightSubmission({ candidate, roleId, credits }) {
  const blockers = [];
  if (!candidate.candidateUserId) blockers.push("missing_candidate_user_id");
  if (!candidate.candidateId) blockers.push("missing_candidate_id");
  if (!normalizeEmail(candidate.email || "")) blockers.push("no_deliverable_email");
  if (!firstNameFor(candidate.name)) blockers.push("unusable_name");
  if (credits && credits.allowance > 0 && credits.usedThisWeek >= credits.allowance) {
    blockers.push("credits_exhausted");
  }
  let prefs = null;
  try {
    prefs = await trpcGet("candidateUserPreference.hasUserInputPreferences", {
      candidate_user_id: candidate.candidateUserId,
      required_fields: [],
    });
    if (prefs && prefs.hasAllRequired === false) blockers.push("preferences_incomplete");
  } catch { /* preferences read is advisory; a failure is not a blocker */ }
  return { ok: blockers.length === 0, blockers, prefs };
}

/**
 * Submit one candidate to one role.
 *
 * The wire contract past `prepareForSingleSubmission` is UNPROVEN (capture doc
 * open item 2). Rather than guess a payload, this records the real response of
 * the prepare call and refuses to fire a submit whose shape it has not seen.
 * The P3 canary settles it and the recorded shape unlocks the rest.
 */
export async function submitToRole({ candidate, roleId, apply, credits = null }) {
  const outcome = {
    roleId,
    stage: "claimed",
    submitted: false,
    verified: false,
    blockers: [],
    prepareShape: null,
    error: null,
  };

  const pre = await preflightSubmission({ candidate, roleId, credits });
  if (!pre.ok) {
    outcome.stage = "blocked";
    outcome.blockers = pre.blockers;
    return outcome;
  }

  const won = await claimSubmission(candidate.candidateUserId, roleId, { roleId });
  if (!won) {
    const prior = await getSubmissionClaim(candidate.candidateUserId, roleId);
    outcome.stage = "already_claimed";
    outcome.priorOutcome = prior?.outcome || null;
    return outcome;
  }

  if (!apply) {
    outcome.stage = "would_submit";
    return outcome;
  }

  let prepared = null;
  try {
    prepared = await trpcPost("roleSlots.prepareForSingleSubmission", {
      role_id: roleId,
      candidate_user_id: candidate.candidateUserId,
      linkedin_user: candidate.linkedinUser || candidate.linkedin_user || "",
    }, 1);
  } catch (error) {
    outcome.stage = "prepare_failed";
    outcome.error = String(error?.message || error).slice(0, 300);
    await recordSubmissionOutcome(candidate.candidateUserId, roleId, outcome.stage);
    return outcome;
  }

  // Record what prepare actually returned. This is the capture that unblocks
  // the executor; it is deliberately inspected before any submit is attempted.
  outcome.prepareShape = prepared && typeof prepared === "object"
    ? Object.keys(prepared).slice(0, 40)
    : typeof prepared;

  const submissionRequestId = prepared?.submission_request_id
    || prepared?.submissionRequestId
    || prepared?.id
    || null;

  if (!submissionRequestId) {
    // The shared-path hypothesis did not hold. Stop, record, and let a human
    // read the recorded shape rather than inventing a payload.
    outcome.stage = "contract_unconfirmed";
    await recordSubmissionOutcome(candidate.candidateUserId, roleId, outcome.stage);
    return outcome;
  }

  outcome.stage = "prepared";
  outcome.submissionRequestId = submissionRequestId;
  await recordSubmissionOutcome(candidate.candidateUserId, roleId, outcome.stage);
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
      gateOrderViolations: config.gateOrderViolations,
    },
    lastSweep: sweep,
    staleMs,
    stale: staleMs === null ? true : staleMs > 90 * 60 * 1000,
  };
}

/* -------------------------------------------------------------------- tick */

export async function runInterestTick({ config = interestConfig(), mailer = null, now = Date.now() } = {}) {
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
  const sweep = await sweepInterest({ config, now });
  result.sweep = {
    ok: sweep.ok,
    candidatesRead: sweep.candidatesRead,
    seeded: sweep.seeded,
    detected: sweep.detected.length,
    readErrors: sweep.readErrors,
  };

  const credits = await readSubmissionCredits().catch(() => null);

  for (const hit of sweep.detected) {
    const { candidate, roleIds } = hit;
    const token = await acquireLock(candidate.candidateUserId);
    if (!token) continue;
    try {
      let job = await getJob(candidate.candidateUserId);
      job = job && job.stage !== "done"
        ? await saveJob(appendJournal({ ...job, roles: [...new Set([...(job.roles || []), ...roleIds])] }, "more_interest", { added: roleIds.length }))
        : await createJob(candidate.candidateUserId, { roles: roleIds });

      // 1. STOP — enforcing first, so we never email while a nudge is queued.
      const stop = await stopFollowUps({
        candidate,
        apply: config.writesEnabled && config.stopArmed,
      });
      job = await saveJob(appendJournal({ ...job, stopped: stop, stage: "stopped" }, "stopped", {
        paused: stop.paused, attempted: stop.attempted,
      }));

      // 2. SUBMIT claims + pre-flight (before the email, so the promise is bankable).
      const submissions = [];
      for (const roleId of job.roles) {
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

      const bankable = submissions.filter((s) => !["blocked", "prepare_failed"].includes(s.stage));
      const blockers = [...new Set(submissions.flatMap((s) => s.blockers || []))];

      // 3. EMAIL — only when at least one role is actually bankable.
      let email = { sent: false, skipped: "no_bankable_role" };
      if (bankable.length) {
        email = await sendConfirmation({
          candidate,
          roleCount: bankable.length,
          batchId: job.batchId,
          apply: config.writesEnabled && config.emailArmed,
          mailer,
        });
      }
      job = await saveJob(appendJournal({ ...job, emailed: email, stage: "done" }, "emailed", {
        sent: email.sent, skipped: email.skipped || null,
      }));

      const reviewReasons = [
        ...blockers,
        ...(email.skipped && !["dry_run", "already_delivered"].includes(email.skipped) ? [email.skipped] : []),
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
