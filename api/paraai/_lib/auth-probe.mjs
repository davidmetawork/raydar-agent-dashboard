// Paraform auth circuit breaker — OBSERVE-ONLY probe (phase 1).
//
// The shared Paraform session cookie is the recurring single point of failure
// across every cookie-consuming lane; when it dies, each lane discovers it
// separately and Slack drowns in per-item AUTH_EXPIRED spam (07-25→07-28).
// This probe rides the existing */5 worker tick, confirms a real auth outage
// with two distinct cheap tRPC reads plus one retry pass, and records ONE
// durable flag that a future per-lane rollout can hold on.
//
// Phase 1 contract (spec: docs/PARAFORM-ACTIONS-AUTOMATION-IDEAS-2026-07-29.md
// in the main repo, "Paraform auth circuit breaker with auto resume"):
// - The probe is the SOLE writer of the `auth:paraform:*` KV namespace. The
//   `paraai:*` namespace stays single-writer for the Para AI API; nothing
//   here touches it.
// - NO lane holds on the flag yet. Lane consumption ships later, per lane,
//   each behind its own gate.
// - Hold semantics apply only to Paraform's own 401s. A network error, vendor
//   5xx, or probe-budget timeout proves nothing about the cookie: it NEVER
//   sets the flag (fail open). The same correction binds future consumers:
//   when the flag endpoint (GET /api/ops/paraform-auth) is unreachable, a
//   lane MUST fail OPEN to its normal per-lane behavior.
// - Exactly one Slack alert when the circuit opens, at most one daily
//   "still down (day N)" reminder, and one "cookie healthy — resumed" post
//   when the probe goes green. The Para AI lane is known to have no Slack
//   token configured in production; delivery is therefore recorded on the
//   flag and surfaced by the ops endpoint instead of being assumed.
// - The probe consumes the shared cookie through the existing core.mjs
//   helpers and never logs or stores the cookie value anywhere.

import { notifySlack, trpcGet } from "./core.mjs";
import { kv } from "./store.mjs";

export const AUTH_FLAG_KEY = "auth:paraform:down";
export const AUTH_LAST_PROBE_KEY = "auth:paraform:lastprobe";
export const AUTH_OPEN_ALERT_KEY = "auth:paraform:alert:open";
export const AUTH_REMINDER_ALERT_KEY = "auth:paraform:alert:reminder";
const OPEN_ALERT_TTL_SECONDS = 30 * 24 * 60 * 60;
const REMINDER_TTL_SECONDS = 24 * 60 * 60;
const LAST_PROBE_TTL_SECONDS = 7 * 24 * 60 * 60;
// Per-read cap so a hung Paraform read bounds the probe, never the worker's
// 120s budget. The underlying fetch keeps its own (longer) AbortSignal.
const PROBE_READ_BUDGET_MS = Number(
  process.env.PARAFORM_AUTH_PROBE_BUDGET_MS || 8_000,
);
const PROBE_RETRY_DELAY_MS = 500;

// Two DISTINCT cheap reads, so a lone intermittent 401 on one proc never
// trips the breaker. Both shapes are the proven ones already used by
// core.mjs (user.getCurrentUser is the LinkedIn-resolution entry read; the
// CRM input mirrors crmPage at page 1). tries=1: the probe manages its own
// retry pass and must see non-auth failures immediately.
export const PROBE_READS = Object.freeze([
  { proc: "user.getCurrentUser", input: {} },
  {
    proc: "candidateUser.getCRMExternalCandidates",
    input: {
      filters: { sort: { field: "updated_at", direction: "desc" } },
      limit: 1,
      cursor: 0,
    },
  },
]);

export const RECAPTURE_RUNBOOK =
  "recapture on the desktop: node src/ingest/persist-paraform-browser-session.mjs (main repo)";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const parse = (raw, fallback = null) => {
  if (raw == null) return fallback;
  try { return JSON.parse(raw); } catch { return fallback; }
};

export function slackAlertingConfigured() {
  const channel = process.env.PARAAI_SLACK_CHANNEL
    || process.env.SLACK_CHANNEL_ID_ALERTS
    || "";
  return Boolean(
    (process.env.SLACK_BOT_TOKEN && channel) || process.env.SLACK_WEBHOOK_URL,
  );
}

// The losing promise keeps running under its own AbortSignal and is
// catch-attached so a late rejection can never surface as unhandled.
function withBudget(promise, ms) {
  promise.catch(() => {});
  let timer;
  const budget = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error("PROBE_BUDGET_EXCEEDED");
      error.code = "PROBE_BUDGET_EXCEEDED";
      reject(error);
    }, ms);
  });
  return Promise.race([promise, budget]).finally(() => clearTimeout(timer));
}

// One pass over the distinct reads. Any authorized response means the
// session is alive (a 401 on the other proc would be the known lone
// intermittent, not an outage), so the first success short-circuits.
async function probePass({ trpcGetImpl, budgetMs }) {
  for (const read of PROBE_READS) {
    try {
      await withBudget(trpcGetImpl(read.proc, read.input, 1), budgetMs);
      return { outcome: "healthy", confirmedBy: read.proc };
    } catch (error) {
      if (error?.code !== "AUTH_EXPIRED") {
        // Network failure, vendor 5xx, cookie-store read failure, or budget:
        // NOT evidence of a dead cookie. Fail open and stop this tick.
        return {
          outcome: "unknown",
          reason: String(error?.code || error?.message || "probe_failed")
            .slice(0, 80),
        };
      }
      // A genuine Paraform 401 → try the next distinct read.
    }
  }
  return { outcome: "auth_failed" };
}

export async function probeParaformAuth(
  { budgetMs = PROBE_READ_BUDGET_MS } = {},
  { trpcGetImpl = trpcGet, sleepImpl = sleep } = {},
) {
  const first = await probePass({ trpcGetImpl, budgetMs });
  if (first.outcome === "healthy") {
    return { healthy: true, reason: "ok", confirmedBy: first.confirmedBy, passes: 1 };
  }
  if (first.outcome === "unknown") {
    return { healthy: null, reason: first.reason, passes: 1 };
  }
  // Both distinct reads 401'd. Retry once before declaring down — lone
  // intermittent 401s are known Paraform behavior (verifier note), and a
  // 401 already cleared the cookie cache, so this pass rereads the store.
  await sleepImpl(PROBE_RETRY_DELAY_MS);
  const second = await probePass({ trpcGetImpl, budgetMs });
  if (second.outcome === "healthy") {
    return {
      healthy: true,
      reason: "recovered_on_retry",
      confirmedBy: second.confirmedBy,
      passes: 2,
    };
  }
  if (second.outcome === "unknown") {
    return { healthy: null, reason: second.reason, passes: 2 };
  }
  return {
    healthy: false,
    reason: "auth_expired",
    passes: 2,
    evidence: {
      procs: PROBE_READS.map((read) => read.proc),
      passes: 2,
      code: "AUTH_EXPIRED",
    },
  };
}

// Public state shape for GET /api/ops/paraform-auth. Deliberately minimal:
// {down, since, lastProbe} only — no cookie material, no alert internals.
export function paraformAuthState({ flag = null, lastProbe = null } = {}) {
  return {
    down: Boolean(flag),
    since: flag?.since || null,
    lastProbe: lastProbe
      ? {
          at: lastProbe.at || null,
          healthy: typeof lastProbe.healthy === "boolean"
            ? lastProbe.healthy
            : null,
          reason: lastProbe.reason || null,
        }
      : null,
  };
}

export async function runAuthProbeTick(
  { now = Date.now() } = {},
  { probeImpl = probeParaformAuth, kvImpl = kv, notifyImpl = notifySlack } = {},
) {
  const at = new Date(now).toISOString();
  const probe = await probeImpl();
  // Heartbeat first: the ops endpoint must show probe staleness even when
  // nothing else changes.
  await kvImpl([
    "SET",
    AUTH_LAST_PROBE_KEY,
    JSON.stringify({ at, healthy: probe.healthy, reason: probe.reason }),
    "EX",
    LAST_PROBE_TTL_SECONDS,
  ]);
  const existing = parse(await kvImpl(["GET", AUTH_FLAG_KEY]));

  if (probe.healthy === null) {
    // Fail open: a probe that could not reach Paraform proves nothing about
    // the cookie. An existing open circuit stays exactly as it is.
    return { status: "unknown", reason: probe.reason, down: Boolean(existing) };
  }

  if (probe.healthy === true) {
    if (!existing) return { status: "healthy", down: false, resumed: false };
    // Auto-resume. Alert slots are cleared BEFORE the flag: a crash between
    // the two can only cause a duplicate "resumed" post next tick, never a
    // suppressed open alert on the next real outage.
    await kvImpl(["DEL", AUTH_OPEN_ALERT_KEY]);
    await kvImpl(["DEL", AUTH_REMINDER_ALERT_KEY]);
    await kvImpl(["DEL", AUTH_FLAG_KEY]);
    const delivered = await notifyImpl(
      `✅ Paraform cookie healthy — resumed (auth circuit closed; was down since ${existing.since || "unknown"}). Observe-only: no lane was held by the flag.`,
    ).catch(() => false);
    return {
      status: "healthy",
      down: false,
      resumed: true,
      alertDelivered: delivered === true,
    };
  }

  // Confirmed down: both distinct reads returned 401 on both passes. The
  // flag has no TTL on purpose — a dead cookie stays dead until recaptured,
  // and probe staleness is visible separately via the heartbeat key.
  const since = existing?.since || at;
  const record = {
    version: 1,
    since,
    lastProbeAt: at,
    evidence: probe.evidence || null,
    alert: existing?.alert || null,
  };
  await kvImpl(["SET", AUTH_FLAG_KEY, JSON.stringify(record)]);

  // Exactly ONE alert per open episode, NX-guarded so overlapping ticks
  // (cron + Fly poller) cannot double-post.
  const openedNow = (await kvImpl([
    "SET", AUTH_OPEN_ALERT_KEY, at, "NX", "EX", OPEN_ALERT_TTL_SECONDS,
  ])) === "OK";
  if (openedNow) {
    // Arm the reminder slot now so the first "still down" lands ~24h after
    // the open alert, not on the very next tick.
    await kvImpl([
      "SET", AUTH_REMINDER_ALERT_KEY, at, "EX", REMINDER_TTL_SECONDS,
    ]);
    const delivered = await notifyImpl(
      `🚨 Paraform auth circuit OPEN — the shared session cookie is rejected (two consecutive 401s on ${PROBE_READS.map((read) => read.proc).join(" + ")}, retried once). Every cookie-consuming lane will fail with AUTH_EXPIRED until it is recaptured — ${RECAPTURE_RUNBOOK}. One daily reminder follows while it stays down. Observe-only: no lane is held by this flag yet.`,
    ).catch(() => false);
    record.alert = { openedAt: at, delivered: delivered === true };
    await kvImpl(["SET", AUTH_FLAG_KEY, JSON.stringify(record)]);
    return {
      status: "down",
      down: true,
      opened: true,
      alertDelivered: delivered === true,
    };
  }

  // At most one "still down" reminder per day, also NX-guarded.
  const remindedNow = (await kvImpl([
    "SET", AUTH_REMINDER_ALERT_KEY, at, "NX", "EX", REMINDER_TTL_SECONDS,
  ])) === "OK";
  if (remindedNow) {
    const sinceMs = Date.parse(String(since));
    const day = Number.isFinite(sinceMs)
      ? Math.max(1, Math.floor((now - sinceMs) / 86_400_000) + 1)
      : 1;
    await notifyImpl(
      `⏳ Paraform auth circuit still OPEN (day ${day}) — cookie still rejected since ${since}. ${RECAPTURE_RUNBOOK}.`,
    ).catch(() => false);
    return { status: "down", down: true, reminded: true, day };
  }

  return { status: "down", down: true };
}
