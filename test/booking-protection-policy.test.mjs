// Item 4: today's "new bookings only" rule stays the default for every
// family; the interview-chase-only widened rule is a config flag, default OFF.
import test from "node:test";
import assert from "node:assert/strict";

import {
  alsoPauseIfBookedBeforeJoining,
  isInterviewChaseSequence,
  interviewChaseFamilyKeys,
  INTERVIEW_CHASE_FAMILY_KEY,
} from "../api/seq/_lib/booking-protection-policy.mjs";
import { DEFAULT_SEQ_KEYS } from "../api/seq/_lib/booking-stop.mjs";

test("the flag defaults OFF and only turns on with the exact value \"1\"", () => {
  assert.equal(alsoPauseIfBookedBeforeJoining({}), false);
  assert.equal(alsoPauseIfBookedBeforeJoining({ BOOKING_STOP_INTERVIEW_CHASE_PAUSE_BEFORE_JOIN: "true" }), false);
  assert.equal(alsoPauseIfBookedBeforeJoining({ BOOKING_STOP_INTERVIEW_CHASE_PAUSE_BEFORE_JOIN: "0" }), false);
  assert.equal(alsoPauseIfBookedBeforeJoining({ BOOKING_STOP_INTERVIEW_CHASE_PAUSE_BEFORE_JOIN: "1" }), true);
});

test("the interview-chase family key matches the launcher's own naming convention, including '- <Role>' variants", () => {
  assert.equal(isInterviewChaseSequence("No Scheduled Call - Raydar - 1st Round Interview - Backend Engineer"), true);
  assert.equal(isInterviewChaseSequence("OLD No Scheduled Call - Raydar - 1st Round Interview"), true);
  assert.equal(isInterviewChaseSequence("No Show - Agent Call"), false);
  assert.equal(isInterviewChaseSequence(""), false);
  assert.equal(isInterviewChaseSequence(null), false);
});

test("the family key is exactly the one already reserved in booking-stop.mjs's DEFAULT_SEQ_KEYS", () => {
  assert.ok(DEFAULT_SEQ_KEYS.includes(INTERVIEW_CHASE_FAMILY_KEY));
  assert.deepEqual(interviewChaseFamilyKeys(), [INTERVIEW_CHASE_FAMILY_KEY]);
});
