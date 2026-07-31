/**
 * Paraform submission notifications — stream 2 collector (Para AI Request replies).
 *
 * Para AI Request outreach goes out over Gmail, not Paraform sequences, so the
 * reply text lives in a Gmail thread rather than in KV. Fetching every
 * replier's thread on every run would be wasteful, so this collector is split
 * in two so the caller can do the cheap part first:
 *
 *   1. `pendingOutreachReplies(states)`  — pure, KV-only. Who has replied, and
 *      what is this reply's event id? No network at all.
 *   2. caller drops the ones already notified (same dedupe key the dispatcher
 *      uses), then fetches Gmail text for the few survivors.
 *   3. `buildRequestEvents({ pending, detailsById })` — pure. Turn those into
 *      events.
 *
 * That ordering means a Gmail thread is read only for a genuinely new reply.
 *
 * ── Why intentCheckedThrough is the event id ──────────────────────────────
 * The outreach lane stores it as the internal-date of the newest inbound
 * message it has judged. A brand-new reply moves it forward, so the event id
 * changes and we notify; re-reading the same reply leaves it identical, so the
 * dispatcher dedupes it. It is derived from the candidate's own message, not
 * from when we happened to poll, so a slow poll cannot invent a second event.
 *
 * ── Why the intent verdict is NOT reused as the signal ────────────────────
 * `intentVerdict` is OPEN / OFF_MARKET / DO_NOT_CONTACT — whether we may send
 * this person a brand-new opportunity. That is a market-level question, and
 * outreach-intent's own rubric states outright that a no to ONE role is not a
 * no to the market. Mapping it onto per-role interest would mislabel every
 * "this role isn't for me" as still-interested. The reply text is classified
 * instead, and the verdict is carried only as context.
 */

import {
  SIGNAL_UNCLEAR,
  STREAM_REQUEST,
  signalFromReplyText,
} from "./submission-notify.mjs";

const str = (value) => (typeof value === "string" ? value.trim() : "");
const num = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);

/**
 * Pure, KV-only. Returns one entry per candidate whose thread holds a reply.
 * @param states outreach candidate states
 */
export function pendingOutreachReplies(states = []) {
  const pending = [];
  for (const state of states) {
    const candidateUserId = str(state?.candidateUserId);
    if (!candidateUserId) continue;

    // `repliedAt` is set the moment inbound mail is seen; `stoppedReason`
    // covers states written before that field existed.
    const replied = Boolean(str(state?.repliedAt))
      || str(state?.stoppedReason) === "candidate_replied";
    if (!replied) continue;

    // Prefer the candidate's own newest-message time. Fall back to repliedAt so
    // a state written before intent tracking still notifies exactly once.
    const eventId = num(state?.intentCheckedThrough)
      ? String(num(state.intentCheckedThrough))
      : str(state?.repliedAt);
    if (!eventId) continue;

    pending.push({
      candidateUserId,
      eventId,
      threadId: str(state?.threadId) || null,
      verdict: str(state?.intentVerdict) || null,
    });
  }
  return pending;
}

/**
 * Pure. `detailsById` maps candidateUserId -> { name, text }, resolved by the
 * caller from the Gmail thread for the pending replies that survived dedupe.
 */
export function buildRequestEvents({ pending = [], detailsById = new Map() } = {}) {
  const events = [];
  for (const item of pending) {
    const detail = detailsById.get(item.candidateUserId) || {};
    const text = str(detail.text);
    events.push({
      stream: STREAM_REQUEST,
      candidateUserId: item.candidateUserId,
      candidateName: str(detail.name),
      eventId: item.eventId,
      // No text means we could not read the thread. Say `unclear` rather than
      // guessing — the notification still reaches David, who can open it.
      signal: text ? signalFromReplyText(text) : SIGNAL_UNCLEAR,
      replyText: text,
      roleName: "",
    });
  }
  return events;
}
