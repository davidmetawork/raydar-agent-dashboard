import { safeUpstreamBase } from "../../_lib/safe-upstream.mjs";
import {
  claimPendingPostCallInterestEvents,
  postCallInterestEventKey,
  settlePostCallInterestEvent,
} from "./interest-store.mjs";

const ENDPOINT_PATH = "/api/v1/engagement-events";
const TIMEOUT_MS = 8_000;
const RUN_BUDGET_MS = 45_000;
const MAX_BATCH_SIZE = 5;
const MAX_RESPONSE_BYTES = 64 * 1024;
const TRUE = new Set(["1", "true", "yes", "on"]);

function codedError(code, status = null) {
  const error = new Error(code);
  error.code = code;
  if (Number.isInteger(status)) error.status = status;
  return error;
}

export function postCallInterestProducerEnabled(env = process.env) {
  return TRUE.has(String(
    env.PARAAI_POST_CALL_INTEREST_ENABLED || "",
  ).trim().toLowerCase());
}

function deliveryConfig(env = process.env) {
  const base = safeUpstreamBase(env.POST_CALL_BASE, {
    allowedOrigins: env.POST_CALL_ALLOWED_ORIGINS,
    service: "post_call_interest",
  });
  const key = String(env.POST_CALL_ENGAGEMENT_API_KEY || "").trim();
  if (key.length < 24 || /\s/u.test(key)) {
    throw codedError("POST_CALL_INTEREST_API_KEY_INVALID");
  }
  return Object.freeze({
    endpoint: `${base}${ENDPOINT_PATH}`,
    key,
  });
}

function safeRecord(record) {
  const eventKey = String(record?.eventKey || "").trim();
  const candidateUserId = String(record?.candidateUserId || "").trim();
  const batchId = String(record?.batchId || "").trim();
  const roleId = String(record?.roleId || "").trim();
  const occurredAt = String(record?.occurredAt || "").trim();
  let expectedEventKey = null;
  try {
    expectedEventKey = postCallInterestEventKey(
      candidateUserId,
      batchId,
      roleId,
    );
  } catch {
    throw codedError("POST_CALL_INTEREST_RECORD_INVALID");
  }
  if (
    !eventKey
    || eventKey !== expectedEventKey
    || !Number.isFinite(Date.parse(occurredAt))
    || new Date(occurredAt).toISOString() !== occurredAt
  ) {
    throw codedError("POST_CALL_INTEREST_RECORD_INVALID");
  }
  return Object.freeze({
    eventKey,
    candidateUserId,
    batchId,
    roleId,
    occurredAt,
  });
}

export function postCallInterestRequest(record) {
  const selected = safeRecord(record);
  return Object.freeze({
    eventKey: selected.eventKey,
    body: Object.freeze({
      schemaVersion: 1,
      event: Object.freeze({
        kind: "curated_role_interest",
        candidateId: selected.candidateUserId,
        roleId: selected.roleId,
        batchId: selected.batchId,
        occurredAt: selected.occurredAt,
        evidence: Object.freeze({
          source: "paraai_curated_interest_v1",
          sourceEventId: selected.eventKey,
        }),
      }),
    }),
  });
}

async function boundedJson(response) {
  const contentType = String(
    response?.headers?.get?.("content-type") || "",
  ).toLowerCase();
  if (!contentType.startsWith("application/json")) {
    throw codedError("POST_CALL_INTEREST_RESPONSE_INVALID");
  }
  const declared = String(response?.headers?.get?.("content-length") || "").trim();
  if (declared) {
    const length = Number(declared);
    if (!Number.isSafeInteger(length) || length < 0 || length > MAX_RESPONSE_BYTES) {
      throw codedError("POST_CALL_INTEREST_RESPONSE_TOO_LARGE");
    }
  }
  const raw = await response.text();
  if (Buffer.byteLength(raw, "utf8") > MAX_RESPONSE_BYTES) {
    throw codedError("POST_CALL_INTEREST_RESPONSE_TOO_LARGE");
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw codedError("POST_CALL_INTEREST_RESPONSE_INVALID");
  }
}

function safeFailureCode(error) {
  const code = String(error?.code || "POST_CALL_INTEREST_DELIVERY_FAILED");
  return /^[A-Z][A-Z0-9_]{0,119}$/u.test(code)
    ? code
    : "POST_CALL_INTEREST_DELIVERY_FAILED";
}

export async function drainPostCallInterestOutbox({
  enabled = postCallInterestProducerEnabled(),
  env = process.env,
  fetchImpl = globalThis.fetch,
  claimImpl = claimPendingPostCallInterestEvents,
  settleImpl = settlePostCallInterestEvent,
  limit = MAX_BATCH_SIZE,
  runBudgetMs = RUN_BUDGET_MS,
  nowImpl = Date.now,
  signalFactory = (milliseconds) => AbortSignal.timeout(milliseconds),
} = {}) {
  // Hard-dark means no state read and no network attempt, even when unrelated
  // Post-call credentials happen to exist in the same runtime.
  if (enabled !== true) {
    return Object.freeze({
      enabled: false, attempted: 0, delivered: 0, pending: 0, leased: 0, deferred: 0,
    });
  }
  if (
    typeof fetchImpl !== "function"
    || typeof claimImpl !== "function"
    || typeof settleImpl !== "function"
    || typeof nowImpl !== "function"
    || typeof signalFactory !== "function"
  ) {
    throw codedError("POST_CALL_INTEREST_DEPENDENCY_INVALID");
  }
  const { endpoint, key } = deliveryConfig(env);
  const selectedLimit = Math.max(1, Math.min(MAX_BATCH_SIZE, Number(limit) || MAX_BATCH_SIZE));
  const selectedBudgetMs = Math.max(1_000, Math.min(55_000, Number(runBudgetMs) || RUN_BUDGET_MS));
  const deadlineMs = Number(nowImpl()) + selectedBudgetMs;
  const pending = await claimImpl(selectedLimit);
  const results = [];
  for (const record of pending) {
    const remainingMs = deadlineMs - Number(nowImpl());
    if (remainingMs < 250) break;
    let request = null;
    let response = null;
    try {
      request = postCallInterestRequest(record);
      response = await fetchImpl(endpoint, {
        method: "POST",
        redirect: "error",
        headers: {
          authorization: `Bearer ${key}`,
          accept: "application/json",
          "content-type": "application/json",
        },
        body: JSON.stringify(request.body),
        signal: signalFactory(Math.max(250, Math.min(TIMEOUT_MS, remainingMs))),
      });
      const body = await boundedJson(response);
      if (
        !response.ok
        || ![200, 202].includes(response.status)
        || body?.ok !== true
        || body?.eventType !== "curated_role_interest"
        || body?.eventKey !== request.eventKey
      ) {
        throw codedError(
          response.ok
            ? "POST_CALL_INTEREST_RESPONSE_INVALID"
            : `POST_CALL_INTEREST_HTTP_${response.status}`,
          response.status,
        );
      }
      await settleImpl(request.eventKey, {
        delivered: true,
        leaseToken: record.leaseToken,
        responseEventKey: body.eventKey,
        statusCode: response.status,
      });
      results.push(Object.freeze({ eventKey: request.eventKey, delivered: true }));
    } catch (error) {
      let errorCode = safeFailureCode(error);
      try {
        await settleImpl(request?.eventKey || record.eventKey, {
          delivered: false,
          leaseToken: record.leaseToken,
          statusCode: Number.isInteger(response?.status) ? response.status : null,
          errorCode,
        });
      } catch (settlementError) {
        errorCode = safeFailureCode(settlementError);
      }
      results.push(Object.freeze({
        eventKey: request?.eventKey || record.eventKey,
        delivered: false,
        errorCode,
      }));
    }
  }
  return Object.freeze({
    enabled: true,
    attempted: results.length,
    delivered: results.filter((result) => result.delivered).length,
    pending: results.filter((result) => !result.delivered).length,
    leased: pending.length,
    deferred: Math.max(0, pending.length - results.length),
    results: Object.freeze(results),
  });
}

export const postCallInterestOutboxContract = Object.freeze({
  endpointPath: ENDPOINT_PATH,
  eventKind: "curated_role_interest",
  eventKey: "curated-interest:sha256(canonical {batchId,candidateUserId,roleId})",
  authentication: "bearer:POST_CALL_ENGAGEMENT_API_KEY",
  defaultMode: "off",
  maxBatchSize: MAX_BATCH_SIZE,
  runBudgetMs: RUN_BUDGET_MS,
});
