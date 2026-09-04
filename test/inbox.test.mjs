import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  applyInboxTriage,
  assembleInboxSnapshotFeed,
  buildInboxFeed,
  buildInboxRefresh,
  campaignInboxInput,
  campaignsToScan,
  countInboxReplies,
  emptyInboxSnapshotState,
  flattenCampaignInbox,
  flattenCampaignInboxForSubmissions,
  inboxReplyBucket,
  inboxSubmissionsProjectionCoverage,
  inboxTrpcGet,
  isInboxCuratedListCampaign,
  isInboxRoleOutreachCampaign,
  mergeAndSortReplies,
  mergeInboxRefreshState,
  normalizeReplyCategory,
  parseInboxTriage,
  readInboxTriage,
  selectInboxCampaigns,
  shouldExcludeInboxReply,
  writeInboxRefreshState,
  writeInboxTriage,
} from "../api/inbox/_lib/core.mjs";
import { OUTCOME_SEQUENCE_RULES } from "../api/roster/_lib/outcome-sequences.mjs";
import {
  createInboxFeedHandler,
} from "../api/inbox/feed.mjs";
import {
  createInboxTriageHandler,
} from "../api/inbox/triage.mjs";
import {
  createInboxSyncHandler,
} from "../api/inbox/sync.mjs";

function mockResponse() {
  return {
    body: null,
    headers: {},
    statusCode: 200,
    setHeader(name, value) {
      this.headers[name] = value;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

test("live campaign inbox rows keep only nested inbound email and join lead metadata", () => {
  const rows = flattenCampaignInbox(
    { id: "sequence-1", name: "Platform search", can_reply: true },
    {
      campaign_to_candidate_users: [
        {
          id: "lead-1",
          reply_category: " interested ",
          tracking_status: "opened",
          is_archived: true,
          candidate_user: {
            emails: [{ email: "ada@example.com" }],
            candidate: {
              name: "Ada Lovelace",
              image_src: "https://images.example/ada.png",
              linkedin_user: "https://www.linkedin.com/in/ada",
              experiences: [
                {
                  is_current: true,
                  title: "Staff Engineer",
                  company: { name: "Analytical Engines" },
                },
              ],
            },
          },
        },
      ],
      campaign_emails: [
        {
          campaign_to_candidate_user_id: "lead-1",
          email: {
            gmail_id: "gmail-inbound",
            thread_id: "thread-1",
            sent_from_paraform: false,
            subject: " Re: Platform role ",
            snippet: "I would like to learn more.",
            email_date: "2026-07-16T18:00:00.000Z",
            attachments: [{ id: "attachment-1" }],
          },
        },
        {
          campaign_to_candidate_user_id: "lead-1",
          email: {
            gmail_id: "gmail-outbound",
            sent_from_paraform: true,
            subject: "Platform role",
          },
        },
        {
          campaign_to_candidate_user_id: "lead-1",
          email: {
            gmail_id: "gmail-unknown-direction",
            subject: "Direction is required",
          },
        },
      ],
    },
  );

  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], {
    candidate_name: "Ada Lovelace",
    candidate_email: "ada@example.com",
    candidate_image: "https://images.example/ada.png",
    candidate_linkedin_url: "https://www.linkedin.com/in/ada",
    candidate_one_liner: "Staff Engineer at Analytical Engines",
    sequence_name: "Platform search",
    sequence_id: "sequence-1",
    subject: "Re: Platform role",
    snippet: "I would like to learn more.",
    date: "2026-07-16T18:00:00.000Z",
    gmail_id: "gmail-inbound",
    thread_id: "thread-1",
    ccu_id: "lead-1",
    reply_category: "INTERESTED",
    tracking_status: "OPENED",
    is_archived: true,
    can_reply: true,
    attachment_count: 1,
  });
});

test("reply categories normalize Paraform values and fail closed to NA", () => {
  assert.equal(normalizeReplyCategory("INTERESTED"), "INTERESTED");
  assert.equal(normalizeReplyCategory(" not_interested "), "NOT_INTERESTED");
  assert.equal(normalizeReplyCategory("unclear"), "UNCLEAR");
  assert.equal(normalizeReplyCategory(""), "NA");
  assert.equal(normalizeReplyCategory("unexpected"), "NA");
  assert.equal(normalizeReplyCategory(null), "NA");
});

test("Inbox exclusion removes David mailbox traffic by exact address in either direction", () => {
  assert.equal(shouldExcludeInboxReply({
    candidate_email: "DAVID@RAYDAR.XYZ",
    subject: "Test reply",
  }), true);
  assert.equal(shouldExcludeInboxReply({
    candidate_email: "candidate@example.com",
    subject: "Test reply",
  }, [
    "Candidate <candidate@example.com>",
    "David Phillips <david@raydar.xyz>",
  ]), true);
  assert.equal(shouldExcludeInboxReply({
    candidate_email: "candidate@example.com",
    subject: "Forwarded note",
    snippet: "Originally sent to david@raydar.xyz",
  }), true);
  assert.equal(shouldExcludeInboxReply({
    candidate_email: "david@raydar.xyz.example.com",
    subject: "A real candidate reply",
    snippet: "Interested in learning more.",
  }), false);
});

test("Inbox exclusion removes delay, bounce, and delivery-failure notifications", () => {
  const excluded = [
    { subject: "Delivery Status Notification (Delay)", snippet: "" },
    { subject: "Delivery Status Notification (Failure)", snippet: "" },
    { subject: "Undeliverable: Platform role", snippet: "" },
    { subject: "Mail delivery failed: returning message to sender", snippet: "" },
    { subject: "Re: Platform role", snippet: "Address not found. Your message wasn't delivered." },
    { candidate_email: "mailer-daemon@example.com", subject: "Status", snippet: "" },
    { candidate_email: "bounce+123@example.com", subject: "Status", snippet: "" },
  ];
  for (const reply of excluded) {
    assert.equal(shouldExcludeInboxReply(reply), true, reply.subject);
  }
  assert.equal(shouldExcludeInboxReply({
    candidate_email: "candidate@example.com",
    subject: "Re: Delivery platform opportunity",
    snippet: "Thanks, I am interested in the role.",
  }), false);
});

test("Submissions projection coverage stays unseeded when the catalog has no targets", () => {
  const state = emptyInboxSnapshotState();
  state.catalog = {
    version: 3,
    submissions_projection_version: 1,
    refreshed_at: "2026-09-03T12:00:00.000Z",
    campaigns_total: 0,
    targets: [],
  };
  const coverage = inboxSubmissionsProjectionCoverage(state, {
    now: () => new Date("2026-09-03T12:01:00.000Z"),
  });
  assert.equal(coverage.coverage_complete, false);
  assert.equal(coverage.confirmed_through, null);
});

test("campaign rows and materialized feeds enforce Inbox exclusions before counts", () => {
  const campaign = { id: "sequence-1", name: "Platform search" };
  const inboxData = {
    campaign_to_candidate_users: [
      {
        id: "lead-real",
        candidate_email: "real@example.com",
        candidate_user: { candidate: { name: "Real Candidate" } },
      },
      {
        id: "lead-david",
        candidate_email: "david@raydar.xyz",
        candidate_user: { candidate: { name: "Internal Test" } },
      },
      {
        id: "lead-delay",
        candidate_email: "mailer-daemon@example.com",
        candidate_user: { candidate: { name: "Mail Delivery Subsystem" } },
      },
    ],
    campaign_emails: [
      {
        campaign_to_candidate_user_id: "lead-real",
        email: {
          gmail_id: "gmail-real",
          sent_from_paraform: false,
          subject: "Re: Platform role",
          snippet: "I would like to discuss.",
        },
      },
      {
        campaign_to_candidate_user_id: "lead-david",
        email: {
          gmail_id: "gmail-david",
          sent_from_paraform: false,
          subject: "Test",
        },
      },
      {
        campaign_to_candidate_user_id: "lead-delay",
        email: {
          gmail_id: "gmail-delay",
          sent_from_paraform: false,
          subject: "Delivery Status Notification (Delay)",
        },
      },
      {
        campaign_to_candidate_user_id: "lead-real",
        email: {
          gmail_id: "gmail-to-david",
          sent_from_paraform: false,
          subject: "Another test",
          to: ["David Phillips <david@raydar.xyz>"],
        },
      },
    ],
  };

  const rows = flattenCampaignInbox(campaign, inboxData);
  assert.deepEqual(rows.map(({ gmail_id }) => gmail_id), ["gmail-real"]);

  const cached = applyInboxTriage({
    replies: [
      rows[0],
      {
        gmail_id: "cached-david",
        candidate_email: "david@raydar.xyz",
        subject: "Old cached test",
      },
      {
        gmail_id: "cached-bounce",
        candidate_email: "candidate@example.com",
        subject: "Undeliverable: old sequence",
      },
    ],
  }, new Map());
  assert.deepEqual(cached.replies.map(({ gmail_id }) => gmail_id), ["gmail-real"]);
  assert.equal(cached.counts.total, 1);
});

test("Submissions projection retains a candidate reply to David without changing Inbox UI rows", () => {
  const campaign = { id: "sequence-primary", name: "Primary mailbox campaign" };
  const inboxData = {
    campaign_to_candidate_users: [{
      id: "lead-1",
      candidate_email: "candidate@example.com",
      candidate_user_id: "candidate-user-1",
    }],
    campaign_emails: [{
      campaign_to_candidate_user_id: "lead-1",
      email: {
        gmail_id: "gmail-primary-reply",
        sent_from_paraform: false,
        subject: "Re: Role",
        snippet: "Yes, interested.",
        to: ["David <david@raydar.xyz>"],
      },
    }],
  };
  assert.equal(flattenCampaignInbox(campaign, inboxData).length, 0);
  const projected = flattenCampaignInboxForSubmissions(campaign, inboxData);
  assert.equal(projected.length, 1);
  assert.equal(projected[0].candidate_user_id, "candidate-user-1");
  assert.equal(projected[0].gmail_id, "gmail-primary-reply");
});

test("triage overlay assigns one effective bucket and recomputes active counts", () => {
  const base = {
    generated_at: "2026-07-17T18:00:00.000Z",
    replies: [
      {
        gmail_id: "gmail-active",
        reply_category: "INTERESTED",
        is_archived: false,
      },
      {
        gmail_id: "gmail-archived",
        reply_category: "INTERESTED",
        is_archived: false,
      },
      {
        gmail_id: "gmail-complete",
        reply_category: "UNCLEAR",
        is_archived: true,
      },
      {
        gmail_id: "gmail-paraform-archived",
        reply_category: "NOT_INTERESTED",
        is_archived: true,
      },
    ],
  };
  const triage = parseInboxTriage([
    "gmail-archived",
    JSON.stringify({
      status: "archived",
      updated_at: "2026-07-17T18:01:00.000Z",
    }),
    "gmail-complete",
    JSON.stringify({
      status: "complete",
      updated_at: "2026-07-17T18:02:00.000Z",
    }),
  ]);

  const feed = applyInboxTriage(base, triage);
  assert.deepEqual(
    feed.replies.map((reply) => inboxReplyBucket(reply)),
    ["active", "archived", "complete", "archived"],
  );
  assert.equal(feed.replies[0].triage_status, null);
  assert.equal(feed.replies[1].triage_status, "archived");
  assert.equal(feed.replies[2].triage_status, "complete");
  assert.deepEqual(feed.counts, {
    total: 4,
    interested: 1,
    needs_review: 0,
    not_interested: 0,
    archived: 2,
    complete: 1,
  });

  const restored = {
    ...feed.replies[2],
    triage_status: null,
  };
  assert.equal(inboxReplyBucket(restored), "archived");
  assert.deepEqual(countInboxReplies([restored]), {
    total: 1,
    interested: 0,
    needs_review: 0,
    not_interested: 0,
    archived: 1,
    complete: 0,
  });
});

test("triage hash parsing ignores orphan fields but fails closed on corrupt records", () => {
  const valid = {
    "gmail-valid": JSON.stringify({
      status: "complete",
      updated_at: "2026-07-17T18:00:00.000Z",
    }),
    "contains spaces": JSON.stringify({ status: "archived" }),
  };
  const triage = parseInboxTriage(valid);
  assert.deepEqual([...triage.entries()], [[
    "gmail-valid",
    {
      status: "complete",
      updated_at: "2026-07-17T18:00:00.000Z",
    },
  ]]);
  assert.throws(
    () => parseInboxTriage({
      ...valid,
      "gmail-invalid-status": JSON.stringify({ status: "later" }),
    }),
    { code: "INVALID_TRIAGE_RECORD" },
  );
  assert.throws(
    () => parseInboxTriage({
      ...valid,
      "gmail-invalid-json": "{",
    }),
    { code: "INVALID_TRIAGE_RECORD" },
  );
});

test("triage reads fail closed when a valid stored record is corrupt", async () => {
  const read = await readInboxTriage({
    configured: true,
    kvImpl: async () => [
      "gmail-corrupt",
      JSON.stringify({ status: "unknown" }),
    ],
  });
  assert.deepEqual(read, { status: "error", value: null });
});

test("triage storage writes, reads back, and restores durable hash state", async () => {
  const hash = new Map();
  const commands = [];
  const kvImpl = async (args) => {
    commands.push(args);
    const [command, , field, value] = args;
    if (command === "EVAL") {
      const gmailId = args[4];
      const record = args[5];
      if (record === undefined) {
        hash.delete(gmailId);
        return 0;
      }
      hash.set(gmailId, record);
      return record;
    }
    if (command === "HGETALL") return [...hash.entries()].flat();
    throw new Error(`Unexpected command ${command}`);
  };

  const saved = await writeInboxTriage("gmail-1", "archived", {
    kvImpl,
    now: () => new Date("2026-07-17T18:00:00.000Z"),
  });
  assert.deepEqual(saved, {
    gmail_id: "gmail-1",
    status: "archived",
    updated_at: "2026-07-17T18:00:00.000Z",
  });
  const read = await readInboxTriage({ kvImpl, configured: true });
  assert.equal(read.status, "ready");
  assert.equal(read.value.get("gmail-1").status, "archived");

  const restored = await writeInboxTriage("gmail-1", null, { kvImpl });
  assert.deepEqual(restored, {
    gmail_id: "gmail-1",
    status: null,
    updated_at: null,
  });
  assert.equal(hash.has("gmail-1"), false);
  assert.equal(commands.some((args) => args.includes("EX")), false);
});

test("triage endpoint authenticates, validates, and returns confirmed state", async () => {
  let writes = 0;
  const unauthenticated = createInboxTriageHandler({
    corsHandler: () => false,
    authHandler: async (_req, res) => {
      res.status(401).json({ ok: false, error: "auth_required" });
      return false;
    },
    storeReady: () => true,
    writeTriage: async () => {
      writes += 1;
    },
  });
  const unauthenticatedResponse = mockResponse();
  await unauthenticated({
    method: "POST",
    headers: { "content-type": "application/json" },
    body: { gmail_id: "gmail-1", status: "archived" },
  }, unauthenticatedResponse);
  assert.equal(unauthenticatedResponse.statusCode, 401);
  assert.equal(writes, 0);

  const calls = [];
  const handler = createInboxTriageHandler({
    corsHandler: () => false,
    authHandler: async () => true,
    storeReady: () => true,
    writeTriage: async (gmailId, status) => {
      calls.push([gmailId, status]);
      return {
        gmail_id: gmailId,
        status,
        updated_at: status ? "2026-07-17T18:00:00.000Z" : null,
      };
    },
  });
  const unsupportedResponse = mockResponse();
  await handler({
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: JSON.stringify({ gmail_id: "gmail-1", status: "complete" }),
  }, unsupportedResponse);
  assert.equal(unsupportedResponse.statusCode, 415);
  assert.equal(unsupportedResponse.body.error, "unsupported_media_type");
  assert.equal(calls.length, 0);

  const invalidResponse = mockResponse();
  await handler({
    method: "POST",
    headers: { "content-type": "application/json" },
    body: { gmail_id: "gmail-1", status: "later" },
  }, invalidResponse);
  assert.equal(invalidResponse.statusCode, 400);
  assert.equal(invalidResponse.body.error, "invalid_triage_status");

  const response = mockResponse();
  await handler({
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({ gmail_id: "gmail-1", status: "complete" }),
  }, response);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, {
    ok: true,
    gmail_id: "gmail-1",
    status: "complete",
    updated_at: "2026-07-17T18:00:00.000Z",
  });

  const restoreResponse = mockResponse();
  await handler({
    method: "POST",
    headers: { "content-type": "application/json" },
    body: { gmail_id: "gmail-1", status: "inbox" },
  }, restoreResponse);
  assert.equal(restoreResponse.statusCode, 200);
  assert.deepEqual(calls, [
    ["gmail-1", "complete"],
    ["gmail-1", null],
  ]);
});

test("feed serves one materialized snapshot with the latest triage overlay", async () => {
  let stateReads = 0;
  let triageReads = 0;
  let assemblies = 0;
  const handler = createInboxFeedHandler({
    corsHandler: () => false,
    authHandler: async () => true,
    readState: async () => {
      stateReads += 1;
      return { status: "ready", value: { snapshot: true } };
    },
    readTriage: async () => {
      triageReads += 1;
      return {
        status: "ready",
        value: new Map([[
          "gmail-1",
          { status: "complete", updated_at: "2026-07-17T18:01:00.000Z" },
        ]]),
      };
    },
    assembleFeed: (state) => {
      assert.deepEqual(state, { snapshot: true });
      assemblies += 1;
      return {
      generated_at: "2026-07-17T18:00:00.000Z",
      partial: false,
      cacheable: true,
      replies: [{
        gmail_id: "gmail-1",
        reply_category: "INTERESTED",
        is_archived: false,
      }],
      counts: {},
      scan: {},
      };
    },
  });
  const response = mockResponse();
  await handler({ method: "GET" }, response);

  assert.equal(response.statusCode, 200);
  assert.equal(stateReads, 1);
  assert.equal(triageReads, 1);
  assert.equal(assemblies, 1);
  assert.equal(response.body.replies[0].triage_status, "complete");
  assert.deepEqual(response.body.counts, {
    total: 1,
    interested: 0,
    needs_review: 0,
    not_interested: 0,
    archived: 0,
    complete: 1,
  });
  assert.deepEqual(response.body.cache, {
    status: "materialized",
    version: 3,
  });
});

test("failed sequence updates retain last-known-good replies and stable counts", () => {
  const previous = emptyInboxSnapshotState();
  previous.catalog = {
    version: 3,
    refreshed_at: "2026-07-17T17:00:00.000Z",
    campaigns_total: 2,
    targets: [
      { id: "sequence-a", name: "Sequence A", email_replies: 1 },
      { id: "sequence-b", name: "Sequence B", email_replies: 1 },
    ],
  };
  previous.snapshots = new Map([
    ["sequence-a", {
      version: 3,
      sequence_id: "sequence-a",
      sequence_name: "Sequence A",
      email_replies: 1,
      refreshed_at: "2026-07-17T17:00:00.000Z",
      replies: [{
        gmail_id: "gmail-old-a",
        sequence_id: "sequence-a",
        ccu_id: "lead-a",
        subject: "Old A",
        reply_category: "INTERESTED",
      }],
      lead_categories: {},
    }],
    ["sequence-b", {
      version: 3,
      sequence_id: "sequence-b",
      sequence_name: "Sequence B",
      email_replies: 1,
      refreshed_at: "2026-07-17T17:00:00.000Z",
      replies: [{
        gmail_id: "gmail-old-b",
        sequence_id: "sequence-b",
        ccu_id: "lead-b",
        subject: "Old B",
        reply_category: "UNCLEAR",
      }],
      lead_categories: {},
    }],
  ]);
  previous.meta = {
    version: 3,
    last_refresh_at: "2026-07-17T17:00:00.000Z",
    last_complete_at: "2026-07-17T17:00:00.000Z",
    sequence_attempts: {},
    failures: [],
  };

  const before = assembleInboxSnapshotFeed(previous, {
    now: () => new Date("2026-07-17T17:05:00.000Z"),
  });
  const next = mergeInboxRefreshState(previous, {
    generated_at: "2026-07-17T17:06:00.000Z",
    catalog: {
      version: 3,
      refreshed_at: "2026-07-17T17:06:00.000Z",
      campaigns_total: 2,
      targets: [
        { id: "sequence-a", name: "Sequence A", email_replies: 2 },
        { id: "sequence-b", name: "Sequence B", email_replies: 1 },
      ],
    },
    target_sequence_ids: ["sequence-a", "sequence-b"],
    selected_sequence_ids: ["sequence-a", "sequence-b"],
    snapshots: [{
      version: 3,
      sequence_id: "sequence-a",
      sequence_name: "Sequence A",
      email_replies: 2,
      refreshed_at: "2026-07-17T17:06:00.000Z",
      replies: [
        {
          gmail_id: "gmail-old-a",
          sequence_id: "sequence-a",
          ccu_id: "lead-a",
          subject: "Old A",
          reply_category: "INTERESTED",
        },
        {
          gmail_id: "gmail-new-a",
          sequence_id: "sequence-a",
          ccu_id: "lead-new-a",
          subject: "New A",
          reply_category: "NOT_INTERESTED",
        },
      ],
      lead_categories: {},
    }],
    recent: {
      version: 3,
      refreshed_at: "2026-07-17T17:06:00.000Z",
      replies: [],
    },
    scan: {
      campaigns_attempted: 2,
      campaigns_deferred: 0,
      campaigns_succeeded: 1,
      campaigns_failed: 1,
      recent_count: 0,
      recent_failed: false,
      failures: [{
        sequence_id: "sequence-b",
        sequence_name: "Sequence B",
        error: "PARAFORM_TIMEOUT",
      }],
    },
  });
  const after = assembleInboxSnapshotFeed(next, {
    now: () => new Date("2026-07-17T17:06:00.000Z"),
  });

  assert.equal(before.counts.total, 2);
  assert.equal(after.counts.total, 3);
  assert.deepEqual(
    after.replies.map(({ gmail_id }) => gmail_id).sort(),
    ["gmail-new-a", "gmail-old-a", "gmail-old-b"],
  );
  assert.equal(next.snapshots.get("sequence-b").refreshed_at, "2026-07-17T17:00:00.000Z");
  assert.equal(after.freshness.state, "degraded");
  assert.equal(after.freshness.coverage_complete, true);
  assert.equal(after.freshness.latest_failures, 1);
  assert.equal(after.freshness.last_complete_at, "2026-07-17T17:00:00.000Z");
});

test("successful catalog refresh prunes sequences removed at the source", () => {
  const previous = emptyInboxSnapshotState();
  previous.snapshots = new Map([
    ["sequence-a", {
      version: 3,
      sequence_id: "sequence-a",
      sequence_name: "Sequence A",
      email_replies: 1,
      refreshed_at: "2026-07-17T17:00:00.000Z",
      replies: [],
      lead_categories: {},
    }],
    ["sequence-b", {
      version: 3,
      sequence_id: "sequence-b",
      sequence_name: "Sequence B",
      email_replies: 1,
      refreshed_at: "2026-07-17T17:00:00.000Z",
      replies: [],
      lead_categories: {},
    }],
  ]);
  const next = mergeInboxRefreshState(previous, {
    generated_at: "2026-07-17T18:00:00.000Z",
    catalog: {
      version: 3,
      refreshed_at: "2026-07-17T18:00:00.000Z",
      campaigns_total: 1,
      targets: [{ id: "sequence-a", name: "Sequence A", email_replies: 1 }],
    },
    target_sequence_ids: ["sequence-a"],
    selected_sequence_ids: [],
    snapshots: [],
    recent: null,
    scan: {
      campaigns_attempted: 0,
      campaigns_deferred: 0,
      campaigns_succeeded: 0,
      campaigns_failed: 0,
      recent_count: 0,
      recent_failed: true,
      failures: [],
    },
  });
  assert.deepEqual([...next.snapshots.keys()], ["sequence-a"]);
});

test("sync selection prioritizes unseeded and changed sequences without starvation", () => {
  const nowMs = Date.parse("2026-07-17T18:00:00.000Z");
  const previous = emptyInboxSnapshotState();
  previous.snapshots = new Map([
    ["changed", { submissions_projection_version: 1, email_replies: 1, refreshed_at: "2026-07-17T17:59:00.000Z" }],
    ["recent", { submissions_projection_version: 1, email_replies: 1, refreshed_at: "2026-07-17T17:59:00.000Z" }],
    ["stale", { submissions_projection_version: 1, email_replies: 1, refreshed_at: "2026-07-17T16:00:00.000Z" }],
    ["fresh", { submissions_projection_version: 1, email_replies: 1, refreshed_at: "2026-07-17T17:59:00.000Z" }],
    ["legacy-projection", { submissions_projection_version: null, email_replies: 1, refreshed_at: "2026-07-17T17:59:00.000Z" }],
  ]);
  previous.meta = {
    sequence_attempts: {
      "missing-retried": "2026-07-17T17:58:00.000Z",
    },
  };
  const selected = selectInboxCampaigns([
    { id: "missing-retried", email_replies: 1 },
    { id: "missing-new", email_replies: 1 },
    { id: "changed", email_replies: 2 },
    { id: "recent", email_replies: 1 },
    { id: "stale", email_replies: 1 },
    { id: "fresh", email_replies: 1 },
    { id: "legacy-projection", email_replies: 1 },
  ], previous, [{ sequence_id: "recent" }], {
    nowMs,
    batchSize: 4,
    staleMs: 15 * 60 * 1000,
  });
  assert.deepEqual(selected.map(({ id }) => id), [
    "missing-new",
    "missing-retried",
    "legacy-projection",
    "changed",
  ]);
});

test("snapshot persistence writes only successful shards with no expiry", async () => {
  const previous = emptyInboxSnapshotState();
  previous.snapshots = new Map([
    ["sequence-b", {
      version: 3,
      sequence_id: "sequence-b",
      sequence_name: "Sequence B",
      email_replies: 1,
      refreshed_at: "2026-07-17T17:00:00.000Z",
      replies: [],
      lead_categories: {},
    }],
  ]);
  let commands = [];
  await writeInboxRefreshState(previous, {
    generated_at: "2026-07-17T18:00:00.000Z",
    catalog: {
      version: 3,
      refreshed_at: "2026-07-17T18:00:00.000Z",
      campaigns_total: 1,
      targets: [{ id: "sequence-a", name: "Sequence A", email_replies: 1 }],
    },
    target_sequence_ids: ["sequence-a"],
    selected_sequence_ids: ["sequence-a"],
    snapshots: [{
      version: 3,
      sequence_id: "sequence-a",
      sequence_name: "Sequence A",
      email_replies: 1,
      refreshed_at: "2026-07-17T18:00:00.000Z",
      replies: [],
      lead_categories: {},
    }],
    recent: null,
    scan: {
      campaigns_attempted: 1,
      campaigns_deferred: 0,
      campaigns_succeeded: 1,
      campaigns_failed: 0,
      recent_count: 0,
      recent_failed: true,
      failures: [],
    },
  }, {
    configured: true,
    pipelineImpl: async (value) => {
      commands = value;
      return value.map(() => "OK");
    },
  });

  assert.equal(commands[0][0], "HSET");
  assert.equal(commands[0][2], "sequence-a");
  assert.deepEqual(commands.find(([command]) => command === "HDEL").slice(2), ["sequence-b"]);
  assert.equal(commands.flat().includes("EX"), false);
});

test("sync endpoint coalesces overlapping refreshes", async () => {
  let builds = 0;
  const handler = createInboxSyncHandler({
    corsHandler: () => false,
    authHandler: async () => true,
    acquireLock: async () => ({ status: "busy", token: null }),
    buildRefresh: async () => {
      builds += 1;
    },
  });
  const response = mockResponse();
  await handler({
    method: "POST",
    headers: { "content-type": "application/json" },
    body: {},
  }, response);
  assert.equal(response.statusCode, 202);
  assert.equal(response.headers["Retry-After"], "15");
  assert.equal(response.body.status, "in_progress");
  assert.equal(builds, 0);
});

test("sync endpoint writes one refresh and always releases its lock", async () => {
  const previous = emptyInboxSnapshotState();
  let writtenRefresh = null;
  let released = "";
  const refresh = { generated_at: "2026-07-17T18:00:00.000Z" };
  const handler = createInboxSyncHandler({
    corsHandler: () => false,
    authHandler: async () => true,
    acquireLock: async () => ({ status: "acquired", token: "sync-token" }),
    readState: async () => ({ status: "ready", value: previous }),
    buildRefresh: async ({ previousState }) => {
      assert.equal(previousState, previous);
      return refresh;
    },
    writeState: async (state, value) => {
      assert.equal(state, previous);
      writtenRefresh = value;
      return { materialized: true };
    },
    assembleFeed: (state) => {
      assert.deepEqual(state, { materialized: true });
      return { freshness: { state: "ready" } };
    },
    releaseLock: async (token) => {
      released = token;
      return true;
    },
  });
  const response = mockResponse();
  await handler({
    method: "POST",
    headers: { "content-type": "application/json" },
    body: {},
  }, response);
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.status, "updated");
  assert.deepEqual(response.body.freshness, { state: "ready" });
  assert.equal(writtenRefresh, refresh);
  assert.equal(released, "sync-token");
});

test("transient Paraform failures retry before succeeding", async () => {
  let calls = 0;
  const result = await inboxTrpcGet(
    "campaigns.example",
    {},
    2,
    1_000,
    async () => {
      calls += 1;
      if (calls === 1) {
        return {
          status: 503,
          ok: false,
          json: async () => ({ error: { json: { message: "try again" } } }),
        };
      }
      return {
        status: 200,
        ok: true,
        json: async () => ({ result: { data: { json: { ok: true } } } }),
      };
    },
    async () => {},
    () => 0,
  );
  assert.equal(calls, 2);
  assert.deepEqual(result, { ok: true });
});

test("Paraform 401 burst responses are retried as throttles, not false expiry", async () => {
  let calls = 0;
  const result = await inboxTrpcGet(
    "campaigns.example",
    {},
    2,
    1_000,
    async () => {
      calls += 1;
      return calls === 1
        ? { status: 401, ok: false, json: async () => ({}) }
        : {
            status: 200,
            ok: true,
            json: async () => ({ result: { data: { json: ["complete"] } } }),
          };
    },
    async () => {},
    () => 0,
  );
  assert.equal(calls, 2);
  assert.deepEqual(result, ["complete"]);
});

test("campaign selection retains disabled reply history when aggregate counts exist", () => {
  const selected = campaignsToScan([
    { id: "disabled-history", project_id: "project-1", status: "DISABLED", email_replies: 4 },
    { id: "active-empty", project_id: "project-2", status: "ACTIVE", email_replies: 0 },
    { id: "disabled-empty", project_id: "project-3", status: "DISABLED", email_replies: "0" },
    { id: "", project_id: "project-4", email_replies: 8 },
  ]);
  assert.deepEqual(selected.map(({ id }) => id), ["disabled-history"]);

  const withMixedCounts = campaignsToScan([
    { id: "active-counted", role_id: "role-1", status: "ACTIVE", email_replies: 0 },
    { id: "disabled-unknown", role_id: "role-2", status: "DISABLED" },
  ]);
  assert.deepEqual(
    withMixedCounts.map(({ id }) => id),
    ["active-counted", "disabled-unknown"],
  );
});

test("Inbox campaign eligibility uses links, never a catalog owner email as sender evidence", () => {
  assert.equal(isInboxRoleOutreachCampaign({
    id: "project-outreach",
    project_id: "project-1",
    campaign_to_accounts: [{ account: { email: "david@heyraydar.com" } }],
  }), true);
  assert.equal(isInboxRoleOutreachCampaign({
    id: "role-outreach",
    role_id: "role-1",
  }), true);
  assert.equal(isInboxRoleOutreachCampaign({
    id: "admin-follow-up",
    name: "(Raydar Agent) No Matches - Added to Para AI",
    campaign_to_accounts: [{ account: { email: "david@raydar.xyz" } }],
  }), false);
  assert.equal(isInboxRoleOutreachCampaign({
    id: "linked-primary-mailbox",
    project_id: "project-2",
    campaign_to_accounts: [{ account: { email: "DAVID@RAYDAR.XYZ" } }],
  }), true);
  assert.equal(isInboxRoleOutreachCampaign({
    id: "unlinked-generic-sequence",
    campaign_to_accounts: [{ account: { email: "david@heyraydar.com" } }],
  }), false);
});

test("Inbox admits pinned curated sequences and reply-bearing unmapped sequences", () => {
  const curatedId = OUTCOME_SEQUENCE_RULES[0].id;
  assert.equal(isInboxCuratedListCampaign({ id: curatedId }), true);
  assert.equal(isInboxCuratedListCampaign({ id: "unlinked-generic-sequence" }), false);
  assert.deepEqual(
    campaignsToScan([
      { id: curatedId, name: "Curated list", email_replies: 3 },
      { id: "unlinked-generic-sequence", email_replies: 4 },
    ]).map(({ id }) => id),
    [curatedId, "unlinked-generic-sequence"],
  );
});

test("recent evidence refreshes an unmapped sequence without changing legacy Inbox rows", async () => {
  const feed = await buildInboxFeed({
    get: async (procedure) => {
      if (procedure === "campaigns.getListOfCampaignsOptimized") {
        return [{
          id: "sequence-unmapped",
          name: "Candidate outreach",
          email_replies: 0,
        }];
      }
      if (procedure === "campaigns.getRecentReplies") {
        return [{
          id: "lead-1",
          sequence_id: "sequence-unmapped",
          candidate_email: "candidate@example.com",
          email_date: "2026-09-03T12:00:00.000Z",
          gmail_id: "gmail-unmapped",
        }];
      }
      assert.equal(procedure, "campaigns.getCampaignInboxData");
      return { campaign_emails: [], campaign_to_candidate_users: [] };
    },
    now: () => new Date("2026-09-03T12:01:00.000Z"),
  });
  // The extra target seeds the Submissions-only projection. It is not a
  // legacy Inbox row because the campaign itself was never UI-admitted.
  assert.equal(feed.replies.length, 0);
});

test("Inbox refresh fans out the pinned unlinked curated-list sequence", async () => {
  const curatedId = OUTCOME_SEQUENCE_RULES[0].id;
  const inboxCalls = [];
  const feed = await buildInboxFeed({
    get: async (procedure, input) => {
      if (procedure === "campaigns.getListOfCampaignsOptimized") {
        return [{ id: curatedId, name: "Curated list", email_replies: 1 }];
      }
      if (procedure === "campaigns.getRecentReplies") return [];
      assert.equal(procedure, "campaigns.getCampaignInboxData");
      inboxCalls.push(input.campaign_id);
      return {
        campaign_to_candidate_users: [{
          id: "lead-curated",
          reply_category: "interested",
          candidate_email: "candidate@example.com",
          candidate_user: { candidate: { name: "Curated Candidate" } },
        }],
        campaign_emails: [{
          campaign_to_candidate_user_id: "lead-curated",
          email: {
            gmail_id: "gmail-curated",
            sent_from_paraform: false,
            email_date: "2026-08-27T12:00:00.000Z",
          },
        }],
      };
    },
    now: () => new Date("2026-08-27T12:01:00.000Z"),
  });
  assert.deepEqual(inboxCalls, [curatedId]);
  assert.equal(feed.replies[0].sequence_id, curatedId);
  assert.equal(feed.replies[0].reply_category, "INTERESTED");
});

test("company sequence inbox reads include the live audience discriminator", () => {
  assert.deepEqual(
    campaignInboxInput({ id: "company-sequence", kind: " company " }),
    { campaign_id: "company-sequence", audience: "company" },
  );
  assert.deepEqual(
    campaignInboxInput({ id: "candidate-sequence", kind: "CANDIDATE" }),
    { campaign_id: "candidate-sequence" },
  );
});

test("fanout rows win duplicate Gmail IDs and merged replies sort newest first", () => {
  const rows = [
    {
      gmail_id: "gmail-duplicate",
      sequence_id: "sequence-1",
      ccu_id: "lead-1",
      candidate_name: "Fanout candidate",
      subject: "Fanout copy",
      date: "2026-07-15T12:00:00.000Z",
    },
    {
      gmail_id: "",
      sequence_id: "sequence-1",
      ccu_id: "lead-2",
      candidate_name: "Composite key candidate",
      subject: "No Gmail ID",
      date: "2026-07-14T12:00:00.000Z",
    },
  ];
  const recent = [
    {
      id: "lead-1",
      gmail_id: "gmail-duplicate",
      sequence_id: "sequence-1",
      candidate_name: "Recent duplicate",
      email_subject: "Recent copy",
      email_date: "2026-07-17T12:00:00.000Z",
    },
    {
      id: "lead-3",
      gmail_id: "gmail-new",
      sequence_id: "sequence-1",
      candidate_name: "Recent candidate",
      email_subject: "Newest unique reply",
      email_date: "2026-07-16T12:00:00.000Z",
    },
    {
      id: "lead-2",
      gmail_id: "",
      sequence_id: "sequence-1",
      candidate_name: "Composite duplicate",
      email_subject: "No Gmail ID",
      email_date: "2026-07-14T12:00:00.000Z",
    },
  ];
  const merged = mergeAndSortReplies(
    rows,
    recent,
    [{ id: "sequence-1", name: "Sequence one", can_reply: true }],
    new Map([[
      "sequence-1:lead-3",
      { reply_category: "unclear", is_archived: true },
    ]]),
  );

  assert.equal(merged.length, 3);
  assert.deepEqual(
    merged.map(({ gmail_id, candidate_name }) => [gmail_id, candidate_name]),
    [
      ["gmail-new", "Recent candidate"],
      ["gmail-duplicate", "Fanout candidate"],
      ["", "Composite key candidate"],
    ],
  );
  assert.equal(merged[0].sequence_name, "Sequence one");
  assert.equal(merged[0].reply_category, "UNCLEAR");
  assert.equal(merged[0].is_archived, true);
  assert.equal(merged[0].can_reply, true);
});

test("feed building bounds fanout and returns partial metadata with recent fallback", async () => {
  const campaigns = [
    {
      id: "sequence-live",
      project_id: "project-live",
      name: "Live sequence",
      email_replies: 1,
      can_reply: true,
    },
    {
      id: "sequence-failed",
      project_id: "project-failed",
      name: "Failed disabled sequence",
      status: "DISABLED",
      email_replies: 2,
    },
    {
      id: "sequence-recent",
      project_id: "project-recent",
      name: "Company sequence",
      kind: "COMPANY",
      email_replies: 1,
      can_reply: true,
    },
    { id: "sequence-empty", project_id: "project-empty", name: "Empty sequence", email_replies: 0 },
    {
      id: "sequence-admin",
      name: "Administrative follow-up",
      email_replies: 1,
      campaign_to_accounts: [{ account: { email: "david@raydar.xyz" } }],
    },
  ];
  const recentReplies = [
    {
      id: "lead-recent",
      sequence_id: "sequence-recent",
      candidate_name: "Grace Hopper",
      candidate_email: "grace@example.com",
      email_subject: "Re: Company search",
      email_snippet: "Happy to discuss.",
      email_date: "2026-07-16T20:00:00.000Z",
      gmail_id: "gmail-recent",
      attachment_count: 2,
    },
    {
      id: "lead-admin",
      sequence_id: "sequence-admin",
      candidate_name: "Administrative contact",
      candidate_email: "admin-contact@example.com",
      email_subject: "Re: Internal follow-up",
      email_date: "2026-07-16T20:30:00.000Z",
      gmail_id: "gmail-admin",
    },
  ];
  const inboxCalls = [];
  let active = 0;
  let maxActive = 0;

  const get = async (procedure, input) => {
    if (procedure === "campaigns.getListOfCampaignsOptimized") return campaigns;
    if (procedure === "campaigns.getRecentReplies") return recentReplies;
    assert.equal(procedure, "campaigns.getCampaignInboxData");
    inboxCalls.push(input);
    active += 1;
    maxActive = Math.max(maxActive, active);
    try {
      await new Promise((resolve) => setTimeout(resolve, 5));
      if (input.campaign_id === "sequence-failed") {
        const error = new Error("upstream unavailable");
        error.code = "PARAFORM_DOWN";
        throw error;
      }
      if (input.campaign_id === "sequence-recent") {
        return {
          campaign_emails: [],
          campaign_to_candidate_users: [{
            id: "lead-recent",
            reply_category: "unclear",
            is_archived: true,
          }],
        };
      }
      return {
        campaign_to_candidate_users: [{
          id: "lead-live",
          reply_category: "interested",
          candidate_email: "live@example.com",
          candidate_user: { candidate: { name: "Live Candidate" } },
        }],
        campaign_emails: [{
          campaign_to_candidate_user_id: "lead-live",
          email: {
            gmail_id: "gmail-live",
            sent_from_paraform: false,
            subject: "Live reply",
            email_date: "2026-07-15T20:00:00.000Z",
          },
        }],
      };
    } finally {
      active -= 1;
    }
  };

  const feed = await buildInboxFeed({
    get,
    concurrency: 2,
    now: () => new Date("2026-07-16T21:00:00.000Z"),
  });

  assert.equal(maxActive, 2);
  // Reply-bearing unlinked sequences are refreshed for the Submissions-only
  // projection, while their rows remain outside the legacy Inbox surface.
  assert.equal(inboxCalls.length, 4);
  assert.deepEqual(
    inboxCalls.find(({ campaign_id }) => campaign_id === "sequence-recent"),
    { campaign_id: "sequence-recent", audience: "company" },
  );
  assert.equal(feed.generated_at, "2026-07-16T21:00:00.000Z");
  assert.equal(feed.partial, true);
  assert.equal(feed.cacheable, false);
  assert.deepEqual(
    feed.replies.map(({ gmail_id, reply_category }) => [gmail_id, reply_category]),
    [
      ["gmail-recent", "UNCLEAR"],
      ["gmail-live", "INTERESTED"],
    ],
  );
  assert.equal(feed.replies[0].is_archived, true);
  assert.equal(feed.replies[0].attachment_count, 2);
  assert.equal(feed.replies[0].can_reply, true);
  assert.deepEqual(feed.counts, {
    total: 2,
    interested: 1,
    needs_review: 0,
    not_interested: 0,
    archived: 1,
    complete: 0,
  });
  assert.deepEqual(feed.scan, {
    campaigns_total: 5,
    campaigns_excluded: 2,
    campaigns_attempted: 3,
    campaigns_succeeded: 2,
    campaigns_failed: 1,
    recent_count: 1,
    recent_excluded: 1,
    recent_failed: false,
    failures: [{
      sequence_id: "sequence-failed",
      sequence_name: "Failed disabled sequence",
      error: "PARAFORM_DOWN",
    }],
  });
});

test("standalone page, dashboard tab, and Vercel routing are wired together", async () => {
  const [inboxHtml, indexHtml, vercelRaw] = await Promise.all([
    readFile(new URL("../inbox.html", import.meta.url), "utf8"),
    readFile(new URL("../index.html", import.meta.url), "utf8"),
    readFile(new URL("../vercel.json", import.meta.url), "utf8"),
  ]);
  const vercel = JSON.parse(vercelRaw);

  assert.match(inboxHtml, /<script src="\/auth-session\.js"><\/script>/);
  assert.match(inboxHtml, /RaydarAuth\.session\(\)/);
  assert.match(inboxHtml, /RaydarAuth\.signIn\(/);
  assert.match(inboxHtml, /fetch\("\/api\/inbox\/feed"/);
  assert.match(inboxHtml, /fetch\("\/api\/inbox\/sync"/);
  assert.match(inboxHtml, /fetch\("\/api\/inbox\/message\?gmail_id="/);
  assert.match(inboxHtml, /fetch\("\/api\/inbox\/triage"/);
  assert.match(inboxHtml, /data-filter="archived"/);
  assert.match(inboxHtml, /data-filter="complete"/);
  assert.match(inboxHtml, /class="mailbox-nav" aria-label="Inbox views"/);
  assert.match(inboxHtml, /\.reply-open\{[^}]*display:grid/);
  assert.match(inboxHtml, /body\.reading \.detail\{display:block\}/);
  assert.match(inboxHtml, /className="back-control"/);
  assert.match(inboxHtml, /className="message-copy"/);
  // The Classic view is deprecated: no toggle, no style=classic branch, no dual-view CSS scope.
  assert.doesNotMatch(inboxHtml, /GMAIL_VIEW|style=classic|Classic view|Gmail view|viewToggle|body\.gmail|class="filters"/);
  assert.match(inboxHtml, /triageControl\(reply,"Archive","archived"/);
  assert.match(inboxHtml, /triageControl\(reply,"Complete","complete"/);
  assert.match(inboxHtml, /triageControl\(reply,"Restore","inbox"/);
  assert.match(inboxHtml, /STATE\.triageRevision\+=1/);
  assert.match(
    inboxHtml,
    /triageRevisionAtStart!==STATE\.triageRevision[\s\S]*?queueFeedRefresh\(\)/,
  );
  assert.match(inboxHtml, /role="group" aria-label="Reply filters"/);
  assert.match(inboxHtml, /data-filter="complete" aria-pressed="false"/);
  assert.match(inboxHtml, /item\.setAttribute\("aria-pressed"/);
  assert.match(inboxHtml, /item\.dataset\.filter===STATE\.filter/);
  assert.match(inboxHtml, /Archived in Paraform/);
  assert.match(inboxHtml, /\.chip\.archived\{[^}]*color:#8A4F0E/);
  assert.match(
    inboxHtml,
    /const focusToken=captureInboxFocus\(\);[\s\S]*?requestAnimationFrame\(\(\)=>restoreInboxFocus\(focusToken\)\)/,
  );
  assert.match(
    inboxHtml,
    /document\.activeElement===sourceButton[\s\S]*?selectAfterTriage\(previousIndex,shouldFocusNext\)/,
  );
  assert.match(inboxHtml, /showTriageBanner\("good","Moved to Complete\."\)/);
  assert.match(inboxHtml, /State unavailable/);
  assert.match(inboxHtml, /last-known-good replies/);
  assert.match(inboxHtml, /STATE\.seedPasses<6/);
  assert.doesNotMatch(inboxHtml, /Partial feed|refresh is already in progress/);
  assert.doesNotMatch(
    inboxHtml,
    /id="replyList"[^>]*aria-live/,
  );
  const inlineScript = [...inboxHtml.matchAll(/<script>([\s\S]*?)<\/script>/g)]
    .at(-1)?.[1];
  assert.ok(inlineScript);
  assert.doesNotThrow(() => new Function(inlineScript));

  assert.match(indexHtml, /id="tab-inbox"/);
  assert.match(indexHtml, /id="view-inbox"[^>]*hidden/);
  assert.match(indexHtml, /<iframe id="inbox-frame"/);
  assert.match(
    indexHtml,
    /name==="inbox" && !inboxLoaded[\s\S]*?frameSrc\("\/inbox","inbox"\)[\s\S]*?inboxLoaded=true/,
  );
  // frameSrc keeps embed=1 and adds the tab (so the frame's rows can link back
  // to this shell) plus the screen the URL names (so an Inbox message opened in
  // a new tab is rebuilt on arrival).
  assert.match(indexHtml, /function frameSrc\(path,tab\)\{[\s\S]*?\?embed=1&tab=\$\{tab\}[\s\S]*?screen=/);

  assert.deepEqual(
    vercel.rewrites.find(({ source }) => source === "/inbox"),
    { source: "/inbox", destination: "/inbox.html" },
  );
  // The retired Classic alias must redirect to the single Inbox, never serve a second view.
  assert.equal(vercel.rewrites.find(({ source }) => source === "/inbox-classic"), undefined);
  assert.deepEqual(
    vercel.redirects.find(({ source }) => source === "/inbox-classic"),
    { source: "/inbox-classic", destination: "/inbox", permanent: false },
  );
  assert.deepEqual(
    vercel.functions["api/inbox/*.mjs"],
    { maxDuration: 120 },
  );
});
