// A stored copy of the PENDING ParaAI interview requests, for readers that must
// never call Paraform themselves (2026-11-19: the CRM Call List,
// app.raydar.xyz/call-list, where a recruiter phones the people named in them).
//
// WHO WRITES IT. The outreach tick (outreach.mjs runOutreachTick) already reads
// the request history from Paraform on its own cadence (about every two
// minutes, through the request lanes' throttle). Right after that read it hands
// the rows here and this module saves the pending ones. Nothing in this file
// calls Paraform, and no extra Paraform read exists because of it.
//
// TWO PARTS, because the tick reads two things on two clocks:
//   own        David's own requests, read on every admitted tick.
//   teammates  the named teammates' requests, read at most every
//              PARAAI_OUTREACH_TEAMMATE_READ_SECONDS (default 10 minutes). A
//              tick that did not read teammates leaves this part as it was.
// Each part carries the time of the read it came from, so a reader can tell
// how old it is. Both expire from the store after a day: a lane that has been
// shut that long has nothing trustworthy to say about what is still pending.
//
// WHAT COUNTS AS PENDING. Paraform's own word only: status "pending" and not
// state EXPIRED. The expiry time is created + EXPIRY_DAYS (reply-actions.mjs,
// Paraform's own 7 days): a forecast for the reader's "expires in" label, never
// proof that a row is live. A row whose forecast has passed is left out at read
// time. Rating-protected subs are not rows of this read and are not included.
//
// The store is the request lanes' own KV (request-lane-store.mjs). A failed
// write or read never throws to the tick: the write is best effort, and a
// reader sees "no copy yet".

import { EXPIRY_DAYS } from "./reply-actions.mjs";
import { requestLaneKv } from "./request-lane-store.mjs";

export const PENDING_OWN_KEY = "paraai:outreach:pending-snapshot:own";
export const PENDING_TEAMMATES_KEY = "paraai:outreach:pending-snapshot:teammates";
export const PENDING_SNAPSHOT_TTL_SECONDS = 24 * 60 * 60;
// Far above anything seen (David's whole history was 416 rows on 2026-10-12,
// most of them long closed). A cap so one odd read cannot write megabytes.
export const PENDING_SNAPSHOT_MAX_ROWS = 1000;

// The two writes together may hold the tick this long at most: the store's own
// timeout is 8 s, and the tick has sends to get to.
export const PENDING_SNAPSHOT_WRITE_BUDGET_MS = 3_000;

const DAY_MS = 24 * 60 * 60 * 1000;
// A mis-set PARAAI_EXPIRY_DAYS must not blank every forecast: Paraform's is 7.
const DEFAULT_EXPIRY_DAYS = Number.isFinite(EXPIRY_DAYS) && EXPIRY_DAYS > 0 ? EXPIRY_DAYS : 7;
const clean = (value, max = 200) => String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
const iso = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);

export function isPendingRequest(request) {
  return clean(request?.status).toLowerCase() === "pending" && clean(request?.state).toUpperCase() !== "EXPIRED";
}

// One normalized request (outreach.mjs normalizeSubmissionRequest) as the copy
// holds it. null when it is not pending or lacks what a reader needs.
export function pendingRow(request, { expiryDays = DEFAULT_EXPIRY_DAYS } = {}) {
  if (!isPendingRequest(request)) return null;
  // A missing created time arrives as null; Number(null) is 0, which is 1970.
  const createdMs = Number(request?.createdAtMs) > 0 ? Number(request.createdAtMs) : NaN;
  const row = {
    request_id: clean(request?.id, 120),
    candidate_name: clean(request?.candidateName),
    candidate_user_id: clean(request?.candidateUserId, 80) || null,
    role_id: clean(request?.roleId, 80) || null,
    role_title: clean(request?.roleName),
    company_name: clean(request?.companyName),
    created_at: iso(createdMs),
    expires_at: iso(createdMs + expiryDays * DAY_MS),
    // "david" for his own requests, else the teammate's key (outreach-scope.mjs).
    recruiter: clean(request?.recruiterKey, 40) || (request?.ownRequest === false ? null : "david"),
    // Paraform's own "reached out to candidate" mark, as last read.
    reached_out: request?.reachedOut === true,
  };
  if (!row.request_id || !row.candidate_name || !row.role_title || !row.company_name || !row.created_at) return null;
  return row;
}

function pendingRows(requests, options) {
  const seen = new Set();
  const rows = [];
  for (const request of Array.isArray(requests) ? requests : []) {
    const row = pendingRow(request, options);
    if (!row || seen.has(row.request_id)) continue;
    seen.add(row.request_id);
    rows.push(row);
    if (rows.length >= PENDING_SNAPSHOT_MAX_ROWS) break;
  }
  return rows;
}

// Called by the tick with the rows it just read. `teammatesRead` is the
// scope's own flag: only then is the teammates' part replaced.
export async function recordPendingSnapshot(
  requests,
  { teammatesRead = false, now = Date.now(), kvImpl = requestLaneKv, budgetMs = PENDING_SNAPSHOT_WRITE_BUDGET_MS } = {},
) {
  const list = Array.isArray(requests) ? requests : [];
  const at = new Date(now).toISOString();
  // Both writes at once, and neither may hold the tick past the budget: a
  // write still in flight then is reported as not saved (it may yet land).
  let timer;
  const late = new Promise((resolve) => { timer = setTimeout(() => resolve(false), budgetMs); });
  const save = (key, rows) => Promise.race([
    Promise.resolve()
      .then(() => kvImpl(["SET", key, JSON.stringify({ at, rows }), "EX", PENDING_SNAPSHOT_TTL_SECONDS]))
      .then(() => true, () => false),
    late,
  ]);
  try {
    const [own, teammates] = await Promise.all([
      save(PENDING_OWN_KEY, pendingRows(list.filter((request) => request?.ownRequest !== false))),
      teammatesRead
        ? save(PENDING_TEAMMATES_KEY, pendingRows(list.filter((request) => request?.ownRequest === false)))
        : null,
    ]);
    return { own, teammates };
  } finally {
    clearTimeout(timer);
  }
}

async function readPart(key, kvImpl) {
  const raw = await kvImpl(["GET", key]).catch(() => null);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || !Number.isFinite(Date.parse(parsed.at)) || !Array.isArray(parsed.rows)) return null;
    return parsed;
  } catch {
    return null;
  }
}

// The copy as GET /api/paraai/pending-requests answers it. `as_of` is the time
// of David's own read (null: no copy, so the reader must not treat the empty
// list as "nobody is pending").
export async function readPendingSnapshot({ now = Date.now(), kvImpl = requestLaneKv } = {}) {
  const [own, teammates] = await Promise.all([
    readPart(PENDING_OWN_KEY, kvImpl),
    readPart(PENDING_TEAMMATES_KEY, kvImpl),
  ]);
  const seen = new Set();
  const requests = [];
  for (const row of [...(own?.rows || []), ...(teammates?.rows || [])]) {
    const id = clean(row?.request_id, 120);
    const expiresMs = Date.parse(row?.expires_at);
    if (!id || seen.has(id) || !Number.isFinite(expiresMs) || expiresMs <= now) continue;
    seen.add(id);
    requests.push(row);
  }
  requests.sort((left, right) => Date.parse(left.expires_at) - Date.parse(right.expires_at));
  return {
    as_of: own?.at ?? null,
    teammates_as_of: teammates?.at ?? null,
    expiry_days: DEFAULT_EXPIRY_DAYS,
    count: requests.length,
    requests,
  };
}
