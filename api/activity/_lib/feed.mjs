// Activity feed builder: the two queues.
//
//   needs_reply — submissions where the latest TEXTFUL message on the
//                 candidate's subthread is theirs (client or Paraform) and
//                 newer than anything we sent there. Literal by design: an
//                 ack like "thanks for the update" stays visible with a hint
//                 chip rather than being hidden by a classifier (the chase's
//                 2026-07-28 lesson, inverted for a human surface).
//   gone_quiet  — submissions with NO subthread activity of any kind in 48h
//                 AND not in needs_reply (mutual silence only, so the two
//                 pages mean different things), excluding candidates whose
//                 interview is scheduled in the future (process is moving).
//
// Read strategy (the reliability core — see docs/ACTIVITY-TAB-RESEARCH-2026-08-09.md
// in the main repo):
//   1. One CRM walk enumerates eligible pairs (row already carries
//      furthest_statuses with application_id, role incl. company id, and
//      submitted_by — no per-candidate calls).
//   2. threadId is CONSTRUCTED (<recruiterId>:<companyId>:<roleId>) and
//      subthreadId is "application:<applicationId>" — resolveApplicationThread
//      (where the chase's 401 storms concentrated) is a per-thread fallback,
//      not the hot path.
//   3. One getInbox call is the change detector: a role thread whose
//      lastThreadItem.id matches our durable per-thread KV cache is served
//      from cache; only threads that moved get a getThread read, at
//      concurrency 2. Cold builds cache each thread as it lands, so a
//      timeout mid-build still makes progress.

import { getJson, setJson } from "./kv.mjs";
import { crmPage, getInbox, getThread, resolveApplicationThread, whoAmI } from "./paraform.mjs";

export const FEED_KEY = "activity:v1:feed";
export const FEED_TTL_SECONDS = 120;
export const FEED_LOCK_KEY = "activity:v1:feed:lock";
const THREAD_KEY = (threadId) => `activity:v1:thread:${threadId}`;
const THREAD_TTL_SECONDS = 14 * 24 * 3600;

const ACTIVE_STAGES = ["SUBMITTED", "INTERVIEWING", "OFFER"];
const CHASEABLE = new Set(["SUBMITTED", "INTERVIEWING", "INTERVIEW", "FIRST_ROUND", "MID_ROUND", "FINAL_ROUND", "ONSITE", "OFFER"]);
const MAX_PAGES = 40;
const QUIET_MS = 48 * 3600 * 1000;
const READ_CONCURRENCY = 2;

const ts = (v) => { const t = Date.parse(v); return Number.isFinite(t) ? t : null; };
const up = (s) => String(s || "").trim().toUpperCase().replace(/[\s-]+/g, "_");
export const stripHtml = (h) => String(h || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();

// Paraform's templated booking prompt — a third of the queue, matched exactly
// (port of the chase's booking.mjs recognizer) so it costs nothing to bucket.
const BOOKING_RE = /can you confirm if .{1,80} has booked in for the interview/i;
export const isBookingPrompt = (text) => BOOKING_RE.test(stripHtml(text));

// Deterministic needs-reply hint (no model in v1): a question, a direct
// mention of David, or a handed-over action reads as "likely needs reply".
const ACTION_RE = /\b(no response from|hasn'?t (responded|replied)|can you|could you|please|any update|waiting on|let (us|me) know|confirm)\b/i;
export function needsReplyHint(text, mentionsDavid) {
  const t = stripHtml(text);
  if (!t) return null;
  if (isBookingPrompt(t)) return "booking";
  if (/\?/.test(t) || mentionsDavid || ACTION_RE.test(t)) return "likely";
  return "fyi";
}

const isSubmissionRecord = (it) => it?.type === "application";
const hasText = (it) => Boolean(stripHtml(it?.text));
const isTheirs = (it) => it?.direction === "received" && !isSubmissionRecord(it);
const isOurs = (it) => it?.direction === "sent" && !isSubmissionRecord(it);
const belongsToSubthread = (it, subthreadId) => it?.id === subthreadId || it?.rootMessageId === subthreadId;

async function mapPool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, Math.max(items.length, 1)) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  }));
  return out;
}

/** CRM walk → eligible pairs (my active submissions on active roles). */
export async function discoverPairs() {
  const me = await whoAmI();
  const filters = { sort: { field: "updated_at", direction: "desc" }, current_stage: ACTIVE_STAGES };
  const pairs = [];
  let cursor = null, pages = 0, truncated = false;
  do {
    const page = await crmPage(filters, cursor);
    for (const row of page?.items || []) {
      for (const fs of row.furthest_statuses || []) {
        if (!fs?.application_id) continue;
        if (fs?.submitted_by?.id !== me.id) continue;
        if (up(fs?.role?.status) !== "ACTIVE") continue;
        if (!CHASEABLE.has(up(fs?.status || fs?.stage))) continue;
        pairs.push({
          candidateUserId: row.id,
          candidateName: row.name,
          candidateLinkedin: row.linkedin_user || null,
          lastEmailAt: row.last_email_interaction || null,
          applicationId: fs.application_id,
          roleId: fs.role?.id || null,
          roleName: fs.role?.name || null,
          companyId: fs.role?.company?.id || null,
          companyName: fs.role?.company?.name || null,
          stage: up(fs.status || fs.stage),
          stageName: fs.stage_name || fs.stage || null,
          scheduledAt: fs.scheduled_at || null,
        });
      }
    }
    cursor = page?.next_cursor || null;
    pages++;
    if (pages >= MAX_PAGES && cursor) { truncated = true; break; }
  } while (cursor);
  return { me, pairs, truncated };
}

/**
 * Thread items for one role thread, cache-first.
 * inboxMark is the lastThreadItem.id getInbox reported for the thread (null if
 * the thread wasn't in the inbox listing) — a matching cached mark means the
 * thread has not moved and the cache is authoritative.
 */
async function threadItems(threadId, inboxMark, stats) {
  const key = THREAD_KEY(threadId);
  const cached = await getJson(key).catch(() => null);
  if (cached?.items && inboxMark && cached.mark === inboxMark) { stats.cacheHits++; return cached.items; }
  try {
    const items = (await getThread(threadId)) || [];
    stats.reads++;
    const mark = inboxMark
      || items.reduce((m, it) => ((ts(it.createdAt) ?? 0) > (ts(m?.createdAt) ?? -1) ? it : m), null)?.id
      || null;
    await setJson(key, { mark, items, at: new Date().toISOString() }, { ttlSeconds: THREAD_TTL_SECONDS }).catch(() => {});
    return items;
  } catch (e) {
    stats.readFailures++;
    // A thread we could not read is REPORTED stale-cache or missing, never
    // silently dropped (the chase's silent-blindness lesson).
    if (cached?.items) { stats.staleServed++; return cached.items; }
    return null;
  }
}

/** Analyze one application's subthread into queue facts. */
export function analyzeSubthread(items, subthreadId) {
  const mine = items
    .filter((it) => belongsToSubthread(it, subthreadId))
    .sort((a, b) => (ts(a.createdAt) ?? 0) - (ts(b.createdAt) ?? 0));
  if (!mine.length) return null;

  let lastOurAt = null, lastAnyAt = null, submittedAt = null;
  for (const it of mine) {
    const t = ts(it.createdAt);
    if (t && (!lastAnyAt || t > lastAnyAt)) lastAnyAt = t;
    if (isSubmissionRecord(it) && t && (!submittedAt || t < submittedAt)) submittedAt = t;
    if (isOurs(it) && hasText(it) && t && (!lastOurAt || t > lastOurAt)) lastOurAt = t;
  }
  const lastInbound = [...mine].reverse().find((it) => isTheirs(it) && hasText(it)) || null;
  const lastInboundAt = lastInbound ? ts(lastInbound.createdAt) : null;
  const unanswered = Boolean(lastInbound) && (lastInboundAt ?? 0) > (lastOurAt ?? 0);
  const mentionsDavid = Boolean(lastInbound?.mentions?.length);

  return {
    itemCount: mine.length,
    submittedAt,
    lastAnyAt,
    lastOurAt,
    unanswered,
    lastInbound: lastInbound ? {
      id: lastInbound.id,
      at: lastInboundAt,
      from: lastInbound.fromUser?.name || null,
      fromType: lastInbound.fromUser?.type || null,
      preview: stripHtml(lastInbound.text).slice(0, 240),
      hint: needsReplyHint(lastInbound.text, mentionsDavid),
    } : null,
  };
}

/** Build the whole feed. Returns {generatedAt, queues, counts, degraded, stats}. */
export async function buildFeed() {
  const stats = { reads: 0, cacheHits: 0, readFailures: 0, staleServed: 0, resolves: 0 };
  const { me, pairs, truncated } = await discoverPairs();

  // One inbox call = change detection + native unread + a safety net for
  // role threads whose constructed id is wrong (fallback below).
  const inboxByThread = new Map();
  try {
    const inbox = await getInbox({});
    for (const item of inbox?.items || []) {
      if (item?.threadId) inboxByThread.set(item.threadId, { mark: item.lastThreadItem?.id || null, isRead: item.isRead === true });
    }
  } catch { /* inbox listing is an optimization, not a dependency */ }

  // Group applications by constructed role thread.
  const byThread = new Map();
  for (const p of pairs) {
    if (!p.companyId || !p.roleId) continue;
    const threadId = `${me.id}:${p.companyId}:${p.roleId}`;
    if (!byThread.has(threadId)) byThread.set(threadId, []);
    byThread.get(threadId).push(p);
  }

  const now = Date.now();
  const needsReply = [];
  const goneQuiet = [];
  const unreadable = [];

  await mapPool([...byThread.entries()], READ_CONCURRENCY, async ([threadId, threadPairs]) => {
    const mark = inboxByThread.get(threadId)?.mark || null;
    let items = await threadItems(threadId, mark, stats);
    if (items === null) { unreadable.push(...threadPairs.map((p) => p.applicationId)); return; }

    for (const p of threadPairs) {
      const subthreadId = `application:${p.applicationId}`;
      let state = analyzeSubthread(items, subthreadId);
      if (!state) {
        // Constructed id missed (role without consolidated messaging, or an
        // id drift) — resolve once, then read that thread.
        try {
          stats.resolves++;
          const resolved = await resolveApplicationThread(p.applicationId);
          if (resolved?.threadId && resolved.threadId !== threadId) {
            const other = await threadItems(resolved.threadId, inboxByThread.get(resolved.threadId)?.mark || null, stats);
            if (other) state = analyzeSubthread(other, resolved.subthreadId || subthreadId);
          }
        } catch { /* falls through to unreadable */ }
      }
      if (!state) { unreadable.push(p.applicationId); continue; }

      const futureInterview = p.scheduledAt && (ts(p.scheduledAt) ?? 0) > now;
      const row = {
        key: p.applicationId,
        threadId,
        subthreadId,
        candidateUserId: p.candidateUserId,
        candidate: p.candidateName,
        linkedin: p.candidateLinkedin,
        company: p.companyName,
        companyId: p.companyId,
        role: p.roleName,
        roleId: p.roleId,
        stage: p.stage,
        stageName: p.stageName,
        scheduledAt: p.scheduledAt,
        futureInterview: Boolean(futureInterview),
        lastEmailAt: p.lastEmailAt,
        lastAnyAt: state.lastAnyAt,
        lastOurAt: state.lastOurAt,
        itemCount: state.itemCount,
      };

      if (state.unanswered && state.lastInbound) {
        needsReply.push({ ...row, inbound: state.lastInbound, waitingSinceMs: state.lastInbound.at });
      } else if (state.lastAnyAt && now - state.lastAnyAt > QUIET_MS && !futureInterview) {
        goneQuiet.push({ ...row, quietSinceMs: state.lastAnyAt });
      }
    }
  });

  needsReply.sort((a, b) => (a.waitingSinceMs ?? 0) - (b.waitingSinceMs ?? 0));
  goneQuiet.sort((a, b) => (a.quietSinceMs ?? 0) - (b.quietSinceMs ?? 0));

  return {
    generatedAt: new Date().toISOString(),
    pairsScanned: pairs.length,
    truncated,
    queues: { needs_reply: needsReply, gone_quiet: goneQuiet },
    counts: {
      needs_reply: needsReply.length,
      gone_quiet: goneQuiet.length,
      booking_prompts: needsReply.filter((r) => r.inbound?.hint === "booking").length,
      unreadable: unreadable.length,
    },
    unreadableApplications: unreadable,
    stats,
  };
}
