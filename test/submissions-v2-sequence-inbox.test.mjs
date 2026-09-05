import test from "node:test";
import assert from "node:assert/strict";

import {
  adaptSequenceInboxReply,
  readCompleteSequenceInboxMessage,
  readCachedSequenceReplyBatch,
  sequenceAuthoredReply,
  SEQUENCE_REPLY_FAMILY,
} from "../api/submissions-v2/_lib/sequence-inbox-source.mjs";
import {
  SEQUENCE_INBOX_ACTIVATION_AT,
  SEQUENCE_INBOX_BATCH_LIMIT,
  SEQUENCE_INBOX_BROKER_DEADLINE_MS,
  SEQUENCE_INBOX_POINT_READ_PACE_MS,
  SEQUENCE_INBOX_POINT_READ_TIMEOUT_MS,
  SEQUENCE_INBOX_REFRESH_BUDGET_MS,
  readSequenceInboxBrokerBatch,
  sequenceInboxActivation,
  validateSequenceInboxBatchRequest,
} from "../api/submissions-v2/_lib/sequence-inbox-broker.mjs";
import { publicMessage } from "../api/inbox/_lib/core.mjs";
import { reconcileSequenceInbox } from "../submissions-v2-worker/sequence-inbox-reader.mjs";

const activationAt = "2026-09-02T02:45:14.308Z";
const env = {
  SUBMISSIONS_V2_EMAIL_HMAC_KEY: "s".repeat(40),
  SUBMISSIONS_V2_EMAIL_HMAC_VERSION: "v1",
};

function reply(overrides = {}) {
  return {
    candidate_user_id: "candidate-user-1",
    candidate_email: "candidate@example.com",
    sequence_id: "sequence-1",
    sequence_name: "Platform outreach",
    gmail_id: "provider-message-1",
    thread_id: "provider-thread-1",
    ccu_id: "campaign-member-1",
    date: "2026-09-03T12:00:00.000Z",
    snippet: "A preview must never be classified.",
    reply_category: "INTERESTED",
    ...overrides,
  };
}

function detail(overrides = {}) {
  return {
    complete: true,
    message: {
      body: "Yes, I would be glad to talk.\n\nOn Tue, Sep 2, 2026, Noah wrote:\n> Outbound copy",
      from: "Candidate <candidate@example.com>",
      from_name: "Candidate",
      to: ["Noah <noah@heyraydar.com>"],
      subject: "Re: Platform outreach",
      date: "2026-09-03T12:00:00.000Z",
      sent_from_paraform: false,
      ...overrides,
    },
  };
}

function state(replies, campaigns = [{
  id: "sequence-1",
  name: "Platform outreach",
  exact_role_id: "role-1",
  exact_role_source: "campaign.role_id",
}]) {
  const snapshots = new Map();
  for (const campaign of campaigns) {
    snapshots.set(campaign.id, {
      version: 3,
      submissions_projection_version: 1,
      sequence_id: campaign.id,
      sequence_name: campaign.name,
      exact_role_id: campaign.exact_role_id || null,
      exact_role_source: campaign.exact_role_source || null,
      refreshed_at: "2026-09-03T12:01:00.000Z",
      replies: replies.filter((item) => item.sequence_id === campaign.id),
      submissions_replies: replies.filter((item) => item.sequence_id === campaign.id),
      lead_categories: {},
    });
  }
  return {
    catalog: {
      version: 3,
      submissions_projection_version: 1,
      refreshed_at: "2026-09-03T12:01:00.000Z",
      campaigns_total: campaigns.length,
      targets: campaigns,
    },
    snapshots,
    recent: { version: 3, refreshed_at: "2026-09-03T12:01:00.000Z", replies: [] },
    meta: {
      version: 3,
      last_refresh_at: "2026-09-03T12:01:00.000Z",
      last_complete_at: "2026-09-03T12:01:00.000Z",
      campaigns_failed: 0,
      recent_failed: false,
    },
  };
}

test("sequence reply extraction removes quoted history from complete bodies", () => {
  assert.equal(sequenceAuthoredReply(detail().message.body), "Yes, I would be glad to talk.");
  assert.equal(sequenceAuthoredReply("<p>Interested.</p><blockquote>Old copy</blockquote>"), "Interested.");
});

test("literal campaign.role_id creates an exact role event with Gmail-compatible identity", () => {
  const record = adaptSequenceInboxReply({
    reply: reply({ role_id: "unsafe-row-role" }),
    campaign: {
      id: "sequence-1",
      project_id: "project-is-not-a-role",
      exact_role_id: "role-1",
      exact_role_source: "campaign.role_id",
    },
    detail: detail(), activationAt, env,
  });
  assert.equal(record.status, "ready");
  assert.equal(record.route, "classify");
  assert.deepEqual(record.event.offered_roles.map((role) => role.role_id), ["role-1"]);
  assert.equal(record.event.provider, "gmail");
  assert.equal(record.event.provider_message_id, "provider-message-1");
  assert.equal(record.event.idempotency_key, "gmail:noah-heyraydar-com:provider-message-1");
  assert.equal(record.event.candidate_authored_text, "Yes, I would be glad to talk.");
  assert.equal(record.event.candidate_authored_text.includes("preview"), false);
  assert.equal(record.source_evidence.exact_role_source, "campaign.role_id");
});

test("project-linked and row role values do not bind an unmapped reply", () => {
  const record = adaptSequenceInboxReply({
    reply: reply({ role_id: "unsafe-row-role" }),
    campaign: { id: "sequence-1", project_id: "project-is-not-a-role" },
    detail: detail(), activationAt, env,
  });
  assert.equal(record.status, "ready");
  assert.equal(record.route, "needs_review");
  assert.deepEqual(record.review_reasons, ["role_unclear"]);
  assert.deepEqual(record.event.offered_roles, []);
  assert.equal(record.event.source_family, SEQUENCE_REPLY_FAMILY);
});

test("an exact outbound recipient mapping can bind multiple roles and an approved family", () => {
  const record = adaptSequenceInboxReply({
    reply: reply(), campaign: { id: "sequence-1" }, detail: detail(), activationAt, env,
    outboundMappings: [{
      sequence_id: "sequence-1",
      campaign_to_candidate_user_id: "campaign-member-1",
      outbound_message_id: "outbound-provider-message-1",
      evidence_locator: "mailroom:outbound-contract-1",
      family: "fit_follow_up_with_matches",
      role_ids: ["role-2", "role-1"],
      sent_message_text: "Here are the two exact roles sent to the candidate.",
    }],
  });
  assert.equal(record.route, "classify");
  assert.equal(record.event.source_family, "fit_follow_up_with_matches");
  assert.deepEqual(record.event.offered_roles.map((role) => role.role_id), ["role-1", "role-2"]);
  assert.equal(record.event.outbound_message_id, "outbound-provider-message-1");
  assert.equal(record.source_evidence.role_evidence_locator, "mailroom:outbound-contract-1");
});

test("full detail, activation, direction, sender, and identity conflicts fail closed", () => {
  const base = { reply: reply(), campaign: { id: "sequence-1" }, activationAt, env };
  assert.equal(adaptSequenceInboxReply({ ...base, detail: { message: detail().message } }).reason, "full_message_unavailable");
  assert.equal(adaptSequenceInboxReply({ ...base, detail: detail({ date: "2026-09-02T02:45:14.307Z" }) }).reason, "before_activation");
  assert.equal(adaptSequenceInboxReply({ ...base, detail: detail({ sent_from_paraform: true }) }).reason, "outbound_message");
  assert.equal(adaptSequenceInboxReply({ ...base, detail: detail({ sent_from_paraform: undefined }) }).reason, "provider_direction_unavailable");
  assert.equal(adaptSequenceInboxReply({ ...base, detail: detail({ to: ["David <david@raydar.xyz>"], subject: "Re: New Match" }) }).reason, "gmail_owned_mailbox");
  assert.equal(adaptSequenceInboxReply({ ...base, detail: detail({ to: ["David <david@raydar.xyz>"], subject: "Re: Platform outreach" }) }).status, "ready");
  assert.equal(adaptSequenceInboxReply({ ...base, detail: detail({ to: ["Noah <noah@raydarlab.com>"] }) }).status, "ready");
  assert.equal(adaptSequenceInboxReply({ ...base, detail: detail({ to: ["noah@raydarlab.com", "other@burner.example"] }) }).reason, "mailbox_identity_invalid");
  assert.equal(adaptSequenceInboxReply({ ...base, detail: detail({ to: ["candidate@example.com"] }) }).reason, "mailbox_identity_invalid");
  assert.equal(adaptSequenceInboxReply({ ...base, detail: detail({ subject: "Delivery Status Notification (Failure)" }) }).reason, "machine_or_excluded_message");

  const conflict = adaptSequenceInboxReply({
    ...base,
    reply: reply({ candidate_email: "different@example.com" }),
    campaign: {
      id: "sequence-1", exact_role_id: "role-1", exact_role_source: "campaign.role_id",
    },
    detail: detail(),
  });
  assert.equal(conflict.route, "needs_review");
  assert.deepEqual(conflict.review_reasons, ["candidate_ambiguous"]);
});

test("approved activation is exact and missing provider direction stays unknown", () => {
  assert.equal(SEQUENCE_INBOX_ACTIVATION_AT, activationAt);
  assert.equal(sequenceInboxActivation({ env: { SUBMISSIONS_V2_GMAIL_ACTIVATED_AT: activationAt }, now: Date.parse("2026-09-04T00:00:00.000Z") }), activationAt);
  assert.throws(
    () => sequenceInboxActivation({ env: { SUBMISSIONS_V2_GMAIL_ACTIVATED_AT: "2026-09-02T22:00:00.000Z" }, now: Date.parse("2026-09-04T00:00:00.000Z") }),
    (error) => error.code === "sequence_inbox_activation_invalid",
  );
  assert.equal(publicMessage({ email_info: {} }).sent_from_paraform, null);
});

test("broker holds the shared lock for at most its conservative refresh and point-read budget", async () => {
  assert.equal(SEQUENCE_INBOX_BATCH_LIMIT, 8);
  assert.equal(SEQUENCE_INBOX_REFRESH_BUDGET_MS + (SEQUENCE_INBOX_BATCH_LIMIT * SEQUENCE_INBOX_POINT_READ_TIMEOUT_MS) + ((SEQUENCE_INBOX_BATCH_LIMIT - 1) * SEQUENCE_INBOX_POINT_READ_PACE_MS), 82_000);
  assert.equal(SEQUENCE_INBOX_BROKER_DEADLINE_MS, 100_000);
  let clock = 0;
  let released = false;
  const timeouts = [];
  const state = {};
  const result = await readSequenceInboxBrokerBatch({}, {
    env: { SUBMISSIONS_V2_GMAIL_ACTIVATED_AT: activationAt },
    now: () => new Date("2026-09-04T00:00:00.000Z"),
    clock: () => clock,
    acquireLock: async () => ({ status: "acquired", token: "lock" }),
    releaseLock: async () => { released = true; },
    readState: async () => ({ status: "ready", value: state }),
    buildRefresh: async ({ budgetMs }) => {
      assert.equal(budgetMs, SEQUENCE_INBOX_REFRESH_BUDGET_MS);
      clock += budgetMs;
      return {};
    },
    writeState: async () => state,
    sleepImpl: async (milliseconds) => { clock += milliseconds; },
    readBatch: async ({ limit, readMessage }) => {
      assert.equal(limit, SEQUENCE_INBOX_BATCH_LIMIT);
      for (let index = 0; index < SEQUENCE_INBOX_BATCH_LIMIT; index += 1) {
        await readMessage(`message-${index}`);
      }
      return { records: [], deferred: [], checkpoint_cursor: null, coverage: {} };
    },
    readMessage: async (_gmailId, { timeoutMs }) => {
      timeouts.push(timeoutMs);
      clock += timeoutMs;
      return { complete: true, message: {} };
    },
  });
  assert.equal(released, true);
  assert.deepEqual(timeouts, Array(SEQUENCE_INBOX_BATCH_LIMIT).fill(SEQUENCE_INBOX_POINT_READ_TIMEOUT_MS));
  assert.equal(clock, 82_000);
  assert.deepEqual(result.records, []);
});

test("broker deadline releases the lock and leaves the page resumable", async () => {
  let clock = 0;
  let released = false;
  await assert.rejects(
    readSequenceInboxBrokerBatch({}, {
      env: { SUBMISSIONS_V2_GMAIL_ACTIVATED_AT: activationAt },
      now: () => new Date("2026-09-04T00:00:00.000Z"),
      clock: () => clock,
      acquireLock: async () => ({ status: "acquired", token: "lock" }),
      releaseLock: async () => { released = true; },
      readState: async () => ({ status: "ready", value: {} }),
      buildRefresh: async () => { clock = SEQUENCE_INBOX_BROKER_DEADLINE_MS - SEQUENCE_INBOX_POINT_READ_TIMEOUT_MS; return {}; },
      writeState: async () => ({}),
      readBatch: async ({ readMessage }) => readMessage("message-1"),
      readMessage: async () => assert.fail("deadline must prevent point read"),
    }),
    (error) => error.code === "sequence_inbox_broker_deadline",
  );
  assert.equal(released, true);
});

test("legacy broker request limits through twelve execute at the eight-record cap", () => {
  for (const limit of [9, 10, 11, 12]) {
    assert.equal(validateSequenceInboxBatchRequest({ limit }).limit, SEQUENCE_INBOX_BATCH_LIMIT);
  }
  assert.equal(validateSequenceInboxBatchRequest({ limit: 8 }).limit, 8);
  assert.throws(
    () => validateSequenceInboxBatchRequest({ limit: 13 }),
    (error) => error.code === "sequence_inbox_batch_limit_invalid",
  );
});

test("cached reader is bounded, stable, full-detail only, and exposes checkpoint safety", async () => {
  const cachedReplies = [
    reply({ gmail_id: "message-1", date: "2026-09-03T12:00:00.000Z" }),
    reply({ gmail_id: "message-2", date: "2026-09-03T12:01:00.000Z" }),
  ];
  const reads = [];
  const options = {
    readState: async () => ({ status: "ready", value: state(cachedReplies) }),
    readMessage: async (gmailId) => {
      reads.push(gmailId);
      return detail({ date: gmailId === "message-1" ? cachedReplies[0].date : cachedReplies[1].date });
    },
    activationAt, env, limit: 1,
    now: () => new Date("2026-09-03T12:02:00.000Z"),
  };
  const first = await readCachedSequenceReplyBatch(options);
  assert.deepEqual(reads, ["message-1"]);
  assert.equal(first.records.length, 1);
  assert.equal(first.coverage.has_more, true);
  assert.equal(first.coverage.checkpoint_safe, true);
  assert.equal(first.coverage.full_success, false);
  assert.ok(first.checkpoint_cursor);
  assert.ok(first.next_cursor);

  const second = await readCachedSequenceReplyBatch({ ...options, cursor: first.next_cursor });
  assert.deepEqual(reads, ["message-1", "message-2"]);
  assert.equal(second.records[0].event.provider_message_id, "message-2");
  assert.equal(second.next_cursor, null);
  assert.equal(second.coverage.checkpoint_safe, true);
  assert.equal(second.coverage.full_success, true);
});

test("cached reader reports incomplete evidence and never substitutes a snippet", async () => {
  const result = await readCachedSequenceReplyBatch({
    readState: async () => ({ status: "ready", value: state([reply()]) }),
    readMessage: async () => ({ complete: false, message: { body: "" } }),
    activationAt, env,
    now: () => new Date("2026-09-03T12:02:00.000Z"),
  });
  assert.equal(result.records.length, 0);
  assert.equal(result.deferred[0].reason, "full_message_unavailable");
  assert.equal(result.coverage.checkpoint_safe, false);
});

test("deterministic skips do not hold a verified Sequence cursor", async () => {
  const result = await readCachedSequenceReplyBatch({
    readState: async () => ({ status: "ready", value: state([
      reply({ gmail_id: "skipped", date: "2026-09-03T12:00:00.000Z" }),
      reply({ gmail_id: "accepted", date: "2026-09-03T12:01:00.000Z" }),
    ]) }),
    readMessage: async (gmailId) => detail({
      date: gmailId === "skipped" ? "2026-09-03T12:00:00.000Z" : "2026-09-03T12:01:00.000Z",
      sent_from_paraform: gmailId === "skipped" ? true : false,
    }),
    activationAt, env, limit: 2,
    now: () => new Date("2026-09-03T12:02:00.000Z"),
  });
  assert.equal(result.deferred[0].reason, "outbound_message");
  assert.equal(result.records.length, 1);
  assert.equal(result.coverage.checkpoint_safe, true);
});

test("unknown direction or ambiguous recipient keeps the Sequence cursor fixed", async () => {
  for (const detailOverride of [
    { sent_from_paraform: undefined },
    { to: ["one@burner.example", "two@burner.example"] },
  ]) {
    const result = await readCachedSequenceReplyBatch({
      readState: async () => ({ status: "ready", value: state([reply()]) }),
      readMessage: async () => detail(detailOverride), activationAt, env,
      now: () => new Date("2026-09-03T12:02:00.000Z"),
    });
    assert.equal(result.records.length, 0);
    assert.equal(result.coverage.checkpoint_safe, false);
  }
});

test("catalog changes reset safely, watermark advances continue, and conflicting projections defer", async () => {
  const cached = state([reply()]);
  const stable = await readCachedSequenceReplyBatch({
    readState: async () => ({ status: "ready", value: cached }),
    readMessage: async () => detail(), activationAt, env,
    now: () => new Date("2026-09-03T12:02:00.000Z"),
  });
  const advanced = await readCachedSequenceReplyBatch({
    readState: async () => ({ status: "ready", value: cached }),
    readMessage: async () => detail(), activationAt, env,
    expectedCatalogDigest: stable.coverage.catalog_digest,
    expectedWatermark: "2026-09-03T12:00:00.000Z",
    now: () => new Date("2026-09-03T12:02:00.000Z"),
  });
  assert.equal(advanced.coverage.watermark_advanced, true);
  assert.equal(advanced.coverage.watermark_changed, false);
  assert.equal(advanced.records.length, 1);
  const changed = await readCachedSequenceReplyBatch({
    readState: async () => ({ status: "ready", value: cached }),
    readMessage: async () => assert.fail("must not read after catalog change"), activationAt, env,
    expectedCatalogDigest: "f".repeat(64),
    now: () => new Date("2026-09-03T12:02:00.000Z"),
  });
  assert.equal(changed.coverage.catalog_changed, true);
  assert.equal(changed.records.length, 0);

  const conflicting = state([
    reply({ gmail_id: "same-message", sequence_id: "sequence-1" }),
    reply({ gmail_id: "same-message", sequence_id: "sequence-2", candidate_user_id: "candidate-user-2" }),
  ], [
    { id: "sequence-1", name: "One", exact_role_id: "role-1", exact_role_source: "campaign.role_id" },
    { id: "sequence-2", name: "Two", exact_role_id: "role-2", exact_role_source: "campaign.role_id" },
  ]);
  let conflictReads = 0;
  const conflict = await readCachedSequenceReplyBatch({
    readState: async () => ({ status: "ready", value: conflicting }),
    readMessage: async () => { conflictReads += 1; return detail(); }, activationAt, env,
    now: () => new Date("2026-09-03T12:02:00.000Z"),
  });
  assert.equal(conflict.deferred.length, 0);
  assert.equal(conflict.records.length, 1);
  assert.equal(conflict.records[0].route, "needs_review");
  assert.deepEqual(conflict.records[0].event.offered_roles, []);
  assert.equal(conflict.records[0].event.candidate_user_id_hint, null);
  assert.equal(conflictReads, 1);
  assert.equal(conflict.coverage.checkpoint_safe, true);
});

test("complete message broker reuses only the existing Paraform point-read procedure", async () => {
  const calls = [];
  const result = await readCompleteSequenceInboxMessage("message-1", {
    get: async (...args) => {
      calls.push(args);
      return {
        email_body: "Full body",
        email_info: {
          from: "candidate@example.com", to: ["noah@heyraydar.com"],
          email_date: "2026-09-03T12:00:00.000Z", sent_from_paraform: false,
        },
      };
    },
  });
  assert.deepEqual(calls, [["campaigns.getCampaignEmail", { gmail_id: "message-1" }, 1]]);
  assert.equal(result.complete, true);
  assert.equal(result.message.body, "Full body");
});

test("worker reader paces a bounded page and advances only its Sequence Inbox cursor", async () => {
  const order = [];
  const result = await reconcileSequenceInbox({
    env: { ...env, SUBMISSIONS_V2_GMAIL_ACTIVATED_AT: activationAt },
    checkpoint: { cursor: "prior-sequence-cursor" },
    assertCurrent: async () => order.push("fence"),
    readBatch: async ({ cursor, cursorOverlapMs, limit }) => {
      assert.equal(cursor, "prior-sequence-cursor");
      assert.equal(cursorOverlapMs, 0);
      assert.equal(limit, 8);
      return {
        records: [{ event: { idempotency_key: "event-1" } }, { event: { idempotency_key: "event-2" } }],
        deferred: [],
        checkpoint_cursor: "next-sequence-cursor",
        coverage: {
          checkpoint_safe: true, full_success: false, page_size: 2,
          cache_state: "ready", cache_last_complete_at: "2026-09-03T12:00:00.000Z",
          cache_campaigns_targeted: 2, cache_campaigns_missing: 0, cache_campaigns_stale: 0,
        },
      };
    },
    admit: async (event) => {
      order.push(`admit:${event.idempotency_key}`);
      return { accepted: true, existing: event.idempotency_key === "event-1" };
    },
  });
  assert.deepEqual(order, [
    "fence", "fence", "fence", "admit:event-1", "fence", "admit:event-2",
  ]);
  assert.deepEqual(result.checkpoint, { cursor: "next-sequence-cursor", caught_up: false });
  assert.equal(result.caught_up, false);
  assert.equal(result.accepted, 1);
  assert.equal(result.existing, 1);
});

test("worker reader rejects an incomplete page without advancing its cursor", async () => {
  await assert.rejects(
    () => reconcileSequenceInbox({
      env: { ...env, SUBMISSIONS_V2_GMAIL_ACTIVATED_AT: activationAt },
      checkpoint: { cursor: "stable-cursor" },
      readBatch: async () => ({
        records: [], deferred: [{ reason: "full_message_unavailable" }],
        coverage: {
          checkpoint_safe: false, full_success: false, page_size: 1, deferred: 1,
          cache_state: "degraded",
        },
      }),
      admit: async () => assert.fail("must not admit incomplete detail"),
    }),
    (error) => error.code === "sequence_inbox_evidence_incomplete"
      && error.checkpoint.cursor === "stable-cursor",
  );
});
