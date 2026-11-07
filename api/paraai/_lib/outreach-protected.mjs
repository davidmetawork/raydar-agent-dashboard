// Rating-protected subs (David, 2026-11-04).
//
// Paraform staff (Conor Stayton since 2026-10-09) email David notes titled
// "Rating-protected sub: <candidate> → <company>": Paraform has set up a
// protected submission for one of our candidates and asks us to confirm the
// candidate is interested first. Each note's "submit here" link is
//
//   paraform.com/company/<slug>/<roleId>/recruit/submit_candidate
//     ?single_submission=true&from_submission_request=true
//     &candidate_to_approved_role_id=<id>&submission_request_id=<requestId>
//
// so the note names an exact Paraform submission request. This file reads the
// notes from David's Gmail and keeps them by request id; the outreach tick then
// emails the candidate about that request (outreach.mjs, `protectedSub`).
//
// Who sends the notes is NOT a rule: any authenticated @paraform.com sender
// counts, because staff leave. Measured 2026-11-04: that submit-link shape
// appears in the protected-sub notes only (57 of 57), never in Paraform's own
// [Action Required], Reminder or status emails, so the link is the signature.
// A new sender's first note posts one Slack line; a note that talks about a
// protected sub but carries no such link posts one Slack line instead of being
// dropped; a protected sub nobody emailed within an hour posts one Slack line.

import { lookupReason, PROTECTED_FIT_TEXT_MAX_TRIES, protectedPickBlocked } from "./outreach-protected-lookup.mjs";
import {
  acquireProtectedScanSlot,
  claimProtectedMeta,
  getProtectedMeta,
  listProtectedSubs,
  markProtectedMessageSeen,
  protectedSeenMessageIds,
  saveProtectedSub,
} from "./outreach-store.mjs";
import {
  getMessage,
  headerAddresses,
  headerValue,
  messageText,
  searchMessages,
} from "./outreach-gmail.mjs";

const clean = (value) => String(value ?? "").trim();
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export const PROTECTED_SUB_DELIVERY_MODE = "protected_sub";
export const PROTECTED_NOTE_QUERY =
  'from:paraform.com newer_than:8d ("protected sub" OR "submit here" OR "protected submission")';
// A request still unemailed this long after its note arrived pages once.
export const PROTECTED_UNSENT_ALERT_MS = HOUR_MS;
// Notes older than this are history (Paraform expires a request in 7 days).
export const PROTECTED_WATCH_WINDOW_MS = 7 * DAY_MS;
// Where staff pick the right person for a held note (2026-11-06).
export const PROTECTED_PICKS_PAGE_URL = "https://monitor.raydar.xyz/protected-subs.html";

export function protectedSubsEnabled(env = process.env) {
  return !["off", "0", "false"].includes(clean(env.PARAAI_PROTECTED_SUBS).toLowerCase());
}

const ID = /^c[a-z0-9]{20,32}$/;

function decodeEntities(value) {
  return String(value ?? "")
    .replace(/&amp;/g, "&")
    .replace(/&#61;/g, "=")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

// Gmail wraps links as https://www.google.com/url?q=<url>&...; the inner URL's
// own ?, & and = arrive percent-encoded inside q.
export function unwrapLink(href) {
  const raw = decodeEntities(clean(href));
  try {
    const url = new URL(raw);
    if (/(^|\.)google\.com$/i.test(url.hostname) && url.pathname === "/url") {
      const inner = url.searchParams.get("q");
      if (inner) return inner;
    }
  } catch {}
  return raw;
}

// The protected submit link, or null. Every one of the four markers must be
// present: they are what separates a protected-sub note from Paraform's other
// mail.
export function protectedSubmitLink(href) {
  let url;
  try { url = new URL(unwrapLink(href)); } catch { return null; }
  if (!/(^|\.)paraform\.com$/i.test(url.hostname)) return null;
  const path = url.pathname.match(/^\/company\/([^/]+)\/([^/]+)\/recruit\/submit_candidate\/?$/);
  if (!path) return null;
  const requestId = clean(url.searchParams.get("submission_request_id"));
  const ctarId = clean(url.searchParams.get("candidate_to_approved_role_id"));
  const roleId = clean(path[2]);
  if (
    url.searchParams.get("from_submission_request") !== "true" ||
    !ID.test(requestId) || !ID.test(ctarId) || !ID.test(roleId)
  ) return null;
  return {
    requestId,
    ctarId,
    roleId,
    companySlug: clean(decodeURIComponent(path[1])),
    submitUrl: url.toString(),
  };
}

const HREF = /href\s*=\s*"([^"]+)"|href\s*=\s*'([^']+)'|<(https?:\/\/[^>\s]+)>|(https?:\/\/[^\s"'<>)]+)/gi;

// Every distinct protected submit link in a note, in order: one note can name
// more than one request.
export function findProtectedSubmitLinks(body) {
  const byRequest = new Map();
  for (const match of String(body ?? "").matchAll(HREF)) {
    const found = protectedSubmitLink(match[1] || match[2] || match[3] || match[4]);
    if (found && !byRequest.has(found.requestId)) byRequest.set(found.requestId, found);
  }
  return [...byRequest.values()];
}

export function findProtectedSubmitLink(body) {
  return findProtectedSubmitLinks(body)[0] || null;
}

// "Rating-protected sub: Jane Doe → Acme" (also "->"), with or without "Re:".
export function parseProtectedSubject(subject) {
  const match = clean(subject).replace(/^(re|fwd?):\s*/i, "")
    .match(/protected sub(?:mission)?\s*:\s*(.+?)\s*(?:→|->|—>)\s*(.+)$/i);
  return match ? { candidateName: clean(match[1]), companyName: clean(match[2]) } : {};
}

// A From header alone is forgeable, so Gmail's DMARC verdict for the From
// domain must pass. Not DKIM's own domain: Paraform's Google Workspace mail is
// DKIM-signed as paraform-com.<date>.gappssmtp.com (measured 2026-11-04), and
// DMARC is what ties that signature (or SPF) back to paraform.com.
export function paraformAuthenticated(message) {
  const results = clean(headerValue(message, "Authentication-Results"));
  // The lookahead stops "paraform.com.evil.example" from passing as paraform.com.
  return /\bdmarc=pass\b[^;]*\bheader\.from=paraform\.com(?=[\s;)]|$)/i.test(results);
}

// The real address is the one in angle brackets: a display name such as
// "conor@paraform.com" <x@elsewhere> must not pass as Paraform.
export function paraformSender(message) {
  const raw = clean(headerValue(message, "From"));
  const bracketed = raw.match(/<([^<>\s]+@[^<>\s]+)>\s*$/);
  const from = bracketed
    ? bracketed[1].toLowerCase()
    : (headerAddresses(message, "From").length === 1 ? headerAddresses(message, "From")[0] : "");
  return /^[^@\s]+@paraform\.com$/i.test(from) ? from.toLowerCase() : null;
}

// The note's "Why I think it fits:" paragraph, which names the person's past
// employers (v4 lookup, 2026-11-07: David's rule that Conor's background
// identifies the person). Only that paragraph: the rest of the note names
// the hiring company and Paraform, so a note without the marker gives "".
// HTML tags and links go, whitespace is collapsed, at most 1200 characters.
const FIT_TEXT_MAX = 1200;
const FIT_START = /why i think (?:it|they|he|she) fits?[*_\s]*:/i;
const FIT_END = /[*_\s]*why the role is worth/i;

function htmlToText(value) {
  return String(value ?? "")
    .replace(/<(style|script)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>|<\/(p|div|li|tr|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&(rsquo|lsquo|#8217|#8216|#39|apos);/gi, "'")
    .replace(/&(rdquo|ldquo|quot|#8220|#8221);/gi, '"')
    .replace(/&(mdash|ndash|#8212|#8211);/gi, "-")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&amp;/gi, "&");
}

export function protectedFitText(body) {
  const text = htmlToText(body);
  const start = text.match(FIT_START);
  if (!start) return "";
  const rest = text.slice(start.index + start[0].length);
  const end = rest.search(FIT_END);
  return (end >= 0 ? rest.slice(0, end) : rest.slice(0, FIT_TEXT_MAX))
    // A link goes; punctuation closing the sentence after it stays.
    .replace(/<?\b(?:https?:\/\/|www\.)[^\s<>]+>?/gi, (url) => ` ${url.match(/[).,;:!?'"]+$/)?.[0] || ""}`)
    .replace(/\*/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, FIT_TEXT_MAX)
    .trim();
}

// Only a subject that names a protected sub makes a link-less note worth a
// page; "protected submission" in Paraform's own mail bodies does not.
const MENTIONS_PROTECTED = /protected sub\b/i;

// { record, records } for a protected-sub note (records: one per request it
// names), { unparsed } for a Paraform note whose subject names a protected sub
// but has no link, or null for anything else.
export function parseProtectedNote(message, { threadId = null } = {}) {
  const sender = paraformSender(message);
  if (!sender) return null;
  const subject = clean(headerValue(message, "Subject"));
  const body = messageText(message);
  const links = findProtectedSubmitLinks(body);
  if (!links.length) {
    return MENTIONS_PROTECTED.test(subject)
      ? { unparsed: { messageId: clean(message?.id), threadId, sender, subject } }
      : null;
  }
  if (!paraformAuthenticated(message)) {
    return { unparsed: { messageId: clean(message?.id), threadId, sender, subject, reason: "auth" } };
  }
  // The subject's name belongs to the note's request only when it names one.
  const names = links.length === 1 ? parseProtectedSubject(subject) : {};
  const internal = Number(message?.internalDate);
  const fitText = protectedFitText(body);
  const records = links.map((link) => ({
    ...link,
    candidateName: names.candidateName || null,
    companyName: names.companyName || null,
    fitText,
    sender,
    subject,
    noteMessageId: clean(message?.id) || null,
    noteThreadId: clean(threadId || message?.threadId) || null,
    receivedAt: Number.isFinite(internal) && internal > 0
      ? new Date(internal).toISOString()
      : new Date().toISOString(),
  }));
  return { record: records[0], records };
}

function senderName(email) {
  const local = clean(email).split("@")[0] || "";
  const first = local.split(/[._-]/)[0] || local;
  return first ? first[0].toUpperCase() + first.slice(1) : "Someone at Paraform";
}

// Reads new notes into the store, at most once per slot. Returns every stored
// protected sub (also when the slot is not due), as a Map by request id.
export async function scanProtectedNotes({
  mailbox,
  now = Date.now(),
  searchImpl = searchMessages,
  getMessageImpl = getMessage,
  notifyImpl,
  store = {},
  // A burst (Paraform sends about 20 in a morning) is read over a few scans
  // rather than in one tick.
  maxReads = 25,
  // The lookup's window (PARAAI_PROTECTED_SUBS_WINDOW_DAYS, 1 to 21 days):
  // the fitText backfill reads every note the lookup queue would wait on
  // (2026-11-07 review: a fixed week left older notes deferred for good).
  windowMs = PROTECTED_WATCH_WINDOW_MS,
} = {}) {
  const s = {
    acquireSlot: acquireProtectedScanSlot,
    claimMeta: claimProtectedMeta,
    getMeta: getProtectedMeta,
    list: listProtectedSubs,
    markSeen: markProtectedMessageSeen,
    seenIds: protectedSeenMessageIds,
    save: saveProtectedSub,
    ...store,
  };
  const summary = { scanned: false, added: [], newSenders: [], unparsed: [] };
  const existing = new Map((await s.list()).map((row) => [row.requestId, row]));
  if (!(await s.acquireSlot().catch(() => false))) return { subs: existing, ...summary };
  summary.scanned = true;
  const meta = await s.getMeta().catch(() => ({}));
  // The very first scan learns who already sends these notes without paging.
  const seeded = Boolean(meta.seeded);
  // A Gmail or store failure ends the scan, never the tick, and never hides
  // the subs already stored; one unreadable message is skipped, not fatal.
  let seen;
  let listed;
  try {
    seen = await s.seenIds();
    listed = await searchImpl(mailbox, PROTECTED_NOTE_QUERY, 100);
  } catch (error) {
    return { subs: existing, ...summary, error: clean(error?.code || error?.message).slice(0, 120) || "scan_failed" };
  }
  const noteThreads = new Set([...existing.values()].map((row) => clean(row.noteThreadId)).filter(Boolean));
  summary.failed = 0;
  let reads = 0;
  // Oldest first, so a capped scan never leaves an old note behind new ones.
  for (const ref of [...(listed || [])].reverse()) {
    const messageId = clean(ref?.id);
    if (!messageId || seen.has(messageId)) continue;
    if (reads >= maxReads) { summary.capped = true; break; }
    reads += 1;
    try {
      await scanOneMessage(messageId, ref);
    } catch {
      summary.failed += 1;
      continue;
    }
    await s.markSeen(messageId).catch(() => {});
    seen.add(messageId);
  }
  // Seeded once the backlog has been read through, so no old note pages.
  if (!seeded && !summary.capped) await s.claimMeta("seeded").catch(() => false);
  // v4 lookup (2026-11-07): notes stored before the background was kept get
  // it read from their note, with the reads this scan has left, closest to
  // expiring first. A failed read counts a try on the note and is tried
  // again next scan; after PROTECTED_FIT_TEXT_MAX_TRIES the lookup goes on
  // without the background.
  const backfill = [...existing.values()]
    .filter((sub) => {
      const receivedMs = Date.parse(clean(sub?.receivedAt));
      return sub?.fitText === undefined && clean(sub?.noteMessageId)
        && Number(sub?.fitTextTries || 0) < PROTECTED_FIT_TEXT_MAX_TRIES
        && Number.isFinite(receivedMs) && receivedMs >= now - (Number(windowMs) > 0 ? Number(windowMs) : PROTECTED_WATCH_WINDOW_MS);
    })
    .sort((a, b) => Date.parse(a.receivedAt) - Date.parse(b.receivedAt));
  const fetched = new Map();
  for (const sub of backfill) {
    const messageId = clean(sub.noteMessageId);
    if (!fetched.has(messageId)) {
      if (reads >= maxReads) { summary.fitTextCapped = true; break; }
      reads += 1;
      fetched.set(messageId, await Promise.resolve()
        .then(() => getMessageImpl(mailbox, messageId))
        .then((message) => {
          if (!message) throw new Error("note message not found");
          return protectedFitText(messageText(message));
        })
        .catch(() => null));
    }
    const fitText = fetched.get(messageId);
    const updated = fitText == null
      ? { ...sub, fitTextTries: Number(sub.fitTextTries || 0) + 1 }
      : { ...sub, fitText };
    await s.save(updated).catch(() => {});
    existing.set(sub.requestId, updated);
    if (fitText == null) summary.fitTextFailed = (summary.fitTextFailed || 0) + 1;
    else summary.fitTextRead = (summary.fitTextRead || 0) + 1;
  }
  return { subs: existing, ...summary };

  async function scanOneMessage(messageId, ref) {
    const message = await getMessageImpl(mailbox, messageId);
    const threadId = clean(message?.threadId || ref?.threadId);
    const parsed = parseProtectedNote(message, { threadId });
    for (const record of parsed?.records || []) {
      if (!existing.has(record.requestId)) {
        const stored = { ...record, firstSeenAt: new Date(now).toISOString() };
        await s.save(stored);
        existing.set(record.requestId, stored);
        summary.added.push(record.requestId);
      }
      if (record.noteThreadId) noteThreads.add(record.noteThreadId);
      if (await s.claimMeta(`sender:${record.sender}`).catch(() => false)) {
        summary.newSenders.push(record.sender);
        if (seeded && notifyImpl) {
          await notifyImpl(
            `🛡️ Para AI: a new Paraform sender of rating-protected subs: ${senderName(record.sender)} (${record.sender}). Their notes are handled like Conor's. First one: ${record.subject || record.requestId}.`,
          ).catch(() => false);
        }
      }
    }
    // A reply on a note thread we already hold (a staff chaser that does not
    // quote the link) is not a new note.
    if (parsed?.unparsed && !noteThreads.has(threadId)) {
      summary.unparsed.push(parsed.unparsed.messageId);
      if (seeded && notifyImpl && await s.claimMeta(`unparsed:${messageId}`).catch(() => false)) {
        const reason = parsed.unparsed.reason === "auth"
          ? "it did not pass Paraform's email signature check"
          : "it has no protected submit link the system can read";
        await notifyImpl(
          `⚠️ Para AI: a Paraform note about a protected sub was NOT handled because ${reason}. Subject: ${parsed.unparsed.subject || "(none)"} from ${parsed.unparsed.sender}. Gmail thread ${parsed.unparsed.threadId || "unknown"}. Handle it by hand.`,
        ).catch(() => false);
      }
    }
  }
}

// Protected subs whose note is recent, an hour old, and still unemailed: one
// Slack line each, ever. `history` is this tick's request read; a request that
// is missing from it or not pending says why it was not sent.
export async function watchUnsentProtectedSubs({
  subs,
  history = [],
  states = [],
  sentThisTick = [],
  exceptions = [],
  // Who each note is about (outreach-protected-lookup.mjs): says why a note
  // the request read does not hold has no row.
  lookups = {},
  // Staff picks (2026-11-06): a note a person chose to skip is decided, so
  // it does not page as unsent.
  picks = {},
  // Notes from before protected subs were switched on are not this lane's.
  notBeforeMs = null,
  // The do-not-send list (PARAAI_PROTECTED_SUBS_SKIP): decided like a staff
  // skip, so never paged. And the send cutoff the picks page lists from: the
  // pick link only goes with a note that page lists (2026-11-06 second review).
  skip = null,
  sendFromMs = null,
  now = Date.now(),
  claimImpl = claimProtectedMeta,
  notifyImpl,
} = {}) {
  const delivered = new Set(sentThisTick || []);
  for (const state of states || []) {
    for (const [requestId, match] of Object.entries(state?.matches || {})) {
      if (match?.sentAt) delivered.add(requestId);
    }
    // Queued in the Mailroom (its send window is closed) is on its way.
    for (const [key, entry] of Object.entries(state?.outbox || {})) {
      if (key.startsWith("match:") && ["claimed", "queued"].includes(entry?.status)) {
        delivered.add(key.slice("match:".length));
      }
    }
  }
  const rows = new Map((history || []).map((row) => [row.id, row]));
  const openException = new Map((exceptions || [])
    .filter((row) => row?.status === "open")
    .map((row) => [clean(row.requestId), clean(row.code)]));
  const alerted = [];
  for (const sub of subs?.values?.() || []) {
    const receivedMs = Date.parse(sub.receivedAt);
    if (!Number.isFinite(receivedMs)) continue;
    if (receivedMs < now - PROTECTED_WATCH_WINDOW_MS) continue;
    if (notBeforeMs != null && receivedMs < notBeforeMs) continue;
    if (receivedMs > now - PROTECTED_UNSENT_ALERT_MS) continue;
    if (delivered.has(sub.requestId)) continue;
    if (picks?.[sub.requestId]?.action === "skip") continue;
    if (skip?.has?.(sub.requestId)) continue;
    if (!(await claimImpl(`unsent:${sub.requestId}`).catch(() => false))) continue;
    const row = rows.get(sub.requestId);
    // A note staff already picked a person for is decided: with no row, say
    // why the pick did not send, never "held for a staff pick" (2026-11-06 review).
    const sendPick = picks?.[sub.requestId]?.action === "send" ? picks[sub.requestId] : null;
    const pickWhy = !row && sendPick
      ? `staff picked ${sendPick.name || "a person"}, but it was not sent because ${
        protectedPickBlocked({ sub, lookup: lookups[sub.requestId], pick: sendPick, states })
        || "a send guard dropped it (the note may be on the do-not-send list or before the send cutoff)"}`
      : null;
    const lookup = lookups[sub.requestId];
    // A resolved note with no row: say why, e.g. the person was already
    // emailed about this role under another request (2026-11-06 second review).
    const resolvedWhy = !row && lookup?.status === "resolved"
      ? protectedPickBlocked({ sub, lookup, pick: { action: "send", candidateUserId: lookup.candidateUserId }, states })
      : null;
    const why = pickWhy || (!row
      ? resolvedWhy || lookupReason(lookup) || "Paraform's request list does not show this request"
      : row.status !== "pending"
        ? `Paraform shows the request as ${row.status || "unknown"}`
        : openException.get(sub.requestId)
          ? `it is held (${openException.get(sub.requestId)})`
          : "it is pending and was not sent yet");
    alerted.push({ requestId: sub.requestId, why });
    if (notifyImpl) {
      // A note with no row is one the lookup did not settle: a person can
      // pick who it is on the page (2026-11-06). No more names or emails here.
      // Only for a note the picks page lists: not one the lookup resolved
      // (the page counts it as handled) and not one from before the send
      // cutoff (2026-11-06 second review).
      const listed = !row && !sendPick && lookup?.status !== "resolved"
        && (sendFromMs == null || receivedMs >= sendFromMs);
      const pickLine = listed ? `\nPick the right person: ${PROTECTED_PICKS_PAGE_URL}` : "";
      await notifyImpl(
        `🛡️ Para AI: the candidate for the rating-protected sub ${sub.candidateName || sub.requestId} → ${sub.companyName || "a role"} has not been emailed an hour after the note, because ${why}. Submit link: ${sub.submitUrl}${pickLine}`,
      ).catch(() => false);
    }
  }
  return alerted;
}
