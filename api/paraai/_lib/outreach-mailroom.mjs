import { createHash } from "node:crypto";

// Para AI delivery through Mailroom. The permanent interview-request lane may
// carry RFC thread headers through SendGrid; the confirmation-gated relief lane
// remains fresh-thread only and deliberately suppresses later follow-ups.

const DEFAULT_BASE = "https://raydar-mailroom.vercel.app";
export const PARAAI_OUTREACH_RELIEF_LANE = "paraai-outreach-relief";
export const PARAAI_INTERVIEW_REQUESTS_LANE = "paraai-interview-requests";
export const PARAAI_INTERVIEW_REQUESTS_SENDER = "david-sg";
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

export function mailroomOutreachConfig(env = process.env) {
  const base = clean(env.MAILROOM_BASE || DEFAULT_BASE).replace(/\/+$/, "");
  const key = clean(env.MAILROOM_API_KEY);
  const lane = clean(
    env.PARAAI_INTERVIEW_REQUEST_MAILROOM_LANE || PARAAI_INTERVIEW_REQUESTS_LANE,
  );
  return { base, key, lane, configured: Boolean(base && key && lane) };
}

export function mailroomReliefDedupeKey(requestId) {
  const id = clean(requestId);
  if (!id) throw new Error("requestId required");
  return `paraai-outreach:${id}`;
}

export function mailroomOutreachDedupeKey(actionKey) {
  const key = clean(actionKey);
  if (!key) throw new Error("actionKey required");
  return `paraai-interview-request:${key}`;
}

export function mailroomReliefConfirmation(
  requestId,
  { recipientEmail = "", withoutDigest = false } = {},
) {
  const id = clean(requestId);
  const email = clean(recipientEmail).toLowerCase();
  if (!id) throw new Error("requestId required");
  return [
    "SEND VIA MAILROOM",
    id,
    ...(email ? ["TO", email] : []),
    ...(withoutDigest ? ["WITHOUT DIGEST"] : []),
  ].join(" ");
}

export function mailroomMatchBundleConfirmation(
  requestIds,
  { recipientEmail = "" } = {},
) {
  const ids = (Array.isArray(requestIds) ? requestIds : [])
    .map(clean)
    .filter(Boolean)
    .sort();
  const email = clean(recipientEmail).toLowerCase();
  if (ids.length < 2 || new Set(ids).size !== ids.length) {
    throw new Error("at least two unique requestIds required");
  }
  if (!email) throw new Error("recipientEmail required");
  return `SEND BUNDLE VIA MAILROOM ${ids.join(",")} TO ${email}`;
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

function providerReference(status) {
  return clean(status?.provider_message_id || status?.providerMessageId)
    || clean(status?.gmail_message_id)
    || null;
}

function reliefSentResult(status, {
  dedupeKey,
  rowId = null,
  sourceThreadId = null,
} = {}) {
  return {
    providerMessageId: providerReference(status),
    rfc822MessageId: clean(status?.rfc822_message_id) || null,
    threadId: clean(status?.result_thread_id) || clean(sourceThreadId) || null,
    mailroomRowId: status?.id ?? rowId,
    dedupeKey,
    transport: "mailroom-sendgrid",
    acceptanceState: "provider_accepted",
    sentAt: clean(status?.sent_at) || null,
  };
}

function queuedResult(status, { dedupeKey, rowId = null } = {}) {
  return {
    queued: true,
    state: clean(status?.state).toLowerCase() || "pending",
    mailroomRowId: status?.id ?? rowId,
    dedupeKey,
    transport: "mailroom-sendgrid",
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

export function mailroomOutreachPayloadHash(message, candidateName = null, {
  lane = PARAAI_INTERVIEW_REQUESTS_LANE,
  sender = PARAAI_INTERVIEW_REQUESTS_SENDER,
} = {}) {
  return createHash("sha256").update(JSON.stringify({
    laneId: lane,
    senderId: sender,
    toEmail: clean(message?.to),
    toName: clean(candidateName) || null,
    subject: message?.subject ?? "",
    text: message?.bodyText,
    html: message?.bodyHtml || null,
    inReplyTo: clean(message?.inReplyTo) || null,
    threadId: clean(message?.threadId) || null,
    references: clean(message?.references) || null,
  })).digest("hex");
}

// SendGrid event ids may append dot-delimited routing data to the X-Message-ID
// returned by the submission API. That suffix does not change message identity.
export function normalizeSendgridProviderId(value) {
  return clean(value).replace(/^<|>$/g, "").split(".")[0].toLowerCase();
}

const NEGATIVE_EVENTS = new Set([
  "bounce",
  "blocked",
  "dropped",
  "spamreport",
  "unsubscribe",
]);

function assertPermanentIdentity(status, expected) {
  if (!status?.found) return;
  if (
    clean(status.lane_id) !== expected.lane ||
    clean(status.sender_id) !== PARAAI_INTERVIEW_REQUESTS_SENDER ||
    clean(status.payload_hash) !== expected.payloadHash ||
    (expected.rowId != null && String(status.id) !== String(expected.rowId))
  ) {
    throw new OutreachMailroomError("OUTREACH_MAILROOM_IDENTITY_MISMATCH");
  }
}

function permanentResult(status, expected) {
  const state = clean(status?.state).toLowerCase();
  const base = {
    deliveryState: "queued",
    state: state || "pending",
    providerMessageId: clean(status?.provider_message_id) || null,
    rfc822MessageId: clean(status?.rfc822_message_id) || null,
    threadId: clean(status?.result_thread_id) || clean(expected.sourceThreadId) || null,
    mailroomRowId: status?.id ?? expected.rowId ?? null,
    dedupeKey: expected.dedupeKey,
    payloadHash: expected.payloadHash,
    transport: "mailroom-sendgrid",
    sentAt: clean(status?.sent_at) || null,
  };
  if (state !== "sent") return base;
  if (!base.providerMessageId || !base.rfc822MessageId || !base.sentAt) {
    throw new OutreachMailroomError("OUTREACH_MAILROOM_RECEIPT_INVALID");
  }

  const providerId = normalizeSendgridProviderId(base.providerMessageId);
  const terminalEvents = (Array.isArray(status?.deliveryEvents) ? status.deliveryEvents : [])
    .filter((event) => (
      clean(event?.event_type).toLowerCase() === "delivered" ||
      NEGATIVE_EVENTS.has(clean(event?.event_type).toLowerCase())
    ));
  const matching = terminalEvents.filter(
    (event) => normalizeSendgridProviderId(event?.provider_message_id) === providerId,
  );
  if (terminalEvents.length && matching.length !== terminalEvents.length) {
    throw new OutreachMailroomError("OUTREACH_MAILROOM_EVENT_IDENTITY_MISMATCH");
  }
  const negative = matching.find(
    (event) => NEGATIVE_EVENTS.has(clean(event?.event_type).toLowerCase()),
  );
  if (negative) {
    return {
      ...base,
      deliveryState: "negative",
      negativeEvent: {
        eventId: clean(negative.event_id) || null,
        eventType: clean(negative.event_type).toLowerCase(),
        occurredAt: clean(negative.occurred_at) || null,
        reason: clean(negative.reason) || null,
        status: clean(negative.status) || null,
      },
    };
  }
  const delivered = matching.find(
    (event) => clean(event?.event_type).toLowerCase() === "delivered",
  );
  if (delivered) {
    return {
      ...base,
      deliveryState: "delivered",
      deliveredAt: clean(delivered.occurred_at) || base.sentAt,
      deliveryEventId: clean(delivered.event_id) || null,
    };
  }
  return { ...base, deliveryState: "provider_accepted" };
}

async function statusFor(dedupeKey, options) {
  return callMailroom(
    `/api/status?key=${encodeURIComponent(dedupeKey)}`,
    options,
  );
}

function threadedMessage(message) {
  const hasThreadFields = Boolean(
    clean(message?.threadId) || clean(message?.inReplyTo) || clean(message?.references),
  );
  if (!hasThreadFields) return false;
  if (!clean(message?.inReplyTo) || !clean(message?.references)) {
    throw new OutreachMailroomError("OUTREACH_MAILROOM_THREADING_INVALID");
  }
  return true;
}

// The automatic lane never invokes /api/worker: that endpoint drains every
// active sender and can operate unrelated lanes. A normal Mailroom cron owns
// delivery. Re-entry only reads or reuses this exact deterministic key.
export async function deliverViaMailroomOutreach({
  message,
  candidateName = null,
  config = mailroomOutreachConfig(),
  fetchImpl = globalThis.fetch,
} = {}) {
  if (!message?.to || !message?.subject || !message?.bodyText || !message?.actionKey) {
    throw new OutreachMailroomError("OUTREACH_MAILROOM_MESSAGE_INVALID");
  }
  const threaded = threadedMessage(message);
  const dedupeKey = mailroomOutreachDedupeKey(message.actionKey);
  const payloadHash = mailroomOutreachPayloadHash(message, candidateName, {
    lane: config.lane,
  });
  const options = { config, fetchImpl };
  const expected = {
    lane: config.lane,
    dedupeKey,
    payloadHash,
    rowId: null,
    sourceThreadId: message.threadId,
  };

  let status = await statusFor(dedupeKey, options);
  assertPermanentIdentity(status, expected);
  assertRunnableStatus(status);
  if (status?.found) return permanentResult(status, expected);

  let rowId = status?.id ?? null;
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
          ...(threaded ? {
            inReplyTo: message.inReplyTo,
            references: message.references,
            ...(clean(message.threadId) ? { threadId: message.threadId } : {}),
          } : {}),
        },
      });
      rowId = enqueued.id ?? null;
      expected.rowId = rowId;
      if (clean(enqueued.payloadHash) && clean(enqueued.payloadHash) !== payloadHash) {
        throw new OutreachMailroomError("OUTREACH_MAILROOM_IDENTITY_MISMATCH");
      }
    } catch (error) {
      // A lost enqueue response is resolved only by the same deterministic key.
      // Gmail Sent absence is not evidence that SendGrid did not accept it.
      status = await statusFor(dedupeKey, options).catch(() => null);
      if (!status?.found) {
        throw new OutreachMailroomError(
          "OUTREACH_MAILROOM_ENQUEUE_UNKNOWN",
          error?.code || error?.message || error,
        );
      }
      assertPermanentIdentity(status, expected);
      assertRunnableStatus(status);
    }
  }

  status = await statusFor(dedupeKey, options);
  assertPermanentIdentity(status, expected);
  assertRunnableStatus(status);
  if (status?.found) return permanentResult(status, expected);
  return queuedResult(status, { dedupeKey, rowId });
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
    return reliefSentResult(status, { dedupeKey });
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
      return reliefSentResult(status, { dedupeKey, rowId });
    }
    assertRunnableStatus(status);
    if (attempt < POLL_ATTEMPTS - 1) await sleepImpl(POLL_DELAY_MS);
  }
  throw new OutreachMailroomError(
    "OUTREACH_MAILROOM_PENDING",
    `dedupe ${dedupeKey} remains ${clean(status?.state) || "unknown"}`,
  );
}
