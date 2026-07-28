// The Paraform read/write surface for expired ParaAI matches, driven from the
// contract captured read-only on 2026-07-28 (docs/PARAAI-EXPIRED-CAPTURE-
// 2026-07-28.md in the main Raydar repo).
//
// What the capture settled, and why the code looks like this:
//
//   * Expiry is SERVER state, not a local clock. A row carries
//     state="EXPIRED" / status="expired" / status_label="Expired" /
//     filterBucket="expired". The home page classifies purely on
//     status === "expired", so this lane does too. No created_at arithmetic is
//     ever allowed to authorise a write.
//   * The Expired card's "Add reason" button fires exactly the mutation the
//     reply lane's pass path already uses:
//         submissionRequest.dismissSubmissionRequest({ id, dismissReason })
//     Rejecting a pending row and adding a reason to an expired row share one
//     handler; the expired path passes no explicitlyUpdatedFields.
//   * The reason is a fixed four-chip vocabulary rendered as "What happened?",
//     sent verbatim as dismissReason ("Other" swaps in free text). The chips
//     are reproduced byte-for-byte in EXPIRED_REASONS.
//   * "Late submit" is the ordinary quick-submit path behind a warning dialog,
//     so it stays available while the row is expired and disappears once the
//     row leaves the expired bucket. This lane never fires it.
import { trpcGet, trpcPost } from "./core.mjs";
import { normalizeRequestRow, EXPIRY_DAYS } from "./reply-actions.mjs";
import { claimSubmissionRequest, readSubmissionRequestClaim } from "./request-claim.mjs";

// One clock for both lanes: two independently configured expiry boundaries
// could each believe the same request belongs to them.
export const EXPIRATION_DAYS = EXPIRY_DAYS;

// Verbatim from the "What happened?" chip list. These strings are shown to the
// hiring manager, so they are Paraform's own words, never ours.
export const EXPIRED_REASONS = Object.freeze({
  not_interested: "Candidate not interested",
  no_response: "Candidate didn't get back",
  too_many_processes: "In too many processes",
});

export const DEFAULT_EXPIRED_REASON_KEY = "no_response";

export function expiredReasonText(key) {
  return EXPIRED_REASONS[key] || EXPIRED_REASONS[DEFAULT_EXPIRED_REASON_KEY];
}

function codedError(code, message = code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

const text = (value) => String(value ?? "").replace(/\s+/g, " ").trim();

// The lane needs three fields the reply lane's normalizer drops: the contact
// evidence that makes "didn't get back" a true statement, and the server's own
// bucket label.
export function normalizeExpiredRow(row) {
  return {
    ...normalizeRequestRow(row),
    statusLabel: text(row?.status_label) || null,
    filterBucket: String(row?.filterBucket || "").toLowerCase() || null,
    reachedOut: row?.reached_out_to_candidate === true,
    reachedOutAt: text(row?.reached_out_to_candidate_at) || null,
    sentToUserId: text(row?.sent_to_user_id) || null,
    hiringManagerName: text(row?.hiringManagerName) || null,
  };
}

// Returns the full envelope, not just rows: counts.expired and
// currentUserExpiredCount are the pause economics this lane exists to move, and
// the reply lane's reader throws them away.
export async function readSubmissionRequestHistory() {
  const result = await trpcGet("submissionRequest.getRecruiterSubmissionRequestHistory", {
    agencyView: false,
    recruiterFilter: [],
  });
  const rawRows = Array.isArray(result) ? result : (result?.requests || []);
  return {
    rows: rawRows.map(normalizeExpiredRow).filter((row) => row.id),
    counts: result?.counts || null,
    stageCounts: result?.stageCounts || null,
    currentUserId: text(result?.currentUserId) || null,
    currentUserExpiredCount: Number.isFinite(Number(result?.currentUserExpiredCount))
      ? Number(result.currentUserExpiredCount)
      : null,
  };
}

// The authoritative pause read. Paraform's own tooltip: "ParaAI is temporarily
// paused due to unresolved expired matches. The recruiter can self-resolve by
// actioning their expired matches."
export async function readParaAiStatus() {
  const result = await trpcGet("submissionRequest.getRecruiterParaAIStatus", {});
  return {
    disabled: result?.isParaAIDisabled === true,
    matchingStatus: text(result?.paraAIMatchingStatus) || null,
    countsTowardsChallenge: result?.paraAICountsTowardsChallenge === true,
    talentNetworkEnabled: result?.isTalentNetworkEnabled === true,
  };
}

// Server truth only. A row is this lane's business when Paraform says it is
// expired — never because our clock thinks seven days elapsed.
export function isExpiredRow(row) {
  return row?.status === "expired" || row?.state === "EXPIRED";
}

export function expiredRows(rows, currentUserId = null) {
  return rows.filter((row) => {
    if (!isExpiredRow(row)) return false;
    // Belt-and-braces: the agencyView:false read was currentUser-scoped across
    // all 306 live rows at capture, but canAccessAgencyView is true on this
    // account, so never dismiss a row we cannot prove is ours.
    if (currentUserId && row.sentToUserId && row.sentToUserId !== currentUserId) return false;
    return true;
  });
}

// When Paraform flipped the row to expired, derived from its own constant. Used
// only for pacing decisions (the arming pin and the optional hold window) —
// never to decide that a row IS expired.
export function expiredAtMs(row, days = EXPIRATION_DAYS) {
  if (!row?.createdAtMs) return null;
  return row.createdAtMs + days * 24 * 60 * 60 * 1000;
}

// Truth is the re-read row, never the mutation response. A dismissed row leaves
// the expired bucket entirely: status becomes "dismissed" and state "DISMISSED".
export async function verifyDismissed(requestId) {
  const { rows, currentUserExpiredCount } = await readSubmissionRequestHistory();
  const row = rows.find((candidate) => candidate.id === requestId) || null;
  if (!row) return { verified: false, row: null, currentUserExpiredCount, reason: "request_row_missing" };
  const verified = row.status === "dismissed" || row.state === "DISMISSED";
  return {
    verified,
    row,
    currentUserExpiredCount,
    reason: verified ? null : `state_is_${row.status || row.state}`,
  };
}

// Claim, one attempt, prove by read-back. Identical discipline to the reply
// lane's pass, but the claim is the neutral cross-lane one so the reply lane
// can never also act on this request.
export async function performExpiredDismiss(row, reasonKey, { claim = true, lane = "expired" } = {}) {
  const reason = expiredReasonText(reasonKey);
  if (claim && !(await claimSubmissionRequest(row.id, "expired_dismiss", lane))) {
    const existing = await readSubmissionRequestClaim(row.id);
    throw codedError(
      "EXPIRED_ALREADY_CLAIMED",
      `request already actioned as ${existing?.action || "unknown"} by ${existing?.lane || existing?.namespace || "another lane"}`,
    );
  }
  const before = await readParaAiStatus().catch(() => null);
  let dismissError = null;
  try {
    await trpcPost("submissionRequest.dismissSubmissionRequest", {
      id: row.id,
      dismissReason: reason,
    }, 1);
  } catch (error) {
    if (error?.code === "AUTH_EXPIRED") throw error;
    dismissError = error;
  }
  const outcome = await verifyDismissed(row.id);
  if (outcome.verified) {
    const after = await readParaAiStatus().catch(() => null);
    return {
      ok: true,
      verified: true,
      reason,
      row: outcome.row,
      expiredCountAfter: outcome.currentUserExpiredCount,
      paraAiBefore: before,
      paraAiAfter: after,
    };
  }
  if (dismissError) throw dismissError;
  // Wrote without a verifiable state change: never retried, always surfaced.
  throw codedError("EXPIRED_DISMISS_UNVERIFIED", `dismissal not verified by read-back (${outcome.reason})`);
}
