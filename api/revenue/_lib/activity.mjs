// The operational half of the homepage: Paraform funnel activity + calls set.
//
// Two sources, both read-only, both allowed to fail independently. A dead
// source nulls its own section and says so; it never zeroes a tile and never
// takes the revenue half down with it. Revenue is our own ledger and has no
// dependency on anything in this file.
//
// HONESTY CONTRACT. Every value that leaves here carries a `basis`, and
// anything derived from a rate carries `estimated: true`. Metrics that Paraform
// genuinely cannot answer for a recruiter session are absent, not zero:
//   - first-round interviews  — no field is confirmed strictly first-round
//   - final rounds            — only a live stock count exists, never a flow
//   - offers out              — only a rate exists, never a count
//   - job applicants          — desktop-local SQLite, unreachable from here
// Those four are surfaced to the UI in `unavailable[]` with their reason, so
// the page can show an honest gap. This is a compensation-facing surface; an
// invented number here is worse than a missing one.

import { fetchRaydarBookingIndex } from "../../seq/_lib/raydar-booking-index.mjs";
import { bookingsByWeek, monthsOfYear, today, yearOf } from "./model.mjs";

const METRICS_URL = process.env.REVENUE_PARAFORM_METRICS_URL
  || "https://webview-lake.vercel.app/api/paraform-metrics";

export const UNAVAILABLE = [
  { metric: "First-round interviews", reason: "Paraform exposes no field confirmed to be strictly first-round; its exact funnel endpoint returns 401 for recruiter sessions." },
  { metric: "Final rounds", reason: "Only a live count of who sits in the final stage right now exists. There is no historical flow to count." },
  { metric: "Offers out", reason: "Paraform carries an offer rate, never an offer count. Multiplying would be a guess." },
  { metric: "Job applicants", reason: "Workable data lands in a desktop-local database that no cloud function can read." },
];

/**
 * Pull the already-cached placement metrics payload from the webview backend.
 * That endpoint serves its own KV last-good copy in ~250ms, so this is a cheap
 * hop, not a Paraform round trip.
 */
export async function fetchParaformMetrics({ fetchImpl = fetch, url = METRICS_URL } = {}) {
  const response = await fetchImpl(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(12_000),
  });
  if (!response.ok) throw new Error(`paraform_metrics_http_${response.status}`);
  const body = await response.json();
  if (!body || typeof body !== "object") throw new Error("paraform_metrics_invalid");
  return body;
}

/**
 * Paraform's monthly hire counts, keyed YYYY-MM, for the reconciliation check.
 *
 * `goal_pace.monthly` is the calendar-month series (deliberately NOT the 1m
 * window, which counts calendar months merely OVERLAPPING a 30-day span and so
 * can absorb a whole extra month). Month labels arrive as bare names with no
 * year, so they are anchored by counting back from the current month.
 */
export function hiresByMonth(metrics, asOf) {
  const monthly = metrics?.goal_pace?.monthly;
  if (!Array.isArray(monthly) || !monthly.length) return null;

  const names = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
  const currentMonth = Number(String(asOf).slice(5, 7));
  const currentYear = Number(yearOf(asOf));
  const out = {};

  // Walk backwards from the newest entry, which the endpoint anchors to the
  // current month, so an unlabelled year can never drift.
  for (let i = monthly.length - 1, offset = 0; i >= 0; i -= 1, offset += 1) {
    const entry = monthly[i];
    const hires = Number(entry?.hires ?? entry?.hired ?? entry?.count);
    if (!Number.isFinite(hires)) continue;
    const absolute = (currentYear * 12 + (currentMonth - 1)) - offset;
    const year = Math.floor(absolute / 12);
    const month = (absolute % 12) + 1;

    // If the payload labels its month, trust the label over the position —
    // it catches a stale refresh that would otherwise shift the whole series.
    const label = String(entry?.month || entry?.label || "").toLowerCase().slice(0, 3);
    const labelled = names.findIndex((name) => name.startsWith(label));
    if (label && labelled >= 0 && labelled + 1 !== month) continue;

    out[`${year}-${String(month).padStart(2, "0")}`] = hires;
  }
  return Object.keys(out).length ? out : null;
}

/** Calls set per trailing week, from the scheduler's cursor-complete booking index. */
export async function fetchCallsSet({ asOf, weeks = 12, now = Date.now(), fetchImpl = fetch } = {}) {
  const lookbackDays = weeks * 7 + 7;
  const result = await fetchRaydarBookingIndex({ fetchImpl, now, lookbackDays, limit: 100 });
  const series = bookingsByWeek(result.bookingList, { asOf, weeks });
  const current = series[series.length - 1] || { agent: 0, human: 0, total: 0 };
  const complete = series.slice(0, -1);
  const priorAverage = complete.length
    ? Math.round(complete.reduce((total, week) => total + week.total, 0) / complete.length)
    : null;
  return {
    basis: "raydar_scheduler_bookings",
    note: "Counted by the date the call was booked. Native Raydar Scheduler bookings only, so weeks before the scheduler cutover read low.",
    generatedAt: result.generatedAt,
    weeks: series,
    thisWeek: { agent: current.agent, human: current.human, total: current.total, partial: true },
    priorWeekAverage: priorAverage,
  };
}

/**
 * Build the whole activity payload. Each source is settled independently so one
 * failure degrades one section.
 */
export async function buildActivity({ now = new Date(), weeks = 12, fetchImpl = fetch } = {}) {
  const asOf = today(now);
  const [metricsResult, callsResult] = await Promise.allSettled([
    fetchParaformMetrics({ fetchImpl }),
    fetchCallsSet({ asOf, weeks, now: now.getTime(), fetchImpl }),
  ]);

  const errors = [];
  let paraform = null;
  let hires = null;

  if (metricsResult.status === "fulfilled") {
    const metrics = metricsResult.value;
    hires = hiresByMonth(metrics, asOf);
    const windows = metrics.windows || {};
    paraform = {
      fetchedAt: metrics.fetched_at || null,
      degraded: Boolean(metrics.degraded),
      degradedReason: metrics.degraded_reason || null,
      lifetime: {
        submissions: metrics.lifetime?.submissions ?? null,
        interviews: metrics.lifetime?.interviews ?? null,
        hired: metrics.lifetime?.hired ?? null,
      },
      // Trailing windows, labelled as such. These are NOT calendar periods:
      // 3m is 91 days and 1y is 365 days. The UI must not relabel them.
      windows: ["1w", "1m", "3m", "6m", "1y"].reduce((out, key) => {
        const window = windows[key];
        if (window) {
          out[key] = {
            days: window.days,
            submissions: window.metrics?.submissions ?? null,
            interviews: window.metrics?.interviews ?? null,
            hired: window.metrics?.hired ?? null,
            ratios: window.ratios || null,
          };
        }
        return out;
      }, {}),
      hiresByMonth: hires,
      goalHiresPerMonth: metrics.goal_pace?.goal_per_month ?? 10,
      funnelLive: metrics.funnel_live || null,
    };
  } else {
    errors.push({ source: "paraform", error: String(metricsResult.reason?.message || metricsResult.reason).slice(0, 200) });
  }

  const calls = callsResult.status === "fulfilled" ? callsResult.value : null;
  if (callsResult.status === "rejected") {
    errors.push({ source: "calls", error: String(callsResult.reason?.message || callsResult.reason).slice(0, 200) });
  }

  return {
    asOf,
    builtAt: new Date(now).toISOString(),
    paraform,
    calls,
    hiresByMonth: hires,
    unavailable: UNAVAILABLE,
    errors,
    // The whole payload is useless only if BOTH halves are gone.
    ok: Boolean(paraform || calls),
  };
}

export { monthsOfYear };
