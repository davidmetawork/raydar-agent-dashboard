import {
  authConfig,
  cors,
  hasCookie,
  paraformHealth,
  storeConfigured,
} from "./_lib/core.mjs";

export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ ok: false, error: "method_not_allowed" });
  }
  try {
    const health = await paraformHealth();
    return res.status(200).json({
      ok: health.paraform === "live"
        && storeConfigured()
        && authConfig().authRequired,
      cookieSet: hasCookie(),
      cacheConfigured: storeConfigured(),
      authRequired: authConfig().authRequired,
      ...health,
    });
  } catch (error) {
    return res.status(200).json({
      ok: false,
      cookieSet: hasCookie(),
      cacheConfigured: storeConfigured(),
      authRequired: authConfig().authRequired,
      paraform: "error",
      detail: String(error?.message || error).slice(0, 160),
    });
  }
}
