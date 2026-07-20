import assert from "node:assert/strict";
import test from "node:test";

import {
  additionalMatchCopy,
  companySlug,
  digestLinkLabel,
  followupCopy,
  initialMatchCopy,
  initialSubject,
  roleShareUrl,
} from "../api/paraai/_lib/outreach-copy.mjs";
import {
  buildMime,
  candidateRepliedAfter,
  deterministicMessageId,
  threadDigestAnchorStatus,
  threadReplyContext,
} from "../api/paraai/_lib/outreach-gmail.mjs";
import {
  calendarCandidateEvidence,
  discoverCandidateContact,
  gmailCandidateEvidence,
  normalizeContactName,
  resolveContactEvidence,
} from "../api/paraai/_lib/outreach-contact.mjs";
import {
  eligibleNewRequests,
  missingEmailAlertCopy,
  normalizeSubmissionRequest,
  outreachConfig,
  outreachExecutionEnabled,
  pendingBackfillRequests,
  planDeliveredFollowup,
  planDeliveredMatch,
  requestOrdinal,
} from "../api/paraai/_lib/outreach.mjs";
import {
  claimOutreachExceptionAlert,
  probeOutreachStore,
  recordOutreachException,
} from "../api/paraai/_lib/outreach-store.mjs";

const role = {
  roleName: "Software Engineer",
  companyName: "Reform",
  roleUrl: "https://www.paraform.com/share/reform/role-12345678",
  digestUrl: "https://www.paraform.com/digest/digest-12345678",
};
const bodyPayload = (text, mimeType = "text/plain") => ({
  mimeType,
  body: { data: Buffer.from(text, "utf8").toString("base64url") },
});

test("initial subject matches the approved interview-request format", () => {
  assert.equal(
    initialSubject("Pallet"),
    "1st Round - Interview Request @ Pallet 🎉",
  );
});
test("first-match copy preserves the approved wording and links", () => {
  const copy = initialMatchCopy({ firstName: "Amy", ...role });
  assert.match(copy.text, /^Hey Amy,\n\nHope you are doing well!/);
  assert.match(copy.text, /I shared a redacted version of your resume with the Founder/);
  assert.match(copy.text, /will add all interview requests you get here:/);
  assert.match(copy.text, /Amy's Interview Requests \(https:\/\/www\.paraform\.com\/digest\/digest-12345678\)/);
  assert.ok(copy.text.endsWith("Thanks,"));
  assert.match(copy.html, /<a href="https:\/\/www\.paraform\.com\/share\/reform\/role-12345678">Software Engineer @ Reform<\/a>/);
  assert.match(copy.html, /<a href="https:\/\/www\.paraform\.com\/digest\/digest-12345678">Amy's Interview Requests<\/a>/);
  assert.doesNotMatch(copy.html, />https:\/\/www\.paraform\.com\/digest\//);
  assert.equal(digestLinkLabel("Amy"), "Amy's Interview Requests");
});

test("HTML copy renders a literal blank Gmail line between every content block", () => {
  const initial = initialMatchCopy({ firstName: "Amy", ...role });
  const second = additionalMatchCopy({
    firstName: "Amy",
    ordinal: 2,
    variationSeed: "request-2",
    ...role,
  });
  const followup = followupCopy({
    firstName: "Amy",
    ordinal: 1,
    followupNumber: 1,
    ...role,
  });
  for (const copy of [initial, second, followup]) {
    const blockCount = (copy.html.match(/<div>/g) || []).length;
    const spacerCount = (copy.html.match(/<div><br><\/div>/g) || []).length;
    assert.equal(spacerCount, (blockCount - spacerCount) - 1);
    assert.doesNotMatch(copy.html, /<p>/);
  }
  assert.match(
    initial.html,
    /<div>Hey Amy,<\/div>\n<div><br><\/div>\n<div>Hope you are doing well!<\/div>/,
  );
});

test("second match is exact while third and later matches vary deterministically", () => {
  const second = additionalMatchCopy({
    firstName: "Amy",
    ordinal: 2,
    variationSeed: "request-2",
    ...role,
  });
  assert.equal(second.variant, "second_exact");
  assert.match(second.text, /You just got a new interview request for the Software Engineer @ Reform/);
  assert.match(second.text, /The founders think you would be a very strong match!/);
  assert.match(second.text, /Open to connecting with the team to discuss\?/);
  assert.match(second.text, /Reminder that I am adding all of these requests in one place for you to review:/);
  assert.match(second.html, />Amy's Interview Requests<\/a>/);

  const thirdA = additionalMatchCopy({
    firstName: "Amy",
    ordinal: 3,
    variationSeed: "stable-request",
    ...role,
  });
  const thirdB = additionalMatchCopy({
    firstName: "Amy",
    ordinal: 3,
    variationSeed: "stable-request",
    ...role,
  });
  assert.equal(thirdA.variant, thirdB.variant);
  assert.equal(thirdA.text, thirdB.text);
  assert.notEqual(thirdA.variant, "second_exact");
  assert.match(thirdA.text, /Software Engineer @ Reform/);
  assert.match(thirdA.text, /https:\/\/www\.paraform\.com\/digest\//);
});

test("follow-up copy uses two first-match touches and one later-match touch", () => {
  const first = followupCopy({
    firstName: "Amy",
    ordinal: 1,
    followupNumber: 1,
    ...role,
  });
  const last = followupCopy({
    firstName: "Amy",
    ordinal: 1,
    followupNumber: 2,
    ...role,
  });
  const additional = followupCopy({
    firstName: "Amy",
    ordinal: 2,
    followupNumber: 1,
    variationSeed: "request-2",
    ...role,
  });
  assert.equal(first.variant, "initial_followup_1");
  assert.equal(last.variant, "initial_followup_2");
  assert.match(last.text, /If not, no worries!/);
  assert.match(additional.variant, /^additional_followup_/);
});

test("company slug and share URL match Paraform's public role shape", () => {
  assert.equal(companySlug("ACME & Sons, Inc."), "acme-and-sons-inc");
  assert.equal(
    roleShareUrl({ companyName: "Reform", roleId: "role-12345678" }),
    "https://www.paraform.com/share/reform/role-12345678",
  );
});

test("Gmail MIME carries deterministic id and reply-thread headers", () => {
  const messageId = deterministicMessageId("match:request-123");
  assert.equal(messageId, deterministicMessageId("match:request-123"));
  assert.notEqual(messageId, deterministicMessageId("match:request-456"));
  const mime = buildMime({
    from: "David Phillips <david@raydar.xyz>",
    to: "candidate@example.com",
    subject: "Re: 1st Round @ CaroHQ 🎉",
    messageId,
    inReplyTo: "<last@example.com>",
    references: "<first@example.com> <last@example.com>",
    bodyText: "Hello",
    bodyHtml: "<p>Hello</p>",
  });
  assert.match(mime.raw, /Message-ID: <raydar-paraai-/);
  assert.match(mime.raw, /In-Reply-To: <last@example.com>/);
  assert.match(mime.raw, /References: <first@example.com> <last@example.com>/);
});

test("thread context follows the latest Gmail message and replies stop follow-ups", () => {
  const thread = {
    id: "thread-123",
    messages: [
      {
        internalDate: "1000",
        payload: { headers: [
          { name: "Subject", value: "1st Round @ CaroHQ 🎉" },
          { name: "Message-ID", value: "<first@example.com>" },
          { name: "From", value: "David Phillips <david@raydar.xyz>" },
        ] },
      },
      {
        internalDate: "2000",
        payload: { headers: [
          { name: "Message-ID", value: "<candidate@example.com>" },
          { name: "References", value: "<first@example.com>" },
          { name: "From", value: "Candidate <candidate@example.com>" },
        ] },
      },
      {
        internalDate: "3000",
        labelIds: ["DRAFT"],
        payload: { headers: [
          { name: "Message-ID", value: "<unsent-draft@example.com>" },
          { name: "References", value: "<first@example.com> <candidate@example.com>" },
          { name: "From", value: "David Phillips <david@raydar.xyz>" },
        ] },
      },
    ],
  };
  const context = threadReplyContext(thread);
  assert.equal(context.threadId, "thread-123");
  assert.equal(context.replySubject, "Re: 1st Round @ CaroHQ 🎉");
  assert.equal(context.inReplyTo, "<candidate@example.com>");
  assert.equal(context.references, "<first@example.com> <candidate@example.com>");
  assert.equal(candidateRepliedAfter(thread, "candidate@example.com", 1500), true);
  assert.equal(candidateRepliedAfter(thread, "candidate@example.com", 2500), false);
});

test("only an exact digest URL in the first delivered email anchors future replies", () => {
  const digestUrl = role.digestUrl;
  const oldThread = {
    id: "old-caro-thread",
    messages: [
      {
        internalDate: "1000",
        payload: {
          ...bodyPayload("A historical email without the candidate digest"),
          headers: [{ name: "Subject", value: "1st Round @ CaroHQ 🎉" }],
        },
      },
      {
        internalDate: "2000",
        labelIds: ["DRAFT"],
        payload: bodyPayload(`Later unsent draft ${digestUrl}`),
      },
    ],
  };
  assert.equal(threadDigestAnchorStatus(oldThread, digestUrl), "missing");

  const newDraftThread = {
    id: "new-reform-draft",
    messages: [{
      internalDate: "3000",
      labelIds: ["DRAFT"],
      payload: bodyPayload(`Dhruva's Interview Requests (${digestUrl})`),
    }],
  };
  assert.equal(threadDigestAnchorStatus(newDraftThread, digestUrl), "draft");

  const anchoredThread = {
    id: "anchored-thread",
    messages: [
      {
        internalDate: "4000",
        payload: bodyPayload(`<a href="${digestUrl}">Dhruva's Interview Requests</a>`, "text/html"),
      },
      {
        internalDate: "5000",
        payload: bodyPayload("A later reply does not need to repeat the URL"),
      },
    ],
  };
  assert.equal(threadDigestAnchorStatus(anchoredThread, digestUrl), "delivered");
  assert.equal(
    threadDigestAnchorStatus(anchoredThread, `${digestUrl}-different`),
    "missing",
  );
});

test("outreach state-store probe proves write, read, and cleanup", async () => {
  const commands = [];
  let stored = null;
  const result = await probeOutreachStore({
    kvImpl: async (command) => {
      commands.push(command);
      if (command[0] === "SET") {
        stored = command[2];
        return "OK";
      }
      if (command[0] === "GET") return stored;
      if (command[0] === "DEL") {
        stored = null;
        return 1;
      }
      return null;
    },
  });
  assert.deepEqual(result, { ok: true, write: true, read: true, cleanup: true });
  assert.deepEqual(commands.map((command) => command[0]), ["SET", "GET", "DEL"]);
  assert.match(commands[0][1], /^paraai:outreach:canary:/);
  assert.equal(commands[0][4], 60);
});

test("Google contact recovery requires one address corroborated by Gmail and Calendar", () => {
  assert.equal(normalizeContactName("⚡Serge-Éric Tremblay"), "serge eric tremblay");
  const gmailThread = {
    messages: [{
      payload: { headers: [
        { name: "From", value: "Serge-Eric Tremblay <set128@gmail.com>" },
        { name: "To", value: "David Phillips <david@raydar.xyz>" },
      ] },
    }],
  };
  const calendarEvents = [{
    summary: "Serge-Eric Tremblay and David Phillips",
    attendees: [
      { email: "david@raydar.xyz" },
      { email: "set128@gmail.com" },
      { email: "alzen@raydargroup.com" },
    ],
  }];
  assert.deepEqual(
    gmailCandidateEvidence(gmailThread, "⚡Serge-Eric Tremblay", "david@raydar.xyz"),
    ["set128@gmail.com"],
  );
  assert.deepEqual(
    calendarCandidateEvidence(
      calendarEvents,
      "⚡Serge-Eric Tremblay",
      "david@raydar.xyz",
    ),
    ["set128@gmail.com"],
  );
  assert.deepEqual(resolveContactEvidence({
    gmailEmails: ["set128@gmail.com"],
    calendarEmails: ["set128@gmail.com"],
  }), {
    email: "set128@gmail.com",
    confidence: "gmail_calendar_corroborated",
    gmailEmails: ["set128@gmail.com"],
    calendarEmails: ["set128@gmail.com"],
    suggestedEmails: ["set128@gmail.com"],
    gmailError: null,
    calendarError: null,
  });
});

test("one-source contact evidence remains a suggestion and cannot send", async () => {
  const result = await discoverCandidateContact(
    {
      candidateName: "Candidate Name",
      mailbox: "david@raydar.xyz",
    },
    {
      gmailEvidenceImpl: async () => ["candidate@example.com"],
      calendarEvidenceImpl: async () => {
        const error = new Error("scope denied");
        error.code = "GOOGLE_CALENDAR_SCOPE_MISSING";
        throw error;
      },
    },
  );
  assert.equal(result.email, "");
  assert.equal(result.confidence, "unresolved");
  assert.deepEqual(result.suggestedEmails, ["candidate@example.com"]);
  assert.equal(result.calendarError, "GOOGLE_CALENDAR_SCOPE_MISSING");
});

test("missing-email alert tells the operator what to fix without authorizing a send", () => {
  const copy = missingEmailAlertCopy({
    candidateName: "⚡Serge-Eric Tremblay",
    roleName: "Product Manager",
    companyName: "Traba",
  }, {
    suggestedEmails: ["set128@gmail.com"],
  });
  assert.equal(copy.subject, "Action needed: missing email for Serge-Eric Tremblay");
  assert.match(copy.text, /set128@gmail\.com/);
  assert.match(copy.text, /no email was sent/i);
  assert.match(copy.text, /Add the correct email to the candidate's Paraform profile/);
});

test("missing-email exceptions are durable and notification claims are deduplicated", async () => {
  const commands = [];
  const request = {
    id: "request-missing-email",
    candidateUserId: "candidate-user",
    candidateName: "Candidate Name",
    roleName: "Product Manager",
    companyName: "Example Co",
  };
  const record = await recordOutreachException({
    request,
    code: "OUTREACH_NO_EMAIL",
    discovery: {
      confidence: "unresolved",
      gmailEmails: ["candidate@example.com"],
      calendarEmails: [],
      suggestedEmails: ["candidate@example.com"],
      calendarError: "GOOGLE_CALENDAR_SCOPE_MISSING",
    },
  }, {
    kvImpl: async (command) => {
      commands.push(command);
      return null;
    },
    pipelineImpl: async (pipeline) => {
      commands.push(...pipeline);
      return ["OK", 1];
    },
  });
  assert.equal(record.status, "open");
  assert.equal(record.attempts, 1);
  assert.deepEqual(record.discovery.suggestedEmails, ["candidate@example.com"]);
  assert.match(commands[1][1], /^paraai:outreach:exception:/);
  assert.equal(commands[2][0], "ZADD");

  assert.equal(await claimOutreachExceptionAlert(request.id, {
    kvImpl: async (command) => {
      assert.equal(command[0], "SET");
      assert.equal(command[3], "NX");
      return "OK";
    },
  }), true);
  assert.equal(await claimOutreachExceptionAlert(request.id, {
    kvImpl: async () => null,
  }), false);
});

test("request normalization and ordinal count all Para AI requests for one candidate", () => {
  const first = normalizeSubmissionRequest({
    id: "request-first",
    status: "submitted",
    reached_out_to_candidate: true,
    created_at: "2026-07-13T17:07:20.087Z",
    candidate: {
      id: "candidate-db",
      candidate_user_id: "candidate-user",
      name: "Dhruva Narayan",
    },
    role: { id: "role-first", name: "Founding Engineer", company: { name: "CaroHQ" } },
  });
  const second = normalizeSubmissionRequest({
    id: "request-second",
    status: "pending",
    reached_out_to_candidate: false,
    created_at: "2026-07-18T01:03:02.093Z",
    candidate: {
      id: "candidate-db",
      candidate_user_id: "candidate-user",
      name: "Dhruva Narayan",
    },
    role: { id: "role-second", name: "Software Engineer", company: { name: "Reform" } },
  });
  assert.equal(requestOrdinal(first, [second, first]), 1);
  assert.equal(requestOrdinal(second, [second, first]), 2);
});

test("eligibility requires pending, unreached, post-cutoff, and not already delivered", () => {
  const config = { notBeforeMs: Date.parse("2026-07-18T00:00:00.000Z") };
  const base = {
    id: "request-pending",
    status: "pending",
    reachedOut: false,
    createdAtMs: Date.parse("2026-07-18T01:00:00.000Z"),
  };
  assert.deepEqual(eligibleNewRequests([base], config, []), [base]);
  assert.deepEqual(eligibleNewRequests([{ ...base, reachedOut: true }], config, []), []);
  assert.deepEqual(eligibleNewRequests([{ ...base, status: "submitted" }], config, []), []);
  assert.deepEqual(eligibleNewRequests([base], config, [{
    matches: { [base.id]: { sentAt: "2026-07-18T02:00:00.000Z" } },
  }]), []);
  const historicalReached = {
    ...base,
    createdAtMs: Date.parse("2026-07-10T01:00:00.000Z"),
    reachedOut: true,
  };
  assert.deepEqual(
    eligibleNewRequests([historicalReached], config, [], [{
      requestId: historicalReached.id,
      status: "open",
    }]),
    [historicalReached],
  );
});

test("manual backfill ignores the rollout cutoff and reached-out checkbox", () => {
  const oldPending = {
    id: "request-old",
    status: "pending",
    reachedOut: false,
    createdAtMs: Date.parse("2026-07-10T01:00:00.000Z"),
  };
  const newPending = {
    id: "request-new",
    status: "pending",
    reachedOut: false,
    createdAtMs: Date.parse("2026-07-18T01:00:00.000Z"),
  };
  assert.deepEqual(
    pendingBackfillRequests([
      newPending,
      { ...oldPending, id: "request-reached", reachedOut: true },
      { ...oldPending, id: "request-expired", status: "expired" },
      oldPending,
    ], [{
      matches: {
        "request-new": { sentAt: "2026-07-19T00:00:00.000Z" },
      },
    }]),
    [oldPending, { ...oldPending, id: "request-reached", reachedOut: true }],
  );
});

test("new match supersedes the old follow-up and owns one new two-day follow-up", () => {
  const state = {
    candidateUserId: "candidate-user",
    revision: 1,
    matches: {},
    outbox: {},
    followup: {
      ownerMatchId: "request-first",
      number: 2,
      remaining: 1,
      dueAt: "2026-07-20T00:00:00.000Z",
    },
    journal: [],
  };
  const request = {
    id: "request-second",
    roleId: "role-second",
    roleName: "Software Engineer",
    companyName: "Reform",
  };
  const sentAt = "2026-07-18T12:00:00.000Z";
  const copy = additionalMatchCopy({
    firstName: "Dhruva",
    ordinal: 2,
    variationSeed: request.id,
    ...role,
  });
  const next = planDeliveredMatch(state, {
    request,
    ordinal: 2,
    roleUrl: role.roleUrl,
    digest: { digestId: "digest-12345678", digestUrl: role.digestUrl },
    copy,
    sent: { id: "gmail-message", threadId: "gmail-thread" },
    sentAt,
    messageId: deterministicMessageId(`match:${request.id}`),
  });
  assert.equal(next.latestMatchId, "request-second");
  assert.equal(next.followup.ownerMatchId, "request-second");
  assert.equal(next.followup.remaining, 1);
  assert.equal(next.followup.dueAt, "2026-07-20T12:00:00.000Z");
  assert.equal(next.journal.at(-1).supersededFollowupFor, "request-first");
});

test("first-match follow-up two is scheduled two days after follow-up one actually sends", () => {
  const state = {
    candidateUserId: "candidate-user",
    revision: 1,
    threadId: "gmail-thread",
    latestMatchId: "request-first",
    outbox: {},
    journal: [],
    followup: {
      ownerMatchId: "request-first",
      ordinal: 1,
      number: 1,
      remaining: 2,
      dueAt: "2026-07-20T12:00:00.000Z",
      roleId: "role-first",
      roleName: "Chief of Staff",
      companyName: "Pallet",
      roleUrl: "https://www.paraform.com/share/pallet/role-first",
    },
  };
  const next = planDeliveredFollowup(state, {
    sent: { id: "followup-message", threadId: "gmail-thread" },
    sentAt: "2026-07-20T14:30:00.000Z",
    messageId: deterministicMessageId("followup:request-first:1"),
  });
  assert.equal(next.followup.number, 2);
  assert.equal(next.followup.remaining, 1);
  assert.equal(next.followup.dueAt, "2026-07-22T14:30:00.000Z");
});

test("all three live-send gates and a pinned cutoff are required", () => {
  const closed = outreachConfig({});
  assert.equal(outreachExecutionEnabled(closed), false);
  const open = outreachConfig({
    PARAAI_OUTREACH_APPROVED: "true",
    PARAAI_OUTREACH_SEND_APPROVED: "true",
    PARAAI_OUTREACH_DRY_RUN: "false",
    PARAAI_OUTREACH_NOT_BEFORE: "2026-07-18T17:00:00.000Z",
    GOOGLE_SA_KEY_FILE: "/private/key.json",
    PARAAI_OUTREACH_MAILBOX: "david@raydar.xyz",
    KV_REST_API_URL: "https://kv.example",
    KV_REST_API_TOKEN: "token",
  });
  // The store module intentionally snapshots its production environment at
  // import time, so test the config facts directly and prove the global gate
  // remains closed in this no-secret test process.
  assert.equal(open.approved, true);
  assert.equal(open.sendApproved, true);
  assert.equal(open.dryRun, false);
  assert.equal(open.notBeforeMs, Date.parse("2026-07-18T17:00:00.000Z"));
  assert.equal(open.gmailConfigured, true);
  assert.equal(outreachExecutionEnabled({ ...open, storeConfigured: true }), true);
});
