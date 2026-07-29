import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  resumeOnlyBackfillMissingResumeTransition,
} from "../api/paraai/_lib/auto.mjs";
import {
  buildPreferenceRouting,
  buildPreferenceRoutingInput,
  buildSubmissionPayload,
} from "../api/paraai/_lib/pipeline.mjs";
import {
  hashSubmissionPayload,
} from "../api/paraai/_lib/store.mjs";
import {
  campaignLeadsAll,
} from "../api/paraai/_lib/core.mjs";
import {
  ALL_OUTCOME_SEQUENCE_IDS,
} from "../api/paraai/_lib/phase3-shadow-policy.mjs";
import {
  armResumeOnlyBackfillRemainder,
  commitResumeOnlyBackfillRecovery,
  commitResumeOnlyBackfillFirstTen,
  confidentHumanBackfillCall,
  confidentHumanBackfillReference,
  exactHumanBackfillNamesMatch,
  matchHumanBackfillRosterRow,
  mechanicalCanaryStatus,
  mechanicalRecoveryCanaryStatus,
  planResumeOnlyBackfillRecovery,
  readHumanBackfillPage,
  readHumanSuccessRoster,
  readResumeOnlyBackfillTargetMembershipSnapshot,
  resumeOnlyBackfillDiagnostics,
  resumeOnlyBackfillPreparationDecision,
  resumeOnlyBackfillReleaseCapacity,
  resumeOnlyBackfillTerminalPreflight,
  runResumeOnlyBackfillReleaseTick,
  runResumeOnlyBackfillPlanTick,
  verifyResumeOnlyBackfillFirstTen,
} from "../api/paraai/_lib/resume-only-backfill.mjs";

const NOW = Date.parse("2026-07-29T18:00:00.000Z");
const CALL_AT = "2026-07-01T18:00:00.000Z";

function candidateHash(candidateUserId) {
  return createHash("sha256")
    .update("paraai-resume-only-backfill-candidate-v1")
    .update("\0")
    .update(candidateUserId)
    .digest("hex");
}

function memoryStore() {
  let control = null;
  let recovery = null;
  const entries = new Map();
  const pending = new Set();
  return {
    async getControl() {
      return control && structuredClone(control);
    },
    async setControl(value) {
      control = structuredClone(value);
      return structuredClone(control);
    },
    async getRecovery() {
      return recovery && structuredClone(recovery);
    },
    async createRecovery(value) {
      if (recovery) return false;
      recovery = structuredClone(value);
      return true;
    },
    async setRecovery(value) {
      recovery = structuredClone(value);
      return structuredClone(recovery);
    },
    async addEntry(value) {
      if (entries.has(value.id)) return false;
      entries.set(value.id, structuredClone(value));
      pending.add(value.id);
      return true;
    },
    async getEntry(id) {
      const value = entries.get(id);
      return value && structuredClone(value);
    },
    async setEntry(value) {
      entries.set(value.id, structuredClone(value));
      return structuredClone(value);
    },
    async removePending(id) {
      pending.delete(id);
    },
    async pendingIds(limit = 1) {
      return [...pending]
        .sort((left, right) => (
          entries.get(left).callAt.localeCompare(
            entries.get(right).callAt,
          )
          || left.localeCompare(right)
        ))
        .slice(0, limit);
    },
    async entries() {
      return [...entries.values()].map((value) => (
        structuredClone(value)
      ));
    },
  };
}

function completePreferences() {
  const input = buildPreferenceRoutingInput(null, {
    country: "United States",
  });
  const routing = buildPreferenceRouting(
    { roleTypes: ["sales"] },
    input.native,
    input.context,
  );
  return { input, routing };
}

function readyJob(id, index = 0) {
  const { input, routing } = completePreferences();
  return {
    id,
    revision: 0,
    state: "ready_to_submit",
    callSourceVerified: true,
    callEndedAt: CALL_AT,
    successfulCallVerified: true,
    extracted: { roleTypes: ["sales"] },
    identity: {
      candidateUserId: `candidate-user-${index}`,
      candidateId: `candidate-${index}`,
      signals: ["linkedin", "scheduled_time"],
      ambiguous: false,
    },
    submission: {
      name: `Private Candidate ${index}`,
      email: `private.${index}@example.test`,
      linkedinUrl:
        `https://www.linkedin.com/in/private-candidate-${index}`,
      resumeUri: `s3://private/resume-${index}.pdf`,
      screeningCallLink: `https://calls.example.test/${id}`,
    },
    reviewPreferences: routing.preferences,
    reviewPolicy: {
      ...routing.policy,
      preferenceRoutingInput: input,
    },
    automation: {
      mode: "backfill_only",
      stepFailures: {},
    },
    journal: [],
    createdAt: CALL_AT,
    updatedAt: CALL_AT,
  };
}

function agentCall(id) {
  return {
    botId: id,
    source: { isScreener: true },
    joinAt: CALL_AT,
    endedAt: "2026-07-01T18:20:00.000Z",
    verdict: {
      verdict: "success",
      userChars: 500,
      speechDensity: 0.8,
    },
    media: { hasTranscript: true },
    transcript: [
      { role: "agent", text: "Tell me about your work." },
      {
        role: "candidate",
        text: "I have led enterprise sales teams for several years.",
      },
      {
        role: "candidate",
        text: "I am now looking for another growth-stage company.",
      },
    ],
  };
}

test("human discovery is restricted to transcript-backed phone transports", () => {
  const phone = {
    id: "human-call-1",
    event_scheduled_at: CALL_AT,
    meeting_platform: "PHONE/TWILIO",
    has_transcript: true,
  };
  assert.equal(confidentHumanBackfillReference(phone), true);
  assert.equal(confidentHumanBackfillReference({
    ...phone,
    meeting_platform: "GOOGLE_MEET",
  }), false);
  assert.equal(confidentHumanBackfillReference({
    ...phone,
    has_transcript: undefined,
  }), true);

  const call = {
    humanCall: true,
    humanPopulation: "phone_screen",
    platform: "PHONE",
    transcriptPresent: true,
    substance: {
      substantive: true,
      speakers: 2,
      quieterSpeakerChars: 800,
    },
    candidate: { fullName: "Private Candidate" },
  };
  assert.equal(confidentHumanBackfillCall(call), true);
  assert.equal(confidentHumanBackfillCall({
    ...call,
    platform: "GOOGLE_MEET",
  }), false);
  assert.equal(confidentHumanBackfillCall({
    ...call,
    substance: { ...call.substance, substantive: false },
  }), false);
});

test("human source requires the fresh complete roster and an exact one-to-one name/time join", async () => {
  const rosterBody = {
    ok: true,
    generatedAt: new Date(NOW).toISOString(),
    count: 2,
    degraded: {
      status: false,
      history: false,
      calendar: false,
    },
    calendarFeed: {
      complete: true,
      degraded: false,
      stale: false,
    },
    rows: [{
      key: "private-human-row-1",
      candidate: "Anne-Marie O'Brien",
      callType: "Human",
      status: "Success",
      startedAt: CALL_AT,
    }, {
      key: "private-agent-row-1",
      candidate: "Private Agent",
      callType: "Agent",
      status: "Success",
      startedAt: CALL_AT,
    }],
  };
  let rosterUrl = null;
  const rows = await readHumanSuccessRoster({
    boundaryAt: new Date(NOW).toISOString(),
    cutoffAt: new Date(
      NOW - 45 * 24 * 60 * 60_000,
    ).toISOString(),
    now: NOW,
    fetchImpl: async (url) => {
      rosterUrl = new URL(url);
      return new Response(
        JSON.stringify(rosterBody),
        {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        },
      );
    },
  });
  assert.equal(
    rosterUrl.searchParams.has("resumeChaseGuard"),
    true,
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, "Anne-Marie O'Brien");
  assert.match(rows[0].rosterHash, /^[a-f0-9]{64}$/u);
  assert.equal(
    exactHumanBackfillNamesMatch(
      "Anne-Marie O'Brien",
      "Anne Marie OBrien",
    ),
    false,
    "joined hyphenated first names must not match a different tokenization",
  );
  assert.equal(
    exactHumanBackfillNamesMatch(
      "Anne-Marie O'Brien",
      "Anne-Marie OBrien",
    ),
    true,
  );

  const meeting = {
    id: "private-human-call-1",
    event_scheduled_at: CALL_AT,
    meeting_platform: "PHONE",
    candidate_user: {
      candidate: {
        name: "Anne-Marie OBrien",
      },
    },
  };
  assert.equal(
    matchHumanBackfillRosterRow(meeting, rows)?.rosterHash,
    rows[0].rosterHash,
  );
  assert.equal(
    matchHumanBackfillRosterRow(meeting, [
      ...rows,
      { ...rows[0], rosterHash: "c".repeat(64) },
    ]),
    null,
    "more than one roster claim must fail closed",
  );

  await assert.rejects(
    () => readHumanSuccessRoster({
      boundaryAt: new Date(NOW).toISOString(),
      cutoffAt: new Date(
        NOW - 45 * 24 * 60 * 60_000,
      ).toISOString(),
      now: NOW,
      fetchImpl: async () => new Response(JSON.stringify({
        ...rosterBody,
        degraded: {
          ...rosterBody.degraded,
          calendar: true,
        },
      }), { status: 200 }),
    }),
    { code: "RESUME_ONLY_BACKFILL_ROSTER_INVALID" },
  );
  await assert.rejects(
    () => readHumanSuccessRoster({
      boundaryAt: new Date(NOW).toISOString(),
      cutoffAt: new Date(
        NOW - 45 * 24 * 60 * 60_000,
      ).toISOString(),
      now: NOW,
      fetchImpl: async () => new Response(JSON.stringify({
        ...rosterBody,
        calendarFeed: {
          ...rosterBody.calendarFeed,
          complete: false,
        },
      }), { status: 200 }),
    }),
    { code: "RESUME_ONLY_BACKFILL_ROSTER_INVALID" },
  );
});

test("agency-wide human page is server-selected and validates cursor continuity", async () => {
  let captured = null;
  const page = await readHumanBackfillPage({
    cursor: 50,
    trpcGetImpl: async (proc, input) => {
      captured = { proc, input };
      return {
        items: Array.from({ length: 2 }, (_, index) => ({
          id: `human-${index}`,
        })),
        next_cursor: 52,
      };
    },
  });
  assert.equal(
    captured.proc,
    "candidateUserMeeting.getMeetingsForRecruiter",
  );
  assert.equal(captured.input.include_agency_calls, true);
  assert.equal(captured.input.has_transcript, true);
  assert.equal(
    Object.hasOwn(captured.input, "owner_filter"),
    false,
  );
  assert.equal(page.nextCursor, 52);
  await assert.rejects(
    () => readHumanBackfillPage({
      cursor: 50,
      trpcGetImpl: async () => ({
        items: [{ id: "human-1" }],
        next_cursor: 99,
      }),
    }),
    { code: "RESUME_ONLY_BACKFILL_HUMAN_PAGE_INVALID" },
  );
});

test("plan freezes 45 days, prepares server-selected calls, and returns aggregates only", async () => {
  const store = memoryStore();
  const jobs = new Map();
  const ids = Array.from(
    { length: 11 },
    (_, index) => `bot_resume_only_${String(index).padStart(2, "0")}`,
  );
  const status = await runResumeOnlyBackfillPlanTick({
    now: NOW,
    store,
    lockImpl: async (operation) => operation(),
    readRecallPageImpl: async ({ boundaryAt, cursor, seenCursors }) => {
      assert.equal(boundaryAt, new Date(NOW).toISOString());
      assert.equal(cursor, null);
      assert.deepEqual(seenCursors, []);
      return {
        exhausted: true,
        nextCursor: null,
        scanned: ids.length,
        references: ids.map((id, index) => ({
          id,
          joinAt: new Date(
            Date.parse(CALL_AT) + index * 1_000,
          ).toISOString(),
        })),
      };
    },
    readHumanPageImpl: async () => ({
      items: [],
      nextCursor: null,
      exhausted: true,
    }),
    readHumanRosterImpl: async () => [],
    fetchAgentCall: async (id) => agentCall(id),
    getJobImpl: async (id) => jobs.get(id) || null,
    getResumeImpl: async () => ({
      resumeUri: "s3://private/resume.pdf",
    }),
    prepareJobImpl: async ({ botId }) => {
      const index = ids.indexOf(botId);
      const job = readyJob(
        botId,
        index === 1 ? 0 : index,
      );
      jobs.set(botId, job);
      return job;
    },
    advanceExistingImpl: async (job) => job,
    terminalPreflightImpl: async () => ({
      eligible: true,
      code: null,
    }),
    queueStatsImpl: async () => ({
      queued: 0,
      due: 0,
      leased: 0,
    }),
    config: {
      strictScreenerSource: true,
    },
    budgetMs: 1_000,
  });
  assert.equal(status.status, "planned");
  assert.equal(status.windowDays, 45);
  assert.equal(status.sources.discovered, 11);
  assert.equal(status.cohort.eligible, 11);
  assert.equal(status.canary.selected, 10);
  const storedControl = await store.getControl();
  assert.equal(storedControl.canary.ids.includes(ids[0]), true);
  assert.equal(
    storedControl.canary.ids.includes(ids[1]),
    false,
    "the first ten must contain ten distinct candidates",
  );
  const serialized = JSON.stringify(status);
  for (const id of ids) {
    assert.equal(serialized.includes(id), false);
  }
  assert.equal(serialized.includes("candidate-user-"), false);
  assert.equal(serialized.includes("@example.test"), false);
});

test("transient preparation failures leave the server-selected row pending for retry", async () => {
  const store = memoryStore();
  const id = "bot_retry_only_01";
  let failures = 1;
  let prepared = null;
  const common = {
    now: NOW,
    store,
    lockImpl: async (operation) => operation(),
    readRecallPageImpl: async () => ({
      exhausted: true,
      nextCursor: null,
      scanned: 1,
      references: [{ id, joinAt: CALL_AT }],
    }),
    readHumanPageImpl: async () => ({
      items: [],
      nextCursor: null,
      exhausted: true,
    }),
    readHumanRosterImpl: async () => [],
    fetchAgentCall: async () => {
      if (failures-- > 0) {
        const error = new Error("temporary source failure");
        error.code = "HTTP_503";
        throw error;
      }
      return agentCall(id);
    },
    getJobImpl: async () => prepared,
    getResumeImpl: async () => ({
      resumeUri: "s3://private/resume.pdf",
    }),
    prepareJobImpl: async () => {
      prepared = readyJob(id, 1);
      return prepared;
    },
    advanceExistingImpl: async (job) => job,
    terminalPreflightImpl: async () => ({
      eligible: true,
      code: null,
    }),
    queueStatsImpl: async () => ({
      queued: 0,
      due: 0,
      leased: 0,
    }),
    config: {
      strictScreenerSource: true,
    },
    budgetMs: 1_000,
  };
  await assert.rejects(
    () => runResumeOnlyBackfillPlanTick(common),
    { code: "RESUME_ONLY_BACKFILL_PREPARATION_RETRY" },
  );
  assert.deepEqual(await store.pendingIds(10), [id]);
  const retried = await runResumeOnlyBackfillPlanTick(common);
  assert.equal(retried.status, "insufficient");
  assert.equal(retried.cohort.eligible, 1);
  assert.equal(retried.cohort.excluded, 0);
});

test("planning preserves in-flight, submitted, technical, and resume-wait jobs", () => {
  const ready = readyJob("bot_preserve_ready", 1);
  assert.deepEqual(
    resumeOnlyBackfillPreparationDecision(ready),
    {
      prepare: true,
      force: false,
      reason: null,
    },
  );
  assert.equal(
    resumeOnlyBackfillPreparationDecision({
      ...ready,
      state: "submitting",
    }).reason,
    "submission_in_flight",
  );
  assert.equal(
    resumeOnlyBackfillPreparationDecision({
      ...ready,
      state: "awaiting_matches",
    }).reason,
    "already_submitted",
  );
  assert.equal(
    resumeOnlyBackfillPreparationDecision({
      ...ready,
      state: "waiting_for_resume",
      automation: {
        ...ready.automation,
        resumeWait: {
          source: "authorized_backfill",
        },
      },
    }).reason,
    "resume_wait_active",
  );
  assert.equal(
    resumeOnlyBackfillPreparationDecision({
      ...ready,
      automation: {
        ...ready.automation,
        lastFailure: {
          code: "AUTH_EXPIRED",
        },
      },
    }).reason,
    "technical_review",
  );
  assert.equal(
    resumeOnlyBackfillPreparationDecision({
      ...ready,
      submitAttemptStartedAt: CALL_AT,
    }).reason,
    "already_submitted",
  );
});

test("terminal preflight exhausts all target sequences and fails closed before authorization", async () => {
  const job = readyJob("bot_preflight_only", 1);
  const targets = ALL_OUTCOME_SEQUENCE_IDS.map((id) => ({
    sequence: { id },
  }));
  const run = (overrides = {}) => (
    resumeOnlyBackfillTerminalPreflight(job, {
      candidateDetailsImpl: async () => (
        overrides.details || { byId: {}, profile: {} }
      ),
      targetMembershipImpl: async () => ({
        targets: overrides.targets || targets,
        memberships: overrides.memberships || [],
      }),
    })
  );
  assert.deepEqual(await run(), {
    eligible: true,
    code: null,
  });
  assert.deepEqual(await run({
    memberships: [{
      sequence: targets[0].sequence,
      lead: { has_replied: true },
    }],
  }), {
    eligible: false,
    code: "HAS_REPLIED",
  });
  assert.deepEqual(await run({
    memberships: [{
      sequence: targets[1].sequence,
      lead: { has_replied: false },
    }],
  }), {
    eligible: false,
    code: "ALREADY_ENROLLED",
  });
  assert.deepEqual(await run({
    details: {
      byId: {
        next_step_at: "2099-01-01T00:00:00.000Z",
      },
    },
  }), {
    eligible: false,
    code: "FUTURE_NEXT_STEP",
  });
  await assert.rejects(
    () => run({ targets: targets.slice(0, -1) }),
    {
      code: "RESUME_ONLY_BACKFILL_PREFLIGHT_INCOMPLETE",
    },
  );
  await assert.rejects(
    () => run({
      memberships: [
        {
          sequence: targets[0].sequence,
          lead: { has_replied: false },
        },
        {
          sequence: targets[0].sequence,
          lead: { has_replied: false },
        },
      ],
    }),
    {
      code: "RESUME_ONLY_BACKFILL_PREFLIGHT_INCOMPLETE",
    },
  );
});

test("one exhaustive target snapshot is shared across every recovery preflight", async () => {
  const sequences = ALL_OUTCOME_SEQUENCE_IDS.map((id, index) => ({
    id,
    name: `renamed-outcome-sequence-${index}`,
  }));
  const reads = [];
  const snapshot =
    await readResumeOnlyBackfillTargetMembershipSnapshot({
      listSequencesImpl: async () => sequences,
      campaignLeadsAllImpl: async (sequenceId) => {
        reads.push(sequenceId);
        if (sequenceId === ALL_OUTCOME_SEQUENCE_IDS[0]) {
          return [{
            cu_id: "candidate-user-1",
            has_replied: true,
          }];
        }
        if (sequenceId === ALL_OUTCOME_SEQUENCE_IDS[1]) {
          return [{
            cu_id: "candidate-user-2",
            has_replied: false,
          }];
        }
        return [];
      },
    });
  assert.deepEqual(reads, ALL_OUTCOME_SEQUENCE_IDS);
  assert.equal(snapshot.byCandidate.size, 2);
  assert.deepEqual(
    await resumeOnlyBackfillTerminalPreflight(
      readyJob("bot_snapshot_only", 1),
      {
        candidateDetailsImpl: async () => ({
          byId: {},
          profile: {},
        }),
        targetMembershipSnapshot: snapshot,
      },
    ),
    {
      eligible: false,
      code: "HAS_REPLIED",
    },
  );
  await assert.rejects(
    () => readResumeOnlyBackfillTargetMembershipSnapshot({
      listSequencesImpl: async () => sequences,
      campaignLeadsAllImpl: async (sequenceId) => (
        sequenceId === ALL_OUTCOME_SEQUENCE_IDS[0]
          ? [
              { cu_id: "candidate-user-1" },
              { cu_id: "candidate-user-1" },
            ]
          : []
      ),
    }),
    {
      code: "RESUME_ONLY_BACKFILL_PREFLIGHT_INCOMPLETE",
    },
  );
  await assert.rejects(
    () => readResumeOnlyBackfillTargetMembershipSnapshot({
      listSequencesImpl: async () => sequences.slice(0, -1),
      campaignLeadsAllImpl: async () => [],
    }),
    {
      code: "RESUME_ONLY_BACKFILL_PREFLIGHT_INCOMPLETE",
    },
  );
});

test("campaign membership cannot truncate at a cap or accept page overlap", async () => {
  await assert.rejects(
    () => campaignLeadsAll("sequence-one", {
      trpcGetImpl: async () => ({
        leads: [],
        totalCount: 10_001,
      }),
    }),
    /incomplete campaign membership read/u,
  );
  let calls = 0;
  await assert.rejects(
    () => campaignLeadsAll("sequence-one", {
      trpcGetImpl: async () => {
        calls += 1;
        return calls === 1
          ? {
              leads: [{ cu_id: "candidate-1" }],
              totalCount: 2,
            }
          : {
              leads: [
                { cu_id: "candidate-1" },
                { cu_id: "candidate-2" },
              ],
            };
      },
    }),
    /incomplete campaign membership read/u,
  );
  const cursors = [];
  const complete = await campaignLeadsAll("sequence-one", {
    trpcGetImpl: async (_procedure, input) => {
      cursors.push(input.cursor ?? null);
      if (input.cursor == null) {
        return {
          leads: [
            { cu_id: "candidate-1" },
            { cu_id: "candidate-2" },
          ],
          totalCount: 5,
        };
      }
      return input.cursor === 2
        ? { leads: [{ cu_id: "candidate-3" }] }
        : {
            leads: [
              { cu_id: "candidate-4" },
              { cu_id: "candidate-5" },
            ],
          };
    },
  });
  assert.equal(complete.length, 5);
  assert.deepEqual(cursors, [null, 2, 3]);
});

test("release capacity never crosses the durable queue ceilings", () => {
  assert.equal(
    resumeOnlyBackfillReleaseCapacity({
      queued: 0,
      due: 0,
      leased: 0,
    }),
    5,
  );
  assert.equal(
    resumeOnlyBackfillReleaseCapacity({
      queued: 199,
      due: 9,
      leased: 4,
    }),
    1,
  );
  assert.equal(
    resumeOnlyBackfillReleaseCapacity({
      queued: 10,
      due: 10,
      leased: 0,
    }),
    0,
  );
  assert.equal(
    resumeOnlyBackfillReleaseCapacity({
      queued: 10,
      due: 0,
      leased: 5,
    }),
    0,
  );
  assert.throws(
    () => resumeOnlyBackfillReleaseCapacity({
      queued: undefined,
      due: 0,
      leased: 0,
    }),
    { code: "RESUME_ONLY_BACKFILL_QUEUE_INVALID" },
  );
});

test("first-ten commit rechecks resumes and sets a no-chase authorization fence", async () => {
  const store = memoryStore();
  const jobs = new Map();
  const ids = Array.from(
    { length: 10 },
    (_, index) => `bot_commit_only_${String(index).padStart(2, "0")}`,
  );
  const manifest = "a".repeat(64);
  await store.setControl({
    version: 1,
    status: "planned",
    boundaryAt: new Date(NOW).toISOString(),
    cutoffAt: new Date(
      NOW - 45 * 24 * 60 * 60_000,
    ).toISOString(),
    recall: {
      cursor: null,
      seenCursors: [],
      exhausted: true,
      scanned: 10,
      discovered: 10,
    },
    human: {
      cursor: 0,
      exhausted: true,
      scanned: 0,
      discovered: 0,
    },
    preparation: {
      attempted: 10,
      eligible: 10,
      excluded: 0,
    },
    createdAt: new Date(NOW).toISOString(),
    updatedAt: new Date(NOW).toISOString(),
    manifestDigest: manifest,
    canary: {
      status: "planned",
      ids,
      committedAt: null,
      verifiedAt: null,
    },
    release: {
      status: "not_armed",
      authorized: 0,
      excluded: 0,
      batchOrdinal: 0,
      armedAt: null,
      completedAt: null,
    },
  });
  for (const [index, id] of ids.entries()) {
    const job = readyJob(id, index);
    jobs.set(id, job);
    await store.addEntry({
      version: 1,
      id,
      source: "agent",
      callAt: CALL_AT,
      status: "eligible",
      candidateHash: null,
      reason: null,
      authorizedAt: null,
    });
    const entry = await store.getEntry(id);
    await store.setEntry({
      ...entry,
      candidateHash: candidateHash(
        job.identity.candidateUserId,
      ),
    });
  }
  const enqueued = [];
  const status = await commitResumeOnlyBackfillFirstTen({
    now: NOW,
    store,
    lockImpl: async (operation) => operation(),
    getJobImpl: async (id) => jobs.get(id) || null,
    getResumeImpl: async () => ({
      resumeUri: "s3://private/current.pdf",
    }),
    saveJobImpl: async (job, expectedRevision) => {
      assert.equal(expectedRevision, jobs.get(job.id).revision);
      const saved = {
        ...job,
        revision: expectedRevision + 1,
      };
      jobs.set(job.id, saved);
      return saved;
    },
    enqueueImpl: async (id, options) => {
      enqueued.push({ id, options });
      return { enqueued: true, duplicate: false };
    },
    terminalPreflightImpl: async () => ({
      eligible: true,
      code: null,
    }),
    queueStatsImpl: async () => ({
      queued: 10,
      due: 10,
      leased: 0,
    }),
  });
  assert.equal(status.status, "canary_running");
  assert.equal(status.committed, 10);
  assert.equal(enqueued.length, 10);
  for (const job of jobs.values()) {
    assert.equal(job.automation.mode, "authorized_backfill");
    assert.equal(job.automation.resumeOnlySubmit, true);
    assert.equal(
      job.automation.resumeOnlyManifestDigest,
      manifest,
    );
    assert.equal(job.automation.resumeOnlyCohort, "canary");
    assert.equal(job.automation.resumeWait, null);
    assert.equal(
      job.automation.preferenceRerouteRequired,
      true,
    );
  }
  assert.equal(
    enqueued.every(({ options }) => (
      options.source === "authorized_backfill"
    )),
    true,
  );
});

function verifiedCanaryJob(id, index, manifest) {
  const base = readyJob(id, index);
  const batchAt = "2026-07-29T18:00:00.000Z";
  const prepared = {
    ...base,
    state: "awaiting_matches",
    automation: {
      ...base.automation,
      mode: "authorized_backfill",
      backfillBatchEntryAt: batchAt,
      resumeOnlySubmit: true,
      resumeOnlyManifestDigest: manifest,
      resumeOnlyCohort: "canary",
      resumeWait: null,
      preferenceRerouteRequired: false,
      preferenceRoutedAt: "2026-07-29T18:01:00.000Z",
      stepFailures: {},
    },
    submitAttemptStartedAt: "2026-07-29T18:02:00.000Z",
    submitAcceptedAt: "2026-07-29T18:03:00.000Z",
    submissionApprovalCheckedAt: "2026-07-29T18:04:00.000Z",
    matchLegStartedAt: "2026-07-29T18:04:00.000Z",
    submitReadbackVerified: true,
    error: null,
    journal: [{
      at: "2026-07-29T18:04:00.000Z",
      detail: "Paraform submission verified",
    }],
  };
  return {
    ...prepared,
    submitPayloadHash: hashSubmissionPayload(
      buildSubmissionPayload(prepared),
    ),
  };
}

async function recoveryFixture() {
  const store = memoryStore();
  const manifest = "e".repeat(64);
  const originalIds = Array.from(
    { length: 10 },
    (_, index) => `bot_recovery_original_${String(index).padStart(2, "0")}`,
  );
  const replacementIds = Array.from(
    { length: 3 },
    (_, index) => `bot_recovery_replace_${String(index).padStart(2, "0")}`,
  );
  const jobs = new Map();
  await store.setControl({
    version: 1,
    status: "canary_running",
    boundaryAt: new Date(NOW).toISOString(),
    cutoffAt: new Date(
      NOW - 45 * 24 * 60 * 60_000,
    ).toISOString(),
    recall: {
      cursor: null,
      seenCursors: [],
      exhausted: true,
      scanned: 13,
      discovered: 13,
    },
    human: {
      cursor: 0,
      exhausted: true,
      scanned: 0,
      discovered: 0,
      rosterSuccessful: 0,
    },
    preparation: {
      attempted: 13,
      eligible: 3,
      excluded: 0,
    },
    createdAt: new Date(NOW).toISOString(),
    updatedAt: new Date(NOW).toISOString(),
    manifestDigest: manifest,
    canary: {
      status: "running",
      ids: originalIds,
      committedAt: new Date(NOW).toISOString(),
      verifiedAt: null,
    },
    release: {
      status: "not_armed",
      authorized: 0,
      excluded: 0,
      batchOrdinal: 0,
      armedAt: null,
      completedAt: null,
    },
  });
  for (const [index, id] of originalIds.entries()) {
    let job;
    if (index < 6) {
      job = verifiedCanaryJob(id, index, manifest);
      if (index < 3) {
        job = {
          ...job,
          error: {
            code: "AUTH_EXPIRED",
            detail: "stale pre-success auth marker",
          },
          automation: {
            ...job.automation,
            lastFailure: {
              code: "AUTH_EXPIRED",
              step: "submission_read",
            },
          },
        };
      }
    } else {
      job = {
        ...readyJob(id, index),
        automation: {
          ...readyJob(id, index).automation,
          mode: "authorized_backfill",
          backfillBatchEntryAt: new Date(NOW).toISOString(),
          resumeOnlySubmit: true,
          resumeOnlyManifestDigest: manifest,
          resumeOnlyCohort: "canary",
          resumeWait: null,
        },
      };
      if (index < 9) {
        job = {
          ...job,
          state: "error",
          error: {
            code: index === 6
              ? "HAS_REPLIED"
              : "ALREADY_ENROLLED",
          },
        };
      }
    }
    jobs.set(id, job);
    await store.addEntry({
      version: 1,
      id,
      source: "agent",
      callAt: new Date(
        Date.parse(CALL_AT) + index * 1_000,
      ).toISOString(),
      status: "authorized",
      candidateHash: candidateHash(
        job.identity.candidateUserId,
      ),
      reason: null,
      authorizedAt: new Date(NOW).toISOString(),
    });
  }
  for (const [index, id] of replacementIds.entries()) {
    const job = readyJob(id, index + 20);
    jobs.set(id, job);
    await store.addEntry({
      version: 1,
      id,
      source: "agent",
      callAt: new Date(
        Date.parse(CALL_AT) + (index + 20) * 1_000,
      ).toISOString(),
      status: "eligible",
      candidateHash: candidateHash(
        job.identity.candidateUserId,
      ),
      reason: null,
      authorizedAt: null,
    });
  }
  const terminalPreflightImpl = async (job) => {
    const code = String(job?.error?.code || "");
    return ["HAS_REPLIED", "ALREADY_ENROLLED"].includes(code)
      ? { eligible: false, code }
      : { eligible: true, code: null };
  };
  return {
    store,
    manifest,
    originalIds,
    replacementIds,
    jobs,
    terminalPreflightImpl,
  };
}

test("manifest recovery carries verified writes and replaces only proved pre-attempt terminals", async () => {
  const fixture = await recoveryFixture();
  const {
    store,
    manifest,
    originalIds,
    replacementIds,
    jobs,
    terminalPreflightImpl,
  } = fixture;
  const common = {
    now: NOW + 60_000,
    store,
    lockImpl: async (operation) => operation(),
    getJobImpl: async (id) => jobs.get(id) || null,
    getResumeImpl: async () => ({
      resumeUri: "s3://private/current.pdf",
    }),
    terminalPreflightImpl,
    config: {
      strictScreenerSource: true,
    },
  };
  const planned = await planResumeOnlyBackfillRecovery({
    ...common,
    advanceExistingImpl: async (job) => job,
  });
  assert.deepEqual(planned, {
    status: "planned",
    revision: 1,
    selected: 10,
    carried: 6,
    retry: 1,
    replacements: 3,
    terminal: 3,
    skippedUnreadable: 0,
    manifestBound: true,
    committed: false,
    verified: false,
  });
  const privateRecovery = await store.getRecovery();
  assert.deepEqual(
    privateRecovery.active.map((entry) => entry.role),
    [
      "carried",
      "carried",
      "carried",
      "carried",
      "carried",
      "carried",
      "retry",
      "replacement",
      "replacement",
      "replacement",
    ],
  );
  assert.deepEqual(
    privateRecovery.terminal.map((entry) => entry.code),
    ["HAS_REPLIED", "ALREADY_ENROLLED", "ALREADY_ENROLLED"],
  );
  const serializedPlan = JSON.stringify(planned);
  for (const id of [...originalIds, ...replacementIds]) {
    assert.equal(serializedPlan.includes(id), false);
  }

  const enqueued = [];
  const committed = await commitResumeOnlyBackfillRecovery({
    ...common,
    saveJobImpl: async (job, expectedRevision) => {
      assert.equal(expectedRevision, jobs.get(job.id).revision);
      const saved = {
        ...job,
        revision: expectedRevision + 1,
      };
      jobs.set(job.id, saved);
      return saved;
    },
    enqueueImpl: async (id, options) => {
      enqueued.push({ id, options });
      return { enqueued: true, duplicate: false };
    },
  });
  assert.equal(committed.status, "running");
  assert.equal(committed.carriedCommitted, 6);
  assert.equal(committed.queued, 4);
  assert.deepEqual(
    enqueued.map(({ id }) => id),
    [originalIds[9], ...replacementIds],
  );
  assert.equal(
    enqueued.every(({ options }) => (
      options.source === "authorized_backfill"
      && options.eventId.includes(
        privateRecovery.manifestDigest,
      )
    )),
    true,
  );
  for (const record of privateRecovery.active) {
    const job = jobs.get(record.id);
    assert.equal(
      job.automation.resumeOnlyRecoveryManifestDigest,
      privateRecovery.manifestDigest,
    );
    assert.equal(
      job.automation.resumeOnlyCohort,
      "canary_recovery",
    );
  }
  for (const id of originalIds.slice(0, 6)) {
    assert.equal(jobs.get(id).error, null);
    assert.equal(jobs.get(id).automation.lastFailure, null);
  }
  for (const id of originalIds.slice(6, 9)) {
    assert.equal(jobs.get(id).state, "error");
    assert.equal(
      jobs.get(id).automation.resumeOnlyRecoveryManifestDigest,
      undefined,
    );
  }

  for (const record of privateRecovery.active) {
    if (record.role === "carried") continue;
    const current = jobs.get(record.id);
    let successful = {
      ...current,
      state: "awaiting_matches",
      revision: current.revision,
      automation: {
        ...current.automation,
        preferenceRerouteRequired: false,
        preferenceRoutedAt: "2026-07-29T18:01:00.000Z",
        resumeOnlyRecoveryManifestDigest:
          privateRecovery.manifestDigest,
        resumeOnlyCohort: "canary_recovery",
      },
      submitAttemptStartedAt: "2026-07-29T18:02:00.000Z",
      submitAcceptedAt: "2026-07-29T18:03:00.000Z",
      submissionApprovalCheckedAt:
        "2026-07-29T18:04:00.000Z",
      matchLegStartedAt: "2026-07-29T18:04:00.000Z",
      submitReadbackVerified: true,
      error: null,
      journal: [{
        at: "2026-07-29T18:04:00.000Z",
        detail: "Paraform submission verified",
      }],
    };
    successful = {
      ...successful,
      submitPayloadHash: hashSubmissionPayload(
        buildSubmissionPayload(successful),
      ),
    };
    jobs.set(record.id, successful);
  }
  const recoveryMechanical = await mechanicalRecoveryCanaryStatus(
    await store.getControl(),
    await store.getRecovery(),
    await store.entries(),
    {
      getJobImpl: async (id) => jobs.get(id),
    },
  );
  assert.equal(
    recoveryMechanical.verified,
    true,
    JSON.stringify(recoveryMechanical),
  );
  assert.equal(recoveryMechanical.talentNetworkVisible, 10);
  assert.equal(recoveryMechanical.errors, 0);
  const recoveryRecord = await store.getRecovery();
  const stampedId = recoveryRecord.active[0].id;
  const correctlyStamped = jobs.get(stampedId);
  jobs.set(stampedId, {
    ...correctlyStamped,
    automation: {
      ...correctlyStamped.automation,
      resumeOnlyRecoveryManifestDigest: "f".repeat(64),
    },
  });
  assert.equal(
    (await mechanicalRecoveryCanaryStatus(
      await store.getControl(),
      recoveryRecord,
      await store.entries(),
      { getJobImpl: async (id) => jobs.get(id) },
    )).verified,
    false,
  );
  jobs.set(stampedId, correctlyStamped);
  const tamperedRecovery = structuredClone(recoveryRecord);
  tamperedRecovery.active[0].role = "retry";
  assert.equal(
    (await mechanicalRecoveryCanaryStatus(
      await store.getControl(),
      tamperedRecovery,
      await store.entries(),
      { getJobImpl: async (id) => jobs.get(id) },
    )).verified,
    false,
  );

  const verified = await verifyResumeOnlyBackfillFirstTen({
    ...common,
    queueStatsImpl: async () => ({
      queued: 0,
      due: 0,
      leased: 0,
    }),
  });
  assert.equal(verified.verificationRecorded, true);
  assert.equal((await store.getRecovery()).status, "verified");
  const armed = await armResumeOnlyBackfillRemainder({
    ...common,
    queueStatsImpl: async () => ({
      queued: 0,
      due: 0,
      leased: 0,
    }),
  });
  assert.equal(armed.status, "running");
  assert.equal(armed.recovery.verified, true);
});

test("recovery leaves an unreadable replacement unauthorized and selects the next safe row", async () => {
  const fixture = await recoveryFixture();
  const {
    store,
    jobs,
    replacementIds,
    terminalPreflightImpl,
  } = fixture;
  const extraId = "bot_recovery_replace_03";
  const extraJob = readyJob(extraId, 23);
  jobs.set(extraId, extraJob);
  await store.addEntry({
    version: 1,
    id: extraId,
    source: "agent",
    callAt: new Date(
      Date.parse(CALL_AT) + 23_000,
    ).toISOString(),
    status: "eligible",
    candidateHash: candidateHash(
      extraJob.identity.candidateUserId,
    ),
    reason: null,
    authorizedAt: null,
  });
  const planned = await planResumeOnlyBackfillRecovery({
    now: NOW + 60_000,
    store,
    lockImpl: async (operation) => operation(),
    getJobImpl: async (id) => jobs.get(id) || null,
    getResumeImpl: async () => ({
      resumeUri: "s3://private/current.pdf",
    }),
    terminalPreflightImpl,
    config: {
      strictScreenerSource: true,
    },
    advanceExistingImpl: async (job) => {
      if (job.id === replacementIds[0]) {
        throw new Error("candidate-specific vendor read failed");
      }
      return job;
    },
  });
  assert.equal(planned.status, "planned");
  assert.equal(planned.replacements, 3);
  assert.equal(planned.skippedUnreadable, 1);
  const privateRecovery = await store.getRecovery();
  assert.equal(
    privateRecovery.active.some(
      (entry) => entry.id === replacementIds[0],
    ),
    false,
  );
  assert.equal(
    (await store.getEntry(replacementIds[0])).status,
    "eligible",
  );
  assert.equal(
    privateRecovery.active.some(
      (entry) => entry.id === extraId,
    ),
    true,
  );

  const authBlocked = await recoveryFixture();
  await assert.rejects(
    () => planResumeOnlyBackfillRecovery({
      now: NOW + 60_000,
      store: authBlocked.store,
      lockImpl: async (operation) => operation(),
      getJobImpl: async (id) => (
        authBlocked.jobs.get(id) || null
      ),
      getResumeImpl: async () => ({
        resumeUri: "s3://private/current.pdf",
      }),
      terminalPreflightImpl:
        authBlocked.terminalPreflightImpl,
      config: {
        strictScreenerSource: true,
      },
      advanceExistingImpl: async (job) => {
        if (job.id === authBlocked.replacementIds[0]) {
          const error = new Error("AUTH_EXPIRED");
          error.code = "AUTH_EXPIRED";
          throw error;
        }
        return job;
      },
    }),
    {
      code:
        "RESUME_ONLY_BACKFILL_RECOVERY_AUTH_EXPIRED",
    },
  );
  assert.equal(
    await authBlocked.store.getRecovery(),
    null,
  );

  const snapshotBlocked = await recoveryFixture();
  await assert.rejects(
    () => planResumeOnlyBackfillRecovery({
      now: NOW + 60_000,
      store: snapshotBlocked.store,
      lockImpl: async (operation) => operation(),
      getJobImpl: async (id) => (
        snapshotBlocked.jobs.get(id) || null
      ),
      getResumeImpl: async () => ({
        resumeUri: "s3://private/current.pdf",
      }),
      terminalPreflightImpl:
        resumeOnlyBackfillTerminalPreflight,
      targetMembershipSnapshotImpl: async () => {
        throw new Error("opaque vendor snapshot failure");
      },
      config: {
        strictScreenerSource: true,
      },
      advanceExistingImpl: async (job) => job,
    }),
    {
      code:
        "RESUME_ONLY_BACKFILL_RECOVERY_TARGET_SNAPSHOT_FAILED",
    },
  );
  assert.equal(
    await snapshotBlocked.store.getRecovery(),
    null,
  );
});

test("recovery refuses uncertain submissions and revalidates every terminal before writes", async () => {
  const uncertain = await recoveryFixture();
  uncertain.jobs.set(uncertain.originalIds[9], {
    ...uncertain.jobs.get(uncertain.originalIds[9]),
    state: "submitting",
    submitAttemptStartedAt: "2026-07-29T18:02:00.000Z",
  });
  await assert.rejects(
    () => planResumeOnlyBackfillRecovery({
      now: NOW + 60_000,
      store: uncertain.store,
      lockImpl: async (operation) => operation(),
      getJobImpl: async (id) => uncertain.jobs.get(id),
      getResumeImpl: async () => ({
        resumeUri: "s3://private/current.pdf",
      }),
      advanceExistingImpl: async (job) => job,
      terminalPreflightImpl:
        uncertain.terminalPreflightImpl,
      config: { strictScreenerSource: true },
    }),
    {
      code: "RESUME_ONLY_BACKFILL_RECOVERY_REVIEW_REQUIRED",
    },
  );
  assert.equal(await uncertain.store.getRecovery(), null);

  const changed = await recoveryFixture();
  const common = {
    now: NOW + 60_000,
    store: changed.store,
    lockImpl: async (operation) => operation(),
    getJobImpl: async (id) => changed.jobs.get(id),
    getResumeImpl: async () => ({
      resumeUri: "s3://private/current.pdf",
    }),
    advanceExistingImpl: async (job) => job,
    terminalPreflightImpl: changed.terminalPreflightImpl,
    config: { strictScreenerSource: true },
  };
  await planResumeOnlyBackfillRecovery(common);
  let saves = 0;
  let enqueues = 0;
  await assert.rejects(
    () => commitResumeOnlyBackfillRecovery({
      ...common,
      terminalPreflightImpl: async () => ({
        eligible: true,
        code: null,
      }),
      saveJobImpl: async () => {
        saves += 1;
      },
      enqueueImpl: async () => {
        enqueues += 1;
      },
    }),
    {
      code:
        "RESUME_ONLY_BACKFILL_RECOVERY_CLASSIFICATION_CHANGED",
    },
  );
  assert.equal(saves, 0);
  assert.equal(enqueues, 0);
  assert.equal((await changed.store.getRecovery()).status, "planned");
});

test("a partial recovery enqueue resumes from the manifest-bound committing state", async () => {
  const fixture = await recoveryFixture();
  const common = {
    now: NOW + 60_000,
    store: fixture.store,
    lockImpl: async (operation) => operation(),
    getJobImpl: async (id) => fixture.jobs.get(id),
    getResumeImpl: async () => ({
      resumeUri: "s3://private/current.pdf",
    }),
    advanceExistingImpl: async (job) => job,
    terminalPreflightImpl: fixture.terminalPreflightImpl,
    config: { strictScreenerSource: true },
    saveJobImpl: async (job, expectedRevision) => {
      assert.equal(
        expectedRevision,
        fixture.jobs.get(job.id).revision,
      );
      const saved = {
        ...job,
        revision: expectedRevision + 1,
      };
      fixture.jobs.set(job.id, saved);
      return saved;
    },
  };
  await planResumeOnlyBackfillRecovery(common);
  let attempts = 0;
  await assert.rejects(
    () => commitResumeOnlyBackfillRecovery({
      ...common,
      enqueueImpl: async () => {
        attempts += 1;
        return attempts < 3
          ? { enqueued: true, duplicate: false }
          : { enqueued: false, duplicate: false };
      },
    }),
    {
      code: "RESUME_ONLY_BACKFILL_RECOVERY_COMMIT_FAILED",
    },
  );
  assert.equal(attempts, 3);
  assert.equal(
    (await fixture.store.getRecovery()).status,
    "committing",
  );
  const resumed = await commitResumeOnlyBackfillRecovery({
    ...common,
    enqueueImpl: async () => ({
      enqueued: false,
      duplicate: true,
    }),
  });
  assert.equal(resumed.status, "running");
  assert.equal(resumed.queued, 0);
  assert.equal(resumed.duplicate, 4);
});

test("running recovery normalizes only exact positive submission readback", async () => {
  const fixture = await recoveryFixture();
  const common = {
    now: NOW + 60_000,
    store: fixture.store,
    lockImpl: async (operation) => operation(),
    getJobImpl: async (id) => fixture.jobs.get(id),
    getResumeImpl: async () => ({
      resumeUri: "s3://private/current.pdf",
    }),
    advanceExistingImpl: async (job) => job,
    terminalPreflightImpl: fixture.terminalPreflightImpl,
    config: { strictScreenerSource: true },
    saveJobImpl: async (job, expectedRevision) => {
      assert.equal(
        expectedRevision,
        fixture.jobs.get(job.id).revision,
      );
      const saved = {
        ...job,
        revision: expectedRevision + 1,
      };
      fixture.jobs.set(job.id, saved);
      return saved;
    },
  };
  await planResumeOnlyBackfillRecovery(common);
  await commitResumeOnlyBackfillRecovery({
    ...common,
    enqueueImpl: async () => ({
      enqueued: true,
      duplicate: false,
    }),
  });
  const recovery = await fixture.store.getRecovery();
  const repairedId = fixture.originalIds[9];
  const current = fixture.jobs.get(repairedId);
  const submitClaimedAt = "2026-07-29T18:01:00.000Z";
  const submitAttemptStartedAt =
    "2026-07-29T18:02:00.000Z";
  const submissionApprovalCheckedAt =
    "2026-07-29T18:04:00.000Z";
  const awaitingMatches = {
    ...current,
    state: "awaiting_matches",
    automation: {
      ...current.automation,
      preferenceRerouteRequired: false,
      preferenceRoutedAt: "2026-07-29T18:01:30.000Z",
      lastFailure: {
        step: "submit",
        code: "SUBMIT_WRITE_UNKNOWN",
        message: "write result unknown",
      },
      stepFailures: {
        submit: {
          count: 1,
          code: "SUBMIT_WRITE_UNKNOWN",
          message: "write result unknown",
        },
      },
    },
    submitClaimedAt,
    submitAttemptStartedAt,
    submitAcceptedAt: submitClaimedAt,
    submissionApprovalCheckedAt,
    matchLegStartedAt: submissionApprovalCheckedAt,
    submitReadbackVerified: true,
    error: {
      code: "SUBMIT_WRITE_UNKNOWN",
      detail: "write result unknown",
    },
    journal: [{
      at: submissionApprovalCheckedAt,
      detail: "Paraform submission verified",
    }],
  };
  fixture.jobs.set(repairedId, {
    ...awaitingMatches,
    submitPayloadHash: hashSubmissionPayload(
      buildSubmissionPayload(awaitingMatches),
    ),
  });

  const pendingId = fixture.replacementIds[0];
  const pending = fixture.jobs.get(pendingId);
  fixture.jobs.set(pendingId, {
    ...pending,
    automation: {
      ...pending.automation,
      lastFailure: {
        step: "submit",
        code: "SUBMIT_WRITE_UNKNOWN",
        message: "must remain without readback proof",
      },
      stepFailures: {
        submit: {
          count: 1,
          code: "SUBMIT_WRITE_UNKNOWN",
          message: "must remain without readback proof",
        },
      },
    },
  });

  const normalized = await commitResumeOnlyBackfillRecovery({
    ...common,
    enqueueImpl: async () => {
      assert.fail("running recovery must not enqueue again");
    },
  });
  assert.equal(normalized.status, "running");
  assert.equal(normalized.reconciledVisibleSubmissions, 1);
  const repaired = fixture.jobs.get(repairedId);
  assert.equal(
    repaired.submitAcceptedAt,
    submissionApprovalCheckedAt,
  );
  assert.equal(repaired.error, null);
  assert.equal(repaired.automation.lastFailure, null);
  assert.deepEqual(repaired.automation.stepFailures, {});
  assert.equal(
    repaired.automation.resumeOnlyRecoveryManifestDigest,
    recovery.manifestDigest,
  );
  assert.notEqual(
    fixture.jobs.get(pendingId).automation.lastFailure,
    null,
  );

  const replayed = await commitResumeOnlyBackfillRecovery({
    ...common,
  });
  assert.equal(replayed.reconciledVisibleSubmissions, 0);
});

test("mechanical first-ten verification requires ten real submissions and every resume-only fence", async () => {
  const ids = Array.from(
    { length: 10 },
    (_, index) => `bot_verified_only_${String(index).padStart(2, "0")}`,
  );
  const manifest = "b".repeat(64);
  const jobs = new Map(ids.map((id, index) => [
    id,
    verifiedCanaryJob(id, index, manifest),
  ]));
  const entries = ids.map((id, index) => ({
    version: 1,
    id,
    source: "agent",
    callAt: CALL_AT,
    status: "authorized",
    candidateHash: String(index).padStart(64, "a"),
    reason: null,
    authorizedAt: "2026-07-29T18:00:00.000Z",
  }));
  const control = {
    status: "canary_running",
    manifestDigest: manifest,
    canary: {
      status: "running",
      ids,
    },
  };
  const verified = await mechanicalCanaryStatus(
    control,
    entries,
    {
      getJobImpl: async (id) => jobs.get(id),
    },
  );
  assert.equal(verified.verified, true);
  assert.equal(verified.talentNetworkVisible, 10);
  assert.equal(verified.preexistingVisible, 0);

  jobs.get(ids[0]).automation.resumeWait = {
    source: "authorized_backfill",
  };
  const chaseable = await mechanicalCanaryStatus(
    control,
    entries,
    {
      getJobImpl: async (id) => jobs.get(id),
    },
  );
  assert.equal(chaseable.resumeOnlyFenceIntact, false);
  assert.equal(chaseable.verified, false);

  jobs.set(ids[0], {
    ...verifiedCanaryJob(ids[0], 0, manifest),
    journal: [{
      detail:
        "Talent Network membership already visible; submission write skipped",
    }, {
      detail: "Paraform submission verified",
    }],
  });
  const preexisting = await mechanicalCanaryStatus(
    control,
    entries,
    {
      getJobImpl: async (id) => jobs.get(id),
    },
  );
  assert.equal(preexisting.preexistingVisible, 1);
  assert.equal(preexisting.verified, false);
});

test("canary diagnostics aggregate recovery classes without exposing private rows", async () => {
  const ids = Array.from(
    { length: 10 },
    (_, index) => `bot_diagnostic_${String(index).padStart(2, "0")}`,
  );
  const manifest = "c".repeat(64);
  const jobs = new Map(ids.map((id, index) => [
    id,
    index < 3
      ? verifiedCanaryJob(id, index, manifest)
      : {
          ...readyJob(id, index),
          state: index < 5 ? "error" : "ready_to_submit",
          ...(index < 5
            ? {
                error: {
                  code: index === 3
                    ? "HAS_REPLIED"
                    : "ALREADY_ENROLLED",
                },
              }
            : {}),
          ...(index === 5
            ? {
                error: { code: "AUTH_EXPIRED" },
                automation: {
                  ...readyJob(id, index).automation,
                  lastFailure: {
                    code: "AUTH_EXPIRED",
                    step: "submission_read",
                  },
                  stepFailures: {
                    submission_read: {
                      code: "AUTH_EXPIRED",
                      count: 1,
                    },
                    candidate_private_step: {
                      code: "CANDIDATE_PRIVATE_CODE",
                      count: 1,
                    },
                  },
                },
              }
            : {}),
          ...(index === 6
            ? {
                state: "submitting",
                submitAttemptStartedAt:
                  "2026-07-29T18:02:00.000Z",
              }
            : {}),
          ...(index === 7
            ? {
                state: "error",
                error: {
                  code: "CANDIDATE_PRIVATE_ABC",
                },
              }
            : {}),
        },
  ]));
  const diagnostic = await resumeOnlyBackfillDiagnostics({
    store: {
      getControl: async () => ({
        status: "canary_running",
        manifestDigest: manifest,
        canary: {
          status: "running",
          ids,
        },
      }),
      getRecovery: async () => ({
        status: "running",
        revision: 1,
        active: ids.map((id, index) => ({
          id,
          role: index < 6 ? "carried" : "replacement",
        })),
        terminal: [{ code: "HAS_REPLIED" }],
        skippedUnreadable: 0,
        manifestDigest: "f".repeat(64),
      }),
    },
    getJobImpl: async (id) => jobs.get(id),
  });
  assert.equal(diagnostic.selected, 10);
  assert.deepEqual(diagnostic.classifications, {
    accepted_visible: 3,
    pending_pre_attempt: 2,
    pre_attempt_terminal: 2,
    retryable_pre_attempt_read: 1,
    unclassified_pre_attempt_error: 1,
    uncertain_submission: 1,
  });
  assert.deepEqual(diagnostic.errorCodes, {
    already_enrolled: 1,
    auth_expired: 1,
    has_replied: 1,
    none: 6,
    other: 1,
  });
  assert.deepEqual(diagnostic.failureSteps, {
    other_other: 1,
    submission_read_auth_expired: 1,
  });
  assert.deepEqual(
    diagnostic.activeRecovery.classifications,
    diagnostic.classifications,
  );
  assert.deepEqual(
    diagnostic.activeRecovery.errorCodes,
    diagnostic.errorCodes,
  );
  const serialized = JSON.stringify(diagnostic);
  assert.equal(serialized.includes("bot_diagnostic"), false);
  assert.equal(serialized.includes("candidate-user"), false);
  assert.equal(serialized.includes("@example.test"), false);
  assert.equal(serialized.includes("candidate_private"), false);
});

test("the remainder cannot arm before verification and releases only after the ten-write gate", async () => {
  const store = memoryStore();
  const ids = Array.from(
    { length: 10 },
    (_, index) => `bot_release_canary_${String(index).padStart(2, "0")}`,
  );
  const remainderId = "bot_release_remainder_01";
  const missingResumeId = "bot_release_remainder_02";
  const manifest = "d".repeat(64);
  const jobs = new Map(ids.map((id, index) => [
    id,
    verifiedCanaryJob(id, index, manifest),
  ]));
  jobs.set(remainderId, readyJob(remainderId, 20));
  jobs.set(
    missingResumeId,
    readyJob(missingResumeId, 21),
  );
  await store.setControl({
    version: 1,
    status: "canary_running",
    boundaryAt: new Date(NOW).toISOString(),
    cutoffAt: new Date(
      NOW - 45 * 24 * 60 * 60_000,
    ).toISOString(),
    recall: {
      cursor: null,
      seenCursors: [],
      exhausted: true,
      scanned: 12,
      discovered: 12,
    },
    human: {
      cursor: 0,
      exhausted: true,
      scanned: 0,
      discovered: 0,
      rosterSuccessful: 0,
    },
    preparation: {
      attempted: 12,
      eligible: 12,
      excluded: 0,
    },
    createdAt: new Date(NOW).toISOString(),
    updatedAt: new Date(NOW).toISOString(),
    manifestDigest: manifest,
    canary: {
      status: "running",
      ids,
      committedAt: new Date(NOW).toISOString(),
      verifiedAt: null,
    },
    release: {
      status: "not_armed",
      authorized: 0,
      excluded: 0,
      batchOrdinal: 0,
      armedAt: null,
      completedAt: null,
    },
  });
  for (const [index, id] of ids.entries()) {
    await store.addEntry({
      version: 1,
      id,
      source: "agent",
      callAt: CALL_AT,
      status: "authorized",
      candidateHash: candidateHash(`candidate-user-${index}`),
      reason: null,
      authorizedAt: new Date(NOW).toISOString(),
    });
  }
  await store.addEntry({
    version: 1,
    id: remainderId,
    source: "agent",
    callAt: CALL_AT,
    status: "eligible",
    candidateHash: candidateHash("candidate-user-20"),
    reason: null,
    authorizedAt: null,
  });
  await store.addEntry({
    version: 1,
    id: missingResumeId,
    source: "agent",
    callAt: CALL_AT,
    status: "eligible",
    candidateHash: candidateHash("candidate-user-21"),
    reason: null,
    authorizedAt: null,
  });
  const common = {
    store,
    lockImpl: async (operation) => operation(),
    getJobImpl: async (id) => jobs.get(id) || null,
    queueStatsImpl: async () => ({
      queued: 0,
      due: 0,
      leased: 0,
    }),
    terminalPreflightImpl: async () => ({
      eligible: true,
      code: null,
    }),
  };
  const unverifiedControl = await store.getControl();
  await store.setControl({
    ...unverifiedControl,
    status: "canary_verified",
    canary: {
      ...unverifiedControl.canary,
      status: "verified",
    },
  });
  jobs.get(ids[0]).automation.resumeWait = {
    source: "authorized_backfill",
  };
  await assert.rejects(
    () => armResumeOnlyBackfillRemainder(common),
    { code: "RESUME_ONLY_BACKFILL_CANARY_NOT_VERIFIED" },
  );
  jobs.set(
    ids[0],
    verifiedCanaryJob(ids[0], 0, manifest),
  );
  await store.setControl(unverifiedControl);
  await assert.rejects(
    () => armResumeOnlyBackfillRemainder(common),
    { code: "RESUME_ONLY_BACKFILL_CANARY_NOT_VERIFIED" },
  );
  const verified = await verifyResumeOnlyBackfillFirstTen(common);
  assert.equal(verified.verificationRecorded, true);
  const armed = await armResumeOnlyBackfillRemainder({
    ...common,
    now: NOW,
  });
  assert.equal(armed.status, "running");

  const enqueued = [];
  const released = await runResumeOnlyBackfillReleaseTick({
    ...common,
    now: NOW,
    getResumeImpl: async (candidateUserId) => (
      candidateUserId === "candidate-user-21"
        ? {}
        : {
            resumeUri: "s3://private/current.pdf",
          }
    ),
    saveJobImpl: async (job, expectedRevision) => {
      assert.equal(expectedRevision, jobs.get(job.id).revision);
      const saved = {
        ...job,
        revision: expectedRevision + 1,
      };
      jobs.set(job.id, saved);
      return saved;
    },
    enqueueImpl: async (id, options) => {
      enqueued.push({ id, options });
      return {
        enqueued: true,
        duplicate: false,
      };
    },
  });
  assert.deepEqual(released.batch, {
    attempted: 2,
    authorized: 1,
    excluded: 1,
  });
  assert.deepEqual(
    enqueued.map(({ id }) => id),
    [remainderId],
  );
  assert.equal(
    enqueued[0].options.source,
    "authorized_backfill",
  );
  const complete = await runResumeOnlyBackfillReleaseTick({
    ...common,
    now: NOW,
  });
  assert.equal(complete.status, "complete");
});

test("a disappearing resume stops in review without creating a chase plan", async () => {
  const job = readyJob("bot_resume_disappeared", 1);
  const stopped = resumeOnlyBackfillMissingResumeTransition({
    ...job,
    automation: {
      ...job.automation,
      mode: "authorized_backfill",
      resumeOnlySubmit: true,
      resumeWait: null,
    },
  }, {
    now: NOW,
  });
  assert.equal(stopped.state, "needs_review");
  assert.equal(
    stopped.reviewReason,
    "resume_only_backfill_resume_missing",
  );
  assert.equal(stopped.automation.resumeWait, null);
  assert.equal(
    stopped.automation.resumeWaitSweepEligible,
    false,
  );
  assert.match(
    stopped.journal.at(-1).detail,
    /stopped without resume chase/u,
  );
  const source = await readFile(
    new URL("../api/paraai/_lib/auto.mjs", import.meta.url),
    "utf8",
  );
  const missingResume = source.indexOf(
    "if (!resume.resumeUri)",
  );
  const noChaseFence = source.indexOf(
    "if (resumeOnlySubmit)",
    missingResume,
  );
  const legacyResumeWait = source.indexOf(
    "if (config.resumeWaitEnabled)",
    missingResume,
  );
  assert.ok(missingResume >= 0);
  assert.ok(noChaseFence > missingResume);
  assert.ok(legacyResumeWait > noChaseFence);
  assert.match(
    source.slice(noChaseFence, legacyResumeWait),
    /resumeOnlyBackfillMissingResumeTransition/u,
  );
});

test("worker exposes only no-parameter controlled modes", async () => {
  const source = await readFile(
    new URL("../api/paraai/worker.mjs", import.meta.url),
    "utf8",
  );
  for (const mode of [
    "resume-only-backfill-plan",
    "resume-only-backfill-commit-first-ten",
    "resume-only-backfill-verify-first-ten",
    "resume-only-backfill-arm",
    "resume-only-backfill-tick",
    "resume-only-backfill-status",
    "resume-only-backfill-diagnostics",
    "resume-only-backfill-recovery-plan",
    "resume-only-backfill-recovery-commit",
    "resume-only-backfill-recovery-status",
  ]) {
    assert.match(source, new RegExp(`"${mode}"`, "u"));
  }
  assert.match(
    source,
    /\["resume-only-backfill-plan", new Set\(\["mode"\]\)\]/u,
  );
  assert.match(
    source,
    /\["resume-only-backfill-arm", new Set\(\["mode"\]\)\]/u,
  );
  assert.match(
    source,
    /\["resume-only-backfill-recovery-plan", new Set\(\["mode"\]\)\]/u,
  );
  assert.match(
    source,
    /caller_parameters_forbidden/u,
  );
  assert.match(
    source,
    /Object\.keys\(query\)\.some\(\(field\) => field !== "mode"\)/u,
  );
  const controller = await readFile(
    new URL(
      "../api/paraai/_lib/resume-only-backfill.mjs",
      import.meta.url,
    ),
    "utf8",
  );
  const discoveryAdmission = controller.slice(
    controller.indexOf("async addEntry(entry)"),
    controller.indexOf("async getEntry(id)"),
  );
  assert.match(discoveryAdmission, /HEXISTS/u);
  assert.match(discoveryAdmission, /redis\.call\('HSET'/u);
  assert.match(discoveryAdmission, /redis\.call\('ZADD'/u);
  assert.match(
    controller,
    /rosterHash: entry\.rosterHash \|\| null/u,
  );
});
