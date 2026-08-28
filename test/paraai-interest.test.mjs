import test from "node:test";
import assert from "node:assert/strict";

import { diffInterest } from "../api/paraai/_lib/interest-store.mjs";
import { normalizeEmail } from "../api/paraai/_lib/core.mjs";
import {
  firstNameFor,
  interestConfirmationBody,
  interestConfirmationSubject,
  buildInterestConfirmation,
} from "../api/paraai/_lib/interest-copy.mjs";
import {
  interestConfig,
  normalizeCanaryEmail,
  interestEmailPlan,
  interestJobAcceptsMoreRoles,
  interestJobDefersNewRoles,
  interestJobExecutionConfig,
  interestJobRolloutPhase,
  interestRolloutPhase,
  interestStopCanProceed,
  interestSweepComplete,
  interestSweepWindow,
  interestTerminalHandoffReasons,
  interestWorkerMaySubmit,
  INTEREST_ROLLOUT_PHASE,
  listInterestHandoffs,
  INTEREST_STATUS,
  REQUIRED_CANDIDATE_PREFERENCE_FIELDS,
  curatedListSequenceIds,
  sendConfirmation,
  stopFollowUps,
} from "../api/paraai/_lib/interest.mjs";

/* -------------------------------------------------------------- detection */

test("first sight seeds and never acts", () => {
  const d = diffInterest(null, { r1: "APPLIED_TO_ROLE", r2: "PENDING" });
  assert.equal(d.firstSight, true);
  assert.deepEqual(d.newlyInterested, [], "an already-interested row must not fire on first sight");
});

test("PENDING to APPLIED_TO_ROLE is the trigger", () => {
  const d = diffInterest({ statuses: { r1: "PENDING" } }, { r1: "APPLIED_TO_ROLE" });
  assert.equal(d.firstSight, false);
  assert.deepEqual(d.newlyInterested, ["r1"]);
});

test("a status that did not change does not re-fire", () => {
  const d = diffInterest({ statuses: { r1: "APPLIED_TO_ROLE" } }, { r1: "APPLIED_TO_ROLE" });
  assert.deepEqual(d.newlyInterested, []);
});

test("declines are recorded but never acted on", () => {
  const d = diffInterest({ statuses: { r1: "PENDING" } }, { r1: "NOT_INTERESTED" });
  assert.deepEqual(d.newlyInterested, []);
  assert.deepEqual(d.declined, ["r1"]);
});

test("a role appearing for the first time on a known candidate does not fire", () => {
  // New role added to an existing list: no prior status, so no transition.
  const d = diffInterest({ statuses: { r1: "PENDING" } }, { r1: "PENDING", r2: "APPLIED_TO_ROLE" });
  assert.deepEqual(d.newlyInterested, [], "needs an observed PENDING before it can transition");
});

test("multiple roles in one batch are all detected", () => {
  const d = diffInterest(
    { statuses: { r1: "PENDING", r2: "PENDING", r3: "PENDING" } },
    { r1: "APPLIED_TO_ROLE", r2: "APPLIED_TO_ROLE", r3: "PENDING" },
  );
  assert.deepEqual(d.newlyInterested.sort(), ["r1", "r2"]);
});

test("a terminal batch is immutable and a later organic transition needs a new batch", () => {
  assert.equal(interestJobAcceptsMoreRoles(null), false);
  assert.equal(interestJobAcceptsMoreRoles({ stage: "detected" }), true);
  assert.equal(interestJobAcceptsMoreRoles({ stage: "email_complete" }), false);
  assert.equal(interestJobDefersNewRoles({ stage: "email_complete" }), true);
  assert.equal(interestJobDefersNewRoles({ stage: "evaluated" }), false);
  assert.equal(interestJobAcceptsMoreRoles({ stage: "done" }), false);
  assert.equal(
    interestJobAcceptsMoreRoles({ stage: "awaiting_human_submission" }),
    false,
  );
  assert.deepEqual(
    interestTerminalHandoffReasons({
      stage: "done",
      submissions: [{ stage: "would_submit" }],
    }),
    ["shadow_would_submit"],
  );
  assert.deepEqual(
    interestTerminalHandoffReasons({ stage: "awaiting_human_submission" }),
    ["human_submission_required"],
  );
  assert.deepEqual(
    interestTerminalHandoffReasons({
      stage: "done",
      submissions: [{
        stage: "blocked",
        blockers: ["credits_exhausted"],
      }],
      emailed: { skipped: "no_bankable_role" },
    }),
    ["credits_exhausted", "no_bankable_role"],
  );
});

test("a deferred state write keeps a sweep window pinned for retry", () => {
  assert.equal(interestSweepComplete({
    populationSize: 50,
    candidatesRead: 50,
    readErrors: 0,
    stateDeferrals: 1,
  }), false);
});

test("a population sweep is healthy only when every candidate read succeeds", () => {
  assert.equal(interestSweepComplete({
    populationSize: 717,
    candidatesRead: 717,
    readErrors: 0,
  }), true);
  assert.equal(interestSweepComplete({
    populationSize: 717,
    candidatesRead: 135,
    readErrors: 582,
  }), false);
  assert.equal(interestSweepComplete({
    populationSize: 0,
    candidatesRead: 0,
    readErrors: 0,
  }), false);
});

test("interest sweeps advance through stable rate-limited population windows", () => {
  assert.deepEqual(interestSweepWindow({
    populationSize: 717,
    batchSize: 100,
    priorSweep: null,
  }), { continuing: false, start: 0, end: 100 });
  assert.deepEqual(interestSweepWindow({
    populationSize: 717,
    batchSize: 100,
    priorSweep: {
      populationSize: 717,
      cycleComplete: false,
      nextCursor: 600,
    },
  }), { continuing: true, start: 600, end: 700 });
  assert.deepEqual(interestSweepWindow({
    populationSize: 717,
    batchSize: 100,
    priorSweep: {
      populationSize: 717,
      cycleComplete: false,
      nextCursor: 700,
    },
  }), { continuing: true, start: 700, end: 717 });
});

test("population drift restarts the sweep rather than trusting a stale cursor", () => {
  assert.deepEqual(interestSweepWindow({
    populationSize: 718,
    batchSize: 100,
    priorSweep: {
      populationSize: 717,
      cycleComplete: false,
      nextCursor: 400,
    },
  }), { continuing: false, start: 0, end: 100 });
});

/* ------------------------------------------------------------------- copy */

test("copy is David's wording verbatim, singular", () => {
  const body = interestConfirmationBody({ firstName: "Thomas", roleCount: 1 });
  assert.match(body, /^Hey Thomas,\n/);
  assert.match(body, /signaled interest on the role I sent over!/);
  assert.match(body, /in front of the team asap/);
  assert.match(body, /Talk soon,\nDavid$/);
});

test("copy pluralises on multiple roles", () => {
  const body = interestConfirmationBody({ firstName: "Thomas", roleCount: 3 });
  assert.match(body, /on the roles I sent over/);
  assert.match(body, /in front of the teams asap/);
});

test("copy carries no em dash", () => {
  const body = interestConfirmationBody({ firstName: "Ana", roleCount: 2 });
  assert.ok(!/[—–]/.test(body), "em and en dashes are banned in shipped copy");
});

test("first name strips prepended symbols and rejects unusable names", () => {
  assert.equal(firstNameFor("⚡Serge-Eric Tremblay"), "Serge-Eric");
  assert.equal(firstNameFor("  Thomas Bulger "), "Thomas");
  assert.equal(firstNameFor(""), null);
  assert.equal(firstNameFor("   "), null);
  assert.equal(firstNameFor("12345"), null, "a name with no letters is unusable");
  // CR/LF are whitespace, so tokenising the first name already strips them:
  // the greeting is safe and the candidate still gets a correct "Hey Bad,".
  assert.equal(firstNameFor("Bad\r\nName"), "Bad", "newlines cannot reach a header");
  // A control character inside the token itself has no such escape hatch.
  assert.equal(firstNameFor("Bad\u0000Name"), null, "embedded control chars are rejected");
  assert.equal(firstNameFor("Zoë Smith"), "Zoë", "accented names survive");
});

test("subject threads onto an existing subject exactly once", () => {
  assert.equal(interestConfirmationSubject({ existingSubject: "Your roles" }), "Re: Your roles");
  assert.equal(interestConfirmationSubject({ existingSubject: "Re: Your roles" }), "Re: Your roles");
  assert.equal(interestConfirmationSubject({}), "Your roles");
});

test("html preserves blank lines as spacing and escapes", () => {
  const { html } = buildInterestConfirmation({ firstName: "A<b", roleCount: 1 });
  assert.ok(html.includes("<div><br></div>"), "blank lines become real spacing");
  assert.ok(html.includes("A&lt;b"), "content is escaped");
});

/* ------------------------------------------------------------------ gates */

test("dry run defaults on when unset", () => {
  const c = interestConfig({});
  assert.equal(c.dryRun, true);
  assert.equal(c.writesEnabled, false);
});

test("every write gate defaults closed", () => {
  const c = interestConfig({});
  assert.equal(c.stopArmed, false);
  assert.equal(c.emailArmed, false);
  assert.equal(c.submitArmed, false);
  assert.equal(c.postCallInterestEnabled, false);
});

test("post-call interest projection has its own explicit gate", () => {
  const c = interestConfig({ PARAAI_POST_CALL_INTEREST_ENABLED: "true" });
  assert.equal(c.postCallInterestEnabled, true);
});

test("email gate refuses to arm without the stop gate", () => {
  const c = interestConfig({ PARAAI_INTEREST_EMAIL_APPROVED: "1" });
  assert.equal(c.emailArmed, false);
  assert.ok(c.gateOrderViolations.length > 0);
});

test("submit gate refuses to arm without stop and email", () => {
  const c = interestConfig({ PARAAI_INTEREST_SUBMIT_APPROVED: "1", PARAAI_INTEREST_STOP_APPROVED: "1" });
  assert.equal(c.submitArmed, false);
  assert.ok(c.gateOrderViolations.some((v) => /SUBMIT_APPROVED/.test(v)));
});

test("gates arm in the correct order", () => {
  const c = interestConfig({
    PARAAI_INTEREST_ENABLED: "1",
    PARAAI_INTEREST_DRY_RUN: "0",
    PARAAI_INTEREST_RELEASE_NOT_BEFORE: "2026-07-29T00:00:00Z",
    PARAAI_INTEREST_STOP_APPROVED: "1",
    PARAAI_INTEREST_EMAIL_APPROVED: "1",
    PARAAI_INTEREST_SUBMIT_APPROVED: "1",
  }, Date.parse("2026-07-29T01:00:00Z"));
  assert.equal(c.stopArmed, true);
  assert.equal(c.emailArmed, true);
  assert.equal(c.submitArmed, true);
  assert.equal(c.writesEnabled, true);
  assert.deepEqual(c.gateOrderViolations, []);
});

test("the canary recipient may be an internal address; the candidate path still may not", () => {
  // Regression for a real production defect: every doc specified
  // EMAIL_CANARY_TO=david@raydar.xyz, but core.mjs normalizeEmail rejects
  // internal domains, so arming EMAIL yielded emailCanaryConfigured:false and a
  // permanently fail-closed canary_recipient_required. Safe, but the canary
  // could never fire. The old tests all used david@example.com, which passes
  // that filter, so nothing caught it.
  for (const internal of [
    "david@raydar.xyz",
    "david@raydargroup.com",
    "someone@paraform.com",
  ]) {
    assert.equal(normalizeCanaryEmail(internal), internal);
    // ...and the candidate-facing guard must be UNCHANGED for the same input.
    assert.equal(normalizeEmail(internal), "");
  }

  assert.equal(normalizeCanaryEmail("  David@Raydar.XYZ  "), "david@raydar.xyz");
  for (const bad of ["", null, undefined, "not-an-email", "a@b", "a b@c.com"]) {
    assert.equal(normalizeCanaryEmail(bad), "");
  }

  const internalCanary = interestConfig({
    PARAAI_INTEREST_ENABLED: "1",
    PARAAI_INTEREST_DRY_RUN: "0",
    PARAAI_INTEREST_RELEASE_NOT_BEFORE: "2026-07-29T00:00:00Z",
    PARAAI_INTEREST_STOP_APPROVED: "1",
    PARAAI_INTEREST_EMAIL_APPROVED: "1",
    PARAAI_INTEREST_EMAIL_CANARY_TO: "david@raydar.xyz",
  }, Date.parse("2026-07-29T01:00:00Z"));
  assert.equal(internalCanary.emailCanaryTo, "david@raydar.xyz");
  assert.equal(interestEmailPlan({ config: internalCanary }).canaryTo, "david@raydar.xyz");
  assert.equal(interestEmailPlan({ config: internalCanary }).skipped, null);
});

test("EMAIL-only rollout can target only the configured canary recipient", () => {
  const emailOnly = interestConfig({
    PARAAI_INTEREST_ENABLED: "1",
    PARAAI_INTEREST_DRY_RUN: "0",
    PARAAI_INTEREST_RELEASE_NOT_BEFORE: "2026-07-29T00:00:00Z",
    PARAAI_INTEREST_STOP_APPROVED: "1",
    PARAAI_INTEREST_EMAIL_APPROVED: "1",
    PARAAI_INTEREST_EMAIL_CANARY_TO: "david@example.com",
  }, Date.parse("2026-07-29T01:00:00Z"));
  assert.deepEqual(interestEmailPlan({ config: emailOnly }), {
    send: true,
    skipped: null,
    apply: true,
    canaryTo: "david@example.com",
  });
  assert.equal(
    interestEmailPlan({
      config: { ...emailOnly, emailCanaryTo: null },
    }).skipped,
    "canary_recipient_required",
  );

  const submitArmed = {
    ...emailOnly,
    submitArmed: true,
  };
  assert.equal(interestEmailPlan({ config: submitArmed }).canaryTo, null);
  assert.equal(
    interestEmailPlan({
      config: submitArmed,
      paraformOwnsConfirmation: true,
    }).skipped,
    "paraform_confirmation_owns_candidate_email",
  );
});

test("email canary uses a one-time global claim and never addresses the candidate", async () => {
  const claims = new Map();
  const recipients = [];
  const emailStore = {
    getEmailClaim: async (candidateUserId, batchId) =>
      claims.get(`${candidateUserId}:${batchId}`) || null,
    claimEmail: async (candidateUserId, batchId) => {
      const key = `${candidateUserId}:${batchId}`;
      if (claims.has(key)) return false;
      claims.set(key, { claimedAt: "now" });
      return true;
    },
    confirmEmail: async (candidateUserId, batchId, detail) => {
      claims.set(`${candidateUserId}:${batchId}`, { deliveredAt: "now", ...detail });
    },
  };
  const args = {
    candidate: {
      candidateUserId: "candidate-user-1",
      name: "Taylor Example",
      email: "candidate@example.com",
    },
    roleCount: 1,
    batchId: "batch-1",
    apply: true,
    canaryTo: "david@example.com",
    emailStore,
    mailer: async ({ to }) => {
      recipients.push(to);
      return { messageId: "message-1" };
    },
  };
  assert.equal((await sendConfirmation(args)).sent, true);
  assert.equal((await sendConfirmation({ ...args, batchId: "batch-2" })).sent, false);
  assert.deepEqual(recipients, ["david@example.com"]);
});

test("not-before must be a parseable timestamp to count as configured", () => {
  assert.equal(interestConfig({}).notBeforeConfigured, false);
  assert.equal(interestConfig({ PARAAI_INTEREST_NOT_BEFORE: "nonsense" }).notBeforeConfigured, false);
  assert.equal(interestConfig({ PARAAI_INTEREST_NOT_BEFORE: "2026-07-28T00:00:00Z" }).notBeforeConfigured, true);
});

test("all writes require a configured release time that has actually passed", () => {
  const env = {
    PARAAI_INTEREST_ENABLED: "1",
    PARAAI_INTEREST_DRY_RUN: "0",
    PARAAI_INTEREST_STOP_APPROVED: "1",
  };
  assert.equal(interestConfig(env).writesEnabled, false);
  assert.equal(interestConfig({
    ...env,
    PARAAI_INTEREST_RELEASE_NOT_BEFORE: "nonsense",
  }).writesEnabled, false);
  const pinned = {
    ...env,
    PARAAI_INTEREST_RELEASE_NOT_BEFORE: "2026-08-02T00:00:00Z",
  };
  assert.equal(
    interestConfig(pinned, Date.parse("2026-08-01T23:59:59Z")).writesEnabled,
    false,
  );
  assert.equal(
    interestConfig(pinned, Date.parse("2026-08-02T00:00:00Z")).writesEnabled,
    true,
  );
});

test("a job is bound to the rollout phase present at detection", () => {
  const at = Date.parse("2026-07-29T01:00:00Z");
  const base = {
    PARAAI_INTEREST_ENABLED: "1",
    PARAAI_INTEREST_DRY_RUN: "0",
    PARAAI_INTEREST_RELEASE_NOT_BEFORE: "2026-07-29T00:00:00Z",
  };
  assert.equal(
    interestRolloutPhase(interestConfig(base, at)),
    INTEREST_ROLLOUT_PHASE.SHADOW,
  );
  assert.equal(
    interestRolloutPhase(interestConfig({
      ...base,
      PARAAI_INTEREST_STOP_APPROVED: "1",
    }, at)),
    INTEREST_ROLLOUT_PHASE.STOP,
  );
  assert.equal(
    interestRolloutPhase(interestConfig({
      ...base,
      PARAAI_INTEREST_STOP_APPROVED: "1",
      PARAAI_INTEREST_EMAIL_APPROVED: "1",
    }, at)),
    INTEREST_ROLLOUT_PHASE.EMAIL_CANARY,
  );
  assert.equal(
    interestRolloutPhase(interestConfig({
      ...base,
      PARAAI_INTEREST_STOP_APPROVED: "1",
      PARAAI_INTEREST_EMAIL_APPROVED: "1",
      PARAAI_INTEREST_SUBMIT_APPROVED: "1",
    }, at)),
    INTEREST_ROLLOUT_PHASE.HUMAN_HANDOFF,
  );
});

test("later gates can never upgrade an earlier or legacy pending job", () => {
  const fullyArmed = interestConfig({
    PARAAI_INTEREST_ENABLED: "1",
    PARAAI_INTEREST_DRY_RUN: "0",
    PARAAI_INTEREST_RELEASE_NOT_BEFORE: "2026-07-29T00:00:00Z",
    PARAAI_INTEREST_STOP_APPROVED: "1",
    PARAAI_INTEREST_EMAIL_APPROVED: "1",
    PARAAI_INTEREST_SUBMIT_APPROVED: "1",
    PARAAI_INTEREST_EMAIL_CANARY_TO: "david@example.com",
  }, Date.parse("2026-07-29T01:00:00Z"));

  for (const legacy of [{}, { rolloutPhase: "unknown" }]) {
    assert.equal(
      interestJobRolloutPhase(legacy),
      INTEREST_ROLLOUT_PHASE.SHADOW,
    );
    const capped = interestJobExecutionConfig(fullyArmed, legacy);
    assert.equal(capped.writesEnabled, false);
    assert.equal(capped.stopArmed, false);
    assert.equal(capped.emailArmed, false);
    assert.equal(capped.submitArmed, false);
  }

  const stopOnly = interestJobExecutionConfig(fullyArmed, {
    rolloutPhase: INTEREST_ROLLOUT_PHASE.STOP,
  });
  assert.equal(stopOnly.writesEnabled, true);
  assert.equal(stopOnly.stopArmed, true);
  assert.equal(stopOnly.emailArmed, false);
  assert.equal(stopOnly.submitArmed, false);
  assert.deepEqual(interestEmailPlan({ config: stopOnly }), {
    send: true,
    skipped: null,
    apply: false,
    canaryTo: null,
  });

  const emailOnly = interestJobExecutionConfig(fullyArmed, {
    rolloutPhase: INTEREST_ROLLOUT_PHASE.EMAIL_CANARY,
  });
  assert.equal(emailOnly.stopArmed, true);
  assert.equal(emailOnly.emailArmed, true);
  assert.equal(emailOnly.submitArmed, false);
  assert.deepEqual(interestEmailPlan({ config: emailOnly }), {
    send: true,
    skipped: null,
    apply: true,
    canaryTo: "david@example.com",
  });

  const handoff = interestJobExecutionConfig(fullyArmed, {
    rolloutPhase: INTEREST_ROLLOUT_PHASE.HUMAN_HANDOFF,
  });
  assert.equal(handoff.stopArmed, true);
  assert.equal(handoff.emailArmed, true);
  assert.equal(handoff.submitArmed, true);
  assert.equal(interestEmailPlan({ config: handoff }).canaryTo, null);
});

test("closing a gate still removes a phase-bound job capability", () => {
  const currentStopOnly = interestConfig({
    PARAAI_INTEREST_ENABLED: "1",
    PARAAI_INTEREST_DRY_RUN: "0",
    PARAAI_INTEREST_RELEASE_NOT_BEFORE: "2026-07-29T00:00:00Z",
    PARAAI_INTEREST_STOP_APPROVED: "1",
  }, Date.parse("2026-07-29T01:00:00Z"));
  const capped = interestJobExecutionConfig(currentStopOnly, {
    rolloutPhase: INTEREST_ROLLOUT_PHASE.HUMAN_HANDOFF,
  });
  assert.equal(capped.writesEnabled, true);
  assert.equal(capped.stopArmed, true);
  assert.equal(capped.emailArmed, false);
  assert.equal(capped.submitArmed, false);
});

test("the worker can never make the final candidate submission", () => {
  assert.equal(interestWorkerMaySubmit(), false);
});

test("handoff feed hydrates identity transiently and never exposes email", async () => {
  const handoffs = await listInterestHandoffs({
    listHandoffsImpl: async () => [],
    listReviewsImpl: async () => [{
      candidateUserId: "candidate-user-1",
      reasons: ["human_submission_required"],
      createdAt: "2026-07-29T18:00:00Z",
      updatedAt: "2026-07-29T18:01:00Z",
    }],
    getJobImpl: async () => ({
      candidateUserId: "candidate-user-1",
      candidateId: "candidate-1",
      roles: ["role-1"],
      submissions: [{
        roleId: "role-1",
        stage: "would_submit",
        blockers: [],
      }],
      stopped: { paused: 1 },
      emailed: { sent: true },
    }),
    trpcGetImpl: async (proc) => {
      if (proc === "candidateUser.getCandidateUserById") {
        return {
          candidate: {
            id: "candidate-1",
            name: "Taylor Example",
            email: "private@example.com",
            linkedin_user: "taylor-example",
          },
        };
      }
      if (proc === "role.getRoleByIdSimple") {
        return {
          id: "role-1",
          title: "Founding Engineer",
          company: { name: "Example Co" },
        };
      }
      throw new Error(`unexpected procedure ${proc}`);
    },
  });
  assert.equal(handoffs.length, 1);
  assert.equal(handoffs[0].candidateName, "Taylor Example");
  assert.equal(handoffs[0].mode, "human_submission_required");
  assert.equal(handoffs[0].roles[0].title, "Founding Engineer");
  assert.equal("email" in handoffs[0], false);
  assert.match(handoffs[0].candidateHref, /candidate-user-1/);
});

test("legacy non-bankable reviews are visible as David-only manual review items", async () => {
  const handoffs = await listInterestHandoffs({
    listHandoffsImpl: async () => [],
    listReviewsImpl: async () => [{
      candidateUserId: "candidate-user-1",
      batchId: "batch-blocked-1",
      reasons: ["credits_exhausted", "no_bankable_role"],
      createdAt: "2026-07-29T22:51:54Z",
      updatedAt: "2026-07-29T22:51:54Z",
    }],
    getJobImpl: async () => ({
      candidateUserId: "candidate-user-1",
      candidateId: "candidate-1",
      batchId: "batch-blocked-1",
      roles: ["role-1"],
      submissions: [{
        roleId: "role-1",
        stage: "blocked",
        blockers: ["credits_exhausted"],
      }],
      stopped: { paused: 0 },
      emailed: { sent: false, skipped: "no_bankable_role" },
    }),
    trpcGetImpl: async (proc, input) => {
      if (proc === "candidateUser.getCandidateUserById") {
        return {
          candidate: {
            id: "candidate-1",
            name: "Taylor Example",
            email: "private@example.com",
          },
        };
      }
      if (proc === "role.getRoleByIdSimple") {
        return { id: input.role_id, title: "Role One" };
      }
      throw new Error(`unexpected procedure ${proc}`);
    },
  });
  assert.equal(handoffs.length, 1);
  assert.equal(handoffs[0].mode, "manual_review");
  assert.equal(handoffs[0].batchId, null);
  assert.deepEqual(
    handoffs[0].reasons,
    ["credits_exhausted", "no_bankable_role"],
  );
  assert.equal("email" in handoffs[0], false);
});

test("two archived batches for one candidate remain independently visible", async () => {
  let candidateReads = 0;
  const handoffs = await listInterestHandoffs({
    listHandoffsImpl: async () => [
      {
        candidateUserId: "candidate-user-1",
        candidateId: "candidate-1",
        batchId: "batch-1",
        mode: "shadow_observation",
        reasons: ["shadow_would_submit"],
        roles: ["role-1"],
        submissions: [{ roleId: "role-1", stage: "would_submit", blockers: [] }],
        stopped: { paused: 0 },
        emailed: { sent: false, skipped: "dry_run" },
        updatedAt: "2026-07-29T18:00:00Z",
      },
      {
        candidateUserId: "candidate-user-1",
        candidateId: "candidate-1",
        batchId: "batch-2",
        mode: "human_submission_required",
        reasons: ["human_submission_required"],
        roles: ["role-2"],
        submissions: [{ roleId: "role-2", stage: "would_submit", blockers: [] }],
        stopped: { paused: 1 },
        emailed: { sent: true },
        updatedAt: "2026-07-29T19:00:00Z",
      },
    ],
    listReviewsImpl: async () => [],
    trpcGetImpl: async (proc, input) => {
      if (proc === "candidateUser.getCandidateUserById") {
        candidateReads++;
        return {
          candidate: {
            id: "candidate-1",
            name: "Taylor Example",
            email: "private@example.com",
          },
        };
      }
      if (proc === "role.getRoleByIdSimple") {
        return {
          id: input.role_id,
          title: input.role_id === "role-1" ? "Role One" : "Role Two",
        };
      }
      throw new Error(`unexpected procedure ${proc}`);
    },
  });
  assert.equal(handoffs.length, 2);
  assert.deepEqual(
    handoffs.map((handoff) => handoff.batchId),
    ["batch-2", "batch-1"],
  );
  assert.equal(candidateReads, 1);
  assert.equal(handoffs[0].mode, "human_submission_required");
  assert.equal(handoffs[1].mode, "shadow_observation");
  assert.equal("email" in handoffs[0], false);
});

test("an archive suppresses only its matching legacy batch", async () => {
  const handoffs = await listInterestHandoffs({
    listHandoffsImpl: async () => [{
      candidateUserId: "candidate-user-1",
      candidateId: "candidate-1",
      batchId: "batch-1",
      mode: "shadow_observation",
      reasons: ["shadow_would_submit"],
      roles: ["role-1"],
      submissions: [],
    }],
    listReviewsImpl: async () => [
      {
        candidateUserId: "candidate-user-1",
        batchId: "batch-1",
        reasons: ["shadow_would_submit"],
      },
      {
        candidateUserId: "candidate-user-1",
        batchId: "batch-2",
        reasons: ["human_submission_required"],
      },
    ],
    getJobImpl: async () => ({
      candidateUserId: "candidate-user-1",
      candidateId: "candidate-1",
      batchId: "batch-2",
      roles: ["role-2"],
      submissions: [],
    }),
    trpcGetImpl: async (proc, input) => {
      if (proc === "candidateUser.getCandidateUserById") {
        return { candidate: { id: "candidate-1", name: "Taylor Example" } };
      }
      return { id: input.role_id, title: input.role_id };
    },
  });
  assert.equal(handoffs.length, 2);
  assert.deepEqual(
    handoffs.map((handoff) => handoff.roles[0].roleId).sort(),
    ["role-1", "role-2"],
  );
});

test("submit preflight pins Paraform's five required candidate preference fields", () => {
  assert.deepEqual(REQUIRED_CANDIDATE_PREFERENCE_FIELDS, [
    "locations",
    "salary_min",
    "workplace",
    "last_funding_round",
    "visa",
  ]);
});

/* --------------------------------------------------------------- contract */

test("trigger status is the captured value", () => {
  assert.equal(INTEREST_STATUS.APPLIED, "APPLIED_TO_ROLE");
});

test("stop scope is the five pinned curated-list sequence ids", () => {
  const ids = curatedListSequenceIds();
  assert.equal(ids.length, 5);
  for (const id of ids) assert.match(id, /^[a-z0-9]{20,}$/, "resolution is ID-first; names are diagnostics");
  assert.ok(ids.includes("cmqk75h7x00030bj8f5s6oaw8"));
  assert.ok(ids.includes("cmqpje4lh00040cki15nuuqc8"));
});

test("stop follow-ups ignores fuzzy search rows and verifies the exact lead", async () => {
  let paused = false;
  const writes = [];
  const candidate = {
    candidateUserId: "candidate-user-1",
    email: "candidate@example.com",
  };
  const trpcGetImpl = async (_proc, input) => {
    if (input.search === candidate.candidateUserId) {
      return {
        leads: [{
          cu_id: "candidate-user-other",
          ccu_id: "lead-other",
          candidate_email: "candidate+other@example.com",
          is_paused: false,
        }],
      };
    }
    return {
      leads: [
        {
          cu_id: "candidate-user-other",
          ccu_id: "lead-other",
          candidate_email: "candidate@example.com.invalid",
          is_paused: false,
        },
        {
          cu_id: candidate.candidateUserId,
          ccu_id: "lead-exact",
          candidate_email: "CANDIDATE@example.com",
          is_paused: paused,
        },
      ],
    };
  };
  const trpcPostImpl = async (_proc, input) => {
    writes.push(input.campaign_to_candidate_user_id);
    paused = true;
  };
  const result = await stopFollowUps({
    candidate,
    apply: true,
    sequenceIds: ["sequence-1"],
    trpcGetImpl,
    trpcPostImpl,
  });
  assert.deepEqual(writes, ["lead-exact"]);
  assert.deepEqual(result.verified, ["sequence-1"]);
  assert.deepEqual(result.errors, []);
});

test("any stop error closes the submit and email boundary", () => {
  assert.equal(interestStopCanProceed({ errors: [] }), true);
  assert.equal(
    interestStopCanProceed({ errors: ["sequence-1:stop_readback_unverified"] }),
    false,
  );
  assert.equal(interestStopCanProceed(null), false);
});
