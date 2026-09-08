// Browser read for the Applicants tab: one call returns the loop's snapshot
// plus the human-decision and loop-ack overlays, keyed by `<cuId>:<roleId>`,
// plus the complete compact-card and photos hashes needed to render every row.
// The UI joins them client-side (decisions overlay the queue, acks flip
// "Queued to send" to "Emailed") and never fetches cards while scrolling.

import { cors, requireAuth } from "./_lib/core.mjs";
import { gzipSync } from "node:zlib";
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

function sourceDetails(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || text(value.state) !== "pending_source_review"
    || text(value.provenance) !== "applicant_hub"
    || text(value.verification) !== "unverified_source"
    || !value.profile || typeof value.profile !== "object" || Array.isArray(value.profile)) return null;
  const history = value.profile;
  const experiences = (Array.isArray(history.experiences) ? history.experiences : []).slice(0, 12)
    .filter((row) => row && typeof row === "object" && !Array.isArray(row))
    .map((row) => ({ roleTitle: text(row.roleTitle), companyName: text(row.companyName),
      start: text(row.start), end: text(row.end), current: row.current === true }))
    .filter((row) => row.roleTitle || row.companyName);
  const education = (Array.isArray(history.education) ? history.education : []).slice(0, 12)
    .filter((row) => row && typeof row === "object" && !Array.isArray(row))
    .map((row) => ({ school: text(row.school), degree: text(row.degree), start: text(row.start), end: text(row.end) }))
    .filter((row) => row.school || row.degree);
  return Object.freeze({
    state: "pending_source_review",
    label: "Source details pending review",
    provenance: "applicant_hub",
    verification: "unverified_source",
    ruleEligible: false,
    sourceObservationId: text(value.sourceObservationId), observedAt: text(value.observedAt),
    historyState: text(value.historyState),
    profile: Object.freeze({ title: text(history.title), location: text(history.location), experiences, education }),
  });
}

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
      ...(sourceDetails(row.sourceDetails) ? { sourceDetails: sourceDetails(row.sourceDetails) } : {}),
      // A preparation stub is never actionable even if an upstream writer
      // regresses. Expose the fact as false rather than the upstream value.
      interviewAllowed: false,
    }));
}

export const config = { maxDuration: 30 };

export function respondApplicantFeed(req, res, body) {
  const json = JSON.stringify(body);
  if (Buffer.byteLength(json) > 1_000_000 && /\bgzip\b/i.test(req.headers?.["accept-encoding"] || "")) {
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Content-Encoding", "gzip");
    res.setHeader("Vary", "Accept-Encoding");
    return res.status(200).end(gzipSync(Buffer.from(json), { level: 9 }));
  }
  return res.status(200).json(body);
}

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
      // These complete projections have their own top-level response fields.
      // Keep one copy on the wire while retaining the full immutable artifact.
      const { applicantRowsV2: _rowsV2, problems: _problems, ...browserSnapshot } = joined || {};
      const profileCache = profileCacheSummary(joined);
      res.setHeader("Cache-Control", "no-store");
      // `counts` carries sync's count-drop tripwire doc (apphub:counts); the
      // tab shows a warning banner when counts.alert is set, data untouched.
      return respondApplicantFeed(req, res, {
        ok: true,
        snapshot: joined ? browserSnapshot : null,
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
