// ─────────────────────────────────────────────────────────────────────────────
// BOOKING STOP — pause a sequence lead the moment the candidate books a call.
//
// WHY THIS EXISTS (2026-07-26 incident):
// Paraform's only native sequence stop is REPLY. Booking is not a stop condition
// and there is no setting to make it one — proven on a 211-lead sequence where
// the ONLY pause reason present was "REPLIED" (46/46). Meanwhile step 1 of every
// role sequence offers two booking links: the Paraform scheduler (which sets
// relationship_status = SCHEDULED_CALL) and a Calendly link for the human call
// (which writes NOTHING back to Paraform). A candidate who books via Calendly and
// doesn't reply is, to Paraform, indistinguishable from someone ignoring us — so
// the next "still on the job market?" nudge goes out on schedule.
//
// Both links are load-bearing and both stay: Paraform's scheduler supports only
// one calendar link per account and Raydar offers two call types. So an EXTERNAL
// control is mandatory and permanent. This module is that control.
//
// It replaces n8n workflow Ha2brYZURrfNjVNU, which was the only prior mechanism
// and which failed for nine consecutive days (60s task-runner timeout) with no
// alerting of any kind. Its defects are the design constraints here:
//   - it read ONE page of getCampaignLeads (50 of 211) -> 78% of active leads
//     were structurally invisible even on a green run. We paginate, always.
//   - it fanned out 161 Calendly invitee calls SERIALLY (124.8s, 2x its budget).
//     We cache invitees in KV and fetch with bounded concurrency.
//   - it had no Slack node and no errorWorkflow, so nine days of failure were
//     silent. We alert on staleness, on a zero-lead pass, and on pause errors.
//   - a "green" run returning activeLeads:0 looked like success (07-10, 07-11).
//     A zero-lead pass is treated as FAILURE here, not a clean run.
//
// SAFETY: this module can only ever STOP mail. It pauses; it never unpauses,
// never removes a lead, never enrolls, never sends. A false positive costs one
// reversible pause (two clicks in the Paraform UI); a false negative emails a
// candidate who already booked. That asymmetry is why this ships enforcing.
// ─────────────────────────────────────────────────────────────────────────────

import { trpcGet, trpcPost, campaignLeads, BOOKED_STATUSES, sleep } from "./core.mjs";

// ---------- which sequences are "please book a call" nudges ----------
// Substring keys, matched with .includes() so every launcher-created
// "... - <Role>" variant, the renamed OLD bucket, and future roles are covered
// with zero config (the same matching the n8n guardian used, extended).
//
// Deliberately NOT covered: client/role-specific sourcing outreach ("Firecrawl -
// In-House Counsel") and the Para AI match-notification sequences. Those are a
// different message with a different intent; pausing them on an intro-call
// booking would stop legitimate work. Widening is an env change, not a code one.
export const DEFAULT_SEQ_KEYS = [
  "No Scheduled Call - Raydar - 1st Round Interview", // + every "- <Role>" variant, base, and "OLD ..."
  "Audio Failed - Agent Call", // lifecycle followup
  "No Show - Agent Call", // lifecycle followup
  "Reschedule Human Call",
  "Reschedule Agent Call",
  "Human Call Follow Up - Curated List", // (1) and (2+)
  "Agent Call Follow Up - Curated List", // (1) and (2+)
];

export function seqKeys() {
  const raw = process.env.BOOKING_STOP_SEQ_KEYS;
  if (!raw) return DEFAULT_SEQ_KEYS;
  return raw.split("|").map((s) => s.trim()).filter(Boolean);
}

export function isNudgeSequence(seq, keys = seqKeys()) {
  const name = String(seq?.name || "");
  return keys.some((k) => name.includes(k));
}

// ---------- tiny KV (Upstash REST), namespace seqguard:* ----------
// Single-writer rule: only the sweep and the webhook write these keys, and they
// write disjoint kinds. Nothing else in the repo touches seqguard:*.
const KV_URL = String(process.env.KV_REST_API_URL || "").replace(/\/+$/, "");
const KV_TOKEN = process.env.KV_REST_API_TOKEN || "";
export const kvConfigured = () => Boolean(KV_URL && KV_TOKEN);

async function kv(command, { throwOnTransport = false } = {}) {
  if (!kvConfigured()) return null;
  try {
    const r = await fetch(KV_URL, {
      method: "POST",
      headers: { authorization: `Bearer ${KV_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify(command),
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) throw new Error(`kv ${r.status}`);
    const b = await r.json().catch(() => null);
    return b?.result ?? null;
  } catch (e) {
    // Callers that use KV for correctness (dedup claims) must be able to tell a
    // genuine "already claimed" from a transport failure — collapsing the two
    // would make a KV blip silently skip a pause, which is the exact class of
    // silent failure this whole module exists to eliminate.
    if (throwOnTransport) { const err = new Error("KV_UNAVAILABLE"); err.code = "KV_UNAVAILABLE"; throw err; }
    return null;
  }
}

export const kvGet = async (key) => {
  const raw = await kv(["GET", key]);
  if (raw == null) return null;
  try { return JSON.parse(raw); } catch { return raw; }
};
export const kvSet = (key, value, ttlSeconds) =>
  kv(ttlSeconds ? ["SET", key, JSON.stringify(value), "EX", String(ttlSeconds)] : ["SET", key, JSON.stringify(value)]);
/** Returns "OK" when the claim was won, null when it was already held, and
 *  THROWS KV_UNAVAILABLE if the store could not be reached. */
export const kvSetNx = (key, value, ttlSeconds) =>
  kv(["SET", key, JSON.stringify(value), "EX", String(ttlSeconds), "NX"], { throwOnTransport: true });

export const K = {
  lastSweep: "seqguard:lastsweep",
  leadIndex: "seqguard:leadindex",
  deferred: (email) => `seqguard:deferred:${hash(email)}`,
  event: (uri) => `seqguard:event:${hash(uri)}`,
  paused: (ccuId) => `seqguard:paused:${ccuId}`,
  cancel: (uri) => `seqguard:cancel:${hash(uri)}`,
  invitees: (uri) => `seqguard:inv:${hash(uri)}`,
  profile: (cuId) => `seqguard:prof:${cuId}`,
  alert: (key) => `seqguard:alert:${key}`,
};

function hash(value) {
  // Short stable key fragment; avoids putting raw URIs (and therefore ids) in key
  // names of unbounded length. Not a security boundary.
  let h = 5381;
  const s = String(value);
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36) + "-" + s.length;
}

/** Alert at most once per `key` per `windowSeconds`. Returns true if the caller should alert. */
export async function shouldAlert(key, windowSeconds = 12 * 3600) {
  if (!kvConfigured()) return true; // no store -> never suppress a real alert
  try {
    const ok = await kvSetNx(K.alert(key), { at: new Date().toISOString() }, windowSeconds);
    return ok === "OK" || ok === true;
  } catch {
    return true; // store unreachable -> alert rather than go quiet
  }
}

// ---------- Calendly ----------
const CAL_BASE = "https://api.calendly.com";
const calToken = () =>
  process.env.CALENDLY_API_TOKEN || process.env.CALENDLY_TOKEN || process.env.CALENDLY_API || "";
export const calendlyConfigured = () => Boolean(calToken());

/** Calendly rate-limits with 429 + Retry-After. Honour it rather than burning
 *  retries — a wide backfill window fans out hundreds of invitee reads. */
export async function calendlyGet(pathOrUrl, tries = 6) {
  const url = pathOrUrl.startsWith("http") ? pathOrUrl : `${CAL_BASE}${pathOrUrl}`;
  for (let a = 0; a < tries; a++) {
    try {
      const r = await fetch(url, {
        headers: { authorization: `Bearer ${calToken()}` },
        signal: AbortSignal.timeout(20000),
      });
      if (r.status === 401 || r.status === 403) {
        const e = new Error("CALENDLY_AUTH");
        e.code = "CALENDLY_AUTH";
        throw e;
      }
      if (r.status === 429) {
        if (a === tries - 1) { const e = new Error("CALENDLY_RATE_LIMIT"); e.code = "CALENDLY_RATE_LIMIT"; throw e; }
        const retryAfter = Number(r.headers.get("retry-after"));
        const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
          ? Math.min(retryAfter * 1000, 30000)
          : Math.min(1000 * 2 ** a, 16000);
        await sleep(waitMs + Math.floor(Math.random() * 500));
        continue;
      }
      if (!r.ok) throw new Error(`calendly ${r.status}`);
      return await r.json();
    } catch (e) {
      if (e.code === "CALENDLY_AUTH" || e.code === "CALENDLY_RATE_LIMIT" || a === tries - 1) throw e;
      await sleep(500 * (a + 1));
    }
  }
}

export const normEmail = (v) => String(v || "").trim().toLowerCase();

/**
 * email -> { bookedAt(ms), startsAt(ISO|null), eventName, status } for the LATEST booking.
 *
 * NOTE ON WINDOW SEMANTICS: Calendly's min_start_time/max_start_time filter on the
 * EVENT START, not on when the booking was made. The prior implementation used
 * min_start_time = now-3d as a proxy for "booked recently", which silently dropped
 * any call that had already happened more than 3 days ago — so a lead missed once
 * could become permanently invisible. We use a small backward window (recently
 * completed calls still justify a pause) and a LARGE forward window.
 */
export async function calendlyBookingIndex({
  backDays = 2,
  forwardDays = 120,
  // Calendly 429s on burst; 4 keeps a cold (uncached) wide window inside limits.
  concurrency = 4,
  useCache = true,
  now = Date.now(),
} = {}) {
  const me = await calendlyGet("/users/me");
  const org = me?.resource?.current_organization;
  if (!org) throw new Error("calendly: no organization on token");

  const minStart = new Date(now - backDays * 864e5).toISOString();
  const maxStart = new Date(now + forwardDays * 864e5).toISOString();

  const events = [];
  let truncated = false;
  for (const status of ["active", "canceled"]) {
    const qs = new URLSearchParams({
      organization: org,
      count: "100",
      status,
      sort: "start_time:asc",
      min_start_time: minStart,
      max_start_time: maxStart,
    });
    let next = `${CAL_BASE}/scheduled_events?${qs}`;
    // Bounded high, and if we ever hit it we SAY so — a silent cap reads as
    // "covered everything" when it didn't.
    for (let page = 0; next && page < 100; page++) {
      const d = await calendlyGet(next);
      events.push(...(d?.collection || []));
      next = d?.pagination?.next_page || null;
      if (next && page === 99) truncated = true;
    }
  }

  const index = new Map();
  let cacheHits = 0;
  let i = 0;
  const worker = async () => {
    while (i < events.length) {
      const ev = events[i++];
      let invitees = null;
      if (useCache) {
        const cached = await kvGet(K.invitees(ev.uri));
        // Cache is keyed by event uri + updated_at so a reschedule busts it.
        if (cached && cached.updatedAt === ev.updated_at) {
          invitees = cached.invitees;
          cacheHits++;
        }
      }
      if (!invitees) {
        invitees = [];
        let next = `${ev.uri}/invitees?count=100`;
        for (let p = 0; next && p < 20; p++) {
          const d = await calendlyGet(next);
          invitees.push(
            ...(d?.collection || []).map((v) => ({
              email: normEmail(v.email),
              created_at: v.created_at,
              status: v.status,
            }))
          );
          next = d?.pagination?.next_page || null;
        }
        if (useCache) await kvSet(K.invitees(ev.uri), { updatedAt: ev.updated_at, invitees }, 30 * 24 * 3600);
      }
      for (const v of invitees) {
        if (!v.email) continue;
        const at = Date.parse(v.created_at);
        if (!Number.isFinite(at)) continue;
        const prev = index.get(v.email);
        if (!prev || at > prev.bookedAt) {
          index.set(v.email, {
            bookedAt: at,
            startsAt: ev.start_time || null,
            eventName: ev.event_type_name || ev.name || null,
            status: ev.status,
          });
        }
      }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));

  return { index, events: events.length, cacheHits, truncated, org };
}

// ---------- Paraform relationship status, cached ----------
// PARAFORM RETURNS 401 AS A RATE LIMIT. Measured 2026-07-26: 40 concurrent
// getCandidateProfileInfo reads on a healthy session -> 27x200 / 13x401, while
// the same reads issued serially are 100% clean. core.mjs's trpcGet maps any 401
// to AUTH_EXPIRED and throws WITHOUT retrying, so under burst a throttle is
// indistinguishable from a dead cookie. In the first containment dry run that
// silently failed 780 of 945 profile reads — every one of which would have been
// scored as "not booked".
//
// So: retry a 401 with backoff, and only believe it is a real expiry after the
// retries are exhausted. isSessionActuallyExpired() then confirms serially before
// anyone shouts about the cookie.
const AUTH_RETRY_DELAYS_MS = [600, 1800, 4500];

/**
 * Run a Paraform call, treating 401 as a THROTTLE until proven otherwise.
 * Used on both reads and writes: the write path is where a misread 401 is most
 * dangerous, because it aborts a partially-applied batch (learned the hard way —
 * the first containment apply run died mid-batch on exactly this).
 */
export async function withThrottleRetry(fn, { onThrottle = null } = {}) {
  for (let attempt = 0; ; attempt++) {
    try { return await fn(); }
    catch (e) {
      if (e?.code !== "AUTH_EXPIRED" || attempt >= AUTH_RETRY_DELAYS_MS.length) throw e;
      if (onThrottle) onThrottle();
      await sleep(AUTH_RETRY_DELAYS_MS[attempt] + Math.floor(Math.random() * 400));
    }
  }
}

export async function isSessionActuallyExpired({ probes = 3 } = {}) {
  // A cheap read, retried with growing backoff. One probe is NOT enough: it is
  // issued while sibling workers still have requests in flight, so it competes
  // in the very burst it is trying to rule out — that produced a false
  // "expired" verdict against a session /api/seq/health showed as live. Only a
  // session that refuses several spaced-out probes is really gone.
  for (let i = 0; i < probes; i++) {
    try {
      await trpcGet("campaigns.getListOfCampaignsOptimized", {}, 1);
      return false;
    } catch (e) {
      if (e?.code !== "AUTH_EXPIRED") return false; // a different fault is not an expiry
      await sleep(1500 * (i + 1) + Math.floor(Math.random() * 600));
    }
  }
  return true;
}

export async function cachedRelationshipStatus(cuId, { ttlSeconds = 6 * 3600, force = false, onThrottle = null } = {}) {
  if (!force) {
    const cached = await kvGet(K.profile(cuId));
    if (cached) return cached;
  }
  let p = null;
  for (let attempt = 0; ; attempt++) {
    try { p = await trpcGet("candidateUser.getCandidateProfileInfo", { candidateUserId: cuId }, 1); break; }
    catch (e) {
      if (e?.code !== "AUTH_EXPIRED" || attempt >= AUTH_RETRY_DELAYS_MS.length) throw e;
      if (onThrottle) onThrottle();
      // Jitter so a fleet of workers does not retry in lockstep.
      await sleep(AUTH_RETRY_DELAYS_MS[attempt] + Math.floor(Math.random() * 400));
    }
  }
  if (!p) return null;
  const value = {
    status: p.candidate_user_relationship_status || null,
    at: p.candidate_user_relationship_status_updated_at || null,
    emails: Array.isArray(p.emails) ? p.emails.map(normEmail).filter(Boolean) : [],
  };
  await kvSet(K.profile(cuId), value, ttlSeconds);
  return value;
}

/** Every address we know for a lead. The n8n version matched to_use_email ONLY,
 *  which cannot see the candidates who book with a different address. */
export function leadAddresses(lead, profile) {
  const set = new Set();
  const add = (v) => { const e = normEmail(v); if (e) set.add(e); };
  add(lead?.to_use_email);
  for (const e of lead?.user_emails || []) add(e);
  for (const e of profile?.emails || []) add(e);
  return set;
}

// ---------- complete membership read ----------
// getCampaignLeads paginates with a numeric OFFSET over an ordering that is not
// injective, so a naive walk in page-size steps returns duplicates on some pages
// and SKIPS rows on others. Measured 2026-07-26 on a 211-lead sequence: stepping
// by 50 yields 211 rows but only 193 distinct — 18 leads unreachable. Stepping by
// 25/10/7 recovers 210. Larger sequences are worse (534-lead: stride 50 -> 491).
//
// This is a different bug from the one that caused the incident (that one never
// paginated at all) and it defeats a correct-looking paginated read, so it gets
// its own reader. Overlapping windows + dedupe + an explicit completeness verdict:
// a short read is REPORTED, never silently accepted as "everyone".
const STRIDES = [25, 10, 7];

export async function completeCampaignLeads(campaignId, { strides = STRIDES } = {}) {
  const byCcu = new Map();
  let totalCount = null;
  let apiCalls = 0;
  let strideUsed = null;

  for (const stride of strides) {
    strideUsed = stride;
    let cursor = 0;
    let barren = 0;
    for (let i = 0; i < 2000; i++) {
      const page = await withThrottleRetry(() =>
        trpcGet("campaigns.getCampaignLeads", cursor ? { campaign_id: campaignId, cursor } : { campaign_id: campaignId }, 1));
      apiCalls++;
      const leads = page?.leads || [];
      if (totalCount === null) totalCount = page?.totalCount ?? leads.length;
      const before = byCcu.size;
      for (const l of leads) if (l?.ccu_id && !byCcu.has(l.ccu_id)) byCcu.set(l.ccu_id, l);
      if (!leads.length) break;
      barren = byCcu.size === before ? barren + 1 : 0;
      if (byCcu.size >= totalCount) break;
      // Walk a little past totalCount: the straddling rows live near the seams.
      if (cursor > totalCount + stride * 4) break;
      if (barren >= 6) break;
      cursor += stride;
    }
    if (totalCount !== null && byCcu.size >= totalCount) break;
  }

  const leads = [...byCcu.values()];
  const shortfall = Math.max(0, (totalCount ?? leads.length) - leads.length);
  // Tolerate a hair of drift (totalCount can include a row that no longer
  // resolves) but treat anything more as an incomplete read.
  const tolerance = Math.max(1, Math.floor((totalCount ?? 0) * 0.01));
  return {
    leads,
    totalCount: totalCount ?? leads.length,
    unique: leads.length,
    shortfall,
    complete: shortfall <= tolerance,
    strideUsed,
    apiCalls,
  };
}

// ---------- decision ----------
/**
 * NEW-BOOKINGS-ONLY RULE (preserved from the original guardian, and load-bearing):
 * a lead is only paused when the booking timestamp is LATER than that lead's
 * enrollment. Everyone in this population booked once before their failed call,
 * so a pre-existing booking must never be read as "they just booked" — and
 * someone deliberately re-engaged after an old call should keep receiving mail.
 */
export function decideLead({ lead, seq, booking, relStatus, now = Date.now() }) {
  if (!lead?.ccu_id) return null;
  if (lead.is_paused || lead.is_archived) return null;
  const enrolledAt = Date.parse(lead.created_at);
  if (!Number.isFinite(enrolledAt)) return null;

  if (booking && booking.bookedAt > enrolledAt) {
    return {
      ccuId: lead.ccu_id,
      cuId: lead.cu_id,
      name: lead.name || null,
      email: normEmail(lead.to_use_email),
      sequenceId: seq.id,
      sequence: seq.name,
      enrolledAt: new Date(enrolledAt).toISOString(),
      bookedAt: new Date(booking.bookedAt).toISOString(),
      startsAt: booking.startsAt,
      source: "calendly",
      evidence: `calendly ${booking.eventName || "event"} booked ${new Date(booking.bookedAt).toISOString()} > enrolled ${new Date(enrolledAt).toISOString()}`,
    };
  }

  if (relStatus?.status && BOOKED_STATUSES.has(relStatus.status)) {
    const at = Date.parse(relStatus.at);
    if (Number.isFinite(at) && at > enrolledAt) {
      return {
        ccuId: lead.ccu_id,
        cuId: lead.cu_id,
        name: lead.name || null,
        email: normEmail(lead.to_use_email),
        sequenceId: seq.id,
        sequence: seq.name,
        enrolledAt: new Date(enrolledAt).toISOString(),
        bookedAt: new Date(at).toISOString(),
        startsAt: null,
        source: "paraform_status",
        evidence: `paraform ${relStatus.status} at ${new Date(at).toISOString()} > enrolled ${new Date(enrolledAt).toISOString()}`,
      };
    }
  }
  return null;
}

// ---------- pause (the only mutation in this module) ----------
/**
 * Pause a batch and READ BACK. A 200 response is never treated as proof —
 * the original guardian's own comment noted pauseErrors existed so "paused: 0"
 * could not masquerade as success, and that instinct is right.
 *
 * Readback is batched PER SEQUENCE, not per lead: verifying 150 pauses one at a
 * time would re-read a 211-lead membership 150 times (~750 page requests) and
 * reintroduce exactly the runtime blowup that killed the predecessor.
 */
export async function applyDecisions(decisions, { concurrency = 3 } = {}) {
  const out = { paused: 0, pauseErrors: [], throttled: 0 };
  if (!decisions.length) return out;

  const attempted = [];
  let i = 0;
  const worker = async () => {
    while (i < decisions.length) {
      const d = decisions[i++];
      try {
        await withThrottleRetry(
          () => trpcPost("campaigns.updateCandidatePauseStatus", { campaign_to_candidate_user_id: d.ccuId, is_paused: true }, 1),
          { onThrottle: () => { out.throttled++; } }
        );
        attempted.push(d);
      } catch (e) {
        if (e.code === "AUTH_EXPIRED") {
          // Confirm serially before believing it. A real expiry aborts the batch
          // loudly; a throttle must only cost this one lead, which the next
          // sweep retries.
          if (await isSessionActuallyExpired()) throw e;
          out.pauseErrors.push({ sequence: d.sequence, reason: "throttled_after_retries" });
          continue;
        }
        out.pauseErrors.push({ sequence: d.sequence, reason: String(e.message || e).slice(0, 120) });
      }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));

  // One authoritative membership read per touched sequence.
  const bySeq = new Map();
  for (const d of attempted) {
    if (!bySeq.has(d.sequenceId)) bySeq.set(d.sequenceId, []);
    bySeq.get(d.sequenceId).push(d);
  }
  for (const [sequenceId, group] of bySeq) {
    const leads = await completeCampaignLeads(sequenceId).then((r) => r.leads).catch(() => null);
    if (!leads) {
      for (const d of group) out.pauseErrors.push({ sequence: d.sequence, reason: "readback_unavailable" });
      continue;
    }
    const byCcu = new Map(leads.map((l) => [l.ccu_id, l]));
    for (const d of group) {
      const row = byCcu.get(d.ccuId);
      if (!row) { out.pauseErrors.push({ sequence: d.sequence, reason: "lead_missing_after_pause" }); continue; }
      if (!row.is_paused) { out.pauseErrors.push({ sequence: d.sequence, reason: "still_active_after_pause" }); continue; }
      out.paused++;
      await kvSet(K.paused(d.ccuId), {
        at: new Date().toISOString(),
        sequence: d.sequence,
        source: d.source,
        evidence: d.evidence,
      });
    }
  }
  return out;
}

// ---------- the sweep ----------
export async function loadNudgeSequences() {
  const all = (await withThrottleRetry(() => trpcGet("campaigns.getListOfCampaignsOptimized", {}, 1))) || [];
  return all.filter((s) => isNudgeSequence(s));
}

/**
 * Full reconciliation pass. This is the BACKSTOP, not the primary path — the
 * webhook is. It exists because webhook deliveries can be dropped and because
 * email-only matching cannot see candidates who booked with a different address.
 */
export async function runBookingSweep({
  apply = true,
  now = Date.now(),
  profileBudget = Number(process.env.BOOKING_STOP_PROFILE_BUDGET || 400),
  concurrency = 8,
  // Paraform 401s under burst (see cachedRelationshipStatus). 4 is the measured
  // comfortable ceiling for this proc; do not raise it without re-measuring.
  profileConcurrency = Number(process.env.BOOKING_STOP_PROFILE_CONCURRENCY || 4),
  calendlyBackDays = Number(process.env.BOOKING_STOP_BACK_DAYS || 7),
  onDecision = null,
} = {}) {
  const startedAt = Date.now();
  const result = {
    ok: false,
    apply,
    sequences: 0,
    activeLeads: 0,
    calendlyEvents: 0,
    calendlyCacheHits: 0,
    calendlyTruncated: false,
    profilesAttempted: 0,
    profilesRead: 0,
    profileFailures: 0,
    profileErrorSample: null,
    indexedEmails: 0,
    throttled: 0,
    throttleGaveUp: 0,
    incompleteReads: [],
    membershipApiCalls: 0,
    decisions: [],
    paused: 0,
    pauseErrors: [],
    durationMs: 0,
  };

  const cal = await calendlyBookingIndex({ now, backDays: calendlyBackDays });
  result.calendlyEvents = cal.events;
  result.calendlyCacheHits = cal.cacheHits;
  result.calendlyTruncated = cal.truncated;

  const seqs = await loadNudgeSequences();
  result.sequences = seqs.length;

  // strict:true so an incomplete membership read THROWS rather than silently
  // reconciling as "everyone left" — the failure mode that makes a broken sweep
  // look like a clean one.
  // Overlapping-window reads are ~8 calls per sequence; serially that is minutes.
  // Bounded concurrency keeps the whole pass inside the function's 300s budget.
  const perSeq = [];
  let m = 0;
  const memWorker = async () => {
    while (m < seqs.length) {
      const seq = seqs[m++];
      const read = await completeCampaignLeads(seq.id);
      if (!read.complete) {
        result.incompleteReads.push({ sequence: seq.name, got: read.unique, expected: read.totalCount, shortfall: read.shortfall });
      }
      result.membershipApiCalls += read.apiCalls;
      perSeq.push({ seq, leads: read.leads });
    }
  };
  await Promise.all(Array.from({ length: 4 }, memWorker));

  const active = [];
  for (const { seq, leads } of perSeq) {
    for (const lead of leads) {
      if (lead.is_paused || lead.is_archived || !lead.ccu_id) continue;
      active.push({ seq, lead });
    }
  }
  result.activeLeads = active.length;

  // LIVENESS ASSERTION: a pass that sees no active leads anywhere is a FAILURE,
  // not a clean run. Two "successful" runs on 2026-07-10/11 returned activeLeads:0
  // because a Paraform API change had silently emptied the membership read.
  if (active.length === 0) {
    result.ok = false;
    result.error = "zero_active_leads";
    result.durationMs = Date.now() - startedAt;
    return result;
  }

  // Pass 1 — Calendly email match. Cheap: no extra API calls at all.
  const matched = new Set();
  for (const { seq, lead } of active) {
    let booking = null;
    for (const e of leadAddresses(lead, null)) {
      const b = cal.index.get(e);
      if (b && (!booking || b.bookedAt > booking.bookedAt)) booking = b;
    }
    const d = decideLead({ lead, seq, booking, relStatus: null, now });
    if (d) { result.decisions.push(d); matched.add(lead.ccu_id); }
  }

  // Pass 2 — Paraform relationship status (and the extra profile addresses that
  // catch candidates who booked from a different mailbox). Cached with a TTL and
  // bounded per run so this can never become the 188s serial leg that killed the
  // n8n version; coverage converges across runs and is reported below.
  const pending = active.filter((a) => !matched.has(a.lead.ccu_id)).slice(0, profileBudget);
  let j = 0;
  const profWorker = async () => {
    while (j < pending.length) {
      const { seq, lead } = pending[j++];
      result.profilesAttempted++;
      let prof = null;
      try {
        prof = await cachedRelationshipStatus(lead.cu_id, { onThrottle: () => { result.throttled++; } });
      } catch (e) {
        if (e.code === "AUTH_EXPIRED") {
          // Only a serially-confirmed 401 is a real expiry; otherwise it is the
          // rate limit wearing an auth costume.
          if (await isSessionActuallyExpired()) throw e;
          result.throttleGaveUp++;
          continue;
        }
        result.profileErrorSample ||= String(e.message || e).slice(0, 200);
      }
      // A profile we could not read is a lead we could not clear. Count it —
      // a silent null here is indistinguishable from "not booked", which is the
      // failure shape this whole module exists to eliminate.
      if (!prof) { result.profileFailures++; continue; }
      result.profilesRead++;
      let booking = null;
      for (const e of leadAddresses(lead, prof)) {
        const b = cal.index.get(e);
        if (b && (!booking || b.bookedAt > booking.bookedAt)) booking = b;
      }
      const d = decideLead({ lead, seq, booking, relStatus: prof, now });
      if (d) result.decisions.push(d);
    }
  };
  await Promise.all(Array.from({ length: profileConcurrency }, profWorker));
  result.profileCoverage = `${pending.length}/${active.length - matched.size}`;

  // Apply
  if (apply && result.decisions.length) {
    const applied = await applyDecisions(result.decisions);
    result.paused = applied.paused;
    result.pauseErrors.push(...applied.pauseErrors);
  }
  if (onDecision) for (const d of result.decisions) await onDecision(d);

  // Publish the index the webhook reads. Only active, unpaused leads: a paused
  // lead needs no second pause, and the webhook must not resurrect stale rows.
  const byEmail = {};
  for (const { seq, lead } of active) {
    for (const addr of leadAddresses(lead, null)) {
      (byEmail[addr] ||= []).push({ s: seq.id, sn: seq.name, ccu: lead.ccu_id, cu: lead.cu_id, n: lead.name || null, t: lead.created_at });
    }
  }
  result.indexedEmails = Object.keys(byEmail).length;
  await kvSet(K.leadIndex, { builtAt: new Date().toISOString(), byEmail }, 6 * 3600);

  result.ok = true;
  result.durationMs = Date.now() - startedAt;
  return result;
}

/**
 * Webhook path: pause every active nudge lead for one email that just booked.
 *
 * This CANNOT walk every sequence's membership inline — measured in production,
 * that is a ~200-call read that blows the function budget and returns 504 to
 * Calendly (which then retries, making it worse). Instead the hourly sweep
 * publishes a lead index and the webhook does ONE KV read against it.
 *
 * On an index miss the work is deferred rather than dropped: the next sweep
 * re-evaluates every lead against Calendly anyway, so the candidate is still
 * caught. A miss only happens for someone enrolled within the last hour, whose
 * next step is days away — so the delay costs nothing, and the deferral is
 * recorded so "we deferred" can never be confused with "there was nothing to do".
 */
export async function pauseForBooking({ email, bookedAt, startsAt = null, eventName = null, apply = true }) {
  const target = normEmail(email);
  const at = typeof bookedAt === "number" ? bookedAt : Date.parse(bookedAt);
  const out = { decisions: [], paused: 0, pauseErrors: [], deferred: false, indexAgeMs: null };
  if (!target || !Number.isFinite(at)) return out;

  const idx = await kvGet(K.leadIndex);
  const builtAt = idx?.builtAt ? Date.parse(idx.builtAt) : null;
  out.indexAgeMs = builtAt ? Date.now() - builtAt : null;
  const usable = idx?.byEmail && builtAt && out.indexAgeMs < LEAD_INDEX_MAX_AGE_MS;

  if (!usable) {
    out.deferred = true;
    await kvSet(K.deferred(target), { at: new Date().toISOString(), bookedAt: new Date(at).toISOString(), reason: idx ? "index_stale" : "index_missing" }, 7 * 24 * 3600);
    return out;
  }

  const entries = idx.byEmail[target] || [];
  const booking = { bookedAt: at, startsAt, eventName, status: "active" };
  for (const e of entries) {
    const d = decideLead({
      lead: { ccu_id: e.ccu, cu_id: e.cu, name: e.n || null, to_use_email: target, created_at: e.t, is_paused: false, is_archived: false },
      seq: { id: e.s, name: e.sn },
      booking,
      relStatus: null,
    });
    if (d) out.decisions.push(d);
  }
  if (apply && out.decisions.length) {
    const applied = await applyDecisions(out.decisions);
    out.paused = applied.paused;
    out.pauseErrors.push(...applied.pauseErrors);
  }
  return out;
}

// ---------- enroll-time gate ----------
/**
 * Calendly-aware replacement for core.mjs `bookedSet()`.
 *
 * The original resolves "is this candidate already booked?" purely from Paraform
 * relationship status, so it cannot see a human call booked through Calendly —
 * the same blind spot that let the nudges go out, one step earlier. Without this
 * the launcher will happily enroll someone who already has a call on the books.
 *
 * FAILS OPEN on the Calendly leg by design: a Calendly outage must not block a
 * whole cohort's enrollment. Anyone who slips through is caught by the sweep
 * within the hour, and the cost of that is one extra email — versus blocking
 * legitimate outreach entirely. The Paraform leg still fails closed as before.
 */
export async function bookedSetWithCalendly(candidateUserIds, { concurrency = 8, now = Date.now() } = {}) {
  const ids = Array.from(new Set((candidateUserIds || []).filter(Boolean)));
  const booked = new Set();
  if (!ids.length) return booked;

  let cal = null;
  if (calendlyConfigured()) {
    // Narrow window: at enroll time we only care whether a call is upcoming or
    // was very recent, and this runs on a user-facing path.
    cal = await calendlyBookingIndex({ backDays: 7, forwardDays: 120, now, concurrency })
      .catch(() => null); // fail open — see doc comment
  }

  let i = 0;
  const worker = async () => {
    while (i < ids.length) {
      const id = ids[i++];
      const prof = await cachedRelationshipStatus(id).catch(() => null);
      if (!prof) continue;
      if (prof.status && BOOKED_STATUSES.has(prof.status)) { booked.add(id); continue; }
      if (!cal) continue;
      for (const e of prof.emails || []) {
        const hit = cal.index.get(e);
        // Only an ACTIVE booking blocks enrollment; a cancelled one means they
        // are back in play and should be re-engaged.
        if (hit && hit.status === "active") { booked.add(id); break; }
      }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  return booked;
}

// ---------- staleness ----------
export const LEAD_INDEX_MAX_AGE_MS = Number(process.env.BOOKING_STOP_INDEX_MAX_AGE_MS || 3 * 3600 * 1000);

export const SWEEP_STALE_AFTER_MS = Number(process.env.BOOKING_STOP_STALE_MS || 3 * 3600 * 1000);

/** The single most important check here: it is what was missing when the n8n
 *  guardian died silently for nine days. */
export async function sweepStaleness(now = Date.now()) {
  const last = await kvGet(K.lastSweep);
  if (!last?.at) return { stale: true, lastAt: null, ageMs: null };
  const ageMs = now - Date.parse(last.at);
  return { stale: ageMs > SWEEP_STALE_AFTER_MS, lastAt: last.at, ageMs, activeLeads: last.activeLeads ?? null };
}

export async function recordSuccessfulSweep(result, now = Date.now()) {
  await kvSet(K.lastSweep, {
    at: new Date(now).toISOString(),
    activeLeads: result.activeLeads,
    paused: result.paused,
    durationMs: result.durationMs,
  });
}
