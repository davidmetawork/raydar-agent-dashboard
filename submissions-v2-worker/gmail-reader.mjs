import { createHash } from "node:crypto";

import {
  APPROVED_EMAIL_FAMILIES,
  GMAIL_ROLE_INTEREST_SCOPE,
  SUBMISSIONS_V2_APPROVED_ACTIVATION_AT,
} from "../api/submissions-v2/_lib/email-source-policy.mjs";
import { collectRoleInterestWindow } from "../api/submissions-v2/_lib/gmail-interview-source.mjs";

const error = (code) => Object.assign(new Error(code), { code, retryable: true });
const APPROVED_FAMILIES = new Set(APPROVED_EMAIL_FAMILIES);
const HEX_DIGEST = /^[a-f0-9]{64}$/u;
const sourceSessionId = (value) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(String(value || ""))
  ? String(value)
  : null;

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

const requestDigest = (value) => createHash("sha256").update(canonicalJson(value)).digest("hex");
const jsonEvent = (value) => JSON.parse(JSON.stringify(value));
const bounded = (value, limit = 500) => typeof value === "string" && value.length > 0 && value.length <= limit;

function normalizePendingAdmission(value, checkpointLane) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw error("gmail_source_recovery_invalid");
  const window = value.window;
  const after = Number(window?.after);
  const before = Number(window?.before);
  if (value.schema_version !== 1 || value.scope !== GMAIL_ROLE_INTEREST_SCOPE || value.lane !== checkpointLane
      || !Number.isSafeInteger(after) || !Number.isSafeInteger(before) || after < 0 || after >= before
      || before - after > 3_660_000 || !bounded(value.event_id, 200)
      || value.mailbox_id !== "david-raydar-xyz" || !APPROVED_FAMILIES.has(value.source_family)
      || !/^[a-f0-9]{1,64}$/iu.test(value.provider_message_id || "")
      || !/^[a-f0-9]{1,64}$/iu.test(value.provider_thread_id || "")
      || value.idempotency_key !== `gmail:${value.mailbox_id}:${value.provider_message_id}`
      || !HEX_DIGEST.test(value.content_digest || "") || !HEX_DIGEST.test(value.request_digest || "")) {
    throw error("gmail_source_recovery_invalid");
  }
  return {
    schema_version: 1,
    scope: GMAIL_ROLE_INTEREST_SCOPE,
    lane: checkpointLane,
    window: { after, before },
    event_id: value.event_id,
    mailbox_id: value.mailbox_id,
    source_family: value.source_family,
    provider_message_id: value.provider_message_id,
    provider_thread_id: value.provider_thread_id,
    idempotency_key: value.idempotency_key,
    content_digest: value.content_digest,
    request_digest: value.request_digest,
  };
}

function pendingAdmissionFor(event, range, checkpointLane) {
  const exactEvent = jsonEvent(event);
  return normalizePendingAdmission({
    schema_version: 1,
    scope: GMAIL_ROLE_INTEREST_SCOPE,
    lane: checkpointLane,
    window: { after: range.after, before: range.before },
    event_id: exactEvent.event_id,
    mailbox_id: exactEvent.mailbox_id,
    source_family: exactEvent.source_family,
    provider_message_id: exactEvent.provider_message_id,
    provider_thread_id: exactEvent.provider_thread_id,
    idempotency_key: exactEvent.idempotency_key,
    content_digest: exactEvent.content_digest,
    request_digest: requestDigest(exactEvent),
  }, checkpointLane);
}

function recoveredEvent(events, pending) {
  const event = events.find((candidate) => candidate.event_id === pending.event_id);
  if (!event) throw error("gmail_source_recovery_event_missing");
  const exactEvent = jsonEvent(event);
  if (exactEvent.mailbox_id !== pending.mailbox_id || exactEvent.source_family !== pending.source_family
      || exactEvent.provider_message_id !== pending.provider_message_id
      || exactEvent.provider_thread_id !== pending.provider_thread_id
      || exactEvent.idempotency_key !== pending.idempotency_key
      || exactEvent.content_digest !== pending.content_digest
      || requestDigest(exactEvent) !== pending.request_digest) {
    throw error("gmail_source_recovery_event_mismatch");
  }
  return exactEvent;
}

export function sourceAuthorityHeaders(env = process.env) {
  const value = String(env.SUBMISSIONS_V2_SOURCE_AUTHORITY_HEADER || "").trim();
  if (!value) return {};
  if (!/^[A-Za-z0-9_-]{1,8192}$/u.test(value)) throw error("gmail_source_authority_invalid");
  return { "x-raydar-source-authority": value };
}

export function approvedGmailActivation(env = process.env) {
  const configured = String(env.SUBMISSIONS_V2_GMAIL_ACTIVATED_AT || "").trim();
  if (configured && configured !== SUBMISSIONS_V2_APPROVED_ACTIVATION_AT) {
    throw error("gmail_activation_invalid");
  }
  return SUBMISSIONS_V2_APPROVED_ACTIVATION_AT;
}

export function gmailWindow(checkpoint, { activationAt, now }) {
  const activation = Date.parse(activationAt || "");
  if (!Number.isFinite(activation)) throw error("gmail_activation_required");
  const through = Number(checkpoint?.through ?? activation);
  if (!Number.isFinite(through) || through < activation) throw error("gmail_checkpoint_invalid");
  const after = Math.max(activation, through - 60_000);
  const span = Math.min(3_600_000, Math.max(30_000, Number(checkpoint?.window_span_ms) || 3_600_000));
  const before = Math.min(now - 120_000, through + span);
  return before > through ? { after, before } : null;
}

export async function reconcileGmailRoleInterest({
  env, fetchImpl = fetch, signal, checkpoint = {}, checkpointLane, assertCurrent,
  resumeSourceSession = null, onSourceSession = async () => {},
  maxThreads = 12, now = Date.now(), sleepImpl = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  const activationAt = approvedGmailActivation(env);
  const range = gmailWindow(checkpoint, { activationAt, now });
  const resumeState = resumeSourceSession && typeof resumeSourceSession === "object"
    ? resumeSourceSession
    : resumeSourceSession ? { sourceSession: resumeSourceSession } : null;
  let sourceSession = resumeState ? sourceSessionId(resumeState.sourceSession) : null;
  if (resumeSourceSession && !sourceSession) throw error("gmail_source_session_invalid");
  let pendingAdmission = resumeState?.pendingAdmission
    ? normalizePendingAdmission(resumeState.pendingAdmission, checkpointLane)
    : null;
  // A retry can land inside the deliberate two-minute live lag.  It has no
  // new safe window to read, but it must not erase a previously confirmed
  // live lane and thereby pause the independent historical catch-up lane.
  if (!range && !sourceSession) return {
    checkpoint,
    completed: false,
    caught_up: checkpoint?.caught_up === true,
    accepted: 0,
    observed: 0,
    threads_read: 0,
  };
  const key = String(env.SUBMISSIONS_V2_MASTER_INBOX_WORKER_KEY || "");
  if (key.length < 32) throw error("gmail_read_broker_not_configured");
  let readCount = 0;
  let sourceSessionClosed = false;
  const authorityHeaders = sourceAuthorityHeaders(env);
  if (!new Set(["live", "catchup"]).has(checkpointLane)) {
    throw error("gmail_source_checkpoint_lane_invalid");
  }
  const request = async (input, { expectScope = true, paceProvider = false, requestRange = range } = {}) => {
    if (paceProvider && readCount++) await sleepImpl(1000);
    signal?.throwIfAborted();
    const response = await fetchImpl("https://raydar-master-inbox.vercel.app/api/worker/submissions-gmail", {
      method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json", ...authorityHeaders },
      body: JSON.stringify({ ...(requestRange || {}), scope: GMAIL_ROLE_INTEREST_SCOPE, ...input, ...(sourceSession ? { sourceSession } : {}) }), signal: AbortSignal.any([signal || new AbortController().signal, AbortSignal.timeout(45_000)]), redirect: "error",
    });
    const body = await response.json().catch(() => null);
    if (!response.ok || body?.ok !== true) throw error(/^[-_a-z0-9]{1,100}$/u.test(body?.error || "") ? body.error : "gmail_read_broker_failed");
    if (expectScope && body?.result?.brokerScope !== GMAIL_ROLE_INTEREST_SCOPE) throw error("gmail_broker_scope_mismatch");
    const returnedSession = sourceSessionId(body?.result?.sourceSession);
    if (!returnedSession) throw error("gmail_source_session_missing");
    if (sourceSession && returnedSession !== sourceSession) throw error("gmail_source_session_mismatch");
    const sessionChanged = sourceSession !== returnedSession;
    sourceSession = returnedSession;
    sourceSessionClosed = false;
    if (sessionChanged) await onSourceSession({ sourceSession });
    return body.result;
  };
  const abortSourceSession = async ({ required = false } = {}) => {
    if (!sourceSession || sourceSessionClosed) return true;
    try {
      const closingSession = sourceSession;
      const response = await fetchImpl("https://raydar-master-inbox.vercel.app/api/worker/submissions-gmail", {
        method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json", ...authorityHeaders },
        body: JSON.stringify({ operation: "abort", scope: GMAIL_ROLE_INTEREST_SCOPE, sourceSession: closingSession }),
        signal: AbortSignal.timeout(10_000), redirect: "error",
      });
      const body = await response.json().catch(() => null);
      const responseCode = /^[-_a-z0-9]{1,100}$/u.test(body?.error || "") ? body.error : "gmail_source_session_abort_failed";
      if (!response.ok && responseCode === "source_session_lost") {
        await onSourceSession(null);
        sourceSessionClosed = true;
        sourceSession = null;
        return true;
      }
      if (!response.ok || body?.ok !== true
        || (body?.result?.authorized !== true && body?.result?.aborted !== true)
        || sourceSessionId(body?.result?.sourceSession) !== closingSession
        || Number(body?.result?.unsettledAdmissions || 0) !== 0) {
        throw error(responseCode);
      }
      await onSourceSession(null);
      sourceSessionClosed = true;
      sourceSession = null;
      return true;
    } catch (failure) {
      if (required) throw failure;
      return false;
    }
  };
  const clientForRange = (requestRange) => ({
    list: ({ pageToken, scope }) => request({ operation: "list", scope, pageToken }, { paceProvider: true, requestRange }),
    thread: (threadId) => request({ operation: "thread", scope: GMAIL_ROLE_INTEREST_SCOPE, threadId }, { paceProvider: true, requestRange }),
  });
  // A previous process may have died after dispatch. Re-read the exact fixed
  // window to reconstruct the event without putting candidate-authored text
  // in an operational checkpoint, then retry admission before any new scan.
  if (sourceSession && pendingAdmission) {
    const recoveryRange = pendingAdmission.window;
    const recoveryEvents = await collectRoleInterestWindow({
      ...recoveryRange,
      client: clientForRange(recoveryRange),
      env,
      assertCurrent,
      maxThreads: 12,
    });
    const event = recoveredEvent(recoveryEvents, pendingAdmission);
    const recovered = await request({ operation: "admit", event }, { expectScope: false, requestRange: recoveryRange });
    if (recovered?.accepted !== true) throw error("gmail_intake_not_acknowledged");
    await onSourceSession({ sourceSession });
    pendingAdmission = null;
  }
  // A recovered/unused old session has no unsettled admission and can now be
  // closed explicitly before the replacement window begins.
  if (sourceSession) await abortSourceSession({ required: true });
  if (!range) return {
    checkpoint,
    completed: false,
    caught_up: checkpoint?.caught_up === true,
    accepted: 0,
    observed: 0,
    threads_read: 0,
  };
  const client = clientForRange(range);
  let events;
  try { events = await collectRoleInterestWindow({
    ...range,
    client,
    env,
    assertCurrent,
    maxThreads: Math.max(1, Math.min(12, Number(maxThreads) || 12)),
  }); }
  catch (failure) {
    if (failure.code !== "gmail_window_too_large") {
      await abortSourceSession();
      throw failure;
    }
    const through = Number(checkpoint.through ?? Date.parse(activationAt));
    const span = range.before - through;
    await abortSourceSession();
    if (span <= 30_000) throw failure;
    return { checkpoint: { ...checkpoint, through, window_span_ms: Math.max(30_000, Math.floor(span / 2)) }, completed: false, narrowed: true, accepted: 0 };
  }
  try {
    let accepted = 0;
    for (const event of events) {
      await assertCurrent();
      // Master Inbox retains the source-session lock until this signed V2
      // intake returns. A transfer therefore cannot retire the old reader in
      // the gap between authority validation and the immutable intake commit.
      const exactEvent = jsonEvent(event);
      pendingAdmission = pendingAdmissionFor(exactEvent, range, checkpointLane);
      await onSourceSession({ sourceSession, pendingAdmission });
      const result = await request({ operation: "admit", event: exactEvent }, { expectScope: false });
      if (result?.accepted !== true) throw error("gmail_intake_not_acknowledged");
      await onSourceSession({ sourceSession });
      pendingAdmission = null;
      accepted += result.existing || result.processing_state === "ignored_later" ? 0 : 1;
    }
    const nextCheckpoint = { through: range.before, window_span_ms: Math.min(3_600_000, (range.before - range.after) * 2) };
    const committed = await request({ operation: "checkpoint", lane: checkpointLane, checkpoint: nextCheckpoint }, { expectScope: false });
    if (committed?.authorized !== true) throw error("gmail_source_checkpoint_not_committed");
    if (authorityHeaders["x-raydar-source-authority"] && (committed.active !== true || committed.committed < 1)) {
      throw error("gmail_source_checkpoint_not_committed");
    }
    sourceSessionClosed = true;
    await onSourceSession(null);
    sourceSession = null;
    return {
      checkpoint: nextCheckpoint,
      completed: true,
      caught_up: range.before >= now - 120_000,
      accepted,
      observed: events.length,
      threads_read: Number(events.threads_read) || 0,
    };
  } catch (failure) {
    // Once a request may have crossed the V2 boundary, retain the exact
    // session/event recovery token. Abort is safe only after receipt-backed
    // acknowledgement or when no admission was dispatched.
    if (!pendingAdmission) await abortSourceSession();
    throw failure;
  }
}

export const reconcileGmailInterviews = reconcileGmailRoleInterest;
