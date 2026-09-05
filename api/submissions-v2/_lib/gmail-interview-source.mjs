import { createHash, createHmac } from "node:crypto";
import { EMAIL_SCHEMA } from "./contracts.mjs";
import { GMAIL_ROLE_INTEREST_SCOPE, outboundEmailFamily, paraformRoleLink, replySubjectFamily } from "./email-source-policy.mjs";

export const GMAIL_MAILBOX = "david@raydar.xyz";
export const GMAIL_MAILBOX_ID = "david-raydar-xyz";
const hash = (value) => createHash("sha256").update(value).digest("hex");
const fail = (code) => Object.assign(new Error(code), { code, retryable: true });
function decodeHeader(value) {
  return String(value || "").replace(/=\?([^?]+)\?([bq])\?([^?]*)\?=/giu, (original, charset, encoding, data) => {
    try {
      const bytes = encoding.toLowerCase() === "b" ? Buffer.from(data, "base64")
        : Buffer.from(data.replace(/_/gu, " ").replace(/=([a-f0-9]{2})/giu, (_, hex) => String.fromCharCode(parseInt(hex, 16))), "latin1");
      return new TextDecoder(charset, { fatal: true }).decode(bytes);
    } catch { return original; }
  });
}
const header = (message, name) => decodeHeader((message?.payload?.headers || [])
  .find((item) => String(item.name).toLowerCase() === name.toLowerCase())?.value);
const timestamp = (message) => Number(message?.internalDate);
const address = (value) => {
  const raw = String(value || "").trim();
  const match = raw.match(/^(?:[^<>]*<)?([^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+)>?$/u);
  return match?.[1]?.toLowerCase() || null;
};
const ids = (value) => String(value || "").match(/<[^<>\s]+>/gu) || [];

function parts(payload, mimeType, depth = 0) {
  if (depth > 20) throw fail("gmail_mime_depth_exceeded");
  if (payload?.filename || String(payload?.mimeType || "").startsWith("message/")) return [];
  if (payload?.mimeType === mimeType && payload.body?.data) {
    if (payload.body.data.length > 400_000) throw fail("gmail_body_too_large");
    return [Buffer.from(payload.body.data, "base64url").toString("utf8")];
  }
  return (payload?.parts || []).flatMap((part) => parts(part, mimeType, depth + 1));
}

function plainHtml(value) {
  return value.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/giu, "")
    .replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/giu, "$2 ($1)")
    .replace(/<(?:br\s*\/?|\/p|\/div|\/li)>/giu, "\n")
    .replace(/<[^>]+>/gu, "").replace(/&nbsp;/giu, " ").replace(/&amp;/giu, "&")
    .replace(/&lt;/giu, "<").replace(/&gt;/giu, ">").replace(/&quot;/giu, '"');
}

export function gmailBody(message) {
  const plain = parts(message?.payload, "text/plain").join("\n");
  const html = parts(message?.payload, "text/html").join("\n");
  return { text: plain || plainHtml(html), html };
}

export function authoredReply(message) {
  const plain = parts(message?.payload, "text/plain").join("\n");
  const html = parts(message?.payload, "text/html").join("\n");
  const text = plain || plainHtml(html.split(/<(?:blockquote\b|div\b[^>]*\bclass=["'][^"']*\b(?:gmail_quote|yahoo_quoted)\b)/iu)[0]);
  // Quoted text is evidence for neither intent nor candidate claims.
  return text.split(/\n\s*(?:On [\s\S]{0,500}?wrote:|[-_]{2,}\s*(?:Original|Forwarded) Message|Begin forwarded message:|From:\s)/iu)[0]
    .split("\n").filter((line) => !/^\s*>/u.test(line)).join("\n").trim();
}

function machineMessage(message) {
  const auto = header(message, "Auto-Submitted").trim().toLowerCase();
  return (auto && auto !== "no") || /^(?:bulk|list|junk)$/iu.test(header(message, "Precedence").trim())
    || Boolean(header(message, "List-Id")) || /^(?:Auto(?:matic)?\s*(?:reply|response)|Out of office|Delivery Status|Undeliverable)/iu.test(header(message, "Subject"))
    // Fyxer scheduling notices omit machine headers and reuse the candidate's
    // thread subject; the observed service sender is never the candidate.
    || address(header(message, "From")) === "drafts@fyxer.com"
    || /(?:mailer-daemon|postmaster|no-?reply)@/iu.test(header(message, "From"));
}

export function offeredRoles(message, { authoredOnly = false } = {}) {
  const { text, html } = authoredOnly ? { text: authoredReply(message), html: "" } : gmailBody(message);
  const found = new Map();
  for (const raw of `${text}\n${html}`.replace(/&amp;/giu, "&").match(/https:\/\/[^\s<>"']+/gu) || []) {
    const role = paraformRoleLink(raw);
    if (role) found.set(role.role_id, role);
  }
  return [...found.values()];
}

function sentToCandidate(message, sender) {
  return message?.labelIds?.includes("SENT") && address(header(message, "From")) === GMAIL_MAILBOX
    && address(header(message, "To")) === sender;
}

/** Bind only the direct RFC parent, or the final References entry when In-Reply-To is absent. */
export function outboundParent(messages, reply, sender) {
  const sent = messages.filter((message) => timestamp(message) < timestamp(reply) && sentToCandidate(message, sender));
  const directIds = ids(header(reply, "In-Reply-To"));
  if (directIds.length) {
    const matches = sent.filter((message) => ids(header(message, "Message-ID")).some((id) => directIds.includes(id)));
    return matches.length === 1 ? matches[0] : null;
  }
  const references = ids(header(reply, "References"));
  const finalReference = references.at(-1);
  if (!finalReference) return null;
  const matches = sent.filter((message) => ids(header(message, "Message-ID")).includes(finalReference));
  return matches.length === 1 ? matches[0] : null;
}

/** Pure adapter: exact Gmail evidence in, provider-neutral V2 events out. */
export function roleInterestReplyEvents(thread, { after, before, env = process.env } = {}) {
  if (!thread?.id || !Array.isArray(thread.messages)) throw fail("gmail_thread_shape_invalid");
  const secret = String(env.SUBMISSIONS_V2_EMAIL_HMAC_KEY || "");
  const version = String(env.SUBMISSIONS_V2_EMAIL_HMAC_VERSION || "");
  if (secret.length < 32 || !version) throw fail("gmail_email_hmac_not_configured");
  const messages = [...thread.messages].sort((a, b) => timestamp(a) - timestamp(b) || String(a.id).localeCompare(String(b.id)));
  const events = [];
  for (const reply of messages) {
    const at = timestamp(reply);
    if (!Number.isFinite(at) || at < after || at >= before || reply.labelIds?.some((label) => ["SENT", "DRAFT", "SPAM", "TRASH"].includes(label))) continue;
    if (machineMessage(reply)) continue;
    const sender = address(header(reply, "From"));
    if (!sender || sender === GMAIL_MAILBOX || sender.endsWith("@raydar.xyz")) continue;
    const referenceIds = [...ids(header(reply, "In-Reply-To")), ...ids(header(reply, "References"))];
    if (!referenceIds.length) continue; // A matching subject by itself is not a candidate reply.
    const sent = outboundParent(messages, reply, sender);
    const candidateText = authoredReply(reply);
    const sentText = sent ? gmailBody(sent).text : "";
    // A link quoted from an older offer does not make an acknowledgement,
    // scheduling update, or recruiter follow-up a new role offer.
    const offered = sent ? offeredRoles(sent, { authoredOnly: true }) : [];
    const family = sent
      ? outboundEmailFamily({ subject: header(sent, "Subject"), text: authoredReply(sent), roleCount: offered.length })
      : replySubjectFamily(header(reply, "Subject"));
    // A known prep/admin parent is not fresh role outreach. When the exact parent is
    // absent, a supported subject may still enter Needs Review with zero offered roles.
    if (!family) continue;
    const key = `gmail:${GMAIL_MAILBOX_ID}:${reply.id}`;
    events.push({
      schema_version: EMAIL_SCHEMA, event_id: `gmail_${hash(key).slice(0, 32)}`,
      source_family: family, source_family_version: "2", adapter_version: "gmail-role-interest-v2",
      mailbox_id: GMAIL_MAILBOX_ID, provider: "gmail", provider_message_id: reply.id,
      provider_thread_id: thread.id, outbound_message_id: sent?.id || null, direction: "inbound",
      sent_at: sent ? new Date(timestamp(sent)).toISOString() : null, received_at: new Date(at).toISOString(),
      sender_match_hmac: { key_version: version, digest: createHmac("sha256", secret).update(sender).digest("base64url") },
      sender_display_name: header(reply, "From").includes("<") ? header(reply, "From").split("<", 1)[0].replace(/^"|"$/gu, "").trim().slice(0, 300) : null,
      candidate_authored_text: candidateText, sent_message_text: sentText, offered_roles: offered,
      machine_message: false, raw_record_ref: `gmail:${GMAIL_MAILBOX_ID}:${reply.id}`,
      content_digest: hash(JSON.stringify({ candidateText, sentText, offered })), idempotency_key: key,
    });
  }
  return events;
}

export const interviewReplyEvents = roleInterestReplyEvents;

export function interviewSearch(after, before) {
  if (!Number.isFinite(after) || !Number.isFinite(before) || after >= before) throw fail("gmail_window_invalid");
  // One-second outward rounding; internalDate enforces the exact half-open window.
  return `subject:"Interview Request" -from:${GMAIL_MAILBOX} -in:sent -in:drafts after:${Math.floor(after / 1000) - 1} before:${Math.ceil(before / 1000)}`;
}

export function roleInterestSearch(after, before) {
  if (!Number.isFinite(after) || !Number.isFinite(before) || after >= before) throw fail("gmail_window_invalid");
  return `{subject:"Interview Request" subject:"New Match" subject:"Raydar - 1st Round Interview" "See matches here"} -from:${GMAIL_MAILBOX} -in:sent -in:drafts after:${Math.floor(after / 1000) - 1} before:${Math.ceil(before / 1000)}`;
}

/** Read all pages before admitting any event, then admit oldest first. */
export async function collectRoleInterestWindow({ after, before, client, env, assertCurrent = async () => {}, maxThreads = 12 }) {
  const query = roleInterestSearch(after, before);
  const threads = new Set();
  const pageTokens = new Set();
  let pageToken;
  for (let page = 0; page < 4; page += 1) {
    await assertCurrent();
    const listed = await client.list({ query, pageToken, maxResults: 100, scope: GMAIL_ROLE_INTEREST_SCOPE });
    if (!listed || (listed.messages !== undefined && !Array.isArray(listed.messages))) throw fail("gmail_list_shape_invalid");
    for (const row of listed.messages || []) {
      if (!/^[a-f0-9]+$/iu.test(row.threadId || "")) throw fail("gmail_thread_identity_invalid");
      threads.add(row.threadId);
    }
    if (threads.size > maxThreads) throw fail("gmail_window_too_large");
    pageToken = listed.nextPageToken;
    if (!pageToken) break;
    if (pageTokens.has(pageToken)) throw fail("gmail_page_token_repeated");
    pageTokens.add(pageToken);
    if (page === 3) throw fail("gmail_window_too_large");
  }
  const events = new Map();
  for (const threadId of threads) {
    await assertCurrent();
    const thread = await client.thread(threadId);
    if (thread?.id !== threadId) throw fail("gmail_thread_identity_mismatch");
    for (const event of roleInterestReplyEvents(thread, { after, before, env })) events.set(event.idempotency_key, event);
  }
  const ordered = [...events.values()].sort((a, b) => a.received_at.localeCompare(b.received_at) || a.provider_message_id.localeCompare(b.provider_message_id));
  Object.defineProperty(ordered, "threads_read", { value: threads.size });
  return ordered;
}

export const collectInterviewWindow = collectRoleInterestWindow;
