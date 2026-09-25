// The #notify switch for the dashboard's critical senders (#notify plan,
// dashboard PR 2, 2026-09-25). David's rule: Raydar posts in one Slack
// channel, #notify, only when a person must act, and each incident posts once.
//
// NOTIFY_SLACK_CHANNEL is the switch:
//  - UNSET: pageNotify(text) calls notifySlack(text) exactly as today (the
//    shared PARAAI_SLACK_CHANNEL, i.e. #paraform-actions). Callers keep their
//    own existing dedupe. Nothing moves.
//  - SET: pageNotify takes a KV NX slot `notify:<key>` for ttlSeconds (default
//    24h) and posts once through the System Health transport to the channel
//    it names. A failed post releases the slot so the next run retries; KV
//    trouble posts anyway (an alert that cannot dedupe is still an alert).
//    systemHealthOwns() is also true: senders whose incident a tier-1 System
//    Health tile already pages (the Paraform session, a locked mailbox, an
//    evicted lane) drop their own copy, so one incident posts once.
//
// Texts passed here carry no candidate names or emails.
import { sendSlack } from "../health/_lib/alert.mjs";
import { notifySlack } from "../paraai/_lib/core.mjs";

export const NOTIFY_TTL_SECONDS = 24 * 60 * 60;

export function notifyChannel(env = process.env) {
  return String(env?.NOTIFY_SLACK_CHANNEL || "").trim();
}

/** True once the switch is on: System Health owns the incidents its tiles page. */
export function systemHealthOwns(env = process.env) {
  return Boolean(notifyChannel(env));
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

const slotKey = (key) => `notify:${String(key).slice(0, 160)}`;

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
 */
export async function pageNotify(text, {
  key,
  ttlSeconds = NOTIFY_TTL_SECONDS,
  env = process.env,
  kv = defaultKv,
  legacySend = notifySlack,
  notifySend = sendSlack,
} = {}) {
  const channel = notifyChannel(env);
  if (!channel) {
    const ok = await legacySend(text).then((value) => value !== false).catch(() => false);
    return { ok, via: "legacy" };
  }
  if (key) {
    const claim = await claimNotifySlot(key, ttlSeconds, { env, kv });
    if (claim === "held") return { ok: true, via: "notify", skipped: "duplicate", key };
  }
  const ok = await notifySend(text, { channel }).catch(() => false);
  if (!ok && key) await clearNotifySlot(key, { env, kv });
  return { ok: Boolean(ok), via: "notify", key };
}
