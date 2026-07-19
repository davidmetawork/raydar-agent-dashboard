import { cors, requirePrepAuth, storeConfigured } from "./_lib/core.mjs";
import { proxyRunnerGet } from "./_lib/runner-proxy.mjs";

// GET ?candidate_user_id=&role_id=&round= (Google session) ->
//   { ok, sources:{...}, doNotMention:[], prompts:[] }
// Server-side proxy to the Fly runner's /precheck: the Prep tab's
// pre-generation "what the system knows" panel.
export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (req.method !== "GET") return res.status(405).json({ ok: false, error: "GET only" });
  if (!storeConfigured()) return res.status(503).json({ ok: false, error: "state_store_not_configured" });
  if (!(await requirePrepAuth(req, res))) return;
  await proxyRunnerGet(res, "/precheck", {
    candidate_user_id: req.query?.candidate_user_id,
    role_id: req.query?.role_id,
    round: req.query?.round,
  });
}
