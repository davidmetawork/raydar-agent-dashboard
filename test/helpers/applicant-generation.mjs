// Shared fixtures for the Applicants publication contract.
//
// Since the immutable-generation cutover a publisher may no longer POST a bare
// `{snapshot, queue}` pair (sync answers `generation_required`), and a reader
// may no longer be handed the legacy `apphub:snapshot` / `apphub:queue` keys
// (feed and rules-tick answer `generation_unavailable`). Every applicants test
// therefore needs the same two things: a POST body that carries Core's
// generation tuple plus its conserved counts, and an in-memory KV state that
// already holds a verified active publication.
//
// Keeping both here means one place has to agree with
// api/applicants/_lib/generation.mjs, instead of a dozen fixtures drifting
// apart the way they did before 2026-09-04.

import {
  buildGeneration,
  coreGenerationDigest,
} from "../../api/applicants/_lib/generation.mjs";
import { K } from "../../api/applicants/_lib/kv.mjs";
import { profilePreparingCount } from "../../api/applicants/_lib/profile-readiness.mjs";

export const FIXTURE_GENERATION_ID = "gen-fixture-0001";

/** The four conserved dimensions exactly as normalizeConservedCounts computes
 *  them, so a fixture can never declare a total the payload does not support. */
export function conservedCountsFor(snapshot, queue) {
  const stream = Array.isArray(snapshot?.stream) ? snapshot.stream.length : 0;
  const queued = Array.isArray(queue) ? queue.length : 0;
  const profilePreparing = profilePreparingCount(snapshot);
  return { total: stream + queued + profilePreparing, stream, queue: queued, profilePreparing };
}

/**
 * A complete publish body: snapshot + queue + Core's generation tuple + the
 * conserved counts. `sourceCutoff`/`sourceWatermark` are explicit nulls
 * because sync requires both keys to be present, not merely truthy.
 */
export function publicationBody({
  snapshot,
  queue,
  generationId = FIXTURE_GENERATION_ID,
  sourceCutoff = null,
  sourceWatermark = null,
  ...extra
} = {}) {
  const digest = coreGenerationDigest({ generationId, sourceCutoff, sourceWatermark, snapshot, queue });
  return {
    snapshot,
    queue,
    generation: { id: generationId, digest, sourceCutoff, sourceWatermark },
    counts: conservedCountsFor(snapshot, queue),
    ...extra,
  };
}

/**
 * A queue/stream row that satisfies the publish-time source-profile receipt
 * fence: it names both a profile key and the exact source observation the
 * receipt has to match.
 */
export function sourceRow(cuId, extra = {}) {
  return {
    key: `${cuId}:role1`,
    cuId,
    sourceObservationId: `obs-${cuId}`,
    ...extra,
  };
}

/** The durable Hub receipts for a set of `sourceRow`s. */
export function sourceReceiptsFor(rows) {
  return Object.fromEntries(rows.flatMap((row) => {
    const key = row?.profileKey || row?.cuId;
    const sourceObservationId = row?.sourceObservationId;
    if (!key || !sourceObservationId) return [];
    return [[key, {
      cachedAt: "2026-09-01T00:00:00.000Z",
      source: "applicant_hub",
      durable: true,
      historyState: "data",
      sourceObservationId,
    }]];
  }));
}

/**
 * Write a verified active publication into an in-memory KV `state` map and
 * return the generation. `counts` may carry the tripwire doc (updatedAt/alert);
 * the four conserved dimensions are always recomputed from the payload so the
 * artifact passes verifyGeneration.
 */
export function publishInto(state, {
  snapshot = { generatedAt: "2026-09-01T00:00:00.000Z" },
  queue = [],
  counts = null,
  generationId = FIXTURE_GENERATION_ID,
  sourceCutoff = null,
  sourceWatermark = null,
  publishedAt = "2026-09-01T00:00:00.000Z",
} = {}) {
  const generation = buildGeneration({
    snapshot,
    queue,
    counts: { ...(counts || {}), ...conservedCountsFor(snapshot, queue) },
    generationId,
    sourceCutoff,
    sourceWatermark,
    publishedAt,
  });
  const prefix = K.generation(generationId);
  state[`${prefix}:snapshot`] = generation.snapshot;
  state[`${prefix}:queue`] = generation.queue;
  state[`${prefix}:counts`] = generation.counts;
  state[`${prefix}:meta`] = generation.pointer;
  state[K.activeGeneration] = generation.pointer;
  return generation;
}

/** The `{generationId, generationDigest}` fence every browser write carries. */
export function generationFence(generation) {
  return {
    generationId: generation.pointer.generationId,
    generationDigest: generation.pointer.digest,
  };
}
