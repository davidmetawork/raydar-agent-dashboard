// BOOKING MEMBERSHIP REFRESH — the expensive Paraform membership walk.
//
// This runs separately, ahead of booking-sweep. It writes immutable,
// generation-scoped shards, verifies every byte/hash/count, writes the manifest
// last, then atomically flips the current pointer and webhook by-email index.
// booking-sweep never falls back to doing this work inline.
import {
  cors,
  cronAuth,
  hasCookie,
  requireAuth,
  completeCampaignLeads,
} from "./_lib/core.mjs";
import {
  atomicPublishMembershipSnapshot,
  discoverBookingStopSequences,
  durableKvSetAndReadback,
  kvConfigured,
  kvGet,
  kvSet,
  kvSetNx,
  shouldAlert,
} from "./_lib/booking-stop.mjs";
import {
  BOOKING_MEMBERSHIP_KEYS,
  bookingMembershipAttempt,
  runBookingMembershipRefresh,
} from "./_lib/booking-membership-snapshot.mjs";
import { notifySlack } from "../paraai/_lib/core.mjs";

export const config = { maxDuration: 300 };

const store = {
  get: kvGet,
  set: kvSet,
  setNx: kvSetNx,
  atomicPublish: atomicPublishMembershipSnapshot,
};

async function recordAttempt(status, {
  result = null,
  error = null,
} = {}) {
  const payload = bookingMembershipAttempt({
    status,
    result,
    error,
  });
  await durableKvSetAndReadback(
    BOOKING_MEMBERSHIP_KEYS.attempt,
    payload,
    6 * 60 * 60,
  );
}

async function warnOnCronRejection(cron) {
  if (cron.ok || !cron.headerPresent) return;
  if (await shouldAlert(`membership-cron-auth-${cron.reason}`, 3600)) {
    await notifySlack(
      `:warning: Booking membership refresh received a cron-marked request without a valid CRON_SECRET bearer (${cron.reason}). The immutable membership snapshot will age out if scheduled refreshes cannot authenticate.`,
    ).catch(() => {});
  }
}

export default async function handler(req, res) {
  if (cors(req, res)) return;
  const cron = cronAuth(req);
  if (!cron.ok && !(await requireAuth(req, res))) {
    await warnOnCronRejection(cron);
    return;
  }
  if (!hasCookie()) {
    if (kvConfigured()) {
      await recordAttempt("failure", { error: "no_cookie" }).catch(() => {});
    }
    return res.status(200).json({ ok: false, error: "no_cookie" });
  }
  if (!kvConfigured()) {
    return res.status(200).json({ ok: false, error: "no_kv" });
  }

  try {
    await recordAttempt("running");
    const result = await runBookingMembershipRefresh({
      scopeLoader: discoverBookingStopSequences,
      membershipLoader: completeCampaignLeads,
      store,
      concurrency: Number(
        process.env.BOOKING_STOP_MEMBERSHIP_CONCURRENCY || 2,
      ),
    });
    await recordAttempt(result.ok ? "success" : "failure", { result });
    if (!result.ok && (await shouldAlert(
      `membership-refresh-${result.error}`,
      3600,
    ))) {
      await notifySlack(
        `:rotating_light: Booking membership refresh did not publish a generation (${String(result.error || "unknown").slice(0, 100)}). The sweep will fail closed when the current immutable snapshot reaches 60 minutes old.`,
      ).catch(() => {});
    }
    return res.status(200).json({
      ok: result.ok,
      complete: result.complete,
      resumable: result.resumable === true,
      error: result.error || null,
      schema: result.schema || null,
      generation: result.generation || null,
      oldestFetchedAt: result.oldestFetchedAt || null,
      scopeSchema: result.scopeSchema || null,
      scopeDigest: result.scopeDigest || null,
      catalogSequenceCount: result.catalogSequenceCount ?? null,
      selectedSequenceCount: result.selectedSequenceCount ?? null,
      completedSequenceCount: result.completedSequenceCount ?? null,
      shardCount: result.shardCount ?? null,
      leadCount: result.leadCount ?? null,
      indexedEmails: result.indexedEmails ?? null,
      durationMs: result.durationMs,
      ranAt: new Date().toISOString(),
    });
  } catch (error) {
    const code = String(
      error?.code || error?.message || "membership_refresh_error",
    ).slice(0, 120);
    await recordAttempt("failure", { error: code }).catch(() => {});
    if (await shouldAlert(`membership-refresh-${code}`, 3600)) {
      await notifySlack(
        `:rotating_light: Booking membership refresh failed before publication (${code}). No incomplete generation was made current.`,
      ).catch(() => {});
    }
    return res.status(200).json({
      ok: false,
      complete: false,
      error: code,
      ranAt: new Date().toISOString(),
    });
  }
}
