import { privateJson, proxy, relay, requestBody, requireMasterInboxAuth } from "./_lib/core.mjs";

export default async function handler(req, res) {
  privateJson(res);
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "method_not_allowed" });
  if (!(await requireMasterInboxAuth(req, res))) return;
  return relay(res, await proxy(req, "/api/report", { method: "POST", body: requestBody(req) }));
}
