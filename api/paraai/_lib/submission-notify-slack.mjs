/**
 * Paraform submission notifications — Slack delivery.
 *
 * A dedicated sender rather than a change to core.mjs's `notifySlack`, which is
 * shared with health alerting: this stream needs its own channel, and widening
 * a shared alerting helper to take a channel is how the wrong thing ends up in
 * the wrong channel later.
 *
 * ── Fails closed, and says so ─────────────────────────────────────────────
 * If the token or channel is missing this returns false and never throws. The
 * dispatcher treats a false return as "not sent" and leaves the event UNMARKED,
 * so nothing is lost while David is still setting the channel up — the backlog
 * simply delivers once the channel id lands. That is the whole reason the
 * dispatcher marks after posting rather than before.
 */

const SLACK_POST_URL = "https://slack.com/api/chat.postMessage";

export function submissionChannelId(env = process.env) {
  return String(env.PARAFORM_SUBMISSION_SLACK_CHANNEL || "").trim();
}

export function submissionNotifyConfigured(env = process.env) {
  return Boolean(String(env.SLACK_BOT_TOKEN || "").trim() && submissionChannelId(env));
}

/**
 * @returns {Promise<boolean>} true only when Slack confirmed the post.
 *
 * `onError` receives Slack's own reason (`not_in_channel`, `channel_not_found`,
 * `invalid_auth`, …). A bare false is uninformative and cost hours once: a
 * refused post and a missing channel look identical from the outside, so the
 * reason must reach the caller even though the boolean is what gates retry.
 */
export async function postSubmissionNotification(
  text,
  { env = process.env, fetchImpl = fetch, onError = null } = {},
) {
  const token = String(env.SLACK_BOT_TOKEN || "").trim();
  const channel = submissionChannelId(env);
  const body = String(text || "").trim();
  if (!token || !channel || !body) {
    if (onError) onError(!token ? "missing_token" : !channel ? "missing_channel" : "empty_text");
    return false;
  }

  let response;
  try {
    response = await fetchImpl(SLACK_POST_URL, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      // unfurl off: these messages carry a Paraform link, and unfurling it would
      // paste candidate-identifying preview cards into the channel.
      body: JSON.stringify({ channel, text: body, unfurl_links: false, unfurl_media: false }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    if (onError) onError(`transport: ${error?.message || error}`);
    return false; // transport failure: unmarked, retried next run
  }

  const payload = await response.json().catch(() => null);
  if (!payload?.ok && onError) {
    onError(String(payload?.error || `http_${response.status}`));
  }
  return Boolean(payload?.ok);
}
