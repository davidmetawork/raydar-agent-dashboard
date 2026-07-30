// Authenticated, default-off receipt transport for Human Intro Calendar facts.
//
// This route binds one signed Calendar semantic revision to an existing
// durable hi- intake and immutably retains it. It does not mutate the job,
// infer attendance, accept outcomes, enumerate source records, construct a
// source head, or grant source/Phase 4 authority.

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
  HumanIntroCalendarReceiptStoreError,
  humanIntroCalendarReceiptStoreConfigured,
  retainHumanIntroCalendarReceipt,
} from "./_lib/human-intro-calendar-receipt-store.mjs";
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

export const HUMAN_INTRO_CALENDAR_RECEIPT_INGEST_ENV =
  "PARAAI_HUMAN_INTRO_CALENDAR_RECEIPT_INGEST_ENABLED";

const MAX_BODY_BYTES = 8_192;

function json(value, status = 200) {
  return Response.json(value, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

export function humanIntroCalendarReceiptIngestEnabled(
  env = process.env,
) {
  return env?.[HUMAN_INTRO_CALENDAR_RECEIPT_INGEST_ENV] === "1";
}

function parseReceipt(rawBody) {
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
  approvedKey,
}) {
  const calendar = projection.calendarObservation;
  if (
    calendar === null
    || calendar.receiptDigest !== retention.receiptDigest
    || calendar.eventRevision !== retention.eventRevision
    || calendar.sourceId !== retention.sourceId
    || calendar.verificationKeyCommitmentDigest
      !== retention.approvedKeyCommitmentDigest
    || calendar.verificationKeyCommitmentDigest
      !== approvedKey.keyCommitment
  ) {
    throw new Error("calendar retention continuity failed");
  }
  return Object.freeze({
    ...publicEvidence,
    version: "human-intro-calendar-retained-evidence-v1",
    receiptDigest: retention.receiptDigest,
    retentionRevisionDigest: semanticDigest(
      "phase4-human-intro-calendar-retention-revision-v1",
      retention.recordRevisionSha1,
    ),
    approvedReceiptKeyAvailable: true,
    receiptProducerAvailable: true,
    durableSignedReceiptAvailable: true,
    signedOutcomeAttestationVerified: false,
    sourceHeadAvailable: false,
    sourceExhaustivenessAvailable: false,
    occurredEvidenceAvailable: false,
    candidateIdentityResolutionAvailable: false,
    sourceAuthorityAvailable: false,
    pinnable: false,
  });
}

export async function handleHumanIntroCalendarReceipt(request, {
  secret = process.env.PARAAI_RESUME_SIGNAL_SECRET,
  verify = verifyResumeSignal,
  enabled = humanIntroCalendarReceiptIngestEnabled(),
  loadApprovedKey =
    loadApprovedHumanIntroCalendarReceiptKey,
  hasReceiptStore =
    humanIntroCalendarReceiptStoreConfigured,
  loadJob = getJob,
  retain = retainHumanIntroCalendarReceipt,
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
      error: "human_intro_calendar_receipt_disabled",
    }, 503);
  }
  const receipt = parseReceipt(rawBody);
  if (!receipt || !Number.isFinite(nowMs)) {
    return json({ ok: false, error: "invalid_request" }, 400);
  }
  let approvedKey;
  try {
    approvedKey = loadApprovedKey();
  } catch {
    return json({
      ok: false,
      error: "calendar_receipt_key_unavailable",
    }, 503);
  }
  if (!hasReceiptStore()) {
    return json({
      ok: false,
      error: "calendar_receipt_store_unavailable",
    }, 503);
  }
  const sourceId = String(receipt.sourceId || "");
  let jobId;
  try {
    jobId = humanIntroJobId(sourceId);
  } catch {
    return json({ ok: false, error: "invalid_request" }, 400);
  }
  let job;
  try {
    job = await loadJob(jobId);
  } catch {
    return json({
      ok: false,
      error: "calendar_receipt_unavailable",
    }, 503);
  }
  if (!job) {
    return json({
      ok: false,
      error: "human_intro_not_found",
      jobId,
    }, 404);
  }
  let projection;
  let publicEvidence;
  try {
    const receiptOptions = {
      decisionBoundaryAt: receipt.observedAt,
      calendarReceiptKey: approvedKey.key,
      calendarReceiptKeyId: approvedKey.keyId,
      outcomeReceiptKey: null,
      outcomeReceiptKeyId: null,
    };
    projection = normalizeHumanIntroAuthoritativeEvidence(
      job,
      {
        calendarObservation: receipt,
        outcomeAttestation: null,
      },
      receiptOptions,
    );
    publicEvidence = humanIntroAuthoritativeSourceEvidence(
      job,
      {
        calendarObservation: receipt,
        outcomeAttestation: null,
      },
      receiptOptions,
    );
    if (
      projection.calendarObservation
        ?.verificationKeyCommitmentDigest
        !== approvedKey.keyCommitment
    ) {
      throw new Error("approved key commitment mismatch");
    }
  } catch {
    return json({
      ok: false,
      error: "calendar_receipt_invalid",
      jobId,
    }, 409);
  }
  let retention;
  let evidence;
  try {
    retention = await retain({
      approvedKeyCommitmentDigest:
        approvedKey.keyCommitment,
      eventRevision:
        projection.calendarObservation.eventRevision,
      jobId,
      receipt,
      receiptDigest:
        projection.calendarObservation.receiptDigest,
      sourceId,
    });
    evidence = durableEvidence({
      projection,
      publicEvidence,
      retention,
      approvedKey,
    });
  } catch (error) {
    if (
      error instanceof HumanIntroCalendarReceiptStoreError
      && error.code
        === "HUMAN_INTRO_CALENDAR_RECEIPT_STORE_CONFLICT"
    ) {
      return json({
        ok: false,
        error: "calendar_receipt_conflict",
        jobId,
      }, 409);
    }
    return json({
      ok: false,
      error: "calendar_receipt_unavailable",
      jobId,
    }, 503);
  }
  return json({
    ok: true,
    jobId,
    sourceId,
    eventRevision: retention.eventRevision,
    receiptDigest: retention.receiptDigest,
    created: retention.created,
    duplicate: retention.duplicate,
    evidence,
  }, retention.created ? 202 : 200);
}

export default {
  async fetch(request) {
    return handleHumanIntroCalendarReceipt(request);
  },
};
