import { cors, requireSourcingAuth } from "./_lib/core.mjs";
import { getRun, storeConfigured } from "./_lib/store.mjs";

const RUN_ID = /^[a-zA-Z0-9_-]{6,100}$/;
const queryOf = (req) => req.query || (typeof req.url === "string" ? Object.fromEntries(new URL(req.url, "http://local").searchParams) : {});

export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (req.method !== "GET") return res.status(405).json({ ok: false, error: "GET only" });
  if (!storeConfigured()) return res.status(503).json({ ok: false, error: "state_store_not_configured" });
  if (!(await requireSourcingAuth(req, res))) return;
  const runId = String(queryOf(req).runId || "").trim();
  if (!RUN_ID.test(runId)) return res.status(400).json({ ok: false, error: "valid runId required" });
  const run = await getRun(runId);
  return run ? res.status(200).json({ ok: true, run }) : res.status(404).json({ ok: false, error: "run_not_found" });
}
