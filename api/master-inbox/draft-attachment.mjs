import { requireMasterInboxAuth, privateJson, proxy, relay, requestBody } from "./_lib/core.mjs";
import { attachmentDownload } from "./_lib/download.mjs";
export default async function handler(req, res) {
  privateJson(res);
  if (!["GET", "POST"].includes(req.method)) return res.status(405).json({ ok: false, error: "method_not_allowed" });
  if (!(await requireMasterInboxAuth(req, res))) return;
  if (req.method === "GET") return attachmentDownload(req, res, "/api/draft-attachment");
  return relay(res, await proxy(req, "/api/draft-attachment", { method: "POST", body: requestBody(req), timeout: 58_000 }));
}
