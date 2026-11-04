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
  const records = links.map((link) => ({
    ...link,
    candidateName: names.candidateName || null,
    companyName: names.companyName || null,
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
  for (const ref of listed || []) {
    const messageId = clean(ref?.id);
    if (!messageId || seen.has(messageId)) continue;
    try {
      await scanOneMessage(messageId, ref);
    } catch {
      summary.failed += 1;
      continue;
    }
    await s.markSeen(messageId).catch(() => {});
    seen.add(messageId);
  }
  if (!seeded) await s.claimMeta("seeded").catch(() => false);
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
  // Notes from before protected subs were switched on are not this lane's.
  notBeforeMs = null,
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
    if (!(await claimImpl(`unsent:${sub.requestId}`).catch(() => false))) continue;
    const row = rows.get(sub.requestId);
    const why = !row
      ? "Paraform's request list does not show this request"
      : row.status !== "pending"
        ? `Paraform shows the request as ${row.status || "unknown"}`
        : openException.get(sub.requestId)
          ? `it is held (${openException.get(sub.requestId)})`
          : "it is pending and was not sent yet";
    alerted.push({ requestId: sub.requestId, why });
    if (notifyImpl) {
      await notifyImpl(
        `🛡️ Para AI: the candidate for the rating-protected sub ${sub.candidateName || sub.requestId} → ${sub.companyName || "a role"} has not been emailed an hour after the note, because ${why}. Submit link: ${sub.submitUrl}`,
      ).catch(() => false);
    }
  }
  return alerted;
}
