// ─────────────────────────────────────────────────────────────────────────────
// BACKGROUND MATCHER — drains the pending-booking queue the webhooks only
// ever enqueue into (item 3 of docs/research/booking-protection-minimum-
// 2026-09-26.md). Matching against the live-set index costs 0 Paraform
// requests; only a real match costs 2 (pause + read-back verify), via the
// same booking-stop.mjs applyDecisions() the legacy sweep used to call.
import {
  applyDecisions,
  raydarPauseCanaryIdentityFingerprint,
  raydarWebhookSecretFingerprint,
  K as LEGACY_K,
  kvSet as legacyKvSet,
} from "./booking-stop.mjs";
import {
  loadLiveSet,
  liveSetUsable,
  matchBookingAgainstLiveSet,
} from "./booking-protection-liveset.mjs";
import { alsoPauseIfBookedBeforeJoining } from "./booking-protection-policy.mjs";
import {
  pendingBookingIds,
  readPendingBooking,
  removePendingBooking,
} from "./booking-protection-queue.mjs";

// Same 30-day proof freshness window the legacy webhook used
// (booking-stop.mjs RAYDAR_WEBHOOK_PROOF_MAX_AGE_MS) — api/seq/health.mjs's
// raydarWebhookProofStatus() reads whatever last wrote these keys, whoever
// that is, so the worker writes through the SAME K.raydarWebhookProof /
// K.raydarPauseCanaryProof keys the hook used to write directly.
export async function drainPendingBookings({
  now = Date.now(),
  listPending = pendingBookingIds,
  readJob = readPendingBooking,
  removeJob = removePendingBooking,
  loadLive = loadLiveSet,
  applyDecisionsImpl = applyDecisions,
  writeProof = legacyKvSet,
  pauseCanaryFingerprint = process.env.RAYDAR_BOOKING_PAUSE_CANARY_FINGERPRINT,
  webhookSecret = process.env.RAYDAR_SCHEDULER_WEBHOOK_SECRET,
  apply = process.env.BOOKING_STOP_APPLY !== "0",
  maxJobsPerRun = Number(process.env.BOOKING_STOP_LITE_WORKER_BUDGET || 25),
  applyDecisionsOverrides = {},
} = {}) {
  const out = {
    pending: 0,
    processed: 0,
    matched: 0,
    paused: 0,
    deferred: 0,
    pauseErrors: [],
    liveSetReady: false,
  };
  const eventIds = await listPending();
  out.pending = eventIds.length;
  if (!eventIds.length) return out;

  const liveSet = await loadLive();
  out.liveSetReady = liveSetUsable(liveSet, now);
  const alsoBeforeJoin = alsoPauseIfBookedBeforeJoining();

  for (const eventId of eventIds.slice(0, maxJobsPerRun)) {
    const job = await readJob(eventId);
    if (!job) { await removeJob(eventId); continue; }

    if (!out.liveSetReady) {
      // Leave it queued. The next tick retries once the daily job publishes
      // (or republishes) a usable index — never drop a pending booking
      // because the index happened to be stale.
      out.deferred++;
      continue;
    }

    out.processed++;
    const decisions = matchBookingAgainstLiveSet({
      liveSet,
      email: job.email,
      bookedAtMs: job.effectiveBookedAtMs ?? job.bookedAtMs,
      source: job.source,
      eventName: job.eventName,
      startsAt: job.startsAt,
      alsoPauseBeforeJoiningInterviewChase: alsoBeforeJoin,
      now,
    });

    let applied = { paused: 0, pauseErrors: [] };
    if (apply && decisions.length) {
      applied = await applyDecisionsImpl(decisions, applyDecisionsOverrides);
    }
    out.matched += decisions.length;
    out.paused += applied.paused || 0;
    if (applied.pauseErrors?.length) {
      out.pauseErrors.push(...applied.pauseErrors);
      // Same rule the legacy webhook used: leave it queued (not "done") so
      // the next tick retries the idempotent pause until read-back proves it.
      continue;
    }

    await removeJob(eventId);

    try {
      const proof = {
        schema: "raydar-booking-webhook-proof-v1",
        verifiedAt: new Date(now).toISOString(),
        secretFingerprint: raydarWebhookSecretFingerprint(webhookSecret),
        apply: Boolean(apply),
        deferred: false,
        matched: decisions.length,
        paused: applied.paused || 0,
      };
      await writeProof(LEGACY_K.raydarWebhookProof, proof, 30 * 24 * 3600);
      const canaryFingerprint = raydarPauseCanaryIdentityFingerprint({
        secret: webhookSecret,
        email: job.email,
      });
      if (
        proof.apply
        && !proof.deferred
        && proof.matched >= 1
        && proof.paused >= 1
        && /^[a-f0-9]{64}$/u.test(String(pauseCanaryFingerprint || ""))
        && canaryFingerprint === pauseCanaryFingerprint
      ) {
        await writeProof(LEGACY_K.raydarPauseCanaryProof, {
          ...proof,
          canaryFingerprint,
        }, 30 * 24 * 3600);
      }
    } catch {
      // Proof-writing is observability, not correctness: the pause itself
      // already passed read-back verification above and the job is removed
      // from the queue either way.
    }
  }
  return out;
}
