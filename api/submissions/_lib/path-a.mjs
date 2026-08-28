import { createHash } from "node:crypto";

import { trpcGet } from "../../paraai/_lib/core.mjs";
import {
  candidatePreferencesReady,
  confirmInterest,
  quickSubmitBlockingReasons,
  readQuickSubmitForm,
  readSubmissionRequests,
  REQUIRED_CANDIDATE_PREFERENCE_FIELDS,
  submitQuickSubmission,
  verifyRequestOutcome,
} from "../../paraai/_lib/reply-actions.mjs";
import { assemblePayload } from "../../paraai/_lib/reply-answers.mjs";
import { findJobForCandidate, prepareSubmission } from "../../paraai/_lib/reply.mjs";
import { listJobs } from "../../paraai/_lib/store.mjs";
import {
  claimSubmissionRequestAttempt,
  readSubmissionRequestClaim,
  releaseSubmissionRequestClaim,
} from "../../paraai/_lib/request-claim.mjs";
import {
  acquireRowLock,
  appendLedgerEvent,
  readLedger,
  readRowsSnapshot,
  releaseRowLock,
  writeRowsSnapshot,
} from "./store.mjs";

const text = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
const PHONE_SCREEN_BLOCKER = "This role requires that the candidate has been phone screened";

function codedError(code, message = code, status = 409, detail = null) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  error.detail = detail;
  return error;
}

export function normalizeEditedDraft(value = {}) {
  const answers = Array.isArray(value.question_answers) ? value.question_answers : [];
  return {
    great_fit_reason: text(value.great_fit_reason).slice(0, 5_000),
    open_ended_submission: text(value.open_ended_submission).slice(0, 8_000) || null,
    question_answers: answers.slice(0, 100).map((row) => ({
      question_id: text(row?.question_id).slice(0, 160),
      answer: text(row?.answer).slice(0, 5_000),
      grounded: row?.grounded !== false,
    })).filter((row) => row.question_id),
    salary_explanation: text(value.salary_explanation).slice(0, 1_000) || null,
    additional_notes: text(value.additional_notes).slice(0, 295) || null,
  };
}

const editTokens = (value) => new Set(text(value).toLowerCase().match(/[a-z0-9$%+#.'-]+/g) || []);
function groundedEdit(original, edited) {
  const source = editTokens(original);
  const proposed = text(edited);
  return [...editTokens(proposed)].every((token) => source.has(token)) ? proposed : null;
}

export function guardPathAEdits(originalRaw, editedRaw) {
  const original = normalizeEditedDraft(originalRaw);
  const edited = normalizeEditedDraft(editedRaw);
  const warnings = [];
  const keep = (field) => {
    const value = groundedEdit(original[field], edited[field]);
    if (value == null) warnings.push(`${field}_unsourced_edit_stripped`);
    return value == null ? original[field] : value;
  };
  const question_answers = original.question_answers.map((row) => {
    const edit = edited.question_answers.find((item) => item.question_id === row.question_id);
    if (!edit) return row;
    const answer = groundedEdit(row.answer, edit.answer);
    if (answer == null) warnings.push(`question_${row.question_id}_unsourced_edit_stripped`);
    return { ...row, answer: answer == null ? row.answer : answer };
  });
  return {
    draft: {
      ...original,
      great_fit_reason: keep("great_fit_reason"),
      open_ended_submission: keep("open_ended_submission") || null,
      salary_explanation: keep("salary_explanation") || null,
      additional_notes: keep("additional_notes") || null,
      question_answers,
    },
    warnings: [...new Set(warnings)],
  };
}

function splitPhoneScreenOverride(blockers = []) {
  const blocked = blockers.filter((reason) => reason !== PHONE_SCREEN_BLOCKER);
  const warnings = blockers.includes(PHONE_SCREEN_BLOCKER)
    ? ["No screening call is on record. The submission will state phone_screened=false."]
    : [];
  return { blocked, warnings };
}

function draftDigest(request, form, draft) {
  return createHash("sha256").update(JSON.stringify({
    requestId: request.id,
    roleId: request.roleId,
    formRoleId: form?.role?.id || null,
    draft,
  })).digest("hex");
}

async function liveRequest(body, { readRequestsImpl = readSubmissionRequests } = {}) {
  const requestId = text(body?.requestId);
  const candidateUserId = text(body?.candidateUserId);
  const roleId = text(body?.roleId);
  if (!requestId || !candidateUserId || !roleId) {
    throw codedError("SUBMISSION_ROW_REQUIRED", "requestId, candidateUserId and roleId are required", 400);
  }
  const requests = await readRequestsImpl();
  const request = requests.find((row) => row.id === requestId) || null;
  if (!request) throw codedError("SUBMISSION_REQUEST_NOT_FOUND", "submission request not found", 404);
  if (request.candidateUserId !== candidateUserId || request.roleId !== roleId) {
    throw codedError("SUBMISSION_ROW_CHANGED", "the request no longer belongs to this candidate and role", 409);
  }
  return { request, requests };
}

async function loadPrepared(request, {
  editedDraft = null,
  readFormImpl = readQuickSubmitForm,
  readPreferencesImpl = candidatePreferencesReady,
  readRoleSettingsImpl = (roleId) => trpcGet(
    "roleSettings.getRoleSettingsForRecruiters",
    { role_id: roleId },
  ),
  listJobsImpl = listJobs,
  prepareImpl = prepareSubmission,
} = {}) {
  const jobs = await listJobsImpl(500).catch(() => []);
  const job = findJobForCandidate(jobs, request.candidateUserId);
  // The legacy reply worker treats a failed preference read as ready so that a
  // transient Paraform failure does not stop reply triage. This human submit
  // path has a stricter contract: inability to prove readiness blocks the
  // click. Keep that distinction local to Submissions.
  const preferences = await readPreferencesImpl(
    request.candidateUserId,
    [...REQUIRED_CANDIDATE_PREFERENCE_FIELDS],
  );
  if (preferences.ready === false) {
    throw codedError(
      "SUBMISSION_BLOCKED",
      "candidate preferences are incomplete",
      409,
      preferences.missingFields,
    );
  }
  const roleSettings = await readRoleSettingsImpl(request.roleId);
  if (typeof roleSettings?.candidate_application_confirm_email !== "boolean") {
    throw codedError(
      "SUBMISSION_CONFIRMATION_SETTING_UNAVAILABLE",
      "Paraform's candidate-confirmation setting could not be verified",
      503,
    );
  }
  const paraformConfirmationExpected = roleSettings.candidate_application_confirm_email;
  if (!editedDraft) {
    const record = {
      candidateUserId: request.candidateUserId,
      candidateName: request.candidateName,
      decision: { evidence: "", conditions: [] },
    };
    const prepared = await prepareImpl(request, record, job, {});
    const split = splitPhoneScreenOverride(prepared.blocked || []);
    return {
      ...prepared,
      ...split,
      job,
      paraformConfirmationExpected,
      draft: normalizeEditedDraft(prepared.generated || {}),
    };
  }
  const record = {
    candidateUserId: request.candidateUserId,
    candidateName: request.candidateName,
    decision: { evidence: "", conditions: [] },
  };
  const originalPrepared = await prepareImpl(request, record, job, {});
  const splitOriginal = splitPhoneScreenOverride(originalPrepared.blocked || []);
  if (splitOriginal.blocked.length) {
    return {
      ...originalPrepared,
      ...splitOriginal,
      job,
      paraformConfirmationExpected,
      draft: normalizeEditedDraft(originalPrepared.generated || {}),
      editWarnings: [],
    };
  }
  const form = originalPrepared.form || await readFormImpl(request.id);
  const guarded = guardPathAEdits(originalPrepared.generated || {}, editedDraft);
  const draft = guarded.draft;
  const payload = assemblePayload({
    form,
    generated: draft,
    call: job ? { id: job.botId || job.id } : null,
    extracted: job?.extracted || null,
  });
  const split = splitPhoneScreenOverride(quickSubmitBlockingReasons(form, payload));
  return {
    form,
    payload,
    job,
    paraformConfirmationExpected,
    draft,
    editWarnings: guarded.warnings,
    ...split,
  };
}

export async function previewPathA(body, deps = {}) {
  const { request } = await liveRequest(body, deps);
  if (request.state !== "PENDING") {
    throw codedError("SUBMISSION_REQUEST_NOT_PENDING", "the request is no longer pending", 409);
  }
  const ledger = await (deps.readLedgerImpl || readLedger)(request.candidateUserId, request.roleId);
  if (ledger?.submittedAt) throw codedError("SUBMISSION_ALREADY_RECORDED", "this row is already submitted", 409);
  const prepared = await loadPrepared(request, deps);
  return {
    ok: true,
    request: {
      id: request.id,
      candidateName: request.candidateName,
      roleName: request.roleName,
      companyName: request.companyName,
      clientNote: request.clientNote,
    },
    source: prepared.job ? "screening call and Paraform profile" : "Paraform profile and role only",
    noCallOnRecord: !prepared.job,
    paraformConfirmationExpected: prepared.paraformConfirmationExpected,
    blocked: prepared.blocked,
    warnings: prepared.warnings,
    draft: prepared.draft,
    previewDigest: draftDigest(request, prepared.form, prepared.draft),
  };
}

async function mutationAttempt(request, payload, {
  submitImpl = submitQuickSubmission,
  verifyImpl = verifyRequestOutcome,
} = {}) {
  let mutationError = null;
  try {
    await submitImpl({ ...payload, submission_request_id: request.id });
  } catch (error) {
    mutationError = error;
  }
  let readback = null;
  let readbackError = null;
  try {
    readback = await verifyImpl(request.id, "submitted");
  } catch (error) {
    readbackError = error;
  }
  return { mutationError, readback, readbackError };
}

function provenAbsent(result) {
  return result?.readback?.verified === false
    && result.readback.row?.state === "PENDING"
    && !result.readback.row?.applicationId;
}

export async function submitPathA(body, deps = {}) {
  const { request } = await liveRequest(body, deps);
  if (request.state !== "PENDING") {
    const verified = request.applicationId || request.state === "SUBMITTED" || request.status === "submitted";
    if (verified) return { ok: true, verified: true, alreadySubmitted: true, applicationId: request.applicationId };
    throw codedError("SUBMISSION_REQUEST_NOT_PENDING", "the request is no longer pending", 409);
  }
  const prepared = await loadPrepared(request, { ...deps, editedDraft: body?.draft || {} });
  if (prepared.blocked.length) {
    throw codedError("SUBMISSION_BLOCKED", "the live Paraform form is blocked", 409, prepared.blocked);
  }
  const acquireLockImpl = deps.acquireLockImpl || acquireRowLock;
  const releaseLockImpl = deps.releaseLockImpl || releaseRowLock;
  const appendLedgerImpl = deps.appendLedgerImpl || appendLedgerEvent;
  const readLedgerImpl = deps.readLedgerImpl || readLedger;
  const claimImpl = deps.claimImpl || claimSubmissionRequestAttempt;
  const releaseClaimImpl = deps.releaseClaimImpl || releaseSubmissionRequestClaim;
  const token = await acquireLockImpl(request.candidateUserId, request.roleId);
  if (!token) throw codedError("SUBMISSION_BUSY", "another teammate is working on this row", 409);
  try {
    const ledger = await readLedgerImpl(request.candidateUserId, request.roleId);
    if (ledger?.submittedAt) {
      return { ok: true, verified: true, alreadySubmitted: true, applicationId: ledger.applicationId || null };
    }
    if (ledger?.dismissedAt) throw codedError("SUBMISSION_DISMISSED", "this row was dismissed", 409);

    let claim = await claimImpl(request.id, "submit", "submissions");
    if (claim.status !== "claimed") {
      throw codedError(
        "SUBMISSION_ALREADY_CLAIMED",
        `this request is already claimed by ${claim.claim?.lane || "another lane"}`,
        409,
      );
    }
    await appendLedgerImpl(request.candidateUserId, request.roleId, "submit_claimed", {
      by: body.by,
      path: "A",
      requestId: request.id,
      claimId: claim.claim.claimId,
      blockersAtClick: [],
      draftDigest: draftDigest(request, prepared.form, prepared.draft),
      editWarnings: prepared.editWarnings || [],
    });

    try {
      await (deps.confirmInterestImpl || confirmInterest)(request.id, {
        hasClientNote: Boolean(request.clientNote),
        recruiterResponse: null,
      });
    } catch (error) {
      const outcome = await (deps.verifyImpl || verifyRequestOutcome)(request.id, "submitted").catch(() => null);
      if (outcome?.verified) {
        const recorded = await appendLedgerImpl(request.candidateUserId, request.roleId, "submitted_verified", {
          by: body.by,
          path: "A",
          submittedAt: new Date().toISOString(),
          applicationId: outcome.row?.applicationId || null,
          readbackVerdict: "verified",
        });
        return { ok: true, verified: true, applicationId: recorded?.applicationId || null };
      }
      throw error;
    }

    let result = await mutationAttempt(request, prepared.payload, deps);
    if (result.readback?.verified) {
      const recorded = await appendLedgerImpl(request.candidateUserId, request.roleId, "submitted_verified", {
        by: body.by,
        path: "A",
        submittedAt: new Date().toISOString(),
        applicationId: result.readback.row?.applicationId || null,
        readbackVerdict: "verified",
      });
      return { ok: true, verified: true, applicationId: recorded?.applicationId || null, editWarnings: prepared.editWarnings || [] };
    }

    if (provenAbsent(result)) {
      await releaseClaimImpl(request.id, claim.claim.claimId, { lane: "submissions" });
      await appendLedgerImpl(request.candidateUserId, request.roleId, "retry_authorized_by_absent_readback", {
        by: body.by,
        path: "A",
        detail: "Paraform read-back remained pending with no application",
      });
      claim = await claimImpl(request.id, "submit", "submissions");
      if (claim.status !== "claimed") {
        throw codedError("SUBMISSION_RETRY_CLAIM_FAILED", "the bounded retry could not reclaim the request", 409);
      }
      result = await mutationAttempt(request, prepared.payload, deps);
      if (result.readback?.verified) {
        const recorded = await appendLedgerImpl(request.candidateUserId, request.roleId, "submitted_verified_after_retry", {
          by: body.by,
          path: "A",
          submittedAt: new Date().toISOString(),
          applicationId: result.readback.row?.applicationId || null,
          readbackVerdict: "verified_after_retry",
          claimId: claim.claim.claimId,
        });
        return { ok: true, verified: true, retried: true, applicationId: recorded?.applicationId || null, editWarnings: prepared.editWarnings || [] };
      }
    }

    const absent = provenAbsent(result);
    await appendLedgerImpl(request.candidateUserId, request.roleId, absent ? "submit_failed_proven_absent" : "submit_may_have_landed", {
      by: body.by,
      path: "A",
      readbackVerdict: absent ? "proven_absent_after_retry" : "ambiguous",
      claimId: claim.claim.claimId,
      detail: text(result.mutationError?.code || result.readbackError?.code || result.readback?.reason || "unverified"),
    });
    throw codedError(
      absent ? "SUBMISSION_FAILED_PROVEN_ABSENT" : "SUBMISSION_OUTCOME_AMBIGUOUS",
      absent
        ? "Paraform proved that neither attempt landed. Use Unclaim before another try."
        : "The submission may have landed. It was not retried.",
      502,
    );
  } finally {
    await releaseLockImpl(request.candidateUserId, request.roleId, token).catch(() => {});
  }
}

export async function dismissPathA(body, deps = {}) {
  const { request } = await liveRequest(body, deps);
  const lock = await (deps.acquireLockImpl || acquireRowLock)(request.candidateUserId, request.roleId);
  if (!lock) throw codedError("SUBMISSION_BUSY", "another teammate is working on this row", 409);
  try {
    const ledger = await (deps.readLedgerImpl || readLedger)(request.candidateUserId, request.roleId);
    if (ledger?.submittedAt) throw codedError("SUBMISSION_ALREADY_RECORDED", "submitted rows cannot be dismissed", 409);
    const dismissedAt = new Date().toISOString();
    const next = await (deps.appendLedgerImpl || appendLedgerEvent)(
      request.candidateUserId,
      request.roleId,
      "dismissed",
      {
        by: body.by,
        path: "A",
        dismissedAt,
        dismissReason: text(body.reason).slice(0, 240) || "Dismissed in Monitor",
      },
    );
    const readSnapshotImpl = deps.readSnapshotImpl || readRowsSnapshot;
    const writeSnapshotImpl = deps.writeSnapshotImpl || writeRowsSnapshot;
    const snapshot = await readSnapshotImpl().catch(() => null);
    if (snapshot) {
      await writeSnapshotImpl({
        ...snapshot,
        rows: (snapshot.rows || []).map((row) => row.key === body.key
          ? { ...row, state: "dismissed", ledger: next }
          : row),
      }).catch(() => {});
    }
    return { ok: true, dismissedAt: next.dismissedAt };
  } finally {
    await (deps.releaseLockImpl || releaseRowLock)(request.candidateUserId, request.roleId, lock).catch(() => {});
  }
}

export async function undoDismissPathA(body, deps = {}) {
  const { request } = await liveRequest(body, deps);
  const acquireLockImpl = deps.acquireLockImpl || acquireRowLock;
  const releaseLockImpl = deps.releaseLockImpl || releaseRowLock;
  const token = await acquireLockImpl(request.candidateUserId, request.roleId);
  if (!token) throw codedError("SUBMISSION_BUSY", "another teammate is working on this row", 409);
  const readLedgerImpl = deps.readLedgerImpl || readLedger;
  const appendLedgerImpl = deps.appendLedgerImpl || appendLedgerEvent;
  const readSnapshotImpl = deps.readSnapshotImpl || readRowsSnapshot;
  const writeSnapshotImpl = deps.writeSnapshotImpl || writeRowsSnapshot;
  try {
    const ledger = await readLedgerImpl(request.candidateUserId, request.roleId);
    if (!ledger?.dismissedAt) throw codedError("DISMISS_NOT_FOUND", "this row is not dismissed", 409);
    const snapshot = await readSnapshotImpl().catch(() => null);
    if (!snapshot || Date.parse(snapshot.generatedAt || "") > Date.parse(ledger.dismissedAt)) {
      throw codedError("DISMISS_UNDO_WINDOW_CLOSED", "the next sweep has already made this dismissal final", 409);
    }
    const next = await appendLedgerImpl(request.candidateUserId, request.roleId, "dismiss_undone", {
      by: body.by,
      path: "A",
      dismissedAt: null,
      dismissReason: null,
    });
    await writeSnapshotImpl({
      ...snapshot,
      rows: (snapshot.rows || []).map((row) => row.key === body.key
        ? { ...row, state: request.state === "PENDING" ? "requested" : "blocked", ledger: next }
        : row),
    });
    return { ok: true, undone: true };
  } finally {
    await releaseLockImpl(request.candidateUserId, request.roleId, token).catch(() => {});
  }
}

export async function unclaimPathA(body, deps = {}) {
  const { request } = await liveRequest(body, deps);
  if (request.state !== "PENDING" || request.applicationId) {
    throw codedError("UNCLAIM_READBACK_NOT_ABSENT", "Paraform does not prove this request is unsubmitted", 409);
  }
  const claim = await (deps.readClaimImpl || readSubmissionRequestClaim)(request.id);
  if (!claim) throw codedError("UNCLAIM_NOT_NEEDED", "this request has no claim", 409);
  if (claim.namespace !== "request-claim" || claim.lane !== "submissions") {
    throw codedError("UNCLAIM_FORBIDDEN", "this claim belongs to another submission lane", 409);
  }
  await (deps.releaseClaimImpl || releaseSubmissionRequestClaim)(
    request.id,
    claim.claimId,
    { lane: "submissions" },
  );
  await (deps.appendLedgerImpl || appendLedgerEvent)(request.candidateUserId, request.roleId, "claim_released", {
    by: body.by,
    path: "A",
    detail: "Typed operator unclaim after live pending/no-application read-back",
  });
  return { ok: true, released: true };
}

export { PHONE_SCREEN_BLOCKER, codedError, liveRequest, loadPrepared, mutationAttempt, provenAbsent };
