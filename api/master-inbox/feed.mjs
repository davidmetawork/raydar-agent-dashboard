import { requireMasterInboxAuth, privateJson, proxy, relay } from "./_lib/core.mjs";

// Explicit allowlist: nothing the page invents reaches the service, and a
// parameter the service does not accept can never be silently discarded on the
// way through. `strict` is separate because it is a mode, not a filter — it
// asks the service to refuse rather than answer out of partial coverage. This
// page does not set it yet; slice 3 turns it on.
const FEED_PARAMS = ["q", "mailbox", "folder", "cursor", "limit"];
const STRICT_VALUES = new Set(["1", "true"]);

export default async function handler(req, res) {
  privateJson(res);
  if (req.method !== "GET") return res.status(405).json({ ok: false, error: "method_not_allowed" });
  if (!(await requireMasterInboxAuth(req, res))) return;
  const params = new URLSearchParams();
  for (const key of FEED_PARAMS) if (req.query?.[key]) params.set(key, String(req.query[key]));
  if (STRICT_VALUES.has(String(req.query?.strict ?? "").toLowerCase())) params.set("strict", "1");
  const [feed, mailboxes] = await Promise.all([proxy(req, `/api/conversations?${params}`), proxy(req, "/api/mailboxes")]);
  if (!feed.ok) return relay(res, feed);
  // feed.body is spread untouched, so `coverage`, `query` and `freshness` reach
  // the page exactly as the store computed them. The proxy must never summarise
  // or fill in coverage — a dashboard-invented "current" is the bug this whole
  // slice exists to remove.
  return res.status(200).json({ ...feed.body, configured: true, mailboxes: mailboxes.ok ? mailboxes.body.rows : [], mailboxStatus: mailboxes.ok ? "ready" : "unavailable" });
}
