import { serviceConfig } from "./core.mjs";

// Transfer authorized private bytes directly from object storage so large
// resumes never pass through a buffered function body.
export async function attachmentDownload(req, res, path) {
  const config = serviceConfig();
  if (!config.base || !config.key) return res.status(503).json({ ok: false, error: "master_inbox_not_configured" });
  const response = await fetch(`${config.base}${path}?id=${encodeURIComponent(String(req.query?.id || ""))}&redirect=1`, {
    headers: { authorization: `Bearer ${config.key}`, "x-raydar-actor": req.authedEmail },
    redirect: "manual", signal: AbortSignal.timeout(25_000),
  });
  if (response.status === 302) {
    const location = response.headers.get("location");
    let url; try { url = new URL(location); } catch { /* handled below */ }
    if (!url || url.protocol !== "https:" || url.username || url.password) return res.status(502).json({ ok: false, error: "attachment_download_unavailable" });
    res.setHeader("referrer-policy", "no-referrer");
    res.setHeader("location", location);
    return res.status(302).end();
  }
  return res.status(response.ok ? 502 : response.status).json(await response.json().catch(() => ({ ok: false, error: "attachment_unavailable" })));
}
