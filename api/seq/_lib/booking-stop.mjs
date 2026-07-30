// ─────────────────────────────────────────────────────────────────────────────
// BOOKING STOP — pause a sequence lead the moment the candidate books a call.
//
// WHY THIS EXISTS (2026-07-26 incident):
// Paraform's only native sequence stop is REPLY. Booking is not a stop condition
// and there is no setting to make it one — proven on a 211-lead sequence where
// the ONLY pause reason present was "REPLIED" (46/46). Meanwhile step 1 of every
// role sequence historically offered two booking links: Paraform's scheduler
// (which sets relationship_status = SCHEDULED_CALL) and Calendly for the human
// call (which writes NOTHING back to Paraform). A candidate who booked via
// Calendly and did not reply was, to Paraform, indistinguishable from someone
// ignoring us — so the next "still on the job market?" nudge went out on time.
//
// Raydar's first-party scheduler now replaces both candidate-facing links. The
// legacy Paraform/Calendly reads remain active through the measured overlap
// window, while the native HMAC webhook and cursor-complete booking index become
// the permanent control. This module intentionally understands both generations
// so cutover never creates a booking-stop gap.
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

import { createHash, createHmac } from "node:crypto";
import {
  trpcGet, trpcPost, campaignLeads, BOOKED_STATUSES, sleep,
  // These three moved into core.mjs so the launcher's dedup and
  // enrolled-elsewhere scans get the same protection this module needed.
  withThrottleRetry, isSessionActuallyExpired, completeCampaignLeads, campaignLeadBySearch,
} from "./core.mjs";
import {
  fetchRaydarBookingIndex,
  raydarSchedulerBookingStopEnabled,
  raydarSchedulerIndexConfigured,
} from "./raydar-booking-index.mjs";
import {
  hasCandidateSchedulingLink,
} from "./scheduling-links.mjs";
export { withThrottleRetry, isSessionActuallyExpired, completeCampaignLeads };

export const BOOKING_STOP_SCOPE_SCHEMA = "raydar-booking-stop-scope-v2";
export const BOOKING_STOP_LEAD_INDEX_SCHEMA = "raydar-booking-lead-index-v2";
export const BOOKING_STOP_ATTEMPT_SCHEMA = "raydar-booking-stop-attempt-v2";
export const BOOKING_STOP_REVIEWED_CATALOG_FLOOR = 75;

export function bookingStopScopeDigest(entries, {
  catalogFloor = BOOKING_STOP_REVIEWED_CATALOG_FLOOR,
} = {}) {
  const normalized = (entries || [])
    .map((entry) => ({
      id: String(entry?.id || ""),
      enabled: Boolean(entry?.enabled),
      linkBearing: Boolean(entry?.linkBearing),
      nudgeBearing: Boolean(entry?.nudgeBearing),
      selected: Boolean(entry?.selected),
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
  if (
    !normalized.length
    || !Number.isInteger(catalogFloor)
    || catalogFloor < 1
    || normalized.some((entry) => !entry.id)
    || new Set(normalized.map((entry) => entry.id)).size !== normalized.length
  ) {
    return null;
  }
  return createHash("sha256")
    .update(JSON.stringify({
      schema: BOOKING_STOP_SCOPE_SCHEMA,
      catalogFloor,
      entries: normalized,
    }))
    .digest("hex");
}

// ---------- which sequences are "please book a call" nudges ----------
// Substring keys, matched with .includes() so every launcher-created
// "... - <Role>" variant, the renamed OLD bucket, and future roles are covered
// with zero config (the same matching the n8n guardian used, extended).
//
// These stable families remain in scope even when disabled so a controlled,
// no-send canary can prove the pause path. In addition, the sweep discovers
// every sequence containing a candidate-facing scheduling URL. That content
// scope is what covers sourcing/client-role outreach and future copied
// sequences without relying on fragile names.
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

export function campaignHasCandidateSchedulingLink(campaign) {
  if (!Array.isArray(campaign?.steps)) return false;
  return campaign.steps.some((step) =>
    ["subject", "body"].some((field) =>
      hasCandidateSchedulingLink(step?.[field])));
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

function stableJson(value) {
  if (Array.isArray(value)) return value.map(stableJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, stableJson(value[key])]),
  );
}

async function durableKvSetAndReadback(key, value, ttlSeconds) {
  const written = await kvSet(key, value, ttlSeconds);
  if (written !== "OK" && written !== true) {
    const error = new Error("KV_CORRECTNESS_WRITE_FAILED");
    error.code = "KV_CORRECTNESS_WRITE_FAILED";
    throw error;
  }
  const readback = await kvGet(key);
  if (
    JSON.stringify(stableJson(readback))
    !== JSON.stringify(stableJson(value))
  ) {
    const error = new Error("KV_CORRECTNESS_READBACK_FAILED");
    error.code = "KV_CORRECTNESS_READBACK_FAILED";
    throw error;
  }
}

export const K = {
  lastSweep: "seqguard:lastsweep",
  lastAttempt: "seqguard:lastattempt:v2",
  leadIndex: "seqguard:leadindex",
  deferred: (email) => `seqguard:deferred:${hash(email)}`,
  event: (uri) => `seqguard:event:${hash(uri)}`,
  raydarEvent: (eventId) => `seqguard:raydar-event:${secureKeyFragment(eventId)}`,
  raydarCancel: (bookingId) => `seqguard:raydar-cancel:${secureKeyFragment(bookingId)}`,
  raydarWebhookProof: "seqguard:raydar-webhook-proof:v1",
  raydarPauseCanaryProof: "seqguard:raydar-pause-canary-proof:v1",
  paused: (ccuId) => `seqguard:paused:${ccuId}`,
  cancel: (uri) => `seqguard:cancel:${hash(uri)}`,
  invitees: (uri) => `seqguard:inv:${hash(uri)}`,
  // VERSIONED. A TTL is fixed at write time, so shortening it does nothing for
  // entries already written — after the 6h -> 30min change, stale CONTACTED
  // values would have kept masking real bookings for up to six more hours.
  // Bumping the version orphans them instantly. Bump again on any change that
  // alters what is cached or how long it may safely live.
  profile: (cuId) => `seqguard:prof2:${cuId}`,
  alert: (key) => `seqguard:alert:${key}`,
  rotor: "seqguard:rotor",
};

export const RAYDAR_WEBHOOK_PROOF_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export function raydarWebhookSecretFingerprint(
  secret = process.env.RAYDAR_SCHEDULER_WEBHOOK_SECRET,
) {
  const value = String(secret || "");
  if (value.length < 32) return null;
  return createHash("sha256")
    .update(`raydar-booking-webhook-secret-v1\0${value}`)
    .digest("base64url")
    .slice(0, 24);
}

export function raydarPauseCanaryIdentityFingerprint({
  secret = process.env.RAYDAR_SCHEDULER_WEBHOOK_SECRET,
  email,
} = {}) {
  const secretValue = String(secret || "");
  const emailValue = String(email || "").trim().toLowerCase();
  if (secretValue.length < 32 || !emailValue.includes("@")) return null;
  return createHmac("sha256", secretValue)
    .update(`raydar-booking-pause-canary-v1\0${emailValue}`)
    .digest("hex");
}

export async function raydarWebhookProofStatus({
  read = kvGet,
  secret = process.env.RAYDAR_SCHEDULER_WEBHOOK_SECRET,
  canaryFingerprint =
    process.env.RAYDAR_BOOKING_PAUSE_CANARY_FINGERPRINT,
  now = Date.now(),
} = {}) {
  const [proof, pauseCanaryProof] = await Promise.all([
    read(K.raydarWebhookProof),
    read(K.raydarPauseCanaryProof),
  ]);
  const expectedFingerprint = raydarWebhookSecretFingerprint(secret);
  const inspect = (value) => {
    const verifiedAtMs = Date.parse(String(value?.verifiedAt || ""));
    const ageMs = Number.isFinite(verifiedAtMs)
      ? Math.max(0, Number(now) - verifiedAtMs)
      : null;
    const shapeValid = (
      value?.schema === "raydar-booking-webhook-proof-v1"
      && Number.isFinite(verifiedAtMs)
      && Number.isInteger(value?.matched)
      && value.matched >= 0
      && Number.isInteger(value?.paused)
      && value.paused >= 0
      && typeof value?.apply === "boolean"
      && typeof value?.deferred === "boolean"
    );
    const secretMatches = Boolean(
      shapeValid
      && expectedFingerprint
      && value.secretFingerprint === expectedFingerprint
    );
    const fresh = Boolean(
      secretMatches
      && ageMs != null
      && ageMs <= RAYDAR_WEBHOOK_PROOF_MAX_AGE_MS
      && verifiedAtMs <= Number(now) + 5 * 60_000
    );
    return {
      value,
      shapeValid,
      secretMatches,
      fresh,
      verifiedAtMs,
      ageMs,
    };
  };
  const latest = inspect(proof);
  const canary = inspect(pauseCanaryProof);
  const canaryConfigMatches = Boolean(
    /^[a-f0-9]{64}$/u.test(String(canaryFingerprint || ""))
    && pauseCanaryProof?.canaryFingerprint === canaryFingerprint
  );
  const pauseCanaryVerified = Boolean(
    canary.fresh
    && canaryConfigMatches
    && pauseCanaryProof.apply === true
    && pauseCanaryProof.deferred === false
    && pauseCanaryProof.matched >= 1
    && pauseCanaryProof.paused >= 1
  );
  return {
    verified: latest.fresh,
    pauseCanaryVerified,
    canaryConfigured:
      /^[a-f0-9]{64}$/u.test(String(canaryFingerprint || "")),
    canaryConfigMatches,
    secretMatches: canary.secretMatches,
    fresh: canary.fresh,
    lastAt: Number.isFinite(canary.verifiedAtMs)
      ? new Date(canary.verifiedAtMs).toISOString()
      : null,
    ageMs: canary.ageMs,
    apply: canary.shapeValid ? pauseCanaryProof.apply : false,
    deferred: canary.shapeValid ? pauseCanaryProof.deferred : true,
    matched: canary.shapeValid ? pauseCanaryProof.matched : 0,
    paused: canary.shapeValid ? pauseCanaryProof.paused : 0,
    latestLastAt: Number.isFinite(latest.verifiedAtMs)
      ? new Date(latest.verifiedAtMs).toISOString()
      : null,
    latestAgeMs: latest.ageMs,
    latestApply: latest.shapeValid ? proof.apply : false,
    latestDeferred: latest.shapeValid ? proof.deferred : true,
    latestMatched: latest.shapeValid ? proof.matched : 0,
    latestPaused: latest.shapeValid ? proof.paused : 0,
  };
}

function hash(value) {
  // Short stable key fragment; avoids putting raw URIs (and therefore ids) in key
  // names of unbounded length. Not a security boundary.
  let h = 5381;
  const s = String(value);
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36) + "-" + s.length;
}

function secureKeyFragment(value) {
  return createHash("sha256").update(String(value)).digest("hex").slice(0, 32);
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

function calendlyDataError(code = "CALENDLY_RESPONSE_INVALID") {
  const error = new Error(code);
  error.code = code;
  return error;
}

function calendlyApiUrl(pathOrUrl) {
  if (typeof pathOrUrl !== "string" || !pathOrUrl) {
    throw calendlyDataError();
  }
  let parsed;
  try {
    parsed = new URL(pathOrUrl, CAL_BASE);
  } catch {
    throw calendlyDataError();
  }
  if (
    parsed.origin !== CAL_BASE
    || parsed.username
    || parsed.password
    || parsed.hash
  ) {
    throw calendlyDataError();
  }
  return parsed.toString();
}

function calendlyPage(value, limit) {
  if (
    !value
    || typeof value !== "object"
    || Array.isArray(value)
    || !Array.isArray(value.collection)
    || value.collection.length > limit
    || !value.pagination
    || typeof value.pagination !== "object"
    || Array.isArray(value.pagination)
    || !Object.hasOwn(value.pagination, "next_page")
    || (
      value.pagination.next_page !== null
      && (
        typeof value.pagination.next_page !== "string"
        || !value.pagination.next_page
      )
    )
  ) {
    throw calendlyDataError();
  }
  return {
    collection: value.collection,
    next: value.pagination.next_page === null
      ? null
      : calendlyApiUrl(value.pagination.next_page),
  };
}

function calendlyTimestamp(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function calendlyEvent(value, expectedStatus) {
  if (
    !value
    || typeof value !== "object"
    || Array.isArray(value)
    || value.status !== expectedStatus
    || !calendlyTimestamp(value.updated_at)
    || !calendlyTimestamp(value.start_time)
  ) {
    throw calendlyDataError();
  }
  const uri = calendlyApiUrl(value.uri);
  const parsedUri = new URL(uri);
  if (
    parsedUri.search
    || !parsedUri.pathname.startsWith("/scheduled_events/")
  ) {
    throw calendlyDataError();
  }
  return { ...value, uri };
}

function calendlyInvitee(value) {
  if (
    !value
    || typeof value !== "object"
    || Array.isArray(value)
    || typeof value.email !== "string"
    || !normEmail(value.email).includes("@")
    || !calendlyTimestamp(value.created_at)
    || typeof value.status !== "string"
    || !value.status
  ) {
    throw calendlyDataError();
  }
  return {
    email: normEmail(value.email),
    created_at: value.created_at,
    status: value.status,
  };
}

/** Calendly rate-limits with 429 + Retry-After. Honour it rather than burning
 *  retries — a wide backfill window fans out hundreds of invitee reads. */
export async function calendlyGet(pathOrUrl, tries = 6) {
  const url = calendlyApiUrl(pathOrUrl);
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
  eventPageLimit = 100,
  inviteePageLimit = 20,
} = {}) {
  if (
    !Number.isInteger(concurrency)
    || concurrency < 1
    || concurrency > 8
    || !Number.isInteger(eventPageLimit)
    || eventPageLimit < 1
    || eventPageLimit > 100
    || !Number.isInteger(inviteePageLimit)
    || inviteePageLimit < 1
    || inviteePageLimit > 20
  ) {
    throw calendlyDataError("CALENDLY_INDEX_CONFIG_INVALID");
  }
  const me = await calendlyGet("/users/me");
  const org = calendlyApiUrl(me?.resource?.current_organization);
  const parsedOrg = new URL(org);
  if (
    parsedOrg.search
    || !parsedOrg.pathname.startsWith("/organizations/")
  ) {
    throw calendlyDataError();
  }

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
    let page = 0;
    while (next && page < eventPageLimit) {
      const d = calendlyPage(await calendlyGet(next), 100);
      events.push(
        ...d.collection.map((event) => calendlyEvent(event, status)),
      );
      next = d.next;
      page++;
    }
    if (next) truncated = true;
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
        if (
          cached
          && cached.updatedAt === ev.updated_at
          && cached.complete === true
        ) {
          if (!Array.isArray(cached.invitees)) {
            throw calendlyDataError("CALENDLY_CACHE_INVALID");
          }
          invitees = cached.invitees.map(calendlyInvitee);
          cacheHits++;
        }
      }
      if (!invitees) {
        invitees = [];
        let next = `${ev.uri}/invitees?count=100`;
        let page = 0;
        while (next && page < inviteePageLimit) {
          const d = calendlyPage(await calendlyGet(next), 100);
          invitees.push(
            ...d.collection.map(calendlyInvitee),
          );
          next = d.next;
          page++;
        }
        if (next) {
          truncated = true;
        } else if (useCache) {
          await kvSet(K.invitees(ev.uri), {
            updatedAt: ev.updated_at,
            invitees,
            complete: true,
          }, 30 * 24 * 3600);
        }
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
// Paraform's throttle can persist for tens of seconds under sustained load, so
// the ladder has to outlast it. Cheap: these delays only run when we are already
// being refused, and giving up costs a missed pause.
// This ladder used to be hand-inlined below, which meant profile reads missed
// every later fix to the shared wrapper — including transport retry. It now
// delegates to withThrottleRetry and keeps only the delays it overrides.
const AUTH_RETRY_DELAYS_MS = [600, 1800, 4500, 9000, 15000];

// TTL is deliberately SHORT. The rotor already bounds load to a few hundred
// reads per pass, so the cache is no longer needed for that — and a long TTL
// actively hides the thing we are looking for: a candidate who books via the
// Paraform scheduler emits no webhook, so the sweep is the only detector, and a
// 6h cache meant their booking could sit unnoticed for 6h behind a stale
// "CONTACTED". Observed live: two candidates booked at 09:34 and 09:49 were
// still unpaused at 13:30 for exactly this reason.
const PROFILE_TTL_SECONDS = Number(process.env.BOOKING_STOP_PROFILE_TTL_S || 1800);

export async function cachedRelationshipStatus(cuId, { ttlSeconds = PROFILE_TTL_SECONDS, force = false, onThrottle = null, deadline = null } = {}) {
  if (!force) {
    const cached = await kvGet(K.profile(cuId));
    if (cached) return cached;
  }
  // Jitter and both retry budgets live in withThrottleRetry now, so a fleet of
  // workers does not retry in lockstep and a timeout is not read as a miss.
  const p = await withThrottleRetry(
    () => trpcGet("candidateUser.getCandidateProfileInfo", { candidateUserId: cuId }, 1),
    { onThrottle, delays: AUTH_RETRY_DELAYS_MS, deadline },
  );
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
    const source = booking.source === "raydar_scheduler" ? "raydar_scheduler" : "calendly";
    const sourceLabel = source === "raydar_scheduler" ? "raydar scheduler" : "calendly";
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
      source,
      evidence: `${sourceLabel} ${booking.eventName || "event"} booked ${new Date(booking.bookedAt).toISOString()} > enrolled ${new Date(enrolledAt).toISOString()}`,
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
export async function applyDecisions(decisions, { concurrency = 2 } = {}) {
  const out = {
    paused: 0,
    pausedCcuIds: [],
    pauseErrors: [],
    throttled: 0,
  };
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

  // TARGETED readback, one exact search per lead. Walking the whole sequence
  // instead made 31 successful pauses report "readback_unavailable" (one failed
  // membership read invalidated verification for every lead in that sequence)
  // and made a paging shortfall look like a lead that had vanished. `search`
  // sidesteps the offset pagination entirely.
  let k = 0;
  const verify = async () => {
    while (k < attempted.length) {
      const d = attempted[k++];
      let row = null;
      // Name search is not identity proof: names need not be unique, and
      // Paraform returns fuzzy results. Require the candidate's address as the
      // search oracle and bind the returned row to the exact ccu_id that was
      // mutated. A different already-paused row must never certify this write.
      if (!d.email) {
        out.pauseErrors.push({
          sequence: d.sequence,
          reason: "exact_readback_identity_unavailable",
        });
        continue;
      }
      try {
        row = await campaignLeadBySearch(d.sequenceId, d.email, {
          expectedCcuId: d.ccuId,
        });
      }
      catch (e) {
        if (e.code === "AUTH_EXPIRED" && (await isSessionActuallyExpired())) throw e;
        out.pauseErrors.push({ sequence: d.sequence, reason: "readback_unavailable" });
        continue;
      }
      if (!row) { out.pauseErrors.push({ sequence: d.sequence, reason: "lead_not_found_on_readback" }); continue; }
      if (!row.is_paused) { out.pauseErrors.push({ sequence: d.sequence, reason: "still_active_after_pause" }); continue; }
      out.paused++;
      out.pausedCcuIds.push(d.ccuId);
      await kvSet(K.paused(d.ccuId), {
        at: new Date().toISOString(),
        sequence: d.sequence,
        source: d.source,
        evidence: d.evidence,
      });
    }
  };
  await Promise.all(Array.from({ length: 2 }, verify));
  return out;
}

// ---------- the sweep ----------
export async function discoverBookingStopSequences({
  deadline = null,
  listSequences = async () =>
    withThrottleRetry(() =>
      trpcGet("campaigns.getListOfCampaignsOptimized", {}, 1), { deadline }),
  readCampaign = async (id) =>
    withThrottleRetry(() =>
      trpcGet("campaigns.getCampaign", { campaign_id: id }, 1), { deadline }),
  concurrency = Number(process.env.BOOKING_STOP_SCOPE_CONCURRENCY || 2),
  minimumCatalogCount = Number(
    process.env.BOOKING_STOP_SCOPE_CATALOG_FLOOR
      || BOOKING_STOP_REVIEWED_CATALOG_FLOOR,
  ),
} = {}) {
  const all = await listSequences();
  if (
    !Array.isArray(all)
    || !Number.isInteger(minimumCatalogCount)
    || minimumCatalogCount < 1
    || all.length < minimumCatalogCount
    || !Number.isInteger(concurrency)
    || concurrency < 1
    || concurrency > 4
  ) {
    const error = new Error("BOOKING_STOP_SEQUENCE_CATALOG_INVALID");
    error.code = "BOOKING_STOP_SEQUENCE_CATALOG_INVALID";
    throw error;
  }
  const seen = new Set();
  for (const sequence of all) {
    if (
      !sequence
      || typeof sequence !== "object"
      || typeof sequence.id !== "string"
      || !sequence.id
      || seen.has(sequence.id)
    ) {
      const error = new Error("BOOKING_STOP_SEQUENCE_CATALOG_INVALID");
      error.code = "BOOKING_STOP_SEQUENCE_CATALOG_INVALID";
      throw error;
    }
    seen.add(sequence.id);
  }

  const inspected = new Map();
  let cursor = 0;
  const worker = async () => {
    while (cursor < all.length) {
      const sequence = all[cursor++];
      const campaign = await readCampaign(sequence.id);
      if (
        !campaign
        || typeof campaign !== "object"
        || !Array.isArray(campaign.steps)
      ) {
        const error = new Error("BOOKING_STOP_SEQUENCE_CAMPAIGN_INVALID");
        error.code = "BOOKING_STOP_SEQUENCE_CAMPAIGN_INVALID";
        throw error;
      }
      inspected.set(
        sequence.id,
        campaignHasCandidateSchedulingLink(campaign),
      );
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  if (inspected.size !== all.length) {
    const error = new Error("BOOKING_STOP_SEQUENCE_SCOPE_INCOMPLETE");
    error.code = "BOOKING_STOP_SEQUENCE_SCOPE_INCOMPLETE";
    throw error;
  }

  const linkSequences = all.filter((sequence) => inspected.get(sequence.id));
  const enabledLinkSequences = linkSequences.filter((sequence) =>
    Boolean(sequence.enabled));
  const sequences = all.filter((sequence) =>
    isNudgeSequence(sequence)
    || (Boolean(sequence.enabled) && inspected.get(sequence.id)));
  const scopeDigest = bookingStopScopeDigest(all.map((sequence) => ({
    id: sequence.id,
    enabled: sequence.enabled,
    linkBearing: inspected.get(sequence.id),
    nudgeBearing: isNudgeSequence(sequence),
    selected: sequences.some((selected) => selected.id === sequence.id),
  })), { catalogFloor: minimumCatalogCount });
  if (!scopeDigest) {
    const error = new Error("BOOKING_STOP_SEQUENCE_SCOPE_INCOMPLETE");
    error.code = "BOOKING_STOP_SEQUENCE_SCOPE_INCOMPLETE";
    throw error;
  }
  return {
    schema: BOOKING_STOP_SCOPE_SCHEMA,
    scopeDigest,
    catalogFloor: minimumCatalogCount,
    sequences,
    catalogSequences: all.length,
    scannedSequences: inspected.size,
    linkSequences: linkSequences.length,
    enabledLinkSequences: enabledLinkSequences.length,
    coveredEnabledLinkSequences: enabledLinkSequences.length,
    complete: true,
  };
}

// Compatibility wrapper for older imports. The implementation is no longer
// name-only despite the historical function name.
export async function loadNudgeSequences() {
  return (await discoverBookingStopSequences()).sequences;
}

/**
 * Full reconciliation pass. This is the BACKSTOP, not the primary path — the
 * webhook is. It exists because webhook deliveries can be dropped and because
 * email-only matching cannot see candidates who booked with a different address.
 */
export async function runBookingSweep({
  apply = true,
  now = Date.now(),
  // A SOFT budget the pass enforces on itself, well inside the 300s the
  // platform enforces by killing us. A killed pass writes no outcome at all:
  // its attempt record stays "running" forever and health cannot tell it from
  // one still in flight. Observed 2026-07-30 at 975s. Stopping ourselves is the
  // difference between a diagnosis and a mystery. The headroom is for the
  // pause writes and the index publish, which run AFTER the budget is spent.
  budgetMs = Number(process.env.BOOKING_STOP_BUDGET_MS || 210000),
  profileBudget = Number(process.env.BOOKING_STOP_PROFILE_BUDGET || 400),
  concurrency = 8,
  // Paraform 401s under burst (see cachedRelationshipStatus). 4 is the measured
  // comfortable ceiling for this proc; do not raise it without re-measuring.
  profileConcurrency = Number(process.env.BOOKING_STOP_PROFILE_CONCURRENCY || 3),
  calendlyBackDays = Number(process.env.BOOKING_STOP_BACK_DAYS || 7),
  calendlyIndexLoader = calendlyBookingIndex,
  raydarEnabled = raydarSchedulerBookingStopEnabled(),
  raydarConfigured = raydarSchedulerIndexConfigured(),
  raydarIndexLoader = fetchRaydarBookingIndex,
  sequenceScopeLoader = discoverBookingStopSequences,
  membershipLoader = completeCampaignLeads,
  decisionApplier = applyDecisions,
  leadIndexPublisher = durableKvSetAndReadback,
  onDecision = null,
} = {}) {
  const startedAt = Date.now();
  const deadline = startedAt + budgetMs;
  const overBudget = () => Date.now() >= deadline;
  const result = {
    ok: false,
    apply,
    budgetMs,
    budgetExceeded: false,
    budgetExceededIn: null,
    sequences: 0,
    scopeSchema: null,
    scopeDigest: null,
    scopeCatalogFloor: null,
    sequenceCatalogCount: 0,
    sequenceScopeScanned: 0,
    linkSequences: 0,
    enabledLinkSequences: 0,
    coveredEnabledLinkSequences: 0,
    linkScopeComplete: false,
    activeLeads: 0,
    calendlyEvents: 0,
    calendlyCacheHits: 0,
    calendlyTruncated: false,
    raydarEnabled,
    raydarConfigured,
    raydarItems: 0,
    raydarBookings: 0,
    raydarPages: 0,
    raydarComplete: !raydarEnabled,
    raydarError: null,
    profilesAttempted: 0,
    profilesRead: 0,
    profileFailures: 0,
    profileErrorSample: null,
    indexedEmails: 0,
    profileRotorFrom: 0,
    profileRotorOf: 0,
    throttled: 0,
    throttleGaveUp: 0,
    incompleteReads: [],
    membershipApiCalls: 0,
    decisions: [],
    paused: 0,
    pausedCcuIds: [],
    pauseErrors: [],
    durationMs: 0,
  };

  // Stopping before a leg whose output would be INCOMPLETE. A partial
  // membership read cannot publish a lead index — the webhook reads that index,
  // and a short one silently un-protects whoever is missing from it. Same rule
  // the incomplete_membership path already follows.
  const stopForBudget = (leg) => {
    result.ok = false;
    result.budgetExceeded = true;
    result.budgetExceededIn = leg;
    result.error = "budget_exceeded";
    result.durationMs = Date.now() - startedAt;
    return result;
  };

  const cal = await calendlyIndexLoader({ now, backDays: calendlyBackDays });
  result.calendlyEvents = cal.events;
  result.calendlyCacheHits = cal.cacheHits;
  result.calendlyTruncated = cal.truncated;
  if (overBudget()) return stopForBudget("calendly");

  let raydar = null;
  if (raydarEnabled) {
    if (!raydarConfigured) {
      result.raydarError = "RAYDAR_BOOKING_INDEX_NOT_CONFIGURED";
    } else {
      try {
        raydar = await raydarIndexLoader({ now });
        if (raydar?.complete !== true || !(raydar?.index instanceof Map)) {
          throw new Error("RAYDAR_BOOKING_INDEX_INCOMPLETE");
        }
        result.raydarItems = raydar.items;
        result.raydarBookings = raydar.bookings;
        result.raydarPages = raydar.pages;
        result.raydarComplete = true;
      } catch (error) {
        result.raydarError = String(error?.code || error?.message || "RAYDAR_BOOKING_INDEX_UNAVAILABLE").slice(0, 120);
      }
    }
  }

  const scope = await sequenceScopeLoader({ deadline });
  if (
    scope?.schema !== BOOKING_STOP_SCOPE_SCHEMA
    || !/^[a-f0-9]{64}$/u.test(String(scope?.scopeDigest || ""))
    || !Number.isInteger(scope?.catalogFloor)
    || scope.catalogFloor < 1
    || scope?.complete !== true
    || !Array.isArray(scope?.sequences)
    || !Number.isInteger(scope?.catalogSequences)
    || scope.catalogSequences < 1
    || scope.scannedSequences !== scope.catalogSequences
    || !Number.isInteger(scope?.enabledLinkSequences)
    || !Number.isInteger(scope?.coveredEnabledLinkSequences)
    || scope.coveredEnabledLinkSequences !== scope.enabledLinkSequences
  ) {
    const error = new Error("BOOKING_STOP_SEQUENCE_SCOPE_INCOMPLETE");
    error.code = "BOOKING_STOP_SEQUENCE_SCOPE_INCOMPLETE";
    throw error;
  }
  const seqs = scope.sequences;
  result.scopeSchema = scope.schema;
  result.scopeDigest = scope.scopeDigest;
  result.scopeCatalogFloor = scope.catalogFloor;
  result.sequences = seqs.length;
  result.sequenceCatalogCount = scope.catalogSequences;
  result.sequenceScopeScanned = scope.scannedSequences;
  result.linkSequences = scope.linkSequences;
  result.enabledLinkSequences = scope.enabledLinkSequences;
  result.coveredEnabledLinkSequences = scope.coveredEnabledLinkSequences;
  result.linkScopeComplete = true;
  if (overBudget()) return stopForBudget("scope");

  // strict:true so an incomplete membership read THROWS rather than silently
  // reconciling as "everyone left" — the failure mode that makes a broken sweep
  // look like a clean one.
  // Overlapping-window reads are ~8 calls per sequence; serially that is minutes.
  // Bounded concurrency keeps the whole pass inside the function's 300s budget.
  const perSeq = [];
  let m = 0;
  let membershipCutShort = false;
  const memWorker = async () => {
    while (m < seqs.length) {
      if (overBudget()) { membershipCutShort = true; return; }
      const seq = seqs[m++];
      const read = await membershipLoader(seq.id, { deadline });
      if (!read.complete) {
        result.incompleteReads.push({ sequence: seq.name, got: read.unique, expected: read.totalCount, shortfall: read.shortfall });
      }
      result.membershipApiCalls += read.apiCalls;
      perSeq.push({ seq, leads: read.leads });
    }
  };
  // Membership is the burstiest leg (overlapping windows, ~8 calls a sequence).
  await Promise.all(Array.from({ length: Number(process.env.BOOKING_STOP_MEMBERSHIP_CONCURRENCY || 2) }, memWorker));
  // Membership short of the full scope means `active` is short too, so neither
  // the decisions nor the published index would be trustworthy. Stop here.
  if (membershipCutShort) return stopForBudget("membership");
  if (result.incompleteReads.length) {
    result.ok = false;
    result.error = "incomplete_membership";
    result.durationMs = Date.now() - startedAt;
    return result;
  }

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

  // Pass 1 — external booking indexes. Both are already in memory, so matching
  // is cheap. During overlap we choose the newest booking across native Raydar
  // and Calendly rather than allowing source order to change the decision.
  const matched = new Set();
  for (const { seq, lead } of active) {
    let booking = null;
    for (const e of leadAddresses(lead, null)) {
      for (const source of [cal, raydar]) {
        const b = source?.index?.get(e);
        if (b && (!booking || b.bookedAt > booking.bookedAt)) booking = b;
      }
    }
    const d = decideLead({ lead, seq, booking, relStatus: null, now });
    if (d) { result.decisions.push(d); matched.add(lead.ccu_id); }
  }

  // Pass 2 — Paraform relationship status (and the extra profile addresses that
  // catch candidates who booked from a different mailbox). Cached with a TTL and
  // bounded per run so this can never become the 188s serial leg that killed the
  // n8n version; coverage converges across runs and is reported below.
  // ROTATION. A plain .slice(0, budget) always takes the SAME leads, so with a
  // budget below the population the tail is never examined at all — coverage
  // looks partial but is in fact permanently blind. Sort for a stable order,
  // then start where the last run stopped so every lead is reached within
  // ceil(N / budget) passes. One KV read + one write, not one per lead.
  const candidates = active
    .filter((a) => !matched.has(a.lead.ccu_id))
    .sort((x, y) => String(x.lead.ccu_id).localeCompare(String(y.lead.ccu_id)));
  const rotorState = await kvGet(K.rotor);
  const startAt = candidates.length ? (Number(rotorState?.at) || 0) % candidates.length : 0;
  const pending = candidates.length <= profileBudget
    ? candidates
    : [...candidates.slice(startAt), ...candidates.slice(0, startAt)].slice(0, profileBudget);
  result.profileRotorFrom = startAt;
  result.profileRotorOf = candidates.length;
  await kvSet(K.rotor, { at: candidates.length ? (startAt + pending.length) % candidates.length : 0, updatedAt: new Date().toISOString() });
  let j = 0;
  const profWorker = async () => {
    while (j < pending.length) {
      // Unlike membership, stopping here does NOT invalidate the pass's other
      // outputs: `active` is already complete, coverage is rotor-bounded and
      // partial by design, and the leads matched in pass 1 still deserve their
      // pause. So we stop reading, keep the work, and refuse to call it healthy.
      if (overBudget()) {
        result.budgetExceeded = true;
        result.budgetExceededIn ||= "profiles";
        return;
      }
      const { seq, lead } = pending[j++];
      result.profilesAttempted++;
      let prof = null;
      try {
        prof = await cachedRelationshipStatus(lead.cu_id, { onThrottle: () => { result.throttled++; }, deadline });
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
        for (const source of [cal, raydar]) {
          const b = source?.index?.get(e);
          if (b && (!booking || b.bookedAt > booking.bookedAt)) booking = b;
        }
      }
      const d = decideLead({ lead, seq, booking, relStatus: prof, now });
      if (d) result.decisions.push(d);
    }
  };
  await Promise.all(Array.from({ length: profileConcurrency }, profWorker));
  result.profileCoverage = `${pending.length}/${active.length - matched.size}`;

  // Apply
  if (apply && result.decisions.length) {
    const applied = await decisionApplier(result.decisions);
    result.paused = applied.paused;
    result.pausedCcuIds = applied.pausedCcuIds;
    result.pauseErrors.push(...applied.pauseErrors);
  }
  if (onDecision) for (const d of result.decisions) await onDecision(d);

  // Publish the index the webhook reads. Only active, unpaused leads: a paused
  // lead needs no second pause, and the webhook must not resurrect stale rows.
  const byEmail = {};
  const pausedThisPass = new Set(result.pausedCcuIds || []);
  for (const { seq, lead } of active) {
    if (pausedThisPass.has(lead.ccu_id)) continue;
    for (const addr of leadAddresses(lead, null)) {
      (byEmail[addr] ||= []).push({ s: seq.id, sn: seq.name, ccu: lead.ccu_id, cu: lead.cu_id, n: lead.name || null, t: lead.created_at });
    }
  }
  result.indexedEmails = Object.keys(byEmail).length;
  await leadIndexPublisher(K.leadIndex, {
    schema: BOOKING_STOP_LEAD_INDEX_SCHEMA,
    scopeSchema: result.scopeSchema,
    scopeDigest: result.scopeDigest,
    scopeCatalogFloor: result.scopeCatalogFloor,
    builtAt: new Date().toISOString(),
    byEmail,
  }, 6 * 3600);

  result.ok = !result.calendlyTruncated
    && !result.raydarError
    && !result.budgetExceeded
    && result.pauseErrors.length === 0;
  if (result.budgetExceeded) result.error = "budget_exceeded";
  else if (result.raydarError) result.error = "raydar_index_incomplete";
  else if (result.calendlyTruncated) {
    result.error = "calendly_index_incomplete";
  }
  else if (result.pauseErrors.length) result.error = "pause_incomplete";
  result.durationMs = Date.now() - startedAt;
  return result;
}

/**
 * Webhook path: pause every active nudge lead for one email that just booked.
 *
 * This CANNOT walk every sequence's membership inline — measured in production,
 * that is a ~200-call read that blows the function budget and returns 504 to
 * the provider (which then retries, making it worse). Instead the hourly sweep
 * publishes a lead index and the webhook does ONE KV read against it.
 *
 * On an index miss the work is deferred rather than dropped: the next sweep
 * re-evaluates every lead against all booking sources anyway, so the candidate
 * is still caught. A miss only happens for someone enrolled within the last hour, whose
 * next step is days away — so the delay costs nothing, and the deferral is
 * recorded so "we deferred" can never be confused with "there was nothing to do".
 */
export async function pauseForBooking({
  email,
  bookedAt,
  startsAt = null,
  eventName = null,
  source = "calendly",
  apply = true,
}) {
  const target = normEmail(email);
  const at = typeof bookedAt === "number" ? bookedAt : Date.parse(bookedAt);
  const out = { decisions: [], paused: 0, pauseErrors: [], deferred: false, indexAgeMs: null };
  if (!target || !Number.isFinite(at)) return out;

  const [idx, lastSweep] = await Promise.all([
    kvGet(K.leadIndex),
    kvGet(K.lastSweep),
  ]);
  const builtAt = idx?.builtAt ? Date.parse(idx.builtAt) : null;
  out.indexAgeMs = builtAt ? Date.now() - builtAt : null;
  const usable = (
    idx?.schema === BOOKING_STOP_LEAD_INDEX_SCHEMA
    && idx?.scopeSchema === BOOKING_STOP_SCOPE_SCHEMA
    && /^[a-f0-9]{64}$/u.test(String(idx?.scopeDigest || ""))
    && lastSweep?.scopeSchema === BOOKING_STOP_SCOPE_SCHEMA
    && lastSweep?.scopeDigest === idx.scopeDigest
    && lastSweep?.linkScopeComplete === true
    && idx?.byEmail
    && builtAt
    && out.indexAgeMs < LEAD_INDEX_MAX_AGE_MS
  );

  if (!usable) {
    out.deferred = true;
    await kvSet(K.deferred(target), {
      at: new Date().toISOString(),
      bookedAt: new Date(at).toISOString(),
      reason: idx ? "index_stale_or_scope_mismatch" : "index_missing",
    }, 7 * 24 * 3600);
    return out;
  }

  const entries = idx.byEmail[target] || [];
  const booking = {
    bookedAt: at,
    startsAt,
    eventName,
    status: "active",
    source: source === "raydar_scheduler" ? "raydar_scheduler" : "calendly",
  };
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
 * External-booking-aware replacement for core.mjs `bookedSet()`.
 *
 * The original resolves "is this candidate already booked?" purely from Paraform
 * relationship status, so it cannot see a human call booked through Calendly —
 * the same blind spot that let the nudges go out, one step earlier. Without this
 * the launcher will happily enroll someone who already has a call on the books.
 *
 * The legacy Calendly leg preserves its historical fail-open behavior. The
 * first-party Raydar index does NOT: once enabled, an incomplete/error response
 * throws and blocks enrollment. A first-party source failure must never be
 * interpreted as evidence that a candidate did not book.
 */
export async function bookedSetWithSources(candidateUserIds, {
  concurrency = 8,
  now = Date.now(),
  calendlyEnabled = calendlyConfigured(),
  calendlyIndexLoader = calendlyBookingIndex,
  raydarEnabled = raydarSchedulerBookingStopEnabled(),
  raydarConfigured = raydarSchedulerIndexConfigured(),
  raydarIndexLoader = fetchRaydarBookingIndex,
  profileLoader = cachedRelationshipStatus,
} = {}) {
  const ids = Array.from(new Set((candidateUserIds || []).filter(Boolean)));
  const booked = new Set();
  if (!ids.length) return booked;

  let cal = null;
  if (calendlyEnabled) {
    // Narrow window: at enroll time we only care whether a call is upcoming or
    // was very recent, and this runs on a user-facing path.
    cal = await calendlyIndexLoader({ backDays: 7, forwardDays: 120, now, concurrency })
      .catch(() => null); // fail open — see doc comment
  }

  let raydar = null;
  if (raydarEnabled) {
    if (!raydarConfigured) {
      const error = new Error("RAYDAR_BOOKING_INDEX_NOT_CONFIGURED");
      error.code = "RAYDAR_BOOKING_INDEX_NOT_CONFIGURED";
      throw error;
    }
    raydar = await raydarIndexLoader({ now });
    if (raydar?.complete !== true || !(raydar?.index instanceof Map)) {
      const error = new Error("RAYDAR_BOOKING_INDEX_INCOMPLETE");
      error.code = "RAYDAR_BOOKING_INDEX_INCOMPLETE";
      throw error;
    }
  }

  let i = 0;
  const worker = async () => {
    while (i < ids.length) {
      const id = ids[i++];
      let prof = null;
      try {
        prof = await profileLoader(id);
      } catch {
        if (raydarEnabled) {
          const error = new Error("RAYDAR_CANDIDATE_PROFILE_UNAVAILABLE");
          error.code = "RAYDAR_CANDIDATE_PROFILE_UNAVAILABLE";
          throw error;
        }
        // The legacy Calendly-only gate intentionally remains best-effort.
        continue;
      }
      if (
        !prof
        || typeof prof !== "object"
        || Array.isArray(prof)
        || !Array.isArray(prof.emails)
      ) {
        if (raydarEnabled) {
          const error = new Error("RAYDAR_CANDIDATE_PROFILE_UNAVAILABLE");
          error.code = "RAYDAR_CANDIDATE_PROFILE_UNAVAILABLE";
          throw error;
        }
        continue;
      }
      if (prof.status && BOOKED_STATUSES.has(prof.status)) { booked.add(id); continue; }
      for (const e of prof.emails || []) {
        for (const source of [cal, raydar]) {
          const hit = source?.index?.get(e);
          // Only an ACTIVE booking blocks enrollment; a cancelled one means they
          // are back in play and should be re-engaged.
          if (hit && hit.status === "active") { booked.add(id); break; }
        }
        if (booked.has(id)) break;
      }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  return booked;
}

// Compatibility export retained while callers and registry language transition.
export const bookedSetWithCalendly = bookedSetWithSources;

// ---------- staleness ----------
export const LEAD_INDEX_MAX_AGE_MS = Number(process.env.BOOKING_STOP_INDEX_MAX_AGE_MS || 3 * 3600 * 1000);

export const SWEEP_STALE_AFTER_MS = Number(process.env.BOOKING_STOP_STALE_MS || 3 * 3600 * 1000);

/** The single most important check here: it is what was missing when the n8n
 *  guardian died silently for nine days. */
export async function sweepStaleness(now = Date.now()) {
  const [last, attempt, leadIndex] = await Promise.all([
    kvGet(K.lastSweep),
    kvGet(K.lastAttempt),
    kvGet(K.leadIndex),
  ]);
  const attemptAtMs = Date.parse(String(attempt?.at || ""));
  const attemptAgeMs = Number.isFinite(attemptAtMs)
    ? Math.max(0, now - attemptAtMs)
    : null;
  const attemptBase = {
    latestAttemptAt: Number.isFinite(attemptAtMs)
      ? new Date(attemptAtMs).toISOString()
      : null,
    latestAttemptAgeMs: attemptAgeMs,
    latestAttemptStatus:
      attempt?.schema === BOOKING_STOP_ATTEMPT_SCHEMA
        ? attempt.status
        : null,
    latestAttemptError:
      attempt?.schema === BOOKING_STOP_ATTEMPT_SCHEMA
        ? attempt.error
        : null,
  };
  const leadIndexAtMs = Date.parse(String(leadIndex?.builtAt || ""));
  const leadIndexAgeMs = Number.isFinite(leadIndexAtMs)
    ? Math.max(0, now - leadIndexAtMs)
    : null;
  if (!last?.at) {
    return {
      stale: true,
      lastAt: null,
      ageMs: null,
      calendlyComplete: false,
      ...attemptBase,
      latestAttemptCurrent: false,
      leadIndexAt: Number.isFinite(leadIndexAtMs)
        ? new Date(leadIndexAtMs).toISOString()
        : null,
      leadIndexAgeMs,
      leadIndexCurrent: false,
    };
  }
  const ageMs = now - Date.parse(last.at);
  const latestAttemptCurrent = Boolean(
    attempt?.schema === BOOKING_STOP_ATTEMPT_SCHEMA
    && attempt.status === "success"
    && attempt.scopeSchema === BOOKING_STOP_SCOPE_SCHEMA
    && attempt.scopeDigest === last.scopeDigest
    && attemptAtMs >= Date.parse(last.at)
  );
  const leadIndexCurrent = Boolean(
    leadIndex?.schema === BOOKING_STOP_LEAD_INDEX_SCHEMA
    && leadIndex.scopeSchema === BOOKING_STOP_SCOPE_SCHEMA
    && leadIndex.scopeDigest === last.scopeDigest
    && leadIndexAgeMs != null
    && leadIndexAgeMs <= LEAD_INDEX_MAX_AGE_MS
  );
  return {
    stale: ageMs > SWEEP_STALE_AFTER_MS,
    lastAt: last.at,
    ageMs,
    activeLeads: last.activeLeads ?? null,
    calendlyComplete: last.calendlyComplete === true,
    raydarEnabled: Boolean(last.raydarEnabled),
    raydarComplete: Boolean(last.raydarComplete),
    raydarBookings: last.raydarBookings ?? null,
    sequenceCatalogCount: last.sequenceCatalogCount ?? null,
    sequenceScopeScanned: last.sequenceScopeScanned ?? null,
    linkSequences: last.linkSequences ?? null,
    enabledLinkSequences: last.enabledLinkSequences ?? null,
    coveredEnabledLinkSequences: last.coveredEnabledLinkSequences ?? null,
    scopeSchema: last.scopeSchema ?? null,
    scopeDigest: last.scopeDigest ?? null,
    scopeCatalogFloor: last.scopeCatalogFloor ?? null,
    linkScopeComplete: Boolean(
      last.scopeSchema === BOOKING_STOP_SCOPE_SCHEMA
      && /^[a-f0-9]{64}$/u.test(String(last.scopeDigest || ""))
      && last.linkScopeComplete
    ),
    ...attemptBase,
    latestAttemptCurrent,
    leadIndexAt: Number.isFinite(leadIndexAtMs)
      ? new Date(leadIndexAtMs).toISOString()
      : null,
    leadIndexAgeMs,
    leadIndexCurrent,
  };
}

/** The one clue health gets about WHY a pass died, so it must not be thrown
 *  away on the way there. A DOMException carries a legacy NUMERIC `code` — an
 *  AbortSignal.timeout() is 23 — so `e.code || e.message` recorded the literal
 *  string "23", which told nobody anything and cost a real diagnosis. Prefer a
 *  meaningful string code, then the name, then the message. */
export function sweepErrorLabel(e) {
  if (typeof e === "string") return e || "error";
  if (typeof e?.code === "string" && e.code) return e.code;
  if (typeof e?.name === "string" && e.name && e.name !== "Error") return e.name;
  if (e?.message) return String(e.message);
  return e?.code != null ? String(e.code) : "error";
}

/** What health will actually see. `result.error` stays the stable machine code
 *  so anything matching on it keeps working, but "budget_exceeded" alone is
 *  useless — the whole point of stopping ourselves was to learn WHERE the time
 *  goes, and that stage was reaching Slack and the HTTP response while health,
 *  the one unauthenticated surface, still got nothing. Returning null leaves
 *  recordSweepAttempt to fall through to `result.error` exactly as before. */
export function sweepAttemptErrorLabel(result) {
  if (result?.budgetExceeded && result?.budgetExceededIn) {
    return `budget_exceeded:${result.budgetExceededIn}`;
  }
  return null;
}

export async function recordSweepAttempt({
  status,
  result = null,
  error = null,
}, now = Date.now()) {
  if (!["failure", "running", "success"].includes(status)) {
    const invalid = new Error("BOOKING_STOP_ATTEMPT_INVALID");
    invalid.code = "BOOKING_STOP_ATTEMPT_INVALID";
    throw invalid;
  }
  const payload = {
    schema: BOOKING_STOP_ATTEMPT_SCHEMA,
    at: new Date(now).toISOString(),
    status,
    error: status === "failure"
      ? String(error || result?.error || "unknown").slice(0, 80)
      : null,
    scopeSchema: result?.scopeSchema || null,
    scopeDigest: /^[a-f0-9]{64}$/u.test(String(result?.scopeDigest || ""))
      ? result.scopeDigest
      : null,
  };
  await durableKvSetAndReadback(K.lastAttempt, payload, 6 * 3600);
}

export async function recordSuccessfulSweep(result, now = Date.now()) {
  if (
    result?.ok !== true
    || result?.calendlyTruncated !== false
    || (result?.pauseErrors?.length || 0) !== 0
    || result?.scopeSchema !== BOOKING_STOP_SCOPE_SCHEMA
    || !/^[a-f0-9]{64}$/u.test(String(result?.scopeDigest || ""))
    || !Number.isInteger(result?.scopeCatalogFloor)
    || result.scopeCatalogFloor < 1
    || result?.sequenceCatalogCount < result.scopeCatalogFloor
    || result?.linkScopeComplete !== true
    || result?.sequenceScopeScanned !== result?.sequenceCatalogCount
    || result?.coveredEnabledLinkSequences !== result?.enabledLinkSequences
  ) {
    const error = new Error("BOOKING_STOP_SEQUENCE_SCOPE_INCOMPLETE");
    error.code = "BOOKING_STOP_SEQUENCE_SCOPE_INCOMPLETE";
    throw error;
  }
  await durableKvSetAndReadback(K.lastSweep, {
    at: new Date(now).toISOString(),
    scopeSchema: result.scopeSchema,
    scopeDigest: result.scopeDigest,
    scopeCatalogFloor: result.scopeCatalogFloor,
    activeLeads: result.activeLeads,
    paused: result.paused,
    durationMs: result.durationMs,
    calendlyComplete: true,
    raydarEnabled: Boolean(result.raydarEnabled),
    raydarComplete: Boolean(result.raydarComplete),
    raydarBookings: result.raydarBookings ?? 0,
    sequenceCatalogCount: result.sequenceCatalogCount ?? 0,
    sequenceScopeScanned: result.sequenceScopeScanned ?? 0,
    linkSequences: result.linkSequences ?? 0,
    enabledLinkSequences: result.enabledLinkSequences ?? 0,
    coveredEnabledLinkSequences: result.coveredEnabledLinkSequences ?? 0,
    linkScopeComplete: Boolean(result.linkScopeComplete),
  }, 6 * 3600);
}
