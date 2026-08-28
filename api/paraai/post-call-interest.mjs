import { timingSafeEqual } from "node:crypto";

import { runPostCallInterestProjectionTick } from "./_lib/interest.mjs";

// This is the independent owner for the post-call engagement projection. It is
// deliberately separate from the legacy curated-interest worker, so closing or
// misconfiguring that older lane cannot strand an already-durable stop event.
export const config = { maxDuration: 120 };

function equalSecret(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  return a.length > 0 && a.length === b.length && timingSafeEqual(a, b);
}

export function postCallInterestWorkerAuthorized(req, env = process.env) {
  const bearer = String(req?.headers?.authorization || "").replace(/^Bearer\s+/iu, "");
  return [env.CRON_SECRET, env.PARAAI_AUTOMATION_RUNNER_KEY]
    .filter(Boolean)
    .some((secret) => equalSecret(bearer, secret));
}

export default async function handler(req, res) {
  if (!["GET", "POST"].includes(String(req.method || "GET").toUpperCase())) {
    return res.status(405).json({ ok: false, error: "method_not_allowed" });
  }
  if (!postCallInterestWorkerAuthorized(req)) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }
  try {
    const result = await runPostCallInterestProjectionTick();
    return res.status(result.ran && result.ok !== true ? 503 : 200).json(result);
  } catch (error) {
    return res.status(503).json({
      ok: false,
      error: String(error?.code || "POST_CALL_INTEREST_WORKER_FAILED"),
    });
  }
}
