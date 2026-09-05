import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { GMAIL_ROLE_INTEREST_SCOPE, paraformRoleLink } from "../api/submissions-v2/_lib/email-source-policy.mjs";
import { authoredReply, collectInterviewWindow, interviewReplyEvents, interviewSearch, offeredRoles, outboundParent, roleInterestSearch } from "../api/submissions-v2/_lib/gmail-interview-source.mjs";
import { normalizeEmailReply } from "../api/submissions-v2/_lib/contracts.mjs";
import { serviceInternals } from "../api/submissions-v2/_lib/service.mjs";
import { gmailWindow, reconcileGmailInterviews, sourceAuthorityHeaders } from "../submissions-v2-worker/gmail-reader.mjs";
import { createWorkerHandlers } from "../submissions-v2-worker/worker-handlers.mjs";
import { rowDto } from "../api/submissions-v2/_lib/presentation.mjs";
import { repositoryInternals } from "../api/submissions-v2/_lib/repository.mjs";

const env = { SUBMISSIONS_V2_EMAIL_HMAC_KEY: "h".repeat(40), SUBMISSIONS_V2_EMAIL_HMAC_VERSION: "v1", SUBMISSIONS_V2_GMAIL_ACTIVATED_AT: "2026-09-02T02:45:14.308Z", SUBMISSIONS_V2_MASTER_INBOX_WORKER_KEY: "k".repeat(40) };
const start = Date.parse(env.SUBMISSIONS_V2_GMAIL_ACTIVATED_AT);
const sourceSession = "11111111-1111-4111-8111-111111111111";
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
  assert.equal(normalizeEmailReply(event).event.adapter_version, "gmail-role-interest-v2");
});

test("silence, sent mail, drafts, automation, and unrelated subjects produce no signals", () => {
  assert.equal(interviewReplyEvents(thread([]), options).length, 0);
  for (const patch of [{ labels: ["SENT"] }, { labels: ["DRAFT"] }, { labels: ["SPAM"] }, { labels: ["TRASH"] }, { headers: { "Auto-Submitted": "auto-replied" } }, { headers: { "Precedence": "bulk" } }, { headers: { "List-Id": "list.example.com" } }, { from: "noreply@example.com" }, { from: "colleague@raydar.xyz" }, { headers: { "In-Reply-To": "", References: "" } }]) {
    assert.equal(interviewReplyEvents(thread([message(patch)]), options).length, 0, JSON.stringify(patch));
  }
});

test("encoded subjects remain detectable and HTML quoted consent is excluded", () => {
  const subject = `=?UTF-8?B?${Buffer.from("Re: Interview Request @ Example 🎉").toString("base64")}?=`;
  const [event] = interviewReplyEvents(thread([message({ subject, mime: "text/html", body: '<p>No thanks.</p><blockquote>Yes, I am interested.</blockquote>' })]), options);
  assert.equal(event.candidate_authored_text, "No thanks.");
  assert.equal(authoredReply(message({ mime: "text/html", body: '<div>What salary?</div><div class="gmail_quote">Yes please</div>' })), "What salary?");
});

test("Fyxer service notices are excluded by exact sender even without machine headers", () => {
  const notice = message({ from: "Fyxer <drafts@fyxer.com>", subject: "Re: Raydar - 1st Round Interview", body: "We checked your calendar. Create an event now." });
  assert.deepEqual(interviewReplyEvents({ id: "ab", messages: [notice] }, options), []);
  assert.equal(interviewReplyEvents(thread([message({ from: "Fyxer <person@example.com>" })]), options).length, 1);
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

test("strict Paraform share links carry the exact role id while digest and malformed links never do", () => {
  assert.equal(paraformRoleLink("https://www.paraform.com/share/example-company/role-123456")?.role_id, "role-123456");
  assert.equal(paraformRoleLink("https://paraform.com/share/example.company/role_abcdef")?.role_id, "role_abcdef");
  for (const value of [
    "https://www.paraform.com/digest/role-123456",
    "https://www.paraform.com/lists/role-123456",
    "https://www.paraform.com/share/example-company/short",
    "https://www.paraform.com/share/example-company/role-123456/extra",
    "https://www.paraform.com/share/example-company/role-123456?candidate=other",
    "https://www.paraform.com.evil.example/share/example-company/role-123456",
  ]) assert.equal(paraformRoleLink(value), null, value);
  assert.deepEqual(offeredRoles(sent({ body: "Any interest in exploring Engineer @ Example (https://www.paraform.com/share/example-company/role-123456)? Digest: https://www.paraform.com/digest/not-a-role" })).map((role) => role.role_id), ["role-123456"]);
});

test("the direct outbound parent wins over older role offers so prep replies are not fresh interest", () => {
  const oldOffer = sent({ id: "old", at: start - 3000, body: "Any interest in exploring Engineer @ Example (https://www.paraform.com/share/example-company/role-old1)?" });
  const prep = sent({ id: "prep", at: start - 1000, body: "Here is what to expect in the later interview stage.", headers: { "Message-ID": "<prep@example.com>", "In-Reply-To": "<old@example.com>", References: "<old@example.com>" } });
  const reply = message({ headers: { "In-Reply-To": "<prep@example.com>", References: "<old@example.com> <prep@example.com>" }, body: "What format will that stage use?" });
  assert.equal(outboundParent([oldOffer, prep], reply, "person@example.com")?.id, "prep");
  assert.deepEqual(interviewReplyEvents({ id: "ab", messages: [oldOffer, prep, reply] }, options), []);
});

test("the final References parent is usable only when In-Reply-To is absent", () => {
  const offer = sent({ id: "offer", body: "Any interest in exploring Engineer @ Example (https://www.paraform.com/share/example-company/role-123456)?" });
  const reply = message({ headers: { "In-Reply-To": "", References: "<unavailable@example.com> <offer@example.com>" } });
  const [event] = interviewReplyEvents({ id: "ab", messages: [offer, reply] }, options);
  assert.equal(event.offered_roles[0].role_id, "role-123456");
});

test("prep parents with real role links and quoted offers cannot turn acknowledgements into new interest", () => {
  const quotedOffer = "Any interest in exploring this role? https://www.paraform.com/share/example-company/role-123456";
  for (const original of [
    sent({ body: `Here is your interview preparation guide for https://www.paraform.com/share/example-company/role-123456.\n\nOn Wed, David wrote:\n> ${quotedOffer}` }),
    sent({ mime: "text/html", body: `<p>Your interview is scheduled; here are the preparation materials.</p><div class="gmail_quote">${quotedOffer}</div>` }),
  ]) {
    assert.deepEqual(interviewReplyEvents(thread([message({ body: "Yes, looks good." })], original), options), []);
  }
});

test("acknowledgements of recruiter updates do not inherit an older quoted role offer", () => {
  const oldOffer = "Would you be interested in Engineer? https://www.paraform.com/share/example-company/role-123456";
  for (const original of [
    sent({ body: `Glad to hear it! I will get the ball rolling with the team and keep you posted.\n\nOn Wed, Sample wrote:\n> Sounds great.\n> ${oldOffer}` }),
    sent({ mime: "text/html", body: `<p>I will get the ball rolling and keep you posted.</p><div class="gmail_quote">${oldOffer}</div>` }),
  ]) {
    assert.deepEqual(interviewReplyEvents(thread([message({ body: "Sounds great, thanks for the update!" })], original), options), []);
  }
  const [realOffer] = interviewReplyEvents(thread([message({ body: "Yes, please." })], sent({
    body: `Would you be interested in this new role? https://www.paraform.com/share/example-company/role-current\n\nOn Wed, Sample wrote:\n> ${oldOffer}`,
  })), options);
  assert.deepEqual(realOffer.offered_roles.map((item) => item.role_id), ["role-current"]);
});

test("approved New Match and Fit Follow Up parents use their own families", () => {
  const newMatch = sent({ subject: "A New Match", body: "Would you be interested in this role? https://www.paraform.com/share/example-company/role-123456" });
  const [newEvent] = interviewReplyEvents(thread([message({ subject: "Re: A New Match" })], newMatch), options);
  assert.equal(newEvent.source_family, "new_match");
  assert.equal(newEvent.offered_roles[0].role_id, "role-123456");

  const fit = sent({ subject: "Raydar - 1st Round Interview", body: "Thanks for taking the time to chat with our AI agent. See matches here: https://www.paraform.com/lists/example. Let me know if any of these opportunities look interesting." });
  const fitReply = message({ subject: "Re: Raydar - 1st Round Interview" });
  const [fitEvent] = interviewReplyEvents(thread([fitReply], fit), options);
  assert.equal(fitEvent.source_family, "fit_follow_up_with_matches");
  assert.ok(normalizeEmailReply(fitEvent).errors.includes("offered_roles_missing"));
});

test("multiple offered roles stay in one event for contextual classification", () => {
  const [event] = interviewReplyEvents(thread([message()], sent({ body: "https://paraform.com/browse?role=one https://paraform.com/browse?role=two https://paraform.com/browse?role=one" })), options);
  assert.deepEqual(event.offered_roles.map((role) => role.role_id), ["one", "two"]);
});

test("missing original remains Review, while a known prep/admin parent is excluded", () => {
  const [event] = interviewReplyEvents({ id: "ab", messages: [message({ body: "Yes, please." })] }, options);
  assert.ok(normalizeEmailReply(event).errors.includes("offered_roles_missing"));
  const [fitFallback] = interviewReplyEvents({ id: "fit", messages: [message({ subject: "Re: Raydar - 1st Round Interview", body: "I am interested." })] }, options);
  assert.equal(fitFallback.source_family, "fit_follow_up_with_matches");
  assert.ok(normalizeEmailReply(fitFallback).errors.includes("offered_roles_missing"));
  const [blank] = interviewReplyEvents(thread([message({ body: "\nOn Wed, David wrote:\nYes" })]), options);
  assert.equal(blank.candidate_authored_text, "");
  assert.ok(normalizeEmailReply(blank).errors.includes("candidate_text_missing"));
  assert.deepEqual(interviewReplyEvents(thread([message()], sent({ body: "Here is the interview preparation guide and scheduling detail." })), options), []);
  assert.equal(authoredReply(message({ body: "No thanks.\nFrom: David\nYes" })), "No thanks.");
});

test("mail links are scoped to David and reject injected thread URLs", () => {
  const [event] = interviewReplyEvents(thread(), options);
  assert.equal(serviceInternals.trustedSignalUrl(event), "https://mail.google.com/mail/?authuser=david%40raydar.xyz#all/ab");
  assert.equal(serviceInternals.trustedSignalUrl({ ...event, provider_thread_id: "ab/../../evil" }), null);
  assert.equal(serviceInternals.trustedSignalUrl({ ...event, mailbox_id: "other" }), null);
  const signal_url = serviceInternals.trustedSignalUrl(event);
  assert.equal(rowDto({ signal_url }).signal_url, signal_url);
  assert.equal(repositoryInternals.signalUrlFromEnvelope({ signal_url }), signal_url);
  for (const bad of ["https://mail.google.com/other", "https://mail.google.com.evil.example/mail/?authuser=david%40raydar.xyz#all/ab", "https://mail.google.com/mail/?authuser=other#all/ab"]) {
    assert.equal(rowDto({ signal_url: bad }).signal_url, null);
    assert.equal(repositoryInternals.signalUrlFromEnvelope({ signal_url: bad }), null);
  }
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
  assert.match(roleInterestSearch(start, start + 300_000), /subject:"New Match"/u);
  assert.match(roleInterestSearch(start, start + 300_000), /subject:"Raydar - 1st Round Interview"/u);
  assert.match(roleInterestSearch(start, start + 300_000), /"See matches here"/u);
});

test("a no-window retry preserves a proven live checkpoint without a broker read", async () => {
  let called = false;
  const checkpoint = { through: start + 300_000, caught_up: true };
  const result = await reconcileGmailInterviews({
    env,
    checkpoint,
    now: start + 360_000,
    assertCurrent: async () => {},
    admit: async () => assert.fail("must not admit without a live window"),
    fetchImpl: async () => { called = true; throw new Error("must not read"); },
  });
  assert.equal(called, false);
  assert.equal(result.checkpoint, checkpoint);
  assert.equal(result.caught_up, true);
  assert.equal(result.threads_read, 0);
});

test("overflow narrows the window without admitting or skipping messages", async () => {
  const operations = [];
  const result = await reconcileGmailInterviews({ env, checkpointLane: "live", now: start + 600_000, assertCurrent: async () => {}, admit: async () => assert.fail("must not admit"),
    fetchImpl: async (_url, init) => {
      const request = JSON.parse(init.body); operations.push(request.operation);
      const resultValue = request.operation === "abort"
        ? { sourceSession, aborted: true, unsettledAdmissions: 0 }
        : { sourceSession, brokerScope: GMAIL_ROLE_INTEREST_SCOPE, messages: Array.from({ length: 13 }, (_, i) => ({ threadId: i.toString(16) })) };
      return new Response(JSON.stringify({ ok: true, result: resultValue }));
    },
  });
  assert.equal(result.narrowed, true); assert.equal(result.checkpoint.through, start); assert.equal(result.checkpoint.window_span_ms, 240_000);
  assert.deepEqual(operations, ["list", "abort"]);
});

test("broker failure before admission aborts, while an unacknowledged admission stays pinned without local intake", async () => {
  const base = { env, checkpointLane: "live", now: start + 600_000, assertCurrent: async () => {}, sleepImpl: async () => {} };
  await assert.rejects(reconcileGmailInterviews({ ...base, admit: async () => assert.fail("must not admit"), fetchImpl: async () => new Response(JSON.stringify({ error: "provider_budget_exhausted" }), { status: 429 }) }), /provider_budget_exhausted/u);
  const requests = [];
  await assert.rejects(reconcileGmailInterviews({ ...base, admit: async () => assert.fail("authority mode must not call local intake"), fetchImpl: async (_url, init) => {
    const request = JSON.parse(init.body); requests.push(request);
    const result = request.operation === "list" ? { messages: [{ threadId: "ab" }] }
      : request.operation === "thread" ? thread()
        : request.operation === "admit" ? { accepted: false }
          : { aborted: true, unsettledAdmissions: 0 };
    return new Response(JSON.stringify({ ok: true, result: { sourceSession, brokerScope: GMAIL_ROLE_INTEREST_SCOPE, ...result } }));
  } }), /intake_not_acknowledged/u);
  assert.deepEqual(requests.map((request) => request.operation), ["list", "thread", "admit"]);
  assert.equal(requests[2].sourceSession, sourceSession);
  assert.equal(requests[2].event.provider_message_id, "aa");
  await assert.rejects(reconcileGmailInterviews({ ...base, admit: async () => assert.fail("must not admit"), fetchImpl: async () => new Response(JSON.stringify({ ok: true, result: { sourceSession, messages: [] } })) }), /broker_scope_mismatch/u);
});

test("a broker session change aborts the original session before admission or checkpoint", async () => {
  const otherSession = "22222222-2222-4222-8222-222222222222";
  const requests = [];
  await assert.rejects(reconcileGmailInterviews({
    env, checkpointLane: "live", now: start + 600_000, assertCurrent: async () => {}, sleepImpl: async () => {},
    admit: async () => assert.fail("must not call local intake"),
    fetchImpl: async (_url, init) => {
      const request = JSON.parse(init.body); requests.push(request);
      if (request.operation === "list") return new Response(JSON.stringify({ ok: true, result: { sourceSession, brokerScope: GMAIL_ROLE_INTEREST_SCOPE, messages: [{ threadId: "ab" }] } }));
      if (request.operation === "thread") return new Response(JSON.stringify({ ok: true, result: { sourceSession: otherSession, brokerScope: GMAIL_ROLE_INTEREST_SCOPE, ...thread() } }));
      return new Response(JSON.stringify({ ok: true, result: { sourceSession, aborted: true, unsettledAdmissions: 0 } }));
    },
  }), /gmail_source_session_mismatch/u);
  assert.deepEqual(requests.map((request) => request.operation), ["list", "thread", "abort"]);
  assert.equal(requests[2].sourceSession, sourceSession);
});

test("an ambiguous admission persists only a minimal deterministic recovery token", async () => {
  const states = [];
  const requests = [];
  let dispatchedEvent;
  await assert.rejects(reconcileGmailInterviews({
    env,
    checkpointLane: "live",
    now: start + 600_000,
    assertCurrent: async () => {},
    onSourceSession: async (state) => states.push(structuredClone(state)),
    sleepImpl: async () => {},
    fetchImpl: async (_url, init) => {
      const request = JSON.parse(init.body); requests.push(request);
      if (request.operation === "list") return new Response(JSON.stringify({ ok: true, result: { sourceSession, brokerScope: GMAIL_ROLE_INTEREST_SCOPE, messages: [{ threadId: "ab" }] } }));
      if (request.operation === "thread") return new Response(JSON.stringify({ ok: true, result: { sourceSession, brokerScope: GMAIL_ROLE_INTEREST_SCOPE, ...thread() } }));
      if (request.operation === "admit") {
        dispatchedEvent = request.event;
        throw Object.assign(new Error("connection reset after dispatch"), { code: "source_admission_uncertain" });
      }
      assert.fail("an uncertain admission must not abort or checkpoint");
    },
  }), /connection reset after dispatch/u);
  assert.deepEqual(requests.map((request) => request.operation), ["list", "thread", "admit"]);
  const saved = states.at(-1);
  assert.equal(saved.sourceSession, sourceSession);
  assert.deepEqual(Object.keys(saved.pendingAdmission).sort(), [
    "content_digest", "event_id", "idempotency_key", "lane", "mailbox_id", "provider_message_id",
    "provider_thread_id", "request_digest", "schema_version", "scope", "source_family", "window",
  ]);
  assert.deepEqual(saved.pendingAdmission.window, { after: start, before: start + 480_000 });
  assert.equal(saved.pendingAdmission.event_id, dispatchedEvent.event_id);
  assert.equal(saved.pendingAdmission.content_digest, dispatchedEvent.content_digest);
  assert.match(saved.pendingAdmission.request_digest, /^[a-f0-9]{64}$/u);
  assert.doesNotMatch(JSON.stringify(saved), /candidate_authored_text|sent_message_text|Yes, I am interested/u);

  for (const brokerResult of [
    { accepted: true, existing: false, processing_state: "queued" },
    { accepted: true, existing: true, reconciled: true },
  ]) {
    const recoveryRequests = [];
    const recoveryStates = [];
    const result = await reconcileGmailInterviews({
      env,
      checkpoint: { through: start + 480_000, caught_up: true },
      checkpointLane: "live",
      resumeSourceSession: saved,
      now: start + 540_000,
      assertCurrent: async () => {},
      onSourceSession: async (state) => recoveryStates.push(structuredClone(state)),
      sleepImpl: async () => {},
      fetchImpl: async (_url, init) => {
        const request = JSON.parse(init.body); recoveryRequests.push(request);
        if (request.operation === "list") return new Response(JSON.stringify({ ok: true, result: { sourceSession, brokerScope: GMAIL_ROLE_INTEREST_SCOPE, messages: [{ threadId: "ab" }] } }));
        if (request.operation === "thread") return new Response(JSON.stringify({ ok: true, result: { sourceSession, brokerScope: GMAIL_ROLE_INTEREST_SCOPE, ...thread() } }));
        if (request.operation === "admit") return new Response(JSON.stringify({ ok: true, result: { sourceSession, ...brokerResult } }));
        if (request.operation === "abort") return new Response(JSON.stringify({ ok: true, result: { sourceSession, aborted: true, unsettledAdmissions: 0 } }));
        assert.fail("a no-window recovery cannot start a replacement scan");
      },
    });
    assert.deepEqual(recoveryRequests.map((request) => request.operation), ["list", "thread", "admit", "abort"]);
    assert.deepEqual(recoveryRequests[2].event, dispatchedEvent);
    assert.ok(recoveryRequests.slice(0, 3).every((request) => request.after === start && request.before === start + 480_000));
    assert.equal(recoveryStates.at(-1), null);
    assert.equal(result.completed, false);
    assert.equal(result.caught_up, true);
  }
});

test("recovery refuses a changed event and retains the old session without another admission", async () => {
  const states = [];
  const original = interviewReplyEvents(thread(), options)[0];
  const pendingAdmission = {
    schema_version: 1,
    scope: GMAIL_ROLE_INTEREST_SCOPE,
    lane: "live",
    window: { after: start, before: start + 300_000 },
    event_id: original.event_id,
    mailbox_id: original.mailbox_id,
    source_family: original.source_family,
    provider_message_id: original.provider_message_id,
    provider_thread_id: original.provider_thread_id,
    idempotency_key: original.idempotency_key,
    content_digest: original.content_digest,
    request_digest: "0".repeat(64),
  };
  const operations = [];
  await assert.rejects(reconcileGmailInterviews({
    env,
    checkpointLane: "live",
    resumeSourceSession: { sourceSession, pendingAdmission },
    now: start + 600_000,
    assertCurrent: async () => {},
    onSourceSession: async (state) => states.push(state),
    sleepImpl: async () => {},
    fetchImpl: async (_url, init) => {
      const request = JSON.parse(init.body); operations.push(request.operation);
      if (request.operation === "list") return new Response(JSON.stringify({ ok: true, result: { sourceSession, brokerScope: GMAIL_ROLE_INTEREST_SCOPE, messages: [{ threadId: "ab" }] } }));
      if (request.operation === "thread") return new Response(JSON.stringify({ ok: true, result: { sourceSession, brokerScope: GMAIL_ROLE_INTEREST_SCOPE, ...thread() } }));
      assert.fail("a digest mismatch cannot admit, abort, or checkpoint");
    },
  }), /gmail_source_recovery_event_mismatch/u);
  assert.deepEqual(operations, ["list", "thread"]);
  assert.deepEqual(states, []);
});

test("a saved session with no pending admission is closed before any provider read or V2 post", async () => {
  for (const alreadyClosed of [false, true]) {
    const operations = [];
    const states = [];
    const result = await reconcileGmailInterviews({
      env,
      checkpoint: { through: start + 480_000, caught_up: true },
      checkpointLane: "live",
      resumeSourceSession: { sourceSession },
      now: start + 540_000,
      assertCurrent: async () => {},
      onSourceSession: async (state) => states.push(state),
      fetchImpl: async (_url, init) => {
        const request = JSON.parse(init.body); operations.push(request.operation);
        assert.equal(request.operation, "abort");
        return alreadyClosed
          ? new Response(JSON.stringify({ error: "source_session_lost" }), { status: 409 })
          : new Response(JSON.stringify({ ok: true, result: { sourceSession, aborted: true, unsettledAdmissions: 0 } }));
      },
    });
    assert.deepEqual(operations, ["abort"]);
    assert.deepEqual(states, [null]);
    assert.equal(result.completed, false);
  }
});

test("the Gmail broker keeps one source session through the empty window checkpoint", async () => {
  const bodies = [];
  const result = await reconcileGmailInterviews({ env, checkpointLane: "live", now: start + 600_000, assertCurrent: async () => {}, admit: async () => assert.fail("must not call local intake"), sleepImpl: async () => {},
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body); bodies.push(body);
      const resultValue = body.operation === "list" ? { messages: [] }
        : body.operation === "checkpoint" ? { authorized: true, active: false, committed: 0 }
          : {};
      return new Response(JSON.stringify({ ok: true, result: { sourceSession, brokerScope: GMAIL_ROLE_INTEREST_SCOPE, ...resultValue } }));
    },
  });
  assert.equal(result.observed, 0);
  assert.deepEqual(bodies.map((body) => body.operation), ["list", "checkpoint"]);
  assert.equal(bodies[0].sourceSession, undefined);
  assert.equal(bodies[1].sourceSession, sourceSession);
  assert.deepEqual(bodies[1].checkpoint, result.checkpoint);
});

test("active shared authority travels only by the authenticated broker header and commits before returning progress", async () => {
  const encoded = Buffer.from(JSON.stringify([{ mailboxId: "david-raydar-xyz", family: "new_match", ownerId: "v2-reader", epoch: 4, fenceToken: "synthetic" }])).toString("base64url");
  const calls = [];
  const activeEnv = { ...env, SUBMISSIONS_V2_SOURCE_AUTHORITY_HEADER: encoded };
  const result = await reconcileGmailInterviews({ env: activeEnv, checkpointLane: "live", now: start + 600_000, assertCurrent: async () => {}, admit: async () => ({ accepted: true }), sleepImpl: async () => {},
    fetchImpl: async (_url, init) => {
      const request = JSON.parse(init.body);
      calls.push({ request, authority: init.headers["x-raydar-source-authority"] });
      if (request.operation === "checkpoint") return new Response(JSON.stringify({ ok: true, result: { sourceSession, authorized: true, active: true, committed: 1 } }));
      return new Response(JSON.stringify({ ok: true, result: { sourceSession, brokerScope: GMAIL_ROLE_INTEREST_SCOPE, messages: [] } }));
    },
  });
  assert.equal(result.checkpoint.through, start + 480_000);
  assert.deepEqual(calls.map((call) => call.request.operation), ["list", "checkpoint"]);
  assert.ok(calls.every((call) => call.authority === encoded));
  assert.deepEqual(calls[1].request.checkpoint, result.checkpoint);
  assert.equal(calls[1].request.lane, "live");
  assert.deepEqual(sourceAuthorityHeaders(activeEnv), { "x-raydar-source-authority": encoded });
  assert.throws(() => sourceAuthorityHeaders({ SUBMISSIONS_V2_SOURCE_AUTHORITY_HEADER: "%%%" }), /gmail_source_authority_invalid/u);
  await assert.rejects(() => reconcileGmailInterviews({ env: activeEnv, now: start + 600_000, assertCurrent: async () => {}, admit: async () => ({ accepted: true }) }), /checkpoint_lane_invalid/u);
});

test("worker Gmail mode commits only broker-acknowledged progress under the existing email fence", async () => {
  let committed; let health; let admitted = 0;
  const sql = async () => []; sql.json = (v) => v;
  const handlers = createWorkerHandlers({ env: { ...env, SUBMISSIONS_V2_EMAIL_READER: "gmail" }, sql, resumeStore: {},
    repository: { recordSourceHealth: async (value) => { health = value; } },
    service: { intakeMasterInbox: async () => { admitted += 1; return { accepted: true }; } },
    sourceLease: { claimSourceCursor: async () => ({ fencing_token: 4, checkpoint: { prior: true, gmail: { through: start + 300_000, window_span_ms: 60_000 } } }), commitSourceCursor: async (value) => { committed = value; return {}; }, releaseSourceCursor: async () => {} },
    gmailInterviews: async ({ admit, checkpoint, checkpointLane }) => { assert.equal(admit, undefined); assert.deepEqual(checkpoint, { through: start + 300_000 }); assert.equal(checkpointLane, "live"); return { checkpoint: { through: start + 360_000 }, completed: true, caught_up: true, accepted: 1, observed: 1 }; },
    masterInbox: async () => assert.fail("not both transports"), now: () => new Date(start + 600_000),
  });
  await handlers.reconcile_master_inbox({ job: {}, workerId: "test", controlEpoch: 5, checkpoint: async () => {}, signal: new AbortController().signal });
  assert.equal(admitted, 0); assert.equal(committed.sourceKey, "master_inbox"); assert.equal(committed.controlEpoch, 5);
  assert.equal(committed.checkpoint.prior, true); assert.equal(committed.checkpoint.gmail.through, start + 300_000);
  const scoped = committed.checkpoint.gmail.scopes[GMAIL_ROLE_INTEREST_SCOPE];
  assert.equal(scoped.live.through, start + 360_000);
  assert.equal(scoped.live.caught_up, true);
  assert.equal(scoped.catchup.caught_up, undefined);
  assert.equal(health.delayed, true);
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

test("live Gmail progress commits when bounded catch-up hits provider quota", async () => {
  let committed; let health; const budgets = []; let calls = 0;
  const sql = async () => []; sql.json = (value) => value;
  const handlers = createWorkerHandlers({ env: { ...env, SUBMISSIONS_V2_EMAIL_READER: "gmail" }, sql, resumeStore: {}, service: { intakeMasterInbox: async () => ({ accepted: true }) },
    repository: { recordSourceHealth: async (value) => { health = value; } },
    sourceLease: {
      claimSourceCursor: async () => ({ fencing_token: 7, checkpoint: { gmail: { through: start + 300_000, scopes: { [GMAIL_ROLE_INTEREST_SCOPE]: { catchup: { through: start } } } } } }),
      commitSourceCursor: async (value) => { committed = value; return {}; },
      releaseSourceCursor: async () => assert.fail("live progress must commit"),
    },
    gmailInterviews: async ({ checkpoint, checkpointLane, maxThreads }) => {
      budgets.push(maxThreads);
      if (calls++ === 0) {
        assert.equal(checkpointLane, "live");
        assert.equal(checkpoint.through, start + 300_000);
        return { checkpoint: { through: start + 360_000 }, caught_up: true, completed: true, threads_read: 9, accepted: 1, observed: 1 };
      }
      assert.equal(checkpointLane, "catchup");
      assert.equal(checkpoint.through, start);
      throw Object.assign(new Error("quota"), { code: "provider_budget_exhausted" });
    },
    now: () => new Date(start + 600_000),
  });
  const result = await handlers.reconcile_master_inbox({ job: {}, workerId: "test", controlEpoch: 5, checkpoint: async () => {}, signal: new AbortController().signal });
  assert.deepEqual(budgets, [12, 3]);
  assert.equal(committed.checkpoint.gmail.scopes[GMAIL_ROLE_INTEREST_SCOPE].live.through, start + 360_000);
  assert.equal(committed.checkpoint.gmail.scopes[GMAIL_ROLE_INTEREST_SCOPE].catchup.through, start);
  assert.equal(health.errorClass, "provider_budget_exhausted");
  assert.equal(result.checkpoint.catchup_delayed, true);
});

test("a no-window live retry still advances catch-up within the shared thread budget", async () => {
  let committed; let health; const budgets = []; let calls = 0;
  const sql = async () => []; sql.json = (value) => value;
  const handlers = createWorkerHandlers({ env: { ...env, SUBMISSIONS_V2_EMAIL_READER: "gmail" }, sql, resumeStore: {}, service: { intakeMasterInbox: async () => ({ accepted: true }) },
    repository: { recordSourceHealth: async (value) => { health = value; } },
    sourceLease: {
      claimSourceCursor: async () => ({ fencing_token: 9, checkpoint: { gmail: { scopes: { [GMAIL_ROLE_INTEREST_SCOPE]: { live: { through: start + 300_000, caught_up: true }, catchup: { through: start } } } } } }),
      commitSourceCursor: async (value) => { committed = value; return {}; },
      releaseSourceCursor: async () => assert.fail("durable lanes must commit"),
    },
    gmailInterviews: async ({ checkpoint, checkpointLane, maxThreads }) => {
      budgets.push(maxThreads);
      if (calls++ === 0) {
        assert.equal(checkpointLane, "live");
        assert.deepEqual(checkpoint, { through: start + 300_000, caught_up: true });
        return { checkpoint, completed: false, caught_up: true, accepted: 0, observed: 0, threads_read: 0 };
      }
      assert.equal(checkpointLane, "catchup");
      assert.deepEqual(checkpoint, { through: start });
      return { checkpoint: { through: start + 120_000 }, completed: true, caught_up: false, accepted: 0, observed: 0, threads_read: 8 };
    },
    now: () => new Date(start + 360_000),
  });
  const result = await handlers.reconcile_master_inbox({ job: {}, workerId: "test", controlEpoch: 5, checkpoint: async () => {}, signal: new AbortController().signal });
  assert.deepEqual(budgets, [12, 12]);
  const scoped = committed.checkpoint.gmail.scopes[GMAIL_ROLE_INTEREST_SCOPE];
  assert.deepEqual(scoped.live, { through: start + 300_000, caught_up: true });
  assert.deepEqual(scoped.catchup, { through: start + 120_000, caught_up: false });
  assert.equal(health.errorClass, "gmail_catching_up");
  assert.equal(result.checkpoint.catchup_delayed, false);
});

test("aborted catch-up never commits a live checkpoint", async () => {
  let committed = false; let released = false; let calls = 0;
  const controller = new AbortController();
  const sql = async () => []; sql.json = (value) => value;
  const handlers = createWorkerHandlers({ env: { ...env, SUBMISSIONS_V2_EMAIL_READER: "gmail" }, sql, resumeStore: {}, service: { intakeMasterInbox: async () => ({ accepted: true }) },
    repository: { recordSourceHealth: async () => {} },
    sourceLease: {
      claimSourceCursor: async () => ({ fencing_token: 8, checkpoint: { gmail: { through: start + 300_000, scopes: { [GMAIL_ROLE_INTEREST_SCOPE]: { catchup: { through: start } } } } } }),
      commitSourceCursor: async () => { committed = true; return {}; },
      releaseSourceCursor: async () => { released = true; },
    },
    gmailInterviews: async () => {
      if (calls++ === 0) return { checkpoint: { through: start + 360_000 }, caught_up: true, completed: true, threads_read: 1 };
      controller.abort();
      throw Object.assign(new Error("aborted"), { name: "AbortError", code: "aborted" });
    },
    now: () => new Date(start + 600_000),
  });
  await assert.rejects(
    handlers.reconcile_master_inbox({ job: {}, workerId: "test", controlEpoch: 5, checkpoint: async () => {}, signal: controller.signal }),
  );
  assert.equal(committed, false);
  assert.equal(released, true);
});
