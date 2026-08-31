import { requireMasterInboxAuth, privateJson, proxy, relay, requestBody } from "./_lib/core.mjs";
export default async function handler(req, res) {
  privateJson(res);
  if (!["GET", "POST"].includes(req.method)) return res.status(405).json({ ok: false, error: "method_not_allowed" });
  if (!(await requireMasterInboxAuth(req, res))) return;
  const path = `/api/drafts${req.query?.id ? `?id=${encodeURIComponent(String(req.query.id))}` : ""}`;
  return relay(res, await proxy(req, path, req.method === "POST" ? { method: "POST", body: requestBody(req) } : {}));
}
