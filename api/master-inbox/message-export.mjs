import { requireMasterInboxAuth, privateJson, serviceConfig } from "./_lib/core.mjs";

export default async function handler(req, res) {
  privateJson(res);
  if (req.method !== "GET") return res.status(405).json({ ok: false, error: "method_not_allowed" });
  if (!(await requireMasterInboxAuth(req, res))) return;
  const config = serviceConfig();
  if (!config.base || !config.key) return res.status(503).json({ ok: false, error: "master_inbox_not_configured" });
  const response = await fetch(`${config.base}/api/message-export?id=${encodeURIComponent(String(req.query?.id || ""))}`, { headers: { authorization: `Bearer ${config.key}`, "x-raydar-actor": req.authedEmail }, signal: AbortSignal.timeout(30_000) });
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!response.ok) return res.status(response.status).send(bytes);
  res.setHeader("content-type", response.headers.get("content-type") || "application/json");
  res.setHeader("content-disposition", response.headers.get("content-disposition") || "attachment");
  return res.status(200).send(bytes);
}
