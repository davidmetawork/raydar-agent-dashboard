import { linkedinHandle, normalizeEmail, paraformRest, trpcGet, trpcPost } from "../../paraai/_lib/core.mjs";
import {
  candidatePreferencesReady,
  readQuickSubmitForm,
  readSubmissionRequests,
} from "../../paraai/_lib/reply-actions.mjs";
import { findJobForCandidate } from "../../paraai/_lib/reply.mjs";
import { listJobs } from "../../paraai/_lib/store.mjs";
import { precheckCapturedSingleSubmissionContext } from "../../paraai/_lib/interest-submission.mjs";
import {
  buildCombinedRows,
  buildPathARows,
  contextFromQuickSubmitForm,
  groupSubmissionRequests,
  snapshotSummary,
} from "./rows.mjs";
import { readSignalSources } from "./sources.mjs";
import {
  acquireSyncLock,
  readLedgers,
  readRowsSnapshot,
  releaseSyncLock,
  writeRowsSnapshot,
} from "./store.mjs";

const CONTEXT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const DEFAULT_PACE_MS = 1_400;
const DEFAULT_DEADLINE_MS = 260_000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function publicReadError(error) {
  const code = String(error?.code || "SUBMISSION_CONTEXT_READ_FAILED");
  if (code === "AUTH_EXPIRED") return "paraform_session_expired";
  if (code === "PARAFORM_THROTTLED") return "paraform_throttled";
  if (code.startsWith("PARAFORM_TRANSPORT")) return "paraform_transport_failed";
  return "submission_context_read_failed";
}

function shouldRefresh(context, now, force) {
  if (force || !context?.checkedAt) return true;
  const checkedAt = Date.parse(context.checkedAt);
  return !Number.isFinite(checkedAt) || now - checkedAt >= CONTEXT_MAX_AGE_MS;
}

export function createPacedReader({ paceMs = DEFAULT_PACE_MS, sleepImpl = sleep } = {}) {
  let lastStartedAt = 0;
  let tail = Promise.resolve();
  return (fn) => {
    const next = tail.then(async () => {
      const waitMs = Math.max(0, paceMs - (Date.now() - lastStartedAt));
      if (waitMs) await sleepImpl(waitMs);
      lastStartedAt = Date.now();
      return fn();
    });
    tail = next.catch(() => {});
    return next;
  };
}

function candidateFromProfile(candidateUserId, candidateUser = {}, fallbackName = "Candidate") {
  const candidate = candidateUser?.candidate || {};
  const email = [
    ...(Array.isArray(candidateUser?.emails) ? candidateUser.emails : []),
    candidate?.email,
  ].map((value) => normalizeEmail(
    typeof value === "object" ? value?.email ?? value?.value ?? "" : value,
  )).find(Boolean) || null;
  return {
    candidateUserId,
    candidateId: candidate?.id || candidateUser?.candidate_id || null,
    name: candidate?.name || candidateUser?.name || fallbackName,
    email,
    linkedinUser: linkedinHandle(
      candidate?.linkedin_user || candidateUser?.linkedin_user || "",
    ) || null,
    hasResume: Boolean(
      candidateUser?.resume_id
      || candidateUser?.latest_application_resume_id
      || candidate?.resume_id,
    ),
  };
}

function retainedPairs(signalResult, previous) {
  const pairs = [...signalResult.pairs];
  if (!signalResult.errors.length) return pairs;
  const seen = new Set(pairs.map((pair) => pair.key));
  for (const row of previous?.rows || []) {
    if (row.path !== "B" || seen.has(row.key)) continue;
    pairs.push({
      key: row.key,
      candidateUserId: row.candidateUserId,
      candidateName: row.candidateName,
      roleId: row.roleId,
      roleName: row.roleName,
      companyName: row.companyName,
      signals: row.signals || [],
    });
  }
  return pairs;
}

export async function syncPathARows({
  force = false,
  now = Date.now(),
  deadlineMs = DEFAULT_DEADLINE_MS,
  paceMs = DEFAULT_PACE_MS,
  readRequestsImpl = readSubmissionRequests,
  readFormImpl = readQuickSubmitForm,
  readPreferencesImpl = candidatePreferencesReady,
  readRoleSettingsImpl = (roleId) => trpcGet(
    "roleSettings.getRoleSettingsForRecruiters",
    { role_id: roleId },
  ),
  listJobsImpl = listJobs,
  readSignalsImpl = readSignalSources,
  readCandidateImpl = (candidateUserId) => trpcGet(
    "candidateUser.getCandidateUserById",
    { candidate_user_id: candidateUserId },
  ),
  precheckPathBImpl = precheckCapturedSingleSubmissionContext,
  trpcGetImpl = trpcGet,
  trpcPostImpl = trpcPost,
  restImpl = paraformRest,
  readSnapshotImpl = readRowsSnapshot,
  readLedgersImpl = readLedgers,
  writeSnapshotImpl = writeRowsSnapshot,
  acquireLockImpl = acquireSyncLock,
  releaseLockImpl = releaseSyncLock,
  sleepImpl = sleep,
} = {}) {
  const token = await acquireLockImpl();
  if (!token) return { ok: false, busy: true };
  const startedAt = Date.now();
  try {
    const [requests, previous, jobs] = await Promise.all([
      readRequestsImpl(),
      readSnapshotImpl().catch(() => null),
      listJobsImpl(500).catch(() => []),
    ]);
    const groups = groupSubmissionRequests(requests);
    const signalResult = await readSignalsImpl({ requests });
    const signalPairs = retainedPairs(signalResult, previous);
    const pairs = [...new Map([
      ...groups.map(({ primary }) => ({
        candidateUserId: primary.candidateUserId,
        roleId: primary.roleId,
      })),
      ...signalPairs.map((pair) => ({
        candidateUserId: pair.candidateUserId,
        roleId: pair.roleId,
      })),
    ].map((pair) => [`${pair.candidateUserId}\0${pair.roleId}`, pair])).values()];
    const ledgers = await readLedgersImpl(pairs);
    const contextByKey = new Map(
      (previous?.rows || []).map((row) => [row.key, row.context || null]),
    );
    const paced = createPacedReader({ paceMs, sleepImpl });
    const roleSettings = new Map();
    let attempted = 0;
    let refreshed = 0;
    let failed = 0;
    let systemicFailure = null;
    let stoppedForDeadline = false;

    const pendingGroups = groups
      .filter(({ primary }) => primary.state === "PENDING")
      .sort((left, right) => Number(left.primary.createdAtMs || 0) - Number(right.primary.createdAtMs || 0));
    for (const group of pendingGroups) {
      const existing = contextByKey.get(group.key);
      if (!shouldRefresh(existing, now, force)) continue;
      if (Date.now() - startedAt > deadlineMs) {
        stoppedForDeadline = true;
        break;
      }
      attempted += 1;
      try {
        const request = group.primary;
        const form = await paced(() => readFormImpl(request.id));
        const preferences = await paced(() => readPreferencesImpl(
          form?.candidateUserId || request.candidateUserId,
          [],
        ));
        let settings = roleSettings.get(request.roleId);
        if (!settings) {
          settings = await paced(() => readRoleSettingsImpl(request.roleId));
          roleSettings.set(request.roleId, settings || {});
        }
        const job = findJobForCandidate(jobs, request.candidateUserId);
        const confirmationSetting = typeof settings?.candidate_application_confirm_email === "boolean"
          ? settings.candidate_application_confirm_email
          : null;
        const context = contextFromQuickSubmitForm(form, {
          preferences,
          hasCall: Boolean(job),
          paraformConfirmationExpected: confirmationSetting,
        });
        if (confirmationSetting == null) {
          context.blockers = [...new Set([
            ...(context.blockers || []),
            "submission_context_read_failed_role_settings",
          ])];
        }
        contextByKey.set(group.key, context);
        refreshed += 1;
      } catch (error) {
        failed += 1;
        const code = publicReadError(error);
        contextByKey.set(group.key, {
          status: "failed",
          code,
          checkedAt: new Date().toISOString(),
        });
        if (code === "paraform_session_expired") {
          systemicFailure = code;
          break;
        }
      }
    }

    const requestKeys = new Set(groups.map((group) => group.key));
    const pendingPathB = signalPairs
      .filter((pair) => !requestKeys.has(pair.key))
      .sort((left, right) => {
        const leftPriority = Number(left.signals?.[0]?.priority ?? 8);
        const rightPriority = Number(right.signals?.[0]?.priority ?? 8);
        return leftPriority - rightPriority
          || (Date.parse(left.signals?.[0]?.at || "") || 0)
          - (Date.parse(right.signals?.[0]?.at || "") || 0);
      });
    for (const pair of pendingPathB) {
      const existing = contextByKey.get(pair.key);
      if (!shouldRefresh(existing, now, force)) continue;
      if (Date.now() - startedAt > deadlineMs) {
        stoppedForDeadline = true;
        break;
      }
      attempted += 1;
      try {
        const candidateUser = await paced(() => readCandidateImpl(pair.candidateUserId));
        const candidate = candidateFromProfile(
          pair.candidateUserId,
          candidateUser,
          pair.candidateName,
        );
        const pacedGet = (procedure, input, tries) => paced(() => trpcGetImpl(procedure, input, tries));
        const pacedPost = (procedure, input, tries) => paced(() => trpcPostImpl(procedure, input, tries));
        const pacedRest = (path, options) => paced(() => restImpl(path, options));
        const precheck = await precheckPathBImpl({
          candidate,
          roleId: pair.roleId,
          trpcGetImpl: pacedGet,
          trpcPostImpl: pacedPost,
          restImpl: pacedRest,
          now: new Date(now),
          advisoryCredits: true,
        });
        if (!candidate.hasResume) {
          precheck.blockers = [...new Set([...(precheck.blockers || []), "submission_resume_missing"])];
          precheck.ok = false;
        }
        const readFailed = (precheck.blockers || []).some((code) => (
          String(code).startsWith("submission_context_read_failed")
        ));
        const job = findJobForCandidate(jobs, pair.candidateUserId);
        contextByKey.set(pair.key, {
          status: readFailed ? "failed" : "ready",
          code: readFailed ? "submission_context_read_failed" : null,
          checkedAt: new Date().toISOString(),
          blockers: precheck.blockers || [],
          creditsAvailable: precheck.signals?.creditsAvailable ?? null,
          paraformConfirmationExpected:
            precheck.signals?.paraformConfirmationExpected ?? null,
          roleName: precheck.signals?.roleName || pair.roleName,
          companyName: precheck.signals?.companyName || pair.companyName,
          linkedinUser: candidate.linkedinUser,
          hasResume: candidate.hasResume,
          hasCall: Boolean(job),
        });
        if (readFailed) failed += 1;
        else refreshed += 1;
      } catch (error) {
        failed += 1;
        const code = publicReadError(error);
        contextByKey.set(pair.key, {
          status: "failed",
          code,
          checkedAt: new Date().toISOString(),
        });
        if (code === "paraform_session_expired") {
          systemicFailure = code;
          break;
        }
      }
    }

    const priorRows = [...new Set([
      ...groups.map((group) => group.key),
      ...signalPairs.map((pair) => pair.key),
    ])].map((key) => ({
      key,
      context: contextByKey.get(key) || null,
    }));
    const builtA = buildPathARows({ requests, ledgers, priorRows, now });
    const built = buildCombinedRows({
      pathARows: builtA.rows,
      signalPairs,
      ledgers,
      priorRows,
      now,
    });
    const summary = snapshotSummary(built.rows, built.dismissed);
    const failureRatio = attempted ? failed / attempted : 0;
    const trustworthy = !systemicFailure && failed < 3 && failureRatio < 0.2;
    const snapshot = await writeSnapshotImpl({
      generatedAt: new Date().toISOString(),
      trustworthy,
      unhealthyReason: systemicFailure || (!trustworthy ? "too_many_paraform_read_failures" : null),
      source: "submissionRequest.getRecruiterSubmissionRequestHistory",
      paths: { A: true, B: true },
      sources: {
        errors: signalResult.errors,
        unresolved: signalResult.unresolved.length,
        coverage: signalResult.coverage,
      },
      sync: {
        attempted,
        refreshed,
        failed,
        stoppedForDeadline,
        remaining: built.rows.filter((row) => (
          ["requested", "blocked"].includes(row.state)
          && row.blockers.some((chip) => chip.code === "requirements_check_pending")
        )).length,
      },
      summary,
      rows: built.rows,
    });
    return { ok: true, snapshot };
  } finally {
    await releaseLockImpl(token).catch(() => {});
  }
}

export { CONTEXT_MAX_AGE_MS, DEFAULT_DEADLINE_MS, DEFAULT_PACE_MS, publicReadError };
