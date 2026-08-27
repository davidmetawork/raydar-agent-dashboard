import { createHash } from "node:crypto";

import { linkedinHandle, normalizeEmail, paraformRest, trpcGet, trpcPost } from "../../paraai/_lib/core.mjs";
import {
  duplicateSubmissionBlockers,
  executeCapturedSingleSubmission,
  generateGroundedSubmissionDraft,
  parseSingleSubmissionPrepareResponse,
  precheckCapturedSingleSubmissionContext,
  singleSubmissionLedgerSnapshot,
  singleSubmissionWeekStart,
  buildSingleSubmissionPrepareInput,
} from "../../paraai/_lib/interest-submission.mjs";
import {
  claimSubmissionAttempt,
  getSubmissionClaim,
  recordSubmissionOutcome,
  recordSubmissionPrepared,
  releaseSubmissionClaim,
} from "../../paraai/_lib/interest-store.mjs";
import { findJobForCandidate } from "../../paraai/_lib/reply.mjs";
import { listJobs } from "../../paraai/_lib/store.mjs";
import {
  acquireRowLock,
  appendLedgerEvent,
  readLedger,
  readRowsSnapshot,
  releaseRowLock,
  writeRowsSnapshot,
} from "./store.mjs";
import { createPacedReader } from "./sync.mjs";
import { codedError } from "./path-a.mjs";

const text = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function digest(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function publicDraft(draft = {}) {
  return {
    oneLiner: text(draft.oneLiner).slice(0, 140),
    greatFitReason: text(draft.greatFitReason).slice(0, 5_000),
    additionalInfo: text(draft.additionalInfo).slice(0, 5_000),
    jobHopperExplanation: text(draft.jobHopperExplanation).slice(0, 1_000),
    attributes: (Array.isArray(draft.attributes) ? draft.attributes : []).slice(0, 100).map((row) => ({
      requirementId: text(row?.requirementId).slice(0, 160),
      name: text(row?.name).slice(0, 500),
      rating: [1, 3, 5].includes(Number(row?.rating)) ? Number(row.rating) : 3,
      comment: text(row?.comment).slice(0, 500),
    })),
    questionAnswers: (Array.isArray(draft.questionAnswers) ? draft.questionAnswers : []).slice(0, 100).map((row) => ({
      questionId: text(row?.questionId).slice(0, 160),
      answer: text(row?.answer).slice(0, 5_000),
    })),
    rating: 3,
  };
}

const tokens = (value) => new Set(text(value).toLowerCase().match(/[a-z0-9$%+#.'-]+/g) || []);
function groundedEdit(original, edited) {
  const source = tokens(original);
  const proposed = text(edited);
  return [...tokens(proposed)].every((token) => source.has(token)) ? proposed : null;
}

export function guardHumanEdits(originalRaw, editedRaw) {
  const original = publicDraft(originalRaw);
  const edited = publicDraft(editedRaw);
  const warnings = [];
  const keep = (field) => {
    const value = groundedEdit(original[field], edited[field]);
    if (value == null) warnings.push(`${field}_unsourced_edit_stripped`);
    return value == null ? original[field] : value;
  };
  const attributes = original.attributes.map((row) => {
    const edit = edited.attributes.find((item) => item.requirementId === row.requirementId);
    if (!edit) return row;
    const comment = groundedEdit(row.comment, edit.comment);
    if (comment == null) warnings.push(`attribute_${row.requirementId}_unsourced_edit_stripped`);
    return { ...row, rating: edit.rating, comment: comment == null ? row.comment : comment };
  });
  const questionAnswers = original.questionAnswers.map((row) => {
    const edit = edited.questionAnswers.find((item) => item.questionId === row.questionId);
    if (!edit) return row;
    const answer = groundedEdit(row.answer, edit.answer);
    if (answer == null) warnings.push(`question_${row.questionId}_unsourced_edit_stripped`);
    return { ...row, answer: answer == null ? row.answer : answer };
  });
  const draft = {
    ...original,
    oneLiner: keep("oneLiner"),
    greatFitReason: keep("greatFitReason"),
    additionalInfo: keep("additionalInfo"),
    jobHopperExplanation: keep("jobHopperExplanation"),
    attributes,
    questionAnswers,
  };
  return { draft, warnings: [...new Set(warnings)] };
}

function candidateFromProfile(candidateUserId, value = {}, fallbackName = "Candidate") {
  const candidate = value?.candidate || {};
  const email = [
    ...(Array.isArray(value?.emails) ? value.emails : []),
    candidate?.email,
  ].map((item) => normalizeEmail(typeof item === "object" ? item?.email ?? item?.value ?? "" : item))
    .find(Boolean) || null;
  return {
    candidateUserId,
    candidateId: candidate?.id || value?.candidate_id || null,
    name: candidate?.name || value?.name || fallbackName,
    email,
    linkedinUser: linkedinHandle(candidate?.linkedin_user || value?.linkedin_user || "") || null,
    hasResume: Boolean(
      value?.resume_id
      || value?.latest_application_resume_id
      || candidate?.resume_id,
    ),
  };
}

async function liveRow(body, { readSnapshotImpl = readRowsSnapshot } = {}) {
  const snapshot = await readSnapshotImpl();
  if (!snapshot || snapshot.trustworthy === false) {
    throw codedError("SUBMISSIONS_SNAPSHOT_UNHEALTHY", "the cached list is not trustworthy", 503);
  }
  const row = (snapshot.rows || []).find((item) => item.key === body?.key) || null;
  if (!row || row.path !== "B") throw codedError("SUBMISSION_ROW_NOT_FOUND", "Path B row not found", 404);
  if (row.candidateUserId !== body.candidateUserId || row.roleId !== body.roleId) {
    throw codedError("SUBMISSION_ROW_CHANGED", "the row identity changed", 409);
  }
  return { row, snapshot };
}

function serialIo(deps = {}) {
  const paced = createPacedReader({
    paceMs: deps.paceMs ?? 1_400,
    sleepImpl: deps.sleepImpl || sleep,
  });
  const get = deps.trpcGetImpl || trpcGet;
  const post = deps.trpcPostImpl || trpcPost;
  const rest = deps.restImpl || paraformRest;
  return {
    get: (procedure, input, tries) => paced(() => get(procedure, input, tries)),
    post: (procedure, input, tries) => paced(() => post(procedure, input, tries)),
    rest: (path, options) => paced(() => rest(path, options)),
  };
}

async function prepareDraft(row, deps = {}) {
  const io = serialIo(deps);
  const profile = await io.get("candidateUser.getCandidateUserById", {
    candidate_user_id: row.candidateUserId,
  });
  const candidate = candidateFromProfile(row.candidateUserId, profile, row.candidateName);
  if (!candidate.hasResume) {
    throw codedError("SUBMISSION_BLOCKED", "candidate resume is missing", 409, ["submission_resume_missing"]);
  }
  const precheck = await (deps.precheckImpl || precheckCapturedSingleSubmissionContext)({
    candidate,
    roleId: row.roleId,
    trpcGetImpl: io.get,
    trpcPostImpl: io.post,
    restImpl: io.rest,
    advisoryCredits: true,
  });
  if (!precheck.ok) {
    throw codedError("SUBMISSION_BLOCKED", "the live Paraform checks block this row", 409, precheck.blockers);
  }
  const generated = await (deps.draftImpl || generateGroundedSubmissionDraft)({
    candidate,
    roleId: row.roleId,
    trpcGetImpl: io.get,
    fetchImpl: deps.fetchImpl || fetch,
    env: deps.env || process.env,
  });
  if (!generated?.ok || !generated?.draft) {
    throw codedError("SUBMISSION_DRAFT_BLOCKED", "a grounded submission draft could not be built", 409, generated?.blockers || []);
  }
  const jobs = await (deps.listJobsImpl || listJobs)(500).catch(() => []);
  return {
    candidate,
    precheck,
    draft: publicDraft(generated.draft),
    hasCall: Boolean(findJobForCandidate(jobs, row.candidateUserId)),
    io,
  };
}

export async function previewPathB(body, deps = {}) {
  const { row } = await liveRow(body, deps);
  if (!["ready", "blocked"].includes(row.state)) {
    throw codedError("SUBMISSION_ROW_NOT_READY", "this row is not awaiting submission", 409);
  }
  const prepared = await prepareDraft(row, deps);
  return {
    ok: true,
    path: "B",
    source: prepared.hasCall ? "screening call and Paraform profile" : "Paraform profile and role only",
    noCallOnRecord: !prepared.hasCall,
    paraformConfirmationExpected:
      prepared.precheck.signals?.paraformConfirmationExpected ?? null,
    warnings: prepared.hasCall ? [] : ["No screening call is on record. The submission will state phone_screened=false."],
    blocked: [],
    draft: prepared.draft,
    previewDigest: digest(prepared.draft),
  };
}

export async function provePathBAbsent(candidate, roleId, deps = {}) {
  const io = deps.io || serialIo(deps);
  try {
    const role = await io.get("role.getRoleByIdSimple", { role_id: roleId, id: roleId });
    const duplicates = await io.post("submission.checkDuplicates", {
      role_id: roleId,
      email: normalizeEmail(candidate.email || ""),
      linkedin_user: candidate.linkedinUser,
    }, 1);
    const companySubmitted = role?.companyId
      ? await io.get("candidates.hasCandidateBeenSubmittedToCompany", {
        candidate_linkedin: candidate.linkedinUser,
        company_id: role.companyId,
      })
      : null;
    const ledgerRaw = await io.get("roleSlots.getMySingleSubmissionData", {
      weekStart: singleSubmissionWeekStart(new Date()),
    });
    const ledger = singleSubmissionLedgerSnapshot(ledgerRaw);
    const recent = ledger.rows.some((row) => (
      row.roleId === roleId && row.candidateUserId === candidate.candidateUserId
    ));
    const duplicate = duplicateSubmissionBlockers(duplicates).length > 0;
    return {
      absent: companySubmitted === false && !duplicate && !recent,
      signals: { companySubmitted, duplicate, recent },
    };
  } catch {
    return { absent: false, signals: { readFailed: true } };
  }
}

export async function submitPathB(body, deps = {}) {
  const { row } = await liveRow(body, deps);
  const prepared = await prepareDraft(row, deps);
  const guarded = guardHumanEdits(prepared.draft, body?.draft || {});
  const lock = await (deps.acquireLockImpl || acquireRowLock)(row.candidateUserId, row.roleId);
  if (!lock) throw codedError("SUBMISSION_BUSY", "another teammate is working on this row", 409);
  const append = deps.appendLedgerImpl || appendLedgerEvent;
  try {
    const ledger = await (deps.readLedgerImpl || readLedger)(row.candidateUserId, row.roleId);
    if (ledger?.submittedAt) return { ok: true, verified: true, alreadySubmitted: true, applicationId: ledger.applicationId || null };
    if (ledger?.dismissedAt) throw codedError("SUBMISSION_DISMISSED", "this row was dismissed", 409);
    const store = deps.submissionStore || {
      claimSubmissionAttempt,
      getSubmissionClaim,
      recordSubmissionPrepared,
      recordSubmissionOutcome,
    };
    const claim = await store.claimSubmissionAttempt(row.candidateUserId, row.roleId, {
      roleId: row.roleId,
      lane: "submissions",
      by: text(body.by).slice(0, 160),
    });
    if (claim.status !== "started") {
      throw codedError("SUBMISSION_ALREADY_CLAIMED", "this candidate-role pair is already claimed", 409);
    }
    const attemptId = claim.claim.attemptId;
    await append(row.candidateUserId, row.roleId, "submit_claimed", {
      by: body.by,
      path: "B",
      claimId: attemptId,
      blockersAtClick: [],
      payloadDigest: digest(guarded.draft),
    });
    let prepareResponse;
    try {
      prepareResponse = await prepared.io.post("roleSlots.prepareForSingleSubmission", buildSingleSubmissionPrepareInput({
        roleId: row.roleId,
        candidateUserId: row.candidateUserId,
        linkedinUser: prepared.candidate.linkedinUser,
        anonymizeCandidates: false,
        roleDiscoverySource: "CURATED_LIST",
      }), 1);
    } catch {
      await store.recordSubmissionOutcome(row.candidateUserId, row.roleId, "submission_unknown", {
        attemptId, detail: "prepare mutation transport result unknown",
      });
      await append(row.candidateUserId, row.roleId, "submit_may_have_landed", {
        by: body.by, path: "B", claimId: attemptId, detail: "prepare result unknown",
      });
      throw codedError("SUBMISSION_OUTCOME_AMBIGUOUS", "the prepare step may have landed; it was not retried", 502);
    }
    const parsed = parseSingleSubmissionPrepareResponse(prepareResponse);
    if (!parsed.ok) {
      await store.recordSubmissionOutcome(row.candidateUserId, row.roleId, "contract_unconfirmed", {
        attemptId, detail: "prepare response failed captured contract",
      });
      throw codedError("SUBMISSION_PREPARE_CONTRACT_UNCONFIRMED", "Paraform's prepare response no longer matches the captured contract", 502);
    }
    await store.recordSubmissionPrepared(
      row.candidateUserId,
      row.roleId,
      attemptId,
      parsed.candidateToApprovedRoleId,
    );
    const execute = deps.executeImpl || executeCapturedSingleSubmission;
    const executeOnce = () => execute({
      candidate: prepared.candidate,
      roleId: row.roleId,
      candidateToApprovedRoleId: parsed.candidateToApprovedRoleId,
      submissionDraft: guarded.draft,
      preflightSignals: {},
      trpcGetImpl: prepared.io.get,
      trpcPostImpl: prepared.io.post,
      restImpl: prepared.io.rest,
      advisoryCredits: true,
      phoneScreened: prepared.hasCall,
    });
    let result = await executeOnce();
    if (result?.verified === true) {
      await store.recordSubmissionOutcome(row.candidateUserId, row.roleId, "accepted", { attemptId, detail: "final mutation returned" });
      await store.recordSubmissionOutcome(row.candidateUserId, row.roleId, "verified", { attemptId, detail: "authoritative readback verified" });
      await append(row.candidateUserId, row.roleId, "submitted_verified", {
        by: body.by, path: "B", submittedAt: new Date().toISOString(), applicationId: result.applicationId || null,
        readbackVerdict: "verified", editWarnings: guarded.warnings,
      });
      return { ok: true, verified: true, applicationId: result.applicationId || null, editWarnings: guarded.warnings };
    }
    const outcome = result?.mutationAttempted === false ? "contract_unconfirmed" : "submission_unknown";
    await store.recordSubmissionOutcome(row.candidateUserId, row.roleId, outcome, {
      attemptId,
      detail: result?.mutationAttempted === false ? "captured submit preconditions not satisfied" : "final mutation not authoritatively verified",
    });
    let provenAbsent = false;
    if (result?.mutationAttempted === true && !result?.applicationId) {
      const proof = await (deps.proveAbsentImpl || provePathBAbsent)(prepared.candidate, row.roleId, { ...deps, io: prepared.io });
      if (proof.absent) {
        await append(row.candidateUserId, row.roleId, "retry_authorized_by_absent_readback", {
          by: body.by, path: "B", detail: "No duplicate, company submission, or recent ledger row exists",
        });
        result = await executeOnce();
        if (result?.verified === true) {
          await store.recordSubmissionOutcome(row.candidateUserId, row.roleId, "verified", { attemptId, detail: "bounded retry readback verified" });
          await append(row.candidateUserId, row.roleId, "submitted_verified_after_retry", {
            by: body.by, path: "B", submittedAt: new Date().toISOString(), applicationId: result.applicationId || null,
            readbackVerdict: "verified_after_retry", editWarnings: guarded.warnings,
          });
          return { ok: true, verified: true, retried: true, applicationId: result.applicationId || null, editWarnings: guarded.warnings };
        }
        if (result?.mutationAttempted === true && !result?.applicationId) {
          const finalProof = await (deps.proveAbsentImpl || provePathBAbsent)(prepared.candidate, row.roleId, { ...deps, io: prepared.io });
          provenAbsent = finalProof.absent === true;
        }
      }
    }
    if (result?.mutationAttempted === false) {
      await append(row.candidateUserId, row.roleId, "submit_blocked_at_final_precheck", {
        by: body.by,
        path: "B",
        claimId: attemptId,
        readbackVerdict: "not_attempted",
        detail: (result?.blockers || []).join(", ").slice(0, 240),
      });
      throw codedError(
        "SUBMISSION_BLOCKED",
        "Paraform's final live checks blocked the submission before the application write",
        409,
        result?.blockers || [],
      );
    }
    await append(row.candidateUserId, row.roleId, provenAbsent ? "submit_failed_proven_absent" : "submit_may_have_landed", {
      by: body.by,
      path: "B",
      claimId: attemptId,
      readbackVerdict: provenAbsent ? "proven_absent_after_retry" : "ambiguous",
      detail: (result?.blockers || []).join(", ").slice(0, 240),
    });
    throw codedError(
      provenAbsent ? "SUBMISSION_FAILED_PROVEN_ABSENT" : "SUBMISSION_OUTCOME_AMBIGUOUS",
      provenAbsent ? "Paraform proved no submission landed; use Unclaim before trying again" : "the submission may have landed; it was not retried",
      502,
      result?.blockers || [],
    );
  } finally {
    await (deps.releaseLockImpl || releaseRowLock)(row.candidateUserId, row.roleId, lock).catch(() => {});
  }
}

export async function unclaimPathB(body, deps = {}) {
  const { row } = await liveRow(body, deps);
  const prepared = await prepareDraft(row, { ...deps, draftImpl: async () => ({ ok: true, draft: {} }) });
  const claim = await (deps.getClaimImpl || getSubmissionClaim)(row.candidateUserId, row.roleId);
  if (!claim) throw codedError("UNCLAIM_NOT_NEEDED", "this row has no Path B claim", 409);
  if (claim.lane !== "submissions") throw codedError("UNCLAIM_FORBIDDEN", "this claim belongs to another lane", 409);
  const proof = await (deps.proveAbsentImpl || provePathBAbsent)(prepared.candidate, row.roleId, { ...deps, io: prepared.io });
  if (!proof.absent) throw codedError("UNCLAIM_READBACK_NOT_ABSENT", "Paraform does not prove this pair is unsubmitted", 409);
  await (deps.releaseClaimImpl || releaseSubmissionClaim)(
    row.candidateUserId,
    row.roleId,
    claim.attemptId,
    { lane: "submissions" },
  );
  await (deps.appendLedgerImpl || appendLedgerEvent)(row.candidateUserId, row.roleId, "claim_released", {
    by: body.by,
    path: "B",
    detail: "Typed operator unclaim after live duplicate/company/ledger absence proof",
  });
  return { ok: true, released: true };
}

export async function dismissPathB(body, deps = {}) {
  const { row, snapshot } = await liveRow(body, deps);
  const acquireLockImpl = deps.acquireLockImpl || acquireRowLock;
  const releaseLockImpl = deps.releaseLockImpl || releaseRowLock;
  const lock = await acquireLockImpl(row.candidateUserId, row.roleId);
  if (!lock) throw codedError("SUBMISSION_BUSY", "another teammate is working on this row", 409);
  try {
    const ledger = await (deps.readLedgerImpl || readLedger)(row.candidateUserId, row.roleId);
    if (ledger?.submittedAt) throw codedError("SUBMISSION_ALREADY_RECORDED", "submitted rows cannot be dismissed", 409);
    const next = await (deps.appendLedgerImpl || appendLedgerEvent)(row.candidateUserId, row.roleId, "dismissed", {
      by: body.by,
      path: "B",
      dismissedAt: new Date().toISOString(),
      dismissReason: text(body.reason).slice(0, 240) || "Dismissed in Monitor",
    });
    await (deps.writeSnapshotImpl || writeRowsSnapshot)({
      ...snapshot,
      rows: (snapshot.rows || []).map((item) => item.key === row.key
        ? { ...item, state: "dismissed", ledger: next }
        : item),
    });
    return { ok: true, dismissedAt: next.dismissedAt };
  } finally {
    await releaseLockImpl(row.candidateUserId, row.roleId, lock).catch(() => {});
  }
}

export async function undoDismissPathB(body, deps = {}) {
  const snapshot = await (deps.readSnapshotImpl || readRowsSnapshot)();
  const row = (snapshot?.rows || []).find((item) => item.key === body?.key) || null;
  const candidateUserId = row?.candidateUserId || text(body?.candidateUserId);
  const roleId = row?.roleId || text(body?.roleId);
  if (!candidateUserId || !roleId) throw codedError("SUBMISSION_ROW_NOT_FOUND", "Path B row not found", 404);
  const acquireLockImpl = deps.acquireLockImpl || acquireRowLock;
  const releaseLockImpl = deps.releaseLockImpl || releaseRowLock;
  const lock = await acquireLockImpl(candidateUserId, roleId);
  if (!lock) throw codedError("SUBMISSION_BUSY", "another teammate is working on this row", 409);
  try {
    const ledger = await (deps.readLedgerImpl || readLedger)(candidateUserId, roleId);
    if (!ledger?.dismissedAt) throw codedError("DISMISS_NOT_FOUND", "this row is not dismissed", 409);
    if (!row || Date.parse(snapshot?.generatedAt || "") > Date.parse(ledger.dismissedAt)) {
      throw codedError("DISMISS_UNDO_WINDOW_CLOSED", "the next sweep has already made this dismissal final", 409);
    }
    const next = await (deps.appendLedgerImpl || appendLedgerEvent)(candidateUserId, roleId, "dismiss_undone", {
      by: body.by, path: "B", dismissedAt: null, dismissReason: null,
    });
    await (deps.writeSnapshotImpl || writeRowsSnapshot)({
      ...snapshot,
      rows: (snapshot.rows || []).map((item) => item.key === row.key
        ? { ...item, state: item.blockers?.length ? "blocked" : "ready", ledger: next }
        : item),
    });
    return { ok: true, undone: true };
  } finally {
    await releaseLockImpl(candidateUserId, roleId, lock).catch(() => {});
  }
}

export { liveRow, prepareDraft, publicDraft };
