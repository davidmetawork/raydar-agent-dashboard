import { syncPathARows } from "./_lib/sync.mjs";
import { requireCron, requireHuman, sendError } from "./_lib/http.mjs";
import { storeConfigured } from "./_lib/store.mjs";
import { paraformBackgroundPauseState } from "../_lib/paraform-background-pause.mjs";

export const config = { maxDuration: 300 };

export async function handleSubmissionsRefresh(req, res, {
  pauseState = () => paraformBackgroundPauseState("dashboardReaders"),
  sync = syncPathARows,
  configured = storeConfigured,
  cronAuthHandler = requireCron,
  humanAuthHandler = requireHuman,
} = {}) {
  if (!["GET", "POST"].includes(req.method)) {
    return res.status(405).json({ ok: false, error: "GET_or_POST_only" });
  }
  const authed = req.method === "GET"
    ? cronAuthHandler(req, res)
    : await humanAuthHandler(req, res);
  if (!authed) return;
  const backgroundPause = await pauseState()
    .catch(() => ({ paused: true, state: "unreadable" }));
  if (backgroundPause?.paused) {
    res.setHeader("Retry-After", "300");
    return res.status(503).json({
      ok: false,
      paused: true,
      error: "paraform_background_paused",
      control_state: backgroundPause.state || "unreadable",
    });
  }
  if (!configured()) return res.status(503).json({ ok: false, error: "state_store_not_configured" });
  try {
    const result = await sync({ force: req.method === "POST" });
    return res.status(result.busy ? 202 : 200).json(result);
  } catch (error) {
    return sendError(res, error);
  }
}

export default async function handler(req, res) {
  return handleSubmissionsRefresh(req, res);
}
