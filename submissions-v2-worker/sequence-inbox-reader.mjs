import { ResumePipelineError } from "../api/submissions-v2/_lib/resume/pipeline-runtime.mjs";
import { readSequenceInboxBrokerBatch } from "./sequence-inbox-broker-client.mjs";

/**
 * Process one bounded broker page. The dashboard owns cache and provider reads;
 * the isolated worker receives only canonical V2 intake events.
 */
export async function reconcileSequenceInbox({
  env = process.env,
  checkpoint = {},
  signal,
  assertCurrent = async () => {},
  admit,
  readBatch = readSequenceInboxBrokerBatch,
  limit = 8,
} = {}) {
  if (typeof admit !== "function") {
    throw new ResumePipelineError(
      "sequence_inbox_intake_required",
      "Sequence Inbox intake is not configured.",
      { retryable: true },
    );
  }
  signal?.throwIfAborted?.();
  await assertCurrent();
  const batch = await readBatch({
    env,
    signal,
    cursor: checkpoint.cursor || null,
    caughtUp: checkpoint.caught_up === true,
    cursorOverlapMs: checkpoint.caught_up === true ? 5 * 60_000 : 0,
    catalogDigest: checkpoint.catalog_digest || null,
    watermark: checkpoint.watermark || null,
    limit: Math.max(1, Math.min(8, Number(limit) || 8)),
  });
  signal?.throwIfAborted?.();
  await assertCurrent();
  if (batch.coverage.catalog_changed || batch.coverage.watermark_changed) {
    // The cache gained an unscanned target or advanced its conservative
    // per-sequence watermark. Restart from the approved activation boundary;
    // provider idempotency makes this safe and prevents late older replies
    // from being skipped behind a global cursor.
    return {
      checkpoint: {
        cursor: null,
        caught_up: false,
        catalog_digest: batch.coverage.catalog_digest || null,
        watermark: batch.coverage.watermark || null,
      },
      caught_up: false,
      observed: 0,
      accepted: 0,
      existing: 0,
      cache: {
        state: batch.coverage.cache_state,
        last_complete_at: batch.coverage.cache_last_complete_at,
        campaigns_targeted: batch.coverage.cache_campaigns_targeted,
        campaigns_missing: batch.coverage.cache_campaigns_missing,
        campaigns_stale: batch.coverage.cache_campaigns_stale,
      },
    };
  }
  let accepted = 0;
  let existing = 0;
  for (const record of batch.records) {
    signal?.throwIfAborted?.();
    await assertCurrent();
    const result = await admit(record.event);
    if (result?.accepted !== true) {
      throw new ResumePipelineError(
        "sequence_inbox_intake_not_acknowledged",
        "Submissions V2 did not acknowledge a Sequence Inbox event.",
        { retryable: true },
      );
    }
    if (result.existing || result.processing_state === "ignored_later") existing += 1;
    else accepted += 1;
  }
  if (!batch.coverage.checkpoint_safe) {
    const reason = batch.deferred[0]?.reason
      || (batch.coverage.cache_state !== "ready" ? `cache_${batch.coverage.cache_state}` : "cache_incomplete");
    throw new ResumePipelineError(
      "sequence_inbox_evidence_incomplete",
      "Sequence Inbox evidence is incomplete, so its cursor was not advanced.",
      {
        retryable: true,
        details: {
          cache_state: batch.coverage.cache_state || "unavailable",
          cache_last_complete_at: batch.coverage.cache_last_complete_at || null,
          cache_campaigns_targeted: Number(batch.coverage.cache_campaigns_targeted) || 0,
          cache_campaigns_missing: Number(batch.coverage.cache_campaigns_missing) || 0,
          cache_campaigns_stale: Number(batch.coverage.cache_campaigns_stale) || 0,
        },
        checkpoint: {
          ...checkpoint,
          stage: "sequence_inbox_evidence_incomplete",
          observed: Number(batch.coverage.page_size) || 0,
          accepted,
          existing,
          deferred: Number(batch.coverage.deferred) || 0,
          reason,
        },
      },
    );
  }
  return {
    checkpoint: {
      cursor: batch.checkpoint_cursor || checkpoint.cursor || null,
      caught_up: Boolean(batch.coverage.full_success),
      ...((batch.coverage.catalog_digest || checkpoint.catalog_digest) ? {
        catalog_digest: batch.coverage.catalog_digest || checkpoint.catalog_digest,
      } : {}),
      ...((batch.coverage.watermark || checkpoint.watermark) ? {
        watermark: batch.coverage.watermark || checkpoint.watermark,
      } : {}),
    },
    caught_up: Boolean(batch.coverage.full_success),
    observed: Number(batch.coverage.page_size) || 0,
    accepted,
    existing,
    cache: {
      state: batch.coverage.cache_state,
      last_complete_at: batch.coverage.cache_last_complete_at,
      campaigns_targeted: batch.coverage.cache_campaigns_targeted,
      campaigns_missing: batch.coverage.cache_campaigns_missing,
      campaigns_stale: batch.coverage.cache_campaigns_stale,
    },
  };
}
