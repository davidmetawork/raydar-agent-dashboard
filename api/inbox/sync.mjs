import {
  acquireInboxSyncLock,
  assembleInboxSnapshotFeed,
  buildInboxRefresh,
  cors,
  INBOX_CHANGED_BATCH_SIZE,
  readInboxSnapshotState,
  releaseInboxSyncLock,
  requireInboxAuth,
  resolveInboxParaformSession,
  writeInboxRefreshState,
} from "./_lib/core.mjs";
import { cronAuth } from "../seq/_lib/core.mjs";
import { paraformBackgroundPauseState } from "../_lib/paraform-background-pause.mjs";

// The Inbox refreshes on the vercel.json schedule (a GET carrying the
// CRON_SECRET bearer) and when someone presses Refresh now (a signed-in
// POST). Both run the change-driven refresh: one catalog read, one recent
// window, reply counts in batches of ten, and reads only for sequences with
// evidence of change. Opening the page no longer calls Paraform.
export const INBOX_SCHEDULED_ALERT_AFTER_MS = 20 * 60 * 60 * 1_000;
const SCHEDULED_LOCK_WAIT_MS = 15_000;
const SCHEDULED_LOCK_ATTEMPTS = 3;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Slack only when a person has to act: the scheduled refresh has not verified
// the Inbox for most of a day (two or more runs in a row), or sequences have
// stayed unconfirmed past the stale window. Deduplicated to once a day.
export async function alertInboxRefreshNeedsAttention(detail, {
  shouldAlertImpl,
  notifySlackImpl,
} = {}) {
  const shouldAlert = shouldAlertImpl
    || (await import("../seq/_lib/booking-stop.mjs")).shouldAlert;
  const notifySlack = notifySlackImpl
    || (await import("../paraai/_lib/core.mjs")).notifySlack;
  if (!(await shouldAlert("inbox-scheduled-refresh-attention", 24 * 3600))) return false;
  await notifySlack(
    `:warning: The Monitor Sequence Inbox needs attention: ${detail} `
      + "New Paraform replies may be missing from monitor.raydar.xyz/inbox. "
      + "Check the Paraform session (/api/inbox/health), then press Refresh now on the Inbox.",
  ).catch(() => {});
  return true;
}

function longUnverified(meta, nowMs) {
  const verifiedMs = Date.parse(meta?.verified_at || meta?.last_complete_at || "");
  return !Number.isFinite(verifiedMs) || nowMs - verifiedMs >= INBOX_SCHEDULED_ALERT_AFTER_MS;
}

export function createInboxSyncHandler({
  corsHandler = cors,
  authHandler = requireInboxAuth,
  cronCheck = cronAuth,
  acquireLock = acquireInboxSyncLock,
  readState = readInboxSnapshotState,
  buildRefresh = buildInboxRefresh,
  writeState = writeInboxRefreshState,
  releaseLock = releaseInboxSyncLock,
  assembleFeed = assembleInboxSnapshotFeed,
  pauseState = () => paraformBackgroundPauseState("dashboardReaders"),
  ensureSession = resolveInboxParaformSession,
  alert = alertInboxRefreshNeedsAttention,
  sleepImpl = wait,
  now = () => Date.now(),
} = {}) {
  return async function handler(req, res) {
    if (corsHandler(req, res)) return;
    res.setHeader("Cache-Control", "private, no-store, max-age=0");
    const scheduled = req.method === "GET";
    if (scheduled) {
      if (!cronCheck(req).ok) {
        return res.status(401).json({ ok: false, error: "cron_unauthorized" });
      }
    } else {
      if (req.method !== "POST") {
        res.setHeader("Allow", "GET, POST");
        return res.status(405).json({ ok: false, error: "method_not_allowed" });
      }
      const contentType = String(
        req.headers?.["content-type"] || "",
      ).split(";", 1)[0].trim().toLowerCase();
      if (contentType !== "application/json") {
        return res.status(415).json({
          ok: false,
          error: "unsupported_media_type",
        });
      }
      if (!(await authHandler(req, res))) return;
    }

    const backgroundPause = await pauseState()
      .catch(() => ({ paused: true, state: "unreadable" }));
    if (backgroundPause?.paused) {
      res.setHeader("Retry-After", "300");
      return res.status(503).json({
        ok: false,
        paused: true,
        error: "paraform_background_paused",
        control_state: backgroundPause.state || "unreadable",
        retry_after_seconds: 300,
      });
    }

    // Resolve the live n8n-store session before any Paraform read; without
    // this the sweep sends the dead static env seal and every read 401s.
    await ensureSession();

    // A scheduled run waits briefly for a concurrent refresh rather than
    // skipping its slot, since the next slot can be hours away.
    let lock = await acquireLock();
    for (
      let attempt = 1;
      scheduled && lock.status === "busy" && attempt < SCHEDULED_LOCK_ATTEMPTS;
      attempt += 1
    ) {
      await sleepImpl(SCHEDULED_LOCK_WAIT_MS);
      lock = await acquireLock();
    }
    if (lock.status === "busy") {
      res.setHeader("Retry-After", "15");
      return res.status(202).json({
        ok: true,
        status: "in_progress",
        retry_after_seconds: 15,
      });
    }
    if (lock.status !== "acquired") {
      return res.status(503).json({
        ok: false,
        error: "inbox_store_unavailable",
      });
    }

    let previousMeta = null;
    let outcome;
    try {
      const state = await readState();
      if (state.status === "unavailable") {
        outcome = { status: 503, body: { ok: false, error: "inbox_store_not_configured" } };
        return res.status(outcome.status).json(outcome.body);
      }
      if (state.status !== "ready") {
        outcome = { status: 502, body: { ok: false, error: "inbox_snapshot_unavailable" } };
        return res.status(outcome.status).json(outcome.body);
      }
      previousMeta = state.value?.meta || null;
      const refresh = await buildRefresh({
        previousState: state.value,
        mode: "changed",
        batchSize: INBOX_CHANGED_BATCH_SIZE,
      });
      const nextState = await writeState(state.value, refresh);
      const feed = assembleFeed(nextState);
      outcome = { ok: true, stale: Number(feed.freshness?.campaigns_stale) || 0 };
      return res.status(200).json({
        ok: true,
        status: "updated",
        trigger: scheduled ? "schedule" : "manual",
        generated_at: refresh.generated_at,
        freshness: feed.freshness,
        scan: refresh.scan,
      });
    } catch (error) {
      outcome = { error: error?.code || String(error?.message || error).slice(0, 80) };
      return res.status(error?.code === "AUTH_EXPIRED" ? 503 : 502).json({
        ok: false,
        error: error?.code === "AUTH_EXPIRED"
          ? "paraform_auth_expired"
          : "sync_unavailable",
        detail: String(error?.message || error).slice(0, 180),
      });
    } finally {
      await releaseLock(lock.token);
      if (scheduled) {
        try {
          if (outcome?.ok && outcome.stale > 0) {
            await alert(`${outcome.stale} sequence(s) have not been confirmed for over 16 hours.`);
          } else if (!outcome?.ok && longUnverified(previousMeta, now())) {
            await alert(`the scheduled refresh failed (${outcome?.error || outcome?.body?.error || "unknown"}) and the Inbox has not been verified for 20+ hours.`);
          }
        } catch {
          // Alerting must never turn a finished refresh into a failure.
        }
      }
    }
  };
}

export default createInboxSyncHandler();
