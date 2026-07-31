/**
 * Paraform submission notifications — dispatch.
 *
 * Takes events from the three collectors, drops the ones already sent, posts
 * the rest to Slack, and remembers what it sent. NOTIFY-ONLY: nothing here
 * touches Paraform or a candidate.
 *
 * ── Why collectors can be dumb ────────────────────────────────────────────
 * Dedupe is durable in KV and keyed per event, so a collector may re-scan its
 * whole source every run without causing repeats. That is deliberate: precise
 * change-detection (cursors, watermarks, "since" timestamps) is the part that
 * silently breaks and loses events. Re-scanning plus idempotent dedupe cannot
 * lose an event, only re-consider it.
 *
 * ── Why the first run posts nothing ───────────────────────────────────────
 * The sources already contain historical items — 14 archived interest records
 * on day one, plus every past reply. Re-scanning them on first run would fire
 * a flood of stale notifications about people David dealt with weeks ago, and
 * would teach him to ignore the channel on day one. So the first run SEEDS:
 * it marks everything as seen and posts nothing. This is the same
 * "first sight seeds and never acts" rule the interest lane uses to make
 * arming forward-only, and it is the correct default for the same reason.
 *
 * ── Why we post before marking ────────────────────────────────────────────
 * If we marked first and the post failed, the notification would be lost
 * permanently and silently — David would never learn the candidate replied.
 * If we post first and the mark fails, the worst case is a duplicate message.
 * A duplicate is mildly annoying; a lost "yes" can cost a placement. So the
 * order is post, then mark, and a failed post is simply left unmarked to be
 * retried next run.
 */

import { buildNotification, notificationDedupeKey } from "./submission-notify.mjs";

const SEEDED_KEY = "paraai:subnotify:seeded";

/** Has this notifier ever run? Until it has, we seed rather than post. */
export async function isSeeded({ kvGet }) {
  const value = await kvGet(SEEDED_KEY);
  return Boolean(value);
}

export async function markSeeded({ kvSet }) {
  await kvSet(SEEDED_KEY, new Date().toISOString());
}

/**
 * @param events  [{ stream, candidateUserId, candidateName, eventId, signal,
 *                   replyText?, roleName? }]
 * @param seeding when true, mark every event as seen and post nothing
 */
export async function dispatchEvents({
  events = [],
  kvGet,
  kvSet,
  postMessage,
  seeding = false,
  now = () => new Date().toISOString(),
} = {}) {
  const result = { considered: 0, posted: 0, duplicate: 0, seeded: 0, failed: 0, errors: [] };

  for (const event of events) {
    if (!event || !event.stream) continue;
    result.considered++;

    const key = notificationDedupeKey({
      stream: event.stream,
      candidateUserId: event.candidateUserId,
      eventId: event.eventId,
    });

    let already = null;
    try {
      already = await kvGet(key);
    } catch (error) {
      // A dedupe read we cannot trust must not become a silent drop OR a
      // duplicate storm. Skip this event and retry next run.
      result.failed++;
      result.errors.push(`dedupe read failed: ${error?.message || error}`);
      continue;
    }
    if (already) { result.duplicate++; continue; }

    if (seeding) {
      // Record it as handled without ever posting. This is what stops day one
      // from replaying history into the channel.
      try {
        await kvSet(key, now());
        result.seeded++;
      } catch (error) {
        result.failed++;
        result.errors.push(`seed write failed: ${error?.message || error}`);
      }
      continue;
    }

    const { text } = buildNotification(event);

    let sent = false;
    try {
      sent = await postMessage(text);
    } catch (error) {
      result.failed++;
      result.errors.push(`post failed: ${error?.message || error}`);
      continue; // deliberately unmarked, so the next run retries it
    }
    if (!sent) {
      result.failed++;
      result.errors.push("post returned false");
      continue; // ditto
    }

    result.posted++;
    try {
      await kvSet(key, now());
    } catch (error) {
      // Posted but not marked: this may duplicate next run. That is the
      // deliberate trade — see the header note.
      result.errors.push(`mark failed after posting: ${error?.message || error}`);
    }
  }

  return result;
}
