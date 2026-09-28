// Para AI interview-request outreach: NEW conversations start in the Mailroom
// on SendGrid (David, 2026-09-28); conversations already open in Gmail finish
// in Gmail; Mailroom conversations continue in the Mailroom.
//
// The end-to-end cases drive the real processMatchRequest / processDueFollowup
// / reconcile code against fake KV, Paraform, Google and Mailroom endpoints,
// in the same style as paraai-request-lane-throttle.test.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";

const KV_URL = "https://kv.outreach-mailroom-default.test";
const PARAFORM_BASE = "https://www.paraform.com/api";
const MAILROOM_BASE = "https://mailroom.outreach-default.test";
const GMAIL_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
process.env.KV_REST_API_URL = KV_URL;
process.env.KV_REST_API_TOKEN = "kv-test-token";
process.env.PARAAI_OUTREACH_KV_REST_API_URL = KV_URL;
process.env.PARAAI_OUTREACH_KV_REST_API_TOKEN = "kv-test-token";
process.env.PARAFORM_SESSION_COOKIE = "Fe26.2*test-session*";
process.env.MAILROOM_BASE = MAILROOM_BASE;
process.env.MAILROOM_API_KEY = "mailroom-test-key";
delete process.env.PARAAI_OUTREACH_TRANSPORT;
delete process.env.SLACK_BOT_TOKEN;
const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});
process.env.GOOGLE_SA_KEY_JSON = JSON.stringify({
  client_email: "test-outreach-mailroom@test.iam.gserviceaccount.com",
  private_key: privateKey,
});

// ── Fakes ────────────────────────────────────────────────────────────────────
let kv;
let zsets;
let calls;
let gmail;
let mailroom;
let paraform;

function reset() {
  kv = new Map();
  zsets = new Map();
  calls = [];
  gmail = {
    searches: [],
    searchResults: [],
    threads: new Map(),
    sent: [],
  };
  mailroom = {
    lane: {
      id: "paraai-outreach-relief",
      sender_id: "david-sg",
      enabled: true,
      transport: "sendgrid",
      sender_status: "active",
      sendgrid_threading_enabled: true,
    },
    rows: new Map(),
    enqueued: [],
    wakes: [],
    nextId: 5000,
    // "sent" delivers on wake; "hold" leaves rows pending (window closed).
    onWake: "sent",
  };
  paraform = {
    reachedOut: new Set(),
    digestId: "digest-abc",
    marks: [],
    history: [],
  };
}
reset();

const zadd = (key, member) => {
  if (!zsets.has(key)) zsets.set(key, []);
  const list = zsets.get(key).filter((item) => item !== member);
  list.push(member);
  zsets.set(key, list);
};

function evalScript([script, keyCount, ...rest]) {
  const keys = rest.slice(0, Number(keyCount));
  const args = rest.slice(Number(keyCount));
  if (script.includes("redis.call('GET', KEYS[1]) == ARGV[1]")) {
    if (kv.get(keys[0]) === args[0]) { kv.delete(keys[0]); return 1; }
    return 0;
  }
  if (script.includes("return {1, ARGV[1]}")) {
    const existing = kv.get(keys[0]);
    zadd(keys[1], args[3]);
    if (existing) return [0, existing];
    kv.set(keys[0], args[0]);
    return [1, args[0]];
  }
  if (script.includes("cjson.decode")) {
    const raw = kv.get(keys[0]);
    if (!raw) return -1;
    if (Number(JSON.parse(raw).revision || 0) !== Number(args[0])) return 0;
    kv.set(keys[0], args[1]);
    zadd(keys[1], args[4]);
    return 1;
  }
  if (script.includes("tonumber(ARGV[1]) - tonumber(raw)")) {
    const raw = kv.get(keys[0]);
    const now = Number(args[0]);
    const minIntervalMs = Number(args[1]);
    if (raw != null && now - Number(raw) < minIntervalMs) return 0;
    kv.set(keys[0], args[0]);
    return 1;
  }
  throw new Error(`unexpected EVAL in test: ${script.slice(0, 60)}`);
}

function command([name, ...args]) {
  switch (String(name).toUpperCase()) {
    case "GET": return kv.get(args[0]) ?? null;
    case "SET": {
      const [key, value, ...options] = args;
      if (options.includes("NX") && kv.has(key)) return null;
      kv.set(key, value);
      return "OK";
    }
    case "DEL": return kv.delete(args[0]) ? 1 : 0;
    case "INCR": {
      const next = (Number(kv.get(args[0])) || 0) + 1;
      kv.set(args[0], String(next));
      return next;
    }
    case "DECR": {
      const next = (Number(kv.get(args[0])) || 0) - 1;
      kv.set(args[0], String(next));
      return next;
    }
    case "EXPIRE": return kv.has(args[0]) ? 1 : 0;
    case "ZADD": zadd(args[0], args[args.length - 1]); return 1;
    case "ZREVRANGE": return [...(zsets.get(args[0]) || [])].reverse();
    case "EVAL": return evalScript(args);
    default: throw new Error(`unexpected KV command in test: ${name}`);
  }
}

const jsonResponse = (status, body) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json" },
});
const trpc = (json) => jsonResponse(200, { result: { data: { json } } });

function paraformRoute(url, init) {
  const parsed = new URL(url);
  const proc = parsed.pathname.split("/trpc/")[1];
  const input = init?.method === "POST"
    ? JSON.parse(init.body || "{}")?.json
    : JSON.parse(parsed.searchParams.get("input") || "{}")?.json;
  calls.push({ kind: "paraform", proc, input });
  if (proc === "candidateUser.getCandidateUsersByIds") {
    const id = input.candidate_user_ids[0];
    return trpc([{ id, name: `Candidate ${id}`, emails: [{ value: `${id}@example.com` }] }]);
  }
  if (proc === "matchDigest.getDigestForCandidate") {
    const roles = paraform.history
      .filter((row) => row.candidate_user_id === input.candidateUserId)
      .map((row) => ({ roleId: row.role_id }));
    return trpc({ digestId: paraform.digestId, roles });
  }
  if (proc === "submissionRequest.markReachedOutToCandidate") {
    paraform.marks.push(input.id);
    paraform.reachedOut.add(input.id);
    return trpc({ ok: true });
  }
  if (proc === "submissionRequest.getRecruiterSubmissionRequestHistory") {
    return trpc({
      items: paraform.history.map((row) => ({
        ...row,
        reached_out_to_candidate: paraform.reachedOut.has(row.id),
      })),
    });
  }
  throw new Error(`unexpected Paraform procedure in test: ${proc}`);
}

function gmailRoute(url, init) {
  const parsed = new URL(url);
  const path = parsed.pathname.replace("/gmail/v1/users/me", "");
  calls.push({ kind: "gmail", method: init?.method || "GET", path, q: parsed.searchParams.get("q") });
  if (path === "/threads" && (init?.method || "GET") === "GET") {
    gmail.searches.push(parsed.searchParams.get("q"));
    return jsonResponse(200, { threads: gmail.searchResults.map((id) => ({ id })) });
  }
  if (path.startsWith("/threads/")) {
    const id = decodeURIComponent(path.slice("/threads/".length));
    const thread = gmail.threads.get(id);
    return thread ? jsonResponse(200, thread) : jsonResponse(404, { error: { code: 404 } });
  }
  if (path === "/settings/sendAs") {
    return jsonResponse(200, { sendAs: [{ isDefault: true, sendAsEmail: "david@raydar.xyz", signature: "<div>DAVID-SIGNATURE</div>" }] });
  }
  if (path === "/messages" && (init?.method || "GET") === "GET") {
    return jsonResponse(200, { messages: [] });
  }
  if (path === "/messages/send") {
    const body = JSON.parse(init.body);
    gmail.sent.push(body);
    return jsonResponse(200, { id: `gmail-sent-${gmail.sent.length}`, threadId: body.threadId || `gmail-thread-new-${gmail.sent.length}` });
  }
  throw new Error(`unexpected Gmail call in test: ${init?.method || "GET"} ${path}`);
}

function mailroomRoute(url, init) {
  const parsed = new URL(url);
  const method = init?.method || "GET";
  calls.push({ kind: "mailroom", method, path: parsed.pathname });
  if (parsed.pathname === "/api/lanes") {
    return jsonResponse(200, { ok: true, lanes: [mailroom.lane] });
  }
  if (parsed.pathname === "/api/status") {
    const row = mailroom.rows.get(parsed.searchParams.get("key"));
    return jsonResponse(200, row ? { ok: true, found: true, ...row } : { ok: true, found: false });
  }
  if (parsed.pathname === "/api/enqueue") {
    const body = JSON.parse(init.body);
    mailroom.enqueued.push(body);
    if (!mailroom.lane.enabled) return jsonResponse(400, { ok: false, error: "ENQUEUE_LANE_DISABLED" });
    const id = mailroom.nextId++;
    mailroom.rows.set(body.dedupeKey, {
      id,
      lane_id: body.lane,
      sender_id: "david-sg",
      state: "pending",
      rfc822_message_id: `<raydar-mailroom-${id}@raydar.xyz>`,
      provider_message_id: null,
      sent_at: null,
      deliveryEvents: [],
    });
    return jsonResponse(200, { ok: true, id, outboxId: id, accepted: true });
  }
  if (parsed.pathname === "/api/worker" && method === "POST") {
    const body = JSON.parse(init.body);
    mailroom.wakes.push(body);
    const row = mailroom.rows.get(body.operationKey);
    if (row && mailroom.onWake === "sent") {
      row.state = "sent";
      row.sent_at = "2026-09-28T18:00:00.000Z";
      row.provider_message_id = `sg-${row.id}`;
    }
    return jsonResponse(200, { ok: true, operationKey: body.operationKey, report: [] });
  }
  throw new Error(`unexpected Mailroom call in test: ${method} ${parsed.pathname}`);
}

globalThis.fetch = async (url, init = {}) => {
  const href = String(url);
  if (href.startsWith(KV_URL)) {
    const body = JSON.parse(init.body || "null");
    const result = href.endsWith("/pipeline")
      ? body.map((item) => ({ result: command(item) }))
      : { result: command(body) };
    return jsonResponse(200, result);
  }
  if (href.startsWith(PARAFORM_BASE)) return paraformRoute(href, init);
  if (href === GOOGLE_TOKEN_URL) {
    return jsonResponse(200, { access_token: "test-access-token", expires_in: 3600 });
  }
  if (href.startsWith(GMAIL_BASE)) return gmailRoute(href, init);
  if (href.startsWith(MAILROOM_BASE)) return mailroomRoute(href, init);
  throw new Error(`unexpected fetch in test: ${href}`);
};

const {
  deliverViaMailroomOutreach,
  mailroomBounceFromStatus,
  mailroomDispatchWindowOpen,
  mailroomOutreachDedupeKey,
  mailroomOutreachLaneReady,
  outreachTransportMode,
  resetMailroomOutreachLaneCache,
} = await import("../api/paraai/_lib/outreach-mailroom.mjs");
const {
  assessOutreachThread,
  assessmentPatch,
  eligibleNewRequests,
  mailroomConversationContext,
  mailroomReplyThread,
  normalizeSubmissionRequest,
  outreachConfig,
  planDeliveredFollowup,
  planDeliveredMatch,
  processDueFollowup,
  processMatchRequest,
  queuedMailroomMatchIds,
  reconcileQueuedMailroomMatches,
} = await import("../api/paraai/_lib/outreach.mjs");
const { createOutreachState, getOutreachState, saveOutreachState } = await import(
  "../api/paraai/_lib/outreach-store.mjs"
);
const { pendingOutreachReplies } = await import("../api/paraai/_lib/submission-notify-request.mjs");

const config = { ...outreachConfig(process.env), mailbox: "david@raydar.xyz" };
const noSleep = async () => {};
const instantDelivery = (options) => deliverViaMailroomOutreach({ ...options, sleepImpl: noSleep });

function historyRow(id, candidateUserId, { company = "Acme", role = "Software Engineer", createdAt = "2026-09-28T16:00:00.000Z" } = {}) {
  return {
    id,
    status: "pending",
    created_at: createdAt,
    candidate_user_id: candidateUserId,
    candidate_name: `Candidate ${candidateUserId}`,
    role_id: `role-${id}`,
    role_name: role,
    company_name: company,
    recipient_types: ["RECRUITER"],
  };
}

function seedRequest(id, candidateUserId, options) {
  const row = historyRow(id, candidateUserId, options);
  paraform.history.push(row);
  return normalizeSubmissionRequest(row);
}

function history() {
  return paraform.history.map((row) => normalizeSubmissionRequest({
    ...row,
    reached_out_to_candidate: paraform.reachedOut.has(row.id),
  }));
}

function sendOptions(extra = {}) {
  return {
    mode: "send",
    config,
    mailroomDeliveryImpl: instantDelivery,
    ...extra,
  };
}

const header = (name, value) => ({ name, value });
function gmailMessage({ id, from, internalDate, subject = "Re: x", inReplyTo = null, references = null, labels = ["INBOX"], text = "Thanks!" }) {
  return {
    id,
    internalDate: String(internalDate),
    labelIds: labels,
    payload: {
      mimeType: "text/plain",
      headers: [
        header("From", from),
        header("Subject", subject),
        ...(inReplyTo ? [header("In-Reply-To", inReplyTo)] : []),
        ...(references ? [header("References", references)] : []),
      ],
      body: { data: Buffer.from(text, "utf8").toString("base64url") },
    },
  };
}

test.beforeEach(() => {
  reset();
  resetMailroomOutreachLaneCache();
});

// ── Pure helpers ─────────────────────────────────────────────────────────────

test("new conversations default to the Mailroom, and PARAAI_OUTREACH_TRANSPORT=gmail rolls back", () => {
  assert.equal(outreachTransportMode({}), "mailroom");
  assert.equal(outreachTransportMode({ PARAAI_OUTREACH_TRANSPORT: "GMAIL" }), "gmail");
  assert.equal(outreachTransportMode({ PARAAI_OUTREACH_TRANSPORT: "mailroom" }), "mailroom");
  assert.equal(outreachConfig({}).transport, "mailroom");
  assert.equal(mailroomOutreachDedupeKey("match:req-1"), "paraai-outreach:auto:match:req-1");
});

test("the local dispatch window matches the Mailroom's 05:00-19:30 Pacific envelope", () => {
  // 2026-09-28 is PDT (UTC-7).
  assert.equal(mailroomDispatchWindowOpen(new Date("2026-09-28T11:59:00Z")), false); // 04:59
  assert.equal(mailroomDispatchWindowOpen(new Date("2026-09-28T12:00:00Z")), true); // 05:00
  assert.equal(mailroomDispatchWindowOpen(new Date("2026-09-29T02:29:00Z")), true); // 19:29
  assert.equal(mailroomDispatchWindowOpen(new Date("2026-09-29T02:30:00Z")), false); // 19:30
});

test("the lane is ready only when enabled, on active SendGrid, with threading armed", async () => {
  const lanes = (lane) => async () => jsonResponse(200, { ok: true, lanes: [lane] });
  const base = { id: "paraai-outreach-relief", sender_id: "david-sg", enabled: true, transport: "sendgrid", sender_status: "active", sendgrid_threading_enabled: true };
  const cfg = { base: MAILROOM_BASE, key: "k", lane: "paraai-outreach-relief", configured: true };
  const check = async (lane) => {
    resetMailroomOutreachLaneCache();
    return mailroomOutreachLaneReady({ config: cfg, fetchImpl: lanes(lane) });
  };
  assert.deepEqual(await check(base), { ready: true, reason: null, senderId: "david-sg" });
  assert.equal((await check({ ...base, enabled: false })).reason, "lane_disabled");
  assert.equal((await check({ ...base, transport: "gmail" })).reason, "lane_not_sendgrid");
  assert.equal((await check({ ...base, sender_status: "paused" })).reason, "sender_inactive");
  assert.equal((await check({ ...base, sendgrid_threading_enabled: false })).reason, "threading_disabled");
  resetMailroomOutreachLaneCache();
  assert.equal(
    (await mailroomOutreachLaneReady({ config: cfg, fetchImpl: async () => { throw new Error("down"); } })).ready,
    false,
  );
  assert.equal((await mailroomOutreachLaneReady({ config: { ...cfg, configured: false } })).reason, "not_configured");
});

test("only a hard bounce or a bounce-driven drop counts as a Mailroom bounce", () => {
  const status = (events) => ({ deliveryEvents: events });
  assert.equal(mailroomBounceFromStatus(status([{ event_type: "delivered" }])), null);
  assert.equal(mailroomBounceFromStatus(status([{ event_type: "blocked", reason: "spam" }])), null);
  assert.equal(mailroomBounceFromStatus(status([{ event_type: "dropped", reason: "Unsubscribed Address" }])), null);
  assert.ok(mailroomBounceFromStatus(status([{ event_type: "bounce", reason: "550 5.1.1 user unknown" }])));
  assert.ok(mailroomBounceFromStatus(status([{ event_type: "dropped", reason: "Bounced Address" }])));
  assert.equal(mailroomBounceFromStatus(null), null);
});

test("a Mailroom conversation replies only on the same digest, with references ending at the last email", () => {
  const ids = Array.from({ length: 25 }, (_, index) => `<raydar-mailroom-${index}@raydar.xyz>`);
  const state = {
    mailroomConversation: {
      subject: "1st Round - Interview Request @ Acme 🎉",
      digestUrl: "https://www.paraform.com/digest/digest-abc",
      startedAt: "2026-09-28T16:00:00.000Z",
      messageIds: ids,
    },
  };
  const context = mailroomConversationContext(state, "https://www.paraform.com/digest/digest-abc");
  assert.equal(context.threadId, null);
  assert.equal(context.replySubject, "Re: 1st Round - Interview Request @ Acme 🎉");
  assert.equal(context.inReplyTo, ids[24]);
  assert.equal(context.references.split(" ").length, 20);
  assert.equal(context.references.split(" ").at(-1), ids[24]);
  assert.equal(mailroomConversationContext(state, "https://www.paraform.com/digest/other"), null);
  assert.equal(mailroomConversationContext(state, null), null);
  // Follow-ups pass no digest and always reply on the active conversation.
  assert.equal(mailroomConversationContext(state).inReplyTo, ids[24]);
  assert.equal(mailroomConversationContext({}), null);
});

test("a Mailroom start clears the Gmail thread, arms the ladder, and a Gmail send hands the conversation back", () => {
  const request = { id: "req-1", roleId: "role-1", roleName: "SWE", companyName: "Acme" };
  const copy = { subject: "1st Round - Interview Request @ Acme 🎉", variant: "first" };
  const digest = { digestId: "digest-abc", digestUrl: "https://www.paraform.com/digest/digest-abc" };
  const started = planDeliveredMatch({
    candidateUserId: "cu-1",
    threadId: "old-gmail-thread",
    threadSubject: "Old subject",
  }, {
    request,
    ordinal: 1,
    roleUrl: "https://example.test/role",
    digest,
    copy,
    sent: { providerMessageId: "sg-1", mailroomRowId: 7 },
    sentAt: "2026-09-28T16:00:00.000Z",
    messageId: "<raydar-paraai-x@raydar.xyz>",
    transport: "mailroom-sendgrid",
    mailroom: { start: true, messageId: "<raydar-mailroom-1@raydar.xyz>", dedupeKey: "paraai-outreach:auto:match:req-1" },
  });
  assert.equal(started.threadId, null);
  assert.equal(started.threadSubject, copy.subject);
  assert.deepEqual(started.mailroomConversation, {
    subject: copy.subject,
    digestUrl: digest.digestUrl,
    startedAt: "2026-09-28T16:00:00.000Z",
    messageIds: ["<raydar-mailroom-1@raydar.xyz>"],
    dedupeKeys: ["paraai-outreach:auto:match:req-1"],
  });
  assert.equal(started.followup.remaining, 2);
  assert.equal(started.outbox["match:req-1"].mailroomDedupeKey, "paraai-outreach:auto:match:req-1");
  assert.equal(started.outbox["match:req-1"].gmailMessageId, null);

  const nudged = planDeliveredFollowup(started, {
    sent: { providerMessageId: "sg-2" },
    sentAt: "2026-09-30T16:00:00.000Z",
    messageId: "<raydar-paraai-y@raydar.xyz>",
    mailroom: { messageId: "<raydar-mailroom-2@raydar.xyz>", dedupeKey: "paraai-outreach:auto:followup:req-1:1" },
  });
  assert.deepEqual(nudged.mailroomConversation.messageIds, [
    "<raydar-mailroom-1@raydar.xyz>",
    "<raydar-mailroom-2@raydar.xyz>",
  ]);
  assert.equal(nudged.threadId, null);
  assert.equal(nudged.followup.number, 2);
  assert.equal(nudged.outbox["followup:req-1:1"].transport, "mailroom-sendgrid");

  const backToGmail = planDeliveredMatch(nudged, {
    request: { ...request, id: "req-2" },
    ordinal: 2,
    roleUrl: "https://example.test/role2",
    digest,
    copy,
    sent: { id: "gmail-1", threadId: "gmail-thread-2" },
    sentAt: "2026-10-01T16:00:00.000Z",
    messageId: "<m>",
    transport: "gmail",
  });
  assert.equal(backToGmail.threadId, "gmail-thread-2");
  assert.equal(backToGmail.mailroomConversation, null);

  // Relief keeps its exact old shape: no conversation change, no nudges.
  const relief = planDeliveredMatch(nudged, {
    request: { ...request, id: "req-3" },
    ordinal: 3,
    roleUrl: "r",
    digest,
    copy,
    sent: { providerMessageId: "sg-3" },
    sentAt: "2026-10-01T16:00:00.000Z",
    messageId: "<m3>",
    transport: "mailroom-sendgrid",
    armFollowup: false,
  });
  assert.deepEqual(relief.mailroomConversation, nudged.mailroomConversation);
  assert.equal(relief.followup, null);
});

test("reply discovery finds the candidate's reply, including from a gmail dot variant or by reference", async () => {
  const startedMs = Date.parse("2026-09-28T16:00:00.000Z");
  const state = {
    candidateEmail: "first.last@gmail.com",
    mailroomConversation: {
      subject: "1st Round - Interview Request @ Acme 🎉",
      digestUrl: "https://www.paraform.com/digest/digest-abc",
      startedAt: "2026-09-28T16:00:00.000Z",
      messageIds: ["<raydar-mailroom-1@raydar.xyz>"],
    },
  };
  const searches = [];
  const threads = new Map([
    ["t-1", { id: "t-1", messages: [
      gmailMessage({ id: "before", from: "first.last@gmail.com", internalDate: startedMs - 1000 }),
      gmailMessage({ id: "dot-variant", from: "Candidate <firstlast@gmail.com>", internalDate: startedMs + 1000 }),
      gmailMessage({ id: "ours", from: "david@raydar.xyz", internalDate: startedMs + 2000, labels: ["SENT"] }),
    ] }],
    ["t-2", { id: "t-2", messages: [
      gmailMessage({ id: "work-address", from: "c@work.example", internalDate: startedMs + 3000, inReplyTo: "<raydar-mailroom-1@raydar.xyz>" }),
      gmailMessage({ id: "unrelated", from: "someone@else.example", internalDate: startedMs + 4000 }),
    ] }],
  ]);
  const thread = await mailroomReplyThread(state, {
    mailbox: "david@raydar.xyz",
    searchImpl: async (mailbox, query, limit) => { searches.push({ query, limit }); return [{ id: "t-1" }, { id: "t-2" }]; },
    threadImpl: async (mailbox, id) => threads.get(id),
  });
  assert.deepEqual(thread.messages.map((message) => message.id), ["dot-variant", "work-address"]);
  assert.equal(thread.id, "t-1");
  assert.match(searches[0].query, /^\{from:"first\.last@gmail\.com" "https:\/\/www\.paraform\.com\/digest\/digest-abc"\} after:\d+ -in:sent -in:drafts$/);
  assert.equal(searches[0].limit, 10);
  assert.equal(await mailroomReplyThread({ ...state, mailroomConversation: null }, { mailbox: "x" }), null);
});

test("a queued Mailroom send is in flight, so the tick never re-runs it", () => {
  const request = normalizeSubmissionRequest(historyRow("req-q", "cu-q"));
  const states = [{
    candidateUserId: "cu-q",
    outbox: {
      "match:req-q": {
        status: "queued",
        transport: "mailroom-sendgrid",
        mailroomDedupeKey: "paraai-outreach:auto:match:req-q",
        requestId: "req-q",
      },
    },
  }];
  assert.deepEqual([...queuedMailroomMatchIds(states)], ["req-q"]);
  const cfg = { notBeforeMs: Date.parse("2026-09-01T00:00:00Z"), candidateRecipientNotBeforeMs: null };
  assert.equal(eligibleNewRequests([request], cfg, [], []).length, 1);
  assert.equal(eligibleNewRequests([request], cfg, states, []).length, 0);
});

test("a reply to a Mailroom email is assessed from the search, and the notifier can quote it", async () => {
  const state = {
    candidateUserId: "cu-a",
    candidateEmail: "a@example.com",
    threadId: null,
    mailroomConversation: {
      subject: "s",
      startedAt: "2026-09-28T16:00:00.000Z",
      messageIds: ["<raydar-mailroom-1@raydar.xyz>"],
      dedupeKeys: ["k1"],
    },
  };
  const assessment = await assessOutreachThread({
    state,
    config: { mailbox: "david@raydar.xyz" },
    mailroomThreadImpl: async () => ({
      id: "reply-thread",
      messages: [gmailMessage({ id: "r1", from: "a@example.com", internalDate: Date.parse("2026-09-29T00:00:00Z"), text: "Sounds great, happy to chat" })],
    }),
    mailroomBounceImpl: async () => null,
    classifyImpl: async () => ({ verdict: "OPEN", source: "test" }),
    declineImpl: async () => ({ roleIds: [] }),
  });
  assert.equal(assessment.checked, true);
  assert.equal(assessment.replied, true);
  assert.equal(assessment.mailroomReplyThreadId, "reply-thread");
  const { patch } = assessmentPatch(assessment, { state });
  assert.equal(patch.mailroomConversation.replyThreadId, "reply-thread");
  const [pending] = pendingOutreachReplies([{ ...state, ...patch }]);
  assert.equal(pending.threadId, "reply-thread");

  const bounced = await assessOutreachThread({
    state,
    config: { mailbox: "david@raydar.xyz" },
    mailroomThreadImpl: async () => ({ id: null, messages: [] }),
    mailroomBounceImpl: async () => ({ at: "2026-09-29T00:00:00Z", subject: "SendGrid bounce" }),
  });
  assert.ok(bounced.bounce);
});

// ── Mailroom delivery contract ───────────────────────────────────────────────

test("delivery enqueues once, wakes exactly its own row, and returns the Mailroom Message-ID", async () => {
  const message = {
    actionKey: "match:req-1",
    to: "c@example.com",
    subject: "Re: 1st Round - Interview Request @ Acme 🎉",
    bodyText: "text",
    bodyHtml: "<div>text</div>",
    threadId: "gmail-thread-must-not-travel",
    inReplyTo: "<raydar-mailroom-9@raydar.xyz>",
    references: "<raydar-mailroom-9@raydar.xyz>",
  };
  const sent = await instantDelivery({ message, actionKey: message.actionKey, candidateName: "C" });
  assert.equal(mailroom.enqueued.length, 1);
  const body = mailroom.enqueued[0];
  assert.equal(body.lane, "paraai-outreach-relief");
  assert.equal(body.dedupeKey, "paraai-outreach:auto:match:req-1");
  assert.equal(body.inReplyTo, "<raydar-mailroom-9@raydar.xyz>");
  assert.equal(body.references, "<raydar-mailroom-9@raydar.xyz>");
  assert.equal("threadId" in body, false);
  assert.deepEqual(mailroom.wakes, [{ senderId: "david-sg", operationKey: "paraai-outreach:auto:match:req-1" }]);
  assert.equal(sent.rfc822MessageId, "<raydar-mailroom-5000@raydar.xyz>");
  assert.equal(sent.providerMessageId, "sg-5000");

  // A retry of the same action converges on the same row: nothing is enqueued.
  const again = await instantDelivery({ message, actionKey: message.actionKey });
  assert.equal(mailroom.enqueued.length, 1);
  assert.equal(again.rfc822MessageId, sent.rfc822MessageId);
});

test("a held row returns queued, and a parked row is the one outcome that throws", async () => {
  mailroom.onWake = "hold";
  const message = { to: "c@example.com", subject: "s", bodyText: "t" };
  const queued = await instantDelivery({ message, actionKey: "match:req-h" });
  assert.equal(queued.queued, true);
  assert.equal(queued.mailroomState, "pending");
  mailroom.rows.get("paraai-outreach:auto:match:req-h").state = "review";
  await assert.rejects(
    instantDelivery({ message, actionKey: "match:req-h" }),
    (error) => error.code === "OUTREACH_MAILROOM_PARKED",
  );
  await assert.rejects(
    instantDelivery({ message: { ...message, references: null, inReplyTo: "<a@b>" }, actionKey: "x" }),
    (error) => error.code === "OUTREACH_MAILROOM_THREADING_INVALID",
  );
});

// ── End to end through processMatchRequest / processDueFollowup ─────────────

test("a brand-new conversation goes out through the Mailroom with the signature, and never through Gmail", async () => {
  const request = seedRequest("req-1", "cu-1");
  const result = await processMatchRequest(request, history(), sendOptions());
  assert.equal(result.action, "sent");
  assert.equal(result.transport, "mailroom-sendgrid");
  assert.equal(gmail.sent.length, 0, "no Gmail send");
  assert.equal(mailroom.enqueued.length, 1);
  const body = mailroom.enqueued[0];
  assert.equal(body.dedupeKey, "paraai-outreach:auto:match:req-1");
  assert.equal(body.subject, "1st Round - Interview Request @ Acme 🎉");
  assert.equal(body.inReplyTo, undefined);
  assert.match(body.html, /DAVID-SIGNATURE/);
  assert.match(body.html, /digest\/digest-abc/);
  const state = await getOutreachState("cu-1");
  assert.equal(state.threadId, null);
  assert.deepEqual(state.mailroomConversation.messageIds, ["<raydar-mailroom-5000@raydar.xyz>"]);
  assert.equal(state.matches["req-1"].transport, "mailroom-sendgrid");
  assert.equal(state.followup.ownerMatchId, "req-1");
  assert.deepEqual(paraform.marks, ["req-1"], "Paraform reached-out marker written after delivery");
});

test("a later role continues the Mailroom conversation, threaded, without a Gmail thread hunt", async () => {
  const first = seedRequest("req-1", "cu-1", { createdAt: "2026-09-28T16:00:00.000Z" });
  await processMatchRequest(first, history(), sendOptions());
  const second = seedRequest("req-2", "cu-1", { company: "Beta", createdAt: "2026-09-28T17:00:00.000Z" });
  gmail.searches = [];
  const result = await processMatchRequest(second, history(), sendOptions());
  assert.equal(result.action, "sent");
  const reply = mailroom.enqueued[1];
  assert.equal(reply.subject, "Re: 1st Round - Interview Request @ Acme 🎉");
  assert.equal(reply.inReplyTo, "<raydar-mailroom-5000@raydar.xyz>");
  assert.equal(reply.references, "<raydar-mailroom-5000@raydar.xyz>");
  assert.doesNotMatch(reply.html, /DAVID-SIGNATURE/, "a reply never repeats the signature");
  // The only Gmail search is the reply check for the intent gate.
  assert.equal(gmail.searches.length, 1);
  assert.match(gmail.searches[0], /^\{from:"cu-1@example\.com"/);
  const state = await getOutreachState("cu-1");
  assert.equal(state.mailroomConversation.messageIds.length, 2);
  assert.equal(state.followup.ownerMatchId, "req-2");
  assert.equal(gmail.sent.length, 0);
});

test("a conversation already open in Gmail finishes in Gmail", async () => {
  const request = seedRequest("req-g", "cu-g");
  await createOutreachState("cu-g", { candidateEmail: "cu-g@example.com" });
  const existing = await getOutreachState("cu-g");
  const digestUrl = "https://www.paraform.com/digest/digest-abc";
  gmail.threads.set("gmail-thread-1", {
    id: "gmail-thread-1",
    messages: [{
      id: "m1",
      internalDate: String(Date.parse("2026-09-20T16:00:00Z")),
      labelIds: ["SENT"],
      payload: {
        mimeType: "text/plain",
        headers: [
          header("From", "David Phillips <david@raydar.xyz>"),
          header("Subject", "1st Round - Interview Request @ Old 🎉"),
          header("Message-ID", "<CAold@mail.gmail.com>"),
        ],
        body: { data: Buffer.from(`See ${digestUrl}`, "utf8").toString("base64url") },
      },
    }],
  });
  await saveOutreachState({
    ...existing,
    threadId: "gmail-thread-1",
    threadSubject: "1st Round - Interview Request @ Old 🎉",
    firstOutboundAt: "2026-09-20T16:00:00.000Z",
    digestUrl,
  }, existing.revision);
  const result = await processMatchRequest(request, history(), sendOptions());
  assert.equal(result.action, "sent");
  assert.equal(result.transport, "gmail");
  assert.equal(mailroom.enqueued.length, 0, "the Mailroom is not used");
  assert.equal(gmail.sent.length, 1);
  assert.equal(gmail.sent[0].threadId, "gmail-thread-1");
  const state = await getOutreachState("cu-g");
  assert.equal(state.mailroomConversation, null);
  assert.equal(state.threadId, "gmail-thread-1");
});

test("while the lane is not ready (David's Hub rollback), new conversations start in Gmail", async () => {
  mailroom.lane.enabled = false;
  const request = seedRequest("req-r", "cu-r");
  const result = await processMatchRequest(request, history(), sendOptions());
  assert.equal(result.transport, "gmail");
  assert.equal(mailroom.enqueued.length, 0);
  assert.equal(gmail.sent.length, 1);
  assert.equal(gmail.sent[0].threadId, undefined);
});

test("PARAAI_OUTREACH_TRANSPORT=gmail keeps every send on Gmail without asking the Mailroom", async () => {
  const request = seedRequest("req-env", "cu-env");
  const result = await processMatchRequest(request, history(), sendOptions({ config: { ...config, transport: "gmail" } }));
  assert.equal(result.transport, "gmail");
  assert.equal(calls.filter((call) => call.kind === "mailroom").length, 0);
});

test("a send the Mailroom holds is queued, skipped by eligibility, and finished by the reconcile pass", async () => {
  mailroom.onWake = "hold";
  const request = seedRequest("req-n", "cu-n");
  const result = await processMatchRequest(request, history(), sendOptions());
  assert.equal(result.action, "queued");
  let state = await getOutreachState("cu-n");
  assert.equal(state.outbox["match:req-n"].status, "queued");
  assert.equal(state.matches?.["req-n"], undefined);
  assert.deepEqual(paraform.marks, [], "no reached-out marker before the email leaves");
  const cfg = { ...config, notBeforeMs: Date.parse("2026-09-01T00:00:00Z") };
  assert.equal(eligibleNewRequests(history(), cfg, [state], []).length, 0);

  // Still pending: the pass reports and changes nothing.
  let passes = await reconcileQueuedMailroomMatches({ history: history(), states: [state], config });
  assert.deepEqual(passes.map((row) => row.action), ["queued"]);

  // 05:00 opens the window and the row leaves.
  const row = mailroom.rows.get("paraai-outreach:auto:match:req-n");
  Object.assign(row, { state: "sent", sent_at: "2026-09-29T12:00:05.000Z", provider_message_id: "sg-n" });
  passes = await reconcileQueuedMailroomMatches({ history: history(), states: [state], config });
  assert.deepEqual(passes.map((row) => row.action), ["sent"]);
  state = await getOutreachState("cu-n");
  assert.equal(state.matches["req-n"].sentAt, "2026-09-29T12:00:05.000Z");
  assert.equal(state.outbox["match:req-n"].status, "delivered");
  assert.equal(state.mailroomConversation.messageIds[0], row.rfc822_message_id);
  assert.equal(state.followup.dueAt, "2026-10-01T12:00:05.000Z");
  assert.deepEqual(paraform.marks, ["req-n"]);
  assert.equal(mailroom.enqueued.length, 1, "never enqueued twice");
});

test("a claimed Mailroom action is never finished on Gmail, even if the lane goes down", async () => {
  const request = seedRequest("req-c", "cu-c");
  // First attempt: the Mailroom is unreachable after the claim.
  const unreachable = async () => { const error = new Error("down"); error.code = "OUTREACH_MAILROOM_UNREACHABLE"; throw error; };
  await assert.rejects(
    processMatchRequest(request, history(), sendOptions({ mailroomDeliveryImpl: unreachable })),
    (error) => error.code === "OUTREACH_MAILROOM_RETRY",
  );
  let state = await getOutreachState("cu-c");
  assert.equal(state.outbox["match:req-c"].status, "claimed");
  assert.equal(state.outbox["match:req-c"].transport, "mailroom-sendgrid");
  // The lane is then disabled: the retry waits instead of switching to Gmail.
  mailroom.lane.enabled = false;
  resetMailroomOutreachLaneCache();
  await assert.rejects(
    processMatchRequest(request, history(), sendOptions()),
    (error) => error.code === "OUTREACH_MAILROOM_RETRY",
  );
  assert.equal(gmail.sent.length, 0);
  // Back up: the same key is used and the email goes once.
  mailroom.lane.enabled = true;
  resetMailroomOutreachLaneCache();
  const result = await processMatchRequest(request, history(), sendOptions());
  assert.equal(result.action, "sent");
  assert.equal(mailroom.enqueued.length, 1);
  state = await getOutreachState("cu-c");
  assert.equal(state.matches["req-c"].transport, "mailroom-sendgrid");
});

test("a Mailroom nudge replies on the conversation, but only inside the window and never after a reply", async () => {
  const request = seedRequest("req-f", "cu-f");
  await processMatchRequest(request, history(), sendOptions());
  const dueAt = Date.parse((await getOutreachState("cu-f")).followup.dueAt);

  // Due (at 11:00 Pacific on 09-30), but it is now 19:45 Pacific: the
  // Mailroom window is closed, so nothing is read or sent.
  const evening = Date.parse("2026-10-01T02:45:00Z");
  assert.ok(evening > dueAt);
  gmail.searches = [];
  const closed = await processDueFollowup("cu-f", { config, now: evening, mailroomDeliveryImpl: instantDelivery });
  assert.equal(closed.action, "mailroom_window_closed");
  assert.equal(mailroom.enqueued.length, 1);
  assert.equal(gmail.searches.length, 0, "no reply read while the window is closed");

  // 09:00 Pacific the next morning with no reply: one threaded nudge.
  const morning = Date.parse("2026-10-01T16:00:00Z");
  gmail.searchResults = [];
  const sent = await processDueFollowup("cu-f", { config, now: morning, mailroomDeliveryImpl: instantDelivery });
  assert.equal(sent.action, "sent");
  const nudge = mailroom.enqueued[1];
  assert.equal(nudge.dedupeKey, "paraai-outreach:auto:followup:req-f:1");
  assert.equal(nudge.inReplyTo, "<raydar-mailroom-5000@raydar.xyz>");
  assert.equal(nudge.subject, "Re: 1st Round - Interview Request @ Acme 🎉");
  let state = await getOutreachState("cu-f");
  assert.equal(state.followup.number, 2);
  assert.equal(state.mailroomConversation.messageIds.length, 2);

  // The candidate replies before nudge two: the ladder stops, nothing is enqueued.
  gmail.searchResults = ["reply-thread"];
  gmail.threads.set("reply-thread", {
    id: "reply-thread",
    messages: [gmailMessage({
      id: "r1",
      from: "Candidate <cu-f@example.com>",
      internalDate: Date.parse("2026-10-01T00:00:00Z"),
      inReplyTo: "<raydar-mailroom-5001@raydar.xyz>",
    })],
  });
  const later = Date.parse("2026-10-02T17:00:00Z");
  const stopped = await processDueFollowup("cu-f", { config, now: later, mailroomDeliveryImpl: instantDelivery });
  assert.equal(stopped.action, "stopped_on_reply");
  assert.equal(mailroom.enqueued.length, 2);
  state = await getOutreachState("cu-f");
  assert.equal(state.followup, null);
  assert.equal(state.mailroomConversation.replyThreadId, "reply-thread");
});

test("a Mailroom bounce stops the ladder and holds the next role until the address changes", async () => {
  const request = seedRequest("req-b", "cu-b");
  await processMatchRequest(request, history(), sendOptions());
  mailroom.rows.get("paraai-outreach:auto:match:req-b").deliveryEvents = [
    { event_type: "bounce", reason: "550 5.1.1 user unknown", occurred_at: "2026-09-28T18:00:10Z" },
  ];
  const result = await processDueFollowup("cu-b", {
    config,
    now: Date.parse("2026-09-30T18:00:00Z"),
    mailroomDeliveryImpl: instantDelivery,
  });
  assert.equal(result.action, "stopped_on_bounce");
  const state = await getOutreachState("cu-b");
  assert.equal(state.followup, null);
  assert.equal(state.bounce.address, "cu-b@example.com");
  const next = seedRequest("req-b2", "cu-b", { company: "Beta", createdAt: "2026-09-28T17:00:00.000Z" });
  await assert.rejects(
    processMatchRequest(next, history(), sendOptions()),
    (error) => error.code === "OUTREACH_EMAIL_BOUNCED",
  );
  assert.equal(mailroom.enqueued.length, 1);
});
