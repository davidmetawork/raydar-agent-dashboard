import { cors, hasCookie, paraformHealth } from "./_lib/core.mjs";
import {
  raydarWebhookProofStatus,
  sweepStaleness,
} from "./_lib/booking-stop.mjs";
import {
  raydarSchedulerBookingStopEnabled,
  raydarSchedulerIndexConfigured,
} from "./_lib/raydar-booking-index.mjs";

export default async function handler(req, res) {
  if (cors(req, res)) return; // health is open so the page can show status
  // Booking-stop liveness is reported HERE, on the one unauthenticated endpoint,
  // deliberately. The sweep's own staleness alarm lives inside the sweep — which
  // is no use at all if the sweep stops being invoked, and that is precisely the
  // failure that went unnoticed for nine days. Exposing it here means liveness
  // can be checked from outside the cron's own auth path (counts only, no PII).
  let bookingStop = null;
  try {
    const [s, webhook] = await Promise.all([
      sweepStaleness(),
      raydarWebhookProofStatus(),
    ]);
    bookingStop = {
      lastSuccessfulSweep: s.lastAt,
      ageMinutes: s.ageMs == null ? null : Math.round(s.ageMs / 60000),
      stale: s.stale,
      activeLeadsLastPass: s.activeLeads ?? null,
      raydarScheduler: {
        enabled: raydarSchedulerBookingStopEnabled(),
        applyEnabled: process.env.BOOKING_STOP_APPLY !== "0",
        webhookConfigured: String(process.env.RAYDAR_SCHEDULER_WEBHOOK_SECRET || "").length >= 32,
        webhookVerified: webhook.verified,
        pauseCanaryConfigured: webhook.canaryConfigured,
        pauseCanaryVerified: webhook.pauseCanaryVerified,
        lastWebhookSuccess: webhook.lastAt,
        lastWebhookAgeMinutes: webhook.ageMs == null
          ? null
          : Math.round(webhook.ageMs / 60000),
        lastWebhookApply: webhook.apply,
        lastWebhookDeferred: webhook.deferred,
        lastWebhookMatched: webhook.matched,
        lastWebhookPaused: webhook.paused,
        latestWebhookSuccess: webhook.latestLastAt,
        latestWebhookAgeMinutes: webhook.latestAgeMs == null
          ? null
          : Math.round(webhook.latestAgeMs / 60000),
        latestWebhookApply: webhook.latestApply,
        latestWebhookDeferred: webhook.latestDeferred,
        latestWebhookMatched: webhook.latestMatched,
        latestWebhookPaused: webhook.latestPaused,
        indexConfigured: raydarSchedulerIndexConfigured(),
        lastSweepCalendlyComplete: s.calendlyComplete ?? false,
        lastSweepEnabled: s.raydarEnabled ?? false,
        lastSweepComplete: s.raydarComplete ?? false,
        bookingsLastPass: s.raydarBookings ?? null,
        lastSweepScopeSchema: s.scopeSchema ?? null,
        lastSweepScopeDigest: s.scopeDigest ?? null,
        lastSweepScopeCatalogFloor: s.scopeCatalogFloor ?? null,
        lastSweepSequenceCatalogCount: s.sequenceCatalogCount ?? null,
        lastSweepSequenceScopeScanned: s.sequenceScopeScanned ?? null,
        lastSweepLinkSequences: s.linkSequences ?? null,
        lastSweepEnabledLinkSequences: s.enabledLinkSequences ?? null,
        lastSweepCoveredEnabledLinkSequences:
          s.coveredEnabledLinkSequences ?? null,
        lastSweepLinkScopeComplete: s.linkScopeComplete ?? false,
        latestSweepAttemptAt: s.latestAttemptAt ?? null,
        latestSweepAttemptAgeMinutes: s.latestAttemptAgeMs == null
          ? null
          : Math.round(s.latestAttemptAgeMs / 60000),
        latestSweepAttemptStatus: s.latestAttemptStatus ?? null,
        latestSweepAttemptError: s.latestAttemptError ?? null,
        latestSweepAttemptCurrent: s.latestAttemptCurrent ?? false,
        leadIndexAt: s.leadIndexAt ?? null,
        leadIndexAgeMinutes: s.leadIndexAgeMs == null
          ? null
          : Math.round(s.leadIndexAgeMs / 60000),
        leadIndexCurrent: s.leadIndexCurrent ?? false,
      },
    };
  } catch { bookingStop = { error: "unavailable" }; }

  try {
    const h = await paraformHealth();
    res.status(200).json({ ok: h.paraform === "live", cookieSet: hasCookie(), ...h, bookingStop });
  } catch (e) {
    res.status(200).json({ ok: false, cookieSet: hasCookie(), paraform: "error", detail: String(e.message || e).slice(0, 160), bookingStop });
  }
}
