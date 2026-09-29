// Para AI reply auto-pass (David, 2026-09-29).
//
// When a candidate we emailed about a hiring manager's interview request tells
// us no, the request should not sit pending on paraform.com/home until it
// expires. After each outreach tick this step:
//
//   1. re-reads the conversation of every candidate who still has a PENDING
//      request (Gmail thread or Mailroom conversation), at most once per
//      recheck interval, with the SAME live assessor the send path uses
//      (assessOutreachThread + assessmentPatch). What holds a new request and
//      what passes an open one therefore come from one judgment;
//   2. passes (dismisses on Paraform) each pending request whose candidate is
//      held off the market, asked not to be contacted, or declined that role.
//      Requests the outreach lane is already holding for those reasons are
//      passed the same way.
//
// David's decisions: pass the requests only, never Paraform's network-wide
// off-market switch; live on release, no shadow period; one Slack line per
// pass. An interested reply is NOT handled here (it goes to the CRM
// Submissions tab), and an unclear reply is left alone.
//
// Write discipline is the armed expired lane's: the neutral cross-lane claim
// first, exactly one attempt through the request-lane throttle, and the
// outcome proven by re-reading the request history. A throttle refusal means
// Paraform never took the call, so the lane releases its own claim and the
// next tick re-plans from fresh history.
import {
  boundRequestLaneTrpc,
  REQUEST_LANE_COOLDOWN_CODE,
  REQUEST_LANE_RATE_LIMITED_CODE,
} from "./request-lane-throttle.mjs";
import {
  claimSubmissionRequestAttempt,
  readSubmissionRequestClaim,
  releaseSubmissionRequestClaim,
} from "./request-claim.mjs";
import { PASS_REASONS } from "./reply-actions.mjs";
import {
  activeOffMarketHold,
  INTENT_DO_NOT_CONTACT,
  INTENT_OFF_MARKET,
} from "./outreach-intent.mjs";
import { roleDeclined } from "./outreach-decline.mjs";
import {
  acquireOutreachLock,
  appendOutreachJournal,
  claimOutreachExceptionAlert,
  getOutreachState,
  releaseOutreachLock,
  resolveOutreachException,
  saveOutreachState,
} from "./outreach-store.mjs";
import { notifySlack } from "./core.mjs";

const { trpcPost } = boundRequestLaneTrpc("reply");

export const REPLY_PASS_LANE = "reply-pass";
const DEFAULT_RECHECK_MINUTES = 30;
const DEFAULT_ASSESS_LIMIT = 4;
const DEFAULT_PASS_LIMIT = 3;
const UNVERIFIED_ALERT_TTL_SECONDS = 7 * 24 * 60 * 60;

const clean = (value) => String(value || "").trim();
const finiteDate = (value) => {
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : null;
};

export function replyPassConfig(env = process.env) {
  const number = (value, fallback, min, max) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? Math.max(min, Math.min(max, parsed)) : fallback;
  };
  return {
    // Code-side stop: PARAAI_REPLY_PASS=off. The lane also stops with the
    // outreach tick (brake scope paraaiRequestLanes, cooldown, Gmail breaker).
    enabled: clean(env.PARAAI_REPLY_PASS).toLowerCase() !== "off",
    recheckMs: number(env.PARAAI_REPLY_PASS_RECHECK_MINUTES, DEFAULT_RECHECK_MINUTES, 5, 24 * 60) * 60_000,
    assessLimit: number(env.PARAAI_REPLY_PASS_ASSESS_LIMIT, DEFAULT_ASSESS_LIMIT, 1, 20),
    passLimit: number(env.PARAAI_REPLY_PASS_LIMIT, DEFAULT_PASS_LIMIT, 1, 10),
  };
}

// Shown to the hiring manager, so neutral and never the candidate's words.
export function replyPassReason(cause) {
  return cause === "off_market" ? PASS_REASONS.off_market : PASS_REASONS.not_interested;
}

// True when we emailed (or queued an email to) the candidate about this
// request AFTER they said it. That is David overriding the hold ("send it
// anyway"), and an override must never be undone by passing the request.
export function contactedAfter(state, requestId, sinceIso) {
  const since = finiteDate(sinceIso);
  if (since == null) return false;
  const outbox = state?.outbox?.[`match:${requestId}`];
  if (outbox && outbox.status !== "released" && (finiteDate(outbox.claimedAt) ?? -Infinity) > since) {
    return true;
  }
  const match = state?.matches?.[requestId];
  return (finiteDate(match?.sentAt) ?? -Infinity) > since;
}

// A send for this request that has not settled yet (claimed, queued in the
// Mailroom, or uncertain). Passing under it could leave an email about a
// passed request still on its way, so the pass waits for it to settle.
export function sendInFlight(state, requestId) {
  const outbox = state?.outbox?.[`match:${requestId}`];
  return ["claimed", "queued", "uncertain"].includes(clean(outbox?.status));
}

// What the candidate's recorded words authorize for one pending request, or
// null. Pure: the state already carries every verdict the assessor latched.
export function passCauseFor(state, request, now = Date.now()) {
  if (!state || !request?.id) return null;
  if (state.passedRequests?.[request.id]) return null;
  if (sendInFlight(state, request.id)) return null;
  const hold = activeOffMarketHold(state, now);
  if (hold?.verdict === INTENT_OFF_MARKET || hold?.verdict === INTENT_DO_NOT_CONTACT) {
    if (contactedAfter(state, request.id, hold.detectedAt)) return null;
    return {
      cause: hold.verdict === INTENT_OFF_MARKET ? "off_market" : "do_not_contact",
      statedAt: hold.detectedAt || null,
      holdUntil: hold.expiresAt || null,
    };
  }
  const declined = roleDeclined(state, request.roleId);
  if (declined) {
    if (contactedAfter(state, request.id, declined.declinedAt)) return null;
    return { cause: "declined", statedAt: declined.declinedAt || null, holdUntil: null };
  }
  return null;
}

export function pendingRequestsByCandidate(history) {
  const byCandidate = new Map();
  for (const request of history || []) {
    if (clean(request?.status).toLowerCase() !== "pending") continue;
    const id = clean(request?.candidateUserId);
    if (!id || !clean(request?.id)) continue;
    if (!byCandidate.has(id)) byCandidate.set(id, []);
    byCandidate.get(id).push(request);
  }
  return byCandidate;
}

// Every pass the recorded words authorize, oldest request first. The caller
// caps real Paraform attempts, not plans, so a request whose earlier attempt
// could not be proven never starves the ones behind it.
export function planReplyPasses({ history, states, now = Date.now() }) {
  const byCandidate = pendingRequestsByCandidate(history);
  const stateById = new Map((states || []).map((state) => [clean(state?.candidateUserId), state]));
  const plans = [];
  for (const [candidateUserId, requests] of byCandidate) {
    const state = stateById.get(candidateUserId);
    if (!state) continue;
    for (const request of requests) {
      const found = passCauseFor(state, request, now);
      if (found) plans.push({ request, candidateUserId, ...found });
    }
  }
  plans.sort((left, right) => (
    (left.request.createdAtMs ?? Number.MAX_SAFE_INTEGER) - (right.request.createdAtMs ?? Number.MAX_SAFE_INTEGER)
    || left.request.id.localeCompare(right.request.id)
  ));
  return plans;
}

// Candidates whose conversation should be re-read this tick: they still have a
// pending request, we have actually written to them, and they were not read
// within the recheck interval. Least recently read first.
export function candidatesToAssess({ history, states, now = Date.now(), recheckMs, limit }) {
  const byCandidate = pendingRequestsByCandidate(history);
  return (states || [])
    .filter((state) => (
      byCandidate.has(clean(state?.candidateUserId)) &&
      (clean(state?.threadId) || state?.mailroomConversation) &&
      now - (finiteDate(state?.replyPassCheckedAt) ?? 0) >= recheckMs
    ))
    .sort((left, right) => (
      (finiteDate(left.replyPassCheckedAt) ?? 0) - (finiteDate(right.replyPassCheckedAt) ?? 0)
    ))
    .slice(0, limit);
}

const displayName = (value) => clean(value) || "a candidate";

export function replyPassSlackLine({ request, cause, holdUntil }) {
  const what = `${clean(request.roleName) || "a role"} @ ${clean(request.companyName) || "a company"}`;
  const why = cause === "off_market"
    ? `they said they are off the market${holdUntil ? ` (our hold runs to ${clean(holdUntil).slice(0, 10)})` : ""}`
    : cause === "do_not_contact"
      ? "they asked us not to contact them"
      : "they said no to this role";
  return `✋ Para AI: passed ${what} for ${displayName(request.candidateName)} on Paraform, because ${why}.`;
}

const throttled = (error) => [REQUEST_LANE_COOLDOWN_CODE, REQUEST_LANE_RATE_LIMITED_CODE].includes(error?.code);

export async function runReplyPassStep({
  history,
  states,
  config,
  now = Date.now(),
  passConfig = replyPassConfig(),
  // From outreach.mjs, injected so this module never imports it back.
  assessImpl,
  assessmentPatchImpl,
  historyImpl,
  getStateImpl = getOutreachState,
  saveStateImpl = saveOutreachState,
  lockImpl = acquireOutreachLock,
  unlockImpl = releaseOutreachLock,
  dismissImpl = (id, dismissReason) => trpcPost("submissionRequest.dismissSubmissionRequest", { id, dismissReason }),
  claimImpl = claimSubmissionRequestAttempt,
  readClaimImpl = readSubmissionRequestClaim,
  releaseClaimImpl = releaseSubmissionRequestClaim,
  resolveExceptionImpl = resolveOutreachException,
  notifyImpl = notifySlack,
  alertSlotImpl = (key, ttlSeconds) => claimOutreachExceptionAlert(key, { ttlSeconds }),
} = {}) {
  const summary = { enabled: passConfig.enabled, assessed: 0, passed: [], skipped: [], unverified: [], stopped: null };
  if (!passConfig.enabled) return summary;

  // 1. Re-read conversations, latching verdicts exactly as the send path does.
  const latest = new Map((states || []).map((state) => [clean(state?.candidateUserId), state]));
  for (const candidate of candidatesToAssess({
    history,
    states,
    now,
    recheckMs: passConfig.recheckMs,
    limit: passConfig.assessLimit,
  })) {
    const candidateUserId = clean(candidate.candidateUserId);
    const lockToken = await lockImpl(candidateUserId).catch(() => null);
    if (!lockToken) continue;
    try {
      let state = await getStateImpl(candidateUserId);
      if (!state) continue;
      const assessment = await assessImpl({ state, config, history }).catch(() => ({ checked: false }));
      summary.assessed += 1;
      const { patch, event } = assessment?.checked
        ? assessmentPatchImpl(assessment, {
          requestId: null,
          address: state.candidateEmail || null,
          repliedAt: state.repliedAt,
          stoppedReason: state.stoppedReason,
          state,
        })
        : { patch: {}, event: null };
      const next = { ...state, ...patch, replyPassCheckedAt: new Date(now).toISOString() };
      state = await saveStateImpl(
        event && Object.keys(patch).length
          ? appendOutreachJournal(next, event, {
            source: REPLY_PASS_LANE,
            verdict: assessment.verdict || null,
            intentSource: assessment.intent?.source || null,
          })
          : next,
        state.revision,
      ).catch(() => null);
      if (state) latest.set(candidateUserId, state);
    } finally {
      await unlockImpl(candidateUserId, lockToken).catch(() => {});
    }
  }

  // 2. Pass what the recorded words authorize.
  const plans = planReplyPasses({ history, states: [...latest.values()], now });
  const attempted = [];
  for (const plan of plans) {
    if (attempted.length >= passConfig.passLimit) break;
    const { request } = plan;
    const claim = await claimImpl(request.id, "pass", REPLY_PASS_LANE).catch(() => null);
    if (claim?.status !== "claimed") {
      const existing = claim?.claim || await readClaimImpl(request.id).catch(() => null);
      // Our own earlier attempt that never verified: say so once, never retry.
      if (existing?.lane === REPLY_PASS_LANE) summary.unverified.push({ requestId: request.id, earlier: true, plan });
      else summary.skipped.push({ requestId: request.id, reason: `claimed_by_${existing?.lane || existing?.namespace || "unknown"}` });
      continue;
    }
    try {
      await dismissImpl(request.id, replyPassReason(plan.cause));
      attempted.push({ plan, claim: claim.claim });
    } catch (error) {
      if (throttled(error) || error?.code === "AUTH_EXPIRED") {
        // Paraform never took this call: give the request back and stop.
        await releaseClaimImpl(request.id, claim.claim.claimId, { lane: REPLY_PASS_LANE }).catch(() => {});
        summary.stopped = clean(error.code);
        break;
      }
      // Unknown outcome: the read-back below decides.
      attempted.push({ plan, claim: claim.claim, error: clean(error?.code || error?.message).slice(0, 120) });
    }
  }

  // 3. Prove every attempt by re-reading the history, once for the batch.
  let fresh = null;
  if (attempted.length) {
    fresh = await historyImpl().catch((error) => {
      summary.stopped = summary.stopped || clean(error?.code || "history_unreadable");
      return null;
    });
  }
  const freshById = new Map((fresh || []).map((row) => [row.id, row]));
  for (const { plan, error } of attempted) {
    const row = freshById.get(plan.request.id);
    const status = clean(row?.status).toLowerCase();
    if (fresh && status && status !== "pending") {
      summary.passed.push({ requestId: plan.request.id, cause: plan.cause, status });
      await resolveExceptionImpl(plan.request.id, { resolution: `passed_on_paraform:${plan.cause}` }).catch(() => null);
      await recordPass(plan, { status, now, getStateImpl, saveStateImpl }).catch(() => null);
      await notifyImpl(replyPassSlackLine(plan)).catch(() => false);
    } else {
      summary.unverified.push({ requestId: plan.request.id, plan, error: error || null, readBack: fresh ? (status || "missing") : "unread" });
    }
  }

  // A claimed pass that could not be proven is never retried; it is surfaced
  // once so a person can look at the card.
  for (const item of summary.unverified) {
    const slotKey = `reply-pass-unverified:${item.requestId}`;
    const claimed = await alertSlotImpl(slotKey, UNVERIFIED_ALERT_TTL_SECONDS).catch(() => false);
    if (!claimed || !item.plan) continue;
    const { request } = item.plan;
    await notifyImpl(
      `⚠️ Para AI: tried to pass ${clean(request.roleName) || "a role"} @ ${clean(request.companyName) || "a company"} `
      + `for ${displayName(request.candidateName)} on Paraform but could not confirm it went through. `
      + "It will not be retried; check the card on paraform.com/home.",
    ).catch(() => false);
  }
  return {
    ...summary,
    unverified: summary.unverified.map(({ requestId, earlier, error, readBack }) => ({
      requestId,
      ...(earlier ? { earlier: true } : {}),
      ...(error ? { error } : {}),
      ...(readBack ? { readBack } : {}),
    })),
  };
}

async function recordPass(plan, { status, now, getStateImpl, saveStateImpl }) {
  const state = await getStateImpl(plan.candidateUserId);
  if (!state) return null;
  return saveStateImpl(appendOutreachJournal({
    ...state,
    passedRequests: {
      ...(state.passedRequests || {}),
      [plan.request.id]: {
        at: new Date(now).toISOString(),
        cause: plan.cause,
        statedAt: plan.statedAt || null,
        roleId: plan.request.roleId || null,
        status,
      },
    },
  }, "request_passed_on_paraform", {
    requestId: plan.request.id,
    cause: plan.cause,
    source: REPLY_PASS_LANE,
  }), state.revision);
}
