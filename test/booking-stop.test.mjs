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
  campaignHasCandidateSchedulingLink,
  calendlyBookingIndex,
  DEFAULT_SEQ_KEYS,
  discoverBookingStopSequences,
  isNudgeSequence,
  leadAddresses,
  decideLead,
  normEmail,
  runBookingSweep,
  sweepErrorLabel,
  SWEEP_STALE_AFTER_MS,
} from "../api/seq/_lib/booking-stop.mjs";
import { campaignLeads } from "../api/seq/_lib/core.mjs";
import { withThrottleRetry, isSessionActuallyExpired } from "../api/seq/_lib/booking-stop.mjs";
import { completeCampaignLeads, cronAuth, trpcGet } from "../api/seq/_lib/core.mjs";

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

test("membership read reaches every lead of a 211-lead sequence", async () => {
  const TOTAL = 211;
  const all = Array.from({ length: TOTAL }, (_, i) => ({
    ccu_id: `ccu-${i}`, cu_id: `cu-${i}`, name: `Person ${i}`,
    to_use_email: `p${i}@example.com`, created_at: "2026-07-17T16:04:00.000Z",
    is_paused: false, is_archived: false,
  }));
  const seen = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const input = JSON.parse(decodeURIComponent(String(url).split("input=")[1])).json;
    seen.push({ cursor: input.cursor ?? 0, limit: input.limit });
    const limit = input.limit || 50;
    return new Response(JSON.stringify({
      result: { data: { json: { leads: all.slice(input.cursor ?? 0, (input.cursor ?? 0) + limit), totalCount: TOTAL } } },
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const leads = await campaignLeads("seq-1", { strict: true });
    assert.equal(leads.length, TOTAL, "must return every lead");
    assert.ok(leads.some((l) => l.ccu_id === "ccu-186"), "the lead at index 186 must be reachable");
    assert.ok(seen.every((c) => c.limit), "every read must pin an explicit page size");
  } finally {
    globalThis.fetch = realFetch;
  }
});

// THE REGRESSION GUARD. getCampaignLeads orders on a non-unique key, so
// LIMIT/OFFSET across a tie block returns an arbitrary order per (cursor,limit)
// pair: rows repeat across page boundaries and others never surface, while
// totalCount still reads correct. Varying the CURSOR cannot escape it — the
// order is deterministic per (cursor,limit) — so the reader must vary PAGE SIZE.
test("varying page size escapes a tie block that a fixed page size cannot", async () => {
  const TOTAL = 240;
  const all = Array.from({ length: TOTAL }, (_, i) => ({ ccu_id: `ccu-${i}`, cu_id: `cu-${i}`, candidate_email: `p${i}@x.com` }));
  // Model the real behaviour: rows are shuffled deterministically by (limit),
  // so a given page size always exposes the same subset and hides the rest.
  const order = (limit) => {
    const idx = all.map((_, i) => i);
    return idx.sort((a, b) => ((a * limit) % 251) - ((b * limit) % 251));
  };
  const serve = (cursor, limit) => order(limit).slice(cursor, cursor + limit).map((i) => all[i]);
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const input = JSON.parse(decodeURIComponent(String(url).split("input=")[1])).json;
    if (String(url).includes("getListOfCampaigns?")) {
      return new Response(JSON.stringify({ result: { data: { json: [{ id: "seq-1", campaign_to_candidate_users: all.map((l) => ({ id: l.ccu_id, candidate_user_id: l.cu_id, candidate_email: l.candidate_email })) }] } } }),
        { status: 200, headers: { "content-type": "application/json" } });
    }
    if (input.search) {
      const hit = all.find((l) => l.candidate_email === input.search);
      return new Response(JSON.stringify({ result: { data: { json: { leads: hit ? [hit] : [], totalCount: hit ? 1 : 0 } } } }),
        { status: 200, headers: { "content-type": "application/json" } });
    }
    const limit = input.limit || 50;
    // The defect: a full window silently drops its tail, so any single page size
    // is short — but WHICH rows are lost depends on the page size.
    const win = serve(input.cursor ?? 0, limit);
    return new Response(JSON.stringify({ result: { data: { json: { leads: win.length === limit ? win.slice(0, limit - 2) : win, totalCount: TOTAL } } } }),
      { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    // A fixed page size cannot see everyone, however many cursors you try.
    const fixed = new Set();
    for (let c = 0; c < TOTAL; c += 50) for (const l of serve(c, 50).slice(0, 48)) fixed.add(l.ccu_id);
    assert.ok(fixed.size < TOTAL, "a fixed page size must demonstrably fall short");

    const r = await completeCampaignLeads("seq-1");
    assert.equal(r.unique, TOTAL, "the reader must reach every lead");
    assert.equal(r.complete, true);
    assert.equal(r.shortfall, 0);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("completeness has ZERO tolerance — a percentage would swallow real leads", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes("getListOfCampaigns?")) {
      return new Response(JSON.stringify({ result: { data: { json: [] } } }), { status: 200, headers: { "content-type": "application/json" } });
    }
    // 999 of 1000 — a 1% tolerance would have called this complete.
    return new Response(JSON.stringify({ result: { data: { json: { leads: Array.from({ length: 999 }, (_, i) => ({ ccu_id: `c${i}`, cu_id: `u${i}` })), totalCount: 1000 } } } }),
      { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const r = await completeCampaignLeads("seq-1");
    assert.equal(r.complete, false, "one missing lead is still incomplete");
    assert.equal(r.shortfall, 1);
    await assert.rejects(() => campaignLeads("seq-1", { strict: true }), /incomplete campaign membership read/);
  } finally { globalThis.fetch = realFetch; }
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

test("sequence family matching retains every role variant, OLD, and the followups", () => {
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
  // Names alone do not guess that client sourcing and match notifications are
  // booking sequences; content discovery covers any that carry a link.
  for (const name of ["Firecrawl - In-House Counsel", "(1) New Matches - Added to Para AI"]) {
    assert.equal(isNudgeSequence({ name }), false, `${name} must NOT be covered`);
  }
  assert.ok(DEFAULT_SEQ_KEYS.length >= 7);
});

test("content discovery covers every enabled link-bearing sequence and controlled disabled nudges", async () => {
  const sequences = [
    { id: "sourcing", name: "Firecrawl - In-House Counsel", enabled: true },
    { id: "plain", name: "Plain Outreach", enabled: true },
    { id: "disabled-link", name: "Disabled Sourcing", enabled: false },
    {
      id: "canary",
      name: "No Scheduled Call - Raydar - 1st Round Interview - Canary",
      enabled: false,
    },
  ];
  const campaigns = new Map([
    ["sourcing", {
      steps: [{
        subject: "",
        body: '<a href="https://book.raydar.xyz/human">Book</a>',
      }],
    }],
    ["plain", { steps: [{ subject: "", body: "No scheduling link" }] }],
    ["disabled-link", {
      steps: [{
        subject: "",
        body: "https://www.paraform.com/cal/raydar/15min",
      }],
    }],
    ["canary", { steps: [{ subject: "", body: "Controlled canary" }] }],
  ]);

  assert.equal(
    campaignHasCandidateSchedulingLink(campaigns.get("sourcing")),
    true,
  );
  const scope = await discoverBookingStopSequences({
    listSequences: async () => sequences,
    readCampaign: async (id) => campaigns.get(id),
    concurrency: 2,
    minimumCatalogCount: 1,
  });
  assert.equal(scope.complete, true);
  assert.equal(scope.schema, "raydar-booking-stop-scope-v2");
  assert.match(scope.scopeDigest, /^[a-f0-9]{64}$/u);
  assert.equal(scope.catalogSequences, 4);
  assert.equal(scope.scannedSequences, 4);
  assert.equal(scope.linkSequences, 2);
  assert.equal(scope.enabledLinkSequences, 1);
  assert.equal(scope.coveredEnabledLinkSequences, 1);
  assert.deepEqual(
    scope.sequences.map((sequence) => sequence.id).sort(),
    ["canary", "sourcing"],
  );
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

test("expiry is only declared after several spaced probes all refuse", async () => {
  const realFetch = globalThis.fetch;
  let calls = 0;
  // Throttled: the first probe 401s, a later one succeeds -> NOT expired.
  globalThis.fetch = async () => (++calls === 1
    ? new Response("{}", { status: 401 })
    : new Response(JSON.stringify({ result: { data: { json: [] } } }), { status: 200, headers: { "content-type": "application/json" } }));
  try {
    assert.equal(await isSessionActuallyExpired(), false, "a throttle must not be reported as an expiry");
    assert.ok(calls >= 2, "must probe more than once");
  } finally { globalThis.fetch = realFetch; }
});

test("a session that refuses every probe is reported expired", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("{}", { status: 401 });
  try {
    assert.equal(await isSessionActuallyExpired({ probes: 2 }), true);
  } finally { globalThis.fetch = realFetch; }
});

test("a non-auth error is not retried", async () => {
  let calls = 0;
  await assert.rejects(() => withThrottleRetry(async () => { calls++; throw new Error("boom"); }));
  assert.equal(calls, 1);
});

// ─────────────────────────────────────────────────────────────────────────────
// Transport faults (2026-07-30 incident)
//
// A pass is ~750 sequential Paraform round trips, each with a hard 20s abort,
// and NOTHING retried a transport failure — the wrapper only knew about 401.
// One slow response therefore killed the whole hourly sweep. Measured live: the
// 17:37Z pass died 117.6s in on a DOMException TimeoutError, and no pass had
// completed for at least six hours while the board still said "done".
// ─────────────────────────────────────────────────────────────────────────────

/** Exactly what AbortSignal.timeout() rejects with. */
const timeoutError = () => new DOMException("The operation was aborted due to timeout", "TimeoutError");

test("a fetch timeout is retried rather than killing the whole pass", async () => {
  let calls = 0, transient = 0;
  const value = await withThrottleRetry(async () => {
    calls++;
    if (calls < 3) throw timeoutError();
    return "ok";
  }, { onTransient: () => { transient++; }, transportDelays: [1, 2, 3] });
  assert.equal(value, "ok");
  assert.equal(calls, 3, "a transient timeout must be retried");
  assert.equal(transient, 2, "each transport retry must be counted, not hidden");
});

test("a persistent timeout still surfaces once transport retries are spent", async () => {
  let calls = 0;
  await assert.rejects(
    () => withThrottleRetry(async () => { calls++; throw timeoutError(); }, { transportDelays: [1, 2] }),
    (e) => e.name === "TimeoutError",
  );
  assert.equal(calls, 3, "bounded: one attempt plus the ladder, never unbounded");
});

test("a network fault hidden in a TypeError cause is treated as transient", async () => {
  let calls = 0;
  const value = await withThrottleRetry(async () => {
    calls++;
    if (calls === 1) {
      const e = new TypeError("fetch failed");
      e.cause = Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
      throw e;
    }
    return "ok";
  }, { transportDelays: [1] });
  assert.equal(value, "ok");
  assert.equal(calls, 2);
});

test("throttle and transport retries draw on independent budgets", async () => {
  // A pass being throttled AND crossing a flaky link must not have one failure
  // mode eat the other's retries.
  const script = ["auth", "timeout", "auth", "timeout", "ok"];
  let i = 0;
  const value = await withThrottleRetry(async () => {
    const step = script[i++];
    if (step === "auth") { const e = new Error("AUTH_EXPIRED"); e.code = "AUTH_EXPIRED"; throw e; }
    if (step === "timeout") throw timeoutError();
    return "ok";
  }, { delays: [1, 2], transportDelays: [1, 2] });
  assert.equal(value, "ok");
  assert.equal(i, 5, "both ladders must still have budget left after the other spends some");
});

test("a 5xx is retryable but a 4xx contract error is not", async () => {
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => (++calls === 1
    ? new Response("<html>bad gateway</html>", { status: 502 })
    : new Response(JSON.stringify({ result: { data: { json: ["ok"] } } }), { status: 200, headers: { "content-type": "application/json" } }));
  try {
    const value = await withThrottleRetry(
      () => trpcGet("campaigns.getListOfCampaignsOptimized", {}, 1),
      { transportDelays: [1] },
    );
    assert.deepEqual(value, ["ok"], "a 502 must be retried, not surfaced as a JSON parse error");
    assert.equal(calls, 2);
  } finally { globalThis.fetch = realFetch; }
});

test("the recorded error names the cause instead of a DOMException number", async () => {
  // A DOMException's legacy numeric code is 23, and `e.code || e.message` used
  // to record the literal string "23" — which is what health actually showed
  // while the sweep was dead, and it identified nothing.
  assert.equal(timeoutError().code, 23, "guard: the numeric code that caused this");
  assert.equal(sweepErrorLabel(timeoutError()), "TimeoutError");

  const authExpired = Object.assign(new Error("nope"), { code: "AUTH_EXPIRED" });
  assert.equal(sweepErrorLabel(authExpired), "AUTH_EXPIRED", "string codes still win");

  const scope = Object.assign(new Error("x"), { code: "BOOKING_STOP_SEQUENCE_SCOPE_INCOMPLETE" });
  assert.equal(sweepErrorLabel(scope), "BOOKING_STOP_SEQUENCE_SCOPE_INCOMPLETE");

  assert.equal(sweepErrorLabel(new Error("plain failure")), "plain failure");
  assert.equal(sweepErrorLabel("zero_active_leads"), "zero_active_leads");
  assert.equal(sweepErrorLabel(null), "error");
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

test("Calendly index rejects malformed or cross-origin pagination", async () => {
  const realFetch = globalThis.fetch;
  let mode = "missing-pagination";
  globalThis.fetch = async (url) => {
    const value = String(url);
    if (value.endsWith("/users/me")) {
      return Response.json({
        resource: {
          current_organization:
            "https://api.calendly.com/organizations/test",
        },
      });
    }
    if (mode === "missing-pagination") {
      return Response.json({ collection: [] });
    }
    return Response.json({
      collection: [],
      pagination: { next_page: "https://attacker.example/next" },
    });
  };
  try {
    await assert.rejects(
      () => calendlyBookingIndex({ useCache: false }),
      (error) => error?.code === "CALENDLY_RESPONSE_INVALID",
    );
    mode = "cross-origin";
    await assert.rejects(
      () => calendlyBookingIndex({ useCache: false }),
      (error) => error?.code === "CALENDLY_RESPONSE_INVALID",
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("Calendly index reports an incomplete invitee pagination window", async () => {
  const realFetch = globalThis.fetch;
  const now = Date.parse("2026-07-29T12:00:00.000Z");
  globalThis.fetch = async (url) => {
    const value = String(url);
    if (value.endsWith("/users/me")) {
      return Response.json({
        resource: {
          current_organization:
            "https://api.calendly.com/organizations/test",
        },
      });
    }
    if (value.includes("/invitees")) {
      return Response.json({
        collection: [{
          email: "candidate@example.com",
          created_at: "2026-07-29T10:00:00.000Z",
          status: "active",
        }],
        pagination: {
          next_page:
            "https://api.calendly.com/scheduled_events/event-1/invitees?count=100&page_token=next",
        },
      });
    }
    const status = new URL(value).searchParams.get("status");
    return Response.json({
      collection: status === "active"
        ? [{
            uri:
              "https://api.calendly.com/scheduled_events/event-1",
            status: "active",
            updated_at: "2026-07-29T10:00:00.000Z",
            start_time: "2026-07-30T10:00:00.000Z",
          }]
        : [],
      pagination: { next_page: null },
    });
  };
  try {
    const index = await calendlyBookingIndex({
      useCache: false,
      now,
      inviteePageLimit: 1,
    });
    assert.equal(index.truncated, true);
    assert.equal(index.events, 1);
    assert.equal(index.index.has("candidate@example.com"), true);
  } finally {
    globalThis.fetch = realFetch;
  }
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
    const r = await runBookingSweep({
      apply: false,
      sequenceScopeLoader: async () => ({
        schema: "raydar-booking-stop-scope-v2",
        scopeDigest: "a".repeat(64),
        catalogFloor: 1,
        sequences: [],
        catalogSequences: 1,
        scannedSequences: 1,
        linkSequences: 1,
        enabledLinkSequences: 1,
        coveredEnabledLinkSequences: 1,
        complete: true,
      }),
    });
    assert.equal(r.ok, false, "must not report ok");
    assert.equal(r.error, "zero_active_leads");
    assert.equal(r.paused, 0);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("an incomplete covered-sequence membership read fails before index publication", async () => {
  const result = await runBookingSweep({
    apply: false,
    calendlyIndexLoader: async () => ({
      index: new Map(),
      events: 0,
      cacheHits: 0,
      truncated: false,
    }),
    raydarEnabled: false,
    sequenceScopeLoader: async () => ({
      schema: "raydar-booking-stop-scope-v2",
      scopeDigest: "b".repeat(64),
      catalogFloor: 1,
      sequences: [{ id: "covered", name: "Covered", enabled: true }],
      catalogSequences: 1,
      scannedSequences: 1,
      linkSequences: 1,
      enabledLinkSequences: 1,
      coveredEnabledLinkSequences: 1,
      complete: true,
    }),
    membershipLoader: async () => ({
      complete: false,
      unique: 1,
      totalCount: 2,
      shortfall: 1,
      apiCalls: 2,
      leads: [{ ccu_id: "partial" }],
    }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, "incomplete_membership");
  assert.equal(result.incompleteReads.length, 1);
  assert.equal(result.indexedEmails, 0);
});

function completeSingleLeadSweepOptions(calendlyIndexLoader) {
  return {
    apply: true,
    profileBudget: 0,
    calendlyIndexLoader,
    raydarEnabled: false,
    sequenceScopeLoader: async () => ({
      schema: "raydar-booking-stop-scope-v2",
      scopeDigest: "c".repeat(64),
      catalogFloor: 1,
      sequences: [{ id: "covered", name: "Covered", enabled: true }],
      catalogSequences: 1,
      scannedSequences: 1,
      linkSequences: 1,
      enabledLinkSequences: 1,
      coveredEnabledLinkSequences: 1,
      complete: true,
    }),
    membershipLoader: async () => ({
      complete: true,
      unique: 1,
      totalCount: 1,
      shortfall: 0,
      apiCalls: 1,
      leads: [{
        ccu_id: "ccu-covered",
        cu_id: "cu-covered",
        name: "Candidate",
        to_use_email: "candidate@example.com",
        created_at: "2026-07-29T08:00:00.000Z",
        is_paused: false,
        is_archived: false,
      }],
    }),
    leadIndexPublisher: async () => "OK",
  };
}

test("a truncated Calendly source can never produce a green sweep", async () => {
  const result = await runBookingSweep(
    completeSingleLeadSweepOptions(async () => ({
      index: new Map(),
      events: 100,
      cacheHits: 0,
      truncated: true,
    })),
  );
  assert.equal(result.ok, false);
  assert.equal(result.error, "calendly_index_incomplete");
});

test("an applying sweep with a pause readback error is never healthy", async () => {
  const options = completeSingleLeadSweepOptions(async () => ({
    index: new Map([[
      "candidate@example.com",
      {
        bookedAt: Date.parse("2026-07-29T10:00:00.000Z"),
        startsAt: "2026-07-30T10:00:00.000Z",
        eventName: "Human Call",
        status: "active",
      },
    ]]),
    events: 1,
    cacheHits: 0,
    truncated: false,
  }));
  options.decisionApplier = async () => ({
    paused: 0,
    pausedCcuIds: [],
    pauseErrors: [{
      sequence: "Covered",
      reason: "still_active_after_pause",
    }],
  });
  const result = await runBookingSweep(options);
  assert.equal(result.decisions.length, 1);
  assert.equal(result.ok, false);
  assert.equal(result.error, "pause_incomplete");
  assert.equal(result.pauseErrors.length, 1);
});

test("profile checks rotate so the tail is never permanently blind", async () => {
  // Regression for a .slice(0, budget) that always took the same leads: with a
  // budget below the population, the leads past the budget were examined by
  // nothing, ever. Rotation must cover everyone within ceil(N/budget) passes.
  const N = 10, BUDGET = 4;
  const all = Array.from({ length: N }, (_, i) => `ccu-${String(i).padStart(2, "0")}`).sort();
  const seen = new Set();
  let rotor = 0;
  for (let pass = 0; pass < Math.ceil(N / BUDGET); pass++) {
    const start = rotor % all.length;
    const pending = [...all.slice(start), ...all.slice(0, start)].slice(0, BUDGET);
    for (const id of pending) seen.add(id);
    rotor = (start + pending.length) % all.length;
  }
  assert.equal(seen.size, N, "every lead must be reached within ceil(N/budget) passes");
});

test("staleness threshold is hours, not days — a dead sweep must surface same-day", () => {
  assert.ok(SWEEP_STALE_AFTER_MS <= 6 * 3600 * 1000, "must catch a dead sweep within hours");
  assert.ok(SWEEP_STALE_AFTER_MS >= 3600 * 1000, "but not alert on a single missed tick");
});

// ─────────────────────────────────────────────────────────────────────────────
// Cron authentication. `x-vercel-cron` is NOT a credential — Vercel does not
// strip it from inbound traffic, so accepting it let anyone trigger endpoints
// that pause leads, disable sequences and enrol candidates.
// ─────────────────────────────────────────────────────────────────────────────

test("the x-vercel-cron header alone does not authenticate", () => {
  const prev = process.env.CRON_SECRET;
  process.env.CRON_SECRET = "s3cret";
  try {
    const r = cronAuth({ headers: { "x-vercel-cron": "1" } });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "header_without_bearer");
    assert.equal(r.headerPresent, true, "must be flagged so it can be alerted on");
  } finally { process.env.CRON_SECRET = prev; }
});

test("a matching bearer authenticates", () => {
  const prev = process.env.CRON_SECRET;
  process.env.CRON_SECRET = "s3cret";
  try {
    assert.equal(cronAuth({ headers: { authorization: "Bearer s3cret" } }).ok, true);
    assert.equal(cronAuth({ headers: { authorization: "Bearer wrong" } }).ok, false);
    assert.equal(cronAuth({ headers: {} }).ok, false);
  } finally { process.env.CRON_SECRET = prev; }
});

test("no CRON_SECRET fails closed, never open", () => {
  const prev = process.env.CRON_SECRET;
  delete process.env.CRON_SECRET;
  try {
    const r = cronAuth({ headers: { "x-vercel-cron": "1", authorization: "Bearer anything" } });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "no_cron_secret");
  } finally { if (prev !== undefined) process.env.CRON_SECRET = prev; }
});
