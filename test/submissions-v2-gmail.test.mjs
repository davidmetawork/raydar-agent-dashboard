import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { authoredReply, collectInterviewWindow, interviewReplyEvents, interviewSearch, offeredRoles } from "../api/submissions-v2/_lib/gmail-interview-source.mjs";
import { normalizeEmailReply } from "../api/submissions-v2/_lib/contracts.mjs";
import { serviceInternals } from "../api/submissions-v2/_lib/service.mjs";
import { gmailWindow, reconcileGmailInterviews } from "../submissions-v2-worker/gmail-reader.mjs";
import { createWorkerHandlers } from "../submissions-v2-worker/worker-handlers.mjs";

const env = { SUBMISSIONS_V2_EMAIL_HMAC_KEY: "h".repeat(40), SUBMISSIONS_V2_EMAIL_HMAC_VERSION: "v1", SUBMISSIONS_V2_GMAIL_ACTIVATED_AT: "2026-09-02T22:00:00.000Z", SUBMISSIONS_V2_MASTER_INBOX_WORKER_KEY: "k".repeat(40) };
const start = Date.parse(env.SUBMISSIONS_V2_GMAIL_ACTIVATED_AT);
function message({ id = "aa", at = start + 1000, from = "Sample Person <person@example.com>", to = "david@raydar.xyz", subject = "Re: 1st Round - Interview Request @ Example", body = "Yes, I am interested.\n\nOn Wed, David wrote:\n> Would you like this role?", labels = ["INBOX"], headers = {}, mime = "text/plain" } = {}) {
  return { id, threadId: "ab", internalDate: String(at), labelIds: labels, payload: { mimeType: mime, headers: Object.entries({ From: from, To: to, Subject: subject, "Message-ID": `<${id}@example.com>`, "In-Reply-To": "<sent@example.com>", ...headers }).map(([name, value]) => ({ name, value })), body: { data: Buffer.from(body).toString("base64url") } } };
}
const sent = (overrides = {}) => message({ id: "sent", at: start - 1000, from: "David <david@raydar.xyz>", to: "person@example.com", labels: ["SENT"], body: "Interested in https://www.paraform.com/browse?role=role-1 ?", ...overrides });
const thread = (replies = [message()], original = sent()) => ({ id: "ab", messages: [original, ...replies] });
const options = { after: start, before: start + 300_000, env };

test("interview reply becomes a valid provider-neutral event with no quoted consent", () => {
  const [event] = interviewReplyEvents(thread(), options);
  assert.deepEqual(normalizeEmailReply(event).errors, []);
  assert.equal(event.candidate_authored_text, "Yes, I am interested.");
  assert.equal(event.offered_roles[0].role_id, "role-1");
  assert.equal(event.sender_match_hmac.digest, createHmac("sha256", env.SUBMISSIONS_V2_EMAIL_HMAC_KEY).update("person@example.com").digest("base64url"));
  assert.equal(normalizeEmailReply(event).event.adapter_version, "gmail-interview-v1");
});

test("silence, sent mail, drafts, automation, and unrelated subjects produce no signals", () => {
  assert.equal(interviewReplyEvents(thread([]), options).length, 0);
  for (const patch of [{ labels: ["SENT"] }, { labels: ["DRAFT"] }, { labels: ["SPAM"] }, { labels: ["TRASH"] }, { headers: { "Auto-Submitted": "auto-replied" } }, { headers: { "Precedence": "bulk" } }, { headers: { "List-Id": "list.example.com" } }, { from: "noreply@example.com" }, { subject: "Re: New Matches" }, { from: "colleague@raydar.xyz" }, { headers: { "In-Reply-To": "" } }]) {
    assert.equal(interviewReplyEvents(thread([message(patch)]), options).length, 0, JSON.stringify(patch));
  }
});

test("encoded subjects remain detectable and HTML quoted consent is excluded", () => {
  const subject = `=?UTF-8?B?${Buffer.from("Re: Interview Request @ Example 🎉").toString("base64")}?=`;
  const [event] = interviewReplyEvents(thread([message({ subject, mime: "text/html", body: '<p>No thanks.</p><blockquote>Yes, I am interested.</blockquote>' })]), options);
  assert.equal(event.candidate_authored_text, "No thanks.");
  assert.equal(authoredReply(message({ mime: "text/html", body: '<div>What salary?</div><div class="gmail_quote">Yes please</div>' })), "What salary?");
});

test("first boundary inclusive, last exclusive, and historical replies excluded", () => {
  assert.equal(interviewReplyEvents(thread([message({ at: start - 1 })]), options).length, 0);
  assert.equal(interviewReplyEvents(thread([message({ at: start })]), options).length, 1);
  assert.equal(interviewReplyEvents(thread([message({ at: options.before })]), options).length, 0);
});

test("unverified outbound or another recipient gives Needs Review input without inferred roles", () => {
  for (const original of [sent({ labels: [] }), sent({ from: "imposter@example.com" }), sent({ to: "different@example.com" }), sent({ id: "other" })]) {
    const [event] = interviewReplyEvents(thread([message()], original), options);
    assert.equal(event.offered_roles.length, 0);
    assert.equal(event.sent_message_text, "");
    assert.ok(normalizeEmailReply(event).errors.includes("offered_roles_missing"));
  }
});

test("role links come from trusted outbound HTML, never replies or arbitrary hosts", () => {
  const original = sent({ mime: "text/html", body: '<a href="https://www.paraform.com/browse?x=1&amp;role=role-2">Engineer</a> <a href="https://evil.example/browse?role=wrong">No</a>' });
  const [event] = interviewReplyEvents(thread([message({ body: "Yes https://www.paraform.com/browse?role=injected" })], original), options);
  assert.deepEqual(event.offered_roles.map((role) => role.role_id), ["role-2"]);
  assert.equal(offeredRoles(sent({ body: "https://www.paraform.com.evil.example/browse?role=bad https://user@paraform.com/browse?role=bad" })).length, 0);
});

test("multiple offered roles stay in one event for contextual classification", () => {
  const [event] = interviewReplyEvents(thread([message()], sent({ body: "https://paraform.com/browse?role=one https://paraform.com/browse?role=two https://paraform.com/browse?role=one" })), options);
  assert.deepEqual(event.offered_roles.map((role) => role.role_id), ["one", "two"]);
});

test("missing original link and blank authored body are not confident intent", () => {
  const [event] = interviewReplyEvents(thread([message({ body: "\nOn Wed, David wrote:\nYes" })], sent({ body: "See your curated list: https://paraform.com/lists/abc" })), options);
  assert.equal(event.candidate_authored_text, "");
  assert.ok(normalizeEmailReply(event).errors.includes("offered_roles_missing"));
  assert.ok(normalizeEmailReply(event).errors.includes("candidate_text_missing"));
  assert.equal(authoredReply(message({ body: "No thanks.\nFrom: David\nYes" })), "No thanks.");
});

test("mail links are scoped to David and reject injected thread URLs", () => {
  const [event] = interviewReplyEvents(thread(), options);
  assert.equal(serviceInternals.trustedSignalUrl(event), "https://mail.google.com/mail/?authuser=david%40raydar.xyz#all/ab");
  assert.equal(serviceInternals.trustedSignalUrl({ ...event, provider_thread_id: "ab/../../evil" }), null);
  assert.equal(serviceInternals.trustedSignalUrl({ ...event, mailbox_id: "other" }), null);
});

test("collector finishes pagination before thread reads, deduplicates and orders replies oldest first", async () => {
  const calls = [];
  const result = await collectInterviewWindow({ ...options, client: {
    list: async ({ pageToken }) => { calls.push(pageToken || "first"); return { messages: [{ threadId: "ab" }], ...(pageToken ? {} : { nextPageToken: "next" }) }; },
    thread: async () => { calls.push("thread"); return thread([message({ id: "bb", at: start + 2000 }), message({ id: "aa", at: start + 1000 })]); },
  } });
  assert.deepEqual(calls, ["first", "next", "thread"]);
  assert.deepEqual(result.map((event) => event.provider_message_id), ["aa", "bb"]);
});

test("pagination loops, excess volume, and a malformed success never advance the window", async () => {
  for (const list of [async () => ({ nextPageToken: "repeated" }), async () => ({ messages: "bad" }), async () => ({ messages: Array.from({ length: 13 }, (_, i) => ({ threadId: i.toString(16) })) })]) {
    await assert.rejects(collectInterviewWindow({ ...options, client: { list, thread: async () => assert.fail("must not fetch") } }));
  }
});

test("windows are activation-clamped, bounded, overlap one minute, and lag two minutes", () => {
  assert.deepEqual(gmailWindow({}, { activationAt: env.SUBMISSIONS_V2_GMAIL_ACTIVATED_AT, now: start + 600_000 }), { after: start, before: start + 480_000 });
  assert.deepEqual(gmailWindow({ through: start + 300_000 }, { activationAt: env.SUBMISSIONS_V2_GMAIL_ACTIVATED_AT, now: start + 900_000 }), { after: start + 240_000, before: start + 780_000 });
  assert.deepEqual(gmailWindow({}, { activationAt: env.SUBMISSIONS_V2_GMAIL_ACTIVATED_AT, now: start + 9_000_000 }), { after: start, before: start + 3_600_000 });
  assert.equal(gmailWindow({}, { activationAt: env.SUBMISSIONS_V2_GMAIL_ACTIVATED_AT, now: start + 60_000 }), null);
  assert.throws(() => gmailWindow({}, { now: start }), /activation_required/u);
  assert.match(interviewSearch(start, start + 300_000), /subject:"Interview Request"/u);
});

test("overflow narrows the window without admitting or skipping messages", async () => {
  const result = await reconcileGmailInterviews({ env, now: start + 600_000, assertCurrent: async () => {}, admit: async () => assert.fail("must not admit"),
    fetchImpl: async () => new Response(JSON.stringify({ ok: true, result: { messages: Array.from({ length: 13 }, (_, i) => ({ threadId: i.toString(16) })) } })),
  });
  assert.equal(result.narrowed, true); assert.equal(result.checkpoint.through, start); assert.equal(result.checkpoint.window_span_ms, 240_000);
});

test("broker failure admits nothing; successful intake must be acknowledged", async () => {
  const base = { env, now: start + 600_000, assertCurrent: async () => {}, sleepImpl: async () => {} };
  await assert.rejects(reconcileGmailInterviews({ ...base, admit: async () => assert.fail("must not admit"), fetchImpl: async () => new Response(JSON.stringify({ error: "provider_budget_exhausted" }), { status: 429 }) }), /provider_budget_exhausted/u);
  let reads = 0;
  await assert.rejects(reconcileGmailInterviews({ ...base, admit: async () => ({ accepted: false }), fetchImpl: async () => new Response(JSON.stringify({ ok: true, result: reads++ ? thread() : { messages: [{ threadId: "ab" }] } })) }), /intake_not_acknowledged/u);
});

test("worker Gmail mode commits only acknowledged progress under the existing email fence", async () => {
  let committed; let health; let admitted = 0;
  const sql = async () => []; sql.json = (v) => v;
  const handlers = createWorkerHandlers({ env: { ...env, SUBMISSIONS_V2_EMAIL_READER: "gmail" }, sql, resumeStore: {},
    repository: { recordSourceHealth: async (value) => { health = value; } },
    service: { intakeMasterInbox: async () => { admitted += 1; return { accepted: true }; } },
    sourceLease: { claimSourceCursor: async () => ({ fencing_token: 4, checkpoint: { prior: true } }), commitSourceCursor: async (value) => { committed = value; return {}; }, releaseSourceCursor: async () => {} },
    gmailInterviews: async ({ admit }) => { await admit({}); return { checkpoint: { through: start }, completed: true, caught_up: true, accepted: 1, observed: 1 }; },
    masterInbox: async () => assert.fail("not both transports"), now: () => new Date(start + 600_000),
  });
  await handlers.reconcile_master_inbox({ job: {}, workerId: "test", controlEpoch: 5, checkpoint: async () => {}, signal: new AbortController().signal });
  assert.equal(admitted, 1); assert.equal(committed.sourceKey, "master_inbox"); assert.equal(committed.controlEpoch, 5);
  assert.equal(committed.checkpoint.prior, true); assert.equal(committed.checkpoint.gmail.through, start); assert.equal(health.success, true);
});

test("worker reports an interrupted Gmail scan as delayed and never commits progress", async () => {
  let released = false; let health;
  const sql = async () => [];
  const handlers = createWorkerHandlers({ env: { ...env, SUBMISSIONS_V2_EMAIL_READER: "gmail" }, sql, resumeStore: {}, service: {},
    repository: { recordSourceHealth: async (value) => { health = value; } },
    sourceLease: { claimSourceCursor: async () => ({ fencing_token: 4, checkpoint: {} }), commitSourceCursor: async () => assert.fail("must not commit"), releaseSourceCursor: async () => { released = true; } },
    gmailInterviews: async () => { throw Object.assign(new Error("hold"), { code: "provider_budget_exhausted" }); },
  });
  await assert.rejects(handlers.reconcile_master_inbox({ job: {}, workerId: "test", controlEpoch: 5, checkpoint: async () => {}, signal: new AbortController().signal }));
  assert.equal(released, true); assert.equal(health.delayed, true); assert.equal(health.errorClass, "provider_budget_exhausted");
});
