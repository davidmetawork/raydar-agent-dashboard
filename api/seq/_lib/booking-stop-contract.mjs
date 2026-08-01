export const BOOKING_STOP_SCOPE_SCHEMA =
  "raydar-booking-stop-scope-v2";
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
