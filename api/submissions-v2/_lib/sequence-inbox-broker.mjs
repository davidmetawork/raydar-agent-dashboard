import {
  readCachedSequenceReplyBatch,
  readCompleteSequenceInboxMessage,
} from "./sequence-inbox-source.mjs";
import { SUBMISSIONS_V2_APPROVED_ACTIVATION_AT } from "./email-source-policy.mjs";
import {
  readSourcingSequenceRoleMappings,
  sourcingRoleMappingInternals,
} from "./sourcing-role-mappings.mjs";
import {
  acquireInboxSyncLock,
  buildInboxRefresh,
  readInboxSnapshotState,
  releaseInboxSyncLock,
  writeInboxRefreshState,
} from "../../inbox/_lib/core.mjs";

export const SEQUENCE_INBOX_ACTIVATION_AT = SUBMISSIONS_V2_APPROVED_ACTIVATION_AT;
// The shared Inbox lock has a fixed 120-second TTL. Keep the whole broker
// well below it: 35s refresh + (8 × 5s point reads) + (7 × 1s pacing) = 82s,
// preserving 38s for KV/read-state/write-state and runtime overhead.
export const SEQUENCE_INBOX_BATCH_LIMIT = 8;
// Deployed workers may still request the former 12-record page. Accept that
// wire contract during rollout, but never let it increase broker work.
export const SEQUENCE_INBOX_REQUEST_LIMIT_MAX = 12;
export const SEQUENCE_INBOX_REFRESH_BUDGET_MS = 35_000;
export const SEQUENCE_INBOX_POINT_READ_TIMEOUT_MS = 5_000;
export const SEQUENCE_INBOX_POINT_READ_PACE_MS = 1_000;
export const SEQUENCE_INBOX_BROKER_DEADLINE_MS = 100_000;

const fail = (code, message, status = 400) => Object.assign(new Error(message), {
  code,
  status,
  retryable: status >= 500,
});
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const cacheUnavailable = (stage) => fail(
  "sequence_inbox_cache_unavailable",
  `The Sequence Inbox cache is unavailable (${stage}).`,
  503,
);

export function sequenceInboxActivation({ env = process.env, now = Date.now() } = {}) {
  const expected = Date.parse(SEQUENCE_INBOX_ACTIVATION_AT);
  const configuredRaw = String(env.SUBMISSIONS_V2_GMAIL_ACTIVATED_AT || "").trim();
  const configured = configuredRaw ? Date.parse(configuredRaw) : expected;
  if (!Number.isFinite(configured) || configured !== expected || configured > now) {
    throw fail(
      "sequence_inbox_activation_invalid",
      "Sequence Inbox activation does not match the approved boundary.",
      503,
    );
  }
  return SEQUENCE_INBOX_ACTIVATION_AT;
}

export function validateSequenceInboxBatchRequest(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw fail("sequence_inbox_batch_invalid", "The Sequence Inbox batch request is invalid.");
  }
  const allowed = new Set(["cursor", "caught_up", "limit", "catalog_digest", "watermark"]);
  if (Object.keys(input).some((key) => !allowed.has(key))) {
    throw fail("sequence_inbox_batch_field_invalid", "The Sequence Inbox batch request contains an unsupported field.");
  }
  const cursor = input.cursor == null ? null : String(input.cursor).trim();
  if (cursor !== null && (!cursor || cursor.length > 1_000 || !/^[A-Za-z0-9_-]+$/u.test(cursor))) {
    throw fail("sequence_inbox_cursor_invalid", "The Sequence Inbox cursor is invalid.");
  }
  if (input.caught_up != null && typeof input.caught_up !== "boolean") {
    throw fail("sequence_inbox_caught_up_invalid", "The Sequence Inbox catch-up marker is invalid.");
  }
  const requestedLimit = input.limit == null ? SEQUENCE_INBOX_BATCH_LIMIT : Number(input.limit);
  if (!Number.isInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > SEQUENCE_INBOX_REQUEST_LIMIT_MAX) {
    throw fail("sequence_inbox_batch_limit_invalid", "The Sequence Inbox batch exceeds its safe limit.");
  }
  const catalogDigest = input.catalog_digest == null ? null : String(input.catalog_digest).trim();
  if (catalogDigest !== null && !/^[a-f0-9]{64}$/u.test(catalogDigest)) {
    throw fail("sequence_inbox_catalog_digest_invalid", "The Sequence Inbox catalog marker is invalid.");
  }
  const watermark = input.watermark == null ? null : String(input.watermark).trim();
  if (watermark !== null && (!watermark || !Number.isFinite(Date.parse(watermark)))) {
    throw fail("sequence_inbox_watermark_invalid", "The Sequence Inbox watermark is invalid.");
  }
  return {
    cursor,
    caughtUp: input.caught_up === true,
    limit: Math.min(requestedLimit, SEQUENCE_INBOX_BATCH_LIMIT),
    catalogDigest,
    watermark,
  };
}

function safeDeferred(record) {
  return {
    status: "deferred",
    reason: String(record?.reason || "unknown").slice(0, 100),
    sequence_id: record?.sequence_id || null,
    provider_message_id: record?.provider_message_id || null,
    error: record?.error ? String(record.error).slice(0, 100) : undefined,
  };
}

/** Dashboard-owned cache and Paraform point reads exposed to the worker only. */
export async function readSequenceInboxBrokerBatch(input, {
  env = process.env,
  now = () => new Date(),
  readBatch = readCachedSequenceReplyBatch,
  readMessage = readCompleteSequenceInboxMessage,
  acquireLock = acquireInboxSyncLock,
  readState = readInboxSnapshotState,
  buildRefresh = buildInboxRefresh,
  writeState = writeInboxRefreshState,
  releaseLock = releaseInboxSyncLock,
  sleepImpl = wait,
  clock = () => Date.now(),
  readRoleMappings = readSourcingSequenceRoleMappings,
} = {}) {
  const request = validateSequenceInboxBatchRequest(input);
  const activationAt = sequenceInboxActivation({ env, now: now().getTime() });
  // Optional evidence is read before taking the shared Inbox lease. An
  // unavailable/incomplete lookup returns a fixed empty-set digest, so literal
  // campaign roles keep flowing while a mapping appearance/disappearance still
  // fences the persisted page cursor.
  let savedRoleMappingState;
  try {
    const loadedMappings = await readRoleMappings({ env });
    savedRoleMappingState = loadedMappings?.status === "ready"
      && Array.isArray(loadedMappings.mappings)
      && /^[a-f0-9]{64}$/u.test(String(loadedMappings.digest || ""))
      ? loadedMappings
      : null;
  } catch {
    savedRoleMappingState = null;
  }
  if (!savedRoleMappingState) {
    savedRoleMappingState = {
      status: "unavailable",
      mappings: [],
      digest: sourcingRoleMappingInternals.UNAVAILABLE_DIGEST,
    };
  }
  const lock = await acquireLock();
  if (lock?.status !== "acquired") {
    if (lock?.status === "busy") {
      throw fail("sequence_inbox_refresh_busy", "The bounded Sequence Inbox cache refresh is unavailable.", 503);
    }
    throw cacheUnavailable("lock_unavailable");
  }
  let batch;
  const deadline = clock() + SEQUENCE_INBOX_BROKER_DEADLINE_MS;
  const remaining = () => deadline - clock();
  const requireBudget = (minimumMs = 0) => {
    if (remaining() <= minimumMs) {
      throw fail(
        "sequence_inbox_broker_deadline",
        "The bounded Sequence Inbox page ran out of its shared-lock budget.",
        503,
      );
    }
  };
  try {
    const loaded = await readState();
    if (loaded?.status !== "ready" || !loaded.value) {
      throw cacheUnavailable(loaded?.cause || "state_unavailable");
    }
    // Refresh only at the beginning of a scan or after the prior watermark is
    // complete.  Refreshing every page moves the watermark and would force a
    // safe restart before a large cache can ever be consumed.
    const shouldRefresh = request.caughtUp || (!request.cursor && !request.watermark);
    if (shouldRefresh) requireBudget(1_000);
    const refreshedState = shouldRefresh
      ? await writeState(loaded.value, await buildRefresh({
          previousState: loaded.value,
          budgetMs: Math.min(SEQUENCE_INBOX_REFRESH_BUDGET_MS, remaining()),
      }))
      : loaded.value;
    requireBudget(SEQUENCE_INBOX_POINT_READ_TIMEOUT_MS);
    let reads = 0;
    batch = await readBatch({
      activationAt,
      env,
      cursor: request.cursor,
      cursorOverlapMs: request.caughtUp ? 5 * 60_000 : 0,
      expectedCatalogDigest: request.catalogDigest,
      expectedWatermark: request.watermark,
      savedRoleMappings: savedRoleMappingState.mappings,
      savedRoleMappingDigest: savedRoleMappingState.digest,
      savedRoleMappingStatus: savedRoleMappingState.status,
      limit: request.limit,
      now,
      readState: async () => ({ status: "ready", value: refreshedState }),
      readMessage: async (gmailId) => {
        if (reads > 0) await sleepImpl(SEQUENCE_INBOX_POINT_READ_PACE_MS);
        requireBudget(SEQUENCE_INBOX_POINT_READ_TIMEOUT_MS);
        reads += 1;
        return readMessage(gmailId, {
          timeoutMs: Math.min(SEQUENCE_INBOX_POINT_READ_TIMEOUT_MS, remaining()),
        });
      },
    });
  } finally {
    await releaseLock(lock.token);
  }
  return {
    records: Array.isArray(batch?.records)
      ? batch.records.map((record) => ({ event: record.event }))
      : [],
    deferred: Array.isArray(batch?.deferred) ? batch.deferred.map(safeDeferred) : [],
    next_cursor: batch?.next_cursor || null,
    checkpoint_cursor: batch?.checkpoint_cursor || request.cursor,
    coverage: batch?.coverage || {},
  };
}
