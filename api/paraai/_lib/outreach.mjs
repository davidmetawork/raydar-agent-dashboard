import {
  normalizeEmail,
  notifySlack,
  trpcGet,
  trpcPost,
} from "./core.mjs";
import {
  additionalMatchCopy,
  followupCopy,
  initialMatchCopy,
  initialSubject,
  roleShareUrl,
} from "./outreach-copy.mjs";
import {
  canonicalAddress,
  candidateRepliedAfter,
  createReviewDraft,
  deliverMessage,
  deterministicMessageId,
  findDigestThread,
  firstDeliveredInternalDate,
  getSignatureHtml,
  getThread,
  gmailConfigured,
  hardBounceAfter,
  inboundMessagesAfter,
  outreachMailbox,
  probeGmail,
  threadDigestAnchorStatus,
  threadReplyContext,
} from "./outreach-gmail.mjs";
import {
  activeOffMarketHold,
  classifyInboundIntent,
  intentGateDisabled,
  intentMessagesFromThread,
  INTENT_DO_NOT_CONTACT,
  INTENT_OFF_MARKET,
  INTENT_OPEN,
  lapsedOffMarketHold,
  newestInternalDate,
  offMarketHold,
  OFF_MARKET_HOLD_DAYS,
} from "./outreach-intent.mjs";
import { discoverCandidateContact } from "./outreach-contact.mjs";
import { protectedRecruiterForRoleTitle } from "../../seq/_lib/protected.mjs";
import {
  acquireOutreachLock,
  acquireOutreachPollSlot,
  appendOutreachJournal,
  claimOutreachExceptionAlert,
  createOutreachState,
  getOutreachState,
  listOutreachExceptions,
  listOutreachStates,
  probeOutreachStore,
  recordOutreachException,
  releaseOutreachLock,
  releaseOutreachExceptionAlert,
  releaseOutreachPollSlot,
  resolveOutreachException,
  saveOutreachState,
  storeConfigured,
} from "./outreach-store.mjs";

const TWO_DAYS_MS = 2 * 24 * 60 * 60 * 1000;
const EXCEPTION_RETRY_MS = 5 * 60 * 1000;
// Exception codes that a later tick may legitimately retry on its own. A bounced
// address behaves exactly like a missing one: the moment David fixes it in
// Paraform the request becomes sendable again, so it self-heals.
const RECOVERABLE_EXCEPTION_CODES = new Set(["OUTREACH_NO_EMAIL", "OUTREACH_EMAIL_BOUNCED"]);
// Codes that park a request for a human and must never re-enter the tick on
// their own. OUTREACH_CANDIDATE_REPLIED is the retired 2026-07-26 code, kept here
// so pre-existing held records stay parked until the release action re-judges
// them under the intent rule.
const HUMAN_HELD_EXCEPTION_CODES = new Set([
  "OUTREACH_CANDIDATE_REPLIED",
  "OUTREACH_CANDIDATE_OFF_MARKET",
  "OUTREACH_CANDIDATE_DO_NOT_CONTACT",
]);
const REQUEST_STATUSES = new Set(["pending"]);
const clean = (value) => String(value || "").trim();
const lower = (value) => clean(value).toLowerCase();

const bool = (value, fallback = false) => {
  if (value == null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
};

const finiteDate = (value) => {
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : null;
};

export function outreachConfig(env = process.env) {
  const notBeforeMs = finiteDate(env.PARAAI_OUTREACH_NOT_BEFORE);
  return {
    approved: bool(env.PARAAI_OUTREACH_APPROVED),
    dryRun: !("PARAAI_OUTREACH_DRY_RUN" in env) || bool(env.PARAAI_OUTREACH_DRY_RUN, true),
    sendApproved: bool(env.PARAAI_OUTREACH_SEND_APPROVED),
    notBeforeMs,
    mailbox: outreachMailbox(env),
    gmailConfigured: gmailConfigured(env),
    storeConfigured: storeConfigured(),
    batchSize: Math.max(1, Math.min(10, Number(env.PARAAI_OUTREACH_BATCH || 3))),
    pollLockSeconds: Math.max(15, Math.min(300, Number(env.PARAAI_OUTREACH_POLL_SECONDS || 45))),
  };
}
// INCIDENT 2026-07-20 — during triage of the Kyra "Corporate Counsel" outreach
// incident this was set true as a precautionary full halt. Root cause was the
// LinkedIn-cohort Paraform SEQUENCE, not this Para AI outreach path (which is
// recruiter-scoped to David and never touched Kyra's candidates), so David
// authorized lifting the halt. Kept as a documented one-flip kill switch: set
// true to instantly close every outreach send path (tick/send-request/backfill).
export const OUTREACH_INCIDENT_HALT = false;

export function outreachExecutionEnabled(config = outreachConfig()) {
  if (OUTREACH_INCIDENT_HALT) return false;
  return Boolean(
    config.approved &&
    config.sendApproved &&
    config.dryRun === false &&
    config.notBeforeMs != null &&
    config.gmailConfigured &&
    config.storeConfigured,
  );
}

export function normalizeSubmissionRequest(request) {
  const candidate = request?.candidate || {};
  const role = request?.role || {};
  return {
    id: clean(request?.id),
    status: lower(request?.status),
    reachedOut: request?.reached_out_to_candidate === true,
    createdAt: clean(request?.created_at),
    createdAtMs: finiteDate(request?.created_at),
    candidateId: clean(candidate?.id || request?.candidate_id),
    candidateUserId: clean(candidate?.candidate_user_id || request?.candidate_user_id),
    candidateName: clean(candidate?.name || request?.candidate_name),
    roleId: clean(role?.id || request?.role_id),
    roleName: clean(role?.name || request?.role_name),
    companyName: clean(role?.company?.name || request?.company_name),
  };
}

export function expiredNoDigestOverrideEligible(request) {
  return lower(request?.status) === "expired";
}

export function normalizeExternalDeliveryEvidence(evidence, now = Date.now()) {
  const gmailMessageId = clean(evidence?.gmailMessageId);
  const threadId = clean(evidence?.threadId);
  const sentAtMs = finiteDate(evidence?.sentAt);
  const validGmailId = (value) => /^[a-f0-9]{16,32}$/i.test(value);
  if (!validGmailId(gmailMessageId) || !validGmailId(threadId)) {
    const error = new Error("exact Gmail message and thread IDs are required");
    error.code = "OUTREACH_EXTERNAL_DELIVERY_INVALID";
    throw error;
  }
  if (
    sentAtMs == null ||
    sentAtMs > now + 5 * 60_000 ||
    sentAtMs < now - 24 * 60 * 60_000
  ) {
    const error = new Error("external delivery time must be within the last 24 hours");
    error.code = "OUTREACH_EXTERNAL_DELIVERY_INVALID";
    throw error;
  }
  return {
    gmailMessageId,
    threadId,
    sentAt: new Date(sentAtMs).toISOString(),
  };
}

export async function readSubmissionRequestHistory() {
  const result = await trpcGet("submissionRequest.getRecruiterSubmissionRequestHistory", {
    agencyView: false,
    recruiterFilter: [],
  });
  const rows = Array.isArray(result) ? result : (result?.requests || []);
  return rows.map(normalizeSubmissionRequest).filter(
    (request) => request.id && request.candidateUserId && request.roleId,
  );
}

export function requestOrdinal(request, history) {
  const rows = (history || [])
    .filter((row) => row.candidateUserId === request.candidateUserId)
    .sort((left, right) => (
      (left.createdAtMs ?? Number.MAX_SAFE_INTEGER) - (right.createdAtMs ?? Number.MAX_SAFE_INTEGER)
      || left.id.localeCompare(right.id)
    ));
  const index = rows.findIndex((row) => row.id === request.id);
  return index >= 0 ? index + 1 : rows.length + 1;
}

export function eligibleNewRequests(
  history,
  config = outreachConfig(),
  states = [],
  exceptions = [],
) {
  const delivered = new Set();
  for (const state of states || []) {
    for (const [requestId, record] of Object.entries(state?.matches || {})) {
      if (record?.sentAt) delivered.add(requestId);
    }
  }
  const retryAuthorized = new Set(
    (exceptions || [])
      .filter((row) => (
        row?.status === "open" &&
        // Only a recoverable exception may re-enter the queue. A missing email
        // becomes sendable the moment David adds it; a candidate-replied hold
        // never does.
        RECOVERABLE_EXCEPTION_CODES.has(clean(row?.code)) &&
        (
          finiteDate(row?.lastSeenAt) == null ||
          finiteDate(row?.lastSeenAt) <= Date.now() - EXCEPTION_RETRY_MS
        )
      ))
      .map((row) => clean(row?.requestId))
      .filter(Boolean),
  );
  // An off-market hold is a human decision, not a transient failure. Without this
  // the request stays pending and unreached forever, so every tick would
  // re-process it, re-throw, and burn a batch slot — starving real work.
  const humanHeld = new Set(
    (exceptions || [])
      .filter((row) => (
        row?.status === "open" &&
        HUMAN_HELD_EXCEPTION_CODES.has(clean(row?.code))
      ))
      .map((row) => clean(row?.requestId))
      .filter(Boolean),
  );
  return (history || []).filter((request) => (
    REQUEST_STATUSES.has(request.status) &&
    // GUARDRAIL: never outreach a protected recruiter's role (e.g. Kyra's).
    !protectedRecruiterForRoleTitle(request.roleName) &&
    !humanHeld.has(request.id) &&
    (
      retryAuthorized.has(request.id) ||
      (
        request.reachedOut !== true &&
        request.createdAtMs != null &&
        request.createdAtMs >= config.notBeforeMs
      )
    ) &&
    !delivered.has(request.id)
  )).sort((left, right) => left.createdAtMs - right.createdAtMs || left.id.localeCompare(right.id));
}

export function pendingBackfillRequests(history, states = []) {
  const delivered = new Set();
  for (const state of states || []) {
    for (const [requestId, record] of Object.entries(state?.matches || {})) {
      if (record?.sentAt) delivered.add(requestId);
    }
  }
  return (history || []).filter((request) => (
    REQUEST_STATUSES.has(request.status) &&
    // GUARDRAIL: never backfill outreach for a protected recruiter's role.
    !protectedRecruiterForRoleTitle(request.roleName) &&
    !delivered.has(request.id)
  )).sort((left, right) => (
    (left.createdAtMs ?? Number.MAX_SAFE_INTEGER) -
      (right.createdAtMs ?? Number.MAX_SAFE_INTEGER)
    || left.id.localeCompare(right.id)
  ));
}

function displayName(name) {
  return clean(name).replace(/^[^\p{L}\p{N}]+/u, "").trim();
}

function firstName(name) {
  return displayName(name).split(/\s+/)[0] || "there";
}

async function candidateContact(request, config) {
  const rows = await trpcGet("candidateUser.getCandidateUsersByIds", {
    candidate_user_ids: [request.candidateUserId],
  });
  const record = (Array.isArray(rows) ? rows : [rows]).find(
    (row) => clean(row?.id) === clean(request.candidateUserId),
  ) || (Array.isArray(rows) ? rows[0] : rows);
  const emails = Array.isArray(record?.emails) ? record.emails : [record?.email];
  const email = emails.map(normalizeEmail).find(Boolean) || "";
  const name = displayName(record?.name || record?.candidate?.name || request.candidateName);
  if (email) {
    return {
      name,
      email,
      source: "paraform",
      discovery: null,
    };
  }
  const discovery = await discoverCandidateContact({
    candidateName: name,
    mailbox: config.mailbox,
  });
  if (discovery.email) {
    return {
      name,
      email: discovery.email,
      source: discovery.confidence,
      discovery,
    };
  }
  if (!email) {
    const error = new Error("candidate has no deliverable email");
    error.code = "OUTREACH_NO_EMAIL";
    error.discovery = discovery;
    throw error;
  }
}

export async function ensureMatchDigest(request) {
  let digest = await trpcGet("matchDigest.getDigestForCandidate", {
    candidateUserId: request.candidateUserId,
  });
  const visible = () => (digest?.roles || []).some(
    (role) => clean(role?.roleId) === request.roleId,
  );
  if (!visible()) {
    await trpcPost("matchDigest.createOrAddRoles", {
      candidateUserId: request.candidateUserId,
      submissionRequestIds: [request.id],
    }, 1);
    digest = await trpcGet("matchDigest.getDigestForCandidate", {
      candidateUserId: request.candidateUserId,
    });
  }
  if (!digest?.digestId || !visible()) {
    const error = new Error("match digest write did not read back");
    error.code = "OUTREACH_DIGEST_NOT_VISIBLE";
    throw error;
  }
  return {
    digestId: digest.digestId,
    digestUrl: `https://www.paraform.com/digest/${digest.digestId}`,
    roles: digest.roles || [],
  };
}

function copyForMatch({ request, ordinal, contact, digest, roleUrl }) {
  const input = {
    firstName: firstName(contact.name || request.candidateName),
    roleName: request.roleName,
    companyName: request.companyName,
    roleUrl,
    digestUrl: digest?.digestUrl || null,
  };
  return ordinal === 1
    ? initialMatchCopy(input)
    : additionalMatchCopy({
        ...input,
        ordinal,
        variationSeed: request.id,
      });
}

async function threadForMatch({ state, request, mailbox, digestUrl }) {
  // The explicitly confirmed expired-request override has no Paraform digest.
  // It must start a standalone Gmail conversation, never attach itself to some
  // older outreach thread just because the candidate is the same.
  if (!clean(digestUrl)) {
    return { thread: null, context: null, anchorStatus: "none" };
  }
  if (state?.threadId) {
    try {
      const thread = await getThread(mailbox, state.threadId);
      const anchorStatus = threadDigestAnchorStatus(thread, digestUrl);
      if (anchorStatus === "delivered") {
        const context = threadReplyContext(thread);
        if (context) return { thread, context, anchorStatus };
      }
      if (anchorStatus === "draft") {
        return { thread, context: null, anchorStatus };
      }
    } catch {
      // A stale state thread must not prevent exact digest-anchor discovery.
    }
  }
  const found = await findDigestThread(mailbox, state?.candidateEmail, digestUrl);
  if (found?.context) {
    return {
      thread: found.thread,
      context: found.context,
      anchorStatus: "delivered",
    };
  }
  return { thread: null, context: null, anchorStatus: "none" };
}

function messageForMatch({
  mailbox,
  request,
  ordinal,
  copy,
  context,
  draftThreadId,
  signatureHtml,
}) {
  const actionKey = `match:${request.id}`;
  return {
    actionKey,
    from: `David Phillips <${mailbox}>`,
    to: request.candidateEmail,
    subject: context?.replySubject || initialSubject(request.companyName),
    messageId: deterministicMessageId(actionKey),
    ...(context ? {
      threadId: context.threadId,
      inReplyTo: context.inReplyTo,
      references: context.references,
    } : draftThreadId ? { threadId: draftThreadId } : {}),
    bodyText: copy.text,
    bodyHtml: ordinal === 1
      ? `${copy.html}<br>\n${signatureHtml || ""}`
      : copy.html,
  };
}

function matchRecord({
  request,
  ordinal,
  roleUrl,
  digest,
  copy,
  sent,
  sentAt,
  deliveryMode,
}) {
  return {
    requestId: request.id,
    ordinal,
    roleId: request.roleId,
    roleName: request.roleName,
    companyName: request.companyName,
    roleUrl,
    digestId: digest?.digestId || null,
    digestOmitted: !digest?.digestId,
    deliveryMode,
    sentAt,
    gmailMessageId: sent?.id || null,
    copyVariant: copy.variant,
  };
}

export function planDeliveredMatch(state, {
  request,
  ordinal,
  roleUrl,
  digest,
  copy,
  sent,
  sentAt,
  messageId,
  deliveryMode = "digest",
}) {
  const previousFollowup = state.followup;
  const remaining = ordinal === 1 ? 2 : 1;
  const next = {
    ...state,
    threadId: sent?.threadId || state.threadId || null,
    threadSubject: state.threadSubject || copy.subject || null,
    ...(digest?.digestId ? {
      digestId: digest.digestId,
      digestUrl: digest.digestUrl,
    } : {}),
    latestMatchId: request.id,
    lastOutboundAt: sentAt,
    // Written once: the conversation anchor the reply window is measured from.
    firstOutboundAt: state.firstOutboundAt || sentAt,
    matches: {
      ...(state.matches || {}),
      [request.id]: matchRecord({
        request, ordinal, roleUrl, digest, copy, sent, sentAt, deliveryMode,
      }),
    },
    outbox: {
      ...(state.outbox || {}),
      [`match:${request.id}`]: {
        ...(state.outbox?.[`match:${request.id}`] || {}),
        status: "delivered",
        messageId,
        gmailMessageId: sent?.id || null,
        threadId: sent?.threadId || state.threadId || null,
        deliveredAt: sentAt,
        deliveryMode,
      },
    },
    // A candidate who has already replied never gets a re-armed nudge ladder,
    // even when an operator explicitly overrides the send for a new role.
    followup: (state.repliedAt || state.stoppedReason) ? null : {
      ownerMatchId: request.id,
      ordinal,
      number: 1,
      remaining,
      dueAt: new Date(Date.parse(sentAt) + TWO_DAYS_MS).toISOString(),
      roleId: request.roleId,
      roleName: request.roleName,
      companyName: request.companyName,
      roleUrl,
    },
  };
  return appendOutreachJournal(next, "match_delivered", {
    requestId: request.id,
    ordinal,
    deliveryMode,
    ...(previousFollowup ? {
      supersededFollowupFor: previousFollowup.ownerMatchId,
    } : {}),
  });
}

async function markReachedOut(requestId) {
  await trpcPost("submissionRequest.markReachedOutToCandidate", { id: requestId }, 1);
  const history = await readSubmissionRequestHistory();
  const visible = history.find((request) => request.id === requestId);
  if (!visible?.reachedOut) {
    const error = new Error("Paraform reached-out marker did not read back");
    error.code = "OUTREACH_REACHED_OUT_NOT_VISIBLE";
    throw error;
  }
  return visible;
}

async function saveUncertainOutbox(state, actionKey, messageId, error) {
  const uncertain = appendOutreachJournal({
    ...state,
    outbox: {
      ...(state.outbox || {}),
      [actionKey]: {
        ...(state.outbox?.[actionKey] || {}),
        status: "uncertain",
        messageId,
        errorCode: clean(error?.code || "GMAIL_SEND_UNKNOWN"),
        uncertainAt: new Date().toISOString(),
      },
    },
  }, "gmail_delivery_uncertain", { actionKey });
  return saveOutreachState(uncertain, state.revision).catch(() => uncertain);
}

// Read a candidate's conversation and decide what it authorizes, WITHOUT writing
// anything. The send path and the held-backlog review share this so a reported
// verdict and an acted-on verdict can never disagree.
export async function assessOutreachThread({
  state,
  config = outreachConfig(),
  threadImpl = getThread,
  classifyImpl = classifyInboundIntent,
} = {}) {
  if (!state?.threadId) return { checked: false };
  const thread = await threadImpl(config.mailbox, state.threadId).catch(() => null);
  if (!thread) return { checked: false };
  const anchor = finiteDate(state.firstOutboundAt)
    ?? firstDeliveredInternalDate(thread)
    ?? 0;
  const bounce = hardBounceAfter(thread, anchor);
  const inbound = inboundMessagesAfter(thread, config.mailbox, anchor);
  const newestInboundMs = newestInternalDate(inbound);
  const result = {
    checked: true,
    replied: inbound.length > 0,
    bounce,
    newestInboundMs,
    verdict: null,
    intent: null,
    hold: null,
  };
  // An undeliverable address settles the question before intent matters.
  if (bounce || !inbound.length) return result;
  // Never re-judge messages already judged: same answer, no repeat model spend.
  if (Number(state.intentCheckedThrough || 0) >= newestInboundMs) {
    result.verdict = state.intentVerdict || null;
    result.hold = activeOffMarketHold(state);
    result.cached = true;
    return result;
  }
  const intent = await classifyImpl(intentMessagesFromThread(inbound));
  result.intent = intent;
  result.verdict = intent.verdict;
  result.hold = offMarketHold({
    verdict: intent.verdict,
    // Anchor the six months at what the candidate SAID, not at when we read it,
    // so an old decline surfaced late does not restart the clock.
    detectedAt: new Date(newestInboundMs || Date.now()).toISOString(),
    reason: intent.reason,
    source: intent.source,
    model: intent.model || null,
  });
  return result;
}

// Turn an assessment into the exact state change it justifies. Shared by the send
// path and the backlog review so that what David is shown and what the worker
// later acts on are produced by one piece of code.
export function assessmentPatch(assessment, {
  requestId = null,
  address = null,
  repliedAt = null,
  stoppedReason = null,
} = {}) {
  if (!assessment?.checked) return { patch: {}, event: null };
  const patch = {};
  let event = "intent_checked";
  if (assessment.replied) {
    // Written whenever anyone wrote back: this is what keeps a previously engaged
    // candidate off the nudge ladder even when the new role is cleared to send.
    // An existing timestamp is never overwritten — the first reply is the anchor.
    patch.repliedAt = repliedAt || new Date().toISOString();
    patch.stoppedReason = stoppedReason || "candidate_replied";
    patch.followup = null;
    event = "reply_cleared_for_new_role";
  }
  if (assessment.newestInboundMs) {
    patch.intentCheckedThrough = assessment.newestInboundMs;
    patch.intentVerdict = assessment.verdict;
  }
  if (assessment.bounce) {
    patch.bounce = {
      ...assessment.bounce,
      address: address || null,
      detectedAt: new Date().toISOString(),
    };
    event = "match_blocked_on_bounce";
  } else if (assessment.hold) {
    patch.offMarket = { ...assessment.hold, requestId };
    event = "match_blocked_off_market";
  }
  return { patch, event };
}

export function assessmentBlockCode(assessment) {
  if (assessment?.bounce) return "OUTREACH_EMAIL_BOUNCED";
  if (assessment?.hold?.verdict === INTENT_DO_NOT_CONTACT) {
    return "OUTREACH_CANDIDATE_DO_NOT_CONTACT";
  }
  if (assessment?.hold?.verdict === INTENT_OFF_MARKET) return "OUTREACH_CANDIDATE_OFF_MARKET";
  return null;
}

export async function processMatchRequest(
  request,
  history,
  {
    mode = "send",
    config = outreachConfig(),
    allowAfterReply = false,
    allowWithoutDigest = false,
  } = {},
) {
  // INCIDENT 2026-07-20 defense-in-depth: refuse any live candidate send while
  // the outreach halt is active, regardless of caller. Drafts remain allowed.
  if (mode === "send" && OUTREACH_INCIDENT_HALT) {
    const error = new Error("Para AI outreach sending is halted (2026-07-20 Kyra incident)");
    error.code = "OUTREACH_HALTED";
    throw error;
  }
  if (allowWithoutDigest && (mode !== "send" || !expiredNoDigestOverrideEligible(request))) {
    const error = new Error("no-digest delivery is restricted to an expired live request");
    error.code = "OUTREACH_REQUEST_NOT_EXPIRED";
    throw error;
  }
  const lockToken = await acquireOutreachLock(request.candidateUserId);
  if (!lockToken) {
    const error = new Error("candidate outreach is already being processed");
    error.code = "OUTREACH_BUSY";
    throw error;
  }
  try {
    const contact = await candidateContact(request, config);
    await resolveOutreachException(request.id, {
      resolution: contact.source,
    }).catch(() => {});
    let state = await getOutreachState(request.candidateUserId);
    if (!state) {
      state = await createOutreachState(request.candidateUserId, {
        candidateName: contact.name || request.candidateName,
        candidateEmail: contact.email,
        candidateEmailSource: contact.source,
      });
    }
    state = {
      ...state,
      candidateName: contact.name || request.candidateName,
      candidateEmail: contact.email,
      candidateEmailSource: contact.source,
    };
    const existingMatch = state.matches?.[request.id];
    if (existingMatch?.sentAt) return { action: "existing", state, request, match: existingMatch };

    // INCIDENT 2026-07-26 → REVISED 2026-07-28. The 07-26 fix made ANY inbound
    // message a permanent block on every future match. It was right about nudges
    // and wrong about new roles: a candidate who wrote "not this one, thanks" is
    // exactly who a brand-new role should reach. A reply still kills the nudge
    // ladder (see planDeliveredMatch), but the SEND is blocked only by an explicit
    // off-market statement, an explicit stop-contacting request, or a hard bounce.
    // PARAAI_OUTREACH_INTENT_DISABLED restores the 07-26 block-on-any-reply rule.
    const blockFor = (code, message, detail = null) => {
      const error = new Error(message);
      error.code = code;
      error.candidateName = state.candidateName;
      error.detail = detail;
      return error;
    };
    const legacyReplyGate = intentGateDisabled();
    const gated = mode === "send" && !allowAfterReply;

    // A bounce recorded against an address we no longer use is stale: the whole
    // point of surfacing it was to get the address fixed in Paraform.
    if (state.bounce && contact.email && state.bounce.address &&
        canonicalAddress(state.bounce.address) !== canonicalAddress(contact.email)) {
      state = await saveOutreachState(appendOutreachJournal({
        ...state,
        bounce: null,
      }, "bounce_cleared_on_new_address", { requestId: request.id }), state.revision)
        .catch(() => ({ ...state, bounce: null }));
    }

    if (gated) {
      const hold = activeOffMarketHold(state);
      if (hold) {
        throw blockFor(
          hold.verdict === INTENT_DO_NOT_CONTACT
            ? "OUTREACH_CANDIDATE_DO_NOT_CONTACT"
            : "OUTREACH_CANDIDATE_OFF_MARKET",
          "candidate is on an outreach hold; automatic match send is blocked",
          hold,
        );
      }
      if (state.bounce) {
        throw blockFor(
          "OUTREACH_EMAIL_BOUNCED",
          "candidate email hard-bounced; automatic match send is blocked",
          state.bounce,
        );
      }
      if (legacyReplyGate && (state.repliedAt || state.stoppedReason)) {
        throw blockFor(
          "OUTREACH_CANDIDATE_REPLIED",
          "candidate has replied; automatic match send is blocked (intent gate disabled)",
        );
      }
      // A six-month hold that has run out resumes sending — but never silently.
      const lapsed = lapsedOffMarketHold(state);
      if (lapsed) {
        state = await saveOutreachState(appendOutreachJournal({
          ...state,
          offMarket: { ...lapsed, lapseNotifiedAt: new Date().toISOString() },
        }, "off_market_hold_lapsed", { requestId: request.id }), state.revision)
          .catch(() => state);
        await notifySlack(
          `⏰ Para AI outreach: ${displayName(state.candidateName) || "a candidate"}'s off-market hold has lapsed after ${OFF_MARKET_HOLD_DAYS} days. New roles auto-send again, starting with ${clean(request.roleName) || "this role"} @ ${clean(request.companyName) || "this company"}.`,
        ).catch(() => false);
      }
    }

    // Live thread read. Candidates who replied BEFORE any of this shipped carry no
    // stored flag — their ladder had already finished, so the follow-up gate will
    // never run again to record one. Reading the thread here is what makes the
    // guard real for exactly the people it most needs to protect.
    if (gated && state.threadId) {
      const assessment = await assessOutreachThread({ state, config });
      if (assessment.checked) {
        const { patch, event } = assessmentPatch(assessment, {
          requestId: request.id,
          address: state.candidateEmail || contact.email || null,
          repliedAt: state.repliedAt,
          stoppedReason: state.stoppedReason,
        });
        if (Object.keys(patch).length) {
          state = await saveOutreachState(
            appendOutreachJournal({ ...state, ...patch }, event, {
              requestId: request.id,
              verdict: assessment.verdict || null,
              intentSource: assessment.intent?.source || null,
            }),
            state.revision,
          ).catch(() => ({ ...state, ...patch }));
        }
        const blockCode = assessmentBlockCode(assessment);
        if (blockCode) {
          throw blockFor(
            blockCode,
            blockCode === "OUTREACH_EMAIL_BOUNCED"
              ? "candidate email hard-bounced; automatic match send is blocked"
              : "candidate is on an outreach hold; automatic match send is blocked",
            assessment.bounce ? patch.bounce : assessment.hold,
          );
        }
        if (assessment.replied && legacyReplyGate) {
          throw blockFor(
            "OUTREACH_CANDIDATE_REPLIED",
            "candidate has replied; automatic match send is blocked (intent gate disabled)",
          );
        }
      }
    }

    const ordinal = requestOrdinal(request, history);
    const digest = allowWithoutDigest ? null : await ensureMatchDigest(request);
    const deliveryMode = allowWithoutDigest ? "expired_without_digest" : "digest";
    const roleUrl = roleShareUrl(request);
    request = { ...request, candidateEmail: contact.email };
    const actionKey = `match:${request.id}`;
    const previousOutbox = state.outbox?.[actionKey] || {};
    const previousThreadId = state.threadId || null;
    const { context, anchorStatus } = await threadForMatch({
      state,
      request,
      mailbox: config.mailbox,
      digestUrl: digest?.digestUrl || null,
    });
    const replaceExistingDraft = Boolean(
      mode === "draft" &&
      previousOutbox.draftId &&
      anchorStatus === "none"
    );
    const copy = copyForMatch({ request, ordinal, contact, digest, roleUrl });
    const signatureHtml = ordinal === 1
      ? await getSignatureHtml(config.mailbox).catch(() => "")
      : "";
    const message = messageForMatch({
      mailbox: config.mailbox,
      request,
      ordinal,
      copy,
      context,
      draftThreadId: anchorStatus === "draft" ? previousThreadId : null,
      signatureHtml,
    });
    const anchoredThreadId = context?.threadId
      || (anchorStatus === "draft" ? previousThreadId : null);
    const claimed = appendOutreachJournal({
      ...state,
      ...(digest?.digestId ? {
        digestId: digest.digestId,
        digestUrl: digest.digestUrl,
      } : {}),
      threadId: anchoredThreadId,
      threadSubject: context?.originalSubject
        || (anchorStatus === "draft" ? state.threadSubject : message.subject),
      outbox: {
        ...(state.outbox || {}),
        [message.actionKey]: {
          ...previousOutbox,
          status: mode === "draft" ? "drafting" : "claimed",
          messageId: message.messageId,
          requestId: request.id,
          claimedAt: previousOutbox.claimedAt || new Date().toISOString(),
          deliveryMode,
        },
      },
    }, mode === "draft" ? "review_draft_claimed" : "gmail_delivery_claimed", {
      requestId: request.id,
      ordinal,
      anchorStatus,
      deliveryMode,
    });
    state = await saveOutreachState(claimed, state.revision);

    if (mode === "draft") {
      const draft = await createReviewDraft({
        mailbox: config.mailbox,
        existingDraftId: previousOutbox.draftId || null,
        replaceExistingDraft,
        message,
      });
      const drafted = appendOutreachJournal({
        ...state,
        threadId: draft.threadId || anchoredThreadId,
        threadSubject: context?.originalSubject || message.subject,
        outbox: {
          ...(state.outbox || {}),
          [message.actionKey]: {
            ...state.outbox[message.actionKey],
            status: "drafted",
            draftId: draft.id,
            gmailDraftMessageId: draft.messageId,
            gmailDraftRfc822MessageId: draft.rfc822MessageId,
            threadId: context?.threadId || draft.threadId || null,
            draftedAt: new Date().toISOString(),
            copyVariant: copy.variant,
          },
        },
      }, "review_draft_created", {
        requestId: request.id,
        ordinal,
        anchorStatus,
        draftAction: draft.draftAction,
      });
      state = await saveOutreachState(drafted, state.revision);
      return {
        action: "drafted",
        request,
        ordinal,
        digest,
        roleUrl,
        copy,
        message,
        draft,
        state,
      };
    }

    let sent;
    try {
      sent = await deliverMessage({
        mailbox: config.mailbox,
        draftId: previousOutbox.draftId || null,
        draftRfc822MessageId: previousOutbox.gmailDraftRfc822MessageId || null,
        message,
      });
    } catch (error) {
      await saveUncertainOutbox(state, message.actionKey, message.messageId, error);
      throw error;
    }
    const sentAt = new Date().toISOString();
    state = await saveOutreachState(planDeliveredMatch(state, {
      request,
      ordinal,
      roleUrl,
      digest,
      copy,
      sent,
      sentAt,
      messageId: message.messageId,
      deliveryMode,
    }), state.revision);

    if (request.reachedOut) {
      state = await saveOutreachState(appendOutreachJournal({
        ...state,
        matches: {
          ...state.matches,
          [request.id]: {
            ...state.matches[request.id],
            reachedOutVerifiedAt: new Date().toISOString(),
          },
        },
      }, "paraform_reached_out_already_visible", { requestId: request.id }), state.revision);
    } else {
      try {
        await markReachedOut(request.id);
        state = await saveOutreachState(appendOutreachJournal({
          ...state,
          matches: {
            ...state.matches,
            [request.id]: {
              ...state.matches[request.id],
              reachedOutMarkedAt: new Date().toISOString(),
            },
          },
        }, "paraform_reached_out_verified", { requestId: request.id }), state.revision);
      } catch (error) {
        state = await saveOutreachState(appendOutreachJournal({
          ...state,
          reachedOutMarkPending: {
            requestId: request.id,
            errorCode: clean(error?.code || "REACHED_OUT_MARK_FAILED"),
          },
        }, "paraform_reached_out_pending", { requestId: request.id }), state.revision)
          .catch(() => state);
      }
    }
    return { action: "sent", request, ordinal, digest, roleUrl, copy, sent, state };
  } finally {
    await releaseOutreachLock(request.candidateUserId, lockToken).catch(() => {});
  }
}

export async function recordExpiredExternalDelivery(
  request,
  history,
  evidence,
  { config = outreachConfig() } = {},
) {
  if (!expiredNoDigestOverrideEligible(request)) {
    const error = new Error("external no-digest delivery is restricted to an expired request");
    error.code = "OUTREACH_REQUEST_NOT_EXPIRED";
    throw error;
  }
  const verified = normalizeExternalDeliveryEvidence(evidence);
  const lockToken = await acquireOutreachLock(request.candidateUserId);
  if (!lockToken) {
    const error = new Error("candidate outreach is already being processed");
    error.code = "OUTREACH_BUSY";
    throw error;
  }
  try {
    const contact = await candidateContact(request, config);
    let state = await getOutreachState(request.candidateUserId);
    if (!state) {
      state = await createOutreachState(request.candidateUserId, {
        candidateName: contact.name || request.candidateName,
        candidateEmail: contact.email,
        candidateEmailSource: contact.source,
      });
    }
    const existingMatch = state.matches?.[request.id];
    if (existingMatch?.sentAt) {
      if (
        existingMatch.gmailMessageId === verified.gmailMessageId &&
        state.threadId === verified.threadId
      ) {
        return { action: "existing", state, request, match: existingMatch };
      }
      const error = new Error("request already has a different delivered message");
      error.code = "OUTREACH_EXTERNAL_DELIVERY_CONFLICT";
      throw error;
    }
    const actionKey = `match:${request.id}`;
    if (state.outbox?.[actionKey]) {
      const error = new Error("request already has an outbox record");
      error.code = "OUTREACH_EXTERNAL_DELIVERY_CONFLICT";
      throw error;
    }

    const ordinal = requestOrdinal(request, history);
    const roleUrl = roleShareUrl(request);
    request = { ...request, candidateEmail: contact.email };
    const copy = copyForMatch({
      request,
      ordinal,
      contact,
      digest: null,
      roleUrl,
    });
    const messageId = deterministicMessageId(actionKey);
    let next = planDeliveredMatch({
      ...state,
      candidateName: contact.name || request.candidateName,
      candidateEmail: contact.email,
      candidateEmailSource: contact.source,
    }, {
      request,
      ordinal,
      roleUrl,
      digest: null,
      copy,
      sent: {
        id: verified.gmailMessageId,
        threadId: verified.threadId,
      },
      sentAt: verified.sentAt,
      messageId,
      deliveryMode: "expired_without_digest",
    });
    next = appendOutreachJournal({
      ...next,
      matches: {
        ...next.matches,
        [request.id]: {
          ...next.matches[request.id],
          deliverySource: "gmail_ui_verified",
          ...(request.reachedOut ? { reachedOutVerifiedAt: new Date().toISOString() } : {}),
        },
      },
      outbox: {
        ...next.outbox,
        [actionKey]: {
          ...next.outbox[actionKey],
          deliverySource: "gmail_ui_verified",
        },
      },
    }, "external_delivery_recorded", {
      requestId: request.id,
      deliveryMode: "expired_without_digest",
    });
    if (request.reachedOut) {
      next = appendOutreachJournal(
        next,
        "paraform_reached_out_already_visible",
        { requestId: request.id },
      );
    }
    state = await saveOutreachState(next, state.revision);
    await resolveOutreachException(request.id, {
      resolution: "external_delivery_recorded",
    }).catch(() => {});
    return { action: "recorded", state, request, ordinal, roleUrl, copy };
  } finally {
    await releaseOutreachLock(request.candidateUserId, lockToken).catch(() => {});
  }
}

export function planDeliveredFollowup(state, { sent, sentAt, messageId }) {
  const current = state.followup;
  if (!current) return state;
  const hasAnother = Number(current.remaining) > 1;
  const nextFollowup = hasAnother ? {
    ...current,
    number: Number(current.number) + 1,
    remaining: Number(current.remaining) - 1,
    dueAt: new Date(Date.parse(sentAt) + TWO_DAYS_MS).toISOString(),
  } : null;
  const actionKey = `followup:${current.ownerMatchId}:${current.number}`;
  return appendOutreachJournal({
    ...state,
    threadId: sent?.threadId || state.threadId,
    lastOutboundAt: sentAt,
    followup: nextFollowup,
    outbox: {
      ...(state.outbox || {}),
      [actionKey]: {
        ...(state.outbox?.[actionKey] || {}),
        status: "delivered",
        messageId,
        gmailMessageId: sent?.id || null,
        threadId: sent?.threadId || state.threadId || null,
        deliveredAt: sentAt,
      },
    },
  }, "followup_delivered", {
    ownerMatchId: current.ownerMatchId,
    followupNumber: current.number,
  });
}

export async function processDueFollowup(
  candidateUserId,
  {
    config = outreachConfig(),
    now = Date.now(),
  } = {},
) {
  // INCIDENT 2026-07-20 defense-in-depth: the halt must close this path on its
  // own, not only via runOutreachTick's gate.
  if (OUTREACH_INCIDENT_HALT) {
    const error = new Error("Para AI outreach sending is halted (2026-07-20 Kyra incident)");
    error.code = "OUTREACH_HALTED";
    throw error;
  }
  const lockToken = await acquireOutreachLock(candidateUserId);
  if (!lockToken) return { action: "busy" };
  try {
    let state = await getOutreachState(candidateUserId);
    const followup = state?.followup;
    if (!followup || finiteDate(followup.dueAt) > now) return { action: "not_due", state };
    // INCIDENT 2026-07-26: the stop is now STICKY. Once a reply has been seen it
    // is recorded durably and re-checked here before Gmail is even read, so no
    // later outbound can slide the window past it and un-see it.
    if (state.repliedAt || state.stoppedReason) {
      state = await saveOutreachState(appendOutreachJournal({
        ...state,
        followup: null,
      }, "followup_suppressed_after_reply", {
        ownerMatchId: followup.ownerMatchId,
        repliedAt: state.repliedAt || null,
      }), state.revision);
      return { action: "stopped_on_reply", state };
    }
    if (followup.ownerMatchId !== state.latestMatchId) {
      state = await saveOutreachState(appendOutreachJournal({
        ...state,
        followup: null,
      }, "stale_followup_canceled", {
        ownerMatchId: followup.ownerMatchId,
        latestMatchId: state.latestMatchId,
      }), state.revision);
      return { action: "canceled", state };
    }
    if (!state.threadId) {
      const error = new Error("follow-up has no Gmail thread");
      error.code = "OUTREACH_THREAD_NOT_FOUND";
      throw error;
    }
    const thread = await getThread(config.mailbox, state.threadId);
    // Anchor the reply window at the START of the conversation, not at our most
    // recent send. The old `lastOutboundAt` cutoff meant a reply became
    // permanently invisible the moment any outbound followed it.
    const replyWindowStart = finiteDate(state.firstOutboundAt)
      ?? firstDeliveredInternalDate(thread)
      ?? 0;
    if (candidateRepliedAfter(thread, config.mailbox, replyWindowStart)) {
      state = await saveOutreachState(appendOutreachJournal({
        ...state,
        followup: null,
        stoppedReason: "candidate_replied",
        repliedAt: new Date().toISOString(),
      }, "followups_stopped_on_reply", {
        ownerMatchId: followup.ownerMatchId,
      }), state.revision);
      return { action: "stopped_on_reply", state };
    }
    const context = threadReplyContext(thread);
    if (!context) {
      const error = new Error("Gmail thread has no reply context");
      error.code = "OUTREACH_THREAD_NOT_FOUND";
      throw error;
    }
    const copy = followupCopy({
      firstName: firstName(state.candidateName),
      roleName: followup.roleName,
      companyName: followup.companyName,
      roleUrl: followup.roleUrl,
      ordinal: followup.ordinal,
      followupNumber: followup.number,
      variationSeed: `${followup.ownerMatchId}:${followup.number}`,
    });
    const actionKey = `followup:${followup.ownerMatchId}:${followup.number}`;
    const message = {
      actionKey,
      from: `David Phillips <${config.mailbox}>`,
      to: state.candidateEmail,
      subject: context.replySubject,
      messageId: deterministicMessageId(actionKey),
      threadId: context.threadId,
      inReplyTo: context.inReplyTo,
      references: context.references,
      bodyText: copy.text,
      bodyHtml: copy.html,
    };
    const claimed = appendOutreachJournal({
      ...state,
      outbox: {
        ...(state.outbox || {}),
        [actionKey]: {
          ...(state.outbox?.[actionKey] || {}),
          status: "claimed",
          messageId: message.messageId,
          claimedAt: state.outbox?.[actionKey]?.claimedAt || new Date().toISOString(),
        },
      },
    }, "followup_claimed", {
      ownerMatchId: followup.ownerMatchId,
      followupNumber: followup.number,
    });
    state = await saveOutreachState(claimed, state.revision);
    let sent;
    try {
      sent = await deliverMessage({ mailbox: config.mailbox, message });
    } catch (error) {
      await saveUncertainOutbox(state, actionKey, message.messageId, error);
      throw error;
    }
    const sentAt = new Date().toISOString();
    state = await saveOutreachState(planDeliveredFollowup(state, {
      sent,
      sentAt,
      messageId: message.messageId,
    }), state.revision);
    return { action: "sent", copyVariant: copy.variant, state };
  } finally {
    await releaseOutreachLock(candidateUserId, lockToken).catch(() => {});
  }
}

function htmlEscape(value) {
  return String(value || "").replace(
    /[&<>"']/g,
    (character) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    })[character],
  );
}

export function missingEmailAlertCopy(request, discovery = {}) {
  const suggestions = Array.isArray(discovery?.suggestedEmails)
    ? discovery.suggestedEmails.filter(Boolean)
    : [];
  const suggestionText = suggestions.length
    ? `Google lookup found: ${suggestions.join(", ")}. This was not corroborated by both Gmail and Calendar, so no email was sent.`
    : "Gmail and Google Calendar did not produce one corroborated address.";
  const candidate = displayName(request?.candidateName) || "Unknown candidate";
  const role = clean(request?.roleName) || "Unknown role";
  const company = clean(request?.companyName) || "Unknown company";
  const lines = [
    `Para AI outreach is blocked for ${candidate}.`,
    `${role} @ ${company}`,
    suggestionText,
    "Add the correct email to the candidate's Paraform profile. The worker will retry automatically after the address is available.",
  ];
  return {
    subject: `Action needed: missing email for ${candidate}`,
    text: lines.join("\n\n"),
    html: lines
      .map((line) => `<div>${htmlEscape(line)}</div>`)
      .join("\n<div><br></div>\n"),
    slack: `🚨 Para AI outreach blocked: ${candidate} has no deliverable email for ${role} @ ${company}. ${suggestionText} Add the correct email in Paraform; the worker will retry automatically.`,
  };
}

const HELD_ALERT_CODES = new Set([
  "OUTREACH_CANDIDATE_REPLIED",
  "OUTREACH_CANDIDATE_OFF_MARKET",
  "OUTREACH_CANDIDATE_DO_NOT_CONTACT",
  "OUTREACH_EMAIL_BOUNCED",
]);

// Slack only carries the verdict and the role, never the candidate's own words.
export function heldAlertCopy(code, request, error = null) {
  const candidate = displayName(error?.candidateName || request?.candidateName) || "a candidate";
  const role = clean(request?.roleName) || "Unknown role";
  const company = clean(request?.companyName) || "Unknown company";
  const match = `${role} @ ${company}`;
  if (code === "OUTREACH_EMAIL_BOUNCED") {
    return `📮 Para AI outreach bounced: email to ${candidate} is undeliverable, so ${match} was NOT sent. Fix the address on their Paraform profile and the worker retries automatically.`;
  }
  if (code === "OUTREACH_CANDIDATE_DO_NOT_CONTACT") {
    return `🛑 Para AI outreach stopped: ${candidate} asked us to stop emailing, so ${match} was NOT sent — and no future role will be until you clear the hold.`;
  }
  if (code === "OUTREACH_CANDIDATE_OFF_MARKET") {
    const until = clean(error?.detail?.expiresAt).slice(0, 10);
    const window = until
      ? ` The hold lifts automatically on ${until}.`
      : ` The hold lifts automatically after ${OFF_MARKET_HOLD_DAYS} days.`;
    return `🛑 Para AI outreach held: ${candidate} said they are off the market, so ${match} was NOT sent.${window} Send it anyway from the Para AI tab if you disagree.`;
  }
  return `✋ Para AI outreach held: ${candidate} has already replied, so the ${match} match was NOT auto-sent. Review the thread and send manually if it still makes sense.`;
}

export async function handleOutreachFailure(
  error,
  request,
  {
    config = outreachConfig(),
  } = {},
) {
  const code = clean(error?.code || "OUTREACH_FAILED");
  if (!new Set([
    "AUTH_EXPIRED",
    "OUTREACH_NO_EMAIL",
    "OUTREACH_CANDIDATE_REPLIED",
    "OUTREACH_CANDIDATE_OFF_MARKET",
    "OUTREACH_CANDIDATE_DO_NOT_CONTACT",
    "OUTREACH_EMAIL_BOUNCED",
    "OUTREACH_THREAD_NOT_FOUND",
    "OUTREACH_DIGEST_NOT_VISIBLE",
    "GMAIL_SEND_UNKNOWN",
    "GMAIL_AUTH_FAILED",
  ]).has(code)) return;
  // A blocked match is a human decision, not a system fault: record it durably and
  // alert once, exactly like the missing-email path. Never silent.
  if (HELD_ALERT_CODES.has(code) && request?.id) {
    const record = await recordOutreachException({ request, code, discovery: null });
    const alertClaimed = await claimOutreachExceptionAlert(request.id).catch(() => false);
    if (!alertClaimed) return record;
    await notifySlack(heldAlertCopy(code, request, error)).catch(() => false);
    return record;
  }
  if (code === "OUTREACH_NO_EMAIL" && request?.id) {
    const record = await recordOutreachException({
      request,
      code,
      discovery: error?.discovery || null,
    });
    const alertClaimed = await claimOutreachExceptionAlert(request.id).catch(() => false);
    if (!alertClaimed) return record;
    const copy = missingEmailAlertCopy(request, error?.discovery);
    let notified = await notifySlack(copy.slack).catch(() => false);
    if (!notified) {
      const day = new Date().toISOString().slice(0, 10);
      const actionKey = `missing-email-alert:${request.id}:${day}`;
      notified = Boolean(await deliverMessage({
        mailbox: config.mailbox,
        message: {
          actionKey,
          from: `David Phillips <${config.mailbox}>`,
          to: config.mailbox,
          subject: copy.subject,
          messageId: deterministicMessageId(actionKey),
          bodyText: copy.text,
          bodyHtml: copy.html,
        },
      }).catch(() => null));
    }
    if (!notified) {
      await releaseOutreachExceptionAlert(request.id).catch(() => {});
    }
    return { ...record, notified };
  }
  await notifySlack(
    `🚨 Para AI outreach: ${code} for ${request?.id || "scheduled follow-up"}. No duplicate email will be attempted; review the outreach ledger.`,
  ).catch(() => {});
}

export async function runOutreachTick({
  config = outreachConfig(),
  now = Date.now(),
} = {}) {
  if (!outreachExecutionEnabled(config)) {
    return {
      enabled: false,
      processed: 0,
      reason: "outreach_gates_closed",
    };
  }
  const pollToken = await acquireOutreachPollSlot({ ttlSeconds: config.pollLockSeconds });
  if (!pollToken) return { enabled: true, processed: 0, reason: "poll_not_due" };
  try {
    const [history, states, exceptions] = await Promise.all([
      readSubmissionRequestHistory(),
      listOutreachStates(),
      listOutreachExceptions(),
    ]);
    const candidatesWithNewMatch = new Set();
    const results = [];
    for (const request of eligibleNewRequests(
      history,
      config,
      states,
      exceptions,
    ).slice(0, config.batchSize)) {
      candidatesWithNewMatch.add(request.candidateUserId);
      try {
        const result = await processMatchRequest(request, history, { mode: "send", config });
        results.push({ action: result.action, requestId: request.id });
      } catch (error) {
        await handleOutreachFailure(error, request, { config }).catch(() => {});
        results.push({ action: "error", requestId: request.id, code: clean(error?.code || "OUTREACH_FAILED") });
      }
    }

    const remaining = Math.max(0, config.batchSize - results.length);
    if (remaining > 0) {
      const refreshedStates = await listOutreachStates();
      const due = refreshedStates
        .filter((state) => (
          state?.followup &&
          finiteDate(state.followup.dueAt) <= now &&
          !candidatesWithNewMatch.has(state.candidateUserId)
        ))
        .sort((left, right) => finiteDate(left.followup.dueAt) - finiteDate(right.followup.dueAt))
        .slice(0, remaining);
      for (const state of due) {
        try {
          const result = await processDueFollowup(state.candidateUserId, { config, now });
          results.push({ action: result.action, followup: true });
        } catch (error) {
          await handleOutreachFailure(error, null, { config }).catch(() => {});
          results.push({ action: "error", followup: true, code: clean(error?.code || "OUTREACH_FAILED") });
        }
      }
    }
    return {
      enabled: true,
      processed: results.filter((result) => result.action === "sent").length,
      results,
    };
  } finally {
    await releaseOutreachPollSlot(pollToken).catch(() => {});
  }
}

// THE 2026-07-26 BACKLOG. Every request parked by the old block-on-any-reply rule
// is re-judged under the intent rule. This reports and latches verdicts; it never
// sends. releaseHeldOutreach does the sending, and only after this has run.
export async function reviewHeldOutreach({
  config = outreachConfig(),
  limit = 50,
  assessImpl = assessOutreachThread,
} = {}) {
  const [history, exceptions] = await Promise.all([
    readSubmissionRequestHistory(),
    listOutreachExceptions(500),
  ]);
  const held = (exceptions || [])
    .filter((row) => row?.status === "open" && HUMAN_HELD_EXCEPTION_CODES.has(clean(row?.code)))
    .slice(0, Math.max(1, Math.min(200, Number(limit) || 50)));
  const rows = [];
  for (const record of held) {
    const requestId = clean(record.requestId);
    const request = (history || []).find((row) => row.id === requestId) || null;
    const row = {
      requestId,
      candidateName: clean(record.candidateName || request?.candidateName),
      roleName: clean(record.roleName || request?.roleName),
      companyName: clean(record.companyName || request?.companyName),
      heldCode: clean(record.code),
      heldSince: clean(record.firstSeenAt) || null,
      verdict: null,
      reason: null,
      source: null,
      wouldSend: false,
      blockedBy: null,
    };
    if (!request) {
      // Withdrawn, filled, or already reached out elsewhere — nothing to release.
      row.blockedBy = "REQUEST_NO_LONGER_PENDING";
      rows.push(row);
      continue;
    }
    const candidateUserId = clean(record.candidateUserId || request.candidateUserId);
    const state = candidateUserId
      ? await getOutreachState(candidateUserId).catch(() => null)
      : null;
    if (!state?.threadId) {
      row.verdict = INTENT_OPEN;
      row.reason = "no candidate conversation on record";
      row.source = "no_thread";
      row.wouldSend = true;
      rows.push(row);
      continue;
    }
    let assessment;
    try {
      assessment = await assessImpl({ state, config });
    } catch (error) {
      row.blockedBy = clean(error?.code || "OUTREACH_ASSESS_FAILED");
      rows.push(row);
      continue;
    }
    row.verdict = assessment.verdict || INTENT_OPEN;
    row.reason = clean(assessment.intent?.reason) || null;
    row.source = clean(assessment.intent?.source) || (assessment.cached ? "cached" : null);
    row.blockedBy = assessmentBlockCode(assessment);
    row.wouldSend = !row.blockedBy;
    // Latch what we just learned so the send path agrees with this report.
    const { patch, event } = assessmentPatch(assessment, {
      requestId,
      address: state.candidateEmail || null,
      repliedAt: state.repliedAt,
      stoppedReason: state.stoppedReason,
    });
    if (Object.keys(patch).length) {
      await saveOutreachState(
        appendOutreachJournal({ ...state, ...patch }, event, {
          requestId,
          verdict: assessment.verdict || null,
          review: "held_backlog",
        }),
        state.revision,
      ).catch(() => null);
    }
    rows.push(row);
  }
  return {
    reviewed: rows.length,
    sendable: rows.filter((row) => row.wouldSend).length,
    held: rows.filter((row) => row.blockedBy).length,
    rows,
  };
}

export async function releaseHeldOutreach({
  config = outreachConfig(),
  limit = 5,
} = {}) {
  const review = await reviewHeldOutreach({ config, limit: 200 });
  const batch = review.rows
    .filter((row) => row.wouldSend)
    .slice(0, Math.max(1, Math.min(10, Number(limit) || 5)));
  const history = await readSubmissionRequestHistory();
  const results = [];
  for (const row of batch) {
    const request = history.find((item) => item.id === row.requestId);
    if (!request) {
      results.push({ ...row, action: "skipped", code: "REQUEST_NO_LONGER_PENDING" });
      continue;
    }
    try {
      // allowAfterReply stays FALSE on purpose: the normal gate runs, so an
      // off-market verdict recorded between review and release still blocks.
      const result = await processMatchRequest(request, history, { mode: "send", config });
      results.push({ ...row, action: result.action });
    } catch (error) {
      await handleOutreachFailure(error, request, { config }).catch(() => {});
      results.push({ ...row, action: "error", code: clean(error?.code || "OUTREACH_FAILED") });
    }
  }
  return {
    reviewed: review.reviewed,
    sendable: review.sendable,
    processed: results.filter((result) => result.action === "sent").length,
    remaining: Math.max(0, review.sendable - batch.length),
    results,
  };
}

export async function discoverOutreachRequestContact(
  requestId,
  {
    config = outreachConfig(),
  } = {},
) {
  const history = await readSubmissionRequestHistory();
  const request = history.find((row) => row.id === clean(requestId));
  if (!request) {
    const error = new Error("submission request not found");
    error.code = "OUTREACH_REQUEST_NOT_FOUND";
    throw error;
  }
  const discovery = await discoverCandidateContact({
    candidateName: displayName(request.candidateName),
    mailbox: config.mailbox,
  });
  return { request, discovery };
}

export async function draftOutreachRequest(requestId, {
  config = outreachConfig(),
} = {}) {
  if (!config.gmailConfigured || !config.storeConfigured) {
    const error = new Error("Gmail or outreach state store is not configured");
    error.code = "OUTREACH_NOT_CONFIGURED";
    throw error;
  }
  const history = await readSubmissionRequestHistory();
  const request = history.find((row) => row.id === clean(requestId));
  if (!request) {
    const error = new Error("submission request not found");
    error.code = "OUTREACH_REQUEST_NOT_FOUND";
    throw error;
  }
  return processMatchRequest(request, history, { mode: "draft", config });
}

export async function outreachHealth({
  config = outreachConfig(),
  probe = false,
} = {}) {
  const result = {
    approved: config.approved,
    dryRun: config.dryRun,
    sendApproved: config.sendApproved,
    notBeforePinned: config.notBeforeMs != null,
    gmailConfigured: config.gmailConfigured,
    storeConfigured: config.storeConfigured,
    mailbox: config.mailbox,
    executionReady: outreachExecutionEnabled(config),
    contactRecoveryConfigured: config.gmailConfigured,
    gmail: probe && config.gmailConfigured ? "checking" : null,
    store: probe && config.storeConfigured ? "checking" : null,
  };
  if (probe && config.gmailConfigured) {
    try {
      result.gmail = (await probeGmail(config.mailbox)).ok ? "live" : "wrong_mailbox";
    } catch (error) {
      result.gmail = "error";
      result.gmailError = clean(error?.code || "GMAIL_PROBE_FAILED");
    }
  }
  if (probe && config.storeConfigured) {
    try {
      result.store = await probeOutreachStore();
    } catch (error) {
      result.store = {
        ok: false,
        error: clean(error?.code || "OUTREACH_STORE_FAILED"),
        detail: clean(error?.message).slice(0, 180),
      };
    }
  }
  return result;
}
