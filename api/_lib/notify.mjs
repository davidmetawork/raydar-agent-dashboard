// The #notify switch for the dashboard's critical senders (#notify plan,
// dashboard PR 2, 2026-09-25). David's rule: Raydar posts in one Slack
// channel, #notify, only when a person must act, and each incident posts once.
//
// The switch is ON when NOTIFY_SLACK_CHANNEL is set AND HEALTH_ALERTS_ENABLED
// is exactly "true" (notify-switch.mjs says why both):
//  - OFF: pageNotify(text) calls notifySlack(text) as before (the shared
//    PARAAI_SLACK_CHANNEL, i.e. #paraform-actions). Callers keep their own
//    dedupe. Routing does not move, but some senders' dedupe and scope did
//    change in this PR (see the PR body's "live on merge" list).
//  - ON: pageNotify takes a KV NX slot `notify:<key>` for ttlSeconds (default
//    24h) and posts once through the System Health transport, by bot token,
//    to the channel NOTIFY_SLACK_CHANNEL names (never SLACK_WEBHOOK_URL,
//    whose channel is fixed by the webhook). A failed post releases the slot
//    so the next run retries; KV trouble posts anyway (an alert that cannot
//    dedupe is still an alert). systemHealthOwns() is also true: senders whose
//    incident a tier-1 System Health tile already pages (the Paraform session,
//    a locked mailbox, an evicted lane) drop their own copy.
//
// A slot is "once per incident" only where its detector clears it on recovery
// (the stale sweep, n8n workflows, n8n unreadable, sweep pause errors).
// Elsewhere (cron-auth, the guardian's sequence set) it is "at most once per
// 24h".
//
// Texts passed here carry no candidate names or emails.
import { sendSlack } from "../health/_lib/alert.mjs";
import { notifySlack } from "../paraai/_lib/core.mjs";
import { notifyChannel, notifySwitchOn } from "./notify-switch.mjs";

export { notifyChannel, notifySwitchOn };

export const NOTIFY_TTL_SECONDS = 24 * 60 * 60;

/** True once the switch is on: System Health owns the incidents its tiles page. */
export function systemHealthOwns(env = process.env) {
  return notifySwitchOn(env);
}

function kvEndpoint(env) {
  const url = String(env?.KV_REST_API_URL || "").replace(/\/+$/, "");
  const token = String(env?.KV_REST_API_TOKEN || "");
  return url && token ? { url, token } : null;
}

async function defaultKv(command, env = process.env) {
  const endpoint = kvEndpoint(env);
  if (!endpoint) throw new Error("KV_UNCONFIGURED");
  const response = await fetch(endpoint.url, {
    method: "POST",
    headers: { authorization: `Bearer ${endpoint.token}`, "content-type": "application/json" },
    body: JSON.stringify(command),
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) throw new Error(`KV_HTTP_${response.status}`);
  const body = await response.json().catch(() => null);
  return body?.result ?? null;
}

/** The KV key behind a pageNotify slot (for callers that refresh its TTL). */
export const notifySlotKey = (key) => `notify:${String(key).slice(0, 160)}`;
const slotKey = notifySlotKey;

// A slot whose page landed, when the caller asked for it to be marked
// (pageNotify's deliveredTtlSeconds). An in-flight claim holds an ISO stamp.
const DELIVERED_PREFIX = "delivered:";
export const notifySlotDelivered = (value) =>
  typeof value === "string" && value.startsWith(DELIVERED_PREFIX);

/** "won" | "held" | "unavailable" */
export async function claimNotifySlot(key, ttlSeconds = NOTIFY_TTL_SECONDS, {
  env = process.env,
  kv = defaultKv,
} = {}) {
  try {
    const result = await kv(
      ["SET", slotKey(key), new Date().toISOString(), "EX", String(ttlSeconds), "NX"],
      env,
    );
    return result === "OK" || result === true ? "won" : "held";
  } catch {
    return "unavailable";
  }
}

/** Release a slot (a failed post, or a detector that saw the condition clear). */
export async function clearNotifySlot(key, { env = process.env, kv = defaultKv } = {}) {
  if (!key) return false;
  try {
    await kv(["DEL", slotKey(key)], env);
    return true;
  } catch {
    return false;
  }
}

/**
 * One critical page. -> { ok, via, skipped? }
 *   via "legacy": switch off, sent with notifySlack exactly as before
 *   via "notify": switch on, sent to NOTIFY_SLACK_CHANNEL
 *
 * deliveredTtlSeconds (opt-in, PR 230 review 5): the claim then lives only
 * ttlSeconds (keep it short: it covers one in-flight send), and a landed
 * page rewrites the slot to "delivered:<iso>" for deliveredTtlSeconds. A
 * claim orphaned by a killed function, or by a failed send whose release
 * DEL failed too, lapses in minutes and a later run retries, instead of
 * holding the page off for the delivered lifetime.
 */
export async function pageNotify(text, {
  key,
  ttlSeconds = NOTIFY_TTL_SECONDS,
  deliveredTtlSeconds = null,
  env = process.env,
  kv = defaultKv,
  legacySend = notifySlack,
  notifySend = sendSlack,
} = {}) {
  const channel = notifyChannel(env);
  if (!notifySwitchOn(env)) {
    const ok = await legacySend(text).then((value) => value !== false).catch(() => false);
    return { ok, via: "legacy" };
  }
  if (key) {
    const claim = await claimNotifySlot(key, ttlSeconds, { env, kv });
    if (claim === "held") return { ok: true, via: "notify", skipped: "duplicate", key };
  }
  const ok = await notifySend(text, { channel, botTokenFirst: true }).catch(() => false);
  if (!ok && key) await clearNotifySlot(key, { env, kv });
  if (ok && key && deliveredTtlSeconds) {
    await Promise.resolve(kv(
      ["SET", slotKey(key), `${DELIVERED_PREFIX}${new Date().toISOString()}`, "EX", String(deliveredTtlSeconds)],
      env,
    )).catch(() => null);
  }
  return { ok: Boolean(ok), via: "notify", key };
}
