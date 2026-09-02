import { privateJson, proxy, relay, requestBody, requireMasterInboxAuth } from "./_lib/core.mjs";

const resources = Object.freeze({
  mailbox: { path: "/api/admin/mailbox", methods: new Set(["GET", "POST"]) },
  backfill: { path: "/api/admin/backfill", methods: new Set(["POST"]) },
  operations: { path: "/api/admin/operations", methods: new Set(["GET"]) }
});

export default async function handler(req, res) {
  privateJson(res);
  const resource = resources[String(req.query?.resource || "")];
  if (!resource) return res.status(404).json({ ok: false, error: "admin_resource_not_found" });
  if (!resource.methods.has(req.method)) return res.status(405).json({ ok: false, error: "method_not_allowed" });
  if (!(await requireMasterInboxAuth(req, res))) return;
  return relay(res, await proxy(req, resource.path, req.method === "POST"
    ? { method: "POST", body: requestBody(req), timeout: 300_000 }
    : { timeout: 60_000 }));
}
