// ─────────────────────────────────────────────────────────────────────────────
// PAUSE-RULE POLICY for the lightweight booking-protection design.
//
// TODAY'S RULE, unchanged, for every family (No Show, Audio Failed, both
// Reschedule sequences, the curated-list follow-ups, and the interview
// chase): a lead is only paused when the booking is LATER than enrollment
// (booking-stop.mjs decideLead — reused as-is, not modified). Everyone in
// those populations booked once already, before the call they missed, so an
// older booking must never be read as "they just booked".
//
// The ONE family where an *older* booking can still be the right signal is
// the interview chase ("No Scheduled Call - Raydar - 1st Round Interview" and
// its "- <Role>"/"OLD ..." variants): someone can be freshly enrolled into it
// after already booking, if enrollment and the call get scheduled close
// together. Whether that should also pause is explicitly David's call
// (docs/research/booking-protection-minimum-2026-09-26.md §4, "Only the
// interview chase would also pause someone who booked just before joining.
// That rule is your call.") — so it ships as a config flag, default OFF,
// until he decides.
export const INTERVIEW_CHASE_FAMILY_KEY =
  "No Scheduled Call - Raydar - 1st Round Interview";

export function interviewChaseFamilyKeys() {
  return [INTERVIEW_CHASE_FAMILY_KEY];
}

export function alsoPauseIfBookedBeforeJoining(env = process.env) {
  return env.BOOKING_STOP_INTERVIEW_CHASE_PAUSE_BEFORE_JOIN === "1";
}

/** True when `sequenceName` belongs to the interview-chase family. */
export function isInterviewChaseSequence(sequenceName, keys = interviewChaseFamilyKeys()) {
  const name = String(sequenceName || "");
  return keys.some((key) => name.includes(key));
}
