// Rating-protected subs: staff picks (David, 2026-11-06).
//
// A note the lookup could not settle (outreach-protected-lookup.mjs: a
// surname shown only as an initial, degree letters after the name, a very
// common name) is HELD, never guessed. protected-subs.html lists the held
// notes with every person by a compatible name the lookup saw, and a person
// picks one ("send") or drops the note ("skip"). The pick lives in its own
// store hash; the next tick turns a "send" pick into a request row, and the
// normal send path still applies every guard.
//
// Picks are human only: the runner and cron bearer can list, never pick.

import { lookupReason, PROTECTED_LOOKUP_VERSION, protectedPickBlocked } from "./outreach-protected-lookup.mjs";
import {
  acquireOutreachLock,
  getOutreachState,
  getProtectedLookups,
  getProtectedPicks,
  listOutreachStates,
  listProtectedSubs,
  releaseOutreachLock,
  saveProtectedPick,
} from "./outreach-store.mjs";

const clean = (value) => String(value ?? "").trim();
const DAY_MS = 24 * 60 * 60 * 1000;
// A picked note stays on the page this long, so staff see it went out.
export const PICK_SHOWN_MS = 7 * DAY_MS;
// Paraform expires a request seven days after it is made.
const REQUEST_LIFETIME_MS = 7 * DAY_MS;
export const PICK_QUEUED_MESSAGE =
  "queued: the next tick, within about 5 minutes, sends it with all the usual checks; the Mailroom sends 05:00 to 19:30 PT";

const defaultStore = {
  listSubs: () => listProtectedSubs(),
  getLookups: () => getProtectedLookups(),
  getPicks: () => getProtectedPicks(),
  savePick: (record, options) => saveProtectedPick(record, options),
  listStates: () => listOutreachStates(),
  getState: (candidateUserId) => getOutreachState(candidateUserId),
  // The send path's own per-candidate lock (processMatchRequest).
  lock: (candidateUserId) => acquireOutreachLock(candidateUserId),
  unlock: (candidateUserId, token) => releaseOutreachLock(candidateUserId, token),
};

// The signed-in staff member, or null. A runner or cron bearer is never a
// person, and with Google sign-in unconfigured nobody is (requireAuth lets
// the request through without an email then).
export function staffActor(req) {
  if (req?.automationBearer === true) return null;
  const email = clean(req?.authedEmail).toLowerCase();
  return /^[^@\s]+@[^@\s]+$/.test(email) ? email : null;
}

// requestId -> "sent" | "queued", from the outreach states.
export function protectedDeliveries(states = []) {
  const out = new Map();
  for (const state of states || []) {
    for (const [requestId, match] of Object.entries(state?.matches || {})) {
      if (match?.sentAt) out.set(requestId, "sent");
    }
    for (const [key, entry] of Object.entries(state?.outbox || {})) {
      if (!key.startsWith("match:") || !["claimed", "queued"].includes(entry?.status)) continue;
      const requestId = clean(entry?.requestId) || key.slice("match:".length);
      if (!out.has(requestId)) out.set(requestId, "queued");
    }
  }
  return out;
}

function sendCutoff(config) {
  return config?.protectedSendFromMs ?? config?.protectedNotBeforeMs ?? null;
}

// Whether a note is one this lane may still send: received in the window,
// from the send cutoff on, and not on the skip list.
function noteInLane(sub, config, now) {
  const receivedMs = Date.parse(clean(sub?.receivedAt));
  const cutoff = sendCutoff(config);
  if (!Number.isFinite(receivedMs) || cutoff == null) return false;
  if (receivedMs < cutoff || receivedMs < now - Number(config.protectedWindowMs || REQUEST_LIFETIME_MS)) return false;
  return !config.protectedSkip?.has?.(sub.requestId);
}

// Only the contract's fields, so nothing else a lookup recorded reaches the page.
function optionsOf(lookup) {
  return (Array.isArray(lookup?.options) ? lookup.options : []).slice(0, 10).map((option) => ({
    candidateUserId: clean(option?.candidateUserId),
    name: clean(option?.name) || null,
    linkedinUser: clean(option?.linkedinUser) || null,
    roleOnRecord: option?.roleOnRecord === true,
    roleRecent: option?.roleRecent === true,
    roleAt: clean(option?.roleAt) || null,
    // false when the lookup never read this person's applications (too many
    // namesakes, an unfinished search): the page says "role not checked",
    // not "not on this role" (2026-11-06 review).
    checked: option?.checked !== false,
    // v4 (2026-11-07): the employers on this person's record that the note's
    // background names, so staff see who worked where. Only when there are any.
    ...(Array.isArray(option?.backgroundHits) && option.backgroundHits.length
      ? { backgroundHits: option.backgroundHits.map((name) => clean(name)).filter(Boolean).slice(0, 5) }
      : {}),
  })).filter((option) => option.candidateUserId);
}

function pickOf(pick) {
  if (!pick) return null;
  return {
    action: pick.action,
    candidateUserId: clean(pick.candidateUserId) || null,
    name: clean(pick.name) || null,
    linkedinUser: clean(pick.linkedinUser) || null,
    pickedBy: clean(pick.pickedBy) || null,
    pickedAt: clean(pick.pickedAt) || null,
  };
}

// Picks for notes no longer stored, or received more than two windows ago
// (the same rule that prunes lookups), go.
export function staleProtectedPicks({ picks = {}, subs, now = Date.now(), windowMs = REQUEST_LIFETIME_MS } = {}) {
  return Object.keys(picks || {}).filter((requestId) => {
    const sub = subs?.get?.(requestId);
    const receivedMs = Date.parse(clean(sub?.receivedAt));
    return !sub || !Number.isFinite(receivedMs) || receivedMs < now - 2 * windowMs;
  });
}

// The page's list: every note in the lane that nobody was emailed about and
// the lookup did not resolve, plus every note picked in the last week (with
// whether it went out). Pure: the caller reads the stores.
export function heldProtectedSubs({ subs = [], lookups = {}, picks = {}, states = [], config = {}, now = Date.now() } = {}) {
  const deliveries = protectedDeliveries(states);
  const items = [];
  let handledAutomatically = 0;
  for (const sub of subs || []) {
    if (!clean(sub?.requestId)) continue;
    const lookup = lookups[sub.requestId] || null;
    const pick = picks[sub.requestId] || null;
    const delivery = deliveries.get(sub.requestId) || null;
    const pickedMs = Date.parse(clean(pick?.pickedAt));
    const recentPick = pick && Number.isFinite(pickedMs) && pickedMs >= now - PICK_SHOWN_MS;
    const inLane = noteInLane(sub, config, now);
    if (inLane && !pick && (delivery || lookup?.status === "resolved")) {
      handledAutomatically += 1;
      continue;
    }
    if (!recentPick && !(inLane && !pick)) continue;
    const receivedMs = Date.parse(clean(sub.receivedAt));
    items.push({
      requestId: sub.requestId,
      candidateName: clean(sub.candidateName) || null,
      companyName: clean(lookup?.companyName) || clean(sub.companyName) || null,
      roleName: clean(lookup?.roleName) || null,
      receivedAt: clean(sub.receivedAt) || null,
      expiresAt: Number.isFinite(receivedMs) ? new Date(receivedMs + REQUEST_LIFETIME_MS).toISOString() : null,
      submitUrl: clean(sub.submitUrl) || null,
      status: lookup?.status || null,
      reason: lookupReason(lookup),
      // No lookup yet, a pacing wait, or a record from an older lookup (before
      // options were kept): the page says "still looking", not "nobody found".
      lookupPending: !lookup || lookup.status === "throttled"
        || Number(lookup.version || 1) < PROTECTED_LOOKUP_VERSION,
      nameForm: lookup?.nameForm || null,
      options: optionsOf(lookup),
      pick: pickOf(pick),
      delivery,
      // Why a send pick will not go out, so the page never says "sends
      // within about 5 minutes" for one a guard drops (2026-11-06 review).
      pickBlocked: pick?.action === "send" && !delivery
        ? (inLane ? protectedPickBlocked({ sub, lookup, pick, states }) : "the note is past the send window or on the do-not-send list")
        : null,
    });
  }
  // Notes waiting on a person first, oldest (closest to expiring) first; then
  // the picked ones, newest pick first.
  items.sort((a, b) => (
    Number(Boolean(a.pick)) - Number(Boolean(b.pick))
    || (a.pick
      ? Date.parse(b.pick.pickedAt || 0) - Date.parse(a.pick.pickedAt || 0)
      : Date.parse(a.receivedAt || 0) - Date.parse(b.receivedAt || 0))
  ));
  return {
    handledAutomatically,
    needYou: items.filter((item) => !item.pick && !item.delivery).length,
    items,
  };
}

export async function listHeldProtectedSubs({ config, now = Date.now(), store = {} } = {}) {
  const s = { ...defaultStore, ...store };
  const laneOn = sendCutoff(config) != null;
  if (!laneOn) return { laneOn, handledAutomatically: 0, needYou: 0, items: [] };
  const [subs, lookups, picks, states] = await Promise.all([s.listSubs(), s.getLookups(), s.getPicks(), s.listStates()]);
  return { laneOn, generatedAt: new Date(now).toISOString(), ...heldProtectedSubs({ subs, lookups, picks, states, config, now }) };
}

const refuse = (status, error, detail) => ({ status, body: { ok: false, error, ...(detail ? { detail } : {}) } });

// Shared checks for both actions: a person, the exact confirmation, a known
// note still in the lane, nobody emailed about it yet.
async function loadNote({ actor, requestId, confirmation, expected, config, now, s }) {
  if (!actor) return { refusal: refuse(403, "staff_sign_in_required", "a pick needs a signed-in staff Google account, not a runner key") };
  if (!requestId) return { refusal: refuse(400, "requestId_required") };
  if (confirmation !== expected) return { refusal: refuse(400, "confirmation_required") };
  if (sendCutoff(config) == null) return { refusal: refuse(503, "protected_subs_off") };
  const [subs, lookups, picks, states] = await Promise.all([s.listSubs(), s.getLookups(), s.getPicks(), s.listStates()]);
  const sub = (subs || []).find((row) => row?.requestId === requestId);
  if (!sub) return { refusal: refuse(404, "protected_sub_not_found") };
  if (config.protectedSkip?.has?.(requestId)) return { refusal: refuse(409, "protected_sub_on_skip_list") };
  if (!noteInLane(sub, config, now)) return { refusal: refuse(409, "protected_sub_outside_window") };
  if (protectedDeliveries(states).has(requestId)) return { refusal: refuse(409, "protected_sub_already_emailed") };
  return { sub, lookup: lookups[requestId] || null, pick: picks[requestId] || null, states };
}

// "Send to this person": body { requestId, candidateUserId, confirmation: "SEND <requestId>" }.
export async function pickProtectedSub({ actor, body = {}, config, now = Date.now(), store = {} } = {}) {
  const s = { ...defaultStore, ...store };
  const requestId = clean(body.requestId);
  const candidateUserId = clean(body.candidateUserId);
  const note = await loadNote({ actor, requestId, confirmation: body.confirmation, expected: `SEND ${requestId}`, config, now, s });
  if (note.refusal) return note.refusal;
  const { lookup, pick } = note;
  if (pick?.action === "send") return refuse(409, "protected_sub_already_picked");
  // A pick never overrides an automatic match, even one to the same person
  // (that note is already on its way).
  if (lookup?.status === "resolved") {
    return refuse(409, clean(lookup.candidateUserId) === candidateUserId
      ? "protected_sub_resolved_automatically"
      : "protected_sub_resolved_elsewhere");
  }
  // A role on hold, paused or closed no longer refuses a pick (v4,
  // 2026-11-07, David's rule 3: those notes still get the email).
  if (!candidateUserId) return refuse(400, "candidateUserId_required");
  const option = optionsOf(lookup).find((row) => row.candidateUserId === candidateUserId);
  if (!option) return refuse(409, "candidate_not_an_option");
  if (!clean(lookup?.roleName) || !clean(lookup?.companyName)) return refuse(409, "role_unreadable");
  // The states list is capped, so the picked person's own state is read too,
  // and so is the person of the send pick a skip replaced (2026-11-06 review).
  for (const id of new Set([candidateUserId, clean(pick?.replaced?.candidateUserId)].filter(Boolean))) {
    const own = await s.getState(id).catch(() => null);
    if (own && protectedDeliveries([own]).has(requestId)) return refuse(409, "protected_sub_already_emailed");
  }
  const record = {
    requestId,
    action: "send",
    candidateUserId,
    name: option.name,
    linkedinUser: option.linkedinUser,
    pickedBy: actor,
    pickedAt: new Date(now).toISOString(),
    ...(pick ? { replaced: pickOf(pick) } : {}),
  };
  // Only the first of two people picking at once wins: over no pick by
  // HSETNX, over a "skip" only while that skip is still the stored pick.
  const written = await s.savePick(record, pick ? { expected: pick } : { onlyIfAbsent: true });
  if (!written) return refuse(409, "protected_sub_already_picked");
  return {
    status: 200,
    body: {
      ok: true,
      action: "pick-protected-sub",
      requestId,
      pick: pickOf(record),
      next: PICK_QUEUED_MESSAGE,
    },
  };
}

// "Skip this note": body { requestId, confirmation: "SKIP <requestId>" }.
// Stopping is always allowed until the email goes, so it also replaces a
// "send" pick the tick has not acted on yet.
export async function skipProtectedSub({ actor, body = {}, config, now = Date.now(), store = {} } = {}) {
  const s = { ...defaultStore, ...store };
  const requestId = clean(body.requestId);
  const note = await loadNote({ actor, requestId, confirmation: body.confirmation, expected: `SKIP ${requestId}`, config, now, s });
  if (note.refusal) return note.refusal;
  const { pick, lookup } = note;
  if (pick?.action === "skip") return refuse(409, "protected_sub_already_skipped");
  // The picked person, or the automatically matched one: the person a row
  // for this note would email.
  const resolvedId = lookup?.status === "resolved" ? clean(lookup.candidateUserId) : "";
  const ids = [...new Set([clean(pick?.candidateUserId), resolvedId].filter(Boolean))];
  // The skip holds the send path's own candidate lock while it checks their
  // state and saves, so it never lands between the send's last pick read and
  // its claim (2026-11-06 second review: the skip was answered "will not be
  // emailed" while the claim it raced went on to send). A send that holds the
  // lock now finishes first; the skip is refused, to be tried again.
  const held = [];
  try {
    for (const id of ids) {
      const token = await s.lock(id).catch(() => null);
      if (!token) return refuse(409, "protected_sub_busy", "a send for this person is running right now; try the skip again in a minute");
      held.push([id, token]);
    }
    return await saveSkip({ s, actor, requestId, pick, ids, now });
  } finally {
    for (const [id, token] of held) await s.unlock(id, token).catch(() => {});
  }
}

async function saveSkip({ s, actor, requestId, pick, ids, now }) {
  for (const id of ids) {
    const own = await s.getState(id).catch(() => null);
    if (own && protectedDeliveries([own]).has(requestId)) return refuse(409, "protected_sub_already_emailed");
  }
  const record = {
    requestId,
    action: "skip",
    candidateUserId: null,
    name: null,
    linkedinUser: null,
    pickedBy: actor,
    pickedAt: new Date(now).toISOString(),
    ...(pick ? { replaced: pickOf(pick) } : {}),
  };
  const written = await s.savePick(record, pick ? { expected: pick } : { onlyIfAbsent: true });
  if (!written) return refuse(409, "protected_sub_already_picked");
  return {
    status: 200,
    body: {
      ok: true,
      action: "skip-protected-sub",
      requestId,
      pick: pickOf(record),
      // The send path reads the pick again just before it claims the email,
      // under the candidate lock this skip held, so a skip saved here stops
      // any send that has not claimed yet.
      next: "skipped: this note will not be emailed",
    },
  };
}
