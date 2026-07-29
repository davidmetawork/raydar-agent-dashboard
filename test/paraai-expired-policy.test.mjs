import test from "node:test";
import assert from "node:assert/strict";

import {
  expiredConfig,
  expiredDetectionEnabled,
  expiredWriteEnabled,
  expiredShadowMode,
  planExpiredRow,
} from "../api/paraai/_lib/expired.mjs";
import { normalizeExpiredRow } from "../api/paraai/_lib/expired-actions.mjs";

const NOW = Date.parse("2026-07-29T00:00:00.000Z");

const row = (over = {}) => normalizeExpiredRow({
  id: "req-expired",
  created_at: "2026-07-21T22:47:06.677Z",
  sent_to_user_id: "user-me",
  reached_out_to_candidate: true,
  state: "EXPIRED",
  status: "expired",
  status_label: "Expired",
  filterBucket: "expired",
  candidate: { id: "cand-1", candidate_user_id: "cu-1", name: "Test Candidate" },
  role: { id: "role-1", name: "Product Manager", company: { name: "Example Co" } },
  ...over,
});

const evidence = (over = {}) => ({
  reachedOut: true,
  replyRecords: [],
  gmailReplies: 0,
  gmailError: null,
  ...over,
});

const config = (over = {}) => expiredConfig({
  PARAAI_EXPIRED_APPROVED: "true",
  PARAAI_EXPIRED_DRY_RUN: "false",
  PARAAI_EXPIRED_NOT_BEFORE: "2026-07-01T00:00:00.000Z",
  PARAAI_EXPIRED_DISMISS_APPROVED: "true",
  ...over,
});

const plan = (over = {}, evidenceOver = {}, configOver = {}, claim = null) => planExpiredRow(
  row(over),
  evidence(evidenceOver),
  { config: config(configOver), now: NOW, claim },
);

// ------------------------------------------------------------------ gates

// The store check reads real deployment env at import, so gate-ladder cases
// resolve it explicitly; that it fails closed when absent is asserted first.
const withStore = (over) => ({ ...expiredConfig(over), storeConfigured: true });

test("an unconfigured store fails closed before any gate is consulted", () => {
  const bare = expiredConfig({});
  assert.equal(bare.approved, false);
  assert.equal(bare.dryRun, true, "an unset dry-run flag must mean dry run");
  assert.equal(bare.notBeforeMs, null);
  assert.equal(bare.storeConfigured, false);
  assert.equal(expiredDetectionEnabled(bare), false);
  assert.equal(expiredWriteEnabled(bare), false);

  // Fully approved but no durable store: still nothing runs, because without
  // records the freeze rule and the claim cannot hold.
  assert.equal(expiredDetectionEnabled(expiredConfig({
    PARAAI_EXPIRED_APPROVED: "true",
    PARAAI_EXPIRED_DRY_RUN: "false",
    PARAAI_EXPIRED_NOT_BEFORE: "2026-07-01T00:00:00.000Z",
    PARAAI_EXPIRED_DISMISS_APPROVED: "true",
  })), false);
});

test("every gate fails closed, and dry-run is closed by absence", () => {
  assert.equal(expiredDetectionEnabled(withStore({})), false, "unapproved means nothing runs");

  // Approved but never pinned: reads and plans, never writes.
  const unpinned = withStore({
    PARAAI_EXPIRED_APPROVED: "true",
    PARAAI_EXPIRED_DRY_RUN: "false",
    PARAAI_EXPIRED_DISMISS_APPROVED: "true",
  });
  assert.equal(expiredDetectionEnabled(unpinned), true);
  assert.equal(expiredWriteEnabled(unpinned), false, "no arming pin means no writes");

  // Pinned and approved but dry-run unset: shadow mode, the burn-in state.
  const shadow = withStore({
    PARAAI_EXPIRED_APPROVED: "true",
    PARAAI_EXPIRED_NOT_BEFORE: "2026-07-01T00:00:00.000Z",
    PARAAI_EXPIRED_DISMISS_APPROVED: "true",
  });
  assert.equal(expiredShadowMode(shadow), true);
  assert.equal(expiredWriteEnabled(shadow), false);

  // Live only when all four agree.
  const armed = withStore({
    PARAAI_EXPIRED_APPROVED: "true",
    PARAAI_EXPIRED_DRY_RUN: "false",
    PARAAI_EXPIRED_NOT_BEFORE: "2026-07-01T00:00:00.000Z",
    PARAAI_EXPIRED_DISMISS_APPROVED: "true",
  });
  assert.equal(expiredWriteEnabled(armed), true);
  assert.equal(expiredShadowMode(armed), false);

  // The single write gate closing is enough to stop the lane on its own.
  assert.equal(expiredWriteEnabled({ ...armed, dismissApproved: false }), false);
});

test("defaults are the ratified ones", () => {
  const settings = expiredConfig({});
  assert.equal(settings.batchSize, 5);
  assert.equal(settings.dailyCap, 20);
  assert.equal(settings.pollLockSeconds, 3600);
  assert.equal(settings.holdHours, 0, "as soon as they are expired");
  assert.equal(settings.requireReachedOut, true);
});

// ----------------------------------------------------------------- policy

test("a clean expired row with recorded outreach is dismissed as no response", () => {
  const decision = plan();
  assert.equal(decision.action, "dismiss");
  assert.equal(decision.reasonKey, "no_response");
});

// The load-bearing guard: the sweep must never tell a hiring manager the
// candidate went quiet when Raydar holds a reply from them.
test("a candidate who replied on Gmail is never dismissed as unresponsive", () => {
  const decision = plan({}, { gmailReplies: 1 });
  assert.equal(decision.action, "review");
  assert.equal(decision.resolution, "candidate_replied");
});

test("a reply-lane record on the candidate also blocks the dismissal", () => {
  const decision = plan({}, { replyRecords: [{ replyId: "cu-1:msg", status: "needs_review", action: "submit" }] });
  assert.equal(decision.action, "review");
  assert.equal(decision.resolution, "candidate_replied");
});

// Paraform's own reached_out_to_candidate flag is the contact evidence. Without
// it we cannot claim they failed to get back.
test("a candidate we never contacted goes to review rather than getting a false reason", () => {
  const decision = plan({ reached_out_to_candidate: false }, { reachedOut: false });
  assert.equal(decision.action, "review");
  assert.equal(decision.resolution, "never_contacted");
});

test("the never-contacted guard can be relaxed deliberately, not accidentally", () => {
  const decision = plan(
    { reached_out_to_candidate: false },
    { reachedOut: false },
    { PARAAI_EXPIRED_REQUIRE_REACHED_OUT: "false" },
  );
  assert.equal(decision.action, "dismiss");
});

// A Gmail outage must not authorise a dismissal, and must not burn the row
// either: hold is a retry, not a decision.
test("unavailable contact evidence holds instead of dismissing", () => {
  const decision = plan({}, { gmailError: "gmail_unavailable" });
  assert.equal(decision.action, "hold");
  assert.equal(decision.resolution, "contact_evidence_unavailable");
});

test("a request already claimed by the reply lane is skipped, never re-actioned", () => {
  const decision = plan({}, {}, {}, { action: "pass", lane: "reply" });
  assert.equal(decision.action, "skip");
  assert.equal(decision.resolution, "claimed_by_another_lane");
});

// Forward-only arming: switching the lane on observes the backlog, and the
// operator backfill is the only way past the pin.
test("a row that expired before the arming pin is observed but never actioned", () => {
  const decision = plan({}, {}, { PARAAI_EXPIRED_NOT_BEFORE: "2026-08-01T00:00:00.000Z" });
  assert.equal(decision.action, "observe");
  assert.equal(decision.resolution, "expired_before_pin");
});

test("the optional hold window delays the write without changing the decision", () => {
  // Row expired 2026-07-28T22:47Z; NOW is 2026-07-29T00:00Z, about 1.2h later.
  const held = plan({}, {}, { PARAAI_EXPIRED_HOLD_HOURS: "24" });
  assert.equal(held.action, "hold");
  assert.equal(held.resolution, "hold_window");

  const elapsed = plan({}, {}, { PARAAI_EXPIRED_HOLD_HOURS: "1" });
  assert.equal(elapsed.action, "dismiss");
});

// Ordering matters: a reply outranks every pacing rule, because pacing only
// decides when to act and the reply decides whether the claim is even true.
test("a reply beats the hold window and the arming pin", () => {
  const decision = plan({}, { gmailReplies: 2 }, {
    PARAAI_EXPIRED_HOLD_HOURS: "48",
    PARAAI_EXPIRED_NOT_BEFORE: "2026-08-01T00:00:00.000Z",
  });
  assert.equal(decision.action, "review");
  assert.equal(decision.resolution, "candidate_replied");
});
