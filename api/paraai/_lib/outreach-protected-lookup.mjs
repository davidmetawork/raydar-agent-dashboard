// Rating-protected subs: who the note is about (David, 2026-11-04).
//
// Paraform's rating-protected requests never appear in David's request
// history (measured 2026-11-04: 0 of 46 stored notes in the read), so the
// lane cannot admit one from that read. Instead the note itself names the
// person: this finds them on Paraform by the name in the note's subject and
// accepts them only when exactly one person by that name has the note's exact
// role on their Paraform record (David's rule). Anything else (nobody, two
// people, an unreadable role) is recorded and never sent; the unsent watch
// then pages with that reason.
//
// A resolved note becomes a request row of the tick (`synthetic: true`), so
// the normal send path applies every guard. Such a row never gets Paraform's
// reached-out marker, never reaches the digest write, and never goes to the
// reply pass, which could dismiss the request on Paraform.

import {
  getProtectedLookups,
  pruneProtectedLookups,
  saveProtectedLookup,
} from "./outreach-store.mjs";
import {
  REQUEST_LANE_COOLDOWN_CODE,
  REQUEST_LANE_RATE_LIMITED_CODE,
} from "./request-lane-throttle.mjs";

// Same window the unsent watch uses: a note older than a week is past acting on.
export const PROTECTED_LOOKUP_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
// "Nobody found" is retried (Paraform may add the role a little after the
// note), at most this many times, this far apart.
export const PROTECTED_LOOKUP_MAX_ATTEMPTS = 3;
export const PROTECTED_LOOKUP_RETRY_MS = 10 * 60 * 1000;
const CRM_PAGE_LIMIT = 50;
const CRM_MAX_PAGES = 3;
// More people by that name than this, or more search pages than the cap: the
// lookup cannot prove there is only one, so it never resolves.
const MAX_NAME_MATCHES = 4;
// Paraform puts the person on the role minutes before the note (measured
// 2026-11-04: 6 minutes). An older application on the role is someone else's
// story (a past applicant by the same name), so it does not count, unless
// Paraform's own id for it is the note's protected-sub id.
const APPLICATION_BEFORE_NOTE_MS = 7 * 24 * 60 * 60 * 1000;
const APPLICATION_AFTER_NOTE_MS = 60 * 60 * 1000;
// Bumped when the lookup changes, so the earlier notes are measured again.
export const PROTECTED_LOOKUP_VERSION = 2;
// A pacing refusal is retried later without using an attempt, this many times.
const MAX_THROTTLED = 12;
const FINAL_STATUSES = new Set(["resolved", "ambiguous", "too_many", "incomplete", "no_name", "role_inactive"]);

const clean = (value) => String(value ?? "").trim();

// Lowercase, accents and punctuation off, so "José O'Neil" matches "jose oneil".
export function nameTokens(value) {
  return clean(value)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/['’.]/g, "")
    .split(/[^a-z0-9-]+/)
    .filter(Boolean);
}

// First and last name both equal (a middle name on either side is fine).
export function sameName(left, right) {
  const a = nameTokens(left);
  const b = nameTokens(right);
  if (a.length < 2 || b.length < 2) return a.length > 0 && a.join(" ") === b.join(" ");
  return a[0] === b[0] && a[a.length - 1] === b[b.length - 1];
}

function crmName(item) {
  const person = item?.candidate && typeof item.candidate === "object" ? item.candidate : {};
  return clean(
    person.name
    || item?.full_name
    || [item?.first_name, item?.last_name].filter(Boolean).join(" ")
    || item?.name
    || item?.candidate_name,
  );
}

function crmId(item) {
  return clean(item?.candidate_user_id || item?.cu_id || item?.candidateUserId || item?.id);
}

function crmLinkedin(item) {
  const person = item?.candidate && typeof item.candidate === "object" ? item.candidate : {};
  return clean(item?.linkedin_user || person.linkedin_user) || null;
}

function applicationRoleId(row) {
  return clean(row?.role_id || row?.role?.id || row?.roleId);
}

// Where a person's CRM row names the role (measured 2026-11-04: the
// applications read omits roles Paraform added the person to as "Sourced",
// which is how a protected sub arrives). Returns the path to the first value
// equal to the role id and the date on the object holding it, if any.
export function roleLinkInRow(node, roleId, path = "", depth = 0) {
  if (!node || typeof node !== "object" || depth > 6) return null;
  const entries = Array.isArray(node) ? node.map((value, index) => [index, value]) : Object.entries(node);
  for (const [key, value] of entries) {
    if (typeof value === "string" && value === roleId) {
      return { path: `${path}${Array.isArray(node) ? "[]" : `.${key}`}`, atMs: Array.isArray(node) ? null : applicationTimeMs(node) };
    }
  }
  for (const [key, value] of entries) {
    if (value && typeof value === "object") {
      const found = roleLinkInRow(value, roleId, `${path}${Array.isArray(node) ? "[]" : `.${key}`}`, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

function rowUpdatedMs(item) {
  const person = item?.candidate && typeof item.candidate === "object" ? item.candidate : {};
  for (const value of [item?.updated_at, item?.updatedAt, person.updated_at, person.updatedAt]) {
    const ms = Date.parse(clean(value));
    if (Number.isFinite(ms)) return ms;
  }
  return null;
}

function applicationTimeMs(row) {
  for (const value of [row?.created_at, row?.createdAt, row?.updated_at, row?.updatedAt, row?.submitted_at]) {
    const ms = Date.parse(clean(value));
    if (Number.isFinite(ms)) return ms;
  }
  return null;
}

// Which subs to look up this tick: notes in the window (a week unless set)
// that the request read does not hold, never looked up or due a retry, and
// not skipped. Notes from the send cutoff on come first (oldest first); then
// at most `backfill` earlier ones (newest first), only recorded, never sent.
export function protectedLookupQueue({ subs, historyIds, lookups = {}, notBeforeMs, now = Date.now(), backfill = 0, windowMs = PROTECTED_LOOKUP_WINDOW_MS, skip = null } = {}) {
  const due = (sub) => {
    const record = lookups[sub.requestId];
    if (!record) return true;
    if (FINAL_STATUSES.has(record.status)) return false;
    if (Number(record.attempts || 0) >= PROTECTED_LOOKUP_MAX_ATTEMPTS) return false;
    if (Number(record.throttled || 0) >= MAX_THROTTLED) return false;
    const last = Date.parse(record.lastTriedAt || "");
    return !Number.isFinite(last) || last <= now - PROTECTED_LOOKUP_RETRY_MS;
  };
  const fresh = [];
  const earlier = [];
  let earlierRecorded = 0;
  for (const sub of subs?.values?.() || []) {
    const receivedMs = Date.parse(sub?.receivedAt || "");
    if (!Number.isFinite(receivedMs) || receivedMs < now - windowMs) continue;
    if (historyIds?.has?.(sub.requestId)) continue;
    if (skip?.has?.(sub.requestId)) continue;
    const afterSwitchOn = notBeforeMs != null && receivedMs >= notBeforeMs;
    if (afterSwitchOn) {
      if (due(sub)) fresh.push(sub);
    } else if (Number(lookups[sub.requestId]?.version || 1) >= PROTECTED_LOOKUP_VERSION) {
      earlierRecorded += 1;
    } else {
      earlier.push(sub);
    }
  }
  fresh.sort((a, b) => Date.parse(a.receivedAt) - Date.parse(b.receivedAt));
  earlier.sort((a, b) => Date.parse(b.receivedAt) - Date.parse(a.receivedAt));
  return [...fresh, ...earlier.slice(0, Math.max(0, backfill - earlierRecorded))];
}

// One note: the role, then the people by that name, then whose record has
// the role. Calls go one at a time through the lane's throttled reader; a
// pace-cap or cooldown refusal throws (the runner records it as throttled).
export async function lookupProtectedSub(sub, { trpcGetImpl, now = Date.now(), previous = null } = {}) {
  const base = {
    requestId: sub.requestId,
    roleId: clean(sub.roleId) || null,
    lastTriedAt: new Date(now).toISOString(),
    attempts: Number(previous?.attempts || 0) + 1,
    throttled: Number(previous?.throttled || 0),
    version: PROTECTED_LOOKUP_VERSION,
  };
  const name = clean(sub.candidateName);
  if (!name) return { ...base, status: "no_name" };
  if (!base.roleId) return { ...base, status: "role_unreadable" };
  const role = await trpcGetImpl("role.getRoleByIdSimple", { role_id: base.roleId, id: base.roleId });
  const roleName = clean(role?.title ?? role?.name);
  const companyName = clean(role?.company?.name ?? role?.company_name ?? role?.companyName) || clean(sub.companyName);
  const returnedId = clean(role?.id || role?.role_id || role?.roleId);
  if (!roleName || !companyName || returnedId !== base.roleId) return { ...base, status: "role_unreadable" };
  const roleStatus = clean(role?.status).toUpperCase();
  if (roleStatus && roleStatus !== "ACTIVE") return { ...base, roleName, companyName, roleStatus, status: "role_inactive" };
  const found = new Map();
  let cursor = null;
  let pages = 0;
  let complete = false;
  while (pages < CRM_MAX_PAGES) {
    const response = await trpcGetImpl("candidateUser.getCRMExternalCandidates", {
      limit: CRM_PAGE_LIMIT,
      ...(cursor != null ? { cursor } : {}),
      filters: { sort: { field: "updated_at", direction: "desc" }, general_search: name },
    });
    pages += 1;
    const items = Array.isArray(response?.items) ? response.items : [];
    for (const item of items) {
      const id = crmId(item);
      if (id && sameName(crmName(item), name) && !found.has(id)) found.set(id, item);
    }
    cursor = response?.next_cursor ?? null;
    if (cursor == null || items.length < CRM_PAGE_LIMIT) { complete = true; break; }
  }
  const evidence = { roleName, companyName, roleStatus: roleStatus || null, nameMatches: found.size, crmPages: pages };
  // The search did not reach its end, or found too many to check: another
  // person by that name could be the one, so this is never a match.
  if (!complete) return { ...base, ...evidence, status: "incomplete" };
  if (found.size > MAX_NAME_MATCHES) return { ...base, ...evidence, status: "too_many" };
  const receivedMs = Date.parse(clean(sub.receivedAt));
  const nearNote = (at) => Number.isFinite(receivedMs) && at != null
    && at >= receivedMs - APPLICATION_BEFORE_NOTE_MS && at <= receivedMs + APPLICATION_AFTER_NOTE_MS;
  const confirmed = [];
  let onRoleRows = 0;
  let crmRoleLinks = 0;
  let crmRolePath = null;
  for (const [candidateUserId, item] of found) {
    // The role on the person's CRM row counts when that link is dated near
    // the note, or, undated, when the row itself changed since a week before
    // the note (Paraform adding the role is what changed it).
    const link = roleLinkInRow(item, base.roleId);
    if (link) {
      crmRoleLinks += 1;
      crmRolePath = crmRolePath || link.path;
      const updatedMs = rowUpdatedMs(item);
      const linkRecent = link.atMs != null
        ? nearNote(link.atMs)
        : updatedMs != null && Number.isFinite(receivedMs) && updatedMs >= receivedMs - APPLICATION_BEFORE_NOTE_MS;
      if (linkRecent) {
        confirmed.push({ candidateUserId, linkedinUser: crmLinkedin(item), ctarMatch: false, via: "crm_row" });
        continue;
      }
    }
    const rows = await trpcGetImpl("candidateUser.getCandidateUserApplications", { candidate_user_id: candidateUserId });
    const onRole = (Array.isArray(rows) ? rows : []).filter((row) => applicationRoleId(row) === base.roleId);
    onRoleRows += onRole.length;
    const exact = Boolean(clean(sub.ctarId)) && onRole.some((row) => (
      clean(row?.id) === clean(sub.ctarId) || clean(row?.candidate_to_approved_role_id) === clean(sub.ctarId)
    ));
    const recent = onRole.some((row) => nearNote(applicationTimeMs(row)));
    if (exact || recent) confirmed.push({ candidateUserId, linkedinUser: crmLinkedin(item), ctarMatch: exact, via: "application" });
  }
  Object.assign(evidence, { onRoleRows, crmRoleLinks, crmRolePath, confirmed: confirmed.length });
  if (confirmed.length === 1) {
    return { ...base, ...evidence, status: "resolved", candidateUserId: confirmed[0].candidateUserId, linkedinUser: confirmed[0].linkedinUser, ctarMatch: confirmed[0].ctarMatch, via: confirmed[0].via };
  }
  if (confirmed.length > 1) return { ...base, ...evidence, status: "ambiguous" };
  return { ...base, ...evidence, status: "not_found" };
}

// The same refusals that stop the tick's other Paraform work.
const STOP_CODES = new Set([
  REQUEST_LANE_COOLDOWN_CODE,
  REQUEST_LANE_RATE_LIMITED_CODE,
  "PARAFORM_THROTTLED",
  "AUTH_EXPIRED",
  "HTTP_429",
]);

// Looks up at most `maxLookups` notes (one by default: a lookup is up to
// nine reads against the shared 10-a-minute pace cap), within `budgetMs`.
// It runs after the tick's sends. Returns every stored lookup plus this tick's.
export async function runProtectedLookups({
  subs,
  historyIds,
  notBeforeMs,
  now = Date.now(),
  trpcGetImpl,
  backfill = 0,
  maxLookups = 1,
  windowMs = PROTECTED_LOOKUP_WINDOW_MS,
  skip = null,
  budgetMs = 25_000,
  clock = Date.now,
  store = {},
} = {}) {
  const s = { list: getProtectedLookups, save: saveProtectedLookup, prune: pruneProtectedLookups, ...store };
  const summary = { looked: 0, stopped: null };
  // An unreadable store would re-run (and overwrite) every lookup: skip.
  const lookups = await s.list().catch(() => null);
  if (!lookups) return { lookups: {}, ...summary, error: "lookup_store_unreadable" };
  if (typeof trpcGetImpl !== "function" || !subs?.size) return { lookups, ...summary };
  // Records for notes no longer stored or older than two windows go.
  const stale = Object.keys(lookups).filter((requestId) => {
    const sub = subs.get(requestId);
    const receivedMs = Date.parse(sub?.receivedAt || "");
    return !sub || !Number.isFinite(receivedMs) || receivedMs < now - 2 * windowMs;
  });
  if (stale.length) await s.prune(stale).catch(() => {});
  const started = clock();
  const queue = protectedLookupQueue({ subs, historyIds, lookups, notBeforeMs, now, backfill, windowMs, skip });
  for (const sub of queue.slice(0, maxLookups)) {
    if (clock() - started > budgetMs) { summary.stopped = "budget"; break; }
    const previous = lookups[sub.requestId] || null;
    let record;
    try {
      record = await lookupProtectedSub(sub, { trpcGetImpl, now, previous });
    } catch (error) {
      const code = clean(error?.code);
      const throttled = STOP_CODES.has(code) || Number(error?.status) === 429;
      record = {
        ...(previous || {}),
        requestId: sub.requestId,
        roleId: clean(sub.roleId) || null,
        lastTriedAt: new Date(now).toISOString(),
        // A pacing refusal moves the note to the back of the queue without
        // using an attempt; any other error uses one.
        ...(throttled
          ? { status: previous?.status && previous.status !== "error" ? previous.status : "throttled", throttled: Number(previous?.throttled || 0) + 1 }
          : { status: "error", error: (code || clean(error?.name) || "error").slice(0, 60), attempts: Number(previous?.attempts || 0) + 1 }),
      };
      if (throttled) summary.stopped = code || "throttled";
    }
    record.afterSwitchOn = notBeforeMs != null && Date.parse(sub.receivedAt) >= notBeforeMs;
    lookups[sub.requestId] = record;
    summary.looked += 1;
    await s.save(record).catch(() => {});
    if (summary.stopped) break;
  }
  return { lookups, ...summary };
}

// Request rows for the resolved notes from the send cutoff on that the read
// does not hold and are not skipped. Every field the send path needs is
// present, or no row.
export function syntheticProtectedRequests({ subs, lookups = {}, historyIds, notBeforeMs, now = Date.now(), windowMs = PROTECTED_LOOKUP_WINDOW_MS, skip = null, states = [] } = {}) {
  if (notBeforeMs == null) return [];
  // A person already emailed about this role under another request is not
  // emailed again (the backlog, 2026-11-05, holds notes for such roles).
  const emailedRoles = new Map();
  for (const state of states || []) {
    for (const match of Object.values(state?.matches || {})) {
      if (!match?.sentAt || !clean(match.roleId)) continue;
      const key = `${clean(state.candidateUserId)}\0${clean(match.roleId)}`;
      if (!emailedRoles.has(key)) emailedRoles.set(key, new Set());
      emailedRoles.get(key).add(clean(match.requestId));
    }
  }
  const rows = [];
  for (const sub of subs?.values?.() || []) {
    const lookup = lookups[sub.requestId];
    if (lookup?.status !== "resolved") continue;
    if (historyIds?.has?.(sub.requestId)) continue;
    if (skip?.has?.(sub.requestId)) continue;
    const receivedMs = Date.parse(sub.receivedAt || "");
    if (!Number.isFinite(receivedMs) || receivedMs < notBeforeMs || receivedMs < now - windowMs) continue;
    const required = [sub.requestId, lookup.candidateUserId, sub.roleId, lookup.roleName, lookup.companyName, sub.submitUrl];
    if (required.some((value) => !clean(value))) continue;
    const emailedFor = emailedRoles.get(`${clean(lookup.candidateUserId)}\0${clean(sub.roleId)}`);
    if (emailedFor && !emailedFor.has(sub.requestId)) continue;
    rows.push({
      id: sub.requestId,
      status: "pending",
      synthetic: true,
      candidateUserId: lookup.candidateUserId,
      candidateName: clean(sub.candidateName) || null,
      linkedinUser: lookup.linkedinUser || null,
      roleId: sub.roleId,
      roleName: lookup.roleName,
      companyName: lookup.companyName,
      createdAt: new Date(receivedMs).toISOString(),
      createdAtMs: receivedMs,
      reachedOut: false,
      reachedOutAt: null,
      reachedOutAtMs: null,
      recipientTypes: [],
      ownRequest: true,
      protectedSub: {
        submitUrl: sub.submitUrl,
        ctarId: sub.ctarId || null,
        receivedAt: sub.receivedAt,
        sender: sub.sender || null,
        noteThreadId: sub.noteThreadId || null,
      },
    });
  }
  return rows;
}

// Every stored lookup; an unreadable store reads as none (so no row).
export async function getProtectedLookupsSafe() {
  return getProtectedLookups().catch(() => ({}));
}

// Why a note the read does not hold was not emailed, for the unsent watch.
export function lookupReason(lookup) {
  switch (lookup?.status) {
    case "not_found": return "no one on Paraform by that name has this role on their record";
    case "ambiguous": return "more than one person on Paraform by that name has this role on their record";
    case "role_unreadable": return "the role in the note could not be read on Paraform";
    case "role_inactive": return `Paraform shows the role as ${lookup.roleStatus || "not active"}`;
    case "too_many": return "too many people on Paraform share that name to be sure who it is";
    case "incomplete": return "the Paraform search by that name did not finish, so another person by that name could be the one";
    case "throttled": return "the candidate lookup is waiting on Paraform's request pacing";
    case "no_name": return "the note does not name the candidate";
    case "error": return `the candidate lookup failed (${lookup.error || "error"})`;
    case "resolved": return null;
    default: return "Paraform's request list does not show this request and the candidate lookup has not finished";
  }
}
