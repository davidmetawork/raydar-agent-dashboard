// One evaluator per named check. Each returns:
//   { state: "OK"|"DEGRADED"|"DOWN", reason: string|null, metrics?: object }
//
// Evaluators NEVER see transport failures — the engine turns fetch errors,
// timeouts and unexpected statuses into UNKNOWN before calling here. So an
// evaluator can assume it has a parsed body (or null body with a status).
//
// Guiding rule from the 2026-08-06/07 outage: report what is TRUE, never what
// is convenient. A tile that cannot tell must say UNKNOWN, not OK.

const OK = (reason = null, metrics) => ({ state: "OK", reason, metrics });
const DEG = (reason, metrics) => ({ state: "DEGRADED", reason, metrics });
const DOWN = (reason, metrics) => ({ state: "DOWN", reason, metrics });
const UNK = (reason, metrics) => ({ state: "UNKNOWN", reason, metrics });

const ageMin = (iso) => {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? Math.round((Date.now() - t) / 60000) : null;
};

// ---------- candidate-facing ----------

/** The tile that matters most: can a candidate actually hold a slot right now. */
export function bookingDoor({ body, status }) {
  if (!body || typeof body !== "object") return UNK(`unparseable body (HTTP ${status})`);
  const checks = body.checks || {};
  const metrics = {
    ready: body.ready,
    agentAdmission: body.agentAdmission,
    checkedAt: body.checkedAt,
  };
  // agentAdmission was added by the 2026-08-07 fix. If it is absent the
  // deployment predates that fix and we cannot see the door — say so.
  if (body.agentAdmission === undefined) {
    return UNK("agentAdmission absent (release predates the honest-health fix)", metrics);
  }
  if (body.agentAdmission === false) return DOWN("admission closed — holds are 503ing", metrics);
  if (body.ok !== true) return DOWN(`health ok:false (HTTP ${status})`, metrics);
  const soft = ["agentCoverage", "sequenceStop", "nativeReminders", "humanIsolation"]
    .filter((k) => checks[k] === false);
  if (soft.length) return DEG(`door open; degraded: ${soft.join(", ")}`, metrics);
  return OK(null, metrics);
}

/** Ground truth for the door: what does /api/hold actually answer. */
export function bookingDoorHold({ body }) {
  if (!body || typeof body !== "object") return UNK("no probe result");
  const { hold, holdStatus, health } = body;
  const checks = health?.checks || {};
  const soft = ["agentCoverage", "sequenceStop", "nativeReminders", "humanIsolation"]
    .filter((k) => checks[k] === false);
  const metrics = {
    holdStatus,
    holdError: hold?.error || null,
    healthOk: health?.ok ?? null,
    healthAgentAdmission: health?.agentAdmission ?? null,
  };
  if (holdStatus === 409) {
    // slot_taken past the admission gate = the door is open.
    return soft.length
      ? DEG(`door open; degraded: ${soft.join(", ")}`, metrics)
      : OK(null, metrics);
  }
  if (holdStatus === 503) {
    const lying = health?.agentAdmission === true
      ? " (health claims admission open — attestation-level closure)" : "";
    return DOWN(`holds refused: ${hold?.error || "503"}${lying}`, metrics);
  }
  if (holdStatus === 429) return DEG("hold probe rate-limited", metrics);
  if (holdStatus === 403) return DOWN(`booking gates off: ${hold?.error || "403"}`, metrics);
  if (holdStatus >= 500) {
    // Any server error IS the door failing — the 2026-08-12 Neon quota outage
    // 500'd here for 7.5h and sat in UNKNOWN, which never pages.
    return DOWN(`hold probe HTTP ${holdStatus}: ${hold?.error || "server error"}`, metrics);
  }
  return UNK(`unexpected hold answer HTTP ${holdStatus}`, metrics);
}

export function bridge({ body }) {
  if (!body || typeof body !== "object") return UNK("unparseable body");
  const metrics = {
    calls: body.calls,
    uptimeHours: body.uptime ? Math.round(body.uptime / 3600) : null,
    maxLagSec: body.maxLagSec,
  };
  if (body.ok !== true) return DOWN("bridge reports not ok", metrics);
  if (Number(body.maxLagSec) > 5) return DEG(`audio lag ${body.maxLagSec}s`, metrics);
  return OK(null, metrics);
}

export function webviewStatus({ body, status }) {
  if (status === 503) return DOWN(`feed degraded: ${body?.error || "503"}`);
  if (!body || typeof body !== "object") return UNK("unparseable body");
  if (body.ok === false || body.degraded) return DEG(String(body.error || "degraded"));
  return OK();
}

/** Derived: Paraform cookie liveness, read from two lanes that already know. */
export function paraformSession({ results }) {
  const seq = results["seq-guardian"]?.raw;
  const paraai = results["paraai-lane"]?.raw;
  if (!seq && !paraai) return UNK("no seq/paraai health available this tick");
  const paraformState = String(paraai?.paraform?.status || paraai?.paraform || "");
  const metrics = { paraai: paraformState || null };
  if (/expired|no_cookie|invalid/i.test(paraformState)) {
    return DOWN(`Paraform session ${paraformState} — every Paraform lane is blind`, metrics);
  }
  const seqCookie = seq?.cookie ?? seq?.session;
  if (seqCookie === false) return DOWN("seq health reports no live Paraform session", metrics);
  const throttled = String(
    seq?.bookingStop?.latestAttemptError || seq?.latestAttemptError || "",
  );
  if (/throttl/i.test(throttled)) return DEG(`Paraform throttling: ${throttled}`, metrics);
  if (!paraformState && seqCookie === undefined) return UNK("health payloads lack a session field", metrics);
  return OK(null, metrics);
}

// ---------- generic ----------

export function okTrue({ body, status }) {
  if (body && typeof body === "object" && "ok" in body) {
    return body.ok === true ? OK() : DOWN(String(body.error || `ok:false (HTTP ${status})`));
  }
  // We asked a health endpoint whether it is healthy and it did not answer.
  // That is a question we cannot resolve, not a yes.
  return UNK(`no ok field in the response (HTTP ${status})`);
}

export function reachable({ status }) {
  return status >= 200 && status < 400 ? OK(null, { status }) : DOWN(`HTTP ${status}`);
}

// A CRON_SECRET-gated endpoint is HEALTHY when it answers 401: the function
// exists and rejected us, which is all an unauthenticated probe can prove.
// 404 means a stale `vercel --prod` deploy EVICTED the function (and its cron
// row) — the 2026-08-08 incident class that cost a candidate his human-handoff
// email for 84 minutes. Anything else is a question, not an answer.
export function authGated({ status }) {
  if (status === 401) return OK(null, { status });
  if (status === 404) return DOWN("HTTP 404 — function evicted by a stale deploy; redeploy lifecycle/ from main", { status });
  if (status === 0) return DOWN("unreachable", { status });
  return UNK(`HTTP ${status} (expected 401)`, { status });
}

// ---------- pipeline ----------

export function schedulerDetail({ body, status, keyMissing }) {
  if (keyMissing) return UNK("key-missing: SCHEDULER_HEALTH_READ_KEY not provisioned");
  if (!body || typeof body !== "object") return UNK(`unparseable body (HTTP ${status})`);
  // Unauthorized => we got the public shape back; we cannot see detail.
  if (!body.checks || body.schema === "raydar-scheduler-health-public-v1") {
    return UNK("read key rejected — got the public shape instead of detail");
  }
  const failing = Object.entries(body.checks)
    .filter(([, v]) => v?.ok === false || v === false)
    .map(([k]) => k);
  const metrics = { readyForCutover: body.readyForCutover, failing };
  if (body.ok !== true) return DOWN(`scheduler ok:false — ${failing.join(", ") || "unknown"}`, metrics);
  if (failing.length) return DEG(`degraded: ${failing.join(", ")}`, metrics);
  return OK(null, metrics);
}

export function reminderHealth({ body, status, keyMissing }) {
  if (keyMissing) return UNK("key-missing: CALL_REMINDER_HEALTH_READ_KEY not provisioned");
  if (status === 401) return UNK("read key rejected (401)");
  if (status === 503) return DOWN("reminders-health 503 (key unconfigured on lifecycle)");
  if (!body || typeof body !== "object") return UNK(`unparseable body (HTTP ${status})`);
  const last = body.lastOkAt || body.health?.lastOkAt;
  const mins = last ? ageMin(last) : null;
  const metrics = { lastOkAt: last, ageMin: mins };
  if (body.ok === false) return DOWN(String(body.error || "reminder lane not ok"), metrics);
  if (mins != null && mins > 120) return DEG(`no successful reminder tick for ${mins}m`, metrics);
  return OK(null, metrics);
}

export function paraaiLane({ body }) {
  if (!body || typeof body !== "object") return UNK("unparseable body");
  if (!("automation" in body) && !("paraform" in body)) {
    return UNK("response is not a paraai-health payload");
  }
  const a = body.automation || {};
  const q = a.queue || {};
  const metrics = { ready: a.ready, queued: q.queued, due: q.due, leased: q.leased };
  if (body.ok !== true) return DOWN(String(body.error || "paraai health ok:false"), metrics);
  if (a.ready === false) return DEG("automation not ready", metrics);
  if (Number(q.due) > 25) return DEG(`${q.due} items overdue in the queue`, metrics);
  return OK(null, metrics);
}

export function seqHealth({ body }) {
  if (!body || typeof body !== "object") return UNK("unparseable body");
  // Assert this is actually the seq-health payload. An object that merely
  // parses is not an answer — an error envelope contains no bad news either.
  if (!("bookingStop" in body) && !("paraform" in body) && !("sequenceCount" in body)) {
    return UNK("response is not a seq-health payload");
  }
  const bs = body.bookingStop || {};
  const metrics = {
    sequenceCount: body.sequenceCount,
    sweepStale: bs.stale,
    latestAttemptError: bs.latestAttemptError || null,
  };
  if (body.ok === false) return DOWN(String(body.error || "seq health ok:false"), metrics);
  if (bs.stale === true) {
    return DEG(`booking-stop sweep stale${bs.latestAttemptError ? `: ${bs.latestAttemptError}` : ""}`, metrics);
  }
  return OK(null, metrics);
}

// ---------- derived: fly / n8n ----------

export function bridgeMachine({ results }) {
  const up = results["screener-uplink"];
  if (!up) return UNK("bridge probe did not run");
  if (up.state === "UNKNOWN") return UNK(up.reason);
  return { state: up.state, reason: up.reason, metrics: up.metrics };
}

/** READ-ONLY consumer of the existing hourly n8n watchdog's KV state. */
export function n8nWatchdog({ watchdog }) {
  if (!watchdog) return UNK("watchdog state key absent (has /api/ops/n8n-watchdog ever run?)");
  const mins = ageMin(watchdog.at || watchdog.checkedAt);
  const metrics = { lastRunMin: mins, streaks: (watchdog.streaks || []).length };
  if (mins == null) return UNK("watchdog state has no timestamp", metrics);
  if (mins > 180) return UNK(`watchdog-stale: no run for ${mins}m`, metrics);
  if (watchdog.unreachable || watchdog.error) {
    return DOWN(`n8n unreachable from the watchdog: ${watchdog.error || "unknown"}`, metrics);
  }
  const streaks = watchdog.streaks || [];
  if (streaks.length) {
    const names = streaks.map((s) => s.workflowName || s.workflowId).slice(0, 4).join(", ");
    return DEG(`failing: ${names}`, metrics);
  }
  return OK(null, metrics);
}

// ---------- GitHub Actions ----------

// ---------- desktop ----------

/**
 * A lane is judged on heartbeat freshness plus a self-reported status.
 * Scheduled vendors can legitimately delay or drop an invocation, so callers
 * may define a degraded window before sustained silence becomes DOWN.
 */
export function beatLane({ probe, beat }) {
  if (!beat) return UNK("no beats yet");
  const mins = ageMin(beat.at);
  const metrics = { lastBeat: beat.at, ageMin: mins, status: beat.status };
  if (beat.status === "fail") {
    return DOWN(`lane reported failure: ${String(beat.note || "").slice(0, 120)}`, metrics);
  }
  if (mins == null) return UNK("beat has no timestamp", metrics);
  if (mins > probe.maxSilenceMin) return DOWN(`no beat for ${mins}m (max ${probe.maxSilenceMin}m)`, metrics);
  if (beat.status === "warn") {
    const note = String(beat.note || "").slice(0, 120);
    return DEG(note ? `lane reported warning: ${note}` : "lane reported warning", metrics);
  }
  if (
    Number.isFinite(probe.degradedAfterMin)
    && mins > probe.degradedAfterMin
  ) {
    return DEG(
      `heartbeat delayed ${mins}m (expected within ${probe.degradedAfterMin}m; down after ${probe.maxSilenceMin}m)`,
      metrics,
    );
  }
  return OK(null, metrics);
}

/**
 * The collapse rule. A closed laptop must produce ONE line, not sixteen.
 * When most lanes are simultaneously silent the runner is off, not broken —
 * individual lanes are rewritten to UNKNOWN/runner-offline by the engine.
 */
export function desktopRunner({ laneStates }) {
  const live = laneStates.filter((l) => !l.paused);
  if (!live.length) return UNK("no desktop lanes configured");
  const known = live.filter((l) => l.state !== "UNKNOWN" || l.reason !== "no beats yet");
  if (!known.length) return UNK("no lane has ever beaten");
  const overdue = known.filter((l) => l.state === "DOWN");
  const ratio = overdue.length / known.length;
  const metrics = { lanes: known.length, overdue: overdue.length };
  if (ratio >= 0.6) return DOWN(`runner offline — ${overdue.length}/${known.length} lanes silent`, metrics);
  if (overdue.length) return DEG(`${overdue.length} lane(s) overdue`, metrics);
  return OK(null, metrics);
}

// ---------- dependencies ----------

export function vendorApi({ status, keyMissing, probe }) {
  const envName = probe?.authEnv || "api key";
  if (keyMissing) return UNK(`key-missing: ${envName} not provisioned`);
  if (status === 401 || status === 403) return DOWN(`credentials rejected (${status}) — key revoked or expired`);
  if (status === 429) return DEG("rate limited (429)");
  if (status >= 500) return DEG(`vendor ${status}`);
  return status >= 200 && status < 300 ? OK(null, { status }) : DEG(`HTTP ${status}`);
}

// Reads the PUBLIC scheduler health body, not the authorized detail view.
// The public payload already carries these booleans, so watching Google,
// Postgres and the reminder lane needs no read key at all — provisioning a
// secret to learn something already published would be gratuitous.
const schedulerChecks = (results) => {
  const raw = results["booking-door"]?.raw;
  // booking-door is now a composite hold+health probe. Its raw body moved
  // from the scheduler health document to {hold, holdStatus, health}; keep the
  // direct form for old samples and isolated evaluator callers.
  return raw?.health?.checks || raw?.checks || null;
};

export function googleWorkspace({ results }) {
  const checks = schedulerChecks(results);
  if (!checks) return UNK("scheduler public health unavailable");
  const names = ["gmail", "calendars", "meetAccess", "humanStaffCalendars"];
  const failing = names.filter((n) => checks[n] === false);
  if (failing.length) return DEG(`failing: ${failing.join(", ")}`, { failing });
  return OK();
}

export function neonDb({ results }) {
  const checks = schedulerChecks(results);
  if (!checks) return UNK("scheduler public health unavailable");
  if (checks.database === false) return DOWN("scheduler cannot reach Postgres");
  return OK();
}

/** Reminder lane liveness, also from the public scheduler payload. */
export function nativeReminders({ results }) {
  const checks = schedulerChecks(results);
  if (!checks) return UNK("scheduler public health unavailable");
  if (checks.nativeReminders === false) {
    return DEG("reminder lane not reporting healthy to the scheduler");
  }
  return OK();
}

/** The vendor, not the workloads: a streaking workflow means n8n is UP and a
 *  workflow is broken. Only the watchdog's reachability verdict lands here. */
export function n8nCloud({ results }) {
  const n = results["n8n-workflows"];
  if (!n || n.state === "UNKNOWN") return UNK(n?.reason || "watchdog state unavailable");
  if (n.state === "DOWN") return DOWN(n.reason);
  return OK(null, n.metrics);
}

/** Reachability of the GitHub API itself, derived from the one Actions fetch. */

export function upstashKv({ kvOk }) {
  return kvOk ? OK() : DOWN("KV read-back failed this tick");
}

export function slackTransport({ lastDelivered }) {
  if (!lastDelivered) return UNK("no alert has been delivered yet");
  if (lastDelivered.failed) return DOWN(`last delivery exhausted retries at ${lastDelivered.at}`);
  return OK(null, { lastDelivered: lastDelivered.at });
}

export const EVALUATORS = {
  bookingDoorHold,
  bookingDoor, bridge, webviewStatus, paraformSession, okTrue, reachable, authGated,
  schedulerDetail, reminderHealth, paraaiLane, seqHealth, bridgeMachine,
  n8nWatchdog, beatLane, desktopRunner,
  vendorApi, googleWorkspace, neonDb, nativeReminders, upstashKv, slackTransport,
  n8nCloud,
};
