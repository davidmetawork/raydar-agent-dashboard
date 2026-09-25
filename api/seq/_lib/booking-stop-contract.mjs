export const BOOKING_STOP_SCOPE_SCHEMA =
  "raydar-booking-stop-scope-v2";
export const BOOKING_STOP_SCOPE_SCHEMA_V3 =
  "raydar-booking-stop-scope-v3";
export const BOOKING_STOP_COLD_EXCLUSION_SCHEMA =
  "raydar-booking-stop-cold-exclusions-v1";
export const BOOKING_STOP_LEAD_INDEX_SCHEMA =
  "raydar-booking-lead-index-v2";
export const BOOKING_STOP_ATTEMPT_SCHEMA =
  "raydar-booking-stop-attempt-v3";
export const BOOKING_STOP_REVIEWED_CATALOG_FLOOR = 60;

export const BOOKING_MEMBERSHIP_SNAPSHOT_SCHEMA =
  "raydar-booking-membership-snapshot-v1";
export const BOOKING_MEMBERSHIP_SHARD_SCHEMA =
  "raydar-booking-membership-shard-v1";
export const BOOKING_MEMBERSHIP_CURRENT_SCHEMA =
  "raydar-booking-membership-current-v1";
export const BOOKING_MEMBERSHIP_CHECKPOINT_SCHEMA =
  "raydar-booking-membership-checkpoint-v1";
export const BOOKING_MEMBERSHIP_ATTEMPT_SCHEMA =
  "raydar-booking-membership-attempt-v1";

// This is deliberately fixed by the snapshot contract, rather than being an
// environment-tunable safety boundary. A deployment must not silently bless a
// snapshot older than one refresh interval.
export const BOOKING_MEMBERSHIP_MAX_AGE_MS = 60 * 60 * 1000;
export const BOOKING_MEMBERSHIP_BUILD_BUDGET_MS = 240 * 1000;

// ── Sequence-definition cache (discoverBookingStopSequences) ────────────────
// Fixed here, like BOOKING_MEMBERSHIP_MAX_AGE_MS, and deliberately NOT
// environment-tunable: an environment may switch the cache OFF
// (BOOKING_STOP_DEFINITION_CACHE=off restores a full read on every load) but
// can never lengthen how long a cached answer is trusted.
//
// The only protection gap the cache introduces: a scheduling link added to an
// EXISTING sequence that is enabled, name-unmatched and not cold-excluded,
// with no rename and no enable flip, is invisible in the catalog. A cached
// "no link" for such a row is trusted for at most NO_LINK_MAX_AGE (today the
// gap is one refresh interval, about 10 minutes). Choosing that number is a
// review decision.
export const BOOKING_STOP_DEFINITION_CACHE_SCHEMA =
  "raydar-booking-stop-definition-cache-v1";
// Cached "no link" on a row where that answer decides selection.
export const BOOKING_STOP_DEFINITION_NO_LINK_MAX_AGE_MS = 30 * 60 * 1000;
// Every other cached answer (a cached "has link" only ever widens scope; a
// disabled or name-matched row's link answer never changes selection).
export const BOOKING_STOP_DEFINITION_MAX_AGE_MS = 6 * 60 * 60 * 1000;
// A selection-deciding "no link" is trusted only once a read at least this
// long after the state was first seen confirms it. Covers new ids, renames,
// enable flips, link removals and getCampaign's tens-of-seconds eventual
// consistency after updateSequenceSteps.
export const BOOKING_STOP_DEFINITION_SETTLE_MS = 5 * 60 * 1000;
// The refresh re-reads the oldest entries of each class before they expire so
// expiries never bunch into bursts: per run, per class,
// ceil(count * HORIZON / (maxAge - HORIZON)) reads, at most ROTOR_MAX_READS in
// total, inside a ROTOR_PHASE_MS time budget.
export const BOOKING_STOP_DEFINITION_ROTOR_HORIZON_MS = 10 * 60 * 1000;
export const BOOKING_STOP_DEFINITION_ROTOR_MAX_READS = 64;
export const BOOKING_STOP_DEFINITION_ROTOR_PHASE_MS = 45 * 1000;
// A document past either cap is neither trusted nor written.
export const BOOKING_STOP_DEFINITION_CACHE_MAX_ENTRIES = 1024;
export const BOOKING_STOP_DEFINITION_CACHE_MAX_BYTES = 512 * 1024;
export const BOOKING_STOP_DEFINITION_CACHE_TTL_SECONDS = 7 * 60 * 60;
