// BOOKING LIVE-SET REFRESH — once a day (GET, cron), or immediately on demand
// (POST, operator-triggered — the "immediately when a protected sequence is
// re-enabled" half of item 2: there is no push signal from Paraform for that,
// so re-enabling a sequence and calling this manually is the equivalent).
//
// Replaces the 10-minute booking-membership-refresh.mjs walk. Every Paraform
// request this makes is paced at <= 10/min, one in flight
// (_lib/booking-protection-pace.mjs).
import { timingSafeEqual } from "node:crypto";
import { cors, requireAuth, hasCookie, cronAuth, ensureParaformSession } from "./_lib/core.mjs";
import { shouldAlert } from "./_lib/booking-stop.mjs";
import { completeCampaignLeads } from "./_lib/core.mjs";
import {
  createPacer,
  pacedTrpcClient,
} from "./_lib/booking-protection-pace.mjs";
import {
  buildLiveSet,
  publishLiveSet,
} from "./_lib/booking-protection-liveset.mjs";
import {
  LITE_KEYS,
  kvGet,
  kvSet,
  kvConfigured,
} from "./_lib/booking-protection-store.mjs";
import { notifySlack } from "../paraai/_lib/core.mjs";
import { withParaformTelemetrySource } from "../_lib/paraform-telemetry-context.mjs";

export const config = { maxDuration: 280 };

// Stop starting new sequence walks well before maxDuration, so an overrun is
// recorded and alerted instead of being killed silently. A dead first
// session costs about 70 s of paced probes before the pacer moves on
// (ESTIMATED from the configured delays), which is what made this worth
// guarding. The last walk started is not bounded: 6.5 s of pacing plus an
// unpaced throttle ladder (about 36 s) can follow the check, so the budget
// leaves about 55 s. The run's durationMs is recorded; retune from that.
export const LIVESET_REFRESH_BUDGET_MS = 225_000;

const OPERATOR_KEY_PATTERN = /^\S{32,}$/u;

export function incompleteRefreshText(unverifiedSequences = []) {
  const parts = unverifiedSequences.map((s) => `${s.name || s.id} (${s.reason || "unread"})`);
  const listed = parts.slice(0, 5).join(", ") + (parts.length > 5 ? ` and ${parts.length - 5} more` : "");
  return `:warning: Booking live-set refresh published, but could not fully read ${unverifiedSequences.length} sequence(s): ${listed || "unnamed"}. Bookings checked against this index are held in the queue, not dropped, until a later refresh reads those sequences.`;
}

function operatorAuthorized(header, key) {
  if (!OPERATOR_KEY_PATTERN.test(String(key ?? "")) || typeof header !== "string") return false;
  const actual = Buffer.from(header, "utf8");
  const expected = Buffer.from(`Bearer ${key}`, "utf8");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

async function recordAttempt(status, extra = {}) {
  if (!kvConfigured()) return;
  await kvSet(LITE_KEYS.liveSetAttempt, {
    status,
    at: new Date().toISOString(),
    ...extra,
  }, 3 * 24 * 3600).catch(() => {});
}

async function runRefresh({ triggeredBy, startedAt = Date.now() }) {
  await ensureParaformSession();
  if (!hasCookie()) {
    await recordAttempt("failure", { error: "no_cookie" });
    return { ok: false, error: "no_cookie" };
  }
  const pace = createPacer();
  const client = pacedTrpcClient(pace);
  const listSequences = () => client.get("campaigns.getListOfCampaignsOptimized", {});
  // completeCampaignLeads walks one sequence internally (page reads, and a
  // rare oracle-backed backfill) at its own established pace; pacing is
  // applied BETWEEN sequences here, one sequence in flight at a time, which
  // is where the daily job's request volume actually lives (~1-3 requests per
  // selected sequence for the populations this design targets — see the
  // numbers table in the research doc). A single unusually large sequence's
  // own internal page walk can briefly exceed strict per-request spacing;
  // it stays far under Paraform's measured ~30/min refusal edge.
  const membershipLoader = (id) => completeCampaignLeads(id);
  const sleepBetweenSequences = () => pace(async () => {}).catch((error) => {
    if (error?.code === "PARAFORM_PACED_BACKOFF") throw error;
  });

  const liveSet = await buildLiveSet({
    listSequences,
    membershipLoader,
    sleepBetweenSequences,
    deadlineAt: startedAt + LIVESET_REFRESH_BUDGET_MS,
  });
  await publishLiveSet(liveSet);
  await recordAttempt("success", {
    triggeredBy,
    durationMs: Date.now() - startedAt,
    catalogSequences: liveSet.catalogSequences,
    candidateSequences: liveSet.candidateSequences,
    sequencesWithActiveLeads: liveSet.sequencesWithActiveLeads,
    leadsIndexed: liveSet.leadsIndexed,
    indexedEmails: liveSet.indexedEmails,
    incomplete: liveSet.incomplete,
    unverifiedSequences: liveSet.unverifiedSequences.length,
  });
  return {
    ok: true,
    triggeredBy,
    catalogSequences: liveSet.catalogSequences,
    candidateSequences: liveSet.candidateSequences,
    sequencesWithActiveLeads: liveSet.sequencesWithActiveLeads,
    leadsIndexed: liveSet.leadsIndexed,
    indexedEmails: liveSet.indexedEmails,
    incomplete: liveSet.incomplete,
    unverifiedSequences: liveSet.unverifiedSequences,
    errors: liveSet.errors,
  };
}

async function handleBookingLivesetRefresh(req, res) {
  if (cors(req, res)) return;
  const scheduled = req.method === "GET";
  const operator = req.method === "POST";
  if (!scheduled && !operator) {
    return res.status(405).json({ ok: false, error: "GET_or_POST_only" });
  }
  if (scheduled) {
    const cron = cronAuth(req);
    if (!cron.ok && !(await requireAuth(req, res))) return;
  } else if (!operatorAuthorized(req.headers?.authorization, process.env.RAYDAR_BOOKING_LIVESET_REFRESH_KEY)) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }

  const startedAt = Date.now();
  try {
    const result = await runRefresh({ triggeredBy: scheduled ? "cron" : "operator", startedAt });
    if (!result.ok && (await shouldAlert(`liveset-refresh-${result.error}`, 6 * 3600))) {
      await notifySlack(`:rotating_light: Booking live-set refresh could not run (${result.error}). The worker will keep serving the last published index until it ages past ${Math.round((36 * 3600))}s.`).catch(() => {});
    }
    if (result.ok && result.incomplete && (await shouldAlert("liveset-refresh-incomplete", 6 * 3600))) {
      await notifySlack(incompleteRefreshText(result.unverifiedSequences)).catch(() => {});
    }
    return res.status(200).json({ ...result, ranAt: new Date().toISOString() });
  } catch (error) {
    const code = error?.code === "PARAFORM_PACED_BACKOFF" ? "paced_backoff" : "error";
    await recordAttempt("failure", {
      error: code,
      reason: String(error?.code || "").slice(0, 60) || null,
      durationMs: Date.now() - startedAt,
    });
    if (await shouldAlert(`liveset-refresh-${code}`, 6 * 3600)) {
      await notifySlack(`:rotating_light: Booking live-set refresh failed: ${String(error?.message || error).slice(0, 160)}`).catch(() => {});
    }
    return res.status(200).json({ ok: false, error: code, detail: String(error?.message || error).slice(0, 200) });
  }
}

export default function handler(req, res) {
  return withParaformTelemetrySource("dashboard-booking", () => handleBookingLivesetRefresh(req, res));
}

export { runRefresh, kvGet };
