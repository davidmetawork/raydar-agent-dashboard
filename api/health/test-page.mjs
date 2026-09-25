// Manual #notify delivery test for Raydar System Health. POST only, authed
// exactly like api/paraai/background-pause.mjs — the automation runner's
// PARAAI_AUTOMATION_RUNNER_KEY bearer, never CRON_SECRET — via the shared
// helper in api/_lib/runner-key-auth.mjs.
//
// This is an explicit, human-triggered test of the alert pipe itself, so it
// always sends (independent of HEALTH_ALERTS_ENABLED) but reports that flag
// in the response so the caller can tell "alerts are actually armed" from
// "the Slack pipe works." Rate-limited to one send per 10 minutes via KV so a
// retry loop or fat-fingered re-run cannot spam the channel.
import { runnerAuthorized } from "../_lib/runner-key-auth.mjs";
import { hSetNx, K } from "./_lib/kv.mjs";
import { sendSlack } from "./_lib/alert.mjs";

const RATE_LIMIT_SECONDS = 10 * 60;

function resolvedChannel(env = process.env) {
  // Mirrors alert.mjs sendSlack()'s own resolution (no per-call override here).
  return String(env.HEALTH_SLACK_CHANNEL || env.SLACK_CHANNEL_ID_ALERTS || "");
}

function channelIsConfigured(env = process.env) {
  const webhook = String(env.SLACK_WEBHOOK_URL || "");
  const token = String(env.SLACK_BOT_TOKEN || "");
  const channel = resolvedChannel(env);
  return Boolean(webhook || (token && channel));
}

export async function handleTestPage(req, res, {
  env = process.env,
  sendSlackImpl = sendSlack,
  rateLimitImpl = hSetNx,
} = {}) {
  res.setHeader("Cache-Control", "no-store");
  if (!runnerAuthorized(req, env)) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "POST_only" });
  }

  const alertsEnabled = env.HEALTH_ALERTS_ENABLED === "true";
  const channel = resolvedChannel(env);
  const channelConfigured = channelIsConfigured(env);
  const channelSuffix = channel ? channel.slice(-4) : "";

  const won = await rateLimitImpl(K.testPageSent, { at: new Date().toISOString() }, RATE_LIMIT_SECONDS);
  if (!(won === "OK" || won === true)) {
    return res.status(429).json({
      ok: false,
      error: "rate_limited",
      alertsEnabled,
      channelConfigured,
      channelSuffix,
      delivered: false,
    });
  }

  const delivered = await sendSlackImpl(
    ":white_check_mark: #notify test from Raydar System Health (no action needed)",
  );

  return res.status(200).json({
    ok: true,
    alertsEnabled,
    channelConfigured,
    channelSuffix,
    delivered,
  });
}

export default async function handler(req, res) {
  return handleTestPage(req, res);
}
