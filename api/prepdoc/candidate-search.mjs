import { cors, requirePrepAuth, storeConfigured } from "./_lib/core.mjs";
import { proxyRunnerGet } from "./_lib/runner-proxy.mjs";

// GET ?q=<term>&limit=8 (Google session) -> { ok, query, results:[identity cards] }
// Server-side proxy to the Fly runner's /candidates/search (runner key).
// `runner_unavailable` tells the Prep tab to fall back to free-text entry.
export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (req.method !== "GET") return res.status(405).json({ ok: false, error: "GET only" });
  if (!storeConfigured()) return res.status(503).json({ ok: false, error: "state_store_not_configured" });
  if (!(await requirePrepAuth(req, res))) return;
  await proxyRunnerGet(res, "/candidates/search", {
    q: req.query?.q,
    limit: req.query?.limit,
  });
}
