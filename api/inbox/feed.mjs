import {
  acquireInboxBuildLock,
  applyInboxTriage,
  buildInboxFeed,
  cors,
  readInboxCache,
  readInboxTriage,
  releaseInboxBuildLock,
  requireInboxAuth,
  writeInboxCache,
} from "./_lib/core.mjs";

function rejectTriageRead(res, triage) {
  if (triage.status === "unavailable") {
    res.status(503).json({
      ok: false,
      error: "triage_store_not_configured",
    });
    return true;
  }
  if (triage.status !== "ready") {
    res.status(502).json({
      ok: false,
      error: "triage_unavailable",
    });
    return true;
  }
  return false;
}

export function createInboxFeedHandler({
  corsHandler = cors,
  authHandler = requireInboxAuth,
  readCache = readInboxCache,
  readTriage = readInboxTriage,
  acquireLock = acquireInboxBuildLock,
  buildFeed = buildInboxFeed,
  writeCache = writeInboxCache,
  releaseLock = releaseInboxBuildLock,
  applyTriage = applyInboxTriage,
} = {}) {
  return async function handler(req, res) {
    if (corsHandler(req, res)) return;
    res.setHeader("Cache-Control", "private, no-store, max-age=0");
    if (req.method !== "GET") {
      res.setHeader("Allow", "GET");
      return res.status(405).json({ ok: false, error: "method_not_allowed" });
    }
    if (!(await authHandler(req, res))) return;

    try {
      const [cached, triage] = await Promise.all([
        readCache(),
        readTriage(),
      ]);
      if (rejectTriageRead(res, triage)) return;
      if (cached.value) {
        const feed = applyTriage(cached.value, triage.value);
        return res.status(200).json({
          ok: true,
          ...feed,
          cache: { status: "hit" },
        });
      }

      const lock = await acquireLock();
      if (lock.status === "busy") {
        res.setHeader("Retry-After", "3");
        return res.status(503).json({
          ok: false,
          error: "feed_refresh_in_progress",
          retry_after_seconds: 3,
        });
      }

      try {
        const baseFeed = await buildFeed();
        let cacheStatus = cached.status;
        if (baseFeed.cacheable) {
          try {
            cacheStatus = await writeCache(baseFeed)
              ? "stored"
              : cached.status;
          } catch {
            cacheStatus = "error";
          }
        } else {
          cacheStatus = "bypassed_partial";
        }
        // A cold Paraform fan-out can run for many seconds. Re-read the small
        // triage hash after it finishes so a click made during that window cannot
        // be overwritten by this response in the browser.
        const latestTriage = await readTriage();
        if (rejectTriageRead(res, latestTriage)) return;
        const feed = applyTriage(baseFeed, latestTriage.value);
        return res.status(200).json({
          ok: true,
          ...feed,
          cache: {
            status: cacheStatus,
            lock: lock.status,
          },
        });
      } finally {
        await releaseLock(lock.token);
      }
    } catch (error) {
      return res.status(error?.code === "AUTH_EXPIRED" ? 503 : 502).json({
        ok: false,
        error: error?.code === "AUTH_EXPIRED"
          ? "paraform_auth_expired"
          : "feed_unavailable",
        detail: String(error?.message || error).slice(0, 180),
      });
    }
  };
}

export default createInboxFeedHandler();
