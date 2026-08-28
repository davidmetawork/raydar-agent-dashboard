import assert from "node:assert/strict";
import test from "node:test";

import {
  deliverViaMailroomRelief,
  mailroomReliefConfig,
  mailroomReliefDedupeKey,
  OutreachMailroomError,
  PARAAI_OUTREACH_RELIEF_LANE,
} from "../api/paraai/_lib/outreach-mailroom.mjs";
import { planDeliveredMatch } from "../api/paraai/_lib/outreach.mjs";

const config = {
  base: "https://mailroom.test",
  key: "secret",
  lane: PARAAI_OUTREACH_RELIEF_LANE,
  configured: true,
};

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json" },
});

const message = {
  to: "candidate@example.com",
  subject: "1st Round - Interview Request @ Acme 🎉",
  bodyText: "Hey Candidate,\n\nA role is ready.\n\nThanks,\nDavid",
  bodyHtml: "<div>Hey Candidate,</div><div>A role is ready.</div>",
};

test("mailroom relief configuration is explicit and dedupe is request-scoped", () => {
  assert.deepEqual(mailroomReliefConfig({
    MAILROOM_BASE: "https://mailroom.test/",
    MAILROOM_API_KEY: "secret",
  }), config);
  assert.equal(mailroomReliefDedupeKey("req-1"), "paraai-outreach:req-1");
});

test("mailroom relief enqueues once, drains, and returns the provider receipt", async () => {
  const calls = [];
  let statusReads = 0;
  const fetchImpl = async (url, init = {}) => {
    const parsed = new URL(url);
    calls.push({ path: parsed.pathname, search: parsed.search, method: init.method, body: init.body });
    if (parsed.pathname === "/api/status") {
      statusReads += 1;
      return statusReads === 1
        ? json({ ok: true, found: false })
        : json({
            ok: true,
            found: true,
            state: "sent",
            sent_at: "2026-08-28T16:00:00.000Z",
            gmail_message_id: "sendgrid-provider-1",
            result_thread_id: null,
          });
    }
    if (parsed.pathname === "/api/enqueue") return json({ ok: true, enqueued: true, id: 2401 });
    if (parsed.pathname === "/api/worker") return json({ ok: true, report: [] });
    throw new Error(`unexpected ${parsed.pathname}`);
  };

  const result = await deliverViaMailroomRelief({
    message,
    requestId: "req-1",
    candidateName: "Candidate One",
    config,
    fetchImpl,
    sleepImpl: async () => {},
  });

  assert.equal(result.providerMessageId, "sendgrid-provider-1");
  assert.equal(result.mailroomRowId, 2401);
  assert.equal(result.transport, "mailroom-sendgrid");
  assert.deepEqual(calls.map((call) => call.path), [
    "/api/status",
    "/api/enqueue",
    "/api/worker",
    "/api/status",
  ]);
  const enqueued = JSON.parse(calls.find((call) => call.path === "/api/enqueue").body);
  assert.equal(enqueued.lane, PARAAI_OUTREACH_RELIEF_LANE);
  assert.equal(enqueued.dedupeKey, "paraai-outreach:req-1");
  assert.equal(enqueued.to, "candidate@example.com");
  assert.equal(enqueued.subject, message.subject);
});

test("mailroom relief reconciles an existing sent row without enqueueing", async () => {
  const paths = [];
  const result = await deliverViaMailroomRelief({
    message,
    requestId: "req-2",
    config,
    fetchImpl: async (url) => {
      paths.push(new URL(url).pathname);
      return json({
        ok: true,
        found: true,
        state: "sent",
        sent_at: "2026-08-28T16:01:00.000Z",
        gmail_message_id: "sendgrid-provider-2",
      });
    },
  });
  assert.equal(result.providerMessageId, "sendgrid-provider-2");
  assert.deepEqual(paths, ["/api/status"]);
});

test("mailroom relief refuses threading and parked rows", async () => {
  await assert.rejects(
    () => deliverViaMailroomRelief({
      message: { ...message, threadId: "gmail-thread" },
      requestId: "req-3",
      config,
      fetchImpl: async () => { throw new Error("should not fetch"); },
    }),
    (error) => error instanceof OutreachMailroomError
      && error.code === "OUTREACH_MAILROOM_THREADING_FORBIDDEN",
  );
  await assert.rejects(
    () => deliverViaMailroomRelief({
      message,
      requestId: "req-4",
      config,
      fetchImpl: async () => json({
        ok: true,
        found: true,
        state: "review",
        last_error: "provider outcome ambiguous",
      }),
    }),
    (error) => error instanceof OutreachMailroomError
      && error.code === "OUTREACH_MAILROOM_PARKED",
  );
});

test("a SendGrid relief delivery is recorded without an automatic follow-up", () => {
  const state = {
    candidateUserId: "candidate-1",
    revision: 2,
    journal: [],
    matches: {},
    outbox: {},
    followup: { ownerMatchId: "older-request" },
  };
  const planned = planDeliveredMatch(state, {
    request: {
      id: "req-5",
      roleId: "role-1",
      roleName: "Engineer",
      companyName: "Acme",
    },
    ordinal: 2,
    roleUrl: "https://www.paraform.com/share/acme/role-1",
    digest: { digestId: "digest-1", digestUrl: "https://www.paraform.com/digest/1" },
    copy: { subject: null, variant: "second_exact" },
    sent: { providerMessageId: "sendgrid-provider-5", mailroomRowId: 2405 },
    sentAt: "2026-08-28T16:05:00.000Z",
    messageId: "<mailroom-message>",
    transport: "mailroom-sendgrid",
    armFollowup: false,
  });
  assert.equal(planned.followup, null);
  assert.equal(planned.matches["req-5"].gmailMessageId, null);
  assert.equal(planned.matches["req-5"].providerMessageId, "sendgrid-provider-5");
  assert.equal(planned.outbox["match:req-5"].mailroomRowId, 2405);
  assert.equal(planned.journal.at(-1).followupSuppressed, true);
});
