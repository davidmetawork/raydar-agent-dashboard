import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { effectiveControls, environmentControls } from "./config.mjs";
import { normalizeEmailReply, privateEventPayload, safeEventProjection } from "./contracts.mjs";
import { classifyReply } from "./classifier.mjs";
import { createRepository } from "./repository.mjs";
import { rowDto, publicHealth } from "./presentation.mjs";
import { decryptJson, encryptJson } from "./private-data.mjs";
import {
  createPresignedUpload, inspectPrivateObject, privatePath, privateReservationId, putPrivateObject,
  readPrivateObject, signDownloadTicket, verifyDownloadTicket,
} from "./blob.mjs";

const CURRENT_MASTER_INBOX_CONTRACT = 1;
const ALLOWED_UPLOADS = new Set(["application/pdf", "image/png", "image/jpeg", "image/webp"]);
const clean = (value, limit = 500) => String(value ?? "").trim().slice(0, limit);
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function problem(code, message, status = 422, current = null) {
  return Object.assign(new Error(message), { code, status, ...(current ? { current } : {}) });
}

function required(value, field, limit = 500) {
  const result = clean(value, limit);
  if (!result) throw problem(`${field}_required`, `${field.replaceAll("_", " ")} is required.`, 400);
  return result;
}

function expectedVersion(value) {
  const result = Number(value);
  if (!Number.isInteger(result) || result < 0) throw problem("expected_version_required", "The current item version is required.", 400);
  return result;
}

function equal(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  return a.length === b.length && timingSafeEqual(a, b);
}

function uploadSecret(env = process.env) {
  const value = clean(env.SUBMISSIONS_V2_UPLOAD_SECRET, 4_000);
  if (value.length < 32) throw problem("upload_signing_not_configured", "Upload signing is not configured.", 503);
  return value;
}

function retentionSecret(env = process.env) {
  const value = clean(env.SUBMISSIONS_V2_RETENTION_HMAC_KEY, 4_000);
  if (value.length < 32) throw problem("retention_hmac_not_configured", "Case-retention hashing is not configured.", 503);
  return value;
}

function tombstoneCaseHmac(pairId, env = process.env) {
  return createHmac("sha256", retentionSecret(env)).update(`submissions-v2-case\0${pairId}`).digest("hex");
}

function candidateSuppressionDigest(candidateId) {
  return sha256(`submissions-v2-candidate-suppression:v1\0${candidateId}`);
}

export function signUploadIntent(payload, { env = process.env } = {}) {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", uploadSecret(env)).update(encoded).digest("base64url");
  return `${encoded}.${signature}`;
}

export function verifyUploadIntent(value, { actorEmail, env = process.env, now = Date.now() } = {}) {
  const [encoded, supplied, extra] = String(value || "").split(".");
  if (!encoded || !supplied || extra) throw problem("upload_intent_invalid", "The upload intent is invalid.", 401);
  const expected = createHmac("sha256", uploadSecret(env)).update(encoded).digest("base64url");
  if (!equal(supplied, expected)) throw problem("upload_intent_invalid", "The upload intent is invalid.", 401);
  let payload;
  try { payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")); }
  catch { throw problem("upload_intent_invalid", "The upload intent is invalid.", 401); }
  if (!payload?.reservation_id || !payload?.pathname || !payload?.pair_id || !payload?.email || Number(payload.expires_at) <= now) throw problem("upload_intent_expired", "The upload intent expired or is incomplete.", 401);
  if (String(payload.email).toLowerCase() !== String(actorEmail || "").toLowerCase()) throw problem("upload_intent_wrong_user", "The upload intent belongs to another user.", 403);
  return payload;
}

function trustedSignalUrl(input) {
  const conversationId = clean(input?.payload?.conversationId ?? input?.conversationId, 500);
  if (!conversationId || !/^[A-Za-z0-9._:~-]{1,500}$/.test(conversationId)) return null;
  return `https://monitor.raydar.xyz/master-inbox#conversation=${encodeURIComponent(conversationId)}`;
}

function filenamePart(value, fallback) {
  return clean(value, 120).normalize("NFKD").replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || fallback;
}

function safeFilename({ candidateName, companyName, roleTitle, createdAt, artifactVersion } = {}) {
  const date = Number.isFinite(Date.parse(createdAt || "")) ? new Date(createdAt).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10);
  return `${filenamePart(candidateName, "Candidate")}__${filenamePart(companyName, "Company")}__${filenamePart(roleTitle, "Role")}__Raydar__${date}.pdf`;
}

function normalizeCounts(row = {}) {
  return {
    interested: Number(row.interested || 0),
    needs_review: Number(row.needs_review || 0),
    not_interested: Number(row.not_interested || 0),
    actionable: Number(row.actionable || 0),
  };
}

export function createService({
  repository = createRepository(), env = process.env, fetchImpl = fetch,
  blob = {}, classifier = classifyReply, now = () => Date.now(),
} = {}) {
  const blobs = {
    createPresignedUpload: blob.createPresignedUpload || createPresignedUpload,
    inspectPrivateObject: blob.inspectPrivateObject || inspectPrivateObject,
    putPrivateObject: blob.putPrivateObject || putPrivateObject,
    readPrivateObject: blob.readPrivateObject || readPrivateObject,
  };

  async function requireControls(...requiredFlags) {
    const durable = await repository.runtimeControls();
    const current = effectiveControls(environmentControls(env), durable);
    if (!current.readable) throw problem("submissions_v2_controls_unavailable", "Submissions V2 controls are unavailable.", 503);
    const disabled = requiredFlags.filter((flag) => !current[flag]);
    if (disabled.length) throw problem("submissions_v2_disabled", "Submissions V2 is disabled for this action.", 503);
    return current;
  }

  const service = {
    async list(input = {}) {
      await requireControls("ui");
      const result = await repository.list({
        page: clean(input.page, 40), query: clean(input.q, 200), cursor: clean(input.cursor, 2_000) || null,
        limit: Number(input.limit) || 100,
      });
      const health = publicHealth(await repository.health());
      return { rows: result.rows.map(rowDto), total_count: result.total, next_cursor: result.next_cursor, health };
    },

    async counts() {
      await requireControls("ui");
      const [counts, health] = await Promise.all([repository.counts(), repository.health()]);
      return { counts: normalizeCounts(counts), health: publicHealth(health) };
    },

    async search(kind, input = {}) {
      await requireControls("ui");
      if (!new Set(["candidates", "roles"]).has(kind)) throw problem("search_kind_invalid", "The search kind is invalid.", 404);
      const query = clean(input.q, 200);
      const results = kind === "candidates"
        ? await repository.searchCandidates({ query, limit: input.limit })
        : await repository.searchRoles({ query, limit: input.limit });
      return { results };
    },

    async pair(pairId) {
      await requireControls("ui");
      const row = await repository.pair(required(pairId, "pair_id", 100));
      if (!row) throw problem("pair_not_found", "The candidate-role item was not found.", 404);
      return { pair: rowDto({
        ...row, pair_id: row.id, candidate_name: row.candidate_name, candidate_url: row.candidate_url,
        company_name: row.company_name, role_title: row.role_title, role_url: row.destination_url,
        signal_at: row.original_signal_at,
      }) };
    },

    async jobs(input = {}) {
      await requireControls("ui");
      return { jobs: await repository.jobs({
        pairId: clean(input.pair_id, 100) || null,
        state: clean(input.state, 40) || null,
        limit: Number(input.limit) || 50,
      }) };
    },

    async intakeMasterInbox(input) {
      await requireControls("ingestion", "master_inbox");
      const normalized = normalizeEmailReply(input);
      const contractUnsupported = input?.schema_version === undefined && Number(input?.contractVersion) !== CURRENT_MASTER_INBOX_CONTRACT;
      if (contractUnsupported) {
        normalized.errors.push("unsupported_contract_version");
        normalized.quarantined = true;
      }
      const event = { ...normalized.event };
      if (!event.idempotency_key || !event.event_id || !event.received_at || !event.mailbox_id || !event.provider_message_id) {
        throw problem("source_identity_invalid", "The Master Inbox event identity is incomplete.", 400);
      }
      const prior = await repository.sourceByIdempotency(event.idempotency_key);
      if (prior) return { accepted: true, existing: true, signal_id: prior.id, processing_state: prior.processing_state };
      const providerPrior = await repository.sourceByProvider?.(event.mailbox_id, event.provider_message_id);
      if (providerPrior) return { accepted: true, existing: true, signal_id: providerPrior.id, processing_state: providerPrior.processing_state };

      const candidateResolutionRaw = await repository.candidateMatches(event);
      const candidateResolution = {
        candidate_user_id: candidateResolutionRaw.candidate?.candidate_user_id || null,
        ambiguous: Boolean(candidateResolutionRaw.ambiguous),
      };
      let processingState = "ready";
      let safeErrorCode = null;
      let safeErrorDetail = null;
      if (event.machine_message) {
        processingState = "ignored_machine";
        safeErrorCode = "machine_message";
      } else if (normalized.quarantined || normalized.errors.some((code) => code.startsWith("unsupported_"))) {
        processingState = "unsupported_version";
        safeErrorCode = normalized.errors.find((code) => code.startsWith("unsupported_")) || "unsupported_contract";
        safeErrorDetail = "The source contract version or family is not approved.";
      } else if (normalized.errors.includes("offered_roles_missing")) {
        processingState = "needs_role";
        safeErrorCode = "role_unclear";
        safeErrorDetail = "The exact offered role was not present in the source contract.";
      } else if (normalized.errors.length) {
        processingState = "quarantined";
        safeErrorCode = normalized.errors[0];
        safeErrorDetail = "The source event did not satisfy the approved contract.";
      } else if (!candidateResolution.candidate_user_id) {
        processingState = "needs_candidate";
        safeErrorCode = candidateResolution.ambiguous ? "candidate_ambiguous" : "candidate_not_found";
        safeErrorDetail = candidateResolution.ambiguous
          ? "More than one Paraform candidate matched and no single recorded-call profile resolved the duplicate."
          : "The candidate could not be matched to an active Paraform profile.";
      }

      if (processingState === "ready") {
        const firstResponse = await repository.claimEmailFirstResponse({
          eventId: event.event_id,
          idempotencyKey: event.idempotency_key,
          candidateId: candidateResolution.candidate_user_id,
          offeredRoles: event.offered_roles,
        });
        if (firstResponse.ignored_later) {
          return {
            accepted: true,
            existing: false,
            signal_id: null,
            processing_state: "ignored_later",
            queued: false,
          };
        }
        const eligibleRoleIds = new Set(firstResponse.eligible_role_ids);
        event.offered_roles = event.offered_roles.filter((role) => eligibleRoleIds.has(role.role_id));
      }

      const privatePayload = privateEventPayload(event);
      const encrypted = encryptJson(privatePayload, { env, context: `event:${event.event_id}`, deterministic: true });
      const privateObjectKey = privatePath("events", sha256(event.idempotency_key).slice(0, 48));
      const privateObjectBytes = Buffer.from(JSON.stringify(encrypted));
      const privateObjectDigest = sha256(privateObjectBytes);
      const objectReservation = await repository.reservePrivateObject({
        reservationId: privateReservationId(privateObjectKey), objectKey: privateObjectKey, purpose: "source_event",
        ownerRef: event.event_id, expectedDigest: privateObjectDigest, expiresAt: now() + 24 * 60 * 60_000,
      });
      await repository.renewPrivateObjectWrite({ reservationId: objectReservation.id, objectKey: privateObjectKey, expectedDigest: privateObjectDigest, writeFencingToken: objectReservation.write_fencing_token });
      await blobs.putPrivateObject(privateObjectKey, privateObjectBytes, "application/json", { env });
      if (!/^[a-f0-9]{64}$/i.test(event.content_digest)) event.content_digest = sha256(JSON.stringify(privatePayload));
      const safeEnvelope = {
        ...safeEventProjection(event),
        signal_url: trustedSignalUrl(input),
      };
      const recorded = await repository.recordEmailSource({
        event, safeEnvelope, privateObjectKey, objectReservationId: objectReservation.id,
        objectWriteFencingToken: objectReservation.write_fencing_token,
        objectDigest: privateObjectDigest, processingState, safeErrorCode, safeErrorDetail, candidateResolution,
      });
      return {
        accepted: true,
        existing: recorded.existing,
        signal_id: recorded.source.id,
        processing_state: recorded.source.processing_state,
        queued: Boolean(recorded.job),
      };
    },

    async processSignal(signalId, overrides = {}) {
      await requireControls("ingestion", "master_inbox");
      const source = await repository.sourceForClassification({
        signalId: required(signalId, "signal_id", 100),
        candidateId: overrides.candidateId,
        roleIds: overrides.roleIds,
        executionFence: overrides.executionFence,
      });
      if (!source) throw problem("source_not_found", "The source event was not found.", 404);
      if (source.classification_skipped) {
        return { signal_id: source.id, existing: true, pairs: [], created_count: 0, ignored_later: true };
      }
      if (!source.encrypted_body_object_key) throw problem("source_private_payload_missing", "The private source payload is unavailable.", 409);
      const stored = await blobs.readPrivateObject(source.encrypted_body_object_key, { env });
      let envelope;
      try { envelope = JSON.parse(stored.bytes.toString("utf8")); }
      catch { throw problem("encrypted_payload_invalid", "The private source payload is invalid.", 409); }
      const privatePayload = decryptJson(envelope, { env, context: `event:${source.event_id}` });
      const event = {
        ...source.envelope,
        ...privatePayload,
        offered_roles: Array.isArray(overrides.roleIds) && overrides.roleIds.length
          ? source.offered_roles.filter((role) => overrides.roleIds.includes(role.role_id))
          : source.offered_roles,
      };
      try {
        const result = await classifier(event, { env, fetchImpl, now });
        if (typeof overrides.beforeApply === "function") await overrides.beforeApply();
        return repository.applyClassifiedSignal({
          signalId: source.id,
          candidateId: overrides.candidateId || source.envelope?.candidate_resolution?.candidate_user_id,
          decisions: result.decisions,
          attempts: result.attempts.map((attempt) => ({ ...attempt, duration_ms: result.duration_ms })),
          executionFence: overrides.executionFence,
        });
      } catch (error) {
        if (error.code === "classification_failed") {
          if (typeof overrides.beforeApply === "function") await overrides.beforeApply();
          return repository.routeClassificationFailure({
            signalId: source.id,
            attempts: Array.isArray(error.attempts) ? error.attempts : [],
            spent: Number(error.spent) || 0,
            safeDetail: "Both approved classifier paths failed safely.",
            executionFence: overrides.executionFence,
          });
        }
        throw error;
      }
    },

    async command({ actorEmail, idempotencyKey, body }) {
      const action = required(body?.action, "action", 80);
      const generationActions = new Set(["add_candidate", "duplicate", "regenerate", "retry_preparation", "create_upload_intent", "complete_upload"]);
      const destinationNeedsGeneration = new Set(["correct", "resolve_review"]).has(action) && body?.destination === "interested";
      await requireControls("ui", ...(generationActions.has(action) || destinationNeedsGeneration ? ["generation"] : []));
      if (action === "add_candidate") {
        return repository.addCandidate({ actorEmail, idempotencyKey, candidateId: required(body.candidate_id, "candidate_id", 200), roleId: required(body.role_id, "role_id", 200) });
      }
      if (action === "duplicate") {
        const source = await repository.pair(required(body.case_id, "case_id", 100));
        if (!source) throw problem("pair_not_found", "The candidate-role item was not found.", 404);
        if (Number(source.state_version) !== expectedVersion(body.expected_version)) throw problem("stale_pair_version", "The candidate-role item changed before this action was committed.", 409, { case_id: source.id, state_version: Number(source.state_version) });
        return repository.addCandidate({ actorEmail, idempotencyKey, candidateId: source.candidate_user_id, roleId: required(body.role_id, "role_id", 200), sourcePairId: source.id, action: "duplicate" });
      }
      if (action === "correct") {
        return repository.transition({ actorEmail, idempotencyKey, pairId: required(body.case_id, "case_id", 100), expectedVersion: expectedVersion(body.expected_version), destination: required(body.destination, "destination", 40), note: required(body.note, "note", 500), action });
      }
      if (action === "resolve_review") {
        if (!body.case_id && body.signal_id) {
          if (!body.candidate_id) throw problem("candidate_selection_required", "Select the matching Paraform candidate before resolving this source event.", 409);
          return repository.bindUnresolvedSignal({
            actorEmail, idempotencyKey, signalId: required(body.signal_id, "signal_id", 100),
            candidateId: required(body.candidate_id, "candidate_id", 200),
            roleIds: Array.isArray(body.role_ids) ? body.role_ids : [],
            note: required(body.note, "note", 500),
          });
        }
        const pairId = required(body.case_id, "case_id", 100);
        const version = expectedVersion(body.expected_version);
        const note = required(body.note, "note", 500);
        if (body.destination === "needs_review") return repository.keepReview({ actorEmail, idempotencyKey, pairId, expectedVersion: version, note });
        return repository.transition({ actorEmail, idempotencyKey, pairId, expectedVersion: version, destination: required(body.destination, "destination", 40), note, action });
      }
      if (["recheck", "retry_preparation"].includes(action)) {
        return repository.enqueuePairAction({
          actorEmail, idempotencyKey, pairId: required(body.case_id, "case_id", 100),
          expectedVersion: expectedVersion(body.expected_version), action,
          kind: action === "recheck" ? "recheck_pair" : "prepare_resume",
          requiredControl: action === "recheck" ? "ingestion" : "generation",
          checkpoint: { trigger_kind: action === "retry_preparation" ? "retry" : undefined },
        });
      }
      if (action === "retry_classification") {
        return repository.enqueueSignalAction({ actorEmail, idempotencyKey, signalId: required(body.signal_id, "signal_id", 100), action });
      }
      if (action === "create_upload_intent") return service.createUploadIntent({ actorEmail, idempotencyKey, body });
      if (action === "complete_upload") return service.completeUpload({ actorEmail, idempotencyKey, body });
      if (action === "regenerate") {
        const pairId = required(body.case_id, "case_id", 100);
        const version = expectedVersion(body.expected_version);
        const evidenceBasis = required(body.evidence_basis, "evidence_basis", 40);
        if (!new Set(["sourced", "correction"]).has(evidenceBasis)) throw problem("evidence_basis_invalid", "The evidence basis is invalid.", 400);
        const sourceNote = required(body.source_note, "source_note", 500);
        const context = clean(body.candidate_context, 12_000);
        const instructions = clean(body.instructions, 4_000);
        const evidenceEnvelope = context ? encryptJson({ text: context }, { env, context: `supplement:${pairId}:evidence` }) : null;
        const instructionEnvelope = instructions ? encryptJson({ text: instructions }, { env, context: `supplement:${pairId}:instruction` }) : null;
        const requestedUploads = Array.isArray(body.uploads)
          ? [...new Set(body.uploads.map((value) => required(value, "supplement_id", 100)))]
          : [];
        if (requestedUploads.length > 5) throw problem("supplement_count_exceeded", "Choose at most five evidence files.", 400);
        return repository.regenerate({
          actorEmail, idempotencyKey, pairId, expectedVersion: version,
          evidenceEncrypted: evidenceEnvelope ? Buffer.from(JSON.stringify(evidenceEnvelope)) : null,
          evidenceDigest: context ? sha256(context) : null,
          evidenceBasis, sourceNote,
          instructionsEncrypted: instructionEnvelope ? Buffer.from(JSON.stringify(instructionEnvelope)) : null,
          uploads: requestedUploads,
        });
      }
      throw problem("action_not_supported", "This Submissions V2 action is not supported.", 400);
    },

    async createUploadIntent({ actorEmail, idempotencyKey, body }) {
      await requireControls("ui", "generation");
      const pairId = required(body.case_id, "case_id", 100);
      const version = expectedVersion(body.expected_version);
      const pair = await repository.pair(pairId);
      if (!pair) throw problem("pair_not_found", "The candidate-role item was not found.", 404);
      if (Number(pair.state_version) !== version) throw problem("stale_pair_version", "The candidate-role item changed before this action was committed.", 409, { case_id: pair.id, state_version: Number(pair.state_version) });
      const contentType = required(body.content_type, "content_type", 100).toLowerCase();
      const size = Number(body.size);
      if (!ALLOWED_UPLOADS.has(contentType)) throw problem("upload_type_invalid", "Use a PDF, PNG, JPEG, or WebP file.", 400);
      if (!Number.isInteger(size) || size < 1 || size > 10 * 1024 * 1024) throw problem("upload_size_invalid", "Each file must be 10 MB or smaller.", 400);
      const filename = required(body.filename, "filename", 255);
      required(idempotencyKey, "idempotency_key", 200);
      const reservationId = randomUUID();
      const pathname = privatePath("supplements", reservationId);
      const expiresAt = now() + 5 * 60_000;
      const reservation = await repository.reserveUploadIntent({
        actorEmail, idempotencyKey, pairId, expectedVersion: version,
        reservationId, objectKey: pathname, contentType, size, filename, expiresAt,
      });
      const prepared = await blobs.createPresignedUpload({ pathname: reservation.object_key, contentType, maximumSizeInBytes: size, validForMs: 5 * 60_000 }, { env });
      const uploadId = signUploadIntent({
        reservation_id: reservation.reservation_id, pathname: reservation.object_key,
        pair_id: pairId, expected_version: version, email: actorEmail,
        content_type: contentType, size, filename, expires_at: Math.min(expiresAt, Date.parse(reservation.expires_at)),
      }, { env });
      return { upload_id: uploadId, ...prepared };
    },

    async completeUpload({ actorEmail, idempotencyKey, body }) {
      await requireControls("ui", "generation");
      const intent = verifyUploadIntent(required(body.upload_id, "upload_id", 8_000), { actorEmail, env, now: now() });
      const pairId = required(body.case_id, "case_id", 100);
      if (pairId !== intent.pair_id || expectedVersion(body.expected_version) !== Number(intent.expected_version)) throw problem("upload_intent_mismatch", "The upload intent does not match this item.", 409);
      const inspected = await blobs.inspectPrivateObject(intent.pathname, { env });
      if (inspected.content_type !== intent.content_type || Number(inspected.size) !== Number(intent.size)) throw problem("upload_readback_mismatch", "The uploaded file did not match the approved intent.", 409);
      const object = await blobs.readPrivateObject(intent.pathname, { env });
      const digestValue = sha256(object.bytes);
      const evidenceBasis = required(body.evidence_basis, "evidence_basis", 40);
      if (!new Set(["sourced", "correction"]).has(evidenceBasis)) throw problem("evidence_basis_invalid", "The evidence basis is invalid.", 400);
      const sourceNote = required(body.source_note, "source_note", 500);
      return repository.addSupplement({
        actorEmail, idempotencyKey, pairId, expectedVersion: Number(intent.expected_version),
        reservationId: intent.reservation_id,
        objectKey: intent.pathname, mimeType: intent.content_type, originalName: intent.filename,
        sizeBytes: Number(intent.size), digestValue,
        evidenceBasis, sourceNote,
      });
    },

    async issueDownload({ actorEmail, idempotencyKey, pairId, body }) {
      await requireControls("ui");
      const expiresAt = now() + 5 * 60_000;
      const ticketId = randomUUID();
      const result = await repository.issueDownload({
        actorEmail, idempotencyKey, pairId: required(pairId, "pair_id", 100),
        expectedVersion: expectedVersion(body?.expected_version), ticketId, expiresAt,
      });
      const ticket = signDownloadTicket({
        ticket_id: result.ticket_id, artifact_id: result.artifact.id, pair_id: pairId,
        pathname: result.artifact.private_object_key, email: actorEmail, expires_at: Date.parse(result.expires_at), disposition: "attachment",
      }, { env });
      return {
        url: `/api/submissions-v2/download?ticket=${encodeURIComponent(ticket)}&display=inline`,
        filename: safeFilename({ candidateName: result.candidate_name || result.candidate_user_id, companyName: result.company_name, roleTitle: result.role_title, createdAt: result.artifact.created_at, artifactVersion: result.artifact.artifact_version }),
        expires_at: result.expires_at,
      };
    },

    async download({ actorEmail, ticket }) {
      const payload = verifyDownloadTicket(required(ticket, "ticket", 8_000), { identityEmail: actorEmail, env, now: now() });
      if (payload.disposition !== "archive_retrieval") await requireControls("ui");
      let artifact = null;
      try {
        artifact = await repository.downloadableArtifact({ artifactId: payload.artifact_id, pairId: payload.pair_id, pathname: payload.pathname });
        if (!artifact) throw problem("artifact_not_found", "The archived resume is unavailable.", 404);
        const object = await blobs.readPrivateObject(payload.pathname, { env });
        if (sha256(object.bytes) !== artifact.digest) throw problem("artifact_digest_mismatch", "The archived resume failed integrity verification.", 409);
        await repository.redeemDownloadTicket({ ticketId: payload.ticket_id, actorEmail, artifactId: artifact.id, pairId: artifact.pair_id, pathname: payload.pathname, disposition: payload.disposition === "archive_retrieval" ? "archive_retrieval" : "attachment", requestDigest: sha256(ticket) });
        return { bytes: object.bytes, content_type: "application/pdf", filename: safeFilename({ candidateName: artifact.candidate_name, companyName: artifact.company_name, roleTitle: artifact.role_title, createdAt: artifact.created_at, artifactVersion: artifact.artifact_version }) };
      } catch (error) {
        await repository.auditDownloadFailure({ ticketId: payload.ticket_id, actorEmail, artifactId: artifact?.id || payload.artifact_id, pairId: artifact?.pair_id || payload.pair_id, disposition: payload.disposition === "archive_retrieval" ? "archive_retrieval" : "attachment", code: error.code || "download_failed", requestDigest: sha256(ticket) }).catch(() => {});
        throw error;
      }
    },

    async openSubmit({ actorEmail, idempotencyKey, pairId, body }) {
      await requireControls("ui");
      return repository.openSubmit({ actorEmail, idempotencyKey, pairId: required(pairId, "pair_id", 100), expectedVersion: expectedVersion(body?.expected_version) });
    },

    async archive({ actorEmail, input = {} } = {}) {
      const candidateId = clean(input.candidate_id, 200) || null;
      const roleId = clean(input.role_id, 200) || null;
      const artifactId = clean(input.artifact_id, 100) || null;
      if (artifactId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(artifactId)) throw problem("artifact_id_invalid", "The archive artifact id is invalid.", 400);
      const version = input.version == null || input.version === "" ? null : Number(input.version);
      if (version !== null && (!Number.isInteger(version) || version < 1)) throw problem("version_invalid", "The archive version must be a positive integer.", 400);
      const date = clean(input.date, 40) || null;
      if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw problem("date_invalid", "The archive date must use YYYY-MM-DD.", 400);
      if (!candidateId && !roleId && !artifactId && !date && version === null) throw problem("archive_filter_required", "Provide a candidate, role, artifact, date, or version.", 400);
      const ticketId = randomUUID();
      const expiresAt = now() + 5 * 60_000;
      const result = await repository.issueArchiveRetrieval({ actorEmail, candidateId, roleId, artifactId, date, version, ticketId, expiresAt });
      if (!result) throw problem("artifact_not_found", "No archived resume matched those filters.", 404);
      const ticket = signDownloadTicket({
        ticket_id: result.ticket_id, artifact_id: result.artifact.id, pair_id: result.artifact.pair_id,
        pathname: result.artifact.private_object_key, email: actorEmail, expires_at: Date.parse(result.expires_at), disposition: "archive_retrieval",
      }, { env });
      return {
        artifact: {
          id: result.artifact.id, candidate_id: result.artifact.candidate_user_id, role_id: result.artifact.role_id,
          version: Number(result.artifact.artifact_version), created_at: result.artifact.created_at,
        },
        url: `/api/submissions-v2/download?ticket=${encodeURIComponent(ticket)}`,
        filename: safeFilename({ candidateName: result.artifact.candidate_name, companyName: result.artifact.company_name, roleTitle: result.artifact.role_title, createdAt: result.artifact.created_at, artifactVersion: result.artifact.artifact_version }),
        expires_at: result.expires_at,
      };
    },

    async softDeleteCase({ actorEmail, idempotencyKey, pairId, body }) {
      const caseId = required(pairId, "pair_id", 100);
      const version = expectedVersion(body?.expected_version);
      const reason = required(body?.reason, "reason", 500);
      const reservation = await repository.reserveCaseRetentionCommand({
        actorEmail, action: "soft_delete_case", idempotencyKey,
        pairId: caseId, expectedVersion: version, reason,
      });
      if (reservation.replay) return { ...reservation.result, replay: true };
      try {
        const snapshot = await repository.caseDeletionManifest({ pairId: caseId, expectedVersion: version });
        const deletionId = randomUUID();
        const requestedAt = new Date(now()).toISOString();
        const recoveryDeadline = new Date(Date.parse(requestedAt) + 30 * 24 * 60 * 60 * 1_000).toISOString();
        const manifest = {
          manifest_version: 1,
          deletion_id: deletionId,
          pair_id: caseId,
          requested_at: requestedAt,
          recovery_deadline: recoveryDeadline,
          reason,
          reason_digest: sha256(reason),
          snapshot,
        };
        const caseHmac = tombstoneCaseHmac(caseId, env);
        const candidateHmac = candidateSuppressionDigest(snapshot.pair.candidate_user_id);
        const context = `case-deletion:${deletionId}`;
        const envelope = encryptJson(manifest, { env, context });
        const manifestBytes = Buffer.from(JSON.stringify(envelope));
        const manifestDigest = sha256(manifestBytes);
        const objectKey = privatePath("case_manifests", deletionId);
        const objectReservation = await repository.reservePrivateObject({
          reservationId: privateReservationId(objectKey), objectKey, purpose: "case_manifest", ownerRef: caseId,
          expectedDigest: manifestDigest, expiresAt: now() + 24 * 60 * 60_000,
        });
        await repository.renewPrivateObjectWrite({ reservationId: objectReservation.id, objectKey, expectedDigest: manifestDigest, writeFencingToken: objectReservation.write_fencing_token });
        await blobs.putPrivateObject(objectKey, manifestBytes, "application/json", { env });
        return await repository.softDeleteCase({
          actorEmail, commandId: reservation.command_id, pairId: caseId, expectedVersion: version,
          deletionId, requestedAt, recoveryDeadline, encryptedManifestObjectKey: objectKey,
          manifestDigest, tombstoneCaseHmac: caseHmac, tombstoneCandidateHmac: candidateHmac, manifest,
          objectReservationId: objectReservation.id,
          objectWriteFencingToken: objectReservation.write_fencing_token,
        });
      } catch (error) {
        await repository.failCaseRetentionCommand({ commandId: reservation.command_id, errorCode: error.code || "case_delete_failed" }).catch(() => {});
        throw error;
      }
    },

    async restoreCase({ actorEmail, idempotencyKey, pairId, body }) {
      const caseId = required(pairId, "pair_id", 100);
      const version = expectedVersion(body?.expected_version);
      const reservation = await repository.reserveCaseRetentionCommand({
        actorEmail, action: "restore_case", idempotencyKey,
        pairId: caseId, expectedVersion: version,
      });
      if (reservation.replay) return { ...reservation.result, replay: true };
      try {
        const deletion = await repository.caseDeletionForRestore({ pairId: caseId });
        if (!deletion) throw problem("case_deletion_not_found", "No recoverable case deletion was found.", 404);
        if (Number(deletion.state_version) !== version) {
          throw problem("stale_pair_version", "The candidate-role item changed before this action was committed.", 409, { case_id: caseId, state_version: Number(deletion.state_version) });
        }
        if (Date.parse(deletion.recovery_deadline) <= now()) throw problem("case_recovery_expired", "The 30-day case recovery window has expired.", 410);
        const stored = await blobs.readPrivateObject(deletion.encrypted_manifest_object_key, { env });
        if (sha256(stored.bytes) !== deletion.manifest_digest) throw problem("case_manifest_digest_mismatch", "The encrypted recovery manifest failed integrity verification.", 409);
        let envelope;
        try { envelope = JSON.parse(stored.bytes.toString("utf8")); }
        catch { throw problem("case_manifest_invalid", "The encrypted recovery manifest is invalid.", 409); }
        const manifest = decryptJson(envelope, { env, context: `case-deletion:${deletion.id}` });
        return await repository.restoreCase({
          actorEmail, commandId: reservation.command_id, pairId: caseId,
          expectedVersion: version, deletionId: deletion.id, manifest,
        });
      } catch (error) {
        await repository.failCaseRetentionCommand({ commandId: reservation.command_id, errorCode: error.code || "case_restore_failed" }).catch(() => {});
        throw error;
      }
    },

    async controls() {
      const durable = await repository.runtimeControls();
      return { durable, effective: effectiveControls(environmentControls(env), durable) };
    },

    async setControls({ actorEmail, idempotencyKey, body }) {
      const reason = required(body?.reason, "reason", 500);
      const flags = ["ui", "ingestion", "generation", "master_inbox", "curated"];
      for (const flag of flags) if (typeof body?.[flag] !== "boolean") throw problem("control_value_invalid", `${flag} must be true or false.`, 400);
      const durable = await repository.setControls({
        actorEmail, reason, ui: body.ui, ingestion: body.ingestion,
        generation: body.generation, masterInbox: body.master_inbox, curated: body.curated, idempotencyKey,
      });
      return { durable, effective: effectiveControls(environmentControls(env), durable) };
    },

    async tick() {
      const instant = new Date(now());
      const minuteKey = instant.toISOString().slice(0, 16);
      const fiveMinuteKey = `${minuteKey.slice(0, 15)}${Math.floor(Number(minuteKey.slice(15, 16)) / 5) * 5}`;
      const hourKey = minuteKey.slice(0, 13);
      const pacific = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
        timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", hourCycle: "h23",
      }).formatToParts(instant).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
      const pacificDayKey = `${pacific.year}-${pacific.month}-${pacific.day}`;
      const pacificHour = Number(pacific.hour);
      return repository.scheduleTick({
        minuteKey, fiveMinuteKey, hourKey, pacificDayKey,
        dailyDigestDue: pacificHour >= 8,
        nightlyDue: pacificHour >= 1,
        purgeDue: pacificHour >= 2,
        controlCeiling: environmentControls(env),
      });
    },

    async health() {
      const [health, durable] = await Promise.all([repository.health(), repository.runtimeControls()]);
      return {
        health: publicHealth(health), sources: health.sources || {},
        controls: effectiveControls(environmentControls(env), durable),
      };
    },
  };
  return service;
}

export const serviceInternals = Object.freeze({ trustedSignalUrl, safeFilename, CURRENT_MASTER_INBOX_CONTRACT });
