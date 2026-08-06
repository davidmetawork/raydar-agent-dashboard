import {
  applyInboxTriage,
  assembleInboxSnapshotFeed,
  cors,
  readInboxSnapshotState,
  readInboxTriage,
  requireInboxAuth,
} from "./_lib/core.mjs";

function rejectStateRead(res, state) {
  if (state.status === "unavailable") {
    res.status(503).json({
      ok: false,
      error: "inbox_store_not_configured",
    });
    return true;
  }
  if (state.status !== "ready") {
    res.status(502).json({
      ok: false,
      error: "inbox_snapshot_unavailable",
    });
    return true;
  }
  return false;
}

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
  readState = readInboxSnapshotState,
  readTriage = readInboxTriage,
  assembleFeed = assembleInboxSnapshotFeed,
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
      const [state, triage] = await Promise.all([
        readState(),
        readTriage(),
      ]);
      if (rejectStateRead(res, state) || rejectTriageRead(res, triage)) return;
      const feed = applyTriage(assembleFeed(state.value), triage.value);
      return res.status(200).json({
        ok: true,
        ...feed,
        cache: { status: "materialized", version: 3 },
      });
    } catch (error) {
      return res.status(502).json({
        ok: false,
        error: "feed_unavailable",
        detail: String(error?.message || error).slice(0, 180),
      });
    }
  };
}

export default createInboxFeedHandler();
