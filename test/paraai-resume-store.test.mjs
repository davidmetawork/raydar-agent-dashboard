import { createHash } from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";

import {
  activateResumeChaseGeneration,
  ackResumeAskTerminal,
  claimResumeAskSuppression,
  confirmResumeAskSuppression,
  createJob,
  getOrCreateResumeBackfillAnchor,
  getRecentResumeAttachedSignal,
  getResumeAskSuppression,
  hashedResumeAskKey,
  hashedResumeCandidateId,
  hashedResumeCurrentChainKey,
  hashedResumeSatisfactionKey,
  listWaitingResumeJobs,
  recordResumeAttachedSignal,
  resumeChaseChainId,
  saveJob,
  stopResumeAskSuppression,
} from "../api/paraai/_lib/store.mjs";

const candidateUserId = "candidate-private-123";
const jobId = "bot_12345678";
const chainAnchorAt = "2026-07-25T01:00:00.000Z";
const chainCallEndedAt = "2026-07-25T00:30:00.000Z";
const chainId = resumeChaseChainId(jobId, chainAnchorAt);
const chaseScope = {
  jobId,
  chainId,
  chainAnchorAt,
  chainCallEndedAt,
};
const waitingJob = {
  id: jobId,
  revision: 4,
  state: "waiting_for_resume",
  callEndedAt: chainCallEndedAt,
  updatedAt: "2026-07-25T02:00:00.000Z",
  identity: { candidateUserId },
  automation: {
    resumeWait: {
      enteredAt: chainAnchorAt,
    },
  },
};

test("resume candidate hash and shared suppression key use the locked namespace without PII", () => {
  const expected = createHash("sha256")
    .update("paraai-candidate-v1")
    .update("\0")
    .update(candidateUserId)
    .digest("hex");
  assert.equal(hashedResumeCandidateId(candidateUserId), expected);
  assert.equal(
    hashedResumeAskKey(candidateUserId, chainId),
    `paraai:resume-ask:v2:${expected}:${chainId}`,
  );
  assert.equal(
    hashedResumeSatisfactionKey(candidateUserId),
    `paraai:resume-satisfied:v1:${expected}`,
  );
  assert.equal(
    hashedResumeCurrentChainKey(candidateUserId),
    `paraai:resume-current-chain:v1:${expected}`,
  );
  assert.equal(
    hashedResumeAskKey(candidateUserId, chainId).includes(candidateUserId),
    false,
  );
});

test("Phase 2 backfill anchor uses one atomic permanent versioned key", async () => {
  const commands = [];
  const expected = {
    version: 1,
    anchorAt: "2026-07-25T00:00:00.000Z",
  };
  const anchorRecord = await getOrCreateResumeBackfillAnchor({
    now: Date.parse(expected.anchorAt),
  }, {
    kvImpl: async (command) => {
      commands.push(command);
      return command.at(-1);
    },
  });
  assert.deepEqual(anchorRecord, expected);
  assert.equal(commands[0][0], "EVAL");
  assert.equal(commands[0][2], 1);
  assert.equal(
    commands[0][3],
    "paraai:resume-backfill-anchor:v1",
  );
  assert.match(commands[0][1], /redis\.call\('GET', KEYS\[1\]\)/u);
  assert.match(commands[0][1], /redis\.call\('SET', KEYS\[1\], ARGV\[1\]\)/u);
  assert.equal(commands[0].includes("EX"), false);
});

test("resume attach race signal is short-lived, hashed, and age-bounded", async () => {
  const commands = [];
  const receivedAt = "2026-07-25T02:00:00.000Z";
  const record = await recordResumeAttachedSignal(candidateUserId, {
    eventId: "private-booking-attach-event",
    receivedAt,
    ttlSeconds: 600,
  }, {
    kvImpl: async (command) => {
      commands.push(command);
      return "OK";
    },
  });
  assert.match(record.candidateHash, /^[a-f0-9]{64}$/);
  assert.match(record.eventHash, /^[a-f0-9]{64}$/);
  assert.equal(record.receivedAt, receivedAt);
  assert.equal(JSON.stringify(record).includes(candidateUserId), false);
  assert.equal(JSON.stringify(record).includes("private-booking-attach-event"), false);
  assert.equal(commands[0][0], "SET");
  assert.match(commands[0][1], /^paraai:resume-attached-signal:[a-f0-9]{64}$/);
  assert.equal(commands[0][1].includes(candidateUserId), false);
  assert.equal(commands[0][3], "EX");
  assert.equal(commands[0][4], "600");

  const readCommands = [];
  assert.deepEqual(await getRecentResumeAttachedSignal(candidateUserId, {
    now: Date.parse(receivedAt) + 599_000,
    maxAgeMs: 600_000,
  }, {
    kvImpl: async (command) => {
      readCommands.push(command);
      return JSON.stringify(record);
    },
  }), record);
  assert.equal(readCommands[0][0], "GET");
  assert.equal(readCommands[0][1], commands[0][1]);
  assert.equal(await getRecentResumeAttachedSignal(candidateUserId, {
    now: Date.parse(receivedAt) + 601_000,
    maxAgeMs: 600_000,
  }, {
    kvImpl: async () => JSON.stringify(record),
  }), null);
});

test("saveJob atomically adds or removes waiting-set membership with the revisioned write", async () => {
  const waitingCommands = [];
  const saved = await saveJob(waitingJob, 4, {
    kvImpl: async (command) => {
      waitingCommands.push(command);
      return 1;
    },
  });
  assert.equal(saved.revision, 5);
  assert.equal(waitingCommands[0][0], "EVAL");
  assert.equal(waitingCommands[0][2], 3);
  assert.equal(waitingCommands[0][3], `paraai:job:${jobId}`);
  assert.equal(waitingCommands[0][4], "paraai:index");
  assert.equal(waitingCommands[0][5], "paraai:resume-waiting");
  assert.equal(waitingCommands[0].at(-1), "waiting_for_resume");
  assert.match(waitingCommands[0][1], /ARGV\[6\] == 'waiting_for_resume'/);
  assert.match(waitingCommands[0][1], /redis\.call\('SADD', KEYS\[3\], ARGV\[5\]\)/);
  assert.match(waitingCommands[0][1], /redis\.call\('SREM', KEYS\[3\], ARGV\[5\]\)/);

  const readyCommands = [];
  await saveJob({ ...waitingJob, state: "ready_to_submit" }, 4, {
    kvImpl: async (command) => {
      readyCommands.push(command);
      return 1;
    },
  });
  assert.equal(readyCommands[0].at(-1), "ready_to_submit");
});

test("createJob establishes waiting-set membership in the same first-write script", async () => {
  const commands = [];
  await createJob(waitingJob, {
    kvImpl: async (command) => {
      commands.push(command);
      return [1, command[6]];
    },
  });
  assert.equal(commands[0][2], 3);
  assert.equal(commands[0][5], "paraai:resume-waiting");
  assert.equal(commands[0].at(-1), "waiting_for_resume");
  assert.match(commands[0][1], /current\.state == 'waiting_for_resume'/);
  assert.match(commands[0][1], /ARGV\[5\] == 'waiting_for_resume'/);
});

test("listWaitingResumeJobs reads the dedicated set, filters stale state, and returns oldest waits first", async () => {
  const commands = [];
  const later = {
    ...waitingJob,
    id: "bot_87654321",
    automation: { resumeWait: { enteredAt: "2026-07-25T03:00:00.000Z" } },
  };
  const jobs = await listWaitingResumeJobs(10, {
    kvImpl: async (command) => {
      commands.push(command);
      return [later.id, "bot_stale123", waitingJob.id];
    },
    pipelineImpl: async (pipeline) => {
      assert.deepEqual(pipeline, [
        ["GET", `paraai:job:${later.id}`],
        ["GET", "paraai:job:bot_stale123"],
        ["GET", `paraai:job:${waitingJob.id}`],
      ]);
      return [
        JSON.stringify(later),
        JSON.stringify({ id: "bot_stale123", state: "ready_to_submit" }),
        JSON.stringify(waitingJob),
      ];
    },
  });
  assert.deepEqual(commands[0], ["SMEMBERS", "paraai:resume-waiting"]);
  assert.equal(commands[1][0], "EVAL");
  assert.equal(commands[1][2], 2);
  assert.equal(commands[1][3], "paraai:resume-waiting");
  assert.equal(commands[1][4], "paraai:job:bot_stale123");
  assert.match(commands[1][1], /job\.state == 'waiting_for_resume'/);
  assert.match(commands[1][1], /redis\.call\('SREM'/);
  assert.deepEqual(jobs.map((job) => job.id), [waitingJob.id, later.id]);
});

test("waiting-store completeness is false when the requested feed cap omits a valid wait", async () => {
  const later = {
    ...waitingJob,
    id: "bot_87654321",
    automation: {
      resumeWait: {
        enteredAt: "2026-07-25T03:00:00.000Z",
      },
    },
  };
  const listed = await listWaitingResumeJobs(1, {
    withCompleteness: true,
    kvImpl: async () => [later.id, waitingJob.id],
    pipelineImpl: async () => [
      JSON.stringify(later),
      JSON.stringify(waitingJob),
    ],
  });
  assert.deepEqual(listed, {
    jobs: [waitingJob],
    complete: false,
    totalWaiting: 2,
    scannedCount: 2,
  });

  assert.deepEqual(await listWaitingResumeJobs(500, {
    withCompleteness: true,
    kvImpl: async () => [],
  }), {
    jobs: [],
    complete: true,
    totalWaiting: 0,
    scannedCount: 0,
  });
});

test("resume ask send claim is one atomic waiting-state + candidate + touch claim", async () => {
  const commands = [];
  const record = {
    version: 2,
    candidateHash: hashedResumeCandidateId(candidateUserId),
    chainId,
    chainAnchorAt,
    status: "active",
    stopped: false,
    claims: {
      1: { eventHash: "a".repeat(64), touch: 1 },
    },
  };
  const result = await claimResumeAskSuppression(candidateUserId, {
    ...chaseScope,
    eventId: "chase-event-private-1",
    touch: 1,
    claimedAt: "2026-07-25T04:00:00.000Z",
    dueAt: "2026-07-25T04:00:00.000Z",
  }, {
    kvImpl: async (command) => {
      commands.push(command);
      return [1, JSON.stringify(record)];
    },
  });
  assert.equal(result.status, "claimed");
  assert.equal(result.allowed, true);
  const command = commands[0];
  assert.equal(command[2], 4);
  assert.equal(command[3], hashedResumeAskKey(candidateUserId, chainId));
  assert.equal(command[4], `paraai:job:${jobId}`);
  assert.equal(command[5], hashedResumeSatisfactionKey(candidateUserId));
  assert.equal(command[6], hashedResumeCurrentChainKey(candidateUserId));
  assert.match(command[1], /job\.state ~= 'waiting_for_resume'/);
  assert.match(command[1], /job\.identity\.candidateUserId/);
  assert.match(command[1], /existing\.eventHash == nextClaim\.eventHash/);
  assert.ok(
    command[1].indexOf("local currentRaw")
      < command[1].indexOf("local claimDeadline"),
    "newer generation ownership must fence the old chain before deadline denial",
  );
  const storedClaim = JSON.parse(command[9]);
  assert.match(storedClaim.eventHash, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(storedClaim).includes("chase-event-private-1"), false);
  assert.equal(JSON.stringify(storedClaim).includes(candidateUserId), false);

  assert.deepEqual(
    await claimResumeAskSuppression(candidateUserId, {
      ...chaseScope,
      eventId: "another-event",
      touch: 2,
    }, { kvImpl: async () => [-3, ""] }),
    { status: "not_waiting", allowed: false, idempotent: false, record: null },
  );
  const idempotent = await claimResumeAskSuppression(candidateUserId, {
    ...chaseScope,
    eventId: "same-event",
    touch: 1,
  }, { kvImpl: async () => [2, JSON.stringify(record)] });
  assert.equal(idempotent.status, "pending");
  assert.equal(idempotent.allowed, true);
  assert.equal(idempotent.idempotent, true);
  assert.equal(idempotent.confirmed, false);
});

test("same deterministic claim recovers a lost response while conflicts and confirmed sends stay fenced", async () => {
  const record = {
    version: 2,
    candidateHash: hashedResumeCandidateId(candidateUserId),
    chainId,
    chainAnchorAt,
    status: "active",
    stopped: false,
    claims: {
      1: { eventHash: "a".repeat(64), touch: 1 },
    },
  };
  let ownerAssigned = false;
  const kvImpl = async () => {
    if (!ownerAssigned) {
      ownerAssigned = true;
      return [1, JSON.stringify(record)];
    }
    return [2, JSON.stringify(record)];
  };
  const results = await Promise.all([
    claimResumeAskSuppression(candidateUserId, {
      ...chaseScope,
      eventId: "same-deterministic-event",
      touch: 1,
    }, { kvImpl }),
    claimResumeAskSuppression(candidateUserId, {
      ...chaseScope,
      eventId: "same-deterministic-event",
      touch: 1,
    }, { kvImpl }),
  ]);
  assert.equal(results.filter((result) => result.allowed).length, 2);
  assert.deepEqual(results.map((result) => result.status).sort(), ["claimed", "pending"]);

  const conflicting = await claimResumeAskSuppression(candidateUserId, {
    ...chaseScope,
    eventId: "different-deterministic-event",
    touch: 1,
  }, { kvImpl: async () => [-2, JSON.stringify(record)] });
  assert.equal(conflicting.status, "touch_conflict");
  assert.equal(conflicting.allowed, false);

  const deliveredRecord = {
    ...record,
    claims: {
      1: {
        ...record.claims[1],
        deliveredAt: "2026-07-25T05:00:00.000Z",
      },
    },
  };
  const deliveredReplay = await claimResumeAskSuppression(candidateUserId, {
    ...chaseScope,
    eventId: "same-deterministic-event",
    touch: 1,
  }, { kvImpl: async () => [2, JSON.stringify(deliveredRecord)] });
  assert.equal(deliveredReplay.status, "sent");
  assert.equal(deliveredReplay.allowed, false);
  assert.equal(deliveredReplay.confirmed, true);
});

test("a delivered deterministic claim replays before terminal job gating after local-ledger loss", async () => {
  const eventId = "touch-3-post-terminal-recovery";
  const eventHash = createHash("sha256")
    .update("resume-ask-event-v1")
    .update("\0")
    .update(eventId)
    .digest("hex");
  const delivered = {
    version: 2,
    candidateHash: hashedResumeCandidateId(candidateUserId),
    chainId,
    chainAnchorAt,
    status: "active",
    claims: {
      3: {
        eventHash,
        touch: 3,
        deliveredAt: "2026-08-01T03:00:00.000Z",
      },
    },
    terminalAck: {
      touch: 3,
      eventHash,
      outcome: "delivered",
      acknowledgedAt: "2026-08-01T03:00:00.000Z",
    },
  };
  let command;
  const replay = await claimResumeAskSuppression(candidateUserId, {
    ...chaseScope,
    eventId,
    touch: 3,
    claimedAt: "2026-08-02T03:00:00.000Z",
  }, {
    kvImpl: async (value) => {
      command = value;
      return [2, JSON.stringify(delivered)];
    },
  });
  assert.deepEqual({
    status: replay.status,
    allowed: replay.allowed,
    confirmed: replay.confirmed,
    idempotent: replay.idempotent,
  }, {
    status: "sent",
    allowed: false,
    confirmed: true,
    idempotent: true,
  });
  assert.ok(
    command[1].indexOf("local replayClaim")
      < command[1].indexOf("local rawJob"),
    "same-event delivered replay must precede waiting/job validation",
  );
});

test("resume ask confirmation, read, and stop keep only hashed shared state", async () => {
  const active = {
    version: 2,
    candidateHash: hashedResumeCandidateId(candidateUserId),
    chainId,
    chainAnchorAt,
    status: "active",
    claims: { 1: { eventHash: "a".repeat(64), deliveredAt: "2026-07-25T05:00:00.000Z" } },
    lastTouch: 1,
    lastSentAt: "2026-07-25T05:00:00.000Z",
  };
  const confirmCommands = [];
  const confirmed = await confirmResumeAskSuppression(candidateUserId, {
    ...chaseScope,
    eventId: "delivery-event-private",
    touch: 1,
    deliveredAt: "2026-07-25T05:00:00.000Z",
    deliveryDigest: "provider-message-private",
  }, {
    kvImpl: async (command) => {
      confirmCommands.push(command);
      return [1, JSON.stringify(active)];
    },
  });
  assert.equal(confirmed.status, "confirmed");
  assert.equal(confirmed.confirmed, true);
  const confirmation = JSON.parse(confirmCommands[0][8]);
  assert.match(confirmation.deliveryDigest, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(confirmation).includes("provider-message-private"), false);

  const getCommands = [];
  assert.deepEqual(await getResumeAskSuppression(candidateUserId, {
    chainId,
    kvImpl: async (command) => {
      getCommands.push(command);
      return [JSON.stringify(active), null, JSON.stringify({
        chainId,
        chainAnchorAt,
        callEndedAt: chainCallEndedAt,
      })];
    },
  }), {
    version: 2,
    candidateHash: hashedResumeCandidateId(candidateUserId),
    chainId,
    chain: active,
    candidateSatisfaction: null,
    currentGeneration: {
      chainId,
      chainAnchorAt,
      callEndedAt: chainCallEndedAt,
    },
  });
  assert.deepEqual(getCommands, [[
    "MGET",
    hashedResumeAskKey(candidateUserId, chainId),
    hashedResumeSatisfactionKey(candidateUserId),
    hashedResumeCurrentChainKey(candidateUserId),
  ]]);

  const stoppedRecord = {
    ...active,
    status: "stopped",
    stopped: true,
    stoppedAt: "2026-07-25T05:30:00.000Z",
    stopReason: "resume_attached",
  };
  const stopCommands = [];
  const stopped = await stopResumeAskSuppression(candidateUserId, {
    ...chaseScope,
    reason: "resume_attached",
    stoppedAt: "2026-07-25T05:30:00.000Z",
  }, {
    kvImpl: async (command) => {
      stopCommands.push(command);
      return [1, JSON.stringify(stoppedRecord)];
    },
  });
  assert.equal(stopped.status, "stopped");
  assert.equal(stopped.stopped, true);
  assert.equal(
    stopCommands[0][3],
    hashedResumeAskKey(candidateUserId, chainId),
  );
  assert.equal(
    stopCommands[0][6],
    hashedResumeCurrentChainKey(candidateUserId),
  );
  assert.match(stopCommands[0][1], /record\.status = 'stopped'/);
  assert.match(stopCommands[0][1], /current\.status = 'terminal'/);
  assert.equal(stopCommands[0][9], "resume_attached");
  assert.equal(stopCommands[0][10], "1");
});

test("chain-local stops cannot suppress a later independent candidate chain", async () => {
  const laterJobId = "bot_87654321";
  const laterAnchorAt = "2026-08-10T01:00:00.000Z";
  const laterCallEndedAt = "2026-08-10T00:30:00.000Z";
  const laterChainId = resumeChaseChainId(laterJobId, laterAnchorAt);
  assert.notEqual(chainId, laterChainId);
  assert.notEqual(
    hashedResumeAskKey(candidateUserId, chainId),
    hashedResumeAskKey(candidateUserId, laterChainId),
  );

  const stopCommands = [];
  const stoppedRecord = {
    version: 2,
    candidateHash: hashedResumeCandidateId(candidateUserId),
    chainId,
    chainAnchorAt,
    status: "stopped",
    stopped: true,
    stopScope: "chain",
    stopReason: "candidate_replied",
    claims: {},
  };
  const stopped = await stopResumeAskSuppression(candidateUserId, {
    ...chaseScope,
    reason: "candidate_replied",
  }, {
    kvImpl: async (command) => {
      stopCommands.push(command);
      return [1, JSON.stringify(stoppedRecord)];
    },
  });
  assert.equal(stopped.permanent, false);
  assert.equal(stopCommands[0][10], "0");

  const laterRecord = {
    version: 2,
    candidateHash: hashedResumeCandidateId(candidateUserId),
    chainId: laterChainId,
    chainAnchorAt: laterAnchorAt,
    status: "active",
    stopped: false,
    claims: { 1: { eventHash: "b".repeat(64), touch: 1 } },
  };
  const claimCommands = [];
  const claimed = await claimResumeAskSuppression(candidateUserId, {
    jobId: laterJobId,
    chainId: laterChainId,
    chainAnchorAt: laterAnchorAt,
    chainCallEndedAt: laterCallEndedAt,
    eventId: "later-independent-chain-touch-1",
    touch: 1,
  }, {
    kvImpl: async (command) => {
      claimCommands.push(command);
      return [1, JSON.stringify(laterRecord)];
    },
  });
  assert.equal(claimed.status, "claimed");
  assert.equal(claimed.allowed, true);
  assert.equal(
    claimCommands[0][3],
    hashedResumeAskKey(candidateUserId, laterChainId),
  );

  const satisfied = await claimResumeAskSuppression(candidateUserId, {
    jobId: laterJobId,
    chainId: laterChainId,
    chainAnchorAt: laterAnchorAt,
    chainCallEndedAt: laterCallEndedAt,
    eventId: "later-independent-chain-touch-1",
    touch: 1,
  }, {
    kvImpl: async () => [-5, JSON.stringify({
      version: 1,
      candidateHash: hashedResumeCandidateId(candidateUserId),
      satisfied: true,
      reason: "resume_detected",
    })],
  });
  assert.equal(satisfied.status, "candidate_satisfied");
  assert.equal(satisfied.allowed, false);
});

test("received artifact stops remain candidate-wide across later generations", async () => {
  for (const reason of ["resume_received", "resume_received_review"]) {
    const stoppedRecord = {
      version: 2,
      candidateHash: hashedResumeCandidateId(candidateUserId),
      chainId,
      chainAnchorAt,
      status: "stopped",
      stopped: true,
      stopScope: "candidate",
      stopReason: reason,
      claims: {},
    };
    let stopCommand;
    const stopped = await stopResumeAskSuppression(candidateUserId, {
      ...chaseScope,
      reason,
    }, {
      kvImpl: async (command) => {
        stopCommand = command;
        return [1, JSON.stringify(stoppedRecord)];
      },
    });
    assert.equal(stopped.permanent, true);
    assert.equal(stopCommand[9], reason);
    assert.equal(stopCommand[10], "1");
    assert.match(
      stopCommand[1],
      /local satisfactionChanged = ensureCandidateSatisfaction\(\)/u,
    );
    assert.match(
      stopCommand[1],
      /\(satisfactionChanged or cancellationChanged\) and 1 or 2/u,
    );
    assert.ok(
      stopCommand[1].indexOf(
        "local satisfactionChanged = ensureCandidateSatisfaction()",
      ) < stopCommand[1].indexOf(
        "(satisfactionChanged or cancellationChanged) and 1 or 2",
      ),
      "an idempotent chain stop must repair missing candidate satisfaction",
    );

    const laterJobId = `bot_${reason.replaceAll("_", "")}`;
    const laterAnchorAt = "2026-08-18T01:00:00.000Z";
    const satisfaction = {
      version: 1,
      candidateHash: hashedResumeCandidateId(candidateUserId),
      satisfied: true,
      satisfiedAt: "2026-08-10T01:00:00.000Z",
      reason,
    };
    const laterClaim = await claimResumeAskSuppression(candidateUserId, {
      jobId: laterJobId,
      chainId: resumeChaseChainId(laterJobId, laterAnchorAt),
      chainAnchorAt: laterAnchorAt,
      chainCallEndedAt: "2026-08-18T00:30:00.000Z",
      eventId: `${reason}-later-generation`,
      touch: 1,
    }, {
      kvImpl: async () => [-5, JSON.stringify(satisfaction)],
    });
    assert.equal(laterClaim.status, "candidate_satisfied");
    assert.equal(laterClaim.allowed, false);
    assert.equal(laterClaim.candidateSatisfaction.reason, reason);
  }
});

test("receipt reasons monotonically upgrade ordinary stops without rewriting stoppedAt", async () => {
  const originalStoppedAt = "2026-07-26T01:00:00.000Z";
  const reasonUpdatedAt = "2026-07-27T01:00:00.000Z";
  const upgraded = {
    version: 2,
    candidateHash: hashedResumeCandidateId(candidateUserId),
    chainId,
    chainAnchorAt,
    status: "stopped",
    stopped: true,
    stoppedAt: originalStoppedAt,
    stopReason: "resume_received",
    stopScope: "candidate",
    reasonUpdatedAt,
    claims: {},
  };
  let upgradeCommand;
  const received = await stopResumeAskSuppression(candidateUserId, {
    ...chaseScope,
    reason: "resume_received",
    stoppedAt: reasonUpdatedAt,
  }, {
    kvImpl: async (command) => {
      upgradeCommand = command;
      return [1, JSON.stringify(upgraded)];
    },
  });
  assert.equal(received.record.stopReason, "resume_received");
  assert.equal(received.record.stoppedAt, originalStoppedAt);
  assert.equal(received.record.reasonUpdatedAt, reasonUpdatedAt);
  assert.match(
    upgradeCommand[1],
    /if existingRank > 0 then return incomingRank > existingRank end/u,
  );
  assert.match(
    upgradeCommand[1],
    /elseif shouldUpgradeReceiptReason\(record\.stopReason, ARGV\[3\]\) then/u,
  );
  const upgradeStart = upgradeCommand[1].indexOf(
    "elseif shouldUpgradeReceiptReason(record.stopReason, ARGV[3]) then",
  );
  const upgradeEnd = upgradeCommand[1].indexOf(
    "if ensureCandidateSatisfaction()",
    upgradeStart,
  );
  const upgradeBlock = upgradeCommand[1].slice(upgradeStart, upgradeEnd);
  assert.match(upgradeBlock, /record\.stopReason = ARGV\[3\]/u);
  assert.match(upgradeBlock, /record\.reasonUpdatedAt = ARGV\[2\]/u);
  assert.doesNotMatch(upgradeBlock, /record\.stoppedAt\s*=/u);

  const reviewUpdatedAt = "2026-07-28T01:00:00.000Z";
  const reviewedRecord = {
    ...upgraded,
    stopReason: "resume_received_review",
    reasonUpdatedAt: reviewUpdatedAt,
  };
  const reviewed = await stopResumeAskSuppression(candidateUserId, {
    ...chaseScope,
    reason: "resume_received_review",
    stoppedAt: reviewUpdatedAt,
  }, {
    kvImpl: async () => [1, JSON.stringify(reviewedRecord)],
  });
  assert.equal(reviewed.record.stopReason, "resume_received_review");
  assert.equal(reviewed.record.stoppedAt, originalStoppedAt);

  const noDowngrade = await stopResumeAskSuppression(candidateUserId, {
    ...chaseScope,
    reason: "resume_received",
    stoppedAt: "2026-07-29T01:00:00.000Z",
  }, {
    kvImpl: async () => [2, JSON.stringify(reviewedRecord)],
  });
  assert.equal(noDowngrade.status, "existing");
  assert.equal(noDowngrade.record.stopReason, "resume_received_review");
  assert.equal(noDowngrade.record.stoppedAt, originalStoppedAt);
});

test("a first cancellation timestamp is monotonic and independent of stop order", async () => {
  const originalStoppedAt = "2026-07-26T01:00:00.000Z";
  const cancellationAt = "2026-07-27T01:00:00.000Z";
  const stoppedForNoShow = {
    version: 2,
    candidateHash: hashedResumeCandidateId(candidateUserId),
    chainId,
    chainAnchorAt,
    status: "stopped",
    stopped: true,
    stoppedAt: originalStoppedAt,
    stopReason: "no_show",
    stopScope: "chain",
    cancellationAt,
    claims: {},
  };
  let cancellationCommand;
  const cancelled = await stopResumeAskSuppression(candidateUserId, {
    ...chaseScope,
    reason: "cancelled",
    stoppedAt: cancellationAt,
  }, {
    kvImpl: async (command) => {
      cancellationCommand = command;
      return [1, JSON.stringify(stoppedForNoShow)];
    },
  });
  assert.equal(cancelled.record.stopReason, "no_show");
  assert.equal(cancelled.record.stoppedAt, originalStoppedAt);
  assert.equal(cancelled.record.cancellationAt, cancellationAt);
  assert.match(
    cancellationCommand[1],
    /if ARGV\[3\] ~= 'cancelled' or value\.cancellationAt then/u,
  );
  assert.match(
    cancellationCommand[1],
    /value\.cancellationAt = ARGV\[2\]/u,
  );
  assert.match(
    cancellationCommand[1],
    /if ensureCancellationAt\(record\) then changed = true end/u,
  );
  const sameReasonStart = cancellationCommand[1].indexOf(
    "and record.stopReason == ARGV[3] then",
  );
  const sameReasonEnd = cancellationCommand[1].indexOf(
    "local rawJob = redis.call('GET', KEYS[2])",
    sameReasonStart,
  );
  const sameReasonBlock = cancellationCommand[1].slice(
    sameReasonStart,
    sameReasonEnd,
  );
  assert.match(
    sameReasonBlock,
    /if cancellationChanged then[\s\S]*redis\.call\('SET', KEYS\[1\], encoded, 'EX', ARGV\[9\]\)/u,
  );

  const replayed = await stopResumeAskSuppression(candidateUserId, {
    ...chaseScope,
    reason: "cancelled",
    stoppedAt: "2026-07-28T01:00:00.000Z",
  }, {
    kvImpl: async () => [2, JSON.stringify(stoppedForNoShow)],
  });
  assert.equal(replayed.record.cancellationAt, cancellationAt);
  assert.equal(replayed.record.stoppedAt, originalStoppedAt);
});

test("same-anchor concurrent generations choose the most recent completed call", async () => {
  const commonAnchor = "2026-07-25T00:00:00.000Z";
  const olderJobId = "bot_sameanchor_old";
  const newerJobId = "bot_sameanchor_new";
  const older = {
    jobId: olderJobId,
    chainId: resumeChaseChainId(olderJobId, commonAnchor),
    chainAnchorAt: commonAnchor,
    chainCallEndedAt: "2026-07-10T10:00:00.000Z",
  };
  const newer = {
    jobId: newerJobId,
    chainId: resumeChaseChainId(newerJobId, commonAnchor),
    chainAnchorAt: commonAnchor,
    chainCallEndedAt: "2026-07-20T10:00:00.000Z",
  };
  let current = null;
  const commands = [];
  const kvImpl = async (command) => {
    commands.push(command);
    const proposed = JSON.parse(command[9]);
    if (!current) {
      current = proposed;
      return [1, JSON.stringify(current)];
    }
    if (current.chainId === proposed.chainId) {
      return [2, JSON.stringify(current)];
    }
    const before = [
      current.chainAnchorAt,
      current.callEndedAt || "",
      current.chainId,
    ];
    const after = [
      proposed.chainAnchorAt,
      proposed.callEndedAt || "",
      proposed.chainId,
    ];
    if (after.join("\0") > before.join("\0")) {
      current = proposed;
      return [1, JSON.stringify(current)];
    }
    return [-1, JSON.stringify(current)];
  };

  const [olderResult, newerResult] = await Promise.all([
    activateResumeChaseGeneration(candidateUserId, older, { kvImpl }),
    activateResumeChaseGeneration(candidateUserId, newer, { kvImpl }),
  ]);
  assert.equal(olderResult.current, true);
  assert.equal(newerResult.current, true);
  assert.equal(current.chainId, newer.chainId);
  assert.match(
    commands[0][1],
    /currentCallEndedAt > ARGV\[3\]/u,
  );

  const exactReplay = await activateResumeChaseGeneration(
    candidateUserId,
    newer,
    { kvImpl },
  );
  assert.equal(exactReplay.status, "existing");
  assert.equal(exactReplay.current, true);

  const staleReplay = await activateResumeChaseGeneration(
    candidateUserId,
    older,
    { kvImpl },
  );
  assert.equal(staleReplay.status, "superseded");
  assert.equal(staleReplay.current, false);
});

test("newer candidate generations carry the durable three-touch progression", async () => {
  for (const deliveredTouch of [1, 2]) {
    const nextJobId = `bot_repeat_${deliveredTouch}2345678`;
    const nextAnchorAt = `2026-08-0${deliveredTouch + 1}T01:00:00.000Z`;
    const nextScope = {
      jobId: nextJobId,
      chainId: resumeChaseChainId(nextJobId, nextAnchorAt),
      chainAnchorAt: nextAnchorAt,
      chainCallEndedAt:
        `2026-08-0${deliveredTouch + 1}T00:30:00.000Z`,
    };
    const carried = {
      version: 1,
      candidateHash: hashedResumeCandidateId(candidateUserId),
      chainId: nextScope.chainId,
      chainAnchorAt: nextScope.chainAnchorAt,
      callEndedAt: nextScope.chainCallEndedAt,
      lastTouch: deliveredTouch,
      lastDeliveredTouch: deliveredTouch,
      lastSentAt: `2026-07-2${deliveredTouch}T05:00:00.000Z`,
      carriedFromChainId: chainId,
    };
    let activationCommand;
    const activated = await activateResumeChaseGeneration(
      candidateUserId,
      nextScope,
      {
        kvImpl: async (command) => {
          activationCommand = command;
          return [1, JSON.stringify(carried)];
        },
      },
    );
    assert.equal(activated.current, true);
    assert.equal(activated.record.lastTouch, deliveredTouch);
    assert.equal(
      activated.record.lastDeliveredTouch,
      deliveredTouch,
    );
    assert.match(
      activationCommand[1],
      /proposed\.lastTouch = tonumber\(current\.lastTouch or 0\)/u,
    );
    assert.match(
      activationCommand[1],
      /proposed\.lastSentAt = current\.lastSentAt/u,
    );

    const readAfterRestart = await getResumeAskSuppression(
      candidateUserId,
      {
        chainId: nextScope.chainId,
        kvImpl: async () => [
          null,
          null,
          JSON.stringify(carried),
        ],
      },
    );
    assert.equal(
      readAfterRestart.currentGeneration.lastTouch,
      deliveredTouch,
    );

    const nextTouch = deliveredTouch + 1;
    const newChainRecord = {
      version: 2,
      candidateHash: hashedResumeCandidateId(candidateUserId),
      chainId: nextScope.chainId,
      chainAnchorAt: nextScope.chainAnchorAt,
      status: "active",
      claims: {
        [nextTouch]: {
          eventHash: "e".repeat(64),
          touch: nextTouch,
        },
      },
      lastTouch: nextTouch,
    };
    let claimCommand;
    const claim = await claimResumeAskSuppression(candidateUserId, {
      ...nextScope,
      eventId: `repeat-touch-${nextTouch}`,
      touch: nextTouch,
    }, {
      kvImpl: async (command) => {
        claimCommand = command;
        return [1, JSON.stringify(newChainRecord)];
      },
    });
    assert.equal(claim.allowed, true);
    assert.match(
      claimCommand[1],
      /requestedTouch ~= carriedTouch \+ 1/u,
    );
    assert.match(
      claimCommand[1],
      /redis\.call\('SET', KEYS\[4\], currentRaw/u,
    );
  }

  const capped = await claimResumeAskSuppression(candidateUserId, {
    ...chaseScope,
    eventId: "fourth-touch-must-never-send",
    touch: 3,
  }, {
    kvImpl: async () => [-9, JSON.stringify({
      chainId,
      lastTouch: 3,
      lastDeliveredTouch: 3,
    })],
  });
  assert.equal(capped.status, "candidate_touch_cap");
  assert.equal(capped.allowed, false);
  assert.equal(capped.idempotent, true);
});

test("pending claim lineage survives repeated active rollovers and fences new claims", async () => {
  const eventId = "origin-touch-2-pending";
  const eventHash = createHash("sha256")
    .update("resume-ask-event-v1")
    .update("\0")
    .update(eventId)
    .digest("hex");
  const lineage = {
    eventHash,
    touch: 2,
    originChainId: chainId,
  };
  const rolloverScopes = [
    {
      jobId: "bot_rollover_b",
      chainAnchorAt: "2026-08-12T01:00:00.000Z",
      chainCallEndedAt: "2026-08-12T00:30:00.000Z",
    },
    {
      jobId: "bot_rollover_c",
      chainAnchorAt: "2026-08-13T01:00:00.000Z",
      chainCallEndedAt: "2026-08-13T00:30:00.000Z",
    },
  ].map((scope) => ({
    ...scope,
    chainId: resumeChaseChainId(scope.jobId, scope.chainAnchorAt),
  }));

  for (const scope of rolloverScopes) {
    const carried = {
      version: 1,
      candidateHash: hashedResumeCandidateId(candidateUserId),
      chainId: scope.chainId,
      chainAnchorAt: scope.chainAnchorAt,
      callEndedAt: scope.chainCallEndedAt,
      status: "active",
      lastTouch: 2,
      lastDeliveredTouch: 1,
      pendingClaimLineage: lineage,
    };
    let activationCommand;
    const activated = await activateResumeChaseGeneration(
      candidateUserId,
      scope,
      {
        kvImpl: async (command) => {
          activationCommand = command;
          return [1, JSON.stringify(carried)];
        },
      },
    );
    assert.deepEqual(activated.record.pendingClaimLineage, lineage);
    assert.match(
      activationCommand[1],
      /proposed\.pendingClaimLineage = current\.pendingClaimLineage/u,
    );
    assert.equal(
      JSON.stringify(activated.record).includes(eventId),
      false,
    );
  }

  const newest = rolloverScopes.at(-1);
  let claimCommand;
  const blocked = await claimResumeAskSuppression(candidateUserId, {
    ...newest,
    eventId: "newer-chain-must-wait",
    touch: 3,
  }, {
    kvImpl: async (command) => {
      claimCommand = command;
      return [-11, JSON.stringify({
        chainId: newest.chainId,
        lastTouch: 2,
        lastDeliveredTouch: 1,
        pendingClaimLineage: lineage,
      })];
    },
  });
  assert.equal(blocked.status, "pending_claim_conflict");
  assert.equal(blocked.allowed, false);
  assert.deepEqual(
    blocked.currentGeneration.pendingClaimLineage,
    lineage,
  );
  assert.match(
    claimCommand[1],
    /if currentIsNewer then\s+if current\.pendingClaimLineage\s+and not pendingLineageMatches\(current\) then/u,
  );
  assert.match(
    claimCommand[1],
    /proposed\.pendingClaimLineage = current\.pendingClaimLineage/u,
  );
  assert.match(
    claimCommand[1],
    /current\.pendingClaimLineage = \{\s+eventHash = nextClaim\.eventHash,\s+touch = requestedTouch,\s+originChainId = ARGV\[5\]/u,
  );
  assert.ok(
    claimCommand[1].indexOf("if current.pendingClaimLineage")
      < claimCommand[1].indexOf("local carriedTouch"),
    "a second claim must fail before touch progression advances",
  );
});

test("stopping a superseded origin releases only its exact pending lineage", async () => {
  const eventHash = "a".repeat(64);
  const newestChainId = resumeChaseChainId(
    "bot_rollover_release",
    "2026-08-14T01:00:00.000Z",
  );
  const stoppedRecord = {
    version: 2,
    candidateHash: hashedResumeCandidateId(candidateUserId),
    chainId,
    chainAnchorAt,
    status: "stopped",
    stopped: true,
    stoppedAt: "2026-08-14T01:05:00.000Z",
    stopReason: "send_unknown",
    stopScope: "chain",
    claims: {},
  };
  let stopCommand;
  const stopped = await stopResumeAskSuppression(candidateUserId, {
    ...chaseScope,
    reason: "send_unknown",
    stoppedAt: "2026-08-14T01:05:00.000Z",
  }, {
    kvImpl: async (command) => {
      stopCommand = command;
      return [1, JSON.stringify(stoppedRecord)];
    },
  });
  assert.equal(stopped.record.stopReason, "send_unknown");
  assert.match(
    stopCommand[1],
    /if current\.chainId ~= ARGV\[5\] then[\s\S]*tostring\(lineage\.originChainId or ''\) == ARGV\[5\]/u,
  );
  assert.match(
    stopCommand[1],
    /current\.pendingClaimLineage = nil\s+current\.lastTouch =\s+tonumber\(current\.lastDeliveredTouch or 0\)/u,
  );
  assert.match(
    stopCommand[1],
    /redis\.call\(\s+'SET',\s+KEYS\[4\],\s+cjson\.encode\(current\)/u,
  );
  assert.equal(stopCommand[11], chainId);
  assert.notEqual(stopCommand[11], newestChainId);
});

test("only the pending origin can confirm through rollover and touch 3 terminalizes the newest generation", async () => {
  const eventId = "origin-touch-3-pending";
  const eventHash = createHash("sha256")
    .update("resume-ask-event-v1")
    .update("\0")
    .update(eventId)
    .digest("hex");
  const deliveredAt = "2026-08-01T01:01:00.000Z";
  const deliveredRecord = {
    version: 2,
    candidateHash: hashedResumeCandidateId(candidateUserId),
    chainId,
    chainAnchorAt,
    status: "active",
    stopped: false,
    claims: {
      3: {
        eventHash,
        touch: 3,
        deliveredAt,
      },
    },
    lastTouch: 3,
    lastDeliveredTouch: 3,
    lastSentAt: deliveredAt,
    terminalAck: {
      touch: 3,
      eventHash,
      outcome: "delivered",
      acknowledgedAt: deliveredAt,
    },
  };
  let confirmCommand;
  const confirmed = await confirmResumeAskSuppression(candidateUserId, {
    ...chaseScope,
    eventId,
    touch: 3,
    deliveredAt,
  }, {
    kvImpl: async (command) => {
      confirmCommand = command;
      return [1, JSON.stringify(deliveredRecord)];
    },
  });
  assert.equal(confirmed.status, "confirmed");
  assert.equal(confirmed.confirmed, true);
  assert.match(
    confirmCommand[1],
    /tostring\(lineage\.originChainId or ''\) == ARGV\[5\]/u,
  );
  assert.match(
    confirmCommand[1],
    /if current\.chainId ~= ARGV\[5\] then\s+if not lineage then return \{-6, raw\} end\s+if not lineageMatches then return \{-7, raw\} end/u,
  );
  assert.match(
    confirmCommand[1],
    /if lineage and not lineageMatches then return \{-7, raw\} end/u,
  );
  const clearIndex = confirmCommand[1].indexOf(
    "current.pendingClaimLineage = nil",
  );
  const terminalIndex = confirmCommand[1].indexOf(
    "current.status = 'terminal'",
  );
  assert.ok(clearIndex >= 0 && clearIndex < terminalIndex);

  const mismatched = await confirmResumeAskSuppression(candidateUserId, {
    ...chaseScope,
    eventId,
    touch: 3,
    deliveredAt,
  }, {
    kvImpl: async () => [-7, JSON.stringify(deliveredRecord)],
  });
  assert.equal(mismatched.status, "pending_claim_conflict");
  assert.equal(mismatched.confirmed, false);

  const unmarkedSuperseded = await confirmResumeAskSuppression(
    candidateUserId,
    {
      ...chaseScope,
      eventId,
      touch: 3,
      deliveredAt,
    },
    {
      kvImpl: async () => [-6, JSON.stringify(deliveredRecord)],
    },
  );
  assert.equal(unmarkedSuperseded.status, "superseded");
  assert.equal(unmarkedSuperseded.confirmed, false);
});

test("a terminal generation resets progression for a later independent chain", async () => {
  const laterJobId = "bot_after_terminal";
  const laterAnchorAt = "2026-08-20T01:00:00.000Z";
  const laterScope = {
    jobId: laterJobId,
    chainId: resumeChaseChainId(laterJobId, laterAnchorAt),
    chainAnchorAt: laterAnchorAt,
    chainCallEndedAt: "2026-08-20T00:30:00.000Z",
  };
  const reset = {
    version: 1,
    candidateHash: hashedResumeCandidateId(candidateUserId),
    chainId: laterScope.chainId,
    chainAnchorAt: laterAnchorAt,
    callEndedAt: laterScope.chainCallEndedAt,
    status: "active",
    resetFromChainId: chainId,
  };
  let activationCommand;
  const activated = await activateResumeChaseGeneration(
    candidateUserId,
    laterScope,
    {
      kvImpl: async (command) => {
        activationCommand = command;
        return [1, JSON.stringify(reset)];
      },
    },
  );
  assert.equal(activated.record.lastTouch, undefined);
  assert.equal(activated.record.lastDeliveredTouch, undefined);
  assert.equal(activated.record.resetFromChainId, chainId);
  assert.match(
    activationCommand[1],
    /local currentTerminal = current\.status == 'terminal'/u,
  );
  assert.match(
    activationCommand[1],
    /proposed\.resetFromChainId = current\.chainId/u,
  );
  assert.match(
    activationCommand[1],
    /if not currentTerminal then/u,
  );
});

test("touch-3 confirm and explicit delivered acknowledgement converge idempotently", async () => {
  const eventId = "touch-3-delivery-owner";
  const eventHash = createHash("sha256")
    .update("resume-ask-event-v1")
    .update("\0")
    .update(eventId)
    .digest("hex");
  const deliveredRecord = {
    version: 2,
    candidateHash: hashedResumeCandidateId(candidateUserId),
    chainId,
    chainAnchorAt,
    status: "active",
    stopped: false,
    claims: {
      3: {
        eventHash,
        touch: 3,
        deliveredAt: "2026-08-01T01:01:00.000Z",
      },
    },
    terminalAck: {
      touch: 3,
      eventHash,
      outcome: "delivered",
      acknowledgedAt: "2026-08-01T01:01:00.000Z",
    },
  };
  const confirmCommands = [];
  const confirmed = await confirmResumeAskSuppression(candidateUserId, {
    ...chaseScope,
    eventId,
    touch: 3,
    deliveredAt: "2026-08-01T01:01:00.000Z",
  }, {
    kvImpl: async (command) => {
      confirmCommands.push(command);
      return [1, JSON.stringify(deliveredRecord)];
    },
  });
  assert.equal(confirmed.confirmed, true);
  assert.match(
    confirmCommands[0][1],
    /tonumber\(ARGV\[1\]\) == 3/u,
  );
  assert.match(
    confirmCommands[0][1],
    /record\.lastDeliveredTouch = math\.max/u,
  );
  assert.match(
    confirmCommands[0][1],
    /current\.status = 'terminal'/u,
  );

  const acknowledged = await ackResumeAskTerminal(candidateUserId, {
    ...chaseScope,
    eventId,
    touch: 3,
    outcome: "delivered",
    acknowledgedAt: "2026-08-01T01:01:00.000Z",
  }, {
    kvImpl: async () => [2, JSON.stringify(deliveredRecord)],
  });
  assert.deepEqual({
    status: acknowledged.status,
    acknowledged: acknowledged.acknowledged,
    idempotent: acknowledged.idempotent,
    outcome: acknowledged.outcome,
  }, {
    status: "existing",
    acknowledged: true,
    idempotent: true,
    outcome: "delivered",
  });

  const acknowledgeFirst = await ackResumeAskTerminal(candidateUserId, {
    ...chaseScope,
    eventId,
    touch: 3,
    outcome: "delivered",
  }, {
    kvImpl: async () => [1, JSON.stringify(deliveredRecord)],
  });
  assert.equal(acknowledgeFirst.acknowledged, true);
  const confirmReplay = await confirmResumeAskSuppression(candidateUserId, {
    ...chaseScope,
    eventId,
    touch: 3,
  }, {
    kvImpl: async () => [2, JSON.stringify(deliveredRecord)],
  });
  assert.equal(confirmReplay.status, "existing");
  assert.equal(confirmReplay.confirmed, true);
});
