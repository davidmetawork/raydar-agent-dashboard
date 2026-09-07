// Browser read for the Applicants tab: one call returns the loop's snapshot
// plus the human-decision and loop-ack overlays, keyed by `<cuId>:<roleId>`,
// plus the complete compact-card and photos hashes needed to render every row.
// The UI joins them client-side (decisions overlay the queue, acks flip
// "Queued to send" to "Emailed") and never fetches cards while scrolling.

import { cors, requireAuth } from "./_lib/core.mjs";
import { readActivePublication, readPublishedArtifacts, verifyGeneration } from "./_lib/generation.mjs";
import { getJson, hashGetAllJson, K, kvConfigured } from "./_lib/kv.mjs";
import { sourceCardsOnly } from "./_lib/rich-profile.mjs";
import { applicantProblemsV2, applicantRowsV2FromSnapshot } from "./_lib/profile-v2.mjs";
import {
  partitionByProfileReceipt,
  profileCacheSummary,
  profilePreparingCount,
} from "./_lib/profile-readiness.mjs";

// Profile preparation is deliberately outside the actionable queue and stream.
// Keep its small, source-owned identity stub separate from the count used by the
// receipt partition below: that partition adds read-time withholds and therefore
// represents `profilePreparing` as a number.  The browser needs the original
// Core stubs to name the work still in progress, but it must receive neither a
// profile nor a route that could make a decision against it.
const text = (value) => {
  const result = typeof value === "string" ? value.trim() : "";
  return result || null;
};

function profilePreparingRows(snapshot) {
  if (!Array.isArray(snapshot?.profilePreparing)) return [];
  return snapshot.profilePreparing
    .filter((row) => row && typeof row === "object" && !Array.isArray(row))
    .map((row) => ({
      key: text(row.key),
      profileKey: text(row.profileKey),
      sourceObservationId: text(row.sourceObservationId),
      state: text(row.state) || "profile_preparing",
      name: text(row.name),
      roleTitle: text(row.roleTitle),
      sourceJobId: text(row.sourceJobId),
      roleId: text(row.roleId),
      company: text(row.company),
      appliedAt: text(row.appliedAt),
      addedAt: text(row.addedAt),
      receivedAt: text(row.receivedAt),
      reason: text(row.reason),
      // A preparation stub is never actionable even if an upstream writer
      // regresses. Expose the fact as false rather than the upstream value.
      interviewAllowed: false,
    }));
}

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
      const published = artifacts.snapshot ? {
        ...artifacts.snapshot,
        ...(Array.isArray(artifacts.queue?.rows) ? { queue: artifacts.queue.rows } : {}),
      } : null;
      const preparingRows = profilePreparingRows(published);
      // V2 is an additive Core-owned read projection. Legacy snapshot rows stay
      // authoritative for every existing screen until Core publishes it.
      const applicantRowsV2 = applicantRowsV2FromSnapshot(published);
      const problems = applicantProblemsV2(applicantRowsV2, published?.problems);
      // ONE STALE ROW MUST NOT BLANK THE TAB (2026-09-04). The publish-time
      // fence in sync.mjs is what keeps an unbacked generation from ever
      // becoming active; by the time we read, this generation was already
      // proved. A receipt can still go stale under a live generation (Hub
      // re-observes and the observation id moves), and answering 503 for that
      // made the tab discard the whole feed — 4,345 rows and the reviewer's
      // local state — over one row. Those rows now move into the same
      // profile-preparing partition Core already publishes: not rendered, so
      // not actionable; counted, so never silently gone.
      const partition = partitionByProfileReceipt(published, sourceProfileReceipts, { now: now() });
      const joined = partition.snapshot;
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
        cards: sourceCardsOnly(cards),
        applicantRowsV2,
        problems,
        counts: artifacts.counts,
        pipeline: pipeline ?? null,
        profileCache,
        profilePreparing: profilePreparingCount(joined),
        // Separate from the numeric profilePreparing total. These Core-owned
        // stubs render only in the read-only Processing view; they never join
        // the review, stream, card, or decision paths.
        profilePreparingRows: preparingRows,
        // Reported separately from Core's own preparing partition so the tab
        // can say which part of the number this read withheld.
        profileReceiptWithheld: partition.withheld,
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
