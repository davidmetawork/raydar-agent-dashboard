import assert from "node:assert/strict";
import test from "node:test";

import {
  buildPathARows,
  contextFromQuickSubmitForm,
  groupSubmissionRequests,
  snapshotSummary,
} from "../api/submissions/_lib/rows.mjs";
import {
  guardPathAEdits,
  previewPathA,
  submitPathA,
  unclaimPathA,
  undoDismissPathA,
} from "../api/submissions/_lib/path-a.mjs";
import { syncPathARows } from "../api/submissions/_lib/sync.mjs";

const request = (patch = {}) => ({
  id: "req-1",
  state: "PENDING",
  status: "pending",
  createdAt: "2026-08-20T12:00:00.000Z",
  createdAtMs: Date.parse("2026-08-20T12:00:00.000Z"),
  applicationId: null,
  clientNote: "Please send this person",
  candidateUserId: "cu-1",
  candidateName: "Test Candidate",
  roleId: "role-1",
  roleName: "Staff Engineer",
  companyName: "Example Co",
  salaryLowerBound: 180000,
  salaryUpperBound: 220000,
  ...patch,
});

const form = (patch = {}) => ({
  candidateUserId: "cu-1",
  eligibility: { status: "eligible" },
  defaultValues: { resume_id: "resume-1" },
  missingCandidateFields: {},
  candidate: { name: "Test Candidate", linkedin_user: "test-candidate" },
  role: {
    id: "role-1",
    name: "Staff Engineer",
    phone_screen: "REQUIRED",
    role_question: [],
  },
  fieldConfigs: {},
  paraAiOpenEnded: false,
  ...patch,
});

const draft = {
  great_fit_reason: "This candidate has directly relevant engineering experience and the background requested for this role.",
  question_answers: [],
  open_ended_submission: null,
  salary_explanation: null,
  additional_notes: null,
};

test("Path A groups repeated requests into one candidate-role row and prefers a pending request", () => {
  const groups = groupSubmissionRequests([
    request({ id: "req-old", state: "SUBMITTED", applicationId: "app-old" }),
    request({ id: "req-current", createdAtMs: Date.parse("2026-08-25T12:00:00Z") }),
  ]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].primary.id, "req-current");
});

test("a missing call is an honest warning, not a Path A blocker", () => {
  const context = contextFromQuickSubmitForm(form(), { hasCall: false });
  const built = buildPathARows({
    requests: [request()],
    priorRows: [{ key: groupSubmissionRequests([request()])[0].key, context }],
    now: Date.parse("2026-08-27T12:00:00Z"),
  });
  assert.equal(built.rows.length, 1);
  assert.deepEqual(built.rows[0].blockers, []);
  assert.deepEqual(built.rows[0].warnings.map((chip) => chip.code), ["no_call_on_record"]);
  assert.equal(built.rows[0].links.linkedin, "https://www.linkedin.com/in/test-candidate");
  assert.equal(snapshotSummary(built.rows, built.dismissed).noLinkedIn, 0);
});

test("Path A rows never turn a failed requirement read into a fabricated blocker", () => {
  const key = groupSubmissionRequests([request()])[0].key;
  const built = buildPathARows({
    requests: [request()],
    priorRows: [{ key, context: { status: "failed", code: "paraform_session_expired" } }],
  });
  assert.deepEqual(
    built.rows[0].blockers.map((chip) => chip.code),
    ["submission_context_read_failed"],
  );
});

test("the Path A sync performs one history read, warms context, and writes an honest snapshot", async () => {
  let historyReads = 0;
  let written = null;
  const result = await syncPathARows({
    readRequestsImpl: async () => { historyReads += 1; return [request()]; },
    readSnapshotImpl: async () => null,
    listJobsImpl: async () => [],
    readSignalsImpl: async ({ requests }) => ({
      pairs: requests.map((row) => ({
        key: groupSubmissionRequests([row])[0].key,
        candidateUserId: row.candidateUserId,
        candidateName: row.candidateName,
        roleId: row.roleId,
        roleName: row.roleName,
        companyName: row.companyName,
        signals: [{ code: "hiring_manager_requested", label: "Hiring manager asked", priority: 0 }],
      })),
      unresolved: [],
      errors: [],
      coverage: {},
    }),
    readLedgersImpl: async () => new Map(),
    readFormImpl: async () => form(),
    readPreferencesImpl: async () => ({ ready: true, missingFields: [] }),
    readRoleSettingsImpl: async () => ({ candidate_application_confirm_email: true }),
    writeSnapshotImpl: async (snapshot) => { written = snapshot; return snapshot; },
    acquireLockImpl: async () => "lock",
    releaseLockImpl: async () => true,
    paceMs: 0,
  });
  assert.equal(result.ok, true);
  assert.equal(historyReads, 1);
  assert.equal(written.trustworthy, true);
  assert.equal(written.paths.A, true);
  assert.equal(written.paths.B, true);
  assert.equal(written.summary.requested, 1);
  assert.equal(written.rows[0].context.paraformConfirmationExpected, true);
});

test("the sync records only aggregate public failure codes for production diagnosis", async () => {
  let written = null;
  await syncPathARows({
    readRequestsImpl: async () => [request()],
    readSnapshotImpl: async () => null,
    listJobsImpl: async () => [],
    readSignalsImpl: async () => ({ pairs: [], unresolved: [], errors: [], coverage: {} }),
    readLedgersImpl: async () => new Map(),
    readFormImpl: async () => {
      const error = new Error("sensitive upstream detail");
      error.code = "PARAFORM_THROTTLED";
      throw error;
    },
    writeSnapshotImpl: async (snapshot) => { written = snapshot; return snapshot; },
    acquireLockImpl: async () => "lock",
    releaseLockImpl: async () => true,
    paceMs: 0,
  });
  assert.equal(written.trustworthy, false);
  assert.deepEqual(written.sync.failureCodes, { paraform_throttled: 1 });
  assert.doesNotMatch(JSON.stringify(written.sync.failureCodes), /sensitive upstream detail/);
});

test("preview keeps the no-call override visible while allowing the draft panel", async () => {
  const result = await previewPathA({
    requestId: "req-1", candidateUserId: "cu-1", roleId: "role-1",
  }, {
    readRequestsImpl: async () => [request()],
    readLedgerImpl: async () => null,
    listJobsImpl: async () => [],
    readPreferencesImpl: async () => ({ ready: true, missingFields: [] }),
    readRoleSettingsImpl: async () => ({ candidate_application_confirm_email: true }),
    prepareImpl: async () => ({
      form: form(),
      generated: draft,
      blocked: ["This role requires that the candidate has been phone screened"],
    }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.noCallOnRecord, true);
  assert.equal(result.paraformConfirmationExpected, true);
  assert.deepEqual(result.blocked, []);
  assert.match(result.warnings[0], /phone_screened=false/);
  assert.equal(result.draft.great_fit_reason, draft.great_fit_reason);
});

test("Path A fails closed when live preference readiness cannot be read", async () => {
  await assert.rejects(
    previewPathA({
      requestId: "req-1", candidateUserId: "cu-1", roleId: "role-1",
    }, {
      readRequestsImpl: async () => [request()],
      readLedgerImpl: async () => null,
      listJobsImpl: async () => [],
      readPreferencesImpl: async () => { throw new Error("Paraform unavailable"); },
      prepareImpl: async () => assert.fail("draft generation must not run"),
    }),
    /Paraform unavailable/,
  );
});

test("Path A fails closed when candidate-confirmation behavior cannot be verified", async () => {
  await assert.rejects(
    previewPathA({
      requestId: "req-1", candidateUserId: "cu-1", roleId: "role-1",
    }, {
      readRequestsImpl: async () => [request()],
      readLedgerImpl: async () => null,
      listJobsImpl: async () => [],
      readPreferencesImpl: async () => ({ ready: true, missingFields: [] }),
      readRoleSettingsImpl: async () => ({}),
      prepareImpl: async () => assert.fail("draft generation must not run"),
    }),
    (error) => error?.code === "SUBMISSION_CONFIRMATION_SETTING_UNAVAILABLE",
  );
});

test("Path A strips unsourced human prose before assembling the live payload", () => {
  const edited = { ...draft, great_fit_reason: `${draft.great_fit_reason} Invented unicorn certification.` };
  const guarded = guardPathAEdits(draft, edited);
  assert.equal(guarded.draft.great_fit_reason, draft.great_fit_reason);
  assert.deepEqual(guarded.warnings, ["great_fit_reason_unsourced_edit_stripped"]);
});

function submitDeps({ verifyResults }) {
  const seen = { submits: 0, claims: 0, releases: 0, events: [] };
  let ledger = null;
  return {
    seen,
    deps: {
      readRequestsImpl: async () => [request()],
      readFormImpl: async () => form(),
      readPreferencesImpl: async () => ({ ready: true, missingFields: [] }),
      readRoleSettingsImpl: async () => ({ candidate_application_confirm_email: true }),
      prepareImpl: async () => ({ form: form(), generated: draft, blocked: [] }),
      listJobsImpl: async () => [],
      acquireLockImpl: async () => "lock",
      releaseLockImpl: async () => true,
      readLedgerImpl: async () => ledger,
      appendLedgerImpl: async (_candidate, _role, event, patch) => {
        seen.events.push(event);
        ledger = { ...(ledger || {}), ...patch };
        return ledger;
      },
      claimImpl: async () => ({
        status: "claimed",
        claim: { claimId: `claim-${++seen.claims}`, lane: "submissions" },
      }),
      releaseClaimImpl: async () => { seen.releases += 1; return true; },
      confirmInterestImpl: async () => ({ ok: true }),
      submitImpl: async () => { seen.submits += 1; return { ok: true }; },
      verifyImpl: async () => verifyResults.shift(),
    },
  };
}

test("Path A retries once only after read-back proves no application landed", async () => {
  const harness = submitDeps({ verifyResults: [
    { verified: false, row: request(), reason: "state_is_PENDING" },
    { verified: true, row: request({ state: "SUBMITTED", applicationId: "app-1" }), reason: null },
  ] });
  const result = await submitPathA({
    requestId: "req-1", candidateUserId: "cu-1", roleId: "role-1", draft, by: "operator@example.com",
  }, harness.deps);
  assert.equal(result.verified, true);
  assert.equal(result.retried, true);
  assert.equal(harness.seen.submits, 2);
  assert.equal(harness.seen.releases, 1);
  assert.equal(harness.seen.claims, 2);
  assert.deepEqual(harness.seen.events, [
    "submit_claimed",
    "retry_authorized_by_absent_readback",
    "submitted_verified_after_retry",
  ]);
});

test("Path A never retries an ambiguous read-back", async () => {
  const harness = submitDeps({ verifyResults: [
    { verified: false, row: null, reason: "request_row_missing" },
  ] });
  await assert.rejects(
    submitPathA({
      requestId: "req-1", candidateUserId: "cu-1", roleId: "role-1", draft, by: "operator@example.com",
    }, harness.deps),
    (error) => error?.code === "SUBMISSION_OUTCOME_AMBIGUOUS",
  );
  assert.equal(harness.seen.submits, 1);
  assert.equal(harness.seen.releases, 0);
  assert.equal(harness.seen.claims, 1);
  assert.equal(harness.seen.events.at(-1), "submit_may_have_landed");
});

test("typed unclaim releases only this lane after a fresh pending/no-application read", async () => {
  const seen = [];
  const result = await unclaimPathA({
    requestId: "req-1", candidateUserId: "cu-1", roleId: "role-1", by: "operator@example.com",
  }, {
    readRequestsImpl: async () => [request()],
    readClaimImpl: async () => ({
      namespace: "request-claim", lane: "submissions", claimId: "claim-1",
    }),
    releaseClaimImpl: async (requestId, claimId, options) => {
      seen.push({ requestId, claimId, options });
      return true;
    },
    appendLedgerImpl: async () => ({}),
  });
  assert.equal(result.released, true);
  assert.deepEqual(seen, [{
    requestId: "req-1", claimId: "claim-1", options: { lane: "submissions" },
  }]);
});

test("dismiss undo closes as soon as a newer sweep exists", async () => {
  const dismissedAt = "2026-08-27T12:00:00.000Z";
  await assert.rejects(
    undoDismissPathA({
      requestId: "req-1", candidateUserId: "cu-1", roleId: "role-1", key: "row-1",
    }, {
      readRequestsImpl: async () => [request()],
      acquireLockImpl: async () => "lock",
      releaseLockImpl: async () => true,
      readLedgerImpl: async () => ({ dismissedAt }),
      readSnapshotImpl: async () => ({ generatedAt: "2026-08-27T12:01:00.000Z", rows: [] }),
    }),
    (error) => error?.code === "DISMISS_UNDO_WINDOW_CLOSED",
  );
});
