import { createHash, createSign } from "node:crypto";
import fs from "node:fs";

const GMAIL_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPES = Object.freeze([
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.compose",
]);
const tokenCache = new Map();
let serviceAccountCache = null;

const clean = (value) => String(value || "").trim();
const b64wrap = (value) => value.replace(/(.{76})/g, "$1\r\n");
const encodeHeader = (value) => (
  /^[\x20-\x7e]*$/.test(clean(value))
    ? clean(value)
    : `=?UTF-8?B?${Buffer.from(clean(value), "utf8").toString("base64")}?=`
);

function serviceAccount() {
  if (serviceAccountCache) return serviceAccountCache;
  if (process.env.GOOGLE_SA_KEY_JSON) {
    serviceAccountCache = JSON.parse(process.env.GOOGLE_SA_KEY_JSON);
  } else if (process.env.GOOGLE_SA_KEY_FILE) {
    serviceAccountCache = JSON.parse(fs.readFileSync(process.env.GOOGLE_SA_KEY_FILE, "utf8"));
  } else {
    const error = new Error("GOOGLE_SA_KEY_JSON or GOOGLE_SA_KEY_FILE required");
    error.code = "GMAIL_NOT_CONFIGURED";
    throw error;
  }
  if (!serviceAccountCache?.client_email || !serviceAccountCache?.private_key) {
    const error = new Error("Google service-account key is incomplete");
    error.code = "GMAIL_NOT_CONFIGURED";
    throw error;
  }
  return serviceAccountCache;
}
const base64urlJson = (value) => Buffer.from(JSON.stringify(value), "utf8").toString("base64url");

async function accessToken(mailbox, { fetchImpl = fetch, now = Date.now } = {}) {
  const subject = clean(mailbox).toLowerCase();
  const cached = tokenCache.get(subject);
  if (cached && cached.expiresAt - now() > 5 * 60_000) return cached.token;
  const key = serviceAccount();
  const issuedAt = Math.floor(now() / 1000);
  const header = base64urlJson({ alg: "RS256", typ: "JWT" });
  const payload = base64urlJson({
    iss: key.client_email,
    scope: SCOPES.join(" "),
    aud: TOKEN_URL,
    iat: issuedAt,
    exp: issuedAt + 3600,
    sub: subject,
  });
  const unsigned = `${header}.${payload}`;
  const signer = createSign("RSA-SHA256");
  signer.update(unsigned);
  signer.end();
  const assertion = `${unsigned}.${signer.sign(key.private_key).toString("base64url")}`;
  const response = await fetchImpl(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
    signal: AbortSignal.timeout(20_000),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || !body?.access_token) {
    const error = new Error(body?.error_description || body?.error || `Google OAuth HTTP ${response.status}`);
    error.code = "GMAIL_AUTH_FAILED";
    throw error;
  }
  const expiresAt = now() + Math.max(300, Number(body.expires_in) || 3600) * 1000;
  tokenCache.set(subject, { token: body.access_token, expiresAt });
  return body.access_token;
}

async function gmailCall(
  mailbox,
  path,
  { method = "GET", data, fetchImpl = fetch, timeoutMs = 30_000 } = {},
) {
  const response = await fetchImpl(`${GMAIL_BASE}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${await accessToken(mailbox, { fetchImpl })}`,
      ...(data == null ? {} : { "content-type": "application/json" }),
    },
    ...(data == null ? {} : { body: JSON.stringify(data) }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (response.status === 204) return null;
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(body?.error?.message || `Gmail HTTP ${response.status}`);
    error.code = response.status === 404 ? "GMAIL_NOT_FOUND" : "GMAIL_REQUEST_FAILED";
    error.status = response.status;
    throw error;
  }
  return body;
}

export function gmailConfigured(env = process.env) {
  return Boolean(
    clean(env.PARAAI_OUTREACH_MAILBOX || "david@raydar.xyz") &&
    (clean(env.GOOGLE_SA_KEY_JSON) || clean(env.GOOGLE_SA_KEY_FILE)),
  );
}

export function outreachMailbox(env = process.env) {
  return clean(env.PARAAI_OUTREACH_MAILBOX || "david@raydar.xyz").toLowerCase();
}

export function deterministicMessageId(actionKey) {
  const hash = createHash("sha256").update(clean(actionKey)).digest("hex").slice(0, 40);
  return `<raydar-paraai-${hash}@raydar.xyz>`;
}

export function headerValue(message, name) {
  return (message?.payload?.headers || []).find(
    (header) => String(header?.name || "").toLowerCase() === String(name || "").toLowerCase(),
  )?.value || null;
}

export function threadReplyContext(thread) {
  const messages = (thread?.messages || []).filter(
    (message) => !(message?.labelIds || []).includes("DRAFT"),
  );
  if (!messages.length) return null;
  const first = messages[0];
  const last = messages[messages.length - 1];
  const originalSubject = headerValue(first, "Subject") || "";
  const lastMessageId = headerValue(last, "Message-ID") || headerValue(last, "Message-Id");
  const priorReferences = headerValue(last, "References") || "";
  return {
    threadId: thread.id,
    originalSubject,
    replySubject: /^re:/i.test(originalSubject) ? originalSubject : `Re: ${originalSubject}`,
    inReplyTo: lastMessageId,
    references: [priorReferences, lastMessageId].filter(Boolean).join(" ").trim() || null,
    firstInternalDate: Number(first.internalDate || 0),
    lastInternalDate: Number(last.internalDate || 0),
  };
}

export function candidateRepliedAfter(thread, candidateEmail, afterMs) {
  const email = clean(candidateEmail).toLowerCase();
  const cutoff = Number(afterMs) || 0;
  return (thread?.messages || []).some((message) => {
    const from = String(headerValue(message, "From") || "").toLowerCase();
    return Number(message?.internalDate || 0) > cutoff && from.includes(email);
  });
}

export function buildMime({
  from,
  to,
  subject,
  messageId,
  inReplyTo,
  references,
  bodyText,
  bodyHtml,
}) {
  const boundary = `alt_${createHash("sha256")
    .update(`${messageId}:${to}`)
    .digest("hex")
    .slice(0, 24)}`;
  const lines = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${encodeHeader(subject)}`,
    `Message-ID: ${messageId}`,
  ];
  if (inReplyTo) lines.push(`In-Reply-To: ${inReplyTo}`);
  if (references) lines.push(`References: ${references}`);
  lines.push(
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    b64wrap(Buffer.from(String(bodyText || ""), "utf8").toString("base64")),
    `--${boundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    b64wrap(Buffer.from(String(bodyHtml || ""), "utf8").toString("base64")),
    `--${boundary}--`,
    "",
  );
  const raw = lines.join("\r\n");
  return { raw, base64url: Buffer.from(raw, "utf8").toString("base64url") };
}

export async function probeGmail(mailbox = outreachMailbox()) {
  const profile = await gmailCall(mailbox, "/profile");
  return {
    ok: String(profile?.emailAddress || "").toLowerCase() === String(mailbox).toLowerCase(),
    emailAddress: profile?.emailAddress || null,
  };
}

export async function searchThreads(mailbox, query, maxResults = 20) {
  const params = new URLSearchParams({
    q: clean(query),
    maxResults: String(Math.max(1, Math.min(100, Number(maxResults) || 20))),
  });
  return (await gmailCall(mailbox, `/threads?${params}`))?.threads || [];
}

export async function getThread(mailbox, threadId) {
  return gmailCall(mailbox, `/threads/${encodeURIComponent(threadId)}?format=full`);
}

export async function findInterviewThread(mailbox, candidateEmail) {
  const refs = await searchThreads(
    mailbox,
    `from:${candidateEmail} OR to:${candidateEmail}`,
    30,
  );
  const candidates = [];
  for (const ref of refs) {
    try {
      const thread = await getThread(mailbox, ref.id);
      const context = threadReplyContext(thread);
      if (context && /1st round(?: - interview request)? @/i.test(context.originalSubject)) {
        candidates.push({ id: ref.id, context, thread });
      }
    } catch {
      // One inaccessible Gmail thread must not hide a usable sibling thread.
    }
  }
  candidates.sort((left, right) => left.context.firstInternalDate - right.context.firstInternalDate);
  return candidates[0] || null;
}

export async function getSignatureHtml(mailbox) {
  const data = await gmailCall(mailbox, "/settings/sendAs");
  const rows = data?.sendAs || [];
  const primary = rows.find((row) => row?.isDefault)
    || rows.find((row) => String(row?.sendAsEmail || "").toLowerCase() === String(mailbox).toLowerCase())
    || rows[0];
  return primary?.signature || "";
}

export async function findMessageByRfc822Id(mailbox, messageId, { sentOnly = true } = {}) {
  const params = new URLSearchParams({
    q: `${sentOnly ? "in:sent " : ""}rfc822msgid:${messageId}`,
    maxResults: "10",
  });
  const rows = (await gmailCall(mailbox, `/messages?${params}`))?.messages || [];
  return rows[0] || null;
}

export async function upsertDraft(mailbox, existingDraftId, message) {
  const mime = buildMime(message);
  const body = { message: { raw: mime.base64url } };
  if (message.threadId) body.message.threadId = message.threadId;
  if (existingDraftId) {
    try {
      const updated = await gmailCall(mailbox, `/drafts/${encodeURIComponent(existingDraftId)}`, {
        method: "PUT",
        data: body,
      });
      return { ...updated, draftAction: "updated" };
    } catch (error) {
      if (error?.code !== "GMAIL_NOT_FOUND") throw error;
    }
  }
  const created = await gmailCall(mailbox, "/drafts", { method: "POST", data: body });
  return { ...created, draftAction: "created" };
}

export async function sendDraft(mailbox, draftId) {
  return gmailCall(mailbox, "/drafts/send", {
    method: "POST",
    data: { id: draftId },
  });
}

export async function sendMessage(mailbox, message) {
  const mime = buildMime(message);
  const body = { raw: mime.base64url };
  if (message.threadId) body.threadId = message.threadId;
  return gmailCall(mailbox, "/messages/send", { method: "POST", data: body });
}

export async function createReviewDraft(
  {
    mailbox = outreachMailbox(),
    existingDraftId = null,
    message,
  } = {},
) {
  const draft = await upsertDraft(mailbox, existingDraftId, message);
  const fetched = await gmailCall(mailbox, `/drafts/${encodeURIComponent(draft.id)}?format=metadata`);
  const headers = fetched?.message?.payload?.headers || [];
  const readHeader = (name) => headers.find(
    (header) => String(header?.name || "").toLowerCase() === name.toLowerCase(),
  )?.value || "";
  if (!String(readHeader("To")).toLowerCase().includes(String(message.to).toLowerCase())) {
    const error = new Error("Gmail draft recipient did not read back");
    error.code = "GMAIL_DRAFT_NOT_VISIBLE";
    throw error;
  }
  return {
    id: draft.id,
    messageId: draft?.message?.id || fetched?.message?.id || null,
    threadId: draft?.message?.threadId || fetched?.message?.threadId || null,
    rfc822MessageId: readHeader("Message-ID") || null,
    draftAction: draft.draftAction,
  };
}

export async function deliverMessage(
  {
    mailbox = outreachMailbox(),
    draftId = null,
    draftRfc822MessageId = null,
    message,
  } = {},
) {
  const reconciliationIds = [...new Set([
    draftRfc822MessageId,
    message.messageId,
  ].filter(Boolean))];
  const findDelivered = async () => {
    for (const messageId of reconciliationIds) {
      const found = await findMessageByRfc822Id(mailbox, messageId);
      if (found) return found;
    }
    return null;
  };
  const existing = await findDelivered();
  if (existing) return { ...existing, delivery: "reconciled" };
  try {
    const sent = draftId
      ? await sendDraft(mailbox, draftId)
      : await sendMessage(mailbox, message);
    return { ...sent, delivery: draftId ? "draft_sent" : "sent" };
  } catch (error) {
    const recovered = await findDelivered().catch(() => null);
    if (recovered) return { ...recovered, delivery: "reconciled_after_error" };
    const unknown = new Error("Gmail delivery could not be reconciled; no automatic retry is allowed");
    unknown.code = "GMAIL_SEND_UNKNOWN";
    unknown.cause = error;
    throw unknown;
  }
}
