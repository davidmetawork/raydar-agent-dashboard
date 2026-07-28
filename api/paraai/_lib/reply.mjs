// Para AI reply actioning: read candidate replies to interview-request
// outreach, classify them, and action the matching submission requests.
//
// Ships dark. Every write path is behind its own false-by-default gate, and
// shadow mode is literally the assertion that the write gates are shut: the
// full read/classify/plan path runs and records what it WOULD do.
//
// Ordering of the gates is deliberate:
//   PARAAI_REPLY_APPROVED      master switch
//   PARAAI_REPLY_DRY_RUN       fail-closed by absence (unset means dry run)
//   PARAAI_REPLY_NOT_BEFORE    arming pin, so first arming cannot eat history
//   PARAAI_REPLY_SUBMIT_APPROVED    the yes path
//   PARAAI_REPLY_PASS_APPROVED      the no path, one phase behind submit
//   PARAAI_REPLY_OFFMARKET_APPROVED the candidate-level off-market write
import { notifySlack, fetchCall } from "./core.mjs";
import { takeAlertSlot, listJobs } from "./store.mjs";
import { listOutreachStates } from "./outreach-store.mjs";
import {
  getThread,
  candidateReplyMessages,
  firstDeliveredInternalDate,
  outreachMailbox,
  gmailConfigured,
} from "./outreach-gmail.mjs";
import {
  stripQuotedReply,
  isMachineReply,
  extractReplySignals,
  classifyReply,
} from "./reply-classify.mjs";
import {
  readSubmissionRequests,
  pendingRequestsFor,
  expiresAtMs,
  readQuickSubmitForm,
  candidatePreferencesReady,
  quickSubmitBlockingReasons,
  confirmInterest,
  performQuickSubmit,
  performPass,
  performOffMarket,
  passReasonText,
} from "./reply-actions.mjs";
import {
  buildAnswerContext,
  generateSubmissionAnswers,
  assemblePayload,
} from "./reply-answers.mjs";
import {
  storeConfigured,
  createReplyRecord,
  saveReplyRecord,
  readReplyRecord,
  listReplyRecords,
  acquireReplyLock,
  releaseReplyLock,
  acquireReplyPollSlot,
  releaseReplyPollSlot,
} from "./reply-store.mjs";

const bool = (value, fallback = false) => {
  if (value === undefined || value === null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
};
const finiteDate = (value) => {
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : null;
};
const text = (value) => String(value ?? "").replace(/\s+/g, " ").trim();

export function replyConfig(env = process.env) {
  return {
    approved: bool(env.PARAAI_REPLY_APPROVED, false),
    dryRun: !("PARAAI_REPLY_DRY_RUN" in env) || bool(env.PARAAI_REPLY_DRY_RUN, true),
    notBeforeMs: finiteDate(env.PARAAI_REPLY_NOT_BEFORE),
    submitApproved: bool(env.PARAAI_REPLY_SUBMIT_APPROVED, false),
    passApproved: bool(env.PARAAI_REPLY_PASS_APPROVED, false),
    offMarketApproved: bool(env.PARAAI_REPLY_OFFMARKET_APPROVED, false),
    batchSize: Math.max(1, Math.min(10, Number(env.PARAAI_REPLY_BATCH) || 3)),
    pollLockSeconds: Math.max(15, Math.min(300, Number(env.PARAAI_REPLY_POLL_SECONDS) || 45)),
    mailbox: outreachMailbox(env),
    gmailConfigured: gmailConfigured(env),
    storeConfigured: storeConfigured(),
  };
}

// Read + classify + plan. True whenever the subsystem may look at replies at
// all; writing is gated separately per action below.
export function replyDetectionEnabled(config = replyConfig()) {
  return Boolean(config.approved && config.gmailConfigured && config.storeConfigured);
}

// Shadow mode: detection on, every write gate shut. This is the burn-in state.
export function replyShadowMode(config = replyConfig()) {
  return Boolean(
    replyDetectionEnabled(config)
    && (config.dryRun !== false || !config.submitApproved),
  );
}

export function replyActionEnabled(action, config = replyConfig()) {
  if (!replyDetectionEnabled(config)) return false;
  if (config.dryRun !== false) return false;
  if (config.notBeforeMs == null) return false;
  if (action === "yes") return config.submitApproved === true;
  if (action === "no") return config.passApproved === true;
  if (action === "off_market") return config.offMarketApproved === true && config.passApproved === true;
  return false;
}

const replyIdFor = (candidateUserId, messageId) => `${candidateUserId}:${messageId}`;

// A candidate's screening job, used to source transcript-grounded answers.
//
// The job record carries the resolved id at identity.candidateUserId. The other
// paths are kept as fallbacks for older records, but identity is the one that
// actually matches: reading only the top-level field silently found nothing and
// sent every yes to review as no_screening_call_record (caught by the first
// backfill on 2026-07-28, where 0 of 241 identified jobs matched).
export function findJobForCandidate(jobs, candidateUserId) {
  const wanted = text(candidateUserId);
  if (!wanted) return null;
  return jobs.find((job) => {
    const ids = [
      job?.identity?.candidateUserId,
      job?.candidateUserId,
      job?.candidate?.candidateUserId,
      job?.candidate?.candidate_user_id,
      job?.submission?.candidateUserId,
    ];
    return ids.some((id) => text(id) && text(id) === wanted);
  }) || null;
}

export async function planReplyAction(record, { requests, jobs, config }) {
  const pending = pendingRequestsFor(record.candidateUserId, requests);
  const decision = record.decision;
  if (!pending.length) {
    return { action: "none", reason: "no_pending_requests" };
  }
  if (decision.intent === "uncertain") {
    return { action: "review", reason: decision.reviewReason || "uncertain", requestIds: pending.map((r) => r.id) };
  }
  if (decision.intent === "no") {
    return { action: "pass", reason: "not_interested", requestIds: decision.targetRequestIds };
  }
  if (decision.intent === "off_market") {
    return { action: "off_market", reason: "off_market", requestIds: pending.map((r) => r.id) };
  }
  // yes
  const targets = pending.filter((request) => decision.targetRequestIds.includes(request.id));
  if (!targets.length) return { action: "review", reason: "target_not_pending", requestIds: pending.map((r) => r.id) };
  const job = findJobForCandidate(jobs, record.candidateUserId);
  if (!job) return { action: "review", reason: "no_screening_call_record", requestIds: targets.map((r) => r.id) };
  return { action: "submit", reason: "definitive_yes", requestIds: targets.map((r) => r.id), jobId: job.id || job.botId || null };
}

export async function prepareSubmission(request, record, job, { fetchImpl = fetch } = {}) {
  const form = await readQuickSubmitForm(request.id);
  if (form?.eligibility?.status === "alreadySubmitted") {
    return { skip: "already_submitted", form };
  }
  if (form?.eligibility?.status && form.eligibility.status !== "eligible") {
    return { blocked: [`eligibility is ${form.eligibility.status}`], form };
  }
  const preferences = await candidatePreferencesReady(
    form?.candidateUserId || record.candidateUserId,
    [],
  ).catch(() => ({ ready: true, missingFields: [] }));
  if (!preferences.ready) {
    return { blocked: [`candidate preferences incomplete: ${preferences.missingFields.join(", ") || "unknown"}`], form };
  }

  let call = null;
  const botId = job?.botId || job?.id || null;
  if (botId) call = await fetchCall(botId).catch(() => null);

  const context = buildAnswerContext({
    form,
    request,
    call,
    extracted: job?.extracted || null,
    replySignals: record.decision?.evidence ? { evidence: record.decision.evidence, conditions: record.decision.conditions } : null,
  });
  const generated = await generateSubmissionAnswers(context, { fetchImpl });
  const payload = assemblePayload({ form, generated, call, extracted: job?.extracted || null });
  const blocked = quickSubmitBlockingReasons(form, payload);
  return { form, payload, generated, call, blocked: blocked.length ? blocked : null };
}

export async function executeAction(record, plan, { requests, jobs, config, fetchImpl = fetch, force = false }) {
  const results = [];
  const byId = new Map(requests.map((request) => [request.id, request]));
  // force is the operator path: a human clicked the card, so the per-action
  // automation gates do not apply. The endpoint still demands the master switch
  // and a confirmation string before it ever gets here.
  const mayWrite = (action) => force || replyActionEnabled(action, config);

  if (plan.action === "submit") {
    for (const requestId of plan.requestIds) {
      const request = byId.get(requestId);
      if (!request) { results.push({ requestId, outcome: "missing" }); continue; }
      const job = findJobForCandidate(jobs, record.candidateUserId);
      const prepared = await prepareSubmission(request, record, job, { fetchImpl });
      if (prepared.skip) { results.push({ requestId, outcome: prepared.skip }); continue; }
      if (prepared.blocked) {
        results.push({ requestId, outcome: "blocked", blocked: prepared.blocked });
        continue;
      }
      if (!mayWrite("yes")) {
        results.push({ requestId, outcome: "shadow", payload: redactPayload(prepared.payload) });
        continue;
      }
      if (request.clientNote) {
        await confirmInterest(request.id, { hasClientNote: true, recruiterResponse: null }).catch(() => {});
      } else {
        await confirmInterest(request.id, { hasClientNote: false }).catch(() => {});
      }
      const outcome = await performQuickSubmit(request, prepared.payload);
      results.push({ requestId, outcome: outcome.verified ? "submitted" : "unverified" });
    }
    return results;
  }

  if (plan.action === "pass" || plan.action === "off_market") {
    const reasonKey = plan.action === "off_market" ? "off_market" : "not_interested";
    for (const requestId of plan.requestIds) {
      const request = byId.get(requestId);
      if (!request) { results.push({ requestId, outcome: "missing" }); continue; }
      if (!mayWrite(plan.action === "off_market" ? "off_market" : "no")) {
        results.push({ requestId, outcome: "shadow", reason: passReasonText(reasonKey) });
        continue;
      }
      const outcome = await performPass(request, reasonKey);
      results.push({ requestId, outcome: outcome.verified ? "dismissed" : "unverified" });
    }
    if (plan.action === "off_market" && mayWrite("off_market")) {
      const offMarket = await performOffMarket(record.candidateUserId);
      results.push({ requestId: null, outcome: "off_market", verified: offMarket.verified });
    }
    return results;
  }
  return results;
}

// Slack never carries reply text or candidate contact details: the verbatim
// evidence stays in the private store and on the gated review card.
function redactPayload(payload) {
  return {
    resume_id: Boolean(payload?.resume_id),
    great_fit_reason_chars: text(payload?.great_fit_reason).length,
    open_ended_chars: text(payload?.open_ended_submission).length,
    answers: (payload?.question_answers || []).length,
    phone_screened: payload?.phone_screened === true,
  };
}

async function alertReview(record, plan) {
  const key = `reply-review:${record.replyId}`;
  if (!(await takeAlertSlot(key, 24 * 3600).catch(() => false))) return false;
  const who = record.candidateName || "A candidate";
  const roles = (plan.requestIds || []).length;
  return notifySlack(
    `⚠️ Para AI reply needs a decision: ${who} replied and the classifier could not act `
    + `(${plan.reason}). ${roles} pending request${roles === 1 ? "" : "s"}. `
    + `Review: https://monitor.raydar.xyz/paraai`,
  ).catch(() => false);
}

export async function runReplyTick({ config = replyConfig(), now = Date.now(), fetchImpl = fetch } = {}) {
  if (!replyDetectionEnabled(config)) {
    return { enabled: false, processed: 0, reason: "reply_gates_closed" };
  }
  const pollToken = await acquireReplyPollSlot({ ttlSeconds: config.pollLockSeconds });
  if (!pollToken) return { enabled: true, processed: 0, reason: "poll_not_due" };
  try {
    return await scanReplies({ config, now, fetchImpl, mode: "organic", limit: config.batchSize });
  } finally {
    await releaseReplyPollSlot(pollToken).catch(() => {});
  }
}

// THE BACKFILL. Same read/classify/plan path as the organic tick, with three
// differences that follow the Para AI backfill freeze rule:
//   1. it ignores the arming pin, because catching up on history is the point;
//   2. every record it writes is tagged backfillOnly and re-anchored at batch
//      entry, so the organic tick can never race it later; and
//   3. it is capped per run and only ever runs from an explicit, confirmed
//      operator call, never from the worker.
// Write authority is unchanged: with the gates shut this classifies and plans
// without writing, which is exactly the shadow dataset to review before arming.
export async function runReplyBackfill({
  config = replyConfig(),
  now = Date.now(),
  fetchImpl = fetch,
  limit = Number(process.env.PARAAI_REPLY_BACKFILL_LIMIT) || 25,
} = {}) {
  if (!replyDetectionEnabled(config)) {
    return { enabled: false, processed: 0, reason: "reply_gates_closed" };
  }
  const pollToken = await acquireReplyPollSlot({ ttlSeconds: Math.max(120, config.pollLockSeconds) });
  if (!pollToken) return { enabled: true, processed: 0, reason: "poll_not_due" };
  try {
    return await scanReplies({
      config,
      now,
      fetchImpl,
      mode: "backfill",
      limit: Math.max(1, Math.min(200, Number(limit) || 25)),
      ignoreArmingPin: true,
    });
  } finally {
    await releaseReplyPollSlot(pollToken).catch(() => {});
  }
}

async function scanReplies({ config, now, fetchImpl, mode, limit, ignoreArmingPin = false }) {
  {
    const [states, requests, jobs] = await Promise.all([
      listOutreachStates(),
      readSubmissionRequests(),
      listJobs(300).catch(() => []),
    ]);
    const results = [];
    let processed = 0;
    let scanned = 0;
    let skippedNoPending = 0;
    let skippedNoReply = 0;
    let skippedMachine = 0;
    let skippedSeen = 0;

    for (const state of states) {
      if (processed >= limit) break;
      if (!state?.threadId || !state?.candidateUserId) continue;
      scanned += 1;
      const pending = pendingRequestsFor(state.candidateUserId, requests);
      if (!pending.length) { skippedNoPending += 1; continue; }

      const thread = await getThread(config.mailbox, state.threadId).catch(() => null);
      if (!thread) continue;
      const anchor = finiteDate(state.firstOutboundAt) ?? firstDeliveredInternalDate(thread) ?? 0;
      const replies = candidateReplyMessages(thread, config.mailbox, anchor);
      if (!replies.length) { skippedNoReply += 1; continue; }

      const latest = replies[replies.length - 1];
      // The arming pin applies to the REPLY, so first arming cannot action a
      // backlog of older replies. The backfill is the sanctioned way past it.
      if (!ignoreArmingPin && config.notBeforeMs != null && latest.internalDate < config.notBeforeMs) continue;

      const replyId = replyIdFor(state.candidateUserId, latest.id);
      // A record already exists, which includes every backfillOnly record: that
      // is the freeze rule, and it is why the two lanes can never double-action.
      if (await readReplyRecord(replyId)) { skippedSeen += 1; continue; }

      const body = stripQuotedReply(latest.body);
      if (isMachineReply(latest.message, body)) { skippedMachine += 1; continue; }

      const lock = await acquireReplyLock(replyId);
      if (!lock) continue;
      try {
        processed += 1;
        let record = {
          replyId,
          candidateUserId: state.candidateUserId,
          candidateName: pending[0]?.candidateName || null,
          threadId: state.threadId,
          messageId: latest.id,
          receivedAt: new Date(latest.internalDate).toISOString(),
          body,
          status: "classified",
          source: mode,
          backfillOnly: mode === "backfill",
          // Backfilled clocks anchor at batch entry, never at the original
          // (possibly weeks-old) reply time.
          anchorAt: new Date(mode === "backfill" ? now : latest.internalDate).toISOString(),
        };
        const { signals, summary, model, provider } = await extractReplySignals(body, { fetchImpl });
        const decision = classifyReply(signals, { pendingRequests: pending });
        record = { ...record, signals, summary, model, provider, decision };

        const plan = await planReplyAction(record, { requests, jobs, config });
        record.plan = plan;
        record.shadow = !replyActionEnabled(
          plan.action === "submit" ? "yes" : plan.action === "pass" ? "no" : plan.action,
          config,
        );

        const created = await createReplyRecord(record);
        record = created.record;

        if (plan.action === "review" || plan.action === "none") {
          record.status = plan.action === "none" ? "no_action" : "needs_review";
          if (plan.action === "review") await alertReview(record, plan);
        } else {
          const actionResults = await executeAction(record, plan, { requests, jobs, config, fetchImpl })
            .catch((error) => [{ requestId: null, outcome: "error", code: error?.code || "REPLY_ACTION_FAILED", message: text(error?.message).slice(0, 240) }]);
          record.results = actionResults;
          const failed = actionResults.filter((row) => row.outcome === "error" || row.outcome === "unverified" || row.outcome === "blocked");
          record.status = record.shadow
            ? "shadow_planned"
            : failed.length ? "needs_review" : "actioned";
          if (failed.length && !record.shadow) await alertReview(record, { ...plan, reason: failed[0].code || failed[0].outcome });
        }
        await saveReplyRecord(record, record.revision);
        results.push({
          replyId,
          intent: record.decision.intent,
          action: plan.action,
          status: record.status,
          shadow: record.shadow === true,
        });
      } catch (error) {
        results.push({
          replyId,
          action: "error",
          code: error?.code || "REPLY_TICK_FAILED",
          message: text(error?.message).slice(0, 240),
        });
        if (error?.code === "AUTH_EXPIRED") {
          if (await takeAlertSlot("reply-auth-expired", 12 * 3600).catch(() => false)) {
            await notifySlack("🚨 Para AI reply actioning paused: the Paraform session cookie expired and needs rotating.").catch(() => {});
          }
          break;
        }
      } finally {
        await releaseReplyLock(replyId, lock).catch(() => {});
      }
    }
    return {
      enabled: true,
      mode,
      processed,
      limit,
      more: processed >= limit,
      scanned,
      skipped: {
        noPendingRequest: skippedNoPending,
        noReply: skippedNoReply,
        machineMail: skippedMachine,
        alreadyRecorded: skippedSeen,
      },
      results,
    };
  }
}

export async function replyHealth({ config = replyConfig() } = {}) {
  const records = await listReplyRecords(200).catch(() => []);
  const counts = records.reduce((acc, record) => {
    const key = record?.status || "unknown";
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
  return {
    approved: config.approved,
    dryRun: config.dryRun,
    notBeforePinned: config.notBeforeMs != null,
    submitApproved: config.submitApproved,
    passApproved: config.passApproved,
    offMarketApproved: config.offMarketApproved,
    gmailConfigured: config.gmailConfigured,
    storeConfigured: config.storeConfigured,
    detectionEnabled: replyDetectionEnabled(config),
    shadowMode: replyShadowMode(config),
    writeAuthority: {
      yes: replyActionEnabled("yes", config),
      no: replyActionEnabled("no", config),
      off_market: replyActionEnabled("off_market", config),
    },
    counts,
    total: records.length,
  };
}

export { listReplyRecords, readReplyRecord, saveReplyRecord, expiresAtMs };
