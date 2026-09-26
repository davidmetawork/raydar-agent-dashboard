import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

import {
  RAYDAR_BOOKING_HOOK_PATH,
  normalizeRaydarBookingEvent,
  normalizeRaydarBookingIndexItem,
  verifyRaydarBookingWebhook,
} from "../api/seq/_lib/raydar-booking-contract.mjs";
import {
  fetchRaydarBookingIndex,
} from "../api/seq/_lib/raydar-booking-index.mjs";
import {
  campaignLeadBySearch,
} from "../api/seq/_lib/core.mjs";
import {
  bookedSetWithSources,
  decideLead,
} from "../api/seq/_lib/booking-stop.mjs";
import {
  handleRaydarBookingWebhook,
} from "../api/seq/raydar-booking-hook.mjs";

const SECRET = "raydar-booking-test-secret-that-is-long-enough";
const NOW_MS = Date.parse("2026-07-29T18:00:00.000Z");

function booking(overrides = {}) {
  return {
    schema: "raydar-booking-event-v1",
    event: "booking.confirmed",
    eventId: "bevt_test_001",
    occurredAt: "2026-07-29T17:59:00.000Z",
    bookingId: "bk_test_001",
    callType: "agent",
    candidate: { email: "candidate@example.com", name: "Test Candidate" },
    startsAt: "2026-07-30T18:00:00.000Z",
    endsAt: "2026-07-30T18:15:00.000Z",
    bookedAt: "2026-07-29T17:59:00.000Z",
    sourceAttribution: null,
    status: "confirmed",
    supersedesBookingId: null,
    ...overrides,
  };
}

function indexBooking(overrides = {}) {
  const event = booking(overrides);
  return {
    bookingId: event.bookingId,
    callType: event.callType,
    candidate: event.candidate,
    startsAt: event.startsAt,
    endsAt: event.endsAt,
    bookedAt: event.bookedAt,
    sourceAttribution: event.sourceAttribution,
    status: event.status,
    supersedesBookingId: event.supersedesBookingId,
  };
}

function signedRequest(body, {
  timestamp = String(Math.floor(NOW_MS / 1000)),
  eventId = body.eventId,
  signatureTransform = (value) => value,
} = {}) {
  const raw = JSON.stringify(body);
  const canonical = `${timestamp}\nPOST\n${RAYDAR_BOOKING_HOOK_PATH}\n${raw}`;
  const signature = signatureTransform(
    `v1=${createHmac("sha256", SECRET).update(canonical).digest("hex")}`,
  );
  return new Request(`https://monitor.raydar.xyz${RAYDAR_BOOKING_HOOK_PATH}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-raydar-timestamp": timestamp,
      "x-raydar-event-id": eventId,
      "x-raydar-signature": signature,
    },
    body: raw,
  });
}

function handlerDeps(overrides = {}) {
  return {
    enabled: true,
    secret: SECRET,
    storeConfigured: () => true,
    claim: async () => "OK",
    readClaim: async () => null,
    write: async () => "OK",
    // Lightweight redesign (2026-09-26): the hook only enqueues now. It never
    // calls Paraform and never writes the webhook/canary proof directly — the
    // background worker does both (booking-protection-worker.test.mjs).
    enqueue: async () => {},
    alert: async () => {},
    alertAllowed: async () => false,
    nowMs: NOW_MS,
    ...overrides,
  };
}

test("native booking HMAC binds timestamp, method, path, and exact raw body", () => {
  const body = booking();
  const request = signedRequest(body);
  const raw = JSON.stringify(body);
  assert.deepEqual(
    verifyRaydarBookingWebhook({
      secret: SECRET,
      headers: request.headers,
      rawBody: raw,
      expectedEventId: body.eventId,
      nowMs: NOW_MS,
    }),
    { timestampSeconds: NOW_MS / 1000, eventId: body.eventId },
  );

  assert.throws(
    () => verifyRaydarBookingWebhook({
      secret: SECRET,
      headers: request.headers,
      rawBody: `${raw} `,
      expectedEventId: body.eventId,
      nowMs: NOW_MS,
    }),
    (error) => error.code === "RAYDAR_BOOKING_SIGNATURE_INVALID",
  );
});

test("native booking signature rejects stale, uppercase, and body-mismatched event IDs", async () => {
  const body = booking();
  const stale = signedRequest(body, { timestamp: String(NOW_MS / 1000 - 301) });
  assert.equal((await handleRaydarBookingWebhook(stale, handlerDeps())).status, 401);

  const uppercase = signedRequest(body, {
    signatureTransform: (value) => value.toUpperCase(),
  });
  assert.equal((await handleRaydarBookingWebhook(uppercase, handlerDeps())).status, 401);

  const wrongEvent = signedRequest(body, { eventId: "bevt_other_001" });
  const wrongResponse = await handleRaydarBookingWebhook(wrongEvent, handlerDeps());
  assert.equal(wrongResponse.status, 400);
  assert.equal((await wrongResponse.json()).error, "RAYDAR_BOOKING_EVENT_ID_MISMATCH");
});

test("native event schema is exact and event/status pairs cannot drift", () => {
  const normalized = normalizeRaydarBookingEvent(booking());
  assert.equal(normalized.candidate.email, "candidate@example.com");
  assert.equal(normalized.sourceAttribution, null);
  assert.equal(normalized.effectiveBookedAtMs, Date.parse("2026-07-29T17:59:00.000Z"));

  assert.equal(
    normalizeRaydarBookingEvent(
      booking({ sourceAttribution: "paraform_sequence_agent" }),
    ).sourceAttribution,
    "paraform_sequence_agent",
  );
  const legacyShape = booking();
  delete legacyShape.sourceAttribution;
  assert.equal(
    normalizeRaydarBookingEvent(legacyShape).sourceAttribution,
    null,
  );
  for (const eventId of ["bevt_-Nr_base64url", "bevt__Ft_base64url"]) {
    assert.equal(normalizeRaydarBookingEvent(booking({ eventId })).eventId, eventId);
  }
  assert.throws(
    () => normalizeRaydarBookingEvent(booking({ bookingId: "bk_-invalid" })),
    (error) => error.code === "RAYDAR_BOOKING_ID_INVALID",
  );
  assert.throws(
    () => normalizeRaydarBookingEvent({ ...booking(), privateAssignee: "hidden" }),
    (error) => error.code === "RAYDAR_BOOKING_EVENT_INVALID",
  );
  assert.throws(
    () => normalizeRaydarBookingEvent({ ...booking(), status: "cancelled" }),
    (error) => error.code === "RAYDAR_BOOKING_STATUS_INVALID",
  );
  assert.throws(
    () => normalizeRaydarBookingEvent({
      ...booking(),
      candidate: { email: "Candidate@Example.com", name: null },
    }),
    (error) => error.code === "RAYDAR_BOOKING_EMAIL_INVALID",
  );
  for (const sourceAttribution of [
    "",
    " LinkedIn_InMail ",
    "candidate@example.com",
    "x".repeat(65),
  ]) {
    const value = booking({ sourceAttribution });
    assert.throws(
      () => normalizeRaydarBookingEvent(value),
      (error) =>
        error.code === "RAYDAR_BOOKING_SOURCE_ATTRIBUTION_INVALID",
    );
  }
});

test("native index item accepts only the pinned current-booking summary", () => {
  const normalized = normalizeRaydarBookingIndexItem(indexBooking({
    sourceAttribution: "linkedin_inmail",
  }));
  assert.equal(normalized.bookingId, "bk_test_001");
  assert.equal(normalized.sourceAttribution, "linkedin_inmail");
  assert.equal(normalized.bookedAtMs, Date.parse("2026-07-29T17:59:00.000Z"));

  const extended = {
    ...indexBooking(),
    candidate: {
      ...indexBooking().candidate,
      paraformCandidateUserId: `c${"a1".repeat(10)}`,
      paraformName: "Paraform Candidate",
    },
  };
  assert.equal(
    normalizeRaydarBookingIndexItem(extended).candidate.email,
    "candidate@example.com",
  );

  for (const candidate of [
    {
      ...indexBooking().candidate,
      paraformCandidateUserId: extended.candidate.paraformCandidateUserId,
    },
    { ...extended.candidate, unexpected: true },
    { ...extended.candidate, paraformCandidateUserId: "candidate-123" },
    { ...extended.candidate, paraformName: "\u0000Candidate" },
  ]) {
    assert.throws(
      () => normalizeRaydarBookingIndexItem(indexBooking({ candidate })),
      (error) => error.code === "RAYDAR_BOOKING_CANDIDATE_INVALID"
        || error.code === "RAYDAR_BOOKING_NAME_INVALID",
    );
  }

  assert.throws(
    () => normalizeRaydarBookingEvent(booking({
      candidate: extended.candidate,
    })),
    (error) => error.code === "RAYDAR_BOOKING_CANDIDATE_INVALID",
    "the signed webhook contract must stay on its original two-field shape",
  );

  assert.throws(
    () => normalizeRaydarBookingIndexItem({
      ...indexBooking(),
      schema: "raydar-booking-event-v1",
    }),
    (error) => error.code === "RAYDAR_BOOKING_INDEX_ITEM_INVALID",
  );
  assert.throws(
    () => normalizeRaydarBookingIndexItem({
      ...indexBooking(),
      status: "active",
    }),
    (error) => error.code === "RAYDAR_BOOKING_STATUS_INVALID",
  );
  assert.throws(
    () => normalizeRaydarBookingIndexItem({
      ...indexBooking(),
      sourceAttribution: "candidate@example.com",
    }),
    (error) =>
      error.code === "RAYDAR_BOOKING_SOURCE_ATTRIBUTION_INVALID",
  );
});

// Lightweight redesign (2026-09-26): the hook only validates, records, and
// enqueues — it never calls Paraform and never writes the webhook/pause-canary
// proof itself. Those two things (matching + pausing, and the proof they
// produce) now belong to the background worker; see
// booking-protection-worker.test.mjs for "signed scheduler event reaches the
// pause path", "confirmed webhook persists a secret-bound proof",
// "transport-only proof cannot masquerade as a canary", "a real non-canary
// pause cannot mint the canary proof", and "an unmatched booking updates
// transport proof without erasing canary readiness" — the direct
// descendants of the five tests this comment replaces.

test("signed scheduler event with source attribution is durably enqueued, not paused inline", async () => {
  const body = booking({ sourceAttribution: "paraform_sequence_agent" });
  let seen = null;
  const response = await handleRaydarBookingWebhook(
    signedRequest(body),
    handlerDeps({
      enqueue: async (job) => { seen = job; },
    }),
  );
  assert.equal(response.status, 202);
  assert.equal(seen?.email, "candidate@example.com");
  assert.equal(seen?.source, "raydar_scheduler");
  assert.equal(seen?.eventId, body.eventId);
});

test("confirmed native events are enqueued and the hook answers OK without ever calling Paraform", async () => {
  let seen = null;
  const response = await handleRaydarBookingWebhook(
    signedRequest(booking()),
    handlerDeps({
      enqueue: async (job) => { seen = job; },
    }),
  );
  const payload = await response.json();
  assert.equal(response.status, 202);
  assert.equal(payload.queued, true);
  assert.equal(seen.source, "raydar_scheduler");
  assert.equal(seen.email, "candidate@example.com");
  assert.equal(JSON.stringify(payload).includes("candidate@example.com"), false);
});

test("the hook still answers OK when enqueue would-be pause inputs (cookie-adjacent state) are irrelevant — it never checks Paraform state at all", async () => {
  // There is deliberately no hasParaformCookie/pause dependency left to stub:
  // removing that check is the fix for the original stalling bug (design doc
  // §"Right now it is down and still costing requests" / item 3).
  const response = await handleRaydarBookingWebhook(
    signedRequest(booking({ eventId: "bevt_no_cookie_check" })),
    handlerDeps(),
  );
  assert.equal(response.status, 202);
  assert.equal((await response.json()).queued, true);
});

test("rescheduled-away webhook is terminal history and never calls pause", async () => {
  const event = booking({
    event: "booking.rescheduled",
    eventId: "bevt_test_reschedule",
    occurredAt: "2026-07-29T17:59:30.000Z",
    bookedAt: "2026-07-01T10:00:00.000Z",
    status: "rescheduled",
    supersedesBookingId: "bk_test_old",
  });
  let pauseCalls = 0;
  const writes = [];
  const response = await handleRaydarBookingWebhook(
    signedRequest(event),
    handlerDeps({
      pause: async () => { pauseCalls++; },
      write: async (key, value) => {
        writes.push({ key, value });
        return "OK";
      },
    }),
  );
  const payload = await response.json();
  assert.equal(response.status, 202);
  assert.equal(payload.event, "booking.rescheduled");
  assert.equal(payload.recorded, true);
  assert.equal(pauseCalls, 0);
  assert.equal(
    writes.some((entry) => entry.value.event === "booking.rescheduled"),
    true,
  );
  assert.equal(writes.some((entry) => entry.value.state === "done"), true);
});

test("cancellation is recorded but never auto-unpauses or calls pause", async () => {
  const event = booking({
    event: "booking.cancelled",
    eventId: "bevt_test_cancel",
    status: "cancelled",
  });
  let pauseCalls = 0;
  const writes = [];
  const response = await handleRaydarBookingWebhook(
    signedRequest(event),
    handlerDeps({
      pause: async () => { pauseCalls++; },
      write: async (key, value) => { writes.push({ key, value }); return "OK"; },
    }),
  );
  assert.equal(response.status, 202);
  assert.equal(pauseCalls, 0);
  assert.equal(writes.length, 2);
  assert.equal(writes.some((entry) => entry.value.state === "done"), true);
});

test("durable replay returns duplicate only after a prior event reached done", async () => {
  let enqueueCalls = 0;
  const response = await handleRaydarBookingWebhook(
    signedRequest(booking()),
    handlerDeps({
      claim: async () => null,
      readClaim: async () => ({
        state: "done",
        receivedAt: "2026-07-29T17:59:01.000Z",
      }),
      enqueue: async () => { enqueueCalls++; },
    }),
  );
  assert.equal(response.status, 202);
  assert.equal((await response.json()).duplicate, true);
  assert.equal(enqueueCalls, 0);
});

test("native webhook fails closed when the durable replay store is unavailable", async () => {
  const response = await handleRaydarBookingWebhook(
    signedRequest(booking()),
    handlerDeps({
      claim: async () => {
        const error = new Error("KV_UNAVAILABLE");
        error.code = "KV_UNAVAILABLE";
        throw error;
      },
    }),
  );
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error, "store_unavailable");
});

// ─────────────────────────────────────────────────────────────────────────────
// Test/canary skip (item 3: "Skip Scheduler test/canary bookings"). The v1
// wire contract has no dedicated flag for this — see raydar-booking-hook.mjs's
// isTestOrCanaryBooking() comment — so this recognizes a reserved
// sourceAttribution marker and a configurable bookingId allow-list, both OFF
// by default (matching nothing unless configured).
// ─────────────────────────────────────────────────────────────────────────────

test("a booking tagged with a reserved test/canary sourceAttribution is recorded but never enqueued", async () => {
  let enqueueCalls = 0;
  const writes = [];
  const event = booking({ sourceAttribution: "scheduler_canary" });
  const response = await handleRaydarBookingWebhook(
    signedRequest(event),
    handlerDeps({
      enqueue: async () => { enqueueCalls++; },
      write: async (key, value) => { writes.push({ key, value }); return "OK"; },
    }),
  );
  const payload = await response.json();
  assert.equal(response.status, 202);
  assert.equal(payload.skippedTest, true);
  assert.equal(enqueueCalls, 0, "a canary-tagged booking must never reach the pause path");
  assert.equal(writes.some((entry) => entry.value.state === "done" && entry.value.skippedTest), true);
});

test("a booking whose id is in the configured test-booking-id allow-list is recorded but never enqueued", async () => {
  const prev = process.env.RAYDAR_BOOKING_TEST_BOOKING_IDS;
  process.env.RAYDAR_BOOKING_TEST_BOOKING_IDS = "bk_other,bk_test_001";
  try {
    let enqueueCalls = 0;
    const event = booking({ bookingId: "bk_test_001" });
    const response = await handleRaydarBookingWebhook(
      signedRequest(event),
      handlerDeps({ enqueue: async () => { enqueueCalls++; } }),
    );
    const payload = await response.json();
    assert.equal(response.status, 202);
    assert.equal(payload.skippedTest, true);
    assert.equal(enqueueCalls, 0);
  } finally {
    if (prev === undefined) delete process.env.RAYDAR_BOOKING_TEST_BOOKING_IDS;
    else process.env.RAYDAR_BOOKING_TEST_BOOKING_IDS = prev;
  }
});

test("an ordinary booking with an unrelated sourceAttribution is still enqueued (the skip list is not overly broad)", async () => {
  let seen = null;
  const event = booking({ sourceAttribution: "linkedin_inmail" });
  const response = await handleRaydarBookingWebhook(
    signedRequest(event),
    handlerDeps({ enqueue: async (job) => { seen = job; } }),
  );
  const payload = await response.json();
  assert.equal(response.status, 202);
  assert.equal(payload.skippedTest, undefined);
  assert.equal(seen?.eventId, event.eventId);
});

test("native webhook retries when durable settlement cannot be written", async () => {
  const response = await handleRaydarBookingWebhook(
    signedRequest(booking()),
    handlerDeps({
      write: async () => null,
    }),
  );
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error, "store_unavailable");
});

test("native index paginates completely, authenticates, and excludes terminal rows", async () => {
  const active = indexBooking();
  const cancelled = indexBooking({
    bookingId: "bk_test_002",
    candidate: { email: "cancelled@example.com", name: null },
    status: "cancelled",
  });
  const rescheduled = indexBooking({
    bookingId: "bk_test_003",
    candidate: { email: "rescheduled@example.com", name: null },
    status: "rescheduled",
  });
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url: String(url), options });
    const cursor = new URL(url).searchParams.get("cursor");
    const body = cursor
      ? {
        schema: "raydar-booking-index-v1",
        items: [cancelled, rescheduled],
        nextCursor: null,
        complete: true,
        generatedAt: "2026-07-29T18:00:00.000Z",
      }
      : {
        schema: "raydar-booking-index-v1",
        items: [active],
        nextCursor: "page_2",
        complete: true,
        generatedAt: "2026-07-29T18:00:00.000Z",
      };
    return Response.json(body);
  };
  const result = await fetchRaydarBookingIndex({
    fetchImpl,
    baseUrl: "https://book.raydar.xyz",
    readKey: "private-read-key",
    now: NOW_MS,
  });
  assert.equal(result.pages, 2);
  assert.equal(result.complete, true);
  assert.equal(result.active, 1);
  assert.equal(result.cancelled, 1);
  assert.equal(result.rescheduled, 1);
  assert.ok(result.index.has("candidate@example.com"));
  assert.equal(result.index.has("cancelled@example.com"), false);
  assert.equal(result.index.has("rescheduled@example.com"), false);
  assert.equal(requests[0].options.headers.authorization, "Bearer private-read-key");
  assert.equal(new URL(requests[0].url).searchParams.get("limit"), "100");
});

test("an incomplete native index throws instead of becoming an empty index", async () => {
  await assert.rejects(
    () => fetchRaydarBookingIndex({
      fetchImpl: async () => Response.json({
        schema: "raydar-booking-index-v1",
        items: [],
        nextCursor: null,
        complete: false,
        generatedAt: "2026-07-29T18:00:00.000Z",
      }),
      baseUrl: "https://book.raydar.xyz",
      readKey: "private-read-key",
      now: NOW_MS,
    }),
    (error) => error.code === "RAYDAR_BOOKING_INDEX_INCOMPLETE",
  );
});

test("native index rejects stale, future, and regressing page snapshots", async () => {
  for (const generatedAt of [
    "2026-07-29T17:54:59.999Z",
    "2026-07-29T18:05:00.001Z",
  ]) {
    await assert.rejects(
      () => fetchRaydarBookingIndex({
        fetchImpl: async () => Response.json({
          schema: "raydar-booking-index-v1",
          items: [],
          nextCursor: null,
          complete: true,
          generatedAt,
        }),
        baseUrl: "https://book.raydar.xyz",
        readKey: "private-read-key",
        now: NOW_MS,
      }),
      (error) => error.code === "RAYDAR_BOOKING_INDEX_TIME_INVALID",
    );
  }

  let page = 0;
  await assert.rejects(
    () => fetchRaydarBookingIndex({
      fetchImpl: async () => Response.json({
        schema: "raydar-booking-index-v1",
        items: [],
        nextCursor: page++ === 0 ? "page_2" : null,
        complete: true,
        generatedAt: page === 1
          ? "2026-07-29T18:00:00.000Z"
          : "2026-07-29T17:59:59.999Z",
      }),
      baseUrl: "https://book.raydar.xyz",
      readKey: "private-read-key",
      now: NOW_MS,
    }),
    (error) => error.code === "RAYDAR_BOOKING_INDEX_TIME_REGRESSION",
  );
});

test("native index rejects an omitted cursor field instead of assuming pagination ended", async () => {
  await assert.rejects(
    () => fetchRaydarBookingIndex({
      fetchImpl: async () => Response.json({
        schema: "raydar-booking-index-v1",
        items: [],
        complete: true,
        generatedAt: "2026-07-29T18:00:00.000Z",
      }),
      baseUrl: "https://book.raydar.xyz",
      readKey: "private-read-key",
      now: NOW_MS,
    }),
    (error) => error.code === "RAYDAR_BOOKING_INDEX_RESPONSE_INVALID",
  );
});

test("a new confirmed superseding row wins over immutable reschedule history", async () => {
  const old = indexBooking({
    bookingId: "bk_test_old",
    bookedAt: "2026-07-01T10:00:00.000Z",
    status: "rescheduled",
  });
  const current = indexBooking({
    bookingId: "bk_test_new",
    bookedAt: "2026-07-29T17:59:30.000Z",
    status: "confirmed",
    supersedesBookingId: "bk_test_old",
  });
  const result = await fetchRaydarBookingIndex({
    fetchImpl: async () => Response.json({
      schema: "raydar-booking-index-v1",
      items: [current, old],
      nextCursor: null,
      complete: true,
      generatedAt: "2026-07-29T18:00:00.000Z",
    }),
    baseUrl: "https://book.raydar.xyz",
    readKey: "private-read-key",
    now: NOW_MS,
  });
  assert.equal(result.index.get("candidate@example.com").bookingId, "bk_test_new");
  assert.equal(
    result.index.get("candidate@example.com").bookedAt,
    Date.parse("2026-07-29T17:59:30.000Z"),
  );
});

test("native booking evidence pauses decisions with first-party provenance", () => {
  const decision = decideLead({
    lead: {
      ccu_id: "ccu-1",
      cu_id: "cu-1",
      name: "Test",
      to_use_email: "candidate@example.com",
      created_at: "2026-07-29T17:00:00.000Z",
      is_paused: false,
      is_archived: false,
    },
    seq: { id: "seq-1", name: "Reschedule Agent Call" },
    booking: {
      bookedAt: Date.parse("2026-07-29T17:59:00.000Z"),
      startsAt: "2026-07-30T18:00:00.000Z",
      eventName: "Agent Call",
      status: "active",
      source: "raydar_scheduler",
    },
    relStatus: null,
  });
  assert.equal(decision.source, "raydar_scheduler");
  assert.match(decision.evidence, /^raydar scheduler /);
});

test("enroll-time gate includes native active bookings", async () => {
  const booked = await bookedSetWithSources(["cu-1"], {
    calendlyEnabled: false,
    raydarEnabled: true,
    raydarConfigured: true,
    raydarIndexLoader: async () => ({
      complete: true,
      index: new Map([[
        "candidate@example.com",
        { status: "active", bookedAt: NOW_MS, source: "raydar_scheduler" },
      ]]),
    }),
    profileLoader: async () => ({
      status: "CONTACTED",
      at: "2026-07-29T17:00:00.000Z",
      emails: ["candidate@example.com"],
    }),
  });
  assert.deepEqual([...booked], ["cu-1"]);
});

test("enroll-time gate fails closed on an incomplete native index", async () => {
  await assert.rejects(
    () => bookedSetWithSources(["cu-1"], {
      calendlyEnabled: false,
      raydarEnabled: true,
      raydarConfigured: true,
      raydarIndexLoader: async () => ({ complete: false, index: new Map() }),
      profileLoader: async () => ({ status: "CONTACTED", emails: [] }),
    }),
    (error) => error.code === "RAYDAR_BOOKING_INDEX_INCOMPLETE",
  );
});

test("enroll-time native gate fails closed when candidate profile transport fails", async () => {
  await assert.rejects(
    () => bookedSetWithSources(["cu-1"], {
      calendlyEnabled: false,
      raydarEnabled: true,
      raydarConfigured: true,
      raydarIndexLoader: async () => ({
        complete: true,
        index: new Map(),
      }),
      profileLoader: async () => {
        throw new Error("sensitive upstream detail");
      },
    }),
    (error) => (
      error.code === "RAYDAR_CANDIDATE_PROFILE_UNAVAILABLE"
      && error.message === "RAYDAR_CANDIDATE_PROFILE_UNAVAILABLE"
    ),
  );
});

test("enroll-time native gate fails closed when candidate profile is null", async () => {
  await assert.rejects(
    () => bookedSetWithSources(["cu-1"], {
      calendlyEnabled: false,
      raydarEnabled: true,
      raydarConfigured: true,
      raydarIndexLoader: async () => ({
        complete: true,
        index: new Map(),
      }),
      profileLoader: async () => null,
    }),
    (error) => error.code === "RAYDAR_CANDIDATE_PROFILE_UNAVAILABLE",
  );
});

test("legacy Calendly-only enrollment preserves best-effort profile reads", async () => {
  const booked = await bookedSetWithSources(["cu-1"], {
    calendlyEnabled: true,
    calendlyIndexLoader: async () => ({
      complete: true,
      index: new Map(),
    }),
    raydarEnabled: false,
    profileLoader: async () => {
      throw new Error("legacy source unavailable");
    },
  });
  assert.deepEqual([...booked], []);
});

test("pause readback selects the exact ccu_id instead of a fuzzy wrong-first row", async () => {
  const exact = await campaignLeadBySearch(
    "seq-1",
    "candidate@example.com",
    {
      expectedCcuId: "ccu-target",
      reader: async () => ({
        leads: [
          { ccu_id: "ccu-other", is_paused: true },
          { ccu_id: "ccu-target", is_paused: false },
        ],
      }),
    },
  );
  assert.equal(exact.ccu_id, "ccu-target");
  assert.equal(exact.is_paused, false);

  const missing = await campaignLeadBySearch(
    "seq-1",
    "candidate@example.com",
    {
      expectedCcuId: "ccu-missing",
      reader: async () => ({
        leads: [{ ccu_id: "ccu-other", is_paused: true }],
      }),
    },
  );
  assert.equal(missing, null);
});
