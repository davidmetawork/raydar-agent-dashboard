// Shared operator bearer-auth for the automation runner key. Extracted out of
// api/paraai/background-pause.mjs (2026-09-24) so other operator-only control
// endpoints — e.g. api/health/test-page.mjs — authenticate exactly the same
// way instead of re-implementing timing-safe comparison.
//
// Deliberately only PARAAI_AUTOMATION_RUNNER_KEY: CRON_SECRET is a different
// principal (the Vercel cron scheduler) and must never satisfy this check.
import { timingSafeEqual } from "node:crypto";

export function equalSecret(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  return a.length > 0 && a.length === b.length && timingSafeEqual(a, b);
}

export function runnerAuthorized(req, env = process.env) {
  const token = String(req.headers?.authorization || "").replace(/^Bearer\s+/i, "");
  return equalSecret(token, env.PARAAI_AUTOMATION_RUNNER_KEY);
}
