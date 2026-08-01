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
  canonicalAddress,
  candidateRepliedAfter,
  deliverMessage,
  deterministicActionId,
  deterministicMessageId,
  findMessageByActionId,
  firstDeliveredInternalDate,
  hardBounceAfter,
  isHardBounce,
  threadDigestAnchorStatus,
  threadReplyContext,
} from "../api/paraai/_lib/outreach-gmail.mjs";
import {
  activeOffMarketHold,
  classifyByPhrase,
  classifyInboundIntent,
  INTENT_DO_NOT_CONTACT,
  INTENT_OFF_MARKET,
  INTENT_OPEN,
  lapsedOffMarketHold,
  offMarketHold,
  OFF_MARKET_HOLD_DAYS,
  stripQuotedText,
} from "../api/paraai/_lib/outreach-intent.mjs";
import {
  calendarCandidateEvidence,
  discoverCandidateContact,
  eventMentionsLinkedinHandle,
  gmailCandidateEvidence,
  handleRouteFor,
  isAbbreviatedName,
  linkedinCalendarEvidence,
  normalizeContactName,
  normalizeLinkedinHandle,
  probeCalendarAccess,
  resolveContactEvidence,
} from "../api/paraai/_lib/outreach-contact.mjs";
import {
  assessOutreachThread,
  assessmentBlockCode,
  assessmentPatch,
  eligibleNewRequests,
  expiredNoDigestOverrideEligible,
  expiredUnsentCopy,
  expiryEscalationCopy,
  expiryEscalationRung,
  requestExpiresAtMs,
  sweepExpiryEscalations,
  sweepStaleOutreachExceptions,
  SUBMISSION_REQUEST_EXPIRY_DAYS,
  heldAlertCopy,
  messageForMatch,
  missingEmailAlertCopy,
  normalizeExternalDeliveryEvidence,
  normalizeSubmissionRequest,
  OUTREACH_INCIDENT_HALT,
  outreachConfig,
  outreachExecutionEnabled,
  pendingNoDigestConfirmation,
  pendingNoDigestOverrideEligible,
  PENDING_DIGEST_UNAVAILABLE_REASON,
  PENDING_DIGEST_UNAVAILABLE_VENDOR_MESSAGE,
  pendingBackfillRequests,
  planDeliveredFollowup,
  planDeliveredMatch,
  requestOrdinal,
  retryableFailure,
  verifyPendingDigestUnavailable,
} from "../api/paraai/_lib/outreach.mjs";
import {
  classifyDeclinedRoles,
  declinableRoles,
  extractDeclinedRolesWithModel,
  mergeDeclinedRoles,
  roleDeclined,
} from "../api/paraai/_lib/outreach-decline.mjs";
import {
  claimOutreachExceptionAlert,
  getContactCapability,
  probeOutreachStore,
  recordContactCapability,
  recordOutreachException,
  resolveOutreachException,
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

test("expired first-match override keeps the role link and omits unavailable digest language", () => {
  const copy = initialMatchCopy({
    firstName: "Dan",
    roleName: "Senior / Staff Software Engineer",
    companyName: "TubeScience",
    roleUrl: "https://www.paraform.com/share/tubescience/role-1",
    digestUrl: null,
  });
  assert.equal(copy.variant, "initial_expired_no_digest");
  assert.match(copy.text, /Senior \/ Staff Software Engineer @ TubeScience/);
  assert.match(copy.text, /https:\/\/www\.paraform\.com\/share\/tubescience\/role-1/);
  assert.doesNotMatch(copy.text, /digest|all interview requests|one place/i);
  assert.doesNotMatch(copy.html, /paraform\.com\/digest|Interview Requests/);
});

test("later-match copy drops the bare David sign-off when the signature block follows", () => {
  for (const ordinal of [2, 3]) {
    const signed = additionalMatchCopy({
      firstName: "Amy",
      ordinal,
      variationSeed: `request-${ordinal}`,
      ...role,
      signatureFollows: true,
    });
    assert.ok(signed.text.endsWith("Thanks,"));
    assert.match(signed.html, /<div>Thanks,<\/div>$/);
    const unsigned = additionalMatchCopy({
      firstName: "Amy",
      ordinal,
      variationSeed: `request-${ordinal}`,
      ...role,
    });
    assert.ok(unsigned.text.endsWith("Thanks,\nDavid"));
    assert.match(unsigned.html, /<div>Thanks,<br>David<\/div>$/);
  }
});

test("a thread-starting match email carries the signature and a reply never does", () => {
  const request = {
    id: "req-1",
    candidateEmail: "amy@example.com",
    companyName: "Reform",
  };
  const copy = { text: "body", html: "<div>body</div>" };
  const signatureHtml = '<div dir="ltr">David Phillips<br>Raydar</div>';
  const fresh = messageForMatch({
    mailbox: "david@raydar.xyz",
    request,
    copy,
    context: null,
    draftThreadId: null,
    signatureHtml,
  });
  assert.equal(fresh.bodyHtml, `<div>body</div><br>\n${signatureHtml}`);
  assert.equal(fresh.threadId, undefined);
  const draftAnchored = messageForMatch({
    mailbox: "david@raydar.xyz",
    request,
    copy,
    context: null,
    draftThreadId: "thread-9",
    signatureHtml,
  });
  assert.equal(draftAnchored.bodyHtml, `<div>body</div><br>\n${signatureHtml}`);
  assert.equal(draftAnchored.threadId, "thread-9");
  const reply = messageForMatch({
    mailbox: "david@raydar.xyz",
    request,
    copy,
    context: {
      threadId: "thread-1",
      inReplyTo: "<m1@mail.gmail.com>",
      references: "<m1@mail.gmail.com>",
      replySubject: "Re: 1st Round - Interview Request @ Reform 🎉",
    },
    signatureHtml,
  });
  assert.equal(reply.bodyHtml, "<div>body</div>");
  const noSignature = messageForMatch({
    mailbox: "david@raydar.xyz",
    request,
    copy,
    context: null,
    draftThreadId: null,
    signatureHtml: "",
  });
  assert.equal(noSignature.bodyHtml, "<div>body</div>");
});

test("expired later-match override omits the digest reminder", () => {
  for (const ordinal of [2, 3]) {
    const copy = additionalMatchCopy({
      firstName: "Dan",
      ordinal,
      variationSeed: `request-${ordinal}`,
      ...role,
      digestUrl: null,
    });
    assert.match(copy.variant, /expired_no_digest$/);
    assert.match(copy.text, /Software Engineer @ Reform/);
    assert.doesNotMatch(copy.text, /digest|all of these requests|one place/i);
    assert.doesNotMatch(copy.html, /paraform\.com\/digest|Interview Requests/);
  }
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
  const actionKey = "match:request-123";
  const messageId = deterministicMessageId(actionKey);
  assert.equal(messageId, deterministicMessageId(actionKey));
  assert.notEqual(messageId, deterministicMessageId("match:request-456"));
  const mime = buildMime({
    actionKey,
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
  assert.match(
    mime.raw,
    new RegExp(`X-Raydar-Action-ID: ${deterministicActionId(actionKey)}`),
  );
  assert.match(mime.raw, /In-Reply-To: <last@example.com>/);
  assert.match(mime.raw, /References: <first@example.com> <last@example.com>/);
});

test("Gmail action reconciliation reads the preserved marker and rejects duplicates", async () => {
  const actionId = deterministicActionId("match:request-123");
  const messages = {
    "gmail-one": {
      id: "gmail-one",
      payload: { headers: [{ name: "X-Raydar-Action-ID", value: "other-action" }] },
    },
    "gmail-two": {
      id: "gmail-two",
      threadId: "thread-two",
      payload: { headers: [{ name: "X-Raydar-Action-ID", value: actionId }] },
    },
  };
  const calls = [];
  const gmailCallImpl = async (_mailbox, path) => {
    calls.push(path);
    if (path.startsWith("/messages?")) {
      return { messages: [{ id: "gmail-one" }, { id: "gmail-two" }] };
    }
    const id = path.match(/^\/messages\/([^?]+)/)?.[1];
    return messages[id];
  };
  const found = await findMessageByActionId("david@raydar.xyz", actionId, {
    to: "candidate@example.com",
    subject: "1st Round @ Example",
    gmailCallImpl,
  });
  assert.equal(found.id, "gmail-two");
  assert.match(calls[0], /in%3Asent/);
  assert.equal(
    calls.filter((path) => path.includes("metadataHeaders=X-Raydar-Action-ID")).length,
    2,
  );

  messages["gmail-one"] = {
    ...messages["gmail-one"],
    payload: { headers: [{ name: "X-Raydar-Action-ID", value: actionId }] },
  };
  await assert.rejects(
    findMessageByActionId("david@raydar.xyz", actionId, { gmailCallImpl }),
    { code: "GMAIL_ACTION_DUPLICATE" },
  );
});

test("a prior Gmail claim reconciles or fails closed without sending again", async () => {
  const message = {
    actionKey: "match:request-123",
    from: "David Phillips <david@raydar.xyz>",
    to: "candidate@example.com",
    subject: "1st Round @ Example",
    messageId: deterministicMessageId("match:request-123"),
    bodyText: "Hello",
    bodyHtml: "<p>Hello</p>",
  };
  let sends = 0;
  const reconciled = await deliverMessage({
    mailbox: "david@raydar.xyz",
    message,
    reconcileOnly: true,
    findMessageByActionIdImpl: async () => ({
      id: "gmail-existing",
      threadId: "thread-existing",
    }),
    findMessageByRfc822IdImpl: async () => null,
    sendMessageImpl: async () => { sends += 1; },
  });
  assert.equal(reconciled.delivery, "reconciled");
  assert.equal(sends, 0);

  await assert.rejects(
    deliverMessage({
      mailbox: "david@raydar.xyz",
      message,
      reconcileOnly: true,
      findMessageByActionIdImpl: async () => null,
      findMessageByRfc822IdImpl: async () => null,
      sendMessageImpl: async () => { sends += 1; },
    }),
    { code: "GMAIL_SEND_UNKNOWN" },
  );
  assert.equal(sends, 0);
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
  assert.equal(candidateRepliedAfter(thread, "david@raydar.xyz", 1500), true);
  // REGRESSION (incident 2026-07-26): the caller must anchor the reply window at
  // the START of the conversation. Anchored there, a reply we have already talked
  // over is still seen...
  const anchor = firstDeliveredInternalDate(thread);
  assert.equal(anchor, 1000);
  assert.equal(candidateRepliedAfter(thread, "david@raydar.xyz", anchor), true);
  // ...whereas the old lastOutboundAt anchor hid it permanently. This line is the
  // defect itself, kept as documentation of why the anchor moved.
  assert.equal(candidateRepliedAfter(thread, "david@raydar.xyz", 2500), false);
  // Our own delivered mail is never a reply, at any cutoff.
  assert.equal(candidateRepliedAfter({ messages: [thread.messages[0]] }, "david@raydar.xyz", 0), false);
  // Unsent drafts sitting in the thread are not replies either.
  assert.equal(candidateRepliedAfter({ messages: [thread.messages[2]] }, "david@raydar.xyz", 0), false);
});

test("a reply from an address Paraform never had still stops the ladder", () => {
  // REGRESSION (incident 2026-07-26): Paraform held darrentas7@gmail.com and the
  // candidate replied as darren.tas7@gmail.com. Same Gmail mailbox, different
  // string — the old substring test missed it and sent two more follow-ups.
  const reply = (from) => ({
    messages: [
      {
        internalDate: "1000",
        labelIds: ["SENT"],
        payload: { headers: [
          { name: "Subject", value: "1st Round @ Wayside 🎉" },
          { name: "From", value: "David Phillips <david@raydar.xyz>" },
        ] },
      },
      {
        internalDate: "2000",
        payload: { headers: [{ name: "From", value: from }] },
      },
    ],
  });
  assert.equal(canonicalAddress("darren.tas7@gmail.com"), "darrentas7@gmail.com");
  assert.equal(canonicalAddress("Darren.Tas7+jobs@GoogleMail.com"), "darrentas7@googlemail.com");
  assert.equal(canonicalAddress("first.last@company.com"), "first.last@company.com");
  for (const from of [
    "Darren Tas <darren.tas7@gmail.com>",
    "Darren Tas <darrentas7+paraform@gmail.com>",
    "Darren Tas <darren@some-other-domain.com>",
    "darren.tas7@gmail.com",
  ]) {
    assert.equal(candidateRepliedAfter(reply(from), "david@raydar.xyz", 0), true, from);
  }
  // Our own address, however it is spelled, is still not a reply.
  assert.equal(
    candidateRepliedAfter(reply("David Phillips <david@raydar.xyz>"), "david@raydar.xyz", 0),
    false,
  );
});

test("a recorded reply blocks the automatic match send but not the operator override", async () => {
  const replied = { repliedAt: "2026-07-22T14:19:00.000Z", matches: {}, outbox: {} };
  const planned = planDeliveredMatch(
    { ...replied, journal: [] },
    {
      request: { id: "req-1", roleId: "role-1", roleName: "Engineer", companyName: "Wayside" },
      ordinal: 1,
      roleUrl: "https://www.paraform.com/share/wayside/role-1",
      digest: { digestId: "digest-1", digestUrl: "https://www.paraform.com/digest/digest-1" },
      copy: { subject: "1st Round", variant: "initial_exact" },
      sent: { id: "m1", threadId: "t1" },
      sentAt: "2026-07-23T09:30:00.000Z",
      messageId: "<x@raydar.xyz>",
    },
  );
  // An override send must never re-arm a nudge ladder on someone who replied.
  assert.equal(planned.followup, null);
  assert.equal(planned.firstOutboundAt, "2026-07-23T09:30:00.000Z");
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
      payload: bodyPayload(`Avery's Interview Requests (${digestUrl})`),
    }],
  };
  assert.equal(threadDigestAnchorStatus(newDraftThread, digestUrl), "draft");

  const anchoredThread = {
    id: "anchored-thread",
    messages: [
      {
        internalDate: "4000",
        payload: bodyPayload(`<a href="${digestUrl}">Avery's Interview Requests</a>`, "text/html"),
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
        {
          name: "To",
          value: "David Phillips <david@raydar.xyz>, Alzen Flores <alzen@raydargroup.com>",
        },
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
  assert.deepEqual(gmailCandidateEvidence({
    messages: [{
      payload: { headers: [{
        name: "To",
        value: "Other Person <other@example.com>, Serge-Eric Tremblay <set128@gmail.com>, Another Person <another@example.com>",
      }] },
    }],
  }, "Serge-Eric Tremblay", "david@raydar.xyz"), ["set128@gmail.com"]);
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

// REGRESSION (incident 2026-07-29): the alert always prescribed "add the email in
// Paraform", including for four days when the real fault was that the Calendar half
// of the corroboration could not run at all. The exception record carried
// `calendarError` the whole time and the alert never said it.
test("missing-email alert names the failing half instead of blaming Paraform", () => {
  const request = {
    candidateName: "Matthew Example",
    roleName: "Founding GTM",
    companyName: "ClaimSorted",
  };
  const broken = missingEmailAlertCopy(request, {
    suggestedEmails: ["candidate@example.com"],
    gmailError: null,
    calendarError: "GOOGLE_CALENDAR_SCOPE_MISSING",
  });
  assert.match(broken.slack, /Calendar lookup FAILED \(GOOGLE_CALENDAR_SCOPE_MISSING\)/);
  assert.match(broken.slack, /SYSTEM fault/);
  assert.match(broken.slack, /no Paraform edit will clear it/);
  // The old prescription must NOT be the headline remedy when Google is broken.
  assert.doesNotMatch(broken.text, /^Add the correct email/m);
  assert.match(broken.text, /Once Google access is restored/);
  // Both halves down reads as both halves down.
  const bothDown = missingEmailAlertCopy(request, {
    gmailError: "GMAIL_AUTH_FAILED",
    calendarError: "GOOGLE_CALENDAR_SCOPE_MISSING",
  });
  assert.match(bothDown.slack, /Gmail lookup FAILED \(GMAIL_AUTH_FAILED\) and Calendar lookup FAILED/);
  // A healthy lookup that simply found nothing keeps the original instruction.
  const healthy = missingEmailAlertCopy(request, {
    suggestedEmails: ["candidate@example.com"],
    gmailError: null,
    calendarError: null,
  });
  assert.doesNotMatch(healthy.slack, /FAILED/);
  assert.match(healthy.slack, /Add the correct email in Paraform/);
});

// REGRESSION (incident 2026-07-29): health reported `contactRecoveryConfigured:
// true` for nine days while the Calendar half of contact discovery could not run,
// because the field was literally an alias for the Gmail configuration flag. The
// discovery path always knew the truth; now it writes it down.
test("the contact-capability observation records which Google half works", async () => {
  const writes = [];
  const record = await recordContactCapability({
    calendarOk: false,
    calendarCode: "GOOGLE_CALENDAR_SCOPE_MISSING",
    gmailOk: true,
    source: "discovery",
  }, {
    kvImpl: async (command) => { writes.push(command); return "OK"; },
  });
  assert.equal(record.calendarOk, false);
  assert.equal(record.calendarCode, "GOOGLE_CALENDAR_SCOPE_MISSING");
  assert.equal(record.gmailOk, true);
  assert.equal(writes[0][0], "SET");
  assert.equal(writes[0][1], "paraai:outreach:contact-capability");
  assert.equal(writes[0][3], "EX");
  assert.equal(JSON.parse(writes[0][2]).calendarOk, false);

  const stored = await getContactCapability({
    kvImpl: async () => JSON.stringify({ version: 1, calendarOk: true, observedAt: "2026-07-29T15:00:00.000Z" }),
  });
  assert.equal(stored.calendarOk, true);
  assert.equal(await getContactCapability({ kvImpl: async () => null }), null);

  const ok = await recordContactCapability({ calendarOk: true }, {
    kvImpl: async () => "OK",
  });
  assert.equal(ok.calendarOk, true);
  assert.equal(ok.calendarCode, null);
  assert.equal(ok.gmailOk, null);
});

test("the calendar probe reports a missing scope as a missing scope", async () => {
  const token = async () => "token";
  // The exact production shape on 2026-07-28: the API itself was disabled project-wide.
  const forbidden = await probeCalendarAccess("david@raydar.xyz", {
    tokenImpl: token,
    fetchImpl: async () => ({
      ok: false,
      status: 403,
      json: async () => ({ error: { message: "Calendar API has not been used in project 98752102484" } }),
    }),
  });
  assert.equal(forbidden.ok, false);
  assert.equal(forbidden.code, "GOOGLE_CALENDAR_SCOPE_MISSING");
  assert.match(forbidden.detail, /has not been used/);

  // No domain-wide delegation for the scope: the token request itself is refused.
  const unauthorized = await probeCalendarAccess("david@raydar.xyz", {
    tokenImpl: async () => {
      const error = new Error("unauthorized_client");
      error.code = "GMAIL_AUTH_FAILED";
      throw error;
    },
  });
  assert.equal(unauthorized.ok, false);
  assert.equal(unauthorized.code, "GOOGLE_CALENDAR_SCOPE_MISSING");

  const broken = await probeCalendarAccess("david@raydar.xyz", {
    tokenImpl: token,
    fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({}) }),
  });
  assert.equal(broken.code, "GOOGLE_CALENDAR_REQUEST_FAILED");

  const live = await probeCalendarAccess("david@raydar.xyz", {
    tokenImpl: token,
    fetchImpl: async () => ({ ok: true, json: async () => ({ items: [] }) }),
  });
  assert.equal(live.ok, true);
  assert.equal(live.code, null);
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
  assert.equal(record.retryable, false);
  assert.equal(record.stage, null);
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

test("staged auth failures are durable and contact recovery cannot erase them", async () => {
  let stored = null;
  const request = {
    id: "request-auth-expired",
    candidateUserId: "candidate-user",
    candidateName: "Candidate Name",
    roleName: "Staff Engineer",
    companyName: "Example Co",
  };
  const kvImpl = async (command) => {
    if (command[0] === "GET") return stored;
    if (command[0] === "SET") {
      stored = command[2];
      return "OK";
    }
    return null;
  };
  const pipelineImpl = async (pipeline) => {
    stored = pipeline[0][2];
    return ["OK", 1];
  };
  const record = await recordOutreachException({
    request,
    code: "AUTH_EXPIRED",
    stage: "digest_mutation",
    retryable: true,
  }, { kvImpl, pipelineImpl });
  assert.equal(record.code, "AUTH_EXPIRED");
  assert.equal(record.stage, "digest_mutation");
  assert.equal(record.retryable, true);

  const untouched = await resolveOutreachException(request.id, {
    resolution: "native_paraform_email",
    onlyCodes: ["OUTREACH_NO_EMAIL", "OUTREACH_EMAIL_BOUNCED"],
    kvImpl,
  });
  assert.equal(untouched.status, "open");
  assert.equal(JSON.parse(stored).status, "open");

  const resolved = await resolveOutreachException(request.id, {
    resolution: "sent",
    kvImpl,
  });
  assert.equal(resolved.status, "resolved");
  assert.equal(resolved.resolution, "sent");
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
      name: "Avery Stone",
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
      name: "Avery Stone",
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
      code: "OUTREACH_NO_EMAIL",
    }]),
    [historicalReached],
  );
  // REGRESSION (incident 2026-07-26): a candidate-replied hold is a human
  // decision, never a retryable failure. The request stays pending and unreached
  // forever, so if it re-entered the queue the tick would retry it every five
  // minutes and starve the batch.
  assert.deepEqual(
    eligibleNewRequests([base], config, [], [{
      requestId: base.id,
      status: "open",
      code: "OUTREACH_CANDIDATE_REPLIED",
    }]),
    [],
  );
  // ...and it must not be resurrected by the retry-authorized path either.
  assert.deepEqual(
    eligibleNewRequests([historicalReached], config, [], [{
      requestId: historicalReached.id,
      status: "open",
      code: "OUTREACH_CANDIDATE_REPLIED",
    }]),
    [],
  );
});

// REGRESSION (incident 2026-07-29): the five-minute retry interval was reachable
// only through `retryAuthorized`, i.e. only once Paraform's reached-out marker was
// set. An un-reached request satisfied plain eligibility on its own, so a
// known-blocked request was re-attempted every tick — 1,361 attempts in 9h39m in
// production, each burning a Gmail search, a Calendar query, and one of three batch
// slots.
test("a recoverable exception throttles retries even while the request is unreached", () => {
  const now = Date.parse("2026-07-29T12:00:00.000Z");
  const config = { notBeforeMs: Date.parse("2026-07-18T00:00:00.000Z") };
  const request = {
    id: "request-no-email",
    status: "pending",
    reachedOut: false,
    createdAtMs: Date.parse("2026-07-24T17:16:00.000Z"),
  };
  const exception = (lastSeenAt) => [{
    requestId: request.id,
    status: "open",
    code: "OUTREACH_NO_EMAIL",
    lastSeenAt,
  }];
  // Attempted 26 seconds ago: inside the interval, so it must NOT re-enter.
  assert.deepEqual(
    eligibleNewRequests([request], config, [], exception("2026-07-29T11:59:34.000Z"), { now }),
    [],
  );
  // Attempted six minutes ago: due again.
  assert.deepEqual(
    eligibleNewRequests([request], config, [], exception("2026-07-29T11:54:00.000Z"), { now }),
    [request],
  );
  // No exception yet — the very first attempt is never throttled.
  assert.deepEqual(eligibleNewRequests([request], config, [], [], { now }), [request]);
  // A throttled request must not block the queue behind it: the next request still
  // runs in the same tick.
  const other = { ...request, id: "request-other", createdAtMs: now - 60_000 };
  assert.deepEqual(
    eligibleNewRequests(
      [request, other],
      config,
      [],
      exception("2026-07-29T11:59:34.000Z"),
      { now },
    ),
    [other],
  );
  // A resolved exception carries no throttle.
  assert.deepEqual(
    eligibleNewRequests([request], config, [], [{
      requestId: request.id,
      status: "resolved",
      code: "OUTREACH_NO_EMAIL",
      lastSeenAt: "2026-07-29T11:59:34.000Z",
    }], { now }),
    [request],
  );
});

test("write-auth failures retry on a bounded interval while unknown failures stay parked", () => {
  const now = Date.parse("2026-07-30T12:00:00.000Z");
  const config = { notBeforeMs: Date.parse("2026-07-18T00:00:00.000Z") };
  const request = {
    id: "request-auth",
    status: "pending",
    reachedOut: false,
    createdAtMs: Date.parse("2026-07-30T03:00:00.000Z"),
  };
  const authException = {
    requestId: request.id,
    status: "open",
    code: "AUTH_EXPIRED",
    retryable: true,
  };
  assert.deepEqual(
    eligibleNewRequests([request], config, [], [{
      ...authException,
      lastSeenAt: "2026-07-30T11:59:00.000Z",
    }], { now }),
    [],
  );
  assert.deepEqual(
    eligibleNewRequests([request], config, [], [{
      ...authException,
      lastSeenAt: "2026-07-30T11:54:00.000Z",
    }], { now }),
    [request],
  );
  assert.deepEqual(
    eligibleNewRequests([request], config, [], [{
      requestId: request.id,
      status: "open",
      code: "OUTREACH_FAILED",
      retryable: false,
      lastSeenAt: "2026-07-30T11:00:00.000Z",
    }], { now }),
    [],
  );
});

// REGRESSION (incident 2026-07-31): a transient Gmail 429 on a thread READ was
// recorded as GMAIL_REQUEST_FAILED, which appears in none of the code sets, so
// the write site stamped `retryable: false` and the `systemHeld` catch-all parked
// the request permanently. One candidate sat unemailed for 12h with attempts
// frozen at 1 and no second alert, while the tick happily sent for everyone else.
// The boundary is the outbox claim: nothing before it can have sent an email.
test("an unclassified failure before the outbox claim is retryable; after it, never", () => {
  // The exact shape that stalled: unlisted code, pre-send read stage.
  assert.equal(retryableFailure("GMAIL_REQUEST_FAILED", "thread_anchor"), true);
  assert.equal(retryableFailure("GMAIL_REQUEST_FAILED", "contact_discovery"), true);
  assert.equal(retryableFailure("OUTREACH_FAILED", "digest_mutation"), true);
  // From the claim onward the send outcome may be uncertain. Retrying could
  // double-send, so an unclassified failure there stays parked for a human.
  assert.equal(retryableFailure("GMAIL_REQUEST_FAILED", "outbox_claim"), false);
  assert.equal(retryableFailure("GMAIL_REQUEST_FAILED", "gmail_delivery"), false);
  assert.equal(retryableFailure("OUTREACH_FAILED", "mark_reached_out"), false);
  // An unknown or missing stage is not evidence of safety.
  assert.equal(retryableFailure("OUTREACH_FAILED", "unknown"), false);
  assert.equal(retryableFailure("OUTREACH_FAILED", null), false);
  // Explicit classification always outranks the stage, in both directions: a
  // human hold and an uncertain send stay parked even at a pre-send stage...
  assert.equal(retryableFailure("OUTREACH_CANDIDATE_OFF_MARKET", "thread_anchor"), false);
  assert.equal(retryableFailure("GMAIL_SEND_UNKNOWN", "thread_anchor"), false);
  assert.equal(retryableFailure("GMAIL_AUTH_FAILED", "state_load"), false);
  // ...and a recoverable code stays retryable even at a post-send stage.
  assert.equal(retryableFailure("OUTREACH_NO_EMAIL", "gmail_delivery"), true);
  assert.equal(retryableFailure("AUTH_EXPIRED", "mark_reached_out"), true);
});

// The two halves must compose: a pre-send failure is stamped retryable, and the
// eligibility pass then re-admits it once the five-minute throttle has elapsed
// rather than parking it in `systemHeld`.
test("a retryable pre-send failure re-enters the queue on the throttle, not never", () => {
  const now = Date.parse("2026-07-31T13:00:00.000Z");
  const config = { notBeforeMs: Date.parse("2026-07-18T00:00:00.000Z") };
  const request = {
    id: "request-thread-anchor",
    status: "pending",
    reachedOut: false,
    createdAtMs: Date.parse("2026-07-31T00:52:15.493Z"),
  };
  const stalled = (lastSeenAt) => [{
    requestId: request.id,
    status: "open",
    code: "GMAIL_REQUEST_FAILED",
    stage: "thread_anchor",
    retryable: retryableFailure("GMAIL_REQUEST_FAILED", "thread_anchor"),
    lastSeenAt,
  }];
  // Inside the interval it waits its turn...
  assert.deepEqual(
    eligibleNewRequests([request], config, [], stalled("2026-07-31T12:59:00.000Z"), { now }),
    [],
  );
  // ...and once the interval is up it comes back, instead of being parked for
  // twelve hours as it was in production.
  assert.deepEqual(
    eligibleNewRequests([request], config, [], stalled("2026-07-31T12:50:00.000Z"), { now }),
    [request],
  );
  // The uncertain-send case is the control: same code, post-claim stage, and it
  // must remain parked no matter how much time passes.
  assert.deepEqual(
    eligibleNewRequests([request], config, [], [{
      requestId: request.id,
      status: "open",
      code: "GMAIL_REQUEST_FAILED",
      stage: "gmail_delivery",
      retryable: retryableFailure("GMAIL_REQUEST_FAILED", "gmail_delivery"),
      lastSeenAt: "2026-07-30T00:00:00.000Z",
    }], { now }),
    [],
  );
});

test("the expiry clock is seven days and escalation rungs fire tightest-first", () => {
  assert.equal(SUBMISSION_REQUEST_EXPIRY_DAYS, 7);
  const request = {
    id: "request-expiring",
    candidateName: "Candidate Name",
    roleName: "Founding GTM",
    companyName: "ClaimSorted",
    createdAtMs: Date.parse("2026-07-24T17:16:00.000Z"),
  };
  assert.equal(
    new Date(requestExpiresAtMs(request)).toISOString(),
    "2026-07-31T17:16:00.000Z",
  );
  assert.equal(requestExpiresAtMs({}), null);
  // Six days out: not near the deadline, no escalation.
  assert.equal(
    expiryEscalationRung(request, { now: Date.parse("2026-07-25T17:16:00.000Z") }),
    null,
  );
  assert.equal(
    expiryEscalationRung(request, { now: Date.parse("2026-07-30T00:00:00.000Z") }).rung,
    48,
  );
  // Inside the tightest rung, the tightest rung wins.
  assert.equal(
    expiryEscalationRung(request, { now: Date.parse("2026-07-31T09:00:00.000Z") }).rung,
    12,
  );
  // Already expired: the deadline warning is pointless, the expired-unsent alarm owns it.
  assert.equal(
    expiryEscalationRung(request, { now: Date.parse("2026-08-01T00:00:00.000Z") }),
    null,
  );
  const copy = expiryEscalationCopy(
    request,
    "OUTREACH_NO_EMAIL",
    expiryEscalationRung(request, { now: Date.parse("2026-07-31T09:00:00.000Z") }),
  );
  assert.match(copy, /expires in ~8h/);
  assert.match(copy, /OUTREACH_NO_EMAIL/);
  assert.match(copy, /last warning/i);
  assert.match(copy, /pause new Para AI matches/);
});

// REGRESSION (incident 2026-07-29): a blocked request left the queue in silence the
// moment Paraform flipped it out of `pending`. One candidate's request expired
// unsent and the only trace was a days-old unread alert.
test("a lost match alarms once, and an exception never outlives its request", async () => {
  const history = [
    { id: "request-expired", status: "expired", candidateName: "Dan Example", roleName: "Staff Engineer", companyName: "TubeScience" },
    { id: "request-live", status: "pending", candidateName: "Live Candidate", roleName: "PM", companyName: "Example Co" },
    { id: "request-delivered", status: "expired", candidateName: "Sent Already", roleName: "AE", companyName: "Example Co" },
    { id: "request-submitted", status: "submitted", candidateName: "Held But Submitted", roleName: "Founding Engineer", companyName: "Rama" },
    { id: "request-dismissed", status: "dismissed", candidateName: "Passed", roleName: "SDR", companyName: "Example Co" },
  ];
  const exceptions = [
    { requestId: "request-expired", status: "open", code: "OUTREACH_NO_EMAIL", candidateName: "Dan Example" },
    { requestId: "request-live", status: "open", code: "OUTREACH_NO_EMAIL" },
    { requestId: "request-delivered", status: "open", code: "OUTREACH_NO_EMAIL" },
    { requestId: "request-submitted", status: "open", code: "OUTREACH_CANDIDATE_REPLIED" },
    { requestId: "request-dismissed", status: "open", code: "OUTREACH_CANDIDATE_REPLIED" },
    { requestId: "request-gone", status: "open", code: "OUTREACH_NO_EMAIL" },
    { requestId: "request-expired", status: "resolved", code: "OUTREACH_NO_EMAIL" },
  ];
  const states = [{ matches: { "request-delivered": { sentAt: "2026-07-28T00:00:00.000Z" } } }];
  const claims = [];
  const notices = [];
  const resolved = [];
  const sweep = await sweepStaleOutreachExceptions({
    history,
    states,
    exceptions,
    claimImpl: async (key) => { claims.push(key); return true; },
    notifyImpl: async (text) => { notices.push(text); return true; },
    resolveImpl: async (id, options) => { resolved.push([id, options.resolution]); return null; },
  });
  // Loud only for the one that cost a placement: asked for, never emailed, expired.
  assert.deepEqual(sweep.expiredUnsent, ["request-expired"]);
  assert.deepEqual(claims, ["request-expired:expired-unsent"]);
  assert.match(notices[0], /EXPIRED UNSENT/);
  assert.match(notices[0], /Dan Example/);
  assert.equal(notices.length, 1, "resolved-elsewhere exceptions must never page a human");
  // Silent for everything already answered another way. A pending request is still
  // real work and an absent one is ambiguous, so neither is touched.
  assert.deepEqual(sweep.closed, [
    { requestId: "request-delivered", status: "expired" },
    { requestId: "request-submitted", status: "submitted" },
    { requestId: "request-dismissed", status: "dismissed" },
  ]);
  assert.deepEqual(resolved, [
    ["request-expired", "expired_unsent"],
    ["request-delivered", "no_longer_pending_expired"],
    ["request-submitted", "no_longer_pending_submitted"],
    ["request-dismissed", "no_longer_pending_dismissed"],
  ]);
  // Second pass: the alarm claim is held, so the lost match is not re-announced.
  const again = await sweepStaleOutreachExceptions({
    history,
    states,
    exceptions: exceptions.filter((row) => row.requestId === "request-expired"),
    claimImpl: async () => false,
    notifyImpl: async () => { throw new Error("must not alert twice"); },
    resolveImpl: async () => { throw new Error("must not resolve twice"); },
  });
  assert.deepEqual(again, { expiredUnsent: [], closed: [] });
  assert.match(expiredUnsentCopy(history[0]), /never emailed/);
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
    firstName: "Avery",
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

test("expired no-digest delivery stays durable and schedules the normal first-match ladder", () => {
  const request = {
    id: "request-expired",
    roleId: "role-expired",
    roleName: "Senior / Staff Software Engineer",
    companyName: "TubeScience",
  };
  const next = planDeliveredMatch({
    candidateUserId: "candidate-user",
    revision: 1,
    matches: {},
    outbox: {},
    journal: [],
  }, {
    request,
    ordinal: 1,
    roleUrl: "https://www.paraform.com/share/tubescience/role-expired",
    digest: null,
    copy: { subject: "1st Round", variant: "initial_expired_no_digest" },
    sent: { id: "gmail-message", threadId: "gmail-thread" },
    sentAt: "2026-07-29T12:00:00.000Z",
    messageId: deterministicMessageId(`match:${request.id}`),
    deliveryMode: "expired_without_digest",
  });
  assert.equal(next.matches[request.id].digestId, null);
  assert.equal(next.matches[request.id].digestOmitted, true);
  assert.equal(next.matches[request.id].deliveryMode, "expired_without_digest");
  assert.equal(next.outbox[`match:${request.id}`].status, "delivered");
  assert.equal(next.outbox[`match:${request.id}`].deliveryMode, "expired_without_digest");
  assert.equal(next.followup.ownerMatchId, request.id);
  assert.equal(next.followup.remaining, 2);
  assert.equal(next.followup.dueAt, "2026-07-31T12:00:00.000Z");
  assert.equal(next.journal.at(-1).deliveryMode, "expired_without_digest");
});

test("no-digest override is eligible only for an expired request", () => {
  assert.equal(expiredNoDigestOverrideEligible({ status: "expired" }), true);
  assert.equal(expiredNoDigestOverrideEligible({ status: "EXPIRED" }), true);
  assert.equal(expiredNoDigestOverrideEligible({ status: "pending" }), false);
  assert.equal(expiredNoDigestOverrideEligible(null), false);
});

test("pending no-digest recovery requires the exact live Paraform contradiction", () => {
  const request = {
    id: "request-pending",
    candidateUserId: "candidate-user",
    roleId: "role-pending",
    status: "pending",
    reachedOut: false,
  };
  const vendorError = Object.assign(
    new Error(PENDING_DIGEST_UNAVAILABLE_VENDOR_MESSAGE),
    { code: "-32600" },
  );
  const status = {
    pendingIds: [request.id],
    digestableIds: [request.id],
  };
  assert.equal(
    pendingNoDigestOverrideEligible(request, vendorError, status, null),
    true,
  );
  assert.equal(
    pendingNoDigestOverrideEligible(
      { ...request, reachedOut: true },
      vendorError,
      status,
      null,
    ),
    false,
  );
  assert.equal(
    pendingNoDigestOverrideEligible(
      request,
      Object.assign(new Error("different vendor response"), { code: "-32600" }),
      status,
      null,
    ),
    false,
  );
  assert.equal(
    pendingNoDigestOverrideEligible(
      request,
      vendorError,
      { ...status, digestableIds: [] },
      null,
    ),
    false,
  );
  assert.equal(
    pendingNoDigestOverrideEligible(
      request,
      vendorError,
      status,
      { digestId: "digest-now-exists", roles: [] },
    ),
    false,
  );
  assert.equal(
    pendingNoDigestConfirmation(request.id),
    `SEND PENDING WITHOUT DIGEST ${request.id}`,
  );
});

test("pending no-digest verifier re-reads status and digest after the failed mutation", async () => {
  const request = {
    id: "request-pending",
    candidateUserId: "candidate-user",
    roleId: "role-pending",
    status: "pending",
    reachedOut: false,
  };
  const calls = [];
  const evidence = await verifyPendingDigestUnavailable(request, {
    ensureDigestImpl: async () => {
      calls.push("ensure");
      throw Object.assign(
        new Error(PENDING_DIGEST_UNAVAILABLE_VENDOR_MESSAGE),
        { code: "-32600" },
      );
    },
    readStatusImpl: async () => {
      calls.push("status");
      return {
        pendingIds: [request.id],
        digestableIds: [request.id],
      };
    },
    readDigestImpl: async () => {
      calls.push("digest");
      return null;
    },
  });
  assert.deepEqual(new Set(calls), new Set(["ensure", "status", "digest"]));
  assert.deepEqual(evidence, {
    eligible: true,
    reason: PENDING_DIGEST_UNAVAILABLE_REASON,
    requestId: request.id,
    pending: true,
    digestable: true,
    digestAbsent: true,
  });
});

test("pending no-digest verifier fails closed when a digest becomes available", async () => {
  const request = {
    id: "request-pending",
    candidateUserId: "candidate-user",
    roleId: "role-pending",
    status: "pending",
    reachedOut: false,
  };
  await assert.rejects(
    verifyPendingDigestUnavailable(request, {
      ensureDigestImpl: async () => ({ digestId: "digest-now-exists" }),
    }),
    { code: "OUTREACH_DIGEST_NOW_AVAILABLE" },
  );
});

test("pending no-digest delivery has a distinct durable audit mode", () => {
  const request = {
    id: "request-pending",
    roleId: "role-pending",
    roleName: "Senior / Staff Software Engineer",
    companyName: "TubeScience",
  };
  const next = planDeliveredMatch({
    candidateUserId: "candidate-user",
    revision: 1,
    matches: {},
    outbox: {},
    journal: [],
  }, {
    request,
    ordinal: 1,
    roleUrl: "https://www.paraform.com/share/tubescience/role-pending",
    digest: null,
    copy: { subject: "1st Round", variant: "initial_pending_digest_unavailable" },
    sent: { id: "gmail-message", threadId: "gmail-thread" },
    sentAt: "2026-07-30T12:00:00.000Z",
    messageId: deterministicMessageId(`match:${request.id}`),
    deliveryMode: PENDING_DIGEST_UNAVAILABLE_REASON,
  });
  assert.equal(
    next.matches[request.id].deliveryMode,
    PENDING_DIGEST_UNAVAILABLE_REASON,
  );
  assert.equal(
    next.outbox[`match:${request.id}`].deliveryMode,
    PENDING_DIGEST_UNAVAILABLE_REASON,
  );
  assert.equal(next.journal.at(-1).deliveryMode, PENDING_DIGEST_UNAVAILABLE_REASON);
});

test("external delivery evidence accepts exact recent Gmail IDs and rejects stale or malformed input", () => {
  const now = Date.parse("2026-07-29T14:05:00.000Z");
  assert.deepEqual(normalizeExternalDeliveryEvidence({
    gmailMessageId: "19fae2fd111d04e1",
    threadId: "19fae2f5a3c3e8c5",
    sentAt: "2026-07-29T14:03:00.000Z",
  }, now), {
    gmailMessageId: "19fae2fd111d04e1",
    threadId: "19fae2f5a3c3e8c5",
    sentAt: "2026-07-29T14:03:00.000Z",
  });
  assert.throws(() => normalizeExternalDeliveryEvidence({
    gmailMessageId: "not-a-gmail-id",
    threadId: "19fae2f5a3c3e8c5",
    sentAt: "2026-07-29T14:03:00.000Z",
  }, now), { code: "OUTREACH_EXTERNAL_DELIVERY_INVALID" });
  assert.throws(() => normalizeExternalDeliveryEvidence({
    gmailMessageId: "19fae2fd111d04e1",
    threadId: "19fae2f5a3c3e8c5",
    sentAt: "2026-07-27T14:03:00.000Z",
  }, now), { code: "OUTREACH_EXTERNAL_DELIVERY_INVALID" });
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
  // INCIDENT 2026-07-20: the outreach incident halt is a top-level override that
  // forces execution off even when every gate is live. It flips back to
  // asserting `true` automatically once David lifts the halt.
  assert.equal(
    outreachExecutionEnabled({ ...open, storeConfigured: true }),
    !OUTREACH_INCIDENT_HALT,
  );
});

// ---------------------------------------------------------------------------
// 2026-07-28: reply INTENT replaces reply PRESENCE as the new-role send gate.
// A reply still stops the nudge ladder; only an explicit off-market statement,
// an explicit stop-contacting request, or a hard bounce blocks a new role.
// ---------------------------------------------------------------------------

const inbound = (text, { at = "2000", from = "Avery <avery@example.com>", subject = "Re: 1st Round" } = {}) => ({
  internalDate: at,
  payload: {
    ...bodyPayload(text),
    headers: [
      { name: "From", value: from },
      { name: "Subject", value: subject },
    ],
  },
});
const ourMessage = (at = "1000") => ({
  internalDate: at,
  labelIds: ["SENT"],
  payload: {
    ...bodyPayload("Here is the role"),
    headers: [
      { name: "From", value: "David Phillips <david@raydar.xyz>" },
      { name: "Subject", value: "1st Round - Interview Request @ Rama 🎉" },
    ],
  },
});

test("only an explicit market-level exit reads as off the market", () => {
  // David's calibration, 2026-07-28. The first two hold; the rest send.
  for (const text of [
    "Hey David, I actually just accepted another offer, best of luck filling the role!",
    "I signed an offer last week.",
    "Thanks, but I'm not looking right now.",
    "I'm happy where I am at the moment.",
    "I've taken myself off the market for now.",
    "I just started a new role in May.",
  ]) {
    assert.equal(classifyByPhrase(text), INTENT_OFF_MARKET, text);
  }
  for (const text of [
    "Not interested in this particular role, but keep me posted.",
    "This one isn't for me — too early stage.",
    "I'm in final stages somewhere else, but still open.",
    "Can we talk next week?",
    "I am out of office until Monday with limited access to email.",
    "What does the comp band look like?",
  ]) {
    assert.equal(classifyByPhrase(text), null, text);
  }
  for (const text of [
    "Please stop emailing me.",
    "Remove me from your list.",
    "unsubscribe",
    "Do not contact me again.",
  ]) {
    assert.equal(classifyByPhrase(text), INTENT_DO_NOT_CONTACT, text);
  }
});

test("quoted text is stripped so we never classify our own copy as the candidate's", () => {
  // Our email is quoted under every reply and is full of role language. Judging
  // it would let our own words decide whether the candidate is off the market.
  const raw = [
    "Not interested in this one, thanks.",
    "",
    "On Mon, Jul 27, 2026 at 9:30 AM David Phillips <david@raydar.xyz> wrote:",
    "> I just accepted another offer on your behalf and you are off the market",
  ].join("\n");
  const stripped = stripQuotedText(raw);
  assert.equal(stripped, "Not interested in this one, thanks.");
  assert.equal(classifyByPhrase(stripped), null);
  // Without the strip, the quoted block would have tripped the off-market rule.
  assert.equal(classifyByPhrase(raw), INTENT_OFF_MARKET);
});

test("an explicit stop-contacting request never spends a model call", async () => {
  let calls = 0;
  const result = await classifyInboundIntent(
    [{ at: "2026-07-27T00:00:00.000Z", text: "Please stop emailing me." }],
    {
      fetchImpl: async () => { calls += 1; throw new Error("must not be called"); },
      env: { ANTHROPIC_API_KEY: "key" },
    },
  );
  assert.equal(result.verdict, INTENT_DO_NOT_CONTACT);
  assert.equal(result.source, "phrase");
  assert.equal(calls, 0);
});

test("the model decides the soft cases, and its verdict is what sticks", async () => {
  const modelFetch = (verdict) => async () => ({
    ok: true,
    json: async () => ({
      model: "claude-fable-5",
      content: [{
        type: "tool_use",
        name: "record_reply_intent",
        input: { verdict, reason: "stated wording" },
      }],
    }),
  });
  const open = await classifyInboundIntent(
    [{ at: "2026-07-27T00:00:00.000Z", text: "Not for me, but send me the next one." }],
    { fetchImpl: modelFetch(INTENT_OPEN), env: { ANTHROPIC_API_KEY: "key" } },
  );
  assert.equal(open.verdict, INTENT_OPEN);
  assert.equal(open.source, "model");

  const off = await classifyInboundIntent(
    [{ at: "2026-07-27T00:00:00.000Z", text: "I'm out of the running, sorry." }],
    { fetchImpl: modelFetch(INTENT_OFF_MARKET), env: { ANTHROPIC_API_KEY: "key" } },
  );
  assert.equal(off.verdict, INTENT_OFF_MARKET);
});

test("a dead model retries once, falls back to phrases, then defaults to send", async () => {
  let calls = 0;
  const dead = async () => { calls += 1; return { ok: false, json: async () => ({}) }; };

  const ambiguous = await classifyInboundIntent(
    [{ at: "2026-07-27T00:00:00.000Z", text: "Hmm, let me think about it." }],
    { fetchImpl: dead, env: { ANTHROPIC_API_KEY: "key" } },
  );
  assert.equal(calls, 2, "retries exactly once before falling back");
  assert.equal(ambiguous.verdict, INTENT_OPEN, "default is send");
  assert.equal(ambiguous.source, "phrase_fallback");

  calls = 0;
  const explicit = await classifyInboundIntent(
    [{ at: "2026-07-27T00:00:00.000Z", text: "I just accepted another offer." }],
    { fetchImpl: dead, env: { ANTHROPIC_API_KEY: "key" } },
  );
  assert.equal(explicit.verdict, INTENT_OFF_MARKET, "phrases still catch the clear case");

  // No API key at all: do not burn a retry on a call that cannot succeed.
  calls = 0;
  const unconfigured = await classifyInboundIntent(
    [{ at: "2026-07-27T00:00:00.000Z", text: "Sounds interesting." }],
    { fetchImpl: dead, env: {} },
  );
  assert.equal(calls, 0);
  assert.equal(unconfigured.verdict, INTENT_OPEN);
});

test("an off-market hold expires after six months; do-not-contact never does", () => {
  const detectedAt = "2026-07-27T00:00:00.000Z";
  const off = offMarketHold({ verdict: INTENT_OFF_MARKET, detectedAt });
  assert.equal(OFF_MARKET_HOLD_DAYS, 183);
  assert.equal(
    off.expiresAt,
    new Date(Date.parse(detectedAt) + 183 * 24 * 60 * 60 * 1000).toISOString(),
  );
  const stop = offMarketHold({ verdict: INTENT_DO_NOT_CONTACT, detectedAt });
  assert.equal(stop.expiresAt, null);
  assert.equal(offMarketHold({ verdict: INTENT_OPEN, detectedAt }), null);

  const dayBefore = Date.parse(off.expiresAt) - 1;
  const dayAfter = Date.parse(off.expiresAt) + 1;
  assert.ok(activeOffMarketHold({ offMarket: off }, dayBefore));
  assert.equal(activeOffMarketHold({ offMarket: off }, dayAfter), null);
  // A stop-contacting hold outlives any window.
  assert.ok(activeOffMarketHold({ offMarket: stop }, dayAfter + 1e12));

  // The lapse is announced exactly once.
  assert.ok(lapsedOffMarketHold({ offMarket: off }, dayAfter));
  assert.equal(lapsedOffMarketHold({ offMarket: off }, dayBefore), null);
  assert.equal(
    lapsedOffMarketHold({ offMarket: { ...off, lapseNotifiedAt: "2027-01-27T00:00:00.000Z" } }, dayAfter),
    null,
  );
});

test("only a permanent delivery failure counts as a bounce", () => {
  const report = (text, extra = {}) => ({
    internalDate: "3000",
    payload: {
      ...bodyPayload(text),
      headers: [
        { name: "From", value: "Mail Delivery Subsystem <mailer-daemon@googlemail.com>" },
        { name: "Subject", value: "Delivery Status Notification (Failure)" },
        ...(extra.headers || []),
      ],
    },
  });
  assert.equal(
    isHardBounce(report("550 5.1.1 The email account that you tried to reach does not exist.")),
    true,
  );
  // A temporary failure is retried by the sending server; latching a stop on it
  // would silently drop a candidate whose mailbox was merely full for an hour.
  assert.equal(isHardBounce(report("4.2.2 The recipient's mailbox is over quota, will retry")), false);
  // An out-of-office is not a delivery report at all.
  assert.equal(
    isHardBounce(inbound("I am out of office until Monday", { subject: "Automatic reply" })),
    false,
  );
  // A real reply from the candidate is never a bounce.
  assert.equal(isHardBounce(inbound("Not interested in this one")), false);

  const thread = { messages: [ourMessage("1000"), report("550 5.1.1 user unknown")] };
  assert.ok(hardBounceAfter(thread, 500));
  assert.equal(hardBounceAfter(thread, 5000), null, "respects the conversation anchor");
});

test("a role-level decline clears a new role; an accepted offer holds it", async () => {
  const config = { mailbox: "david@raydar.xyz" };
  const state = { threadId: "t1", firstOutboundAt: "1970-01-01T00:00:01.000Z" };
  const threadOf = (text) => async () => ({
    id: "t1",
    messages: [ourMessage("1000"), inbound(text, { at: "2000" })],
  });

  const declined = await assessOutreachThread({
    state,
    config,
    threadImpl: threadOf("Not interested in this particular role, thanks."),
    classifyImpl: async () => ({ verdict: INTENT_OPEN, reason: "role-level no", source: "model" }),
  });
  assert.equal(declined.replied, true, "a reply is still recorded");
  assert.equal(declined.hold, null, "but it does not block the new role");
  assert.equal(assessmentBlockCode(declined), null);

  const offMarket = await assessOutreachThread({
    state,
    config,
    threadImpl: threadOf("I just accepted another offer, best of luck!"),
    classifyImpl: async () => ({ verdict: INTENT_OFF_MARKET, reason: "accepted an offer", source: "model" }),
  });
  assert.equal(offMarket.hold.verdict, INTENT_OFF_MARKET);
  assert.equal(assessmentBlockCode(offMarket), "OUTREACH_CANDIDATE_OFF_MARKET");
  // The six months run from what the candidate said, not from when we read it.
  assert.equal(offMarket.hold.detectedAt, new Date(2000).toISOString());

  const bounced = await assessOutreachThread({
    state,
    config,
    threadImpl: async () => ({
      id: "t1",
      messages: [ourMessage("1000"), {
        internalDate: "2000",
        payload: {
          ...bodyPayload("550 5.1.1 address not found"),
          headers: [
            { name: "From", value: "mailer-daemon@googlemail.com" },
            { name: "Subject", value: "Delivery Status Notification (Failure)" },
          ],
        },
      }],
    }),
    classifyImpl: async () => { throw new Error("must not classify a bounce"); },
  });
  assert.equal(assessmentBlockCode(bounced), "OUTREACH_EMAIL_BOUNCED");
});

// ---------------------------------------------------------------------------
// PER-ROLE DECLINE MEMORY (built 2026-07-31)
//
// The intent gate above answers availability and deliberately lets a
// single-role "no" through. These cover the other half: remembering WHICH role
// was refused. The incident: a candidate wrote "I'm not interested in Kapwing
// or Toku" while a Toku request sat pending, and nothing in the lane could hear
// it.
// ---------------------------------------------------------------------------

const TOKU = { roleId: "role-toku", roleName: "Director of Engineering", companyName: "Toku" };
const ROGER = { roleId: "role-roger", roleName: "Staff Engineer", companyName: "Roger Healthcare" };

test("the declinable set spans emailed roles AND merely-pending ones", () => {
  const state = {
    candidateUserId: "cand-1",
    matches: { "req-old": { roleId: ROGER.roleId, roleName: ROGER.roleName, companyName: ROGER.companyName } },
  };
  // The pending Toku request was NEVER emailed — it reached the candidate only
  // through Paraform's digest page. That is exactly the 07-31 shape, and if the
  // set were built from `matches` alone his decline would be unmatchable.
  const history = [
    { candidateUserId: "cand-1", roleId: TOKU.roleId, roleName: TOKU.roleName, companyName: TOKU.companyName },
    { candidateUserId: "someone-else", roleId: "role-other", roleName: "PM", companyName: "Acme" },
  ];
  const roles = declinableRoles(state, history);
  assert.deepEqual(roles.map((row) => row.roleId).sort(), ["role-roger", "role-toku"]);
  // Another candidate's roles must never enter this candidate's closed set.
  assert.ok(!roles.some((row) => row.roleId === "role-other"));
  // A role in both sources appears once.
  assert.equal(declinableRoles(state, [
    { candidateUserId: "cand-1", roleId: ROGER.roleId, roleName: ROGER.roleName, companyName: ROGER.companyName },
  ]).length, 1);
});

test("the model can only ever name a role from the closed set", async () => {
  const roles = [TOKU, ROGER];
  const answer = (declined) => async () => ({
    ok: true,
    json: async () => ({
      content: [{ type: "tool_use", name: "record_declined_roles", input: { declined, reason: "x" } }],
    }),
  });
  const env = { ANTHROPIC_API_KEY: "test-key" };
  const first = await extractDeclinedRolesWithModel([{ text: "no to Toku" }], roles, {
    fetchImpl: answer([1]), env,
  });
  assert.deepEqual(first.roleIds, ["role-toku"]);
  // Out of range, non-numeric, and duplicated answers are DROPPED, not repaired:
  // a number we cannot map is not evidence of anything.
  const junk = await extractDeclinedRolesWithModel([{ text: "?" }], roles, {
    fetchImpl: answer([7, 0, -1, "role-toku", null, 2, 2]), env,
  });
  assert.deepEqual(junk.roleIds, ["role-roger"]);
});

test("decline extraction fails CLOSED: an unreachable model records nothing", async () => {
  const roles = [TOKU];
  const messages = [{ text: "not interested in Toku" }];
  // No API key: never guess from phrases. A wrong decline silently drops a
  // candidate from a role they wanted, so silence beats a guess.
  const unconfigured = await classifyDeclinedRoles(messages, roles, { env: {} });
  assert.deepEqual(unconfigured.roleIds, []);
  assert.equal(unconfigured.source, "unavailable");
  // A dead endpoint is the same answer, and it is distinguishable from a real
  // "nothing was declined" by `source` — the caller must never confuse them.
  const dead = await classifyDeclinedRoles(messages, roles, {
    env: { ANTHROPIC_API_KEY: "k" },
    fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({}) }),
    attempts: 1,
  });
  assert.deepEqual(dead.roleIds, []);
  assert.equal(dead.source, "unavailable");
  // The kill switch stops extraction without touching the model.
  const off = await classifyDeclinedRoles(messages, roles, {
    env: { ANTHROPIC_API_KEY: "k", PARAAI_OUTREACH_ROLE_DECLINE_DISABLED: "1" },
    fetchImpl: async () => { throw new Error("must not call the model"); },
  });
  assert.equal(off.source, "disabled");
});

test("declines latch: first detection wins and nothing is ever un-declined", () => {
  const roles = [TOKU, ROGER];
  const first = mergeDeclinedRoles({}, ["role-toku"], {
    roles, detectedAt: "2026-07-31T03:30:10.000Z", evidenceMessageId: "msg-1",
  });
  assert.equal(first["role-toku"].companyName, "Toku");
  assert.equal(first["role-toku"].declinedAt, "2026-07-31T03:30:10.000Z");
  // We store the message id, never the candidate's words.
  assert.equal(first["role-toku"].evidenceMessageId, "msg-1");
  assert.ok(!JSON.stringify(first).includes("not interested"));
  // A later re-read cannot move the timestamp and make an old decline look new.
  const again = mergeDeclinedRoles(first, ["role-toku"], {
    roles, detectedAt: "2026-08-05T00:00:00.000Z",
  });
  assert.equal(again["role-toku"].declinedAt, "2026-07-31T03:30:10.000Z");
  // Merging a second role keeps the first. There is no removal path here at all.
  const both = mergeDeclinedRoles(first, ["role-roger"], { roles });
  assert.deepEqual(Object.keys(both).sort(), ["role-roger", "role-toku"]);
});

test("a decline is latched even when the candidate is enthusiastically OPEN", async () => {
  // The exact 07-31 message: a yes and a no in one breath. Availability and
  // per-role interest must not be able to veto each other.
  const state = {
    candidateUserId: "cand-1",
    threadId: "t1",
    firstOutboundAt: "1970-01-01T00:00:01.000Z",
    matches: { "req-1": { roleId: ROGER.roleId, roleName: ROGER.roleName, companyName: ROGER.companyName } },
  };
  const assessment = await assessOutreachThread({
    state,
    config: { mailbox: "david@raydar.xyz" },
    history: [{ candidateUserId: "cand-1", ...TOKU }],
    threadImpl: async () => ({
      id: "t1",
      messages: [ourMessage("1000"), inbound(
        "Yes, I am interested in Roger Healthcare. I'm not interested in Kapwing or Toku.",
        { at: "2000" },
      )],
    }),
    classifyImpl: async () => ({ verdict: INTENT_OPEN, reason: "still looking", source: "model" }),
    declineImpl: async (_messages, roles) => {
      // The closed set must have been widened to include the pending role.
      assert.ok(roles.some((row) => row.roleId === "role-toku"));
      return { roleIds: ["role-toku"], source: "model" };
    },
  });
  assert.equal(assessment.verdict, INTENT_OPEN);
  assert.equal(assessment.hold, null, "an OPEN candidate is not held");
  assert.equal(assessmentBlockCode(assessment), null, "and no candidate-level block applies");
  assert.deepEqual(assessment.declined.roleIds, ["role-toku"]);

  const { patch, event } = assessmentPatch(assessment, { requestId: "req-2", state });
  assert.equal(event, "roles_declined");
  assert.equal(patch.declinedRoles["role-toku"].companyName, "Toku");
  // The reply still stops the nudge ladder, as it always did.
  assert.equal(patch.followup, null);

  // Enforcement is role-scoped: the declined role is blocked, everything else
  // for this same candidate still sends. That scoping IS the feature.
  const next = { ...state, ...patch };
  assert.ok(roleDeclined(next, "role-toku"));
  assert.equal(roleDeclined(next, "role-roger"), null);
  assert.equal(roleDeclined(next, "role-unseen"), null);

  // Re-running with the same knowledge must not churn the revision.
  const { patch: repeat } = assessmentPatch(assessment, { requestId: "req-3", state: next });
  assert.equal(repeat.declinedRoles, undefined);
});

test("a declined role is parked for a human and never retried by the tick", () => {
  const config = { notBeforeMs: Date.parse("2026-07-18T00:00:00.000Z") };
  const request = {
    id: "request-declined",
    status: "pending",
    reachedOut: false,
    createdAtMs: Date.parse("2026-07-31T00:52:15.493Z"),
  };
  // A candidate's own decision is never a transient failure: if it re-entered
  // the queue the tick would re-throw on it every five minutes forever.
  assert.deepEqual(
    eligibleNewRequests([request], config, [], [{
      requestId: request.id,
      status: "open",
      code: "OUTREACH_ROLE_DECLINED",
    }]),
    [],
  );
  // ...and the reached-out retry path must not resurrect it either.
  assert.deepEqual(
    eligibleNewRequests([{ ...request, reachedOut: true }], config, [], [{
      requestId: request.id,
      status: "open",
      code: "OUTREACH_ROLE_DECLINED",
      retryable: true,
    }]),
    [],
  );
});

// REGRESSION (incident 2026-07-31): every escalateNearExpiry call site lives
// inside handleOutreachFailure, which only runs when a request is PROCESSED. So
// a request held out of the eligible set — an off-market hold, a role decline,
// an uncertain send — escalated at most once, on the tick its failure was first
// raised, then went silent until the post-mortem after Paraform expired it. The
// 12h "last warning" could never fire for a request parked on day one. This
// sweep keys on the REQUEST instead, so being un-processable is no longer a way
// to be un-warned.
test("the deadline sweep warns about held requests the failure path never reaches", async () => {
  const now = Date.parse("2026-07-31T12:00:00.000Z");
  // Created 2026-07-25, so ~12h from the seven-day expiry: the tightest rung.
  const request = {
    id: "req-held",
    status: "pending",
    reachedOut: false,
    candidateName: "Avery Stone",
    roleName: "Director of Engineering",
    companyName: "Toku",
    createdAtMs: Date.parse("2026-07-25T00:00:00.000Z"),
  };
  const calls = [];
  const escalateImpl = async (req, code, opts) => {
    calls.push({ requestId: req.id, code, now: opts.now });
    return { rung: 12, hoursLeft: 12, notified: true };
  };
  // Parked on a human-held code, so nothing will ever process it again.
  const result = await sweepExpiryEscalations({
    history: [request],
    states: [],
    exceptions: [{ requestId: "req-held", status: "open", code: "OUTREACH_ROLE_DECLINED" }],
    now,
    escalateImpl,
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].requestId, "req-held");
  // The reason travels with the warning so the alert can name what is blocking.
  assert.equal(calls[0].code, "OUTREACH_ROLE_DECLINED");
  assert.deepEqual(result.escalated, [{ requestId: "req-held", rung: 12, code: "OUTREACH_ROLE_DECLINED" }]);
});

test("the deadline sweep covers a stuck request that has no exception at all", async () => {
  const now = Date.parse("2026-07-31T12:00:00.000Z");
  const calls = [];
  const escalateImpl = async (req, code) => {
    calls.push({ requestId: req.id, code });
    return { rung: 48, hoursLeft: 40, notified: true };
  };
  // The exception-driven ladder could not have seen this one: pending,
  // un-emailed, and nothing has reported a reason. Keying on the request is what
  // makes it visible.
  await sweepExpiryEscalations({
    history: [{
      id: "req-silent",
      status: "pending",
      reachedOut: false,
      createdAtMs: Date.parse("2026-07-25T00:00:00.000Z"),
    }],
    states: [],
    exceptions: [],
    now,
    escalateImpl,
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].code, null, "no exception means no code, not a fabricated one");
});

test("the deadline sweep never warns about a request that was already emailed", async () => {
  const now = Date.parse("2026-07-31T12:00:00.000Z");
  const base = {
    status: "pending",
    reachedOut: false,
    createdAtMs: Date.parse("2026-07-25T00:00:00.000Z"),
  };
  const calls = [];
  const escalateImpl = async (req) => { calls.push(req.id); return { rung: 12, notified: true }; };
  await sweepExpiryEscalations({
    history: [
      { ...base, id: "req-delivered" },
      // Paraform's marker set by a hand-sent email: our ledger has no delivery
      // record, but the candidate HAS heard from us, so "still not been emailed"
      // would be false. A deadline alert nobody needs is how alerting gets muted.
      { ...base, id: "req-reached-out", reachedOut: true },
      // Delivered during THIS tick: history and states were both read before it
      // landed, so only the explicit hand-off keeps it quiet.
      { ...base, id: "req-sent-now" },
      // Not pending any more, so not our problem: the stale-exception sweep owns it.
      { ...base, id: "req-submitted", status: "submitted" },
      { ...base, id: "req-expired", status: "expired" },
    ],
    states: [{ matches: { "req-delivered": { sentAt: "2026-07-26T00:00:00.000Z" } } }],
    exceptions: [],
    sentThisTick: ["req-sent-now"],
    now,
    escalateImpl,
  });
  assert.deepEqual(calls, [], "not one of these five is an un-emailed pending request");
});

test("a deadline warning with no exception says so instead of inventing one", () => {
  const request = {
    candidateName: "Avery Stone",
    roleName: "Director of Engineering",
    companyName: "Toku",
    createdAtMs: Date.parse("2026-07-24T17:16:00.000Z"),
  };
  const rung = { rung: 12, hoursLeft: 8 };
  const withCode = expiryEscalationCopy(request, "OUTREACH_ROLE_DECLINED", rung);
  assert.match(withCode, /Blocked by OUTREACH_ROLE_DECLINED/);
  // The sweep can raise a warning for a request with no ledger entry. Saying
  // "blocked by an exception" would send David hunting for one that isn't there.
  const withoutCode = expiryEscalationCopy(request, null, rung);
  assert.ok(!/Blocked by an exception/.test(withoutCode));
  assert.match(withoutCode, /NOTHING has reported a reason/);
  assert.match(withoutCode, /Paraform/);
  // Both still carry the deadline and the last-warning marker.
  for (const copy of [withCode, withoutCode]) {
    assert.match(copy, /expires in ~8h/);
    assert.match(copy, /This is the last warning/);
  }
});

// REGRESSION (incident 2026-07-29, William M.). Paraform sometimes stores an
// abbreviated display name, and the calendar half of discovery then cannot work:
// Google's tokenised search returns a DIFFERENT person's event for q="William M."
// and the loose name filter would accept that stranger. Since corroboration needs
// both halves, nobody with an abbreviated name and no Paraform email could ever
// be resolved. Identity now comes from the LinkedIn handle Calendly writes into
// the booked event, never from a surname guessed off the handle — measured
// against 140 known full names, such a guess is still wrong ~4% of the time.
test("an abbreviated name resolves through the LinkedIn handle, not a guessed surname", () => {
  assert.equal(isAbbreviatedName("William M."), true);
  assert.equal(isAbbreviatedName("William M"), true);
  assert.equal(isAbbreviatedName("William Mulder"), false);
  assert.equal(isAbbreviatedName("Cher"), false);

  assert.equal(normalizeLinkedinHandle("williammulder"), "williammulder");
  assert.equal(normalizeLinkedinHandle("https://www.linkedin.com/in/william-mulder/"), "william-mulder");
  assert.equal(normalizeLinkedinHandle("  WilliamMulder "), "williammulder");
  // Anything we cannot reduce to a bare handle is refused rather than guessed at.
  assert.equal(normalizeLinkedinHandle("linkedin.com/company/acme"), "");
  assert.equal(normalizeLinkedinHandle("not a handle"), "");
  assert.equal(normalizeLinkedinHandle(""), "");
});

test("the handle route is chosen for abbreviated names only", () => {
  // The whole point: this is the case the name route cannot serve.
  assert.equal(handleRouteFor("William M.", "william-mulder"), "william-mulder");
  assert.equal(handleRouteFor("William M", "https://linkedin.com/in/william-mulder"), "william-mulder");
  // A full name keeps the name route. Switching it to the handle would silently
  // lose every candidate whose meeting was booked outside Calendly, because
  // those events carry no LinkedIn URL and would yield no evidence at all.
  assert.equal(handleRouteFor("William Mulder", "william-mulder"), "");
  // No handle, or an unusable one, means no route change and no guessing.
  assert.equal(handleRouteFor("William M.", ""), "");
  assert.equal(handleRouteFor("William M.", "linkedin.com/company/acme"), "");
});

test("handle matching is exact, so a prefix can never pull in a stranger", () => {
  const event = (description) => ({ description, attendees: [{ email: "w@example.com" }] });
  assert.equal(
    eventMentionsLinkedinHandle(event("Booked via Calendly\nLinkedIn: https://linkedin.com/in/william-mulder"), "william-mulder"),
    true,
  );
  // The failure mode that matters: a shorter handle must not match a longer one.
  assert.equal(eventMentionsLinkedinHandle(event("linkedin.com/in/williammulder"), "willi"), false);
  assert.equal(eventMentionsLinkedinHandle(event("linkedin.com/in/amyzhang"), "amy"), false);
  assert.equal(eventMentionsLinkedinHandle(event("linkedin.com/in/amy"), "amyzhang"), false);
  // A name in the description is not identity — only the URL counts.
  assert.equal(eventMentionsLinkedinHandle(event("Call with William Mulder"), "william-mulder"), false);
  assert.equal(eventMentionsLinkedinHandle(event(""), "william-mulder"), false);
  assert.equal(eventMentionsLinkedinHandle(event("linkedin.com/in/william-mulder"), ""), false);
});

test("only handle-bearing events contribute an address, and never our own", () => {
  const events = [
    {
      description: "LinkedIn: https://www.linkedin.com/in/william-mulder",
      attendees: [{ email: "david@raydar.xyz" }, { email: "William@Example.com" }],
    },
    // A different person's event, which is exactly what q="William M." returned
    // in production. No matching handle, so it contributes nothing.
    { description: "LinkedIn: https://linkedin.com/in/william-marsh", attendees: [{ email: "marsh@example.com" }] },
    { description: "no linkedin url here", attendees: [{ email: "stranger@example.com" }] },
  ];
  assert.deepEqual(linkedinCalendarEvidence(events, "william-mulder", "david@raydar.xyz"), ["william@example.com"]);
  // No handle means no evidence at all — never a fallback to "everything".
  assert.deepEqual(linkedinCalendarEvidence(events, "", "david@raydar.xyz"), []);
});

test("the handle route runs only for abbreviated names, and corroboration still rules", async () => {
  const routed = [];
  const calendarEvidenceImpl = async (_mailbox, name, opts = {}) => {
    routed.push({ name, linkedinUser: opts.linkedinUser });
    return ["william@example.com"];
  };
  // Gmail keeps offering the disposable-domain lookalikes it found in production.
  // The intersection with a handle-verified calendar address is what discards
  // them, which is why the Gmail half was left alone.
  const gmailEvidenceImpl = async () => [
    "william@example.com", "william.m@spam.cfd", "william.m@spam.icu",
  ];
  const resolved = await discoverCandidateContact(
    { candidateName: "William M.", mailbox: "david@raydar.xyz", linkedinUser: "william-mulder" },
    { gmailEvidenceImpl, calendarEvidenceImpl },
  );
  assert.equal(resolved.email, "william@example.com");
  assert.equal(resolved.confidence, "gmail_calendar_corroborated");
  assert.equal(routed[0].linkedinUser, "william-mulder", "the handle reaches the calendar half");

  // Two corroborated addresses is still ambiguous and must still fail closed —
  // this path did not loosen the rule, it only fed the calendar half better.
  const ambiguous = await discoverCandidateContact(
    { candidateName: "William M.", mailbox: "david@raydar.xyz", linkedinUser: "william-mulder" },
    {
      gmailEvidenceImpl: async () => ["a@example.com", "b@example.com"],
      calendarEvidenceImpl: async () => ["a@example.com", "b@example.com"],
    },
  );
  assert.equal(ambiguous.email, "");
  assert.equal(ambiguous.confidence, "unresolved");

  // And a candidate with no handle is exactly as resolvable as before: the
  // feature adds a route, it never removes the existing one.
  const noHandle = await discoverCandidateContact(
    { candidateName: "William Mulder", mailbox: "david@raydar.xyz" },
    { gmailEvidenceImpl: async () => ["william@example.com"], calendarEvidenceImpl },
  );
  assert.equal(noHandle.email, "william@example.com");
  assert.equal(routed[routed.length - 1].linkedinUser, "", "no handle passed, name route as before");
});

test("the decline alert names the role and says the other roles still send", () => {
  const copy = heldAlertCopy(
    "OUTREACH_ROLE_DECLINED",
    { candidateName: "Avery Stone", roleName: "Director of Engineering", companyName: "Toku" },
    { detail: { declinedAt: "2026-07-31T03:30:10.000Z" } },
  );
  assert.match(copy, /Director of Engineering @ Toku/);
  assert.match(copy, /NOT sent/);
  assert.match(copy, /2026-07-31/);
  // The scoping is the reassurance David needs: this is one role, not a person.
  assert.match(copy, /Every other role for them still sends/);
  // David's next move is on Paraform, so the alert has to say so.
  assert.match(copy, /dismiss/i);
  // Never the candidate's own words, same rule as every other held alert. The
  // copy states the verdict in OUR voice; anything that reads like a quotation
  // of their message is the thing this guards against.
  assert.ok(!/not interested in/i.test(copy));
  assert.ok(!/["“”]/.test(copy));
});

test("an already-judged conversation is never re-classified", async () => {
  let classified = 0;
  const assessment = await assessOutreachThread({
    state: {
      threadId: "t1",
      firstOutboundAt: "1970-01-01T00:00:01.000Z",
      intentCheckedThrough: 2000,
      intentVerdict: INTENT_OPEN,
    },
    config: { mailbox: "david@raydar.xyz" },
    threadImpl: async () => ({ id: "t1", messages: [ourMessage("1000"), inbound("Not for me", { at: "2000" })] }),
    classifyImpl: async () => { classified += 1; return { verdict: INTENT_OPEN }; },
  });
  assert.equal(classified, 0, "no repeat model spend on the same messages");
  assert.equal(assessment.cached, true);
  assert.equal(assessment.verdict, INTENT_OPEN);
});

test("a cleared reply sends the role but never re-arms the nudge ladder", () => {
  // The 07-26 incident was two follow-ups after a decline. Even now that the new
  // role sends, the ladder must stay dead for anyone who has ever written back.
  const { patch, event } = assessmentPatch(
    { checked: true, replied: true, newestInboundMs: 2000, verdict: INTENT_OPEN, hold: null, bounce: null },
    { requestId: "req-9" },
  );
  assert.equal(event, "reply_cleared_for_new_role");
  assert.equal(patch.followup, null);
  assert.ok(patch.repliedAt);
  assert.equal(patch.intentVerdict, INTENT_OPEN);
  assert.equal(patch.offMarket, undefined);

  const planned = planDeliveredMatch(
    { ...patch, candidateUserId: "c1", matches: {}, outbox: {}, journal: [] },
    {
      request: { id: "req-9", roleId: "role-9", roleName: "Founding Engineer", companyName: "Rama" },
      ordinal: 2,
      roleUrl: "https://www.paraform.com/share/rama/role-9",
      digest: { digestId: "d1", digestUrl: "https://www.paraform.com/digest/d1" },
      copy: { subject: "Interview Request", variant: "additional_exact" },
      sent: { id: "m2", threadId: "t1" },
      sentAt: "2026-07-28T10:00:00.000Z",
      messageId: "<y@raydar.xyz>",
    },
  );
  assert.equal(planned.followup, null, "no re-armed ladder after any prior reply");
  assert.ok(planned.matches["req-9"], "the new role is still delivered and recorded");

  // An existing reply timestamp is the anchor and is never overwritten.
  const later = assessmentPatch(
    { checked: true, replied: true, newestInboundMs: 3000, verdict: INTENT_OPEN },
    { repliedAt: "2026-07-01T00:00:00.000Z" },
  );
  assert.equal(later.patch.repliedAt, "2026-07-01T00:00:00.000Z");
});

test("held requests stay parked until reviewed, and bounces self-heal", () => {
  const history = [
    { id: "req-held", status: "pending", reachedOut: false, createdAtMs: 2_000_000, candidateUserId: "c1", roleId: "r1", roleName: "Engineer" },
    { id: "req-bounced", status: "pending", reachedOut: false, createdAtMs: 2_000_000, candidateUserId: "c2", roleId: "r2", roleName: "Engineer" },
  ];
  const config = { notBeforeMs: 1_000_000 };
  const stale = new Date(Date.now() - 10 * 60 * 1000).toISOString();

  // The retired 07-26 code must keep parking its backlog: those requests are
  // released by the explicit review/release action, never by a passing tick.
  const legacyHeld = eligibleNewRequests(history, config, [], [
    { status: "open", code: "OUTREACH_CANDIDATE_REPLIED", requestId: "req-held", lastSeenAt: stale },
    { status: "open", code: "OUTREACH_EMAIL_BOUNCED", requestId: "req-bounced", lastSeenAt: stale },
  ]);
  assert.deepEqual(legacyHeld.map((row) => row.id), ["req-bounced"]);

  // An off-market hold parks its request the same way.
  const offMarketHeld = eligibleNewRequests(history, config, [], [
    { status: "open", code: "OUTREACH_CANDIDATE_OFF_MARKET", requestId: "req-held", lastSeenAt: stale },
    { status: "open", code: "OUTREACH_CANDIDATE_DO_NOT_CONTACT", requestId: "req-bounced", lastSeenAt: stale },
  ]);
  assert.deepEqual(offMarketHeld.map((row) => row.id), []);
});

test("hold alerts name the verdict and the remedy, never the candidate's words", () => {
  const request = { id: "req-1", candidateName: "Avery Stone", roleName: "Founding Engineer", companyName: "Rama" };
  const offMarket = heldAlertCopy("OUTREACH_CANDIDATE_OFF_MARKET", request, {
    detail: { expiresAt: "2027-01-26T00:00:00.000Z" },
  });
  assert.match(offMarket, /off the market/);
  assert.match(offMarket, /Founding Engineer @ Rama/);
  assert.match(offMarket, /lifts automatically on 2027-01-26/);

  const stop = heldAlertCopy("OUTREACH_CANDIDATE_DO_NOT_CONTACT", request);
  assert.match(stop, /stop emailing/);
  assert.match(stop, /no future role/);

  const bounced = heldAlertCopy("OUTREACH_EMAIL_BOUNCED", request);
  assert.match(bounced, /undeliverable/);
  assert.match(bounced, /retries automatically/);
});
