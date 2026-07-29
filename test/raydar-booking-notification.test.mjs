import assert from "node:assert/strict";
import test from "node:test";

import {
  notifyRaydarBookingEvent,
  raydarBookingNotificationMode,
  renderRaydarBookingNotification,
} from "../api/seq/_lib/raydar-booking-notification.mjs";

const NOW = Date.parse("2026-07-29T18:00:00.000Z");
const APPLY_ENV = {
  RAYDAR_SCHEDULER_NOTIFICATION_ENABLED: "1",
  RAYDAR_SCHEDULER_NOTIFICATION_APPLY: "1",
  RAYDAR_SCHEDULER_NOTIFICATION_NOT_BEFORE:
    "2026-07-29T17:00:00.000Z",
};

function event(overrides = {}) {
  return {
    schema: "raydar-booking-event-v1",
    event: "booking.confirmed",
    eventId: "bevt_test_notification",
    occurredAt: "2026-07-29T17:59:00.000Z",
    bookingId: "bk_test_notification",
    callType: "agent",
    candidate: {
      email: "candidate@example.test",
      name: "Synthetic Candidate",
    },
    startsAt: "2026-07-30T18:00:00.000Z",
    endsAt: "2026-07-30T18:15:00.000Z",
    bookedAt: "2026-07-29T17:59:00.000Z",
    status: "confirmed",
    supersedesBookingId: null,
    ...overrides,
  };
}

test("notification writes are disabled and dry-run until independently armed", () => {
  assert.equal(raydarBookingNotificationMode({ env: {}, nowMs: NOW }), "disabled");
  assert.equal(raydarBookingNotificationMode({
    env: { RAYDAR_SCHEDULER_NOTIFICATION_ENABLED: "1" },
    nowMs: NOW,
  }), "dry-run");
  assert.throws(
    () => raydarBookingNotificationMode({
      env: {
        ...APPLY_ENV,
        RAYDAR_SCHEDULER_NOTIFICATION_NOT_BEFORE:
          "2026-07-30T00:00:00.000Z",
      },
      nowMs: NOW,
    }),
    /RAYDAR_BOOKING_NOTIFICATION_NOT_ARMED/u,
  );
});

test("copy names Raydar and call type but never private assignee or email", () => {
  for (const callType of ["agent", "human"]) {
    const text = renderRaydarBookingNotification(event({ callType }));
    assert.match(text, /Raydar/u);
    assert.match(text, new RegExp(callType, "iu"));
    assert.doesNotMatch(
      text,
      /David|Alzen|Vanessa|candidate@example/iu,
    );
  }
  const escaped = renderRaydarBookingNotification(event({
    candidate: {
      email: "candidate@example.test",
      name: "<!channel> & Candidate",
    },
  }));
  assert.doesNotMatch(escaped, /<!channel>/u);
  assert.match(escaped, /&lt;!channel&gt; &amp; Candidate/u);
});

test("one event is claimed, sent, settled, and then deduped", async () => {
  let state = null;
  let sends = 0;
  const deps = {
    env: APPLY_ENV,
    nowMs: NOW,
    claim: async (_key, value) => {
      if (state) return null;
      state = value;
      return "OK";
    },
    read: async () => state,
    write: async (_key, value) => {
      state = value;
      return "OK";
    },
    send: async () => {
      sends += 1;
      return true;
    },
  };
  const first = await notifyRaydarBookingEvent(event(), deps);
  const second = await notifyRaydarBookingEvent(event(), deps);
  assert.deepEqual(first, { ok: true, status: "sent" });
  assert.deepEqual(second, { ok: true, status: "duplicate" });
  assert.equal(sends, 1);
  assert.equal(state.state, "done");
  assert.doesNotMatch(JSON.stringify(state), /candidate@example/u);
});

test("unknown send outcomes are terminal while definitive failures retry", async () => {
  let unknownState = null;
  let unknownSends = 0;
  const unknownDeps = {
    env: APPLY_ENV,
    nowMs: NOW,
    claim: async (_key, value) => {
      if (unknownState) return null;
      unknownState = value;
      return "OK";
    },
    read: async () => unknownState,
    write: async (_key, value) => {
      unknownState = value;
      return "OK";
    },
    send: async () => {
      unknownSends += 1;
      throw new Error("timeout after write");
    },
  };
  assert.deepEqual(
    await notifyRaydarBookingEvent(event(), unknownDeps),
    { ok: true, status: "unknown" },
  );
  assert.deepEqual(
    await notifyRaydarBookingEvent(event(), unknownDeps),
    { ok: true, status: "unknown" },
  );
  assert.equal(unknownSends, 1);

  let failedState = null;
  let failedSends = 0;
  const failedDeps = {
    ...unknownDeps,
    claim: async (_key, value) => {
      if (failedState) return null;
      failedState = value;
      return "OK";
    },
    read: async () => failedState,
    write: async (_key, value) => {
      failedState = value;
      return "OK";
    },
    send: async () => {
      failedSends += 1;
      return failedSends > 1;
    },
  };
  assert.deepEqual(
    await notifyRaydarBookingEvent(event(), failedDeps),
    { ok: false, status: "failed" },
  );
  assert.deepEqual(
    await notifyRaydarBookingEvent(event(), failedDeps),
    { ok: true, status: "sent" },
  );
  assert.equal(failedSends, 2);
});
