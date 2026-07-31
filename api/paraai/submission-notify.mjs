/**
 * Paraform submission notifications — the runner.
 *
 * Collects the three streams, dedupes, and posts one short Slack message per new
 * candidate response. NOTIFY-ONLY: this endpoint never writes to Paraform, never
 * sends candidate email, and never actions a submission. Every upstream call it
 * makes is a read.
 *
 * ── Why one endpoint and one cron ─────────────────────────────────────────
 * The dashboard is at 5 of a documented ceiling of 6 Vercel crons, so this build
 * gets exactly one and all three streams run in a single tick.
 *
 * ── Why stream 2 dedupes BEFORE reading Gmail ─────────────────────────────
 * `pendingOutreachReplies()` is deliberately KV-only so the expensive part can
 * be skipped: a reply that has already been notified needs no thread read at
 * all. So the order is list states → compute dedupe keys → drop the ones already
 * sent → read Gmail only for the survivors. Reading first and deduping after
 * would re-fetch every historical thread on every tick forever.
 *
 * ── Why each stream is isolated ───────────────────────────────────────────
 * A notifier that dies because one source is down is worse than one that
 * reports two streams and an error: silence looks identical to "nobody replied".
 * Each collector is wrapped so a failure degrades that stream only, and the
 * failure is returned rather than swallowed.
 *
 * ── Why it refuses to run unconfigured ────────────────────────────────────
 * Without a channel there is nowhere to post and every event would be left
 * unmarked for retry — correct, but it would burn a full set of upstream reads
 * each tick for nothing. An unconfigured run therefore exits early, and
 * crucially does NOT seed, so the first configured run still seeds and stays
 * quiet.
 */

import { cors, requireAuth, notifySlack } from "./_lib/core.mjs";
// cronAuth is the project's single implementation of the Vercel-cron bearer
// check; duplicating it here would be a second copy of a security check.
import { cronAuth } from "../seq/_lib/core.mjs";
import { createHash, timingSafeEqual } from "node:crypto";
import { kv } from "./_lib/store.mjs";
import { curatedListSequenceIds, listCuratedListCandidates } from "./_lib/interest.mjs";
import { listInterestHandoffRecords } from "./_lib/interest-store.mjs";
import { listOutreachStates } from "./_lib/outreach-store.mjs";
import { getThread, inboundMessagesAfter, outreachMailbox } from "./_lib/outreach-gmail.mjs";
import { intentMessagesFromThread } from "./_lib/outreach-intent.mjs";
import { buildInboxFeed } from "../inbox/_lib/core.mjs";

import { notificationDedupeKey } from "./_lib/submission-notify.mjs";
import { nameIndex, buildInterestEvents } from "./_lib/submission-notify-interest.mjs";
import { pendingOutreachReplies, buildRequestEvents } from "./_lib/submission-notify-request.mjs";
import { buildSequenceEvents } from "./_lib/submission-notify-sequence.mjs";
import { dispatchEvents, isSeeded, markSeeded } from "./_lib/submission-notify-dispatch.mjs";
import {
  postSubmissionNotification,
  submissionNotifyConfigured,
} from "./_lib/submission-notify-slack.mjs";

/**
 * The runner key, accepted alongside Vercel cron and a Google session.
 *
 * Without this the tick is UNOBSERVABLE: it cannot be invoked by hand, and a
 * cron that silently returns nothing is indistinguishable from a cron that
 * never fired. That ambiguity cost hours on 2026-07-31. Every other Para AI
 * endpoint (worker, interest) already trusts this credential, so accepting it
 * here removes an inconsistency rather than widening the trust boundary.
 */
export function runnerAuthorized(req, env = process.env) {
  const secret = env.PARAAI_AUTOMATION_RUNNER_KEY || "";
  if (!secret) return false;
  const token = String(req?.headers?.authorization || "").replace(/^Bearer\s+/i, "");
  if (!token) return false;
  const a = createHash("sha256").update(token).digest();
  const b = createHash("sha256").update(secret).digest();
  return a.length === b.length && timingSafeEqual(a, b);
}

// The inbox build alone budgets 80s; give the whole tick headroom above that.
export const config = { maxDuration: 300 };

// Even after dedupe, a first real run could surface a burst of replies. Cap the
// Gmail reads per tick; anything beyond simply waits for the next tick rather
// than risking the function budget. Uncapped events are NOT dropped.
const TEXT_LOOKUP_CAP = 25;

const defaultKvGet = async (key) => kv(["GET", key]);
const defaultKvSet = async (key, value) => kv(["SET", key, value]);

/**
 * Injectable so the whole tick can be exercised without KV, Gmail, Paraform or
 * Slack. Mirrors createInboxFeedHandler in api/inbox/feed.mjs, which is this
 * codebase's existing pattern for a testable endpoint. `export default` below
 * wires the real io, so production behaviour is unchanged.
 */
export function createSubmissionNotifyHandler({
  corsHandler = cors,
  authHandler = requireAuth,
  cronAuthHandler = cronAuth,
  runnerAuth = runnerAuthorized,
  configured = submissionNotifyConfigured,
  kvGet = defaultKvGet,
  kvSet = defaultKvSet,
  listHandoffs = listInterestHandoffRecords,
  listCandidates = listCuratedListCandidates,
  listStates = listOutreachStates,
  sequenceIds = curatedListSequenceIds,
  buildFeed = buildInboxFeed,
  mailboxFor = outreachMailbox,
  threadFor = getThread,
  postMessage = (text) => postSubmissionNotification(text),
  alert = notifySlack,
  dispatch = dispatchEvents,
  seededCheck = isSeeded,
  seededMark = markSeeded,
  textLookupCap = TEXT_LOOKUP_CAP,
} = {}) {

async function collectInterest(errors) {
  try {
    const [records, candidates] = await Promise.all([
      listHandoffs(),
      listCandidates().catch(() => []),
    ]);
    return buildInterestEvents({ records, names: nameIndex(candidates) });
  } catch (error) {
    errors.push(`interest: ${error?.message || error}`);
    return [];
  }
}

async function collectRequest(errors, seeding) {
  try {
    const pending = pendingOutreachReplies(await listStates());

    // Drop the already-notified BEFORE touching Gmail — that is the whole point
    // of pendingOutreachReplies being KV-only.
    const fresh = [];
    for (const item of pending) {
      const key = notificationDedupeKey({
        stream: "request",
        candidateUserId: item.candidateUserId,
        eventId: item.eventId,
      });
      try {
        if (await kvGet(key)) continue;
      } catch {
        // Can't confirm it was sent: treat as fresh. The dispatcher re-checks
        // the same key, so a duplicate read here cannot cause a duplicate post.
      }
      fresh.push(item);
    }

    const detailsById = new Map();
    // A seeding pass posts nothing, so reading threads for text that will be
    // discarded is pure waste — and on day one `fresh` is the entire history
    // of repliers, so this is the single most expensive tick there will ever be.
    const mailbox = seeding ? null : mailboxFor(process.env);
    if (mailbox) {
      for (const item of fresh.slice(0, textLookupCap)) {
        if (!item.threadId) continue;
        try {
          const thread = await threadFor(mailbox, item.threadId);
          const messages = intentMessagesFromThread(inboundMessagesAfter(thread, mailbox, 0));
          const newest = messages.reduce(
            (best, row) => (Date.parse(row?.at || 0) >= Date.parse(best?.at || 0) ? row : best),
            messages[0] || null,
          );
          if (newest?.text) detailsById.set(item.candidateUserId, { text: newest.text });
        } catch { /* unclear is the safe fallback; the event still posts */ }
      }
    }
    return buildRequestEvents({ pending: fresh, detailsById });
  } catch (error) {
    errors.push(`request: ${error?.message || error}`);
    return [];
  }
}

async function collectSequence(errors) {
  try {
    // Scoping is mandatory: the inbox is CROSS-sequence, so without the
    // curated-list ids this would spray unrelated campaigns into the channel.
    const ids = sequenceIds();
    if (!ids?.length) {
      errors.push("sequence: no curated-list sequence ids configured, stream skipped");
      return [];
    }
    // The 90s inbox cache is far shorter than this cron's interval, so a cached
    // read would essentially always miss. Build the feed and accept a partial
    // one: some replies beat none.
    const feed = await buildFeed();
    if (feed?.partial) {
      errors.push("sequence: inbox feed was partial, some campaigns did not respond");
    }
    return buildSequenceEvents({ rows: feed?.replies || [], sequenceIds: ids });
  } catch (error) {
    errors.push(`sequence: ${error?.message || error}`);
    return [];
  }
}

return async function handler(req, res) {
  if (corsHandler(req, res)) return;
  const cron = cronAuthHandler(req);
  const runner = runnerAuth(req);
  if (!cron.ok && !runner && !(await authHandler(req, res))) return;

  if (!configured()) {
    return res.status(200).json({
      ok: false,
      error: "not_configured",
      detail: "SLACK_BOT_TOKEN and PARAFORM_SUBMISSION_SLACK_CHANNEL are both required",
    });
  }

  // Establish seeding FIRST: it decides whether the expensive Gmail lookups are
  // worth doing at all, and a failed check should cost no upstream reads.
  let seeding = false;
  try {
    seeding = !(await seededCheck({ kvGet }));
  } catch (error) {
    // If we cannot tell whether this is the first run, do NOT assume it is
    // seeded: posting the whole backlog is the one outcome that would teach
    // David to mute the channel. Bail and retry next tick.
    return res.status(200).json({ ok: false, error: `seed check failed: ${error?.message || error}` });
  }

  const errors = [];
  // Surface Slack's own refusal reason; "post returned false" alone is useless.
  const send = postMessage
    || ((text) => postSubmissionNotification(text, {
      onError: (reason) => { if (!errors.includes(`slack: ${reason}`)) errors.push(`slack: ${reason}`); },
    }));
  const [interest, request, sequence] = await Promise.all([
    collectInterest(errors),
    collectRequest(errors, seeding),
    collectSequence(errors),
  ]);
  const events = [...interest, ...request, ...sequence];

  const result = await dispatch({
    events,
    kvGet,
    kvSet,
    postMessage: send,
    seeding,
  });

  // Only a CLEAN seeding pass may mark the lane seeded. If a collector failed
  // during seeding, that stream contributed no events, so none of its history
  // got marked as seen — marking seeded anyway would make its entire backlog
  // look brand new on the very next tick and flood the channel, which is the
  // exact outcome seeding exists to prevent. Staying unseeded costs nothing:
  // the next tick simply seeds again, silently.
  if (seeding && !errors.length) {
    try {
      await seededMark({ kvSet });
    } catch (error) {
      // Not marking means the next run seeds again: quiet and harmless, and far
      // better than posting the backlog.
      errors.push(`markSeeded failed: ${error?.message || error}`);
    }
  }

  // A stream failing every tick is otherwise invisible — the channel just looks
  // quiet, which is exactly the failure this build exists to prevent.
  if (errors.length && cron.ok) {
    await alert(
      `:warning: Paraform submission notifications ran with ${errors.length} stream error(s): ${errors.join("; ")}`,
    ).catch(() => {});
  }

  return res.status(200).json({
    ok: true,
    seeding,
    counts: { interest: interest.length, request: request.length, sequence: sequence.length },
    ...result,
    errors: [...result.errors, ...errors],
  });
};
}

// Production wiring: real io, unchanged behaviour.
export default createSubmissionNotifyHandler();
