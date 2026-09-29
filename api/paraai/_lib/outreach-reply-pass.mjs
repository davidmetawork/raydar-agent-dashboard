// Para AI reply auto-pass (David, 2026-09-29).
//
// When a candidate we emailed about a hiring manager's interview request tells
// us no, the request should not sit pending on paraform.com/home until it
// expires. After each outreach tick this step:
//
//   1. confirms the passes it attempted on earlier ticks against THIS tick's
//      history read (no extra Paraform call): a row now "dismissed" is a
//      confirmed pass, announced once in Slack;
//   2. re-reads the conversation of every candidate who still has a PENDING
//      request (Gmail thread or Mailroom conversation), at most once per
//      recheck interval, with the SAME live assessor the send path uses
//      (assessOutreachThread + assessmentPatch). What holds a new request and
//      what passes an open one therefore come from one judgment;
//   3. passes (dismisses on Paraform) each pending request whose candidate the
//      MODEL judged off the market or asked not to be contacted, or who
//      recently declined that role. Requests the outreach lane is already
//      holding for those reasons are passed the same way.
//
// David's decisions: pass the requests only, never Paraform's network-wide
// off-market switch; live on release, no shadow period; one Slack line per
// pass. An interested reply is NOT handled here (it goes to the CRM
// Submissions tab), and an unclear reply is left alone.
//
// A pass cannot be undone, so it acts only on a verdict the model gave. The
// assessor's phrase shortcut ("unsubscribe", "take me off") and its
// model-unavailable fallback still hold new requests, but never pass one.
//
// Write discipline: under the candidate's lock, re-read the state and re-plan,
// take the neutral cross-lane claim, record the attempt on the state, then
// exactly one attempt through the request-lane throttle. A throttle refusal
// (refused before sending, or answered 401/429, so Paraform did not act)
// gives the claim back. Anything else is judged by the next tick's history:
// "dismissed" confirms it; still pending means it did not take, which is
// flagged once and never retried; any other status gives the request back.
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
  getGmailBackoff,
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
// The worker function has a 120 s ceiling and the expired lane runs after
// this tick, so this step starts no new work once the TICK (its sends
// included) has run this long.
const DEFAULT_BUDGET_MS = 60_000;
// An attempted pass whose request has left Paraform's history entirely can
// never be confirmed; after this long (past the 7-day request expiry) the
// record is dropped with a journal note instead of being re-read forever.
const MISSING_ROW_GIVE_UP_MS = 14 * 24 * 60 * 60 * 1000;
// A decline older than this when the request arrived is not the candidate's
// answer to it: that request stays held for David instead of being passed.
const DECLINE_FRESH_MS = 30 * 24 * 60 * 60 * 1000;
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
    budgetMs: DEFAULT_BUDGET_MS,
  };
}

// Shown to the hiring manager, so neutral and never the candidate's words.
export function replyPassReason(cause) {
  return cause === "off_market" ? PASS_REASONS.off_market : PASS_REASONS.not_interested;
}

// Every outbox entry about this request: its own match send, and any operator
// bundle that included it.
function outboxEntriesFor(state, requestId) {
  return Object.entries(state?.outbox || {})
    .filter(([key, entry]) => (
      key === `match:${requestId}` ||
      clean(entry?.requestId) === requestId ||
      (Array.isArray(entry?.requestIds) && entry.requestIds.map(clean).includes(requestId))
    ))
    .map(([, entry]) => entry);
}

// A send for this request that has not settled yet (claimed, queued in the
// Mailroom, or uncertain). Passing under it could leave an email about a
// passed request still on its way, so the pass waits for it to settle.
export function sendInFlight(state, requestId) {
  return outboxEntriesFor(state, requestId)
    .some((entry) => ["claimed", "queued", "uncertain"].includes(clean(entry?.status)));
}

// True when we emailed (or queued an email to) the candidate about this
// request AFTER they said it. That is David overriding the hold ("send it
// anyway"), and an override must never be undone by passing the request.
export function contactedAfter(state, requestId, sinceIso) {
  const since = finiteDate(sinceIso);
  if (since == null) return false;
  const sentLater = outboxEntriesFor(state, requestId).some((entry) => (
    entry?.status !== "released" && (finiteDate(entry?.claimedAt) ?? -Infinity) > since
  ));
  if (sentLater) return true;
  return (finiteDate(state?.matches?.[requestId]?.sentAt) ?? -Infinity) > since;
}

// What the candidate's recorded words authorize for one pending request, or
// null. Pure: the state already carries every verdict the assessor latched.
export function passCauseFor(state, request, now = Date.now()) {
  if (!state || !request?.id) return null;
  if (state.passedRequests?.[request.id] || state.pendingPasses?.[request.id]) return null;
  if (sendInFlight(state, request.id)) return null;
  const hold = activeOffMarketHold(state, now);
  if (
    (hold?.verdict === INTENT_OFF_MARKET || hold?.verdict === INTENT_DO_NOT_CONTACT) &&
    hold.source === "model"
  ) {
    if (contactedAfter(state, request.id, hold.detectedAt)) return null;
    return {
      cause: hold.verdict === INTENT_OFF_MARKET ? "off_market" : "do_not_contact",
      statedAt: hold.detectedAt || null,
      holdUntil: hold.expiresAt || null,
    };
  }
  const declined = roleDeclined(state, request.roleId);
  if (declined && declined.source === "model") {
    const declinedAt = finiteDate(declined.declinedAt);
    if (declinedAt == null) return null;
    if (request.createdAtMs != null && request.createdAtMs - declinedAt > DECLINE_FRESH_MS) return null;
    if (contactedAfter(state, request.id, declined.declinedAt)) return null;
    return { cause: "declined", statedAt: declined.declinedAt, holdUntil: null };
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
// caps real Paraform attempts, not plans.
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

const same = (left, right) => JSON.stringify(left ?? null) === JSON.stringify(right ?? null);

// Only what the assessment actually changed. assessmentPatch re-states every
// field for anyone who has replied (and restamps a known bounce and hold), so
// saving it whole on every re-read would churn the 200-entry journal.
export function changedFields(state, patch) {
  const changed = {};
  for (const [key, value] of Object.entries(patch || {})) {
    if (key === "offMarket" && state?.offMarket &&
      state.offMarket.verdict === value?.verdict && state.offMarket.detectedAt === value?.detectedAt) continue;
    if (key === "bounce" && state?.bounce && clean(state.bounce.at) === clean(value?.at)) continue;
    if (!same(state?.[key], value)) changed[key] = value;
  }
  return changed;
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

function unverifiedSlackLine(request) {
  return `⚠️ Para AI: tried to pass ${clean(request.roleName) || "a role"} @ ${clean(request.companyName) || "a company"} `
    + `for ${displayName(request.candidateName)} on Paraform, but the request is still pending. `
    + "It will not be retried; check the card on paraform.com/home.";
}

const throttled = (error) => [REQUEST_LANE_COOLDOWN_CODE, REQUEST_LANE_RATE_LIMITED_CODE].includes(error?.code);

export async function runReplyPassStep({
  history,
  states,
  config,
  now = Date.now(),
  passConfig = replyPassConfig(),
  clock = Date.now,
  // When the outreach tick began, so the budget covers the whole tick.
  startedAt = null,
  // From outreach.mjs, injected so this module never imports it back.
  assessImpl,
  assessmentPatchImpl,
  getStateImpl = getOutreachState,
  saveStateImpl = saveOutreachState,
  lockImpl = acquireOutreachLock,
  unlockImpl = releaseOutreachLock,
  dismissImpl = (id, dismissReason) => trpcPost("submissionRequest.dismissSubmissionRequest", { id, dismissReason }),
  claimImpl = claimSubmissionRequestAttempt,
  readClaimImpl = readSubmissionRequestClaim,
  releaseClaimImpl = releaseSubmissionRequestClaim,
  resolveExceptionImpl = resolveOutreachException,
  gmailBackoffImpl = getGmailBackoff,
  notifyImpl = notifySlack,
  alertSlotImpl = (key, ttlSeconds) => claimOutreachExceptionAlert(key, { ttlSeconds }),
} = {}) {
  const summary = {
    enabled: passConfig.enabled,
    confirmed: [],
    returned: [],
    unverified: [],
    assessed: 0,
    attempted: [],
    skipped: [],
    stopped: null,
  };
  if (!passConfig.enabled) return summary;
  const started = Number.isFinite(startedAt) ? startedAt : clock();
  const overBudget = () => clock() - started > passConfig.budgetMs;
  const historyById = new Map((history || []).map((row) => [clean(row?.id), row]));

  // Everything below changes one candidate's state under that candidate's
  // lock, re-read fresh, so it can never interleave with a send.
  const withCandidate = async (candidateUserId, fn) => {
    const token = await lockImpl(candidateUserId).catch(() => null);
    if (!token) return null;
    try {
      const state = await getStateImpl(candidateUserId);
      return state ? await fn(state) : null;
    } finally {
      await unlockImpl(candidateUserId, token).catch(() => {});
    }
  };

  // 1. Confirm earlier attempts from this tick's own history read.
  for (const listed of states || []) {
    const pending = Object.keys(listed?.pendingPasses || {});
    if (!pending.length) continue;
    await withCandidate(clean(listed.candidateUserId), async (state) => {
      let next = state;
      const announce = [];
      for (const requestId of Object.keys(state.pendingPasses || {})) {
        const attempt = state.pendingPasses[requestId];
        const row = historyById.get(requestId);
        const status = clean(row?.status).toLowerCase();
        if (!row && now - (finiteDate(attempt.at) ?? now) > MISSING_ROW_GIVE_UP_MS) {
          const { [requestId]: _gone, ...kept } = next.pendingPasses;
          next = appendOutreachJournal({ ...next, pendingPasses: kept }, "request_pass_unresolvable", {
            requestId,
            source: REPLY_PASS_LANE,
          });
          continue;
        }
        if (!row || status === "pending") {
          // Not taken. Kept (and its claim kept) so it is never retried;
          // flagged once below.
          if (status === "pending" && !attempt.unverifiedAt) {
            next = {
              ...next,
              pendingPasses: { ...next.pendingPasses, [requestId]: { ...attempt, unverifiedAt: new Date(now).toISOString() } },
            };
            summary.unverified.push({ requestId, request: row || attempt.request });
          }
          continue;
        }
        const { [requestId]: _done, ...rest } = next.pendingPasses;
        if (status === "dismissed") {
          next = appendOutreachJournal({
            ...next,
            pendingPasses: rest,
            passedRequests: {
              ...(next.passedRequests || {}),
              [requestId]: { at: attempt.at, confirmedAt: new Date(now).toISOString(), cause: attempt.cause, statedAt: attempt.statedAt || null, roleId: attempt.request?.roleId || null },
            },
          }, "request_passed_on_paraform", { requestId, cause: attempt.cause, source: REPLY_PASS_LANE });
          summary.confirmed.push({ requestId, cause: attempt.cause });
          announce.push({ requestId, attempt });
        } else {
          // Expired or submitted meanwhile: not our pass. Give the request
          // back so the lane that owns that state can act on it.
          next = appendOutreachJournal({ ...next, pendingPasses: rest }, "request_pass_returned", {
            requestId,
            status,
            source: REPLY_PASS_LANE,
          });
          await releaseClaimImpl(requestId, attempt.claimId, { lane: REPLY_PASS_LANE }).catch(() => {});
          summary.returned.push({ requestId, status });
        }
      }
      if (next !== state) await saveStateImpl(next, state.revision);
      for (const { requestId, attempt } of announce) {
        await resolveExceptionImpl(requestId, { resolution: `passed_on_paraform:${attempt.cause}` }).catch(() => null);
        await notifyImpl(replyPassSlackLine({ request: attempt.request, cause: attempt.cause, holdUntil: attempt.holdUntil })).catch(() => false);
      }
    }).catch(() => null);
  }
  for (const item of summary.unverified) {
    const claimed = await alertSlotImpl(`reply-pass-unverified:${item.requestId}`, UNVERIFIED_ALERT_TTL_SECONDS).catch(() => false);
    if (claimed && item.request) await notifyImpl(unverifiedSlackLine(item.request)).catch(() => false);
  }

  // 2. Re-read conversations, latching verdicts exactly as the send path does.
  const latest = new Map((states || []).map((state) => [clean(state?.candidateUserId), state]));
  for (const candidate of candidatesToAssess({
    history,
    states,
    now,
    recheckMs: passConfig.recheckMs,
    limit: passConfig.assessLimit,
  })) {
    if (overBudget()) { summary.stopped = "budget"; break; }
    if (await gmailBackoffImpl().catch(() => null)) { summary.stopped = "gmail_rate_limited"; break; }
    const candidateUserId = clean(candidate.candidateUserId);
    const saved = await withCandidate(candidateUserId, async (state) => {
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
      const changed = changedFields(state, patch);
      const next = { ...state, ...changed, replyPassCheckedAt: new Date(now).toISOString() };
      return saveStateImpl(
        Object.keys(changed).length && event
          ? appendOutreachJournal(next, event, {
            source: REPLY_PASS_LANE,
            verdict: assessment.verdict || null,
            intentSource: assessment.intent?.source || null,
          })
          : next,
        state.revision,
      );
    }).catch(() => null);
    if (saved) latest.set(candidateUserId, saved);
  }

  // 3. Pass what the recorded words authorize, re-planned under each lock.
  for (const plan of planReplyPasses({ history, states: [...latest.values()], now })) {
    if (summary.attempted.length >= passConfig.passLimit) break;
    if (overBudget()) { summary.stopped = summary.stopped || "budget"; break; }
    const { request } = plan;
    let halt = null;
    await withCandidate(plan.candidateUserId, async (state) => {
      const fresh = passCauseFor(state, request, now);
      if (!fresh) { summary.skipped.push({ requestId: request.id, reason: "state_changed" }); return; }
      const claim = await claimImpl(request.id, "pass", REPLY_PASS_LANE);
      if (claim?.status !== "claimed") {
        const existing = claim?.claim || await readClaimImpl(request.id).catch(() => null);
        summary.skipped.push({ requestId: request.id, reason: `claimed_by_${existing?.lane || existing?.namespace || "unknown"}` });
        return;
      }
      const attempt = {
        at: new Date(now).toISOString(),
        claimId: claim.claim.claimId,
        cause: fresh.cause,
        statedAt: fresh.statedAt || null,
        holdUntil: fresh.holdUntil || null,
        request: {
          id: request.id,
          roleId: request.roleId || null,
          roleName: request.roleName || null,
          companyName: request.companyName || null,
          candidateName: request.candidateName || null,
        },
      };
      // Recorded BEFORE the call, so even a crash mid-call is reconciled.
      let recorded;
      try {
        recorded = await saveStateImpl({
          ...state,
          pendingPasses: { ...(state.pendingPasses || {}), [request.id]: attempt },
        }, state.revision);
      } catch {
        // Nothing was sent; an unrecorded claim would block the request forever.
        await releaseClaimImpl(request.id, claim.claim.claimId, { lane: REPLY_PASS_LANE }).catch(() => {});
        summary.skipped.push({ requestId: request.id, reason: "state_save_failed" });
        return;
      }
      try {
        await dismissImpl(request.id, replyPassReason(fresh.cause));
        summary.attempted.push({ requestId: request.id, cause: fresh.cause });
      } catch (error) {
        if (throttled(error) || error?.code === "AUTH_EXPIRED") {
          // Paraform did not act on it: give the request back and stop.
          const { [request.id]: _undo, ...rest } = recorded.pendingPasses || {};
          recorded = await saveStateImpl({ ...recorded, pendingPasses: rest }, recorded.revision).catch(() => recorded);
          await releaseClaimImpl(request.id, claim.claim.claimId, { lane: REPLY_PASS_LANE }).catch(() => {});
          halt = clean(error.code);
          return;
        }
        // Unknown outcome: the next tick's history decides.
        summary.attempted.push({ requestId: request.id, cause: fresh.cause, error: clean(error?.code || error?.message).slice(0, 120) });
      }
    }).catch((error) => {
      summary.skipped.push({ requestId: request.id, reason: clean(error?.code || error?.message).slice(0, 80) || "failed" });
    });
    if (halt) { summary.stopped = halt; break; }
  }
  return {
    ...summary,
    unverified: summary.unverified.map(({ requestId }) => ({ requestId })),
  };
}
