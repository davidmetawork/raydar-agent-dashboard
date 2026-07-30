// Authenticated, default-off transport for Human Intro outcome attestations.
//
// This route joins one signed human outcome to an already retained signed
// Calendar revision and durable hi- intake, then immutably retains the joined
// proof. It does not mutate the job, resolve identity, enumerate records,
// construct a source head, grant source/Phase 4 authority, or activate import.

import {
  createHash,
} from "node:crypto";

import {
  humanIntroJobId,
} from "./_lib/human-intro.mjs";
import {
  loadApprovedHumanIntroCalendarReceiptKey,
} from "./_lib/human-intro-calendar-receipt-key.mjs";
import {
  humanIntroCalendarReceiptStoreConfigured,
  readHumanIntroCalendarReceipt,
} from "./_lib/human-intro-calendar-receipt-store.mjs";
import {
  loadApprovedHumanIntroOutcomeReceiptKey,
} from "./_lib/human-intro-outcome-receipt-key.mjs";
import {
  HumanIntroOutcomeReceiptStoreError,
  humanIntroOutcomeReceiptStoreConfigured,
  retainHumanIntroOutcomeReceipt,
} from "./_lib/human-intro-outcome-receipt-store.mjs";
import {
  humanIntroAuthoritativeSourceEvidence,
  normalizeHumanIntroAuthoritativeEvidence,
} from "./_lib/source-human-intro-authoritative-evidence.mjs";
import {
  requestPathname,
  verifyResumeSignal,
} from "./_lib/resume-signal.mjs";
import {
  getJob,
} from "./_lib/store.mjs";

export const config = { maxDuration: 30 };

export const HUMAN_INTRO_OUTCOME_RECEIPT_INGEST_ENV =
  "PARAAI_HUMAN_INTRO_OUTCOME_RECEIPT_INGEST_ENABLED";

const MAX_BODY_BYTES = 8_192;

function json(value, status = 200) {
  return Response.json(value, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

export function humanIntroOutcomeReceiptIngestEnabled(
  env = process.env,
) {
  return env?.[HUMAN_INTRO_OUTCOME_RECEIPT_INGEST_ENV] === "1";
}

function parseAttestation(rawBody) {
  if (
    typeof rawBody !== "string"
    || Buffer.byteLength(rawBody, "utf8") > MAX_BODY_BYTES
  ) {
    return null;
  }
  try {
    const parsed = JSON.parse(rawBody);
    if (
      !parsed
      || typeof parsed !== "object"
      || Array.isArray(parsed)
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function semanticDigest(namespace, value) {
  return createHash("sha256")
    .update(namespace)
    .update("\0")
    .update(JSON.stringify(value))
    .digest("hex");
}

function durableEvidence({
  projection,
  publicEvidence,
  retention,
  calendarRetention,
  approvedCalendarKey,
  approvedOutcomeKey,
}) {
  const calendar = projection.calendarObservation;
  const outcome = projection.outcomeAttestation;
  if (
    calendar === null
    || outcome === null
    || calendar.receiptDigest
      !== calendarRetention.receiptDigest
    || calendar.eventRevision
      !== retention.calendarEventRevision
    || calendar.sourceId !== retention.sourceId
    || outcome.receiptDigest
      !== retention.outcomeReceiptDigest
    || outcome.calendarEventRevision
      !== retention.calendarEventRevision
    || calendarRetention.recordRevisionSha1
      !== retention.calendarRetentionRevisionSha1
    || calendar.verificationKeyCommitmentDigest
      !== approvedCalendarKey.keyCommitment
    || outcome.verificationKeyCommitmentDigest
      !== approvedOutcomeKey.keyCommitment
    || retention.approvedCalendarKeyCommitmentDigest
      !== approvedCalendarKey.keyCommitment
    || retention.approvedOutcomeKeyCommitmentDigest
      !== approvedOutcomeKey.keyCommitment
  ) {
    throw new Error("outcome retention continuity failed");
  }
  return Object.freeze({
    ...publicEvidence,
    version: "human-intro-outcome-retained-evidence-v1",
    calendarReceiptDigest: calendar.receiptDigest,
    outcomeReceiptDigest: outcome.receiptDigest,
    calendarRetentionRevisionDigest: semanticDigest(
      "phase4-human-intro-calendar-retention-revision-v1",
      calendarRetention.recordRevisionSha1,
    ),
    outcomeRetentionRevisionDigest: semanticDigest(
      "phase4-human-intro-outcome-retention-revision-v1",
      retention.recordRevisionSha1,
    ),
    approvedReceiptKeyAvailable: true,
    approvedCalendarReceiptKeyAvailable: true,
    approvedOutcomeReceiptKeyAvailable: true,
    receiptProducerAvailable: true,
    durableSignedReceiptAvailable: true,
    signedOutcomeAttestationVerified: true,
    sourceHeadAvailable: false,
    sourceExhaustivenessAvailable: false,
    candidateIdentityResolutionAvailable: false,
    sourceAuthorityAvailable: false,
    pinnable: false,
  });
}

export async function handleHumanIntroOutcomeReceipt(request, {
  secret = process.env.PARAAI_RESUME_SIGNAL_SECRET,
  verify = verifyResumeSignal,
  enabled = humanIntroOutcomeReceiptIngestEnabled(),
  loadApprovedCalendarKey =
    loadApprovedHumanIntroCalendarReceiptKey,
  loadApprovedOutcomeKey =
    loadApprovedHumanIntroOutcomeReceiptKey,
  hasCalendarReceiptStore =
    humanIntroCalendarReceiptStoreConfigured,
  hasOutcomeReceiptStore =
    humanIntroOutcomeReceiptStoreConfigured,
  loadJob = getJob,
  readCalendar = readHumanIntroCalendarReceipt,
  retain = retainHumanIntroOutcomeReceipt,
  now = () => Date.now(),
} = {}) {
  if (request.method !== "POST") {
    return json({ ok: false, error: "POST_only" }, 405);
  }
  const rawBody = await request.text();
  const nowMs = Number(now());
  try {
    verify({
      secret,
      headers: request.headers,
      method: request.method,
      pathname: requestPathname(request),
      rawBody,
      nowMs,
    });
  } catch {
    return json({ ok: false, error: "unauthorized" }, 401);
  }
  if (!enabled) {
    return json({
      ok: false,
      error: "human_intro_outcome_receipt_disabled",
    }, 503);
  }
  const attestation = parseAttestation(rawBody);
  if (!attestation || !Number.isFinite(nowMs)) {
    return json({ ok: false, error: "invalid_request" }, 400);
  }
  let approvedCalendarKey;
  let approvedOutcomeKey;
  try {
    approvedCalendarKey = loadApprovedCalendarKey();
  } catch {
    return json({
      ok: false,
      error: "calendar_receipt_key_unavailable",
    }, 503);
  }
  try {
    approvedOutcomeKey = loadApprovedOutcomeKey();
  } catch {
    return json({
      ok: false,
      error: "outcome_receipt_key_unavailable",
    }, 503);
  }
  if (
    !hasCalendarReceiptStore()
    || !hasOutcomeReceiptStore()
  ) {
    return json({
      ok: false,
      error: "outcome_receipt_store_unavailable",
    }, 503);
  }
  const sourceId = String(attestation.sourceId || "");
  const calendarEventRevision =
    String(attestation.calendarEventRevision || "");
  let jobId;
  try {
    jobId = humanIntroJobId(sourceId);
  } catch {
    return json({ ok: false, error: "invalid_request" }, 400);
  }
  let job;
  let calendarRetention;
  try {
    [job, calendarRetention] = await Promise.all([
      loadJob(jobId),
      readCalendar({
        sourceId,
        eventRevision: calendarEventRevision,
      }),
    ]);
  } catch {
    return json({
      ok: false,
      error: "outcome_receipt_unavailable",
      jobId,
    }, 503);
  }
  if (!job) {
    return json({
      ok: false,
      error: "human_intro_not_found",
      jobId,
    }, 404);
  }
  if (!calendarRetention) {
    return json({
      ok: false,
      error: "calendar_receipt_not_retained",
      jobId,
    }, 409);
  }
  let projection;
  let publicEvidence;
  try {
    if (
      calendarRetention.sourceId !== sourceId
      || calendarRetention.eventRevision
        !== calendarEventRevision
      || calendarRetention.approvedKeyCommitmentDigest
        !== approvedCalendarKey.keyCommitment
    ) {
      throw new Error("retained Calendar continuity failed");
    }
    const receiptOptions = {
      decisionBoundaryAt: attestation.attestedAt,
      calendarReceiptKey: approvedCalendarKey.key,
      calendarReceiptKeyId: approvedCalendarKey.keyId,
      outcomeReceiptKey: approvedOutcomeKey.key,
      outcomeReceiptKeyId: approvedOutcomeKey.keyId,
    };
    const receipts = {
      calendarObservation: calendarRetention.receipt,
      outcomeAttestation: attestation,
    };
    projection = normalizeHumanIntroAuthoritativeEvidence(
      job,
      receipts,
      receiptOptions,
    );
    publicEvidence = humanIntroAuthoritativeSourceEvidence(
      job,
      receipts,
      receiptOptions,
    );
  } catch {
    return json({
      ok: false,
      error: "outcome_receipt_invalid",
      jobId,
    }, 409);
  }
  let retention;
  let evidence;
  try {
    retention = await retain({
      approvedCalendarKeyCommitmentDigest:
        approvedCalendarKey.keyCommitment,
      approvedOutcomeKeyCommitmentDigest:
        approvedOutcomeKey.keyCommitment,
      calendarEventRevision,
      calendarReceiptDigest:
        projection.calendarObservation.receiptDigest,
      calendarRetentionRevisionSha1:
        calendarRetention.recordRevisionSha1,
      jobId,
      outcomeAttestation: attestation,
      outcomeReceiptDigest:
        projection.outcomeAttestation.receiptDigest,
      sourceId,
    });
    evidence = durableEvidence({
      projection,
      publicEvidence,
      retention,
      calendarRetention,
      approvedCalendarKey,
      approvedOutcomeKey,
    });
  } catch (error) {
    if (
      error instanceof HumanIntroOutcomeReceiptStoreError
      && error.code
        === "HUMAN_INTRO_OUTCOME_RECEIPT_STORE_CONFLICT"
    ) {
      return json({
        ok: false,
        error: "outcome_receipt_conflict",
        jobId,
      }, 409);
    }
    return json({
      ok: false,
      error: "outcome_receipt_unavailable",
      jobId,
    }, 503);
  }
  return json({
    ok: true,
    jobId,
    sourceId,
    calendarEventRevision,
    outcomeReceiptDigest: retention.outcomeReceiptDigest,
    classification: evidence.classification,
    created: retention.created,
    duplicate: retention.duplicate,
    evidence,
  }, retention.created ? 202 : 200);
}

export default {
  async fetch(request) {
    return handleHumanIntroOutcomeReceipt(request);
  },
};
