import {
  GMAIL_ROLE_INTEREST_SCOPE,
  SUBMISSIONS_V2_APPROVED_ACTIVATION_AT,
} from "../api/submissions-v2/_lib/email-source-policy.mjs";
import { collectRoleInterestWindow } from "../api/submissions-v2/_lib/gmail-interview-source.mjs";

const error = (code) => Object.assign(new Error(code), { code, retryable: true });

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

export async function reconcileGmailRoleInterest({ env, fetchImpl = fetch, signal, checkpoint = {}, assertCurrent, admit, maxThreads = 12, now = Date.now(), sleepImpl = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
  const activationAt = approvedGmailActivation(env);
  const range = gmailWindow(checkpoint, { activationAt, now });
  // A retry can land inside the deliberate two-minute live lag.  It has no
  // new safe window to read, but it must not erase a previously confirmed
  // live lane and thereby pause the independent historical catch-up lane.
  if (!range) return {
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
  const request = async (input) => {
    if (readCount++) await sleepImpl(1000);
    signal?.throwIfAborted();
    const response = await fetchImpl("https://raydar-master-inbox.vercel.app/api/worker/submissions-gmail", {
      method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ ...range, scope: GMAIL_ROLE_INTEREST_SCOPE, ...input }), signal: AbortSignal.any([signal || new AbortController().signal, AbortSignal.timeout(45_000)]), redirect: "error",
    });
    const body = await response.json().catch(() => null);
    if (!response.ok || body?.ok !== true) throw error(/^[-_a-z0-9]{1,100}$/u.test(body?.error || "") ? body.error : "gmail_read_broker_failed");
    if (body?.result?.brokerScope !== GMAIL_ROLE_INTEREST_SCOPE) throw error("gmail_broker_scope_mismatch");
    return body.result;
  };
  const client = {
    list: ({ pageToken, scope }) => request({ operation: "list", scope, pageToken }),
    thread: (threadId) => request({ operation: "thread", scope: GMAIL_ROLE_INTEREST_SCOPE, threadId }),
  };
  let events;
  try { events = await collectRoleInterestWindow({
    ...range,
    client,
    env,
    assertCurrent,
    maxThreads: Math.max(1, Math.min(12, Number(maxThreads) || 12)),
  }); }
  catch (failure) {
    if (failure.code !== "gmail_window_too_large") throw failure;
    const through = Number(checkpoint.through ?? Date.parse(activationAt));
    const span = range.before - through;
    if (span <= 30_000) throw failure;
    return { checkpoint: { ...checkpoint, through, window_span_ms: Math.max(30_000, Math.floor(span / 2)) }, completed: false, narrowed: true, accepted: 0 };
  }
  let accepted = 0;
  for (const event of events) {
    await assertCurrent();
    const result = await admit(event);
    if (result?.accepted !== true) throw error("gmail_intake_not_acknowledged");
    accepted += result.existing || result.processing_state === "ignored_later" ? 0 : 1;
  }
  return {
    checkpoint: { through: range.before, window_span_ms: Math.min(3_600_000, (range.before - range.after) * 2) },
    completed: true,
    caught_up: range.before >= now - 120_000,
    accepted,
    observed: events.length,
    threads_read: Number(events.threads_read) || 0,
  };
}

export const reconcileGmailInterviews = reconcileGmailRoleInterest;
