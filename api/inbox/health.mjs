import {
  authConfig,
  cors,
  ensureParaformSession,
  hasCookie,
  paraformHealth,
  readInboxSnapshotState,
  storeConfigured,
} from "./_lib/core.mjs";
import { PARAFORM_SESSION_HEALTH_TIMEOUT_MS } from "../_lib/paraform-session-store.mjs";

export function createInboxHealthHandler({
  corsHandler = cors,
  // Budgeted like /api/seq/health: a store read that hangs falls back to the
  // env seal for this response only, and still warms the cache for the next.
  ensureSession = () => ensureParaformSession({
    timeoutMs: PARAFORM_SESSION_HEALTH_TIMEOUT_MS,
  }),
  healthReader = paraformHealth,
  snapshotReader = readInboxSnapshotState,
  configured = storeConfigured,
  auth = authConfig,
  cookieSet = hasCookie,
} = {}) {
  return async function handler(req, res) {
    if (corsHandler(req, res)) return;
    if (req.method !== "GET") {
      res.setHeader("Allow", "GET");
      return res.status(405).json({ ok: false, error: "method_not_allowed" });
    }
    try {
      await ensureSession();
      const [health, snapshot] = await Promise.all([
        healthReader(),
        snapshotReader(),
      ]);
      return res.status(200).json({
        ok: health.paraform === "live"
          && configured()
          && auth().authRequired
          && snapshot.status === "ready",
        cookieSet: cookieSet(),
        cacheConfigured: configured(),
        stateStoreConfigured: configured(),
        authRequired: auth().authRequired,
        snapshotState: snapshot.status,
        snapshotCause: snapshot.cause || null,
        ...health,
      });
    } catch (error) {
      return res.status(200).json({
        ok: false,
        cookieSet: cookieSet(),
        cacheConfigured: configured(),
        stateStoreConfigured: configured(),
        authRequired: auth().authRequired,
        paraform: "error",
        detail: String(error?.message || error).slice(0, 160),
      });
    }
  };
}

export default createInboxHealthHandler();
