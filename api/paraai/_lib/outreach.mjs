import {
  firstEmail,
  normalizeEmail,
  notifySlack,
  trpcGet,
  trpcPost,
} from "./core.mjs";
import {
  reportParaformWriteAuthFailure,
  reportParaformWriteAuthSuccess,
} from "./auth-probe.mjs";
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
import {
  classifyDeclinedRoles,
  declinableRoles,
  mergeDeclinedRoles,
  roleDeclined,
} from "./outreach-decline.mjs";
import { discoverCandidateContact, probeCalendarAccess } from "./outreach-contact.mjs";
import {
  deliverViaMailroomRelief,
  mailroomReliefConfig,
} from "./outreach-mailroom.mjs";
import { protectedRecruiterForRoleTitle } from "../../seq/_lib/protected.mjs";
import {
  acquireOutreachLock,
  acquireOutreachPollSlot,
  appendOutreachJournal,
  armGmailBackoff,
  getGmailBackoff,
  claimOutreachExceptionAlert,
  createOutreachState,
  getContactCapability,
  getOutreachState,
  listOutreachExceptions,
  listOutreachStates,
  probeOutreachStore,
  recordContactCapability,
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
// Paraform expires a submission request seven days after `created_at`
// (SUBMISSION_REQUEST_CONFIG, captured 2026-07-28). A blocked request is racing
// this clock, so the deadline has to be a first-class number here rather than
// something a human is expected to work out from the board.
export const SUBMISSION_REQUEST_EXPIRY_DAYS = 7;
const HOUR_MS = 60 * 60 * 1000;
// Escalation rungs, in hours before expiry. One alert per rung per request, so a
// blocked request gets louder as it dies instead of repeating the same daily line.
const EXPIRY_ESCALATION_HOURS = [48, 12];
const EXPIRY_ALERT_TTL_SECONDS = 30 * 24 * 60 * 60;
// Exception codes that a later tick may legitimately retry on its own. A bounced
// address behaves exactly like a missing one: the moment David fixes it in
// Paraform the request becomes sendable again, so it self-heals.
const RECOVERABLE_EXCEPTION_CODES = new Set([
  "AUTH_EXPIRED",
  "OUTREACH_NO_EMAIL",
  "OUTREACH_EMAIL_BOUNCED",
  "OUTREACH_THREAD_NOT_FOUND",
  "OUTREACH_DIGEST_NOT_VISIBLE",
]);
// Codes that park a request for a human and must never re-enter the tick on
// their own. OUTREACH_CANDIDATE_REPLIED is the retired 2026-07-26 code, kept here
// so pre-existing held records stay parked until the release action re-judges
// them under the intent rule.
const HUMAN_HELD_EXCEPTION_CODES = new Set([
  "OUTREACH_CANDIDATE_REPLIED",
  "OUTREACH_CANDIDATE_OFF_MARKET",
  "OUTREACH_CANDIDATE_DO_NOT_CONTACT",
  // The candidate declined this specific role. Their decision, so it never
  // re-enters the tick on its own — and unlike the codes above it is scoped to
  // one role, leaving every other role for this candidate free to send.
  "OUTREACH_ROLE_DECLINED",
]);
// A delivery with an uncertain Gmail outcome must never retry automatically.
// It stays parked until an operator reconciles the deterministic message ID.
const SYSTEM_HELD_EXCEPTION_CODES = new Set([
  "GMAIL_SEND_UNKNOWN",
  "GMAIL_AUTH_FAILED",
]);
// INCIDENT 2026-07-31. An attempt that dies BEFORE the outbox is claimed cannot
// have sent anything, so retrying it is safe. Classifying retryability by code
// alone did not know that: outreach-gmail maps every non-404 to the unlisted
// GMAIL_REQUEST_FAILED, so one transient 429 on a thread READ wrote
// `retryable: false`, and the `systemHeld` catch-all in eligibleNewRequests then
// parked the request permanently — never retried, attempts frozen at 1, no
// second alert, and (because escalateNearExpiry only runs on a processed
// failure) no deadline warning either. One candidate sat unemailed for 12h.
// The boundary is the outbox claim, not the code: from the claim onward the send
// outcome may be uncertain, which is exactly what SYSTEM_HELD protects. Never
// widen this set past `thread_anchor`.
const PRE_SEND_STAGES = new Set([
  "contact_discovery",
  "exception_resolution",
  "state_load",
  "state_create",
  "candidate_safety",
  "digest_mutation",
  "pending_digest_reverification",
  "thread_anchor",
]);
export const PENDING_DIGEST_UNAVAILABLE_VENDOR_MESSAGE =
  "None of the selected matches are eligible for a digest. Only pending, dismissed, or expired matches can be added.";
export const PENDING_DIGEST_UNAVAILABLE_REASON = "pending_digest_unavailable";
export const OPERATOR_CONFIRMED_NO_DIGEST_REASON =
  "operator_confirmed_without_digest";
const REQUEST_STATUSES = new Set(["pending"]);
const clean = (value) => String(value || "").trim();
const lower = (value) => clean(value).toLowerCase();

// The one Paraform contradiction the no-digest recovery exists for:
// matchDigest.createOrAddRoles rejects a request that
// matchDigest.getRequestIdsByStatus reports as pending AND digestable. Matched
// on the exact code AND the exact message on purpose — any other -32600 is a
// real rejection and must keep failing closed.
export function isPendingDigestUnavailableError(error) {
  return String(error?.code || "") === "-32600" &&
    clean(error?.message) === PENDING_DIGEST_UNAVAILABLE_VENDOR_MESSAGE;
}

// The single definition of "may this failure re-enter the tick on its own".
// Explicit classification always wins over the stage, so a human hold and an
// uncertain send stay parked no matter where they were raised; only an
// UNCLASSIFIED code falls through to the pre-send test. That fall-through is
// the fix: an unrecognised failure used to be treated as permanently held.
export function retryableFailure(code, stage) {
  const key = clean(code);
  if (RECOVERABLE_EXCEPTION_CODES.has(key)) return true;
  if (SYSTEM_HELD_EXCEPTION_CODES.has(key)) return false;
  if (HUMAN_HELD_EXCEPTION_CODES.has(key)) return false;
  return PRE_SEND_STAGES.has(clean(stage));
}

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
    // Paraform stores this on every row (326/326 in the request history). It is
    // the only identity token strong enough to resolve a candidate whose display
    // name is abbreviated — see outreach-contact.mjs.
    linkedinUser: clean(candidate?.linkedin_user || request?.linkedin_user),
    roleId: clean(role?.id || request?.role_id),
    roleName: clean(role?.name || request?.role_name),
    companyName: clean(role?.company?.name || request?.company_name),
  };
}

export function expiredNoDigestOverrideEligible(request) {
  return lower(request?.status) === "expired";
}

export function pendingNoDigestConfirmation(requestId) {
  return `SEND PENDING WITHOUT DIGEST ${clean(requestId)}`;
}

export function pendingNoDigestOverrideEligible(
  request,
  vendorError,
  status,
  digest,
) {
  const requestId = clean(request?.id);
  const candidateUserId = clean(request?.candidateUserId);
  const roleId = clean(request?.roleId);
  const pendingIds = Array.isArray(status?.pendingIds) ? status.pendingIds.map(clean) : [];
  const digestableIds = Array.isArray(status?.digestableIds)
    ? status.digestableIds.map(clean)
    : [];
  return Boolean(
    requestId &&
    candidateUserId &&
    roleId &&
    lower(request?.status) === "pending" &&
    request?.reachedOut !== true &&
    String(vendorError?.code || "") === "-32600" &&
    clean(vendorError?.message) === PENDING_DIGEST_UNAVAILABLE_VENDOR_MESSAGE &&
    pendingIds.includes(requestId) &&
    digestableIds.includes(requestId) &&
    !clean(digest?.digestId) &&
    (!Array.isArray(digest?.roles) || digest.roles.length === 0),
  );
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
  { now = Date.now() } = {},
) {
  const delivered = new Set();
  for (const state of states || []) {
    for (const [requestId, record] of Object.entries(state?.matches || {})) {
      if (record?.sentAt) delivered.add(requestId);
    }
  }
  const recoverable = (exceptions || []).filter((row) => (
    row?.status === "open" && (
      row?.retryable === true ||
      RECOVERABLE_EXCEPTION_CODES.has(clean(row?.code))
    )
  ));
  const retryDue = (row) => (
    finiteDate(row?.lastSeenAt) == null ||
    finiteDate(row?.lastSeenAt) <= now - EXCEPTION_RETRY_MS
  );
  const retryAuthorized = new Set(
    recoverable
      // Only a recoverable exception may re-enter the queue. A missing email
      // becomes sendable the moment David adds it; a candidate-replied hold
      // never does.
      .filter(retryDue)
      .map((row) => clean(row?.requestId))
      .filter(Boolean),
  );
  // INCIDENT 2026-07-29. The retry interval above used to be reachable only
  // through `retryAuthorized`, i.e. only for a request whose Paraform reached-out
  // marker was already set. A still-unreached request satisfied the plain
  // eligibility test on its own, so a known-blocked request was re-attempted on
  // EVERY tick: one live case logged 1,361 attempts in 9h39m (one per ~26s), each
  // burning a Gmail search, up to twenty thread reads, a Calendar query, and one
  // of only three batch slots. Three such requests at once would have starved
  // every new request. The interval now applies to both admission paths.
  const retryThrottled = new Set(
    recoverable
      .filter((row) => !retryDue(row))
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
  const systemHeld = new Set(
    (exceptions || [])
      .filter((row) => (
        row?.status === "open" &&
        (
          SYSTEM_HELD_EXCEPTION_CODES.has(clean(row?.code)) ||
          (
            row?.retryable !== true &&
            !RECOVERABLE_EXCEPTION_CODES.has(clean(row?.code)) &&
            !HUMAN_HELD_EXCEPTION_CODES.has(clean(row?.code))
          )
        )
      ))
      .map((row) => clean(row?.requestId))
      .filter(Boolean),
  );
  return (history || []).filter((request) => (
    REQUEST_STATUSES.has(request.status) &&
    // GUARDRAIL: never outreach a protected recruiter's role (e.g. Kyra's).
    !protectedRecruiterForRoleTitle(request.roleName) &&
    !humanHeld.has(request.id) &&
    !systemHeld.has(request.id) &&
    !retryThrottled.has(request.id) &&
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

export function normalizeOperatorContactOverride(request, override) {
  if (!override) return null;
  const email = normalizeEmail(override.email);
  if (!email) {
    const error = new Error("operator contact override requires a valid email");
    error.code = "OUTREACH_OPERATOR_EMAIL_INVALID";
    throw error;
  }
  return {
    name: displayName(override.name || request?.candidateName),
    email,
    source: "operator_paraform_profile",
    discovery: null,
  };
}

export function candidateEmailFromRecord(record) {
  const existing = firstEmail(record);
  if (existing) return existing;
  const candidates = [
    record,
    record?.candidate_user,
    record?.candidateUser,
    record?.candidate,
    record?.item,
  ].filter((value) => value && typeof value === "object");
  for (const candidate of candidates) {
    for (const key of [
      "email",
      "emails",
      "candidate_email",
      "to_use_email",
      "user_email",
      "user_emails",
    ]) {
      const values = Array.isArray(candidate[key])
        ? candidate[key]
        : [candidate[key]];
      for (const value of values) {
        const email = normalizeEmail(
          typeof value === "object"
            ? value?.value || value?.email || value?.address
            : value,
        );
        if (email) return email;
      }
    }
  }
  return "";
}

export async function candidateEmailFromParaformSources(
  candidateUserId,
  batchRecord,
  { trpcGetImpl = trpcGet } = {},
) {
  const batchEmail = candidateEmailFromRecord(batchRecord);
  if (batchEmail) return { email: batchEmail, snapshot: null };

  // Paraform's current profile header merges candidate-user data with this
  // candidate snapshot. The batch record can have an empty emails[] even when
  // the profile visibly has an address, so check the same snapshot before
  // falling through to the existing Gmail + Calendar corroboration path.
  const id = clean(candidateUserId);
  const snapshot = id
    ? await trpcGetImpl("candidates.getCandidateByCandidateUserId", id)
      .catch(() => null)
    : null;
  return {
    email: candidateEmailFromRecord(snapshot),
    snapshot,
  };
}

export async function candidateContact(
  request,
  config,
  override = null,
  { trpcGetImpl = trpcGet } = {},
) {
  const rows = await trpcGetImpl("candidateUser.getCandidateUsersByIds", {
    candidate_user_ids: [request.candidateUserId],
  });
  const record = (Array.isArray(rows) ? rows : [rows]).find(
    (row) => clean(row?.id) === clean(request.candidateUserId),
  ) || (Array.isArray(rows) ? rows[0] : rows);
  // Paraform's candidate batch read returns several source-dependent shapes.
  // The detail UI already uses the recursive contact shape; reading only the
  // two top-level fields made real profile emails look absent.
  const { email, snapshot } = await candidateEmailFromParaformSources(
    request.candidateUserId,
    record,
    { trpcGetImpl },
  );
  const name = displayName(
    record?.name ||
    record?.candidate?.name ||
    snapshot?.name ||
    snapshot?.candidate?.name ||
    request.candidateName,
  );
  const operatorContact = normalizeOperatorContactOverride(
    { ...request, candidateName: name || request.candidateName },
    override,
  );
  if (operatorContact) return operatorContact;
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
    linkedinUser:
      request.linkedinUser ||
      record?.linkedin_user ||
      record?.candidate?.linkedin_user ||
      snapshot?.linkedin_user ||
      snapshot?.candidate?.linkedin_user ||
      "",
  });
  // Every discovery call already knows whether both halves are usable. Latch it so
  // health can stop guessing (2026-07-29 incident).
  await recordContactCapability({
    calendarOk: !discovery.calendarError,
    calendarCode: discovery.calendarError || null,
    gmailOk: !discovery.gmailError,
    gmailCode: discovery.gmailError || null,
    source: "discovery",
  }).catch(() => null);
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

async function paraformOutreachWrite(stage, operation) {
  try {
    const result = await operation();
    // The write itself is the recovery canary. Clearing is generation-safe:
    // an older success cannot erase a newer AUTH_EXPIRED report.
    await reportParaformWriteAuthSuccess({
      lane: "paraai_outreach",
      stage,
    }).catch(() => null);
    return result;
  } catch (error) {
    if (error?.code === "AUTH_EXPIRED") {
      error.outreachStage ||= stage;
      // Never let an observability-store problem mask the original 401.
      await reportParaformWriteAuthFailure({
        lane: "paraai_outreach",
        stage,
      }).catch(() => null);
    }
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
    await paraformOutreachWrite("digest_mutation", () => trpcPost(
      "matchDigest.createOrAddRoles",
      {
        candidateUserId: request.candidateUserId,
        submissionRequestIds: [request.id],
      },
      1,
    ));
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

export async function verifyPendingDigestUnavailable(
  request,
  {
    ensureDigestImpl = ensureMatchDigest,
    readStatusImpl = (candidateUserId) => trpcGet(
      "matchDigest.getRequestIdsByStatus",
      { candidateUserId },
    ),
    readDigestImpl = (candidateUserId) => trpcGet(
      "matchDigest.getDigestForCandidate",
      { candidateUserId },
    ),
    // The tick calls this having ALREADY watched the mutation fail inside the
    // candidate lock. Re-firing it would be a second pointless write against a
    // vendor that just refused. An operator call passes nothing and still
    // re-proves the failure itself, exactly as before.
    observedError = null,
  } = {},
) {
  let vendorError = observedError || undefined;
  if (!vendorError) {
    try {
      await ensureDigestImpl(request);
    } catch (error) {
      vendorError = error;
    }
  }
  if (!vendorError) {
    const error = new Error("the Paraform digest is now available; use the normal send path");
    error.code = "OUTREACH_DIGEST_NOW_AVAILABLE";
    throw error;
  }
  if (!isPendingDigestUnavailableError(vendorError)) {
    throw vendorError;
  }
  const [status, digest] = await Promise.all([
    readStatusImpl(request.candidateUserId),
    readDigestImpl(request.candidateUserId),
  ]);
  if (!pendingNoDigestOverrideEligible(request, vendorError, status, digest)) {
    const error = new Error(
      "pending no-digest recovery was not re-verified against current Paraform state",
    );
    error.code = "OUTREACH_PENDING_NO_DIGEST_UNVERIFIED";
    throw error;
  }
  return {
    eligible: true,
    reason: PENDING_DIGEST_UNAVAILABLE_REASON,
    requestId: request.id,
    pending: true,
    digestable: true,
    digestAbsent: true,
  };
}

function copyForMatch({ request, ordinal, contact, digest, roleUrl, signatureFollows }) {
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
        signatureFollows,
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

export function messageForMatch({
  mailbox,
  request,
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
    // The full signature belongs on every email that starts a conversation
    // and never on a reply within an existing one.
    bodyHtml: !context && signatureHtml
      ? `${copy.html}<br>\n${signatureHtml}`
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
  transport = "gmail",
}) {
  const providerMessageId = sent?.providerMessageId || sent?.id || null;
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
    transport,
    sentAt,
    gmailMessageId: transport === "gmail" ? sent?.id || null : null,
    providerMessageId: transport === "gmail" ? null : providerMessageId,
    mailroomRowId: sent?.mailroomRowId || null,
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
  transport = "gmail",
  armFollowup = true,
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
        request, ordinal, roleUrl, digest, copy, sent, sentAt, deliveryMode, transport,
      }),
    },
    outbox: {
      ...(state.outbox || {}),
      [`match:${request.id}`]: {
        ...(state.outbox?.[`match:${request.id}`] || {}),
        status: "delivered",
        messageId,
        gmailMessageId: transport === "gmail" ? sent?.id || null : null,
        threadId: transport === "gmail"
          ? sent?.threadId || state.threadId || null
          : null,
        deliveredAt: sentAt,
        deliveryMode,
        transport,
        providerMessageId: transport === "gmail"
          ? null
          : sent?.providerMessageId || sent?.id || null,
        mailroomRowId: sent?.mailroomRowId || null,
      },
    },
    // A candidate who has already replied never gets a re-armed nudge ladder,
    // even when an operator explicitly overrides the send for a new role.
    followup: (!armFollowup || state.repliedAt || state.stoppedReason) ? null : {
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
    transport,
    ...(armFollowup ? {} : { followupSuppressed: true }),
    ...(previousFollowup ? {
      supersededFollowupFor: previousFollowup.ownerMatchId,
    } : {}),
  });
}

async function markReachedOut(requestId) {
  await paraformOutreachWrite("mark_reached_out", () => trpcPost(
    "submissionRequest.markReachedOutToCandidate",
    { id: requestId },
    1,
  ));
  const history = await readSubmissionRequestHistory();
  const visible = history.find((request) => request.id === requestId);
  if (!visible?.reachedOut) {
    const error = new Error("Paraform reached-out marker did not read back");
    error.code = "OUTREACH_REACHED_OUT_NOT_VISIBLE";
    throw error;
  }
  return visible;
}

async function saveUncertainOutbox(
  state,
  actionKey,
  messageId,
  error,
  { transport = "gmail" } = {},
) {
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
        transport,
      },
    },
  }, `${transport === "gmail" ? "gmail" : "mailroom"}_delivery_uncertain`, {
    actionKey,
    transport,
  });
  return saveOutreachState(uncertain, state.revision).catch(() => uncertain);
}

// Read a candidate's conversation and decide what it authorizes, WITHOUT writing
// anything. The send path and the held-backlog review share this so a reported
// verdict and an acted-on verdict can never disagree.
export async function assessOutreachThread({
  state,
  config = outreachConfig(),
  history = [],
  threadImpl = getThread,
  classifyImpl = classifyInboundIntent,
  declineImpl = classifyDeclinedRoles,
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
    declined: null,
    declinableRoles: [],
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
  const messages = intentMessagesFromThread(inbound);
  const roles = declinableRoles(state, history);
  // Availability and per-role interest are two different questions about the same
  // sentences, so they are judged independently and neither can veto the other:
  // "yes to Roger Healthcare, no to Toku" is OPEN *and* a decline of Toku.
  const [intent, declined] = await Promise.all([
    classifyImpl(messages),
    declineImpl(messages, roles),
  ]);
  result.intent = intent;
  result.verdict = intent.verdict;
  result.declined = declined;
  result.declinableRoles = roles;
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
  state = null,
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
  // Latched independently of the reply/hold branches below: a candidate who says
  // "yes to A, no to B" is neither blocked nor silent, and B must still stick.
  if (assessment.declined?.roleIds?.length) {
    const merged = mergeDeclinedRoles(state?.declinedRoles, assessment.declined.roleIds, {
      roles: assessment.declinableRoles || [],
      detectedAt: new Date(assessment.newestInboundMs || Date.now()).toISOString(),
      evidenceMessageId: assessment.declined.evidenceMessageId || null,
      source: assessment.declined.source || "model",
    });
    // Only write when something is actually new, so a re-read cannot churn the
    // revision or re-fire the journal for declines we already knew about.
    if (Object.keys(merged).length !== Object.keys(state?.declinedRoles || {}).length) {
      patch.declinedRoles = merged;
      event = "roles_declined";
    }
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
    allowWithoutDigestReason = null,
    transport = "gmail",
    deliveryImpl = null,
    contactOverride = null,
  } = {},
) {
  // INCIDENT 2026-07-20 defense-in-depth: refuse any live candidate send while
  // the outreach halt is active, regardless of caller. Drafts remain allowed.
  if (mode === "send" && OUTREACH_INCIDENT_HALT) {
    const error = new Error("Para AI outreach sending is halted (2026-07-20 Kyra incident)");
    error.code = "OUTREACH_HALTED";
    throw error;
  }
  const noDigestReason = clean(allowWithoutDigestReason);
  const reliefTransport = clean(transport) === "mailroom-relief";
  if (!new Set(["gmail", "mailroom-relief"]).has(clean(transport))) {
    const error = new Error("unsupported Para AI outreach transport");
    error.code = "OUTREACH_TRANSPORT_INVALID";
    throw error;
  }
  if (contactOverride && (mode !== "send" || !reliefTransport)) {
    const error = new Error(
      "operator contact overrides are restricted to confirmed Mailroom relief sends",
    );
    error.code = "OUTREACH_OPERATOR_EMAIL_OVERRIDE_INVALID";
    throw error;
  }
  if (allowWithoutDigest) {
    const expiredAllowed = expiredNoDigestOverrideEligible(request) &&
      (!noDigestReason || noDigestReason === "expired_without_digest");
    const pendingAllowed =
      noDigestReason === PENDING_DIGEST_UNAVAILABLE_REASON &&
      lower(request?.status) === "pending" &&
      request?.reachedOut !== true;
    const operatorReliefAllowed =
      noDigestReason === OPERATOR_CONFIRMED_NO_DIGEST_REASON &&
      reliefTransport &&
      lower(request?.status) === "pending" &&
      request?.reachedOut !== true &&
      Boolean(contactOverride);
    if (
      mode !== "send" ||
      (!expiredAllowed && !pendingAllowed && !operatorReliefAllowed)
    ) {
      const error = new Error(
        "no-digest delivery requires an approved expired or re-verified pending recovery",
      );
      error.code = pendingAllowed
        ? "OUTREACH_NO_DIGEST_SEND_ONLY"
        : "OUTREACH_NO_DIGEST_OVERRIDE_INVALID";
      throw error;
    }
  }
  const lockToken = await acquireOutreachLock(request.candidateUserId);
  if (!lockToken) {
    const error = new Error("candidate outreach is already being processed");
    error.code = "OUTREACH_BUSY";
    throw error;
  }
  let attemptStage = "contact_discovery";
  let state = null;
  try {
    const contact = await candidateContact(request, config, contactOverride);
    attemptStage = "exception_resolution";
    await resolveOutreachException(request.id, {
      resolution: contact.source,
      // Contact discovery proves only these two failures recovered. It must
      // never erase an auth/digest failure merely because an email exists.
      onlyCodes: ["OUTREACH_NO_EMAIL", "OUTREACH_EMAIL_BOUNCED"],
    }).catch(() => {});
    attemptStage = "state_load";
    state = await getOutreachState(request.candidateUserId);
    if (!state) {
      attemptStage = "state_create";
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
    attemptStage = "candidate_safety";

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
      // Cheapest gate first, and the only one that is role-specific: a decline
      // we already latched blocks this role before Gmail or a model is touched.
      const declined = roleDeclined(state, request.roleId);
      if (declined) {
        throw blockFor(
          "OUTREACH_ROLE_DECLINED",
          "candidate has declined this role; automatic match send is blocked",
          declined,
        );
      }
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
      const assessment = await assessOutreachThread({ state, config, history });
      if (assessment.checked) {
        const { patch, event } = assessmentPatch(assessment, {
          requestId: request.id,
          address: state.candidateEmail || contact.email || null,
          repliedAt: state.repliedAt,
          stoppedReason: state.stoppedReason,
          state,
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
        // Re-checked against the state we just latched. The decline that blocks
        // this send is very often the one we learned in THIS read: the candidate
        // replies naming a role while its request is still pending, which is
        // exactly the 07-31 shape. Checking only before the read would send it.
        const declinedNow = roleDeclined(state, request.roleId);
        if (declinedNow) {
          throw blockFor(
            "OUTREACH_ROLE_DECLINED",
            "candidate has declined this role; automatic match send is blocked",
            declinedNow,
          );
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

    attemptStage = "digest_mutation";
    const ordinal = requestOrdinal(request, history);
    let digest = null;
    let deliveryMode = "digest";
    let autoRecoveredNoDigest = false;
    if (allowWithoutDigest) {
      if (noDigestReason === PENDING_DIGEST_UNAVAILABLE_REASON) {
        attemptStage = "pending_digest_reverification";
        await verifyPendingDigestUnavailable(request);
        deliveryMode = PENDING_DIGEST_UNAVAILABLE_REASON;
      } else if (noDigestReason === OPERATOR_CONFIRMED_NO_DIGEST_REASON) {
        deliveryMode = OPERATOR_CONFIRMED_NO_DIGEST_REASON;
      } else {
        deliveryMode = "expired_without_digest";
      }
    } else {
      try {
        digest = await ensureMatchDigest(request);
      } catch (error) {
        // 2026-08-05: the operator-only escape hatch was the wrong altitude.
        // Twice in a week Paraform rejected a digest write for a request its own
        // status read called pending AND digestable, and both times the tick
        // retried into a wall until a human noticed — 85 attempts over 7h50m for
        // the Exiger request, and nobody is watching at 02:00. The recovery
        // re-proves EVERY gate the manual override demands, against live vendor
        // state, under this candidate's lock. When that proof holds, take it
        // here. Every other digest failure still fails closed.
        if (mode !== "send" || !isPendingDigestUnavailableError(error)) throw error;
        attemptStage = "pending_digest_reverification";
        await verifyPendingDigestUnavailable(request, { observedError: error });
        deliveryMode = PENDING_DIGEST_UNAVAILABLE_REASON;
        autoRecoveredNoDigest = true;
      }
    }
    const roleUrl = roleShareUrl(request);
    request = { ...request, candidateEmail: contact.email };
    const actionKey = `match:${request.id}`;
    const previousOutbox = state.outbox?.[actionKey] || {};
    const previousThreadId = state.threadId || null;
    attemptStage = "thread_anchor";
    const { context, anchorStatus } = reliefTransport
      ? { context: null, anchorStatus: "none" }
      : await threadForMatch({
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
    const signatureHtml = reliefTransport
      ? ""
      : context
        ? ""
        : await getSignatureHtml(config.mailbox).catch(() => "");
    let copy = copyForMatch({
      request,
      ordinal,
      contact,
      digest,
      roleUrl,
      // If the signature fetch failed, keep the baked-in "David" sign-off
      // rather than sending a thread-starting email with no name at all.
      signatureFollows: Boolean(signatureHtml),
    });
    if (
      deliveryMode === PENDING_DIGEST_UNAVAILABLE_REASON ||
      deliveryMode === OPERATOR_CONFIRMED_NO_DIGEST_REASON
    ) {
      copy = {
        ...copy,
        variant: clean(copy.variant).replace(
          "_expired_no_digest",
          deliveryMode === PENDING_DIGEST_UNAVAILABLE_REASON
            ? "_pending_digest_unavailable"
            : "_operator_confirmed_no_digest",
        ),
      };
    }
    const message = messageForMatch({
      mailbox: config.mailbox,
      request,
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
          transport: reliefTransport ? "mailroom-sendgrid" : "gmail",
        },
      },
    }, mode === "draft"
      ? "review_draft_claimed"
      : reliefTransport
        ? "mailroom_delivery_claimed"
        : "gmail_delivery_claimed", {
      requestId: request.id,
      ordinal,
      anchorStatus,
      deliveryMode,
      transport: reliefTransport ? "mailroom-sendgrid" : "gmail",
      // Self-healing must stay legible: a send that only happened because the
      // vendor contradicted itself has to be distinguishable, forever, from a
      // send that took the normal digest path.
      ...(autoRecoveredNoDigest ? { autoRecoveredNoDigest: true } : {}),
    });
    attemptStage = "outbox_claim";
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

    attemptStage = reliefTransport ? "mailroom_delivery" : "gmail_delivery";
    let sent;
    try {
      if (reliefTransport) {
        const send = deliveryImpl || deliverViaMailroomRelief;
        sent = await send({
          message,
          requestId: request.id,
          candidateName: contact.name || request.candidateName,
        });
      } else {
        const send = deliveryImpl || deliverMessage;
        sent = await send({
          mailbox: config.mailbox,
          draftId: previousOutbox.draftId || null,
          draftRfc822MessageId: previousOutbox.gmailDraftRfc822MessageId || null,
          message,
          // A process can die after Gmail accepts the email and before Redis
          // records delivery. A previous claim must reconcile by action marker;
          // it must never become authorization for a second send.
          reconcileOnly: ["claimed", "uncertain"].includes(previousOutbox.status),
        });
      }
    } catch (error) {
      await saveUncertainOutbox(
        state,
        message.actionKey,
        message.messageId,
        error,
        { transport: reliefTransport ? "mailroom-sendgrid" : "gmail" },
      );
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
      transport: reliefTransport ? "mailroom-sendgrid" : "gmail",
      // SendGrid opens a fresh conversation and Mailroom does not yet ingest
      // replies, so automatic nudges would be unsafe for this relief path.
      armFollowup: !reliefTransport,
    }), state.revision);

    await resolveOutreachException(request.id, {
      resolution: "sent",
    }).catch(() => {});

    attemptStage = "mark_reached_out";
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
    attemptStage = "complete";
    return {
      action: "sent",
      request,
      ordinal,
      digest,
      roleUrl,
      copy,
      sent,
      state,
      deliveryMode,
      transport: reliefTransport ? "mailroom-sendgrid" : "gmail",
      autoRecoveredNoDigest,
    };
  } catch (error) {
    const stage = clean(error?.outreachStage || attemptStage || "unknown");
    error.outreachStage ||= stage;
    // The exception ledger below is the cross-request durable record. Also
    // attach a stage/code journal event to the candidate state when one exists,
    // so operators can reconstruct how far this exact attempt progressed.
    const current = await getOutreachState(request.candidateUserId).catch(() => null);
    if (current) {
      const failed = appendOutreachJournal(
        current,
        "match_attempt_failed",
        {
          requestId: request.id,
          code: clean(error?.code || "OUTREACH_FAILED"),
          stage,
        },
      );
      await saveOutreachState(failed, current.revision).catch(() => null);
    }
    throw error;
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
    const previousOutbox = state.outbox?.[actionKey] || {};
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
          ...previousOutbox,
          status: "claimed",
          messageId: message.messageId,
          claimedAt: previousOutbox.claimedAt || new Date().toISOString(),
        },
      },
    }, "followup_claimed", {
      ownerMatchId: followup.ownerMatchId,
      followupNumber: followup.number,
    });
    state = await saveOutreachState(claimed, state.revision);
    let sent;
    try {
      sent = await deliverMessage({
        mailbox: config.mailbox,
        message,
        reconcileOnly: ["claimed", "uncertain"].includes(previousOutbox.status),
      });
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

// INCIDENT 2026-07-29. This alert used to describe only the outcome ("not
// corroborated by both Gmail and Calendar") and always prescribe the same fix
// ("add the email in Paraform"). For nine days the real fault was that the
// Calendar half could not run at all — the exception record carried
// `calendarError` the whole time and the alert never said it — so four days of
// daily alerts pointed at a Paraform field that no edit would have unblocked.
// A lookup that CANNOT run and a lookup that ran and found nothing need different
// human actions, so they now read differently.
export function missingEmailAlertCopy(request, discovery = {}) {
  const suggestions = Array.isArray(discovery?.suggestedEmails)
    ? discovery.suggestedEmails.filter(Boolean)
    : [];
  const gmailError = clean(discovery?.gmailError) || null;
  const calendarError = clean(discovery?.calendarError) || null;
  const brokenHalves = [
    gmailError ? `Gmail lookup FAILED (${gmailError})` : null,
    calendarError ? `Calendar lookup FAILED (${calendarError})` : null,
  ].filter(Boolean);
  const suggestionText = suggestions.length
    ? `Google lookup found: ${suggestions.join(", ")}. This was not corroborated by both Gmail and Calendar, so no email was sent.`
    : "Gmail and Google Calendar did not produce one corroborated address.";
  const faultText = brokenHalves.length
    ? `${brokenHalves.join(" and ")} — corroboration was impossible, so this is a SYSTEM fault and no Paraform edit will clear it. Fix the Google access first.`
    : null;
  const remedy = brokenHalves.length
    ? "Once Google access is restored the worker retries automatically; adding the email in Paraform also unblocks it immediately."
    : "Add the correct email to the candidate's Paraform profile. The worker will retry automatically after the address is available.";
  const candidate = displayName(request?.candidateName) || "Unknown candidate";
  const role = clean(request?.roleName) || "Unknown role";
  const company = clean(request?.companyName) || "Unknown company";
  const lines = [
    `Para AI outreach is blocked for ${candidate}.`,
    `${role} @ ${company}`,
    suggestionText,
    ...(faultText ? [faultText] : []),
    remedy,
  ];
  return {
    subject: `Action needed: missing email for ${candidate}`,
    text: lines.join("\n\n"),
    html: lines
      .map((line) => `<div>${htmlEscape(line)}</div>`)
      .join("\n<div><br></div>\n"),
    slack: [
      `🚨 Para AI outreach blocked: ${candidate} has no deliverable email for ${role} @ ${company}.`,
      suggestionText,
      faultText,
      brokenHalves.length
        ? "Restore the Google access; adding the email in Paraform also unblocks it immediately."
        : "Add the correct email in Paraform; the worker will retry automatically.",
    ].filter(Boolean).join(" "),
  };
}

export function requestExpiresAtMs(request) {
  const created = request?.createdAtMs ?? finiteDate(request?.createdAt);
  return created == null
    ? null
    : created + SUBMISSION_REQUEST_EXPIRY_DAYS * 24 * HOUR_MS;
}

// The rung a request has just crossed, or null when it is not near the deadline.
// Rungs are ordered tightest-first so a request that jumps two rungs (a long tick
// gap, or a first failure discovered late) reports the more urgent one.
export function expiryEscalationRung(request, { now = Date.now() } = {}) {
  const expiresAt = requestExpiresAtMs(request);
  if (expiresAt == null) return null;
  const hoursLeft = (expiresAt - now) / HOUR_MS;
  if (hoursLeft <= 0) return null;
  for (const rung of [...EXPIRY_ESCALATION_HOURS].sort((left, right) => left - right)) {
    if (hoursLeft <= rung) return { rung, hoursLeft };
  }
  return null;
}

export function expiryEscalationCopy(request, code, { rung, hoursLeft }) {
  const candidate = displayName(request?.candidateName) || "a candidate";
  const role = clean(request?.roleName) || "Unknown role";
  const company = clean(request?.companyName) || "Unknown company";
  const hours = Math.max(1, Math.round(hoursLeft));
  // A deadline warning can now be raised by the tick-end sweep for a request
  // that has no exception at all, so "Blocked by an exception" is no longer a
  // safe default — saying it would send David hunting for a ledger entry that
  // does not exist. No code means nothing has reported a reason, which is
  // itself the more alarming case and must read that way.
  const why = clean(code)
    ? `Blocked by ${clean(code)}.`
    : "NOTHING has reported a reason for this one, so it is not in the exception ledger — check the request on Paraform directly.";
  return `⏳ Para AI outreach DEADLINE: ${candidate} has still not been emailed about ${role} @ ${company}, and the hiring manager's request expires in ~${hours}h (Paraform kills it ${SUBMISSION_REQUEST_EXPIRY_DAYS} days after the request). ${why} After expiry the match is dead and it counts toward the three expired matches that pause new Para AI matches.${rung <= 12 ? " This is the last warning." : ""}`;
}

export function expiredUnsentCopy(request) {
  const candidate = displayName(request?.candidateName) || "a candidate";
  const role = clean(request?.roleName) || "Unknown role";
  const company = clean(request?.companyName) || "Unknown company";
  return `💀 Para AI outreach EXPIRED UNSENT: ${candidate} was never emailed about ${role} @ ${company} and the hiring manager's request has now expired. Nothing will retry it. Recover it by hand with the expired-request override if the role is still worth pursuing.`;
}

// An exception outlives the work it describes. A blocked request used to leave the
// queue in silence the moment Paraform flipped it out of `pending`, so the only
// trace of a lost match was an unread alert from days earlier — and an exception
// whose request was answered some other way (submitted by hand, dismissed) stayed
// open forever, because only a successful send ever resolved one. This runs at the
// end of every tick and splits those two cases the way the alerting rule requires:
// a lost match is loud exactly once, and everything else closes silently, because
// self-healing must never page a human.
export async function sweepStaleOutreachExceptions({
  history,
  states = [],
  exceptions = [],
  claimImpl = claimOutreachExceptionAlert,
  notifyImpl = notifySlack,
  resolveImpl = resolveOutreachException,
} = {}) {
  const delivered = new Set();
  for (const state of states || []) {
    for (const [requestId, record] of Object.entries(state?.matches || {})) {
      if (record?.sentAt) delivered.add(requestId);
    }
  }
  const open = (exceptions || []).filter((row) => row?.status === "open");
  const expiredUnsent = [];
  const closed = [];
  for (const row of open) {
    const requestId = clean(row?.requestId);
    if (!requestId) continue;
    const request = (history || []).find((item) => item.id === requestId);
    // Absent from the history is ambiguous — withdrawn, filled, or simply outside
    // what the endpoint returned — so it is never grounds for closing anything.
    if (!request) continue;
    const status = lower(request.status);
    // Still pending means still real work: leave it alone.
    if (REQUEST_STATUSES.has(status)) continue;
    if (status === "expired" && !delivered.has(requestId)) {
      // The one case that costs a placement: the hiring manager asked, the
      // candidate was never emailed, and the window has closed.
      const claimed = await claimImpl(`${requestId}:expired-unsent`, {
        ttlSeconds: EXPIRY_ALERT_TTL_SECONDS,
      }).catch(() => false);
      if (!claimed) continue;
      await notifyImpl(expiredUnsentCopy({
        ...request,
        candidateName: row.candidateName || request.candidateName,
      })).catch(() => false);
      await resolveImpl(requestId, { resolution: "expired_unsent" }).catch(() => null);
      expiredUnsent.push(requestId);
      continue;
    }
    // Submitted, dismissed, or expired after we had already emailed them: the
    // request was resolved elsewhere, so the exception is stale bookkeeping, not
    // news. Close it quietly.
    await resolveImpl(requestId, {
      resolution: `no_longer_pending_${status || "unknown"}`,
    }).catch(() => null);
    closed.push({ requestId, status: status || "unknown" });
  }
  return { expiredUnsent, closed };
}

// INCIDENT 2026-07-31. The deadline ladder was unreachable for exactly the
// requests that needed it. All three escalateNearExpiry call sites live inside
// handleOutreachFailure, which only runs when a request is PROCESSED — so any
// request held out of the eligible set (an off-market hold, a role decline, an
// uncertain send, or a system-held code) escalated once at most, on the tick its
// failure was first raised, and then went silent until the post-mortem after
// Paraform expired it. The 12h "last warning" could never fire for a request
// parked on day one.
//
// This sweep closes that by keying on the REQUEST rather than on the exception.
// That is the stronger invariant and it deliberately covers a case nobody has
// diagnosed yet: a pending, un-emailed request with NO exception at all is
// warned about too, where the exception-driven ladder could not have seen it.
//
// Alerting is unchanged in volume: escalateNearExpiry claims one alert per
// (request, rung) with a 30-day TTL, so a request that also fails during the
// tick cannot produce two lines for the same rung.
export async function sweepExpiryEscalations({
  history = [],
  states = [],
  exceptions = [],
  sentThisTick = [],
  now = Date.now(),
  escalateImpl = escalateNearExpiry,
} = {}) {
  // `states` and `history` are both read at the START of the tick, so a request
  // this tick has just delivered still looks un-emailed in them. Warning about
  // one would be a straight falsehood, and the shape is real: a request blocked
  // for six days and finally sent has hours left on its clock when it lands.
  const delivered = new Set(sentThisTick || []);
  for (const state of states || []) {
    for (const [requestId, record] of Object.entries(state?.matches || {})) {
      if (record?.sentAt) delivered.add(requestId);
    }
  }
  const codeByRequest = new Map();
  for (const row of exceptions || []) {
    const requestId = clean(row?.requestId);
    if (row?.status === "open" && requestId) codeByRequest.set(requestId, clean(row?.code));
  }
  const escalated = [];
  for (const request of history || []) {
    const requestId = clean(request?.id);
    if (!requestId) continue;
    if (!REQUEST_STATUSES.has(lower(request?.status))) continue;
    // Two independent proofs that the candidate already heard from us. Our own
    // delivery record is authoritative, but reached-out can also be set by a
    // hand-sent email, and "has still not been emailed" would be a false alarm
    // in that case. A deadline alert nobody needs is how alerting gets muted.
    if (delivered.has(requestId) || request?.reachedOut === true) continue;
    const result = await escalateImpl(request, codeByRequest.get(requestId) || null, { now })
      .catch(() => null);
    if (result?.notified) {
      escalated.push({ requestId, rung: result.rung, code: codeByRequest.get(requestId) || null });
    }
  }
  return { escalated };
}

const HELD_ALERT_CODES = new Set([
  "OUTREACH_CANDIDATE_REPLIED",
  "OUTREACH_CANDIDATE_OFF_MARKET",
  "OUTREACH_CANDIDATE_DO_NOT_CONTACT",
  "OUTREACH_EMAIL_BOUNCED",
  // Actionable, so it alerts: the hiring manager's request is still pending and
  // will sit there until David dismisses it or the seven days run out.
  "OUTREACH_ROLE_DECLINED",
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
  if (code === "OUTREACH_ROLE_DECLINED") {
    const when = clean(error?.detail?.declinedAt).slice(0, 10);
    return `🙅 Para AI outreach held: ${candidate} has already declined ${match}${when ? ` (${when})` : ""}, so it was NOT sent. Every other role for them still sends normally. The hiring manager's request stays pending until you dismiss it on Paraform.`;
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

// One extra, louder line per escalation rung, on top of the daily alert. The daily
// alert answers "something is blocked"; this answers "and it dies in N hours",
// which is the fact that actually forces a decision. Claimed per rung with a
// 30-day TTL, so it fires at most once each and never becomes noise.
export async function escalateNearExpiry(request, code, { now = Date.now() } = {}) {
  if (!request?.id) return null;
  const escalation = expiryEscalationRung(request, { now });
  if (!escalation) return null;
  const claimed = await claimOutreachExceptionAlert(
    `${request.id}:expiry-${escalation.rung}`,
    { ttlSeconds: EXPIRY_ALERT_TTL_SECONDS },
  ).catch(() => false);
  if (!claimed) return null;
  const notified = await notifySlack(
    expiryEscalationCopy(request, code, escalation),
  ).catch(() => false);
  if (!notified) {
    await releaseOutreachExceptionAlert(`${request.id}:expiry-${escalation.rung}`)
      .catch(() => {});
  }
  return { ...escalation, notified };
}

export async function handleOutreachFailure(
  error,
  request,
  {
    config = outreachConfig(),
    now = Date.now(),
  } = {},
) {
  const code = clean(error?.code || "OUTREACH_FAILED");
  // One observed Gmail 429 stands the whole lane down (see armGmailBackoff).
  // Alert at most once per 6h so the stand-down is visible without spamming.
  if (code === "GMAIL_REQUEST_FAILED" && Number(error?.status) === 429) {
    const until = await armGmailBackoff().catch(() => null);
    if (until) {
      const claimed = await claimOutreachExceptionAlert("gmail-429-backoff", { ttlSeconds: 6 * 60 * 60 }).catch(() => false);
      if (claimed) {
        await notifySlack(
          `Para AI outreach: Gmail answered 429 (per-user rate limit) — outreach is standing down until ${until} so the mailbox bucket can recover. Requests stay queued; nothing is lost.`,
        ).catch(() => {});
      }
    }
  }
  const tracked = new Set([
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
  ]);
  if (!request?.id) {
    if (tracked.has(code)) {
      await notifySlack(
        `🚨 Para AI outreach: ${code} for a scheduled follow-up. No duplicate email will be attempted; review the outreach ledger.`,
      ).catch(() => {});
    }
    return;
  }
  // A lock race is expected concurrency, not an attempt failure. The request
  // remains eligible for the next tick and no operator action is needed.
  if (code === "OUTREACH_BUSY") return;
  // A blocked match is a human decision, not a system fault: record it durably and
  // alert once, exactly like the missing-email path. Never silent.
  if (HELD_ALERT_CODES.has(code)) {
    const record = await recordOutreachException({
      request,
      code,
      discovery: null,
      stage: error?.outreachStage || null,
      retryable: RECOVERABLE_EXCEPTION_CODES.has(code),
    });
    const escalation = await escalateNearExpiry(request, code, { now });
    const alertClaimed = await claimOutreachExceptionAlert(request.id).catch(() => false);
    if (!alertClaimed) return { ...record, escalation };
    await notifySlack(heldAlertCopy(code, request, error)).catch(() => false);
    return { ...record, escalation };
  }
  if (code === "OUTREACH_NO_EMAIL") {
    const record = await recordOutreachException({
      request,
      code,
      discovery: error?.discovery || null,
      stage: error?.outreachStage || "contact_discovery",
      retryable: true,
    });
    const escalation = await escalateNearExpiry(request, code, { now });
    const alertClaimed = await claimOutreachExceptionAlert(request.id).catch(() => false);
    if (!alertClaimed) return record;
    const copy = missingEmailAlertCopy(request, error?.discovery);
    // Slack-only by David's order (2026-08-18): the old Gmail fallback emailed
    // the same contended mailbox this alert exists to protect. A failed Slack
    // post releases the claim below, so delivery is retried next tick, and the
    // blocked candidate stays durable in KV either way.
    const notified = await notifySlack(copy.slack).catch(() => false);
    if (!notified) {
      await releaseOutreachExceptionAlert(request.id).catch(() => {});
    }
    return { ...record, notified, escalation };
  }
  const record = await recordOutreachException({
    request,
    code,
    discovery: null,
    stage: error?.outreachStage || null,
    retryable: retryableFailure(code, error?.outreachStage),
  });
  const escalation = await escalateNearExpiry(request, code, { now });
  // AUTH_EXPIRED alerting is owned by the global auth latch. It deduplicates
  // the outage across all requests and carries the recapture runbook.
  if (code === "AUTH_EXPIRED") return { ...record, escalation };
  await notifySlack(
    `🚨 Para AI outreach: ${code} for ${request?.id || "scheduled follow-up"}. No duplicate email will be attempted; review the outreach ledger.`,
  ).catch(() => {});
  return { ...record, escalation };
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
  // Gmail-429 breaker (2026-08-10): while armed, run no Gmail work at all.
  // Requests stay eligible and are picked up when the breaker expires; without
  // this, the pass itself kept the mailbox's per-user bucket exhausted 24/7.
  const gmailBackoffUntil = await getGmailBackoff().catch(() => null);
  if (gmailBackoffUntil) {
    await releaseOutreachPollSlot(pollToken).catch(() => {});
    return { enabled: true, processed: 0, reason: "gmail_rate_limited", until: gmailBackoffUntil };
  }
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
      { now },
    ).slice(0, config.batchSize)) {
      candidatesWithNewMatch.add(request.candidateUserId);
      try {
        const result = await processMatchRequest(request, history, { mode: "send", config });
        results.push({
          action: result.action,
          requestId: request.id,
          ...(result.autoRecoveredNoDigest
            ? { deliveryMode: result.deliveryMode, autoRecoveredNoDigest: true }
            : {}),
        });
      } catch (error) {
        await handleOutreachFailure(error, request, { config, now }).catch(() => {});
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
    // A lost match must never be quieter than a blocked one, and an exception must
    // not outlive its request (2026-07-29 incident).
    const sweep = await sweepStaleOutreachExceptions({
      history,
      states,
      exceptions,
    }).catch(() => ({ expiredUnsent: [], closed: [] }));
    // Deadline warnings for everything still pending and un-emailed, including
    // the held requests the failure path can never reach (2026-07-31 incident).
    // Deliberately separate from the sweep above and separately guarded: these
    // two answer different questions, and one failing must not silence the other.
    const expiry = await sweepExpiryEscalations({
      history,
      states,
      exceptions,
      // history/states were read before this tick sent anything, so anything
      // delivered just now has to be excluded explicitly or it gets warned about.
      sentThisTick: results
        .filter((result) => result.action === "sent" && result.requestId)
        .map((result) => result.requestId),
      now,
    }).catch(() => ({ escalated: [] }));
    return {
      enabled: true,
      processed: results.filter((result) => result.action === "sent").length,
      results,
      expiredUnsent: sweep.expiredUnsent,
      closedStaleExceptions: sweep.closed,
      expiryEscalations: expiry.escalated,
      // Non-zero means Paraform's digest API contradicted itself this tick and
      // we routed around it. It costs nobody a placement, so it does not page,
      // but a rising count is the signal to take back to the vendor.
      autoRecoveredNoDigest: results.filter((result) => result.autoRecoveredNoDigest).length,
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
  requestId: onlyRequestId = null,
  assessImpl = assessOutreachThread,
} = {}) {
  const [history, exceptions] = await Promise.all([
    readSubmissionRequestHistory(),
    listOutreachExceptions(500),
  ]);
  const target = clean(onlyRequestId) || null;
  const held = (exceptions || [])
    .filter((row) => (
      row?.status === "open" &&
      HUMAN_HELD_EXCEPTION_CODES.has(clean(row?.code)) &&
      (!target || clean(row?.requestId) === target)
    ))
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
    // Presence in the history is NOT the same as still being open: the history
    // carries submitted, dismissed, and expired rows too. Without this check a
    // release would email an interview request for a role the candidate has
    // already been submitted to — one of the two held records on 2026-07-29 was
    // exactly that shape.
    if (!REQUEST_STATUSES.has(request.status)) {
      row.requestStatus = request.status;
      row.blockedBy = "REQUEST_NO_LONGER_PENDING";
      rows.push(row);
      continue;
    }
    row.requestStatus = request.status;
    row.expiresAt = new Date(requestExpiresAtMs(request)).toISOString();
    const candidateUserId = clean(record.candidateUserId || request.candidateUserId);
    const state = candidateUserId
      ? await getOutreachState(candidateUserId).catch(() => null)
      : null;
    // A latched decline outranks the intent verdict and must be checked BEFORE
    // the no-thread shortcut below. Intent answers "still on the market", and a
    // candidate who declined one role almost always still is — so without this
    // the review would report OPEN, releaseHeldOutreach would send, and the
    // decline memory would be undone by the very tool meant to review it.
    const latchedDecline = roleDeclined(state, request.roleId);
    if (latchedDecline) {
      row.verdict = INTENT_OPEN;
      row.reason = "candidate declined this specific role";
      row.source = "role_decline";
      row.blockedBy = "OUTREACH_ROLE_DECLINED";
      row.declinedAt = clean(latchedDecline.declinedAt) || null;
      row.wouldSend = false;
      rows.push(row);
      continue;
    }
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
      assessment = await assessImpl({ state, config, history });
    } catch (error) {
      row.blockedBy = clean(error?.code || "OUTREACH_ASSESS_FAILED");
      rows.push(row);
      continue;
    }
    row.verdict = assessment.verdict || INTENT_OPEN;
    row.reason = clean(assessment.intent?.reason) || null;
    row.source = clean(assessment.intent?.source) || (assessment.cached ? "cached" : null);
    row.blockedBy = assessmentBlockCode(assessment);
    // A decline found in THIS read blocks it too, not just a previously latched
    // one — the review is often the first thing to read a reply.
    if (!row.blockedBy && assessment.declined?.roleIds?.includes(clean(request.roleId))) {
      row.blockedBy = "OUTREACH_ROLE_DECLINED";
      row.reason = "candidate declined this specific role";
      row.source = "role_decline";
    }
    row.wouldSend = !row.blockedBy;
    // Latch what we just learned so the send path agrees with this report.
    const { patch, event } = assessmentPatch(assessment, {
      requestId,
      address: state.candidateEmail || null,
      repliedAt: state.repliedAt,
      stoppedReason: state.stoppedReason,
      state,
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
  requestId = null,
} = {}) {
  const review = await reviewHeldOutreach({ config, limit: 200, requestId });
  const batch = review.rows
    .filter((row) => row.wouldSend)
    .slice(0, Math.max(1, Math.min(10, Number(limit) || 5)));
  const history = await readSubmissionRequestHistory();
  const results = [];
  for (const row of batch) {
    const request = history.find((item) => item.id === row.requestId);
    if (!request || !REQUEST_STATUSES.has(request.status)) {
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
    // The diagnostic must take the same route as the send path, or it reports
    // a resolution the worker would never reach.
    linkedinUser: request.linkedinUser || "",
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
  // INCIDENT 2026-07-29. `contactRecoveryConfigured` was literally
  // `config.gmailConfigured`, so it reported the recovery path green for nine days
  // while the Calendar half of the corroboration could not run at all and every
  // candidate without a Paraform email was silently unsendable. It now requires
  // BOTH halves: the Gmail configuration flag AND a calendar observation that is
  // not known-broken. The observation is written by the discovery path itself and
  // refreshed by an explicit probe, so this can no longer be true by assumption.
  const capability = config.storeConfigured
    ? await getContactCapability().catch(() => null)
    : null;
  const result = {
    approved: config.approved,
    dryRun: config.dryRun,
    sendApproved: config.sendApproved,
    notBeforePinned: config.notBeforeMs != null,
    gmailConfigured: config.gmailConfigured,
    storeConfigured: config.storeConfigured,
    mailroomReliefConfigured: mailroomReliefConfig().configured,
    mailbox: config.mailbox,
    executionReady: outreachExecutionEnabled(config),
    // Three-state on purpose: false when Gmail is not configured, null when the
    // calendar half has not been observed yet, and only true on evidence. The old
    // field could only ever be true, which is exactly how it lied.
    contactRecoveryConfigured: config.gmailConfigured
      ? (capability ? capability.calendarOk === true : null)
      : false,
    contactRecovery: {
      gmailConfigured: config.gmailConfigured,
      calendarOk: capability ? capability.calendarOk === true : null,
      calendarCode: capability?.calendarCode || null,
      observedAt: capability?.observedAt || null,
      observedBy: capability?.source || null,
    },
    gmail: probe && config.gmailConfigured ? "checking" : null,
    store: probe && config.storeConfigured ? "checking" : null,
  };
  if (probe && config.gmailConfigured) {
    const calendar = await probeCalendarAccess(config.mailbox);
    result.contactRecovery = {
      ...result.contactRecovery,
      calendarOk: calendar.ok,
      calendarCode: calendar.code || null,
      calendarDetail: calendar.detail || null,
      observedAt: new Date().toISOString(),
      observedBy: "probe",
    };
    result.contactRecoveryConfigured = config.gmailConfigured && calendar.ok;
    if (config.storeConfigured) {
      await recordContactCapability({
        calendarOk: calendar.ok,
        calendarCode: calendar.code || null,
        source: "probe",
      }).catch(() => null);
    }
  }
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
