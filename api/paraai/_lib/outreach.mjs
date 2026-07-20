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
  candidateRepliedAfter,
  createReviewDraft,
  deliverMessage,
  deterministicMessageId,
  findDigestThread,
  getSignatureHtml,
  getThread,
  gmailConfigured,
  outreachMailbox,
  probeGmail,
  threadDigestAnchorStatus,
  threadReplyContext,
} from "./outreach-gmail.mjs";
import { discoverCandidateContact } from "./outreach-contact.mjs";
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
export function outreachExecutionEnabled(config = outreachConfig()) {
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
        (
          finiteDate(row?.lastSeenAt) == null ||
          finiteDate(row?.lastSeenAt) <= Date.now() - EXCEPTION_RETRY_MS
        )
      ))
      .map((row) => clean(row?.requestId))
      .filter(Boolean),
  );
  return (history || []).filter((request) => (
    REQUEST_STATUSES.has(request.status) &&
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
    digestUrl: digest.digestUrl,
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

function matchRecord({ request, ordinal, roleUrl, digest, copy, sent, sentAt }) {
  return {
    requestId: request.id,
    ordinal,
    roleId: request.roleId,
    roleName: request.roleName,
    companyName: request.companyName,
    roleUrl,
    digestId: digest.digestId,
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
}) {
  const previousFollowup = state.followup;
  const remaining = ordinal === 1 ? 2 : 1;
  const next = {
    ...state,
    threadId: sent?.threadId || state.threadId || null,
    threadSubject: state.threadSubject || copy.subject || null,
    digestId: digest.digestId,
    digestUrl: digest.digestUrl,
    latestMatchId: request.id,
    lastOutboundAt: sentAt,
    matches: {
      ...(state.matches || {}),
      [request.id]: matchRecord({
        request, ordinal, roleUrl, digest, copy, sent, sentAt,
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
      },
    },
    followup: {
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

export async function processMatchRequest(
  request,
  history,
  {
    mode = "send",
    config = outreachConfig(),
  } = {},
) {
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

    const ordinal = requestOrdinal(request, history);
    const digest = await ensureMatchDigest(request);
    const roleUrl = roleShareUrl(request);
    request = { ...request, candidateEmail: contact.email };
    const actionKey = `match:${request.id}`;
    const previousOutbox = state.outbox?.[actionKey] || {};
    const previousThreadId = state.threadId || null;
    const { context, anchorStatus } = await threadForMatch({
      state,
      request,
      mailbox: config.mailbox,
      digestUrl: digest.digestUrl,
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
      digestId: digest.digestId,
      digestUrl: digest.digestUrl,
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
        },
      },
    }, mode === "draft" ? "review_draft_claimed" : "gmail_delivery_claimed", {
      requestId: request.id,
      ordinal,
      anchorStatus,
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
    }), state.revision);

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
    return { action: "sent", request, ordinal, digest, roleUrl, copy, sent, state };
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
  const lockToken = await acquireOutreachLock(candidateUserId);
  if (!lockToken) return { action: "busy" };
  try {
    let state = await getOutreachState(candidateUserId);
    const followup = state?.followup;
    if (!followup || finiteDate(followup.dueAt) > now) return { action: "not_due", state };
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
    if (candidateRepliedAfter(thread, state.candidateEmail, finiteDate(state.lastOutboundAt))) {
      state = await saveOutreachState(appendOutreachJournal({
        ...state,
        followup: null,
        stoppedReason: "candidate_replied",
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
    "OUTREACH_THREAD_NOT_FOUND",
    "OUTREACH_DIGEST_NOT_VISIBLE",
    "GMAIL_SEND_UNKNOWN",
    "GMAIL_AUTH_FAILED",
  ]).has(code)) return;
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
