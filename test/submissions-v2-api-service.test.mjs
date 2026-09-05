import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { encryptJson } from "../api/submissions-v2/_lib/private-data.mjs";
import {
  createService, serviceInternals, signUploadIntent, verifyUploadIntent,
} from "../api/submissions-v2/_lib/service.mjs";

const encryptionKey = Buffer.alloc(32, 9).toString("base64url");
const env = {
  SUBMISSIONS_V2_ENCRYPTION_KEY: encryptionKey,
  SUBMISSIONS_V2_DOWNLOAD_SECRET: "d".repeat(40),
  SUBMISSIONS_V2_UPLOAD_SECRET: "u".repeat(40),
  SUBMISSIONS_V2_UI_ENABLED: "true",
  SUBMISSIONS_V2_INGESTION_ENABLED: "true",
  SUBMISSIONS_V2_GENERATION_ENABLED: "true",
  SUBMISSIONS_V2_MASTER_INBOX_ENABLED: "true",
  SUBMISSIONS_V2_CURATED_ENABLED: "true",
};
const digest = (value) => createHash("sha256").update(value).digest("hex");
const runtimeControls = async () => ({
  control_epoch: 1,
  ui_enabled: true,
  ingestion_enabled: true,
  generation_enabled: true,
  master_inbox_enabled: true,
  curated_enabled: true,
});

function intakeRepository(overrides = {}) {
  return {
    runtimeControls,
    sourceByIdempotency: async () => null,
    candidateMatches: async () => ({ candidate: { candidate_user_id: "candidate-1" }, ambiguous: false, hinted: true }),
    claimEmailFirstResponse: async ({ offeredRoles }) => ({
      eligible_role_ids: offeredRoles.map((role) => role.role_id), dropped_role_count: 0, ignored_later: false,
    }),
    reservePrivateObject: async ({ reservationId, objectKey, purpose, ownerRef, expectedDigest, expiresAt }) => ({
      id: reservationId, object_key: objectKey, purpose, owner_ref: ownerRef,
      expected_digest: expectedDigest, expires_at: new Date(expiresAt).toISOString(), state: "pending", write_fencing_token: 1,
    }),
    renewPrivateObjectWrite: async () => ({}),
    recordEmailSource: async ({ event, processingState, safeEnvelope, privateObjectKey }) => ({
      existing: false,
      source: { id: "11111111-1111-4111-8111-111111111111", processing_state: processingState, event, safeEnvelope, privateObjectKey },
      job: processingState === "ready" ? { id: "job-1" } : null,
    }),
    ...overrides,
  };
}

const inboxEvent = (contractVersion = 1) => ({
  id: "event-1",
  eventKey: "master-inbox:message-1:role-1",
  contractVersion,
  family: "new_match",
  mailboxId: "mailbox-1",
  providerMessageId: "message-1",
  senderMatchHmac: { key_version: "v1", digest: "candidate-email-hmac" },
  roleId: "role-1",
  payload: {
    receivedAt: "2026-09-01T20:00:00.000Z",
    candidateText: "Yes, I am interested.",
    sentMessageText: "Would you like this role?",
    conversationId: "conversation_123",
    sourceMessageId: "private-message-id",
  },
});

test("Master Inbox intake encrypts private text, keeps trusted conversation link, and queues only the current contract", async () => {
  let stored;
  let recorded;
  const repository = intakeRepository({
    recordEmailSource: async (input) => {
      recorded = input;
      return { existing: false, source: { id: "signal-1", processing_state: input.processingState }, job: { id: "job-1" } };
    },
  });
  const service = createService({
    repository,
    env,
    blob: { putPrivateObject: async (pathname, bytes, contentType) => { stored = { pathname, bytes, contentType }; } },
  });
  const result = await service.intakeMasterInbox(inboxEvent());
  assert.equal(result.processing_state, "ready");
  assert.equal(result.queued, true);
  assert.equal(stored.contentType, "application/json");
  assert.equal(stored.bytes.includes(Buffer.from("Yes, I am interested.")), false);
  assert.equal(recorded.safeEnvelope.signal_url, "https://monitor.raydar.xyz/master-inbox#conversation=conversation_123");
  assert.equal(JSON.stringify(recorded.safeEnvelope).includes("private-message-id"), true);
  assert.equal(JSON.stringify(recorded.safeEnvelope).includes("Yes, I am interested."), false);
});

test("a later reply is reduced to a privacy-safe metric before private storage or model work", async () => {
  let privateWrites = 0;
  let classifierCalls = 0;
  const repository = intakeRepository({
    claimEmailFirstResponse: async () => ({ eligible_role_ids: [], dropped_role_count: 1, ignored_later: true }),
    reservePrivateObject: async () => { throw new Error("private reservation must not run"); },
  });
  const service = createService({
    repository, env,
    classifier: async () => { classifierCalls += 1; return {}; },
    blob: { putPrivateObject: async () => { privateWrites += 1; } },
  });
  const result = await service.intakeMasterInbox(inboxEvent());
  assert.equal(result.processing_state, "ignored_later");
  assert.equal(result.signal_id, null);
  assert.equal(result.queued, false);
  assert.equal(privateWrites, 0);
  assert.equal(classifierCalls, 0);
});

test("Sequence Inbox identity conflicts are retained in Needs Review without a first-response claim", async () => {
  let claimed = 0;
  let recorded;
  const service = createService({
    repository: intakeRepository({
      claimEmailFirstResponse: async () => { claimed += 1; return { eligible_role_ids: [] }; },
      recordEmailSource: async (input) => {
        recorded = input;
        return { existing: false, source: { id: "signal-sequence", processing_state: input.processingState }, job: null };
      },
    }),
    env,
    blob: { putPrivateObject: async () => {} },
  });
  const result = await service.intakeMasterInbox({
    schema_version: "submissions.email_reply.v1",
    event_id: "sequence-event-1",
    source_family: "paraform_sequence_reply",
    source_family_version: "1",
    adapter_version: "sequence-inbox-v1",
    mailbox_id: "noah-heyraydar-com",
    provider: "gmail",
    provider_message_id: "message-sequence-1",
    provider_thread_id: "thread-sequence-1",
    direction: "inbound",
    received_at: "2026-09-03T12:00:00.000Z",
    sender_match_hmac: { key_version: "v1", digest: "candidate-email-hmac" },
    candidate_authored_text: "Yes, please tell me more.",
    offered_roles: [{ role_id: "role-1" }],
    content_digest: "a".repeat(64),
    idempotency_key: "gmail:noah-heyraydar-com:message-sequence-1",
    candidate_user_id_hint: "cached-candidate-user",
    review_reason_hint: "candidate_ambiguous",
    source_evidence: { cache_version: 3, sequence_id: "sequence-1" },
  });
  assert.equal(result.processing_state, "needs_candidate");
  assert.equal(claimed, 0);
  assert.equal(recorded.safeErrorCode, "candidate_ambiguous");
  assert.equal(recorded.candidateResolution.candidate_user_id, null);
  assert.equal(recorded.safeEnvelope.source_evidence.sequence_id, "sequence-1");
});

test("Master Inbox private-object replay survives a crash after Blob write and before source commit", async () => {
  let reservation;
  let blobBytes;
  let writes = 0;
  let records = 0;
  const repository = intakeRepository({
    reservePrivateObject: async (input) => {
      if (!reservation) reservation = { ...input, id: input.reservationId, state: "pending", write_fencing_token: 1 };
      else {
        assert.equal(input.reservationId, reservation.id);
        assert.equal(input.expectedDigest, reservation.expectedDigest);
      }
      return reservation;
    },
    recordEmailSource: async (input) => {
      records += 1;
      return { existing: false, source: { id: "signal-replayed", processing_state: input.processingState }, job: { id: "job-replayed" } };
    },
  });
  const service = createService({
    repository, env,
    blob: {
      putPrivateObject: async (_pathname, bytes) => {
        writes += 1;
        if (!blobBytes) {
          blobBytes = Buffer.from(bytes);
          throw Object.assign(new Error("simulated process crash"), { code: "simulated_crash" });
        }
        assert.deepEqual(Buffer.from(bytes), blobBytes);
      },
    },
  });
  await assert.rejects(() => service.intakeMasterInbox(inboxEvent()), (error) => error.code === "simulated_crash");
  const replayed = await service.intakeMasterInbox(inboxEvent());
  assert.equal(replayed.signal_id, "signal-replayed");
  assert.equal(writes, 2);
  assert.equal(records, 1);
});

test("unknown Master Inbox contract versions are durably quarantined without a classifier job", async () => {
  let recorded;
  const service = createService({
    repository: intakeRepository({
      recordEmailSource: async (input) => {
        recorded = input;
        return { existing: false, source: { id: "signal-2", processing_state: input.processingState }, job: null };
      },
    }),
    env,
    blob: { putPrivateObject: async () => {} },
  });
  const result = await service.intakeMasterInbox(inboxEvent(2));
  assert.equal(result.processing_state, "unsupported_version");
  assert.equal(result.queued, false);
  assert.equal(recorded.safeErrorCode, "unsupported_contract_version");
});

test("Signal URL is built only from a trusted conversation identifier", () => {
  assert.equal(serviceInternals.trustedSignalUrl({ payload: { conversationId: "abc:123" } }), "https://monitor.raydar.xyz/master-inbox#conversation=abc%3A123");
  assert.equal(serviceInternals.trustedSignalUrl({ adapter_version: "sequence-inbox-v1", source_evidence: { sequence_id: "sequence-123" } }), "https://www.paraform.com/sequences?detail=sequence-123&sequence_tab=inbox");
  assert.equal(serviceInternals.trustedSignalUrl({ adapter_version: "sequence-inbox-v1", source_evidence: { sequence_id: "../bad" } }), null);
  assert.equal(serviceInternals.trustedSignalUrl({ payload: { conversationId: "../bad?value" } }), null);
  assert.equal(serviceInternals.trustedSignalUrl({ payload: { sourceMessageId: "message-only" } }), null);
});

test("worker-side processing decrypts one private event and applies grounded classifier decisions", async () => {
  const eventId = "event-1";
  const envelope = encryptJson({ candidate_authored_text: "Yes", sent_message_text: "Interested?" }, { env, context: `event:${eventId}` });
  let applied;
  const repository = {
    runtimeControls,
    sourceForClassification: async () => ({
      id: "signal-1",
      event_id: eventId,
      encrypted_body_object_key: "private/event",
      envelope: { candidate_resolution: { candidate_user_id: "candidate-1" } },
      offered_roles: [{ role_id: "role-1", company: "Acme", title: "Engineer" }],
    }),
    applyClassifiedSignal: async (input) => { applied = input; return { created_count: 1 }; },
    routeClassificationFailure: async () => assert.fail("should not fail classification"),
  };
  const service = createService({
    repository,
    env,
    blob: { readPrivateObject: async () => ({ bytes: Buffer.from(JSON.stringify(envelope)) }) },
    classifier: async () => ({
      decisions: [{ role_id: "role-1", label: "interested", quote: "Yes", review_reason: null, negative_reason: null }],
      attempts: [{ model: "gpt-5.4-nano-2026-03-17", outcome: "accepted" }],
      duration_ms: 25,
    }),
  });
  const result = await service.processSignal("signal-1");
  assert.equal(result.created_count, 1);
  assert.equal(applied.candidateId, "candidate-1");
  assert.equal(applied.decisions[0].quote, "Yes");
  assert.equal(applied.attempts[0].duration_ms, 25);
});

test("classifier exhaustion retains every failed attempt before routing to review", async () => {
  const eventId = "event-failed";
  const envelope = encryptJson({ candidate_authored_text: "Maybe", sent_message_text: "Interested?" }, { env, context: `event:${eventId}` });
  let routed;
  const repository = {
    runtimeControls,
    sourceForClassification: async () => ({
      id: "signal-failed", event_id: eventId, encrypted_body_object_key: "private/failed",
      envelope: { candidate_resolution: { candidate_user_id: "candidate-1" } },
      offered_roles: [{ role_id: "role-1" }],
    }),
    routeClassificationFailure: async (input) => { routed = input; return { pairs: [] }; },
  };
  const error = Object.assign(new Error("failed"), {
    code: "classification_failed",
    spent: 0.019,
    attempts: [
      { model: "gpt-5.4-nano-2026-03-17", outcome: "invalid", reason: "quote_not_verbatim" },
      { model: "gpt-5.4-2026-03-05", outcome: "failed", reason: "classifier_http_503" },
    ],
  });
  const service = createService({
    repository, env,
    blob: { readPrivateObject: async () => ({ bytes: Buffer.from(JSON.stringify(envelope)) }) },
    classifier: async () => { throw error; },
  });
  await service.processSignal("signal-failed");
  assert.equal(routed.attempts.length, 2);
  assert.equal(routed.attempts[0].reason, "quote_not_verbatim");
  assert.equal(routed.spent, 0.019);
});

test("upload intents are short-lived, actor-bound, and read back before supplement persistence", async () => {
  let supplement;
  const bytes = Buffer.from("evidence-file");
  const repository = {
    runtimeControls,
    pair: async () => ({ id: "pair-1", state_version: 4 }),
    reserveUploadIntent: async ({ reservationId, objectKey, expiresAt }) => ({
      reservation_id: reservationId, object_key: objectKey,
      expires_at: new Date(expiresAt).toISOString(),
    }),
    addSupplement: async (input) => { supplement = input; return { supplement_id: "supplement-1" }; },
  };
  const service = createService({
    repository,
    env,
    now: () => 1_800_000_000_000,
    blob: {
      createPresignedUpload: async ({ pathname, contentType }) => ({ upload_url: "https://example.public.blob.vercel-storage.com/upload", upload_headers: { "content-type": contentType }, pathname }),
      inspectPrivateObject: async () => ({ content_type: "application/pdf", size: bytes.length }),
      readPrivateObject: async () => ({ bytes, content_type: "application/pdf" }),
    },
  });
  const prepared = await service.createUploadIntent({ actorEmail: "recruiter@raydar.xyz", idempotencyKey: "upload-intent-1", body: { case_id: "pair-1", expected_version: 4, filename: "context.pdf", content_type: "application/pdf", size: bytes.length } });
  const decoded = verifyUploadIntent(prepared.upload_id, { actorEmail: "recruiter@raydar.xyz", env, now: 1_800_000_000_001 });
  assert.equal(decoded.pair_id, "pair-1");
  assert.throws(() => verifyUploadIntent(prepared.upload_id, { actorEmail: "other@raydar.xyz", env, now: 1_800_000_000_001 }), /another user/);
  const completed = await service.completeUpload({ actorEmail: "recruiter@raydar.xyz", idempotencyKey: "upload-command-1", body: { case_id: "pair-1", expected_version: 4, upload_id: prepared.upload_id, evidence_basis: "sourced", source_note: "Candidate-provided context" } });
  assert.equal(completed.supplement_id, "supplement-1");
  assert.equal(supplement.digestValue, digest(bytes));
});

test("download broker verifies the archived digest and never exposes a private object URL", async () => {
  const bytes = Buffer.from("pdf-bytes");
  const repository = {
    runtimeControls,
    issueDownload: async ({ ticketId, expiresAt }) => ({ ticket_id: ticketId, expires_at: new Date(expiresAt).toISOString(), artifact: { id: "artifact-1", private_object_key: "submissions/resumes/v2/artifacts/1", created_at: "2026-08-31T20:00:00.000Z" }, candidate_user_id: "candidate-1", candidate_name: "Jane Candidate", role_id: "role-1", company_name: "Acme Health", role_title: "Product Engineer" }),
    downloadableArtifact: async () => ({ id: "artifact-1", pair_id: "pair-1", digest: digest(bytes), candidate_name: "Jane Candidate", company_name: "Acme Health", role_title: "Product Engineer", created_at: "2026-08-31T20:00:00.000Z" }),
    redeemDownloadTicket: async () => ({ redeemed: true }),
    auditDownloadFailure: async () => {},
  };
  const service = createService({ repository, env, now: () => 1_800_000_000_000, blob: { readPrivateObject: async () => ({ bytes }) } });
  const issued = await service.issueDownload({ actorEmail: "recruiter@raydar.xyz", idempotencyKey: "download-command-1", pairId: "pair-1", body: { expected_version: 3 } });
  assert.match(issued.url, /&display=inline$/u);
  assert.match(issued.url, /^\/api\/submissions-v2\/download\?ticket=/);
  assert.equal(issued.url.includes("vercel-storage.com"), false);
  const downloaded = await service.download({ actorEmail: "recruiter@raydar.xyz", ticket: new URL(`https://monitor.raydar.xyz${issued.url}`).searchParams.get("ticket") });
  assert.deepEqual(downloaded.bytes, bytes);
  assert.equal(downloaded.filename, "Jane_Candidate__Acme_Health__Product_Engineer__Raydar__2026-08-31.pdf");
});

test("upload token helpers reject tampering and expiry", () => {
  const token = signUploadIntent({ pathname: "p", pair_id: "pair", email: "a@raydar.xyz", expires_at: 100 }, { env });
  assert.throws(() => verifyUploadIntent(`${token}x`, { actorEmail: "a@raydar.xyz", env, now: 1 }), /invalid/);
  assert.throws(() => verifyUploadIntent(token, { actorEmail: "a@raydar.xyz", env, now: 101 }), /expired/);
});

test("regeneration can reuse the existing source bundle without supplemental context", async () => {
  let requested;
  const service = createService({
    repository: {
      runtimeControls,
      regenerate: async (input) => { requested = input; return { job_id: "job-rerun" }; },
    },
    env,
  });
  const result = await service.command({
    actorEmail: "recruiter@raydar.xyz",
    idempotencyKey: "rerun-existing-sources",
    body: { action: "regenerate", case_id: "pair-1", expected_version: 4 },
  });
  assert.equal(result.job_id, "job-rerun");
  assert.equal(requested.pairId, "pair-1");
  assert.equal(requested.expectedVersion, 4);
  assert.equal(requested.evidenceEncrypted, null);
  assert.equal(requested.evidenceBasis, null);
  assert.equal(requested.sourceNote, null);
  assert.equal(requested.instructionsEncrypted, null);
  assert.deepEqual(requested.uploads, []);
});

test("Review dismissal requires a controlled reason and a human note", async () => {
  let dismissed;
  const service = createService({
    repository: {
      runtimeControls,
      dismissUnresolvedSignal: async (input) => {
        dismissed = input;
        return { outcome: "dismissed", destination: "removed_from_review", signal_id: input.signalId, affected_count: 1 };
      },
    },
    env,
  });
  const result = await service.command({
    actorEmail: "recruiter@raydar.xyz", idempotencyKey: "dismiss-review-1",
    body: {
      action: "dismiss_review", signal_id: "11111111-1111-4111-8111-111111111111",
      dismissal_reason: "irrelevant_notification", note: "Calendar-assistant notification, not a candidate response.",
    },
  });
  assert.equal(result.destination, "removed_from_review");
  assert.equal(dismissed.dismissalReason, "irrelevant_notification");
  assert.equal(dismissed.note, "Calendar-assistant notification, not a candidate response.");
  for (const body of [
    { action: "dismiss_review", signal_id: "signal", dismissal_reason: "hide_it", note: "Reason" },
    { action: "dismiss_review", signal_id: "signal", dismissal_reason: "not_candidate_response", note: "" },
  ]) {
    await assert.rejects(
      () => service.command({ actorEmail: "recruiter@raydar.xyz", idempotencyKey: `invalid-${body.dismissal_reason}`, body }),
      (error) => error.status === 400,
    );
  }
});

test("role recheck queues a live ingestion read for the same pair", async () => {
  let queued;
  const service = createService({
    repository: {
      runtimeControls,
      enqueuePairAction: async (input) => { queued = input; return { job_id: "job-role-recheck" }; },
    },
    env,
  });
  const result = await service.command({
    actorEmail: "recruiter@raydar.xyz", idempotencyKey: "recheck-role-1",
    body: { action: "recheck_role", case_id: "pair-1", expected_version: 7 },
  });
  assert.equal(result.job_id, "job-role-recheck");
  assert.deepEqual(queued, {
    actorEmail: "recruiter@raydar.xyz", idempotencyKey: "recheck-role-1",
    pairId: "pair-1", expectedVersion: 7, action: "recheck_role",
    kind: "recheck_pair", requiredControl: "ingestion", checkpoint: { target: "role" },
  });
});

test("environment and durable controls jointly block direct UI and intake calls while health remains readable", async () => {
  let listCalled = false;
  const repository = {
    runtimeControls: async () => ({
      control_epoch: 2, ui_enabled: true, ingestion_enabled: true, generation_enabled: true,
      master_inbox_enabled: true, curated_enabled: true,
    }),
    list: async () => { listCalled = true; return { rows: [], total: 0, next_cursor: null }; },
    health: async () => ({ delayed: false, database: "current" }),
  };
  const service = createService({ repository, env: { ...env, SUBMISSIONS_V2_UI_ENABLED: "false", SUBMISSIONS_V2_MASTER_INBOX_ENABLED: "false" } });
  await assert.rejects(() => service.list({ page: "interested" }), /disabled/);
  await assert.rejects(() => service.intakeMasterInbox(inboxEvent()), /disabled/);
  assert.equal(listCalled, false);
  assert.equal((await service.health()).health.database, "current");
});

test("scheduler tick supplies five-minute, hourly, Pacific daily, and purge windows", async () => {
  let scheduled;
  let recoveries = 0;
  const repository = {
    runtimeControls,
    recoverExpiredResumeGenerations: async () => { recoveries += 1; return { recovered: [] }; },
    scheduleTick: async (input) => { scheduled = input; return { jobs: [] }; },
  };
  const service = createService({
    repository,
    env,
    now: () => Date.parse("2026-09-01T15:07:30.000Z"),
  });
  await service.tick({ recoverResumes: true });
  assert.equal(recoveries, 1);
  assert.equal(scheduled.minuteKey, "2026-09-01T15:07");
  assert.equal(scheduled.fiveMinuteKey, "2026-09-01T15:05");
  assert.equal(scheduled.hourKey, "2026-09-01T15");
  assert.equal(scheduled.pacificDayKey, "2026-09-01");
  assert.equal(scheduled.dailyDigestDue, true);
  assert.equal(scheduled.nightlyDue, true);
  assert.equal(scheduled.purgeDue, true);
  assert.equal(scheduled.controlCeiling.ingestion, true);
  assert.equal(scheduled.controlCeiling.master_inbox, true);
  assert.equal(scheduled.controlCeiling.curated, true);
});

test("scheduler skips resume recovery while UI or generation is disabled without blocking ordinary jobs", async () => {
  let recoveries = 0;
  let scheduled = 0;
  const repository = {
    runtimeControls: async () => ({ ...await runtimeControls(), ui_enabled: false }),
    recoverExpiredResumeGenerations: async () => { recoveries += 1; },
    scheduleTick: async () => { scheduled += 1; return { jobs: [{ id: "source-job" }] }; },
  };
  const service = createService({ repository, env, now: () => Date.parse("2026-09-01T15:07:30.000Z") });
  const result = await service.tick({ recoverResumes: true });
  assert.equal(recoveries, 0);
  assert.equal(scheduled, 1);
  assert.equal(result.jobs[0].id, "source-job");
});

test("API scheduler calls never invoke worker-only resume recovery", async () => {
  let recoveries = 0;
  const service = createService({
    repository: {
      runtimeControls,
      recoverExpiredResumeGenerations: async () => { recoveries += 1; },
      scheduleTick: async () => ({ jobs: [] }),
    },
    env,
    now: () => Date.parse("2026-09-01T15:07:30.000Z"),
  });
  await service.tick();
  assert.equal(recoveries, 0);
});
