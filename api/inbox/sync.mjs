import {
  acquireInboxSyncLock,
  assembleInboxSnapshotFeed,
  buildInboxRefresh,
  cors,
  readInboxSnapshotState,
  releaseInboxSyncLock,
  requireInboxAuth,
  writeInboxRefreshState,
} from "./_lib/core.mjs";

export function createInboxSyncHandler({
  corsHandler = cors,
  authHandler = requireInboxAuth,
  acquireLock = acquireInboxSyncLock,
  readState = readInboxSnapshotState,
  buildRefresh = buildInboxRefresh,
  writeState = writeInboxRefreshState,
  releaseLock = releaseInboxSyncLock,
  assembleFeed = assembleInboxSnapshotFeed,
} = {}) {
  return async function handler(req, res) {
    if (corsHandler(req, res)) return;
    res.setHeader("Cache-Control", "private, no-store, max-age=0");
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
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

    const lock = await acquireLock();
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

    try {
      const state = await readState();
      if (state.status === "unavailable") {
        return res.status(503).json({
          ok: false,
          error: "inbox_store_not_configured",
        });
      }
      if (state.status !== "ready") {
        return res.status(502).json({
          ok: false,
          error: "inbox_snapshot_unavailable",
        });
      }
      const refresh = await buildRefresh({ previousState: state.value });
      const nextState = await writeState(state.value, refresh);
      const feed = assembleFeed(nextState);
      return res.status(200).json({
        ok: true,
        status: "updated",
        generated_at: refresh.generated_at,
        freshness: feed.freshness,
        scan: refresh.scan,
      });
    } catch (error) {
      return res.status(error?.code === "AUTH_EXPIRED" ? 503 : 502).json({
        ok: false,
        error: error?.code === "AUTH_EXPIRED"
          ? "paraform_auth_expired"
          : "sync_unavailable",
        detail: String(error?.message || error).slice(0, 180),
      });
    } finally {
      await releaseLock(lock.token);
    }
  };
}

export default createInboxSyncHandler();
