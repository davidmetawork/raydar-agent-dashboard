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
 * ── Identity comes from the state, not from a match ───────────────────────
 * Nothing here has to work out WHO replied. The outreach state is keyed by
 * candidate_user_id and stores the name, the address and every role we sent, all
 * written at send time. Until 2026-08-04 this collector simply did not read
 * those fields, so every message in the channel said "Unknown candidate" — a
 * plumbing gap that looked like a matching problem. The Gmail `From` header is
 * kept only as a fallback for states written before the name was stored.
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
  paraformCandidateLink,
  signalFromReplyText,
} from "./submission-notify.mjs";

const str = (value) => (typeof value === "string" ? value.trim() : "");
const num = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);

/**
 * The role this reply is most likely about, plus the id that makes the Paraform
 * link land on the application rather than a list.
 *
 * `latestMatchId` is written by the outreach lane every time a match is
 * delivered, so it is the role of the most recent email in the thread — which is
 * the one a reply is answering. When several roles have been sent, the count is
 * stated rather than hidden: showing one role as if it were the only one would
 * quietly mislead on exactly the message David acts from.
 */
export function latestOutreachMatch(state) {
  const matches = state?.matches && typeof state.matches === "object"
    ? Object.values(state.matches).filter(Boolean)
    : [];
  const named = state?.matches?.[str(state?.latestMatchId)] || null;
  // No latestMatchId (states written before it existed) still resolves, by the
  // same rule: the newest send is the one being replied to.
  const match = named || matches.reduce(
    (best, row) => (Date.parse(row?.sentAt || 0) >= Date.parse(best?.sentAt || 0) ? row : best),
    matches[0] || null,
  );
  if (!match) return { roleId: "", roleName: "" };
  const role = str(match.roleName);
  const company = str(match.companyName);
  const label = [role, company].filter(Boolean).join(" @ ");
  return {
    roleId: str(match.roleId),
    roleName: label && matches.length > 1
      ? `${label} · latest of ${matches.length} roles`
      : label,
  };
}

/**
 * Pull a person out of a `From` header. The outreach state normally carries the
 * name already; this is the belt-and-braces path for a state written before the
 * name was stored, and it is why a reply can no longer be anonymous — the
 * message we are reading is by definition addressed from the candidate.
 *
 * RFC 2047 encoded words (`=?UTF-8?B?…?=`) are NOT decoded: a mojibake name in
 * Slack reads like a bug, so those fall through to the address instead.
 */
export function replyIdentity(fromHeader) {
  const value = str(fromHeader);
  if (!value) return { name: "", email: "" };
  const angled = value.match(/^(.*)<([^>]+)>[^>]*$/);
  const email = str(angled ? angled[2] : value).toLowerCase();
  let name = angled ? str(angled[1]).replace(/^["']|["']$/g, "").trim() : "";
  if (name.startsWith("=?") || name.toLowerCase() === email) name = "";
  return { name, email: email.includes("@") ? email : "" };
}

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

    // The state already knows exactly who this is and what we sent them: it is
    // keyed by candidate_user_id and written at send time. Carrying it here is
    // what stops the notification saying "Unknown candidate" — there was never
    // an identity to resolve, only fields this collector used to drop.
    const { roleId, roleName } = latestOutreachMatch(state);
    pending.push({
      candidateUserId,
      eventId,
      threadId: str(state?.threadId) || null,
      verdict: str(state?.intentVerdict) || null,
      candidateName: str(state?.candidateName),
      candidateEmail: str(state?.candidateEmail),
      roleId,
      roleName,
    });
  }
  return pending;
}

/**
 * Pure. The pending replies whose event is at or after `sinceMs`.
 *
 * Only this stream can be windowed by time, and that is not an accident: its
 * event id IS the internal-date of the candidate's newest message. Stream 1's
 * is a batch id and stream 3's a Gmail message id — neither is ordered, so a
 * "since" filter over them would silently select the wrong set.
 *
 * A non-numeric event id (the `repliedAt` fallback, used by states written
 * before intent tracking) is parsed as a date rather than dropped.
 */
export function repliesSince(pending = [], sinceMs = 0) {
  const cutoff = Number(sinceMs) || 0;
  return pending.filter((item) => {
    const id = str(item?.eventId);
    const at = /^\d+$/.test(id) ? Number(id) : Date.parse(id);
    return Number.isFinite(at) && at >= cutoff;
  });
}

/**
 * Pure. `detailsById` maps candidateUserId -> { text, name, email }, resolved by
 * the caller from the Gmail thread for the pending replies that survived dedupe.
 * The state's own name wins; the thread's `From` is the fallback.
 */
export function buildRequestEvents({ pending = [], detailsById = new Map() } = {}) {
  const events = [];
  for (const item of pending) {
    const detail = detailsById.get(item.candidateUserId) || {};
    const text = str(detail.text);
    const candidateName = str(item.candidateName) || str(detail.name);
    events.push({
      stream: STREAM_REQUEST,
      candidateUserId: item.candidateUserId,
      candidateName,
      candidateEmail: str(item.candidateEmail) || str(detail.email),
      eventId: item.eventId,
      // No text means we could not read the thread. Say `unclear` rather than
      // guessing — the notification still reaches David, who can open it.
      signal: text ? signalFromReplyText(text) : SIGNAL_UNCLEAR,
      replyText: text,
      roleName: str(item.roleName),
      // This stream's id IS a candidate_user_id, so the link opens the person
      // (and, when known, the application) rather than a candidate list.
      link: paraformCandidateLink({
        candidateUserId: item.candidateUserId,
        roleId: item.roleId,
        name: candidateName,
      }),
    });
  }
  return events;
}
