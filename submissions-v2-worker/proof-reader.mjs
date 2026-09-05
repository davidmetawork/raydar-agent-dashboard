import { trpcGet } from "../api/paraai/_lib/core.mjs";
import { canonicalJson, sha256 } from "../api/submissions-v2/_lib/resume/source-bundle.mjs";

const clean = (value, limit = 500) => String(value ?? "").trim().slice(0, limit);
const explicit = (value, keys) => keys.map((key) => clean(value?.[key])).find(Boolean) || null;
const sourceShapeError = (code, message) => Object.assign(new Error(message), { code, retryable: true });
const instant = (value) => Number.isFinite(Date.parse(String(value || "")))
  ? new Date(value).toISOString()
  : null;
const MAX_EXACT_ROLE_APPLICATIONS = 3;

const SUBMITTED_STATES = new Set([
  "SUBMITTED", "INTERVIEWING", "INTERVIEW", "ACCEPTED", "REJECTED", "HIRED", "OFFER", "OFFERED",
]);

function candidateApplicationRows(value, scopedCandidateUserId) {
  if (!Array.isArray(value)) {
    throw sourceShapeError("candidate_applications_shape_invalid", "Paraform candidate applications returned an unrecognized success payload.");
  }
  return value.map((row) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      throw sourceShapeError("candidate_application_row_invalid", "Paraform candidate applications returned an invalid row.");
    }
    const candidateUser = row.candidate_user || row.candidateUser || {};
    const candidateUserId = explicit(row, ["candidate_user_id", "candidateUserId"])
      || explicit(candidateUser, ["candidate_user_id", "candidateUserId", "id"]);
    if (candidateUserId && candidateUserId !== scopedCandidateUserId) {
      throw sourceShapeError("candidate_application_scope_conflict", "Paraform candidate applications returned a row for a conflicting candidate identity.");
    }
    const role = row.role || {};
    const applicationId = explicit(row, ["id", "application_id", "applicationId"]);
    const roleId = explicit(row, ["role_id", "roleId"]) || explicit(role, ["role_id", "roleId", "id"]);
    if (!applicationId || !roleId) {
      throw sourceShapeError("candidate_application_row_incomplete", "Paraform candidate applications returned a row without exact application and role identifiers.");
    }
    return {
      applicationId,
      roleId,
      observedAt: instant(explicit(row, ["submitted_at", "submittedAt", "submittedOn", "created_at", "createdAt"])),
    };
  });
}

function applicationFacts(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw sourceShapeError("submission_application_detail_shape_invalid", "Paraform application detail returned an unrecognized success payload.");
  }
  const candidateUser = value.candidate_user || value.candidateUser || {};
  const candidateToApprovedRole = value.candidate_to_approved_role || value.candidateToApprovedRole || {};
  const result = {
    applicationId: explicit(value, ["id", "application_id", "applicationId"]),
    candidateUserId: explicit(value, ["candidate_user_id", "candidateUserId"])
      || explicit(candidateUser, ["candidate_user_id", "candidateUserId", "id"]),
    roleId: explicit(value, ["role_id", "roleId"])
      || explicit(candidateToApprovedRole, ["role_id", "roleId"]),
    status: clean(value.status || value.state, 100).toUpperCase(),
    observedAt: instant(explicit(value, ["submitted_at", "submittedAt", "submittedOn", "created_at", "createdAt", "updated_at", "lastUpdated"])),
  };
  if (!result.applicationId || !result.candidateUserId || !result.roleId || !result.status) {
    throw sourceShapeError("submission_application_detail_incomplete", "Paraform application detail omitted an exact identifier or status.");
  }
  return result;
}

function exactRoleApplications(rows, roleId) {
  const exact = rows.filter((row) => row.roleId === roleId).sort((left, right) => {
    const leftTime = Date.parse(left.observedAt || "") || 0;
    const rightTime = Date.parse(right.observedAt || "") || 0;
    return rightTime - leftTime || right.applicationId.localeCompare(left.applicationId);
  });
  if (exact.length > MAX_EXACT_ROLE_APPLICATIONS) {
    throw sourceShapeError("candidate_application_role_ambiguous", "Paraform returned too many applications for one exact candidate-role pair to inspect safely in a bounded run.");
  }
  return exact;
}

function proofForApplication(pair, located, application, now) {
  if (application.applicationId !== located.applicationId
    || application.candidateUserId !== pair.candidate_user_id
    || application.roleId !== pair.role_id) {
    throw sourceShapeError("submission_application_identity_conflict", "Paraform application detail did not match the exact candidate, role, and application requested.");
  }
  if (!SUBMITTED_STATES.has(application.status)) return null;
  const authoritativePath = "application.getRecruiterApplicationData";
  return {
    pairId: pair.id,
    applicationId: application.applicationId,
    authoritativePath,
    evidenceDigest: sha256(canonicalJson({ authoritativePath, ...application })),
    observedAt: application.observedAt || located.observedAt || new Date(now).toISOString(),
    checkedAt: new Date(now).toISOString(),
  };
}

export async function readExactSubmissionProofs(pairs, {
  trpcGetImpl = trpcGet,
  now = new Date(),
} = {}) {
  const requested = Array.isArray(pairs) ? pairs.filter(Boolean) : [];
  if (!requested.length) return [];
  if (requested.some((pair) => !clean(pair.id) || !clean(pair.candidate_user_id) || !clean(pair.role_id))) {
    throw sourceShapeError("submission_proof_pair_incomplete", "Submission proof selection omitted an exact pair, candidate, or role identifier.");
  }

  const rowsByCandidate = new Map();
  for (const candidateUserId of new Set(requested.map((pair) => clean(pair.candidate_user_id)).filter(Boolean))) {
    const value = await trpcGetImpl("candidateUser.getCandidateUserApplications", { candidate_user_id: candidateUserId });
    rowsByCandidate.set(candidateUserId, candidateApplicationRows(value, candidateUserId));
  }

  const proofs = [];
  for (const pair of requested) {
    const locatedRows = exactRoleApplications(rowsByCandidate.get(pair.candidate_user_id) || [], pair.role_id);
    for (const located of locatedRows) {
      const value = await trpcGetImpl("application.getRecruiterApplicationData", { application_id: located.applicationId });
      const proof = proofForApplication(pair, located, applicationFacts(value), now);
      if (proof) {
        proofs.push(proof);
        break;
      }
    }
  }
  return proofs;
}

export async function readExactSubmissionProof(pair, options = {}) {
  return (await readExactSubmissionProofs([pair], options))[0] || null;
}

export const proofReaderInternals = Object.freeze({
  applicationFacts,
  candidateApplicationRows,
  exactRoleApplications,
  proofForApplication,
});
