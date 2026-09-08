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
import {
  normalizeSourcingRoleMappingRecord,
  readSourcingSequenceRoleMappings,
  sourcingRoleMappingInternals,
} from "../api/submissions-v2/_lib/sourcing-role-mappings.mjs";

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
      exact_project_id: campaign.exact_project_id || null,
      exact_project_source: campaign.exact_project_source || null,
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

test("a known-created Sourcing mapping binds one exact active role without manufacturing an outbound id", () => {
  const record = adaptSequenceInboxReply({
    reply: reply(),
    campaign: {
      id: "sequence-1",
      exact_project_id: "project-1",
      exact_project_source: "campaign.project_id",
    },
    detail: detail(), activationAt, env,
    savedRoleMappings: [{
      sequence_id: "sequence-1",
      role_id: "role-1",
      project_id: "project-1",
      attested_at: "2026-09-03T11:00:00.000Z",
      sequence_created: true,
      active: true,
      valid: true,
      evidence_locator: "sourcing:v1:role:role-1#digest",
    }],
  });
  assert.equal(record.route, "classify");
  assert.deepEqual(record.event.offered_roles.map((role) => role.role_id), ["role-1"]);
  assert.equal(record.source_evidence.exact_role_source, "sourcing.role_state.mapping");
  assert.equal(record.event.outbound_message_id, null);
});

test("saved role mappings fail closed on literal conflict, project mismatch, reuse, or post-reply attestation", () => {
  const mapping = {
    sequence_id: "sequence-1", role_id: "role-2", project_id: "project-1",
    attested_at: "2026-09-03T11:00:00.000Z", sequence_created: true,
    active: true, valid: true, evidence_locator: "sourcing:v1:role:role-2#digest",
  };
  const base = { reply: reply(), detail: detail(), activationAt, env };
  const conflict = adaptSequenceInboxReply({
    ...base,
    campaign: {
      id: "sequence-1", exact_role_id: "role-1", exact_role_source: "campaign.role_id",
      exact_project_id: "project-1", exact_project_source: "campaign.project_id",
    },
    savedRoleMappings: [mapping],
  });
  assert.equal(conflict.route, "needs_review");
  assert.deepEqual(conflict.event.offered_roles, []);

  for (const changed of [
    { project_id: "project-other" },
    { sequence_created: false },
    { attested_at: "2026-09-03T13:00:00.000Z" },
    { active: false },
  ]) {
    const result = adaptSequenceInboxReply({
      ...base,
      campaign: {
        id: "sequence-1", exact_project_id: "project-1",
        exact_project_source: "campaign.project_id",
      },
      savedRoleMappings: [{ ...mapping, ...changed }],
    });
    assert.equal(result.route, "needs_review");
    assert.deepEqual(result.event.offered_roles, []);
  }

  const activeInactiveCollision = adaptSequenceInboxReply({
    ...base,
    campaign: {
      id: "sequence-1", exact_project_id: "project-1",
      exact_project_source: "campaign.project_id",
    },
    savedRoleMappings: [mapping, {
      ...mapping,
      role_id: "role-inactive",
      active: false,
      valid: false,
      evidence_locator: "sourcing:v1:role:role-inactive#digest",
    }],
  });
  assert.equal(activeInactiveCollision.route, "needs_review");
  assert.deepEqual(activeInactiveCollision.event.offered_roles, []);
});

test("saved Sourcing state requires exact identity, creation provenance, timestamp, and active role", () => {
  const raw = {
    key: "sourcing:v1:role:role-1",
    stateRoleId: "role-1",
    mappingRoleId: "role-1",
    sequenceId: "sequence-1",
    reviewProjectId: "project-1",
    preparedAt: "2026-09-03T11:00:00.000Z",
    sequenceCreated: true,
  };
  assert.equal(normalizeSourcingRoleMappingRecord(raw, new Set(["role-1"])).valid, true);
  assert.equal(normalizeSourcingRoleMappingRecord({ ...raw, sequenceCreated: false }, new Set(["role-1"])).valid, false);
  assert.equal(normalizeSourcingRoleMappingRecord({ ...raw, preparedAt: null }, new Set(["role-1"])).valid, false);
  assert.equal(normalizeSourcingRoleMappingRecord({ ...raw, mappingRoleId: "role-2" }, new Set(["role-1"])).valid, false);
  assert.equal(normalizeSourcingRoleMappingRecord(raw, new Set()).valid, false);
  assert.equal(normalizeSourcingRoleMappingRecord({ ...raw, key: "sourcing:v1:role:role-1:runs" }, new Set(["role-1"])), null);
});

test("bounded Sourcing mapping inventory rejects partial state and never returns partial mappings", async () => {
  const compact = JSON.stringify({
    key: "sourcing:v1:role:role-1", stateRoleId: "role-1", mappingRoleId: "role-1",
    sequenceId: "sequence-1", reviewProjectId: "project-1",
    preparedAt: "2026-09-03T11:00:00.000Z", sequenceCreated: true,
  });
  let calls = 0;
  const loaded = await readSourcingSequenceRoleMappings({
    command: async (args) => {
      calls += 1;
      return args[0] === "SCAN"
        ? ["0", ["sourcing:v1:role:role-1", "sourcing:v1:role:role-1:runs"]]
        : [compact];
    },
    activeRoleIds: async () => new Set(["role-1"]),
  });
  assert.equal(calls, 4);
  assert.equal(loaded.status, "ready");
  assert.equal(loaded.mappings.length, 1);
  assert.equal(loaded.mappings[0].valid, true);

  const incomplete = await readSourcingSequenceRoleMappings({
    command: async () => ["next", []],
    activeRoleIds: async () => new Set(["role-1"]),
  });
  assert.equal(incomplete.status, "unavailable");
  assert.deepEqual(incomplete.mappings, []);
  assert.equal(incomplete.digest, sourcingRoleMappingInternals.UNAVAILABLE_DIGEST);
});

test("a changed Sourcing mapping inventory is unavailable rather than partially admitted", async () => {
  const compact = (roleId) => JSON.stringify({
    key: `sourcing:v1:role:${roleId}`, stateRoleId: roleId, mappingRoleId: roleId,
    sequenceId: "sequence-1", reviewProjectId: "project-1",
    preparedAt: "2026-09-03T11:00:00.000Z", sequenceCreated: true,
  });
  let scan = 0;
  const loaded = await readSourcingSequenceRoleMappings({
    command: async (args) => {
      if (args[0] === "SCAN") {
        scan += 1;
        return ["0", [`sourcing:v1:role:role-${scan}`]];
      }
      return [compact(`role-${scan}`)];
    },
    activeRoleIds: async () => new Set(["role-1", "role-2"]),
  });
  assert.equal(loaded.status, "unavailable");
  assert.deepEqual(loaded.mappings, []);
  assert.equal(loaded.digest, sourcingRoleMappingInternals.UNAVAILABLE_DIGEST);
});

test("full detail, activation, direction, sender, and identity conflicts fail closed", () => {
  const base = { reply: reply(), campaign: { id: "sequence-1" }, activationAt, env };
  assert.equal(adaptSequenceInboxReply({ ...base, detail: { message: detail().message } }).reason, "full_message_unavailable");
  assert.equal(adaptSequenceInboxReply({ ...base, detail: detail({ date: "2026-09-02T02:45:14.307Z" }) }).reason, "before_activation");
  assert.equal(adaptSequenceInboxReply({ ...base, detail: detail({ sent_from_paraform: true }) }).reason, "outbound_message");
  assert.equal(adaptSequenceInboxReply({ ...base, detail: detail({ sent_from_paraform: undefined }) }).reason, "provider_direction_unavailable");
  assert.equal(adaptSequenceInboxReply({ ...base, detail: detail({ to: ["David <david@raydar.xyz>"], subject: "Re: New Match" }) }).reason, "gmail_owned_mailbox");
  // Match Watch subjects belong to the direct Gmail reader too, so one reply is never
  // claimed twice with two different role sets.
  for (const subject of ["Re: Raydar - New Role Match \u{1F389}", "Re: Raydar - New Role Matches \u{1F389}"]) {
    assert.equal(adaptSequenceInboxReply({ ...base, detail: detail({ to: ["David <david@raydar.xyz>"], subject }) }).reason, "gmail_owned_mailbox", subject);
  }
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
    readRoleMappings: async () => ({
      status: "ready", digest: "a".repeat(64), mappings: [{ valid: true, role_id: "role-1" }],
    }),
    readBatch: async ({ limit, readMessage, savedRoleMappings, savedRoleMappingDigest, savedRoleMappingStatus }) => {
      assert.equal(limit, SEQUENCE_INBOX_BATCH_LIMIT);
      assert.equal(savedRoleMappingStatus, "ready");
      assert.equal(savedRoleMappingDigest, "a".repeat(64));
      assert.equal(savedRoleMappings[0].role_id, "role-1");
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

test("broker repairs 136 stale campaigns across bounded mid-scan refreshes without moving the scan watermark", async () => {
  const campaigns = Array.from({ length: 136 }, (_, index) => ({
    id: `sequence-${index + 1}`,
    name: `Sequence ${index + 1}`,
    exact_role_id: `role-${index + 1}`,
    exact_role_source: "campaign.role_id",
  }));
  const cached = state([], campaigns);
  const staleAt = "2026-09-03T12:01:00.000Z";
  const refreshedAt = "2026-09-04T12:01:00.000Z";
  for (const snapshot of cached.snapshots.values()) snapshot.refreshed_at = staleAt;
  cached.catalog.refreshed_at = staleAt;
  cached.meta.last_refresh_at = staleAt;
  cached.meta.last_complete_at = staleAt;

  let refreshes = 0;
  const scanWatermarks = [];
  const dependencies = {
    env: { SUBMISSIONS_V2_GMAIL_ACTIVATED_AT: activationAt },
    now: () => new Date("2026-09-04T12:02:00.000Z"),
    acquireLock: async () => ({ status: "acquired", token: "lock" }),
    releaseLock: async () => {},
    readState: async () => ({ status: "ready", value: cached }),
    buildRefresh: async () => {
      refreshes += 1;
      const sequenceIds = [...cached.snapshots.entries()]
        .filter(([, snapshot]) => snapshot.refreshed_at === staleAt)
        .slice(0, 18)
        .map(([sequenceId]) => sequenceId);
      return { sequenceIds };
    },
    writeState: async (previousState, refresh) => {
      for (const sequenceId of refresh.sequenceIds) {
        previousState.snapshots.get(sequenceId).refreshed_at = refreshedAt;
      }
      previousState.meta.last_refresh_at = refreshedAt;
      return previousState;
    },
    readRoleMappings: async () => ({
      status: "ready", digest: "a".repeat(64), mappings: [],
    }),
    readBatch: async ({ scanWatermark }) => {
      scanWatermarks.push(scanWatermark);
      return {
        records: [], deferred: [], checkpoint_cursor: "cursor-1",
        coverage: { checkpoint_safe: true, full_success: false },
      };
    },
  };
  for (let attempt = 0; attempt < 9; attempt += 1) {
    await readSequenceInboxBrokerBatch({
      cursor: "cursor-1", watermark: staleAt,
    }, dependencies);
  }

  assert.equal(refreshes, 8);
  assert.deepEqual(scanWatermarks.slice(0, 8), Array(8).fill(staleAt));
  assert.equal(scanWatermarks[8], staleAt);
  assert.equal([...cached.snapshots.values()].every((snapshot) => (
    snapshot.refreshed_at === refreshedAt
  )), true);
});

test("broker, cache reader, and worker reconcile 136 stale campaigns through a fixed backlog into a newer reply", async () => {
  const campaigns = Array.from({ length: 136 }, (_, index) => ({
    id: `sequence-${index + 1}`,
    name: `Sequence ${index + 1}`,
    exact_role_id: `role-${index + 1}`,
    exact_role_source: "campaign.role_id",
  }));
  const staleAt = "2026-09-03T12:01:00.000Z";
  const refreshedAt = "2026-09-03T12:03:00.000Z";
  const backlog = Array.from({ length: 12 }, (_, index) => reply({
    gmail_id: `backlog-${String(index + 1).padStart(2, "0")}`,
    sequence_id: `sequence-${index + 1}`,
    date: `2026-09-03T11:50:${String(index).padStart(2, "0")}.000Z`,
  }));
  const newer = reply({
    gmail_id: "newer-after-pin",
    sequence_id: "sequence-136",
    date: "2026-09-03T12:02:00.000Z",
  });
  const cached = state(backlog, campaigns);
  for (const snapshot of cached.snapshots.values()) snapshot.refreshed_at = staleAt;
  cached.catalog.refreshed_at = staleAt;
  cached.meta.last_refresh_at = staleAt;
  cached.meta.last_complete_at = staleAt;

  let refreshes = 0;
  let addedNewer = false;
  const admitted = new Set();
  const newlyAccepted = [];
  const brokerDependencies = {
    env: { ...env, SUBMISSIONS_V2_GMAIL_ACTIVATED_AT: activationAt },
    now: () => new Date("2026-09-03T12:04:00.000Z"),
    acquireLock: async () => ({ status: "acquired", token: "lock" }),
    releaseLock: async () => {},
    readState: async () => ({ status: "ready", value: cached }),
    buildRefresh: async () => {
      refreshes += 1;
      const sequenceIds = [...cached.snapshots.entries()]
        .filter(([, snapshot]) => snapshot.refreshed_at === staleAt)
        .slice(0, 18)
        .map(([sequenceId]) => sequenceId);
      return { sequenceIds };
    },
    writeState: async (previousState, refresh) => {
      for (const sequenceId of refresh.sequenceIds) {
        const snapshot = previousState.snapshots.get(sequenceId);
        snapshot.refreshed_at = refreshedAt;
        if (sequenceId === "sequence-136" && !addedNewer) {
          snapshot.replies.push(newer);
          snapshot.submissions_replies.push(newer);
          addedNewer = true;
        }
      }
      previousState.meta.last_refresh_at = refreshedAt;
      return previousState;
    },
    readRoleMappings: async () => ({
      status: "ready", digest: "a".repeat(64), mappings: [],
    }),
    readMessage: async (gmailId) => {
      const cachedReply = [...backlog, newer].find((item) => item.gmail_id === gmailId);
      return detail({ date: cachedReply.date });
    },
    sleepImpl: async () => {},
  };
  let checkpoint = {};
  let completed = false;
  for (let attempt = 0; attempt < 20 && !completed; attempt += 1) {
    const result = await reconcileSequenceInbox({
      env: brokerDependencies.env,
      checkpoint,
      assertCurrent: async () => {},
      readBatch: ({ cursor, caughtUp, catalogDigest, watermark, limit }) => (
        readSequenceInboxBrokerBatch({
          cursor,
          caught_up: caughtUp,
          catalog_digest: catalogDigest,
          watermark,
          limit,
        }, brokerDependencies)
      ),
      admit: async (event) => {
        const existing = admitted.has(event.idempotency_key);
        admitted.add(event.idempotency_key);
        if (!existing) newlyAccepted.push(event.provider_message_id);
        return { accepted: true, existing };
      },
    });
    checkpoint = result.checkpoint;
    completed = result.caught_up && checkpoint.watermark === refreshedAt;
  }

  assert.equal(completed, true);
  assert.equal(refreshes, 8);
  assert.equal(admitted.size, 13);
  assert.equal(new Set(newlyAccepted).size, newlyAccepted.length);
  assert.equal(newlyAccepted.includes("newer-after-pin"), true);
});

test("broker, cache reader, and worker finish a pinned replay across 130-to-137 empty-target churn before advancing", async () => {
  const baseCampaigns = Array.from({ length: 130 }, (_, index) => ({
    id: `sequence-${index + 1}`,
    name: `Sequence ${index + 1}`,
    exact_role_id: `role-${index + 1}`,
    exact_role_source: "campaign.role_id",
  }));
  const addedCampaigns = Array.from({ length: 7 }, (_, index) => ({
    id: `sequence-${index + 131}`,
    name: `Sequence ${index + 131}`,
    exact_role_id: `role-${index + 131}`,
    exact_role_source: "campaign.role_id",
  }));
  const pinnedAt = "2026-09-03T12:01:00.000Z";
  const refreshedAt = "2026-09-03T12:03:00.000Z";
  const backlog = Array.from({ length: 25 }, (_, index) => reply({
    gmail_id: `churn-backlog-${String(index + 1).padStart(2, "0")}`,
    sequence_id: `sequence-${index + 1}`,
    date: `2026-09-03T11:50:${String(index).padStart(2, "0")}.000Z`,
  }));
  const newer = reply({
    gmail_id: "churn-newer-after-pin",
    sequence_id: "sequence-137",
    date: "2026-09-03T12:02:00.000Z",
  });
  const cached = state(backlog, [...baseCampaigns, ...addedCampaigns]);
  const setAddedTargets = (included) => {
    cached.catalog.targets = included
      ? [...baseCampaigns, ...addedCampaigns]
      : [...baseCampaigns];
    cached.catalog.campaigns_total = cached.catalog.targets.length;
  };
  setAddedTargets(false);
  for (const snapshot of cached.snapshots.values()) snapshot.refreshed_at = pinnedAt;
  cached.catalog.refreshed_at = pinnedAt;
  cached.meta.last_refresh_at = pinnedAt;
  cached.meta.last_complete_at = pinnedAt;

  let brokerCalls = 0;
  let refreshes = 0;
  let newerAdded = false;
  let pinnedCompleted = false;
  const targetCounts = [];
  const observedPages = [];
  const admitted = new Set();
  const newlyAccepted = [];
  const brokerDependencies = {
    env: { ...env, SUBMISSIONS_V2_GMAIL_ACTIVATED_AT: activationAt },
    now: () => new Date("2026-09-03T12:04:00.000Z"),
    acquireLock: async () => ({ status: "acquired", token: "lock" }),
    releaseLock: async () => {},
    readState: async () => {
      brokerCalls += 1;
      if (!pinnedCompleted) setAddedTargets(brokerCalls % 2 === 0);
      else setAddedTargets(true);
      targetCounts.push(cached.catalog.targets.length);
      return { status: "ready", value: cached };
    },
    buildRefresh: async () => ({ advance: refreshes++ > 0 }),
    writeState: async (previousState, refresh) => {
      if (!refresh.advance) return previousState;
      for (const campaign of previousState.catalog.targets) {
        previousState.snapshots.get(campaign.id).refreshed_at = refreshedAt;
      }
      if (!newerAdded) {
        const snapshot = previousState.snapshots.get("sequence-137");
        snapshot.replies.push(newer);
        snapshot.submissions_replies.push(newer);
        newerAdded = true;
      }
      previousState.catalog.refreshed_at = refreshedAt;
      previousState.meta.last_refresh_at = refreshedAt;
      previousState.meta.last_complete_at = refreshedAt;
      return previousState;
    },
    readRoleMappings: async () => ({
      status: "ready", digest: "a".repeat(64), mappings: [],
    }),
    readMessage: async (gmailId) => {
      const cachedReply = [...backlog, newer].find((item) => item.gmail_id === gmailId);
      return detail({ date: cachedReply.date });
    },
    sleepImpl: async () => {},
  };

  let checkpoint = {};
  let completed = false;
  for (let attempt = 0; attempt < 12 && !completed; attempt += 1) {
    const result = await reconcileSequenceInbox({
      env: brokerDependencies.env,
      checkpoint,
      assertCurrent: async () => {},
      readBatch: ({ cursor, caughtUp, catalogDigest, watermark, limit }) => (
        readSequenceInboxBrokerBatch({
          cursor,
          caught_up: caughtUp,
          catalog_digest: catalogDigest,
          watermark,
          limit,
        }, brokerDependencies)
      ),
      admit: async (event) => {
        const existing = admitted.has(event.idempotency_key);
        admitted.add(event.idempotency_key);
        if (!existing) newlyAccepted.push(event.provider_message_id);
        return { accepted: true, existing };
      },
    });
    checkpoint = result.checkpoint;
    observedPages.push(result.observed);
    if (result.caught_up && checkpoint.watermark === pinnedAt) pinnedCompleted = true;
    completed = result.caught_up && checkpoint.watermark === refreshedAt;
  }

  assert.deepEqual(targetCounts.slice(0, 4), [130, 137, 130, 137]);
  assert.deepEqual(observedPages.slice(0, 4), [8, 8, 8, 1]);
  assert.equal(brokerCalls, 5);
  assert.equal(pinnedCompleted, true);
  assert.equal(completed, true);
  assert.equal(refreshes, 2);
  assert.equal(admitted.size, 26);
  assert.equal(new Set(newlyAccepted).size, newlyAccepted.length);
  assert.equal(newlyAccepted.includes("churn-newer-after-pin"), true);
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

test("broker exposes only the fixed cache failure cause", async () => {
  await assert.rejects(
    readSequenceInboxBrokerBatch({}, {
      env: { SUBMISSIONS_V2_GMAIL_ACTIVATED_AT: activationAt },
      now: () => new Date("2026-09-04T00:00:00.000Z"),
      acquireLock: async () => ({ status: "acquired", token: "lock" }),
      releaseLock: async () => {},
      readState: async () => ({ status: "error", cause: "pipeline_wrongtype", value: null }),
    }),
    (error) => error.code === "sequence_inbox_cache_unavailable"
      && error.message === "The Sequence Inbox cache is unavailable (pipeline_wrongtype).",
  );
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

test("cached reader pins a repaired scan horizon and admits newer replies on the next overlap scan", async () => {
  const pinnedAt = "2026-09-03T12:01:00.000Z";
  const refreshedAt = "2026-09-03T12:03:00.000Z";
  const cachedReplies = [
    reply({ gmail_id: "message-before-pin", date: "2026-09-03T12:00:00.000Z" }),
    reply({ gmail_id: "message-after-pin", date: "2026-09-03T12:02:00.000Z" }),
  ];
  const cached = state(cachedReplies);
  for (const snapshot of cached.snapshots.values()) snapshot.refreshed_at = refreshedAt;
  cached.catalog.refreshed_at = refreshedAt;
  cached.meta.last_refresh_at = refreshedAt;
  cached.meta.last_complete_at = refreshedAt;
  const options = {
    readState: async () => ({ status: "ready", value: cached }),
    readMessage: async (gmailId) => detail({
      date: cachedReplies.find((item) => item.gmail_id === gmailId).date,
    }),
    activationAt, env, limit: 8,
    now: () => new Date("2026-09-03T12:04:00.000Z"),
  };

  const pinned = await readCachedSequenceReplyBatch({ ...options, scanWatermark: pinnedAt });
  assert.deepEqual(pinned.records.map((record) => record.event.provider_message_id), ["message-before-pin"]);
  assert.equal(pinned.coverage.cache_confirmed_through, refreshedAt);
  assert.equal(pinned.coverage.watermark, pinnedAt);
  assert.equal(pinned.coverage.full_success, true);

  const next = await readCachedSequenceReplyBatch({
    ...options,
    cursor: pinned.checkpoint_cursor,
    cursorOverlapMs: 5 * 60_000,
    expectedCatalogDigest: pinned.coverage.catalog_digest,
    expectedWatermark: pinned.coverage.watermark,
  });
  assert.equal(next.records.some((record) => (
    record.event.provider_message_id === "message-after-pin"
  )), true);
  assert.equal(next.coverage.watermark, refreshedAt);
  assert.equal(next.coverage.watermark_advanced, true);
});

test("a refresh that inserts an older reply behind the cursor resets the scan before reading ahead", async () => {
  const campaigns = [
    { id: "sequence-a", name: "A", exact_role_id: "role-a", exact_role_source: "campaign.role_id" },
    { id: "sequence-b", name: "B", exact_role_id: "role-b", exact_role_source: "campaign.role_id" },
  ];
  const initialReplies = [
    reply({ sequence_id: "sequence-a", gmail_id: "message-a-1", date: "2026-09-03T12:00:00.000Z" }),
    reply({ sequence_id: "sequence-a", gmail_id: "message-a-2", date: "2026-09-03T12:00:30.000Z" }),
  ];
  const cached = state(initialReplies, campaigns);
  const messageDates = new Map(initialReplies.map((item) => [item.gmail_id, item.date]));
  const reads = [];
  const options = {
    readState: async () => ({ status: "ready", value: cached }),
    readMessage: async (gmailId) => {
      reads.push(gmailId);
      return detail({ date: messageDates.get(gmailId) });
    },
    activationAt, env, limit: 1,
    now: () => new Date("2026-09-03T12:04:00.000Z"),
  };

  const first = await readCachedSequenceReplyBatch(options);
  assert.deepEqual(reads, ["message-a-1"]);
  assert.equal(first.coverage.watermark, "2026-09-03T12:01:00.000Z");
  assert.equal(first.coverage.has_more, true);

  const lateOlder = reply({
    sequence_id: "sequence-b",
    gmail_id: "message-b-late-older",
    date: "2026-09-03T11:59:00.000Z",
  });
  messageDates.set(lateOlder.gmail_id, lateOlder.date);
  cached.snapshots.get("sequence-b").submissions_replies.push(lateOlder);
  cached.snapshots.get("sequence-b").refreshed_at = "2026-09-03T12:03:00.000Z";

  const changed = await readCachedSequenceReplyBatch({
    ...options,
    cursor: first.next_cursor,
    expectedCatalogDigest: first.coverage.catalog_digest,
    expectedWatermark: first.coverage.watermark,
    scanWatermark: first.coverage.watermark,
  });
  assert.equal(changed.coverage.catalog_changed, true);
  assert.equal(changed.checkpoint_cursor, null);
  assert.deepEqual(reads, ["message-a-1"]);

  const restarted = await readCachedSequenceReplyBatch({
    ...options,
    expectedCatalogDigest: changed.coverage.catalog_digest,
    expectedWatermark: changed.coverage.watermark,
  });
  assert.equal(restarted.coverage.catalog_changed, false);
  assert.deepEqual(
    restarted.records.map((record) => record.event.provider_message_id),
    ["message-b-late-older"],
  );
});

test("empty target churn cannot reset or prevent a finite replay from completing", async () => {
  const replies = Array.from({ length: 6 }, (_, index) => reply({
    gmail_id: `message-${index + 1}`,
    date: `2026-09-03T12:00:0${index}.000Z`,
  }));
  const baseCampaign = {
    id: "sequence-1", name: "One",
    exact_role_id: "role-1", exact_role_source: "campaign.role_id",
  };
  const cached = state(replies, [baseCampaign]);
  const reads = [];
  const options = {
    readState: async () => ({ status: "ready", value: cached }),
    readMessage: async (gmailId) => {
      reads.push(gmailId);
      return detail({ date: replies.find((item) => item.gmail_id === gmailId).date });
    },
    activationAt, env, limit: 1,
    now: () => new Date("2026-09-03T12:02:00.000Z"),
  };

  let cursor = null;
  let digest = null;
  let watermark = null;
  let final = null;
  for (let page = 0; page < replies.length; page += 1) {
    if (page > 0 && page % 2 === 1) {
      const emptyCampaign = {
        id: `sequence-empty-${page}`,
        name: `Empty ${page}`,
        exact_role_id: `empty-role-${page}`,
        exact_role_source: "campaign.role_id",
      };
      cached.catalog.targets.push(emptyCampaign);
      cached.snapshots.set(emptyCampaign.id, state([], [emptyCampaign]).snapshots.get(emptyCampaign.id));
    } else if (page > 0) {
      cached.catalog.targets = cached.catalog.targets.filter((campaign) => campaign.id === "sequence-1");
      for (const sequenceId of [...cached.snapshots.keys()]) {
        if (sequenceId !== "sequence-1") cached.snapshots.delete(sequenceId);
      }
    }
    cached.catalog.campaigns_total = cached.catalog.targets.length;
    final = await readCachedSequenceReplyBatch({
      ...options,
      cursor,
      expectedCatalogDigest: digest,
      expectedWatermark: watermark,
      scanWatermark: watermark,
    });
    assert.equal(final.coverage.catalog_changed, false);
    assert.equal(final.records.length, 1);
    cursor = final.next_cursor;
    digest = final.coverage.catalog_digest;
    watermark = final.coverage.watermark;
  }

  assert.deepEqual(reads, replies.map((item) => item.gmail_id));
  assert.equal(final.next_cursor, null);
  assert.equal(final.coverage.full_success, true);
});

test("a newly seeded target with an old reply resets before point read and is caught on replay", async () => {
  const initialReplies = [
    reply({ sequence_id: "sequence-a", gmail_id: "message-a-1", date: "2026-09-03T12:00:00.000Z" }),
    reply({ sequence_id: "sequence-a", gmail_id: "message-a-2", date: "2026-09-03T12:00:30.000Z" }),
  ];
  const campaignA = {
    id: "sequence-a", name: "A",
    exact_role_id: "role-a", exact_role_source: "campaign.role_id",
  };
  const cached = state(initialReplies, [campaignA]);
  const dates = new Map(initialReplies.map((item) => [item.gmail_id, item.date]));
  const reads = [];
  const options = {
    readState: async () => ({ status: "ready", value: cached }),
    readMessage: async (gmailId) => {
      reads.push(gmailId);
      return detail({ date: dates.get(gmailId) });
    },
    activationAt, env, limit: 1,
    now: () => new Date("2026-09-03T12:02:00.000Z"),
  };
  const first = await readCachedSequenceReplyBatch(options);
  assert.deepEqual(reads, ["message-a-1"]);

  const campaignB = {
    id: "sequence-b", name: "B",
    exact_role_id: "role-b", exact_role_source: "campaign.role_id",
  };
  const lateOlder = reply({
    sequence_id: "sequence-b",
    gmail_id: "message-b-late-older",
    date: "2026-09-03T11:59:00.000Z",
  });
  dates.set(lateOlder.gmail_id, lateOlder.date);
  cached.catalog.targets.push(campaignB);
  cached.catalog.campaigns_total = 2;
  cached.snapshots.set(campaignB.id, state([lateOlder], [campaignB]).snapshots.get(campaignB.id));

  const changed = await readCachedSequenceReplyBatch({
    ...options,
    cursor: first.next_cursor,
    expectedCatalogDigest: first.coverage.catalog_digest,
    expectedWatermark: first.coverage.watermark,
    scanWatermark: first.coverage.watermark,
  });
  assert.equal(changed.coverage.catalog_changed, true);
  assert.equal(changed.checkpoint_cursor, null);
  assert.deepEqual(reads, ["message-a-1"]);

  const replayed = await readCachedSequenceReplyBatch({
    ...options,
    expectedCatalogDigest: changed.coverage.catalog_digest,
    expectedWatermark: changed.coverage.watermark,
    scanWatermark: changed.coverage.watermark,
  });
  assert.equal(replayed.records[0].event.provider_message_id, "message-b-late-older");
});

test("role and project evidence changes for an old reply each reset its replay epoch", async () => {
  for (const [field, replacement] of [
    ["exact_role_id", "role-2"],
    ["exact_role_source", "changed.role.source"],
    ["exact_project_id", "project-2"],
    ["exact_project_source", "changed.project.source"],
  ]) {
    const campaign = {
      id: "sequence-1", name: "One",
      exact_role_id: "role-1", exact_role_source: "campaign.role_id",
      exact_project_id: "project-1", exact_project_source: "campaign.project_id",
    };
    const cached = state([reply()], [campaign]);
    const stable = await readCachedSequenceReplyBatch({
      readState: async () => ({ status: "ready", value: cached }),
      readMessage: async () => detail(),
      activationAt, env,
      now: () => new Date("2026-09-03T12:02:00.000Z"),
    });
    campaign[field] = replacement;
    const changed = await readCachedSequenceReplyBatch({
      readState: async () => ({ status: "ready", value: cached }),
      readMessage: async () => assert.fail(`must reset before reading after ${field} change`),
      activationAt, env,
      expectedCatalogDigest: stable.coverage.catalog_digest,
      expectedWatermark: stable.coverage.watermark,
      scanWatermark: stable.coverage.watermark,
      now: () => new Date("2026-09-03T12:02:00.000Z"),
    });
    assert.equal(changed.coverage.catalog_changed, true, field);
    assert.equal(changed.checkpoint_cursor, null, field);
  }
});

test("newer-only target metadata waits for the next overlap scan and the newer reply is then read", async () => {
  const pinnedAt = "2026-09-03T12:01:00.000Z";
  const refreshedAt = "2026-09-03T12:03:00.000Z";
  const cachedReplies = [
    reply({ sequence_id: "sequence-a", gmail_id: "message-old", date: "2026-09-03T12:00:00.000Z" }),
    reply({ sequence_id: "sequence-b", gmail_id: "message-newer", date: "2026-09-03T12:02:00.000Z" }),
  ];
  const campaigns = [
    { id: "sequence-a", name: "A", exact_role_id: "role-a", exact_role_source: "campaign.role_id" },
    { id: "sequence-b", name: "B", exact_role_id: "role-b", exact_role_source: "campaign.role_id" },
  ];
  const cached = state(cachedReplies, campaigns);
  for (const snapshot of cached.snapshots.values()) snapshot.refreshed_at = refreshedAt;
  cached.catalog.refreshed_at = refreshedAt;
  cached.meta.last_refresh_at = refreshedAt;
  cached.meta.last_complete_at = refreshedAt;
  const reads = [];
  const options = {
    readState: async () => ({ status: "ready", value: cached }),
    readMessage: async (gmailId) => {
      reads.push(gmailId);
      return detail({ date: cachedReplies.find((item) => item.gmail_id === gmailId).date });
    },
    activationAt, env, limit: 8,
    now: () => new Date("2026-09-03T12:04:00.000Z"),
  };
  const pinned = await readCachedSequenceReplyBatch({ ...options, scanWatermark: pinnedAt });
  assert.deepEqual(reads, ["message-old"]);

  campaigns[1].exact_role_id = "role-b-updated";
  campaigns[1].exact_project_id = "project-b-updated";
  campaigns[1].exact_project_source = "campaign.project_id";
  const unchanged = await readCachedSequenceReplyBatch({
    ...options,
    cursor: pinned.checkpoint_cursor,
    expectedCatalogDigest: pinned.coverage.catalog_digest,
    expectedWatermark: pinned.coverage.watermark,
    scanWatermark: pinned.coverage.watermark,
  });
  assert.equal(unchanged.coverage.catalog_changed, false);
  assert.deepEqual(reads, ["message-old"]);

  const next = await readCachedSequenceReplyBatch({
    ...options,
    cursor: unchanged.checkpoint_cursor,
    cursorOverlapMs: 5 * 60_000,
    expectedCatalogDigest: unchanged.coverage.catalog_digest,
    expectedWatermark: unchanged.coverage.watermark,
  });
  assert.equal(next.coverage.catalog_changed, false);
  assert.equal(next.coverage.watermark_advanced, true);
  assert.deepEqual(next.records.map((record) => record.event.provider_message_id), [
    "message-old", "message-newer",
  ]);
  assert.deepEqual(next.records.find((record) => (
    record.event.provider_message_id === "message-newer"
  )).event.offered_roles.map((role) => role.role_id), ["role-b-updated"]);
});

test("projection readiness and watermark regression still stop replay safely", async () => {
  const unprojected = state([reply()]);
  unprojected.snapshots.get("sequence-1").submissions_projection_version = 0;
  const unavailable = await readCachedSequenceReplyBatch({
    readState: async () => ({ status: "ready", value: unprojected }),
    readMessage: async () => assert.fail("must not read an incomplete projection"),
    activationAt, env,
    now: () => new Date("2026-09-03T12:02:00.000Z"),
  });
  assert.equal(unavailable.deferred[0].reason, "submissions_projection_unavailable");
  assert.equal(unavailable.coverage.checkpoint_safe, false);

  const cached = state([reply()]);
  const stable = await readCachedSequenceReplyBatch({
    readState: async () => ({ status: "ready", value: cached }),
    readMessage: async () => detail(), activationAt, env,
    now: () => new Date("2026-09-03T12:02:00.000Z"),
  });
  cached.snapshots.get("sequence-1").refreshed_at = "2026-09-03T11:59:00.000Z";
  const regressed = await readCachedSequenceReplyBatch({
    readState: async () => ({ status: "ready", value: cached }),
    readMessage: async () => assert.fail("must not read after watermark regression"),
    activationAt, env,
    expectedCatalogDigest: stable.coverage.catalog_digest,
    expectedWatermark: stable.coverage.watermark,
    now: () => new Date("2026-09-03T12:02:00.000Z"),
  });
  assert.equal(regressed.coverage.watermark_changed, true);
  assert.equal(regressed.checkpoint_cursor, null);
});

test("a reply hashes the declared campaign used by adaptation, not its snapshot container", async () => {
  const campaigns = [
    { id: "sequence-container", name: "Container", exact_role_id: "role-container", exact_role_source: "campaign.role_id" },
    { id: "sequence-declared", name: "Declared", exact_role_id: "role-declared", exact_role_source: "campaign.role_id" },
  ];
  const mismatched = reply({ sequence_id: "sequence-declared", gmail_id: "message-mismatched" });
  const cached = state([mismatched], campaigns);
  cached.snapshots.get("sequence-declared").submissions_replies = [];
  cached.snapshots.get("sequence-declared").replies = [];
  cached.snapshots.get("sequence-container").submissions_replies = [mismatched];
  cached.snapshots.get("sequence-container").replies = [mismatched];
  const stable = await readCachedSequenceReplyBatch({
    readState: async () => ({ status: "ready", value: cached }),
    readMessage: async () => detail(), activationAt, env,
    now: () => new Date("2026-09-03T12:02:00.000Z"),
  });
  assert.deepEqual(stable.records[0].event.offered_roles.map((role) => role.role_id), ["role-declared"]);

  campaigns[0].exact_role_id = "role-container-updated";
  const containerChanged = await readCachedSequenceReplyBatch({
    readState: async () => ({ status: "ready", value: cached }),
    readMessage: async () => detail(), activationAt, env,
    expectedCatalogDigest: stable.coverage.catalog_digest,
    expectedWatermark: stable.coverage.watermark,
    scanWatermark: stable.coverage.watermark,
    now: () => new Date("2026-09-03T12:02:00.000Z"),
  });
  assert.equal(containerChanged.coverage.catalog_changed, false);

  campaigns[1].exact_role_id = "role-declared-updated";
  const declaredChanged = await readCachedSequenceReplyBatch({
    readState: async () => ({ status: "ready", value: cached }),
    readMessage: async () => assert.fail("must reset before using changed declared evidence"),
    activationAt, env,
    expectedCatalogDigest: containerChanged.coverage.catalog_digest,
    expectedWatermark: containerChanged.coverage.watermark,
    scanWatermark: containerChanged.coverage.watermark,
    now: () => new Date("2026-09-03T12:02:00.000Z"),
  });
  assert.equal(declaredChanged.coverage.catalog_changed, true);
});

test("a reply whose declared sequence is absent hashes neutral evidence instead of its container role", async () => {
  const campaign = {
    id: "sequence-container", name: "Container",
    exact_role_id: "role-container", exact_role_source: "campaign.role_id",
  };
  const mismatched = reply({ sequence_id: "sequence-absent", gmail_id: "message-absent-sequence" });
  const cached = state([], [campaign]);
  cached.snapshots.get(campaign.id).submissions_replies = [mismatched];
  cached.snapshots.get(campaign.id).replies = [mismatched];
  const stable = await readCachedSequenceReplyBatch({
    readState: async () => ({ status: "ready", value: cached }),
    readMessage: async () => detail(), activationAt, env,
    now: () => new Date("2026-09-03T12:02:00.000Z"),
  });
  assert.equal(stable.records[0].route, "needs_review");
  assert.deepEqual(stable.records[0].event.offered_roles, []);
  assert.equal(stable.records[0].source_evidence.sequence_id, "sequence-absent");

  campaign.exact_role_id = "role-container-updated";
  const containerChanged = await readCachedSequenceReplyBatch({
    readState: async () => ({ status: "ready", value: cached }),
    readMessage: async () => detail(), activationAt, env,
    expectedCatalogDigest: stable.coverage.catalog_digest,
    expectedWatermark: stable.coverage.watermark,
    scanWatermark: stable.coverage.watermark,
    now: () => new Date("2026-09-03T12:02:00.000Z"),
  });
  assert.equal(containerChanged.coverage.catalog_changed, false);
  assert.deepEqual(containerChanged.records[0].event.offered_roles, []);
});

test("optional saved-role lookup unavailability preserves literal campaign role intake", async () => {
  const result = await readCachedSequenceReplyBatch({
    readState: async () => ({ status: "ready", value: state([reply()]) }),
    readMessage: async () => detail(),
    activationAt, env,
    savedRoleMappingStatus: "unavailable",
    savedRoleMappings: [{ valid: true, role_id: "unsafe-partial-role" }],
    savedRoleMappingDigest: sourcingRoleMappingInternals.UNAVAILABLE_DIGEST,
    now: () => new Date("2026-09-03T12:02:00.000Z"),
  });
  assert.equal(result.records.length, 1);
  assert.deepEqual(result.records[0].event.offered_roles.map((role) => role.role_id), ["role-1"]);
  assert.equal(result.coverage.sourcing_role_mapping_status, "unavailable");
  assert.equal(result.coverage.sourcing_role_mapping_inventory_count, 0);
  assert.equal(result.coverage.sourcing_role_mapping_valid_record_count, 0);
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

  const mappingChanged = await readCachedSequenceReplyBatch({
    readState: async () => ({ status: "ready", value: cached }),
    readMessage: async () => assert.fail("must not read after mapping digest change"),
    activationAt, env,
    expectedCatalogDigest: stable.coverage.catalog_digest,
    savedRoleMappingDigest: "a".repeat(64),
    now: () => new Date("2026-09-03T12:02:00.000Z"),
  });
  assert.equal(mappingChanged.coverage.catalog_changed, true);
  assert.equal(mappingChanged.records.length, 0);

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
          sourcing_role_mapping_status: "ready", sourcing_role_mapping_inventory_count: 4,
          sourcing_role_mapping_valid_record_count: 3,
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
  assert.equal(result.cache.sourcing_role_mapping_status, "ready");
  assert.equal(result.cache.sourcing_role_mapping_inventory_count, 4);
  assert.equal(result.cache.sourcing_role_mapping_valid_record_count, 3);
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
