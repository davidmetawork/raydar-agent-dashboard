// Paraform auth circuit breaker — OBSERVE-ONLY probe (phase 1).
//
// The shared Paraform session cookie is the recurring single point of failure
// across every cookie-consuming lane; when it dies, each lane discovers it
// separately and Slack drowns in per-item AUTH_EXPIRED spam (07-25→07-28).
// This probe rides the existing worker tick, but a durable cadence claim keeps
// the five-second Fly poller from turning it into a five-second auth hammer.
// A read-layer outage needs independently paced failed observations before it
// opens, and independently paced green observations before it closes. A Paraform
// mutation can also report a write-layer 401 into this module. That signal is
// latched until a later mutation succeeds: authorized reads are not evidence
// that the write layer recovered (2026-07-30 incident).
//
// Phase 1 contract (spec: docs/PARAFORM-ACTIONS-AUTOMATION-IDEAS-2026-07-29.md
// in the main repo, "Paraform auth circuit breaker with auto resume"):
// - This MODULE is the sole writer of the `auth:paraform:*` KV namespace.
//   Paraform mutation call sites report success/failure through the exported
//   functions below; they never write auth keys directly. The `paraai:*`
//   namespace stays single-writer for the Para AI API; nothing here touches it.
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

import { notifySlack, trpcGetRaw } from "./core.mjs";
import { kv } from "./store.mjs";

export const AUTH_FLAG_KEY = "auth:paraform:down";
export const AUTH_LAST_PROBE_KEY = "auth:paraform:lastprobe";
export const AUTH_OPEN_ALERT_KEY = "auth:paraform:alert:open";
export const AUTH_REMINDER_ALERT_KEY = "auth:paraform:alert:reminder";
export const AUTH_WRITE_FAILURE_KEY = "auth:paraform:write-failure";
export const AUTH_PROBE_CADENCE_KEY = "auth:paraform:probe:cadence";
export const AUTH_READ_SUSPECT_KEY = "auth:paraform:read-suspect";
export const AUTH_READ_RECOVERY_KEY = "auth:paraform:read-recovery";
const OPEN_ALERT_TTL_SECONDS = 30 * 24 * 60 * 60;
const REMINDER_TTL_SECONDS = 24 * 60 * 60;
const LAST_PROBE_TTL_SECONDS = 7 * 24 * 60 * 60;
const READ_CONFIRMATION_TTL_SECONDS = 30 * 60;
const DEFAULT_PROBE_INTERVAL_SECONDS = 5 * 60;
const DEFAULT_CONFIRMATION_SEPARATION_MS = 3 * 60 * 1000;
// Per-read cap so a hung Paraform read bounds the probe, never the worker's
// 120s budget. The underlying fetch keeps its own (longer) AbortSignal.
// A malformed override (e.g. "8s" → NaN) or a sub-500ms value must fall
// back instead of silently disarming the cap.
export function probeReadBudgetMs(
  raw = process.env.PARAFORM_AUTH_PROBE_BUDGET_MS,
) {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 500 ? n : 8_000;
}
const PROBE_READ_BUDGET_MS = probeReadBudgetMs();
const PROBE_RETRY_DELAY_MS = 500;
// A losing tick in the open-alert race must not immediately win the daily
// reminder slot and post "still OPEN (day 1)" seconds after the open alert;
// within this window of the recorded openedAt the reminder is skipped.
const REMINDER_AFTER_OPEN_GRACE_MS = 60 * 60 * 1000;

export function probeIntervalSeconds(
  raw = process.env.PARAFORM_AUTH_PROBE_INTERVAL_SECONDS,
) {
  const n = Number(raw);
  return Number.isFinite(n) && n >= DEFAULT_PROBE_INTERVAL_SECONDS
    ? Math.floor(n)
    : DEFAULT_PROBE_INTERVAL_SECONDS;
}

export function confirmationSeparationMs(
  raw = process.env.PARAFORM_AUTH_CONFIRMATION_SEPARATION_MS,
) {
  const n = Number(raw);
  return Number.isFinite(n) && n >= DEFAULT_CONFIRMATION_SEPARATION_MS
    ? Math.floor(n)
    : DEFAULT_CONFIRMATION_SEPARATION_MS;
}

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

async function probePasses({ trpcGetImpl, sleepImpl, budgetMs }) {
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

export async function probeParaformAuth(
  { budgetMs = PROBE_READ_BUDGET_MS } = {},
  { trpcGetImpl = trpcGetRaw, sleepImpl = sleep } = {},
) {
  // The per-read cap alone still lets slow failures stack: four near-budget
  // 401s plus the retry gap is ~4x the read budget before the lanes run.
  // One overall cap of 2x the per-read budget bounds the whole probe (both
  // passes AND the retry gap). Overrun proves nothing about the cookie, so
  // it fails open exactly like a per-read timeout.
  try {
    return await withBudget(
      probePasses({ trpcGetImpl, sleepImpl, budgetMs }),
      budgetMs * 2,
    );
  } catch (error) {
    return {
      healthy: null,
      reason: String(error?.code || error?.message || "probe_failed")
        .slice(0, 80),
    };
  }
}

// The worker endpoint is polled by both Vercel cron and a five-second Fly
// runner. Without a shared claim, every poll executes four auth reads in a
// failure case and the detector can create the very 401 burst it interprets.
// The cadence key is a lease, not state: a thrown tick releases it so the next
// poll can retry, while a completed (including unknown) observation remains
// paced. Write-layer reports bypass this wrapper and still open immediately.
export async function runScheduledAuthProbeTick(
  { now = Date.now() } = {},
  {
    probeImpl = probeParaformAuth,
    kvImpl = kv,
    notifyImpl = notifySlack,
    tickImpl = runAuthProbeTick,
  } = {},
) {
  const at = new Date(now).toISOString();
  const claimed = (await kvImpl([
    "SET",
    AUTH_PROBE_CADENCE_KEY,
    at,
    "NX",
    "EX",
    probeIntervalSeconds(),
  ])) === "OK";
  if (!claimed) return { status: "skipped", reason: "cadence", down: null };
  try {
    return await tickImpl(
      { now },
      { probeImpl, kvImpl, notifyImpl },
    );
  } catch (error) {
    await kvImpl(["DEL", AUTH_PROBE_CADENCE_KEY]).catch(() => {});
    throw error;
  }
}

// The ops endpoint is a public unauthenticated read: raw internal error
// strings (vendor bodies, cookie-store messages) must never be republished
// verbatim. The raw reason still lands in the KV heartbeat for operators;
// the endpoint sees only this closed enum: ok | recovered_on_retry |
// auth_suspected | recovery_pending | auth_expired |
// probe_budget_exceeded | network | vendor_error |
// no_cookie | store_error.
export function publicProbeReason(raw) {
  const reason = String(raw ?? "").trim();
  if (!reason) return null;
  if (reason === "ok" || reason === "recovered_on_retry") return reason;
  if (reason === "auth_expired" || reason === "AUTH_EXPIRED") {
    return "auth_expired";
  }
  if (reason === "auth_suspected" || reason === "recovery_pending") {
    return reason;
  }
  if (reason === "write_auth_expired") return "write_auth_expired";
  if (reason === "PROBE_BUDGET_EXCEEDED") return "probe_budget_exceeded";
  if (/no paraform session cookie|PARAFORM_SESSION_COOKIE not found/i.test(reason)) {
    return "no_cookie";
  }
  if (/^n8n variables read failed|^PARAFORM_SESSION_COOKIE_|^STATE_STORE/.test(reason)) {
    return "store_error";
  }
  if (
    reason === "fetch failed" // undici TypeError, no code
    || /^E[A-Z_]+$/.test(reason) // node socket codes (ECONNRESET, EAI_AGAIN)
    || /^UND_ERR/.test(reason) // undici error codes
    || /^\d+$/.test(reason) // DOMException numeric codes (timeout/abort)
    || /timeout|abort|network/i.test(reason)
  ) {
    return "network";
  }
  // HTTP_5xx, tRPC body codes, and anything unrecognized: the vendor said
  // something, and what it said stays out of the public response.
  return "vendor_error";
}

// Public state shape for GET /api/ops/paraform-auth. Deliberately minimal:
// {down, since, lastProbe, alert} — no cookie material, reasons mapped to
// the closed enum above, and of the alert only the secrets-free delivery
// summary. The alert summary is surfaced ON PURPOSE: Para AI production has
// no Slack token, so the flag + endpoint ARE the alert channel and a
// consumer must be able to see whether the open post was ever delivered.
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
          reason: publicProbeReason(lastProbe.reason),
        }
      : null,
    alert: flag?.alert
      ? {
          openedAt: flag.alert.openedAt || null,
          delivered: flag.alert.delivered === true,
        }
      : null,
  };
}

export async function runAuthProbeTick(
  { now = Date.now() } = {},
  { probeImpl = probeParaformAuth, kvImpl = kv, notifyImpl = notifySlack } = {},
) {
  const at = new Date(now).toISOString();
  const observed = await probeImpl();
  const writeFailure = parse(await kvImpl(["GET", AUTH_WRITE_FAILURE_KEY]));
  // A green GET cannot clear a mutation-layer 401. Keep the outage latched
  // until reportParaformWriteAuthSuccess atomically clears the signal after a
  // later successful Paraform mutation.
  const probe = writeFailure
    ? {
        healthy: false,
        reason: "write_auth_expired",
        evidence: {
          code: "AUTH_EXPIRED",
          mode: "write",
          lane: writeFailure.lane || "unknown",
          stage: writeFailure.stage || "unknown",
          observedAt: writeFailure.observedAt || null,
        },
      }
    : observed;
  const existing = parse(await kvImpl(["GET", AUTH_FLAG_KEY]));
  const writeHeartbeat = async (healthy, reason) => kvImpl([
    "SET",
    AUTH_LAST_PROBE_KEY,
    JSON.stringify({ at, healthy, reason }),
    "EX",
    LAST_PROBE_TTL_SECONDS,
  ]);

  if (probe.healthy === null) {
    // Fail open: a probe that could not reach Paraform proves nothing about
    // the cookie. It also breaks the consecutive-evidence chain: independent
    // observations must agree, with no unknown or green sample in between.
    await kvImpl(["DEL", AUTH_READ_SUSPECT_KEY]);
    await kvImpl(["DEL", AUTH_READ_RECOVERY_KEY]);
    await writeHeartbeat(null, probe.reason);
    return { status: "unknown", reason: probe.reason, down: Boolean(existing) };
  }

  if (probe.healthy === true) {
    await kvImpl(["DEL", AUTH_READ_SUSPECT_KEY]);
    if (!existing) {
      await kvImpl(["DEL", AUTH_READ_RECOVERY_KEY]);
      await writeHeartbeat(true, probe.reason);
      return { status: "healthy", down: false, resumed: false };
    }

    // Read-layer recovery uses hysteresis too. One green poll seconds after a
    // burst is not enough to announce recovery and reopen on the next burst.
    // A write-layer incident is different: reportParaformWriteAuthSuccess has
    // already supplied the stronger proof of a successful later mutation, so
    // it may close on the next green read without another delay.
    const writeLayerIncident = existing?.evidence?.mode === "write";
    if (!writeLayerIncident) {
      const recovery = parse(await kvImpl(["GET", AUTH_READ_RECOVERY_KEY]));
      const firstAtMs = Date.parse(String(recovery?.firstAt || ""));
      const separated = Number.isFinite(firstAtMs)
        && now - firstAtMs >= confirmationSeparationMs();
      if (!separated) {
        const record = {
          version: 1,
          firstAt: Number.isFinite(firstAtMs) ? recovery.firstAt : at,
          lastAt: at,
        };
        await kvImpl([
          "SET",
          AUTH_READ_RECOVERY_KEY,
          JSON.stringify(record),
          "EX",
          READ_CONFIRMATION_TTL_SECONDS,
        ]);
        await writeHeartbeat(null, "recovery_pending");
        return { status: "recovering", down: true, resumed: false };
      }
    }

    await writeHeartbeat(true, probe.reason);
    await kvImpl(["DEL", AUTH_READ_RECOVERY_KEY]);
    // Auto-resume. Alert slots are cleared BEFORE the flag: a crash between
    // the two re-runs this path next tick (the flag still exists), so a
    // suppressed open alert on the next real outage is impossible. The DEL
    // of the flag is then the atomic claim on the episode: overlapping
    // ticks (cron + Fly) can both read the flag as present, but only the
    // tick whose DEL actually removes it sends the resumed post.
    await kvImpl(["DEL", AUTH_OPEN_ALERT_KEY]);
    await kvImpl(["DEL", AUTH_REMINDER_ALERT_KEY]);
    const claimed = Number(await kvImpl(["DEL", AUTH_FLAG_KEY])) === 1;
    if (!claimed) return { status: "healthy", down: false, resumed: false };
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

  await kvImpl(["DEL", AUTH_READ_RECOVERY_KEY]);

  // A real mutation 401 remains an immediate write-layer verdict. A read-only
  // failure is merely a suspicion until another paced probe (not another call
  // in the same burst) independently agrees after the separation window.
  let since = existing?.since || at;
  if (probe.reason !== "write_auth_expired" && !existing) {
    const suspect = parse(await kvImpl(["GET", AUTH_READ_SUSPECT_KEY]));
    const firstAtMs = Date.parse(String(suspect?.firstAt || ""));
    const separated = Number.isFinite(firstAtMs)
      && now - firstAtMs >= confirmationSeparationMs();
    if (!separated) {
      const record = {
        version: 1,
        firstAt: Number.isFinite(firstAtMs) ? suspect.firstAt : at,
        lastAt: at,
      };
      await kvImpl([
        "SET",
        AUTH_READ_SUSPECT_KEY,
        JSON.stringify(record),
        "EX",
        READ_CONFIRMATION_TTL_SECONDS,
      ]);
      await writeHeartbeat(null, "auth_suspected");
      return { status: "suspected", down: false, opened: false };
    }
    since = suspect.firstAt;
  }
  await kvImpl(["DEL", AUTH_READ_SUSPECT_KEY]);
  await writeHeartbeat(false, probe.reason);

  // Confirmed down: either independently paced read probes agreed, or a real
  // mutation returned 401. The flag has no TTL on purpose — a dead cookie
  // stays dead until recaptured, and probe staleness is visible separately.
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
    const evidence = probe.reason === "write_auth_expired"
      ? `a Paraform mutation returned 401 at ${probe.evidence?.lane || "unknown"}:${probe.evidence?.stage || "unknown"} while read canaries may still be green`
      : `independently paced checks both saw repeated 401s on ${PROBE_READS.map((read) => read.proc).join(" + ")}`;
    const delivered = await notifyImpl(
      `🚨 Paraform auth circuit OPEN — the shared session cookie is rejected (${evidence}). Every cookie-consuming lane can fail with AUTH_EXPIRED until it is recaptured — ${RECAPTURE_RUNBOOK}. A write-layer outage stays latched until a later mutation succeeds; green reads alone cannot close it. One daily reminder follows while it stays down. Observe-only: no lane is held by this flag yet.`,
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

  // The open slot already exists (this tick lost the open NX, or the
  // episode is simply ongoing). Two duties, both on the slot's value — the
  // openedAt ISO stamp written at open:
  // - TTL refresh (XX): the 30d TTL is only a leak guard; unrefreshed it
  //   would expire mid-episode on day 31 and the next NX would re-post a
  //   duplicate open alert. XX never resurrects a slot that already
  //   expired — closing the episode is what deletes it for real.
  // - Reminder grace: a tick that lost the open NX seconds ago must not win
  //   the reminder NX and post "still OPEN (day 1)" right after the open
  //   alert. Skip the reminder inside the grace window; an absent or
  //   unparseable stamp keeps the reminder as the crash fallback (a tick
  //   that died between the open NX and the open notify).
  const openedAtRaw = await kvImpl(["GET", AUTH_OPEN_ALERT_KEY]);
  if (openedAtRaw != null) {
    await kvImpl([
      "SET", AUTH_OPEN_ALERT_KEY, openedAtRaw, "XX", "EX", OPEN_ALERT_TTL_SECONDS,
    ]);
  }
  const openedAtMs = Date.parse(String(openedAtRaw ?? ""));
  if (Number.isFinite(openedAtMs) && now - openedAtMs < REMINDER_AFTER_OPEN_GRACE_MS) {
    return { status: "down", down: true };
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

// Mutation call sites report a Paraform 401 here. The report is durable before
// the circuit is opened, so a crash between the two cannot lose the evidence:
// the next ordinary probe tick sees the latch and opens the circuit itself.
export async function reportParaformWriteAuthFailure(
  {
    lane = "unknown",
    stage = "unknown",
    now = Date.now(),
  } = {},
  {
    kvImpl = kv,
    notifyImpl = notifySlack,
  } = {},
) {
  const observedAt = new Date(now).toISOString();
  const record = {
    version: 1,
    observedAt,
    lane: String(lane || "unknown").slice(0, 48),
    stage: String(stage || "unknown").slice(0, 80),
    code: "AUTH_EXPIRED",
  };
  await kvImpl(["SET", AUTH_WRITE_FAILURE_KEY, JSON.stringify(record)]);
  const result = await runAuthProbeTick(
    { now },
    {
      probeImpl: async () => ({
        healthy: false,
        reason: "write_auth_expired",
        evidence: {
          code: "AUTH_EXPIRED",
          mode: "write",
          lane: record.lane,
          stage: record.stage,
          observedAt,
        },
      }),
      kvImpl,
      notifyImpl,
    },
  );
  return { record, circuit: result };
}

// A lane-level AUTH_EXPIRED has already survived the Para AI client's paced
// ladder and serial two-procedure confirmation, but it still belongs to the
// read-layer hysteresis instead of owning a separate Slack alert. Recording it
// here seeds (or advances) the shared suspicion; a later independently paced
// worker probe must agree before the one circuit alert is allowed to fire.
export async function reportParaformReadAuthFailure(
  {
    lane = "unknown",
    stage = "unknown",
    now = Date.now(),
  } = {},
  {
    kvImpl = kv,
    notifyImpl = notifySlack,
  } = {},
) {
  const result = await runAuthProbeTick(
    { now },
    {
      probeImpl: async () => ({
        healthy: false,
        reason: "auth_expired",
        evidence: {
          code: "AUTH_EXPIRED",
          mode: "read",
          lane: String(lane || "unknown").slice(0, 48),
          stage: String(stage || "unknown").slice(0, 80),
        },
      }),
      kvImpl,
      notifyImpl,
    },
  );
  return { lane, stage, circuit: result };
}

// Clear only a failure observed no later than this successful mutation. The
// timestamp comparison happens atomically in Redis so an older success racing
// a newer failure cannot erase the newer outage.
export async function reportParaformWriteAuthSuccess(
  {
    lane = "unknown",
    stage = "unknown",
    now = Date.now(),
  } = {},
  {
    kvImpl = kv,
  } = {},
) {
  const succeededAt = new Date(now).toISOString();
  const script = `
    local raw = redis.call('GET', KEYS[1])
    if not raw then return 0 end
    local ok, current = pcall(cjson.decode, raw)
    if not ok then return 0 end
    local observed = tostring(current.observedAt or '')
    if observed ~= '' and observed <= ARGV[1] then
      return redis.call('DEL', KEYS[1])
    end
    return 0
  `;
  const cleared = Number(await kvImpl([
    "EVAL", script, 1, AUTH_WRITE_FAILURE_KEY, succeededAt,
  ])) === 1;
  return {
    cleared,
    succeededAt,
    lane: String(lane || "unknown").slice(0, 48),
    stage: String(stage || "unknown").slice(0, 80),
  };
}
