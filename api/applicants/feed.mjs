// Browser read for the Applicants tab: one call returns the loop's snapshot
// plus the human-decision and loop-ack overlays, keyed by `<cuId>:<roleId>`,
// plus the complete compact-card and photos hashes needed to render every row.
// The UI joins them client-side (decisions overlay the queue, acks flip
// "Queued to send" to "Emailed") and never fetches cards while scrolling.

import { cors, requireAuth } from "./_lib/core.mjs";
import { readActivePublication, readPublishedArtifacts, verifyGeneration } from "./_lib/generation.mjs";
import { getJson, hashGetAllJson, K, kvConfigured } from "./_lib/kv.mjs";
import {
  activeSourceProfileReceiptMismatches,
  profileCacheSummary,
  profilePreparingCount,
} from "./_lib/profile-readiness.mjs";

export const config = { maxDuration: 30 };

export function createFeedHandler({
  corsHandler = cors,
  authHandler = requireAuth,
  kvReady = kvConfigured,
  readJson = getJson,
  readHash = hashGetAllJson,
  now = Date.now,
  readActive = () => readActivePublication({ readJson }),
  readArtifacts = (pointer) => readPublishedArtifacts(pointer, { readJson }),
} = {}) {
  return async function handler(req, res) {
    if (corsHandler(req, res)) return;
    if (req.method !== "GET") return res.status(405).json({ ok: false, error: "GET only" });
    if (!(await authHandler(req, res))) return;
    if (!kvReady()) return res.status(503).json({ ok: false, error: "state_store_not_configured" });
    try {
      // The pointer is deliberately read first. Never merge legacy/split keys
      // when the active generation is missing or incomplete: a mixed feed can
      // make a browser action against the wrong applicant revision.
      const generation = await readActive();
      if (!generation) {
        res.setHeader("Cache-Control", "no-store");
        return res.status(503).json({ ok: false, error: "generation_unavailable" });
      }
      const artifacts = await readArtifacts(generation);
      if (!artifacts || !verifyGeneration(artifacts).ok) {
        res.setHeader("Cache-Control", "no-store");
        return res.status(503).json({
          ok: false,
          error: "generation_unavailable",
          generationId: generation.generationId,
        });
      }
      const [decisions, acks, photos, cards, sourceProfileReceipts, pipeline] = await Promise.all([
        readHash(K.decisions),
        readHash(K.acks),
        readHash(K.photos),
        readHash(K.cards),
        readHash(K.sourceProfileReady),
        // Applicant Pipeline Core's funnel snapshot (Status v2 build plan
        // step 3) — null when Core has never published one; never a fake 0.
        readJson(K.pipeline),
      ]);
      const joined = artifacts.snapshot ? {
        ...artifacts.snapshot,
        ...(Array.isArray(artifacts.queue?.rows) ? { queue: artifacts.queue.rows } : {}),
      } : null;
      const receiptMismatches = activeSourceProfileReceiptMismatches(joined, sourceProfileReceipts, { now: now() });
      if (receiptMismatches.length) {
        res.setHeader("Cache-Control", "no-store");
        return res.status(503).json({
          ok: false,
          error: "generation_unavailable",
          reason: "profile_receipt_mismatch",
          generationId: generation.generationId,
          profilePreparing: profilePreparingCount(joined),
        });
      }
      const profileCache = profileCacheSummary(joined);
      res.setHeader("Cache-Control", "no-store");
      // `counts` carries sync's count-drop tripwire doc (apphub:counts); the
      // tab shows a warning banner when counts.alert is set, data untouched.
      return res.status(200).json({
        ok: true,
        snapshot: joined,
        decisions,
        acks,
        photos,
        cards,
        counts: artifacts.counts,
        pipeline: pipeline ?? null,
        profileCache,
        profilePreparing: profilePreparingCount(joined),
        generation: {
          generationId: generation.generationId,
          digest: generation.digest,
          sourceCutoff: generation.sourceCutoff ?? null,
          sourceWatermark: generation.sourceWatermark ?? null,
          publishedAt: generation.publishedAt ?? null,
        },
      });
    } catch (error) {
      return res.status(502).json({
        ok: false,
        error: "feed_unavailable",
        detail: String(error?.message || error).slice(0, 180),
      });
    }
  };
}

export default createFeedHandler();
