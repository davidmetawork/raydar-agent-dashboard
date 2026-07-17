import {
  acquireInboxBuildLock,
  buildInboxFeed,
  cors,
  readInboxCache,
  releaseInboxBuildLock,
  requireInboxAuth,
  writeInboxCache,
} from "./_lib/core.mjs";

export default async function handler(req, res) {
  if (cors(req, res)) return;
  res.setHeader("Cache-Control", "private, no-store, max-age=0");
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ ok: false, error: "method_not_allowed" });
  }
  if (!(await requireInboxAuth(req, res))) return;

  try {
    const cached = await readInboxCache();
    if (cached.value) {
      return res.status(200).json({
        ok: true,
        ...cached.value,
        cache: { status: "hit" },
      });
    }

    const lock = await acquireInboxBuildLock();
    if (lock.status === "busy") {
      res.setHeader("Retry-After", "3");
      return res.status(503).json({
        ok: false,
        error: "feed_refresh_in_progress",
        retry_after_seconds: 3,
      });
    }

    try {
      const feed = await buildInboxFeed();
      let cacheStatus = cached.status;
      if (feed.cacheable) {
        try {
          cacheStatus = await writeInboxCache(feed) ? "stored" : cached.status;
        } catch {
          cacheStatus = "error";
        }
      } else {
        cacheStatus = "bypassed_partial";
      }
      return res.status(200).json({
        ok: true,
        ...feed,
        cache: {
          status: cacheStatus,
          lock: lock.status,
        },
      });
    } finally {
      await releaseInboxBuildLock(lock.token);
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
}
