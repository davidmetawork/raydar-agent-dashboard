import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";

import { runMigrations } from "../scripts/migrate-submissions-v2.mjs";
import { createDatabase, setRuntimeControls } from "../api/submissions-v2/_lib/db.mjs";
import { canonicalJson, requestDigest, validateEnrichment } from "../api/submissions-v2/_lib/enrichment.mjs";
import { createRepository } from "../api/submissions-v2/_lib/repository.mjs";
import { createService } from "../api/submissions-v2/_lib/service.mjs";

const databaseUrl = process.env.SUBMISSIONS_V2_ENRICHMENT_TEST_DATABASE_URL
  || process.env.SUBMISSIONS_V2_TEST_DATABASE_URL || "";
const digest = (value) => createHash("sha256").update(String(value)).digest("hex");
const serviceEnv = {
  SUBMISSIONS_V2_INGESTION_ENABLED: "true",
  SUBMISSIONS_V2_MASTER_INBOX_ENABLED: "true",
  SUBMISSIONS_V2_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString("base64"),
};
let sql;

before(async () => {
  if(!databaseUrl)return;
  await runMigrations({databaseUrl,logger:{info(){}}});
  sql = createDatabase({ databaseUrl, max: 5 });
  await setRuntimeControls({
    actorEmail: "enrichment-regression@raydar.test",
    reason: "Run isolated late-contract enrichment regression coverage",
    ui: false, ingestion: true, generation: false, masterInbox: true, curated: false,
  }, sql);
});
after(async () => { await sql?.end({ timeout: 5 }); });

async function fixture({ processingState = "needs_role", offeredRoles = [], originalRoles = false, insertSource = true } = {}) {
  const suffix = randomUUID();
  const candidateId = `candidate-enrichment-${suffix}`;
  const roleIds = [`role-first-${suffix}`, `role-second-${suffix}`];
  const signalId = randomUUID();
  const eventKey = `reply-event-${suffix}`;
  const mailboxId = `mailbox-${suffix}`;
  const providerMessageId = `message-${suffix}`;
  const senderDigest = digest(`sender:${suffix}`);
  const originalContentDigest = digest(`body:${suffix}`);
  const parentRfcMessageId = `<outbound-${suffix}@raydar.test>`;
  const sourceMessageId = `source-message-${suffix}`;
  const receivedAt = new Date().toISOString();
  const eventId = `event-${suffix}`;
  const originalRoleIds = originalRoles ? roleIds : offeredRoles;
  const intakeInput = {
    schema_version: "submissions.email_reply.v1",
    event_id: eventId,
    adapter_version: "master-inbox-contract-1",
    source_family: "new_match",
    source_family_version: "1",
    mailbox_id: mailboxId,
    provider: "master_inbox",
    provider_message_id: providerMessageId,
    direction: "inbound",
    received_at: receivedAt,
    sender_match_hmac: { key_version: "test-v1", digest: senderDigest },
    candidate_authored_text: "I am interested in this role.",
    offered_roles: originalRoleIds.map((roleId) => ({ role_id: roleId })),
    raw_record_ref: sourceMessageId,
    parent_rfc_message_id: parentRfcMessageId,
    content_digest: originalContentDigest,
    idempotency_key: eventKey,
  };
  const envelope = {
    source_family: "new_match",
    sender_match_hmac: { key_version: "test-v1", digest: senderDigest },
    raw_record_ref: sourceMessageId,
    parent_rfc_message_id: parentRfcMessageId,
    offered_roles: originalRoleIds.map((roleId) => ({ role_id: roleId })),
    request_digest: requestDigest(intakeInput),
  };
  await sql`
    insert into submissions_v2.candidate_index(
      candidate_user_id, display_name, normalized_name, search_key,
      email_match_hmac_current, email_match_hmac_current_version, active,
      paraform_profile_url, last_confirmed_at, source_digest
    ) values (
      ${candidateId}, 'Synthetic Enrichment Candidate', 'synthetic enrichment candidate', 'synthetic enrichment candidate',
      ${senderDigest}, 'test-v1', true, ${`https://www.paraform.com/candidates/${candidateId}`}, clock_timestamp(), ${digest(candidateId)}
    )
  `;
  for (const [index, roleId] of roleIds.entries()) {
    await sql`
      insert into submissions_v2.role_index(
        role_id, company_name, role_title, search_key, active, destination_url, last_confirmed_at, source_digest
      ) values (
        ${roleId}, ${`Synthetic Company ${index}`}, ${`Synthetic Role ${index}`}, ${`synthetic role ${index}`}, true,
        ${`https://www.paraform.com/browse?role=${roleId}`}, clock_timestamp(), ${digest(roleId)}
      )
    `;
  }
  if (insertSource) await sql`
    insert into submissions_v2.source_events(
      id, source_family, source_version, event_id, provider, mailbox_id, provider_message_id, direction,
      received_at, content_digest, processing_state, safe_error_code, safe_error_detail, idempotency_key, envelope
    ) values (
      ${signalId}, 'email', 'submissions.email_reply.v1', ${eventId}, 'master_inbox', ${mailboxId}, ${providerMessageId}, 'inbound',
      ${receivedAt}, ${originalContentDigest}, ${processingState}, 'role_unclear', 'The exact offered role was not present in the source contract.',
      ${eventKey}, ${sql.json(envelope)}
    )
  `;
  if (insertSource && offeredRoles.length) {
    for (const [order, roleId] of offeredRoles.entries()) {
      const role = roleIds.includes(roleId) ? roleId : roleIds[order % roleIds.length];
      await sql`
        insert into submissions_v2.source_offered_roles(
          signal_id, role_id, company_snapshot, role_label_snapshot, role_url_snapshot, offered_order, content_digest
        ) values (
          ${signalId}, ${role}, 'Immutable Company', ${`Immutable ${order}`}, ${`https://www.paraform.com/browse?role=${role}`}, ${order}, ${originalContentDigest}
        )
      `;
    }
  }
  return { candidateId, roleIds, signalId, eventKey, mailboxId, providerMessageId, senderDigest, originalContentDigest, parentRfcMessageId, sourceMessageId, receivedAt, envelope, intakeInput };
}

function enrichment(source, { enrichmentId = `enrichment-${randomUUID()}`, roleIds = source.roleIds, candidateId = source.candidateId, overrides = {} } = {}) {
  return {
    schemaVersion: 1,
    enrichmentId,
    eventKey: `late-contract:${enrichmentId}`,
    reason: "late_outbound_contract",
    originalEventKey: source.eventKey,
    semanticIdentity: { consumer: "submissions_v2", mailboxId: source.mailboxId, providerMessageId: source.providerMessageId },
    contract: {
      contractVersion: 1,
      contractKey: `contract-${enrichmentId}`,
      payloadDigest: digest(`contract:${enrichmentId}`),
      family: "new_match",
      candidateId,
      roleIds,
      producer: "test-producer",
      producerVersion: "test-v1",
      rfcMessageId: source.parentRfcMessageId,
      sentAt: new Date(Date.parse(source.receivedAt) - 1_000).toISOString(),
    },
    evidence: {
      bindingKind: "exact_outbound_parent_and_recipient",
      parentRfcMessageId: source.parentRfcMessageId,
      senderMatchHmac: { key_version: "test-v1", digest: source.senderDigest },
      originalContentDigest: source.originalContentDigest,
      sourceMessageId: source.sourceMessageId,
    },
    ...overrides,
  };
}

async function repositoryAndService() {
  const repository = createRepository({ sql });
  return { repository, service: createService({ repository, env: serviceEnv }) };
}

function memoryBlob() {
  const objects = new Map();
  return {
    async putPrivateObject(pathname, bytes, contentType) {
      objects.set(pathname, { bytes: Buffer.from(bytes), contentType });
      return { pathname, contentType };
    },
    async readPrivateObject(pathname) {
      const object = objects.get(pathname);
      if (!object) throw new Error("missing local test object");
      return object;
    },
    async inspectPrivateObject(pathname) {
      const object = objects.get(pathname);
      return { pathname, size: object?.bytes.length || 0 };
    },
  };
}

async function assertError(action, code, status = 409) {
  await assert.rejects(action, (error) => error?.code === code && error?.status === status);
}

test("late valid contract appends immutable evidence, claims ordered roles once, queues classification, and exposes a signed receipt", {skip:!databaseUrl}, async () => {
  const source = await fixture();
  const input = enrichment(source, { roleIds: [source.roleIds[1], source.roleIds[0]] });
  const { repository, service } = await repositoryAndService();
  const result = await service.intakeEnrichment(input);
  assert.deepEqual({ accepted: result.accepted, existing: result.existing, disposition: result.disposition, queued: result.queued }, { accepted: true, existing: false, disposition: "queued", queued: true });

  const sourceAfter = (await sql`select envelope, processing_state, content_digest from submissions_v2.source_events where id=${source.signalId}`)[0];
  assert.deepEqual(sourceAfter.envelope, source.envelope);
  assert.equal(sourceAfter.processing_state, "ready");
  assert.equal(sourceAfter.content_digest, source.originalContentDigest);
  const offers = await sql`select role_id, offered_order from submissions_v2.source_offered_roles where signal_id=${source.signalId} order by offered_order`;
  assert.deepEqual(offers.map((row) => [row.role_id, Number(row.offered_order)]), [[source.roleIds[1], 0], [source.roleIds[0], 1]]);
  assert.equal((await sql`select count(*)::integer as count from submissions_v2.first_response_claims where signal_id=${source.signalId} and released_at is null`)[0].count, 2);
  assert.equal((await sql`select count(*)::integer as count from submissions_v2.jobs where kind='classify_email_reply' and subject_id=${source.signalId}`)[0].count, 1);

  const audit = (await sql`select ordered_role_ids, disposition, evidence from submissions_v2.source_enrichments where enrichment_id=${input.enrichmentId}`)[0];
  assert.deepEqual(audit.ordered_role_ids, input.contract.roleIds);
  assert.equal(audit.disposition, "queued");
  assert.deepEqual(audit.evidence.senderMatchHmac, input.evidence.senderMatchHmac);
  const receipt = await service.intakeReceipt("enrichment", input.enrichmentId);
  assert.equal(receipt.received, true);
  assert.equal(receipt.requestDigest, requestDigest(input));
  assert.equal(receipt.contentDigest, receipt.requestDigest);
  assert.ok(receipt.receiptId);
  assert.equal((await repository.intakeReceipt("enrichment", input.enrichmentId)).request_digest, requestDigest(input));
});

test("same enrichment replay is a no-op, a changed replay conflicts, and concurrent delivery makes one claim and one job", {skip:!databaseUrl}, async () => {
  const source = await fixture();
  const input = enrichment(source);
  const { service } = await repositoryAndService();
  const [first, concurrent] = await Promise.all([service.intakeEnrichment(input), service.intakeEnrichment(input)]);
  assert.equal([first.existing, concurrent.existing].filter(Boolean).length, 1);
  const replay = await service.intakeEnrichment(input);
  assert.equal(replay.existing, true);
  await assertError(() => service.intakeEnrichment(enrichment(source, {
    overrides: { eventKey: input.eventKey },
  })), "intake_replay_conflict");
  await assertError(() => service.intakeEnrichment(enrichment(source, {
    enrichmentId: input.enrichmentId,
    overrides: { eventKey: "conflicting-payload" },
  })), "intake_replay_conflict");
  assert.equal((await sql`select count(*)::integer as count from submissions_v2.source_enrichments where enrichment_id=${input.enrichmentId}`)[0].count, 1);
  assert.equal((await sql`select count(*)::integer as count from submissions_v2.enrichment_request_keys where event_key=${input.eventKey}`)[0].count, 1);
  assert.equal((await sql`select count(*)::integer as count from submissions_v2.jobs where kind='classify_email_reply' and subject_id=${source.signalId}`)[0].count, 1);
  assert.equal((await sql`select count(*)::integer as count from submissions_v2.first_response_claims where signal_id=${source.signalId}`)[0].count, 2);
});

test("settled original intake accepts only its identical canonical request and rejects changed contents", {skip:!databaseUrl}, async () => {
  const source = await fixture({ processingState: "ready", offeredRoles: ["placeholder"] });
  const { service } = await repositoryAndService();
  const replay = await service.intakeMasterInbox(source.intakeInput);
  assert.equal(replay.accepted, true);
  assert.equal(replay.existing, true);
  await assertError(() => service.intakeMasterInbox({
    ...source.intakeInput,
    candidate_authored_text: "This is a changed body under the same immutable event identity.",
  }), "intake_replay_conflict");
  const after = (await sql`select envelope from submissions_v2.source_events where id=${source.signalId}`)[0];
  assert.equal(after.envelope.request_digest, requestDigest(source.intakeInput));
});

test("concurrent conflicting original replies accept one immutable body and reject the changed body before recording a replay", {skip:!databaseUrl}, async () => {
  const source = await fixture({ processingState: "ready", originalRoles: true, insertSource: false });
  const repository = createRepository({ sql });
  const blob = memoryBlob();
  const service = createService({ repository, env: serviceEnv, blob });
  const changed = {
    ...source.intakeInput,
    candidate_authored_text: "This changed reply has the same semantic identity.",
    content_digest: digest("changed concurrent body"),
  };
  const results = await Promise.allSettled([service.intakeMasterInbox(source.intakeInput), service.intakeMasterInbox(changed)]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1, JSON.stringify(results.map((result) => result.status === "fulfilled" ? result.value : { code: result.reason?.code, status: result.reason?.status, message: result.reason?.message })));
  const rejected = results.find((result) => result.status === "rejected")?.reason;
  assert.equal(rejected?.code, "intake_replay_conflict");
  assert.equal(rejected?.status, 409);
  const rows = await sql`select content_digest, envelope from submissions_v2.source_events where idempotency_key=${source.eventKey}`;
  assert.equal(rows.length, 1);
  const acceptedDigest = rows[0].content_digest;
  assert.ok([source.originalContentDigest, changed.content_digest].includes(acceptedDigest));
  assert.equal(rows[0].envelope.request_digest, acceptedDigest === source.originalContentDigest ? requestDigest(source.intakeInput) : requestDigest(changed));
});

test("mismatched sender, parent, digest, candidate, role, and ancestry leave source evidence and claims unchanged", {skip:!databaseUrl}, async () => {
  const source = await fixture();
  const { service } = await repositoryAndService();
  const cases = [
    ["sender", enrichment(source, { overrides: { evidence: { ...enrichment(source).evidence, senderMatchHmac: { key_version: "test-v1", digest: digest("wrong-sender") } } } }), "enrichment_evidence_mismatch"],
    ["parent", enrichment(source, { overrides: { evidence: { ...enrichment(source).evidence, parentRfcMessageId: "<wrong-parent@raydar.test>" } } }), "enrichment_contract_invalid"],
    ["digest", enrichment(source, { overrides: { evidence: { ...enrichment(source).evidence, originalContentDigest: digest("wrong-body") } } }), "enrichment_evidence_mismatch"],
    ["candidate", enrichment(source, { candidateId: "candidate-wrong" }), "enrichment_candidate_mismatch"],
    ["role", enrichment(source, { roleIds: ["role-unavailable"] }), "enrichment_role_unavailable"],
    ["late-sent", enrichment(source, { overrides: { contract: { ...enrichment(source).contract, sentAt: new Date(Date.parse(source.receivedAt) + 1_000).toISOString() } } }), "enrichment_evidence_mismatch"],
  ];
  for (const [, input, code] of cases) await assertError(() => service.intakeEnrichment(input), code, code === "enrichment_contract_invalid" ? 400 : 409);
  const after = (await sql`select envelope, processing_state, content_digest from submissions_v2.source_events where id=${source.signalId}`)[0];
  assert.deepEqual(after.envelope, source.envelope);
  assert.equal(after.processing_state, "needs_role");
  assert.equal(after.content_digest, source.originalContentDigest);
  assert.equal((await sql`select count(*)::integer as count from submissions_v2.source_enrichments where signal_id=${source.signalId}`)[0].count, 0);
  assert.equal((await sql`select count(*)::integer as count from submissions_v2.first_response_claims where signal_id=${source.signalId}`)[0].count, 0);
});

test("a needs-candidate source with original roles accepts only the same immutable role order", {skip:!databaseUrl}, async () => {
  const source = await fixture({ processingState: "needs_candidate", originalRoles: true });
  const { service } = await repositoryAndService();
  await assertError(() => service.intakeEnrichment(enrichment(source, { roleIds: [...source.roleIds].reverse() })), "enrichment_original_offer_mismatch");
  const unchanged = (await sql`select envelope, processing_state from submissions_v2.source_events where id=${source.signalId}`)[0];
  assert.deepEqual(unchanged.envelope, source.envelope);
  assert.equal(unchanged.processing_state, "needs_candidate");
  assert.equal((await sql`select count(*)::integer as count from submissions_v2.source_enrichments where signal_id=${source.signalId}`)[0].count, 0);
  const result = await service.intakeEnrichment(enrichment(source, { roleIds: source.roleIds }));
  assert.equal(result.disposition, "queued");
  const offers = await sql`select role_id from submissions_v2.source_offered_roles where signal_id=${source.signalId} order by offered_order`;
  assert.deepEqual(offers.map((row) => row.role_id), source.roleIds);
});

test("a question, negative, or proven first claim cannot be replaced; a settled source retains its original offered-role order", {skip:!databaseUrl}, async () => {
  for (const label of ["question", "negative", "proven"]) {
    const source = await fixture({ processingState: "needs_role" });
    const otherSignalId = randomUUID();
    await sql`
      insert into submissions_v2.source_events(id, source_family, source_version, event_id, received_at, content_digest, idempotency_key, envelope)
      values (${otherSignalId}, 'manual', 'manual.v1', ${`${label}-${otherSignalId}`}, clock_timestamp(), ${digest(otherSignalId)}, ${`other-${otherSignalId}`}, '{}'::jsonb)
    `;
    await sql`
      insert into submissions_v2.first_response_claims(candidate_user_id, role_id, event_id, source_family, signal_id, committed_at)
      values (${source.candidateId}, ${source.roleIds[0]}, ${`first-${label}-${otherSignalId}`}, 'manual', ${otherSignalId}, clock_timestamp())
    `;
    if (label === "question") {
      await sql`
        insert into submissions_v2.source_offered_roles(signal_id, role_id, company_snapshot, role_label_snapshot, offered_order)
        values (${otherSignalId}, ${source.roleIds[0]}, 'Question Company', 'Question Role', 0)
      `;
      await sql`
        insert into submissions_v2.signal_role_decisions(signal_id, role_id, candidate_user_id, decision_label, binding_result, schema_version)
        values (${otherSignalId}, ${source.roleIds[0]}, ${source.candidateId}, 'needs_review', 'question', 'test.v1')
      `;
    } else if (label === "negative") {
      const pairId = randomUUID();
      await sql`
        insert into submissions_v2.candidate_role_pairs(
          id, candidate_user_id, role_id, first_signal_id, intent_state, workflow_state, original_signal_at
        ) values (${pairId}, ${source.candidateId}, ${source.roleIds[0]}, ${otherSignalId}, 'not_interested', 'not_interested', clock_timestamp())
      `;
      await sql`
        insert into submissions_v2.not_interested_entries(pair_id, source_event_id, original_negative_at, grounded_reason, evidence_digest)
        values (${pairId}, ${otherSignalId}, clock_timestamp(), 'Synthetic negative response.', ${digest(`negative:${pairId}`)})
      `;
    }
    const { service } = await repositoryAndService();
    const result = await service.intakeEnrichment(enrichment(source, { roleIds: [source.roleIds[0]] }));
    assert.equal(result.disposition, "ignored_later", label);
    assert.equal(result.queued, false, label);
    const claim = (await sql`select event_id, signal_id from submissions_v2.first_response_claims where candidate_user_id=${source.candidateId} and role_id=${source.roleIds[0]}`)[0];
    assert.equal(claim.event_id, `first-${label}-${otherSignalId}`);
    assert.equal(claim.signal_id, otherSignalId);
  }

  const settled = await fixture({ processingState: "ready", offeredRoles: [] });
  for (const [order, roleId] of [settled.roleIds[1], settled.roleIds[0]].entries()) {
    await sql`
      insert into submissions_v2.source_offered_roles(signal_id, role_id, company_snapshot, role_label_snapshot, role_url_snapshot, offered_order, content_digest)
      values (${settled.signalId}, ${roleId}, 'Original Offer', ${`Original ${order}`}, ${`https://www.paraform.com/browse?role=${roleId}`}, ${order}, ${settled.originalContentDigest})
    `;
  }
  const { service } = await repositoryAndService();
  const result = await service.intakeEnrichment(enrichment(settled, { roleIds: [settled.roleIds[0]] }));
  assert.equal(result.disposition, "already_settled");
  const offers = await sql`select role_id from submissions_v2.source_offered_roles where signal_id=${settled.signalId} order by offered_order`;
  assert.deepEqual(offers.map((row) => row.role_id), [settled.roleIds[1], settled.roleIds[0]]);
});

test("canonical digest is key-order invariant but preserves ordered role intent; immutable receipt and enrichment rows reject mutation", {skip:!databaseUrl}, async () => {
  const ordered = { z: 1, contract: { roleIds: ["role-b", "role-a"] }, evidence: { digest: "x" } };
  const rekeyed = { evidence: { digest: "x" }, contract: { roleIds: ["role-b", "role-a"] }, z: 1 };
  assert.equal(canonicalJson(ordered), canonicalJson(rekeyed));
  assert.equal(requestDigest(ordered), requestDigest(rekeyed));
  assert.notEqual(requestDigest(ordered), requestDigest({ ...ordered, contract: { roleIds: ["role-a", "role-b"] } }));
  assert.equal(validateEnrichment(enrichment(await fixture())).schemaVersion, 1);

  const source = await fixture();
  const { service } = await repositoryAndService();
  const result = await service.intakeEnrichment(enrichment(source));
  await assert.rejects(sql`update submissions_v2.source_enrichments set disposition='tampered' where signal_id=${source.signalId}`, /immutable/);
  await assert.rejects(sql`delete from submissions_v2.intake_receipts where kind='enrichment' and event_id=${(await sql`select enrichment_id from submissions_v2.source_enrichments where signal_id=${source.signalId}`)[0].enrichment_id}`, /immutable/);
  assert.equal(result.accepted, true);
});
