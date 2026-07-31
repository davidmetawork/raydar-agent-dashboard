/**
 * Paraform submission notifications — stream 1 collector (curated-list interest).
 *
 * Turns the interest lane's durable records into notification events. Pure:
 * callers fetch, this decides. READ-ONLY by construction — it takes data and
 * returns events, and cannot write anywhere.
 *
 * ── Where the events come from ────────────────────────────────────────────
 * A candidate marking interest creates a job (`paraai:interest:job:*`), which
 * archives to a handoff record (`paraai:interest:handoff:*`) once terminal.
 * Neither is gated on dry-run — they are internal state, not Paraform writes —
 * so detection keeps producing them while the lane is stood down. Both are
 * scanned, because a job that terminates quickly can leave the job index
 * before a run sees it, and the handoff record is what survives.
 *
 * ── Why batchId is the event id ───────────────────────────────────────────
 * A batch is one round of interest for one candidate. When a candidate marks
 * MORE roles while their job is still open, `more_interest` appends to the same
 * batch rather than creating a new one — so the same batchId correctly does not
 * re-notify, while a genuinely new round of interest gets a new batch and does.
 *
 * ── Known limitation, stated rather than hidden ───────────────────────────
 * Only POSITIVE interest reaches this stream. A `NOT_INTERESTED` click is
 * counted by the sweep (`result.declined`) but never persisted as a job or
 * handoff, so there is nothing durable to notify from. This stream therefore
 * emits `interested` only. If David wants declines too, the lane must persist
 * them first — that is a change to the interest lane, not to this collector.
 */

import { SIGNAL_INTERESTED, STREAM_INTEREST } from "./submission-notify.mjs";

const str = (value) => (typeof value === "string" ? value.trim() : "");

/** candidateUserId -> display name, from the live curated-list population. */
export function nameIndex(candidates = []) {
  const index = new Map();
  for (const row of candidates) {
    const id = str(row?.candidateUserId);
    const name = str(row?.name);
    if (id && name) index.set(id, name);
  }
  return index;
}

/**
 * Roles are stored as opaque role IDs, not names. Putting a raw ID in Slack
 * reads like a bug, so describe the shape instead — honest and glanceable.
 */
export function describeRoles(roles) {
  const list = Array.isArray(roles) ? roles.filter((r) => str(r)) : [];
  if (list.length === 0) return "";
  return list.length === 1 ? "1 role" : `${list.length} roles`;
}

/**
 * @param records  interest jobs and/or handoff records, each carrying at least
 *                 { candidateUserId, batchId, roles }
 * @param names    Map from nameIndex()
 */
export function buildInterestEvents({ records = [], names = new Map() } = {}) {
  const events = [];
  const seenBatches = new Set();

  for (const record of records) {
    const candidateUserId = str(record?.candidateUserId);
    const batchId = str(record?.batchId);
    if (!candidateUserId || !batchId) continue;

    // A candidate can appear as BOTH a live job and an archived handoff for the
    // same batch. That is one event, not two.
    const pair = `${candidateUserId}:${batchId}`;
    if (seenBatches.has(pair)) continue;
    seenBatches.add(pair);

    events.push({
      stream: STREAM_INTEREST,
      candidateUserId,
      candidateName: names.get(candidateUserId) || "",
      eventId: batchId,
      signal: SIGNAL_INTERESTED,
      roleName: describeRoles(record?.roles),
    });
  }

  return events;
}
