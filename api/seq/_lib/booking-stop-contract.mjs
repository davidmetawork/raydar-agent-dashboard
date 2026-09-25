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
// The cache never serves a "no link" answer on a row where that answer
// decides selection (enabled, name-unmatched, not cold-excluded). Those rows
// are read live on EVERY scope load, exactly as before the cache, because the
// catalog carries no change signal (no updated_at, version or step count:
// verified field set in the raydar repo's Paraform API reference) and a
// scheduling link added to such a row moves nothing in the catalog. Every
// answer the cache does serve can only keep a row in scope or cannot change
// selection, so a stale cached answer can never shrink protection.
export const BOOKING_STOP_DEFINITION_CACHE_SCHEMA =
  "raydar-booking-stop-definition-cache-v2";
// Bump whenever campaignHasCandidateSchedulingLink, hasCandidateSchedulingLink
// or the scheduling-link rules they use change meaning. The cache revision is
// this version plus a fingerprint of the matcher functions' source, so a
// matcher change always starts from an empty cache; a deploy that does not
// touch the matcher keeps it. test/booking-stop-definition-cache.test.mjs
// pins the matcher files' hash to this version.
export const BOOKING_STOP_DEFINITION_MATCHER_VERSION = 1;
// How long the refresh trusts a cached answer it may use (a cached "has link"
// only ever widens scope; a disabled or name-matched row's link answer never
// changes selection).
export const BOOKING_STOP_DEFINITION_MAX_AGE_MS = 6 * 60 * 60 * 1000;
// The sweep trusts the same answers one snapshot lifetime longer, so it never
// re-reads (and disagrees with) an answer the published snapshot was built
// from. Rows the sweep reads live are unaffected. Also the retention bound:
// an entry older than this is dropped on write.
export const BOOKING_STOP_DEFINITION_SWEEP_MAX_AGE_MS =
  BOOKING_STOP_DEFINITION_MAX_AGE_MS + BOOKING_MEMBERSHIP_MAX_AGE_MS;
// The refresh re-reads the oldest cached answers before they expire so
// expiries never bunch into bursts: per run
// ceil(count * HORIZON / (MAX_AGE - HORIZON)) reads, at most ROTOR_MAX_READS,
// inside ROTOR_PHASE_MS. Rotor reads are single-shot (no throttle ladder, no
// session-expiry probe): the first failure stops the rotor for that run.
export const BOOKING_STOP_DEFINITION_ROTOR_HORIZON_MS = 10 * 60 * 1000;
export const BOOKING_STOP_DEFINITION_ROTOR_MAX_READS = 64;
export const BOOKING_STOP_DEFINITION_ROTOR_PHASE_MS = 20 * 1000;
// A document past either cap is neither trusted nor written.
export const BOOKING_STOP_DEFINITION_CACHE_MAX_ENTRIES = 1024;
export const BOOKING_STOP_DEFINITION_CACHE_MAX_BYTES = 512 * 1024;
export const BOOKING_STOP_DEFINITION_CACHE_TTL_SECONDS = 8 * 60 * 60;
// The refresh's PUBLISHED answers: one write-once document per scope digest
// (seqguard:booking-stop-definition-answers:v1:<scopeDigest>) holding the
// link answers {n, e, l, r} that produced that digest. The sweep serves only
// from the document of the digest the current pointer publishes, so a served
// answer always equals the published binding's, whatever the mutable cache
// document holds. Same caps and TTL as the cache document.
export const BOOKING_STOP_DEFINITION_ANSWERS_SCHEMA =
  "raydar-booking-stop-definition-answers-v1";
// How long the sweep waits (KV reads only) for a refresh that is running
// right now to publish, when the current pointer is already provably stale.
// Before the definition cache the sweep's live scope leg took about this
// long, so a generation published inside it was consumed; waiting keeps that.
export const BOOKING_STOP_PRECHECK_MAX_WAIT_MS = 90 * 1000;
export const BOOKING_STOP_PRECHECK_POLL_MS = 5 * 1000;
