import test from "node:test";
import assert from "node:assert/strict";

import {
  dismissPathB,
  guardHumanEdits,
  previewPathB,
  submitPathB,
  unclaimPathB,
} from "../api/submissions/_lib/path-b.mjs";
import { buildSignalPairs } from "../api/submissions/_lib/sources.mjs";
import { buildCombinedRows } from "../api/submissions/_lib/rows.mjs";
import { rowHash } from "../api/submissions/_lib/store.mjs";
import { createPacedReader } from "../api/submissions/_lib/sync.mjs";
import {
  normalizeExternalSources,
  sourceBridgeAuthorized,
} from "../api/submissions/sources.mjs";

const candidateUserId = "candidate-user-1";
const roleId = "role-1";
const key = rowHash(candidateUserId, roleId);
const row = {
  key,
  path: "B",
  state: "ready",
  candidateUserId,
  candidateName: "Candidate",
  roleId,
  roleName: "Engineer",
  companyName: "Company",
};
const snapshot = { trustworthy: true, generatedAt: "2026-08-27T12:00:00.000Z", rows: [row] };
const candidateProfile = {
  candidate: { id: "candidate-1", name: "Candidate", linkedin_user: "candidate" },
  emails: ["candidate@example.com"],
  resume_id: "resume-1",
};
const draft = {
  oneLiner: "Engineer @ Company | Platforms",
  greatFitReason: "Candidate brings grounded platform experience that maps directly to Company's core engineering needs. Their documented ownership and delivery history make them a strong fit for the team and this role.",
  additionalInfo: "",
  jobHopperExplanation: "",
  attributes: [{ requirementId: "req-1", name: "Platforms", rating: 5, comment: "" }],
  questionAnswers: [],
  rating: 3,
};

function baseDeps() {
  return {
    readSnapshotImpl: async () => snapshot,
    trpcGetImpl: async (procedure) => {
      if (procedure === "candidateUser.getCandidateUserById") return candidateProfile;
      throw new Error(`unexpected get ${procedure}`);
    },
    trpcPostImpl: async (procedure) => {
      if (procedure === "roleSlots.prepareForSingleSubmission") {
        return { success: true, candidate_to_approved_role_id: "prepared-1" };
      }
      throw new Error(`unexpected post ${procedure}`);
    },
    restImpl: async () => ({}),
    precheckImpl: async () => ({ ok: true, blockers: [], signals: {} }),
    draftImpl: async () => ({ ok: true, blockers: [], draft }),
    listJobsImpl: async () => [],
    paceMs: 0,
    sleepImpl: async () => {},
  };
}

test("the eight source families converge on candidate-role pairs without identity guessing", () => {
  const request = {
    id: "request-1", candidateUserId, candidateName: "Candidate", roleId,
    roleName: "Engineer", companyName: "Company", createdAt: "2026-08-20T00:00:00.000Z",
  };
  const built = buildSignalPairs({
    requests: [request],
    curatedCandidates: [{ candidateUserId, name: "Candidate" }],
    interestSnapshots: new Map([[candidateUserId, {
      statuses: { [roleId]: "APPLIED_TO_ROLE" }, updatedAt: "2026-08-21T00:00:00.000Z",
    }]]),
    replyRecords: [{
      candidateUserId, createdAt: "2026-08-22T00:00:00.000Z",
      decision: { intent: "yes", targetRequestIds: ["request-1"] },
    }],
    applicantDecisions: {
      [`${candidateUserId}:${roleId}`]: { action: "interview", at: "2026-08-19T00:00:00.000Z" },
    },
    external: {
      interviewFollowups: [{ candidateUserId, roleId, promisedAt: "2026-08-23T00:00:00.000Z" }],
      matchWatch: [{ candidateUserId, roleIds: [roleId], repliedAt: "2026-08-24T00:00:00.000Z", listSize: 1 }],
    },
    inboxFeed: { replies: [{
      candidate_user_id: candidateUserId, candidate_name: "Candidate",
      role_id: roleId, reply_category: "INTERESTED", date: "2026-08-25T00:00:00.000Z",
    }] },
  });
  assert.equal(built.pairs.length, 1);
  assert.deepEqual(built.pairs[0].signals.map((item) => item.code), [
    "hiring_manager_requested",
    "good_fit_promised",
    "curated_list_interested",
    "paraai_reply_yes",
    "sequence_reply_interested",
    "applicants_interview",
    "match_watch_replied",
  ]);
  assert.equal(built.unresolved.length, 0);
});

test("a bare match-watch reply stays visible and blocked until it is read", () => {
  const pair = buildSignalPairs({
    external: { matchWatch: [{ candidateUserId, roleIds: [roleId], repliedAt: "2026-08-24T00:00:00.000Z", listSize: 1 }] },
  }).pairs[0];
  const built = buildCombinedRows({
    signalPairs: [pair],
    priorRows: [{ key, context: { status: "ready", blockers: [], hasCall: false } }],
  });
  assert.equal(built.rows[0].state, "blocked");
  assert.equal(built.rows[0].section, "blocked");
  assert.ok(built.rows[0].blockers.some((item) => item.code === "reply_needs_review"));
});

test("a role-linked Inbox reply stays on its exact role", () => {
  const otherRoleId = "role-2";
  const built = buildSignalPairs({
    requests: [
      { id: "request-1", candidateUserId, roleId },
      { id: "request-2", candidateUserId, roleId: otherRoleId },
    ],
    inboxFeed: { replies: [{
      candidate_user_id: candidateUserId,
      role_id: otherRoleId,
      reply_category: "INTERESTED",
    }] },
  });
  const signaled = built.pairs.filter((pair) => (
    pair.signals.some((item) => item.code === "sequence_reply_interested")
  ));
  assert.deepEqual(signaled.map((pair) => pair.roleId), [otherRoleId]);
});

test("paced reader serializes concurrent callers", async () => {
  let active = 0;
  let maxActive = 0;
  const paced = createPacedReader({ paceMs: 0 });
  await Promise.all([1, 2, 3].map(() => paced(async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 2));
    active -= 1;
  })));
  assert.equal(maxActive, 1);
});

test("unsourced human prose is stripped while score choices remain editable", () => {
  const edited = structuredClone(draft);
  edited.greatFitReason += " Invented unicorn certification.";
  edited.attributes[0].rating = 3;
  const guarded = guardHumanEdits(draft, edited);
  assert.equal(guarded.draft.greatFitReason, draft.greatFitReason);
  assert.equal(guarded.draft.attributes[0].rating, 3);
  assert.ok(guarded.warnings.includes("greatFitReason_unsourced_edit_stripped"));
});

test("Path B preview is human-only preparation and states phone_screened=false without a call", async () => {
  const result = await previewPathB({ key, candidateUserId, roleId }, baseDeps());
  assert.equal(result.path, "B");
  assert.equal(result.noCallOnRecord, true);
  assert.match(result.warnings[0], /phone_screened=false/);
  assert.equal(result.draft.oneLiner, draft.oneLiner);
});

test("Path B retries once only after an independent absence proof", async () => {
  const events = [];
  const execution = [];
  let outcome = null;
  const deps = {
    ...baseDeps(),
    acquireLockImpl: async () => "lock",
    releaseLockImpl: async () => true,
    readLedgerImpl: async () => null,
    appendLedgerImpl: async (_candidate, _role, event) => { events.push(event); return {}; },
    submissionStore: {
      claimSubmissionAttempt: async () => ({ status: "started", claim: { attemptId: "attempt-1" } }),
      recordSubmissionPrepared: async () => ({ status: "prepared" }),
      recordSubmissionOutcome: async (_candidate, _role, next) => { outcome = next; return { status: "recorded" }; },
    },
    executeImpl: async (input) => {
      execution.push(input);
      return execution.length === 1
        ? { verified: false, mutationAttempted: true, applicationId: null, blockers: ["submission_write_result_unknown"] }
        : { verified: true, mutationAttempted: true, applicationId: "application-1", blockers: [] };
    },
    proveAbsentImpl: async () => ({ absent: true }),
  };
  const result = await submitPathB({ key, candidateUserId, roleId, path: "B", draft, by: "team@example.com" }, deps);
  assert.equal(result.verified, true);
  assert.equal(result.retried, true);
  assert.equal(execution.length, 2);
  assert.ok(execution.every((input) => input.phoneScreened === false));
  assert.equal(outcome, "verified");
  assert.deepEqual(events, ["submit_claimed", "retry_authorized_by_absent_readback", "submitted_verified_after_retry"]);
});

test("Path B never retries an application-id-shaped ambiguous outcome", async () => {
  let calls = 0;
  const deps = {
    ...baseDeps(),
    acquireLockImpl: async () => "lock",
    releaseLockImpl: async () => true,
    readLedgerImpl: async () => null,
    appendLedgerImpl: async () => ({}),
    submissionStore: {
      claimSubmissionAttempt: async () => ({ status: "started", claim: { attemptId: "attempt-1" } }),
      recordSubmissionPrepared: async () => ({ status: "prepared" }),
      recordSubmissionOutcome: async () => ({ status: "recorded" }),
    },
    executeImpl: async () => {
      calls += 1;
      return { verified: false, mutationAttempted: true, applicationId: "application-possible", blockers: ["readback_mismatch"] };
    },
    proveAbsentImpl: async () => assert.fail("absence proof is not used when an application id exists"),
  };
  await assert.rejects(
    submitPathB({ key, candidateUserId, roleId, path: "B", draft, by: "team@example.com" }, deps),
    (error) => error.code === "SUBMISSION_OUTCOME_AMBIGUOUS",
  );
  assert.equal(calls, 1);
});

test("typed Path B unclaim releases only this lane after live absence proof", async () => {
  const released = [];
  const result = await unclaimPathB({ key, candidateUserId, roleId, by: "team@example.com" }, {
    ...baseDeps(),
    getClaimImpl: async () => ({ attemptId: "attempt-1", lane: "submissions" }),
    proveAbsentImpl: async () => ({ absent: true }),
    releaseClaimImpl: async (...args) => { released.push(args); return { released: true }; },
    appendLedgerImpl: async () => ({}),
  });
  assert.equal(result.released, true);
  assert.deepEqual(released[0], [candidateUserId, roleId, "attempt-1", { lane: "submissions" }]);
});

test("Path B dismissal cannot race a teammate's submit lock", async () => {
  let ledgerReads = 0;
  await assert.rejects(
    dismissPathB({ key, candidateUserId, roleId, by: "team@example.com" }, {
      ...baseDeps(),
      acquireLockImpl: async () => null,
      readLedgerImpl: async () => { ledgerReads += 1; return null; },
    }),
    (error) => error.code === "SUBMISSION_BUSY",
  );
  assert.equal(ledgerReads, 0);
});

test("source bridge validates its narrow id-only machine payload and secret", () => {
  assert.equal(sourceBridgeAuthorized({ headers: { authorization: "Bearer secret" } }, { APPHUB_SYNC_KEY: "secret" }), true);
  assert.equal(sourceBridgeAuthorized({ headers: { authorization: "Bearer wrong" } }, { APPHUB_SYNC_KEY: "secret" }), false);
  const normalized = normalizeExternalSources({
    interviewFollowups: [{ candidateUserId, roleId, candidateName: " Candidate " }],
    matchWatch: [{ candidateUserId, roleIds: [roleId, roleId], listSize: 2 }],
  });
  assert.equal(normalized.interviewFollowups.length, 1);
  assert.deepEqual(normalized.matchWatch[0].roleIds, [roleId]);
});
