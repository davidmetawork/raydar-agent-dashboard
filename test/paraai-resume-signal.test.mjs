import { createHmac } from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";

import {
  resumeSignalBase,
  resumeSignalId,
  signResumeSignal,
  verifyResumeSignal,
} from "../api/paraai/_lib/resume-signal.mjs";
import {
  hashedResumeCandidateId,
  resumeChaseChainId,
} from "../api/paraai/_lib/store.mjs";
import {
  resumeWaitPlan,
} from "../api/paraai/_lib/resume-wait.mjs";
import { handleResumeAttached } from "../api/paraai/resume-attached.mjs";
import { handleResumeWaiting } from "../api/paraai/resume-waiting.mjs";

const secret = "phase-2-resume-signal-test-secret";
const timestamp = 1_785_000_000;
const nowMs = timestamp * 1000;
const candidateUserId = "candidate-private-123";
const jobId = "bot_12345678";
const chainAnchorAt = "2026-07-25T02:00:00.000Z";
const chaseChainId = resumeChaseChainId(jobId, chainAnchorAt);

function signedHeaders(method, pathname, rawBody = "", at = timestamp) {
  return {
    "content-type": "application/json",
    "x-raydar-timestamp": String(at),
    "x-raydar-signature": signResumeSignal({
      secret,
      timestamp: at,
      method,
      pathname,
      rawBody,
    }),
  };
}

function signedRequest(pathname, {
  method = "GET",
  rawBody = "",
  at = timestamp,
  signaturePath = pathname,
} = {}) {
  return new Request(`https://monitor.raydar.xyz${pathname}`, {
    method,
    headers: signedHeaders(method, signaturePath, rawBody, at),
    ...(method === "GET" ? {} : { body: rawBody }),
  });
}

test("resume service HMAC signs the exact documented canonical bytes", () => {
  const rawBody = '{"candidateUserId":"private-id","eventId":"attach-1"}';
  const base = `${timestamp}.POST./api/paraai/resume-attached.${rawBody}`;
  assert.equal(resumeSignalBase({
    timestamp,
    method: "post",
    pathname: "/api/paraai/resume-attached",
    rawBody,
  }), base);
  const expected = `v1=${createHmac("sha256", secret).update(base).digest("hex")}`;
  assert.equal(signResumeSignal({
    secret,
    timestamp,
    method: "POST",
    pathname: "/api/paraai/resume-attached",
    rawBody,
  }), expected);
  assert.match(expected, /^v1=[a-f0-9]{64}$/);
  assert.throws(
    () => signResumeSignal({
      secret: "too-short",
      timestamp,
      method: "POST",
      pathname: "/api/paraai/resume-attached",
      rawBody,
    }),
    (error) => error?.code === "RESUME_SIGNAL_NOT_CONFIGURED",
  );
});

test("resume service verifier enforces raw-body/path integrity and a strict five-minute seconds clock", () => {
  const pathname = "/api/paraai/resume-attached";
  const rawBody = '{"candidateUserId":"private-id"}';
  const headers = signedHeaders("POST", pathname, rawBody);
  assert.deepEqual(verifyResumeSignal({
    secret,
    headers,
    method: "POST",
    pathname,
    rawBody,
    nowMs,
  }), {
    timestamp,
    signedRequestId: resumeSignalId({ rawBody }),
  });
  assert.throws(
    () => verifyResumeSignal({
      secret,
      headers,
      method: "POST",
      pathname,
      rawBody: `${rawBody} `,
      nowMs,
    }),
    (error) => error?.code === "RESUME_SIGNAL_SIGNATURE_INVALID",
  );
  assert.throws(
    () => verifyResumeSignal({
      secret,
      headers,
      method: "POST",
      pathname: "/api/paraai/resume-waiting",
      rawBody,
      nowMs,
    }),
    (error) => error?.code === "RESUME_SIGNAL_SIGNATURE_INVALID",
  );
  assert.throws(
    () => verifyResumeSignal({
      secret,
      headers: signedHeaders("POST", pathname, rawBody, timestamp - 301),
      method: "POST",
      pathname,
      rawBody,
      nowMs,
    }),
    (error) => error?.code === "RESUME_SIGNAL_TIMESTAMP_INVALID",
  );
  assert.doesNotThrow(() => verifyResumeSignal({
    secret,
    headers: signedHeaders("POST", pathname, rawBody, timestamp - 300),
    method: "POST",
    pathname,
    rawBody,
    nowMs,
  }));
  assert.throws(
    () => verifyResumeSignal({
      secret,
      headers: {
        "x-raydar-timestamp": String(timestamp * 1000),
        "x-raydar-signature": "v1=".padEnd(67, "0"),
      },
      method: "POST",
      pathname,
      rawBody,
      nowMs,
    }),
    (error) => error?.code === "RESUME_SIGNAL_TIMESTAMP_INVALID",
    "13-digit millisecond timestamps must be rejected, not treated as seconds",
  );
  for (const invalidTimestamp of ["999999999", "10000000000"]) {
    assert.throws(
      () => verifyResumeSignal({
        secret,
        headers: {
          "x-raydar-timestamp": invalidTimestamp,
          "x-raydar-signature": "v1=".padEnd(67, "0"),
        },
        method: "POST",
        pathname,
        rawBody,
        nowMs,
      }),
      (error) => error?.code === "RESUME_SIGNAL_TIMESTAMP_INVALID",
      "only an exact 10-digit epoch-seconds timestamp is accepted",
    );
  }
  assert.throws(
    () => verifyResumeSignal({
      secret,
      headers: {
        ...headers,
        "x-raydar-signature": headers["x-raydar-signature"].toUpperCase(),
      },
      method: "POST",
      pathname,
      rawBody,
      nowMs,
    }),
    (error) => error?.code === "RESUME_SIGNAL_SIGNATURE_INVALID",
    "signature contract is v1 plus lowercase hex",
  );
});

test("resume-attached stops chase and immediately re-dues only currently waiting jobs", async () => {
  const rawBody = JSON.stringify({ candidateUserId, eventId: "booking-sync-attach-1" });
  const signals = [];
  const stops = [];
  const enqueues = [];
  const waiting = [
    {
      id: jobId,
      state: "waiting_for_resume",
      callEndedAt: "2026-07-25T01:00:00.000Z",
      identity: { candidateUserId },
      automation: { resumeWait: { enteredAt: chainAnchorAt } },
    },
    {
      id: "bot_87654321",
      state: "waiting_for_resume",
      identity: { candidateUserId: "other-private-candidate" },
    },
    {
      id: "bot_notwait12",
      state: "ready_to_submit",
      identity: { candidateUserId },
    },
  ];
  const response = await handleResumeAttached(signedRequest("/api/paraai/resume-attached", {
    method: "POST",
    rawBody,
  }), {
    secret,
    now: () => nowMs,
    hasStore: () => true,
    recordSignal: async (...args) => {
      signals.push(args);
      return { receivedAt: new Date(nowMs).toISOString() };
    },
    listWaiting: async () => waiting,
    stopSuppression: async (...args) => {
      stops.push(args);
      return { status: "stopped", stopped: true };
    },
    enqueue: async (...args) => {
      enqueues.push(args);
      return { enqueued: true, duplicate: false };
    },
  });
  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), {
    ok: true,
    matched: 1,
    enqueued: 1,
    duplicate: 0,
    stopped: 1,
  });
  assert.equal(signals.length, 1);
  assert.equal(signals[0][0], candidateUserId);
  assert.match(signals[0][1].eventId, /^[a-f0-9]{64}$/);
  assert.equal(signals[0][1].receivedAt, new Date(nowMs).toISOString());
  assert.equal(stops.length, 1);
  assert.equal(stops[0][0], candidateUserId);
  assert.equal(stops[0][1].reason, "resume_attached");
  assert.equal(stops[0][1].chainId, chaseChainId);
  assert.equal(stops[0][1].chainAnchorAt, chainAnchorAt);
  assert.equal(
    stops[0][1].chainCallEndedAt,
    "2026-07-25T01:00:00.000Z",
  );
  assert.equal(enqueues.length, 1);
  assert.equal(enqueues[0][0], jobId);
  assert.match(enqueues[0][1].source, /^resume_attached:[a-f0-9]{64}$/);
  assert.match(enqueues[0][1].eventId, /^resume-attached:[a-f0-9]{64}$/);
  assert.equal(enqueues[0][1].dueAt, nowMs);
  assert.equal(JSON.stringify(enqueues[0][1]).includes(candidateUserId), false);
  assert.equal(JSON.stringify(enqueues[0][1]).includes("booking-sync-attach-1"), false);
});

test("resume-attached exact replay is deterministic and no-ops safely outside waiting state", async () => {
  const rawBody = JSON.stringify({ candidateUserId, eventId: "stable-attach-event" });
  const sources = [];
  const eventIds = [];
  let enqueueCount = 0;
  const dependencies = {
    secret,
    hasStore: () => true,
    now: () => nowMs,
    recordSignal: async () => ({ receivedAt: new Date(nowMs).toISOString() }),
    listWaiting: async () => [{
      id: jobId,
      state: "waiting_for_resume",
      callEndedAt: "2026-07-25T01:00:00.000Z",
      identity: { candidateUserId },
      automation: { resumeWait: { enteredAt: chainAnchorAt } },
    }],
    stopSuppression: async () => ({ status: "stopped", stopped: true }),
    enqueue: async (_id, options) => {
      sources.push(options.source);
      eventIds.push(options.eventId);
      enqueueCount += 1;
      return { enqueued: enqueueCount === 1, duplicate: enqueueCount > 1 };
    },
  };
  const first = await handleResumeAttached(signedRequest("/api/paraai/resume-attached", {
    method: "POST",
    rawBody,
  }), dependencies);
  const replay = await handleResumeAttached(signedRequest("/api/paraai/resume-attached", {
    method: "POST",
    rawBody,
    at: timestamp + 1,
  }), dependencies);
  assert.equal((await first.json()).enqueued, 1);
  assert.deepEqual(await replay.json(), {
    ok: true,
    matched: 1,
    enqueued: 0,
    duplicate: 1,
    stopped: 1,
  });
  assert.equal(sources[0], sources[1]);
  assert.equal(eventIds[0], eventIds[1]);

  let stopped = 0;
  const noWait = await handleResumeAttached(signedRequest("/api/paraai/resume-attached", {
    method: "POST",
    rawBody,
  }), {
    secret,
    now: () => nowMs,
    hasStore: () => true,
    recordSignal: async () => ({ receivedAt: new Date(nowMs).toISOString() }),
    listWaiting: async () => [],
    stopSuppression: async () => {
      stopped += 1;
      return { status: "existing", stopped: true };
    },
    enqueue: async () => assert.fail("must not enqueue outside waiting_for_resume"),
  });
  assert.deepEqual(await noWait.json(), {
    ok: true,
    matched: 0,
    enqueued: 0,
    duplicate: 0,
    stopped: 0,
  });
  assert.equal(stopped, 0);
});

test("resume-attached rejects unsigned calls before reading waiting state", async () => {
  let reads = 0;
  const rawBody = JSON.stringify({ candidateUserId });
  const response = await handleResumeAttached(new Request(
    "https://monitor.raydar.xyz/api/paraai/resume-attached",
    { method: "POST", body: rawBody },
  ), {
    secret,
    hasStore: () => true,
    listWaiting: async () => {
      reads += 1;
      return [];
    },
  });
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { ok: false, error: "unauthorized" });
  assert.equal(reads, 0);
});

test("signed waiting feed exposes only chase-required fields and durable scheduledChecks", async () => {
  const job = {
    id: jobId,
    state: "waiting_for_resume",
    bookingCreatedAt: "2026-07-20T04:00:00.000Z",
    bookingCreatedAtSource: "source_created_at",
    callType: "agent",
    callEndedAt: "2026-07-25T01:00:00.000Z",
    updatedAt: "2026-07-25T02:00:00.000Z",
    candidate: {
      scheduledStart: "2026-07-25T00:30:00.000Z",
      paraformEventId: "pf-event-source-123",
    },
    identity: { candidateUserId },
    submission: {
      name: "Candidate Example",
      email: "candidate@example.com",
      resumeUri: "s3://private/resume.pdf",
    },
    automation: {
      resumeWait: {
        source: "organic",
        enteredAt: "2026-07-25T02:00:00.000Z",
        expiresAt: "2026-08-01T02:00:00.000Z",
        claimableThroughAt: "2026-08-01T02:15:00.000Z",
        scheduledChecks: 3,
        terminalAck: {
          status: "awaiting_ack",
          openedAt: "2026-08-01T02:00:00.000Z",
          opsDeadlineAt: "2026-08-01T02:15:00.000Z",
          claimableThroughAt: "2026-08-01T02:15:00.000Z",
        },
      },
    },
    transcript: "private transcript must never leave the feed",
    reviewPreferences: { salaryMin: 200000 },
  };
  const response = await handleResumeWaiting(signedRequest("/api/paraai/resume-waiting"), {
    secret,
    now: () => nowMs,
    hasStore: () => true,
    listWaiting: async (_limit, options) => {
      assert.deepEqual(options, { withCompleteness: true });
      return {
        jobs: [job],
        complete: true,
        totalWaiting: 1,
      };
    },
    activateGeneration: async () => ({
      status: "existing",
      current: true,
    }),
    getSuppression: async () => ({
      version: 2,
      chainId: chaseChainId,
      currentGeneration: { chainId: chaseChainId },
      candidateSatisfaction: null,
      chain: {
        status: "stopped",
        stopped: true,
        stoppedAt: "2026-07-25T12:00:00+09:00",
        stopReason: "cancelled",
        lastTouch: 1,
        lastDeliveredTouch: 1,
        lastSentAt: "2026-07-25T03:00:00.000Z",
        claims: {
          1: {
            eventHash: "a".repeat(64),
            deliveredAt: "2026-07-25T03:00:00.000Z",
          },
        },
      },
    }),
  });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.ok, true);
  assert.equal(payload.count, 1);
  assert.equal(payload.complete, true);
  assert.equal(payload.totalWaiting, 1);
  assert.deepEqual(Object.keys(payload.waiting[0]).sort(), [
    "bookingCreatedAt",
    "bookingCreatedAtSource",
    "bookingSourceId",
    "callEndedAt",
    "callType",
    "candidateHash",
    "candidateName",
    "candidateUserId",
    "chaseChainId",
    "email",
    "jobId",
    "resumeLinkDisposition",
    "resumeReceipt",
    "resumeWait",
    "scheduledAt",
    "suppression",
  ]);
  assert.equal(payload.waiting[0].scheduledAt, "2026-07-25T00:30:00.000Z");
  assert.equal(payload.waiting[0].bookingCreatedAt, "2026-07-20T04:00:00.000Z");
  assert.equal(payload.waiting[0].bookingCreatedAtSource, "source_created_at");
  assert.equal(payload.waiting[0].bookingSourceId, "pf-event-source-123");
  assert.equal(payload.waiting[0].resumeLinkDisposition, null);
  assert.equal(payload.waiting[0].resumeReceipt, null);
  assert.equal(payload.waiting[0].chaseChainId, chaseChainId);
  assert.equal(payload.waiting[0].resumeWait.checkCount, 3);
  assert.equal(
    payload.waiting[0].resumeWait.claimableThroughAt,
    "2026-08-01T02:15:00.000Z",
  );
  assert.deepEqual(payload.waiting[0].suppression, {
    candidateSatisfied: false,
    candidateSatisfactionReason: null,
    chainStopped: true,
    chainStopReason: "cancelled",
    chainStoppedAt: "2026-07-25T03:00:00.000Z",
    chainCancellationAt: "2026-07-25T03:00:00.000Z",
    lastTouch: 1,
    lastSentAt: "2026-07-25T03:00:00.000Z",
  });
  const serialized = JSON.stringify(payload);
  assert.equal(serialized.includes("private transcript"), false);
  assert.equal(serialized.includes("s3://private"), false);
  assert.equal(serialized.includes("salaryMin"), false);
  assert.equal(serialized.includes("eventHash"), false);

  const pendingResponse = await handleResumeWaiting(
    signedRequest("/api/paraai/resume-waiting"),
    {
      secret,
      now: () => nowMs,
      hasStore: () => true,
      listWaiting: async () => ({
        jobs: [job],
        complete: true,
        totalWaiting: 1,
      }),
      activateGeneration: async () => ({ current: true }),
      getSuppression: async () => ({
        currentGeneration: {
          chainId: chaseChainId,
          lastTouch: 1,
          lastDeliveredTouch: 0,
        },
        candidateSatisfaction: null,
        chain: {
          status: "active",
          stopped: false,
          lastTouch: 1,
          claims: { 1: { eventHash: "b".repeat(64) } },
        },
      }),
    },
  );
  const pendingRow = (await pendingResponse.json()).waiting[0];
  assert.equal(pendingRow.suppression.lastTouch, null);
  assert.equal(pendingRow.suppression.lastSentAt, null);
  assert.equal(pendingRow.suppression.chainStopped, false);
});

test("a new empty-suppression resume plan exposes its persisted initial claim fence", async () => {
  const wait = resumeWaitPlan({
    source: "organic",
    anchorAt: chainAnchorAt,
  });
  const job = {
    id: jobId,
    state: "waiting_for_resume",
    bookingCreatedAt: "2026-07-20T04:00:00.000Z",
    bookingCreatedAtSource: "source_created_at",
    callType: "agent",
    callEndedAt: chainAnchorAt,
    candidate: {
      paraformEventId: "pf-event-source-123",
    },
    identity: { candidateUserId },
    submission: {
      name: "Candidate Example",
      email: "candidate@example.com",
    },
    automation: { resumeWait: wait },
  };
  const response = await handleResumeWaiting(
    signedRequest("/api/paraai/resume-waiting"),
    {
      secret,
      now: () => nowMs,
      hasStore: () => true,
      listWaiting: async () => ({
        jobs: [job],
        complete: true,
        totalWaiting: 1,
      }),
      activateGeneration: async () => ({ current: true }),
      getSuppression: async () => null,
      save: async () => assert.fail(
        "a real resumeWaitPlan must already persist its initial fence",
      ),
    },
  );
  assert.equal(response.status, 200);
  const row = (await response.json()).waiting[0];
  assert.equal(
    row.resumeWait.claimableThroughAt,
    "2026-07-26T04:00:00.000Z",
  );
  assert.equal(row.resumeWait.terminalAck, null);
});

test("waiting feed exposes candidate-wide carried touch progress on the newest chain", async () => {
  const wait = resumeWaitPlan({
    source: "organic",
    anchorAt: chainAnchorAt,
  });
  const job = {
    id: jobId,
    revision: 2,
    state: "waiting_for_resume",
    bookingCreatedAt: "2026-07-20T04:00:00.000Z",
    callType: "agent",
    callEndedAt: chainAnchorAt,
    identity: { candidateUserId },
    candidate: { paraformEventId: "pf-event-source-123" },
    automation: { resumeWait: wait },
    journal: [],
  };
  const response = await handleResumeWaiting(
    signedRequest("/api/paraai/resume-waiting"),
    {
      secret,
      now: () => nowMs,
      hasStore: () => true,
      listWaiting: async () => ({
        jobs: [job],
        complete: true,
        totalWaiting: 1,
      }),
      activateGeneration: async () => ({ current: true }),
      getSuppression: async () => ({
        currentGeneration: {
          chainId: chaseChainId,
          lastTouch: 2,
          lastDeliveredTouch: 2,
          lastSentAt: "2026-07-25T04:00:00.000Z",
        },
        chain: null,
        candidateSatisfaction: null,
      }),
      save: async (next, revision) => ({
        ...next,
        revision: revision + 1,
      }),
    },
  );
  assert.equal(response.status, 200);
  const row = (await response.json()).waiting[0];
  assert.equal(row.suppression.lastTouch, 2);
  assert.equal(
    row.suppression.lastSentAt,
    "2026-07-25T04:00:00.000Z",
  );
  assert.equal(row.suppression.chainStopped, false);
});

test("signed waiting feed suppresses Paraform and Raydar internal email domains", async () => {
  const jobs = [
    ["@paraform.com", "candidate@paraform.com"],
    ["@raydar.xyz", "candidate@raydar.xyz"],
    ["@raydargroup.com", "candidate@raydargroup.com"],
  ].map(([domain, email], index) => ({
    id: `bot_internal${index}`,
    state: "waiting_for_resume",
    identity: { candidateUserId: `${candidateUserId}-${index}` },
    submission: { name: `Internal ${index}`, email },
    automation: {
      resumeWait: {
        enteredAt: "2026-07-25T02:00:00.000Z",
        claimableThroughAt: "2026-07-26T04:00:00.000Z",
      },
    },
    domain,
  }));
  const response = await handleResumeWaiting(signedRequest("/api/paraai/resume-waiting"), {
    secret,
    now: () => nowMs,
    hasStore: () => true,
    listWaiting: async () => jobs,
    activateGeneration: async () => ({ current: true }),
    getSuppression: async () => null,
  });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.count, 3);
  assert.equal(payload.complete, false);
  assert.equal(payload.totalWaiting, null);
  assert.deepEqual(payload.waiting.map((row) => row.email), [null, null, null]);
});

test("waiting feed fails completeness closed when a stored wait cannot normalize", async () => {
  const valid = {
    id: jobId,
    state: "waiting_for_resume",
    identity: { candidateUserId },
    submission: {
      name: "Candidate Example",
      email: "candidate@example.com",
    },
    automation: {
      resumeWait: {
        enteredAt: "2026-07-25T02:00:00.000Z",
        claimableThroughAt: "2026-07-26T04:00:00.000Z",
      },
    },
  };
  const response = await handleResumeWaiting(
    signedRequest("/api/paraai/resume-waiting"),
    {
      secret,
      now: () => nowMs,
      hasStore: () => true,
      listWaiting: async () => ({
        jobs: [
          valid,
          {
            ...valid,
            id: "bot_missing_identity",
            identity: {},
          },
        ],
        complete: true,
        totalWaiting: 2,
      }),
      activateGeneration: async () => ({ current: true }),
      getSuppression: async () => null,
    },
  );
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.count, 1);
  assert.equal(payload.complete, false);
  assert.equal(payload.totalWaiting, null);
});

test("waiting service claim, confirm, and stop actions return status only", async () => {
  const baseJob = {
    id: jobId,
    state: "waiting_for_resume",
    bookingCreatedAt: "2026-07-20T04:00:00.000Z",
    bookingCreatedAtSource: "source_created_at",
    callEndedAt: "2026-07-25T01:00:00.000Z",
    identity: { candidateUserId },
    automation: {
      resumeWait: {
        enteredAt: chainAnchorAt,
        claimableThroughAt: "2026-07-26T04:00:00.000Z",
      },
    },
  };
  const calls = [];
  const runAction = async (body, overrides = {}) => {
    const rawBody = JSON.stringify(body);
    const response = await handleResumeWaiting(signedRequest("/api/paraai/resume-waiting", {
      method: "POST",
      rawBody,
    }), {
      secret,
      now: () => nowMs,
      hasStore: () => true,
      loadJob: async () => baseJob,
      getSuppression: async () => null,
      claimSuppression: async (...args) => {
        calls.push(["claim", ...args]);
        return { status: "claimed", allowed: true, idempotent: false };
      },
      confirmSuppression: async (...args) => {
        calls.push(["confirm", ...args]);
        return { status: "confirmed", confirmed: true, idempotent: false };
      },
      stopSuppression: async (...args) => {
        calls.push(["stop", ...args]);
        return { status: "stopped", stopped: true, idempotent: false };
      },
      ackTerminal: async (...args) => {
        calls.push(["ack", ...args]);
        return {
          status: "acknowledged",
          acknowledged: true,
          idempotent: false,
          outcome: "terminal_no_send",
        };
      },
      enqueue: async () => ({ enqueued: true, duplicate: false }),
      ...overrides,
    });
    return { response, payload: await response.json() };
  };

  const claim = await runAction({
    action: "claim_send",
    jobId,
    chaseChainId,
    candidateHash: resumeSignalId({ eventId: "wrong-namespace" }),
    touch: 1,
    eventId: "chase-touch-1",
    dueAt: "2026-07-25T03:00:00.000Z",
  });
  assert.deepEqual(claim.payload, { ok: true, status: "not_found", allowed: false });
  assert.equal(calls.length, 0, "candidate hash mismatch must fail closed");

  const correctHash = hashedResumeCandidateId(candidateUserId);
  const claimed = await runAction({
    action: "claim_send",
    jobId,
    chaseChainId,
    candidateHash: correctHash,
    touch: 1,
    eventId: "chase-touch-1",
    dueAt: "2026-07-25T03:00:00.000Z",
  });
  assert.deepEqual(claimed.payload, {
    ok: true,
    status: "claimed",
    allowed: true,
    idempotent: false,
    confirmed: false,
  });
  assert.equal(calls[0][0], "claim");
  assert.equal(calls[0][1], candidateUserId);
  assert.equal(calls[0][2].jobId, jobId);
  assert.equal(calls[0][2].chainId, chaseChainId);
  assert.equal(calls[0][2].chainAnchorAt, chainAnchorAt);

  const confirmed = await runAction({
    action: "confirm_send",
    jobId,
    chaseChainId,
    candidateHash: correctHash,
    touch: 1,
    eventId: "chase-touch-1",
    deliveredAt: "2026-07-25T03:01:00.000Z",
  });
  assert.deepEqual(confirmed.payload, {
    ok: true,
    status: "confirmed",
    confirmed: true,
    idempotent: false,
  });

  const unconfirmed = await runAction({
    action: "confirm_send",
    jobId,
    chaseChainId,
    candidateHash: correctHash,
    touch: 2,
    eventId: "chase-touch-2",
    deliveredAt: "2026-07-25T03:02:00.000Z",
  }, {
    confirmSuppression: async () => ({
      status: "event_conflict",
      confirmed: false,
      idempotent: false,
    }),
  });
  assert.equal(unconfirmed.response.status, 409);
  assert.deepEqual(unconfirmed.payload, {
    ok: true,
    status: "event_conflict",
    confirmed: false,
    idempotent: false,
  });

  const acknowledged = await runAction({
    action: "ack_terminal",
    jobId,
    chaseChainId,
    candidateHash: correctHash,
    touch: 3,
    eventId: "chase-touch-3",
    outcome: "terminal_no_send",
    acknowledgedAt: "2026-07-25T03:03:00.000Z",
  });
  assert.deepEqual(acknowledged.payload, {
    ok: true,
    status: "acknowledged",
    acknowledged: true,
    idempotent: false,
    outcome: "terminal_no_send",
  });
  assert.equal(calls.at(-1)[0], "ack");

  const stopped = await runAction({
    action: "stop",
    jobId,
    chaseChainId,
    candidateHash: correctHash,
    reason: "resume_detected",
  });
  assert.deepEqual(stopped.payload, {
    ok: true,
    status: "stopped",
    stopped: true,
    idempotent: false,
  });
  assert.equal(Object.prototype.hasOwnProperty.call(stopped.payload, "jobId"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(stopped.payload, "candidateUserId"), false);
});

test("claim reconciliation persists a confirmed-touch deadline extension before claiming", async () => {
  const actionNow = Date.parse("2026-08-02T00:00:00.000Z");
  const job = {
    id: jobId,
    revision: 8,
    state: "waiting_for_resume",
    bookingCreatedAt: "2026-07-20T04:00:00.000Z",
    bookingCreatedAtSource: "source_created_at",
    callEndedAt: "2026-07-25T01:00:00.000Z",
    identity: { candidateUserId },
    automation: {
      resumeWait: {
        source: "organic",
        enteredAt: chainAnchorAt,
        claimableThroughAt: "2026-07-26T04:00:00.000Z",
      },
    },
    journal: [],
  };
  const shared = {
    currentGeneration: { chainId: chaseChainId },
    chain: {
      claims: {
        1: {
          touch: 1,
          deliveredAt: "2026-08-01T00:00:00.000Z",
        },
      },
    },
  };
  const writes = [];
  let claimed = 0;
  const rawBody = JSON.stringify({
    action: "claim_send",
    jobId,
    chaseChainId,
    candidateHash: hashedResumeCandidateId(candidateUserId),
    touch: 2,
    eventId: "extended-touch-2",
  });
  const response = await handleResumeWaiting(
    signedRequest("/api/paraai/resume-waiting", {
      method: "POST",
      rawBody,
      at: Math.floor(actionNow / 1000),
    }),
    {
      secret,
      now: () => actionNow,
      hasStore: () => true,
      loadJob: async () => job,
      getSuppression: async () => shared,
      save: async (next, revision) => {
        writes.push({ next, revision });
        return { ...next, revision: revision + 1 };
      },
      claimSuppression: async () => {
        claimed += 1;
        return {
          status: "claimed",
          allowed: true,
          idempotent: false,
          confirmed: false,
        };
      },
    },
  );
  assert.equal(response.status, 200);
  assert.equal(claimed, 1);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].revision, 8);
  assert.equal(
    writes[0].next.automation.resumeWait.claimableThroughAt,
    "2026-08-05T00:00:00.000Z",
  );
});

test("post-terminal same-event claim replay reaches durable suppression after local loss", async () => {
  const closedJob = {
    id: jobId,
    state: "needs_review",
    bookingCreatedAt: "2026-07-20T04:00:00.000Z",
    callEndedAt: "2026-07-25T01:00:00.000Z",
    identity: { candidateUserId },
    automation: {
      status: "needs_review",
      resumeWait: {
        enteredAt: chainAnchorAt,
        claimableThroughAt: "2026-08-02T02:00:00.000Z",
      },
    },
  };
  let claims = 0;
  const rawBody = JSON.stringify({
    action: "claim_send",
    jobId,
    chaseChainId,
    candidateHash: hashedResumeCandidateId(candidateUserId),
    touch: 3,
    eventId: "touch-3-post-terminal-recovery",
  });
  const response = await handleResumeWaiting(
    signedRequest("/api/paraai/resume-waiting", {
      method: "POST",
      rawBody,
    }),
    {
      secret,
      now: () => nowMs,
      hasStore: () => true,
      loadJob: async () => closedJob,
      getSuppression: async () => assert.fail(
        "closed-job replay does not need a mutable deadline read",
      ),
      claimSuppression: async () => {
        claims += 1;
        return {
          status: "sent",
          allowed: false,
          idempotent: true,
          confirmed: true,
        };
      },
    },
  );
  assert.equal(claims, 1);
  assert.deepEqual(await response.json(), {
    ok: true,
    status: "sent",
    allowed: false,
    idempotent: true,
    confirmed: true,
  });
});

test("resume_received_review stops the chain and immediately creates a hard review", async () => {
  const saved = [];
  const baseJob = {
    id: jobId,
    revision: 7,
    state: "waiting_for_resume",
    callEndedAt: "2026-07-25T01:00:00.000Z",
    identity: { candidateUserId },
    automation: { resumeWait: { enteredAt: chainAnchorAt } },
    reviewReasons: [],
    journal: [],
  };
  const rawBody = JSON.stringify({
    action: "stop",
    jobId,
    chaseChainId,
    candidateHash: hashedResumeCandidateId(candidateUserId),
    reason: "resume_received_review",
  });
  const response = await handleResumeWaiting(
    signedRequest("/api/paraai/resume-waiting", {
      method: "POST",
      rawBody,
    }),
    {
      secret,
      now: () => nowMs,
      hasStore: () => true,
      loadJob: async () => baseJob,
      stopSuppression: async () => ({
        status: "stopped",
        stopped: true,
        idempotent: false,
      }),
      save: async (job, revision) => {
        saved.push({ job, revision });
        return { ...job, revision: revision + 1 };
      },
    },
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    status: "stopped",
    stopped: true,
    idempotent: false,
  });
  assert.equal(saved.length, 1);
  assert.equal(saved[0].job.state, "needs_review");
  assert.equal(saved[0].job.reviewReason, "resume_received_review");
  assert.equal(saved[0].job.reviewReasons[0].soft, false);
});

test("human Calendar receipt feed is URL-free and stops asks before any claim", async () => {
  const humanSourceId = "c".repeat(64);
  const humanJobId = `hi-${humanSourceId}`;
  const humanAnchorAt = "2026-07-25T02:00:00.000Z";
  const humanChainId = resumeChaseChainId(
    humanJobId,
    humanAnchorAt,
  );
  const descriptor = {
    source: "calendar_resume_link",
    status: "received",
    artifactSha256: "d".repeat(64),
    mimeType: "application/pdf",
  };
  const job = {
    id: humanJobId,
    revision: 3,
    state: "waiting_for_resume",
    humanCall: true,
    humanIntro: true,
    callType: "human",
    bookingSourceId: humanSourceId,
    bookingCreatedAt: "2026-07-20T04:00:00.000Z",
    bookingCreatedAtSource: "calendar_booking_created_at",
    callEndedAt: "2026-07-25T01:00:00.000Z",
    identity: { candidateUserId },
    candidate: {
      scheduledStart: "2026-07-25T00:30:00.000Z",
    },
    submission: {
      name: "Candidate Example",
      email: "candidate@example.com",
    },
    resumeLinkDisposition: "received",
    resumeReceipt: descriptor,
    humanCallMeta: {
      sourceId: humanSourceId,
      resumeLinkDisposition: "received",
      resumeReceipt: descriptor,
    },
    automation: {
      resumeWait: {
        source: "calendar_human_intro",
        enteredAt: humanAnchorAt,
        expiresAt: "2026-08-01T02:00:00.000Z",
        claimableThroughAt: "2026-07-26T04:00:00.000Z",
      },
    },
    journal: [],
  };
  const stops = [];
  const feed = await handleResumeWaiting(
    signedRequest("/api/paraai/resume-waiting"),
    {
      secret,
      now: () => nowMs,
      hasStore: () => true,
      listWaiting: async () => ({
        jobs: [job],
        complete: true,
        totalWaiting: 1,
      }),
      activateGeneration: async () => ({ current: true }),
      stopSuppression: async (...args) => {
        stops.push(args);
        return {
          status: "stopped",
          stopped: true,
          idempotent: false,
        };
      },
      getSuppression: async () => ({
        currentGeneration: { chainId: humanChainId },
        candidateSatisfaction: null,
        chain: {
          stopped: true,
          stopReason: "resume_received",
          stoppedAt: "2026-07-25T10:00:00+09:00",
          cancellationAt: "2026-07-25T11:00:00+09:00",
        },
      }),
    },
  );
  assert.equal(feed.status, 200);
  const row = (await feed.json()).waiting[0];
  assert.equal(row.bookingSourceId, humanSourceId);
  assert.equal(row.resumeLinkDisposition, "received");
  assert.deepEqual(row.resumeReceipt, descriptor);
  assert.equal(JSON.stringify(row).includes("https://"), false);
  assert.equal(row.suppression.candidateSatisfied, false);
  assert.equal(
    row.suppression.chainStoppedAt,
    "2026-07-25T01:00:00.000Z",
  );
  assert.equal(
    row.suppression.chainCancellationAt,
    "2026-07-25T02:00:00.000Z",
  );
  assert.equal(stops[0][1].reason, "resume_received");

  let claims = 0;
  const rawBody = JSON.stringify({
    action: "claim_send",
    jobId: humanJobId,
    chaseChainId: humanChainId,
    candidateHash: hashedResumeCandidateId(candidateUserId),
    touch: 1,
    eventId: "calendar-receipt-touch-1",
  });
  const claim = await handleResumeWaiting(
    signedRequest("/api/paraai/resume-waiting", {
      method: "POST",
      rawBody,
    }),
    {
      secret,
      now: () => nowMs,
      hasStore: () => true,
      loadJob: async () => job,
      stopSuppression: async () => ({
        status: "existing",
        stopped: true,
        idempotent: true,
      }),
      save: async (next, revision) => ({
        ...next,
        revision: revision + 1,
      }),
      claimSuppression: async () => {
        claims += 1;
        return { status: "claimed", allowed: true };
      },
    },
  );
  assert.deepEqual(await claim.json(), {
    ok: true,
    status: "candidate_satisfied",
    allowed: false,
    idempotent: true,
    confirmed: false,
  });
  assert.equal(claims, 0);

  const reviewJob = {
    ...job,
    resumeLinkDisposition: "received_review",
    resumeReceipt: {
      ...descriptor,
      status: "received_review",
      mimeType: "application/rtf",
    },
    humanCallMeta: {
      ...job.humanCallMeta,
      resumeLinkDisposition: "received_review",
      resumeReceipt: {
        ...descriptor,
        status: "received_review",
        mimeType: "application/rtf",
      },
    },
  };
  const reviewWrites = [];
  const reviewClaim = await handleResumeWaiting(
    signedRequest("/api/paraai/resume-waiting", {
      method: "POST",
      rawBody,
    }),
    {
      secret,
      now: () => nowMs,
      hasStore: () => true,
      loadJob: async () => reviewJob,
      stopSuppression: async () => ({
        status: "stopped",
        stopped: true,
        idempotent: false,
      }),
      save: async (next, revision) => {
        reviewWrites.push(next);
        return { ...next, revision: revision + 1 };
      },
      claimSuppression: async () => assert.fail(
        "received-review artifacts must not claim a send",
      ),
    },
  );
  assert.deepEqual(await reviewClaim.json(), {
    ok: true,
    status: "resume_review_required",
    allowed: false,
    idempotent: false,
    confirmed: false,
  });
  assert.equal(reviewWrites[0].state, "needs_review");
  assert.equal(
    reviewWrites[0].reviewReason,
    "calendar_resume_received_review",
  );

  const inconsistentJob = {
    ...job,
    resumeReceipt: {
      ...descriptor,
      artifactSha256: "not-a-valid-digest",
    },
    humanCallMeta: {
      ...job.humanCallMeta,
      resumeReceipt: {
        ...descriptor,
        artifactSha256: "not-a-valid-digest",
      },
    },
  };
  let inconsistentClaims = 0;
  const inconsistentStops = [];
  const inconsistentClaim = await handleResumeWaiting(
    signedRequest("/api/paraai/resume-waiting", {
      method: "POST",
      rawBody,
    }),
    {
      secret,
      now: () => nowMs,
      hasStore: () => true,
      loadJob: async () => inconsistentJob,
      stopSuppression: async (...args) => {
        inconsistentStops.push(args);
        return {
          status: "stopped",
          stopped: true,
          idempotent: false,
        };
      },
      save: async (next, revision) => ({
        ...next,
        revision: Number(revision || 0) + 1,
      }),
      claimSuppression: async () => {
        inconsistentClaims += 1;
        return { status: "claimed", allowed: true };
      },
    },
  );
  assert.deepEqual(await inconsistentClaim.json(), {
    ok: true,
    status: "resume_review_required",
    allowed: false,
    idempotent: false,
    confirmed: false,
  });
  assert.equal(inconsistentClaims, 0);
  assert.equal(
    inconsistentStops[0][1].reason,
    "resume_received_review",
  );
});

test("agent booking source time is recorded immutably before any chase claim", async () => {
  const sourceId = "pf-event-source-123";
  const bookingCreatedAt = "2026-07-20T04:00:00.000Z";
  const baseJob = {
    id: jobId,
    revision: 4,
    state: "waiting_for_resume",
    callType: "agent",
    callEndedAt: "2026-07-25T01:00:00.000Z",
    candidate: { paraformEventId: sourceId },
    identity: { candidateUserId },
    automation: { resumeWait: { enteredAt: chainAnchorAt } },
    journal: [],
  };
  const request = (body) => signedRequest(
    "/api/paraai/resume-waiting",
    {
      method: "POST",
      rawBody: JSON.stringify(body),
    },
  );
  const common = {
    secret,
    now: () => nowMs,
    hasStore: () => true,
  };
  const action = {
    action: "record_booking_created_at",
    jobId,
    chaseChainId,
    candidateHash: hashedResumeCandidateId(candidateUserId),
    bookingSourceId: sourceId,
    bookingCreatedAt,
  };
  let saved = null;
  const recorded = await handleResumeWaiting(request(action), {
    ...common,
    loadJob: async () => baseJob,
    save: async (job, revision) => {
      saved = { ...job, revision: revision + 1 };
      return saved;
    },
  });
  assert.equal(recorded.status, 200);
  assert.deepEqual(await recorded.json(), {
    ok: true,
    status: "recorded",
    recorded: true,
    idempotent: false,
  });
  assert.equal(saved.bookingCreatedAt, bookingCreatedAt);
  assert.equal(
    saved.bookingCreatedAtSource,
    "gmail_paraform_booking_notification",
  );
  assert.equal(saved.bookingSourceId, sourceId);

  const replay = await handleResumeWaiting(request(action), {
    ...common,
    loadJob: async () => saved,
    save: async () => assert.fail("exact booking-time replay must not write"),
  });
  assert.deepEqual(await replay.json(), {
    ok: true,
    status: "existing",
    recorded: true,
    idempotent: true,
  });

  const unresolvedClaim = await handleResumeWaiting(request({
    action: "claim_send",
    jobId,
    chaseChainId,
    candidateHash: hashedResumeCandidateId(candidateUserId),
    touch: 1,
    eventId: "must-not-claim-before-booking-time",
  }), {
    ...common,
    loadJob: async () => baseJob,
    claimSuppression: async () => assert.fail("unresolved booking cannot claim"),
  });
  assert.deepEqual(await unresolvedClaim.json(), {
    ok: true,
    status: "booking_time_unresolved",
    allowed: false,
    idempotent: false,
    confirmed: false,
  });
});
