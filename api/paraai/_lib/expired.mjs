// Para AI expired-match actioning: when Paraform expires an interview request
// that was never submitted, attach the reason the hiring manager sees and clear
// it off the board.
//
// Why it exists: three unresolved expired matches pause new ParaAI matches, and
// Paraform's own tooltip says the recruiter "can self-resolve by actioning their
// expired matches". This lane is that self-resolution, run continuously.
//
// Ships dark. Gate order is deliberate and every gate fails closed:
//   PARAAI_EXPIRED_APPROVED          master switch
//   PARAAI_EXPIRED_DRY_RUN           fail-closed by absence (unset means dry run)
//   PARAAI_EXPIRED_NOT_BEFORE        arming pin, so first arming cannot eat the backlog
//   PARAAI_EXPIRED_DISMISS_APPROVED  the single write
//
// The one thing this lane must never do is tell a hiring manager something
// untrue. "Candidate didn't get back" is only sent when nothing in Raydar
// contradicts it: no reply on the outreach thread, no reply-lane record, and
// Paraform's own reached_out_to_candidate flag set. Anything else is a review
// card, never a softer reason.
import { notifySlack } from "./core.mjs";
import { takeAlertSlot } from "./store.mjs";
import { getOutreachState } from "./outreach-store.mjs";
import {
  getThread,
  candidateReplyMessages,
  firstDeliveredInternalDate,
  outreachMailbox,
  gmailConfigured,
} from "./outreach-gmail.mjs";
import { listReplyRecords } from "./reply-store.mjs";
import { readSubmissionRequestClaim } from "./request-claim.mjs";
import {
  EXPIRATION_DAYS,
  EXPIRED_REASONS,
  DEFAULT_EXPIRED_REASON_KEY,
  expiredReasonText,
  readSubmissionRequestHistory,
  readParaAiStatus,
  expiredRows,
  expiredAtMs,
  performExpiredDismiss,
} from "./expired-actions.mjs";
import {
  storeConfigured,
  createExpiredRecord,
  saveExpiredRecord,
  readExpiredRecord,
  listExpiredRecords,
  acquireExpiredPollSlot,
  spendDailyDismissBudget,
  readDailyDismissSpend,
  markExpiredRun,
  readExpiredLastRun,
} from "./expired-store.mjs";

const bool = (value, fallback = false) => {
  if (value === undefined || value === null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
};
const finiteDate = (value) => {
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : null;
};
const text = (value) => String(value ?? "").replace(/\s+/g, " ").trim();

export function expiredConfig(env = process.env) {
  return {
    approved: bool(env.PARAAI_EXPIRED_APPROVED, false),
    dryRun: !("PARAAI_EXPIRED_DRY_RUN" in env) || bool(env.PARAAI_EXPIRED_DRY_RUN, true),
    notBeforeMs: finiteDate(env.PARAAI_EXPIRED_NOT_BEFORE),
    dismissApproved: bool(env.PARAAI_EXPIRED_DISMISS_APPROVED, false),
    batchSize: Math.max(1, Math.min(20, Number(env.PARAAI_EXPIRED_BATCH) || 5)),
    dailyCap: Math.max(1, Math.min(200, Number(env.PARAAI_EXPIRED_DAILY_CAP) || 20)),
    pollLockSeconds: Math.max(60, Math.min(21_600, Number(env.PARAAI_EXPIRED_POLL_SECONDS) || 3600)),
    // Zero by design: "as soon as they are expired". The valve exists because
    // dismissing removes the row from the expired bucket, which takes the Late
    // submit button with it — if that recovery path ever needs protecting, this
    // buys a window without a code change.
    holdHours: Math.max(0, Math.min(168, Number(env.PARAAI_EXPIRED_HOLD_HOURS) || 0)),
    // Paraform tracks whether the recruiter reached out. Without that flag we
    // cannot claim the candidate failed to respond.
    requireReachedOut: bool(env.PARAAI_EXPIRED_REQUIRE_REACHED_OUT, true),
    expirationDays: EXPIRATION_DAYS,
    mailbox: outreachMailbox(env),
    gmailConfigured: gmailConfigured(env),
    storeConfigured: storeConfigured(),
  };
}

// Read + plan. True whenever the lane may look at expired rows at all; writing
// is gated separately below.
export function expiredDetectionEnabled(config = expiredConfig()) {
  return Boolean(config.approved && config.storeConfigured);
}

// Shadow mode: detection on, the write gate shut. This is the burn-in state.
export function expiredShadowMode(config = expiredConfig()) {
  return Boolean(expiredDetectionEnabled(config) && !expiredWriteEnabled(config));
}

export function expiredWriteEnabled(config = expiredConfig()) {
  if (!expiredDetectionEnabled(config)) return false;
  if (config.dryRun !== false) return false;
  if (config.notBeforeMs == null) return false;
  return config.dismissApproved === true;
}

// ---------------------------------------------------------------- planning

// Everything that could make "Candidate didn't get back" false, gathered before
// any decision. Gmail is authoritative (it sees replies the reply lane has not
// scanned yet); the reply records are a cheap local cross-check.
export async function gatherContactEvidence(row, { config, replyRecordsByCandidate, now }) {
  const evidence = {
    reachedOut: row.reachedOut === true,
    replyRecords: [],
    gmailReplies: null,
    gmailError: null,
  };
  const records = replyRecordsByCandidate.get(row.candidateUserId) || [];
  evidence.replyRecords = records.map((record) => ({
    replyId: record.replyId,
    status: record.status || null,
    action: record.plan?.action || null,
    receivedAt: record.receivedAt || null,
  }));

  if (!config.gmailConfigured) return evidence;
  try {
    const state = await getOutreachState(row.candidateUserId);
    if (!state?.threadId) { evidence.gmailReplies = 0; return evidence; }
    const thread = await getThread(config.mailbox, state.threadId);
    if (!thread) { evidence.gmailReplies = 0; return evidence; }
    const anchor = finiteDate(state.firstOutboundAt) ?? firstDeliveredInternalDate(thread) ?? 0;
    const replies = candidateReplyMessages(thread, config.mailbox, anchor);
    evidence.gmailReplies = replies.length;
    evidence.latestReplyAt = replies.length
      ? new Date(replies[replies.length - 1].internalDate).toISOString()
      : null;
  } catch (error) {
    // A Gmail outage must not authorise a dismissal, and must not permanently
    // burn the row either: the plan holds and the next tick retries.
    evidence.gmailError = String(error?.code || error?.message || "gmail_unavailable").slice(0, 120);
  }
  return evidence;
}

export function planExpiredRow(row, evidence, { config, now, claim }) {
  const expiredAt = expiredAtMs(row, config.expirationDays);

  if (claim) {
    return { action: "skip", resolution: "claimed_by_another_lane", detail: claim.action || claim.namespace || null };
  }
  if (evidence.gmailError) {
    return { action: "hold", resolution: "contact_evidence_unavailable", detail: evidence.gmailError };
  }
  // A candidate who replied demonstrably DID get back. The reply lane owns that
  // request's truthful outcome (a late submit, or a pass with a real reason), so
  // this lane surfaces it rather than inventing one.
  if (evidence.gmailReplies > 0 || evidence.replyRecords.length > 0) {
    return {
      action: "review",
      resolution: "candidate_replied",
      detail: `gmail=${evidence.gmailReplies ?? "n/a"} records=${evidence.replyRecords.length}`,
    };
  }
  if (config.requireReachedOut && !evidence.reachedOut) {
    return { action: "review", resolution: "never_contacted", detail: "reached_out_to_candidate is false" };
  }
  if (config.holdHours > 0 && expiredAt != null && now < expiredAt + config.holdHours * 3600_000) {
    return { action: "hold", resolution: "hold_window", detail: `${config.holdHours}h` };
  }
  // The arming pin binds to the moment the row expired, so switching the lane on
  // observes the existing backlog without acting on it. The operator backfill is
  // the sanctioned way past this.
  if (config.notBeforeMs != null && expiredAt != null && expiredAt < config.notBeforeMs) {
    return { action: "observe", resolution: "expired_before_pin", detail: new Date(expiredAt).toISOString() };
  }
  return { action: "dismiss", resolution: "no_response", reasonKey: DEFAULT_EXPIRED_REASON_KEY };
}

// ------------------------------------------------------------------- alerts

async function alertReview(record, plan) {
  if (!(await takeAlertSlot(`expired-review:${record.requestId}`, 24 * 3600).catch(() => false))) return false;
  const who = record.candidateName || "a candidate";
  const where = [record.roleName, record.companyName].filter(Boolean).join(" at ") || "a role";
  const why = plan.resolution === "candidate_replied"
    ? "they replied to our outreach, so \"didn't get back\" would be untrue"
    : plan.resolution === "never_contacted"
      ? "Paraform has no record that we reached out"
      : String(plan.resolution || "needs a look");
  await notifySlack(
    `⏳ Expired ParaAI match needs your call: ${who} for ${where} — ${why}. `
    + "Late submit or add a reason on paraform.com/home.",
  ).catch(() => {});
  return true;
}

// -------------------------------------------------------------------- tick

export async function runExpiredTick({
  now = Date.now(),
  mode = "organic",
  limit = null,
  ignoreArmingPin = false,
  force = false,
  env = process.env,
} = {}) {
  const config = expiredConfig(env);
  if (!expiredDetectionEnabled(config)) {
    return { ok: true, ran: false, reason: config.approved ? "store_not_configured" : "not_approved" };
  }

  const slot = await acquireExpiredPollSlot({ ttlSeconds: config.pollLockSeconds });
  if (!slot && mode === "organic") return { ok: true, ran: false, reason: "poll_not_due" };

  const batch = Math.max(1, Math.min(config.batchSize, Number(limit) || config.batchSize));
  const summary = {
    ok: true,
    ran: true,
    mode,
    scanned: 0,
    planned: 0,
    dismissed: 0,
    review: 0,
    held: 0,
    observed: 0,
    skipped: 0,
    errors: 0,
    shadow: expiredShadowMode(config),
    results: [],
  };

  const [history, paraAi, replyRecords] = await Promise.all([
    readSubmissionRequestHistory(),
    readParaAiStatus().catch(() => null),
    listReplyRecords(500).catch(() => []),
  ]);
  summary.expiredCount = history.currentUserExpiredCount;
  summary.counts = history.counts;
  summary.paraAi = paraAi;
  // The whole point of the lane, measured every tick rather than asserted.
  summary.matchingPaused = paraAi ? paraAi.matchingStatus !== "ACTIVE" : null;

  const replyRecordsByCandidate = new Map();
  for (const record of replyRecords) {
    if (!record?.candidateUserId) continue;
    const list = replyRecordsByCandidate.get(record.candidateUserId) || [];
    list.push(record);
    replyRecordsByCandidate.set(record.candidateUserId, list);
  }

  const rows = expiredRows(history.rows, history.currentUserId);
  summary.expiredRows = rows.length;

  for (const row of rows) {
    if (summary.planned >= batch) break;
    summary.scanned += 1;

    // The freeze rule: one record per request, and its existence is what stops
    // the tick re-touching it. Backfill records carry backfillOnly so the
    // organic tick can never re-action them.
    const existing = await readExpiredRecord(row.id);
    if (existing) { summary.skipped += 1; continue; }

    const claim = await readSubmissionRequestClaim(row.id).catch(() => null);
    const evidence = await gatherContactEvidence(row, { config, replyRecordsByCandidate, now });
    const plan = planExpiredRow(row, evidence, {
      config,
      now,
      claim: force ? null : claim,
    });
    if (ignoreArmingPin && plan.action === "observe" && plan.resolution === "expired_before_pin") {
      plan.action = "dismiss";
      plan.resolution = "no_response";
      plan.reasonKey = DEFAULT_EXPIRED_REASON_KEY;
    }
    summary.planned += 1;

    let record = {
      requestId: row.id,
      candidateUserId: row.candidateUserId,
      candidateName: row.candidateName || null,
      roleId: row.roleId,
      roleName: row.roleName || null,
      companyName: row.companyName || null,
      hiringManagerName: row.hiringManagerName || null,
      createdAt: row.createdAt,
      expiredAtMs: expiredAtMs(row, config.expirationDays),
      reachedOut: evidence.reachedOut,
      evidence: {
        gmailReplies: evidence.gmailReplies,
        replyRecords: evidence.replyRecords.length,
        gmailError: evidence.gmailError,
      },
      plan,
      source: mode,
      backfillOnly: mode === "backfill",
      expiredCountBefore: history.currentUserExpiredCount,
      paraAiBefore: paraAi,
      status: "planned",
      shadow: !expiredWriteEnabled(config),
    };

    // A hold is a retry, not a decision — never persisted, so the next tick
    // re-evaluates with fresh evidence.
    if (plan.action === "hold") {
      summary.held += 1;
      summary.results.push({ requestId: row.id, outcome: "hold", resolution: plan.resolution });
      continue;
    }

    const created = await createExpiredRecord(record);
    if (!created.created) { summary.skipped += 1; continue; }
    record = created.record;

    try {
      if (plan.action === "skip") {
        record.status = "skipped";
        summary.skipped += 1;
      } else if (plan.action === "observe") {
        record.status = "observed";
        summary.observed += 1;
      } else if (plan.action === "review") {
        record.status = "needs_review";
        summary.review += 1;
        await alertReview(record, plan);
      } else if (record.shadow) {
        record.status = "shadow_planned";
        record.wouldSend = expiredReasonText(plan.reasonKey);
        summary.observed += 1;
      } else {
        const budget = await spendDailyDismissBudget(config.dailyCap, { now });
        if (!budget.granted) {
          record.status = "held_daily_cap";
          summary.held += 1;
        } else {
          const outcome = await performExpiredDismiss(row, plan.reasonKey, { claim: true });
          record.status = "actioned";
          record.write = {
            attemptedAt: new Date(now).toISOString(),
            verified: outcome.verified,
            reason: outcome.reason,
            rowStatus: outcome.row?.status || null,
          };
          record.expiredCountAfter = outcome.expiredCountAfter;
          record.paraAiAfter = outcome.paraAiAfter;
          summary.dismissed += 1;
        }
      }
      await saveExpiredRecord(record, record.revision);
      summary.results.push({
        requestId: row.id,
        outcome: record.status,
        resolution: plan.resolution,
      });
    } catch (error) {
      if (error?.code === "AUTH_EXPIRED") {
        if (await takeAlertSlot("expired-auth-expired", 12 * 3600).catch(() => false)) {
          await notifySlack(
            "🚨 Para AI expired-match actioning paused: the Paraform session cookie expired and needs rotating. "
            + `${rows.length} expired match(es) are unresolved; ParaAI matching pauses at 3.`,
          ).catch(() => {});
        }
        summary.errors += 1;
        summary.authExpired = true;
        break;
      }
      summary.errors += 1;
      record.status = "needs_review";
      record.error = {
        code: String(error?.code || "EXPIRED_ACTION_FAILED"),
        message: text(error?.message).slice(0, 240),
      };
      await saveExpiredRecord(record, record.revision).catch(() => {});
      summary.results.push({ requestId: row.id, outcome: "error", code: record.error.code });
      if (await takeAlertSlot(`expired-error:${row.id}`, 12 * 3600).catch(() => false)) {
        await notifySlack(
          `🚨 Para AI expired-match dismissal failed (${record.error.code}) for `
          + `${record.roleName || "a role"} at ${record.companyName || "a company"}. It is in review, not retried.`,
        ).catch(() => {});
      }
    }
  }

  await markExpiredRun({ now }).catch(() => {});
  return summary;
}

// ------------------------------------------------------------------ health

export async function expiredHealth() {
  const config = expiredConfig();
  const records = await listExpiredRecords(200).catch(() => []);
  const counts = {};
  for (const record of records) counts[record.status || "unknown"] = (counts[record.status || "unknown"] || 0) + 1;
  const lastRun = await readExpiredLastRun().catch(() => null);
  const spentToday = await readDailyDismissSpend().catch(() => 0);
  return {
    approved: config.approved,
    dryRun: config.dryRun,
    armed: config.notBeforeMs != null,
    notBefore: config.notBeforeMs ? new Date(config.notBeforeMs).toISOString() : null,
    writeEnabled: expiredWriteEnabled(config),
    shadow: expiredShadowMode(config),
    storeConfigured: config.storeConfigured,
    gmailConfigured: config.gmailConfigured,
    expirationDays: config.expirationDays,
    holdHours: config.holdHours,
    requireReachedOut: config.requireReachedOut,
    dailyCap: config.dailyCap,
    spentToday,
    lastRunAt: lastRun?.at || null,
    records: records.length,
    counts,
    reasonVocabulary: EXPIRED_REASONS,
  };
}

export { EXPIRED_REASONS, expiredReasonText };
