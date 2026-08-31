import { requireMasterInboxAuth, privateJson, proxy, relay } from "./_lib/core.mjs";

export default async function handler(req, res) {
  privateJson(res);
  if (req.method !== "GET") return res.status(405).json({ ok: false, error: "method_not_allowed" });
  if (!(await requireMasterInboxAuth(req, res))) return;
  const params = new URLSearchParams();
  for (const key of ["q", "mailbox", "folder", "cursor", "limit"]) if (req.query?.[key]) params.set(key, String(req.query[key]));
  const [feed, mailboxes] = await Promise.all([proxy(req, `/api/conversations?${params}`), proxy(req, "/api/mailboxes")]);
  if (!feed.ok) return relay(res, feed);
  return res.status(200).json({ ...feed.body, configured: true, mailboxes: mailboxes.ok ? mailboxes.body.rows : [], mailboxStatus: mailboxes.ok ? "ready" : "unavailable" });
}
