import {
  acquireInboxSyncLock,
  assembleInboxSnapshotFeed,
  buildInboxRefresh,
  cors,
  INBOX_SYNC_BATCH_SIZE,
  inboxTrpcGet,
  readInboxSnapshotState,
  releaseInboxSyncLock,
  requireInboxAuth,
  writeInboxRefreshState,
} from "./_lib/core.mjs";
import { paraformBackgroundPauseState } from "../_lib/paraform-background-pause.mjs";

export const MANUAL_INBOX_MIN_INTERVAL_MS = 3_000;
export const MANUAL_INBOX_MAX_RUN_AGE_MS = 30 * 60 * 1_000;

const REFUSAL_CODES = new Set([
  "PARAFORM_THROTTLED",
  "PARAFORM_UPSTREAM",
  "PARAFORM_TIMEOUT",
  "PARAFORM_NETWORK",
]);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function requestBody(req) {
  if (typeof req?.body === "string") {
    try { return JSON.parse(req.body || "{}"); } catch { return null; }
  }
  return req?.body && typeof req.body === "object" ? req.body : {};
}

function manualRunStart(body, nowMs) {
  if (!body?.run_started_at) return new Date(nowMs).toISOString();
  if (typeof body.run_started_at !== "string") return null;
  const parsed = Date.parse(body.run_started_at);
  if (
    !Number.isFinite(parsed)
    || parsed > nowMs + 5_000
    || nowMs - parsed > MANUAL_INBOX_MAX_RUN_AGE_MS
  ) return null;
  return new Date(parsed).toISOString();
}

function configuredPause(state) {
  return state?.paused === true
    && state?.state === "configured"
    && typeof state?.pauseId === "string"
    && state.pauseId.length > 0;
}

export function manualInboxProgress(state, runStartedAtMs) {
  const targets = Array.isArray(state?.catalog?.targets)
    ? state.catalog.targets
    : [];
  const targetIds = targets.map((campaign) => String(campaign?.id || ""))
    .filter(Boolean);
  const uiTargetIds = targets
    .filter((campaign) => campaign?.ui_admitted !== false)
    .map((campaign) => String(campaign?.id || ""))
    .filter(Boolean);
  const refreshed = (sequenceId) => {
    const value = Date.parse(state?.snapshots?.get(sequenceId)?.refreshed_at || "");
    return Number.isFinite(value) && value >= runStartedAtMs;
  };
  const refreshedCount = targetIds.filter(refreshed).length;
  const uiRefreshedCount = uiTargetIds.filter(refreshed).length;
  return {
    campaigns_targeted: targetIds.length,
    campaigns_refreshed: refreshedCount,
    campaigns_remaining: Math.max(0, targetIds.length - refreshedCount),
    ui_campaigns_targeted: uiTargetIds.length,
    ui_campaigns_refreshed: uiRefreshedCount,
    ui_campaigns_remaining: Math.max(0, uiTargetIds.length - uiRefreshedCount),
  };
}

export function createPacedManualInboxGet({
  get = inboxTrpcGet,
  sleepImpl = sleep,
  nowMs = Date.now,
  intervalMs = MANUAL_INBOX_MIN_INTERVAL_MS,
} = {}) {
  let queue = Promise.resolve();
  let nextAllowedAt = 0;
  let callsStarted = 0;
  let callsSucceeded = 0;
  let firstRefusal = null;

  const pacedGet = (procedure, input, _tries = 1, timeoutMs) => {
    const task = queue.then(async () => {
      if (firstRefusal) {
        const stopped = new Error("STOPPED_AFTER_FIRST_PROVIDER_REFUSAL");
        stopped.code = "STOPPED_AFTER_FIRST_PROVIDER_REFUSAL";
        throw stopped;
      }
      const delay = Math.max(0, nextAllowedAt - nowMs());
      if (delay > 0) await sleepImpl(delay);
      nextAllowedAt = nowMs() + Math.max(0, intervalMs);
      callsStarted += 1;
      try {
        const value = await get(procedure, input, 1, timeoutMs);
        callsSucceeded += 1;
        return value;
      } catch (error) {
        if (REFUSAL_CODES.has(error?.code)) {
          firstRefusal = {
            code: error.code,
            after_calls_started: callsStarted,
            after_calls_succeeded: callsSucceeded,
          };
        }
        throw error;
      }
    });
    queue = task.catch(() => undefined);
    return task;
  };
  pacedGet.stats = () => ({
    calls_started: callsStarted,
    calls_succeeded: callsSucceeded,
    first_refusal: firstRefusal,
  });
  return pacedGet;
}

export function createManualInboxSyncHandler({
  corsHandler = cors,
  authHandler = requireInboxAuth,
  pauseState = () => paraformBackgroundPauseState("dashboardReaders"),
  acquireLock = acquireInboxSyncLock,
  readState = readInboxSnapshotState,
  buildRefresh = buildInboxRefresh,
  writeState = writeInboxRefreshState,
  releaseLock = releaseInboxSyncLock,
  assembleFeed = assembleInboxSnapshotFeed,
  pacedGetFactory = createPacedManualInboxGet,
  now = () => new Date(),
} = {}) {
  return async function handler(req, res) {
    if (corsHandler(req, res)) return;
    res.setHeader("Cache-Control", "private, no-store, max-age=0");
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return res.status(405).json({ ok: false, error: "method_not_allowed" });
    }
    const contentType = String(req.headers?.["content-type"] || "")
      .split(";", 1)[0].trim().toLowerCase();
    if (contentType !== "application/json") {
      return res.status(415).json({ ok: false, error: "unsupported_media_type" });
    }
    if (!(await authHandler(req, res))) return;
    const body = requestBody(req);
    if (!body) return res.status(400).json({ ok: false, error: "invalid_json" });
    const nowMs = now().getTime();
    const runStartedAt = manualRunStart(body, nowMs);
    if (!runStartedAt) {
      return res.status(400).json({ ok: false, error: "invalid_run_started_at" });
    }
    const runStartedAtMs = Date.parse(runStartedAt);

    const pauseBefore = await pauseState()
      .catch(() => ({ paused: true, state: "unreadable" }));
    if (!configuredPause(pauseBefore)) {
      return res.status(pauseBefore?.state === "absent" ? 409 : 503).json({
        ok: false,
        error: pauseBefore?.state === "absent"
          ? "manual_refresh_requires_background_pause"
          : "pause_control_unavailable",
      });
    }

    const lock = await acquireLock();
    if (lock.status === "busy") {
      res.setHeader("Retry-After", "15");
      return res.status(202).json({
        ok: true,
        status: "in_progress",
        run_started_at: runStartedAt,
        retry_after_seconds: 15,
      });
    }
    if (lock.status !== "acquired") {
      return res.status(503).json({ ok: false, error: "inbox_store_unavailable" });
    }

    const pacedGet = pacedGetFactory();
    try {
      const state = await readState();
      if (state.status === "unavailable") {
        return res.status(503).json({ ok: false, error: "inbox_store_not_configured" });
      }
      if (state.status !== "ready") {
        return res.status(502).json({ ok: false, error: "inbox_snapshot_unavailable" });
      }

      const refresh = await buildRefresh({
        previousState: state.value,
        get: pacedGet,
        concurrency: 1,
        batchSize: INBOX_SYNC_BATCH_SIZE,
        budgetMs: 110_000,
        forceRefreshAfterMs: runStartedAtMs,
      });
      const pauseAfterReads = await pauseState()
        .catch(() => ({ paused: true, state: "unreadable" }));
      if (
        !configuredPause(pauseAfterReads)
        || pauseAfterReads.pauseId !== pauseBefore.pauseId
      ) {
        return res.status(409).json({ ok: false, error: "pause_state_changed" });
      }

      const nextState = await writeState(state.value, refresh);
      const pauseAfterWrite = await pauseState()
        .catch(() => ({ paused: true, state: "unreadable" }));
      if (
        !configuredPause(pauseAfterWrite)
        || pauseAfterWrite.pauseId !== pauseBefore.pauseId
      ) {
        return res.status(409).json({ ok: false, error: "pause_state_changed" });
      }
      const feed = assembleFeed(nextState);
      const progress = manualInboxProgress(nextState, runStartedAtMs);
      const provider = pacedGet.stats();
      const complete = progress.campaigns_remaining === 0
        && refresh.scan.campaigns_failed === 0
        && refresh.scan.recent_failed === false
        && !provider.first_refusal;
      const payload = {
        ok: complete || (
          refresh.scan.campaigns_failed === 0
          && refresh.scan.recent_failed === false
          && !provider.first_refusal
        ),
        status: complete ? "manual_refresh_complete" : "manual_refresh_progress",
        complete,
        run_started_at: runStartedAt,
        generated_at: refresh.generated_at,
        progress,
        counts: feed.counts,
        freshness: feed.freshness,
        scan: refresh.scan,
        provider,
      };
      if (provider.first_refusal) {
        res.setHeader("Retry-After", "300");
        return res.status(429).json({
          ...payload,
          ok: false,
          error: "paraform_provider_refusal",
          retry_after_seconds: 300,
        });
      }
      if (refresh.scan.campaigns_failed > 0 || refresh.scan.recent_failed) {
        return res.status(502).json({
          ...payload,
          ok: false,
          error: "manual_refresh_incomplete",
        });
      }
      return res.status(200).json(payload);
    } catch (error) {
      const provider = pacedGet.stats();
      if (provider.first_refusal) {
        res.setHeader("Retry-After", "300");
        return res.status(429).json({
          ok: false,
          error: "paraform_provider_refusal",
          run_started_at: runStartedAt,
          provider,
          retry_after_seconds: 300,
        });
      }
      return res.status(error?.code === "AUTH_EXPIRED" ? 503 : 502).json({
        ok: false,
        error: error?.code === "AUTH_EXPIRED"
          ? "paraform_auth_expired"
          : "manual_refresh_unavailable",
        detail: String(error?.message || error).slice(0, 180),
      });
    } finally {
      await releaseLock(lock.token);
    }
  };
}

export default createManualInboxSyncHandler();
