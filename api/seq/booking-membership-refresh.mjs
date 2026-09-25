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
  raydarPauseCanaryIdentityFingerprint,
  shouldAlert,
} from "./_lib/booking-stop.mjs";
import {
  BOOKING_MEMBERSHIP_KEYS,
  bookingMembershipAttempt,
  runBookingMembershipRefresh,
} from "./_lib/booking-membership-snapshot.mjs";
import { pageNotify, systemHealthOwns } from "../_lib/notify.mjs";

const pageNotifyCronAuth = (text) => pageNotify(text, { key: "cron-auth" });
import { withParaformTelemetrySource } from "../_lib/paraform-telemetry-context.mjs";

export const config = { maxDuration: 300 };

const store = {
  get: kvGet,
  set: kvSet,
  setNx: kvSetNx,
  atomicPublish: atomicPublishMembershipSnapshot,
};

function includeConfiguredPauseCanary(lead) {
  const configured = String(
    process.env.RAYDAR_BOOKING_PAUSE_CANARY_FINGERPRINT || "",
  ).trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/u.test(configured)) return false;
  const emails = new Set([
    lead?.to_use_email,
    ...(Array.isArray(lead?.user_emails) ? lead.user_emails : []),
  ].map((value) => String(value || "").trim().toLowerCase())
    .filter((value) => value.includes("@")));
  return [...emails].some((email) =>
    raydarPauseCanaryIdentityFingerprint({ email }) === configured);
}

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
  if (systemHealthOwns() || await shouldAlert(`membership-cron-auth-${cron.reason}`, 3600)) {
    await pageNotifyCronAuth(
      `:warning: Booking membership refresh received a cron-marked request without a valid CRON_SECRET bearer (${cron.reason}). The immutable membership snapshot will age out if scheduled refreshes cannot authenticate.`,
    ).catch(() => {});
  }
}

async function handleBookingMembershipRefresh(req, res) {
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
      // Keep only the independently fingerprint-bound, no-send canary in the
      // webhook index while it is paused. Ordinary paused leads remain
      // excluded. This lets the scheduled rearm prove a real unpause→signed
      // webhook→pause cycle after every immutable membership refresh.
      includePausedLead: includeConfiguredPauseCanary,
    });
    // No Slack for a refresh that did not publish (2026-09-25, one-channel
    // rule). One of its codes, membership_refresh_checkpointed, is the normal
    // resumable checkpoint, and it posted a :rotating_light: about every 40
    // minutes. A snapshot that really goes stale is the booking sweep's to
    // report (its stale-sweep page); the attempt record below keeps the code.
    await recordAttempt(result.ok ? "success" : "failure", { result });
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
      bookingStopPolicy: result.bookingStopPolicy ?? null,
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
    // Recorded, not posted: the sweep's stale page is the persistent signal.
    await recordAttempt("failure", { error: code }).catch(() => {});
    return res.status(200).json({
      ok: false,
      complete: false,
      error: code,
      ranAt: new Date().toISOString(),
    });
  }
}

export default function handler(req, res) {
  return withParaformTelemetrySource("dashboard-booking", () => handleBookingMembershipRefresh(req, res));
}
