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

// ── Default transport for NEW conversations (David, 2026-09-28) ──────────────
// New Para AI interview-request conversations go out through the Mailroom on
// SendGrid, so they stop filling david@raydar.xyz's Gmail Sent folder.
// Conversations that are already open in Gmail finish in Gmail. The automatic
// path shares the relief lane: it is the one Mailroom lane already bound to the
// SendGrid sender for this copy, and sharing it means no Mailroom migration or
// release. The two paths never share a dedupe key (`paraai-outreach:<id>` for
// relief, `paraai-outreach:auto:<actionKey>` here).
//
// PARAAI_OUTREACH_TRANSPORT=gmail is the code-side rollback. The Mailroom-side
// rollback needs no deploy: disable the lane (or its SendGrid threading) in the
// Hub and new conversations go back to Gmail on the next tick, because
// mailroomOutreachLaneReady() stops answering true.
export const PARAAI_OUTREACH_MAILROOM_LANE = PARAAI_OUTREACH_RELIEF_LANE;
const LANE_READY_CACHE_MS = 60_000;
const DEFAULT_WAKE_POLL_ATTEMPTS = 6;

export function outreachTransportMode(env = process.env) {
  return clean(env.PARAAI_OUTREACH_TRANSPORT).toLowerCase() === "gmail" ? "gmail" : "mailroom";
}

export function mailroomOutreachDedupeKey(actionKey) {
  const key = clean(actionKey);
  if (!key) throw new Error("actionKey required");
  return `paraai-outreach:auto:${key}`;
}

// The Mailroom's standing dispatch envelope (mailroom/lib/dispatch-window.mjs):
// 05:00 to 19:30 America/Los_Angeles. Rows enqueued outside it wait for the
// next opening. A follow-up is only enqueued inside it, so its reply check is
// fresh at the moment it actually leaves.
const PT_MINUTE = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Los_Angeles",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
export function mailroomDispatchWindowOpen(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return false;
  const parts = Object.fromEntries(
    PT_MINUTE.formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  const minute = Number(parts.hour) * 60 + Number(parts.minute);
  return minute >= 5 * 60 && minute < 19 * 60 + 30;
}

let laneReadyCache = null;
export function resetMailroomOutreachLaneCache() {
  laneReadyCache = null;
}

// Ready means the lane can carry BOTH a fresh email and a threaded reply:
// enabled, on an active SendGrid sender that replies to the mailbox, and with
// SendGrid threading armed. A threaded row on a lane without threading parks
// in review (THREADED_UNSUPPORTED_TRANSPORT), so a half-armed lane is not ready.
// Never throws: an unreadable Mailroom reads as "not ready", which routes new
// conversations to Gmail exactly as before.
export async function mailroomOutreachLaneReady({
  config = mailroomReliefConfig(),
  fetchImpl = globalThis.fetch,
  now = Date.now(),
} = {}) {
  if (!config.configured) return { ready: false, reason: "not_configured" };
  if (laneReadyCache && laneReadyCache.lane === config.lane && now - laneReadyCache.at < LANE_READY_CACHE_MS) {
    return laneReadyCache.value;
  }
  let value;
  try {
    const body = await callMailroom("/api/lanes", { config, fetchImpl });
    const lane = (Array.isArray(body?.lanes) ? body.lanes : []).find(
      (row) => clean(row?.id) === config.lane,
    );
    if (!lane) value = { ready: false, reason: "lane_missing" };
    else if (lane.enabled !== true) value = { ready: false, reason: "lane_disabled" };
    else if (clean(lane.transport) !== "sendgrid") value = { ready: false, reason: "lane_not_sendgrid" };
    else if (clean(lane.sender_status) !== "active") value = { ready: false, reason: "sender_inactive" };
    else if (lane.sendgrid_threading_enabled !== true) value = { ready: false, reason: "threading_disabled" };
    else value = { ready: true, reason: null, senderId: clean(lane.sender_id) || null };
  } catch (error) {
    value = { ready: false, reason: clean(error?.code) || "lanes_unreadable" };
  }
  laneReadyCache = { lane: config.lane, at: now, value };
  return value;
}

// A SendGrid send leaves nothing in Gmail, so a bounce can only be learned from
// the Mailroom's signature-verified delivery events. `bounce` is a hard bounce
// (the Mailroom already splits SendGrid's "blocked" out of it); `dropped` counts
// only when SendGrid suppressed the address for a bounce or an invalid address.
export function mailroomBounceFromStatus(status) {
  const events = Array.isArray(status?.deliveryEvents) ? status.deliveryEvents : [];
  const hit = events.find((event) => {
    const type = clean(event?.event_type).toLowerCase();
    if (type === "bounce") return true;
    return type === "dropped" && /bounce|invalid/i.test(clean(event?.reason));
  });
  if (!hit) return null;
  return {
    at: clean(hit.occurred_at) || new Date().toISOString(),
    subject: `SendGrid ${clean(hit.event_type).toLowerCase()}`,
    reason: clean(hit.reason).slice(0, 180) || null,
    source: "mailroom_delivery_event",
  };
}

export async function readMailroomOutreachStatus(dedupeKey, {
  config = mailroomReliefConfig(),
  fetchImpl = globalThis.fetch,
} = {}) {
  return statusFor(dedupeKey, { config, fetchImpl });
}

function outreachSentResult(status, { dedupeKey, rowId = null } = {}) {
  const providerMessageId = clean(status?.provider_message_id) || null;
  return {
    id: providerMessageId,
    threadId: null,
    providerMessageId,
    rfc822MessageId: clean(status?.rfc822_message_id) || null,
    mailroomRowId: status?.id ?? rowId,
    dedupeKey,
    transport: "mailroom-sendgrid",
    sentAt: clean(status?.sent_at) || null,
    delivery: "sent",
  };
}

// Status-first, exactly-once delivery through the Mailroom. The dedupe key is
// deterministic per action, so every retry, crash recovery or lost response
// converges on the same outbox row: this function can be called again for the
// same action at any time without risking a second email. It returns either a
// sent receipt or `{ queued: true }` when the row is accepted but still waiting
// (the dispatch window is closed, a brake is armed, or the worker is busy). It
// throws OUTREACH_MAILROOM_PARKED only when the Mailroom parked the row for
// review, which is the one outcome a human has to reconcile.
export async function deliverViaMailroomOutreach({
  message,
  actionKey,
  candidateName = null,
  config = mailroomReliefConfig(),
  fetchImpl = globalThis.fetch,
  sleepImpl = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  pollAttempts = DEFAULT_WAKE_POLL_ATTEMPTS,
} = {}) {
  if (!message?.to || !message?.subject || !message?.bodyText) {
    throw new OutreachMailroomError("OUTREACH_MAILROOM_MESSAGE_INVALID");
  }
  if (message.inReplyTo && !message.references) {
    throw new OutreachMailroomError("OUTREACH_MAILROOM_THREADING_INVALID");
  }
  const dedupeKey = mailroomOutreachDedupeKey(actionKey || message.actionKey);
  const options = { config, fetchImpl };

  let status = await statusFor(dedupeKey, options);
  if (status?.found && clean(status.state).toLowerCase() === "sent") {
    return outreachSentResult(status, { dedupeKey });
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
          // RFC headers only. A Gmail thread id means nothing to SendGrid, and
          // the Mailroom parks a row that carries one on a SendGrid sender.
          inReplyTo: message.inReplyTo || undefined,
          references: message.references || undefined,
        },
      });
      rowId = enqueued.id ?? enqueued.outboxId ?? null;
    } catch (error) {
      status = await statusFor(dedupeKey, options).catch(() => null);
      if (!status?.found) throw error;
    }
    status = await statusFor(dedupeKey, options).catch(() => status);
  }

  // Wake exactly this row rather than waiting for the two-minute cron. The
  // targeted wake claims only this dedupe key, so a long queue on the same
  // SendGrid sender (for example CRM invitations) cannot delay it. A failed
  // wake is harmless: the cron drains the row on its next pass.
  const senderId = clean(status?.sender_id);
  if (senderId) {
    await callMailroom("/api/worker", {
      ...options,
      method: "POST",
      body: { senderId, operationKey: dedupeKey },
      timeoutMs: 30_000,
    }).catch(() => null);
  }

  for (let attempt = 0; attempt < pollAttempts; attempt += 1) {
    status = await statusFor(dedupeKey, options).catch(() => status);
    if (status?.found && clean(status.state).toLowerCase() === "sent") {
      return outreachSentResult(status, { dedupeKey, rowId });
    }
    assertRunnableStatus(status);
    if (attempt < pollAttempts - 1) await sleepImpl(POLL_DELAY_MS);
  }
  return {
    queued: true,
    dedupeKey,
    mailroomRowId: status?.id ?? rowId,
    mailroomState: clean(status?.state) || "unknown",
    transport: "mailroom-sendgrid",
  };
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
