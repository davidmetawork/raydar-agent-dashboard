import { createHash } from "node:crypto";

const EVENT_TTL_SECONDS = 180 * 24 * 3600;

function codedError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function enabled(value) {
  return value === "1" || String(value ?? "").trim().toLowerCase() === "true";
}

export function raydarBookingNotificationMode({
  env = process.env,
  nowMs = Date.now(),
} = {}) {
  if (!enabled(env.RAYDAR_SCHEDULER_NOTIFICATION_ENABLED)) {
    return "disabled";
  }
  if (!enabled(env.RAYDAR_SCHEDULER_NOTIFICATION_APPLY)) {
    return "dry-run";
  }
  const notBefore = Date.parse(
    String(env.RAYDAR_SCHEDULER_NOTIFICATION_NOT_BEFORE ?? ""),
  );
  if (!Number.isFinite(notBefore)) {
    throw codedError("RAYDAR_BOOKING_NOTIFICATION_NOT_BEFORE_REQUIRED");
  }
  if (nowMs < notBefore) {
    throw codedError("RAYDAR_BOOKING_NOTIFICATION_NOT_ARMED");
  }
  return "apply";
}

function notificationKey(eventId) {
  const digest = createHash("sha256")
    .update(`raydar-booking-notification-v1\0${String(eventId)}`)
    .digest("hex");
  return `seqguard:raydar-notification:${digest}`;
}

function cleanName(value) {
  const selected = String(value ?? "").replace(/\s+/gu, " ").trim();
  const safe = (
    selected
    && selected.length <= 200
    && !/[\u0000-\u001f\u007f]/u.test(selected)
  ) ? selected : "A candidate";
  return safe
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;");
}

function slackDate(instant) {
  const timestamp = Date.parse(String(instant ?? ""));
  if (!Number.isFinite(timestamp)) {
    throw codedError("RAYDAR_BOOKING_NOTIFICATION_TIME_INVALID");
  }
  const epoch = Math.floor(timestamp / 1_000);
  return `<!date^${epoch}^{date_short_pretty} at {time}|scheduled time>`;
}

export function renderRaydarBookingNotification(event) {
  const call = event?.callType === "agent"
    ? "Agent Call"
    : event?.callType === "human"
      ? "Human Call"
      : null;
  if (!call) throw codedError("RAYDAR_BOOKING_NOTIFICATION_CALL_TYPE_INVALID");
  const candidate = cleanName(event?.candidate?.name);
  const when = slackDate(event?.startsAt);
  if (event?.event === "booking.confirmed") {
    return `:calendar: ${candidate} booked a Raydar ${call} for ${when}.`;
  }
  if (event?.event === "booking.rescheduled") {
    return `:calendar: ${candidate} rescheduled a Raydar ${call} to ${when}.`;
  }
  if (event?.event === "booking.cancelled") {
    return `:no_entry_sign: ${candidate} cancelled a Raydar ${call} scheduled for ${when}. Sequences remain paused until reviewed.`;
  }
  throw codedError("RAYDAR_BOOKING_NOTIFICATION_EVENT_INVALID");
}

/**
 * Send one internal notification for one authenticated scheduler event.
 *
 * `claimed` after a crash is deliberately terminal-unknown: sending again
 * could duplicate a Slack message whose HTTP response was lost. A definitive
 * `failed` result may retry; a transport throw is recorded `unknown`.
 */
export async function notifyRaydarBookingEvent(event, {
  env = process.env,
  nowMs = Date.now(),
  claim,
  read,
  write,
  send,
} = {}) {
  const mode = raydarBookingNotificationMode({ env, nowMs });
  if (mode !== "apply") return { ok: true, status: mode };
  if (
    typeof claim !== "function"
    || typeof read !== "function"
    || typeof write !== "function"
    || typeof send !== "function"
  ) {
    throw codedError("RAYDAR_BOOKING_NOTIFICATION_DEPENDENCY_INVALID");
  }
  const key = notificationKey(event?.eventId);
  const attemptedAt = new Date(nowMs).toISOString();
  let won;
  try {
    won = await claim(key, {
      state: "claimed",
      attemptedAt,
      event: event.event,
    }, EVENT_TTL_SECONDS);
  } catch {
    throw codedError("RAYDAR_BOOKING_NOTIFICATION_STORE_FAILED");
  }
  if (won !== "OK" && won !== true) {
    let prior;
    try {
      prior = await read(key);
    } catch {
      throw codedError("RAYDAR_BOOKING_NOTIFICATION_STORE_FAILED");
    }
    if (prior?.state === "done") {
      return { ok: true, status: "duplicate" };
    }
    if (prior?.state === "unknown" || prior?.state === "claimed") {
      if (prior?.state === "claimed") {
        await write(key, {
          state: "unknown",
          attemptedAt: prior.attemptedAt || attemptedAt,
          settledAt: attemptedAt,
          event: event.event,
        }, EVENT_TTL_SECONDS).catch(() => {});
      }
      return { ok: true, status: "unknown" };
    }
    // A definitive provider rejection is retryable on scheduler redelivery.
  }

  let sent;
  try {
    sent = await send(renderRaydarBookingNotification(event));
  } catch {
    await write(key, {
      state: "unknown",
      attemptedAt,
      settledAt: new Date().toISOString(),
      event: event.event,
    }, EVENT_TTL_SECONDS).catch(() => {});
    return { ok: true, status: "unknown" };
  }
  if (sent !== true) {
    try {
      await write(key, {
        state: "failed",
        attemptedAt,
        settledAt: new Date().toISOString(),
        event: event.event,
      }, EVENT_TTL_SECONDS);
    } catch {
      throw codedError("RAYDAR_BOOKING_NOTIFICATION_STORE_FAILED");
    }
    return { ok: false, status: "failed" };
  }
  try {
    await write(key, {
      state: "done",
      attemptedAt,
      settledAt: new Date().toISOString(),
      event: event.event,
    }, EVENT_TTL_SECONDS);
  } catch {
    // The Slack write succeeded. Retrying would risk a duplicate, so this is an
    // unknown terminal settlement, not a retryable failure.
    return { ok: true, status: "unknown" };
  }
  return { ok: true, status: "sent" };
}
