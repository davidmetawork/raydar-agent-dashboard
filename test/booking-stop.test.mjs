// Regression suite for the stop-on-booking control (2026-07-26 incident).
// Every test here corresponds to a specific way the n8n predecessor failed.
process.env.PARAFORM_COOKIE ||= "Fe26.2**test-cookie";
process.env.CALENDLY_API_TOKEN ||= "test-calendly-token";

import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

import { verifyCalendlyWebhook, parseSignatureHeader, calendlyWebhookEvent } from "../api/seq/_lib/calendly-webhook.mjs";
import { handleCalendlyWebhook } from "../api/seq/calendly-hook.mjs";
import {
  DEFAULT_SEQ_KEYS,
  isNudgeSequence,
  leadAddresses,
  decideLead,
  normEmail,
  runBookingSweep,
  SWEEP_STALE_AFTER_MS,
} from "../api/seq/_lib/booking-stop.mjs";
import { campaignLeads } from "../api/seq/_lib/core.mjs";
import { withThrottleRetry } from "../api/seq/_lib/booking-stop.mjs";
import { completeCampaignLeads } from "../api/seq/_lib/booking-stop.mjs";

const SECRET = "test-signing-key";

function signed(body, { secret = SECRET, at = Date.now() } = {}) {
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  const t = Math.floor(at / 1000);
  const v1 = createHmac("sha256", secret).update(`${t}.${raw}`).digest("hex");
  return { raw, headers: new Headers({ "calendly-webhook-signature": `t=${t},v1=${v1}` }) };
}

const req = (raw, headers, method = "POST") =>
  new Request("https://monitor.raydar.xyz/api/seq/calendly-hook", { method, headers, body: raw });

// ─────────────────────────────────────────────────────────────────────────────
// Signature verification — the endpoint is public, HMAC is the only gate.
// ─────────────────────────────────────────────────────────────────────────────

test("signature header parses t and every v1 candidate", () => {
  assert.deepEqual(parseSignatureHeader("t=123,v1=abc"), { t: "123", v1: ["abc"] });
  assert.deepEqual(parseSignatureHeader("t=1,v1=aa,v1=bb").v1, ["aa", "bb"]);
  assert.deepEqual(parseSignatureHeader(""), { t: "", v1: [] });
});

test("a correctly signed payload verifies", () => {
  const { raw, headers } = signed({ event: "invitee.created" });
  assert.doesNotThrow(() => verifyCalendlyWebhook({ secret: SECRET, headers, payload: raw }));
});

test("a tampered body fails verification", () => {
  const { headers } = signed({ event: "invitee.created", payload: { email: "real@example.com" } });
  assert.throws(
    () => verifyCalendlyWebhook({
      secret: SECRET,
      headers,
      payload: JSON.stringify({ event: "invitee.created", payload: { email: "attacker@example.com" } }),
    }),
    (e) => e.code === "CALENDLY_SIGNATURE_INVALID"
  );
});

test("a stale timestamp is rejected (replay protection)", () => {
  const { raw, headers } = signed({ event: "invitee.created" }, { at: Date.now() - 20 * 60 * 1000 });
  assert.throws(
    () => verifyCalendlyWebhook({ secret: SECRET, headers, payload: raw }),
    (e) => e.code === "CALENDLY_TIMESTAMP_STALE"
  );
});

test("a missing or malformed header is rejected, and a missing secret fails closed", () => {
  assert.throws(
    () => verifyCalendlyWebhook({ secret: SECRET, headers: new Headers(), payload: "{}" }),
    (e) => e.code === "CALENDLY_SIGNATURE_MISSING"
  );
  assert.throws(
    () => verifyCalendlyWebhook({ secret: SECRET, headers: new Headers({ "calendly-webhook-signature": "garbage" }), payload: "{}" }),
    (e) => e.code === "CALENDLY_SIGNATURE_MALFORMED"
  );
  const { raw, headers } = signed({});
  assert.throws(
    () => verifyCalendlyWebhook({ secret: "", headers, payload: raw }),
    (e) => e.code === "CALENDLY_SECRET_MISSING"
  );
});

test("an unsigned request gets a bare 401 and never reaches the pause path", async () => {
  let called = 0;
  const res = await handleCalendlyWebhook(req(JSON.stringify({ event: "invitee.created" }), new Headers()), {
    secret: SECRET,
    pause: async () => { called++; return { decisions: [], paused: 0, pauseErrors: [] }; },
    alert: async () => true,
  });
  assert.equal(res.status, 401);
  assert.equal(called, 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// THE REGRESSION GUARD. The predecessor called getCampaignLeads with no cursor
// and saw 50 of 211 leads — 78% of the family was structurally invisible, and
// the incident candidate sat at index 186. Membership reads paginate. Always.
// ─────────────────────────────────────────────────────────────────────────────

test("membership read paginates to the end of a 211-lead sequence", async () => {
  const TOTAL = 211;
  const all = Array.from({ length: TOTAL }, (_, i) => ({
    ccu_id: `ccu-${i}`, cu_id: `cu-${i}`, name: `Person ${i}`,
    to_use_email: `p${i}@example.com`, created_at: "2026-07-17T16:04:00.000Z",
    is_paused: false, is_archived: false,
  }));
  const cursorsSeen = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const input = JSON.parse(decodeURIComponent(String(url).split("input=")[1]));
    const cursor = input.json.cursor ?? 0;
    cursorsSeen.push(cursor);
    return new Response(JSON.stringify({
      result: { data: { json: { leads: all.slice(cursor, cursor + 50), totalCount: TOTAL } } },
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const leads = await campaignLeads("seq-1", { strict: true });
    assert.equal(leads.length, TOTAL, "must return every lead, not just page 1");
    assert.ok(leads.some((l) => l.ccu_id === "ccu-186"), "the lead at index 186 must be reachable");
    assert.ok(cursorsSeen.length > 1, "must issue more than one page request");
  } finally {
    globalThis.fetch = realFetch;
  }
});

// Second, nastier pagination bug: getCampaignLeads offsets over a non-injective
// ordering, so a *correct-looking* paginated walk still skips rows. Measured on a
// real 211-lead sequence: stride 50 -> 193 distinct. Overlapping windows fix it.
test("complete read recovers leads that offset paging skips", async () => {
  const TOTAL = 211;
  const all = Array.from({ length: TOTAL }, (_, i) => ({ ccu_id: `ccu-${i}`, cu_id: `cu-${i}` }));
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const input = JSON.parse(decodeURIComponent(String(url).split("input=")[1]));
    const cursor = input.json.cursor ?? 0;
    // Emulate the real defect. The server orders on a non-unique key, so a full
    // window can return a DUPLICATE in place of a row that then appears in no
    // window at all: the caller still counts 50 rows and 211 total, and never
    // notices it is short. (Measured on the real API: 211 rows, 193 distinct.)
    // Stepping by less than a page re-exposes the lost row mid-window.
    const slice = all.slice(cursor, cursor + 50);
    const window = slice.length === 50 ? [...slice.slice(0, 49), slice[0]] : slice;
    return new Response(JSON.stringify({ result: { data: { json: { leads: window, totalCount: TOTAL } } } }),
      { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const naive = await campaignLeads("seq-1");
    const complete = await completeCampaignLeads("seq-1");
    const naiveUnique = new Set(naive.map((l) => l.ccu_id));
    assert.ok(naiveUnique.size < TOTAL, "the naive reader must demonstrably miss rows");
    const missedByNaive = all.map((l) => l.ccu_id).filter((id) => !naiveUnique.has(id));
    assert.ok(missedByNaive.length > 0);
    assert.equal(complete.unique, TOTAL, "the complete reader must recover every lead");
    const recovered = new Set(complete.leads.map((l) => l.ccu_id));
    for (const id of missedByNaive) assert.ok(recovered.has(id), `${id} must be recovered`);
    assert.equal(complete.complete, true);
    assert.equal(complete.shortfall, 0);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("a genuinely short membership read is reported, never silently accepted", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ result: { data: { json: { leads: [{ ccu_id: "only-one", cu_id: "c1" }], totalCount: 100 } } } }),
      { status: 200, headers: { "content-type": "application/json" } });
  try {
    const r = await completeCampaignLeads("seq-1");
    assert.equal(r.complete, false, "must not claim completeness");
    assert.ok(r.shortfall > 90);
  } finally {
    globalThis.fetch = realFetch;
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Decision rules
// ─────────────────────────────────────────────────────────────────────────────

const SEQ = { id: "seq-1", name: "No Scheduled Call - Raydar - 1st Round Interview - Product Designer" };
const baseLead = {
  ccu_id: "ccu-1", cu_id: "cu-1", name: "Test Person",
  to_use_email: "sent-to@example.com", user_emails: ["sent-to@example.com"],
  created_at: "2026-07-17T16:04:00.000Z", is_paused: false, is_archived: false,
};

test("new-bookings-only: a booking BEFORE enrollment never pauses", () => {
  const before = { bookedAt: Date.parse("2026-07-10T00:00:00Z"), startsAt: null, eventName: "Intro Call", status: "active" };
  assert.equal(decideLead({ lead: baseLead, seq: SEQ, booking: before, relStatus: null }), null);
});

test("new-bookings-only: a booking AFTER enrollment pauses, with evidence", () => {
  const after = { bookedAt: Date.parse("2026-07-24T00:24:44Z"), startsAt: "2026-07-31T16:30:00Z", eventName: "Intro Call", status: "active" };
  const d = decideLead({ lead: baseLead, seq: SEQ, booking: after, relStatus: null });
  assert.ok(d, "must produce a decision");
  assert.equal(d.source, "calendly");
  assert.equal(d.ccuId, "ccu-1");
  assert.match(d.evidence, /booked .* > enrolled/);
});

test("already-paused and archived leads are left alone (idempotent, never unpauses)", () => {
  const after = { bookedAt: Date.parse("2026-07-24T00:00:00Z"), startsAt: null, eventName: "x", status: "active" };
  assert.equal(decideLead({ lead: { ...baseLead, is_paused: true }, seq: SEQ, booking: after, relStatus: null }), null);
    assert.equal(decideLead({ lead: { ...baseLead, is_archived: true }, seq: SEQ, booking: after, relStatus: null }), null);
});

test("the Paraform Book Time path is detected too, via relationship status", () => {
  const d = decideLead({
    lead: baseLead, seq: SEQ, booking: null,
    relStatus: { status: "SCHEDULED_CALL", at: "2026-07-24T01:55:15Z", emails: [] },
  });
  assert.ok(d);
  assert.equal(d.source, "paraform_status");
});

test("a stale relationship status (set before enrollment) does not pause", () => {
  assert.equal(decideLead({
    lead: baseLead, seq: SEQ, booking: null,
    relStatus: { status: "SCHEDULED_CALL", at: "2026-07-01T00:00:00Z", emails: [] },
  }), null);
});

// The n8n version matched to_use_email ONLY. 13 real people book from a
// different mailbox than the one their sequence targets; they were unmatchable.
test("address-set matching finds a candidate who booked from a different mailbox", () => {
  const lead = { ...baseLead, to_use_email: "work@company.com", user_emails: ["work@company.com"] };
  const profile = { emails: ["personal@gmail.com"] };
  const addrs = leadAddresses(lead, profile);
  assert.ok(addrs.has("work@company.com"));
  assert.ok(addrs.has("personal@gmail.com"), "profile addresses must be included");
  assert.equal(normEmail("  Personal@GMAIL.com "), "personal@gmail.com");
});

test("sequence family matching covers every role variant, OLD, and the followups", () => {
  const covered = [
    "No Scheduled Call - Raydar - 1st Round Interview",
    "No Scheduled Call - Raydar - 1st Round Interview - Product Designer",
    "OLD No Scheduled Call - Raydar - 1st Round Interview",
    "No Show - Agent Call",
    "Audio Failed - Agent Call",
    "Reschedule Human Call",
    "(2+) Agent Call Follow Up - Curated List",
  ];
  for (const name of covered) assert.ok(isNudgeSequence({ name }), `${name} must be covered`);
  // Client sourcing outreach and Para AI match notifications are deliberately out.
  for (const name of ["Firecrawl - In-House Counsel", "(1) New Matches - Added to Para AI"]) {
    assert.equal(isNudgeSequence({ name }), false, `${name} must NOT be covered`);
  }
  assert.ok(DEFAULT_SEQ_KEYS.length >= 7);
});

// Paraform answers 401 to a burst on a perfectly healthy session (measured:
// 40 concurrent profile reads -> 13x401). core.mjs maps every 401 to
// AUTH_EXPIRED and throws without retrying, which silently voided 780/945
// reads and later aborted a half-applied pause batch. Both paths now retry.
test("a throttling 401 is retried, not mistaken for an expired session", async () => {
  let calls = 0, throttles = 0;
  const value = await withThrottleRetry(async () => {
    calls++;
    if (calls < 3) { const e = new Error("AUTH_EXPIRED"); e.code = "AUTH_EXPIRED"; throw e; }
    return "ok";
  }, { onThrottle: () => { throttles++; } });
  assert.equal(value, "ok");
  assert.equal(calls, 3, "must retry through transient 401s");
  assert.equal(throttles, 2, "each retry must be counted, not hidden");
});

test("a persistent 401 still surfaces as AUTH_EXPIRED once retries are spent", async () => {
  await assert.rejects(
    () => withThrottleRetry(async () => { const e = new Error("AUTH_EXPIRED"); e.code = "AUTH_EXPIRED"; throw e; }),
    (e) => e.code === "AUTH_EXPIRED"
  );
});

test("a non-auth error is not retried", async () => {
  let calls = 0;
  await assert.rejects(() => withThrottleRetry(async () => { calls++; throw new Error("boom"); }));
  assert.equal(calls, 1);
});

// ─────────────────────────────────────────────────────────────────────────────
// Webhook behaviour
// ─────────────────────────────────────────────────────────────────────────────

test("invitee.canceled records and alerts but NEVER unpauses", async () => {
  let paused = 0;
  const alerts = [];
  const body = { event: "invitee.canceled", payload: { uri: "https://api.calendly.com/i/1", email: "x@example.com" } };
  const { raw, headers } = signed(body);
  const res = await handleCalendlyWebhook(req(raw, headers), {
    secret: SECRET,
    pause: async () => { paused++; return { decisions: [], paused: 1, pauseErrors: [] }; },
    alert: async (t) => { alerts.push(t); return true; },
  });
  assert.equal(res.status, 202);
  assert.equal(paused, 0, "cancellation must never touch the pause path");
  assert.match(alerts.join(" "), /never auto-resumed/i);
});

test("invitee.created pauses via the booking path and reports counts only", async () => {
  const body = {
    event: "invitee.created",
    payload: {
      uri: "https://api.calendly.com/i/2",
      email: "Booked@Example.com",
      created_at: "2026-07-24T00:24:44.730Z",
      scheduled_event: { start_time: "2026-07-31T16:30:00Z", name: "Intro Call" },
    },
  };
  const { raw, headers } = signed(body);
  let seen = null;
  const res = await handleCalendlyWebhook(req(raw, headers), {
    secret: SECRET,
    pause: async (args) => { seen = args; return { decisions: [{}], paused: 1, pauseErrors: [] }; },
    alert: async () => true,
    hasParaformCookie: () => true,
  });
  const payload = await res.json();
  assert.equal(res.status, 202);
  assert.equal(payload.paused, 1);
  assert.equal(seen.email, "booked@example.com", "email must be normalised");
  assert.equal(seen.bookedAt, "2026-07-24T00:24:44.730Z");
  // Response must never carry candidate detail.
  assert.equal(JSON.stringify(payload).includes("example.com"), false);
});

test("unrelated event kinds are ignored without touching Paraform", async () => {
  const { raw, headers } = signed({ event: "routing_form_submission.created", payload: {} });
  let called = 0;
  const res = await handleCalendlyWebhook(req(raw, headers), {
    secret: SECRET,
    pause: async () => { called++; return { decisions: [], paused: 0, pauseErrors: [] }; },
    alert: async () => true,
  });
  assert.equal((await res.json()).ignored, true);
  assert.equal(called, 0);
});

test("payload normalisation pulls the fields the decision needs", () => {
  const e = calendlyWebhookEvent({
    event: "invitee.created",
    payload: {
      uri: "u", email: "A@B.com", created_at: "2026-07-24T00:00:00Z",
      scheduled_event: { uri: "ev", start_time: "2026-07-31T16:30:00Z", name: "Intro Call" },
    },
  });
  assert.equal(e.email, "a@b.com");
  assert.equal(e.startsAt, "2026-07-31T16:30:00Z");
  assert.equal(e.eventUri, "ev");
});

// ─────────────────────────────────────────────────────────────────────────────
// Liveness. Two n8n runs (2026-07-10, 07-11) returned activeLeads:0 and were
// recorded as SUCCESSES. A zero-lead pass is a broken read, not an empty pipeline.
// ─────────────────────────────────────────────────────────────────────────────

test("a sweep that sees zero active leads FAILS instead of reporting success", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    const body = u.includes("/users/me")
      ? { resource: { current_organization: "https://api.calendly.com/organizations/o" } }
      : u.includes("scheduled_events")
        ? { collection: [], pagination: { next_page: null } }
        : u.includes("getListOfCampaignsOptimized")
          ? { result: { data: { json: [] } } } // no sequences -> no leads
          : { result: { data: { json: { leads: [], totalCount: 0 } } } };
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const r = await runBookingSweep({ apply: false });
    assert.equal(r.ok, false, "must not report ok");
    assert.equal(r.error, "zero_active_leads");
    assert.equal(r.paused, 0);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("staleness threshold is hours, not days — a dead sweep must surface same-day", () => {
  assert.ok(SWEEP_STALE_AFTER_MS <= 6 * 3600 * 1000, "must catch a dead sweep within hours");
  assert.ok(SWEEP_STALE_AFTER_MS >= 3600 * 1000, "but not alert on a single missed tick");
});
