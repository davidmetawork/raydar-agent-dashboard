import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export const RESUME_SIGNAL_MAX_SKEW_SECONDS = 5 * 60;
export const RESUME_SIGNAL_MIN_SECRET_LENGTH = 24;

function signalError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function headerValue(headers, name) {
  if (headers?.get) return String(headers.get(name) || "");
  const wanted = String(name).toLowerCase();
  for (const [key, value] of Object.entries(headers || {})) {
    if (String(key).toLowerCase() === wanted) {
      return String(Array.isArray(value) ? value[0] : value || "");
    }
  }
  return "";
}

export function resumeSignalConfigured(secret = process.env.PARAAI_RESUME_SIGNAL_SECRET) {
  return String(secret || "").trim().length >= RESUME_SIGNAL_MIN_SECRET_LENGTH;
}

export function resumeSignalBase({
  timestamp,
  method,
  pathname,
  rawBody = "",
} = {}) {
  return `${String(timestamp)}.${String(method || "").toUpperCase()}.${String(pathname || "")}.${String(rawBody)}`;
}

export function signResumeSignal({
  secret,
  timestamp,
  method,
  pathname,
  rawBody = "",
} = {}) {
  const configured = String(secret || "").trim();
  if (configured.length < RESUME_SIGNAL_MIN_SECRET_LENGTH) {
    throw signalError("RESUME_SIGNAL_NOT_CONFIGURED", "resume signal secret is not configured");
  }
  return `v1=${createHmac("sha256", configured)
    .update(resumeSignalBase({ timestamp, method, pathname, rawBody }))
    .digest("hex")}`;
}

export function resumeSignalId({ eventId = "", rawBody = "" } = {}) {
  const external = String(eventId || "").trim();
  const hash = createHash("sha256")
    .update("resume-signal-event-v1")
    .update("\0")
    .update(external ? `event:${external}\0` : "");
  return hash.update(`body:${String(rawBody || "")}`).digest("hex");
}

export function verifyResumeSignal({
  secret = process.env.PARAAI_RESUME_SIGNAL_SECRET,
  headers,
  method,
  pathname,
  rawBody = "",
  nowMs = Date.now(),
  maxSkewSeconds = RESUME_SIGNAL_MAX_SKEW_SECONDS,
} = {}) {
  const configured = String(secret || "").trim();
  if (configured.length < RESUME_SIGNAL_MIN_SECRET_LENGTH) {
    throw signalError("RESUME_SIGNAL_NOT_CONFIGURED", "resume signal secret is not configured");
  }
  const timestamp = headerValue(headers, "x-raydar-timestamp");
  const received = headerValue(headers, "x-raydar-signature");
  // Contract is epoch seconds, never milliseconds. Reject 13-digit values
  // instead of silently interpreting them on the wrong time scale.
  if (!/^[0-9]{10}$/.test(timestamp)) {
    throw signalError("RESUME_SIGNAL_TIMESTAMP_INVALID", "resume signal timestamp is missing or invalid");
  }
  const timestampSeconds = Number(timestamp);
  const currentMs = Number(nowMs);
  const tolerance = Math.max(1, Number(maxSkewSeconds) || RESUME_SIGNAL_MAX_SKEW_SECONDS);
  if (
    !Number.isSafeInteger(timestampSeconds)
    || !Number.isFinite(currentMs)
    || Math.abs(currentMs / 1000 - timestampSeconds) > tolerance
  ) {
    throw signalError("RESUME_SIGNAL_TIMESTAMP_INVALID", "resume signal timestamp is outside the replay window");
  }
  if (!/^v1=[a-f0-9]{64}$/.test(received)) {
    throw signalError("RESUME_SIGNAL_SIGNATURE_INVALID", "resume signal signature is missing or invalid");
  }
  const expected = signResumeSignal({
    secret: configured,
    timestamp,
    method,
    pathname,
    rawBody,
  });
  const expectedBytes = Buffer.from(expected);
  const receivedBytes = Buffer.from(received);
  if (
    expectedBytes.length !== receivedBytes.length
    || !timingSafeEqual(expectedBytes, receivedBytes)
  ) {
    throw signalError("RESUME_SIGNAL_SIGNATURE_INVALID", "resume signal signature is invalid");
  }
  return {
    timestamp: timestampSeconds,
    signedRequestId: resumeSignalId({ rawBody }),
  };
}

export function requestPathname(request) {
  try {
    return new URL(String(request?.url || ""), "https://monitor.raydar.xyz").pathname;
  } catch {
    return "";
  }
}
