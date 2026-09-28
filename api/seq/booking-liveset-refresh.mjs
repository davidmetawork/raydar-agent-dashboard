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
  pacedWithinDeadline,
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

// The catalog read has its own, earlier deadline. A catalog read that
// started later could not leave time to walk anything, and a 401 on it can
// still cost the pacer's paced probes (about 70 s, ESTIMATED) plus one
// attempt on the next session: started by this point, even that ends
// inside maxDuration.
export const LIVESET_CATALOG_BUDGET_MS = 120_000;

const OPERATOR_KEY_PATTERN = /^\S{32,}$/u;

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

/**
 * The walk's two paced call sites: the catalog read, and the pause between
 * sequence walks. Either can meet a backoff in force, written by an earlier
 * refusal in this run or by another invocation (a worker tick's refusal, or
 * the pacer holding others off while it confirms a 401). A backoff that ends
 * before the deadline is waited out instead of failing the day's refresh;
 * one that does not still fails it loudly as PARAFORM_PACED_BACKOFF. The
 * catalog read also gets one more attempt after a transient refusal (a
 * throttle 401, 403, 429, 5xx or transport failure), after its backoff, and
 * only before `catalogDeadlineAt`. A dead session with nowhere to move
 * (PARAFORM_SESSION_DEAD) fails the run at once instead of costing a
 * backoff between every walk. `stats` counts the waits for the record.
 */
export function refreshPacedCalls({
  pace,
  deadlineAt,
  catalogDeadlineAt = deadlineAt,
  stats = {},
  now,
  sleep,
  log,
} = {}) {
  const client = pacedTrpcClient(pace);
  stats.backoffWaits = 0;
  stats.backoffWaitMs = 0;
  stats.catalogRetries = 0;
  const waitSleep = sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const counted = {
    deadlineAt,
    now,
    log,
    sleep: async (ms) => {
      stats.backoffWaits++;
      stats.backoffWaitMs += ms;
      await waitSleep(ms);
    },
  };
  return {
    listSequences: () => pacedWithinDeadline(
      () => client.get("campaigns.getListOfCampaignsOptimized", {}),
      {
        ...counted,
        deadlineAt: catalogDeadlineAt,
        retryTransientRefusals: 1,
        label: "the catalog read",
        onRetry: () => { stats.catalogRetries++; },
      },
    ),
    sleepBetweenSequences: () => pacedWithinDeadline(
      () => pace(async () => {}),
      { ...counted, label: "the pause between sequence walks" },
    ).catch((error) => {
      if (error?.code === "PARAFORM_PACED_BACKOFF" || error?.code === "PARAFORM_SESSION_DEAD") throw error;
    }),
  };
}

async function runRefresh({ triggeredBy, startedAt = Date.now(), pacingStats = {} }) {
  await ensureParaformSession();
  if (!hasCookie()) {
    await recordAttempt("failure", { error: "no_cookie" });
    return { ok: false, error: "no_cookie" };
  }
  const deadlineAt = startedAt + LIVESET_REFRESH_BUDGET_MS;
  const pace = createPacer();
  const { listSequences, sleepBetweenSequences } = refreshPacedCalls({
    pace,
    deadlineAt,
    catalogDeadlineAt: startedAt + LIVESET_CATALOG_BUDGET_MS,
    stats: pacingStats,
  });
  // completeCampaignLeads walks one sequence internally (page reads, and a
  // rare oracle-backed backfill) at its own established pace; pacing is
  // applied BETWEEN sequences here, one sequence in flight at a time, which
  // is where the daily job's request volume actually lives (~1-3 requests per
  // selected sequence for the populations this design targets — see the
  // numbers table in the research doc). A single unusually large sequence's
  // own internal page walk can briefly exceed strict per-request spacing;
  // it stays far under Paraform's measured ~30/min refusal edge.
  const membershipLoader = (id) => completeCampaignLeads(id);

  const liveSet = await buildLiveSet({
    listSequences,
    membershipLoader,
    sleepBetweenSequences,
    deadlineAt,
  });
  await publishLiveSet(liveSet);
  await recordAttempt("success", {
    triggeredBy,
    durationMs: Date.now() - startedAt,
    ...pacingStats,
    catalogSequences: liveSet.catalogSequences,
    candidateSequences: liveSet.candidateSequences,
    sequencesWithActiveLeads: liveSet.sequencesWithActiveLeads,
    leadsIndexed: liveSet.leadsIndexed,
    indexedEmails: liveSet.indexedEmails,
    incomplete: liveSet.incomplete,
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
  const pacingStats = {};
  // Replaced by the outcome when the run ends. One the platform kills at
  // maxDuration stays "started", instead of showing the previous result.
  await recordAttempt("started", {
    triggeredBy: scheduled ? "cron" : "operator",
    startedAt: new Date(startedAt).toISOString(),
  });
  try {
    const result = await runRefresh({ triggeredBy: scheduled ? "cron" : "operator", startedAt, pacingStats });
    if (!result.ok && (await shouldAlert(`liveset-refresh-${result.error}`, 6 * 3600))) {
      await notifySlack(`:rotating_light: Booking live-set refresh could not run (${result.error}). The worker will keep serving the last published index until it ages past ${Math.round((36 * 3600))}s.`).catch(() => {});
    }
    if (result.ok && result.incomplete && (await shouldAlert("liveset-refresh-incomplete", 6 * 3600))) {
      await notifySlack(`:warning: Booking live-set refresh published with ${result.errors?.length || 0} sequence read error(s) — see /api/seq/health.`).catch(() => {});
    }
    return res.status(200).json({ ...result, ranAt: new Date().toISOString() });
  } catch (error) {
    const code = error?.code === "PARAFORM_PACED_BACKOFF" ? "paced_backoff" : "error";
    await recordAttempt("failure", {
      error: code,
      reason: String(error?.code || "").slice(0, 60) || null,
      durationMs: Date.now() - startedAt,
      ...pacingStats,
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
