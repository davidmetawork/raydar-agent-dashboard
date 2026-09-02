const POST_URL = "https://slack.com/api/chat.postMessage";
const clean = (value, limit = 500) => String(value ?? "")
  .replace(/[\r\n]+/g, " ")
  .replace(/</g, "‹")
  .replace(/>/g, "›")
  .replace(/&/g, "and")
  .trim()
  .slice(0, limit);

export function exactSlackChannel(value) {
  const channel = clean(value, 100);
  if (!/^[CG][A-Z0-9]{2,}$/u.test(channel)) {
    throw Object.assign(new Error("The exact Slack destination channel id is not configured."), { code: "slack_channel_not_configured", status: 503, deliveryOutcome: "not_sent" });
  }
  return channel;
}

export function notificationText(kind, data = {}) {
  const candidate = clean(data.candidate_name || "Candidate", 200);
  const role = clean([data.company, data.role_title].filter(Boolean).join(" · ") || "role unavailable", 300);
  const owner = clean(data.owner_name || "Unassigned", 120);
  const link = /^https:\/\/monitor\.raydar\.xyz\//.test(String(data.monitor_url || "")) ? data.monitor_url : "https://monitor.raydar.xyz/#submissions";
  if (kind === "not_interested") return `Submissions: ${candidate} is not interested in ${role}; owner: ${owner}; review in Monitor: ${link}`;
  if (kind === "classification_failed") return `Submissions needs review: reply classification failed for ${candidate} · ${role}; owner: ${owner}; ${link}`;
  if (kind === "resume_preparation_failed") return `Submissions needs review: resume preparation failed for ${candidate} · ${role}; owner: ${owner}; ${link}`;
  if (kind === "unsupported_source_version") return `Submissions source needs review: unsupported ${clean(data.source_family || "reply", 100)} contract ${clean(data.source_version || "unknown", 100)}; ${link}`;
  if (kind === "source_delayed") return `Submissions source delayed: ${clean(data.source || "unknown source", 100)} has not completed successfully; ${link}`;
  if (kind === "source_recovered") return `Submissions source recovered: ${clean(data.source || "unknown source", 100)} is current again; ${link}`;
  return `Submissions notice: ${clean(kind, 100)}; ${link}`;
}

export async function postSafeNotification(text, { env = process.env, fetchImpl = fetch, destinationId } = {}) {
  const token = String(env.SUBMISSIONS_V2_SLACK_BOT_TOKEN || "").trim();
  const channel = exactSlackChannel(destinationId);
  if (!token) throw Object.assign(new Error("Slack notification is not configured."), { code: "slack_not_configured", status: 503, deliveryOutcome: "not_sent" });
  let response;
  try {
    response = await fetchImpl(POST_URL, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ channel, text: clean(text, 2_000), mrkdwn: false, link_names: false, unfurl_links: false, unfurl_media: false }), signal: AbortSignal.timeout(10_000) });
  } catch (error) {
    throw Object.assign(new Error("Slack delivery outcome is unknown."), { code: clean(error?.code || "slack_transport_unknown", 100), deliveryOutcome: "unknown" });
  }
  const body = await response.json().catch(() => null);
  if (!body) throw Object.assign(new Error("Slack delivery outcome is unknown."), { code: "slack_receipt_unreadable", deliveryOutcome: "unknown" });
  if (!response.ok || !body.ok) throw Object.assign(new Error("Slack did not accept the notification."), { code: clean(body.error || `slack_http_${response.status}`, 100), deliveryOutcome: "not_sent" });
  return { receipt: body.ts || null, channel: body.channel || channel };
}
