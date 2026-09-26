// BOOKING LIVE-SET REFRESH — once a day (GET, cron), or immediately on demand
// (POST, operator-triggered — the "immediately when a protected sequence is
// re-enabled" half of item 2: there is no push signal from Paraform for that,
// so re-enabling a sequence and calling this manually is the equivalent).
//
// Replaces the 10-minute booking-membership-refresh.mjs walk. Every Paraform
// request this makes is paced at <= 10/min, one in flight
// (_lib/booking-protection-pace.mjs).
import { timingSafeEqual } from "node:crypto";
import { cors, requireAuth, hasCookie, cronAuth } from "./_lib/core.mjs";
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

async function runRefresh({ triggeredBy }) {
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
  });
  await publishLiveSet(liveSet);
  await recordAttempt("success", {
    triggeredBy,
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

  try {
    const result = await runRefresh({ triggeredBy: scheduled ? "cron" : "operator" });
    if (!result.ok && (await shouldAlert(`liveset-refresh-${result.error}`, 6 * 3600))) {
      await notifySlack(`:rotating_light: Booking live-set refresh could not run (${result.error}). The worker will keep serving the last published index until it ages past ${Math.round((36 * 3600))}s.`).catch(() => {});
    }
    if (result.ok && result.incomplete && (await shouldAlert("liveset-refresh-incomplete", 6 * 3600))) {
      await notifySlack(`:warning: Booking live-set refresh published with ${result.errors?.length || 0} sequence read error(s) — see /api/seq/health.`).catch(() => {});
    }
    return res.status(200).json({ ...result, ranAt: new Date().toISOString() });
  } catch (error) {
    const code = error?.code === "PARAFORM_PACED_BACKOFF" ? "paced_backoff" : "error";
    await recordAttempt("failure", { error: code });
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
