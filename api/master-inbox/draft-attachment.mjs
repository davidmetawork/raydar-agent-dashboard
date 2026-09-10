import { requireMasterInboxAuth, privateJson, proxy, relay, requestBody } from "./_lib/core.mjs";

// POST only, deliberately. The service's api/draft-attachment.mjs is
// requireMethod(req, res, ["POST"]) and supports the actions "prepare" and
// "commit" — nothing else. A GET download branch here would 405 on every
// call, so the page must not offer an Open link for a draft attachment until
// the service grows a read route.
export default async function handler(req, res) {
  privateJson(res);
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "method_not_allowed" });
  if (!(await requireMasterInboxAuth(req, res))) return;
  return relay(res, await proxy(req, "/api/draft-attachment", { method: "POST", body: requestBody(req), timeout: 58_000 }));
}
