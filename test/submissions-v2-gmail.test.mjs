import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { APPROVED_EMAIL_FAMILIES, GMAIL_ROLE_INTEREST_SCOPE, SUBMISSIONS_V2_APPROVED_ACTIVATION_AT, outboundEmailFamily, paraformRoleLink, replySubjectFamily } from "../api/submissions-v2/_lib/email-source-policy.mjs";
import { authoredReply, collectInterviewWindow, interviewReplyEvents, interviewSearch, offeredRoles, outboundParent, roleInterestSearch } from "../api/submissions-v2/_lib/gmail-interview-source.mjs";
import { EMAIL_FAMILIES, normalizeEmailReply } from "../api/submissions-v2/_lib/contracts.mjs";
import { serviceInternals } from "../api/submissions-v2/_lib/service.mjs";
import { gmailWindow, reconcileGmailInterviews } from "../submissions-v2-worker/gmail-reader.mjs";
import { createWorkerHandlers } from "../submissions-v2-worker/worker-handlers.mjs";
import { rowDto } from "../api/submissions-v2/_lib/presentation.mjs";
import { repositoryInternals } from "../api/submissions-v2/_lib/repository.mjs";

const env = { SUBMISSIONS_V2_EMAIL_HMAC_KEY: "h".repeat(40), SUBMISSIONS_V2_EMAIL_HMAC_VERSION: "v1", SUBMISSIONS_V2_GMAIL_ACTIVATED_AT: "2026-09-02T02:45:14.308Z", SUBMISSIONS_V2_MASTER_INBOX_WORKER_KEY: "k".repeat(40) };
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

const MATCH_WATCH_SINGLE = [
  "Hey Sample,",
  "I recently got a new role that I think you would be a strong fit for!",
  "The role is with Example and they are looking to bring on a Engineer",
  "Linking the Job Description here: https://www.paraform.com/share/example-company/role-123456",
  "Let me know what you think!",
].join("\n\n");
const MATCH_WATCH_MULTI = [
  "Hey Sample,",
  "I recently got some new roles that I think you would be a strong fit for!",
  "Linking the Job Descriptions to the company names and job titles below so you can review :)",
  "Example - Engineer: https://www.paraform.com/share/example-company/role-123456",
  "Other Example - Designer: https://www.paraform.com/share/other-example/role-654321",
  "Let me know what you think!",
].join("\n\n");
const FIT_FOLLOW_UP_ONE = [
  "Hey Sample,",
  "Thanks for taking the time to chat!",
  "I went through all of our clients and hundreds of opportunities and was able to find a match with your background.",
  "See match here: https://www.paraform.com/lists/list-1",
  "Let me know if any of these opportunities look interesting and if so I can connect you with the respective teams ASAP!",
].join("\n\n");
const SCREENING_CALL_NO_MATCH = [
  "Hey Sample,",
  "Thanks for taking the time to chat!",
  "We were able to get all of your preferences down but unfortunately do not have any matching openings at the moment.",
].join("\n\n");

test("Match Watch replies enter Review by subject when the Mailroom original never reached Gmail", () => {
  // Measured 2026-09-08 (analysis note gmail-search-probe.md): 184 live replies carried
  // this subject and none of them produced a source event.
  for (const subject of ["Re: Raydar - New Role Match \u{1F389}", "Re: Raydar - New Role Matches \u{1F389}", "RE: Raydar - New Role Match"]) {
    const [event] = interviewReplyEvents({ id: "mw", messages: [message({ subject, body: "That first one looks interesting." })] }, options);
    assert.equal(event.source_family, "new_match", subject);
    assert.equal(event.offered_roles.length, 0, subject);
    assert.ok(normalizeEmailReply(event).errors.includes("offered_roles_missing"), subject);
  }
  assert.equal(replySubjectFamily("Raydar - New Role Match \u{1F389}"), "new_match");
  assert.equal(replySubjectFamily("Raydar - New Role Matches"), "new_match");
});

test("a surviving Match Watch original supplies its own family and its exact role links", () => {
  const single = sent({ subject: "Raydar - New Role Match \u{1F389}", body: MATCH_WATCH_SINGLE });
  const [one] = interviewReplyEvents(thread([message({ subject: "Re: Raydar - New Role Match \u{1F389}" })], single), options);
  assert.equal(one.source_family, "new_match");
  assert.deepEqual(one.offered_roles.map((role) => role.role_id), ["role-123456"]);
  const multi = sent({ subject: "Raydar - New Role Matches \u{1F389}", body: MATCH_WATCH_MULTI });
  const [many] = interviewReplyEvents(thread([message({ subject: "Re: Raydar - New Role Matches \u{1F389}" })], multi), options);
  assert.deepEqual(many.offered_roles.map((role) => role.role_id), ["role-123456", "role-654321"]);
  // Body markers alone are enough when a client rewrites the subject.
  assert.equal(outboundEmailFamily({ subject: "Following up", text: MATCH_WATCH_SINGLE, roleCount: 1 }), "new_match");
  assert.equal(outboundEmailFamily({ subject: "Following up", text: "Linking the Job Description here: https://example.com" }), null);
});

test("the one-match curated follow-up is admitted and the no-match screening copy is not", () => {
  const fit = sent({ subject: "Raydar - 1st Round Interview", body: FIT_FOLLOW_UP_ONE });
  const [event] = interviewReplyEvents(thread([message({ subject: "Re: Raydar - 1st Round Interview" })], fit), options);
  assert.equal(event.source_family, "fit_follow_up_with_matches");
  assert.equal(outboundEmailFamily({ subject: "Raydar - Screening Call", text: SCREENING_CALL_NO_MATCH }), null);
  assert.equal(replySubjectFamily("Re: Raydar - Screening Call"), null);
  assert.deepEqual(interviewReplyEvents(thread([message({ subject: "Re: Raydar - Screening Call", body: "Thanks for the call." })], sent({ subject: "Raydar - Screening Call", body: SCREENING_CALL_NO_MATCH })), options), []);
});

test("a screening-call thread admits only the roles a later offer in that thread carried", () => {
  const screening = sent({ id: "call", at: start - 3000, subject: "Raydar - Screening Call", body: SCREENING_CALL_NO_MATCH, headers: { "Message-ID": "<call@example.com>" } });
  const offer = sent({ id: "offer", at: start - 1000, subject: "Raydar - New Role Match \u{1F389}", body: MATCH_WATCH_SINGLE, headers: { "Message-ID": "<offer@example.com>", "In-Reply-To": "<call@example.com>", References: "<call@example.com>" } });
  const reply = message({ subject: "Re: Raydar - Screening Call", headers: { "In-Reply-To": "<offer@example.com>", References: "<call@example.com> <offer@example.com>" } });
  const [event] = interviewReplyEvents({ id: "call-thread", messages: [screening, offer, reply] }, options);
  assert.equal(event.source_family, "new_match");
  assert.deepEqual(event.offered_roles.map((role) => role.role_id), ["role-123456"]);
  const onlyCall = message({ subject: "Re: Raydar - Screening Call", headers: { "In-Reply-To": "<call@example.com>", References: "<call@example.com>" } });
  assert.deepEqual(interviewReplyEvents({ id: "call-thread", messages: [screening, onlyCall] }, options), []);
});

test("the Interview Agent invite subject stays out of the curated follow-up family", () => {
  for (const subject of [
    "Re: Raydar - 1st Round Interview - AI Engineer \u{1F389}",
    "Re: Raydar - 1st Round Interview \u{1F389} - Product Designer",
    "Re: Raydar - 1st Round Interview - Head of Product",
  ]) {
    assert.equal(replySubjectFamily(subject), null, subject);
    assert.deepEqual(interviewReplyEvents({ id: "invite", messages: [message({ subject, body: "Yes, that works." })] }, options), [], subject);
  }
  for (const subject of ["Re: Raydar - 1st Round Interview", "Raydar - 1st Round Interview \u{1F389}", "Fwd: raydar - 1st round interview"]) {
    assert.equal(replySubjectFamily(subject), "fit_follow_up_with_matches", subject);
  }
});

test("every message the reader skips is counted by reason instead of vanishing", () => {
  const admitted = message({ id: "keep", subject: "Re: Raydar - New Role Match \u{1F389}", body: "Sounds good." });
  const scan = interviewReplyEvents({ id: "mixed", messages: [
    admitted,
    message({ id: "old", at: start - 5, subject: "Re: Raydar - New Role Match \u{1F389}" }),
    message({ id: "draft", labels: ["DRAFT"] }),
    message({ id: "auto", headers: { "Auto-Submitted": "auto-replied" } }),
    message({ id: "mate", from: "colleague@raydar.xyz" }),
    message({ id: "bare", headers: { "In-Reply-To": "", References: "" } }),
    message({ id: "other", subject: "Re: Quick question about payroll" }),
  ] }, options);
  assert.deepEqual(scan.map((event) => event.provider_message_id), ["keep"]);
  assert.deepEqual(scan.accounting, {
    admitted: 1,
    outside_window: 1,
    excluded_label: 1,
    machine: 1,
    sender_excluded: 1,
    no_reference_headers: 1,
    prep_admin_parent: 0,
    family_unknown: 1,
  });
  const prep = interviewReplyEvents(thread([message({ body: "Yes, looks good." })], sent({ body: "Here is your interview preparation guide." })), options);
  assert.equal(prep.accounting.prep_admin_parent, 1);
  assert.equal(prep.accounting.family_unknown, 0);
});

test("the window collector and the reader report one merged deferral account", async () => {
  const result = await collectInterviewWindow({ ...options, client: {
    list: async () => ({ messages: [{ threadId: "ab" }] }),
    thread: async () => ({ id: "ab", messages: [
      message({ id: "keep", subject: "Re: Raydar - New Role Matches \u{1F389}" }),
      message({ id: "other", subject: "Re: Quick question about payroll" }),
    ] }),
  } });
  assert.equal(result.length, 1);
  assert.equal(result.accounting.admitted, 1);
  assert.equal(result.accounting.family_unknown, 1);
  const reader = await reconcileGmailInterviews({ env, now: start + 600_000, assertCurrent: async () => {}, admit: async () => ({ accepted: true }), sleepImpl: async () => {},
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      return new Response(JSON.stringify({ ok: true, result: { brokerScope: GMAIL_ROLE_INTEREST_SCOPE, ...(body.operation === "list"
        ? { messages: [{ threadId: "ab" }] }
        : { id: "ab", messages: [message({ id: "other", subject: "Re: Quick question about payroll" })] }) } }));
    },
  });
  assert.equal(reader.observed, 0);
  assert.equal(reader.accounting.family_unknown, 1);
});

test("Match Watch reuses the approved new_match family and the forward-only boundary is untouched", () => {
  // A family string the contract layer does not know is quarantined, and an unapproved
  // family also loses the explicit-role fallback in service.intakeMasterInbox.
  for (const family of APPROVED_EMAIL_FAMILIES) assert.ok(EMAIL_FAMILIES.has(family), family);
  assert.equal(SUBMISSIONS_V2_APPROVED_ACTIVATION_AT, "2026-09-02T02:45:14.308Z");
  const [event] = interviewReplyEvents({ id: "mw", messages: [message({ subject: "Re: Raydar - New Role Match \u{1F389}" })] }, options);
  assert.equal(normalizeEmailReply(event).event.source_family, "new_match");
  assert.equal(normalizeEmailReply(event).quarantined, false);
});

test("the worker job summary reports the merged deferral account for both Gmail lanes", async () => {
  let committed; const sql = async () => []; sql.json = (value) => value; let calls = 0;
  const handlers = createWorkerHandlers({ env: { ...env, SUBMISSIONS_V2_EMAIL_READER: "gmail" }, sql, resumeStore: {},
    service: { intakeMasterInbox: async () => ({ accepted: true }) },
    repository: { recordSourceHealth: async () => {} },
    sourceLease: {
      claimSourceCursor: async () => ({ fencing_token: 3, checkpoint: { gmail: { scopes: { [GMAIL_ROLE_INTEREST_SCOPE]: { live: { through: start + 300_000 }, catchup: { through: start } } } } } }),
      commitSourceCursor: async (value) => { committed = value; return {}; },
      releaseSourceCursor: async () => assert.fail("both lanes succeed"),
    },
    gmailInterviews: async () => (calls++ === 0
      ? { checkpoint: { through: start + 360_000 }, completed: true, caught_up: true, accepted: 1, observed: 1, threads_read: 1, accounting: { admitted: 1, family_unknown: 2, machine: 1 } }
      : { checkpoint: { through: start + 120_000 }, completed: true, caught_up: true, accepted: 0, observed: 0, threads_read: 1, accounting: { admitted: 0, family_unknown: 3 } }),
    now: () => new Date(start + 600_000),
  });
  const result = await handlers.reconcile_master_inbox({ job: {}, workerId: "test", controlEpoch: 5, checkpoint: async () => {}, signal: new AbortController().signal });
  assert.ok(committed);
  assert.deepEqual(result.checkpoint.deferred, {
    admitted: 1, outside_window: 0, excluded_label: 0, machine: 1,
    sender_excluded: 0, no_reference_headers: 0, prep_admin_parent: 0, family_unknown: 5,
  });
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
  assert.match(roleInterestSearch(start, start + 300_000), /subject:"New Role Match"/u);
  assert.match(roleInterestSearch(start, start + 300_000), /subject:"New Role Matches"/u);
  assert.match(roleInterestSearch(start, start + 300_000), /subject:"Raydar - 1st Round Interview"/u);
  assert.match(roleInterestSearch(start, start + 300_000), /"See matches here"/u);
  assert.match(roleInterestSearch(start, start + 300_000), /"See match here"/u);
  // The window, the lag, the overlap and the thread budget are untouched by the phrases.
  assert.match(roleInterestSearch(start, start + 300_000), /-from:david@raydar\.xyz -in:sent -in:drafts/u);
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
  const result = await reconcileGmailInterviews({ env, now: start + 600_000, assertCurrent: async () => {}, admit: async () => assert.fail("must not admit"),
    fetchImpl: async () => new Response(JSON.stringify({ ok: true, result: { brokerScope: GMAIL_ROLE_INTEREST_SCOPE, messages: Array.from({ length: 13 }, (_, i) => ({ threadId: i.toString(16) })) } })),
  });
  assert.equal(result.narrowed, true); assert.equal(result.checkpoint.through, start); assert.equal(result.checkpoint.window_span_ms, 240_000);
});

test("broker failure admits nothing; successful intake must be acknowledged", async () => {
  const base = { env, now: start + 600_000, assertCurrent: async () => {}, sleepImpl: async () => {} };
  await assert.rejects(reconcileGmailInterviews({ ...base, admit: async () => assert.fail("must not admit"), fetchImpl: async () => new Response(JSON.stringify({ error: "provider_budget_exhausted" }), { status: 429 }) }), /provider_budget_exhausted/u);
  let reads = 0;
  await assert.rejects(reconcileGmailInterviews({ ...base, admit: async () => ({ accepted: false }), fetchImpl: async () => new Response(JSON.stringify({ ok: true, result: { brokerScope: GMAIL_ROLE_INTEREST_SCOPE, ...(reads++ ? thread() : { messages: [{ threadId: "ab" }] }) } })) }), /intake_not_acknowledged/u);
  await assert.rejects(reconcileGmailInterviews({ ...base, admit: async () => ({ accepted: true }), fetchImpl: async () => new Response(JSON.stringify({ ok: true, result: { messages: [] } })) }), /broker_scope_mismatch/u);
});

test("the Gmail broker receives one approved multi-family scope without changing window controls", async () => {
  const bodies = [];
  const result = await reconcileGmailInterviews({ env, now: start + 600_000, assertCurrent: async () => {}, admit: async () => ({ accepted: true }), sleepImpl: async () => {},
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body); bodies.push(body);
      return new Response(JSON.stringify({ ok: true, result: { brokerScope: GMAIL_ROLE_INTEREST_SCOPE, ...(body.operation === "list" ? { messages: [] } : thread()) } }));
    },
  });
  assert.equal(result.observed, 0);
  assert.deepEqual(bodies, [{ after: start, before: start + 480_000, scope: GMAIL_ROLE_INTEREST_SCOPE, operation: "list" }]);
});

test("worker Gmail mode commits only acknowledged progress under the existing email fence", async () => {
  let committed; let health; let admitted = 0;
  const sql = async () => []; sql.json = (v) => v;
  const handlers = createWorkerHandlers({ env: { ...env, SUBMISSIONS_V2_EMAIL_READER: "gmail" }, sql, resumeStore: {},
    repository: { recordSourceHealth: async (value) => { health = value; } },
    service: { intakeMasterInbox: async () => { admitted += 1; return { accepted: true }; } },
    sourceLease: { claimSourceCursor: async () => ({ fencing_token: 4, checkpoint: { prior: true, gmail: { through: start + 300_000, window_span_ms: 60_000 } } }), commitSourceCursor: async (value) => { committed = value; return {}; }, releaseSourceCursor: async () => {} },
    gmailInterviews: async ({ admit, checkpoint }) => { assert.deepEqual(checkpoint, { through: start + 300_000 }); await admit({}); return { checkpoint: { through: start + 360_000 }, completed: true, caught_up: true, accepted: 1, observed: 1 }; },
    masterInbox: async () => assert.fail("not both transports"), now: () => new Date(start + 600_000),
  });
  await handlers.reconcile_master_inbox({ job: {}, workerId: "test", controlEpoch: 5, checkpoint: async () => {}, signal: new AbortController().signal });
  assert.equal(admitted, 1); assert.equal(committed.sourceKey, "master_inbox"); assert.equal(committed.controlEpoch, 5);
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
    gmailInterviews: async ({ checkpoint, maxThreads }) => {
      budgets.push(maxThreads);
      if (calls++ === 0) {
        assert.equal(checkpoint.through, start + 300_000);
        return { checkpoint: { through: start + 360_000 }, caught_up: true, completed: true, threads_read: 9, accepted: 1, observed: 1 };
      }
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
    gmailInterviews: async ({ checkpoint, maxThreads }) => {
      budgets.push(maxThreads);
      if (calls++ === 0) {
        assert.deepEqual(checkpoint, { through: start + 300_000, caught_up: true });
        return { checkpoint, completed: false, caught_up: true, accepted: 0, observed: 0, threads_read: 0 };
      }
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
