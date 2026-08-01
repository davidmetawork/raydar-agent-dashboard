/**
 * Paraform submission notifications — stream 3 collector
 * (replies to the post-call curated-list email sequence).
 *
 * Source is the existing cross-sequence reply inbox, which already does the
 * hard parts: it reads Paraform read-only, resolves the candidate's name, and
 * — importantly — filters out bounce and delivery-failure notices, which would
 * otherwise arrive as "replies" and get labelled `unclear` forever.
 *
 * Pure: callers fetch the feed, this decides.
 *
 * ── Scoped to the curated-list sequences, ID-first ────────────────────────
 * The inbox is CROSS-sequence, so it also carries replies to unrelated
 * campaigns. Only the curated-list sequences belong in this channel, and they
 * are matched by ID because their names drift — a name match would silently
 * start including or excluding sequences after a rename.
 *
 * ── Why gmail_id is the event id ──────────────────────────────────────────
 * It identifies one message. A second reply in the same thread is a genuinely
 * new event and gets its own id, while the same message re-read on every poll
 * keeps the same id and is deduped. Thread id would collapse a follow-up reply
 * into silence, which is the failure that matters here.
 */

import { STREAM_SEQUENCE, signalFromReplyText } from "./submission-notify.mjs";

const str = (value) => (typeof value === "string" ? value.trim() : "");

/**
 * @param rows          inbox feed reply rows (see flattenCampaignInbox)
 * @param sequenceIds   the curated-list sequence ids to include
 * @param includeArchived archived replies are old news; excluded by default
 */
export function buildSequenceEvents({
  rows = [],
  sequenceIds = [],
  includeArchived = false,
} = {}) {
  const allowed = new Set(
    (Array.isArray(sequenceIds) ? sequenceIds : []).map((id) => str(id)).filter(Boolean),
  );
  const events = [];
  const seen = new Set();

  for (const row of rows) {
    const sequenceId = str(row?.sequence_id);
    // No allow-list means no scoping is possible; emit nothing rather than
    // spraying every sequence's replies into the channel.
    if (!allowed.size || !allowed.has(sequenceId)) continue;
    if (!includeArchived && row?.is_archived) continue;

    const eventId = str(row?.gmail_id);
    if (!eventId || seen.has(eventId)) continue;
    seen.add(eventId);

    const text = str(row?.snippet);
    events.push({
      stream: STREAM_SEQUENCE,
      // The inbox keys replies by lead, not by candidate user; ccu_id is the
      // stable per-candidate handle available here.
      candidateUserId: str(row?.ccu_id),
      candidateName: str(row?.candidate_name),
      eventId,
      signal: signalFromReplyText(text),
      replyText: text,
      roleName: str(row?.sequence_name),
    });
  }

  return events;
}
