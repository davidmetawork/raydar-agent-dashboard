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
function findJobForCandidate(jobs, candidateUserId) {
  return jobs.find((job) => {
    const ids = [job?.candidateUserId, job?.candidate?.candidateUserId, job?.submission?.candidateUserId];
    return ids.some((id) => text(id) && text(id) === text(candidateUserId));
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

async function prepareSubmission(request, record, job, { fetchImpl = fetch } = {}) {
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

async function executeAction(record, plan, { requests, jobs, config, fetchImpl = fetch }) {
  const results = [];
  const byId = new Map(requests.map((request) => [request.id, request]));

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
      if (!replyActionEnabled("yes", config)) {
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
      if (!replyActionEnabled(plan.action === "off_market" ? "off_market" : "no", config)) {
        results.push({ requestId, outcome: "shadow", reason: passReasonText(reasonKey) });
        continue;
      }
      const outcome = await performPass(request, reasonKey);
      results.push({ requestId, outcome: outcome.verified ? "dismissed" : "unverified" });
    }
    if (plan.action === "off_market" && replyActionEnabled("off_market", config)) {
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
    const [states, requests, jobs] = await Promise.all([
      listOutreachStates(),
      readSubmissionRequests(),
      listJobs(300).catch(() => []),
    ]);
    const results = [];
    let processed = 0;

    for (const state of states) {
      if (processed >= config.batchSize) break;
      if (!state?.threadId || !state?.candidateUserId) continue;
      const pending = pendingRequestsFor(state.candidateUserId, requests);
      if (!pending.length) continue;

      const thread = await getThread(config.mailbox, state.threadId).catch(() => null);
      if (!thread) continue;
      const anchor = finiteDate(state.firstOutboundAt) ?? firstDeliveredInternalDate(thread) ?? 0;
      const replies = candidateReplyMessages(thread, config.mailbox, anchor);
      if (!replies.length) continue;

      const latest = replies[replies.length - 1];
      // The arming pin applies to the REPLY, so first arming cannot action a
      // backlog of older replies.
      if (config.notBeforeMs != null && latest.internalDate < config.notBeforeMs) continue;

      const replyId = replyIdFor(state.candidateUserId, latest.id);
      if (await readReplyRecord(replyId)) continue;

      const body = stripQuotedReply(latest.body);
      if (isMachineReply(latest.message, body)) continue;

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
        results.push({ replyId, intent: record.decision.intent, action: plan.action, status: record.status });
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
    return { enabled: true, processed, results };
  } finally {
    await releaseReplyPollSlot(pollToken).catch(() => {});
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
