// ─────────────────────────────────────────────────────────────────────────────
// LIVE-SET INDEX — the once-a-day (or on-demand) replacement for the
// 10-minute booking-membership-refresh walk
// (docs/research/booking-protection-minimum-2026-09-26.md item 1/2).
//
// It reads the sequence catalog once, keeps only ENABLED sequences matching
// the existing named "please book a call" families
// (booking-stop.mjs seqKeys()/isNudgeSequence — a pure string match, zero
// Paraform cost), and walks membership ONLY for the ones that still have at
// least one active lead. The result is a plain email -> [{sequence,
// enrolledAt}, ...] index; consulting it (matchBookingAgainstLiveSet) costs
// ZERO Paraform requests, which is the entire point.
//
// Deliberate simplification vs. the appendix's full design: this does NOT
// re-read every non-cold sequence's step content daily to discover new,
// unnamed scheduling-link sequences (that per-definition scan is what made
// the old walk cost ~272 requests every ten minutes). The summary's minimum
// design (§4) does not call for that scan daily either — it names the same
// "read the sequence list once, then only the enabled protected sequences
// that still have active leads" scope this module builds. Residual risk,
// called out in the PR: a brand-new or renamed sequence that adds a
// scheduling link without matching one of the known name keys is not
// auto-discovered until someone adds its key to BOOKING_STOP_SEQ_KEYS. Every
// currently-protected family (No Show, Audio Failed, both Reschedule
// sequences, the curated-list follow-ups, the interview chase) is matched by
// name today.
//
// SECOND residual risk, also deliberately accepted and called out in the PR
// (a review flagged that it was implemented but undisclosed): a lead enrolled
// into an already-enabled protected sequence AFTER today's build who then
// books before TOMORROW's rebuild is not in byEmail at all yet, so neither the
// webhook-triggered worker nor the daily catch-up can match or pause them —
// they can receive up to one more nudge in the gap. Bounded to <=24h and the
// step cadence these families use in practice (named sequences are 2+ days
// apart per candidate), so a rebuild the next day catches it. The appendix's
// same-day count-delta walk would close this at the cost of the exact daily
// per-sequence read this redesign exists to remove; left to David to decide
// whether that trade is worth it (see the PR's Residual risks section).
import {
  isNudgeSequence,
  seqKeys,
  decideLead,
  normEmail,
  bookingStopColdExclusionProtectionKeys,
} from "./booking-stop.mjs";
import {
  coldExclusionDisposition,
  parseBookingStopColdExclusions,
} from "./booking-stop-policy.mjs";
import { completeCampaignLeads } from "./core.mjs";
import {
  LITE_KEYS,
  LIVESET_SCHEMA,
  LIVESET_MAX_AGE_MS,
  kvGet,
  kvSet,
} from "./booking-protection-store.mjs";
import {
  isInterviewChaseSequence,
} from "./booking-protection-policy.mjs";

export { LIVESET_SCHEMA, LIVESET_MAX_AGE_MS };

export function liveSetUsable(liveSet, now = Date.now(), maxAgeMs = LIVESET_MAX_AGE_MS) {
  const builtAtMs = liveSet?.builtAt ? Date.parse(liveSet.builtAt) : NaN;
  return Boolean(
    liveSet
    && liveSet.schema === LIVESET_SCHEMA
    && liveSet.byEmail
    && typeof liveSet.byEmail === "object"
    && !Array.isArray(liveSet.byEmail)
    && Number.isFinite(builtAtMs)
    && now - builtAtMs >= 0
    && now - builtAtMs <= maxAgeMs,
  );
}

/**
 * Build the daily live-set index.
 *
 * `listSequences` and `membershipLoader` are injected so callers (the daily
 * cron, tests) control exactly how — and how slowly — Paraform gets called;
 * this function itself makes no assumption about pacing beyond calling
 * `sleepBetweenSequences` once per sequence walked.
 */
export async function buildLiveSet({
  now = Date.now(),
  listSequences,
  membershipLoader = (id) => completeCampaignLeads(id),
  keys = seqKeys(),
  coldExclusionPolicy = parseBookingStopColdExclusions(),
  sleepBetweenSequences = async () => {},
} = {}) {
  if (typeof listSequences !== "function") {
    const error = new Error("BOOKING_STOP_LITE_LISTER_REQUIRED");
    error.code = "BOOKING_STOP_LITE_LISTER_REQUIRED";
    throw error;
  }
  const catalog = await listSequences();
  if (!Array.isArray(catalog)) {
    const error = new Error("BOOKING_STOP_LITE_CATALOG_INVALID");
    error.code = "BOOKING_STOP_LITE_CATALOG_INVALID";
    throw error;
  }

  const exclusionKeys = bookingStopColdExclusionProtectionKeys(keys);
  const candidates = catalog.filter((seq) =>
    seq
    && typeof seq === "object"
    && typeof seq.id === "string"
    && seq.id
    && Boolean(seq.enabled)
    && isNudgeSequence(seq, keys)
    && coldExclusionDisposition(seq, coldExclusionPolicy, exclusionKeys) !== "excluded_cold");

  const byEmail = new Map();
  const sequencesWithActiveLeads = [];
  const errors = [];
  let leadsIndexed = 0;
  let first = true;
  for (const seq of candidates) {
    if (!first) await sleepBetweenSequences();
    first = false;
    let membership;
    try {
      membership = await membershipLoader(seq.id);
    } catch (error) {
      errors.push({
        sequenceId: seq.id,
        name: seq.name,
        reason: String(error?.code || error?.message || "error").slice(0, 120),
      });
      continue;
    }
    const leads = Array.isArray(membership?.leads) ? membership.leads : [];
    const active = leads.filter((lead) =>
      lead?.ccu_id && !lead.is_paused && !lead.is_archived);
    if (!active.length) continue;
    sequencesWithActiveLeads.push({
      id: seq.id,
      name: seq.name,
      activeLeads: active.length,
      complete: membership.complete !== false,
    });
    for (const lead of active) {
      const email = normEmail(lead.to_use_email);
      if (!email) continue;
      // Stored as the RAW created_at string, exactly like the legacy shard
      // format (booking-membership-snapshot.mjs `t: lead.created_at`) — this
      // is what decideLead() (reused unmodified) parses with Date.parse().
      if (!Number.isFinite(Date.parse(lead.created_at))) continue;
      const entry = {
        ccu: lead.ccu_id,
        cu: lead.cu_id || null,
        n: lead.name || null,
        s: seq.id,
        sn: seq.name,
        t: lead.created_at,
      };
      if (!byEmail.has(email)) byEmail.set(email, []);
      byEmail.get(email).push(entry);
      leadsIndexed++;
    }
  }

  return {
    schema: LIVESET_SCHEMA,
    builtAt: new Date(now).toISOString(),
    catalogSequences: catalog.length,
    candidateSequences: candidates.length,
    sequencesWithActiveLeads: sequencesWithActiveLeads.length,
    sequences: sequencesWithActiveLeads,
    leadsIndexed,
    indexedEmails: byEmail.size,
    byEmail: Object.fromEntries(byEmail),
    incomplete: errors.length > 0,
    errors,
  };
}

export async function publishLiveSet(liveSet, {
  write = kvSet,
  ttlSeconds = 7 * 24 * 3600,
} = {}) {
  await write(LITE_KEYS.liveSet, liveSet, ttlSeconds);
}

export async function loadLiveSet({ read = kvGet } = {}) {
  return read(LITE_KEYS.liveSet);
}

/**
 * Match one booking against the published live-set index. Zero Paraform
 * requests — a pure in-memory lookup against the last published index. This
 * is the fast path every pending booking goes through before anything ever
 * costs a Paraform request (booking-protection-worker.mjs).
 */
export function matchBookingAgainstLiveSet({
  liveSet,
  email,
  bookedAtMs,
  source,
  eventName = null,
  startsAt = null,
  alsoPauseBeforeJoiningInterviewChase = false,
  now = Date.now(),
} = {}) {
  const target = normEmail(email);
  if (!target || !Number.isFinite(bookedAtMs)) return [];
  const entries = liveSet?.byEmail?.[target] || [];
  const booking = { bookedAt: bookedAtMs, startsAt, eventName, status: "active", source };
  const decisions = [];
  for (const e of entries) {
    const lead = {
      ccu_id: e.ccu,
      cu_id: e.cu,
      name: e.n || null,
      to_use_email: target,
      created_at: e.t,
      is_paused: false,
      is_archived: false,
    };
    const seq = { id: e.s, name: e.sn };
    let decision = decideLead({ lead, seq, booking, relStatus: null, now });
    if (
      !decision
      && alsoPauseBeforeJoiningInterviewChase
      && isInterviewChaseSequence(e.sn)
    ) {
      // The interview-chase-only widened rule (David's call, default OFF —
      // booking-protection-policy.mjs): a booking made just BEFORE joining
      // still counts for this one family. decideLead() intentionally never
      // does this (its "new bookings only" rule is load-bearing for every
      // other family), so this is composed here rather than changed there.
      decision = {
        ccuId: e.ccu,
        cuId: e.cu || null,
        name: e.n || null,
        email: target,
        sequenceId: e.s,
        sequence: e.sn,
        enrolledAt: new Date(e.t).toISOString(),
        bookedAt: new Date(bookedAtMs).toISOString(),
        startsAt,
        source,
        evidence: `${source} booked ${new Date(bookedAtMs).toISOString()} before joining ${new Date(e.t).toISOString()} (interview-chase pre-join rule, BOOKING_STOP_INTERVIEW_CHASE_PAUSE_BEFORE_JOIN=1)`,
      };
    }
    if (decision) decisions.push(decision);
  }
  return decisions;
}
