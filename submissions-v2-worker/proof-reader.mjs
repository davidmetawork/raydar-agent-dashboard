import { trpcGet } from "../api/paraai/_lib/core.mjs";
import { canonicalJson, sha256 } from "../api/submissions-v2/_lib/resume/source-bundle.mjs";

const clean = (value, limit = 500) => String(value ?? "").trim().slice(0, limit);
const explicit = (value, keys) => keys.map((key) => clean(value?.[key])).find(Boolean) || null;
const sourceShapeError = (code, message) => Object.assign(new Error(message), { code, retryable: true });

function mondayPacific(now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit", weekday: "short",
  }).formatToParts(now).map((part) => [part.type, part.value]));
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.weekday);
  const local = new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day) - ((weekday + 6) % 7), 12));
  // Noon UTC pins the local calendar date; resolve midnight using the current PST/PDT offset.
  const probe = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), 12));
  const hour = Number(Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles", hour: "2-digit", hourCycle: "h23",
  }).formatToParts(probe).map((part) => [part.type, part.value])).hour);
  return new Date(probe.getTime() - hour * 60 * 60 * 1_000).toISOString();
}

function facts(row, { allowTopLevelId = false } = {}) {
  const candidate = row?.candidate_user || row?.candidateUser || row?.candidate || {};
  const role = row?.role || row?.candidate_to_approved_role || row?.candidateToApprovedRole || {};
  return {
    applicationId: explicit(row, allowTopLevelId ? ["application_id", "applicationId", "id"] : ["application_id", "applicationId"]),
    candidateUserId: explicit(row, ["candidate_user_id", "candidateUserId"]) || explicit(candidate, ["candidate_user_id", "candidateUserId", "id"]),
    roleId: explicit(row, ["role_id", "roleId"]) || explicit(role, ["role_id", "roleId", "id"]),
    status: clean(row?.status || row?.state, 100).toUpperCase(),
    observedAt: clean(row?.submitted_at || row?.submittedAt || row?.created_at || row?.createdAt, 100) || null,
  };
}

function ledgerRows(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw sourceShapeError("submission_ledger_shape_invalid", "Paraform submission ledger returned an unrecognized success payload.");
  const hasLatest = Object.prototype.hasOwnProperty.call(value, "latestSingleSubmissions");
  const hasRecent = Object.prototype.hasOwnProperty.call(value, "allRecentSingleSubmissions");
  if ((!hasLatest && !hasRecent)
    || (hasLatest && !Array.isArray(value.latestSingleSubmissions))
    || (hasRecent && !Array.isArray(value.allRecentSingleSubmissions))) {
    throw sourceShapeError("submission_ledger_shape_invalid", "Paraform submission ledger returned an unrecognized success payload.");
  }
  const rows = [...(value.latestSingleSubmissions || []), ...(value.allRecentSingleSubmissions || [])];
  if (rows.some((row) => !row || typeof row !== "object" || Array.isArray(row))) throw sourceShapeError("submission_ledger_row_invalid", "Paraform submission ledger returned an invalid row.");
  return rows.map((row) => facts(row, { allowTopLevelId: true }));
}

function historyRows(value) {
  const rows = Array.isArray(value) ? value
    : value && typeof value === "object" && !Array.isArray(value) && Array.isArray(value.requests) ? value.requests
      : null;
  if (!rows) throw sourceShapeError("submission_history_shape_invalid", "Paraform submission history returned an unrecognized success payload.");
  if (rows.some((row) => !row || typeof row !== "object" || Array.isArray(row))) throw sourceShapeError("submission_history_row_invalid", "Paraform submission history returned an invalid row.");
  return rows.map(facts);
}

const SUBMITTED_STATES = new Set(["SUBMITTED", "INTERVIEWING", "INTERVIEW", "ACCEPTED", "REJECTED", "HIRED", "OFFER", "OFFERED"]);

function proofForPair(pair, ledger, history, now) {
  const exact = (row) => row.applicationId
    && row.candidateUserId === pair.candidate_user_id
    && row.roleId === pair.role_id;
  // Membership in Paraform's single-submission ledger is itself submitted
  // evidence; current rows do not consistently repeat a status field.
  const ledgerMatch = ledger.find((row) => exact(row) && (!row.status || SUBMITTED_STATES.has(row.status)));
  const historyMatch = history.find((row) => exact(row) && SUBMITTED_STATES.has(row.status));
  const match = ledgerMatch || historyMatch;
  if (!match) return null;
  const authoritativePath = ledgerMatch
    ? "roleSlots.getMySingleSubmissionData"
    : "submissionRequest.getRecruiterSubmissionRequestHistory";
  return {
    pairId: pair.id,
    applicationId: match.applicationId,
    authoritativePath,
    evidenceDigest: sha256(canonicalJson({ authoritativePath, ...match })),
    observedAt: match.observedAt || new Date(now).toISOString(),
    checkedAt: new Date(now).toISOString(),
  };
}

export async function readExactSubmissionProofs(pairs, {
  trpcGetImpl = trpcGet,
  now = new Date(),
} = {}) {
  const requested = Array.isArray(pairs) ? pairs.filter(Boolean) : [];
  if (!requested.length) return [];
  const [ledger, history] = await Promise.all([
    trpcGetImpl("roleSlots.getMySingleSubmissionData", { weekStart: mondayPacific(now) }),
    trpcGetImpl("submissionRequest.getRecruiterSubmissionRequestHistory", { agencyView: false, recruiterFilter: [] }),
  ]);
  const normalizedLedger = ledgerRows(ledger);
  const normalizedHistory = historyRows(history);
  return requested.map((pair) => proofForPair(pair, normalizedLedger, normalizedHistory, now)).filter(Boolean);
}

export async function readExactSubmissionProof(pair, options = {}) {
  return (await readExactSubmissionProofs([pair], options))[0] || null;
}

export const proofReaderInternals = Object.freeze({ facts, historyRows, ledgerRows, mondayPacific, proofForPair });
