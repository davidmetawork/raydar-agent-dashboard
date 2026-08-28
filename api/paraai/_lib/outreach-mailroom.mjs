// Confirmation-gated Para AI incident relief through the Mailroom's SendGrid
// sender. This opens a fresh conversation on purpose: the Mailroom refuses
// threaded rows on non-Gmail transports, and pretending a SendGrid message is
// inside Gmail would make reply/follow-up state unsafe.

const DEFAULT_BASE = "https://raydar-mailroom.vercel.app";
export const PARAAI_OUTREACH_RELIEF_LANE = "paraai-outreach-relief";
const DEFAULT_TIMEOUT_MS = 15_000;
const POLL_ATTEMPTS = 8;
const POLL_DELAY_MS = 1_000;

const clean = (value) => String(value || "").trim();

export function mailroomReliefConfig(env = process.env) {
  const base = clean(env.MAILROOM_BASE || DEFAULT_BASE).replace(/\/+$/, "");
  const key = clean(env.MAILROOM_API_KEY);
  const lane = clean(env.PARAAI_OUTREACH_MAILROOM_LANE || PARAAI_OUTREACH_RELIEF_LANE);
  return { base, key, lane, configured: Boolean(base && key && lane) };
}

export function mailroomReliefDedupeKey(requestId) {
  const id = clean(requestId);
  if (!id) throw new Error("requestId required");
  return `paraai-outreach:${id}`;
}

export class OutreachMailroomError extends Error {
  constructor(code, detail = "", status = null) {
    super(`${code}${detail ? `:${detail}` : ""}`);
    this.code = code;
    this.detail = clean(detail).slice(0, 240);
    this.status = status;
  }
}

async function callMailroom(
  path,
  {
    method = "GET",
    body = null,
    config = mailroomReliefConfig(),
    fetchImpl = globalThis.fetch,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = {},
) {
  if (!config.configured) {
    throw new OutreachMailroomError("OUTREACH_MAILROOM_NOT_CONFIGURED");
  }
  let response;
  try {
    response = await fetchImpl(`${config.base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${config.key}`,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new OutreachMailroomError(
      "OUTREACH_MAILROOM_UNREACHABLE",
      error?.message || error,
    );
  }
  const parsed = await response.json().catch(() => ({}));
  if (!response.ok || parsed?.ok === false) {
    throw new OutreachMailroomError(
      `OUTREACH_MAILROOM_HTTP_${response.status}`,
      parsed?.error || parsed?.detail || "request rejected",
      response.status,
    );
  }
  return parsed;
}

function sentResult(status, { dedupeKey, rowId = null } = {}) {
  return {
    id: clean(status?.gmail_message_id) || null,
    threadId: clean(status?.result_thread_id) || null,
    providerMessageId: clean(status?.gmail_message_id) || null,
    mailroomRowId: status?.id ?? rowId,
    dedupeKey,
    transport: "mailroom-sendgrid",
    sentAt: clean(status?.sent_at) || null,
  };
}

function assertRunnableStatus(status) {
  if (!status?.found) return;
  const state = clean(status.state).toLowerCase();
  if (state === "review" || state === "dead") {
    throw new OutreachMailroomError(
      "OUTREACH_MAILROOM_PARKED",
      status.last_error || state,
    );
  }
}

async function statusFor(dedupeKey, options) {
  return callMailroom(
    `/api/status?key=${encodeURIComponent(dedupeKey)}`,
    options,
  );
}

export async function deliverViaMailroomRelief({
  message,
  requestId,
  candidateName = null,
  config = mailroomReliefConfig(),
  fetchImpl = globalThis.fetch,
  sleepImpl = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  triggerWorker = true,
} = {}) {
  if (!message?.to || !message?.subject || !message?.bodyText) {
    throw new OutreachMailroomError("OUTREACH_MAILROOM_MESSAGE_INVALID");
  }
  if (message.threadId || message.inReplyTo || message.references) {
    throw new OutreachMailroomError("OUTREACH_MAILROOM_THREADING_FORBIDDEN");
  }
  const dedupeKey = mailroomReliefDedupeKey(requestId);
  const options = { config, fetchImpl };

  let status = await statusFor(dedupeKey, options);
  if (status?.found && clean(status.state).toLowerCase() === "sent") {
    return sentResult(status, { dedupeKey });
  }
  assertRunnableStatus(status);

  let rowId = null;
  if (!status?.found) {
    try {
      const enqueued = await callMailroom("/api/enqueue", {
        ...options,
        method: "POST",
        body: {
          lane: config.lane,
          dedupeKey,
          to: message.to,
          toName: clean(candidateName) || undefined,
          subject: message.subject,
          text: message.bodyText,
          html: message.bodyHtml || undefined,
        },
      });
      rowId = enqueued.id ?? null;
    } catch (error) {
      // An enqueue response can be lost after the DB committed. Re-read the
      // deterministic key before calling the outcome uncertain.
      status = await statusFor(dedupeKey, options).catch(() => null);
      if (!status?.found) throw error;
    }
  }

  if (triggerWorker) {
    // The worker drains every active sender sequentially and can legitimately
    // run longer than the short enqueue/status calls when another lane has a
    // batch. The dashboard function itself has a 120-second ceiling.
    await callMailroom("/api/worker", { ...options, timeoutMs: 60_000 });
  }

  for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt += 1) {
    status = await statusFor(dedupeKey, options);
    if (status?.found && clean(status.state).toLowerCase() === "sent") {
      return sentResult(status, { dedupeKey, rowId });
    }
    assertRunnableStatus(status);
    if (attempt < POLL_ATTEMPTS - 1) await sleepImpl(POLL_DELAY_MS);
  }
  throw new OutreachMailroomError(
    "OUTREACH_MAILROOM_PENDING",
    `dedupe ${dedupeKey} remains ${clean(status?.state) || "unknown"}`,
  );
}
