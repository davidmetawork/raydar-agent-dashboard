import { timingSafeEqual } from "node:crypto";

import { evaluatePagedRulePage } from "./_lib/rules-paged.mjs";
import { loadFundedEmployerSnapshots } from "./_lib/funded-employers.mjs";

export const config = { maxDuration: 60 };

function machineAuthed(req) {
  const secret = process.env.APPHUB_SYNC_KEY || "";
  if (!secret) return false;
  const supplied = Buffer.from(String(req.headers?.authorization || ""));
  const expected = Buffer.from(`Bearer ${secret}`);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

export function createPagedRuleEvaluatorHandler({
  authenticate = machineAuthed,
  evaluate = evaluatePagedRulePage,
  loadSnapshots = loadFundedEmployerSnapshots,
} = {}) {
  return async function handler(req, res) {
    res.setHeader("Cache-Control", "no-store");
    if (req.method !== "POST") return res.status(405).json({ ok: false, error: "POST only" });
    if (!authenticate(req)) return res.status(401).json({ ok: false, error: "unauthorized" });
    let request;
    try {
      request = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body;
    } catch {
      return res.status(400).json({ ok: false, error: "invalid_json" });
    }
    try {
      const fundedEmployerSnapshots = await loadSnapshots(request?.rules || []);
      return res.status(200).json({ ok: true,
        response: evaluate(request, { fundedEmployerSnapshots }) });
    } catch (error) {
      const code = String(error?.code || error?.message || "paged_rule_evaluation_failed").slice(0, 160);
      return res.status(400).json({ ok: false, error: code });
    }
  };
}

export default createPagedRuleEvaluatorHandler();
