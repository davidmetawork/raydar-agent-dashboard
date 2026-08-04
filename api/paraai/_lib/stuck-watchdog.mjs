// Stuck-job watchdog.
//
// On 2026-08-03 every candidate screened for 14 hours stalled in
// resolving_identity and nothing said so. The CRM walk outlived its Vercel
// invocation, so the function was killed before it could journal, record an
// error, or raise a code — and every alert this lane has fires on an explicit
// error code. A failure with no code is silent by construction, and the stale
// sweep re-running the same job forever looks identical to healthy work.
//
// This watches the one thing that is true regardless of how the failure
// happened: a job that should be moving is not moving. It is deliberately
// state-shaped rather than error-shaped, because the next silent failure will
// not resemble this one either.
//
// Alerts only when a human must act, per the repo rule: routine retries are
// silent, and the alert slot throttles repeats so a standing backlog does not
// post every five minutes.

// Pre-submit states a job passes THROUGH. None is a resting place: a job in one
// of these is mid-flight and should leave within minutes. Review and terminal
// states are deliberately absent — a job parked in needs_review is a decision,
// not a stall.
export const IN_FLIGHT_STATES = Object.freeze([
  "detected",
  "resolving_identity",
  "extracting",
  "ready_to_submit",
  "submit_intent",
  "submitting",
]);

export function stuckThresholdMs(raw = process.env.PARAAI_STUCK_ALERT_MINUTES) {
  const minutes = Number(raw);
  return (Number.isFinite(minutes) && minutes >= 5 ? minutes : 45) * 60_000;
}

const age = (value, now) => {
  const at = Date.parse(String(value || ""));
  return Number.isFinite(at) ? now - at : null;
};

// A job counts as stuck on its LAST MOVEMENT, not its creation: a candidate
// legitimately waiting on a slow vendor read has a recent updatedAt, while the
// 2026-08-03 jobs sat with the same updatedAt for hours because the killed
// function never wrote one.
export function findStuckJobs(jobs = [], { now = Date.now(), thresholdMs = stuckThresholdMs() } = {}) {
  const inFlight = new Set(IN_FLIGHT_STATES);
  return (Array.isArray(jobs) ? jobs : [])
    .filter((job) => inFlight.has(String(job?.state || "")))
    .map((job) => ({
      id: String(job?.id || ""),
      name: String(job?.candidate?.fullName || "unknown"),
      state: String(job?.state || ""),
      stalledMs: age(job?.updatedAt || job?.createdAt, now),
    }))
    .filter((row) => Number.isFinite(row.stalledMs) && row.stalledMs >= thresholdMs)
    .sort((left, right) => right.stalledMs - left.stalledMs);
}

const hours = (ms) => (ms / 3_600_000).toFixed(1);

export function stuckAlertMessage(stuck = [], { requeued = 0 } = {}) {
  if (!stuck.length) return null;
  const worst = stuck[0];
  const states = [...new Set(stuck.map((row) => row.state))].sort().join(", ");
  const names = stuck.slice(0, 3).map((row) => row.name).join(", ");
  const more = stuck.length > 3 ? ` +${stuck.length - 3} more` : "";
  return `🚨 Para AI: ${stuck.length} job(s) stuck before submission for over `
    + `${hours(worst.stalledMs)}h — states: ${states}. Oldest: ${worst.name} `
    + `(${worst.state}, ${hours(worst.stalledMs)}h). Affected: ${names}${more}. `
    + `No new candidate is reaching the Talent Network while this holds. `
    + (requeued ? `Re-queued ${requeued} with no queue entry. ` : "")
    + `Review https://monitor.raydar.xyz/paraai`;
}

// The slot key carries the count bucket, so a backlog that GROWS re-alerts
// while a steady one stays quiet. A silent failure that keeps swallowing new
// candidates must not be throttled into looking resolved.
export function stuckAlertSlotKey(stuck = []) {
  const bucket = stuck.length >= 20 ? "20+"
    : stuck.length >= 10 ? "10+"
      : stuck.length >= 5 ? "5+"
        : "1+";
  return `paraai-stuck-${bucket}`;
}

export async function runStuckWatchdogTick({
  listJobsImpl,
  alertSlotImpl,
  notifyImpl,
  enqueueImpl = null,
  now = Date.now(),
  thresholdMs = stuckThresholdMs(),
  limit = 500,
} = {}) {
  let jobs = [];
  try {
    jobs = await listJobsImpl(limit);
  } catch (error) {
    return { ok: false, error: String(error?.message || error).slice(0, 120), stuck: 0, alerted: false };
  }
  const stuck = findStuckJobs(jobs, { now, thresholdMs });
  if (!stuck.length) return { ok: true, stuck: 0, alerted: false, requeued: 0 };

  // A job can be stalled simply because nothing is going to tick it. Only the
  // screener recovery feed enqueues work, so a job that entered any other way —
  // a human call, or a job re-prepared out of band — can sit at ready_to_submit
  // forever with no queue entry and no error: it is not failing, nobody is
  // asking. enqueueAutoJob is idempotent, so re-queueing a job that already has
  // an entry is a no-op, and this stays silent because it is routine
  // self-healing rather than something a human must act on.
  let requeued = 0;
  if (typeof enqueueImpl === "function") {
    for (const row of stuck) {
      try {
        const result = await enqueueImpl(row.id, {
          source: "stuck_watchdog",
          eventId: `stuck:${row.id}:${Math.floor(now / 3_600_000)}`,
          dueAt: now,
        });
        if (result?.enqueued) requeued += 1;
      } catch { /* a failed re-queue must never break the alert below */ }
    }
  }

  const took = await alertSlotImpl(stuckAlertSlotKey(stuck), 3 * 3600).catch(() => false);
  if (!took) return { ok: true, stuck: stuck.length, alerted: false, requeued };
  await notifyImpl(stuckAlertMessage(stuck, { requeued })).catch(() => {});
  return { ok: true, stuck: stuck.length, alerted: true, requeued, oldest: stuck[0] };
}
