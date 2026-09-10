import { serviceConfig } from "./core.mjs";

/* Authorized private bytes for one stored file.

   The DEPLOYED service answers a download with 200 and the bytes
   (master-inbox/api/attachment.mjs sets content-type and
   content-disposition and streams the object), so relaying those bytes is
   the normal path and the only path exercised in production today. The 302
   branch below is forward compatibility for the day the service learns to
   hand out a signed object URL instead; until then it never fires.

   The rule this file exists to keep: a 2xx from the service is never turned
   into a 502. The split this page came from did exactly that — it demanded a
   redirect, and every real download failed. */
export async function attachmentDownload(req, res, path) {
  const config = serviceConfig();
  if (!config.base || !config.key) return res.status(503).json({ ok: false, error: "master_inbox_not_configured" });
  const response = await fetch(`${config.base}${path}?id=${encodeURIComponent(String(req.query?.id || ""))}`, {
    headers: { authorization: `Bearer ${config.key}`, "x-raydar-actor": req.authedEmail },
    redirect: "manual", signal: AbortSignal.timeout(60_000),
  });
  if (response.status === 302 || response.status === 303 || response.status === 307) {
    const location = response.headers.get("location");
    let url; try { url = new URL(location); } catch { /* handled below */ }
    // https only, and no credentials in the URL: the service names the host,
    // so this guard is what stops a compromised or mistaken value redirecting
    // a signed-in employee to a plaintext or credential-bearing endpoint.
    if (!url || url.protocol !== "https:" || url.username || url.password) return res.status(502).json({ ok: false, error: "attachment_download_unavailable" });
    res.setHeader("referrer-policy", "no-referrer");
    res.setHeader("location", location);
    return res.status(302).end();
  }
  if (!response.ok) return res.status(response.status).json(await response.json().catch(() => ({ ok: false, error: "attachment_unavailable" })));
  res.setHeader("content-type", response.headers.get("content-type") || "application/octet-stream");
  res.setHeader("content-disposition", response.headers.get("content-disposition") || "attachment");
  return res.status(200).send(Buffer.from(await response.arrayBuffer()));
}
