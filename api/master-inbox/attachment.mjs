import { requireMasterInboxAuth, privateJson } from "./_lib/core.mjs";
import { attachmentDownload } from "./_lib/download.mjs";
export default async function handler(req, res) {
  privateJson(res);
  if (req.method !== "GET") return res.status(405).json({ ok: false, error: "method_not_allowed" });
  if (!(await requireMasterInboxAuth(req, res))) return;
  return attachmentDownload(req, res, "/api/attachment");
}
