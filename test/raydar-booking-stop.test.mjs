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
    apply: true,
    hasParaformCookie: () => true,
    storeConfigured: () => true,
    claim: async () => "OK",
    readClaim: async () => null,
    write: async () => "OK",
    pause: async () => ({
      decisions: [],
      paused: 0,
      pauseErrors: [],
      deferred: false,
    }),
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
  assert.equal(normalized.effectiveBookedAtMs, Date.parse("2026-07-29T17:59:00.000Z"));

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
});

test("native index item accepts only the pinned current-booking summary", () => {
  const normalized = normalizeRaydarBookingIndexItem(indexBooking());
  assert.equal(normalized.bookingId, "bk_test_001");
  assert.equal(normalized.bookedAtMs, Date.parse("2026-07-29T17:59:00.000Z"));

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
});

test("confirmed native events use the native pause source and return counts only", async () => {
  let seen = null;
  const response = await handleRaydarBookingWebhook(
    signedRequest(booking()),
    handlerDeps({
      pause: async (args) => {
        seen = args;
        return { decisions: [{}], paused: 1, pauseErrors: [], deferred: false };
      },
    }),
  );
  const payload = await response.json();
  assert.equal(response.status, 202);
  assert.equal(payload.paused, 1);
  assert.equal(seen.source, "raydar_scheduler");
  assert.equal(seen.email, "candidate@example.com");
  assert.equal(JSON.stringify(payload).includes("candidate@example.com"), false);
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
  let pauseCalls = 0;
  const response = await handleRaydarBookingWebhook(
    signedRequest(booking()),
    handlerDeps({
      claim: async () => null,
      readClaim: async () => ({
        state: "done",
        receivedAt: "2026-07-29T17:59:01.000Z",
      }),
      pause: async () => { pauseCalls++; },
    }),
  );
  assert.equal(response.status, 202);
  assert.equal((await response.json()).duplicate, true);
  assert.equal(pauseCalls, 0);
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

test("native webhook does not settle a partially failed pause", async () => {
  let settlementWrites = 0;
  const response = await handleRaydarBookingWebhook(
    signedRequest(booking()),
    handlerDeps({
      pause: async () => ({
        decisions: [{}, {}],
        paused: 1,
        pauseErrors: [{ reason: "readback_unavailable" }],
        deferred: false,
      }),
      write: async () => {
        settlementWrites++;
        return "OK";
      },
    }),
  );
  const payload = await response.json();
  assert.equal(response.status, 503);
  assert.equal(payload.error, "pause_incomplete");
  assert.equal(payload.pauseErrors, 1);
  assert.equal(settlementWrites, 0);
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
