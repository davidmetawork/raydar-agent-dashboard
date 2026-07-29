import test from "node:test";
import assert from "node:assert/strict";

import { clearCookieCache } from "../api/paraai/_lib/core.mjs";
import {
  EXPIRATION_DAYS,
  EXPIRED_REASONS,
  expiredReasonText,
  expiredRows,
  expiredAtMs,
  isExpiredRow,
  normalizeExpiredRow,
  readParaAiStatus,
  readSubmissionRequestHistory,
  verifyDismissed,
  performExpiredDismiss,
} from "../api/paraai/_lib/expired-actions.mjs";

// Same injection point as the reply-actions suite: the tRPC layer is reached
// through global fetch, handlers are keyed by procedure name, and an
// unexpected procedure fails the test rather than escaping to the network.
function withParaform(handlers, run) {
  const seen = [];
  const realFetch = globalThis.fetch;
  const realCookie = process.env.PARAFORM_SESSION_COOKIE;
  process.env.PARAFORM_SESSION_COOKIE = "Fe26.2-test-only";
  clearCookieCache();
  globalThis.fetch = async (url, options = {}) => {
    const target = String(url);
    assert.ok(target.includes("/trpc/"), `unexpected non-tRPC request: ${target}`);
    const proc = target.split("/trpc/")[1].split("?")[0];
    const input = options.method === "POST"
      ? JSON.parse(options.body).json
      : JSON.parse(decodeURIComponent(target.split("input=")[1])).json;
    seen.push({ proc, input });
    const handler = handlers[proc];
    assert.ok(handler, `unexpected procedure: ${proc}`);
    return new Response(JSON.stringify({ result: { data: { json: handler(input) } } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return (async () => {
    try {
      return await run(seen);
    } finally {
      globalThis.fetch = realFetch;
      if (realCookie == null) delete process.env.PARAFORM_SESSION_COOKIE;
      else process.env.PARAFORM_SESSION_COOKIE = realCookie;
      clearCookieCache();
    }
  })();
}

// Shapes cloned from the live 2026-07-28 read, not invented: a fixture no
// writer produces is a mirror, not a test.
const expiredRow = (over = {}) => ({
  id: "req-expired",
  created_at: "2026-07-21T22:47:06.677Z",
  sent_to_user_id: "user-me",
  reached_out_to_candidate: true,
  reached_out_to_candidate_at: "2026-07-21T22:47:17.109Z",
  state: "EXPIRED",
  status: "expired",
  status_label: "Expired",
  filterBucket: "expired",
  application_id: null,
  client_note: "We would like to interview them.",
  recruiter_response: null,
  candidate: { id: "cand-1", candidate_user_id: "cu-1", name: "Test Candidate" },
  role: { id: "role-1", name: "Product Manager", company: { name: "Example Co" } },
  hiringManagerName: "Sample Manager",
  ...over,
});

const pendingRow = (over = {}) => expiredRow({
  id: "req-pending",
  state: "PENDING",
  status: "pending",
  status_label: "Pending",
  filterBucket: "pending",
  ...over,
});

const history = (rows, over = {}) => ({
  requests: rows,
  counts: { all: rows.length, pending: 1, submitted: 0, interviewing: 0, expired: 1, dismissed: 0 },
  stageCounts: {},
  canAccessAgencyView: true,
  currentUserId: "user-me",
  currentUserExpiredCount: rows.filter((row) => row.status === "expired").length,
  ...over,
});

// The reason strings are Paraform's own chip labels. If one of these ever
// changes, the hiring manager sees text we invented instead of text the
// platform offers, so they are asserted byte-for-byte.
test("the reason vocabulary matches Paraform's What happened? chips exactly", () => {
  assert.deepEqual(EXPIRED_REASONS, {
    not_interested: "Candidate not interested",
    no_response: "Candidate didn't get back",
    too_many_processes: "In too many processes",
  });
  assert.equal(expiredReasonText("no_response"), "Candidate didn't get back");
  // ASCII apostrophe (U+0027), as captured — not the typographic U+2019.
  assert.ok(EXPIRED_REASONS.no_response.includes(String.fromCharCode(39)));
  assert.ok(!EXPIRED_REASONS.no_response.includes(String.fromCharCode(0x2019)));
  // An unknown key must never silently send a different claim about a person.
  assert.equal(expiredReasonText("nonsense"), "Candidate didn't get back");
});

test("expiry is seven days, read from the client bundle rather than inferred", () => {
  assert.equal(EXPIRATION_DAYS, 7);
  const row = normalizeExpiredRow(expiredRow());
  assert.equal(
    new Date(expiredAtMs(row)).toISOString(),
    "2026-07-28T22:47:06.677Z",
  );
});

// Server state is the only authority. A row that our clock thinks is old but
// Paraform still calls pending is NOT this lane's business.
test("only rows Paraform itself marks expired are selectable", () => {
  const rows = [
    normalizeExpiredRow(expiredRow()),
    normalizeExpiredRow(pendingRow({ created_at: "2026-01-01T00:00:00.000Z" })),
    normalizeExpiredRow(expiredRow({ id: "req-dismissed", state: "DISMISSED", status: "dismissed" })),
  ];
  assert.equal(isExpiredRow(rows[0]), true);
  assert.equal(isExpiredRow(rows[1]), false);
  assert.deepEqual(expiredRows(rows, "user-me").map((row) => row.id), ["req-expired"]);
});

// canAccessAgencyView is true on this account, so a row owned by someone else
// must never be dismissed under David's name.
test("a row belonging to another recruiter is never selectable", () => {
  const rows = [
    normalizeExpiredRow(expiredRow()),
    normalizeExpiredRow(expiredRow({ id: "req-theirs", sent_to_user_id: "user-other" })),
  ];
  assert.deepEqual(expiredRows(rows, "user-me").map((row) => row.id), ["req-expired"]);
});

test("the history read surfaces the pause counter the reply lane discards", async () => {
  const result = await withParaform({
    "submissionRequest.getRecruiterSubmissionRequestHistory": () => history([expiredRow(), pendingRow()]),
  }, () => readSubmissionRequestHistory());
  assert.equal(result.currentUserExpiredCount, 1);
  assert.equal(result.counts.expired, 1);
  assert.equal(result.currentUserId, "user-me");
  assert.equal(result.rows.length, 2);
  assert.equal(result.rows[0].reachedOut, true);
  assert.equal(result.rows[0].statusLabel, "Expired");
});

test("ParaAI status reports whether matching is actually paused", async () => {
  const status = await withParaform({
    "submissionRequest.getRecruiterParaAIStatus": () => ({
      isParaAIDisabled: false,
      paraAIMatchingStatus: "ACTIVE",
      paraAICountsTowardsChallenge: false,
      isTalentNetworkEnabled: true,
    }),
  }, () => readParaAiStatus());
  assert.deepEqual(status, {
    disabled: false,
    matchingStatus: "ACTIVE",
    countsTowardsChallenge: false,
    talentNetworkEnabled: true,
  });
});

// A 200 is never success. Truth is the re-read row.
test("a row still showing expired after the write is not a verified dismissal", async () => {
  const outcome = await withParaform({
    "submissionRequest.getRecruiterSubmissionRequestHistory": () => history([expiredRow()]),
  }, () => verifyDismissed("req-expired"));
  assert.equal(outcome.verified, false);
  assert.equal(outcome.reason, "state_is_expired");
});

test("a row that flipped to dismissed is a verified dismissal", async () => {
  const outcome = await withParaform({
    "submissionRequest.getRecruiterSubmissionRequestHistory": () => history([
      expiredRow({ state: "DISMISSED", status: "dismissed", status_label: "Passed" }),
    ]),
  }, () => verifyDismissed("req-expired"));
  assert.equal(outcome.verified, true);
  assert.equal(outcome.currentUserExpiredCount, 0);
});

test("the dismissal sends the canonical reason and proves itself by read-back", async () => {
  let dismissed = false;
  const { seen, result } = await withParaform({
    "submissionRequest.getRecruiterParaAIStatus": () => ({
      isParaAIDisabled: false,
      paraAIMatchingStatus: "ACTIVE",
      paraAICountsTowardsChallenge: false,
      isTalentNetworkEnabled: true,
    }),
    "submissionRequest.dismissSubmissionRequest": () => { dismissed = true; return { ok: true }; },
    "submissionRequest.getRecruiterSubmissionRequestHistory": () => history([
      dismissed
        ? expiredRow({ state: "DISMISSED", status: "dismissed" })
        : expiredRow(),
    ]),
  }, async (seenCalls) => {
    const row = normalizeExpiredRow(expiredRow());
    // claim:false keeps the KV store out of a pure wire test.
    const result = await performExpiredDismiss(row, "no_response", { claim: false });
    return { seen: seenCalls, result };
  });

  const write = seen.find((call) => call.proc === "submissionRequest.dismissSubmissionRequest");
  assert.ok(write, "expected a dismiss mutation");
  // The captured payload for the Expired card's "Add reason": id + reason only.
  assert.deepEqual(write.input, { id: "req-expired", dismissReason: "Candidate didn't get back" });
  assert.equal(result.verified, true);
  assert.equal(result.expiredCountAfter, 0);
  assert.equal(result.paraAiAfter.matchingStatus, "ACTIVE");
});

// An unverified write is surfaced, never retried: a second attempt would be a
// second statement to the same hiring manager.
test("a dismissal that does not change the row throws rather than retrying", async () => {
  await withParaform({
    "submissionRequest.getRecruiterParaAIStatus": () => ({ paraAIMatchingStatus: "ACTIVE" }),
    "submissionRequest.dismissSubmissionRequest": () => ({ ok: true }),
    "submissionRequest.getRecruiterSubmissionRequestHistory": () => history([expiredRow()]),
  }, async () => {
    const row = normalizeExpiredRow(expiredRow());
    await assert.rejects(
      () => performExpiredDismiss(row, "no_response", { claim: false }),
      (error) => error.code === "EXPIRED_DISMISS_UNVERIFIED",
    );
  });
});
