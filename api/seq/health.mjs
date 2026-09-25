import { timingSafeEqual } from "node:crypto";

import { cors, hasCookie, paraformHealth } from "./_lib/core.mjs";
import { withParaformTelemetrySource } from "../_lib/paraform-telemetry-context.mjs";
import {
  recordSessionLiveProof,
  raydarWebhookProofStatus,
  sweepStaleness,
} from "./_lib/booking-stop.mjs";
import { notifySwitchOn } from "../_lib/notify-switch.mjs";
import { parseBookingStopColdExclusions } from "./_lib/booking-stop-policy.mjs";
import {
  raydarSchedulerBookingStopEnabled,
  raydarSchedulerIndexConfigured,
} from "./_lib/raydar-booking-index.mjs";

const HEALTH_READ_KEY_PATTERN = /^\S{32,}$/u;
const CONTRACT_REVISION_PATTERN = /^[a-f0-9]{40}$/iu;

export function bookingStopPolicyConfigStatus(env = process.env) {
  try {
    const policy = parseBookingStopColdExclusions(
      env?.BOOKING_STOP_COLD_EXCLUSIONS_JSON ?? "",
    );
    return {
      valid: true,
      active: policy.active,
      schema: policy.schema,
      mode: policy.mode,
      policyDigest: policy.policyDigest,
      configuredCampaigns: policy.campaigns.length,
    };
  } catch {
    return {
      valid: false,
      active: false,
      schema: null,
      mode: null,
      policyDigest: null,
      configuredCampaigns: null,
    };
  }
}

/**
 * The scheduler may bind cutover evidence to this exact deployed dashboard
 * revision. The public health response stays unchanged: proof fields are
 * returned only when both the private bearer and an exact deployed revision
 * validate. An explicit revision supports audited local uploads; Vercel's Git
 * SHA remains the fallback for connected deployments. Every other state fails
 * closed to the existing redacted shape.
 */
export function authenticatedSchedulerHealthFields(
  req,
  env = process.env,
) {
  if (req?.method !== "GET") return {};

  const key = env?.SCHEDULER_DASHBOARD_HEALTH_READ_KEY;
  const revision = env?.RAYDAR_DASHBOARD_CONTRACT_REVISION
    ?? env?.VERCEL_GIT_COMMIT_SHA;
  const provided = req?.headers?.authorization;
  if (
    typeof key !== "string"
    || !HEALTH_READ_KEY_PATTERN.test(key)
    || typeof provided !== "string"
  ) {
    return {};
  }

  const actual = Buffer.from(provided, "utf8");
  const expected = Buffer.from(`Bearer ${key}`, "utf8");
  if (
    actual.length !== expected.length
    || !timingSafeEqual(actual, expected)
  ) {
    return {};
  }
  if (
    typeof revision !== "string"
    || !CONTRACT_REVISION_PATTERN.test(revision)
  ) {
    return {};
  }

  return {
    authenticated: true,
    contractRevision: revision.toLowerCase(),
    currentBookingStopPolicy: bookingStopPolicyConfigStatus(env),
  };
}

// System Health probes this endpoint with a 12 s timeout (seq-guardian in
// api/health/_lib/catalog.mjs). On a dead cookie paraformHealth() rides the
// full throttle ladder plus serial expiry probes (measured 42.5 s against a
// 401 stub, 2026-09-25 review), so the probe timed out, the engine recorded
// raw:null, and the paraform-session tile could not see the booking sweep's
// expiry witness in this payload. The live read now starts first, overlaps
// the KV reads, and is capped under the probe timeout; past the cap the
// response says paraform:"timeout" (not live, never a verdict of expired).
// The cap applies only with the #notify switch on: switch off, a slow but
// healthy 9 to 12 s read still answers live, as before (PR 230 review 3).
export const SEQ_HEALTH_LIVE_READ_BUDGET_MS = 9000;

function cappedLiveRead(read, budgetMs) {
  const live = Promise.resolve()
    .then(() => read())
    .catch((e) => ({ paraform: "error", detail: String(e?.message || e).slice(0, 160) }));
  if (!(Number(budgetMs) > 0)) return live;
  let timer;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => resolve({
      paraform: "timeout",
      detail: `live Paraform read took longer than ${Math.round(budgetMs / 1000)}s`,
    }), budgetMs);
    timer.unref?.();
  });
  return Promise.race([live, deadline]).finally(() => clearTimeout(timer));
}

/**
 * The sweep's confirmed-expiry witness against this tick's live read.
 *  - A live read made AFTER the witness proves the session is back (a
 *    recapture whose next sweeps failed for a non-auth reason used to leave
 *    the tile DOWN for the witness's whole 6 h TTL): record that live proof
 *    beside the witness, once. The witness itself is the sweep's to retire:
 *    deleting it here (review 2) let the next pass's pre-sweep stale check
 *    re-page the same dead-cookie incident on recovery (review 3). The tile
 *    and the sweep's stale check both read the proof.
 *  - A proof already recorded after the witness: the session is back.
 *  - Otherwise, with the #notify switch on, the witness is the answer:
 *    paraform:"expired" whatever the capped live read said (it is slow,
 *    paused, or a cached read older than the witness). Switch off: the
 *    live read is reported as before.
 */
async function reconcileWitness(h, bookingStop, { recordLiveProof, switchOn }) {
  const witnessAt = bookingStop?.sessionExpiredConfirmedAt;
  const witnessMs = Date.parse(String(witnessAt || ""));
  if (!Number.isFinite(witnessMs)) return h;
  const checkedMs = Date.parse(String(h?.checkedAt || ""));
  if (h?.paraform === "live" && Number.isFinite(checkedMs) && checkedMs > witnessMs) {
    if (!bookingStop.sessionLiveSinceWitnessAt) {
      await Promise.resolve().then(() => recordLiveProof(h.checkedAt)).catch(() => {});
      bookingStop.sessionLiveSinceWitnessAt = new Date(checkedMs).toISOString();
    }
    return h;
  }
  if (bookingStop.sessionLiveSinceWitnessAt) return h;
  if (!switchOn) return h;
  return {
    ...h,
    paraform: "expired",
    expiredSource: "booking-sweep-witness",
    liveRead: h?.paraform ?? null,
  };
}

export async function handleSequenceHealth(req, res, {
  healthReader = paraformHealth,
  staleness = sweepStaleness,
  webhookProof = raydarWebhookProofStatus,
  recordLiveProof = recordSessionLiveProof,
  env = process.env,
  liveReadBudgetMs = notifySwitchOn(env) ? SEQ_HEALTH_LIVE_READ_BUDGET_MS : null,
} = {}) {
  if (cors(req, res)) return; // health is open so the page can show status
  // Started before the KV reads so the two overlap (see the budget above).
  const liveRead = cappedLiveRead(healthReader, liveReadBudgetMs);
  const currentBookingStopPolicy = bookingStopPolicyConfigStatus();
  // Booking-stop liveness is reported HERE, on the one unauthenticated endpoint,
  // deliberately. The sweep's own staleness alarm lives inside the sweep — which
  // is no use at all if the sweep stops being invoked, and that is precisely the
  // failure that went unnoticed for nine days. Exposing it here means liveness
  // can be checked from outside the cron's own auth path (counts only, no PII).
  let bookingStop = null;
  try {
    const [s, webhook] = await Promise.all([
      staleness(),
      webhookProof(),
    ]);
    bookingStop = {
      currentBookingStopPolicy,
      // Set only while the booking sweep's CONFIRMED Paraform-session expiry
      // stands (spaced probes, not one 401; cleared only by a good pass, a
      // live-session throttle records a live proof instead). System Health's
      // paraform-session tile reads it once the #notify switch is on.
      // Additive (2026-09-25).
      sessionExpiredConfirmedAt: s.sessionExpiredConfirmedAt ?? null,
      // The first live read seen AFTER that witness (recapture): the tile
      // yields to it (set below on this tick's read, or from KV).
      sessionLiveSinceWitnessAt: s.sessionLiveSinceWitnessAt ?? null,
      lastSuccessfulSweep: s.lastAt,
      ageMinutes: s.ageMs == null ? null : Math.round(s.ageMs / 60000),
      stale: s.stale,
      activeLeadsLastPass: s.activeLeads ?? null,
      lastSweepMembershipSnapshotGeneration:
        s.lastSweepMembershipSnapshotGeneration ?? null,
      lastSweepMembershipCurrentMatch:
        s.lastSweepMembershipCurrentMatch ?? false,
      membershipSnapshot: {
        schema: s.membershipSnapshotSchema ?? null,
        generation: s.membershipSnapshotGeneration ?? null,
        current: s.membershipSnapshotCurrent ?? false,
        complete: s.membershipSnapshotComplete ?? false,
        oldestFetchedAt:
          s.membershipSnapshotOldestFetchedAt ?? null,
        ageMinutes: s.membershipSnapshotAgeMs == null
          ? null
          : Math.round(s.membershipSnapshotAgeMs / 60000),
        scopeSchema: s.membershipSnapshotScopeSchema ?? null,
        scopeDigest: s.membershipSnapshotScopeDigest ?? null,
        catalogSequenceCount:
          s.membershipSnapshotCatalogSequenceCount ?? null,
        selectedSequenceCount:
          s.membershipSnapshotSelectedSequenceCount ?? null,
        latestAttemptAt:
          s.membershipSnapshotLatestAttemptAt ?? null,
        latestAttemptStatus:
          s.membershipSnapshotLatestAttemptStatus ?? null,
        latestAttemptError:
          s.membershipSnapshotLatestAttemptError ?? null,
      },
      // Enough to tune BOOKING_STOP_PROFILE_BUDGET from outside the auth path.
      // durationMs against the budget shows headroom; profileCutShort says the
      // clock stopped the leg; coverage/rotor say how many passes the rotor
      // needs to reach every lead. Counts only, no candidate data.
      lastPassDurationMs: s.durationMs ?? null,
      profileCutShort: s.profileCutShort ?? null,
      profileCoverage: s.profileCoverage ?? null,
      profileRotorOf: s.profileRotorOf ?? null,
      lastPassLegMs: s.legMs ?? null,
      latestScopeClassification: s.latestScopeClassification == null
        ? null
        : {
          ...s.latestScopeClassification,
          ageMinutes: Math.round(
            s.latestScopeClassification.ageMs / 60000,
          ),
        },
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
        lastSweepDefinitionSequencesRead:
          s.definitionSequencesRead ?? null,
        lastSweepLinkSequences: s.linkSequences ?? null,
        lastSweepEnabledLinkSequences: s.enabledLinkSequences ?? null,
        lastSweepCoveredEnabledLinkSequences:
          s.coveredEnabledLinkSequences ?? null,
        lastSweepBookingStopPolicy: s.bookingStopPolicy ?? null,
        lastSweepLinkScopeComplete: s.linkScopeComplete ?? false,
        latestSweepAttemptAt: s.latestAttemptAt ?? null,
        latestSweepAttemptAgeMinutes: s.latestAttemptAgeMs == null
          ? null
          : Math.round(s.latestAttemptAgeMs / 60000),
        latestSweepAttemptStatus: s.latestAttemptStatus ?? null,
        latestSweepAttemptError: s.latestAttemptError ?? null,
        latestSweepAttemptBookingStopPolicy:
          s.latestAttemptBookingStopPolicy ?? null,
        latestSweepAttemptCurrent: s.latestAttemptCurrent ?? false,
        lastSweepMembershipSnapshotGeneration:
          s.lastSweepMembershipSnapshotGeneration ?? null,
        lastSweepMembershipCurrentMatch:
          s.lastSweepMembershipCurrentMatch ?? false,
        leadIndexAt: s.leadIndexAt ?? null,
        leadIndexAgeMinutes: s.leadIndexAgeMs == null
          ? null
          : Math.round(s.leadIndexAgeMs / 60000),
        leadIndexCurrent: s.leadIndexCurrent ?? false,
        ...authenticatedSchedulerHealthFields(req),
      },
    };
  } catch {
    bookingStop = { error: "unavailable", currentBookingStopPolicy };
  }

  const h = await reconcileWitness(await liveRead, bookingStop, {
    recordLiveProof,
    switchOn: notifySwitchOn(env),
  });
  res.status(200).json({ ok: h.paraform === "live", cookieSet: hasCookie(), ...h, bookingStop });
}

export default function handler(req, res) {
  return withParaformTelemetrySource("dashboard-health", () => handleSequenceHealth(req, res));
}
